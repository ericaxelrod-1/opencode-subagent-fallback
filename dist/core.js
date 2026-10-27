import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { readFileSync, statSync } from "fs";
import { join, resolve, isAbsolute } from "path";
import { pathToFileURL } from "url";
import { homedir } from "os";
// ── Module state (in-process; nothing survives a restart, by design) ────────
let ROOT = { ...DEFAULTS(), providers: {} };
/** Test seam: loadRoot is the production path; the self-test sets ROOT directly. */
export function __setRootForTests(cfg) {
    ROOT = { ...DEFAULTS(), providers: ROOT.providers, ...cfg };
}
/** Test seam: loadModelLimits is the production path (client.config.get). */
export function __setModelLimitsForTests(limits) {
    for (const [k, v] of Object.entries(limits))
        modelLimits.set(k, v);
}
/** Test seam: clear all in-process state between cases. */
export function __resetStateForTests() {
    breakers.clear();
    blockedUntil.clear();
    anchors.clear();
    modelLimits.clear();
    fallbackCache.clear();
}
const breakers = new Map();
const blockedUntil = new Map();
const modelLimits = new Map();
/** sessionID → last model that completed a turn. */
const anchors = new Map();
const fallbackCache = new Map();
const liveness = new Map();
/** sessionID → when WE aborted it, so the attempt can tell ours from theirs. */
const abortStampedAt = new Map();
function registerLiveness(sid, l) {
    liveness.set(sid, l);
}
function unregisterLiveness(sid) {
    liveness.delete(sid);
}
function stampAlive(sid) {
    const l = liveness.get(sid);
    if (l)
        l.lastPartAt = now();
}
/** True (consuming the stamp) when the last abort of this session was ours. */
function consumeOurAbort(sid) {
    const t = abortStampedAt.get(sid);
    if (t === undefined)
        return false;
    abortStampedAt.delete(sid);
    return true;
}
/**
 * Liveness stamping, independent of the parent watchdog: child attempts
 * register for the sweep whether or not parentWatchdog is enabled, so these
 * events must always be observed.
 */
function handleLivenessEvent(ev) {
    if (ev?.type !== "message.part.updated")
        return;
    const sid = ev?.properties?.part?.sessionID;
    if (sid)
        stampAlive(sid);
}
/**
 * Abort every session silent past its clock. Parents re-prompt via onStall;
 * children just get aborted and their attempt classifies it as ours.
 */
function startLivenessSweep(client) {
    setInterval(() => {
        const t = now();
        for (const [sid, l] of [...liveness]) {
            const seenFirstToken = l.lastPartAt > l.startedAt;
            const silence = t - (seenFirstToken ? l.lastPartAt : l.startedAt);
            const limit = seenFirstToken ? l.stallTimeoutMs : l.firstTokenMs;
            if (silence < limit)
                continue;
            logLine(`liveness ${sid}: silent ${Math.round(silence / 1000)}s (limit ${Math.round(limit / 1000)}s) — aborting`);
            abortStampedAt.set(sid, t);
            try {
                void client.session.abort({ path: { id: sid } });
            }
            catch { }
            l.startedAt = t;
            l.lastPartAt = t;
            l.onStall?.(sid);
        }
    }, 5000);
}
function DEFAULTS() {
    return {
        budgetMs: 600000,
        maxIterations: 10,
        compactionRatio: 0.5,
        parentWatchdog: { enabled: false },
        providers: {},
    };
}
const DEFAULT_PROVIDER = {
    firstTokenMs: 30000,
    stallTimeoutMs: 90000,
    retryDelayMs: 10000,
    skipDelayMs: 0,
    stickyMs: 180000,
    maxTimeMs: 300000,
    timeoutMs: 180000,
    breaker: { threshold: 3, cooldownMs: 60000, maxCooldownMs: 600000 },
};
// ── Small utilities ─────────────────────────────────────────────────────────
const now = () => Date.now();
function sleep(ms) {
    return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}
