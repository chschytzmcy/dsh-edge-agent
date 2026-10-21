/**
 * edge-config — the single read point for dsh-edge-agent runtime settings.
 *
 * §7.102 (2026-10-21): replaces the two previous chains:
 *
 *   old:  .env (bare names)  →  .env.sh (export DSH_EDGE_* derived)  →  cordis.patch.yml
 *         (process.env.DSH_EDGE_LOCAL_LLM_BASEURL, etc.)
 *
 *   new:  config/edge.json  →  this loader  →  plugin Config
 *
 * Why the old chain could not serve every profile:
 *
 *   - dsh-tui / dsh-web / dsh-edge (CLI): install.sh sourced
 *     ~/.dsh/profiles/<p>/.env.sh, so the derived DSH_EDGE_* vars were
 *     present in the process env.
 *   - desktop (DeepSeek Harness.exe, Electron): started by the GUI, never
 *     goes through install.sh, so process.env had none of them. Every
 *     `!!js process.env.DSH_EDGE_LOCAL_LLM_BASEURL || undefined` in the
 *     patch resolved to undefined and the plugin fell back to its Schema
 *     default (127.0.0.1:8080 — a port owned by an unrelated daemon).
 *
 * The new chain has no process-level dependency: the plugin reads the JSON
 * file itself, so a file that ships inside the bundle works identically in
 * every profile.
 *
 * Lookup order (first hit wins):
 *   1. <bundle root>/config/edge.json  — resolved relative to this module,
 *      so it works for the CLI (repo checkout) and for the desktop (the
 *      bundle is copied into the profile's node_modules).
 *   2. ~/.dsh-edge-agent/edge.json      — the installed-override location
 *      (same convention as ~/.dsh-edge-agent/privacy-policy.json).
 *   3. built-in defaults                — see DEFAULT_* below.
 *
 * The loader is deliberately read-only and synchronous: config is read once
 * at plugin apply() time. Hot reload is the caller's job (privacy-policy
 * already implements its own watcher for its own file).
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/* ── Shape ─────────────────────────────────────────────────────────────── */

export interface EdgeSecrets {
  edgeApiKey?: string
  deepseekApiKey?: string
  dashscopeApiKey?: string
  tavilyApiKey?: string
  bochaApiKey?: string
}

export interface EdgeLlmPool {
  baseUrl?: string
  model?: string
  /** Name of a key inside EdgeSecrets. The literal value is never stored
   *  twice — the pool points at the secret, the loader resolves it. */
  keyRef?: string
  stripTools?: boolean
  enableThinking?: boolean
}

export interface EdgeCloudPool extends EdgeLlmPool {
  delegate?: boolean
  delegateProvider?: string
  delegateModel?: string
}

export interface EdgeStage {
  provider?: string
  model?: string
  /** intent-router: category used when no LLM verdict and no keyword matched. */
  defaultCategory?: string
  enabled?: boolean
  timeoutMs?: number
  maxInput?: number
  confidenceThreshold?: number
  recentLimit?: number
  cloudKeywords?: string[]
  localEntities?: string[]
  fallbackKeywords?: string[]
}

export interface EdgeJevConfig {
  enabled?: boolean
  url?: string
  timeoutMs?: number
  confidenceThreshold?: number
  riskThreshold?: number
  breakerTtlMs?: number
  bootProbeEnabled?: boolean
  bootProbeTimeoutMs?: number
  breakerProbeMs?: number
  probeTimeoutMs?: number
}

export interface EdgeFunctionCallExternalConfig {
  enabled?: boolean
  url?: string
  timeoutMs?: number
  confidenceThreshold?: number
  breakerTtlMs?: number
  bootProbeEnabled?: boolean
  bootProbeTimeoutMs?: number
  breakerProbeMs?: number
  probeTimeoutMs?: number
}

