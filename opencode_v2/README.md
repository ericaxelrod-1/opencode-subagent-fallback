# opencode-subagent-fallback (V2)

Transparent model failover, rate-limit resilience, context-overflow routing, and stall recovery for OpenCode 2.x (`opencode_v2`).

Unlike the V1 plugin—which patched `globalThis.fetch` and drove retries via synthetic continuation turns—the V2 plugin integrates directly with OpenCode 2.x's native session hooks (`retry`, `prompt`, `context`, `experimental.idle`, `model.request`, `tool.transform`, `agent.transform`, and `event` streams).

---

## Architecture Overview

In OpenCode 2.x, the server's `SessionRunner.runStep` owns the attempt loop:

```text
attempt fails → session.hook("retry") → switchModel() + mutate e.decision → Retry | Stop
```

Because `ctx.session.switchModel({ sessionID, model })` updates the session's active model **in-step** and a retry clears cached prepared context, the next attempt immediately dispatches to the fallback model without creating a new turn or injecting synthetic user prompts.

### Source Layout

- [src/index.ts](src/index.ts) — Plugin entry (`{ id: "subagent-fallback", setup(ctx) }`) that wires all V2 hooks and event subscriptions.
- [src/core.ts](src/core.ts) — Failover engine: error classification, sticky/rate-limit/quota handling, circuit breakers, multi-pass chain walking, 10-attempt step rollover, context-overflow pre-emption, completion gate, watchdog, and telemetry.
- [src/selftest.ts](src/selftest.ts) — Hermetic unit and regression test suite (`npm test`).

---

## Registered Plugin Hooks

| Hook / Subscription | Handler | Responsibility |
| --- | --- | --- |
| `session.hook("retry")` | `onRetry` | Classifies errors, enforces sticky windows, manages rate-limit/quota cooldowns & breakers, switches models in-step, and triggers attempt-budget rollover. |
| `session.hook("prompt")` | `onPrompt` | Captures prompt payload for rollover/watchdog recovery, resets per-turn state on real user turns, locks the session's agent, and arms liveness tracking. |
| `session.hook("context")` | `onContext` | Applies per-model semantic options (`temperature`, `reasoningEffort`, `thinking`), refreshes the per-step `firstTokenMs` clock, and preempts context overflows. |
| `session.hook("experimental.idle")` | `onIdle` | Unregisters watchdog liveness on idle and optionally restores the original model when `restoreOnSuccess: true`. |
| `session.hook("model.request")` | `onModelRequest` | Non-invasive transport hook (preserves native provider routing). |
| `session.hook("http.request")` / `"http.response"` | `onHttpRequest` / `onHttpResponse` | Transport inspection points (no `fetch` patching). |
| `tool.transform` | `installTools` | Updates the built-in `subagent` tool description to advertise automatic fallback while preserving its schema. |
| `agent.transform` | `installAgents` | Upserts missing custom agents from `fallback.json` and preserves built-in agent modes (`primary` vs `subagent`). |
| `ctx.event.subscribe()` | `consumeEvents` / `handleEvent` | Tracks streaming liveness (`session.text.*`, `session.reasoning.*`, `session.tool.*`, `session.step.*`, `session.retry.*`) and token usage. |

---

## Key Features & Behavior

### 1. Error Classification

`classifyError` maps V2 `SessionError` types (`provider.*`), HTTP status codes, headers, and message patterns into 8 classes:

| Class | Triggers | Failover Behavior |
| --- | --- | --- |
| `transient` | HTTP 429 (within `quotaThresholdMs`), overloaded/busy responses, timeouts, transport/5xx-like blips, `WatchdogAbort` | Retries in-place during `stickyMs`; advances chain once `stickyMs` lapses; eligible for 2nd+ pass. |
| `quota` | HTTP 402, `provider.quota`, free-tier/daily quota exhausted, or `Retry-After` > `quotaThresholdMs` (default 10 min) | Fails over immediately; blocks model cross-turn in `blockedUntilByModel`; excluded for the turn. |
| `context_too_large` | HTTP 413, `context_overflow`, token-limit errors | Routes immediately to the large-context fallback chain; excluded for the turn. |
| `auth` | HTTP 401, `provider.auth` | Fails over immediately; invalidates the whole provider for the turn (`outProviders`). |
| `forbidden` | HTTP 403, `provider.forbidden` | Fails over immediately; invalidates the whole provider for the turn (`outProviders`). |
| `provider_level` | HTTP 5xx, `provider.internal` | Fails over immediately; records breaker failure and invalidates the provider for the turn. |
| `model_not_found` | HTTP 404, `provider.not-found` | Fails over immediately; excluded for the turn. |
| `fatal` | Unrecoverable 4xx (e.g. 400/418) | Leaves OpenCode's default decision untouched; no failover. |

### 2. Generic Rate-Limit, Sticky Window & Quota Handling

Rate limits and quotas are handled uniformly across providers via configuration in `~/.config/opencode/fallback.json`:

