# Critical review of the V1→V2 port critique

Scope: the critique of the earlier V1→V2 port analysis for `opencode-subagent-fallback`.
Method: every claim was checked against the running OpenCode **2.2.7** server binary, the
`@opencode/plugin@2.2.7` / `@opencode/client@2.2.7` / `@opencode/schema` type packages, and the
local V1 implementation (`src/core.ts`, `dist/core.js`). No code was changed.

---

## 1. Verdict

The critique's **central correction is right and it invalidates the earlier port plan**:

> cross-provider failover can happen **in-step**, inside the existing turn, by calling
> `ctx.session.switchModel(...)` from `ctx.session.hook("retry", ...)` and forcing
> `decision = { retry: true, delay }`.

The earlier premise — "a cross-provider switch requires failing the turn and re-dispatching a
new prompt" — is wrong. That premise was load-bearing: it justified a whole re-dispatch
architecture (synthetic user message, new assistant message, transcript surgery, double
billing). None of that is needed.

Everything else in the critique should be treated as **unreliable**. Three claims are factually
wrong, and seven behaviours that materially change the design are missing. Do not implement it
verbatim.

---

## 2. Why the central correction is correct

Verified control flow in the 2.2.7 `SessionRunner`:

```
runStep
  ├─ prepared context cached for the first attempt only
  │    pe = K; ke = pe ?? (yield* L(ee).pipe(A(r.load))); pe = void 0
  ├─ attempt
  ├─ retry(...)                     ← classified error
  ├─ ve.decide(...)                 ← default decision (retry:false for quota/402, etc.)
  ├─ ctx.session.hook("retry", e)   ← plugin sees { sessionID, agent, model, error, attempt, decision }
  ├─ Ms.Retry | Ms.Continue
  └─ loop
```

Three properties make in-step failover work:

1. **`decision` is mutable.** `SessionRetryDecision = { retry: false } | { retry: true; delay: number }`.
   A plugin can turn a non-retryable class (402/quota, 404, free-limit, budget-limit) into a retry.
2. **Retries reload session context.** Because `pe` is cleared, the next iteration calls
   `SessionContext.select` (fresh session row) and `SessionContext.load` (model resolution from
   available providers). A `switchModel` performed in the hook is therefore picked up by the very
   next attempt — no turn boundary required.
3. **`Session.switchModel` has no `isActive` guard.** Only `revert.commit` is guarded. Calling it
   mid-run is legal. It publishes a durable `session.model.selected` event and appends a durable
   `type:"model-switched"` message.

Corollary the critique missed: the same hook fires for **subagent child sessions**, because
children run through the same `SessionRunner` loop. One registration covers primary agents and
subagents; `e.sessionID` is the child's ID.

Trap to avoid: `experimental.model.resolve` is **not** the failover hook. `SessionRunnerModel.resolve`
enforces same-provider only, so a cross-provider target is rejected as unavailable. `switchModel`
in `retry` is the correct mechanism; `model.resolve` is only useful for same-provider routing.

---

## 3. Factual errors in the critique

### E1 — `mime` on prompt attachments (wrong)

The critique's prompt-reconstruction step passes `files: [{ mime, data }]`. That is the shape of a
**stored** attachment (`SessionMessageUser.files: PromptFileAttachment`), not the **input** shape.

`SessionPromptInput.files` / `PromptInput.FileAttachment` is:

```ts
{ uri: string; source?: { type: "inline" } | { type: "uri"; uri: string };
  name?: string; description?: string; mention?: { start; end; text } }
```

No `mime`, no `data`. The server resolves `uri` into an attachment. Sending `mime`/`data` will fail
schema validation.

### E2 — wrong event name (wrong)

The critique uses `session.model.switched`. The durable published event is
**`session.model.selected`**. `session.model.switched` does not exist in 2.2.7. Any code keyed on
the critique's name will silently never fire.

### E3 — "retries always reuse the same assistant message" (wrong)

This is only true **pre-stream**. `runStep` distinguishes:

- failure before output started → `Ms.Retry` → same assistant message, incremented attempt
- failure after output started (`outputStarted`) → `Ms.Continue` → **new** assistant message

Consequence for the port: completion/token logic must not assume "one assistant message per turn".
A mid-stream 429 produces a partial assistant message plus a continuation. The completion gate has
to evaluate the **last** assistant message, and the token estimate must not sum every assistant
message in the turn.

