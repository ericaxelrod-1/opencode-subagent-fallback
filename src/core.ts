import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { readFileSync, statSync } from "fs"
import { join, resolve, isAbsolute } from "path"
import { pathToFileURL } from "url"
import { homedir } from "os"

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

// ── Types ───────────────────────────────────────────────────────────────────

interface BreakerConfig {
  threshold: number
  cooldownMs: number
  maxCooldownMs?: number
}

interface ProviderConfig {
  firstTokenMs: number
  stallTimeoutMs: number
  retryDelayMs: number
  skipDelayMs: number
  stickyMs: number
  maxTimeMs: number
  timeoutMs: number
  breaker: BreakerConfig
}

interface RootConfig {
  budgetMs: number
  maxIterations: number
  compactionRatio: number
  parentWatchdog: { enabled: boolean; firstTokenMs?: number; stallTimeoutMs?: number }
  providers: Record<string, ProviderConfig>
}

interface FallbackEntry {
  model: string
  temperature?: number
  reasoningEffort?: string
  thinking?: { type: string; budgetTokens: number }
}

interface AgentFallback {
  largeContextModel?: string
  minContextRatio?: number
  largeContextFallback?: (FallbackEntry | string)[]
  fallback: (FallbackEntry | string)[]
}

interface FallbackFile {
  enabled?: boolean
  agents?: Record<string, AgentFallback>
  defaultFallback?: string[]
}

type FailClass =
  | "transient"
  | "quota"
  | "context_too_large"
  | "auth"
  | "forbidden"
  | "model_not_found"
  | "provider_level"
  | "fatal"

interface Classified {
  cls: FailClass
  retryAfterMs?: number
  detail: string
  /** An abort WE initiated (watchdog/timer) — never a provider-health signal. */
  ours?: boolean
}

interface AttemptResult {
  ok: boolean
  completion?: { finish?: string; text: string }
  error?: any
}

interface TrailEntry {
  model: string
  cls: FailClass | "ok" | "aborted"
  ms: number
  detail?: string
}

interface WalkOutcome {
  ok: boolean
  model?: string
  result?: AttemptResult
  trail: TrailEntry[]
  reason?: string
  soonestResetMs?: number
}

// ── Module state (in-process; nothing survives a restart, by design) ────────

let ROOT: RootConfig = { ...DEFAULTS(), providers: {} }

/** Test seam: loadRoot is the production path; the self-test sets ROOT directly. */
export function __setRootForTests(cfg: Partial<RootConfig>): void {
  ROOT = { ...DEFAULTS(), providers: ROOT.providers, ...cfg }
}

/** Test seam: loadModelLimits is the production path (client.config.get). */
export function __setModelLimitsForTests(limits: Record<string, number>): void {
  for (const [k, v] of Object.entries(limits)) modelLimits.set(k, v)
}

/** Test seam: clear all in-process state between cases. */
export function __resetStateForTests(): void {
  breakers.clear()
  blockedUntil.clear()
  anchors.clear()
  modelLimits.clear()
  fallbackCache.clear()
}
const breakers = new Map<string, Breaker>()
const blockedUntil = new Map<string, number>()
const modelLimits = new Map<string, number>()
/** sessionID → last model that completed a turn. */
const anchors = new Map<string, string>()
const fallbackCache = new Map<string, FallbackFile>()

// ── Liveness (shared by both halves) ───────────────────────────────────────
// One registry, one sweep. A session registers before an attempt and
// deregisters after. The event stream stamps lastPartAt; the sweep aborts a
// session that has been silent past its clock. Timers are per-session because
// a 1M-context model legitimately prefills for minutes while a small model
// answers instantly — one global timeout cannot serve both.

interface Liveness {
  startedAt: number
  lastPartAt: number
  firstTokenMs: number
  stallTimeoutMs: number
  /** Optional extra action when the sweep aborts (parent re-prompt). */
  onStall?: (sid: string) => void
}

const liveness = new Map<string, Liveness>()
/** sessionID → when WE aborted it, so the attempt can tell ours from theirs. */
const abortStampedAt = new Map<string, number>()

function registerLiveness(sid: string, l: Liveness): void {
  liveness.set(sid, l)
}

function unregisterLiveness(sid: string): void {
  liveness.delete(sid)
}

function stampAlive(sid: string): void {
  const l = liveness.get(sid)
  if (l) l.lastPartAt = now()
}

/** True (consuming the stamp) when the last abort of this session was ours. */
function consumeOurAbort(sid: string): boolean {
  const t = abortStampedAt.get(sid)
  if (t === undefined) return false
  abortStampedAt.delete(sid)
  return true
}

/**
 * Liveness stamping, independent of the parent watchdog: child attempts
 * register for the sweep whether or not parentWatchdog is enabled, so these
 * events must always be observed.
 */
function handleLivenessEvent(ev: any): void {
  if (ev?.type !== "message.part.updated") return
  const sid: string | undefined = ev?.properties?.part?.sessionID
  if (sid) stampAlive(sid)
}

/**
 * Abort every session silent past its clock. Parents re-prompt via onStall;
 * children just get aborted and their attempt classifies it as ours.
 */
