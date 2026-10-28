# opencode-subagent-fallback

Transparent model fallback for OpenCode, covering **both halves** of a session:

1. **`smart_task`** — a `task`-tool replacement that walks a per-agent fallback chain with a circuit breaker, a wall-clock budget, and a completeness gate.
2. **`parentWatchdog`** — steers, aborts, and re-prompts the **parent** session when the user's own turn stalls or fails.

Built around one observation from the deployed `opencode-auto-fallback` plugin: free-tier aggregator providers are flaky in two distinct ways that need opposite answers.

- **TRANSIENT** (429 without a long reset, 5xx, mid-response cut, cold start) — retry the *same* model inside a sticky window. It resolves in minutes; hopping the chain on the first blip wastes a good model.
- **QUOTA** (explicit reset time, hours) — skip it with a `blockedUntil` stamp and move on immediately. Retrying a dead-for-hours quota is pure waste.

## Why not just use the old plugin

The old plugin walks the chain once and stops, and it does it fast — it can exhaust the entire chain in a couple of seconds. When a model is only *intermittently* unavailable (which is normal for routers: traffic routes to different upstreams, so availability flips working → broken → working), exhausting the chain and giving up is the wrong answer. This plugin loops the chain, benches sick models, and keeps the healthy ones in rotation.

## Configuration

All config lives in `fallback.json`, beside the chains it modulates. The old plugin ignores unknown keys, so both can coexist during migration.

```json
{
  "fallbackBudgetMs": 600000,
  "maxIterations": 10,
  "compactionRatio": 0.4,
  "parentWatchdog": {
    "enabled": true,
    "firstTokenMs": 120000,
    "stallTimeoutMs": 90000
  },
  "providers": {
    "unorouter-custom": {
      "firstTokenMs": 120000,
      "stallTimeoutMs": 90000,
      "retryDelayMs": 20000,
      "skipDelayMs": 0,
      "stickyMs": 180000,
      "maxTimeMs": 300000,
      "timeoutMs": 300000,
      "breaker": { "threshold": 3, "cooldownMs": 60000, "maxCooldownMs": 600000 }
    }
  }
}
```

### Root keys

| Key | Default | Meaning |
|---|---|---|
| `fallbackBudgetMs` | `600000` | Wall-clock ceiling for one walk. |
| `maxIterations` | `10` | Max full passes over the chain. |
| `compactionRatio` | `0.4` | Self-compact at this fraction of the model's context window. |
| `parentWatchdog.enabled` | `false` | Master switch for the parent half. |
| `parentWatchdog.firstTokenMs` | provider's | Override the parent's first-token clock. |
| `parentWatchdog.stallTimeoutMs` | provider's | Override the parent's inactivity clock. |

### Per-provider keys

Provider = the part of `provider/model` before the `/`.

| Key | Meaning |
|---|---|
| `firstTokenMs` | How long the model may stay silent **before its first token**. Generous for slow-prefill providers. |
| `stallTimeoutMs` | Inactivity budget **after** the first token arrived. Inter-chunk silence, not total duration — a legitimately long generation is never killed. |
| `retryDelayMs` | Pause between sticky retries on the same model. |
| `skipDelayMs` | Pause before advancing to the next model on a hard failure. |
| `stickyMs` | The window a transient model keeps being preferred before the chain advances. |
| `maxTimeMs` | Per-pass ceiling on one provider. **Resets each pass** — a provider is never permanently excluded, because router intermittency is normal. |
| `timeoutMs` | Total ceiling for one attempt. |
| `breaker.threshold` | Consecutive failures before the breaker opens. |
| `breaker.cooldownMs` | Base cooldown; doubles per re-trip. |
| `breaker.maxCooldownMs` | Ceiling on the exponential ladder. |

## Failure classification

Grounded in real SDK error shapes — `ApiError.isRetryable` is a first-class field, so we don't guess.

