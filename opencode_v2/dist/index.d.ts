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
declare const SubagentFallbackOpenCodePlugin: {
    id: string;
    setup(ctx: any): Promise<() => Promise<void>>;
};
export default SubagentFallbackOpenCodePlugin;
export { SubagentFallbackOpenCodePlugin };