export interface EdgePrivacyConfig {
  inputGuardEnabled?: boolean
  rejectPolicyEnabled?: boolean
  sanitizeDowngradeEnabled?: boolean
  realmHotReload?: boolean
  realmWatchMs?: number
  policyPath?: string
  policyHotReload?: boolean
  policyWatchMs?: number
  /** Sanitizer session-mapping lifetime (ms). */
  sanTtlMs?: number
  /** Max concurrent sanitizer session mappings before LRU eviction. */
  sanMaxSessions?: number
  /** Sanitizer sweep interval (ms). */
  sanSweepMs?: number
}

export interface EdgeResourcesConfig {
  maxSessions?: number
  maxBodyBytes?: number
  sessionIdleMs?: number
  sanMaxSessions?: number
  sanSweepMs?: number
  sanTtlMs?: number
}

export interface EdgeAuditConfig {
  minLevel?: string
  flushMs?: number
  logLevel?: string
  logMaxAgeDays?: number
  logMaxRotated?: number
  logRoot?: string
}

export interface EdgeTeeConfig {
  type?: string
  storageRoot?: string
}

export interface EdgeThreatConfig {
  cloudRate?: number
  blockLevel?: string
}

export interface EdgeWebSearchConfig {
  tavilyEnabled?: boolean
  bochaEnabled?: boolean
}

export interface EdgeAgentConfig {
  persona?: string
  localToolsWritable?: boolean
  localToolsAllowlist?: string
  permissionMode?: string
}

export interface EdgeConfig {
  secrets?: EdgeSecrets
  http?: { host?: string; port?: number }
  llm?: { local?: EdgeLlmPool; cloud?: EdgeCloudPool }
  stages?: { guard?: EdgeStage; intent?: EdgeStage }
  jev?: EdgeJevConfig
  functionCallExternal?: EdgeFunctionCallExternalConfig
  privacy?: EdgePrivacyConfig
  resources?: EdgeResourcesConfig
  audit?: EdgeAuditConfig
  tee?: EdgeTeeConfig
  threat?: EdgeThreatConfig
  webSearch?: EdgeWebSearchConfig
  agent?: EdgeAgentConfig
}

/* ── Defaults (last-resort fallbacks; no local endpoints) ─────────────── */

export const DEFAULT_EDGE_CONFIG: EdgeConfig = {
  secrets: {},
  http: { host: '127.0.0.1', port: 21017 },
  llm: {
    // No baseUrl → the local-LLM route is simply not registered. A hard-coded
    // port here collided with unrelated daemons (see local-llm-adapter.ts
    // Config.baseUrl docs), so "unset" is the only safe default.
    //
    // The model is deliberately left unset: each plugin owns its own Schema
    // default (local-llm-adapter says 'qwen3-4b', http-api's route fallback
    // says 'qwen3-4b-instruct-2507'). A single default here would silently
    // override the plugin's own value.
    local: { stripTools: false, enableThinking: false },
    cloud: { delegate: true },
  },
  stages: {
    guard: { provider: 'local-llm', enabled: true, timeoutMs: 20000, maxInput: 2000 },
    intent: {
      provider: 'local-llm',
      timeoutMs: 30000,
      confidenceThreshold: 0.6,
      maxInput: 2000,
      recentLimit: 3,
      cloudKeywords: [],
      localEntities: [],
      fallbackKeywords: [],
    },
  },
  jev: {
    enabled: true,
    url: 'http://127.0.0.1:8001',
    timeoutMs: 2500,
    confidenceThreshold: 0.85,
    riskThreshold: 0.7,
    breakerTtlMs: 30000,
    bootProbeEnabled: true,
    bootProbeTimeoutMs: 2000,
    breakerProbeMs: 5000,
    probeTimeoutMs: 1000,
  },
  functionCallExternal: {
    // Code-level fallback = the historical Schema defaults (function-call-
    // external.test.ts EXPECTED_DEFAULTS pins them). Deployment values such
    // as the 15000 ms needle timeout live in config/edge.json instead.
    enabled: false,
    url: 'http://127.0.0.1:8081',
    timeoutMs: 10000,
    confidenceThreshold: 0.5,
    breakerTtlMs: 30000,
    bootProbeEnabled: true,
    bootProbeTimeoutMs: 2000,
    breakerProbeMs: 5000,
    probeTimeoutMs: 2000,
  },
  privacy: {
    inputGuardEnabled: true,
    rejectPolicyEnabled: true,
    sanitizeDowngradeEnabled: true,
    realmHotReload: true,
    realmWatchMs: 5000,
    policyHotReload: true,
    policyWatchMs: 5000,
  },
  resources: {
    maxSessions: 100,
    maxBodyBytes: 1048576,
    sessionIdleMs: 1800000,
    sanMaxSessions: 1000,
    sanSweepMs: 60000,
    sanTtlMs: 900000,
  },
  audit: {
    minLevel: 'info',
    flushMs: 1000,
    logLevel: 'info',
    logMaxAgeDays: 1,
    logMaxRotated: 7,
  },
  tee: { type: 'simulated' },
  threat: { cloudRate: 20, blockLevel: 'critical' },
  webSearch: { tavilyEnabled: true, bochaEnabled: true },
  agent: {
    persona: 'You are edge-agent, a privacy-first AI assistant running on the user\'s device.',
    localToolsWritable: true,
    permissionMode: 'workspace-write',
  },
}