| Class | Signal | Behavior |
|---|---|---|
| `transient` | `isRetryable`, 429 without long reset, 5xx, timeout, truncation | Sticky retry on the same model inside `stickyMs` |
| `quota` | 429 with `Retry-After` > 10 min, or daily-quota wording | Fast skip, `blockedUntil` set, advance immediately |
| `context_too_large` | 413, or "context length" text | Model ruled out for the request; catch-all compaction |
| `auth` / `forbidden` / `model_not_found` | 401 / 403 / 404 | Model ruled out for the request, **no** breaker trip |
| `provider_level` | 5xx, transport, degraded | Bench the model **and** skip the whole provider for the request |
| `fatal` | anything else | Stop the walk entirely |

**Aborts we cause are never provider-health signals.** A `WatchdogAbort` fails the attempt and costs time, but benches nothing — otherwise our own timers would poison healthy models.

## The completeness gate

A partial response is **not** a success. Before returning, we check real SDK fields:

- `AssistantMessage.time.completed` present
- `info.error` absent
- `finish` not `"length"` or `"error"`
- no `ToolPart` still in `running`/`pending`
- text non-empty

Failing any of these fails over instead of returning a truncated answer the parent would mistake for a real one.

## Context pre-filter

Before spending an attempt, any model whose `Model.limit.context` can't hold the conversation is ruled out. This makes the small→large chain discipline **self-enforcing from data** rather than manual ordering — and it's why a 1M → 256k fallback is a *config discipline* problem (shard to different agents), not something the plugin papers over.

The pre-filter uses the **full conversation size** (accumulated tokens from all previous messages + current prompt), not just the current prompt. This prevents small models from being selected for conversations they can't hold.

## Parent watchdog

The parent turn hangs (no parts for `firstTokenMs` / `stallTimeoutMs`) or dies (`session.error`). We abort and re-prompt with the next healthy model in the agent's chain, because the user is staring at a frozen session.

**Agent locking:** The agent type is locked at session start. Only explicit user choice (`input.agent`) updates the agent for fallback chain selection. OpenCode's inferred agent (from model fallback) is ignored — this prevents unintended agent switches when a model falls back to a different agent's primary model.

Mechanism, all grounded in the real hook surface:

- **`chat.message`** — `output.message.model` is a mutable `UserMessage`. Mutating it is the *only* parent-level model lever; `chat.params` cannot change the model.
- **`session.abort`** — kills the in-flight generation.
- **`session.prompt`** — re-issues with a different model.
- **`event`** — liveness stamping and `session.error` observation.

**Known cost:** re-prompting duplicates the user turn in the transcript. Accepted — a frozen user turn is worse than a duplicated one.

**Error handling:** The parent watchdog now re-prompts on `session.error` (rate limits, timeouts, etc.), not just stalls. The agent type is **locked at session start** — only explicit user choice (`input.agent`) changes the fallback chain. OpenCode's inferred agent (from model fallback) is ignored for the fallback chain, preventing unintended agent switches when models fall back.

**Known cost:** re-prompting duplicates the user turn in the transcript. Accepted — a frozen user turn is worse than a duplicated one.

## Compaction discipline

Two tiers, and the distinction matters:

1. **Normal — self-compaction.** At `compactionRatio`, the model *in the seat* summarizes its own session via `session.summarize` with its own provider. The primary keeps its own summary and doesn't forget what it's doing.
2. **Catch-all — `largeContextModel`.** Only when a context-too-large failure slips through the pre-filter. Never routine.

Delegating routine compaction to a different model is the "primary forgets" failure, and it's reserved for the catch-all only.

## Context pre-filter

Before spending an attempt, any model whose `Model.limit.context` can't hold the conversation is ruled out. This makes the small→large chain discipline **self-enforcing from data** rather than manual ordering — and it's why a 1M → 256k fallback is a *config discipline* problem (shard to different agents), not something the plugin papers over.

The pre-filter uses the **full conversation size** (accumulated tokens from all previous messages + current prompt), not just the current prompt. This prevents small models from being selected for conversations they can't hold.

## Compaction discipline

Two tiers, and the distinction matters:

1. **Normal — self-compaction.** At `compactionRatio`, the model *in the seat* summarizes its own session via `session.summarize` with its own provider. The primary keeps its own summary and doesn't forget what it's doing.
2. **Catch-all — `largeContextModel`.** Only when a context-too-large failure slips through the pre-filter. Never routine.

Delegating routine compaction to a different model is the "primary forgets" failure, and it's reserved for the catch-all only.