- **Sticky Window (`stickyMs`):** On the first `transient` error for the current seat, a sticky deadline (`now() + stickyMs`) is opened. Subsequent `transient` errors before that deadline retry the **same model** without switching, allowing brief rate limits or service-overload blips to clear without burning fallback hops.
- **Retry Delay Precedence (during `stickyMs`):**
  1. Explicit server `retryAfterMs` (from `Retry-After` / `x-ratelimit-reset` headers or error payload)
  2. Active per-model `rateLimitedUntil` timestamp
  3. Provider `rateLimitMs` (if explicitly configured for strict per-minute rate-limited providers)
  4. Provider `retryDelayMs` (fast sticky retries, e.g. `5000ms` or `10000ms`)
  5. `interceptor.fastRetryMs` (`500ms` default) → exponential backoff fallback
- **Cross-Turn Quota Cooldowns (`blockedUntilByModel`):** When a `quota` error occurs, `parseQuotaBlockedUntil` extracts reset hints (e.g. `"resets in 3600s"`, `"retry in 5 minutes"`) or falls back to `budgets.quotaThresholdMs` (`600000ms`), skipping that model across sessions/turns until the cooldown expires.
- **Per-Model Circuit Breakers (`Breaker`):** Consecutive `transient` or `provider_level` failures increment a model's breaker. Reaching `breaker.threshold` opens the circuit for `breaker.cooldownMs` and doubles the cooldown on repeated trips up to `breaker.maxCooldownMs`. Completing a turn resets the streak (`recordSuccess()`).

### 3. Failover Chain, Agent Locking & Multi-Pass Cycling

- **Chain Resolution (`fallbackChainFor`):** Builds a deduplicated ordered list from:
  `agents[agent].fallback` → `agents[agent].largeContextFallback` → `defaultFallback` → `defaultLargeContextFallback` (with `defaults.*` normalized automatically).
- **Catalog Validation:** Before switching, `onRetry` checks `ctx.model.list()` (cached) and drops models not present in the live catalog instead of letting `switchModel` throw on an unavailable ID.
- **Agent Locking:** The session's agent is locked at turn start (`onPrompt`) so retry events cannot accidentally rebuild the chain for a different agent; only an explicit user agent switch updates the lock.
- **Multi-Pass Cycling:**
  - Within a pass, `st.tried` ensures each model is tried once before moving on.
  - Non-retryable-for-turn errors (`quota`, `auth`, `forbidden`, `model_not_found`, `context_too_large`) are recorded in `st.permFailed`.
  - When a pass exhausts all candidates via `transient` / `provider_level` failures and both `budgets.fallbackBudgetMs` and `budgets.maxIterations` still have room, `st.tried` resets (preserving `st.permFailed`, `outProviders`, open breakers, and active `blockedUntilByModel` cooldowns) and begins a fresh pass over the chain.

### 4. Step Rollover at OpenCode's 10-Attempt Ceiling

OpenCode 2.x enforces a hard `MAX_RETRY_ATTEMPTS = 10` ceiling per step. When `e.attempt >= 10` and budget/iterations remain:

1. `scheduleRolloverIfSpent` converts the retry into a clean step stop (`e.decision = { retry: false }`), resets `st.lastAttempt = -1` (so the upcoming `attempt=0` is not misclassified as a brand-new user turn), and defers the watchdog across the sleep.
2. After the calculated delay, the plugin re-prompts the session (`ctx.session.prompt(...)`) with the captured prompt payload (`resume: true`), giving OpenCode a fresh 10-attempt step while **preserving** `st.tried`, `st.permFailed`, `st.seat`, `st.hops`, and `st.deadline`.

### 5. Context-Overflow Pre-emption, Dynamic Compaction Curve & Large-Context Routing

- **Dynamic Logarithmic Compaction Curve (`dynamicCompactionRatio`):** Rather than using a static trigger percentage across wildly disparate window sizes (which forces premature compaction on small models and risks context rot/cost explosions on large models), proactive compaction follows a dynamic logarithmic curve anchored to `compactionRatio` (default `0.4` = 40%) at the high end and 85% at the low end:
  $$\text{Ratio}(W) = R_{\min} + (0.85 - R_{\min}) \times \frac{\log_2(1{,}048{,}576) - \log_2(W)}{\log_2(1{,}048{,}576) - \log_2(32{,}768)}$$
  - **Below 32k ($W \le 32\text{k}$):** Clamped flat at **0.85 (85%)**, reserving a strict 15% safety headroom margin for assistant output and incoming tool results.
  - **Above 1M ($W \ge 1\text{M}$):** Clamped at `compactionRatio` (e.g. 40% on 1M = 400k tokens, 800k on 2M).
  - **Above 0.85:** Hard-capped at **0.85**; configuring `compactionRatio >= 0.85` flattens the curve to 0.85 across all models to protect generation headroom.
  - **Intermediate Models:** Interpolates smoothly (e.g. 64k $\rightarrow$ 76%, 128k $\rightarrow$ 67%, `big-pickle` 136k usable $\rightarrow$ 66.5% / 90.4k tokens, 200k nominal $\rightarrow$ 61.5% / 123k tokens, 500k $\rightarrow$ 50%).
  - **Dynamic Slope:** Modifying `compactionRatio` in `fallback.json` recalculates the entire slope (e.g. setting `0.30` drops the 1M trigger to 300k tokens while keeping $\le 32\text{k}$ models safely at 85%).
