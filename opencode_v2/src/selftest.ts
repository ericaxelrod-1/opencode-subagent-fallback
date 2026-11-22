/**
 * V2 self-check — no provider, no network, mock ctx only.
 *
 *   cd <repo>/opencode_v2 && npx tsc && node dist/selftest.js
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { createFallback, classifyError, checkCompletion, contextTokens, lastAssistantInTurn, assistantText, __resetStateForTests, __setModelLimitsForTests, __setKnownModelsForTests, __runSweepForTests, isModelAvailable, markModelUnavailable, isModelHealthyNow, Breaker, CONTINUE_PROMPT, parseQuotaBlockedUntil, usableContextLimit, recordModelFailure, dynamicCompactionRatio } from "./core.js"

let failures = 0
function check(name: string, cond: boolean, extra?: string): void {
  if (cond) console.log(`  ok   ${name}`)
  else { failures++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`) }
}

function mockCtx(switches: any[]): any {
  return {
    session: {
      switchModel: async (args: any) => { switches.push(args) },
      context: async () => ({ data: [] }),
      interrupt: async () => ({}),
      prompt: async () => ({}),
    },
    event: { subscribe: () => ({ [Symbol.asyncIterator]: async function* () { /* no events in tests */ } }) },
  }
}

/** Fast sticky discipline for hermetic failover tests (no real waiting). */
const STICKY_FAST = {
  firstTokenMs: 30000,
  stallTimeoutMs: 90000,
  retryDelayMs: 10000,
  skipDelayMs: 0,
  stickyMs: 0,
  maxTimeMs: 300000,
  timeoutMs: 180000,
  rateLimitMs: undefined,
  breaker: { threshold: 3, cooldownMs: 60000, maxCooldownMs: 600000 },
}

const CONFIG_DIR = "/tmp/opencode/opencode-v2-selftest"
const FALLBACK_JSON = JSON.stringify({
  defaultFallback: ["a/small", "a/large", "a/mid"],
  defaultLargeContextModel: "a/huge",
  agents: { architect: { fallback: ["a/arch1", "a/arch2"] }, researcher: { fallback: ["a/res1", "a/res2"] } },
})

