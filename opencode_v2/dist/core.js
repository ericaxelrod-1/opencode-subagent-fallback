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
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
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
    if (msg.includes("model not found") || msg.includes("unknown model") || msg.includes("model unavailable") || name === "ModelUnavailableError")
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
    if (type === "provider.not-found" ||
        type === "not-found" ||
        status === 404 ||
        msg.includes("model not found") ||
        msg.includes("unknown model") ||
        msg.includes("model unavailable") ||
        name === "ModelUnavailableError") {
        return { cls: "model_not_found", retryAfterMs, detail: "not found" };
    }
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
    // consoleLogging: Suppresses all fallback, retry, and breaker output to stdout/stderr when false (default: false).
    // Silent resilience: hides internal model failover traces from parent orchestrator agents to prevent panic.
    consoleLogging: false,
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
    const out = {
        budgetMs: typeof o.budgetMs === "number" ? o.budgetMs : budgets.fallbackBudgetMs,
        maxIterations: budgets.maxIterations,
        compactionRatio: budgets.compactionRatio,
        consoleLogging: typeof o.consoleLogging === "boolean" ? o.consoleLogging : DEFAULTS.consoleLogging,
        budgets,
        interceptor,
        watchdog,
        parentWatchdog,
        providerDefaults,
        providers: { ...DEFAULTS.providers, ...(o.providers ?? {}) },
    };
    if (o.agents)
        out.agents = o.agents;
    if (o.defaultLargeContextModel)
        out.defaultLargeContextModel = o.defaultLargeContextModel;
    if (o.defaultLargeContextFallback)
        out.defaultLargeContextFallback = o.defaultLargeContextFallback;
    if (o.largeContextModel)
        out.largeContextModel = o.largeContextModel;
    if (o.largeContextFallback)
        out.largeContextFallback = o.largeContextFallback;
    return out;
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
let currentConfigDir = "";
export function loadState(dir) {
    try {
        const file = join(dir, "fallback-state.json");
        const raw = JSON.parse(readFileSync(file, "utf8"));
        const t = now();
        if (raw.blockedUntil && typeof raw.blockedUntil === "object") {
            for (const [m, until] of Object.entries(raw.blockedUntil)) {
                if (typeof until === "number" && until > t)
                    blockedUntilByModel.set(m, until);
            }
        }
    }
    catch { }
}
export function saveState() {
    const dir = currentConfigDir || configDir(undefined);
    if (!dir)
        return;
    try {
        const file = join(dir, "fallback-state.json");
        const t = now();
        const activeBlocks = {};
        for (const [m, until] of blockedUntilByModel.entries()) {
            if (until > t)
                activeBlocks[m] = until;
        }
        writeFileSync(file, JSON.stringify({ blockedUntil: activeBlocks, savedAt: t }, null, 2), "utf8");
    }
    catch { }
}
let fallbackCache = null;
function loadFallbackFile(ctx) {
    const dir = configDir(ctx);
    currentConfigDir = dir;
    loadState(dir);
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
    // Console output suppression (Silent Resilience):
    // Suppress stderr/stdout fallback traces by default to keep orchestrator agents calm.
    const consoleLogging = typeof raw.consoleLogging === "boolean"
        ? raw.consoleLogging
        : typeof defaults.consoleLogging === "boolean"
            ? defaults.consoleLogging
            : DEFAULTS.consoleLogging;
    return {
        budgetMs: fallbackBudgetMs,
        maxIterations,
        compactionRatio,
        consoleLogging,
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
function pickDefaultAvailableModel() {
    if (isModelHealthyNow(HARDCODED_FALLBACK_TARGET))
        return HARDCODED_FALLBACK_TARGET;
    if (knownModelsCache && knownModelsCache.size > 0) {
        for (const m of knownModelsCache) {
            if (m.includes("/") && isModelHealthyNow(m))
                return m;
        }
        for (const m of knownModelsCache) {
            if (m.includes("/"))
                return m;
        }
        const first = knownModelsCache.values().next().value;
        if (first)
            return first;
    }
    return HARDCODED_FALLBACK_TARGET;
}
/** Synthetic continuation injected by the server on mid-stream failure (D3). */
export const CONTINUE_PROMPT = "The previous response was interrupted. Continue from where you left off without repeating completed content.";
const sessions = new Map();
const locks = new Map();
// Module-wide breaker / blocked-until state (P2): a dead model or provider is
// dead for every session, not just the one that tripped it.
const breakersByModel = new Map();
const blockedUntilByModel = new Map();
const lastCompactAt = new Map();
const MAX_SESSIONS = 256;
let modelLimitsCache;
let rawModelLimitsCache;
let knownModelsCache;
export function __resetStateForTests() {
    sessions.clear();
    breakersByModel.clear();
    blockedUntilByModel.clear();
    lastCompactAt.clear();
    modelLimitsCache = undefined;
    rawModelLimitsCache = undefined;
    knownModelsCache = undefined;
    const dir = currentConfigDir || (process.env.OPENCODE_CONFIG_DIR ?? "");
    if (dir) {
        try {
            rmSync(join(dir, "fallback-state.json"), { force: true });
        }
        catch { }
    }
}
/** Test seam: inject model context limits (providerID/id -> context window). */
export function __setModelLimitsForTests(limits) {
    modelLimitsCache = new Map(Object.entries(limits));
    rawModelLimitsCache = new Map(Object.entries(limits));
}
export function __setRawModelLimitsForTests(limits) {
    if (!limits) {
        rawModelLimitsCache = undefined;
        return;
    }
    rawModelLimitsCache = new Map(Object.entries(limits));
}
/** Test seam: inject known models for catalog validation tests. */
export function __setKnownModelsForTests(models) {
    if (!models) {
        knownModelsCache = undefined;
        return;
    }
    const s = new Set();
    for (const m of models) {
        s.add(m);
        s.add(m.toLowerCase());
        const slash = m.indexOf("/");
        if (slash !== -1) {
            const id = m.slice(slash + 1);
            s.add(id);
            s.add(id.toLowerCase());
        }
    }
    knownModelsCache = s;
}
export function usableContextLimit(info) {
    const ctx0 = info?.limit?.context;
    const inp0 = info?.limit?.input;
    if (typeof ctx0 !== "number" && typeof inp0 !== "number")
        return undefined;
    const raw = (inp0 !== undefined && inp0 > 0 && ctx0 !== undefined && ctx0 > 0) ? Math.min(inp0, ctx0) : (inp0 || ctx0);
    if (typeof raw !== "number" || raw <= 0)
        return undefined;
    const reserve = Math.max(Math.floor(raw * 0.15), raw >= 40000 ? 20000 : 0);
    return Math.max(0, raw - reserve);
}
/**
 * Raw context ceiling (nominal window) for compaction ratio calculation,
 * avoiding compounding double-reserves on models where input limit < context limit.
 */
export function rawContextLimit(info) {
    const ctx0 = info?.limit?.context;
    const inp0 = info?.limit?.input;
    if (typeof ctx0 === "number" && ctx0 > 0)
        return ctx0;
    if (typeof inp0 === "number" && inp0 > 0)
        return inp0;
    return undefined;
}
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
export function dynamicCompactionRatio(limit, baseRatio = DEFAULTS.compactionRatio) {
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0)
        return baseRatio;
    const W_MIN = 32768; // 32k (2^15)
    const W_MAX = 1048576; // 1M (2^20)
    const MAX_RATIO = 0.85;
    const MIN_RATIO = Math.min(baseRatio, MAX_RATIO);
    if (limit <= W_MIN)
        return MAX_RATIO;
    if (limit >= W_MAX)
        return MIN_RATIO;
    const logMin = Math.log2(W_MIN);
    const logMax = Math.log2(W_MAX);
    const logW = Math.log2(limit);
    const factor = (logMax - logW) / (logMax - logMin);
    const ratio = MIN_RATIO + (MAX_RATIO - MIN_RATIO) * factor;
    return Math.round(ratio * 1000) / 1000;
}
export async function initCatalog(ctx) {
    try {
        const res = await ctx?.model?.list?.();
        const data = res?.data ?? res?.models ?? (Array.isArray(res) ? res : []);
        const models = new Set();
        const limits = new Map();
        for (const info of Array.isArray(data) ? data : []) {
            const p = String(info?.providerID ?? "").trim();
            const id = String(info?.id ?? info?.modelID ?? "").trim();
            if (p && id) {
                const full = `${p}/${id}`;
                models.add(full);
                models.add(full.toLowerCase());
                models.add(id);
                models.add(id.toLowerCase());
                const usable = usableContextLimit(info);
                if (typeof usable === "number") {
                    limits.set(full, usable);
                    limits.set(full.toLowerCase(), usable);
                    limits.set(id, usable);
                    limits.set(id.toLowerCase(), usable);
                }
            }
            else if (id) {
                models.add(id);
                models.add(id.toLowerCase());
            }
        }
        if (models.size > 0) {
            knownModelsCache = models;
            modelLimitsCache = limits;
            logLine(`catalog initialized: ${models.size / 2} model variants indexed`);
        }
        // Also index custom providers and models configured in opencode.json
        try {
            const dir = configDir(ctx);
            const opencodeJsonPath = join(dir, "opencode.json");
            if (existsSync(opencodeJsonPath)) {
                const opencodeCfg = parseJsonWithComments(readFileSync(opencodeJsonPath, "utf8"));
                if (opencodeCfg && typeof opencodeCfg === "object" && opencodeCfg.provider) {
                    const mCache = knownModelsCache ?? new Set();
                    const lCache = modelLimitsCache ?? new Map();
                    for (const [pName, pVal] of Object.entries(opencodeCfg.provider)) {
                        const pObj = pVal;
                        if (pObj?.models && typeof pObj.models === "object") {
                            for (const [mName, mVal] of Object.entries(pObj.models)) {
                                const mObj = mVal;
                                const full = `${pName}/${mName}`;
                                mCache.add(full);
                                mCache.add(full.toLowerCase());
                                mCache.add(mName);
                                mCache.add(mName.toLowerCase());
                                const ctxLim = mObj?.limit?.context;
                                if (typeof ctxLim === "number" && ctxLim > 0) {
                                    const usable = Math.max(1, ctxLim - (mObj?.limit?.output ?? 0));
                                    lCache.set(full, usable);
                                    lCache.set(full.toLowerCase(), usable);
                                    lCache.set(mName, usable);
                                    lCache.set(mName.toLowerCase(), usable);
                                }
                            }
                        }
                    }
                    knownModelsCache = mCache;
                    modelLimitsCache = lCache;
                }
            }
        }
        catch (err) {
            logLine(`catalog: indexing opencode.json models failed: ${String(err)}`);
        }
        // Also index all declared fallback targets in fallback.json
        try {
            const fbFile = loadFallbackFile(ctx);
            const fbModels = [];
            if (fbFile?.defaultLargeContextModel)
                fbModels.push(fbFile.defaultLargeContextModel);
            if (fbFile?.defaultFallback) {
                for (const e of fbFile.defaultFallback)
                    fbModels.push(typeof e === "string" ? e : e.model);
            }
            if (fbFile?.defaultLargeContextFallback) {
                for (const e of fbFile.defaultLargeContextFallback)
                    fbModels.push(typeof e === "string" ? e : e.model);
            }
            if (fbFile?.agents) {
                for (const ag of Object.values(fbFile.agents)) {
                    if (ag?.largeContextModel)
                        fbModels.push(ag.largeContextModel);
                    if (ag?.fallback) {
                        for (const e of ag.fallback)
                            fbModels.push(typeof e === "string" ? e : e.model);
                    }
                    if (ag?.largeContextFallback) {
                        for (const e of ag.largeContextFallback)
                            fbModels.push(typeof e === "string" ? e : e.model);
                    }
                }
            }
            if (fbModels.length > 0) {
                const mCache = knownModelsCache ?? new Set();
                for (const m of fbModels) {
                    if (!m || typeof m !== "string")
                        continue;
                    const full = fmtModel(m);
                    mCache.add(full);
                    mCache.add(full.toLowerCase());
                    const slash = full.indexOf("/");
                    if (slash !== -1) {
                        const id = full.slice(slash + 1);
                        mCache.add(id);
                        mCache.add(id.toLowerCase());
                    }
                }
                knownModelsCache = mCache;
            }
        }
        catch (err) {
            logLine(`catalog: indexing fallback.json models failed: ${String(err)}`);
        }
    }
    catch (err) {
        logLine(`catalog initialization failed: ${String(err)}`);
    }
}
export function isModelAvailable(model) {
    if (!model)
        return false;
    const key = fmtModel(model);
    if (!key || key === "unknown" || key === "undefined")
        return false;
    if (!knownModelsCache || knownModelsCache.size === 0)
        return true;
    if (knownModelsCache.has(key) || knownModelsCache.has(key.toLowerCase()))
        return true;
    const slash = key.indexOf("/");
    if (slash !== -1) {
        const id = key.slice(slash + 1);
        if (knownModelsCache.has(id) || knownModelsCache.has(id.toLowerCase()))
            return true;
    }
    return false;
}
export function markModelUnavailable(model) {
    const key = fmtModel(model);
    if (!key)
        return;
    if (knownModelsCache) {
        knownModelsCache.delete(key);
        knownModelsCache.delete(key.toLowerCase());
        const slash = key.indexOf("/");
        if (slash !== -1) {
            const id = key.slice(slash + 1);
            knownModelsCache.delete(id);
            knownModelsCache.delete(id.toLowerCase());
        }
    }
    logLine(`model marked unavailable: ${key}`);
}
export function isModelHealthyNow(model) {
    if (!isModelAvailable(model))
        return false;
    const key = fmtModel(model);
    const blockedUntil = blockedUntilByModel.get(key);
    if (blockedUntil !== undefined && blockedUntil > now())
        return false;
    const b = breakersByModel.get(key);
    if (b?.isOpen)
        return false;
    return true;
}
function fallbackChainFor(ctx, agent, opts) {
    const fbFile = loadFallbackFile(ctx);
    const list = [];
    const sources = [opts, fbFile].filter(Boolean);
    if (agent === "compaction") {
        for (const src of sources) {
            const agentFb = src.agents?.compaction;
            if (agentFb?.largeContextModel)
                list.push(agentFb.largeContextModel);
            if (agentFb?.largeContextFallback)
                list.push(...agentFb.largeContextFallback);
            if (agentFb?.fallback)
                list.push(...agentFb.fallback);
            if (src.defaultLargeContextFallback)
                list.push(...src.defaultLargeContextFallback);
            if (src.largeContextFallback)
                list.push(...src.largeContextFallback);
        }
    }
    else {
        for (const src of sources) {
            const agentFb = agent ? src.agents?.[agent] : undefined;
            if (agentFb?.fallback)
                list.push(...agentFb.fallback);
            if (agentFb?.largeContextFallback)
                list.push(...agentFb.largeContextFallback);
            if (src.defaultFallback)
                list.push(...src.defaultFallback);
            if (src.defaultLargeContextFallback)
                list.push(...src.defaultLargeContextFallback);
        }
    }
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
    const resolvedChain = fallbackChainFor(ctx, agent, opts);
    const chain = resolvedChain.length > 0 ? resolvedChain : (agent === "compaction" ? [] : [HARDCODED_FALLBACK_TARGET]);
    st = {
        sid,
        chain,
        seat: seat ?? undefined,
        tried: new Set(seat ? [seat] : []),
        permFailed: new Set(),
        switched: false,
        stickyUntil: 0,
        rateLimitMs: {},
        rePrompts: 0,
        opts: opts ?? DEFAULTS,
        prompt: undefined,
        promptPending: false,
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
    const targetAgent = agent ?? st.agent;
    const resolvedChain = fallbackChainFor(ctx, targetAgent, st.opts);
    st.chain = resolvedChain.length > 0 ? resolvedChain : (targetAgent === "compaction" ? [] : [HARDCODED_FALLBACK_TARGET]);
    st.tried = new Set();
    st.permFailed = new Set();
    st.switched = false;
    st.lastSwitchedFrom = undefined;
    st.stickyUntil = 0;
    st.preempted = false;
    st.originalSeat = st.seat;
    st.hops = 0;
    st.lastAttempt = -1;
    st.outProviders = new Set();
    st.deadline = now() + (st.opts?.budgets?.fallbackBudgetMs ?? st.opts?.budgetMs ?? DEFAULTS.budgets.fallbackBudgetMs);
}
function nextCandidate(st) {
    for (const m of st.chain) {
        if (st.tried.has(m))
            continue;
        if (st.outProviders?.has?.(providerOf(m)))
            continue;
        if (!isModelHealthyNow(m))
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
/** Rough conversation-size estimate: accumulated context tokens + pending prompt (if not yet in tokens). */
function conversationTokens(st) {
    const text = typeof st?.prompt?.text === "string" ? st.prompt.text : "";
    const ratio = st?.opts?.budgets?.charsPerToken ?? DEFAULTS.budgets.charsPerToken;
    const r = ratio > 0 ? ratio : 4;
    const promptTokens = Math.ceil(text.length / r);
    if (st?.tokens && st.tokens > 0) {
        if (st.promptPending && promptTokens > 0) {
            return st.tokens + promptTokens;
        }
        return st.tokens;
    }
    return promptTokens;
}
function lastTokenCount(msgs) {
    const m = lastAssistantInTurn(msgs);
    const tok = contextTokens(m);
    if (tok > 0)
        return tok;
    for (let i = msgs.length - 1; i >= 0; i--) {
        const t = contextTokens(msgs[i]);
        if (t > 0)
            return t;
    }
    return 0;
}
async function hydrateSessionTokens(ctx, st) {
    if (st.tokens > 0)
        return conversationTokens(st);
    if (!st.sid)
        return conversationTokens(st);
    try {
        const msgs = await readFlatMessages(ctx, st.sid);
        const tok = lastTokenCount(msgs);
        if (tok > 0) {
            st.tokens = tok;
            if (!st.prompt?.text) {
                st.promptPending = false;
            }
        }
    }
    catch { /* best effort */ }
    return conversationTokens(st);
}
/**
 * Context pre-filter (HIGH): can this candidate hold the conversation?
 * Uses usable context limit from the live catalog; unknown limits pass.
 */
async function contextFits(ctx, st, key) {
    const limits = await getModelLimits(ctx);
    const limit = limits.get(key);
    if (limit === undefined)
        return true;
    if (st.tokens === 0) {
        await hydrateSessionTokens(ctx, st);
    }
    const est = conversationTokens(st);
    return est <= limit;
}
export function recordModelFailure(failedKey, c, fbOpts, st) {
    const p = providerOf(failedKey);
    if (c.cls === "transient" || c.cls === "provider_level") {
        let b = breakersByModel.get(failedKey);
        if (!b) {
            const pcfg = st?.opts?.providers?.[p] ?? fbOpts.providers?.[p] ?? fbOpts.providerDefaults ?? DEFAULTS.providerDefaults;
            b = new Breaker(pcfg?.breaker ?? DEFAULTS.providerDefaults.breaker);
            breakersByModel.set(failedKey, b);
        }
        b.recordFailure();
    }
    if (c.cls === "quota") {
        const reset = c.retryAfterMs ?? fbOpts.budgets?.quotaThresholdMs ?? QUOTA_THRESHOLD_MS;
        const until = now() + reset;
        blockedUntilByModel.set(failedKey, until);
        if (st)
            st.rateLimitMs[failedKey] = until;
        saveState();
    }
    else if (c.cls === "transient") {
        const pcfg = st?.opts?.providers?.[p] ?? fbOpts.providers?.[p] ?? fbOpts.providerDefaults ?? DEFAULTS.providerDefaults;
        const dur = c.retryAfterMs ?? pcfg?.rateLimitMs ?? fbOpts.interceptor?.defaultRateLimitMs ?? DEFAULTS.interceptor.defaultRateLimitMs;
        const ms = typeof dur === "number" && Number.isFinite(dur) && dur > 0 ? dur : DEFAULTS.interceptor.defaultRateLimitMs;
        if (st)
            st.rateLimitMs[failedKey] = now() + ms;
    }
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
        if (!isModelHealthyNow(m))
            continue;
        const fits = await contextFits(ctx, st, m);
        if (!fits)
            continue;
        return m;
    }
    return undefined;
}
function isCompactionModel(modelKey, ctx, opts) {
    if (!modelKey)
        return false;
    const norm = fmtModel(modelKey).toLowerCase();
    const candidates = [];
    const fbFile = loadFallbackFile(ctx);
    for (const src of [opts, fbFile]) {
        if (!src)
            continue;
        if (src.agents?.compaction?.largeContextModel)
            candidates.push(src.agents.compaction.largeContextModel);
        if (src.agents?.compaction?.largeContextFallback) {
            for (const f of src.agents.compaction.largeContextFallback) {
                candidates.push(typeof f === "string" ? f : f.model);
            }
        }
        if (src.defaultLargeContextModel)
            candidates.push(src.defaultLargeContextModel);
        if (src.defaultLargeContextFallback) {
            for (const f of src.defaultLargeContextFallback) {
                candidates.push(typeof f === "string" ? f : f.model);
            }
        }
        if (src.largeContextModel)
            candidates.push(src.largeContextModel);
        if (src.largeContextFallback) {
            for (const f of src.largeContextFallback) {
                candidates.push(typeof f === "string" ? f : f.model);
            }
        }
    }
    return candidates.some((c) => c && fmtModel(c).toLowerCase() === norm);
}
export function createFallback(ctx, opts) {
    const fbOpts = resolveOpts(opts ?? loadRoot(ctx));
    setGlobalConsoleLogging(fbOpts.consoleLogging ?? false);
    const log = (msg) => logLine(msg, fbOpts);
    // ── retry hook: classify → sticky / failover / force retry (step 1 + step 2) ──
    const onRetry = async (e) => {
        try {
            const c = classifyError(e?.error);
            const failedKey = fmtModel(e?.model);
            // F3: auxiliary calls (compaction) arrive with agent "compaction", type "compaction",
            // or using the configured compaction model — resolve their own model before entering
            // the retry loop — never switch for them.
            // However, record failures, trip breakers/quotas, reload agents, and abort non-transient retries.
            let isCompaction = e?.agent === "compaction" ||
                e?.type === "compaction" ||
                e?.action === "compaction" ||
                isCompactionModel(failedKey, ctx, fbOpts);
            if (!isCompaction && ctx?.session?.messages && e?.sessionID) {
                try {
                    const msgs = await readFlatMessages(ctx, e.sessionID);
                    const lastMsg = msgs[msgs.length - 1];
                    if (lastMsg?.type === "compaction" || lastMsg?.compaction === true) {
                        isCompaction = true;
                    }
                }
                catch { }
            }
            if (isCompaction) {
                log(`retry ${e.sessionID}: agent=compaction model=${failedKey} -> ${c.cls} (${c.detail})`);
                recordModelFailure(failedKey, c, fbOpts, sessions.get(e.sessionID));
                if (c.cls === "model_not_found")
                    markModelUnavailable(failedKey);
                await Promise.resolve(ctx?.agent?.reload?.()).catch(() => undefined);
            }
            else {
                log(`retry ${e.sessionID}: ${failedKey} attempt=${e?.attempt} -> ${c.cls}${c.detail ? ` (${c.detail})` : ""}${c.retryAfterMs !== undefined ? ` retryAfterMs=${c.retryAfterMs}` : ""}`);
            }
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
                !isCompaction &&
                !!existingSt &&
                (existingSt.hops === 0 || now() < existingSt.deadline) &&
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
            const agentName = isCompaction ? "compaction" : (e?.agent ?? "developer");
            const st = stateFor(ctx, e.sessionID, failedKey, agentName, fbOpts);
            const budget = st.opts?.budgets ?? fbOpts.budgets;
            const budgetMs = budget?.fallbackBudgetMs ?? fbOpts.budgetMs ?? DEFAULTS.budgets.fallbackBudgetMs;
            const maxIters = budget?.maxIterations ?? fbOpts.maxIterations ?? DEFAULTS.budgets.maxIterations;
            // Turn detection (live-test fix): the server's `attempt` counter resets to
            // 0 on every new turn. A non-increasing attempt therefore means a NEW
            // turn started. The `prompt` hook is the primary per-turn reset, but it
            // does not fire for every turn boundary (watchdog re-prompts, server-side
            // turn restarts, resumed sessions). Without this, `st.deadline` stays
            // expired from a previous turn and the wall-clock budget immediately
            // blocks all failover — observed live as "wall-clock budget exhausted"
            // on the very first retry of every new turn.
            const attempt = typeof e?.attempt === "number" ? e.attempt : undefined;
            if (attempt !== undefined && (st.lastAttempt === -1 || attempt <= st.lastAttempt)) {
                if (st.lastAttempt !== -1) {
                    log(`retry ${e.sessionID}: new turn detected (attempt ${attempt} <= ${st.lastAttempt}) — resetting per-turn state`);
                    resetTurnState(st, ctx, st.agent);
                }
            }
            if (attempt !== undefined)
                st.lastAttempt = attempt;
            if (st.switched && st.seat && failedKey !== st.seat && failedKey === st.lastSwitchedFrom) {
                log(`retry ${e.sessionID}: received retry for previously switched model ${failedKey} while seat is ${st.seat} — aborting retry for old model`);
                e.decision = { retry: false };
                return;
            }
            // Fresh failure sequence: if no failover hops have occurred yet (st.hops === 0),
            // ensure the wall-clock deadline starts from THIS failure sequence rather than
            // an expired timestamp from session creation or earlier execution.
            if (st.hops === 0) {
                st.deadline = now() + budgetMs;
            }
            // D1: transient-class failure opens (or holds open) the sticky window; a
            // rate-limit (429) counts as transient when its retryAfterMs fits the
            // sticky window and the attempt budget is not spent. The window is
            // measured from the first transient failure — once it lapses the chain
            // advances (V1 sticky discipline, corrected blueprint §5.2/D1).
            // Compaction calls do not wait in a long sticky window on rate-limited or broken models;
            // they advance immediately down the compaction fallback chain.
            const isTransientClass = c.cls === "transient" && !isCompaction;
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
                    (typeof pcfg?.retryDelayMs === "number" ? pcfg.retryDelayMs : undefined) ??
                    (typeof fbOpts.interceptor?.fastRetryMs === "number" ? fbOpts.interceptor.fastRetryMs : undefined) ??
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
            // P1 #6: a model that just failed is never revisited later in this pass —
            // mark it tried; non-transient failures (quota/auth/forbidden/not-found/
            // context_too_large) are also permanently excluded for this turn.
            st.tried.add(failedKey);
            if (c.cls === "quota" ||
                c.cls === "auth" ||
                c.cls === "forbidden" ||
                c.cls === "model_not_found" ||
                c.cls === "context_too_large") {
                st.permFailed = st.permFailed ?? new Set();
                st.permFailed.add(failedKey);
            }
            if (c.cls === "model_not_found") {
                markModelUnavailable(failedKey);
            }
            // Breaker & quota enforcement: record failure before selecting candidate
            recordModelFailure(failedKey, c, fbOpts, st);
            // P1 #11: auth / forbidden / provider-level failures invalidate the whole
            // provider for this turn's failover walk (a dead credential or sick gateway
            // behind provider A invalidates every sibling fallback on A).
            if (c.cls === "auth" || c.cls === "forbidden" || c.cls === "provider_level") {
                st.outProviders = st.outProviders ?? new Set();
                st.outProviders.add(providerOf(failedKey));
            }
            let next = nextCandidate(st);
            // R4/F2: validate candidate against catalog; skip unavailable models
            while (next && !isModelAvailable(next)) {
                st.chain = st.chain.filter((m) => m !== next);
                st.tried.add(next);
                next = nextCandidate(st);
            }
            // Multi-pass cycling (V1 parity): if the first pass exhausted all
            // candidates via transient failures and budget/hops remain, reset
            // `st.tried` (preserving `st.permFailed`) and start a fresh pass.
            if (!next && st.chain.length > 0) {
                const retryableInChain = st.chain.filter((m) => !st.permFailed?.has(m));
                if (retryableInChain.length > 0) {
                    st.tried = new Set(st.permFailed ?? []);
                    if (retryableInChain.length > 1)
                        st.tried.add(failedKey);
                    next = nextCandidate(st);
                    if (next)
                        log(`retry ${e.sessionID}: starting new pass over fallback chain -> ${next}`);
                }
            }
            if (!next) {
                log(`retry ${e.sessionID}: no fallback candidate left for ${failedKey} — stopping retries`);
                if (c.cls !== "transient") {
                    e.decision = { retry: false };
                }
                return;
            }
            // Context pre-filter (HIGH, requirement: context pre-filter): before
            // spending an attempt on a candidate, rule out models whose context limit
            // cannot hold the conversation. On context overflow, run the catch-all
            // large-context fallback chain instead of the regular fallback list;
            // in-seat self-compaction stays the normal tier.
            const agentLocked = isCompaction ? "compaction" : (st.agent ?? e?.agent ?? "developer");
            let target = next;
            if (c.cls === "context_too_large") {
                target = await pickLargeContext(ctx, st, agentLocked, failedKey);
            }
            else if (!isCompaction) {
                const fits = await contextFits(ctx, st, next);
                if (!fits)
                    target = await pickLargeContext(ctx, st, agentLocked, failedKey);
            }
            if (!target) {
                log(`retry ${e.sessionID}: no fallback candidate left for ${failedKey} — stopping retries`);
                if (c.cls !== "transient") {
                    e.decision = { retry: false };
                }
                return;
            }
            // O6: switchModel may throw (model unavailable / provider unauthenticated);
            // the hook must never propagate — try next candidates if switch fails.
            let switchSucceeded = false;
            while (target && !switchSucceeded) {
                const candidate = target;
                try {
                    await enqueue(e.sessionID, async () => {
                        if (!st.switched)
                            st.originalSeat = st.seat;
                        st.lastSwitchedFrom = failedKey;
                        await ctx?.session?.switchModel({ sessionID: e.sessionID, model: toModelRef(candidate) });
                        st.switched = true;
                        st.tried.add(candidate);
                        st.stickyUntil = 0;
                        st.seat = candidate;
                    });
                    switchSucceeded = true;
                }
                catch (switchErr) {
                    log(`switchModel to ${candidate} failed: ${String(switchErr)} — marking unavailable`);
                    markModelUnavailable(candidate);
                    st.tried.add(candidate);
                    target = undefined;
                    let alt = nextCandidate(st);
                    while (alt && !isModelAvailable(alt)) {
                        st.chain = st.chain.filter((m) => m !== alt);
                        st.tried.add(alt);
                        alt = nextCandidate(st);
                    }
                    if (alt)
                        target = alt;
                }
            }
            if (!switchSucceeded || !target) {
                log(`retry ${e.sessionID}: switchModel failed and no fallback candidate left — keeping default decision`);
                return;
            }
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
            st.promptPending = true;
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
            // P1 #10: proactive context-overflow pre-emption & proactive self-compaction (V1 parity)
            const st = sid ? sessions.get(sid) : undefined;
            if (st && !st.switched && key && key !== "unknown") {
                st.seat = key;
                st.originalSeat = key;
            }
            if (st && st.tokens === 0) {
                await hydrateSessionTokens(ctx, st);
            }
            if (sid && key && key !== "unknown") {
                const rawLimits = await getRawModelLimits(ctx);
                const rawLimit = rawLimits.get(key);
                const limits = await getModelLimits(ctx);
                const limit = limits.get(key);
                const limitForRatio = typeof rawLimit === "number" && rawLimit > 0 ? rawLimit : (typeof limit === "number" && limit > 0 ? limit : 0);
                const curTokens = st ? conversationTokens(st) : 0;
                const baseCompactionRatio = fbOpts.budgets?.compactionRatio ?? fbOpts.compactionRatio ?? DEFAULTS.compactionRatio;
                const compactionRatio = limitForRatio > 0 ? dynamicCompactionRatio(limitForRatio, baseCompactionRatio) : baseCompactionRatio;
                const debounceMs = fbOpts.parentWatchdog?.compactionDebounceMs ?? fbOpts.watchdog?.compactionDebounceMs ?? 120000;
                if (limitForRatio > 0 && curTokens >= limitForRatio * compactionRatio) {
                    const last = lastCompactAt.get(sid) ?? 0;
                    if (now() - last >= debounceMs) {
                        lastCompactAt.set(sid, now());
                        log(`context ${sid}: ${Math.round((curTokens / limitForRatio) * 100)}% of ${key} (${curTokens}/${limitForRatio}) — triggering proactive self-compaction at ${Math.round(compactionRatio * 100)}%`);
                        void Promise.resolve(ctx?.session?.compact?.({ sessionID: sid })).catch((err) => {
                            log(`context ${sid}: proactive self-compaction failed: ${String(err)}`);
                        });
                    }
                }
            }
            if (st && !st.preempted) {
                const limits = await getModelLimits(ctx);
                const limit = limits.get(key);
                const curTokens = conversationTokens(st);
                if (limit !== undefined && curTokens > limit) {
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
                            log(`context ${sid}: ~${curTokens} tokens > ${limit} limit on ${key} — preemptively switched -> ${next}`);
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
            if (st) {
                st.hops = 0;
                st.lastAttempt = -1;
            }
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
    const installAgents = (editor) => {
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
            const existingList = typeof editor?.list === "function" ? editor.list() : [];
            const existingMap = new Map();
            if (Array.isArray(existingList)) {
                for (const ag of existingList) {
                    const id = ag?.id ?? ag?.name;
                    if (id)
                        existingMap.set(id, ag);
                }
            }
            const allIds = [...new Set([...wanted, ...existingMap.keys()])];
            for (const id of allIds) {
                const agentFb = fbFile?.agents?.[id];
                const fallbacks = id === "compaction"
                    ? [
                        ...(agentFb?.largeContextModel ? [agentFb.largeContextModel] : []),
                        ...(agentFb?.largeContextFallback ?? []),
                        ...(fbFile?.defaultLargeContextModel ? [fbFile.defaultLargeContextModel] : []),
                        ...(fbFile?.defaultLargeContextFallback ?? []),
                        ...(agentFb?.fallback ?? []),
                        ...(fbFile?.defaultFallback ?? []),
                    ]
                    : [
                        ...(agentFb?.fallback ?? []),
                        ...(agentFb?.largeContextFallback ?? []),
                        ...(fbFile?.defaultFallback ?? []),
                    ];
                const fallbackCandidates = fallbacks
                    .map((e) => (typeof e === "string" ? e : e.model))
                    .filter((m) => typeof m === "string" && m.length > 0);
                const healthyFallback = fallbackCandidates.find((m) => isModelHealthyNow(m)) ??
                    fallbackCandidates.find((m) => isModelAvailable(m)) ??
                    pickDefaultAvailableModel();
                const existing = existingMap.get(id) ?? (typeof editor?.get === "function" ? editor.get(id) : undefined);
                const existingObj = existing && typeof existing === "object" ? existing : undefined;
                const currentModelKey = existingObj?.model ? fmtModel(existingObj.model) : undefined;
                const currentModelHealthy = currentModelKey ? isModelHealthyNow(currentModelKey) : false;
                // Guard: if operator configured an agent with an available, working model, leave it alone.
                if (existingObj && currentModelKey && currentModelHealthy) {
                    continue;
                }
                if (existingObj && currentModelKey && !currentModelHealthy) {
                    log(`agent '${id}' model '${currentModelKey}' is unhealthy/unavailable — replacing with healthy fallback '${healthyFallback}'`);
                }
                const agent = {
                    name: id,
                    description: existingObj?.description ?? `Fallback agent registered by opencode-subagent-fallback (${id})`,
                    mode: id === "compaction" ? "primary" : (existingObj?.mode ?? "subagent"),
                    model: toModelRef(healthyFallback),
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
                    d.model = agent.model;
                    return d;
                });
            }
        }
        catch (err) {
            log(`agent transform failed: ${String(err)}`);
        }
    };
    // ── tool hook: execute.before for subagent / task model inheritance ─────────
    const onToolExecuteBefore = async (e) => {
        try {
            const toolName = String(e?.tool ?? "").toLowerCase();
            if (toolName !== "subagent" && toolName !== "task")
                return;
            const input = e?.input;
            if (!input || typeof input !== "object")
                return;
            const targetAgentId = String(input.agent ?? "").trim();
            const fbFile = loadFallbackFile(ctx);
            // 1. If caller explicitly passed an unavailable model, remove it
            if (input.model) {
                const mKey = fmtModel(input.model);
                if (!isModelAvailable(mKey)) {
                    log(`subagent tool called with unavailable model ${mKey} — removing`);
                    delete input.model;
                }
            }
            // 2. OpenCode resolution order: ee = Z ?? X.model ?? F.model
            // If input.model (Z) is not set:
            // If parent has a healthy model, setting input.model ensures the subagent
            // respects the model selected by the parent agent!
            let parentModelKey;
            const parentSt = e?.sessionID ? sessions.get(e.sessionID) : undefined;
            if (parentSt?.seat && parentSt.seat !== "unknown") {
                parentModelKey = parentSt.seat;
            }
            else if (parentSt?.originalSeat && parentSt.originalSeat !== "unknown") {
                parentModelKey = parentSt.originalSeat;
            }
            else if (e?.sessionID && typeof ctx?.session?.get === "function") {
                try {
                    const sess = await ctx.session.get({ sessionID: e.sessionID });
                    if (sess?.model)
                        parentModelKey = fmtModel(sess.model);
                }
                catch { /* best effort */ }
            }
            const parentHealthy = parentModelKey ? isModelHealthyNow(parentModelKey) : false;
            // Find first healthy fallback model for the agent
            const agentFb = targetAgentId ? fbFile?.agents?.[targetAgentId] : undefined;
            const fallbacks = [
                ...(agentFb?.fallback ?? []),
                ...(agentFb?.largeContextFallback ?? []),
                ...(fbFile?.defaultFallback ?? []),
            ];
            const healthyFallback = fallbacks
                .map((item) => (typeof item === "string" ? item : item.model))
                .find((m) => m && isModelHealthyNow(m)) ?? pickDefaultAvailableModel();
            if (!input.model) {
                const chosenModel = parentHealthy && parentModelKey ? parentModelKey : healthyFallback;
                input.model = toModelRef(chosenModel);
                log(`subagent tool: assigned model ${chosenModel} to '${targetAgentId}' (parent: ${parentModelKey ?? "none"}, parentHealthy: ${parentHealthy})`);
            }
        }
        catch (err) {
            log(`tool execute.before hook error: ${String(err)}`);
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
        initCatalog: async (ctxIn) => initCatalog(ctxIn ?? ctx),
        onRetry,
        onPrompt,
        onContext,
        onIdle,
        installTools,
        installAgents,
        onToolExecuteBefore,
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
        isModelAvailable,
        markModelUnavailable,
        isModelHealthyNow,
        recordModelFailure,
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
    const t = m?.tokens ?? m?.info?.tokens;
    if (!t)
        return 0;
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
export function isToolRefusal(text) {
    if (!text)
        return false;
    const lower = text.toLowerCase();
    const mentionsUnavailability = lower.includes("not available in this") ||
        lower.includes("do not have access to") ||
        lower.includes("cannot directly run") ||
        lower.includes("tools are not available") ||
        lower.includes("tools are unavailable") ||
        lower.includes("no access to tools");
    const mentionsTools = lower.includes("tool") ||
        lower.includes("shell") ||
        lower.includes("subagent") ||
        lower.includes("execute") ||
        lower.includes("filesystem");
    return mentionsUnavailability && mentionsTools;
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
    const refusal = !toolParts && isToolRefusal(text ?? "");
    const ok = m.time?.completed != null &&
        m.error == null &&
        !busy &&
        !refusal &&
        m.finish !== "length" &&
        m.finish !== "error" &&
        ((text ?? "").trim().length > 0 || toolParts || trailingIdleSucceeded);
    return { ok, finish: m.finish, text, tokens: contextTokens(m), error: m.error, ...(refusal ? { reason: "tool-refusal" } : {}) };
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
                if (st) {
                    st.tokens = tok;
                    st.promptPending = false;
                }
                else {
                    const s = stateFor(ctx, sid);
                    s.tokens = tok;
                    s.promptPending = false;
                }
                if (sid) {
                    const seat = sessions.get(sid)?.seat;
                    if (seat && seat !== "unknown") {
                        const rawLimits = rawModelLimitsCache;
                        const rawLimit = rawLimits?.get(seat);
                        const limits = modelLimitsCache;
                        const limit = limits?.get(seat);
                        const limitForRatio = typeof rawLimit === "number" && rawLimit > 0 ? rawLimit : (typeof limit === "number" && limit > 0 ? limit : 0);
                        const baseCompactionRatio = opts.budgets?.compactionRatio ?? opts.compactionRatio ?? DEFAULTS.compactionRatio;
                        const compactionRatio = limitForRatio > 0 ? dynamicCompactionRatio(limitForRatio, baseCompactionRatio) : baseCompactionRatio;
                        const debounceMs = opts.parentWatchdog?.compactionDebounceMs ?? opts.watchdog?.compactionDebounceMs ?? 120000;
                        if (limitForRatio > 0 && tok >= limitForRatio * compactionRatio) {
                            const last = lastCompactAt.get(sid) ?? 0;
                            if (now() - last >= debounceMs) {
                                lastCompactAt.set(sid, now());
                                logLine(`event ${sid}: ${Math.round((tok / limitForRatio) * 100)}% of ${seat} (${tok}/${limitForRatio}) — triggering proactive self-compaction at ${Math.round(compactionRatio * 100)}%`, opts);
                                void Promise.resolve(ctx?.session?.compact?.({ sessionID: sid })).catch((err) => {
                                    logLine(`event ${sid}: proactive self-compaction failed: ${String(err)}`, opts);
                                });
                            }
                        }
                    }
                }
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
let globalConsoleLogging = false;
export function setGlobalConsoleLogging(enabled) {
    globalConsoleLogging = enabled;
}
function logLine(msg, optsOrBool) {
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
    // Console output suppression (Silent Resilience):
    // Suppressed by default (consoleLogging: false) to prevent parent orchestrators from misinterpreting
    // intermediate failover signals (429, 503, breaker trips) as fatal job failures.
    // Full diagnostics remain persistently available in fallback.log on disk.
    const isSilent = process.env.OPENCODE_FALLBACK_SILENT === "1";
    const consoleConfig = typeof optsOrBool === "boolean"
        ? optsOrBool
        : (optsOrBool?.consoleLogging ?? globalConsoleLogging);
    const allowConsole = !isSilent && (consoleConfig === true || process.env.OPENCODE_FALLBACK_CONSOLE === "1");
    if (allowConsole) {
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
        logLine(`watchdog ${sid}: ${seenFirstToken ? "stall" : "first-token"} timeout (${silence}ms >= ${limit}ms) — interrupting`, opts);
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
        const rawMap = new Map();
        for (const info of Array.isArray(data) ? data : []) {
            const full = `${info?.providerID}/${info?.id}`;
            const usable = usableContextLimit(info);
            const raw = rawContextLimit(info);
            if (typeof usable === "number") {
                m.set(full, usable);
                m.set(full.toLowerCase(), usable);
                if (info.id) {
                    m.set(info.id, usable);
                    m.set(info.id.toLowerCase(), usable);
                }
            }
            if (typeof raw === "number") {
                rawMap.set(full, raw);
                rawMap.set(full.toLowerCase(), raw);
                if (info.id) {
                    rawMap.set(info.id, raw);
                    rawMap.set(info.id.toLowerCase(), raw);
                }
            }
        }
        rawModelLimitsCache = rawMap;
        return m;
    }
    catch {
        return new Map();
    }
}
async function getModelLimits(ctx) {
    if (!modelLimitsCache)
        modelLimitsCache = await loadModelLimits(ctx);
    return modelLimitsCache;
}
async function getRawModelLimits(ctx) {
    if (!rawModelLimitsCache) {
        await getModelLimits(ctx);
    }
    return rawModelLimitsCache ?? new Map();
}
// ── Redaction + telemetry helper ─────────────────────────────────────────────
function redact(s) {
    return s.replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]").replace(/bearer\s+[A-Za-z0-9._-]+/gi, "bearer [REDACTED]");
}
export const __redactForTests = redact;
export const __runSweepForTests = runSweep;