---

## 4. Omissions that change the design

### O1 — `switchModel` is not a free swap (transcript + selection side effects)

`switchModel` permanently changes the session's selected model and writes a durable
`type:"model-switched"` message into history. A failover-and-restore policy therefore writes **two**
such messages per incident. Restoring is not "transparent"; it is visible in the transcript.
Decide explicitly: sticky failover (recommended, one artifact) vs restore (two artifacts).

### O2 — the retry hook is not called once the retry budget is spent

`if (!u) return;` before the hook. Budget is `Schedule.recurs(10)` with exponential backoff
(2s → 10s cap), i.e. attempts 0..10. A fallback chain longer than ~10 hops cannot complete in one
turn, and a chain that consumes budget on rate-limit waits may never reach later models. The port
must treat `attempt` as a hard signal (budget is `Schedule.recurs(10)` → attempts 0..10) and stop
advancing beyond it; do **not** impose an arbitrary chain cap — live chains already run 9–11 models
(D5).

### O3 — context overflow bypasses the retry hook entirely

`p4(e)` (InvalidRequest + `context-overflow`) short-circuits to compaction, never `m.retry(...)`.
So **cross-provider failover on context overflow is impossible via the retry hook**. The only
levers are:

- `experimental.model.resolve` — same provider only
- a `compaction` agent with its own `.model` — affects compaction, not the main loop
- pre-emptive switching, driven from event/token observation, before the overflow happens

The critique's "handle overflow like any other error" is not implementable as written.

### O4 — `AgentEditor` has no `add` (now corrected by F1)

`AgentEditor` is `{ list, get, default, update, remove }`; `ctx.agent` exposes `list`/`get`/
`transform`/`reload`, and `AgentEditor.update(id, fn)` is an **upsert** that creates the agent when
absent (corrected by F1 / §9.1). The "cannot register" conclusion applied only to a bare `add`, which
the plugin must not use; registration goes through the transform upsert. `fallback.json` references
`architect`, `debugger`, `code-review`, `researcher`, `researcher-vision`, `tester`, `orchestrator` —
none of which exist in `opencode.json` (only `developer` is defined) and there are no agent markdown
files. Every chain targeting those agents will fail on "unknown agent" unless the port upserts them.

### O5 — compaction is async admission, not completion

`ctx.session.compact({ sessionID })` returns an inbox item. Switching the model back immediately
races the actual compaction and can compact under the wrong model. Wait for a compaction boundary
in `ctx.session.context` (or a compaction event) before restoring.

### O6 — retry-hook errors are swallowed

`trigger("session","retry",…).pipe(ye)` discards the failure. A `switchModel` that throws (model
not in an available provider, provider not authenticated) will **not** surface — the turn simply
fails with the original error and the log says nothing. The hook must never throw, and must log and
fall through to the original decision on any internal failure.

### O7 — `ctx.session.wait` swallows errors and returns void

`wait({ sessionID })` is `Effect.ignore`-based. It is not a success signal. Success must be read
from `ctx.session.context({ sessionID })` afterwards. The critique treats `wait` as a completion
oracle.

Additional smaller omissions:

- V2 model refs are `{ providerID, id, variant? }`; `{ providerID, modelID }` fails validation.
- Tool states are `streaming | running | completed | error` — there is no `pending`. V1's gate
  checks `pending`/`running`; the V2 gate needs `streaming`/`running`.
- `finish: "tool-calls"` is a **normal** finish for a tool-using turn, not a failure.
- `ctx.session.context` returns `SessionMessageInfo[]` (flat, since last completed compaction), not
  `{ messages, system, model, options }`.
- There is no `message.updated` / `message.part.updated` event in V2. Liveness must be stamped on
  `session.text.*`, `session.reasoning.*`, `session.tool.*`, `session.step.*`,
  `session.retry.scheduled`.
- `experimental.idle` does not fire while a stream is stalled, so it cannot be the watchdog's
  recovery trigger.
- Built-in `task` is now `subagent` and already accepts `model?`, `background?`, `sessionID?`.
  Much of `smart_task` is redundant.
- `loadFallback` resolves config from `configDir()` (`OPENCODE_CONFIG_DIR` or `~/.config/opencode`),
  not `ctx.location.directory`. Fine for local use, wrong if published.
