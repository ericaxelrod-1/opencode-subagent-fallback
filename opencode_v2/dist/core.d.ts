/**
 * opencode-subagent-fallback — V2 failover core
 *
 * Ported from the V1 implementation (`opencode_v1/src/core.ts`) onto the
 * OpenCode V2 plugin API, following the corrected blueprint in
 * `opencode_v2/docs/v2-critique-review.md` (§5 "Corrected port architecture",
 * §9 converged implementation posture).
 *
 * V2 control flow: the server owns the retry loop. `SessionRunner.runStep`
 * classifies → `ctx.session.hook("retry", ...)` → decides (mutable
 * `SessionRetryDecision`) → Retry | Continue. A plugin therefore never runs
 * its own attempts; it classifies the failed error, may switch the session's
 * model in-step via `ctx.session.switchModel`, and forces the retry decision.
 * Because a retry clears the cached prepared context, the next attempt
 * re-resolves the model from the available providers — no turn boundary or
 * synthetic prompt required.
 *
 * Implemented sequencing (migration doc §8 → corrected blueprint §5/§9):
 *   0. log-only retry classification            — superseded by step 1
 *   1. retry hook + switchModel + decision override (hardcoded target) — done
 *   2. chain state, classification, budget/tried guards, prompt reset
 *   3. completion gate + token accounting (flat schema)
 *   4. watchdog on real V2 events
 *   5. tools/agents: subagent override, agent upserts
 *   6. compaction/overflow pre-emption
 *   7. cleanup, telemetry, redaction
 */
export type FailClass = "transient" | "quota" | "context_too_large" | "auth" | "forbidden" | "model_not_found" | "provider_level" | "fatal";
export interface Classified {
    cls: FailClass;
    retryAfterMs?: number;
    detail: string;
    /** An abort WE initiated (watchdog/timer) — never a provider-health signal. */
    ours?: boolean;
}
/** Error emitted when OUR watchdog aborted an attempt, so classification can tell ours from the provider's. */
export declare const WatchdogAbort: any;
/**
 * V1 quota text parser: derive the blocked-until reset hint ("resets in Ns" /
 * "retry in Ns") from the error text (message + response body) into a duration.
 */