- **Prompt Double-Counting Protection:** `conversationTokens` tracks `st.promptPending`. Prompt character estimations are only factored into context size on turn 1 or before the assistant's initial token chunk arrives. Once measured context tokens (`input + cache.read`) are received via event stream or hydrated from SQLite, `promptPending` is cleared, ensuring prompts and file attachments are never counted twice during tool calls or retries.
- **Pre-flight Pre-emption (`onContext`):** Evaluates estimated conversation size against `limit * dynamicCompactionRatio(limit)`. If threshold is met, proactive self-compaction triggers (`ctx.session.compact`) with watchdog debounce. If conversation exceeds the model's usable limit, it preemptively switches to the large-context chain (`largeContextModel` → `agents[agent].largeContextFallback` → `defaultLargeContextFallback`).
- **Pre-filter (`onRetry`):** Before switching to any fallback candidate, checks `contextFits()`; candidates too small for the current conversation are skipped in favor of the large-context chain.

### 6. Liveness Watchdog & Completion Gate

When `watchdog.enabled` is `true`, a periodic sweep (`sweepIntervalMs`, default `5000ms`) monitors active sessions:

- **Pre-token & Mid-stream Guards:** Interrupts and recovers if no first token arrives within `firstTokenMs` (refreshed per LLM step in `onContext`) or if streaming stalls for `stallTimeoutMs`.
- **Retry-Sleep Deferral:** `deferLiveness(sid, delay)` pauses the watchdog (`pausedUntil`) during `onRetry` backoff/cooldown sleeps so the watchdog never aborts a sleeping retry.
- **Tool / Subagent Wait Protection:** Before interrupting, `runSweep` inspects `ctx.session.context` and skips interruption if the last assistant message has a `running`, `streaming`, or `pending` tool part (e.g., a parent session waiting on a long-running `subagent` call).
- **Terminal & Completion Cleanup:** `runSweep`, `recover`, and `onIdle` unregister liveness cleanly when `checkCompletion(msgs)` passes or when a trailing `idle` message (`outcome: "succeeded"` or `"failed"`) is present, preventing post-completion re-prompt loops.

### 7. Restore Policy & Per-Model Semantic Options

- **Sticky by Default:** Switched fallback models remain active for subsequent turns unless `"restoreOnSuccess": true` is configured, in which case `onIdle` restores `originalSeat` after a verified completion (unless the user manually switched models mid-turn).
- **Semantic Options:** Matching entries in `fallback.json` inject `temperature`, `reasoningEffort`, and `thinking` into `e.options` via `onContext`.

---

## Configuration (`~/.config/opencode/fallback.json`)

The config loader supports JSON with `//` / `/* */` comments and trailing commas, hot-reloaded by file `mtime`. Key top-level sections:

- `budgets`: `fallbackBudgetMs` (`600000`), `maxIterations` (`10`), `compactionRatio` (`0.4`), `charsPerToken` (`4`), `quotaThresholdMs` (`600000`), `maxCooldownSleepMs` (`30000`)
- `interceptor`: `fastRetryMs` (`500`), `defaultRateLimitMs` (`60000`), `maxCooldownSleepMs` (`60000`)
- `watchdog` / `parentWatchdog`: `enabled`, `firstTokenMs`, `stallTimeoutMs`, `sweepIntervalMs`, `debounceMs`, `compactionDebounceMs`
- `providerDefaults` & `providers.<providerID>`: `firstTokenMs`, `stallTimeoutMs`, `retryDelayMs`, `skipDelayMs`, `stickyMs`, `maxTimeMs`, `timeoutMs`, `rateLimitMs`, `breaker` (`threshold`, `cooldownMs`, `maxCooldownMs`)
- `defaults` & `agents.<agentName>`: `fallback`, `largeContextModel`, `largeContextFallback`, `minContextRatio`
- `restoreOnSuccess`: boolean (`false` by default)

---

## Logging & Diagnostics

All failover decisions, model switches, rollovers, and watchdog events are appended (with `sk-*` keys and `Bearer` tokens redacted) to:

```text
~/.local/share/opencode/log/fallback.log
```

Set `OPENCODE_FALLBACK_CONSOLE=1` to also mirror log lines to `stderr`.

---

## Development & Testing

```bash
cd opencode_v2
npm run build      # Compile TypeScript → dist/
npm run typecheck  # Type-check without emitting
npm test           # Build and run dist/selftest.js
```