function startLivenessSweep(client: any): void {
  setInterval(() => {
    const t = now()
    for (const [sid, l] of [...liveness]) {
      const seenFirstToken = l.lastPartAt > l.startedAt
      const silence = t - (seenFirstToken ? l.lastPartAt : l.startedAt)
      const limit = seenFirstToken ? l.stallTimeoutMs : l.firstTokenMs
      if (silence < limit) continue
      logLine(`liveness ${sid}: silent ${Math.round(silence / 1000)}s (limit ${Math.round(limit / 1000)}s) — aborting`)
      abortStampedAt.set(sid, t)
      try {
        void client.session.abort({ path: { id: sid } })
      } catch {}
      l.startedAt = t
      l.lastPartAt = t
      l.onStall?.(sid)
    }
  }, 5000)
}

function DEFAULTS(): RootConfig {
  return {
    budgetMs: 600000,
    maxIterations: 10,
    compactionRatio: 0.5,
    parentWatchdog: { enabled: false },
    providers: {},
  }
}

const DEFAULT_PROVIDER: ProviderConfig = {
  firstTokenMs: 30000,
  stallTimeoutMs: 90000,
  retryDelayMs: 10000,
  skipDelayMs: 0,
  stickyMs: 180000,
  maxTimeMs: 300000,
  timeoutMs: 180000,
  breaker: { threshold: 3, cooldownMs: 60000, maxCooldownMs: 600000 },
}

// ── Small utilities ─────────────────────────────────────────────────────────

const now = () => Date.now()

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve()
}

function providerOf(model: string): string {
  const i = model.indexOf("/")
  return i === -1 ? "" : model.slice(0, i)
}

function splitModel(model: string): [string, string] {
  const i = model.indexOf("/")
  return i === -1 ? ["", model] : [model.slice(0, i), model.slice(i + 1)]
}

function providerCfg(model: string): ProviderConfig {
  return ROOT.providers[providerOf(model)] ?? DEFAULT_PROVIDER
}

function breakerFor(model: string): Breaker {
  let b = breakers.get(model)
  if (!b) {
    b = new Breaker(providerCfg(model).breaker)
    breakers.set(model, b)
  }
  return b
}

function anchorFor(sessionID?: string): string | undefined {
  return sessionID ? anchors.get(sessionID) : undefined
}

function setAnchor(sessionID: string | undefined, model: string): void {
  if (sessionID) anchors.set(sessionID, model)
}

// ── Circuit breaker ─────────────────────────────────────────────────────────

class Breaker {
  failures = 0
  trips = 0
  openUntil = 0
  constructor(private cfg: BreakerConfig) {}
  get isOpen(): boolean {
    return this.openUntil > now()
  }
  recordFailure(): void {
    this.failures++
    if (this.failures < (this.cfg.threshold ?? 1)) return
    this.trips++
    const wait = Math.min(this.cfg.maxCooldownMs ?? this.cfg.cooldownMs, this.cfg.cooldownMs * 2 ** Math.max(0, this.trips - 1))
    this.openUntil = now() + wait
  }
  recordSuccess(): void {
    this.failures = 0
    this.trips = 0
    this.openUntil = 0
  }
}

// ── Config loading ──────────────────────────────────────────────────────────

function configDir(directory: string): string {
  // fallback.json is NOT core opencode config — it lives beside opencode.json
  // in the user's config directory. TODO(ticket): project-level override.
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
  return join(homedir(), ".config", "opencode")
}

function loadRoot(directory: string): RootConfig {
  const cfg = DEFAULTS()
  const dir = configDir(directory)
  try {
    const raw = JSON.parse(readFileSync(join(dir, "fallback.json"), "utf8"))
    if (typeof raw.fallbackBudgetMs === "number") cfg.budgetMs = raw.fallbackBudgetMs
    if (typeof raw.maxIterations === "number") cfg.maxIterations = raw.maxIterations
    if (typeof raw.compactionRatio === "number") cfg.compactionRatio = raw.compactionRatio
    if (raw.parentWatchdog && typeof raw.parentWatchdog === "object") {
      cfg.parentWatchdog = {
        enabled: raw.parentWatchdog.enabled === true,
        firstTokenMs: raw.parentWatchdog.firstTokenMs,
        stallTimeoutMs: raw.parentWatchdog.stallTimeoutMs,
      }
    }
    for (const [k, v] of Object.entries<any>(raw.providers ?? {})) {
      cfg.providers[k] = mergeProvider(v)
    }
  } catch {
    /* no fallback.json: defaults only */
  }
  return cfg
}

function mergeProvider(raw: any): ProviderConfig {
  const p: ProviderConfig = { ...DEFAULT_PROVIDER, breaker: { ...DEFAULT_PROVIDER.breaker } }
  if (!raw || typeof raw !== "object") return p
  for (const k of ["firstTokenMs", "stallTimeoutMs", "retryDelayMs", "skipDelayMs", "stickyMs", "maxTimeMs", "timeoutMs"] as const) {
    if (typeof raw[k] === "number" && Number.isFinite(raw[k])) p[k] = raw[k]
  }
  const b = raw.breaker ?? {}
  if (typeof b.threshold === "number") p.breaker.threshold = b.threshold
  if (typeof b.cooldownMs === "number") p.breaker.cooldownMs = b.cooldownMs
  if (typeof b.maxCooldownMs === "number") p.breaker.maxCooldownMs = b.maxCooldownMs
  return p
}

