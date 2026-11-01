import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { readFileSync, statSync, writeFileSync, appendFileSync, mkdirSync } from "fs"
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

export function stripJsonComments(str: string): string {
  let inString = false
  let escaped = false
  let out = ""
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]
    const next = str[i + 1]
    if (inString) {
      out += ch
      if (escaped) {
        escaped = false
      } else if (ch === "\\") {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
    } else {
      if (ch === '"') {
        inString = true
        out += ch
      } else if (ch === "/" && next === "/") {
        while (i < str.length && str[i] !== "\n") i++
        out += "\n"
      } else if (ch === "/" && next === "*") {
        i += 2
        while (i < str.length && !(str[i] === "*" && str[i + 1] === "/")) i++
        i++ // skip closing '/'
      } else {
        out += ch
      }
    }
  }
  return out
}

export function parseJsonWithComments(str: string): any {
  const stripped = stripJsonComments(str)
  const sanitized = stripped.replace(/,\s*([\]}])/g, "$1")
  return JSON.parse(sanitized)
}

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
  rateLimitMs?: number
  breaker: BreakerConfig
}

interface BudgetsConfig {
  fallbackBudgetMs: number
  maxIterations: number
  compactionRatio: number
  charsPerToken: number
  quotaThresholdMs: number
  maxCooldownSleepMs: number
}

interface InterceptorConfig {
  fastRetryMs: number
  defaultRateLimitMs: number
  maxCooldownSleepMs: number
}

interface WatchdogConfig {
  enabled: boolean
  firstTokenMs?: number
  stallTimeoutMs?: number
  sweepIntervalMs?: number
  debounceMs?: number
  compactionDebounceMs?: number
}

