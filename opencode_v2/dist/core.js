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
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
const QUOTA_THRESHOLD_MS = 600000; // 10 min: beyond this a rate limit is a quota, not a blip
/** Error emitted when OUR watchdog aborted an attempt, so classification can tell ours from the provider's. */
export const WatchdogAbort = function (message = "aborted by watchdog") {
    const e = new Error(message);
    e.name = "WatchdogAbort";
    return e;
};
function isOurs(err) {
    const n = err?.name ?? "";
    const m = String(err?.message ?? "").toLowerCase();
    return n === "WatchdogAbort" || m === "first-token timeout" || m === "stream stall" || m === "attempt timeout";
}
function headerRetryAfter(headers) {
    if (!headers)
        return undefined;
    const raw = headers["retry-after"] ?? headers["Retry-After"] ?? headers["x-ratelimit-reset"];
    if (!raw)
        return undefined;
    const secs = Number(raw);
    if (Number.isFinite(secs) && secs > 0)
        return secs * 1000;
    const date = Date.parse(raw);
    if (Number.isFinite(date))
        return Math.max(0, date - Date.now());
    return undefined;
}
function errorText(err) {
    const e = err?.error ?? err?.data ?? err ?? {};
    const body = e?.response?.body;
    let text = String(e?.message ?? err?.message ?? "");
    if (typeof body === "string")
        text += ` ${body}`;
    else if (body && typeof body === "object") {
        try {
            text += ` ${JSON.stringify(body)}`;
        }
        catch { /* best effort */ }
    }
    return text.toLowerCase();
}
/**
 * V1 quota text parser: derive the blocked-until reset hint ("resets in Ns" /
 * "retry in Ns") from the error text (message + response body) into a duration.
 */
export function parseQuotaBlockedUntil(err) {
    const text = errorText(err);
    const m = /resets?\s+(?:in|at|:)\s*(\d+(?:\.\d+)?)\s*(\w+)?/.exec(text) ?? /retry\s+in\s+(\d+(?:\.\d+)?)\s*(\w+)?/.exec(text);
    if (!m)
        return undefined;
    const n = Number(m[1]);
    const unit = String(m[2] ?? "seconds").toLowerCase();
    const mult = /ms$/.test(unit) ? 1 : /second|sec/.test(unit) ? 1000 : /minute|min/.test(unit) ? 60000 : /hour|hr/.test(unit) ? 3600000 : /day/.test(unit) ? 86400000 : 1000;
    return n * mult;
}
/** V2 `SessionError.Error.type` taxonomy (provider.*), falling back to status/message heuristics. */
function errTypeOf(err, status) {
    const e = err?.error ?? err?.data ?? err ?? {};
    const t = String(e?.type ?? "");
    if (t)
        return t.toLowerCase();
    const name = String(e?.name ?? "");
    const msg = String(e?.message ?? "").toLowerCase();
    if (status === 401)
        return "provider.auth";
    if (status === 403)
        return "provider.forbidden";
    if (status === 404)
        return "provider.not-found";
    if (status === 402)
        return "provider.quota";
    if (status === 429)
        return "provider.rate-limit";
    if (status !== undefined && status >= 500)
        return "provider.internal";
    if (name === "MessageOutputLengthError" || msg.includes("finish_reason") || msg.includes("empty completion") || msg.includes("incomplete response"))
        return "provider.internal";
    if (msg.includes("context length") || msg.includes("maximum context") || msg.includes("context_length_exceeded") || msg.includes("too many tokens") || msg.includes("request too large") || msg.includes("413"))
        return "context_overflow";
    if (msg.includes("free usage limit") || msg.includes("free usage exceeded") || msg.includes("used up") || msg.includes("daily") || msg.includes("per-day") || msg.includes("free-models-per-day") || msg.includes("quota") || msg.includes("insufficient_quota") || msg.includes("usage limit") || msg.includes("subscribe to go") || msg.includes("resets in"))
        return "provider.quota";
    if (msg.includes("rate limit") || msg.includes("too many requests") || msg.includes("429") || msg.includes("busy"))
        return "provider.rate-limit";
    if (msg.includes("transport") || msg.includes("econnreset") || msg.includes("fetch failed") || msg.includes("socket hang up") || msg.includes("503") || msg.includes("502") || msg.includes("unavailable") || msg.includes("bad gateway"))
        return "provider.transport";
    if (msg.includes("timeout") || msg.includes("timed out"))
        return "provider.timeout";
    if (name === "ProviderAuthError")
        return "provider.auth";
    if (msg.includes("model not found") || msg.includes("unknown model"))
        return "provider.not-found";
    return "provider.internal";
}
export function classifyError(err) {
    if (!err)
        return { cls: "fatal", detail: "unknown error" };
    if (isOurs(err))
        return { cls: "transient", detail: String(err?.message ?? "watchdog abort"), ours: true };
    const e = err?.error ?? err?.data ?? err ?? {};
    let status = typeof e?.statusCode === "number" ? e.statusCode : typeof e?.status === "number" ? e.status : undefined;
    const name = e?.name ?? "";
    const msg = String(e?.message ?? err?.message ?? "").toLowerCase();
    const type = errTypeOf(err, status);
    const retryAfterMs = (typeof e?.retryAfterMs === "number" && e.retryAfterMs > 0 ? e.retryAfterMs : undefined) ??
        parseQuotaBlockedUntil(err) ??
        headerRetryAfter(e?.responseHeaders) ??
        headerRetryAfter(e?.response?.headers) ??
        headerRetryAfter(err?.responseHeaders);
    if (status === undefined) {
        const m = /status(?:_code)?\s*[:=]\s*(\d{3})/i.exec(msg);
        if (m)
            status = Number(m[1]);
    }
    if (type === "provider.auth" || type === "auth" || name === "ProviderAuthError" || status === 401)
        return { cls: "auth", retryAfterMs, detail: "auth" };
    if (type === "provider.forbidden" || type === "forbidden" || status === 403)
        return { cls: "forbidden", retryAfterMs, detail: "forbidden" };
    // Blueprint §5.2: cross-provider failover is required on HTTP 402 (quota).
    if (type === "provider.quota" || type === "quota" || status === 402)
        return { cls: "quota", retryAfterMs, detail: "quota" };
    if (type === "provider.not-found" || type === "not-found" || status === 404 || msg.includes("model not found"))
        return { cls: "model_not_found", retryAfterMs, detail: "not found" };
    if (type === "context_overflow" ||
        type === "context" ||
        status === 413 ||
        msg.includes("context length") ||
        msg.includes("maximum context") ||
        msg.includes("context_length_exceeded") ||
        msg.includes("too many tokens") ||
        msg.includes("request too large")) {
        return { cls: "context_too_large", retryAfterMs, detail: "context too large" };
    }
    if (name === "MessageOutputLengthError" ||
        msg.includes("finish_reason 'length'") ||
        msg.includes("finish=length") ||
        msg.includes("incomplete response") ||
        msg.includes("empty completion")) {
        // Model behavior for THIS request, not provider health — exempt from
        // benching (streak-bounded at the walk), but it still fails over.
        return { cls: "transient", retryAfterMs, detail: "truncated/empty completion" };
    }
    const is429 = type === "provider.rate-limit" ||
        type === "rate-limit" ||
        status === 429 ||
        msg.includes("429") ||
        msg.includes("rate limit") ||
        msg.includes("too many requests") ||
        msg.includes("busy") ||
        /all providers for model .+ are busy right now/i.test(msg) ||
        msg.includes("free usage limit reached") ||
        msg.includes("free usage exceeded");
    const isFalseUsedUp = msg.includes("nothing is used up");
    const quotaWords = (!isFalseUsedUp && msg.includes("used up")) ||
        msg.includes("daily") ||
        msg.includes("per-day") ||
        msg.includes("free-models-per-day") ||
        msg.includes("quota") ||
        msg.includes("insufficient_quota") ||
        msg.includes("free usage limit") ||
        msg.includes("usage limit reached") ||
        msg.includes("free usage exceeded") ||
        msg.includes("subscribe to go") ||
        msg.includes("resets in");
    const longReset = retryAfterMs !== undefined && retryAfterMs > QUOTA_THRESHOLD_MS;
    if (is429 || quotaWords) {
        if (quotaWords || longReset)
            return { cls: "quota", retryAfterMs, detail: "quota" };
        return { cls: "transient", retryAfterMs, detail: "rate limited" };
    }
    if ((status !== undefined && status >= 500) || (type === "provider.internal" && status === undefined))
        return { cls: "provider_level", retryAfterMs, detail: "5xx" };
    if (msg.includes("503") ||
        msg.includes("502") ||
        msg.includes("unavailable") ||
        msg.includes("bad gateway") ||
        msg.includes("econnreset") ||
        msg.includes("fetch failed") ||
        msg.includes("socket hang up")) {
        return { cls: "provider_level", retryAfterMs, detail: "transport" };
    }
    if (msg.includes("timeout") || msg.includes("timed out"))
        return { cls: "transient", retryAfterMs, detail: "timeout" };
    if (status === 400)
        return { cls: "transient", retryAfterMs, detail: "provider 400" };
    if (typeof e?.isRetryable === "boolean" && e.isRetryable)
        return { cls: "transient", retryAfterMs, detail: "retryable" };
    return { cls: "fatal", detail: String(e?.message ?? err?.message ?? "fatal").slice(0, 200) };
}
// ── Small utilities ─────────────────────────────────────────────────────────
const now = () => Date.now();
function sleep(ms) {
    return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}