export declare function parseQuotaBlockedUntil(err: any): number | undefined;
export declare function classifyError(err: any): Classified;
export interface FallbackEntry {
    model: string;
    temperature?: number;
    reasoningEffort?: string;
    thinking?: {
        type: string;
        budgetTokens: number;
    };
}
export interface AgentFallback {
    largeContextModel?: string;
    minContextRatio?: number;
    largeContextFallback?: Array<FallbackEntry | string>;
    fallback?: Array<FallbackEntry | string>;
}
export interface FallbackFile {
    enabled?: boolean;
    agents?: Record<string, AgentFallback>;
    defaultFallback?: Array<FallbackEntry | string>;
    defaultLargeContextModel?: string;
    defaultLargeContextFallback?: Array<FallbackEntry | string>;
    defaultMinContextRatio?: number;
    budgets?: BudgetsConfig;
    fallbackBudgetMs?: number;
    maxIterations?: number;
    compactionRatio?: number;
    charsPerToken?: number;
    quotaThresholdMs?: number;
    maxCooldownSleepMs?: number;
    interceptor?: InterceptorConfig;
    watchdog?: WatchdogConfig;
    parentWatchdog?: WatchdogConfig;
    providerDefaults?: ProviderConfig;
    providers?: Record<string, ProviderConfig>;
    defaults?: {
        fallback?: Array<FallbackEntry | string>;
        largeContextModel?: string;
        largeContextFallback?: Array<FallbackEntry | string>;
        minContextRatio?: number;
    };
}
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
    rateLimitMs?: number;
    breaker: BreakerConfig;
}
interface BudgetsConfig {
    fallbackBudgetMs: number;
    maxIterations: number;
    compactionRatio: number;
    charsPerToken: number;
    quotaThresholdMs: number;
    maxCooldownSleepMs: number;
}
interface InterceptorConfig {
    fastRetryMs: number;
    defaultRateLimitMs: number;
    maxCooldownSleepMs: number;
}
interface WatchdogConfig {
    enabled: boolean;
    firstTokenMs?: number;
    stallTimeoutMs?: number;
    sweepIntervalMs?: number;
    debounceMs?: number;
    compactionDebounceMs?: number;
}
export interface FallbackOptions {
    budgetMs: number;
    maxIterations: number;
    compactionRatio: number;
    /**
     * consoleLogging: Master toggle for echoing fallback, retry, and breaker events to console (stderr/stdout).
     * DEFAULT: false (silent console / clean boundary isolation).
     *
     * Architectural Rationale (Silent Resilience):
     * In multi-agent systems, leaf worker stdout/stderr is monitored by parent orchestrator LLMs.
     * When orchestrators observe intermediate provider failure signals (HTTP 429, 503, quota exhaustion, circuit breaker trips),
     * their RLHF'd troubleshooting reflexes trigger, leading to panicked, counterproductive manual workarounds
     * (e.g. launching rogue retries with hallucinated flags or aborting healthy batches) while the fallback
     * plugin is already resolving the issue underneath.
     *
     * Set to true via config ("consoleLogging": true) or environment variable (OPENCODE_FALLBACK_CONSOLE=1)
     * strictly for local human terminal debugging.
     */
    consoleLogging?: boolean;
    budgets: BudgetsConfig;
    interceptor: InterceptorConfig;
    watchdog: WatchdogConfig;
    parentWatchdog: WatchdogConfig;
    providerDefaults: ProviderConfig;
    providers: Record<string, ProviderConfig>;
}
export declare function loadState(dir: string): void;
export declare function saveState(): void;
export declare class Breaker {
    private cfg;
    failures: number;
    trips: number;
    openUntil: number;
    constructor(cfg: BreakerConfig);
    get isOpen(): boolean;
    recordFailure(cooldownMs?: number): void;
    recordSuccess(): void;
}
/** Synthetic continuation injected by the server on mid-stream failure (D3). */
export declare const CONTINUE_PROMPT = "The previous response was interrupted. Continue from where you left off without repeating completed content.";
interface SessionState {
    sid: string;
    /** Fallback candidates still worth trying this turn (tried/switched ones are removed). */
    chain: string[];
    /** Model currently in the seat this turn. */
    seat: string | undefined;
    /** Seat + switched fallbacks for this turn — never revisit. */
    tried: Set<string>;
    /** Models permanently excluded for this turn (quota/auth/forbidden/not-found/overflow). */
    permFailed?: Set<string>;
    switched: boolean;
    /** Sticky window end for the current seat's transient failures. */
    stickyUntil: number;
    rateLimitMs: Record<string, number>;
    rePrompts: number;
    opts: FallbackOptions;
    originalSeat?: string;
    prompt: {
        text?: string;
        files?: any;
        agents?: string[];
        skills?: string[];
        delivery?: any;
        resume?: boolean | null;
    } | undefined;
    promptPending?: boolean;
    breakers: Map<string, Breaker>;
    blockedUntil: Map<string, number>;
    /** Last observed context size (input + cache read) for this session's turn. */
    tokens: number;
    /** True once WE preemptively switched for context overflow this turn (step 6). */
    preempted: boolean;
    /** Agent locked at session start; only explicit user choice updates it (README). */
    agent?: string;
    /** Wall-clock ceiling for this turn's failover walk (fallbackBudgetMs). */
    deadline: number;
    /** Full passes over the chain used this turn (maxIterations). */
    hops: number;
    /** Providers skipped for this turn after auth/forbidden/provider-level failures. */
    outProviders?: Set<string>;
    /**
     * Last `attempt` value observed by the retry hook. The server's attempt
     * counter resets on every new turn, so a non-increasing value means a new
     * turn started — the signal used to reset per-turn state when the `prompt`
     * hook does not fire (watchdog re-prompts, server-side turn restarts).
     */
    lastAttempt: number;
    lastSwitchedFrom?: string;
}
export declare function __resetStateForTests(): void;
/** Test seam: inject model context limits (providerID/id -> context window). */
export declare function __setModelLimitsForTests(limits: Record<string, number>): void;
export declare function __setRawModelLimitsForTests(limits: Record<string, number> | undefined): void;
/** Test seam: inject known models for catalog validation tests. */
export declare function __setKnownModelsForTests(models: string[] | undefined): void;
export declare function usableContextLimit(info: any): number | undefined;
/**
 * Raw context ceiling (nominal window) for compaction ratio calculation,
 * avoiding compounding double-reserves on models where input limit < context limit.
 */