function loadFallback(directory: string): FallbackFile {
  const cached = fallbackCache.get(directory)
  if (cached) return cached
  try {
    const parsed = JSON.parse(readFileSync(join(configDir(directory), "fallback.json"), "utf8"))
    fallbackCache.set(directory, parsed)
    return parsed
  } catch {
    return {}
  }
}

// ── Model limits (pre-filter, Option B) ─────────────────────────────────────

async function loadModelLimits(client: any): Promise<void> {
  try {
    const res = await client.config.get({ throwOnError: true })
    const providers = res?.data?.provider ?? res?.data?.providers ?? {}
    for (const p of Object.values<any>(providers)) {
      for (const [id, m] of Object.entries<any>(p?.models ?? {})) {
        if (typeof m?.limit?.context === "number" && p?.id) modelLimits.set(`${p.id}/${id}`, m.limit.context)
      }
    }
  } catch {
    /* no catalog access: pre-filter empty, catch-all compaction is the guard */
  }
}

// Rough token estimate. Deliberately crude (4 chars/token): it only decides
// whether a model is a candidate, not exact accounting.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// ── Error classification ────────────────────────────────────────────────────

function headerRetryAfter(headers: Record<string, string> | undefined): number | undefined {
  if (!headers) return undefined
  const raw = headers["retry-after"] ?? headers["Retry-After"] ?? headers["x-ratelimit-reset"]
  if (!raw) return undefined
  const secs = Number(raw)
  if (Number.isFinite(secs) && secs > 0) return secs * 1000
  const date = Date.parse(raw)
  if (Number.isFinite(date)) return Math.max(0, date - now())
  return undefined
}

/** Error emitted when OUR watchdog aborted an attempt, so the classifier can
 *  tell it apart from a provider-side abort and never bench for it. */
export const WatchdogAbort: any = function (message = "aborted by watchdog") {
  const e = new Error(message)
  e.name = "WatchdogAbort"
  return e
}

function isOurs(err: any): boolean {
  const n = err?.name ?? ""
  const m = String(err?.message ?? "").toLowerCase()
  return n === "WatchdogAbort" || m === "first-token timeout" || m === "stream stall" || m === "attempt timeout"
}

const QUOTA_THRESHOLD_MS = 600000 // 10 min: beyond this a rate limit is a quota, not a blip

export function classifyError(err: any): Classified {
  if (!err) return { cls: "fatal", detail: "unknown error" }
  if (isOurs(err)) return { cls: "transient", detail: String(err?.message ?? "watchdog abort"), ours: true }

  const d = err?.data ?? err
  const status: number | undefined = typeof d?.statusCode === "number" ? d.statusCode : typeof d?.status === "number" ? d.status : undefined
  const name: string = d?.name ?? ""
  const msg = String(d?.message ?? "").toLowerCase()
  const retryAfterMs = headerRetryAfter(d?.responseHeaders)

  if (name === "ProviderAuthError" || status === 401) return { cls: "auth", detail: "auth" }
  if (status === 403) return { cls: "forbidden", detail: "forbidden" }
  if (status === 404 || msg.includes("model not found")) return { cls: "model_not_found", detail: "not found" }

  if (
    status === 413 ||
    msg.includes("context length") ||
    msg.includes("maximum context") ||
    msg.includes("context_length_exceeded") ||
    msg.includes("too many tokens") ||
    msg.includes("request too large")
  ) {
    return { cls: "context_too_large", detail: "context too large" }
  }

  if (name === "MessageOutputLengthError" || msg.includes("finish_reason 'length'") || msg.includes("empty completion")) {
    // Model behavior for THIS request, not provider health — exempt from
    // benching (streak-bounded at the walk), but it still fails over.
    return { cls: "transient", detail: "truncated/empty completion" }
  }

  const is429 = status === 429 || msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests")
  const quotaWords = msg.includes("daily") || msg.includes("quota") || msg.includes("insufficient_quota") || msg.includes("used up")
  const longReset = retryAfterMs !== undefined && retryAfterMs > QUOTA_THRESHOLD_MS

  if (is429) {
    if (quotaWords || longReset) return { cls: "quota", retryAfterMs, detail: "quota" }
    return { cls: "transient", retryAfterMs, detail: "rate limited" }
  }

  if (status !== undefined && status >= 500) return { cls: "provider_level", detail: "5xx" }
  if (
    msg.includes("503") ||
    msg.includes("502") ||
    msg.includes("unavailable") ||
    msg.includes("bad gateway") ||
    msg.includes("econnreset") ||
    msg.includes("fetch failed") ||
    msg.includes("socket hang up")
  ) {
    return { cls: "provider_level", detail: "transport" }
  }

  if (msg.includes("timeout") || msg.includes("timed out")) return { cls: "transient", detail: "timeout" }
  if (status === 400) return { cls: "transient", detail: "provider 400" }
  if (typeof d?.isRetryable === "boolean" && d.isRetryable) return { cls: "transient", retryAfterMs, detail: "retryable" }

  return { cls: "fatal", detail: String(d?.message ?? "fatal").slice(0, 200) }
}

