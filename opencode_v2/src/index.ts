/**
 * opencode-subagent-fallback — OpenCode V2 plugin entry.
 *
 * V1→V2 port entry, implemented through the corrected blueprint (§5
 * "Corrected port architecture", §9 converged posture) and sequenced to
 * completion (migration doc §8): failover core (retry → switchModel → forced
 * retry), chain state, completion gate, watchdog, tools/agents, overflow
 * pre-emption, cleanup/telemetry/redaction.
 *
 * Registers, against the V2 plugin context:
 *   - `session.hook("retry")`      → failover decision (switchModel + forced retry)
 *   - `session.hook("prompt")`      → per-turn state reset + admission capture
 *   - `session.hook("context")`     → per-model semantic options (e.options)
 *   - `session.hook("experimental.idle")` → sticky restore policy
 *   - `session.hook("model.request")` / `http.*` → transport hooks (no fetch patch)
 *   - `tool.transform`              → subagent tool override
 *   - `agent.transform`             → upsert missing fallback agents
 *   - `event` subscription           → liveness watchdog
 *
 * Entry shape mirrors the working RTK V2 plugin (`/home/eaxelrod/.config/opencode/plugins/rtk.ts`):
 * a plain object `{ id, setup, server? }` — the OpenCode 2.x loader
 * schema-validates the default export against `typeof === "object"`.
 */

import { createFallback } from "./core.js"

const SubagentFallbackOpenCodePlugin = {
  id: "subagent-fallback",

  async setup(ctx: any) {
    const fb = createFallback(ctx)
    await fb.initCatalog(ctx)

    const disposals: Array<() => Promise<void> | void> = []
    const register = (r: any): (() => Promise<void> | void) => {
      const dispose = async (): Promise<void> => {
        try {
          const p = r?.dispose?.()
          await p instanceof Promise ? p : Promise.resolve(p)
        } catch { /* best-effort dispose */ }
      }
      disposals.push(dispose)
      return dispose
    }

    register(await ctx?.session?.hook?.("retry", (e: any) => fb.onRetry(e)))
    register(await ctx?.session?.hook?.("prompt", (e: any) => fb.onPrompt(e)))
    register(await ctx?.session?.hook?.("context", (e: any) => fb.onContext(e)))
    register(await ctx?.session?.hook?.("experimental.idle", (e: any) => fb.onIdle(e)))
    register(await ctx?.session?.hook?.("model.request", (e: any) => fb.onModelRequest(e)))
    register(await ctx?.session?.hook?.("http.request", (e: any) => fb.onHttpRequest(e)))
    register(await ctx?.session?.hook?.("http.response", (e: any) => fb.onHttpResponse(e)))

    if (typeof ctx?.tool?.hook === "function") {
      register(await ctx.tool.hook("execute.before", (e: any) => fb.onToolExecuteBefore(e)))
    }
    if (typeof ctx?.tool?.transform === "function") {
      register(await ctx.tool.transform((editor: any) => fb.installTools(editor)))
    }
    if (typeof ctx?.agent?.transform === "function") {
      register(await ctx.agent.transform((editor: any) => fb.installAgents(editor)))
    }

    // Liveness watchdog over real V2 events; aborted on cleanup.
    const ac = new AbortController()
    void fb.consumeEvents(ctx, ac.signal)

    const cleanup = async (): Promise<void> => {
      ac.abort()
      for (const dispose of disposals) {
        try { await dispose() } catch { /* best-effort dispose */ }
      }
      try { await fb.dispose() } catch { /* best-effort */ }
    }

    return cleanup
  },
}

export default SubagentFallbackOpenCodePlugin
export { SubagentFallbackOpenCodePlugin }