- V2 config has no `fallback`/`retry` keys. The plugin's own `fallback.json` remains the config
  source; there is no `ctx.config` domain.

---

## 5. Corrected port architecture

### 5.1 Entrypoint and lifecycle

V2 requires a default export `{ id, setup }`. The `server` field used by the working rtk plugin is
not part of the `Plugin` type; for portability keep only `id`/`setup` — but the practical local
entrypoint mirrors the working rtk plugin (`{ id, setup, server }`, untyped `ctx: any`) because the
runtime provides `@opencode/plugin` as a virtual module.

```ts
import type { Plugin } from "@opencode/plugin"

export default {
  id: "subagent-fallback",
  async setup(ctx) {
    const fb = createFallback(ctx)
    const regs = [
      await ctx.session.hook("retry", (e) => fb.onRetry(e)),
      await ctx.session.hook("prompt", (e) => fb.onPrompt(e)),          // reset per-turn state
      await ctx.session.hook("experimental.idle", (e) => fb.onIdle(e)), // restore / cleanup
      await ctx.tool.transform((editor) => fb.installTools(editor)),
    ]
    const ac = new AbortController()
    void fb.consumeEvents(ctx, ac.signal)          // ctx.event.subscribe is an async iterable
    return async () => {                           // Cleanup
      ac.abort()
      for (const r of regs) await r.dispose()
      fb.dispose()
    }
  },
} satisfies Plugin
```

Config change in `~/.config/opencode/opencode.json`:

```jsonc
"plugin": ["file:///home/.../src/index.ts"]   // V2 rejects: "configured plugin path must be a directory"
"plugins": ["/home/eaxelrod/GitHub/opencode-subagent-fallback"]  // directory target
```

### 5.2 Failover core

```ts
async onRetry(e: SessionRetry) {              // { sessionID, agent, model, error, attempt, decision }
  try {
    // F3: compaction rides the retry hook with agent:"compaction" but resolves its
    // model before entering the retry loop — never switch for compaction sessions.
    if (e.agent === "compaction") return

    const cls = classify(e.error)             // transient | quota | rate-limit | not-found | auth | fatal
    if (cls === "fatal") return
    const st = this.state(e.sessionID)        // chain, cursor, tried:Set, switched, stickyUntil, rateLimitMs

    // D1: transient-class failure inside the sticky window retries the SAME model,
    // honoring retryAfterMs / rateLimitMs (e.g. 60s free-tier) instead of forcing delay: 0.
    // rate-limit (429) counts as transient here, provided retryAfterMs fits the sticky window
    // and the attempt budget is not spent (O2).
    if ((cls === "transient" || cls === "rate-limit") && Date.now() < st.stickyUntil && e.attempt < st.maxAttempts) {
      e.decision = { retry: true, delay: e.error.retryAfterMs ?? st.rateLimitMs?.[e.model.providerID] ?? backoffFor(e.attempt) }
      return
    }

    // D2: auth-class failures (401/403) advance the chain too — a dead credential on
    // provider A invalidates every model behind A; V1 semantics did the same.
    const next = this.nextModel(st, e.model, cls)
    if (!next) return

    await this.lock(e.sessionID, async () => {
      await this.ctx.session.switchModel({ sessionID: e.sessionID, model: next })
      st.cursor = st.chain.indexOf(next)
      st.tried.add(key(next))
      st.switched = true
      this.log(`${e.sessionID} ${fmt(e.model)} -> ${fmt(next)} (${cls}, attempt ${e.attempt})`)
    })
    // Always re-decide after switching: the failed model's Retry-After is meaningless once we
    // have moved to a different model. Sleep only the next model's cooldown — 0 when it has no
    // active rate-limit window, else the remaining window (e.g. remaining free-tier quota for a
    // shared provider). Record the failed model's retryAfterMs / rateLimitMs as its blockedUntil
    // rather than leaking them into the next model's delay.
    // This forces retry: true even where the default decision would refuse (quota / 402 / 404).
    e.decision = { retry: true, delay: nextCooldownMs(next, st) }
  } catch (err) {
    this.log(`retry hook failed, keeping default decision: ${String(err)}`)  // never throw (O6)
  }
}
```