// ── Completeness gate ───────────────────────────────────────────────────────
// Grounded in real SDK fields — no heuristics on text shape.

export function checkCompletion(res: any): { ok: boolean; finish?: string; text: string } {
  const info = res?.info ?? {}
  const parts: any[] = res?.parts ?? []
  const finished = info?.time?.completed != null && info?.error == null
  const finish: string | undefined = info?.finish
  const toolsPending = parts.some((p: any) => p?.type === "tool" && p?.state && (p.state.status === "running" || p.state.status === "pending"))
  const text: string = parts
    .filter((p: any) => p?.type === "text")
    .map((p: any) => p?.text ?? "")
    .join("\n")

  const ok = finished && !toolsPending && finish !== "length" && finish !== "error" && text.trim().length > 0
  return { ok, finish, text }
}

// ── Attempt trail ───────────────────────────────────────────────────────────

function formatTrail(trail: TrailEntry[]): string {
  if (trail.length === 0) return "(none)"
  const shown = trail.slice(-10)
  const extra = trail.length - shown.length
  const body = shown.map((t) => `${t.model} ${t.cls}=${t.ms}ms${t.detail ? ` msg=${t.detail.slice(0, 100)}` : ""}`).join("; ")
  return extra > 0 ? `${body}; +${extra} more` : body
}

// ── The walk ────────────────────────────────────────────────────────────────

interface WalkInput {
  chain: string[]
  sessionKey?: string
  /** Approximate conversation size in tokens, for the context pre-filter. */
  estimateTokens?: number
  attempt: (model: string) => Promise<AttemptResult>
  onOverflow?: (model: string) => Promise<void>
  log?: (m: string) => void
}

