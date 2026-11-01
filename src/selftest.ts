/**
 * Self-check for the fallback walk logic. No provider, no network.
 *
 *   cd C:\Users\axelr\OneDrive\Documents\GitHub\opencode-subagent-fallback
 *   npm run build && node dist/selftest.js
 */
import plugin, { walkChain, classifyError, checkCompletion, WatchdogAbort, __setRootForTests, __setModelLimitsForTests, __resetStateForTests, stripJsonComments, parseJsonWithComments } from "./core.js"

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
  t("nested status_code=400 in message", err({ message: '{"message":"status_code=400, Invalid request"}' }), "transient")
  t("nested status_code=429 in message", err({ message: '{"message":"status_code=429, Too many requests"}' }), "transient")
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

  console.log("\nsmart_task:")
  const fast = provider({ retryDelayMs: 1, skipDelayMs: 1, stickyMs: 1, breaker: { threshold: 1, cooldownMs: 1 } })
  __resetStateForTests()
  __setRootForTests(root({ providers: { p: fast, unorouter: fast, "unorouter-custom": fast } }))

  const mockContext = { sessionID: "ses_parent_999", worktree: process.cwd() }

  // 1. Happy path
  {
    const client: any = {
      config: { get: async () => ({ data: { agent: { developer: { model: "p/modelA" } } } }) },
      session: {
        create: async () => ({ data: { id: "ses_sub_1" } }),
        messages: async () => ({ data: [] }),
        summarize: async () => ({ data: {} }),
        prompt: async () => ({
          data: {
            info: { time: { completed: 1 }, finish: "stop" },
            parts: [{ type: "text", text: "Subagent success answer" }],
          },
        }),
      },
      event: { subscribe: async () => {} },
    }
    const hooks: any = await plugin({ client, directory: process.cwd() } as any)
    const smartTask = hooks.tool.smart_task
    const res = await smartTask.execute({ description: "Unit test task", prompt: "Hello subagent", subagent_type: "developer" }, mockContext)
    check("smart_task happy path returns completed task XML", res.output.includes('<task id="ses_sub_1" state="completed">'))
    check("smart_task happy path includes task_result", res.output.includes("<task_result>\nSubagent success answer\n</task_result>"))
    check("smart_task happy path metadata model", res.metadata.model === "p/modelA")
  }

  // 2. Fallback on 429 to secondary model in chain
  {
    __resetStateForTests()
    __setRootForTests(root({ providers: { p: fast, unorouter: fast, "unorouter-custom": fast } }))
    const attemptedModels: string[] = []
    const client: any = {
      config: { get: async () => ({ data: { agent: { developer: { model: "p/primary" } } } }) },
      session: {
        create: async () => ({ data: { id: "ses_sub_2" } }),
        messages: async () => ({ data: [] }),
        summarize: async () => ({ data: {} }),
        prompt: async ({ body }: any) => {
          const m = `${body.model.providerID}/${body.model.modelID}`
          attemptedModels.push(m)
          if (m === "p/primary") {
            return { error: { statusCode: 429 } }
          }
          return {
            data: {
              info: { time: { completed: 1 }, finish: "stop" },
              parts: [{ type: "text", text: "Fallback answered successfully" }],
            },
          }
        },
      },
      event: { subscribe: async () => {} },
    }
    const hooks: any = await plugin({ client, directory: process.cwd() } as any)
    const smartTask = hooks.tool.smart_task
    const res = await smartTask.execute({ description: "Fallback test", prompt: "Perform work", subagent_type: "developer" }, mockContext)
    check("smart_task fallback on 429 attempts multiple models", attemptedModels.length > 1, attemptedModels.join(" -> "))
    check("smart_task fallback succeeded", res.output.includes('state="completed"'))
    check("smart_task fallback includes fallback_trail", res.output.includes("<fallback_trail>"))
  }

  // 3. Fallback on truncated/incomplete completion
  {
    __resetStateForTests()
    __setRootForTests(root({ providers: { p: fast, unorouter: fast, "unorouter-custom": fast } }))
    const attempted: string[] = []
    const client: any = {
      config: { get: async () => ({ data: { agent: { developer: { model: "p/primary" } } } }) },
      session: {
        create: async () => ({ data: { id: "ses_sub_3" } }),
        messages: async () => ({ data: [] }),
        summarize: async () => ({ data: {} }),
        prompt: async ({ body }: any) => {
          const m = `${body.model.providerID}/${body.model.modelID}`
          attempted.push(m)
          if (m === "p/primary") {
            return {
              data: {
                info: { time: {}, finish: "length" },
                parts: [{ type: "text", text: "Truncated cut-off text..." }],
              },
            }
          }
          return {
            data: {
              info: { time: { completed: 1 }, finish: "stop" },
              parts: [{ type: "text", text: "Complete response" }],
            },
          }
        },
      },
      event: { subscribe: async () => {} },
    }
    const hooks: any = await plugin({ client, directory: process.cwd() } as any)
    const smartTask = hooks.tool.smart_task
    const res = await smartTask.execute({ description: "Truncation test", prompt: "Work", subagent_type: "developer" }, mockContext)
    check("smart_task fails over on finish=length", attempted[0] === "p/primary" && attempted.length > 1)
    check("smart_task recovers from truncated response", res.output.includes("Complete response"))
  }

  // 4. Unknown subagent type returns error metadata
  {
    const client: any = {
      config: { get: async () => ({ data: { agent: {} } }) },
      session: { create: async () => ({ data: { id: "ses_sub_4" } }) },
      event: { subscribe: async () => {} },
    }
    const hooks: any = await plugin({ client, directory: process.cwd() } as any)
    const smartTask = hooks.tool.smart_task
    const res = await smartTask.execute({ description: "Unknown agent test", prompt: "Hello", subagent_type: "unknown_xyz_role" }, mockContext)
    check("smart_task rejects unknown agent type", res.metadata?.error === true && res.output.includes("Unknown agent type: unknown_xyz_role"))
  }

  // 5. Task resumption (task_id passed)
  {
    let createdCount = 0
    let promptSessionId = ""
    const client: any = {
      config: { get: async () => ({ data: { agent: { developer: { model: "p/primary" } } } }) },
      session: {
        create: async () => { createdCount++; return { data: { id: "new_ses" } } },
        messages: async () => ({ data: [{ info: { role: "assistant" } }] }),
        prompt: async ({ path }: any) => {
          promptSessionId = path.id
          return {
            data: {
              info: { time: { completed: 1 }, finish: "stop" },
              parts: [{ type: "text", text: "Resumed task answer" }],
            },
          }
        },
      },
      event: { subscribe: async () => {} },
    }
    const hooks: any = await plugin({ client, directory: process.cwd() } as any)
    const smartTask = hooks.tool.smart_task
    const res = await smartTask.execute({ description: "Resume task", prompt: "Continue", subagent_type: "developer", task_id: "existing_task_abc" }, mockContext)
    check("smart_task reuses existing task_id when work exists", createdCount === 0 && promptSessionId === "existing_task_abc")
    check("smart_task resumed task has correct id in output", res.output.includes('id="existing_task_abc"'))
  }

  // 6. Ending the fallback chain on 429 must NOT trigger compaction
  {
    __resetStateForTests()
    __setRootForTests(root({ providers: { p: fast }, parentWatchdog: { enabled: true, firstTokenMs: 1000, stallTimeoutMs: 1000 } }))
    let summarizeCount = 0
    const client: any = {
      config: { get: async () => ({ data: { agent: { developer: { model: "p/modelA" } } } }) },
      session: {
        messages: async () => ({
          data: [
            { info: { role: "user" }, parts: [{ type: "text", text: "Do some work" }] },
            { info: { role: "assistant", model: { providerID: "p", modelID: "modelA" }, agent: "developer" } },
          ],
        }),
        summarize: async () => { summarizeCount++; return { data: {} } },
        prompt: async () => ({ data: {} }),
      },
      event: { subscribe: async () => {} },
    }
    const hooks: any = await plugin({ client, directory: process.cwd() } as any)
    // Send session.error with 429
    await hooks.event({
      type: "session.error",
      properties: {
        sessionID: "ses_exhaustion_test",
        error: { statusCode: 429 },
      },
    })
    check("exhausting fallback chain on 429 does not trigger compaction", summarizeCount === 0)
  }

  // 7. Watchdog recovers parts from earlier user messages when latest message has empty parts
  {
    __resetStateForTests()
    __setRootForTests(root({ providers: { p: fast }, parentWatchdog: { enabled: true, firstTokenMs: 1000, stallTimeoutMs: 1000 } }))
    let promptedModel = ""
    let promptedParts: any[] = []
    const client: any = {
      config: { get: async () => ({ data: { agent: { developer: { model: "p/modelA" } } } }) },
      session: {
        messages: async () => ({
          data: [
            { info: { role: "user" }, parts: [{ type: "text", text: "Important original prompt" }] },
            { info: { role: "assistant", model: { providerID: "p", modelID: "modelA" }, agent: "developer" } },
            { info: { role: "user" }, parts: [] }, // empty continuation turn!
          ],
        }),
        prompt: async ({ body }: any) => {
          promptedModel = `${body.model.providerID}/${body.model.modelID}`
          promptedParts = body.parts
          return { data: {} }
        },
      },
      event: { subscribe: async () => {} },
    }
    const hooks: any = await plugin({ client, directory: process.cwd() } as any)
    await hooks.event({
      type: "session.error",
      properties: {
        sessionID: "ses_empty_part_test",
        error: { statusCode: 429 },
      },
    })
    check("watchdog re-prompts on fallback when latest message had empty parts", promptedParts.length === 1 && promptedParts[0]?.text === "Important original prompt")
  }

  // 8. Watchdog defaults to Continue fallback when session has zero parts anywhere
  {
    __resetStateForTests()
    __setRootForTests(root({ providers: { p: fast }, parentWatchdog: { enabled: true, firstTokenMs: 1000, stallTimeoutMs: 1000 } }))
    let fallbackPromptText = ""
    const client: any = {
      config: { get: async () => ({ data: { agent: { developer: { model: "p/modelA" } } } }) },
      session: {
        messages: async () => ({
          data: [
            { info: { role: "user" }, parts: [] },
            { info: { role: "assistant", model: { providerID: "p", modelID: "modelA" }, agent: "developer" } },
          ],
        }),
        prompt: async ({ body }: any) => {
          fallbackPromptText = body?.parts?.[0]?.text ?? ""
          return { data: {} }
        },
      },
      event: { subscribe: async () => {} },
    }
    const hooks: any = await plugin({ client, directory: process.cwd() } as any)
    await hooks.event({
      type: "session.error",
      properties: {
        sessionID: "ses_zero_part_test",
        error: { statusCode: 429 },
      },
    })
    check("watchdog falls back to Continue when no parts exist", fallbackPromptText === "Continue")
  }

  // 9. Error classification: OpenCode quota phrases vs UnoRouter transient rate limits
  {
    const ocQuota1 = classifyError({ message: "Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go" })
    check("classifyError identifies OpenCode 'Free usage limit reached' as quota", ocQuota1.cls === "quota")

    const ocQuota2 = classifyError({ message: "Free usage exceeded, subscribe to Go" })
    check("classifyError identifies OpenCode 'Free usage exceeded' as quota", ocQuota2.cls === "quota")

    const unoTransient = classifyError({ statusCode: 429, message: "The free tier allows 1 request(s) every 1 min. You have used 1 request(s), and nothing is used up, retry in 31s" })
    check("classifyError identifies UnoRouter 'nothing is used up' as transient", unoTransient.cls === "transient")
  }

  // 10. Watchdog aborts and reprompts on session.status retry with quota message
  {
    __resetStateForTests()
    __setRootForTests(root({ providers: { p: fast }, parentWatchdog: { enabled: true, firstTokenMs: 1000, stallTimeoutMs: 1000 } }))
    let abortedSession = ""
    let promptedModel = ""
    const client: any = {
      config: { get: async () => ({ data: { agent: { developer: { model: "p/modelA" } } } }) },
      session: {
        abort: async ({ path }: any) => {
          abortedSession = path.id
          return { data: {} }
        },
        messages: async () => ({
          data: [
            { info: { role: "user" }, parts: [{ type: "text", text: "Retry test" }] },
            { info: { role: "assistant", model: { providerID: "p", modelID: "modelA" }, agent: "developer" } },
          ],
        }),
        prompt: async ({ body }: any) => {
          promptedModel = `${body.model.providerID}/${body.model.modelID}`
          return { data: {} }
        },
      },
      event: { subscribe: async () => {} },
    }
    const hooks: any = await plugin({ client, directory: process.cwd() } as any)
    await hooks.event({
      type: "session.status",
      properties: {
        sessionID: "ses_retry_quota_test",
        status: {
          type: "retry",
          attempt: 1,
          message: "Free usage exceeded, subscribe to Go",
        },
      },
    })
    check("watchdog aborts session when session.status retry has quota message", abortedSession === "ses_retry_quota_test")
    check("watchdog reprompts on healthy fallback model", promptedModel.length > 0 && promptedModel !== "p/modelA")
  }

  console.log("\nselftest result:")
  if (failures === 0) {
    console.log("  all checks passed\n")
    return
  }
  console.log(`  ${failures} check(s) failed\n`)
  process.exitCode = 1
}

void main()