## Catch-all compaction

When a `context_too_large` failure slips through the pre-filter, the catch-all compaction uses the agent's `largeContextModel` (or the failing model as anchor) with the agent's `largeContextFallback` chain. This runs the same `walkChain` logic with the same sticky retry, breaker, and budget discipline — ensuring compaction survives rate limits and unavailable large models.

The `largeContextFallback` chain lets you specify a dedicated list of 1M+ context models for compaction, separate from the regular fallback chain.

## Parent watchdog

The parent turn hangs (no parts for `firstTokenMs` / `stallTimeoutMs`) or dies (`session.error`). We abort and re-prompt with the next healthy model in the agent's chain, because the user is staring at a frozen session.

**Agent locking:** The agent type is locked at session start. Only explicit user choice (`input.agent`) updates the agent for fallback chain selection. OpenCode's inferred agent (from model fallback) is ignored — this prevents unintended agent switches when a model falls back to another agent's primary model.

Mechanism, all grounded in the real hook surface:

- **`chat.message`** — `output.message.model` is a mutable `UserMessage`. Mutating it is the *only* parent-level model lever; `chat.params` cannot change the model.
- **`session.abort`** — kills the in-flight generation.
- **`session.prompt`** — re-issues with a different model.
- **`event`** — liveness stamping and `session.error` observation.

**Known cost:** re-prompting duplicates the user turn in the transcript. Accepted — a frozen user turn is worse than a duplicated one.

## Subagent context tracking

For `smart_task` subagents, the full conversation token count (from `client.session.messages`) is added to the pre-filter estimate. This prevents small-context models from being selected for large conversations in subagent sessions.

The catch-all compaction for subagents uses the subagent's own `largeContextFallback` chain, with its own sticky retry, breaker, and budget discipline — ensuring compaction survives rate limits and unavailable large models.

## Installation

```json
{
  "plugin": ["C:/Users/axelr/OneDrive/Documents/GitHub/opencode-subagent-fallback/src/index.ts"]
}
```

The plugin loads from `.ts` directly — no build step needed for testing.

To make `smart_task` the delegation path, deny the built-in tool on primary agents and allow the wrapper:

```json
{
  "agent": {
    "developer": {
      "permission": { "task": "deny", "smart_task": "allow" }
    }
  }
}
```

And `"smart_task": "deny"` on subagents to prevent recursion.

## Installation

```json
{
  "plugin": ["C:/Users/axelr/OneDrive/Documents/GitHub/opencode-subagent-fallback/src/index.ts"]
}
```

The plugin loads from `.ts` directly — no build step needed for testing.

To make `smart_task` the delegation path, deny the built-in tool on primary agents and allow the wrapper:

```json
{
  "agent": {
    "developer": {
      "permission": { "task": "deny", "smart_task": "allow" }
    }
  }
}
```

And `"smart_task": "deny"` on subagents to prevent recursion.

## Testing

```powershell
cd C:\Users\axelr\OneDrive\Documents\GitHub\opencode-subagent-fallback
npm run typecheck
npm test
```

`npm test` runs `src/selftest.ts` — 30 assertions over the classifier, the completeness gate, and 12 walk invariants (sticky retry, quota fast-skip, provider-level skip, breaker trip, fatal stop, budget bound, watchdog abort, sticky lapse, pre-filter, trail recording). No provider, no network.

Isolated end-to-end run:

```powershell
$env:OPENCODE_CONFIG_DIR = "C:\Users\axelr\opencode-test"
opencode run --print-logs --agent developer "use smart_task to ask the architect for a one-paragraph 3-tier cache design"
```

`--print-logs` surfaces the `[subagent-fallback]` trail on stderr.

## Known gaps

- **Config discovery** reads `OPENCODE_CONFIG_DIR` then `~/.config/opencode`. Project-level `fallback.json` is not yet supported.
- **Agent discovery** uses `client.config.get()`, which covers markdown-defined agents, but this is unverified against the `agents/` directory.
- **In-process state only.** Breakers, anchors, and `blockedUntil` are gone on restart — deliberate, per the no-persistence decision.
- **No concurrency semaphore.** Cross-session contention is absorbed by timeouts, retries, and breakers rather than a lock.

## License

MIT