function fmtModel(m) {
    const key = modelKeyOf(m);
    if (key && key !== "undefined")
        return key;
    return String(m ?? "unknown");
}
function providerOf(key) {
    const i = key.indexOf("/");
    return i === -1 ? "" : key.slice(0, i);
}
function modelKeyOf(m) {
    if (m?.providerID && m?.id)
        return `${m.providerID}/${m.id}`;
    if (m?.providerID && m?.modelID)
        return `${m.providerID}/${m.modelID}`;
    return String(m ?? "");
}
function toModelRef(key) {
    const i = key.indexOf("/");
    if (i === -1)
        return { providerID: "", id: key };
    return { providerID: key.slice(0, i), id: key.slice(i + 1) };
}
/** Explicit agent choice from a hook payload; OpenCode's inferred agent is ignored. */
function pickAgentRef(e) {
    const candidates = [e?.agent, e?.input?.agent, e?.agents, e?.input?.agents];
    for (const c of candidates) {
        if (typeof c === "string" && c.trim().length > 0)
            return c.trim();
        if (Array.isArray(c)) {
            const s = c.map((x) => (typeof x === "string" ? x : x?.name)).find((x) => typeof x === "string" && x.length > 0);
            if (s)
                return s;
        }
    }
    return undefined;
}
/** Exponential backoff mirroring the server's retry schedule (2s → 10s cap). */
function backoffFor(attempt) {
    return Math.min(10_000, 2_000 * 2 ** Math.max(0, attempt));
}
const DEFAULTS = {
    budgetMs: 600000,
    maxIterations: 10,
    compactionRatio: 0.4,
    budgets: {
        fallbackBudgetMs: 600000,
        maxIterations: 10,
        compactionRatio: 0.4,
        charsPerToken: 4,
        quotaThresholdMs: 600000,
        maxCooldownSleepMs: 30000,
    },
    interceptor: { fastRetryMs: 500, defaultRateLimitMs: 60000, maxCooldownSleepMs: 60000 },
    watchdog: {
        enabled: false,
        firstTokenMs: 120000,
        stallTimeoutMs: 90000,
        sweepIntervalMs: 5000,
        debounceMs: 5000,
        compactionDebounceMs: 120000,
    },
    parentWatchdog: {
        enabled: false,
        firstTokenMs: 120000,
        stallTimeoutMs: 90000,
        sweepIntervalMs: 5000,
        debounceMs: 5000,
        compactionDebounceMs: 120000,
    },
    providerDefaults: {
        firstTokenMs: 30000,
        stallTimeoutMs: 90000,
        retryDelayMs: 10000,
        skipDelayMs: 0,
        stickyMs: 180000,
        maxTimeMs: 300000,
        timeoutMs: 180000,
        rateLimitMs: undefined,
        breaker: { threshold: 3, cooldownMs: 60000, maxCooldownMs: 600000 },
    },
    providers: {},
};
function resolveOpts(opts) {
    const o = opts ?? {};
    const budgets = { ...DEFAULTS.budgets, ...(o.budgets ?? {}) };
    const interceptor = { ...DEFAULTS.interceptor, ...(o.interceptor ?? {}) };
    const watchdog = { ...DEFAULTS.watchdog, ...(o.watchdog ?? {}) };
    const parentWatchdog = { ...DEFAULTS.parentWatchdog, ...(o.parentWatchdog ?? {}) };
    const providerDefaults = { ...DEFAULTS.providerDefaults, ...(o.providerDefaults ?? {}) };
    return {
        budgetMs: typeof o.budgetMs === "number" ? o.budgetMs : budgets.fallbackBudgetMs,
        maxIterations: budgets.maxIterations,
        compactionRatio: budgets.compactionRatio,
        budgets,
        interceptor,
        watchdog,
        parentWatchdog,
        providerDefaults,
        providers: { ...DEFAULTS.providers, ...(o.providers ?? {}) },
    };
}
/** Merge a raw provider config over a base (base keys win on undefined). */
function mergeProvider(raw, base = DEFAULTS.providerDefaults) {
    const p = { ...base, breaker: { ...base.breaker } };
    if (!raw || typeof raw !== "object")
        return p;
    for (const k of ["firstTokenMs", "stallTimeoutMs", "retryDelayMs", "skipDelayMs", "stickyMs", "maxTimeMs", "timeoutMs", "rateLimitMs"]) {
        if (typeof raw[k] === "number" && Number.isFinite(raw[k]))
            p[k] = raw[k];
    }
    const b = raw.breaker ?? {};
    if (typeof b.threshold === "number")
        p.breaker.threshold = b.threshold;
    if (typeof b.cooldownMs === "number")
        p.breaker.cooldownMs = b.cooldownMs;
    if (typeof b.maxCooldownMs === "number")
        p.breaker.maxCooldownMs = b.maxCooldownMs;
    return p;
}
/**
 * Load the fallback.json-derived options (budgets / interceptor / watchdog /
 * providerDefaults / providers / defaults.*) and merge them under the
 * programmatic opts. The config file is the source of truth when present;
 * explicit opts still apply for keys the file does not define.
 */