export declare function rawContextLimit(info: any): number | undefined;
/**
 * Dynamic compaction ratio on a continuous logarithmic curve:
 * Smaller context windows get a higher threshold (smaller margin, up to 85%),
 * while 1M+ windows scale down to baseRatio (default 0.40 = 40%, 60% margin).
 *
 * Formula:
 *   W <= 32k: 0.85
 *   W >= 1M:  baseRatio (default 0.40)
 *   In between: linear interpolation on log2 scale between 32k (0.85) and 1M (baseRatio).
 */
export declare function dynamicCompactionRatio(limit: number, baseRatio?: number): number;
export declare function initCatalog(ctx: any): Promise<void>;
export declare function isModelAvailable(model: any): boolean;
export declare function markModelUnavailable(model: any): void;
export declare function isModelHealthyNow(model: any): boolean;
export declare function recordModelFailure(failedKey: string, c: Classified, fbOpts: FallbackOptions, st?: SessionState): void;
export interface Fallback {
    ctx: any;
    opts: FallbackOptions;
    initCatalog: (ctx?: any) => Promise<void>;
    onRetry: (e: any) => Promise<void>;
    onPrompt: (e: any) => Promise<void>;
    onContext: (e: any) => Promise<void>;
    onIdle: (e?: any) => Promise<void>;
    installTools: (editor: any) => void;
    installAgents: (editor: any) => Promise<void> | void;
    onToolExecuteBefore: (e: any) => Promise<void>;
    consumeEvents: (ctx: any, signal?: AbortSignal) => Promise<void>;
    onModelRequest: (e: any) => Promise<void>;
    onHttpRequest: (e: any) => Promise<void>;
    onHttpResponse: (e: any) => Promise<void>;
    dispose: () => Promise<void> | void;
    classifyError: typeof classifyError;
    isModelAvailable: typeof isModelAvailable;
    markModelUnavailable: typeof markModelUnavailable;
    isModelHealthyNow: typeof isModelHealthyNow;
    recordModelFailure: typeof recordModelFailure;
}
export declare function createFallback(ctx: any, opts?: Partial<FallbackOptions>): Fallback;
export interface CompletionCheck {
    ok: boolean;
    finish?: string;
    text: string;
    tokens: number;
    error?: any;
    reason?: string;
}
/** Token estimate for context headroom: input + cache read, null-safe. */
export declare function contextTokens(m: any): number;
/** Last assistant message of the current turn, skipping synthetic continuations / model switches (D3). */
export declare function lastAssistantInTurn(msgs: any[]): any | undefined;
/** Assistant text of the turn's last assistant message, concatenating across Ms.Continue splits (D3). */
export declare function assistantText(msgs: any[]): string;
export declare function checkCompletion(msgs: any[]): CompletionCheck;
export declare function setGlobalConsoleLogging(enabled: boolean): void;
declare function runSweep(ctx: any, opts: FallbackOptions): Promise<void>;
declare function redact(s: string): string;
export declare const __redactForTests: typeof redact;
export declare const __runSweepForTests: typeof runSweep;
export {};
