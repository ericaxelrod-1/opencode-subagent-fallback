import type { Plugin } from "@opencode-ai/plugin";
/**
 * opencode-subagent-fallback
 *
 * Transparent model fallback for both halves of an OpenCode session:
 *   1. smart_task    — a task-tool replacement walking a per-agent fallback
 *                      chain with breakers, budgets and a completeness gate.
 *   2. parentWatchdog — steer/abort/re-prompt on the PARENT session when the
 *                      user's own turn stalls or fails.
 *
 * Built around one observation from the deployed auto-fallback plugin: free-tier
 * aggregator providers are flaky in two distinct ways that need opposite answers.
 *   - TRANSIENT (429, 5xx, mid-response cut, cold start): retry the same model
 *     inside a sticky window — it resolves in minutes, and hopping the chain on
 *     the first blip wastes a good model.
 *   - QUOTA (explicit reset time, hours): skip it with a blocked-until stamp and
 *     move on immediately; retrying a dead-for-hours quota is pure waste.
 *
 * Config: fallback.json (next to the chains it modulates — the old plugin
 * ignores unknown keys), keys under "providers". See README.
 */
interface BreakerConfig {
    threshold: number;
    cooldownMs: number;
    maxCooldownMs?: number;
}
interface ProviderConfig {
    firstTokenMs: number;
    stallTimeoutMs: number;
    retryDelayMs: number;
    skipDelayMs: number;
    stickyMs: number;
    maxTimeMs: number;
    timeoutMs: number;
    breaker: BreakerConfig;
}
interface RootConfig {
    budgetMs: number;
    maxIterations: number;
    compactionRatio: number;
    parentWatchdog: {
        enabled: boolean;
        firstTokenMs?: number;
        stallTimeoutMs?: number;
    };
    providers: Record<string, ProviderConfig>;
}
type FailClass = "transient" | "quota" | "context_too_large" | "auth" | "forbidden" | "model_not_found" | "provider_level" | "fatal";
interface Classified {
    cls: FailClass;
    retryAfterMs?: number;
    detail: string;
    /** An abort WE initiated (watchdog/timer) — never a provider-health signal. */
    ours?: boolean;
}
interface AttemptResult {
    ok: boolean;
    completion?: {
        finish?: string;
        text: string;
    };
    error?: any;
}
interface TrailEntry {
    model: string;
    cls: FailClass | "ok" | "aborted";
    ms: number;
    detail?: string;
}
interface WalkOutcome {
    ok: boolean;
    model?: string;
    result?: AttemptResult;
    trail: TrailEntry[];
    reason?: string;
    soonestResetMs?: number;
}
/** Test seam: loadRoot is the production path; the self-test sets ROOT directly. */
export declare function __setRootForTests(cfg: Partial<RootConfig>): void;
/** Test seam: loadModelLimits is the production path (client.config.get). */
export declare function __setModelLimitsForTests(limits: Record<string, number>): void;
/** Test seam: clear all in-process state between cases. */
export declare function __resetStateForTests(): void;
export declare function estimateTokens(text: string): number;
/** Error emitted when OUR watchdog aborted an attempt, so the classifier can
 *  tell it apart from a provider-side abort and never bench for it. */
export declare const WatchdogAbort: any;
export declare function classifyError(err: any): Classified;
export declare function checkCompletion(res: any): {
    ok: boolean;
    finish?: string;
    text: string;
};
interface WalkInput {
    chain: string[];
    sessionKey?: string;
    /** Approximate conversation size in tokens, for the context pre-filter. */
    estimateTokens?: number;
    attempt: (model: string) => Promise<AttemptResult>;
    onOverflow?: (model: string) => Promise<void>;
    log?: (m: string) => void;
}
/** Exported for the self-test. */
export declare function walkChain(input: WalkInput): Promise<WalkOutcome>;
declare const plugin: Plugin;
export default plugin;