Helpers the blueprint relies on (to be implemented in step 2):

- `nextCooldownMs(next, st)`: cooldown to sleep before retrying `next` — 0 when `next` has no active
  rate-limit window, else the remaining `st.rateLimitMs[next.providerID]`.
- `backoffFor(attempt)`: exponential backoff, 2s → 10s cap (mirrors V2 `Schedule` behavior).

Rules:

- Fail over on: `provider.quota`, `provider.free-limit`, `provider.go-limit`,
  `provider.budget-limit`, `provider.model-budget-limit`, `provider.chatgpt-limit`,
  `provider.rate-limit`, `provider.transport`, `provider.internal`, `provider.timeout`, HTTP
  402/404/429, and provider "nothing is used up" quota text — **and on auth-class failures
  (401/403)** (D2): a dead credential on provider A invalidates every model behind A.
- Transient-class failures inside the sticky window retry the **same** model, honoring
  `retryAfterMs` / `rateLimitMs` (e.g. 60s free-tier) instead of forcing `delay: 0` (D1).
- Never revisit a model in the same turn (`tried` set), never exceed `attempt >= 10` (O2).
- Skip auxiliary sessions: return early when `e.agent === "compaction"` (F3).
- Validate the chain against `await ctx.model.list()` at load and again before switching; drop
  unavailable entries rather than throwing inside the hook (F2).
- Reset per-turn state in the `prompt` hook, not on idle (idle does not run after failure).

### 5.3 Transparency policy

Default: **sticky**. After failover the session stays on the working model, and the plugin writes
one log line plus (optionally) a `metadata`-tagged note. Restore only if `config.restoreOnSuccess`
is true, and only:

- after the completion gate passes on the failover model, and
- only if `ctx.session.context` shows the session's current model is still the plugin's target
  (the user may have switched manually), and
- only after any compaction finished (see O5).

Never restore in `experimental.idle` alone: idle does not run after interruption or failure.

### 5.4 Completion gate and token accounting (flat schema)

```ts
const CONTINUE_PROMPT =
  "The previous response was interrupted. Continue from where you left off without repeating completed content."

function lastAssistantInTurn(msgs: SessionMessageInfo[]) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.type === "assistant") return m
    if (m.type === "model-switched") continue
    if (m.type === "user" && m.text === CONTINUE_PROMPT) continue
    break // hit the turn's real user message (or compaction) — no assistant row in this turn yet
  }
}
function assistantText(msgs: SessionMessageInfo[]): string {
  // D3: Ms.Continue injects a synthetic user message (CONTINUE_PROMPT) before the new
  // assistant message, and switchModel appends "model-switched". Skip both so the reverse
  // scan reaches earlier assistant splits in the same turn and stops at the real user prompt.
  const parts: string[] = []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.type === "model-switched") continue
    if (m.type === "user" && m.text === CONTINUE_PROMPT) continue
    if (m.type !== "assistant") break
    parts.unshift(m.content.filter(c => c.type === "text").map(c => c.text).join("\n"))
  }
  return parts.filter(p => p.trim().length > 0).join("\n")
}
function checkCompletion(msgs: SessionMessageInfo[]) {
  const m = lastAssistantInTurn(msgs)
  if (!m) return { ok: false, reason: "no-assistant" as const }
  const text = assistantText(msgs)   // D3: concatenate across Ms.Continue splits
  const toolParts = m.content.some(c => c.type === "tool")            // D3: tool-calls is a valid finish
  const busy = m.content.some(c => c.type === "tool" &&
    (c.state.status === "streaming" || c.state.status === "running"))
  const ok = m.time.completed != null && !m.error && !busy &&
             m.finish !== "length" && m.finish !== "error" &&
             (text.trim().length > 0 || toolParts)                      // D3: accept tool-only turns
  const tokens = m.tokens ? m.tokens.input + m.tokens.cache.read : 0  // D3: null-safe
  return { ok, finish: m.finish, text, tokens, error: m.error }
}
const contextTokens = (m) => m?.tokens ? m.tokens.input + m.tokens.cache.read : 0
```