function buildFallbackOpts(fbFile, opts) {
    const f = fbFile ?? {};
    const out = { ...opts };
    const budgets = { ...DEFAULTS.budgets, ...(out.budgets ?? {}) };
    budgets.fallbackBudgetMs = typeof f.fallbackBudgetMs === "number" ? f.fallbackBudgetMs : budgets.fallbackBudgetMs;
    budgets.maxIterations = typeof f.maxIterations === "number" ? f.maxIterations : budgets.maxIterations;
    budgets.compactionRatio = typeof f.compactionRatio === "number" ? f.compactionRatio : budgets.compactionRatio;
    budgets.charsPerToken = typeof f.charsPerToken === "number" ? f.charsPerToken : budgets.charsPerToken;
    budgets.quotaThresholdMs = typeof f.quotaThresholdMs === "number" ? f.quotaThresholdMs : budgets.quotaThresholdMs;
    budgets.maxCooldownSleepMs = typeof f.maxCooldownSleepMs === "number" ? f.maxCooldownSleepMs : budgets.maxCooldownSleepMs;
    out.budgets = budgets;
    const interceptor = { ...DEFAULTS.interceptor, ...(out.interceptor ?? {}) };
    interceptor.fastRetryMs = typeof f.interceptor?.fastRetryMs === "number" ? f.interceptor.fastRetryMs : interceptor.fastRetryMs;
    interceptor.defaultRateLimitMs = typeof f.interceptor?.defaultRateLimitMs === "number" ? f.interceptor.defaultRateLimitMs : interceptor.defaultRateLimitMs;
    interceptor.maxCooldownSleepMs = typeof f.interceptor?.maxCooldownSleepMs === "number" ? f.interceptor.maxCooldownSleepMs : interceptor.maxCooldownSleepMs;
    out.interceptor = interceptor;
    const watchdog = { ...DEFAULTS.watchdog, ...(out.watchdog ?? {}) };
    const parentWatchdog = { ...DEFAULTS.parentWatchdog, ...(out.parentWatchdog ?? {}) };
    const wd = f.watchdog ?? f.parentWatchdog ?? {};
    if (wd && typeof wd === "object") {
        if (typeof wd.enabled === "boolean")
            watchdog.enabled = wd.enabled;
        if (typeof wd.firstTokenMs === "number")
            watchdog.firstTokenMs = wd.firstTokenMs;
        if (typeof wd.stallTimeoutMs === "number")
            watchdog.stallTimeoutMs = wd.stallTimeoutMs;
        if (typeof wd.sweepIntervalMs === "number")
            watchdog.sweepIntervalMs = wd.sweepIntervalMs;
        if (typeof wd.debounceMs === "number")
            watchdog.debounceMs = wd.debounceMs;
        if (typeof wd.compactionDebounceMs === "number")
            watchdog.compactionDebounceMs = wd.compactionDebounceMs;
    }
    const pwd = f.parentWatchdog ?? wd;
    if (pwd && typeof pwd === "object") {
        if (typeof pwd.enabled === "boolean")
            parentWatchdog.enabled = pwd.enabled;
        if (typeof pwd.firstTokenMs === "number")
            parentWatchdog.firstTokenMs = pwd.firstTokenMs;
        if (typeof pwd.stallTimeoutMs === "number")
            parentWatchdog.stallTimeoutMs = pwd.stallTimeoutMs;
    }
    out.watchdog = watchdog;
    out.parentWatchdog = parentWatchdog;
    const providerDefaults = mergeProvider(f.providerDefaults, DEFAULTS.providerDefaults);
    const providers = { ...DEFAULTS.providers, ...(out.providers ?? {}) };
    for (const [k, v] of Object.entries(f.providers ?? {}))
        providers[k] = mergeProvider(v, providerDefaults);
    out.providerDefaults = providerDefaults;
    out.providers = providers;
    out.budgetMs = budgets.fallbackBudgetMs;
    out.maxIterations = budgets.maxIterations;
    out.compactionRatio = budgets.compactionRatio;
    return out;
}
// ── fallback.json (JSONC) loading ────────────────────────────────────────────
function stripJsonComments(str) {
    let inString = false;
    let escaped = false;
    let out = "";
    for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        const next = str[i + 1];
        if (inString) {
            out += ch;
            if (escaped)
                escaped = false;
            else if (ch === "\\")
                escaped = true;
            else if (ch === '"')
                inString = false;
        }
        else {
            if (ch === '"') {
                inString = true;
                out += ch;
            }
            else if (ch === "/" && next === "/") {
                while (i < str.length && str[i] !== "\n")
                    i++;
                out += "\n";
            }
            else if (ch === "/" && next === "*") {
                i += 2;
                while (i < str.length && !(str[i] === "*" && str[i + 1] === "/"))
                    i++;
                i++;
            }
            else
                out += ch;
        }
    }
    return out;
}
function parseJsonWithComments(str) {
    const stripped = stripJsonComments(str);
    const sanitized = stripped.replace(/,\s*([\]}])/g, "$1");
    return JSON.parse(sanitized);
}
function configDir(ctx) {
    const envDir = process.env.OPENCODE_CONFIG_DIR;
    if (envDir)
        return envDir;
    return join(homedir(), ".config", "opencode");
}
let fallbackCache = null;
function loadFallbackFile(ctx) {
    const dir = configDir(ctx);
    try {
        const file = join(dir, "fallback.json");
        const stat = statSync(file);
        const cached = fallbackCache && fallbackCache.dir === dir ? fallbackCache : null;
        if (cached && cached.mtime === stat.mtimeMs)
            return cached.data;
        const parsed = parseJsonWithComments(readFileSync(file, "utf8"));
        const data = parsed && typeof parsed === "object" ? parsed : {};
        // Normalize the nested `defaults` block (blueprint §5.8 / V1 loadFallback)
        // into the flat legacy-compatible keys the rest of the port reads.
        const d = data.defaults && typeof data.defaults === "object" ? data.defaults : undefined;
        const norm = { ...data };
        if (d) {
            if (!norm.defaultFallback && d.fallback)
                norm.defaultFallback = d.fallback;
            if (!norm.defaultLargeContextModel && d.largeContextModel)
                norm.defaultLargeContextModel = d.largeContextModel;
            if (!norm.defaultLargeContextFallback && d.largeContextFallback)
                norm.defaultLargeContextFallback = d.largeContextFallback;
            if (typeof d.minContextRatio === "number")
                norm.defaultMinContextRatio = d.minContextRatio;
        }
        fallbackCache = { dir, mtime: stat.mtimeMs, data: norm };
        return norm;
    }
    catch {
        return fallbackCache?.data ?? {};
    }
}
/**
 * Port of V1 loadRoot: normalize fallback.json (including the nested `defaults`
 * block and the legacy flat keys) into FallbackOptions, so the budgets /
 * interceptor / watchdog / providerDefaults / providers read from the loaded
 * fallback file are actually honored at runtime (P0 #2).
 */
function loadRoot(ctx) {
    const raw = loadFallbackFile(ctx) ?? {};
    const defaults = raw?.defaults ?? {};
    const budgets = { ...DEFAULTS.budgets, ...(raw.budgets ?? {}) };
    if (typeof raw.fallbackBudgetMs === "number")
        budgets.fallbackBudgetMs = raw.fallbackBudgetMs;
    if (typeof raw.maxIterations === "number")
        budgets.maxIterations = raw.maxIterations;
    if (typeof raw.compactionRatio === "number")
        budgets.compactionRatio = raw.compactionRatio;
    if (typeof raw.charsPerToken === "number")
        budgets.charsPerToken = raw.charsPerToken;
    if (typeof raw.quotaThresholdMs === "number")
        budgets.quotaThresholdMs = raw.quotaThresholdMs;
    if (typeof raw.maxCooldownSleepMs === "number")
        budgets.maxCooldownSleepMs = raw.maxCooldownSleepMs;
    const interceptor = { ...DEFAULTS.interceptor, ...(raw.interceptor ?? {}) };
    const watchdog = { ...DEFAULTS.watchdog, ...(raw.watchdog ?? raw.parentWatchdog ?? {}) };
    const providerDefaults = mergeProvider(raw.providerDefaults, DEFAULTS.providerDefaults);
    const providers = { ...DEFAULTS.providers };
    for (const [k, v] of Object.entries(raw.providers ?? {}))
        providers[k] = mergeProvider(v, providerDefaults);
    const fallbackBudgetMs = budgets.fallbackBudgetMs;
    const maxIterations = budgets.maxIterations;
    const compactionRatio = budgets.compactionRatio;
    return {
        budgetMs: fallbackBudgetMs,
        maxIterations,
        compactionRatio,
        budgets,
        interceptor,
        watchdog,
        parentWatchdog: watchdog,
        providerDefaults,
        providers,
    };
}
// ── Circuit breaker ─────────────────────────────────────────────────────────
export class Breaker {
    cfg;
    failures = 0;
    trips = 0;
    openUntil = 0;
    constructor(cfg) {
        this.cfg = cfg;
    }
    get isOpen() { return this.openUntil > now(); }
    recordFailure(cooldownMs) {
        this.failures++;
        if (this.failures < (this.cfg.threshold ?? 1))
            return;
        this.trips++;
        const wait = cooldownMs !== undefined
            ? cooldownMs
            : Math.min(this.cfg.maxCooldownMs ?? this.cfg.cooldownMs, this.cfg.cooldownMs * 2 ** Math.max(0, this.trips - 1));
        this.openUntil = now() + wait;
    }
    recordSuccess() { this.failures = 0; this.trips = 0; this.openUntil = 0; }
}
// ── Corrected-blueprint constants ────────────────────────────────────────────
/** `Schedule.recurs(10)` — the server's retry budget is attempts 0..10; stop advancing beyond it (O2). */
const MAX_RETRY_ATTEMPTS = 10;
/** Step 1 of the port: a single hardcoded fallback target. Full per-agent chains land in sequencing step 2. */
const HARDCODED_FALLBACK_TARGET = "opencode/beam-free";
/** Synthetic continuation injected by the server on mid-stream failure (D3). */
export const CONTINUE_PROMPT = "The previous response was interrupted. Continue from where you left off without repeating completed content.";
const sessions = new Map();
const locks = new Map();
// Module-wide breaker / blocked-until state (P2): a dead model or provider is
// dead for every session, not just the one that tripped it.
const breakersByModel = new Map();
const blockedUntilByModel = new Map();
const MAX_SESSIONS = 256;
export function __resetStateForTests() {
    sessions.clear();
    breakersByModel.clear();
    blockedUntilByModel.clear();
    modelLimitsCache = undefined;
}
/** Test seam: inject model context limits (providerID/id -> context window). */
export function __setModelLimitsForTests(limits) {
    modelLimitsCache = new Map(Object.entries(limits));
}
function fallbackChainFor(ctx, agent) {
    const fbFile = loadFallbackFile(ctx);
    const list = [];
    const agentFb = agent ? fbFile?.agents?.[agent] : undefined;
    list.push(...(agentFb?.fallback ?? []));
    list.push(...(agentFb?.largeContextFallback ?? []));
    list.push(...(fbFile?.defaultFallback ?? []));
    list.push(...(fbFile?.defaultLargeContextFallback ?? []));
    const models = list.map((e) => (typeof e === "string" ? e : e.model)).filter((m) => typeof m === "string" && m.length > 0);
    return [...new Set(models)];
}
function stateFor(ctx, sid, seat, agent, opts) {
    let st = sessions.get(sid);
    if (st)
        return st;
    if (sessions.size >= MAX_SESSIONS) {
        const oldest = sessions.keys().next().value;
        if (oldest !== undefined)
            sessions.delete(oldest);
    }
    const chain = fallbackChainFor(ctx, agent).length > 0 ? fallbackChainFor(ctx, agent) : [HARDCODED_FALLBACK_TARGET];
    st = {
        sid,
        chain,
        seat: seat ?? undefined,
        tried: new Set(seat ? [seat] : []),
        switched: false,
        stickyUntil: 0,
        rateLimitMs: {},
        rePrompts: 0,
        opts: opts ?? DEFAULTS,
        prompt: undefined,
        breakers: new Map(),
        blockedUntil: new Map(),
        tokens: 0,
        preempted: false,
        agent: agent ?? "developer",
        deadline: now() + (opts?.budgets?.fallbackBudgetMs ?? opts?.budgetMs ?? DEFAULTS.budgets.fallbackBudgetMs),
        hops: 0,
        lastAttempt: -1,
    };
    sessions.set(sid, st);
    return st;
}
function enqueue(sid, fn) {
    const prev = (locks.get(sid) ?? Promise.resolve());
    const result = prev.then(fn, fn);
    locks.set(sid, result.catch(() => undefined));
    return result;
}
/**
 * Reset the per-turn failover state: the candidate chain, the tried set, the
 * sticky window, the wall-clock deadline and the pass counter. Called from the
 * `prompt` hook (primary turn boundary) and from the retry hook when the
 * server's attempt counter reveals a turn boundary the prompt hook missed.
 */