/* ── Loading ──────────────────────────────────────────────────────────── */

let cached: EdgeConfig | undefined
let cachedPath: string | undefined

/** Candidate paths, in priority order. */
export function edgeConfigCandidates(): string[] {
  // §7.102: DSH_EDGE_CONFIG_FILE=off disables file-based configuration
  // entirely. Unit tests set it so a developer's local config/edge.json
  // (real endpoints, real API keys) cannot leak into the assertions — the
  // suite must be reproducible on any machine.
  if (typeof process !== 'undefined' && process.env?.DSH_EDGE_CONFIG_FILE === 'off') {
    return []
  }
  const here = dirname(fileURLToPath(import.meta.url))
  // src/dsh-adapter/ → repo root (dev) or bundle root (installed)
  const bundleRoot = resolve(here, '..', '..')
  const home = homedir()
  return [
    join(bundleRoot, 'config', 'edge.json'),
    join(home, '.dsh-edge-agent', 'edge.json'),
    // The shipped template is the last resort: it carries the same shape
    // with blank secrets and the documented defaults, so a fresh checkout
    // still boots with a coherent configuration.
    join(bundleRoot, 'config', 'edge.example.json'),
  ]
}

/** Path of the file that was actually loaded, or undefined when defaults
 *  are in use. Exposed for diagnostics / audit. */
export function edgeConfigPath(): string | undefined {
  return cachedPath
}

/**
 * Env override layer.
 *
 * The file (config/edge.json) is the source of truth, but the historical
 * DSH_EDGE_* env vars stay usable as a per-process override — CI jobs,
 * one-off debugging, and the existing unit tests all rely on them. An env
 * var only wins when it is actually set; when it is absent the file value
 * is used. This keeps the migration non-breaking in both directions.
 */