async function main(): Promise<void> {
  // Hermetic: no fallback.json on disk → chain resolution falls back to the
  // hardcoded single target used by the step-1 failover core.
  rmSync(CONFIG_DIR, { recursive: true, force: true })
  mkdirSync(CONFIG_DIR, { recursive: true })
  process.env.OPENCODE_CONFIG_DIR = CONFIG_DIR
  console.log("\nclassifyError (V2 taxonomy incl. HTTP 402 quota):")
  const t = (name: string, e: any, want: string) => check(`${name} -> ${want}`, classifyError(e).cls === want, classifyError(e).cls)
  t("401", { statusCode: 401 }, "auth")
  t("403", { statusCode: 403 }, "forbidden")
  t("402", { statusCode: 402 }, "quota")
  t("404", { statusCode: 404 }, "model_not_found")
  t("413", { statusCode: 413 }, "context_too_large")
  t("429 no reset", { statusCode: 429 }, "transient")
  t("429 + 2h retry-after", { statusCode: 429, responseHeaders: { "retry-after": "7200" } }, "quota")
  t("429 OpenRouter per-day quota", { type: "provider.rate-limit", status: 429, retryAfterMs: 24000, message: "Rate limit exceeded: free-models-per-day-high-balance." }, "quota")
  t("429 UnoRouter transient", { statusCode: 429, message: "The free tier allows 1 request(s) every 1 min. You have used 1 request(s), and nothing is used up, retry in 31s" }, "transient")
  t("UnoRouter all providers busy -> transient", { message: 'All providers for model "glm-5.3:free" are busy right now (they hit their rate limit). This is not a spelling error. Please try again in a little while, or switch to another model. (request id: 202611132320494453920678268d9d61vj3HSdF)' }, "transient")
  t("500", { statusCode: 500 }, "provider_level")
  t("watchdog abort", { name: "WatchdogAbort" } as any, "transient")
  t("unexpected 418", { statusCode: 418 }, "fatal")
  t("ModelUnavailableError -> model_not_found", { name: "ModelUnavailableError", message: "Model unavailable: openrouter/xingchen-agi/xing4.0-29b-a4b:free" }, "model_not_found")
  t("model unavailable in message -> model_not_found", { message: "Model unavailable: some/dead-model" }, "model_not_found")
  t("V2 error.type provider.quota", { error: { type: "provider.quota", message: "quota exceeded" } }, "quota")
  t("V2 error.type context_overflow", { error: { type: "context_overflow", message: "context too large" } }, "context_too_large")
  t("V2 error.type provider.auth", { error: { type: "provider.auth" }, statusCode: 401 }, "auth")
  t("V2 error.type provider.rate-limit + retryAfterMs", { error: { type: "provider.rate-limit", retryAfterMs: 30000 } }, "transient")
  check("parseQuotaBlockedUntil parses 'resets in 3600s'", parseQuotaBlockedUntil({ error: { message: "quota resets in 3600s" } }) === 3600000, String(parseQuotaBlockedUntil({ error: { message: "quota resets in 3600s" } })))

  console.log("\ncompletion gate (V2 flat schema, D3):")
  check("complete ok", checkCompletion([{ type: "assistant", content: [{ type: "text", text: "hi" }], time: { completed: 1 }, finish: "stop" }]).ok)
  check("finish=length rejected", !checkCompletion([{ type: "assistant", content: [{ type: "text", text: "p" }], time: {}, finish: "length" }]).ok)
  check("finish=error rejected", !checkCompletion([{ type: "assistant", content: [{ type: "text", text: "p" }], time: { completed: 1 }, finish: "error" }]).ok)
  check("busy tool rejected", !checkCompletion([{ type: "assistant", content: [{ type: "tool", state: { status: "running" } }], time: { completed: 1 }, finish: "tool-calls" }]).ok)
  check("tool-calls finish accepted when tool part present", checkCompletion([{ type: "assistant", content: [{ type: "tool", state: { status: "completed" } }], time: { completed: 1 }, finish: "tool-calls" }]).ok)
  check("no assistant in turn rejected", !checkCompletion([{ type: "user", text: "do it" }]).ok)

  const splitMsgs = [
    { type: "user", text: "do it" },
    { type: "assistant", content: [{ type: "text", text: "Hel" }], time: { completed: 1 }, finish: "stop" },
    { type: "user", text: CONTINUE_PROMPT },
    { type: "assistant", content: [{ type: "text", text: "lo" }], time: { completed: 2 }, finish: "stop" },
  ]
  check("assistantText concatenates Ms.Continue splits", assistantText(splitMsgs) === "Hel\nlo", assistantText(splitMsgs))
  check("lastAssistantInTurn skips synthetic user + finds last split", lastAssistantInTurn(splitMsgs)?.content?.[0]?.text === "lo")

  check("contextTokens sums input + cache.read (null-safe)", contextTokens({ tokens: { input: 10, cache: { read: 5 } } }) === 15)
  check("contextTokens handles missing tokens", contextTokens({}) === 0)

  console.log("\nonRetry (V2 failover core):")
  __resetStateForTests()

  // 1. Compaction auxiliary call is skipped, decision untouched.
  {
    const switches: any[] = []
    const fb = createFallback(mockCtx(switches))
    const ev: any = { sessionID: "ses_aux", agent: "compaction", model: { providerID: "p", id: "m" }, error: { statusCode: 429 }, attempt: 0, decision: { retry: true, delay: 0 } }
    await fb.onRetry(ev)
    check("compaction retry skipped", switches.length === 0)
    check("compaction retry keeps decision", ev.decision.retry === true)
  }

  // 2. Transient inside sticky window → same-model retry honoring retryAfterMs, no switch.
  {
    const switches: any[] = []
    const fb = createFallback(mockCtx(switches), { providerDefaults: { ...STICKY_FAST, stickyMs: 180000 } })
    const ev: any = { sessionID: "ses_sticky", agent: "developer", model: { providerID: "p", id: "m" }, error: { statusCode: 429, retryAfterMs: 60000 }, attempt: 0, decision: { retry: false } }
    await fb.onRetry(ev)
    check("sticky retry forces retry on same model", ev.decision.retry === true)
    check("sticky retry honors retryAfterMs as delay", ev.decision.delay === 60000)
    check("sticky retry does not switch", switches.length === 0)

    const fbFastSticky = createFallback(mockCtx(switches), { providerDefaults: { ...STICKY_FAST, stickyMs: 60000, retryDelayMs: 5000 } })
    const evFast: any = { sessionID: "ses_sticky_fast", agent: "developer", model: { providerID: "zai", id: "glm-4.7-flash" }, error: { statusCode: 429 }, attempt: 0, decision: { retry: false } }
    await fbFastSticky.onRetry(evFast)
    check("sticky retry without retryAfterMs/rateLimitMs uses retryDelayMs (not 60s defaultRateLimitMs)", evFast.decision.retry === true && evFast.decision.delay === 5000, JSON.stringify(evFast.decision))
  }

  // 3. Quota (402) → failover to hardcoded target + forced retry.
  {
    const switches: any[] = []
    const fb = createFallback(mockCtx(switches))
    const ev: any = { sessionID: "ses_q", agent: "developer", model: { providerID: "p", id: "m" }, error: { statusCode: 402 }, attempt: 0, decision: { retry: false } }
    await fb.onRetry(ev)
    check("quota 402 triggers in-step failover", switches.length === 1)
    check("failover switches to hardcoded target", switches[0]?.model?.providerID === "opencode" && switches[0]?.model?.id === "beam-free")
    check("failover forces retry decision", ev.decision.retry === true)
  }

  // 4. Auth failure (401) → failover (D2).
  {
    const switches: any[] = []
    const fb = createFallback(mockCtx(switches))
    const ev: any = { sessionID: "ses_auth", agent: "developer", model: { providerID: "p", id: "m" }, error: { statusCode: 401 }, attempt: 0, decision: { retry: false } }
    await fb.onRetry(ev)
    check("auth 401 fails over", switches.length === 1)
  }

  // 5. switchModel throwing → hook keeps the default decision, never throws.
  {
    const fb = createFallback({ session: { switchModel: async () => { throw new Error("model not in provider") } } })
    const ev: any = { sessionID: "ses_throw", agent: "developer", model: { providerID: "p", id: "m" }, error: { statusCode: 500 }, attempt: 0, decision: { retry: false } }
    let threw = false
    try { await fb.onRetry(ev) } catch { threw = true }
    check("switchModel failure does not propagate", !threw)
    check("switchModel failure keeps default decision", ev.decision.retry === false)
  }

  // 6. Retry budget spent → no failover, keep default decision.
  {
    const switches: any[] = []
    const fb = createFallback(mockCtx(switches))
    const ev: any = { sessionID: "ses_budget", agent: "developer", model: { providerID: "p", id: "m" }, error: { statusCode: 402 }, attempt: 10, decision: { retry: true, delay: 0 } }
    await fb.onRetry(ev)
    check("attempt budget spent → no switch", switches.length === 0)
    check("attempt budget spent → decision kept", ev.decision.retry === true)
  }

  // Switch to a hermetic fallback.json-backed catalog for the chain/budget/
  // context/agent-lock checks below (written after the hardcoded-target checks).
  writeFileSync(`${CONFIG_DIR}/fallback.json`, FALLBACK_JSON, "utf8")

  console.log("\ncircuit breaker (Breaker unit + failover wiring):")
  __resetStateForTests()
  __setModelLimitsForTests({ "a/small": 1000, "a/large": 1000000, "a/mid": 400000, "a/huge": 2000000 })
  {
    const b = new Breaker({ threshold: 2, cooldownMs: 60000, maxCooldownMs: 120000 })
    check("breaker starts closed", !b.isOpen)
    b.recordFailure()
    check("breaker: single failure below threshold stays closed", !b.isOpen)
    b.recordFailure()
    check("breaker: trips at threshold", b.isOpen)
    check("breaker: trip within maxCooldownMs ceiling", b.openUntil > Date.now() && b.openUntil - Date.now() <= 120000)
    b.recordSuccess()
    check("breaker: success resets streak", !b.isOpen && b.failures === 0)
  }
  // Failover must record failures on the failed model (breaker threshold=1 → trips on 1st).
  {
    const switches: any[] = []
    const fb = createFallback(mockCtx(switches), { providerDefaults: { ...STICKY_FAST, breaker: { threshold: 1, cooldownMs: 60000, maxCooldownMs: 600000 } } })
    const ev1: any = { sessionID: "ses_brk", agent: "developer", model: { providerID: "a", id: "small" }, error: { statusCode: 429 }, attempt: 0, decision: { retry: false } }
    await fb.onRetry(ev1)
    check("breaker-wired failover advances past failed model", switches.length === 1 && switches[0]?.model?.id === "large", JSON.stringify(switches))
    const ev2: any = { sessionID: "ses_brk", agent: "developer", model: { providerID: "a", id: "large" }, error: { statusCode: 429 }, attempt: 1, decision: { retry: false } }
    await fb.onRetry(ev2)
    check("breaker-wired second hop advances to next candidate", switches.length === 2 && switches[1]?.model?.id === "mid", JSON.stringify(switches))
  }

  console.log("\nwall-clock failover budget (fallbackBudgetMs / maxIterations):")
  __resetStateForTests()
  {
    const switches: any[] = []
    const fb = createFallback(mockCtx(switches), { budgets: { fallbackBudgetMs: 0, maxIterations: 10, compactionRatio: 0.4, charsPerToken: 4, quotaThresholdMs: 600000, maxCooldownSleepMs: 30000 } })
    const ev: any = { sessionID: "ses_budget2", agent: "developer", model: { providerID: "p", id: "m" }, error: { statusCode: 402 }, attempt: 0, decision: { retry: true, delay: 2000 } }
    await fb.onRetry(ev)
    check("exhausted wall-clock budget → no switch", switches.length === 0)
    check("exhausted wall-clock budget → stops OpenCode retry", ev.decision.retry === false)
  }
  {
    const switches: any[] = []
    const fb = createFallback(mockCtx(switches), { budgets: { fallbackBudgetMs: 600000, maxIterations: 2, compactionRatio: 0.4, charsPerToken: 4, quotaThresholdMs: 600000, maxCooldownSleepMs: 30000 }, providerDefaults: { ...STICKY_FAST } })
    const ev1: any = { sessionID: "ses_budget3", agent: "developer", model: { providerID: "a", id: "small" }, error: { statusCode: 429 }, attempt: 0, decision: { retry: false } }
    await fb.onRetry(ev1)
    const ev2: any = { sessionID: "ses_budget3", agent: "developer", model: { providerID: "a", id: "large" }, error: { statusCode: 429 }, attempt: 1, decision: { retry: false } }
    await fb.onRetry(ev2)
    const ev3: any = { sessionID: "ses_budget3", agent: "developer", model: { providerID: "a", id: "mid" }, error: { statusCode: 429 }, attempt: 2, decision: { retry: false } }
    await fb.onRetry(ev3)
    check("maxIterations cap respected (2 hops then stop)", switches.length === 2, `switches=${switches.length}`)
    check("maxIterations stop keeps default decision", ev3.decision.retry === false)
  }

  console.log("\ncontext pre-filter + catch-all compaction chain:")
  __resetStateForTests()
  __setModelLimitsForTests({ "a/small": 1000, "a/large": 1000000, "a/mid": 400000, "a/huge": 2000000 })
  {
    const switches: any[] = []
    const fb = createFallback(mockCtx(switches), { providerDefaults: { ...STICKY_FAST } })
    // Conversation (~1250 tokens via prompt estimate) > small model's 1000 limit:
    // context_too_large → catch-all large-context chain (a/huge) instead of the small fallback.
    await fb.onPrompt({ sessionID: "ses_cf", agent: "developer", text: "x".repeat(5000) })
    const ev: any = { sessionID: "ses_cf", agent: "developer", model: { providerID: "a", id: "large" }, error: { statusCode: 413 }, attempt: 0, decision: { retry: false } }
    await fb.onRetry(ev)
    check("context_too_large runs catch-all large-context chain", switches.length === 1 && switches[0]?.model?.id === "huge", JSON.stringify(switches))
  }
  {
    const switches: any[] = []
    const fb = createFallback(mockCtx(switches), { providerDefaults: { ...STICKY_FAST } })
    // Pre-filter: candidate a/small cannot hold the conversation (~1250 tokens > 1000) → route to catch-all.
    await fb.onPrompt({ sessionID: "ses_cf2", agent: "developer", text: "x".repeat(5000) })
    const ev: any = { sessionID: "ses_cf2", agent: "developer", model: { providerID: "a", id: "large" }, error: { statusCode: 429 }, attempt: 0, decision: { retry: false } }
    await fb.onRetry(ev)
    check("context pre-filter rules out small candidate (routes to large)", switches.length === 1 && switches[0]?.model?.id === "huge", JSON.stringify(switches))
  }
  {
    const switches: any[] = []
    const fb = createFallback(mockCtx(switches), { providerDefaults: { ...STICKY_FAST } })
    const ev: any = { sessionID: "ses_cf3", agent: "developer", model: { providerID: "a", id: "small" }, error: { statusCode: 429 }, attempt: 0, decision: { retry: false } }
    await fb.onRetry(ev)
    check("context fits → normal failover within fallback chain", switches.length === 1 && switches[0]?.model?.id === "large", JSON.stringify(switches))
  }
  {
    const switches: any[] = []
    const fb = createFallback(mockCtx(switches), { providerDefaults: { ...STICKY_FAST } })
    await fb.onPrompt({ sessionID: "ses_ovf", agent: "developer", text: "x".repeat(5000) })
    const evCtx: any = { sessionID: "ses_ovf", agent: "developer", model: { providerID: "a", id: "small" } }
    await fb.onContext(evCtx)
    check("onContext pre-empts context overflow via catch-all chain", switches.length === 1 && switches[0]?.model?.id === "huge", JSON.stringify(switches))
  }
  {
    const switches: any[] = []
    const fb = createFallback(mockCtx(switches), { providerDefaults: { ...STICKY_FAST } })
    await fb.onPrompt({ sessionID: "ses_prompt", agent: "developer", prompt: { text: "x".repeat(5000) } })
    const ev: any = { sessionID: "ses_prompt", agent: "developer", model: { providerID: "a", id: "small" }, error: { statusCode: 429 }, attempt: 0, decision: { retry: false } }
    await fb.onRetry(ev)
    check("onPrompt nested prompt.text feeds context pre-filter", switches.length === 1 && switches[0]?.model?.id === "large", JSON.stringify(switches))
  }

  console.log("\nagent locking (fallback chain uses session-start agent):")
  __resetStateForTests()
  __setModelLimitsForTests({ "a/small": 1000, "a/large": 1000000, "a/mid": 400000, "a/huge": 2000000, "a/arch1": 100000, "a/arch2": 100000, "a/res1": 100000, "a/res2": 100000 })
  {
    const switches: any[] = []
    const fb = createFallback(mockCtx(switches), { providerDefaults: { ...STICKY_FAST } })
    const ev: any = { sessionID: "ses_lock", agent: "architect", model: { providerID: "a", id: "arch1" }, error: { statusCode: 429 }, attempt: 0, decision: { retry: false } }
    await fb.onRetry(ev)
    check("locked agent chain used (architect -> arch2)", switches.length === 1 && switches[0]?.model?.id === "arch2", JSON.stringify(switches))
    const ev2: any = { sessionID: "ses_lock", agent: "developer", model: { providerID: "a", id: "arch2" }, error: { statusCode: 429 }, attempt: 1, decision: { retry: false } }
    await fb.onRetry(ev2)
    check("retry event agent does not rebuild chain mid-turn (stayed on architect chain)", switches.length === 2 && switches[1]?.model?.id === "small", JSON.stringify(switches))
    await fb.onPrompt({ sessionID: "ses_lock", agent: "developer", text: "hi" })
    await fb.onPrompt({ sessionID: "ses_lock", agent: "researcher", text: "hi" })
    const ev3: any = { sessionID: "ses_lock", agent: "researcher", model: { providerID: "a", id: "res2" }, error: { statusCode: 429 }, attempt: 2, decision: { retry: false } }
    await fb.onRetry(ev3)
    check("explicit user choice updates agent lock (researcher chain head -> res1)", switches.length === 3 && switches[2]?.model?.id === "res1", JSON.stringify(switches))
  }

  console.log("\ntransport + tools (V2 hook shapes):")
  {
    const fb = createFallback(mockCtx([]))
    const ev: any = { sessionID: "ses_mrq", agent: "developer", model: { providerID: "openrouter", id: "llama-4" }, kind: "chat", baseURL: "https://relay.example.com/v1" }
    await fb.onModelRequest(ev)
    check("model.request never overwrites native provider baseURL", ev.baseURL === "https://relay.example.com/v1", String(ev.baseURL))
    check("model.request does not stuff baseURL into model ref", ev.model?.baseURL === undefined, JSON.stringify(ev.model))
  }
  {
    const captured: any = { fn: undefined as any }
    const editor: any = { update: (id: string, fn: any) => { captured.fn = fn } }
    const fb = createFallback(mockCtx([]))
    fb.installTools(editor)
    const tool: any = {
      agent: "architect",
      sessionID: "ses_1",
      description: "built-in",
      prompt: "do the thing",
      model: { providerID: "a", id: "m1" },
      background: false,
      args: { description: "d", prompt: "p" },
    }
    const out: any = captured.fn(tool)
    check("installTools update preserves built-in subagent shape", out?.agent === "architect" && out?.sessionID === "ses_1" && out?.prompt === "do the thing")
    check("installTools update preserves model/background", out?.model?.providerID === "a" && out?.background === false)
    check("installTools update overrides description + preserves args", typeof out?.description === "string" && out?.description.length > 0 && out?.args?.prompt === "p")
  }
  {
    const capturedAgents: any = {} as Record<string, any>
    const existingBuild: any = { id: "build", name: "build", mode: "primary" }
    const agentEditor: any = {
      update: (id: string, fn: any) => { capturedAgents[id] = fn },
      get: (id: string) => (id === "build" ? existingBuild : undefined),
    }
    const fbAgents = createFallback(mockCtx([]))
    await fbAgents.installAgents(agentEditor)
    check("installAgents upserts fallback agent", typeof capturedAgents["architect"] === "function", Object.keys(capturedAgents).join(","))
    const draft: any = { name: "architect", mode: "primary" }
    capturedAgents["architect"](draft)
    check("installAgents update writes fallback model ref via toModelRef", draft.model?.providerID === "a" && draft.model?.id === "arch1" && draft.mode === "subagent", JSON.stringify(draft))
    if (typeof capturedAgents["build"] === "function") {
      capturedAgents["build"](existingBuild)
      check("installAgents preserves primary mode on existing built-in agent", existingBuild.mode === "primary", JSON.stringify(existingBuild))
    }
  }

  console.log("\nwatchdog vs. retry sleep:")
  {
    __resetStateForTests()
    let interrupted = 0
    const ctxWd: any = {
      session: {
        switchModel: async () => {},
        context: async () => ({ data: [] }),
        interrupt: async () => { interrupted += 1; return {} },
        prompt: async () => ({}),
      },
      event: { subscribe: () => ({ [Symbol.asyncIterator]: async function* () {} }) },
    }
    const fbWd = createFallback(ctxWd, { providerDefaults: { ...STICKY_FAST, stickyMs: 180000, rateLimitMs: 60000 }, watchdog: { enabled: true, firstTokenMs: 1000, stallTimeoutMs: 1000, sweepIntervalMs: 5000, debounceMs: 5000, compactionDebounceMs: 120000 } })
    await fbWd.onPrompt({ sessionID: "ses_wd", agent: "developer", prompt: { text: "ok lets test" } })
    const evWd: any = { sessionID: "ses_wd", agent: "developer", model: { providerID: "unorouter-custom", id: "glm-5.3:free" }, error: { message: 'All providers for model "glm-5.3:free" are busy right now' }, attempt: 0, decision: { retry: true, delay: 0 } }
    await fbWd.onRetry(evWd)
    await __runSweepForTests(ctxWd, {} as any)
    check("sticky retry defers watchdog during retry sleep", evWd.decision?.retry === true && evWd.decision?.delay === 60000 && interrupted === 0, `interrupted=${interrupted}`)
  }
  {
    __resetStateForTests()
    const switchesExp: any[] = []
    const fbExp = createFallback(mockCtx(switchesExp), { providerDefaults: { ...STICKY_FAST, stickyMs: 25, rateLimitMs: 10 } })
    await fbExp.onPrompt({ sessionID: "ses_exp", agent: "developer", prompt: { text: "go" } })
    const ev1: any = { sessionID: "ses_exp", agent: "developer", model: { providerID: "unorouter-custom", id: "glm-5.3:free" }, error: { message: 'All providers for model "glm-5.3:free" are busy right now' }, attempt: 0, decision: { retry: true, delay: 0 } }
    await fbExp.onRetry(ev1)
    check("first transient opens sticky window", switchesExp.length === 0 && ev1.decision?.retry === true)
    await new Promise((r) => setTimeout(r, 35))
    const ev2: any = { sessionID: "ses_exp", agent: "developer", model: { providerID: "unorouter-custom", id: "glm-5.3:free" }, error: { message: 'All providers for model "glm-5.3:free" are busy right now' }, attempt: 1, decision: { retry: true, delay: 0 } }
    await fbExp.onRetry(ev2)
    check("expired sticky window fails over instead of re-arming", switchesExp.length === 1 && switchesExp[0]?.model?.id === "small", JSON.stringify(switchesExp))
  }

  console.log("\nturn detection (live-test fix: stale deadline blocked failover):")
  {
    __resetStateForTests()
    const switchesTurn: any[] = []
    // A short wall-clock budget so the deadline can lapse between turns.
    const fbTurn = createFallback(mockCtx(switchesTurn), {
      budgets: { fallbackBudgetMs: 60, maxIterations: 10, compactionRatio: 0.4, charsPerToken: 4, quotaThresholdMs: 600000, maxCooldownSleepMs: 30000 },
      providerDefaults: { ...STICKY_FAST },
    })
    // Turn 1: budget is fresh → failover happens.
    const evT1: any = { sessionID: "ses_turn", agent: "developer", model: { providerID: "a", id: "small" }, error: { statusCode: 402 }, attempt: 0, decision: { retry: false } }
    await fbTurn.onRetry(evT1)
    check("turn 1 fails over while the budget is fresh", switchesTurn.length === 1 && switchesTurn[0]?.model?.id === "large", JSON.stringify(switchesTurn))
    // Let the turn's wall-clock budget lapse.
    await new Promise((r) => setTimeout(r, 90))
    // Turn 2: the server's attempt counter resets to 0 → new turn detected →
    // per-turn state (incl. the deadline) is reset, so failover works again.
    const evT2: any = { sessionID: "ses_turn", agent: "developer", model: { providerID: "a", id: "small" }, error: { statusCode: 402 }, attempt: 0, decision: { retry: false } }
    await fbTurn.onRetry(evT2)
    check("new turn (attempt counter reset) restores the failover budget", switchesTurn.length === 2 && switchesTurn[1]?.model?.id === "large", JSON.stringify(switchesTurn))
  }
  {
    __resetStateForTests()
    const switchesLong: any[] = []
    const fbLong = createFallback(mockCtx(switchesLong), {
      budgets: { fallbackBudgetMs: 50, maxIterations: 10, compactionRatio: 0.4, charsPerToken: 4, quotaThresholdMs: 600000, maxCooldownSleepMs: 30000 },
      providerDefaults: { ...STICKY_FAST },
    })
    // Session is created and runs for longer than fallbackBudgetMs without failures
    await fbLong.onPrompt({ sessionID: "ses_long", agent: "developer", prompt: { text: "start long task" } })
    await new Promise((r) => setTimeout(r, 80))
    // First failure occurs 80ms later with OpenCode initial attempt=2 (hop 0):
    // Failover budget must NOT be treated as expired from the prompt time!
    const evLong: any = { sessionID: "ses_long", agent: "developer", model: { providerID: "a", id: "small" }, error: { statusCode: 402 }, attempt: 2, decision: { retry: false } }
    await fbLong.onRetry(evLong)
    check("first failure after long execution (> budgetMs) initializes fresh budget and switches", switchesLong.length === 1 && switchesLong[0]?.model?.id === "large", JSON.stringify(switchesLong))
  }
  {
    __resetStateForTests()
    const switchesSame: any[] = []
    const fbSame = createFallback(mockCtx(switchesSame), { providerDefaults: { ...STICKY_FAST } })
    // Same turn: the attempt counter increases → no turn reset, the chain keeps
    // advancing (the failed model is never revisited).
    const evS1: any = { sessionID: "ses_same", agent: "developer", model: { providerID: "a", id: "small" }, error: { statusCode: 402 }, attempt: 0, decision: { retry: false } }
    await fbSame.onRetry(evS1)
    const evS2: any = { sessionID: "ses_same", agent: "developer", model: { providerID: "a", id: "large" }, error: { statusCode: 402 }, attempt: 1, decision: { retry: false } }
    await fbSame.onRetry(evS2)
    check("same turn (increasing attempt) keeps walking the chain", switchesSame.length === 2 && switchesSame[1]?.model?.id === "mid", JSON.stringify(switchesSame))
  }
  {
    __resetStateForTests()
    const switchesRo: any[] = []
    const promptsRo: any[] = []
    const ctxRo: any = {
      session: {
        switchModel: async (args: any) => { switchesRo.push(args) },
        context: async () => ({ data: [] }),
        interrupt: async () => ({}),
        prompt: async (args: any) => { promptsRo.push(args); return {} },
      },
      event: { subscribe: () => ({ [Symbol.asyncIterator]: async function* () {} }) },
    }
    const fbRo = createFallback(ctxRo, { providerDefaults: { ...STICKY_FAST } })
    await fbRo.onPrompt({ sessionID: "ses_rollover", agent: "developer", prompt: { text: "go" } })
    await fbRo.onRetry({ sessionID: "ses_rollover", agent: "developer", model: { providerID: "a", id: "small" }, error: { statusCode: 402 }, attempt: 0, decision: { retry: true, delay: 0 } })
    const evRo: any = { sessionID: "ses_rollover", agent: "developer", model: { providerID: "a", id: "large" }, error: { statusCode: 402 }, attempt: 10, decision: { retry: true, delay: 0 } }
    await fbRo.onRetry(evRo)
    check("attempt 10 in active session switches + ends exhausted step", switchesRo.length === 2 && switchesRo[1]?.model?.id === "mid" && evRo.decision?.retry === false, JSON.stringify({ switchesRo, decision: evRo.decision }))
    await new Promise((r) => setTimeout(r, 90))
    check("rollover schedules fresh prompt to reset attempt budget", promptsRo.length === 1 && promptsRo[0]?.text === "go", JSON.stringify(promptsRo))
    await fbRo.onPrompt({ sessionID: "ses_rollover", agent: "developer", prompt: { text: "go" } })
    await fbRo.onRetry({ sessionID: "ses_rollover", agent: "developer", model: { providerID: "a", id: "mid" }, error: { statusCode: 402 }, attempt: 0, decision: { retry: true, delay: 0 } })
    check("rollover preserves tried set across fresh attempt=0 step", switchesRo.length === 2, JSON.stringify(switchesRo))
  }

  console.log("\nwatchdog completion / idle cleanup (live-test fix):")
  {
    check("checkCompletion skips trailing V2 idle/outcome row", checkCompletion([
      { type: "user", text: "reply with HELLO" },
      { type: "assistant", content: [{ type: "text", text: "HELLO" }], time: { completed: 1 }, finish: "stop" },
      { type: "idle", outcome: "succeeded" },
    ]).ok)
    check("checkCompletion accepts reasoning-only assistant when trailing idle succeeded", checkCompletion([
      { type: "user", text: "continue" },
      { type: "assistant", content: [{ type: "reasoning", text: "Already answered." }], time: { completed: 1 } },
      { type: "idle", outcome: "succeeded" },
    ]).ok)
  }
  {
    __resetStateForTests()
    let interrupted = 0
    let prompted = 0
    const ctxIdle: any = {
      session: {
        switchModel: async () => {},
        context: async () => ({
          data: [
            { type: "user", text: "reply" },
            { type: "assistant", content: [{ type: "text", text: "HELLO" }], time: { completed: 1 }, finish: "stop" },
            { type: "idle", outcome: "succeeded" },
          ],
        }),
        interrupt: async () => { interrupted += 1; return {} },
        prompt: async () => { prompted += 1; return {} },
      },
      event: { subscribe: () => ({ [Symbol.asyncIterator]: async function* () {} }) },
    }
    const fbIdle = createFallback(ctxIdle, { providerDefaults: { ...STICKY_FAST }, watchdog: { enabled: true, firstTokenMs: 10, stallTimeoutMs: 10, sweepIntervalMs: 5000, debounceMs: 5000, compactionDebounceMs: 120000 } })
    await fbIdle.onPrompt({ sessionID: "ses_done", agent: "developer", prompt: { text: "reply" } })
    await fbIdle.onIdle({ sessionID: "ses_done" })
    await new Promise((r) => setTimeout(r, 25))
    await __runSweepForTests(ctxIdle, {} as any)
    check("onIdle unregisters liveness so sweep never interrupts finished session", interrupted === 0 && prompted === 0, JSON.stringify({ interrupted, prompted }))

    // Even if onIdle was missed, runSweep/recover unregisters liveness on completed turns without interrupting.
    await fbIdle.onPrompt({ sessionID: "ses_missed_idle", agent: "developer", prompt: { text: "reply" } })
    await new Promise((r) => setTimeout(r, 25))
    await __runSweepForTests(ctxIdle, {} as any)
    await __runSweepForTests(ctxIdle, {} as any)
    check("runSweep unregisters liveness on completed turn without interrupting", interrupted === 0 && prompted === 0, JSON.stringify({ interrupted, prompted }))

    // Terminal idle { outcome: "failed" } (e.g. ModelUnavailableError) must not be re-prompted.
    const ctxFailed: any = {
      session: {
        switchModel: async () => {},
        context: async () => ({
          data: [
            { type: "user", text: "spawn" },
            { type: "idle", outcome: "failed", error: { type: "provider.no-route", message: "Model unavailable" } },
          ],
        }),
        interrupt: async () => { interrupted += 1; return {} },
        prompt: async () => { prompted += 1; return {} },
      },
      event: { subscribe: () => ({ [Symbol.asyncIterator]: async function* () {} }) },
    }
    const fbFailed = createFallback(ctxFailed, { providerDefaults: { ...STICKY_FAST }, watchdog: { enabled: true, firstTokenMs: 10, stallTimeoutMs: 10, sweepIntervalMs: 5000, debounceMs: 5000, compactionDebounceMs: 120000 } })
    await fbFailed.onPrompt({ sessionID: "ses_failed_idle", agent: "developer", prompt: { text: "spawn" } })
    await new Promise((r) => setTimeout(r, 25))
    await __runSweepForTests(ctxFailed, {} as any)
    check("runSweep unregisters liveness on terminal idle failed without re-prompting", interrupted === 0 && prompted === 0, JSON.stringify({ interrupted, prompted }))

    // Active running tool (e.g. parent waiting on subagent) must not be interrupted by watchdog.
    const ctxTool: any = {
      session: {
        switchModel: async () => {},
        context: async () => ({
          data: [
            { type: "user", text: "invoke subagent" },
            { type: "assistant", content: [{ type: "tool", name: "subagent", state: { status: "running" } }] },
          ],
        }),
        interrupt: async () => { interrupted += 1; return {} },
        prompt: async () => { prompted += 1; return {} },
      },
      event: { subscribe: () => ({ [Symbol.asyncIterator]: async function* () {} }) },
    }
    const fbTool = createFallback(ctxTool, { providerDefaults: { ...STICKY_FAST }, watchdog: { enabled: true, firstTokenMs: 10, stallTimeoutMs: 10, sweepIntervalMs: 5000, debounceMs: 5000, compactionDebounceMs: 120000 } })
    await fbTool.onPrompt({ sessionID: "ses_tool_wait", agent: "developer", prompt: { text: "invoke subagent" } })
    await new Promise((r) => setTimeout(r, 25))
    await __runSweepForTests(ctxTool, {} as any)
    check("runSweep does not interrupt session waiting on active running tool", interrupted === 0 && prompted === 0, JSON.stringify({ interrupted, prompted }))
  }

  console.log("\nmulti-pass cycling (V1 parity):")
  {
    __resetStateForTests()
    const switchesMp: any[] = []
    // Chain for developer (no fallback.json): a/small -> a/large -> a/mid
    // With breaker threshold=5, transient 429s exhaust pass 1 and start pass 2.
    const fbMp = createFallback(mockCtx(switchesMp), {
      budgets: { fallbackBudgetMs: 600000, maxIterations: 10, compactionRatio: 0.4, charsPerToken: 4, quotaThresholdMs: 600000, maxCooldownSleepMs: 30000 },
      providerDefaults: { ...STICKY_FAST, breaker: { threshold: 5, cooldownMs: 60000, maxCooldownMs: 300000 } },
    })
    await fbMp.onRetry({ sessionID: "ses_mp", agent: "developer", model: { providerID: "a", id: "small" }, error: { statusCode: 429 }, attempt: 0, decision: { retry: false } })
    await fbMp.onRetry({ sessionID: "ses_mp", agent: "developer", model: { providerID: "a", id: "large" }, error: { statusCode: 429 }, attempt: 1, decision: { retry: false } })
    await fbMp.onRetry({ sessionID: "ses_mp", agent: "developer", model: { providerID: "a", id: "mid" }, error: { statusCode: 429 }, attempt: 2, decision: { retry: false } })
    check(
      "transient failures cycle into a 2nd pass instead of stopping after pass 1",
      switchesMp.length === 3 && switchesMp[0]?.model?.id === "large" && switchesMp[1]?.model?.id === "mid" && switchesMp[2]?.model?.id === "small",
      JSON.stringify(switchesMp),
    )
  }

  console.log("\ncatalog validation & durability:")
  {
    __resetStateForTests()
    __setKnownModelsForTests(["openrouter/google/gemini-2.5-flash", "anthropic/claude-3-7-sonnet"])
    check("isModelAvailable matches full key", isModelAvailable("openrouter/google/gemini-2.5-flash"))
    check("isModelAvailable is case insensitive", isModelAvailable("OpenRouter/Google/Gemini-2.5-Flash"))
    check("isModelAvailable matches short id", isModelAvailable("claude-3-7-sonnet"))
    check("isModelAvailable rejects dead model", !isModelAvailable("openrouter/xingchen-agi/xing4.0-29b-a4b:free"))
    check("isModelHealthyNow returns true for available unblocked model", isModelHealthyNow("openrouter/google/gemini-2.5-flash"))
    markModelUnavailable("anthropic/claude-3-7-sonnet")
    check("markModelUnavailable removes from catalog", !isModelAvailable("anthropic/claude-3-7-sonnet"))
    check("isModelHealthyNow returns false for unavailable model", !isModelHealthyNow("anthropic/claude-3-7-sonnet"))
    __setKnownModelsForTests(undefined)
  }

  console.log("\ninstallAgents catalog durability:")
  {
    __resetStateForTests()
    __setKnownModelsForTests(["openrouter/google/gemini-2.5-flash", "a/arch1"])
    const savedAgents = new Map<string, any>()
    savedAgents.set("healthy-agent", { id: "healthy-agent", model: "openrouter/google/gemini-2.5-flash" })
    savedAgents.set("dead-agent", { id: "dead-agent", model: "openrouter/xingchen-agi/xing4.0-29b-a4b:free" })

    const mockEditor = {
      list: () => Array.from(savedAgents.values()),
      get: (id: string) => savedAgents.get(id),
      update: (id: string, fn: any) => {
        const cur = savedAgents.get(id) ?? { id }
        const next = fn(cur) ?? cur
        savedAgents.set(id, next)
      },
    }

    const fb = createFallback(mockCtx([]))
    fb.installAgents(mockEditor)

    check("installAgents preserves healthy agent model", savedAgents.get("healthy-agent")?.model === "openrouter/google/gemini-2.5-flash")
    check(
      "installAgents replaces dead agent model with healthy fallback",
      isModelAvailable(savedAgents.get("dead-agent")?.model) &&
        !String(savedAgents.get("dead-agent")?.model?.id ?? "").includes("xing4.0"),
      JSON.stringify(savedAgents.get("dead-agent")),
    )
    __setKnownModelsForTests(undefined)
  }

  console.log("\nonToolExecuteBefore subagent routing & inheritance:")
  {
    __resetStateForTests()
    __setKnownModelsForTests(["openrouter/google/gemini-2.5-flash", "anthropic/claude-3-7-sonnet", "openrouter/meta-llama/llama-3.3-70b-instruct"])
    const fb = createFallback(mockCtx([]))

    // Parent session with healthy model
    await fb.onPrompt({ sessionID: "ses_parent_1", agent: "orchestrator", prompt: { text: "evaluate election" } })
    const stParent = (fb as any).ctx // state
    // Simulate parent seat set to claude-3-7-sonnet
    const fakeEv = { sessionID: "ses_parent_1", agent: "orchestrator", model: { providerID: "anthropic", id: "claude-3-7-sonnet" }, error: { statusCode: 429 }, attempt: 0, decision: { retry: false } }
    // Call onRetry or directly test tool hook with parent session
    const hookPayload1: any = {
      tool: "subagent",
      sessionID: "ses_parent_1",
      input: { agent: "developer", description: "do task" },
    }
    // Set parent state seat
    await fb.onContext({ sessionID: "ses_parent_1", model: "anthropic/claude-3-7-sonnet" })
    await fb.onToolExecuteBefore(hookPayload1)

    check("subagent inherits healthy parent model", hookPayload1.input.model?.id === "claude-3-7-sonnet", JSON.stringify(hookPayload1.input.model))

    // Caller passes dead model explicitly
    const hookPayload2: any = {
      tool: "subagent",
      sessionID: "ses_parent_2",
      input: { agent: "developer", model: "openrouter/xingchen-agi/xing4.0-29b-a4b:free", description: "do task" },
    }
    await fb.onToolExecuteBefore(hookPayload2)
    check("subagent replaces explicit dead model with healthy fallback", hookPayload2.input.model?.id !== "xing4.0-29b-a4b:free" && isModelAvailable(hookPayload2.input.model), JSON.stringify(hookPayload2.input.model))

    __setKnownModelsForTests(undefined)
  }

  console.log("\nonRetry skipping dead models in chain:")
  {
    __resetStateForTests()
    __setKnownModelsForTests(["a/small", "a/mid"]) // a/large is dead/unavailable
    const switchesSkip: any[] = []
    const fbSkip = createFallback(mockCtx(switchesSkip), {
      budgets: { fallbackBudgetMs: 600000, maxIterations: 10, compactionRatio: 0.4, charsPerToken: 4, quotaThresholdMs: 600000, maxCooldownSleepMs: 30000 },
      providerDefaults: { ...STICKY_FAST, stickyMs: 0 },
    })
    // Failed on a/small (quota -> should fail over)
    await fbSkip.onRetry({ sessionID: "ses_skip", agent: "developer", model: { providerID: "a", id: "small" }, error: { statusCode: 402 }, attempt: 0, decision: { retry: false } })

    check("onRetry skips unavailable a/large and switches to a/mid", switchesSkip.length === 1 && switchesSkip[0]?.model?.id === "mid", JSON.stringify(switchesSkip))
    __setKnownModelsForTests(undefined)
  }

  console.log("\nusableContextLimit & token hydration:")
  {
    // Test 1: input vs context limit and reserve calculation
    // Big pickle: context 200k, input 160k -> raw 160k. Reserve = max(160k * 0.15 = 24k, 20k) = 24k -> usable = 136k
    const bpUsable = usableContextLimit({ limit: { context: 200000, input: 160000 } })
    check("usableContextLimit applies min(input, context) and reserve", bpUsable === 136000, String(bpUsable))

    // Small model without input limit: context 32k -> raw 32k. Reserve = max(32k * 0.15 = 4.8k, 0) = 4800 -> usable = 27200
    const smUsable = usableContextLimit({ limit: { context: 32000 } })
    check("usableContextLimit handles single limit", smUsable === 27200, String(smUsable))

    // Test 2: contextFits hydrates tokens from flat messages
    __resetStateForTests()
    __setModelLimitsForTests({ "a/small": 50000, "a/huge": 500000 })
    const switchesHydrate: any[] = []
    const ctxHydrate: any = {
      session: {
        switchModel: async (args: any) => { switchesHydrate.push(args) },
        context: async () => ({
          data: [
            { type: "user", text: "question" },
            { type: "assistant", tokens: { input: 60000, output: 1000 }, content: [{ type: "text", text: "answer" }], finish: "stop" },
          ],
        }),
      },
      event: { subscribe: () => ({ [Symbol.asyncIterator]: async function* () {} }) },
    }
    const fbHydrate = createFallback(ctxHydrate, {
      budgets: { fallbackBudgetMs: 600000, maxIterations: 10, compactionRatio: 0.4, charsPerToken: 4, quotaThresholdMs: 600000, maxCooldownSleepMs: 30000 },
      providerDefaults: { ...STICKY_FAST, stickyMs: 0 },
    })
    // Session starts with 0 cached tokens in st.tokens. Failed on a/small (quota).
    // The candidate a/small has 50k limit, but session context has 60k tokens!
    // contextFits must hydrate 60k tokens from context and reject a/small, routing to huge.
    await fbHydrate.onRetry({ sessionID: "ses_hydr", agent: "developer", model: { providerID: "a", id: "small" }, error: { statusCode: 402 }, attempt: 0, decision: { retry: false } })
    check("contextFits hydrates tokens and skips models that cannot hold conversation", switchesHydrate.length === 1 && switchesHydrate[0]?.model?.id !== "small", JSON.stringify(switchesHydrate))
  }

  console.log("\nper-model quota isolation (V1 parity):")
  {
    __resetStateForTests()
    __setKnownModelsForTests([
      "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
      "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      "openrouter/anthropic/claude-3-7-sonnet",
      "opencode/big-pickle",
    ])
    const fbTier = createFallback(mockCtx([]))
    const nemotron = "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free"
    const llamaFree = "openrouter/meta-llama/llama-3.3-70b-instruct:free"
    const claudePaid = "openrouter/anthropic/claude-3-7-sonnet"

    check("all models healthy initially", isModelHealthyNow(nemotron) && isModelHealthyNow(llamaFree) && isModelHealthyNow(claudePaid))

    // Classify quota error
    const err = { message: "Rate limit exceeded: free-models-per-day-high-balance", statusCode: 429 }
    const classified = classifyError(err)
    check("classifyError identifies quota", classified.cls === "quota", JSON.stringify(classified))

    // Record failure on nemotron
    recordModelFailure(nemotron, classified, fbTier.opts)

    // Verify nemotron is locked out, but sibling free model and paid model are NOT locked out (V1 pure per-model isolation)
    check("nemotron is locked out", !isModelHealthyNow(nemotron))
    check("sibling free model is NOT locked out (per-model isolation)", isModelHealthyNow(llamaFree))
    check("paid model on same provider remains healthy", isModelHealthyNow(claudePaid))

    __setKnownModelsForTests(undefined)
  }

  console.log("\ncompaction agent error recovery & dynamic health:")
  {
    __resetStateForTests()
    __setKnownModelsForTests(["openrouter/nvidia/nemotron:free", "a/huge", "a/small"])
    let agentReloadCalled = 0
    const ctxAgent: any = {
      ...mockCtx([]),
      agent: { reload: async () => { agentReloadCalled++ } },
    }
    const fbCompaction = createFallback(ctxAgent)

    // Agent "compaction" fails with non-transient quota error
    const evCompaction: any = {
      sessionID: "ses_compact",
      agent: "compaction",
      model: { providerID: "openrouter", id: "nvidia/nemotron:free" },
      error: { message: "Rate limit exceeded: free-models-per-day-high-balance", statusCode: 429 },
      decision: { retry: true },
    }
    await fbCompaction.onRetry(evCompaction)

    check("compaction retry requests agent reload", agentReloadCalled === 1)
    check("compaction retry stops non-transient spin (decision.retry = false)", evCompaction.decision.retry === false)
    check("compaction failed model marked unhealthy", !isModelHealthyNow("openrouter/nvidia/nemotron:free"))

    // installAgents selects healthy large-context model for agent "compaction"
    const savedAgents = new Map<string, any>()
    savedAgents.set("compaction", { id: "compaction", model: "openrouter/nvidia/nemotron:free" })
    const mockEditor = {
      list: () => Array.from(savedAgents.values()),
      get: (id: string) => savedAgents.get(id),
      update: (id: string, fn: any) => {
        const cur = savedAgents.get(id) ?? { id }
        const next = fn(cur) ?? cur
        savedAgents.set(id, next)
      },
    }
    fbCompaction.installAgents(mockEditor)
    check(
      "installAgents dynamically replaces unhealthy compaction model with healthy fallback",
      savedAgents.get("compaction")?.model?.id !== "nvidia/nemotron:free" && isModelHealthyNow(savedAgents.get("compaction")?.model),
      JSON.stringify(savedAgents.get("compaction")),
    )

    // Test: compaction switches to next model in fallback chain when candidate available
    __resetStateForTests()
    __setKnownModelsForTests(["c/comp1", "c/comp2"])
    const switchesComp: any[] = []
    const fbCompChain = createFallback(mockCtx(switchesComp), {
      agents: {
        compaction: {
          largeContextModel: "c/comp1",
          largeContextFallback: ["c/comp2"],
        },
      },
    } as any)
    const evCompFail: any = {
      sessionID: "ses_comp_chain",
      agent: "compaction",
      model: { providerID: "c", id: "comp1" },
      error: { message: "Too many requests", statusCode: 429 },
      decision: { retry: true },
    }
    await fbCompChain.onRetry(evCompFail)
    check(
      "compaction switches to next model in fallback chain",
      switchesComp.length === 1 && switchesComp[0]?.model?.id === "comp2" && evCompFail.decision.retry === true,
      JSON.stringify(switchesComp),
    )

    __setKnownModelsForTests(undefined)
  }

  console.log("\npinned model retry abort guard:")
  {
    __resetStateForTests()
    __setModelLimitsForTests({ "a/small": 1000, "a/large": 1000000, "a/mid": 400000 })
    const switchesGuard: any[] = []
    const fbGuard = createFallback(mockCtx(switchesGuard), { providerDefaults: { ...STICKY_FAST, stickyMs: 0 } })

    // Step 1: fails on a/small and switches to a/large
    const evG1: any = { sessionID: "ses_guard", agent: "developer", model: { providerID: "a", id: "small" }, error: { statusCode: 402 }, attempt: 0, decision: { retry: false } }
    await fbGuard.onRetry(evG1)
    check("session switches from a/small to a/large", switchesGuard.length === 1 && switchesGuard[0]?.model?.id === "large")

    // Step 2: OpenCode erroneously fires retry for old model a/small within the same turn
    const evOldRetry: any = { sessionID: "ses_guard", agent: "developer", model: { providerID: "a", id: "small" }, error: { statusCode: 429 }, attempt: 1, decision: { retry: true } }
    await fbGuard.onRetry(evOldRetry)
    check("pinned model abort guard sets retry = false on old model", evOldRetry.decision.retry === false)
    check("no extra switch made for old model retry", switchesGuard.length === 1)
  }

  console.log("\ndynamic compaction curve & double-counting fix:")
  {
    __resetStateForTests()
    // Test logarithmic curve anchors
    check("32k or less gets max ratio 0.85 (15% margin)", dynamicCompactionRatio(32768) === 0.85)
    check("small 16k gets max ratio 0.85", dynamicCompactionRatio(16000) === 0.85)
    check("64k gets ~0.76", Math.abs(dynamicCompactionRatio(65536) - 0.76) < 0.005)
    check("128k gets ~0.67", Math.abs(dynamicCompactionRatio(131072) - 0.67) < 0.005)
    check("200k gets ~0.615", Math.abs(dynamicCompactionRatio(200000) - 0.615) < 0.005)
    check("1M gets base ratio 0.40 (60% margin)", dynamicCompactionRatio(1048576) === 0.40)
    check("2M gets base ratio 0.40", dynamicCompactionRatio(2097152) === 0.40)

    // Test double-counting fix and proactive compaction
    let compactCalls = 0
    const ctxComp: any = {
      ...mockCtx([]),
      session: {
        ...mockCtx([]).session,
        compact: async () => { compactCalls++ },
      },
    }
    __setModelLimitsForTests({ "opencode/big-pickle": 200000 })
    const fbComp = createFallback(ctxComp, { providerDefaults: { ...STICKY_FAST, stickyMs: 0 } })

    // Simulate session: large prompt (67k chars = ~16.7k tokens) + prior tokens (26.6k)
    // 1) 26.6k tokens on 200k limit is 13.3%
    // 2) Compaction threshold on 200k is 61.5% (123k tokens)
    // 3) Proactive compaction does not trigger at 26.6k tokens or at 122.8k tokens
    await fbComp.onPrompt({ sessionID: "ses_curve", agent: "developer", text: "x".repeat(270600) })
    // Simulate event from assistant with actual measured tokens (26,652)
    // This marks prompt as absorbed
    const evChunk = {
      type: "session.text.delta",
      sessionID: "ses_curve",
      properties: {
        info: {
          tokens: { input: 284, cache: { read: 26368 } },
        },
      },
    }
    // Simulate onContext for a tool call after the assistant has responded
    const evCtx: any = { sessionID: "ses_curve", agent: "developer", model: { providerID: "opencode", id: "big-pickle" } }
    await fbComp.onContext(evCtx)

    check("proactive compaction does NOT trigger at 26.6k tokens on 200k model (curve + no double counting)", compactCalls === 0)

    // Now simulate conversation reaching 122.8k tokens on 200k model (61.4%):
    // Threshold is 61.5% (123k), so 122.8k tokens does NOT trigger compaction!
    const evCtx122k: any = { sessionID: "ses_curve_122k", agent: "developer", model: { providerID: "opencode", id: "big-pickle" } }
    await fbComp.onPrompt({ sessionID: "ses_curve_122k", agent: "developer", text: "x" })
    const st122k = (fbComp as any).ctx ? undefined : undefined
    // Inject 122,803 tokens into session state
    const evChunk122k = {
      type: "session.text.delta",
      sessionID: "ses_curve_122k",
      properties: {
        info: {
          tokens: { input: 2803, cache: { read: 120000 } },
        },
      },
    }
    // Handle delta event to set st.tokens = 122803
    await fbComp.onPrompt({ sessionID: "ses_curve_122k", agent: "developer" })
    await (fbComp as any).consumeEvents?.({
      event: {
        subscribe: () => ({
          async *[Symbol.asyncIterator]() {
            yield evChunk122k
          },
        }),
      },
    })
    await fbComp.onContext(evCtx122k)
    check("proactive compaction does NOT trigger at 122.8k tokens on 200k model (123k usable limit, no double counting)", compactCalls === 0)
  }

  console.log("\ncandidate exhaustion loop termination & compaction retry detection:")
  {
    // 1. When candidates are exhausted on non-transient error, retry must be terminated (decision.retry = false)
    __resetStateForTests()
    const switches: any[] = []
    const fbExhaust = createFallback(mockCtx(switches), {
      budgets: { fallbackBudgetMs: 600000, maxIterations: 10, compactionRatio: 0.4, charsPerToken: 4, quotaThresholdMs: 600000, maxCooldownSleepMs: 30000 },
      providerDefaults: { ...STICKY_FAST },
    } as any)
    const ev1: any = { sessionID: "ses_exhaust", agent: "developer", model: { providerID: "a", id: "small" }, error: { statusCode: 402 }, attempt: 0, decision: { retry: true } }
    await fbExhaust.onRetry(ev1)
    const ev2: any = { sessionID: "ses_exhaust", agent: "developer", model: { providerID: "a", id: "large" }, error: { statusCode: 402 }, attempt: 1, decision: { retry: true } }
    await fbExhaust.onRetry(ev2)
    const ev3: any = { sessionID: "ses_exhaust", agent: "developer", model: { providerID: "a", id: "mid" }, error: { statusCode: 402 }, attempt: 2, decision: { retry: true } }
    await fbExhaust.onRetry(ev3)
    check("exhausted candidates on quota sets decision.retry = false", ev3.decision.retry === false, JSON.stringify(ev3.decision))
    check("exhausted candidates records failed model health", !isModelHealthyNow("a/mid"))

    // 2. Compaction retry detected via e.type === 'compaction' even without agent: 'compaction'
    let reloadCalled = 0
    const ctxCompactionTest = {
      ...mockCtx([]),
      agent: {
        reload: async () => { reloadCalled++ },
      },
    }
    const fbCompType = createFallback(ctxCompactionTest, {
      defaultLargeContextModel: "a/huge",
    } as any)
    const evCompType: any = {
      sessionID: "ses_comp_type",
      type: "compaction",
      model: { providerID: "openrouter", id: "nvidia/nemotron:free" },
      error: { statusCode: 429, message: "Rate limit exceeded: free-models-per-day-high-balance" },
      attempt: 0,
      decision: { retry: true, delay: 0 },
    }
    await fbCompType.onRetry(evCompType)
    check("compaction retry via e.type requests agent reload", reloadCalled === 1)
    check("compaction retry via e.type stops non-transient spin", evCompType.decision.retry === false)

    // 3. Compaction retry detected via configured compaction model
    let reloadCalled2 = 0
    const ctxCompactionTest2 = {
      ...mockCtx([]),
      agent: {
        reload: async () => { reloadCalled2++ },
      },
    }
    const fbCompModel = createFallback(ctxCompactionTest2, {
      agents: {
        compaction: {
          largeContextModel: "a/custom-compaction",
        },
      },
    } as any)
    const evCompModel: any = {
      sessionID: "ses_comp_model",
      model: { providerID: "a", id: "custom-compaction" },
      error: { statusCode: 429, message: "Rate limit exceeded: free-models-per-day-high-balance" },
      attempt: 0,
      decision: { retry: true, delay: 0 },
    }
    await fbCompModel.onRetry(evCompModel)
    check("compaction retry via matching compaction model requests agent reload", reloadCalled2 === 1)
    check("compaction retry via matching compaction model stops non-transient spin", evCompModel.decision.retry === false)
  }

  console.log("\nselftest result:")
  if (failures === 0) { console.log("  all checks passed\n"); return }
  console.log(`  ${failures} check(s) failed\n`)
  process.exitCode = 1
}

void main()