function resetTurnState(st, ctx, agent) {
    const chain = fallbackChainFor(ctx, agent ?? st.agent);
    st.chain = chain.length > 0 ? chain : [HARDCODED_FALLBACK_TARGET];
    st.tried = new Set();
    st.switched = false;
    st.stickyUntil = 0;
    st.preempted = false;
    st.originalSeat = st.seat;
    st.hops = 0;
    st.outProviders = new Set();
    st.deadline = now() + (st.opts?.budgets?.fallbackBudgetMs ?? st.opts?.budgetMs ?? DEFAULTS.budgets.fallbackBudgetMs);
}
function nextCandidate(st) {
    for (const m of st.chain) {
        if (st.tried.has(m))
            continue;
        if (st.outProviders?.has?.(providerOf(m)))
            continue;
        const b = breakersByModel.get(m);
        const bt = blockedUntilByModel.get(m);
        if (b?.isOpen)
            continue;
        if (bt !== undefined && bt > now())
            continue;
        return m;
    }
    return undefined;
}
function nextCooldownMs(next, st) {
    const until = blockedUntilByModel.get(next) ?? st.rateLimitMs?.[next];
    if (typeof until !== "number")
        return 0;
    const rem = until - now();
    if (rem <= 0)
        return 0;
    const cap = st.opts?.interceptor?.maxCooldownSleepMs ?? DEFAULTS.interceptor.maxCooldownSleepMs;
    return Math.min(rem, cap);
}
/** Breaker for a model key, lazily created from the session's provider config. */
function breakerFor(st, key) {
    let b = breakersByModel.get(key);
    if (!b) {
        const pcfg = st.opts?.providers?.[providerOf(key)] ?? st.opts?.providerDefaults ?? DEFAULTS.providerDefaults;
        b = new Breaker(pcfg?.breaker ?? DEFAULTS.providerDefaults.breaker);
        breakersByModel.set(key, b);
    }
    return b;
}
/** Rough conversation-size estimate: accumulated context tokens + current prompt. */
function conversationTokens(st) {
    const text = typeof st?.prompt?.text === "string" ? st.prompt.text : "";
    const ratio = st?.opts?.budgets?.charsPerToken ?? DEFAULTS.budgets.charsPerToken;
    const r = ratio > 0 ? ratio : 4;
    const promptTokens = Math.ceil(text.length / r);
    return (st?.tokens ?? 0) + promptTokens;
}
/**
 * Context pre-filter (HIGH): can this candidate hold the conversation?
 * `Model.Info.limit.context` from the live catalog; unknown limits pass.
 */
async function contextFits(ctx, st, key) {
    const limits = await getModelLimits(ctx);
    const limit = limits.get(key);
    if (limit === undefined)
        return true;
    const est = conversationTokens(st);
    return est <= limit;
}
/**
 * Catch-all chain for context overflow (HIGH): the large-context fallback
 * ladder — `largeContextModel` / `largeContextFallback` / default-wide lists —
 * with the same sticky retry / breaker / budget discipline as the main chain.
 * Self-compaction (in-seat) remains the normal tier; this is the catch-all only.
 */
function largeContextChainFor(ctx, agent, anchorKey) {
    const fbFile = loadFallbackFile(ctx);
    const agentFb = agent ? fbFile?.agents?.[agent] : undefined;
    const raw = [];
    const pushList = (list) => {
        for (const e of list ?? []) {
            const m = typeof e === "string" ? e : e?.model;
            if (m)
                raw.push(m);
        }
    };
    const anchor = agentFb?.largeContextModel ?? fbFile?.defaultLargeContextModel ?? anchorKey;
    if (anchor)
        raw.push(anchor);
    pushList(agentFb?.largeContextFallback);
    pushList(agentFb?.fallback);
    pushList(fbFile?.defaultLargeContextFallback);
    pushList(fbFile?.defaultFallback);
    return [...new Set(raw)].filter((m) => typeof m === "string" && m.length > 0);
}
/**
 * Pick the next candidate for the large-context catch-all: first healthy,
 * not-yet-tried model of the large-context chain that can hold the conversation.
 */