const ENV_OVERRIDES: Array<{
  env: string
  apply: (cfg: EdgeConfig, value: string) => void
}> = [
  {
    env: 'DSH_EDGE_LOCAL_LLM_BASEURL',
    apply: (cfg, v) => { cfg.llm!.local!.baseUrl = v },
  },
  {
    env: 'DSH_EDGE_LOCAL_LLM_MODEL',
    apply: (cfg, v) => { cfg.llm!.local!.model = v },
  },
  {
    env: 'DSH_EDGE_LOCAL_LLM_KEY_ENV',
    apply: (cfg, v) => { cfg.llm!.local!.keyRef = v },
  },
  {
    env: 'DSH_EDGE_CLOUD_LLM_BASEURL',
    apply: (cfg, v) => { cfg.llm!.cloud!.baseUrl = v },
  },
  {
    env: 'DSH_EDGE_CLOUD_KEY_ENV',
    apply: (cfg, v) => { cfg.llm!.cloud!.keyRef = v },
  },
  {
    env: 'DSH_EDGE_CLOUD_DELEGATE',
    apply: (cfg, v) => { cfg.llm!.cloud!.delegate = v !== 'false' },
  },
  {
    env: 'DSH_EDGE_CLOUD_DELEGATE_PROVIDER',
    apply: (cfg, v) => { cfg.llm!.cloud!.delegateProvider = v },
  },
  {
    env: 'DSH_EDGE_CLOUD_DELEGATE_MODEL',
    apply: (cfg, v) => { cfg.llm!.cloud!.delegateModel = v },
  },
  {
    env: 'DSH_EDGE_MODEL',
    apply: (cfg, v) => { cfg.llm!.cloud!.model = v },
  },
  {
    env: 'EDGE_API_KEY',
    apply: (cfg, v) => { cfg.secrets!.edgeApiKey = v },
  },
  {
    env: 'DSH_EDGE_HTTP_HOST',
    apply: (cfg, v) => { cfg.http!.host = v },
  },
  {
    env: 'DSH_EDGE_HTTP_PORT',
    apply: (cfg, v) => { cfg.http!.port = Number(v) },
  },
  {
    env: 'DSH_EDGE_AUDIT_MIN_LEVEL',
    apply: (cfg, v) => { cfg.audit!.minLevel = v },
  },
  {
    env: 'DSH_EDGE_AUDIT_FLUSH_MS',
    apply: (cfg, v) => { cfg.audit!.flushMs = Number(v) },
  },
  {
    env: 'DSH_EDGE_LOG_LEVEL',
    apply: (cfg, v) => { cfg.audit!.logLevel = v },
  },
  {
    env: 'DSH_EDGE_LOG_MAX_AGE_DAYS',
    apply: (cfg, v) => { cfg.audit!.logMaxAgeDays = Number(v) },
  },
  {
    env: 'DSH_EDGE_LOG_MAX_ROTATED',
    apply: (cfg, v) => { cfg.audit!.logMaxRotated = Number(v) },
  },
  {
    env: 'DSH_EDGE_MAX_SESSIONS',
    apply: (cfg, v) => { cfg.resources!.maxSessions = Number(v) },
  },
  {
    env: 'DSH_EDGE_MAX_BODY_BYTES',
    apply: (cfg, v) => { cfg.resources!.maxBodyBytes = Number(v) },
  },
  {
    env: 'DSH_EDGE_SESSION_IDLE_MS',
    apply: (cfg, v) => { cfg.resources!.sessionIdleMs = Number(v) },
  },
  {
    env: 'DSH_EDGE_TEE_TYPE',
    apply: (cfg, v) => { cfg.tee!.type = v },
  },
  {
    env: 'DSH_EDGE_PERMISSION_MODE',
    apply: (cfg, v) => { cfg.agent!.permissionMode = v },
  },
  {
    env: 'DSH_EDGE_REALM_HOT_RELOAD',
    apply: (cfg, v) => { cfg.privacy!.realmHotReload = v !== 'false' },
  },
  {
    env: 'DSH_EDGE_REALM_WATCH_MS',
    apply: (cfg, v) => { cfg.privacy!.realmWatchMs = Number(v) },
  },
  {
    env: 'DSH_EDGE_POLICY_HOT_RELOAD',
    apply: (cfg, v) => { cfg.privacy!.policyHotReload = v !== 'false' },
  },
  {
    env: 'DSH_EDGE_POLICY_WATCH_MS',
    apply: (cfg, v) => { cfg.privacy!.policyWatchMs = Number(v) },
  },
  {
    env: 'DSH_EDGE_INTENT_JEV_CONFIDENCE_THRESHOLD',
    apply: (cfg, v) => { cfg.jev!.confidenceThreshold = Number(v) },
  },
  {
    env: 'DSH_EDGE_INTENT_JEV_RISK_THRESHOLD',
    apply: (cfg, v) => { cfg.jev!.riskThreshold = Number(v) },
  },
  {
    env: 'DSH_EDGE_INTENT_JEV_BREAKER_TTL_MS',
    apply: (cfg, v) => { cfg.jev!.breakerTtlMs = Number(v) },
  },
  {
    env: 'DSH_EDGE_INTENT_JEV_BOOT_PROBE_ENABLED',
    apply: (cfg, v) => { cfg.jev!.bootProbeEnabled = v !== 'false' },
  },
  {
    env: 'DSH_EDGE_INTENT_JEV_BOOT_PROBE_TIMEOUT_MS',
    apply: (cfg, v) => { cfg.jev!.bootProbeTimeoutMs = Number(v) },
  },
  {
    env: 'DSH_EDGE_INTENT_JEV_BREAKER_PROBE_MS',
    apply: (cfg, v) => { cfg.jev!.breakerProbeMs = Number(v) },
  },
  {
    env: 'DSH_EDGE_INTENT_JEV_PROBE_TIMEOUT_MS',
    apply: (cfg, v) => { cfg.jev!.probeTimeoutMs = Number(v) },
  },
  {
    env: 'DSH_EDGE_GUARD_MODEL',
    apply: (cfg, v) => { cfg.stages!.guard!.enabled = v !== 'false' },
  },
  {
    env: 'DSH_EDGE_GUARD_MODEL_PROVIDER',
    apply: (cfg, v) => { cfg.stages!.guard!.provider = v },
  },
  {
    env: 'DSH_EDGE_GUARD_MODEL_MODEL',
    apply: (cfg, v) => { cfg.stages!.guard!.model = v },
  },
  {
    env: 'DSH_EDGE_INTENT_PROVIDER',
    apply: (cfg, v) => { cfg.stages!.intent!.provider = v },
  },
  {
    env: 'DSH_EDGE_INTENT_MODEL',
    apply: (cfg, v) => { cfg.stages!.intent!.model = v },
  },
  {
    env: 'DSH_EDGE_INTENT_CONFIDENCE_THRESHOLD',
    apply: (cfg, v) => { cfg.stages!.intent!.confidenceThreshold = Number(v) },
  },
  {
    env: 'DSH_EDGE_INTENT_LLM_TIMEOUT_MS',
    apply: (cfg, v) => { cfg.stages!.intent!.timeoutMs = Number(v) },
  },
  {
    env: 'DSH_EDGE_INTENT_RECENT_LIMIT',
    apply: (cfg, v) => { cfg.stages!.intent!.recentLimit = Number(v) },
  },
  {
    env: 'DSH_EDGE_INTENT_MAX_INPUT',
    apply: (cfg, v) => { cfg.stages!.intent!.maxInput = Number(v) },
  },
  {
    env: 'DSH_EDGE_INTENT_CLOUD_KEYWORDS',
    apply: (cfg, v) => { cfg.stages!.intent!.cloudKeywords = v.split(',').filter(Boolean) },
  },
  {
    env: 'DSH_EDGE_INTENT_LOCAL_ENTITIES',
    apply: (cfg, v) => { cfg.stages!.intent!.localEntities = v.split(',').filter(Boolean) },
  },
  {
    env: 'DSH_EDGE_INTENT_FALLBACK_KEYWORDS',
    apply: (cfg, v) => { cfg.stages!.intent!.fallbackKeywords = v.split(',').filter(Boolean) },
  },
  {
    env: 'DSH_EDGE_INTENT_JEV_ENABLED',
    apply: (cfg, v) => { cfg.jev!.enabled = v !== 'false' },
  },
  {
    env: 'DSH_EDGE_INTENT_JEV_URL',
    apply: (cfg, v) => { cfg.jev!.url = v },
  },
  {
    env: 'DSH_EDGE_INTENT_JEV_TIMEOUT_MS',
    apply: (cfg, v) => { cfg.jev!.timeoutMs = Number(v) },
  },
  {
    env: 'DSH_EDGE_INPUT_GUARD',
    apply: (cfg, v) => { cfg.privacy!.inputGuardEnabled = v !== 'false' },
  },
  {
    env: 'DSH_EDGE_REJECT_POLICY',
    apply: (cfg, v) => { cfg.privacy!.rejectPolicyEnabled = v !== 'false' },
  },
  {
    env: 'DSH_EDGE_SANITIZE_DOWNGRADE',
    apply: (cfg, v) => { cfg.privacy!.sanitizeDowngradeEnabled = v !== 'false' },
  },
  {
    env: 'DSH_EDGE_SAN_TTL_MS',
    apply: (cfg, v) => { cfg.privacy!.sanTtlMs = Number(v) },
  },
  {
    env: 'DSH_EDGE_SAN_MAX_SESSIONS',
    apply: (cfg, v) => { cfg.privacy!.sanMaxSessions = Number(v) },
  },
  {
    env: 'DSH_EDGE_SAN_SWEEP_MS',
    apply: (cfg, v) => { cfg.privacy!.sanSweepMs = Number(v) },
  },
  {
    env: 'DSH_EDGE_TD_CLOUD_RATE',
    apply: (cfg, v) => { cfg.threat!.cloudRate = Number(v) },
  },
  {
    env: 'DSH_EDGE_TD_BLOCK_LEVEL',
    apply: (cfg, v) => { cfg.threat!.blockLevel = v },
  },
  {
    env: 'DSH_EDGE_FUNCTION_CALL_EXTERNAL_ENABLED',
    apply: (cfg, v) => { cfg.functionCallExternal!.enabled = v === 'true' },
  },
  {
    env: 'DSH_EDGE_FUNCTION_CALL_EXTERNAL_URL',
    apply: (cfg, v) => { cfg.functionCallExternal!.url = v },
  },
  {
    env: 'DSH_EDGE_FUNCTION_CALL_EXTERNAL_TIMEOUT_MS',
    apply: (cfg, v) => { cfg.functionCallExternal!.timeoutMs = Number(v) },
  },
  {
    env: 'DSH_EDGE_FUNCTION_CALL_EXTERNAL_CONFIDENCE_THRESHOLD',
    apply: (cfg, v) => { cfg.functionCallExternal!.confidenceThreshold = Number(v) },
  },
  {
    env: 'DSH_EDGE_LOCAL_LLM_STRIP_TOOLS',
    apply: (cfg, v) => { cfg.llm!.local!.stripTools = v === 'true' },
  },
  {
    env: 'DSH_EDGE_LOCAL_LLM_ENABLE_THINKING',
    apply: (cfg, v) => { cfg.llm!.local!.enableThinking = v === 'true' },
  },
]