interface RootConfig {
  budgetMs: number
  maxIterations: number
  compactionRatio: number
  budgets: BudgetsConfig
  interceptor: InterceptorConfig
  watchdog: WatchdogConfig
  parentWatchdog: WatchdogConfig
  providerDefaults: ProviderConfig
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
  defaultLargeContextModel?: string
  defaultLargeContextFallback?: (FallbackEntry | string)[]
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

const DEFAULT_PROVIDER: ProviderConfig = {
  firstTokenMs: 30000,
  stallTimeoutMs: 90000,
  retryDelayMs: 10000,
  skipDelayMs: 0,
  stickyMs: 180000,
  maxTimeMs: 300000,
  timeoutMs: 180000,
  rateLimitMs: undefined,
  breaker: { threshold: 3, cooldownMs: 60000, maxCooldownMs: 600000 },
}

function DEFAULTS(): RootConfig {
  const budgets: BudgetsConfig = {
    fallbackBudgetMs: 600000,
    maxIterations: 10,
    compactionRatio: 0.4,
    charsPerToken: 4,
    quotaThresholdMs: 600000,
    maxCooldownSleepMs: 30000,
  }
  const interceptor: InterceptorConfig = {
    fastRetryMs: 500,
    defaultRateLimitMs: 60000,
    maxCooldownSleepMs: 60000,
  }
  const watchdog: WatchdogConfig = {
    enabled: false,
    firstTokenMs: 120000,
    stallTimeoutMs: 90000,
    sweepIntervalMs: 5000,
    debounceMs: 5000,
    compactionDebounceMs: 120000,
  }
  return {
    budgetMs: budgets.fallbackBudgetMs,
    maxIterations: budgets.maxIterations,
    compactionRatio: budgets.compactionRatio,
    budgets,
    interceptor,
    watchdog,
    parentWatchdog: watchdog,
    providerDefaults: { ...DEFAULT_PROVIDER, breaker: { ...DEFAULT_PROVIDER.breaker } },
    providers: {},
  }
}

let ROOT: RootConfig = { ...DEFAULTS(), providers: {} }

let isTestRoot = false

/** Test seam: loadRoot is the production path; the self-test sets ROOT directly. */
export function __setRootForTests(cfg: Partial<RootConfig>): void {
  isTestRoot = true
  const d = DEFAULTS()
  const b: BudgetsConfig = { ...d.budgets, ...(cfg as any).budgets }
  if (typeof cfg.budgetMs === "number") b.fallbackBudgetMs = cfg.budgetMs
  if (typeof cfg.maxIterations === "number") b.maxIterations = cfg.maxIterations
  if (typeof cfg.compactionRatio === "number") b.compactionRatio = cfg.compactionRatio

  const wd: WatchdogConfig = {
    ...d.watchdog,
    ...(cfg as any).watchdog,
    ...(cfg as any).parentWatchdog,
  }
  if ((cfg as any).parentWatchdog?.enabled !== undefined) wd.enabled = (cfg as any).parentWatchdog.enabled

  const ic: InterceptorConfig = {
    ...d.interceptor,
    ...(cfg as any).interceptor,
  }

  ROOT = {
    budgetMs: b.fallbackBudgetMs,
    maxIterations: b.maxIterations,
    compactionRatio: b.compactionRatio,
    budgets: b,
    interceptor: ic,
    watchdog: wd,
    parentWatchdog: wd,
    providerDefaults: (cfg as any).providerDefaults ?? d.providerDefaults,
    providers: { ...d.providers, ...cfg.providers },
  }
}

/** Test seam: loadModelLimits is the production path (client.config.get). */
export function __setModelLimitsForTests(limits: Record<string, number>): void {
  for (const [k, v] of Object.entries(limits)) modelLimits.set(k, v)
}

/** Test seam: clear all in-process state between cases. */
export function __resetStateForTests(): void {
  isTestRoot = false
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
interface FallbackCacheEntry {
  mtime: number
  data: FallbackFile
}
const fallbackCache = new Map<string, FallbackCacheEntry>()

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
  const interval = ROOT.watchdog?.sweepIntervalMs ?? 5000
  const timer = setInterval(() => {
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
  }, interval)
  timer.unref?.()
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
  return ROOT.providers[providerOf(model)] ?? ROOT.providerDefaults ?? DEFAULT_PROVIDER
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
  recordFailure(cooldownMs?: number): void {
    this.failures++
    if (this.failures < (this.cfg.threshold ?? 1)) return
    this.trips++
    const wait =
      cooldownMs !== undefined
        ? cooldownMs
        : Math.min(this.cfg.maxCooldownMs ?? this.cfg.cooldownMs, this.cfg.cooldownMs * 2 ** Math.max(0, this.trips - 1))
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

let currentConfigDir = ""

function loadState(dir: string): void {
  try {
    const file = join(dir, "fallback-state.json")
    const raw = JSON.parse(readFileSync(file, "utf8"))
    const t = now()
    if (raw.blockedUntil && typeof raw.blockedUntil === "object") {
      for (const [m, until] of Object.entries<any>(raw.blockedUntil)) {
        if (typeof until === "number" && until > t) blockedUntil.set(m, until)
      }
    }
  } catch {}
}

function saveState(): void {
  if (!currentConfigDir) return
  try {
    const file = join(currentConfigDir, "fallback-state.json")
    const t = now()
    const activeBlocks: Record<string, number> = {}
    for (const [m, until] of blockedUntil.entries()) {
      if (until > t) activeBlocks[m] = until
    }
    writeFileSync(file, JSON.stringify({ blockedUntil: activeBlocks, savedAt: t }, null, 2), "utf8")
  } catch {}
}

function loadRoot(directory: string): RootConfig {
  const cfg = DEFAULTS()
  const dir = configDir(directory)
  currentConfigDir = dir
  loadState(dir)
  try {
    const raw = parseJsonWithComments(readFileSync(join(dir, "fallback.json"), "utf8"))

    // Budgets category
    const b = raw.budgets ?? {}
    if (typeof b.fallbackBudgetMs === "number") cfg.budgets.fallbackBudgetMs = b.fallbackBudgetMs
    else if (typeof raw.fallbackBudgetMs === "number") cfg.budgets.fallbackBudgetMs = raw.fallbackBudgetMs
    cfg.budgetMs = cfg.budgets.fallbackBudgetMs

    if (typeof b.maxIterations === "number") cfg.budgets.maxIterations = b.maxIterations
    else if (typeof raw.maxIterations === "number") cfg.budgets.maxIterations = raw.maxIterations
    cfg.maxIterations = cfg.budgets.maxIterations

    if (typeof b.compactionRatio === "number") cfg.budgets.compactionRatio = b.compactionRatio
    else if (typeof raw.compactionRatio === "number") cfg.budgets.compactionRatio = raw.compactionRatio
    cfg.compactionRatio = cfg.budgets.compactionRatio

    if (typeof b.charsPerToken === "number") cfg.budgets.charsPerToken = b.charsPerToken
    if (typeof b.quotaThresholdMs === "number") cfg.budgets.quotaThresholdMs = b.quotaThresholdMs
    if (typeof b.maxCooldownSleepMs === "number") cfg.budgets.maxCooldownSleepMs = b.maxCooldownSleepMs

    // Interceptor category
    const ic = raw.interceptor ?? {}
    if (typeof ic.fastRetryMs === "number") cfg.interceptor.fastRetryMs = ic.fastRetryMs
    if (typeof ic.defaultRateLimitMs === "number") cfg.interceptor.defaultRateLimitMs = ic.defaultRateLimitMs
    if (typeof ic.maxCooldownSleepMs === "number") cfg.interceptor.maxCooldownSleepMs = ic.maxCooldownSleepMs

    // Watchdog category
    const wd = raw.watchdog ?? raw.parentWatchdog ?? {}
    if (typeof wd.enabled === "boolean") cfg.watchdog.enabled = wd.enabled
    if (typeof wd.firstTokenMs === "number") cfg.watchdog.firstTokenMs = wd.firstTokenMs
    if (typeof wd.stallTimeoutMs === "number") cfg.watchdog.stallTimeoutMs = wd.stallTimeoutMs
    if (typeof wd.sweepIntervalMs === "number") cfg.watchdog.sweepIntervalMs = wd.sweepIntervalMs
    if (typeof wd.debounceMs === "number") cfg.watchdog.debounceMs = wd.debounceMs
    if (typeof wd.compactionDebounceMs === "number") cfg.watchdog.compactionDebounceMs = wd.compactionDebounceMs
    cfg.parentWatchdog = cfg.watchdog

    // Provider defaults override
    if (raw.providerDefaults && typeof raw.providerDefaults === "object") {
      cfg.providerDefaults = mergeProvider(raw.providerDefaults, DEFAULT_PROVIDER)
    }

    // Providers category
    for (const [k, v] of Object.entries<any>(raw.providers ?? {})) {
      cfg.providers[k] = mergeProvider(v, cfg.providerDefaults)
    }
  } catch {
    /* no fallback.json: defaults only */
  }
  return cfg
}

function mergeProvider(raw: any, base: ProviderConfig = DEFAULT_PROVIDER): ProviderConfig {
  const p: ProviderConfig = { ...base, breaker: { ...base.breaker } }
  if (!raw || typeof raw !== "object") return p
  for (const k of ["firstTokenMs", "stallTimeoutMs", "retryDelayMs", "skipDelayMs", "stickyMs", "maxTimeMs", "timeoutMs", "rateLimitMs"] as const) {
    if (typeof raw[k] === "number" && Number.isFinite(raw[k])) p[k] = raw[k]
  }
  const b = raw.breaker ?? {}
  if (typeof b.threshold === "number") p.breaker.threshold = b.threshold
  if (typeof b.cooldownMs === "number") p.breaker.cooldownMs = b.cooldownMs
  if (typeof b.maxCooldownMs === "number") p.breaker.maxCooldownMs = b.maxCooldownMs
  return p
}

function loadFallback(directory: string): FallbackFile {
  try {
    const file = join(configDir(directory), "fallback.json")
    const stat = statSync(file)
    const cached = fallbackCache.get(directory)
    if (cached && cached.mtime === stat.mtimeMs) return cached.data
    const parsed = parseJsonWithComments(readFileSync(file, "utf8"))
    if (parsed.defaults && typeof parsed.defaults === "object") {
      if (!parsed.defaultFallback && parsed.defaults.fallback) parsed.defaultFallback = parsed.defaults.fallback
      if (!parsed.defaultLargeContextModel && parsed.defaults.largeContextModel) parsed.defaultLargeContextModel = parsed.defaults.largeContextModel
      if (!parsed.defaultLargeContextFallback && parsed.defaults.largeContextFallback) parsed.defaultLargeContextFallback = parsed.defaults.largeContextFallback
    }
    fallbackCache.set(directory, { mtime: stat.mtimeMs, data: parsed })
    return parsed
  } catch {
    return fallbackCache.get(directory)?.data ?? {}
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

// Rough token estimate. Deliberately crude: it only decides
// whether a model is a candidate, not exact accounting.
export function estimateTokens(text: string): number {
  const ratio = ROOT.budgets?.charsPerToken ?? 4
  return Math.ceil(text.length / (ratio > 0 ? ratio : 4))
}

async function getSessionTokens(client: OpencodeClient, sessionId: string): Promise<number> {
  try {
    const msgs: any = await client.session.messages({ path: { id: sessionId }, throwOnError: true }).catch(() => null)
    if (!msgs?.data) return 0
    return msgs.data.reduce((sum: number, m: any) => sum + (m.info?.tokens?.input || 0), 0)
  } catch {
    return 0
  }
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

function getQuotaThreshold(): number {
  return ROOT.budgets?.quotaThresholdMs ?? QUOTA_THRESHOLD_MS
}

export function classifyError(err: any): Classified {
  if (!err) return { cls: "fatal", detail: "unknown error" }
  if (isOurs(err)) return { cls: "transient", detail: String(err?.message ?? "watchdog abort"), ours: true }

  const d = err?.data ?? err
  let status: number | undefined = typeof d?.statusCode === "number" ? d.statusCode : typeof d?.status === "number" ? d.status : undefined
  const name: string = d?.name ?? ""
  const msg = String(d?.message ?? "").toLowerCase()
  const retryAfterMs = headerRetryAfter(d?.responseHeaders)

  if (status === undefined) {
    const m = msg.match(/status(?:_code)?\s*[:=]\s*(\d{3})/i)
    if (m) status = Number(m[1])
  }

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

  if (
    name === "MessageOutputLengthError" ||
    msg.includes("finish_reason 'length'") ||
    msg.includes("finish=length") ||
    msg.includes("incomplete response") ||
    msg.includes("empty completion")
  ) {
    // Model behavior for THIS request, not provider health — exempt from
    // benching (streak-bounded at the walk), but it still fails over.
    return { cls: "transient", detail: "truncated/empty completion" }
  }

  const is429 = status === 429 || msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests") || msg.includes("busy") || msg.includes("all providers for model") || msg.includes("free usage limit reached") || msg.includes("free usage exceeded")
  const isFalseUsedUp = msg.includes("nothing is used up")
  const quotaWords =
    (!isFalseUsedUp && msg.includes("used up")) ||
    msg.includes("daily") ||
    msg.includes("quota") ||
    msg.includes("insufficient_quota") ||
    msg.includes("free usage limit") ||
    msg.includes("usage limit reached") ||
    msg.includes("free usage exceeded") ||
    msg.includes("subscribe to go") ||
    msg.includes("resets in")
  const longReset = retryAfterMs !== undefined && retryAfterMs > getQuotaThreshold()

  if (is429 || quotaWords) {
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

  const deadline = now() + (ROOT.budgets?.fallbackBudgetMs ?? ROOT.budgetMs)
  const trail: TrailEntry[] = []
  let soonestResetMs: number | undefined

  // Anchor first: the session keeps using the model that last served it.
  const anchor = anchorFor(input.sessionKey)
  const ordered: string[] = []
  if (anchor && candidates.includes(anchor)) ordered.push(anchor)
  for (const m of candidates) if (m !== anchor) ordered.push(m)

  log(`walk starting: ${ordered.join(" -> ")} (anchor=${anchor ?? "none"}, est=${est ?? "n/a"})`)

  // Request-scoped exclusions.
  const outModels = new Set<string>()
  const outProviders = new Set<string>()

  // Per-model transient stickiness + streak counting.
  const transientSince = new Map<string, number>()
  const transientStreak = new Map<string, number>()

  const maxPasses = ROOT.budgets?.maxIterations ?? ROOT.maxIterations
  for (let pass = 0; pass < maxPasses; pass++) {
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
          if (streak >= 3) {
            b.recordFailure()
            log(`${model}: circuit breaker tripped (streak=${streak}) — advancing chain`)
            await sleep(pcfg.skipDelayMs)
            break
          }

          // If 400 validation / bad request: sticky retry is futile, advance immediately
          if (c.detail === "provider 400" || c.detail?.includes("400")) {
            b.recordFailure()
            log(`${model}: provider 400 validation error — advancing chain`)
            await sleep(pcfg.skipDelayMs)
            break
          }

          const since = transientSince.get(model)
          const firstTransient = since === undefined
          const windowElapsed = firstTransient ? 0 : now() - (since as number)
          if (firstTransient) transientSince.set(model, now())

          if (c.retryAfterMs !== undefined && c.retryAfterMs > getQuotaThreshold()) {
            blockedUntil.set(model, now() + c.retryAfterMs)
            saveState()
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
          const reset = c.retryAfterMs ?? getQuotaThreshold()
          blockedUntil.set(model, now() + reset)
          saveState()
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

    // End of pass: check if any models remain eligible (not permanently ruled out).
    const eligible = ordered.filter((m) => !outModels.has(m) && !outProviders.has(providerOf(m)))
    if (eligible.length === 0) break

    // If all eligible models are in cooldown / breaker, pause until the soonest one cools down
    // instead of burning all remaining passes in milliseconds.
    if (pass < maxPasses - 1) {
      let soonestCooldown = Infinity
      for (const m of eligible) {
        const b = breakerFor(m)
        if (b.isOpen && b.openUntil < soonestCooldown) soonestCooldown = b.openUntil
        const bt = blockedUntil.get(m)
        if (bt !== undefined && bt > now() && bt < soonestCooldown) soonestCooldown = bt
      }
      if (soonestCooldown !== Infinity && soonestCooldown > now()) {
        const remainingBudget = deadline - now()
        if (soonestCooldown - now() > remainingBudget) break
        const maxCooldownSleep = ROOT.budgets?.maxCooldownSleepMs ?? 30000
        const waitMs = Math.min(soonestCooldown - now() + 50, maxCooldownSleep)
        log(`walk pass ${pass + 1} finished: all eligible models in cooldown — waiting ${Math.round(waitMs / 1000)}s before pass ${pass + 2}`)
        await sleep(waitMs)
      }
    }
  }

  const reason = soonestResetMs
    ? `all candidates unavailable; soonest reset ~${Math.round(Math.max(0, soonestResetMs - now()) / 1000)}s`
    : "all candidates failed or were ruled out for this request"
  log(`walk finished: ${trail.length} attempts, ${trail.filter(t => t.cls === "ok").length} succeeded`)
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

// ── In-stream fetch interceptor (transparent fallback for opencode run) ──

const KNOWN_PROVIDER_BASE_URLS: Record<string, string> = {
  opencode: "https://opencode.ai/inference/openai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  unorouter: "https://api.unorouter.com/v1",
  "unorouter-custom": "https://api.unorouter.com/v1",
  zai: "https://open.bigmodel.cn/api/paas/v4",
  sambanova: "https://api.sambanova.ai/v1",
  orcarouter: "https://api.orcarouter.com/v1",
  groq: "https://api.groq.com/openai/v1",
  deepseek: "https://api.deepseek.com/v1",
  together: "https://api.together.xyz/v1",
  openai: "https://api.openai.com/v1",
}

interface ResolvedProvider {
  baseURL: string
  apiKey?: string
}

function resolveProviderInfo(providerId: string, directory: string): ResolvedProvider | null {
  let baseURL: string | undefined = KNOWN_PROVIDER_BASE_URLS[providerId]
  let apiKey: string | undefined

  try {
    const ocFile = join(configDir(directory), "opencode.json")
    const ocCfg = JSON.parse(readFileSync(ocFile, "utf8"))
    const pCfg = ocCfg?.provider?.[providerId]
    if (pCfg?.options?.baseURL) baseURL = pCfg.options.baseURL
    if (pCfg?.options?.apiKey) apiKey = pCfg.options.apiKey
  } catch {}

  try {
    const authFile = join(homedir(), ".local", "share", "opencode", "auth.json")
    const authCfg = JSON.parse(readFileSync(authFile, "utf8"))
    const entry = authCfg?.[providerId]
    if (entry?.key) apiKey = entry.key
  } catch {}

  if (!apiKey) {
    const envKeyName = `${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`
    if (process.env[envKeyName]) apiKey = process.env[envKeyName]
    else if (providerId === "openrouter" && process.env.OPENROUTER_API_KEY) apiKey = process.env.OPENROUTER_API_KEY
  }

  if (!baseURL) return null
  return { baseURL, apiKey }
}

function detectIncomingProvider(requestedModel: string, urlStr: string, directory: string): string {
  if (requestedModel.includes("/")) {
    const [p] = splitModel(requestedModel)
    if (p) return p
  }
  if (urlStr.includes("opencode.ai")) return "opencode"
  for (const [p, base] of Object.entries(KNOWN_PROVIDER_BASE_URLS)) {
    try {
      if (urlStr.includes(new URL(base).hostname)) return p
    } catch {}
  }
  try {
    const ocFile = join(configDir(directory), "opencode.json")
    const ocCfg = JSON.parse(readFileSync(ocFile, "utf8"))
    for (const [p, pCfg] of Object.entries<any>(ocCfg?.provider ?? {})) {
      if (pCfg?.options?.baseURL) {
        try {
          if (urlStr.includes(new URL(pCfg.options.baseURL).hostname)) return p
        } catch {}
      }
    }
  } catch {}
  return ""
}

function buildHeaders(originalHeaders: any, apiKey?: string, isTargetOpenRouter?: boolean): Record<string, string> {
  const headers: Record<string, string> = {}
  if (originalHeaders) {
    if (typeof originalHeaders.forEach === "function") {
      originalHeaders.forEach((value: string, key: string) => {
        headers[key.toLowerCase()] = value
      })
    } else if (Array.isArray(originalHeaders)) {
      for (const [k, v] of originalHeaders) {
        headers[k.toLowerCase()] = String(v)
      }
    } else if (typeof originalHeaders === "object") {
      for (const [k, v] of Object.entries(originalHeaders)) {
        headers[k.toLowerCase()] = String(v)
      }
    }
  }
  if (apiKey) {
    headers["authorization"] = `Bearer ${apiKey}`
  }
  if (isTargetOpenRouter) {
    if (!headers["http-referer"]) headers["http-referer"] = "https://opencode.ai"
    if (!headers["x-title"]) headers["x-title"] = "OpenCode"
  }
  delete headers["host"]
  return headers
}

function setupFetchInterceptor(directory: string): void {
  const origFetch = globalThis.fetch
  if (!origFetch || (origFetch as any).__opencode_fallback_installed) return

  const interceptedFetch: typeof globalThis.fetch = async (input, init) => {
    const isPost =
      init?.method?.toUpperCase() === "POST" ||
      (typeof input === "object" && input !== null && "method" in input && (input as any).method?.toUpperCase() === "POST")

    if (!isPost || !init?.body || typeof init.body !== "string") {
      return origFetch(input, init)
    }

    let parsed: any
    try {
      parsed = JSON.parse(init.body)
    } catch {
      return origFetch(input, init)
    }

    if (!parsed || typeof parsed.model !== "string" || (!Array.isArray(parsed.messages) && !Array.isArray(parsed.prompt))) {
      return origFetch(input, init)
    }

    const requestedModel: string = parsed.model
    const response = await origFetch(input, init)
    if (response.ok) return response

    const status = response.status
    let isContextOverflow = status === 413
    if (status === 400) {
      try {
        const cloned = response.clone()
        const text = (await cloned.text()).toLowerCase()
        if (text.includes("context length") || text.includes("maximum context") || text.includes("too many tokens") || text.includes("context_length_exceeded") || text.includes("request too large")) {
          isContextOverflow = true
        }
      } catch {}
    }

    if (status === 429 || status >= 500 || status === 400 || isContextOverflow) {
      const fb = loadFallback(directory)
      let matchedAgent: string | undefined
      try {
        const ocConfig = JSON.parse(readFileSync(join(configDir(directory), "opencode.json"), "utf8"))
        for (const [agentName, aCfg] of Object.entries<any>(ocConfig?.agent ?? {})) {
          if (aCfg?.model === requestedModel || aCfg?.model?.endsWith(`/${requestedModel}`)) {
            matchedAgent = agentName
            break
          }
        }
      } catch {}
      if (!matchedAgent) {
        for (const [agentName, agentFb] of Object.entries(fb.agents ?? {})) {
          const fallbacks = (agentFb?.fallback ?? []).map((e) => (typeof e === "string" ? e : e.model))
          const largeFallbacks = (agentFb?.largeContextFallback ?? []).map((e) => (typeof e === "string" ? e : e.model))
          if (
            agentFb?.largeContextModel === requestedModel ||
            agentFb?.largeContextModel?.endsWith(`/${requestedModel}`) ||
            fallbacks.some((m) => m === requestedModel || m.endsWith(`/${requestedModel}`)) ||
            largeFallbacks.some((m) => m === requestedModel || m.endsWith(`/${requestedModel}`))
          ) {
            matchedAgent = agentName
            break
          }
        }
      }
      if (!matchedAgent) matchedAgent = "developer"

      const agentFb = fb.agents?.[matchedAgent]
      let candidateChain: string[] = []

      if (isContextOverflow) {
        logLine(`fetch interceptor: ${requestedModel} exceeded context length — attempting large-context fallback for agent ${matchedAgent}`)
        const rawLarge: string[] = []
        const compactAnchor = agentFb?.largeContextModel ?? fb.agents?.["compaction"]?.largeContextModel ?? fb.defaultLargeContextModel
        if (compactAnchor) rawLarge.push(compactAnchor)
        for (const e of agentFb?.largeContextFallback ?? agentFb?.fallback ?? fb.agents?.["compaction"]?.largeContextFallback ?? fb.defaultLargeContextFallback ?? fb.defaultFallback ?? []) {
          rawLarge.push(typeof e === "string" ? e : e.model)
        }
        candidateChain = [...new Set(rawLarge)]
      } else {
        const rawChain: string[] = []
        // Current model is ALWAYS included in candidate chain
        rawChain.push(requestedModel)
        for (const e of agentFb?.fallback ?? fb.defaultFallback ?? []) {
          rawChain.push(typeof e === "string" ? e : e.model)
        }
        candidateChain = [...new Set(rawChain)]
      }

      if (candidateChain.length > 0) {
        const incomingUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
        const incomingProvider = detectIncomingProvider(requestedModel, incomingUrl, directory)
        const deadline = now() + (ROOT.budgets?.fallbackBudgetMs ?? ROOT.budgetMs ?? 600000)
        const maxPasses = ROOT.budgets?.maxIterations ?? ROOT.maxIterations ?? 10
        const fastRetryMs = ROOT.interceptor?.fastRetryMs ?? 500
        const defaultRateLimitMs = ROOT.interceptor?.defaultRateLimitMs ?? 60000
        const maxSleepMs = ROOT.interceptor?.maxCooldownSleepMs ?? 60000

        if (status === 429) {
          const pcfg = providerCfg(requestedModel)
          const isUno = incomingProvider === "unorouter-custom" || incomingProvider === "unorouter" || incomingUrl.includes("unorouter.com")
          const cooldown = pcfg.rateLimitMs ?? (isUno ? defaultRateLimitMs : undefined)
          if (cooldown !== undefined && cooldown > 0) {
            blockedUntil.set(requestedModel, now() + cooldown)
          } else {
            breakerFor(requestedModel).recordFailure()
          }
          saveState()
        }
        logLine(`fetch interceptor: ${requestedModel} returned HTTP ${status} (contextOverflow=${isContextOverflow}) — attempting in-stream fallback`)

        const estTokens = estimateTokens(typeof init?.body === "string" ? init.body : "")

        for (let pass = 0; pass < maxPasses; pass++) {
          if (now() >= deadline) break
          let attemptedInPass = 0

          for (const candidate of candidateChain) {
            if (now() >= deadline) break
            const [candProvider, modelOnly] = splitModel(candidate)
            // On pass 0, skip requestedModel because it just failed
            if (pass === 0 && (modelOnly === requestedModel || candidate === requestedModel)) continue

            const candidateBreaker = breakerFor(candidate)
            const bt = blockedUntil.get(candidate)
            if (candidateBreaker.isOpen || (bt !== undefined && bt > now())) continue

            const candLimit = modelLimits.get(candidate)
            if (candLimit !== undefined && estTokens > 0 && estTokens > candLimit) {
              logLine(`fetch interceptor: candidate ${candidate} limit ${candLimit} too small for ~${estTokens} tokens — skipping`)
              continue
            }

            const targetProvider = candProvider || incomingProvider
            let targetUrl = incomingUrl
            let targetHeaders: Record<string, string> | undefined

            if (targetProvider && incomingProvider && targetProvider !== incomingProvider) {
              const pInfo = resolveProviderInfo(targetProvider, directory)
              if (!pInfo || !pInfo.baseURL) {
                logLine(`fetch interceptor: candidate ${candidate} provider ${targetProvider} has no baseURL/auth — skipping`)
                continue
              }
              targetUrl = `${pInfo.baseURL.replace(/\/+$/, "")}/chat/completions`
              targetHeaders = buildHeaders(init.headers, pInfo.apiKey, targetProvider === "openrouter")
            }

            attemptedInPass++
            parsed.model = modelOnly
            logLine(`fetch interceptor (pass ${pass + 1}): falling back ${requestedModel} -> ${candidate} (${targetUrl})`)

            const newInit: RequestInit = {
              ...init,
              headers: targetHeaders ?? init.headers,
              body: JSON.stringify(parsed),
            }

            try {
              const fallbackResponse = await origFetch(targetUrl, newInit)
              if (fallbackResponse.ok) {
                logLine(`fetch interceptor: in-stream fallback to ${candidate} succeeded (HTTP ${fallbackResponse.status})`)
                candidateBreaker.recordSuccess()
                saveState()
                return fallbackResponse
              }
              const respStatus = fallbackResponse.status
              logLine(`fetch interceptor: ${candidate} also failed with HTTP ${respStatus}`)

              if (respStatus === 400) {
                // If endpoint rejected an unsupported parameter (e.g. `usage`), strip it and retry once
                try {
                  const errText = (await fallbackResponse.clone().text()).toLowerCase()
                  const paramMatch = errText.match(/unsupported parameter\(s\):\s*`?([a-zA-Z0-9_]+)`?/i)
                  if (paramMatch && parsed[paramMatch[1]] !== undefined) {
                    delete parsed[paramMatch[1]]
                    newInit.body = JSON.stringify(parsed)
                    const retryRes = await origFetch(targetUrl, newInit)
                    if (retryRes.ok) {
                      logLine(`fetch interceptor: stripped unsupported parameter ${paramMatch[1]} for ${candidate} — succeeded (HTTP ${retryRes.status})`)
                      candidateBreaker.recordSuccess()
                      saveState()
                      return retryRes
                    }
                  }
                } catch {}
                candidateBreaker.recordFailure()
                blockedUntil.set(candidate, now() + 60000)
                saveState()
              } else if (respStatus === 503 || respStatus >= 500) {
                // 503/5xx: Cloud concurrency slot busy.
                // No exponential cooldown: retried next pass (after fastRetryMs) to find an opening.
              } else if (respStatus === 429) {
                // 429: Rate limit / quota exhaustion.
                const candCfg = providerCfg(candidate)
                const isUno = targetProvider === "unorouter-custom" || targetProvider === "unorouter" || targetUrl.includes("unorouter.com")
                const cooldown = candCfg.rateLimitMs ?? (isUno ? defaultRateLimitMs : undefined)
                if (cooldown !== undefined && cooldown > 0) {
                  blockedUntil.set(candidate, now() + cooldown)
                } else {
                  candidateBreaker.recordFailure()
                }
                saveState()
              } else {
                candidateBreaker.recordFailure()
                saveState()
              }
            } catch (e: any) {
              logLine(`fetch interceptor: network error on ${candidate}: ${e?.message ?? e}`)
            }
          }

          if (pass < maxPasses - 1) {
            let soonestCooldown = Infinity
            let anyAvailable = false

            for (const candidate of candidateChain) {
              const cb = breakerFor(candidate)
              const bt = blockedUntil.get(candidate)
              const isBlocked = cb.isOpen || (bt !== undefined && bt > now())
              if (!isBlocked) {
                anyAvailable = true
              } else {
                if (cb.isOpen && cb.openUntil < soonestCooldown) soonestCooldown = cb.openUntil
                if (bt !== undefined && bt > now() && bt < soonestCooldown) soonestCooldown = bt
              }
            }

            if (!anyAvailable && soonestCooldown !== Infinity && soonestCooldown > now()) {
              const remainingBudget = deadline - now()
              if (soonestCooldown - now() > remainingBudget) break
              const waitMs = Math.max(fastRetryMs, Math.min(soonestCooldown - now() + 50, maxSleepMs))
              logLine(`fetch interceptor: all candidates in cooldown — waiting ${Math.round(waitMs / 1000)}s for next opening before pass ${pass + 2}`)
              await sleep(waitMs)
            } else {
              logLine(`fetch interceptor: pass ${pass + 1} finished (${attemptedInPass} attempted) — searching for opening in ${fastRetryMs}ms (pass ${pass + 2})`)
              await sleep(fastRetryMs)
            }
          }
        }
      }
    }

    return response
  }

  ;(interceptedFetch as any).__opencode_fallback_installed = true
  globalThis.fetch = interceptedFetch
}

// ── Parent watchdog ─────────────────────────────────────────────────────────

const LOG_FILE = join(homedir(), ".local", "share", "opencode", "log", "fallback.log")

function logLine(msg: string): void {
  const line = `${new Date().toISOString()} [subagent-fallback] ${msg}\n`
  try {
    appendFileSync(LOG_FILE, line, "utf8")
  } catch {
    try {
      mkdirSync(join(homedir(), ".local", "share", "opencode", "log"), { recursive: true })
      appendFileSync(LOG_FILE, line, "utf8")
    } catch {}
  }
  if (process.env.OPENCODE_FALLBACK_CONSOLE === "1") {
    console.error(`[subagent-fallback] ${msg}`)
  }
}

function sanitizeParts(parts: any[]): any[] {
  return (parts || []).filter((p: any) => p && (p.type === "text" || p.type === "file" || p.type === "agent" || p.type === "subtask"))
}

function extractLastUserParts(allMsgs: any[]): any[] {
  for (let i = allMsgs.length - 1; i >= 0; i--) {
    const m = allMsgs[i]
    const isUser = !m?.info?.role || m.info.role === "user"
    if (isUser && m?.parts?.length) {
      const sanitized = sanitizeParts(m.parts)
      if (sanitized.length > 0) return sanitized
    }
  }
  return []
}

interface TurnState {
  chain: string[]
  parts: any[]
  agent: string
  rePrompts: number
  usedTokens: number
  partialResponse: string
  responseStarted: boolean
  responseStartTime: number
  lastTokenAt: number
  triedModels: Set<string>
}

function setupParentWatchdog(client: any, directory: string): {
  onEvent: (event: any) => void
  onChatMessage: (input: any, output: any) => Promise<void>
} {
  const turns = new Map<string, TurnState>()

  const ensureTurnState = async (sid: string): Promise<TurnState | null> => {
    let st = turns.get(sid)
    if (st) return st
    let currentModel = anchorFor(sid)
    let agent = ""
    let parts: any[] = []
    let usedTokens = 0
    try {
      const msgs: any = await client.session.messages({ path: { id: sid }, throwOnError: true }).catch(() => null)
      const allMsgs = msgs?.data ?? []
      for (let i = allMsgs.length - 1; i >= 0; i--) {
        const m = allMsgs[i]
        if (!currentModel && m?.info?.model?.providerID && m?.info?.model?.modelID) {
          currentModel = `${m.info.model.providerID}/${m.info.model.modelID}`
        }
        if (!agent && m?.info?.agent && m.info.agent !== "compaction") agent = m.info.agent
        if (usedTokens === 0 && m?.info?.role === "assistant" && m?.info?.tokens?.input) {
          usedTokens = m.info.tokens.input
        }
      }
      parts = extractLastUserParts(allMsgs)
    } catch {}
    if (!currentModel) {
      try {
        const cfg: any = (await client.config.get({ throwOnError: true }))?.data
        if (agent && cfg?.agent?.[agent]?.model) currentModel = cfg.agent[agent].model
      } catch {}
    }
    if (!currentModel) return null
    if (!agent) agent = "developer"
    const fb = loadFallback(directory)
    const agentFb = fb.agents?.[agent] ?? fb.agents?.["compaction"]
    const chain: string[] = [currentModel]
    for (const e of agentFb?.fallback ?? fb.defaultFallback ?? []) chain.push(typeof e === "string" ? e : e.model)
    st = {
      chain: [...new Set(chain)],
      parts,
      agent,
      rePrompts: 0,
      usedTokens,
      partialResponse: "",
      responseStarted: false,
      responseStartTime: 0,
      lastTokenAt: 0,
      triedModels: new Set([currentModel]),
    }
    turns.set(sid, st)
    logLine(`parent ${sid}: built chain on-the-fly (agent=${agent}, model=${currentModel}, parts=${parts.length}, usedTokens=${usedTokens})`)
    return st
  }

  // First healthy model in the chain that isn't excluded or on cooldown.
  const nextHealthy = (chain: string[], exclude: string | Set<string>, est?: number): string | undefined => {
    const t = now()
    return chain.find((m) => {
      const isExcluded = typeof exclude === "string" ? m === exclude : exclude.has(m)
      if (isExcluded) return false
      const b = breakerFor(m)
      const bt = blockedUntil.get(m)
      if (b.isOpen || (bt !== undefined && bt > t)) return false
      // Context-size filter: skip models that can't hold the conversation.
      if (est !== undefined) {
        const limit = modelLimits.get(m)
        if (limit !== undefined && est > limit) return false
      }
      return true
    })
  }

  const reprompt = async (sid: string, opts?: { isContextOverflow?: boolean }): Promise<void> => {
    const st = await ensureTurnState(sid)
    if (!st) return
    if (st.rePrompts >= ROOT.maxIterations) {
      logLine(`parent ${sid}: ${st.rePrompts} consecutive stalls — giving up`)
      turns.delete(sid)
      unregisterLiveness(sid)
      return
    }
    const stalled = anchorFor(sid) ?? st.chain[0]
    st.triedModels.add(stalled)
    const next = nextHealthy(st.chain, st.triedModels, st.usedTokens || undefined)
    // Only attempt compaction if there was an explicit context overflow error.
    // Ending the fallback chain on rate limits or errors must never trigger compaction.
    if (!next) {
      if (opts?.isContextOverflow) {
        const fb = loadFallback(directory)
        const effectiveAgent = st.agent && st.agent !== "compaction" ? st.agent : "developer"
        const agentFb = fb.agents?.[effectiveAgent] ?? fb.agents?.["compaction"]
        const largeChainRaw: string[] = []
        const compactAnchor = agentFb?.largeContextModel ?? fb.agents?.["compaction"]?.largeContextModel ?? fb.defaultLargeContextModel ?? stalled
        if (compactAnchor) largeChainRaw.push(compactAnchor)
        if (stalled && stalled !== compactAnchor) largeChainRaw.push(stalled)
        for (const e of agentFb?.largeContextFallback ?? agentFb?.fallback ?? fb.agents?.["compaction"]?.largeContextFallback ?? fb.defaultLargeContextFallback ?? fb.defaultFallback ?? []) {
          largeChainRaw.push(typeof e === "string" ? e : e.model)
        }
        const largeChain = [...new Set(largeChainRaw)]
        logLine(`parent ${sid}: context overflow — compacting via ${effectiveAgent} large context fallback chain (${largeChain.join(" -> ")})`)
        try {
          const result = await walkChain({
            chain: largeChain,
            sessionKey: sid,
            estimateTokens: st.usedTokens > 0 ? st.usedTokens : undefined,
            log: logLine,
            attempt: async (m) => {
              const [providerID, modelID] = splitModel(m)
              try {
                await client.session.summarize({ path: { id: sid }, body: { providerID, modelID } })
                return { ok: true, completion: { finish: "length", text: "" } }
              } catch (e: any) {
                return { ok: false, error: e }
              }
            },
          })
          if (result.ok) {
            logLine(`parent ${sid}: compaction completed on ${result.model} — retrying`)
            if (st.usedTokens > 0) st.usedTokens = Math.round(st.usedTokens * ROOT.compactionRatio)
            // Re-check nextHealthy after compaction
          } else {
            logLine(`parent ${sid}: compaction failed: ${result.reason}`)
          }
        } catch (e: any) {
          logLine(`parent ${sid}: compaction exception: ${e?.message ?? e}`)
        }
      } else {
        logLine(`parent ${sid}: fallback chain exhausted (${st.chain.join(" -> ")}) — giving up`)
        turns.delete(sid)
        unregisterLiveness(sid)
        return
      }
    }
    const nextAfterCompact = next ?? nextHealthy(st.chain, st.triedModels, st.usedTokens || undefined)
    // If parts are empty (chat.message didn't capture them), try fetching
    // from the session before giving up.
    if (st.parts.length === 0) {
      try {
        const msgs: any = await client.session.messages({ path: { id: sid }, throwOnError: true }).catch(() => null)
        const recovered = extractLastUserParts(msgs?.data ?? [])
        if (recovered.length > 0) {
          st.parts = recovered
          logLine(`parent ${sid}: recovered ${st.parts.length} parts from session messages`)
        }
      } catch {}
    }
    if (!nextAfterCompact) {
      logLine(`parent ${sid}: no healthy model to re-prompt on (next=none)`)
      turns.delete(sid)
      return
    }
    const promptParts = st.parts.length > 0 ? st.parts : [{ type: "text", text: "Continue" }]
    st.rePrompts += 1
    logLine(`parent ${sid}: re-prompting on ${nextAfterCompact} (attempt ${st.rePrompts}, parts=${promptParts.length})`)
    setAnchor(sid, nextAfterCompact)
    st.triedModels.add(nextAfterCompact)
    const [providerID, modelID] = splitModel(nextAfterCompact)
    const pcfg = providerCfg(nextAfterCompact)
    const entry = liveness.get(sid)
    if (entry) {
      entry.startedAt = now()
      entry.lastPartAt = now()
      entry.firstTokenMs = pcfg.firstTokenMs ?? ROOT.parentWatchdog.firstTokenMs
      entry.stallTimeoutMs = pcfg.stallTimeoutMs ?? ROOT.parentWatchdog.stallTimeoutMs
    }
    try {
      await client.session.prompt({
        path: { id: sid },
        body: { agent: st.agent, model: { providerID, modelID }, parts: promptParts },
      })
    } catch (e: any) {
      logLine(`parent ${sid}: re-prompt failed: ${e?.message ?? e}`)
    }
  }

  // Compaction bookkeeping: never self-compact the same session twice inside
  // the debounce window (each summarize costs a full turn).
  const lastCompactAt = new Map<string, number>()
  const lastParentErrorAt = new Map<string, number>()
  const debounceMs = ROOT.watchdog?.debounceMs ?? 5000
  const compactDebounceMs = ROOT.watchdog?.compactionDebounceMs ?? 120000

  const onEvent = async (ev: any) => {
    const type = ev?.type
    if (type === "session.status") {
      const sid: string | undefined = ev?.properties?.sessionID
      const status = ev?.properties?.status
      if (sid && status?.type === "idle") {
        unregisterLiveness(sid)
        turns.delete(sid)
        return
      }
      if (sid && status?.type === "retry") {
        logLine(`parent ${sid}: session.status retry attempt=${status.attempt} message=${status.message}`)
        const stalled = anchorFor(sid) ?? turns.get(sid)?.chain?.[0]
        if (stalled) {
          breakerFor(stalled).recordFailure()
          saveState()
        }
        const c = classifyError({ message: status?.message })
        if (c.cls === "quota" || c.detail === "quota") {
          logLine(`parent ${sid}: retry status indicates quota exhaustion ("${status.message}") — aborting and re-prompting immediately`)
          if (typeof client?.session?.abort === "function") {
            try {
              await client.session.abort({ path: { id: sid } })
            } catch (e: any) {
              logLine(`parent ${sid}: abort failed: ${e?.message ?? e}`)
            }
          }
          await reprompt(sid)
        }
      }
      return
    }

    // Liveness stamping is unconditional: child attempts register for the sweep
    // even when the parent watchdog is off, and they need these events.
    if (type === "message.part.updated") {
      const part = ev?.properties?.part
      const sid: string | undefined = part?.sessionID
      if (sid) stampAlive(sid)

      // Detect streaming errors (rate limits, etc.) via RetryPart
      if (part?.type === "retry" && part?.error && ROOT.parentWatchdog.enabled) {
        const c = classifyError(part.error)
        logLine(`parent ${sid}: stream error ${c.cls}${c.detail ? ` (${c.detail})` : ""}`)
        const lastErr = lastParentErrorAt.get(sid!) ?? 0
        if (now() - lastErr >= debounceMs && (c.cls === "quota" || c.cls === "transient" || c.cls === "provider_level") && !c.ours) {
          lastParentErrorAt.set(sid!, now())
          if (!turns.has(sid!)) {
            let currentModel: string | undefined
            let agent = ""
            let parts: any[] = []
            let usedTokens = 0
            try {
              const msgs: any = await client.session.messages({ path: { id: sid }, throwOnError: true }).catch(() => null)
              const allMsgs = msgs?.data ?? []
              for (let i = allMsgs.length - 1; i >= 0; i--) {
                const m = allMsgs[i]
                if (!currentModel && m?.info?.model?.providerID && m?.info?.model?.modelID) {
                  currentModel = `${m.info.model.providerID}/${m.info.model.modelID}`
                }
                if (!agent && m?.info?.agent && m.info.agent !== "compaction") agent = m.info.agent
                if (usedTokens === 0 && m?.info?.role === 'assistant' && m?.info?.tokens?.input) {
                  usedTokens = m.info.tokens.input
                }
              }
              parts = extractLastUserParts(allMsgs)
            } catch {}
            if (!currentModel) {
              try {
                const cfg: any = (await client.config.get({ throwOnError: true }))?.data
                if (agent && cfg?.agent?.[agent]?.model) currentModel = cfg.agent[agent].model
              } catch {}
            }
            if (currentModel) {
              if (!agent) agent = "developer"
              const fb = loadFallback(directory)
              const agentFb = fb.agents?.[agent] ?? fb.agents?.["compaction"]
              const chain: string[] = [currentModel]
              for (const e of agentFb?.fallback ?? fb.defaultFallback ?? []) chain.push(typeof e === "string" ? e : e.model)
              turns.set(sid!, { chain: [...new Set(chain)], parts, agent, rePrompts: 0, usedTokens, partialResponse: "", responseStarted: false, responseStartTime: 0, lastTokenAt: 0, triedModels: new Set([currentModel]) })
              logLine(`parent ${sid}: built chain on-the-fly from stream error (agent=${agent}, model=${currentModel}, parts=${parts.length}, usedTokens=${usedTokens})`)
            }
          }
          const failed = anchorFor(sid!) ?? turns.get(sid!)?.chain?.[0]
          if (failed) {
            breakerFor(failed).recordFailure()
            saveState()
          }
          void reprompt(sid!)
        }
      }
      return
    }
    if (!ROOT.parentWatchdog.enabled) return
    if (type === "message.updated") {
      const info = ev?.properties?.info
      const sid: string | undefined = info?.sessionID
      if (sid) stampAlive(sid)
      if (sid && info?.role === "assistant" && info?.time?.completed != null && !info?.error) {
        unregisterLiveness(sid)
      }

      // Update used tokens for context-size filtering in nextHealthy.
      const used: number | undefined = info?.tokens?.input
      if (sid && used !== undefined && used > 0) {
        const st = turns.get(sid)
        if (st) st.usedTokens = used
      }

      // Error detection: if the assistant message has an error, trigger
      // parent-level fallback (same as session.error). This catches cases
      // where session.error event doesn't fire but message.updated does.
      if (info?.role === "assistant" && info?.error) {
        const c = classifyError(info.error)
        logLine(`parent ${sid}: message.updated error ${c.cls}${c.detail ? ` (${c.detail})` : ""}`)
        // Debounce: don't re-prompt more than once every 5s
        const lastErr = lastParentErrorAt.get(sid!) ?? 0
        if (now() - lastErr >= debounceMs && (c.cls === "quota" || c.cls === "transient" || c.cls === "provider_level") && !c.ours) {
          lastParentErrorAt.set(sid!, now())
          // Build turns on-the-fly if missing (same as session.error handler)
          if (!turns.has(sid!)) {
            let currentModel: string | undefined
            let agent = ""
            let parts: any[] = []
            let usedTokens = 0
            try {
              const msgs: any = await client.session.messages({ path: { id: sid }, throwOnError: true }).catch(() => null)
              const allMsgs = msgs?.data ?? []
              for (let i = allMsgs.length - 1; i >= 0; i--) {
                const m = allMsgs[i]
                if (!currentModel && m?.info?.model?.providerID && m?.info?.model?.modelID) {
                  currentModel = `${m.info.model.providerID}/${m.info.model.modelID}`
                }
                if (!agent && m?.info?.agent && m.info.agent !== "compaction") agent = m.info.agent
            if (usedTokens === 0 && m?.info?.role === 'assistant' && m?.info?.tokens?.input) {
              usedTokens = m.info.tokens.input
            }
              }
              parts = extractLastUserParts(allMsgs)
            } catch {}
            if (!currentModel) {
              try {
                const cfg: any = (await client.config.get({ throwOnError: true }))?.data
                if (agent && cfg?.agent?.[agent]?.model) currentModel = cfg.agent[agent].model
              } catch {}
            }
            if (currentModel) {
              if (!agent) agent = "developer"
              const fb = loadFallback(directory)
              const agentFb = fb.agents?.[agent] ?? fb.agents?.["compaction"]
              const chain: string[] = [currentModel]
              for (const e of agentFb?.fallback ?? fb.defaultFallback ?? []) chain.push(typeof e === "string" ? e : e.model)
              turns.set(sid!, { chain: [...new Set(chain)], parts, agent, rePrompts: 0, usedTokens, partialResponse: "", responseStarted: false, responseStartTime: 0, lastTokenAt: 0, triedModels: new Set([currentModel]) })
              logLine(`parent ${sid}: built chain on-the-fly from message.updated (agent=${agent}, model=${currentModel}, parts=${parts.length}, usedTokens=${usedTokens})`)
            }
          }
          const failed = anchorFor(sid!) ?? turns.get(sid!)?.chain?.[0]
          if (failed) {
            breakerFor(failed).recordFailure()
            saveState()
          }
          void reprompt(sid!)
        }
        return
      }

      // Proactive self-compaction: the model in the seat summarizes its OWN
      // session at compactionRatio. Never delegates compaction to another
      // model — that is the "primary forgets" failure we refuse.
      const model = `${info?.providerID}/${info?.modelID}`
      const limit = modelLimits.get(model)
      const usedTokens: number | undefined = info?.tokens?.input
      if (!sid || limit === undefined || usedTokens === undefined) return
      if (usedTokens < limit * ROOT.compactionRatio) return
      const last = lastCompactAt.get(sid) ?? 0
      if (now() - last < compactDebounceMs) return // debounce: compactionDebounceMs
      lastCompactAt.set(sid, now())
      const [providerID, modelID] = splitModel(model)
      logLine(`parent ${sid}: ${Math.round((usedTokens / limit) * 100)}% of ${model} — self-compacting at ${ROOT.compactionRatio * 100}%`)
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
      logLine(`parent ${ev?.properties?.sessionID}: EVENT session.error=${JSON.stringify(ev?.properties).slice(0,200)}`)
      const sid: string | undefined = ev?.properties?.sessionID
      if (!sid) return
      const lastErr = lastParentErrorAt.get(sid) ?? 0
      if (now() - lastErr < debounceMs) return
      lastParentErrorAt.set(sid, now())
      const c = classifyError(ev?.properties?.error)
      // If turns doesn't have this session (chat.message never fired or didn't
      // capture it), build the chain on-the-fly so the watchdog can still
      // re-prompt instead of silently returning.
      if (!turns.has(sid)) {
        const anchor = anchorFor(sid)
        // anchorFor is usually undefined for parent sessions (only set after
        // a successful smart_task). Fall back to the session's last model or
        // the agent's configured model.
        let currentModel = anchor
        let agent = ""
        let parts: any[] = []
        let usedTokens = 0
        try {
          const msgs: any = await client.session.messages({ path: { id: sid }, throwOnError: true }).catch(() => null)
          const allMsgs = msgs?.data ?? []
          // Find the last assistant or user message with a model.
          for (let i = allMsgs.length - 1; i >= 0; i--) {
            const m = allMsgs[i]
            if (!currentModel && m?.info?.model?.providerID && m?.info?.model?.modelID) {
              currentModel = `${m.info.model.providerID}/${m.info.model.modelID}`
            }
            if (!agent && m?.info?.agent && m.info.agent !== "compaction") agent = m.info.agent
          }
          parts = extractLastUserParts(allMsgs)
        } catch {}
        if (!currentModel) {
          // Last resort: use the agent's configured model from opencode config.
          try {
            const cfg: any = (await client.config.get({ throwOnError: true }))?.data
            if (agent && cfg?.agent?.[agent]?.model) currentModel = cfg.agent[agent].model
          } catch {}
        }
        if (!currentModel) {
          logLine(`parent ${sid}: ${c.cls} — no model available, cannot re-prompt`)
          return
        }
        if (!agent) agent = "developer"
        const fb = loadFallback(directory)
        const agentFb = fb.agents?.[agent] ?? fb.agents?.["compaction"]
        const chain: string[] = [currentModel]
        for (const e of agentFb?.fallback ?? fb.defaultFallback ?? []) chain.push(typeof e === "string" ? e : e.model)
        turns.set(sid, { chain: [...new Set(chain)], parts, agent, rePrompts: 0, usedTokens, partialResponse: "", responseStarted: false, responseStartTime: 0, lastTokenAt: 0, triedModels: new Set([currentModel]) })
        logLine(`parent ${sid}: built chain on-the-fly (agent=${agent}, model=${currentModel}, parts=${parts.length}, usedTokens=${usedTokens})`)
      }
      logLine(`parent ${sid}: ${c.cls}${c.detail ? ` (${c.detail})` : ""}`)
      const failed = anchorFor(sid) ?? turns.get(sid)?.chain?.[0]
      if (failed && !c.ours) {
        if (c.cls === "quota" || c.cls === "transient" || c.cls === "provider_level") {
          breakerFor(failed).recordFailure()
          saveState()
          // Re-prompt on the next healthy model in the chain, same as onStall.
          await reprompt(sid)
        } else if (c.cls === "context_too_large") {
          // Context overflow: force compaction via largeContextFallback or re-prompt on next healthy large model
          logLine(`parent ${sid}: context overflow detected in session.error — triggering compaction/reprompt`)
          await reprompt(sid, { isContextOverflow: true })
        }
      }
    }
  }

  const onChatMessage = async (input: any, output: any) => {
    const sid: string | undefined = input?.sessionID
    const explicitAgent = input?.agent
    const current = output?.message?.model
    if (!sid || !current?.providerID || !current?.modelID) return
    const currentModel = `${current.providerID}/${current.modelID}`

    // Get or create turn state, tracking the effective agent for fallback
    let st = turns.get(sid)
    const isCompaction = explicitAgent === "compaction"
    const effectiveAgent = isCompaction ? (st?.agent ?? "developer") : (explicitAgent ?? st?.agent ?? "developer")
    const fb = loadFallback(directory)
    const agentFb = fb.agents?.[effectiveAgent] ?? (isCompaction ? fb.agents?.["compaction"] : undefined)

    let chainRaw: string[] = []
    if (isCompaction) {
      const largeAnchor = agentFb?.largeContextModel ?? fb.agents?.["compaction"]?.largeContextModel ?? fb.defaultLargeContextModel ?? currentModel
      chainRaw.push(largeAnchor)
      if (currentModel && currentModel !== largeAnchor) chainRaw.push(currentModel)
      for (const e of agentFb?.largeContextFallback ?? agentFb?.fallback ?? fb.agents?.["compaction"]?.largeContextFallback ?? fb.defaultLargeContextFallback ?? fb.defaultFallback ?? []) {
        chainRaw.push(typeof e === "string" ? e : e.model)
      }
    } else {
      chainRaw.push(currentModel)
      for (const e of agentFb?.fallback ?? fb.defaultFallback ?? []) chainRaw.push(typeof e === "string" ? e : e.model)
    }
    const chain = [...new Set(chainRaw)]

    if (!st) {
      turns.set(sid, {
        chain,
        parts: sanitizeParts(output?.parts),
        agent: effectiveAgent,
        rePrompts: 0,
        usedTokens: 0,
        partialResponse: "",
        responseStarted: false,
        responseStartTime: 0,
        lastTokenAt: 0,
        triedModels: new Set([currentModel]),
      })
      st = turns.get(sid)!
    } else {
      st.chain = chain
      const incomingParts = sanitizeParts(output?.parts)
      if (incomingParts.length > 0) st.parts = incomingParts
      if (explicitAgent && !isCompaction) st.agent = explicitAgent
      st.triedModels.clear()
      st.triedModels.add(currentModel)
    }

    setAnchor(sid, currentModel)

    // Pre-turn proactive model override:
    // If compaction turn, or if currentModel is already broken/quota blocked,
    // or if conversation size exceeds currentModel context limit:
    const b = breakerFor(currentModel)
    const bt = blockedUntil.get(currentModel)
    const curLimit = modelLimits.get(currentModel)
    const estTokens = st.usedTokens || undefined
    const isContextExceeded = curLimit !== undefined && estTokens !== undefined && estTokens > curLimit

    if (isCompaction || b.isOpen || (bt !== undefined && bt > now()) || isContextExceeded) {
      const healthy = nextHealthy(st.chain, isCompaction ? "" : currentModel, estTokens)
      if (healthy) {
        const [pID, mID] = splitModel(healthy)
        output.message.model = { providerID: pID, modelID: mID }
        setAnchor(sid, healthy)
        st.triedModels.add(healthy)
        const reason = isCompaction ? "compaction turn" : isContextExceeded ? `context overflow (~${estTokens} > ${curLimit})` : "cooldown/breaker"
        logLine(`parent ${sid}: proactively switched starting model from ${currentModel} to ${healthy} (${reason})`)
      }
    }

    const effectiveModel = `${output.message.model.providerID}/${output.message.model.modelID}`
    const pcfg = providerCfg(effectiveModel)
    registerLiveness(sid, {
      startedAt: now(),
      lastPartAt: now(),
      firstTokenMs: pcfg.firstTokenMs ?? ROOT.parentWatchdog.firstTokenMs,
      stallTimeoutMs: pcfg.stallTimeoutMs ?? ROOT.parentWatchdog.stallTimeoutMs,
      onStall: (s) => void reprompt(s),
    })
  }

  return { onEvent, onChatMessage }
}

// ── Plugin ──────────────────────────────────────────────────────────────────

const plugin: Plugin = async (input: PluginInput) => {
  const { client, directory } = input
  if (!isTestRoot) {
    ROOT = loadRoot(directory)
  }
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
      const fb = loadFallback(directory)
      const agentFb = fb.agents?.[subagent_type]
      const agentConfig = cfg?.agent?.[subagent_type] ?? cfg?.agents?.[subagent_type]
      if (!agentConfig && !agentFb) {
        return { title: description, output: `Unknown agent type: ${subagent_type}`, metadata: { error: true } }
      }

      const chainRaw: string[] = []
      if (agentConfig?.model) chainRaw.push(agentConfig.model)
      for (const e of agentFb?.fallback ?? fb.defaultFallback ?? []) chainRaw.push(typeof e === "string" ? e : e.model)
      const chain = [...new Set(chainRaw)]
      if (chain.length === 0) {
        return { title: description, output: `No models configured for agent ${subagent_type}`, metadata: { error: true } }
      }

      let sessionId: string
      try {
        const createBody: any = { title: `${description} (@${subagent_type} subagent)` }
        if (context?.sessionID) createBody.parentID = context.sessionID

        if (task_id) {
          const msgs: any = await client.session.messages({ path: { id: task_id }, throwOnError: true }).catch(() => null)
          const hasWork = (msgs?.data ?? []).some((m: any) => m?.info?.role === "assistant")
          if (hasWork) {
            sessionId = task_id
          } else {
            const created: any = await client.session.create({
              body: createBody,
              throwOnError: true,
            })
            sessionId = created?.data?.id ?? created?.id
          }
        } else {
          const created: any = await client.session.create({
            body: createBody,
            throwOnError: true,
          })
          sessionId = created?.data?.id ?? created?.id
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
        estimateTokens: estimateTokens(prompt) + (await getSessionTokens(client, sessionId)),
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
            const completion = checkCompletion(res?.data ?? res)
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

  setupFetchInterceptor(directory)

  if (ROOT.parentWatchdog.enabled) {
    const wd = setupParentWatchdog(client, directory)
    // The watchdog's superset handler already stamps liveness first.
    hooks.event = async (input: any) => {
      const event = input?.event ?? input
      await wd.onEvent(event as any)
    }
    hooks["chat.message"] = async (input, output) => wd.onChatMessage(input, output)
  }

  return hooks
}

export default plugin