async function pickLargeContext(ctx, st, agent, anchorKey) {
    const chain = largeContextChainFor(ctx, agent, anchorKey);
    for (const m of chain) {
        if (st.tried?.has?.(m))
            continue;
        if (st.outProviders?.has?.(providerOf(m)))
            continue;
        const b = breakersByModel.get(m);
        if (b?.isOpen)
            continue;
        const bt = blockedUntilByModel.get(m);
        if (bt !== undefined && bt > now())
            continue;
        const fits = await contextFits(ctx, st, m);
        if (!fits)
            continue;
        return m;
    }
    return undefined;
}
export function createFallback(ctx, opts) {
    const fbOpts = resolveOpts(opts ?? loadRoot(ctx));
    const log = logLine;
    // ── retry hook: classify → sticky / failover / force retry (step 1 + step 2) ──
    const onRetry = async (e) => {
        try {
            // F3: the retry hook carries no `kind`; auxiliary calls (compaction)
            // arrive with agent "compaction" and resolve their own model before
            // entering the retry loop — never switch for them.
            if (e?.agent === "compaction") {
                log(`retry ${e.sessionID}: agent=${e.agent} — skipping (auxiliary)`);
                return;
            }
            const c = classifyError(e?.error);
            log(`retry ${e.sessionID}: ${fmtModel(e?.model)} attempt=${e?.attempt} -> ${c.cls}${c.detail ? ` (${c.detail})` : ""}${c.retryAfterMs !== undefined ? ` retryAfterMs=${c.retryAfterMs}` : ""}`);
            // O2: the retry hook is not called once the budget is spent; treat
            // `attempt` as the hard signal anyway and never advance beyond it.
            const spent = typeof e?.attempt === "number" && e.attempt >= MAX_RETRY_ATTEMPTS;
            if (c.cls === "fatal") {
                log(`retry ${e.sessionID}: fatal — keeping default decision`);
                return;
            }
            const existingSt = sessions.get(e.sessionID);
            const existingBudget = existingSt?.opts?.budgets ?? fbOpts.budgets;
            const existingMaxIters = existingBudget?.maxIterations ?? fbOpts.maxIterations ?? DEFAULTS.budgets.maxIterations;
            const canRollover = spent &&
                !!existingSt &&
                now() < existingSt.deadline &&
                existingSt.hops < existingMaxIters &&
                typeof ctx?.session?.prompt === "function";
            if (spent && !canRollover) {
                log(`retry ${e.sessionID}: attempt budget (${MAX_RETRY_ATTEMPTS}) spent — keeping default decision`);
                unregisterLiveness(e.sessionID);
                return;
            }
            const scheduleRolloverIfSpent = () => {
                if (!canRollover || e?.decision?.retry !== true)
                    return;
                const delay = typeof e.decision.delay === "number" && Number.isFinite(e.decision.delay) && e.decision.delay > 0 ? e.decision.delay : 0;
                e.decision = { retry: false };
                const sid = e.sessionID;
                const stCur = sessions.get(sid);
                if (!stCur)
                    return;
                stCur.lastAttempt = -1;
                deferLiveness(sid, delay + 50);
                log(`retry ${sid}: attempt budget (${MAX_RETRY_ATTEMPTS}) spent — rolling over to fresh step in ${delay}ms`);
                const timer = setTimeout(() => {
                    rolloverTimers.delete(timer);
                    const payload = stCur.prompt;
                    recoveringSessions.add(sid);
                    Promise.resolve(ctx?.session?.prompt?.({
                        sessionID: sid,
                        text: payload?.text ?? CONTINUE_PROMPT,
                        files: payload?.files,
                        agents: payload?.agents,
                        skills: payload?.skills,
                        delivery: payload?.delivery,
                        resume: payload?.resume ?? true,
                    })).catch(() => undefined).finally(() => { recoveringSessions.delete(sid); });
                }, Math.max(50, delay));
                timer.unref?.();
                rolloverTimers.add(timer);
            };
            const failedKey = fmtModel(e?.model);
            const st = stateFor(ctx, e.sessionID, failedKey, e?.agent, fbOpts);
            // Turn detection (live-test fix): the server's `attempt` counter resets to
            // 0 on every new turn. A non-increasing attempt therefore means a NEW
            // turn started. The `prompt` hook is the primary per-turn reset, but it
            // does not fire for every turn boundary (watchdog re-prompts, server-side
            // turn restarts, resumed sessions). Without this, `st.deadline` stays
            // expired from a previous turn and the wall-clock budget immediately
            // blocks all failover — observed live as "wall-clock budget exhausted"
            // on the very first retry of every new turn.
            const attempt = typeof e?.attempt === "number" ? e.attempt : undefined;
            if (attempt !== undefined && attempt <= st.lastAttempt) {
                log(`retry ${e.sessionID}: new turn detected (attempt ${attempt} <= ${st.lastAttempt}) — resetting per-turn state`);
                resetTurnState(st, ctx, st.agent);
            }
            if (attempt !== undefined)
                st.lastAttempt = attempt;
            // D1: transient-class failure opens (or holds open) the sticky window; a
            // rate-limit (429) counts as transient when its retryAfterMs fits the
            // sticky window and the attempt budget is not spent. The window is
            // measured from the first transient failure — once it lapses the chain
            // advances (V1 sticky discipline, corrected blueprint §5.2/D1).
            const isTransientClass = c.cls === "transient";
            if (isTransientClass) {
                const windowMs = (fbOpts.providers[providerOf(failedKey)] ?? fbOpts.providerDefaults)?.stickyMs ?? DEFAULTS.providerDefaults.stickyMs;
                if (st.stickyUntil === 0)
                    st.stickyUntil = now() + windowMs;
            }
            if (isTransientClass && now() < st.stickyUntil) {
                const rateLimitedUntil = st.rateLimitMs?.[failedKey];
                const pcfg = st.opts?.providers?.[providerOf(failedKey)] ?? st.opts?.providerDefaults ?? DEFAULTS.providerDefaults;
                const delay = e?.error?.retryAfterMs ??
                    (typeof rateLimitedUntil === "number" && rateLimitedUntil > now() ? rateLimitedUntil - now() : undefined) ??
                    (typeof pcfg?.rateLimitMs === "number" ? pcfg.rateLimitMs : undefined) ??
                    (typeof fbOpts.interceptor?.defaultRateLimitMs === "number" ? fbOpts.interceptor.defaultRateLimitMs : undefined) ??
                    backoffFor(e.attempt ?? 0);
                e.decision = { retry: true, delay };
                deferLiveness(e.sessionID, delay);
                scheduleRolloverIfSpent();
                return;
            }
            // Wall-clock failover budget (HIGH, requirement: fallbackBudgetMs /
            // maxIterations): ceiling for this turn's failover walk plus a cap on the
            // number of full passes over the chain. Checked before spending another
            // attempt on a candidate.
            const budget = st.opts?.budgets ?? fbOpts.budgets;
            const budgetMs = budget?.fallbackBudgetMs ?? fbOpts.budgetMs ?? DEFAULTS.budgets.fallbackBudgetMs;
            const maxIters = budget?.maxIterations ?? fbOpts.maxIterations ?? DEFAULTS.budgets.maxIterations;
            if (now() >= st.deadline) {
                log(`retry ${e.sessionID}: wall-clock budget (${budgetMs}ms) exhausted — stopping retries`);
                e.decision = { retry: false };
                unregisterLiveness(e.sessionID);
                return;
            }
            if (st.hops >= maxIters) {
                log(`retry ${e.sessionID}: failover pass budget (${maxIters}) spent — stopping retries`);
                e.decision = { retry: false };
                unregisterLiveness(e.sessionID);
                return;
            }
            // P1 #6: a model that just failed is never revisited later in this turn's
            // failover walk — mark it tried (the switch below drops the switched target
            // from the chain; the failed seat is covered by the tried set).
            st.tried.add(failedKey);
            let next = nextCandidate(st);
            // R4/F2: validate the candidate against the live model catalog; drop
            // unavailable entries instead of throwing inside the hook.
            if (next) {
                const limits = await getModelLimits(ctx);
                if (limits.size > 0 && !limits.has(next)) {
                    st.chain = st.chain.filter((m) => m !== next);
                    next = nextCandidate(st);
                }
            }
            if (!next) {
                log(`retry ${e.sessionID}: no fallback candidate left for ${failedKey} — keeping default decision`);
                return;
            }
            // Context pre-filter (HIGH, requirement: context pre-filter): before
            // spending an attempt on a candidate, rule out models whose context limit
            // cannot hold the conversation. On context overflow, run the catch-all
            // large-context fallback chain instead of the regular fallback list;
            // in-seat self-compaction stays the normal tier.
            const agentLocked = st.agent ?? e?.agent ?? "developer";
            let target = next;
            if (c.cls === "context_too_large") {
                target = await pickLargeContext(ctx, st, agentLocked, failedKey);
            }
            else {
                const fits = await contextFits(ctx, st, next);
                if (!fits)
                    target = await pickLargeContext(ctx, st, agentLocked, failedKey);
            }
            if (!target) {
                log(`retry ${e.sessionID}: no fallback candidate left for ${failedKey} — keeping default decision`);
                return;
            }
            // Breaker enforcement (HIGH, requirement: smart_task walks chain with
            // breaker): before advancing past the failed model, record the failure.
            // Transient-advance / provider-level failures trip the breaker (threshold
            // consecutive failures, doubling cooldown ladder under the maxCooldownMs
            // ceiling); quota failures stamp blockedUntil instead. Auth / forbidden /
            // not-found never bench (V1 semantics).
            if (c.cls === "transient" || c.cls === "provider_level")
                breakerFor(st, failedKey).recordFailure();
            if (c.cls === "quota") {
                const reset = c.retryAfterMs ?? fbOpts.budgets?.quotaThresholdMs ?? QUOTA_THRESHOLD_MS;
                const until = now() + reset;
                blockedUntilByModel.set(failedKey, until);
                st.rateLimitMs[failedKey] = until;
            }
            else if (c.cls === "transient") {
                // P1 #8: stamp the failed model's rate-limit window. `retryAfterMs` is a
                // duration; without one, fall back to the provider override then the
                // interceptor default (e.g. UnoRouter's 60s free-tier cooldown).
                const pcfg = st.opts?.providers?.[providerOf(failedKey)] ?? st.opts?.providerDefaults ?? DEFAULTS.providerDefaults;
                const dur = c.retryAfterMs ?? pcfg?.rateLimitMs ?? st.opts?.interceptor?.defaultRateLimitMs ?? DEFAULTS.interceptor.defaultRateLimitMs;
                const ms = typeof dur === "number" && Number.isFinite(dur) && dur > 0 ? dur : DEFAULTS.interceptor.defaultRateLimitMs;
                st.rateLimitMs[failedKey] = now() + ms;
            }
            // P1 #11: auth / forbidden / provider-level failures invalidate the whole
            // provider for this turn's failover walk (a dead credential or sick gateway
            // behind provider A invalidates every sibling fallback on A).
            if (c.cls === "auth" || c.cls === "forbidden" || c.cls === "provider_level") {
                st.outProviders = st.outProviders ?? new Set();
                st.outProviders.add(providerOf(failedKey));
            }
            // O6: switchModel may throw (model unavailable / provider unauthenticated);
            // the hook must never propagate — fall through with the default decision.
            await enqueue(e.sessionID, async () => {
                if (!st.switched)
                    st.originalSeat = st.seat;
                await ctx?.session?.switchModel({ sessionID: e.sessionID, model: toModelRef(target) });
                st.switched = true;
                st.tried.add(target);
                st.chain = st.chain.filter((m) => m !== target);
                st.stickyUntil = 0;
                st.seat = target;
            });
            st.hops += 1;
            // Always re-decide after switching: the failed model's Retry-After is
            // meaningless once we have moved to a different model. Sleep only the
            // next model's cooldown — 0 when it has no active rate-limit window (O1:
            // sticky failover writes one durable model-switched artifact).
            e.decision = { retry: true, delay: nextCooldownMs(target, st) };
            deferLiveness(e.sessionID, e.decision.delay);
            scheduleRolloverIfSpent();
            log(`retry ${e.sessionID}: switched ${failedKey} -> ${target} (${c.cls}, attempt ${e.attempt})`);
        }
        catch (err) {
            log(`retry hook failed, keeping default decision: ${String(err)}`);
        }
    };
    // ── prompt hook: reset per-turn state, capture admission payload ──────────
    const onPrompt = async (e) => {
        try {
            const sid = e?.sessionID;
            if (!sid)
                return;
            const existing = sessions.get(sid);
            const st = existing ?? stateFor(ctx, sid, undefined, e?.agent, fbOpts);
            // Agent locking (MEDIUM, requirement: fallback chain uses the agent locked
            // at session start): only an explicit user choice (prompt admission) may
            // update the lock; OpenCode's inferred agent is ignored.
            const explicitAgent = pickAgentRef(e);
            if (explicitAgent && explicitAgent !== st.agent) {
                st.agent = explicitAgent;
            }
            const isRecovery = recoveringSessions.delete(sid);
            if (!isRecovery) {
                // Reset per-turn state here — NOT on idle (idle does not run after
                // failure/interrupt). The full fallback chain is restored every turn so
                // candidates consumed by a previous turn's failover walk do not leak.
                st.rePrompts += 1;
                resetTurnState(st, ctx, st.agent);
            }
            else {
                // A watchdog recovery re-prompt continues the SAME logical failover
                // walk: keep the chain, the tried set and the wall-clock deadline, but
                // clear the attempt counter so the retry hook does not mistake the
                // server's fresh attempt numbering for a new user turn.
                st.lastAttempt = -1;
            }
            const p = e?.prompt ?? {};
            st.prompt = {
                text: typeof p?.text === "string" ? p.text : typeof e?.text === "string" ? e.text : typeof e?.input?.text === "string" ? e.input.text : undefined,
                files: p?.files ?? e?.files ?? e?.input?.files,
                agents: p?.agents ?? e?.agents ?? e?.input?.agents,
                skills: p?.skills ?? e?.skills ?? e?.input?.skills,
                delivery: p?.delivery ?? e?.delivery ?? e?.input?.delivery,
                resume: p?.resume ?? e?.resume ?? e?.input?.resume ?? true,
            };
            // Register liveness for this session so pre-token stalls are watched
            // even before the first streaming event lands (P1 #9).
            if (sid)
                ensureLiveness(ctx, sid, fbOpts);
        }
        catch (err) {
            log(`prompt hook failed: ${String(err)}`);
        }
    };
    // ── context hook: per-model semantic options via e.options keyed on e.model (D6) ──
    const onContext = async (e) => {
        try {
            const sid = e?.sessionID ?? e?.input?.sessionID;
            const l = sid ? liveness.get(sid) : undefined;
            if (l) {
                const t = now();
                l.startedAt = t;
                l.lastPartAt = t;
                l.pausedUntil = undefined;
            }
            const model = e?.model ?? e?.input?.model;
            const key = fmtModel(model);
            const fbFile = loadFallbackFile(ctx);
            const entry = findFallbackEntry(fbFile, key);
            const options = { ...(e?.options ?? e?.input?.options ?? {}) };
            if (entry) {
                if (typeof entry.temperature === "number")
                    options.temperature = entry.temperature;
                if (entry.reasoningEffort)
                    options.reasoningEffort = entry.reasoningEffort;
                if (entry.thinking)
                    options.thinking = entry.thinking;
            }
            e.options = options;
            if (e?.input && typeof e.input === "object")
                e.input = { ...e.input, options };
            // P1 #10: proactive context-overflow pre-emption — before dispatch, watch
            // the conversation size against the seat model's context limit and switch
            // via the catch-all large-context chain before the request that would
            // overflow. Overflow bypasses the retry hook (blueprint §5.2/O3), so the
            // proactive switch must live here.
            const st = sid ? sessions.get(sid) : undefined;
            if (st && !st.switched && key && key !== "unknown") {
                st.seat = key;
                st.originalSeat = key;
            }
            if (st && !st.preempted) {
                const limits = await getModelLimits(ctx);
                const limit = limits.get(key);
                if (limit !== undefined && conversationTokens(st) > limit) {
                    st.preempted = true;
                    const agentLocked = st.agent ?? e?.agent ?? "developer";
                    const next = await pickLargeContext(ctx, st, agentLocked, key);
                    if (next) {
                        try {
                            await ctx?.session?.switchModel({ sessionID: sid, model: toModelRef(next) });
                            st.switched = true;
                            st.seat = next;
                            st.tried.add(next);
                            st.chain = st.chain.filter((m) => m !== next);
                            st.stickyUntil = 0;
                            log(`context ${sid}: ~${conversationTokens(st)} tokens > ${limit} limit on ${key} — preemptively switched -> ${next}`);
                        }
                        catch { /* best effort */ }
                    }
                }
            }
        }
        catch (err) {
            log(`context hook failed: ${String(err)}`);
        }
    };
    // ── idle hook: restore policy (sticky by default, opt-in restore) ──────────
    const onIdle = async (e) => {
        try {
            const sid = e?.sessionID;
            if (sid)
                unregisterLiveness(sid);
            const st = sid ? sessions.get(sid) : undefined;
            if (!st || !st.switched)
                return;
            if (fbOpts.restoreOnSuccess !== true)
                return; // sticky by default (O1)
            const msgs = await readFlatMessages(ctx, sid);
            const check = checkCompletion(msgs);
            // Success is only knowable once the turn finished — record it so the
            // breaker's consecutive-failure streak resets on real recoveries.
            if (check.ok) {
                const b = breakersByModel.get(st.seat ?? "");
                if (b)
                    b.recordSuccess();
            }
            if (!check.ok)
                return;
            const current = lastAssistantInTurn(msgs);
            const currentKey = current ? fmtModel(current?.model ?? current) : undefined;
            // After a failover, the completed assistant message was produced by st.seat,
            // so a manual mid-turn user switch is detected by comparing against st.seat
            // (not st.originalSeat) — otherwise restoreOnSuccess could never restore.
            if (currentKey && st.seat && currentKey !== st.seat) {
                // the user switched manually mid-turn — never fight the user (R6)
                return;
            }
            const target = st.originalSeat ?? st.seat;
            if (!target)
                return;
            await ctx?.session?.switchModel({ sessionID: sid, model: toModelRef(target) });
            st.switched = false;
            st.seat = target;
            st.tried = new Set([target]);
        }
        catch (err) {
            log(`idle hook failed: ${String(err)}`);
        }
    };
    // ── tools: subagent tool override (step 5) ─────────────────────────────────
    const installTools = (editor) => {
        try {
            const apply = editor?.update ?? editor?.modify;
            if (typeof apply !== "function")
                return;
            // V2 ToolEditor contract: `update(id, fn)` — the fn receives a MUTABLE
            // draft and its return value is ignored; mutate the draft in place. The
            // override preserves the built-in `subagent` tool shape ({ agent,
            // sessionID, description, prompt, model?, background? }) while overriding
            // only the description (fallback-aware copy) and args.
            const override = (tool) => {
                const draft = tool ?? {};
                draft.agent = tool?.agent;
                draft.sessionID = tool?.sessionID;
                draft.description =
                    "Delegate a task to a subagent with automatic model fallback. Walks the fallback chain " +
                        "with a circuit breaker, a wall-clock budget and a completeness gate; if the primary model " +
                        "is rate-limited or stalls, retries fallback models. Returns the first complete result — " +
                        "transparent to the caller.";
                draft.prompt = tool?.prompt;
                draft.model = tool?.model;
                draft.background = tool?.background;
                draft.args = { ...(tool?.args ?? {}) };
                return draft;
            };
            if (typeof editor?.update === "function")
                editor.update("subagent", override);
            else
                apply("subagent", override);
        }
        catch (err) {
            log(`tool transform failed: ${String(err)}`);
        }
    };
    // ── agents: upsert missing fallback agents via AgentEditor.update (F1, R9) ──
    const installAgents = async (editor) => {
        try {
            const apply = editor?.update ?? editor?.modify;
            if (typeof apply !== "function")
                return;
            const fbFile = loadFallbackFile(ctx);
            const wanted = [
                ...Object.keys(fbFile?.agents ?? {}),
                "architect",
                "debugger",
                "code-review",
                "researcher",
                "researcher-vision",
                "tester",
                "orchestrator",
            ];
            for (const id of [...new Set(wanted)]) {
                const agentFb = fbFile?.agents?.[id];
                const fallbacks = [
                    ...(agentFb?.fallback ?? []),
                    ...(agentFb?.largeContextFallback ?? []),
                    ...(fbFile?.defaultFallback ?? []),
                ];
                const model = fallbacks.map((e) => (typeof e === "string" ? e : e.model)).find((m) => m) ?? HARDCODED_FALLBACK_TARGET;
                // Guard: never clobber an agent the operator configured with its own model.
                const existing = typeof editor?.get === "function" ? editor.get(id) : undefined;
                const existingObj = existing && typeof existing === "object" ? existing : undefined;
                if (existingObj && existingObj.model)
                    continue;
                const agent = {
                    name: id,
                    description: `Fallback agent registered by opencode-subagent-fallback (${id})`,
                    mode: id === "compaction" ? "primary" : "subagent",
                    model: toModelRef(model),
                };
                // V2 AgentEditor contract: `update(id, fn)` is an upsert that receives a
                // mutable draft (creating the agent when absent) and ignores the return.
                // Preserve existing built-in fields (especially `mode` on `build`!).
                apply.call(editor, id, (draft) => {
                    const d = draft ?? {};
                    if (!existingObj) {
                        d.name = agent.name;
                        d.description = agent.description;
                        d.mode = agent.mode;
                    }
                    else {
                        if (!d.name)
                            d.name = agent.name;
                        if (!d.description)
                            d.description = agent.description;
                        if (!d.mode)
                            d.mode = agent.mode;
                    }
                    if (!d.model)
                        d.model = agent.model;
                    return d;
                });
            }
        }
        catch (err) {
            log(`agent transform failed: ${String(err)}`);
        }
    };
    // ── transport hooks (D6 / blueprint §5.9): model.request carries baseURL+headers ──
    const onModelRequest = async (e) => {
        try {
            // V2: switchModel causes OpenCode to resolve the target provider's native
            // baseURL and SDK driver automatically. Do NOT overwrite e.baseURL here —
            // forcing a relay URL breaks natively-proxied providers (opencode Zen, etc.).
            // This hook is retained as a transport inspection point only.
        }
        catch (err) {
            log(`model.request hook failed: ${String(err)}`);
        }
    };
    const onHttpRequest = async (e) => {
        try { /* transport inspection point — blueprint §5.9 */ }
        catch (err) {
            log(`http.request hook failed: ${String(err)}`);
        }
    };
    const onHttpResponse = async (e) => {
        try { /* transport inspection point — blueprint §5.9 */ }
        catch (err) {
            log(`http.response hook failed: ${String(err)}`);
        }
    };
    // Start the watchdog sweep for this fallback instance (cleared on dispose).
    let watchdogTimer;
    const startWatchdog = () => {
        if (watchdogTimer)
            return;
        if (!fbOpts.watchdog?.enabled)
            return; // watchdog disabled via fallback.json
        watchdogTimer = setInterval(() => { void runSweep(ctx, fbOpts); }, fbOpts.watchdog?.sweepIntervalMs ?? 5000);
        watchdogTimers.add(watchdogTimer);
        watchdogTimer.unref?.();
    };
    const fb = {
        ctx,
        opts: fbOpts,
        onRetry,
        onPrompt,
        onContext,
        onIdle,
        installTools,
        installAgents,
        onModelRequest,
        onHttpRequest,
        onHttpResponse,
        consumeEvents: async (ctxIn, signal) => {
            const ctx2 = ctxIn ?? ctx;
            const source = ctx2?.event?.subscribe?.();
            if (!source)
                return;
            const ag = source[Symbol.asyncIterator]?.();
            if (!ag)
                return;
            const abort = signal ?? new AbortController().signal;
            try {
                for await (const ev of ag) {
                    if (abort?.aborted)
                        break;
                    await handleEvent(ctx2, ev, fbOpts);
                }
            }
            catch { /* subscription closed or aborted */ }
        },
        dispose: async () => {
            if (watchdogTimer) {
                clearInterval(watchdogTimer);
                watchdogTimer = undefined;
            }
            watchdogTimers.clear();
            for (const t of rolloverTimers)
                clearTimeout(t);
            rolloverTimers.clear();
            sessions.clear();
            return;
        },
        classifyError,
    };
    startWatchdog();
    return fb;
}
const KNOWN_PROVIDER_BASE_URLS = {
    opencode: "https://opencode.ai/inference/openai/v1",
    openrouter: "https://openrouter.ai/api/v1",
    unorouter: "https://api.unorouter.com/v1",
    "unorouter-custom": "https://api.unorouter.com/v1",
    zai: "https://open.bigmodel.cn/api/paas/v4",
};
/** Providers whose endpoint the server already routes natively — never overwrite. */
const NATIVE_PROVIDER_SKIP = new Set(["opencode", "openrouter", "unorouter", "unorouter-custom", "zai"]);
function findFallbackEntry(fbFile, key) {
    const entries = [
        ...(Object.values(fbFile?.agents ?? {}).flatMap((a) => [...(a?.fallback ?? []), ...(a?.largeContextFallback ?? [])])),
        ...(fbFile?.defaultFallback ?? []),
        ...(fbFile?.defaultLargeContextFallback ?? []),
    ];
    const hit = entries.find((e) => {
        const m = typeof e === "string" ? e : e.model;
        const i = m.indexOf("/");
        return i === -1 ? m === key : `${m.slice(0, i)}/${m.slice(i + 1)}` === key;
    });
    return hit ? (typeof hit === "string" ? { model: hit } : hit) : undefined;
}
async function readFlatMessages(ctx, sid) {
    if (!sid)
        return [];
    try {
        const res = await ctx?.session?.context?.({ sessionID: sid });
        const list = Array.isArray(res) ? res : res?.data ?? [];
        return Array.isArray(list) ? list : [];
    }
    catch {
        return [];
    }
}
/** Token estimate for context headroom: input + cache read, null-safe. */
export function contextTokens(m) {
    if (!m?.tokens)
        return 0;
    const t = m.tokens;
    const input = typeof t.input === "number" ? t.input : 0;
    const cache = t.cache ?? {};
    const cacheRead = typeof cache?.read === "number" ? cache.read : 0;
    return input + cacheRead;
}
function isSkippableTurnMeta(m) {
    const t = m?.type;
    if (t === "model-switched" || t === "agent-switched" || t === "idle" || t === "synthetic")
        return true;
    return t === "user" && m?.text === CONTINUE_PROMPT;
}
/** Last assistant message of the current turn, skipping synthetic continuations / model switches (D3). */
export function lastAssistantInTurn(msgs) {
    for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m?.type === "assistant")
            return m;
        if (isSkippableTurnMeta(m))
            continue;
        break;
    }
    return undefined;
}
/** Assistant text of the turn's last assistant message, concatenating across Ms.Continue splits (D3). */
export function assistantText(msgs) {
    const parts = [];
    for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (isSkippableTurnMeta(m))
            continue;
        if (m?.type !== "assistant")
            break;
        const content = Array.isArray(m?.content) ? m.content : [];
        parts.unshift(content.filter((c) => c?.type === "text").map((c) => c?.text ?? "").join("\n"));
    }
    return parts.filter((p) => p.trim().length > 0).join("\n");
}
export function checkCompletion(msgs) {
    const m = lastAssistantInTurn(msgs);
    if (!m)
        return { ok: false, finish: undefined, text: "", tokens: 0, error: undefined, reason: "no-assistant" };
    let trailingIdleSucceeded = false;
    for (let i = msgs.length - 1; i >= 0; i--) {
        const item = msgs[i];
        if (item === m)
            break;
        if (item?.type === "idle" && item?.outcome === "succeeded") {
            trailingIdleSucceeded = true;
            break;
        }
    }
    const text = assistantText(msgs);
    const content = Array.isArray(m?.content) ? m.content : [];
    const toolParts = content.some((c) => c?.type === "tool");
    const busy = content.some((c) => c?.type === "tool" && (c?.state?.status === "streaming" || c?.state?.status === "running"));
    const ok = m.time?.completed != null &&
        m.error == null &&
        !busy &&
        m.finish !== "length" &&
        m.finish !== "error" &&
        ((text ?? "").trim().length > 0 || toolParts || trailingIdleSucceeded);
    return { ok, finish: m.finish, text, tokens: contextTokens(m), error: m.error };
}
const liveness = new Map();
const abortStampedAt = new Map();
const recoveringSessions = new Set();
const rolloverTimers = new Set();
const watchdogTimers = new Set();
function registerLiveness(sid, l) { liveness.set(sid, l); }
function unregisterLiveness(sid) { liveness.delete(sid); }
function ensureLiveness(ctx, sid, opts) {
    let l = liveness.get(sid);
    if (!l) {
        l = {
            startedAt: now(),
            lastPartAt: now(),
            firstTokenReceived: false,
            firstTokenMs: opts.watchdog?.firstTokenMs ?? DEFAULTS.watchdog.firstTokenMs ?? 120000,
            stallTimeoutMs: opts.watchdog?.stallTimeoutMs ?? DEFAULTS.watchdog.stallTimeoutMs ?? 90000,
            onStall: async (s) => { await recover(ctx, s); },
        };
        registerLiveness(sid, l);
    }
    return l;
}
function stampAlive(sid) { const l = liveness.get(sid); if (l) {
    l.lastPartAt = now();
    l.pausedUntil = undefined;
} }
function deferLiveness(sid, delayMs) {
    const l = liveness.get(sid);
    if (!l || typeof delayMs !== "number" || !Number.isFinite(delayMs) || delayMs <= 0)
        return;
    const until = now() + delayMs;
    l.pausedUntil = until;
    l.startedAt = until;
    l.lastPartAt = until;
}
function consumeOurAbort(sid) { const t = abortStampedAt.get(sid); if (t === undefined)
    return false; abortStampedAt.delete(sid); return true; }