/** A fresh deep copy of the built-in defaults. */
function deepCopyDefaults(): EdgeConfig {
  return {
    ...DEFAULT_EDGE_CONFIG,
    secrets: { ...DEFAULT_EDGE_CONFIG.secrets },
    http: { ...DEFAULT_EDGE_CONFIG.http },
    llm: {
      local: { ...DEFAULT_EDGE_CONFIG.llm!.local },
      cloud: { ...DEFAULT_EDGE_CONFIG.llm!.cloud },
    },
    stages: {
      guard: { ...DEFAULT_EDGE_CONFIG.stages!.guard },
      intent: { ...DEFAULT_EDGE_CONFIG.stages!.intent },
    },
    jev: { ...DEFAULT_EDGE_CONFIG.jev },
    functionCallExternal: { ...DEFAULT_EDGE_CONFIG.functionCallExternal },
    privacy: { ...DEFAULT_EDGE_CONFIG.privacy },
    resources: { ...DEFAULT_EDGE_CONFIG.resources },
    audit: { ...DEFAULT_EDGE_CONFIG.audit },
    tee: { ...DEFAULT_EDGE_CONFIG.tee },
    threat: { ...DEFAULT_EDGE_CONFIG.threat },
    webSearch: { ...DEFAULT_EDGE_CONFIG.webSearch },
    agent: { ...DEFAULT_EDGE_CONFIG.agent },
  }
}