**Incorporated fixes (meta-review cross-check):** `checkCompletion` now concatenates assistant text
across `Ms.Continue` splits via `assistantText` (skipping in-turn `"model-switched"` markers and the
synthetic `CONTINUE_PROMPT` user message until it hits the real user prompt); it gates on
`lastAssistantInTurn(msgs)` for state (returning `undefined` on a pre-token stall rather than falling
through to the previous turn's assistant message), while token estimates come from that last message
with null-safety, never summed across all assistant messages in the turn.

The re-prompt payload comes from the `prompt`-admission capture (text + files + agents + skills);
`findLast(user)` is **not** authoritative (D4) — after a synthetic continuation the last user message
may be the synthetic one and drops files/agents/skills. User messages are flat strings in V2, not
parts arrays.

### 5.5 Watchdog

- Stamp liveness on `session.text.*`, `session.reasoning.*`, `session.tool.*`, `session.step.*`,
  `session.retry.scheduled`.
- Do not wait for `experimental.idle` to recover a stall.
- Recovery: `ctx.session.interrupt({ sessionID })`, then verify via `ctx.session.context` whether
  the turn's assistant message is completed/errored. On a **pre-token stall** (interrupted before the
  first token lands) no assistant row exists for the stalled turn, so the verification must not fall
  through to (or mask with) the previous turn's assistant message; treat the stalled turn accordingly
  and re-prompt.
- `prompt` returns `SessionInboxUser` at **admission**; it is not completion. `wait` returns void
  and hides errors. Always re-read `context`.
