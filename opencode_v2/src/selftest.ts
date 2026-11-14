/**
 * V2 self-check — no provider, no network, mock ctx only.
 *
 *   cd <repo>/opencode_v2 && npx tsc && node dist/selftest.js
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { createFallback, classifyError, checkCompletion, contextTokens, lastAssistantInTurn, assistantText, __resetStateForTests, __setModelLimitsForTests, __runSweepForTests, Breaker, CONTINUE_PROMPT, parseQuotaBlockedUntil } from "./core.js"

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
    const ev: any = { sessionID: "ses_budget2", agent: "developer", model: { providerID: "p", id: "m" }, error: { statusCode: 402 }, attempt: 0, decision: { retry: false } }
    await fb.onRetry(ev)
    check("exhausted wall-clock budget → no switch", switches.length === 0)
    check("exhausted wall-clock budget → decision kept", ev.decision.retry === false)
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

  console.log("\nselftest result:")
  if (failures === 0) { console.log("  all checks passed\n"); return }
  console.log(`  ${failures} check(s) failed\n`)
  process.exitCode = 1
}

void main()