function armOurAbort(sid, t = now()) { abortStampedAt.set(sid, t); }
function eventSid(ev) {
    const p = ev?.properties ?? ev?.data ?? ev ?? {};
    if (typeof p?.sessionID === "string")
        return p.sessionID;
    const info = p?.info ?? p?.message?.info;
    if (info?.sessionID)
        return info.sessionID;
    const part = p?.part ?? p;
    if (part?.sessionID)
        return part.sessionID;
    if (p?.session?.id)
        return p.session.id;
    return undefined;
}
function isLivenessEventType(type) {
    if (!type)
        return false;
    // Only token-producing / streaming events stamp liveness. Terminal events
    // (session.execution.*, session.status.idle) must NOT re-arm liveness.
    const prefixes = [
        "session.text.",
        "session.reasoning.",
        "session.tool.",
        "session.step.",
        "session.retry.",
    ];
    return prefixes.some((p) => type.startsWith(p));
}
function tokensFromEvent(ev) {
    const p = ev?.properties ?? ev?.data ?? ev ?? {};
    const info = p?.info ?? p?.message?.info;
    const t = info?.tokens ?? p?.tokens;
    if (!t)
        return undefined;
    const input = typeof t.input === "number" ? t.input : 0;
    const cache = t.cache ?? {};
    const read = typeof cache?.read === "number" ? cache.read : 0;
    const total = input + read;
    return total > 0 ? total : undefined;
}
async function handleEvent(ctx, ev, opts) {
    const type = ev?.type;
    const sid = eventSid(ev);
    // Terminal turn state (V2: `session.status.idle`; legacy `session.idle` kept).
    if (type === "session.idle" || type === "session.status.idle" ||
        type === "session.execution.succeeded" || type === "session.execution.failed" ||
        type === "session.execution.interrupted") {
        if (sid)
            unregisterLiveness(sid);
        return;
    }
    if (isLivenessEventType(type)) {
        if (sid) {
            let l = liveness.get(sid);
            if (!l) {
                l = {
                    startedAt: now(),
                    lastPartAt: now(),
                    firstTokenReceived: false,
                    firstTokenMs: opts.watchdog?.firstTokenMs ?? DEFAULTS.watchdog.firstTokenMs ?? 120000,
                    stallTimeoutMs: opts.watchdog?.stallTimeoutMs ?? DEFAULTS.watchdog.stallTimeoutMs ?? 90000,
                    onStall: async (s) => { await recover(ctx, s); },
                };
                registerLiveness(sid, l);
            }
            stampAlive(sid);
            const tok = tokensFromEvent(ev);
            if (tok !== undefined && l) {
                l.firstTokenReceived = true;
                const st = sessions.get(sid);
                if (st)
                    st.tokens = tok;
                else
                    stateFor(ctx, sid).tokens = tok;
            }
        }
    }
}
function hasActiveToolPart(msgs) {
    const m = lastAssistantInTurn(msgs);
    const content = Array.isArray(m?.content) ? m.content : [];
    return content.some((c) => c?.type === "tool" &&
        (c?.state?.status === "streaming" || c?.state?.status === "running" || c?.state?.status === "pending"));
}
function isTerminalIdleMessage(msgs) {
    const last = msgs.length > 0 ? msgs[msgs.length - 1] : undefined;
    return last?.type === "idle" && (last?.outcome === "succeeded" || last?.outcome === "failed");
}
async function recover(ctx, sid) {
    try {
        const msgs = await readFlatMessages(ctx, sid);
        const check = checkCompletion(msgs);
        if (check.ok || isTerminalIdleMessage(msgs)) {
            unregisterLiveness(sid);
            return; // turn actually completed or terminally failed while we were away
        }
        if (hasActiveToolPart(msgs))
            return; // waiting on an active tool / subagent call
        const st = sessions.get(sid);
        const payload = st?.prompt;
        recoveringSessions.add(sid);
        try {
            await ctx?.session?.prompt?.({
                sessionID: sid,
                text: payload?.text ?? CONTINUE_PROMPT,
                files: payload?.files,
                agents: payload?.agents,
                skills: payload?.skills,
                delivery: payload?.delivery,
                resume: payload?.resume ?? true,
            });
        }
        finally {
            recoveringSessions.delete(sid);
        }
    }
    catch { /* re-prompt is best effort */ }
}
const LOG_DIR = join(homedir(), ".local", "share", "opencode", "log");
const LOG_FILE = join(LOG_DIR, "fallback.log");
function logLine(msg) {
    const clean = redact(msg);
    const line = `${new Date().toISOString()} [subagent-fallback] ${clean}\n`;
    try {
        appendFileSync(LOG_FILE, line, "utf8");
    }
    catch {
        try {
            mkdirSync(LOG_DIR, { recursive: true });
            appendFileSync(LOG_FILE, line, "utf8");
        }
        catch { /* logging must never break the hook or sweep */ }
    }
    if (process.env.OPENCODE_FALLBACK_CONSOLE === "1") {
        try {
            console.error(`[subagent-fallback] ${clean}`);
        }
        catch { /* best effort */ }
    }
}
async function runSweep(ctx, opts) {
    const t = now();
    for (const [sid, l] of [...liveness]) {
        if (l.pausedUntil !== undefined && t < l.pausedUntil)
            continue;
        const seenFirstToken = l.firstTokenReceived;
        const silence = t - (seenFirstToken ? l.lastPartAt : l.startedAt);
        const limit = seenFirstToken ? l.stallTimeoutMs : l.firstTokenMs;
        if (silence < limit)
            continue;
        // Inspect session messages before interrupting: if the turn already reached
        // a terminal idle state (succeeded/failed) or is actively waiting on a
        // running tool (e.g. a subagent), do not interrupt it.
        const msgs = await readFlatMessages(ctx, sid);
        if (msgs.length > 0) {
            if (isTerminalIdleMessage(msgs) || checkCompletion(msgs).ok) {
                unregisterLiveness(sid);
                continue;
            }
            if (hasActiveToolPart(msgs)) {
                l.startedAt = t;
                l.lastPartAt = t;
                continue;
            }
        }
        // Recovery: interrupt, then verify via context before re-prompting.
        // (Single recovery path — l.onStall IS the recovery; do not call recover
        // twice for the same stall.)
        logLine(`watchdog ${sid}: ${seenFirstToken ? "stall" : "first-token"} timeout (${silence}ms >= ${limit}ms) — interrupting`);
        armOurAbort(sid, t);
        try {
            await ctx?.session?.interrupt?.({ sessionID: sid });
        }
        catch { /* best effort */ }
        l.startedAt = t;
        l.lastPartAt = t;
        await l.onStall?.(sid);
    }
}
async function loadModelLimits(ctx) {
    try {
        const res = await ctx?.model?.list?.();
        const data = res?.data ?? res?.models ?? [];
        const m = new Map();
        for (const info of Array.isArray(data) ? data : []) {
            const ctx0 = info?.limit?.context;
            if (typeof ctx0 === "number")
                m.set(`${info?.providerID}/${info?.id}`, ctx0);
        }
        return m;
    }
    catch {
        return new Map();
    }
}
let modelLimitsCache;
async function getModelLimits(ctx) {
    if (!modelLimitsCache)
        modelLimitsCache = await loadModelLimits(ctx);
    return modelLimitsCache;
}
// ── Redaction + telemetry helper ─────────────────────────────────────────────
function redact(s) {
    return s.replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]").replace(/bearer\s+[A-Za-z0-9._-]+/gi, "bearer [REDACTED]");
}
export const __redactForTests = redact;
export const __runSweepForTests = runSweep;
