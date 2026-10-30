/**
 * Self-check for the fallback walk logic. No provider, no network.
 *
 *   cd C:\Users\axelr\OneDrive\Documents\GitHub\opencode-subagent-fallback
 *   npm run build && node dist/selftest.js
 */
import { walkChain, classifyError, checkCompletion, WatchdogAbort, __setRootForTests, __setModelLimitsForTests, __resetStateForTests, stripJsonComments, parseJsonWithComments } from "./core.js"

let failures = 0
function check(name: string, cond: boolean, extra?: string) {
  if (cond) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`)
  }
}

function root(overrides = {}) {
  return {
    budgetMs: 60000,
    maxIterations: 10,
    compactionRatio: 0.5,
    parentWatchdog: { enabled: false },
    providers: {},
    ...overrides,
  }
}

function provider(overrides = {}) {
  return {
    firstTokenMs: 1000,
    stallTimeoutMs: 1000,
    retryDelayMs: 1,
    skipDelayMs: 1,
    stickyMs: 100000,
    maxTimeMs: 100000,
    timeoutMs: 100000,
    breaker: { threshold: 2, cooldownMs: 60000, maxCooldownMs: 600000 },
    ...overrides,
  }
}

const ok = (text = "answer") => ({ ok: true, completion: { finish: "stop", text } })
const fail = (err: any) => ({ ok: false, error: err })
const err = (data: any) => ({ data })

async function main() {
  console.log("\nclassifyError:")
  const t = (name: string, e: any, want: string) => check(`${name} -> ${want}`, classifyError(e).cls === want, classifyError(e).cls)
  t("401", err({ statusCode: 401 }), "auth")
  t("403", err({ statusCode: 403 }), "forbidden")
  t("404", err({ statusCode: 404 }), "model_not_found")
  t("413", err({ statusCode: 413 }), "context_too_large")
  t("400 context text", err({ statusCode: 400, message: "maximum context length exceeded" }), "context_too_large")
  t("429 no reset", err({ statusCode: 429 }), "transient")
  t("429 + 2h retry-after", err({ statusCode: 429, responseHeaders: { "retry-after": "7200" } }), "quota")
  t("429 daily words", err({ statusCode: 429, message: "used up your daily free allocation" }), "quota")
  t("500", err({ statusCode: 500 }), "provider_level")
  t("503 text", err({ message: "503 unavailable" }), "provider_level")
  t("timeout text", err({ message: "request timed out" }), "transient")
  t("finish length", err({ name: "MessageOutputLengthError" }), "transient")
  t("watchdog abort", new WatchdogAbort(), "transient")
  check("watchdog abort flagged ours", classifyError(new WatchdogAbort()).ours === true)
  t("unexpected 418", err({ statusCode: 418 }), "fatal")

  console.log("\ncheckCompletion:")
  check("complete ok", checkCompletion({ info: { time: { completed: 1 }, finish: "stop" }, parts: [{ type: "text", text: "hi" }] }).ok)
  check("finish=length rejected", !checkCompletion({ info: { time: {}, finish: "length" }, parts: [{ type: "text", text: "p" }] }).ok)
  check("never finished rejected", !checkCompletion({ info: { time: {}, finish: "stop" }, parts: [{ type: "text", text: "hi" }] }).ok)
  check(
    "dangling tool rejected",
    !checkCompletion({ info: { time: { completed: 1 }, finish: "stop" }, parts: [{ type: "tool", state: { status: "running" } }] }).ok,
  )
  check("empty text rejected", !checkCompletion({ info: { time: { completed: 1 }, finish: "stop" }, parts: [{ type: "text", text: " " }] }).ok)

  console.log("\nwalkChain:")
  const P = "p/a"
  const Q = "q/b"
  const R = "r/c"

  // 1. Happy path: first model answers.
  __resetStateForTests()
  __setRootForTests(root({ providers: { p: provider(), q: provider(), r: provider() } }))
  let calls: string[] = []
  let o = await walkChain({ chain: [P, Q, R], attempt: async (m) => { calls.push(m); return ok() } })
  check("happy path returns ok", o.ok && o.model === P)
  check("happy path makes one attempt", calls.length === 1, `${calls.length}`)

  // 2. Transient then success on the SAME model (sticky, not advancing).
  __resetStateForTests()
  calls = []
  let n = 0
  o = await walkChain({
    chain: [P, Q],
    attempt: async (m) => {
      calls.push(m)
      return ++n === 1 ? fail(err({ statusCode: 429 })) : ok()
    },
  })
  check("transient retries same model", o.ok && calls.length === 2 && calls[0] === P && calls[1] === P, JSON.stringify(calls))

  // 3. Quota -> fast-skip to the next model.
  __resetStateForTests()
  calls = []
  o = await walkChain({
    chain: [P, Q],
    attempt: async (m) => { calls.push(m); return (m === P ? fail(err({ statusCode: 429, responseHeaders: { "retry-after": "7200" } })) : ok()) },
  })
  check("quota fast-skips to next model", o.ok && o.model === Q && calls.length === 2, JSON.stringify(calls))

  // 4. Provider-level: skips the whole provider, not just the model.
  __resetStateForTests()
  calls = []
  o = await walkChain({
    chain: [P, "p/z", Q],
    attempt: async (m) => { calls.push(m); return (m.startsWith("p/") ? fail(err({ statusCode: 500 })) : ok()) },
  })
  check("provider-level skips whole provider", o.ok && o.model === Q, JSON.stringify(calls))

  // 5. Permanent model-class failure advances without tripping the breaker.
  __resetStateForTests()
  calls = []
  o = await walkChain({
    chain: [P, Q],
    attempt: async (m) => { calls.push(m); return (m === P ? fail(err({ statusCode: 404 })) : ok()) },
  })
  check("model-not-found advances", o.ok && o.model === Q)

  // 6. Breaker trips after `threshold` consecutive provider-level failures and
  //    the chain does NOT grind every remaining candidate.
  __resetStateForTests()
  __setRootForTests(root({ providers: { p: provider({ breaker: { threshold: 2, cooldownMs: 60000, maxCooldownMs: 600000 } }), q: provider() } }))
  __resetStateForTests()
  calls = []
  o = await walkChain({
    chain: [P, "p/z", "p/y", Q],
    attempt: async (m) => { calls.push(m); return fail(err({ statusCode: 500 })) },
  })
  check("breaker stops the chain", !o.ok && calls.length <= 4, `${calls.length} attempts`)
  check("breaker records a reason", typeof o.reason === "string" && o.reason.length > 0)

  // 7. Fatal stops the walk entirely.
  __resetStateForTests()
  calls = []
  o = await walkChain({ chain: [P, Q], attempt: async (m) => { calls.push(m); return fail(err({ statusCode: 418 })) } })
  check("fatal stops the walk", !o.ok && calls.length === 1 && /fatal/.test(o.reason ?? ""), JSON.stringify(calls))

  // 8. Budget bound: a chain that always fails transiently must terminate.
  __resetStateForTests()
  __setRootForTests(root({ budgetMs: 300, providers: { p: provider({ retryDelayMs: 1, stickyMs: 50 }) } }))
  __resetStateForTests()
  calls = []
  o = await walkChain({ chain: [P], attempt: async (m) => { calls.push(m); return fail(err({ statusCode: 429 })) } })
  check("budget bounds the walk", !o.ok && calls.length > 1 && calls.length < 50, `${calls.length} attempts`)

  // 9. Watchdog abort is transient, not fatal, and does not stop the walk.
  //    Ours aborts are stickiness-neutral: they retry the SAME model (the
  //    abort is not evidence about the model) until it succeeds.
  __resetStateForTests()
  let n9 = 0
  calls = []
  o = await walkChain({
    chain: [P, Q],
    attempt: async (m) => { calls.push(m); return (m === P && ++n9 === 1 ? fail(new WatchdogAbort()) : ok()) },
  })
  check("watchdog abort retries, not fatal", o.ok && calls.length === 2 && calls[0] === P && calls[1] === P, JSON.stringify(calls))

  // 10. Sticky window: a transient model is NOT retried forever.
  __resetStateForTests()
  __setRootForTests(root({ budgetMs: 300, providers: { p: provider({ retryDelayMs: 1, stickyMs: 30 }), q: provider({ retryDelayMs: 1, stickyMs: 30 }) } }))
  __resetStateForTests()
  calls = []
  o = await walkChain({ chain: [P, Q], attempt: async (m) => { calls.push(m); return fail(err({ statusCode: 429 })) } })
  check("sticky window lapses and advances", calls.includes(Q), JSON.stringify(calls))

  // 11. Pre-filter: a model too small for the conversation is never attempted.
  //     Requires known limits — an unknown limit can't be judged too small.
  __resetStateForTests()
  __setRootForTests(root({ providers: {} }))
  __setModelLimitsForTests({ [P]: 1000, [Q]: 4000 })

  calls = []
  o = await walkChain({ chain: [P, Q], estimateTokens: 999999, attempt: async (m) => { calls.push(m); return ok() } })
  check("no candidates fit -> early return", !o.ok && calls.length === 0 && /fit/.test(o.reason ?? ""), JSON.stringify(calls))

  // 11b. A model whose limit is too small is skipped; a larger one is attempted.
  __setModelLimitsForTests({ [P]: 100, [Q]: 4000000 })

  calls = []
  o = await walkChain({ chain: [P, Q], estimateTokens: 500, attempt: async (m) => { calls.push(m); return ok() } })
  check("small model pre-filtered, large one attempted", o.ok && o.model === Q && calls.length === 1, JSON.stringify(calls))

  // 12. Trail records every failed hop.
  __resetStateForTests()
  __setRootForTests(root({ providers: { p: provider(), q: provider() } }))
  o = await walkChain({ chain: [P, Q], attempt: async (m) => { calls.push(m); return (m === P ? fail(err({ statusCode: 500 })) : ok()) } })
  check("trail records the failed hop", o.trail.length === 2 && o.trail[0].cls === "provider_level" && o.trail[1].cls === "ok", JSON.stringify(o.trail.map((x) => x.cls)))

  // 13. Quota block skips model on subsequent walk.
  __resetStateForTests()
  __setRootForTests(root({ providers: { p: provider(), q: provider() } }))
  await walkChain({ chain: [P, Q], attempt: async (m) => { return m === P ? fail(err({ statusCode: 429, responseHeaders: { "retry-after": "7200" } })) : ok() } })
  calls = []
  o = await walkChain({ chain: [P, Q], attempt: async (m) => { calls.push(m); return ok() } })
  check("quota-blocked model skipped on next walk", o.ok && o.model === Q && calls.length === 1 && calls[0] === Q, JSON.stringify(calls))

  console.log("\njsonComments:")
  const sampleJsonc = `
  {
    // Single line comment
    "budgets": {
      /* Block comment */
      "fallbackBudgetMs": 500000,
      "url": "http://api.example.com//test/*keep*/",
    },
    "interceptor": {
      "fastRetryMs": 250,
    }
  }
  `
  const parsed = parseJsonWithComments(sampleJsonc)
  check("parseJsonWithComments parses comments and trailing commas", parsed.budgets.fallbackBudgetMs === 500000)
  check("parseJsonWithComments preserves comments inside string literals", parsed.budgets.url === "http://api.example.com//test/*keep*/")
  check("parseJsonWithComments parses subcategory values", parsed.interceptor.fastRetryMs === 250)

  console.log("\nselftest result:")
  if (failures === 0) {
    console.log("  all checks passed\n")
    return
  }
  console.log(`  ${failures} check(s) failed\n`)
  process.exitCode = 1
}

void main()