/** Apply the env override layer on top of a freshly loaded config. */
function applyEnvOverrides(cfg: EdgeConfig): EdgeConfig {
  if (typeof process === 'undefined' || !process.env) return cfg
  for (const { env, apply } of ENV_OVERRIDES) {
    const value = process.env[env]
    if (value === undefined || value.length === 0) continue
    try {
      apply(cfg, value)
    } catch {
      // A malformed override must not take the whole config down.
    }
  }
  return cfg
}

/**
 * Load the effective configuration. Cached after the first call — callers
 * that need a re-read can call resetEdgeConfigCache().
 */
export function loadEdgeConfig(force = false): EdgeConfig {
  if (cached && !force) return cached
  for (const candidate of edgeConfigCandidates()) {
    if (!existsSync(candidate)) continue
    try {
      const raw = readFileSync(candidate, 'utf-8')
      const parsed = JSON.parse(raw) as EdgeConfig
      // Deep-merge so a partial file still inherits the defaults for the
      // sections it does not mention.
      const merged: EdgeConfig = {
        ...DEFAULT_EDGE_CONFIG,
        ...parsed,
        secrets: { ...DEFAULT_EDGE_CONFIG.secrets, ...parsed.secrets },
        http: { ...DEFAULT_EDGE_CONFIG.http, ...parsed.http },
        llm: {
          local: { ...DEFAULT_EDGE_CONFIG.llm!.local, ...parsed.llm?.local },
          cloud: { ...DEFAULT_EDGE_CONFIG.llm!.cloud, ...parsed.llm?.cloud },
        },
        stages: {
          guard: { ...DEFAULT_EDGE_CONFIG.stages!.guard, ...parsed.stages?.guard },
          intent: { ...DEFAULT_EDGE_CONFIG.stages!.intent, ...parsed.stages?.intent },
        },
        jev: { ...DEFAULT_EDGE_CONFIG.jev, ...parsed.jev },
        functionCallExternal: { ...DEFAULT_EDGE_CONFIG.functionCallExternal, ...parsed.functionCallExternal },
        privacy: { ...DEFAULT_EDGE_CONFIG.privacy, ...parsed.privacy },
        resources: { ...DEFAULT_EDGE_CONFIG.resources, ...parsed.resources },
        audit: { ...DEFAULT_EDGE_CONFIG.audit, ...parsed.audit },
        tee: { ...DEFAULT_EDGE_CONFIG.tee, ...parsed.tee },
        threat: { ...DEFAULT_EDGE_CONFIG.threat, ...parsed.threat },
        webSearch: { ...DEFAULT_EDGE_CONFIG.webSearch, ...parsed.webSearch },
        agent: { ...DEFAULT_EDGE_CONFIG.agent, ...parsed.agent },
      }
      cached = applyEnvOverrides(merged)
      cachedPath = candidate
      return cached
    } catch {
      // A malformed file must not take the whole bundle down — fall through
      // to the next candidate and eventually to the defaults.
    }
  }
  // Deep-copy before applying the env overrides: a shallow spread would
  // share the nested section objects with DEFAULT_EDGE_CONFIG, so an env
  // override would permanently mutate the module-level defaults and leak
  // into every later load (observed: a test that set DSH_EDGE_MODEL kept
  // seeing 'deepseek-flash' after the env was cleared).
  cached = applyEnvOverrides(deepCopyDefaults())
  cachedPath = undefined
  return cached
}