/** Exported for the self-test. */
export async function walkChain(input: WalkInput): Promise<WalkOutcome> {
  const log = input.log ?? (() => {})

  // Pre-filter (Option B): rule out any model whose context window cannot hold
  // this conversation before spending an attempt on it. Honours the
  // small→large chain discipline from data rather than manual ordering.
  const est = input.estimateTokens
  const candidates = est === undefined
    ? [...input.chain]
    : input.chain.filter((m) => {
        const limit = modelLimits.get(m)
        const fits = limit === undefined || est <= limit
        if (!fits) log(`${m}: context ${limit} < ~${est} est — pre-filtered`)
        return fits
      })
  if (candidates.length === 0) {
    return { ok: false, trail: [], reason: `no candidate model fits ~${est} tokens` }
  }

  const deadline = now() + ROOT.budgetMs
  const trail: TrailEntry[] = []
  let soonestResetMs: number | undefined

  // Anchor first: the session keeps using the model that last served it.
  const anchor = anchorFor(input.sessionKey)
  const ordered: string[] = []
  if (anchor && candidates.includes(anchor)) ordered.push(anchor)
  for (const m of candidates) if (m !== anchor) ordered.push(m)

  // Request-scoped exclusions.
  const outModels = new Set<string>()
  const outProviders = new Set<string>()

  // Per-model transient stickiness + streak counting.
  const transientSince = new Map<string, number>()
  const transientStreak = new Map<string, number>()

  for (let pass = 0; pass < ROOT.maxIterations; pass++) {
    if (now() >= deadline) break

    for (const model of ordered) {
      if (now() >= deadline) break
      if (outModels.has(model) || outProviders.has(providerOf(model))) continue

      const pcfg = providerCfg(model)
      const b = breakerFor(model)

      if (b.isOpen) {
        log(`${model}: breaker open — skipping`)
        continue
      }
      const bt = blockedUntil.get(model)
      if (bt !== undefined && bt > now()) {
        log(`${model}: quota (~${Math.round((bt - now()) / 1000)}s left) — skipping`)
        if (soonestResetMs === undefined || bt < soonestResetMs) soonestResetMs = bt
        continue
      }

      let providerSpent = 0

      // Sticky loop: one transient model is retried on itself inside its
      // sticky window; once the window lapses (or a hard/quota failure lands)
      // the chain advances.
      for (;;) {
        if (now() >= deadline) break
        if (b.isOpen) break
        const bt2 = blockedUntil.get(model)
        if (bt2 !== undefined && bt2 > now()) break
        if (providerSpent >= pcfg.maxTimeMs) {
          log(`${model}: per-pass time cap (${pcfg.maxTimeMs}ms) — deferring to next pass`)
          break
        }

        const started = now()
        let res: AttemptResult
        try {
          res = await input.attempt(model)
        } catch (err) {
          res = { ok: false, error: err }
        }
        const elapsed = now() - started
        providerSpent += elapsed

        if (res.ok) {
          b.recordSuccess()
          transientSince.delete(model)
          transientStreak.delete(model)
          setAnchor(input.sessionKey, model)
          trail.push({ model, cls: "ok", ms: elapsed })
          return { ok: true, model, result: res, trail }
        }

        const c = classifyError(res.error)
        trail.push({ model, cls: c.cls, ms: elapsed, detail: c.detail })
        log(`${model}: ${c.cls}${c.detail ? ` (${c.detail})` : ""} after ${elapsed}ms`)

        // Aborts we cause: evidence about nothing, but they cost time.
        if (c.ours) {
          transientSince.set(model, now())
          await sleep(pcfg.retryDelayMs)
          continue
        }

        if (c.cls === "transient") {
          const streak = (transientStreak.get(model) ?? 0) + 1
          transientStreak.set(model, streak)
          // Streak-bounded exemption: below 3, no bench — truncation is model
          // behavior for this request, not provider health.
          if (streak >= 3) b.recordFailure()

          const since = transientSince.get(model)
          const firstTransient = since === undefined
          const windowElapsed = firstTransient ? 0 : now() - (since as number)
          if (firstTransient) transientSince.set(model, now())

          if (c.retryAfterMs !== undefined && c.retryAfterMs > QUOTA_THRESHOLD_MS) {
            blockedUntil.set(model, now() + c.retryAfterMs)
            if (soonestResetMs === undefined || now() + c.retryAfterMs < soonestResetMs) soonestResetMs = now() + c.retryAfterMs
            log(`${model}: quota reset ~${Math.round(c.retryAfterMs / 1000)}s — advancing`)
            break
          }

          // Sticky: keep preferring this model while its window holds.
          if (windowElapsed < pcfg.stickyMs) {
            await sleep(pcfg.retryDelayMs)
            continue
          }
          log(`${model}: transient window (${pcfg.stickyMs}ms) lapsed — advancing`)
          await sleep(pcfg.skipDelayMs)
          break
        }

        if (c.cls === "quota") {
          const reset = c.retryAfterMs ?? QUOTA_THRESHOLD_MS
          blockedUntil.set(model, now() + reset)
          if (soonestResetMs === undefined || now() + reset < soonestResetMs) soonestResetMs = now() + reset
          log(`${model}: quota — fast skip, reset ~${Math.round(reset / 1000)}s`)
          await sleep(pcfg.skipDelayMs)
          break
        }

        if (c.cls === "provider_level") {
          // Provider-level failure is provider health: bench the model AND skip
          // the whole provider for this request so sibling models of a sick
          // gateway don't each burn a hop.
          b.recordFailure()
          outProviders.add(providerOf(model))
          log(`provider ${providerOf(model)}: level failure — skipping provider for this request`)
          await sleep(pcfg.skipDelayMs)
          break
        }

        // A fatal error says nothing about the other candidates — but it does
        // say this request is malformed, so walking the rest of the chain
        // burns attempts on a request that will fail identically everywhere.
        if (c.cls === "fatal") {
          log(`${model}: fatal — stopping the walk`)
          return { ok: false, trail, reason: `fatal on ${model}: ${c.detail}` }
        }

        // auth / forbidden / not found / context: rule out the model for this
        // request. Context gets the catch-all compaction.
        outModels.add(model)
        if (c.cls === "context_too_large" && input.onOverflow) {
          log(`${model}: context too large — catch-all compaction`)
          try {
            await input.onOverflow(model)
          } catch {}
        }
        break
      }
    }
  }

  const reason = soonestResetMs
    ? `all candidates unavailable; soonest reset ~${Math.round(Math.max(0, soonestResetMs - now()) / 1000)}s`
    : "all candidates failed or were ruled out for this request"
  return { ok: false, trail, reason, soonestResetMs }
}

// ── @file resolution (kept from the task tool spec) ─────────────────────────