- **D4**: a pre-token stall means no assistant row exists yet (`T.hasStarted()` stays false until the
  first chunk lands). If the first-token budget (`firstTokenMs`) elapses with `hasStarted() === false`,
  that **is** a first-token stall — the watchdog must not treat it as live (doing so would disable
  firstTokenMs enforcement). Recovery re-prompt must use the payload captured at
  `ctx.session.hook("prompt")` admission via `ctx.session.prompt({ sessionID, text, files?, agents?, skills?, delivery?, resume? })`.
  Both `SessionPromptInput` and `SessionInterruptInput` accept `resume` (`prompt`'s is
  `resume?: boolean | null`, interrupt's is `resume?: boolean | undefined`), so passing
  `resume: true` in the re-prompt is type-valid; the earlier dismissal was incorrect.
  The synthetic-continuation pitfall (`findLast(user)`) therefore only affects re-prompt construction,
  and the admission capture is authoritative.

### 5.6 Compaction / overflow

- Auto and overflow compaction only use a `compaction` agent model if the `compaction` agent
  defines `.model`; otherwise they use the session's current model.
- Manual `ctx.session.compact({ sessionID })` is admission-only. Poll `context` for a compaction
  boundary before any model change or restore.
- For cross-provider overflow handling, pre-empt: watch `tokens.input + cache.read` per step and
  `switchModel` before the request that would overflow. Do not expect `retry` to fire.

### 5.7 Tools and agents

- Replace `smart_task` with the built-in `subagent` tool: it already accepts
  `{ agent, sessionID, description, prompt, model?, background? }`. Keep a thin wrapper only if you
  need chain resolution or agent-name mapping.
- If a custom tool is still required, `ctx.tool.transform(editor)` supports `add`/`update`/`remove`
  and is synchronous and replayable; schemas are JSON Schema or Standard Schema; results are
  `{ content?, metadata?, output? }`.
- Agents CAN be created: `ctx.agent.transform(ed => ed.update(id, fn))` is an **upsert** that creates
  missing agents (F1), so every missing fallback agent
  (`architect`, `debugger`, `code-review`, `researcher`, `researcher-vision`, `tester`, `orchestrator`)
  can be registered. Optionally declare them in `opencode.json` / markdown as the fallback.

### 5.8 Config and model limits

- Keep `fallback.json`, read with `node:fs` from `ctx.location.directory` (falling back to
  `OPENCODE_CONFIG_DIR` / `~/.config/opencode`).
- Normalize `"provider/model"` strings to `{ providerID, id }`; support `variant`.
- Replace `client.config.get()` + `loadModelLimits` with `await ctx.model.list()` (read the `data`
  array from the returned `ModelListOutput` — `ctx.model.get()` does **not** exist in 2.2.7; F2) and
  `Model.Info.limit.context`.

### 5.9 HTTP / transport hooks

Retire the global `fetch` patch. Use, in order of preference:

- `ctx.session.hook("model.request")` — mutate `baseURL` / `headers` per model call
- `ctx.session.hook("http.request")` / `("http.response")` — inspect/rewrite HTTP
- `ctx.session.hook("experimental.ws.handshake" | "experimental.ws.send" | "experimental.ws.receive")`
  — WebSocket-backed providers

The retry hook already receives a classified `SessionError.Error`
(`{ type, message, status?, response?: { body }, retryAfterMs? }`), so response sniffing for
classification is no longer needed.

- **D6**: semantic per-model options (temperature, reasoningEffort, thinking `{ type: "enabled", budgetTokens }`)
  are **not** settable via `ctx.session.hook("model.request")`; they must go through
  `ctx.session.hook("context", e => { e.options = ... })` keyed on the active `e.model`. The
  `model.request` hook only carries `{ sessionID, agent, model, kind, baseURL?, headers }` (the
  `baseURL` / `headers` are top-level fields, not nested under `request`).

### 5.10 Concurrency, state, cleanup

- One `Map<sessionID, State>`; per-session promise-chain mutex around `switchModel`.
- `State` is reset on `prompt` admission and removed on idle or session delete; bound map size.
- Hook callbacks must be idempotent and must never throw (see O6).
- `setup` must return cleanup that disposes every `Registration`, aborts the event subscription,
  and clears timers. A leaked subscription keeps the plugin alive across reloads.

---

## 6. Risk register

| ID | Risk | Mitigation |
|----|------|------------|
| R1 | Chain longer than the 10-retry budget never completes | no arbitrary ≤6 cap (live chains are 9–11 models: developer 10, general 11, largeContextFallback 9); use `attempt` as guard, filter blocked/rate-limited models |
| R2 | Durable `model-switched` artifacts on every failover | sticky by default; restore opt-in |
| R3 | Cross-provider context overflow cannot fail over | pre-emptive switch on token headroom |
| R4 | Unavailable chain model → `switchModel` throws → silently swallowed | validate against `await ctx.model.list()`; catch + log |
| R5 | Mid-stream failure creates a continuation message | gate on last assistant message only |
| R6 | User manually switches model mid-turn | compare current model before restore; never fight the user |
| R7 | Retry hook fires for auxiliary calls (`compaction`) | filter on `e.agent === "compaction"` (no `kind` field exists, F3; title never triggers retry); don't switch during compaction |
| R8 | Compaction race on restore | wait for compaction boundary |
| R9 | Agent names in `fallback.json` do not exist | register via `ctx.agent.transform(ed => ed.update(id, fn))` upsert (F1); declare in config as fallback |
| R10 | Secrets in `fallback.log` | redact headers/keys; rate-limit |

---

## 7. Test plan

| # | Test | Assertion |
|---|------|-----------|
| T1 | Plugin loads on 2.2.7 | no `PluginModule.LoadError`; `opencode plugin list` shows it |
| T2 | Retry hook fires on 429 | hook log entry with `attempt`, `error.type` |
| T3 | Quota 402 forces failover | default `retry:false` overridden; next attempt uses new model |
| T4 | Cross-provider switch | session row model changes; next request goes to new provider |
| T5 | Subagent child failover | child `sessionID` switches independently of parent |
| T6 | Budget exhaustion | after 10 attempts the hook stops firing; turn fails cleanly with the original error |
| T7 | Mid-stream failure | continuation assistant message; completion gate still passes |
| T8 | Completion gate | `tool-calls` finish accepted; `length`/`error`/busy tool rejected |
| T9 | Context overflow | compaction runs, no retry hook, no cross-provider switch |
| T10 | Unknown agent in chain | agent upsert via `ctx.agent.transform(ed => ed.update(id, fn))` registers missing agents; chain entries resolve |
| T11 | Model restore | restore only after success + boundary; skipped if user switched |
| T12 | Cleanup | dispose removes hooks, aborts subscription, no timers left; reload is clean |

---

## 8. Sequencing (no code until approved)

0. Skeleton plugin + log only; prove load and hook registration.
1. `retry` hook + `switchModel`, no restore, no chain (single hardcoded target).
2. Chain state, classification, budget/tried guards, `prompt` reset.
3. Completion gate + token accounting on the flat schema.
4. Watchdog on real V2 events.
5. Tools/agents: `subagent` model override, agent upserts via `ctx.agent.transform(ed => ed.update(id, fn))` (F1).
6. Compaction/overflow pre-emption.
7. Cleanup, telemetry, redaction.

Implementation gate: steps 0–1 only after explicit approval; nothing else is approved yet.

## 9. Follow-up verdict incorporated (meta-review cross-check)

The meta-review was itself cross-checked against the same v2.2.7 evidence base. Verdict on the verdict:

### 9.1 Corrections to the meta-review (the verdict's "F" findings)

- **F1 — agent registration (§5.7, R9): the meta-review was wrong.** The plugin context does expose
  `ctx.agent.transform`; `AgentEditor.update(id, fn)` is an **upsert** that creates the agent when
  absent. The plugin can therefore register every missing fallback agent
  (`architect`, `debugger`, `code-review`, `researcher`, `researcher-vision`, `tester`, `orchestrator`)
  via `ctx.agent.transform(ed => ed.update(id, fn))`.
- **F2 — model domain (§5.8): the meta-review was wrong to propose `ctx.model.get`.** `ctx.model` is
  `{ list, default, transform, reload }`; there is no `get`. The port must read the `data` array from
  the `ModelListOutput` returned by `await ctx.model.list()` (it is `{ location, data: Array<Model.Info> }`).
- **F3 — retry hook auxiliary calls (R7): the meta-review was wrong.** The retry event has no `kind`
  field; it is strictly `{ sessionID, agent, model, error, attempt, decision }`. Title never triggers
  retry. Compaction passes the retry hook with `agent: "compaction"`, but resolves its model before
  entering the retry loop — so inside retry, switching the primary model is only a side effect and must
  be filtered on `e.agent === "compaction"`.
- **F4 — subagent children (§2): not an error.** The verdict itself confirms the earlier review verified
  child sessions fire the retry hook with the child's `sessionID` through the same pipeline. Retain.

### 9.2 Regressions in the proposed §5 implementation (must fix before implementation)

- **D1 — §5.2 sticky retries:** onRetry must retry the *same* model within `stickyMs` for transient
  errors without calling `switchModel`; honor `retryAfterMs` / `rateLimitMs` (e.g. 60000 for
  `unorouter-custom` 1 req/min free tier) instead of forcing `delay: 0`. Preserve Breakers,
  `blockedUntil`, and `outProviders`.
- **D2 — auth failover:** fail over on 401/403; V1 semantics marked `retrySameModel: false` and advanced
  the chain on auth failures, so halting on auth defeats multi-provider fallback.
- **D3 — completion gate:** concatenate assistant text across `Ms.Continue` splits; treat
  `finish: "tool-calls"` as valid when tool parts exist (don't require prose); null-safe `tokens`.
- **D4 — watchdog:** pre-token stall means no assistant row exists yet (check `hasStarted` before
  expecting an assistant message); recovery re-prompt must use the payload captured at
  `ctx.session.hook("prompt")` admission, not `findLast(user)` (which may be the synthetic continuation
  and drops files/agents/skills).
- **D5 — chain length:** do not cap at ≤6; live chains are 9–11 models. Filter breaker/blocked/rate-limited
  models before switching.
- **D6 — per-model params:** apply temperature / reasoningEffort / thinking via
  `ctx.session.hook("context", e => e.options = …)` keyed on the active `e.model`; `model.request` only
  carries `baseURL` / `headers`.

**Status update:** D1–D6 have since been incorporated into the proposed §5 snippets above. The failover
snippet now retries the same model inside the sticky window honoring `retryAfterMs` / `rateLimitMs`,
fails over on auth-class failures (401/403), filters `e.agent === "compaction"`, and forces a retry
where the default decision refuses; the completion gate accepts `tool-calls` finishes and is null-safe;
the watchdog handles pre-token stalls; the risk register drops the arbitrary ≤6 chain cap; and per-model
params flow through the context hook. §5 is now the corrected source of truth for implementation.

### 9.3 Converged implementation posture

The corrected blueprint should adopt: agent registration via `ctx.agent.transform(ed => ed.update(id, fn))`;
per-model params via the context hook; retry hook with try/catch + compaction filter + sticky retry +
breaker bookkeeping; overflow pre-check via context hook token headroom; watchdog via prompt-admission
capture; completion gate concatenation; model-list indexing instead of `ctx.model.get()`.