/** Drop the cache so the next loadEdgeConfig() re-reads from disk. */
export function resetEdgeConfigCache(): void {
  cached = undefined
  cachedPath = undefined
}

/* ── Typed accessors ──────────────────────────────────────────────────── */

/**
 * Merge one section of the edge config into a plugin's cordis Config.
 *
 * The cordis patch row no longer carries any local configuration (§7.102) —
 * it only declares the plugin. The plugin therefore fills its own Config
 * from this file at apply() time.
 *
 * @param section   which section of edge.json to read
 * @param mapping   config field name -> edge.json field name
 * @param target    the plugin's Config object, mutated in place
 * @param ctx       optional logger; when given, changes are logged
 */
export function mergeEdgeConfig<T extends Record<string, unknown>>(
  section: keyof EdgeConfig,
  mapping: Record<string, string>,
  target: T,
  logger?: { info?: (msg: string) => void },
): T {
  const cfg = loadEdgeConfig()
  const values = cfg[section] as Record<string, unknown> | undefined
  if (!values) return target
  // The generic T cannot be written through an index signature (TS2862), so
  // the mutation goes through a widened view of the same object.
  const sink = target as Record<string, unknown>
  for (const [configField, edgeField] of Object.entries(mapping)) {
    const value = values[edgeField]
    if (value === undefined || value === null) continue
    if (typeof value === 'string' && value.length === 0) continue
    if (sink[configField] === value) continue
    logger?.info?.(
      `[edge-config] ${section}.${edgeField} → ${configField}: `
      + `${String(sink[configField])} → ${String(value)}`,
    )
    sink[configField] = value
  }
  return target
}