function providerOf(model) {
    const i = model.indexOf("/");
    return i === -1 ? "" : model.slice(0, i);
}
function splitModel(model) {
    const i = model.indexOf("/");
    return i === -1 ? ["", model] : [model.slice(0, i), model.slice(i + 1)];
}
function providerCfg(model) {
    return ROOT.providers[providerOf(model)] ?? DEFAULT_PROVIDER;
}
function breakerFor(model) {
    let b = breakers.get(model);
    if (!b) {
        b = new Breaker(providerCfg(model).breaker);
        breakers.set(model, b);
    }
    return b;
}
function anchorFor(sessionID) {
    return sessionID ? anchors.get(sessionID) : undefined;
}
function setAnchor(sessionID, model) {
    if (sessionID)
        anchors.set(sessionID, model);
}
// ── Circuit breaker ─────────────────────────────────────────────────────────
class Breaker {
    cfg;
    failures = 0;
    trips = 0;
    openUntil = 0;
    constructor(cfg) {
        this.cfg = cfg;
    }
    get isOpen() {
        return this.openUntil > now();
    }
    recordFailure() {
        this.failures++;
        if (this.failures < (this.cfg.threshold ?? 1))
            return;
        this.trips++;
        const wait = Math.min(this.cfg.maxCooldownMs ?? this.cfg.cooldownMs, this.cfg.cooldownMs * 2 ** Math.max(0, this.trips - 1));
        this.openUntil = now() + wait;
    }
    recordSuccess() {
        this.failures = 0;
        this.trips = 0;
        this.openUntil = 0;
    }
}
// ── Config loading ──────────────────────────────────────────────────────────
function configDir(directory) {
    // fallback.json is NOT core opencode config — it lives beside opencode.json
    // in the user's config directory. TODO(ticket): project-level override.
    if (process.env.OPENCODE_CONFIG_DIR)
        return process.env.OPENCODE_CONFIG_DIR;
    return join(homedir(), ".config", "opencode");
}
function loadRoot(directory) {
    const cfg = DEFAULTS();
    const dir = configDir(directory);
    try {
        const raw = JSON.parse(readFileSync(join(dir, "fallback.json"), "utf8"));
        if (typeof raw.fallbackBudgetMs === "number")
            cfg.budgetMs = raw.fallbackBudgetMs;
        if (typeof raw.maxIterations === "number")
            cfg.maxIterations = raw.maxIterations;
        if (typeof raw.compactionRatio === "number")
            cfg.compactionRatio = raw.compactionRatio;
        if (raw.parentWatchdog && typeof raw.parentWatchdog === "object") {
            cfg.parentWatchdog = {
                enabled: raw.parentWatchdog.enabled === true,
                firstTokenMs: raw.parentWatchdog.firstTokenMs,
                stallTimeoutMs: raw.parentWatchdog.stallTimeoutMs,
            };
        }
        for (const [k, v] of Object.entries(raw.providers ?? {})) {
            cfg.providers[k] = mergeProvider(v);
        }
    }
    catch {
        /* no fallback.json: defaults only */
    }
    return cfg;
}
function mergeProvider(raw) {
    const p = { ...DEFAULT_PROVIDER, breaker: { ...DEFAULT_PROVIDER.breaker } };
    if (!raw || typeof raw !== "object")
        return p;
    for (const k of ["firstTokenMs", "stallTimeoutMs", "retryDelayMs", "skipDelayMs", "stickyMs", "maxTimeMs", "timeoutMs"]) {
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
function loadFallback(directory) {
    const cached = fallbackCache.get(directory);
    if (cached)
        return cached;
    try {
        const parsed = JSON.parse(readFileSync(join(configDir(directory), "fallback.json"), "utf8"));
        fallbackCache.set(directory, parsed);
        return parsed;
    }
    catch {
        return {};
    }
}
// ── Model limits (pre-filter, Option B) ─────────────────────────────────────
async function loadModelLimits(client) {
    try {
        const res = await client.config.get({ throwOnError: true });
        const providers = res?.data?.provider ?? res?.data?.providers ?? {};
        for (const p of Object.values(providers)) {
            for (const [id, m] of Object.entries(p?.models ?? {})) {
                if (typeof m?.limit?.context === "number" && p?.id)
                    modelLimits.set(`${p.id}/${id}`, m.limit.context);
            }
        }
    }
    catch {
        /* no catalog access: pre-filter empty, catch-all compaction is the guard */
    }
}
// Rough token estimate. Deliberately crude (4 chars/token): it only decides
// whether a model is a candidate, not exact accounting.
export function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}
// ── Error classification ────────────────────────────────────────────────────
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
        return Math.max(0, date - now());
    return undefined;
}
/** Error emitted when OUR watchdog aborted an attempt, so the classifier can
 *  tell it apart from a provider-side abort and never bench for it. */
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
const QUOTA_THRESHOLD_MS = 600000; // 10 min: beyond this a rate limit is a quota, not a blip
export function classifyError(err) {
    if (!err)
        return { cls: "fatal", detail: "unknown error" };
    if (isOurs(err))
        return { cls: "transient", detail: String(err?.message ?? "watchdog abort"), ours: true };
    const d = err?.data ?? err;
    const status = typeof d?.statusCode === "number" ? d.statusCode : typeof d?.status === "number" ? d.status : undefined;
    const name = d?.name ?? "";
    const msg = String(d?.message ?? "").toLowerCase();
    const retryAfterMs = headerRetryAfter(d?.responseHeaders);
    if (name === "ProviderAuthError" || status === 401)
        return { cls: "auth", detail: "auth" };
    if (status === 403)
        return { cls: "forbidden", detail: "forbidden" };
    if (status === 404 || msg.includes("model not found"))
        return { cls: "model_not_found", detail: "not found" };
    if (status === 413 ||
        msg.includes("context length") ||
        msg.includes("maximum context") ||
        msg.includes("context_length_exceeded") ||
        msg.includes("too many tokens") ||
        msg.includes("request too large")) {
        return { cls: "context_too_large", detail: "context too large" };
    }
    if (name === "MessageOutputLengthError" || msg.includes("finish_reason 'length'") || msg.includes("empty completion")) {
        // Model behavior for THIS request, not provider health — exempt from
        // benching (streak-bounded at the walk), but it still fails over.
        return { cls: "transient", detail: "truncated/empty completion" };
    }
    const is429 = status === 429 || msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests");
    const quotaWords = msg.includes("daily") || msg.includes("quota") || msg.includes("insufficient_quota") || msg.includes("used up");
    const longReset = retryAfterMs !== undefined && retryAfterMs > QUOTA_THRESHOLD_MS;
    if (is429) {
        if (quotaWords || longReset)
            return { cls: "quota", retryAfterMs, detail: "quota" };
        return { cls: "transient", retryAfterMs, detail: "rate limited" };
    }
    if (status !== undefined && status >= 500)
        return { cls: "provider_level", detail: "5xx" };
    if (msg.includes("503") ||
        msg.includes("502") ||
        msg.includes("unavailable") ||
        msg.includes("bad gateway") ||
        msg.includes("econnreset") ||
        msg.includes("fetch failed") ||
        msg.includes("socket hang up")) {
        return { cls: "provider_level", detail: "transport" };
    }
    if (msg.includes("timeout") || msg.includes("timed out"))
        return { cls: "transient", detail: "timeout" };
    if (status === 400)
        return { cls: "transient", detail: "provider 400" };
    if (typeof d?.isRetryable === "boolean" && d.isRetryable)
        return { cls: "transient", retryAfterMs, detail: "retryable" };
    return { cls: "fatal", detail: String(d?.message ?? "fatal").slice(0, 200) };
}
// ── Completeness gate ───────────────────────────────────────────────────────
// Grounded in real SDK fields — no heuristics on text shape.
export function checkCompletion(res) {
    const info = res?.info ?? {};
    const parts = res?.parts ?? [];
    const finished = info?.time?.completed != null && info?.error == null;
    const finish = info?.finish;
    const toolsPending = parts.some((p) => p?.type === "tool" && p?.state && (p.state.status === "running" || p.state.status === "pending"));
    const text = parts
        .filter((p) => p?.type === "text")
        .map((p) => p?.text ?? "")
        .join("\n");
    const ok = finished && !toolsPending && finish !== "length" && finish !== "error" && text.trim().length > 0;
    return { ok, finish, text };
}
// ── Attempt trail ───────────────────────────────────────────────────────────
function formatTrail(trail) {
    if (trail.length === 0)
        return "(none)";
    const shown = trail.slice(-10);
    const extra = trail.length - shown.length;
    const body = shown.map((t) => `${t.model} ${t.cls}=${t.ms}ms${t.detail ? ` msg=${t.detail.slice(0, 100)}` : ""}`).join("; ");
    return extra > 0 ? `${body}; +${extra} more` : body;
}
/** Exported for the self-test. */
export async function walkChain(input) {
    const log = input.log ?? (() => { });
    // Pre-filter (Option B): rule out any model whose context window cannot hold
    // this conversation before spending an attempt on it. Honours the
    // small→large chain discipline from data rather than manual ordering.
    const est = input.estimateTokens;
    const candidates = est === undefined
        ? [...input.chain]
        : input.chain.filter((m) => {
            const limit = modelLimits.get(m);
            const fits = limit === undefined || est <= limit;
            if (!fits)
                log(`${m}: context ${limit} < ~${est} est — pre-filtered`);
            return fits;
        });
    if (candidates.length === 0) {
        return { ok: false, trail: [], reason: `no candidate model fits ~${est} tokens` };
    }
    const deadline = now() + ROOT.budgetMs;
    const trail = [];
    let soonestResetMs;
    // Anchor first: the session keeps using the model that last served it.
    const anchor = anchorFor(input.sessionKey);
    const ordered = [];
    if (anchor && candidates.includes(anchor))
        ordered.push(anchor);
    for (const m of candidates)
        if (m !== anchor)
            ordered.push(m);
    // Request-scoped exclusions.
    const outModels = new Set();
    const outProviders = new Set();
    // Per-model transient stickiness + streak counting.
    const transientSince = new Map();
    const transientStreak = new Map();
    for (let pass = 0; pass < ROOT.maxIterations; pass++) {
        if (now() >= deadline)
            break;
        for (const model of ordered) {
            if (now() >= deadline)
                break;
            if (outModels.has(model) || outProviders.has(providerOf(model)))
                continue;
            const pcfg = providerCfg(model);
            const b = breakerFor(model);
            if (b.isOpen) {
                log(`${model}: breaker open — skipping`);
                continue;
            }
            const bt = blockedUntil.get(model);
            if (bt !== undefined && bt > now()) {
                log(`${model}: quota (~${Math.round((bt - now()) / 1000)}s left) — skipping`);
                if (soonestResetMs === undefined || bt < soonestResetMs)
                    soonestResetMs = bt;
                continue;
            }
            let providerSpent = 0;
            // Sticky loop: one transient model is retried on itself inside its
            // sticky window; once the window lapses (or a hard/quota failure lands)
            // the chain advances.
            for (;;) {
                if (now() >= deadline)
                    break;
                if (b.isOpen)
                    break;
                const bt2 = blockedUntil.get(model);
                if (bt2 !== undefined && bt2 > now())
                    break;
                if (providerSpent >= pcfg.maxTimeMs) {
                    log(`${model}: per-pass time cap (${pcfg.maxTimeMs}ms) — deferring to next pass`);
                    break;
                }
                const started = now();
                let res;
                try {
                    res = await input.attempt(model);
                }
                catch (err) {
                    res = { ok: false, error: err };
                }
                const elapsed = now() - started;
                providerSpent += elapsed;
                if (res.ok) {
                    b.recordSuccess();
                    transientSince.delete(model);
                    transientStreak.delete(model);
                    setAnchor(input.sessionKey, model);
                    trail.push({ model, cls: "ok", ms: elapsed });
                    return { ok: true, model, result: res, trail };
                }
                const c = classifyError(res.error);
                trail.push({ model, cls: c.cls, ms: elapsed, detail: c.detail });
                log(`${model}: ${c.cls}${c.detail ? ` (${c.detail})` : ""} after ${elapsed}ms`);
                // Aborts we cause: evidence about nothing, but they cost time.
                if (c.ours) {
                    transientSince.set(model, now());
                    await sleep(pcfg.retryDelayMs);
                    continue;
                }
                if (c.cls === "transient") {
                    const streak = (transientStreak.get(model) ?? 0) + 1;
                    transientStreak.set(model, streak);
                    // Streak-bounded exemption: below 3, no bench — truncation is model
                    // behavior for this request, not provider health.
                    if (streak >= 3)
                        b.recordFailure();
                    const since = transientSince.get(model);
                    const firstTransient = since === undefined;
                    const windowElapsed = firstTransient ? 0 : now() - since;
                    if (firstTransient)
                        transientSince.set(model, now());
                    if (c.retryAfterMs !== undefined && c.retryAfterMs > QUOTA_THRESHOLD_MS) {
                        blockedUntil.set(model, now() + c.retryAfterMs);
                        if (soonestResetMs === undefined || now() + c.retryAfterMs < soonestResetMs)
                            soonestResetMs = now() + c.retryAfterMs;
                        log(`${model}: quota reset ~${Math.round(c.retryAfterMs / 1000)}s — advancing`);
                        break;
                    }
                    // Sticky: keep preferring this model while its window holds.
                    if (windowElapsed < pcfg.stickyMs) {
                        await sleep(pcfg.retryDelayMs);
                        continue;
                    }
                    log(`${model}: transient window (${pcfg.stickyMs}ms) lapsed — advancing`);
                    await sleep(pcfg.skipDelayMs);
                    break;
                }
                if (c.cls === "quota") {
                    const reset = c.retryAfterMs ?? QUOTA_THRESHOLD_MS;
                    blockedUntil.set(model, now() + reset);
                    if (soonestResetMs === undefined || now() + reset < soonestResetMs)
                        soonestResetMs = now() + reset;
                    log(`${model}: quota — fast skip, reset ~${Math.round(reset / 1000)}s`);
                    await sleep(pcfg.skipDelayMs);
                    break;
                }
                if (c.cls === "provider_level") {
                    // Provider-level failure is provider health: bench the model AND skip
                    // the whole provider for this request so sibling models of a sick
                    // gateway don't each burn a hop.
                    b.recordFailure();
                    outProviders.add(providerOf(model));
                    log(`provider ${providerOf(model)}: level failure — skipping provider for this request`);
                    await sleep(pcfg.skipDelayMs);
                    break;
                }
                // A fatal error says nothing about the other candidates — but it does
                // say this request is malformed, so walking the rest of the chain
                // burns attempts on a request that will fail identically everywhere.
                if (c.cls === "fatal") {
                    log(`${model}: fatal — stopping the walk`);
                    return { ok: false, trail, reason: `fatal on ${model}: ${c.detail}` };
                }
                // auth / forbidden / not found / context: rule out the model for this
                // request. Context gets the catch-all compaction.
                outModels.add(model);
                if (c.cls === "context_too_large" && input.onOverflow) {
                    log(`${model}: context too large — catch-all compaction`);
                    try {
                        await input.onOverflow(model);
                    }
                    catch { }
                }
                break;
            }
        }
    }
    const reason = soonestResetMs
        ? `all candidates unavailable; soonest reset ~${Math.round(Math.max(0, soonestResetMs - now()) / 1000)}s`
        : "all candidates failed or were ruled out for this request";
    return { ok: false, trail, reason, soonestResetMs };
}
// ── @file resolution (kept from the task tool spec) ─────────────────────────
const FILE_REGEX = /(?<![\w`])@(\.?[^\s`,.]*(?:\.[^\s`,.]+)*)/g;
function resolvePromptParts(template, worktree) {
    const parts = [{ type: "text", text: template }];
    const seen = new Set();
    for (const match of template.matchAll(FILE_REGEX)) {
        const name = match[1];
        if (!name || seen.has(name))
            continue;
        seen.add(name);
        const filepath = name.startsWith("~/")
            ? join(homedir(), name.slice(2))
            : isAbsolute(name)
                ? name
                : resolve(worktree, name);
        try {
            const st = statSync(filepath);
            parts.push({
                type: "file",
                url: pathToFileURL(filepath).href,
                filename: name,
                mime: st.isDirectory() ? "application/x-directory" : "text/plain",
            });
        }
        catch {
            /* not a file (may be an agent name): leave it literal */
        }
    }
    return parts;
}
// ── Parent watchdog ─────────────────────────────────────────────────────────
function logLine(msg) {
    console.error(`[subagent-fallback] ${msg}`);
}
function setupParentWatchdog(client, directory) {
    // Re-prompt bookkeeping. After an abort we re-issue the captured user parts
    // on the next healthy model. A re-prompt duplicates the user turn in the
    // transcript — accepted; a frozen user turn is worse.
    const turns = new Map();
    // First healthy model in the chain that isn't the one that just stalled.
    const nextHealthy = (chain, exclude) => {
        const t = now();
        return chain.find((m) => {
            if (m === exclude)
                return false;
            const b = breakerFor(m);
            const bt = blockedUntil.get(m);
            return !b.isOpen && (bt === undefined || bt <= t);
        });
    };
    const reprompt = async (sid) => {
        const st = turns.get(sid);
        if (!st)
            return;
        if (st.rePrompts >= ROOT.maxIterations) {
            logLine(`parent ${sid}: ${st.rePrompts} consecutive stalls — giving up`);
            turns.delete(sid);
            return;
        }
        const stalled = anchorFor(sid) ?? st.chain[0];
        const next = nextHealthy(st.chain, stalled);
        if (!next || st.parts.length === 0) {
            logLine(`parent ${sid}: no healthy model to re-prompt on`);
            turns.delete(sid);
            return;
        }
        st.rePrompts += 1;
        logLine(`parent ${sid}: re-prompting on ${next} (attempt ${st.rePrompts})`);
        const [providerID, modelID] = splitModel(next);
        const pcfg = providerCfg(next);
        const entry = liveness.get(sid);
        if (entry) {
            entry.startedAt = now();
            entry.lastPartAt = now();
            entry.firstTokenMs = ROOT.parentWatchdog.firstTokenMs ?? pcfg.firstTokenMs;
            entry.stallTimeoutMs = ROOT.parentWatchdog.stallTimeoutMs ?? pcfg.stallTimeoutMs;
        }
        try {
            await client.session.prompt({
                path: { id: sid },
                body: { agent: st.agent, model: { providerID, modelID }, parts: st.parts },
            });
        }
        catch (e) {
            logLine(`parent ${sid}: re-prompt failed: ${e?.message ?? e}`);
        }
    };
    // Compaction bookkeeping: never self-compact the same session twice inside
    // the debounce window (each summarize costs a full turn).
    const lastCompactAt = new Map();
    const onEvent = (ev) => {
        const type = ev?.type;
        // Liveness stamping is unconditional: child attempts register for the sweep
        // even when the parent watchdog is off, and they need these events.
        if (type === "message.part.updated") {
            const sid = ev?.properties?.part?.sessionID;
            if (sid)
                stampAlive(sid);
            return;
        }
        if (!ROOT.parentWatchdog.enabled)
            return;
        if (type === "message.updated") {
            const info = ev?.properties?.info;
            const sid = info?.sessionID;
            if (sid)
                stampAlive(sid);
            // Proactive self-compaction: the model in the seat summarizes its OWN
            // session at compactionRatio. Never delegates compaction to another
            // model — that is the "primary forgets" failure we refuse.
            const model = `${info?.providerID}/${info?.modelID}`;
            const limit = modelLimits.get(model);
            const used = info?.tokens?.input;
            if (!sid || limit === undefined || used === undefined)
                return;
            if (used < limit * ROOT.compactionRatio)
                return;
            const last = lastCompactAt.get(sid) ?? 0;
            if (now() - last < 120000)
                return; // debounce: 2 min
            lastCompactAt.set(sid, now());
            const [providerID, modelID] = splitModel(model);
            logLine(`parent ${sid}: ${Math.round((used / limit) * 100)}% of ${model} — self-compacting at ${ROOT.compactionRatio * 100}%`);
            void (async () => {
                try {
                    await client.session.summarize({ path: { id: sid }, body: { providerID, modelID } });
                }
                catch (e) {
                    logLine(`parent ${sid}: self-compaction failed: ${e?.message ?? e}`);
                }
            })();
            return;
        }
        if (type === "session.error") {
            const sid = ev?.properties?.sessionID;
            if (!sid || !turns.has(sid))
                return;
            const c = classifyError(ev?.properties?.error);
            logLine(`parent ${sid}: ${c.cls}${c.detail ? ` (${c.detail})` : ""}`);
            const failed = anchorFor(sid);
            if (failed && (c.cls === "quota" || c.cls === "transient" || c.cls === "provider_level") && !c.ours) {
                breakerFor(failed).recordFailure();
            }
        }
    };
    const onChatMessage = async (input, output) => {
        const sid = input?.sessionID;
        const agent = input?.agent ?? output?.message?.agent ?? "";
        const current = output?.message?.model;
        if (!sid || !current?.providerID || !current?.modelID)
            return;
        const currentModel = `${current.providerID}/${current.modelID}`;
        const fb = loadFallback(directory);
        const agentFb = fb.agents?.[agent];
        const chain = [currentModel];
        for (const e of agentFb?.fallback ?? fb.defaultFallback ?? [])
            chain.push(typeof e === "string" ? e : e.model);
        turns.set(sid, { chain: [...new Set(chain)], parts: output?.parts ?? [], agent, rePrompts: 0 });
        const pcfg = providerCfg(currentModel);
        registerLiveness(sid, {
            startedAt: now(),
            lastPartAt: now(),
            firstTokenMs: ROOT.parentWatchdog.firstTokenMs ?? pcfg.firstTokenMs,
            stallTimeoutMs: ROOT.parentWatchdog.stallTimeoutMs ?? pcfg.stallTimeoutMs,
            onStall: (s) => void reprompt(s),
        });
        // Steering: keep the anchor unless it is blocked or its breaker is open.
        const anchor = anchorFor(sid);
        const pick = chain.includes(anchor ?? "") ? anchor : currentModel;
        const b = breakerFor(pick);
        const bt = blockedUntil.get(pick);
        const healthy = !b.isOpen && (bt === undefined || bt <= now());
        if (!healthy) {
            const next = nextHealthy(chain, pick);
            if (next && next !== currentModel) {
                const [providerID, modelID] = splitModel(next);
                output.message.model = { providerID, modelID };
                logLine(`parent ${sid}: steering ${currentModel} → ${next} (anchor unhealthy)`);
            }
        }
    };
    return { onEvent, onChatMessage };
}
// ── Plugin ──────────────────────────────────────────────────────────────────
const plugin = async (input) => {
    const { client, directory } = input;
    ROOT = loadRoot(directory);
    void loadModelLimits(client);
    // One sweep for both halves: child attempts stall on the same clocks.
    startLivenessSweep(client);
    const smartTask = tool({
        description: "Delegate a task to a subagent with automatic model fallback. Walks the fallback chain " +
            "with a circuit breaker, a wall-clock budget and a completeness gate; if the primary model " +
            "is rate-limited or stalls, retries fallback models. Returns the first complete result — " +
            "transparent to the caller.",
        args: {
            description: z.string().describe("A short (3-5 words) description of the task"),
            prompt: z.string().describe("The task for the agent to perform"),
            subagent_type: z.string().describe("The type of specialized agent to use"),
            task_id: z.string().optional().describe("Resume a previous task by ID"),
        },
        execute: async (args, context) => {
            const { description, prompt, subagent_type, task_id } = args;
            let cfg = null;
            try {
                cfg = (await client.config.get({ throwOnError: true }))?.data;
            }
            catch { }
            const agentConfig = cfg?.agent?.[subagent_type];
            if (!agentConfig) {
                return { title: description, output: `Unknown agent type: ${subagent_type}`, metadata: { error: true } };
            }
            const fb = loadFallback(directory);
            const agentFb = fb.agents?.[subagent_type];
            const chainRaw = [];
            if (agentConfig.model)
                chainRaw.push(agentConfig.model);
            for (const e of agentFb?.fallback ?? fb.defaultFallback ?? [])
                chainRaw.push(typeof e === "string" ? e : e.model);
            const chain = [...new Set(chainRaw)];
            if (chain.length === 0) {
                return { title: description, output: `No models configured for agent ${subagent_type}`, metadata: { error: true } };
            }
            let sessionId;
            try {
                if (task_id) {
                    const msgs = await client.session.messages({ path: { id: task_id }, throwOnError: true }).catch(() => null);
                    const hasWork = (msgs?.data ?? []).some((m) => m?.info?.role === "assistant");
                    if (hasWork) {
                        sessionId = task_id;
                    }
                    else {
                        const created = await client.session.create({
                            body: { parentID: context.sessionID, title: `${description} (@${subagent_type} subagent)` },
                            throwOnError: true,
                        });
                        sessionId = created.data.id;
                    }
                }
                else {
                    const created = await client.session.create({
                        body: { parentID: context.sessionID, title: `${description} (@${subagent_type} subagent)` },
                        throwOnError: true,
                    });
                    sessionId = created.data.id;
                }
            }
            catch (e) {
                return { title: description, output: `Failed to create session: ${e?.message ?? e}`, metadata: { error: true } };
            }
            const onOverflow = async (model) => {
                // Catch-all only: compaction model for oversized context.
                const compactModel = agentFb?.largeContextModel ?? model;
                try {
                    const [providerID, modelID] = splitModel(compactModel);
                    await client.session.summarize({ path: { id: sessionId }, body: { providerID, modelID } });
                }
                catch { }
            };
            const outcome = await walkChain({
                chain,
                sessionKey: sessionId,
                estimateTokens: estimateTokens(prompt),
                log: logLine,
                onOverflow,
                attempt: async (model) => {
                    const sdkParts = resolvePromptParts(prompt, context.worktree).map((p) => p.type === "file" ? { type: "file", url: p.url, filename: p.filename, mime: p.mime } : { type: "text", text: p.text });
                    const [providerID, modelID] = splitModel(model);
                    const pcfg = providerCfg(model);
                    // The child attempt registers for liveness so a stalled child is
                    // aborted on the same two clocks the parent uses.
                    registerLiveness(sessionId, {
                        startedAt: now(),
                        lastPartAt: now(),
                        firstTokenMs: pcfg.firstTokenMs,
                        stallTimeoutMs: pcfg.stallTimeoutMs,
                    });
                    try {
                        const res = await client.session.prompt({
                            path: { id: sessionId },
                            body: { model: { providerID, modelID }, agent: subagent_type, parts: sdkParts },
                        });
                        if (res?.error)
                            return { ok: false, error: res.error };
                        // An abort we stamped during the sweep is ours, not the provider's.
                        if (consumeOurAbort(sessionId)) {
                            return { ok: false, error: new WatchdogAbort() };
                        }
                        const completion = checkCompletion(res.data);
                        if (!completion.ok) {
                            // Truncated / never finished: fail over rather than return a
                            // partial answer the parent would mistake for a real one.
                            return { ok: false, error: new Error(`incomplete response (finish=${completion.finish ?? "unset"})`) };
                        }
                        return { ok: true, completion: { finish: completion.finish, text: completion.text } };
                    }
                    catch (err) {
                        if (consumeOurAbort(sessionId))
                            return { ok: false, error: new WatchdogAbort() };
                        return { ok: false, error: err };
                    }
                    finally {
                        unregisterLiveness(sessionId);
                    }
                },
            });
            const trail = formatTrail(outcome.trail);
            if (outcome.ok) {
                const text = outcome.result?.completion?.text ?? "";
                const trailBlock = outcome.trail.length > 1 ? `\n<fallback_trail>${trail}</fallback_trail>` : "";
                return {
                    title: description,
                    output: `<task id="${sessionId}" state="completed">\n<task_result>\n${text}\n</task_result>\n</task>${trailBlock}`,
                    metadata: { sessionId, model: outcome.model, trail: outcome.trail },
                };
            }
            return {
                title: description,
                output: `<task id="${sessionId}" state="error">\n<task_error>${outcome.reason}</task_error>\n</task>\n<fallback_trail>${trail}</fallback_trail>`,
                metadata: { sessionId, failed: true, trail: outcome.trail },
            };
        },
    });
    const hooks = { tool: { smart_task: smartTask } };
    // Liveness needs events whether or not the parent watchdog is on.
    // hooks.event disabled for test
    if (ROOT.parentWatchdog.enabled) {
        const wd = setupParentWatchdog(client, directory);
        // The watchdog's superset handler already stamps liveness first.
        hooks.event = async ({ event }) => wd.onEvent(event);
        hooks["chat.message"] = async (input, output) => wd.onChatMessage(input, output);
    }
    return hooks;
};
export default plugin;