const FILE_REGEX = /(?<![\w`])@(\.?[^\s`,.]*(?:\.[^\s`,.]+)*)/g

interface ResolvedPart {
  type: "text" | "file"
  text?: string
  url?: string
  filename?: string
  mime?: string
}

function resolvePromptParts(template: string, worktree: string): ResolvedPart[] {
  const parts: ResolvedPart[] = [{ type: "text", text: template }]
  const seen = new Set<string>()
  for (const match of template.matchAll(FILE_REGEX)) {
    const name = match[1]
    if (!name || seen.has(name)) continue
    seen.add(name)
    const filepath = name.startsWith("~/")
      ? join(homedir(), name.slice(2))
      : isAbsolute(name)
        ? name
        : resolve(worktree, name)
    try {
      const st = statSync(filepath)
      parts.push({
        type: "file",
        url: pathToFileURL(filepath).href,
        filename: name,
        mime: st.isDirectory() ? "application/x-directory" : "text/plain",
      })
    } catch {
      /* not a file (may be an agent name): leave it literal */
    }
  }
  return parts
}

// ── Parent watchdog ─────────────────────────────────────────────────────────

function logLine(msg: string): void {
  console.error(`[subagent-fallback] ${msg}`)
}

function setupParentWatchdog(client: any, directory: string): {
  onEvent: (event: any) => void
  onChatMessage: (input: any, output: any) => Promise<void>
} {
  // Re-prompt bookkeeping. After an abort we re-issue the captured user parts
  // on the next healthy model. A re-prompt duplicates the user turn in the
  // transcript — accepted; a frozen user turn is worse.
  const turns = new Map<string, { chain: string[]; parts: any[]; agent: string; rePrompts: number }>()

  // First healthy model in the chain that isn't the one that just stalled.
  const nextHealthy = (chain: string[], exclude: string): string | undefined => {
    const t = now()
    return chain.find((m) => {
      if (m === exclude) return false
      const b = breakerFor(m)
      const bt = blockedUntil.get(m)
      return !b.isOpen && (bt === undefined || bt <= t)
    })
  }

  const reprompt = async (sid: string): Promise<void> => {
    const st = turns.get(sid)
    if (!st) return
    if (st.rePrompts >= ROOT.maxIterations) {
      logLine(`parent ${sid}: ${st.rePrompts} consecutive stalls — giving up`)
      turns.delete(sid)
      return
    }
    const stalled = anchorFor(sid) ?? st.chain[0]
    const next = nextHealthy(st.chain, stalled)
    // If parts are empty (chat.message didn't capture them), try fetching
    // from the session before giving up.
    if (st.parts.length === 0) {
      try {
        const msgs: any = await client.session.messages({ path: { id: sid }, throwOnError: true }).catch(() => null)
        const userMsgs = (msgs?.data ?? []).filter((m: any) => m?.info?.role === "user")
        const lastUserMsg = userMsgs[userMsgs.length - 1]
        if (lastUserMsg?.parts?.length) {
          st.parts = lastUserMsg.parts
          logLine(`parent ${sid}: recovered ${st.parts.length} parts from session messages`)
        }
      } catch {}
    }
    if (!next || st.parts.length === 0) {
      logLine(`parent ${sid}: no healthy model to re-prompt on (next=${next ?? "none"}, parts=${st.parts.length})`)
      turns.delete(sid)
      return
    }
    st.rePrompts += 1
    logLine(`parent ${sid}: re-prompting on ${next} (attempt ${st.rePrompts})`)
    const [providerID, modelID] = splitModel(next)
    const pcfg = providerCfg(next)
    const entry = liveness.get(sid)
    if (entry) {
      entry.startedAt = now()
      entry.lastPartAt = now()
      entry.firstTokenMs = ROOT.parentWatchdog.firstTokenMs ?? pcfg.firstTokenMs
      entry.stallTimeoutMs = ROOT.parentWatchdog.stallTimeoutMs ?? pcfg.stallTimeoutMs
    }
    try {
      await client.session.prompt({
        path: { id: sid },
        body: { agent: st.agent, model: { providerID, modelID }, parts: st.parts },
      })
    } catch (e: any) {
      logLine(`parent ${sid}: re-prompt failed: ${e?.message ?? e}`)
    }
  }

  // Compaction bookkeeping: never self-compact the same session twice inside
  // the debounce window (each summarize costs a full turn).
  const lastCompactAt = new Map<string, number>()

  const onEvent = async (ev: any) => {
    const type = ev?.type
    // Liveness stamping is unconditional: child attempts register for the sweep
    // even when the parent watchdog is off, and they need these events.
    if (type === "message.part.updated") {
      const sid: string | undefined = ev?.properties?.part?.sessionID
      if (sid) stampAlive(sid)
      return
    }
    if (!ROOT.parentWatchdog.enabled) return
    if (type === "message.updated") {
      const info = ev?.properties?.info
      const sid: string | undefined = info?.sessionID
      if (sid) stampAlive(sid)

      // Proactive self-compaction: the model in the seat summarizes its OWN
      // session at compactionRatio. Never delegates compaction to another
      // model — that is the "primary forgets" failure we refuse.
      const model = `${info?.providerID}/${info?.modelID}`
      const limit = modelLimits.get(model)
      const used: number | undefined = info?.tokens?.input
      if (!sid || limit === undefined || used === undefined) return
      if (used < limit * ROOT.compactionRatio) return
      const last = lastCompactAt.get(sid) ?? 0
      if (now() - last < 120000) return // debounce: 2 min
      lastCompactAt.set(sid, now())
      const [providerID, modelID] = splitModel(model)
      logLine(`parent ${sid}: ${Math.round((used / limit) * 100)}% of ${model} — self-compacting at ${ROOT.compactionRatio * 100}%`)
      void (async () => {
        try {
          await client.session.summarize({ path: { id: sid }, body: { providerID, modelID } })
        } catch (e: any) {
          logLine(`parent ${sid}: self-compaction failed: ${e?.message ?? e}`)
        }
      })()
      return
    }
    if (type === "session.error") {
      const sid: string | undefined = ev?.properties?.sessionID
      if (!sid) return
      const c = classifyError(ev?.properties?.error)
      // If turns doesn't have this session (chat.message never fired or didn't
      // capture it), build the chain on-the-fly so the watchdog can still
      // re-prompt instead of silently returning.
      if (!turns.has(sid)) {
        const anchor = anchorFor(sid)
        if (!anchor) {
          logLine(`parent ${sid}: ${c.cls} — no anchor, cannot re-prompt`)
          return
        }
        let agent = ""
        let parts: any[] = []
        try {
          const msgs: any = await client.session.messages({ path: { id: sid }, throwOnError: true }).catch(() => null)
          const userMsgs = (msgs?.data ?? []).filter((m: any) => m?.info?.role === "user")
          const lastUserMsg = userMsgs[userMsgs.length - 1]
          if (lastUserMsg?.info?.agent) agent = lastUserMsg.info.agent
          parts = lastUserMsg?.parts ?? []
        } catch {}
        if (!agent) agent = "developer"
        const fb = loadFallback(directory)
        const agentFb = fb.agents?.[agent]
        const chain: string[] = [anchor]
        for (const e of agentFb?.fallback ?? fb.defaultFallback ?? []) chain.push(typeof e === "string" ? e : e.model)
        turns.set(sid, { chain: [...new Set(chain)], parts, agent, rePrompts: 0 })
        logLine(`parent ${sid}: built chain on-the-fly (agent=${agent}, parts=${parts.length})`)
      }
      logLine(`parent ${sid}: ${c.cls}${c.detail ? ` (${c.detail})` : ""}`)
      const failed = anchorFor(sid)
      if (failed && (c.cls === "quota" || c.cls === "transient" || c.cls === "provider_level") && !c.ours) {
        breakerFor(failed).recordFailure()
        // Re-prompt on the next healthy model in the chain, same as onStall.
        void reprompt(sid)
      }
    }
  }

  const onChatMessage = async (input: any, output: any) => {
    const sid: string | undefined = input?.sessionID
    const agent: string = input?.agent ?? output?.message?.agent ?? ""
    const current = output?.message?.model
    if (!sid || !current?.providerID || !current?.modelID) return
    logLine(`parent ${sid}: chat.message (agent=${agent}, model=${current.providerID}/${current.modelID}, parts=${output?.parts?.length ?? 0})`)
    const currentModel = `${current.providerID}/${current.modelID}`

    const fb = loadFallback(directory)
    const agentFb = fb.agents?.[agent]
    const chain: string[] = [currentModel]
    for (const e of agentFb?.fallback ?? fb.defaultFallback ?? []) chain.push(typeof e === "string" ? e : e.model)
    turns.set(sid, { chain: [...new Set(chain)], parts: output?.parts ?? [], agent, rePrompts: 0 })

    const pcfg = providerCfg(currentModel)
    registerLiveness(sid, {
      startedAt: now(),
      lastPartAt: now(),
      firstTokenMs: ROOT.parentWatchdog.firstTokenMs ?? pcfg.firstTokenMs,
      stallTimeoutMs: ROOT.parentWatchdog.stallTimeoutMs ?? pcfg.stallTimeoutMs,
      onStall: (s) => void reprompt(s),
    })

    // Steering: keep the anchor unless it is blocked or its breaker is open.
    const anchor = anchorFor(sid)
    const pick = chain.includes(anchor ?? "") ? (anchor as string) : currentModel
    const b = breakerFor(pick)
    const bt = blockedUntil.get(pick)
    const healthy = !b.isOpen && (bt === undefined || bt <= now())
    if (!healthy) {
      const next = nextHealthy(chain, pick)
      if (next && next !== currentModel) {
        const [providerID, modelID] = splitModel(next)
        output.message.model = { providerID, modelID }
        logLine(`parent ${sid}: steering ${currentModel} → ${next} (anchor unhealthy)`)
      }
    }
  }

  return { onEvent, onChatMessage }
}

// ── Plugin ──────────────────────────────────────────────────────────────────

const plugin: Plugin = async (input: PluginInput) => {
  const { client, directory } = input
  ROOT = loadRoot(directory)
  void loadModelLimits(client)
  // One sweep for both halves: child attempts stall on the same clocks.
  startLivenessSweep(client)

  const smartTask = tool({
    description:
      "Delegate a task to a subagent with automatic model fallback. Walks the fallback chain " +
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
      const { description, prompt, subagent_type, task_id } = args

      let cfg: any = null
      try {
        cfg = (await client.config.get({ throwOnError: true }))?.data
      } catch {}
      const agentConfig = cfg?.agent?.[subagent_type]
      if (!agentConfig) {
        return { title: description, output: `Unknown agent type: ${subagent_type}`, metadata: { error: true } }
      }

      const fb = loadFallback(directory)
      const agentFb = fb.agents?.[subagent_type]
      const chainRaw: string[] = []
      if (agentConfig.model) chainRaw.push(agentConfig.model)
      for (const e of agentFb?.fallback ?? fb.defaultFallback ?? []) chainRaw.push(typeof e === "string" ? e : e.model)
      const chain = [...new Set(chainRaw)]
      if (chain.length === 0) {
        return { title: description, output: `No models configured for agent ${subagent_type}`, metadata: { error: true } }
      }

      let sessionId: string
      try {
        if (task_id) {
          const msgs: any = await client.session.messages({ path: { id: task_id }, throwOnError: true }).catch(() => null)
          const hasWork = (msgs?.data ?? []).some((m: any) => m?.info?.role === "assistant")
          if (hasWork) {
            sessionId = task_id
          } else {
            const created: any = await client.session.create({
              body: { parentID: context.sessionID, title: `${description} (@${subagent_type} subagent)` },
              throwOnError: true,
            })
            sessionId = created.data.id
          }
        } else {
          const created: any = await client.session.create({
            body: { parentID: context.sessionID, title: `${description} (@${subagent_type} subagent)` },
            throwOnError: true,
          })
          sessionId = created.data.id
        }
      } catch (e: any) {
        return { title: description, output: `Failed to create session: ${e?.message ?? e}`, metadata: { error: true } }
      }

      const onOverflow = async (model: string) => {
        // Catch-all: use the large-context fallback chain (with sticky retry,
        // breaker, budget) so compaction survives rate limits or unavailable
        // large models, just like the main chain does.
        const largeChainRaw: string[] = []
        const compactAnchor = agentFb?.largeContextModel ?? model
        if (compactAnchor) largeChainRaw.push(compactAnchor)
        for (const e of agentFb?.largeContextFallback ?? agentFb?.fallback ?? fb.defaultFallback ?? []) largeChainRaw.push(typeof e === "string" ? e : e.model)
        const largeChain = [...new Set(largeChainRaw)]
        try {
          const result = await walkChain({
            chain: largeChain,
            sessionKey: sessionId,
            estimateTokens: estimateTokens(prompt),
            log: logLine,
            attempt: async (m) => {
              const [providerID, modelID] = splitModel(m)
              try {
                await client.session.summarize({ path: { id: sessionId }, body: { providerID, modelID } })
                return { ok: true, completion: { finish: "length", text: "" } }
              } catch (e: any) {
                return { ok: false, error: e }
              }
            },
          })
          if (!result.ok) {
            logLine(`parent ${sessionId}: catch-all compaction failed: ${result.reason} (trail: ${formatTrail(result.trail)})`)
          } else {
            logLine(`parent ${sessionId}: catch-all compaction completed on ${result.model} (trail: ${formatTrail(result.trail)})`)
          }
        } catch (e: any) {
          logLine(`parent ${sessionId}: catch-all compaction exception: ${e?.message ?? e}`)
        }
      }

      const outcome = await walkChain({
        chain,
        sessionKey: sessionId,
        estimateTokens: estimateTokens(prompt),
        log: logLine,
        onOverflow,
        attempt: async (model) => {
          const sdkParts = resolvePromptParts(prompt, context.worktree).map((p) =>
            p.type === "file" ? { type: "file" as const, url: p.url!, filename: p.filename, mime: p.mime! } : { type: "text" as const, text: p.text! },
          )
          const [providerID, modelID] = splitModel(model)
          const pcfg = providerCfg(model)
          // The child attempt registers for liveness so a stalled child is
          // aborted on the same two clocks the parent uses.
          registerLiveness(sessionId, {
            startedAt: now(),
            lastPartAt: now(),
            firstTokenMs: pcfg.firstTokenMs,
            stallTimeoutMs: pcfg.stallTimeoutMs,
          })
          try {
            const res: any = await client.session.prompt({
              path: { id: sessionId },
              body: { model: { providerID, modelID }, agent: subagent_type, parts: sdkParts as any },
            })
            if (res?.error) return { ok: false, error: res.error }
            // An abort we stamped during the sweep is ours, not the provider's.
            if (consumeOurAbort(sessionId)) {
              return { ok: false, error: new WatchdogAbort() }
            }
            const completion = checkCompletion(res.data)
            if (!completion.ok) {
              // Truncated / never finished: fail over rather than return a
              // partial answer the parent would mistake for a real one.
              return { ok: false, error: new Error(`incomplete response (finish=${completion.finish ?? "unset"})`) }
            }
            return { ok: true, completion: { finish: completion.finish, text: completion.text } }
          } catch (err: any) {
            if (consumeOurAbort(sessionId)) return { ok: false, error: new WatchdogAbort() }
            return { ok: false, error: err }
          } finally {
            unregisterLiveness(sessionId)
          }
        },
      })

      const trail = formatTrail(outcome.trail)
      if (outcome.ok) {
        const text = outcome.result?.completion?.text ?? ""
        const trailBlock = outcome.trail.length > 1 ? `\n<fallback_trail>${trail}</fallback_trail>` : ""
        return {
          title: description,
          output: `<task id="${sessionId}" state="completed">\n<task_result>\n${text}\n</task_result>\n</task>${trailBlock}`,
          metadata: { sessionId, model: outcome.model, trail: outcome.trail },
        }
      }
      return {
        title: description,
        output: `<task id="${sessionId}" state="error">\n<task_error>${outcome.reason}</task_error>\n</task>\n<fallback_trail>${trail}</fallback_trail>`,
        metadata: { sessionId, failed: true, trail: outcome.trail },
      }
    },
  })

  const hooks: Hooks = { tool: { smart_task: smartTask } }

  // Liveness needs events whether or not the parent watchdog is on.
  // hooks.event disabled for test

  if (ROOT.parentWatchdog.enabled) {
    const wd = setupParentWatchdog(client, directory)
    // The watchdog's superset handler already stamps liveness first.
    hooks.event = async ({ event }) => wd.onEvent(event as any)
    hooks["chat.message"] = async (input, output) => wd.onChatMessage(input, output)
  }

  return hooks
}

export default plugin