/** Resolve a key reference (e.g. 'dashscopeApiKey') to its literal value. */

/** Resolve a key reference (e.g. 'dashscopeApiKey') to its literal value. */
export function resolveSecret(cfg: EdgeConfig, ref: string | undefined): string | undefined {
  if (!ref) return undefined
  const value = (cfg.secrets as Record<string, unknown> | undefined)?.[ref]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** The local-LLM pool with its secret resolved into an api key. */
export function localPool(cfg: EdgeConfig = loadEdgeConfig()): {
  baseUrl?: string
  model?: string
  apiKey?: string
  stripTools: boolean
  enableThinking: boolean
} {
  const pool = cfg.llm?.local ?? {}
  return {
    baseUrl: pool.baseUrl || undefined,
    model: pool.model || undefined,
    apiKey: resolveSecret(cfg, pool.keyRef),
    stripTools: pool.stripTools ?? false,
    enableThinking: pool.enableThinking ?? false,
  }
}

/** The cloud-LLM pool. Empty baseUrl means DELEGATE mode. */
export function cloudPool(cfg: EdgeConfig = loadEdgeConfig()): {
  baseUrl?: string
  model?: string
  apiKey?: string
  delegate: boolean
  delegateProvider?: string
  delegateModel?: string
} {
  const pool = cfg.llm?.cloud ?? {}
  return {
    baseUrl: pool.baseUrl || undefined,
    model: pool.model || undefined,
    apiKey: resolveSecret(cfg, pool.keyRef),
    delegate: pool.delegate ?? true,
    delegateProvider: pool.delegateProvider || undefined,
    delegateModel: pool.delegateModel || undefined,
  }
}

/**
 * The model an internal LLM stage should use.
 *
 * §7.100 privacy invariant: internal stages (guard detection, intent
 * classification) must only ever target the LOCAL pool. The stage config
 * may name a provider, but a cloud provider is refused here — sending the
 * raw user text to a cloud model would break the edge-side privacy promise.
 * The caller falls back to its keyword / regex rules when this returns
 * undefined and no local endpoint is reachable.
 */
export function stageModel(
  stage: 'guard' | 'intent',
  cfg: EdgeConfig = loadEdgeConfig(),
): { provider: string; model?: string } | undefined {
  const stageCfg = cfg.stages?.[stage]
  if (!stageCfg) return undefined
  const provider = stageCfg.provider || 'local-llm'
  if (provider !== 'local-llm') return undefined
  const model = stageCfg.model || localPool(cfg).model
  return { provider, model }
}
