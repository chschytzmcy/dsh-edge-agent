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

import { existsSync, readFileSync, statSync } from 'node:fs'
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
  /** §7.154: MiniMax 直连凭据（llm.cloud 的旧指向）。 */
  minimaxApiKey?: string
  /** §7.112: 百炼 MaaS（jev 判定模型）。 */
  bailianApiKey?: string
  /** §7.154: 阿里云 token-plan（当前 local/cloud 两池的凭据）。 */
  aliyuntokenplanApiKey?: string
  /**
   * §7.154: 运行员的槽位是**开放的** —— `resolveSecret` 按名字查表，
   * 声明式接口不该把新槽位挡在门外（运行时的 env 槽位名就是从槽位名派生的，
   * 见 scripts/edge-config-from-env.ts 的 fieldToEnvSlot）。
   */
  [slot: string]: string | undefined
}

export interface EdgeLlmPool {
  baseUrl?: string
  model?: string
  /** Name of a key inside EdgeSecrets. The literal value is never stored
   *  twice — the pool points at the secret, the loader resolves it. */
  keyRef?: string
  stripTools?: boolean
  enableThinking?: boolean
  /**
   * §7.106 (2026-10-23): send `reasoning_effort:"none"` when thinking is off.
   * ollama's /v1 layer HONORS this dialect (its probe fix); strict gateways
   * reject unknown params outright (minimax 400 "invalid params" — measured).
   * Opt-in per pool: true for ollama, omit/false for OpenAI-official-style
   * providers. Defaults to false — never surprise a gateway that 400s extras.
   */
  reasoningEffortNone?: boolean
  /**
   * §7.171 (2026-11-10): DELEGATE 模式（`llm.local` 与 `llm.cloud` 对称）。
   *
   * `baseUrl` 留空 = **转发宿主 profile 已配置的模型提供商**（桌面 GUI 选的那个），
   * 本仓不碰任何 secret；要 edge 自有直连池时填 `baseUrl` + `model` + `keyRef`。
   *
   * - `llm.cloud` 留空 ⇒ DELEGATE（§7.100 既有行为）
   * - `llm.local` 留空 ⇒ DELEGATE（§7.171 新增；此前是「整条路由不注册」）
   *
   * ⚠️ delegate 只改变「**谁提供模型**」，**不改变这一域的隐私口径**：
   * `cloud-llm` 是云池（脱敏 + 只带云段历史）；`local-llm` 是本地池
   * （不脱敏 + 带全部历史 —— §7.131 裁决的两条不对称规则）。
   */
  delegate?: boolean
  /** Delegate 模式：显式指定目标 provider route id（优先于宿主选择 / 探针）。 */
  delegateProvider?: string
  /** Delegate 模式：wire model 覆盖（压过宿主选择 / 探针模型）。 */
  delegateModel?: string
}

/**
 * `llm.cloud` 的形状 —— 与 `llm.local` 同构（§7.171 两池对称）。
 *
 * 用 type alias 而不是 `interface X extends Y {}`：后者在
 * `@typescript-eslint/no-empty-object-type` 下是违规写法。
 */
export type EdgeCloudPool = EdgeLlmPool

export interface EdgeStage {
  provider?: string
  model?: string
  /** intent-router: category used when no LLM verdict and no keyword matched. */
  defaultCategory?: string
  /** §7.115 (2026-10-25): decision-model-only mode — false = the LLM
   *  classifier never runs; jev skips go straight to rules + default. */
  llmFallback?: boolean
  enabled?: boolean
  timeoutMs?: number
  maxInput?: number
  confidenceThreshold?: number
  recentLimit?: number
  cloudKeywords?: string[]
  localEntities?: string[]
  fallbackKeywords?: string[]
  /** §7.124 (2026-10-27): 家庭设备操作正则层的扩展词表（追加到内置词表）。 */
  deviceCommands?: { devices?: string[]; actions?: string[] }
}

export interface EdgeJevConfig {
  enabled?: boolean
  url?: string
  /** §7.112 (2026-10-25): backend kind. 'local' = the ONNX /predict
   *  contract (default); 'bailian-decision' = Alibaba's decision-model
   *  /systemone structured-decision interface (POST {model, state,
   *  questions}). */
  provider?: 'local' | 'bailian-decision'
  /** §7.112: decision-model id (bailian-decision only, e.g.
   *  'decision-model-preview'). */
  model?: string
  /** §7.112: secrets keyRef carrying the Bailian MaaS key. */
  apiKeyRef?: string
  /** §7.112: how the key lands in the Authorization header. 'raw' =
   *  `Authorization: <key>` (the org's systemone examples use this);
   *  'bearer' = `Authorization: Bearer <key>` (DashScope compatible-mode
   *  convention). Default 'raw'. */
  authScheme?: 'raw' | 'bearer'
  /** §7.115: directional confidence gate — a LOCAL-leaning decision-model
   *  verdict adopts at this floor (default 0.5) instead of paying the LLM
   *  round-trip; non-LOCAL keeps jev.confidenceThreshold (0.85). */
  localAdoptFloor?: number
  /** §7.114 (2026-10-25): classify path appended to `url`. '/systemone'
   *  (default) = the MaaS deployments; a local MLX serve of the same
   *  contract exposes '/v1/classify' — point url at its /v1 and set
   *  path '/classify'. */
  path?: string
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
  /** privacy-policy.json path; derived from ~/.dsh-edge-agent when unset. */
  policyPath?: string
  policyHotReload?: boolean
  policyWatchMs?: number
  /** skill-realms.json path; derived from ~/.dsh-edge-agent when unset. */
  realmConfigPath?: string
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
  /** audit-log plugin storage dir (defaults to ~/.dsh-edge-agent/audit). */
  root?: string
  /** file-logger plugin storage dir (defaults to ~/.dsh-edge-agent/log). */
  logRoot?: string
  /**
   * §7.118 详细 LLM request/response 追踪的开关组。
   * 落在 audit 段下（而不是新开顶层段）：它描述的是"日志写什么"，
   * 与 logLevel / logRoot 同属日志面，不该被当成独立子系统。
   */
  llmTrace?: {
    enabled?: boolean
    includeRequest?: boolean
    includeResponse?: boolean
    maxChars?: number
    maxMessages?: number
    redactPii?: boolean
    redactSecrets?: boolean
  }
}

export interface EdgeTeeConfig {
  type?: string
  /** tcm keystore directory (defaults to ~/.dsh-edge-agent). */
  storageRoot?: string
  /** Full keystore file path; derived from storageRoot when unset. */
  keyStorePath?: string
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

/** local-storage plugin (plaintext JSONL KV root). */
export interface EdgeStorageConfig {
  root?: string
}

/** etscli read-only tool wrapper (§7.98). */
export interface EdgeEtscliConfig {
  bin?: string
  timeoutMs?: number
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
  storage?: EdgeStorageConfig
  etscli?: EdgeEtscliConfig
}

/* ── Defaults (last-resort fallbacks; no local endpoints) ─────────────── */

export const DEFAULT_EDGE_CONFIG: EdgeConfig = {
  secrets: {},
  http: { host: '127.0.0.1', port: 21017 },
  llm: {
    // No baseUrl → the local-LLM route is DELEGATE mode (§7.171: forward to the
    // host profile's own model provider), NOT "no route at all".
    // A hard-coded port here collided with unrelated daemons (see
    // local-llm-adapter.ts Config.baseUrl docs), so "unset" is the only safe
    // default — and unset now means delegate, which never touches a port.
    //
    // The model is deliberately left unset: each plugin owns its own Schema
    // default (local-llm-adapter says 'qwen3-4b', http-api's route fallback
    // says 'qwen3-4b-instruct-2507'). A single default here would silently
    // override the plugin's own value.
    local: { stripTools: false, enableThinking: false, delegate: true },
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
      // §7.107 (2026-10-23): an undecided turn stays on the device. The
      // cloud needs an explicit public-web signal — see the intent-router's
      // CLOUD keyword list and the privacy policy's CLOUD rule.
      defaultCategory: 'LOCAL',
      cloudKeywords: [],
      localEntities: [],
      fallbackKeywords: [],
      // §7.124: 内置词表已覆盖常见家电；此处是 operator 追加面。
      deviceCommands: { devices: [], actions: [] },
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
    // policyPath / realmConfigPath stay unset → plugins derive via edgeHome().
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
    // root / logRoot stay unset → plugins derive them via edgeHome().
  },
  tee: { type: 'simulated' },
  storage: {},
  etscli: { timeoutMs: 30000 },
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
/** 指纹（path + mtime + size + env 覆盖值）—— loadEdgeConfig(true) 的热路径
 *  短路用：input-guard 每个云路由 turn 都 force 重载一次（§7.102 桌面 GUI
 *  没 .env 链，secrets 只能在文件里），文件没变 + env 没变时没必要每次
 *  existsSync+readFileSync+JSON.parse 阻塞事件循环。 */
let cachedStat: { path: string; mtimeMs: number; size: number } | undefined
let cachedEnvSig: string | undefined

/**
 * Root of the installed bundle (the directory holding `lib/` and
 * `config/`), or the repo root when running from source.
 *
 * src/dsh-adapter/ → repo root (dev) or bundle root (installed).
 */
export function edgeBundleRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '..', '..')
}

/** Candidate paths, in priority order. */
export function edgeConfigCandidates(): string[] {
  // §7.102: DSH_EDGE_CONFIG_FILE=off disables file-based configuration
  // entirely. Unit tests set it so a developer's local config/edge.json
  // (real endpoints, real API keys) cannot leak into the assertions — the
  // suite must be reproducible on any machine.
  if (typeof process !== 'undefined' && process.env?.DSH_EDGE_CONFIG_FILE === 'off') {
    return []
  }
  const bundleRoot = edgeBundleRoot()
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
 * Default data location under the user home (`~/.dsh-edge-agent/...`).
 * Plugins use this when the corresponding edge.json path field is unset —
 * the old patch rows derived the same expression via `!!js HOME`, which is
 * what §7.102's "one config file" rule moves into code.
 */
export function edgeHome(...segments: string[]): string {
  return join(homedir(), '.dsh-edge-agent', ...segments)
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
    // Alias of EDGE_API_KEY. scripts/edge-config-env.mjs exports both
    // spellings (the bare one for the legacy e2e/curl callers, the
    // prefixed one for the plugin side); without a consumer here the
    // prefixed spelling was a dead export.
    env: 'DSH_EDGE_HTTP_TOKEN',
    apply: (cfg, v) => { cfg.secrets!.edgeApiKey = v },
  },
  {
    // The bare secret names are the spellings the retired .env used
    // (`.env.sh` did `set -a` and exported them verbatim). The pools
    // resolve their key through `keyRef` → `secrets[keyRef]`, so without
    // these four mappings an env-only deployment (no config/edge.json)
    // would silently lose the credential and every authenticated call
    // would fail with 401. §7.102 keeps the file as the source of truth;
    // these keep the legacy env chain working on top of it.
    env: 'DEEPSEEK_API_KEY',
    apply: (cfg, v) => { cfg.secrets!.deepseekApiKey = v },
  },
  {
    env: 'DASHSCOPE_API_KEY',
    apply: (cfg, v) => { cfg.secrets!.dashscopeApiKey = v },
  },
  {
    env: 'TAVILY_API_KEY',
    apply: (cfg, v) => { cfg.secrets!.tavilyApiKey = v },
  },
  {
    env: 'BOCHA_API_KEY',
    apply: (cfg, v) => { cfg.secrets!.bochaApiKey = v },
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
    // 方向分闸的 LOCAL 侧门：LOCAL 倾向的判决用低门即采纳（默认本地，
    // 不落 LLM），非 LOCAL 仍走 confidenceThreshold（出网要严门）。
    env: 'DSH_EDGE_INTENT_JEV_LOCAL_ADOPT_FLOOR',
    apply: (cfg, v) => { cfg.jev!.localAdoptFloor = Number(v) },
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
    // §7.102 follow-up (2026-10-21): these two were emitted by
    // scripts/edge-config-env.mjs but had no consumer here, so an operator
    // who exported them saw them silently do nothing. The guard stage has
    // had `timeoutMs` / `maxInput` in the file schema all along.
    env: 'DSH_EDGE_GUARD_MODEL_TIMEOUT_MS',
    apply: (cfg, v) => { cfg.stages!.guard!.timeoutMs = Number(v) },
  },
  {
    env: 'DSH_EDGE_GUARD_MODEL_MAX_INPUT',
    apply: (cfg, v) => { cfg.stages!.guard!.maxInput = Number(v) },
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
    env: 'DSH_EDGE_INTENT_LLM_FALLBACK',
    apply: (cfg, v) => { cfg.stages!.intent!.llmFallback = v !== 'false' },
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
  { env: 'DSH_EDGE_LOG_ROOT', apply: (cfg, v) => { cfg.audit!.logRoot = v } },
  { env: 'DSH_EDGE_AUDIT_ROOT', apply: (cfg, v) => { cfg.audit!.root = v } },
  { env: 'DSH_EDGE_STORAGE_ROOT', apply: (cfg, v) => { cfg.storage!.root = v } },
  { env: 'DSH_EDGE_PRIVACY_POLICY_PATH', apply: (cfg, v) => { cfg.privacy!.policyPath = v } },
  { env: 'DSH_EDGE_REALM_CONFIG', apply: (cfg, v) => { cfg.privacy!.realmConfigPath = v } },
  { env: 'DSH_EDGE_ETSCLI_BIN', apply: (cfg, v) => { cfg.etscli!.bin = v } },
  { env: 'DSH_EDGE_ETSCLI_TIMEOUT_MS', apply: (cfg, v) => { cfg.etscli!.timeoutMs = Number(v) } },
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

/**
 * Apply the env override layer on top of a freshly loaded config.
 *
 * §7.154: exported so scripts/edge-config-from-env.ts can apply the SAME
 * mapping the runtime uses without writing the template to the target file
 * first. That script used to copy the template over the operator's live
 * config (destroying every secret that only existed in the real file) even
 * under --dry-run — it needed this layer, and the file round-trip was the
 * only way it could reach it.
 *
 * Mutates and returns `cfg`.
 */
export function applyEnvOverrides(cfg: EdgeConfig): EdgeConfig {
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
  // force 快速路径：文件指纹（mtime+size）与 env 覆盖值都没变 → 直接回
  // 缓存。语义不变 —— force 想要的是"看到配置的最新值"，指纹比对恰好
  // 保证这一点；只有真的动了文件/环境才付 readFileSync+JSON.parse。
  if (cached && cachedStat) {
    const sig = envOverrideSignature()
    if (sig === cachedEnvSig) {
      try {
        const st = statSync(cachedStat.path)
        if (st.mtimeMs === cachedStat.mtimeMs && st.size === cachedStat.size) return cached
      } catch {
        /* 文件没了 → 落回候选扫描 */
      }
    }
  }
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
        storage: { ...DEFAULT_EDGE_CONFIG.storage, ...parsed.storage },
        etscli: { ...DEFAULT_EDGE_CONFIG.etscli, ...parsed.etscli },
      }
      cached = applyEnvOverrides(merged)
      cachedPath = candidate
      try {
        const st = statSync(candidate)
        cachedStat = { path: candidate, mtimeMs: st.mtimeMs, size: st.size }
      } catch {
        cachedStat = undefined
      }
      cachedEnvSig = envOverrideSignature()
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
  cachedStat = undefined
  cachedEnvSig = envOverrideSignature()
  return cached
}

/** Drop the cache so the next loadEdgeConfig() re-reads from disk. */
export function resetEdgeConfigCache(): void {
  cached = undefined
  cachedPath = undefined
  cachedStat = undefined
  cachedEnvSig = undefined
}

/** ENV_OVERRIDES 覆盖值的指纹 —— force 快速路径必须感知 env 变化（测试
 *  会改 process.env 后期望重载生效）。 */
function envOverrideSignature(): string {
  if (typeof process === 'undefined' || !process.env) return ''
  let sig = ''
  for (const { env } of ENV_OVERRIDES) sig += `${env}=${process.env[env] ?? ''}\n`
  return sig
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
export function resolveSecret(cfg: EdgeConfig, ref: string | undefined): string | undefined {
  if (!ref) return undefined
  const value = (cfg.secrets as Record<string, unknown> | undefined)?.[ref]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * §7.154: secret references that name a slot that is not there.
 *
 * `resolveSecret` returns undefined for a missing slot — correct as a
 * lookup, dangerous as a CONFIG outcome. Rename or delete a secrets slot
 * and the pool silently ends up with no credential; the failure surfaces
 * only at the first call (loudly, as MISSING_CREDENTIAL), which can be a
 * long way from the edit that caused it.
 *
 * Observed 2026-10-29: the operator replaced `secrets.minimaxApiKey` with
 * `secrets.aliyuntokenplanApiKey` and repointed `llm.local.keyRef` — but
 * `llm.cloud.keyRef` kept naming the removed slot. The cloud pool was in
 * DIRECT mode with no credential, and nothing said so at boot.
 *
 * Reports FIELD and SLOT NAMES only — never a value.
 */
export interface DanglingSecretRef {
  /** Config path of the reference, e.g. 'llm.cloud.keyRef'. */
  field: string
  /** The slot that was named but is absent (or empty), e.g. 'minimaxApiKey'. */
  ref: string
}

/**
 * Every secret reference in the config that points at a slot which is not
 * there (or is empty).
 *
 * @param cfg   the config to inspect; defaults to the effective one
 */
export function danglingSecretRefs(cfg: EdgeConfig = loadEdgeConfig()): DanglingSecretRef[] {
  const secrets = (cfg.secrets ?? {}) as Record<string, unknown>
  const out: DanglingSecretRef[] = []
  const check = (field: string, ref: string | undefined): void => {
    if (!ref) return
    const value = secrets[ref]
    if (typeof value === 'string' && value.length > 0) return
    out.push({ field, ref })
  }
  check('llm.local.keyRef', cfg.llm?.local?.keyRef)
  check('llm.cloud.keyRef', cfg.llm?.cloud?.keyRef)
  // jev carries the Bailian MaaS decision-model key (§7.112).
  check('jev.apiKeyRef', cfg.jev?.apiKeyRef)
  return out
}

/**
 * One-line human summary of dangling references, for an operator-facing log.
 */
export function formatDanglingSecretRefs(refs: DanglingSecretRef[]): string {
  return refs.map((r) => `${r.field} → secrets.${r.ref}（该槽位不存在或为空）`).join('; ')
}

/**
 * The local-LLM pool with its secret resolved into an api key.
 *
 * §7.171: `baseUrl` 留空 = DELEGATE 模式（转发宿主提供商），与 `llm.cloud` 对称。
 * `delegate: false` 是 kill switch —— 回到 opt-in 语义（不注册任何路由）。
 */
export function localPool(cfg: EdgeConfig = loadEdgeConfig()): {
  baseUrl?: string
  model?: string
  apiKey?: string
  stripTools: boolean
  enableThinking: boolean
  reasoningEffortNone: boolean
  /** §7.171: baseUrl 留空时是否走 DELEGATE（默认 true）。 */
  delegate: boolean
  delegateProvider?: string
  delegateModel?: string
} {
  const pool = cfg.llm?.local ?? {}
  return {
    baseUrl: pool.baseUrl || undefined,
    model: pool.model || undefined,
    apiKey: resolveSecret(cfg, pool.keyRef),
    stripTools: pool.stripTools ?? false,
    enableThinking: pool.enableThinking ?? false,
    reasoningEffortNone: pool.reasoningEffortNone ?? false,
    delegate: pool.delegate ?? true,
    delegateProvider: pool.delegateProvider || undefined,
    delegateModel: pool.delegateModel || undefined,
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


/** §7.112 (2026-10-25): the jev intent-recognizer pool. `apiKey` resolves
 *  `apiKeyRef` → `secrets.*` — the Bailian MaaS systemone endpoint requires
 *  an Authorization header, which the local ONNX jev never needed. */
export function jevPool(cfg: EdgeConfig = loadEdgeConfig()): {
  enabled?: boolean
  url?: string
  provider?: 'local' | 'bailian-decision'
  model?: string
  apiKey?: string
  authScheme?: 'raw' | 'bearer'
  path?: string
} {
  const pool = cfg.jev ?? {}
  return {
    enabled: pool.enabled,
    url: pool.url || undefined,
    provider: pool.provider || undefined,
    model: pool.model || undefined,
    apiKey: resolveSecret(cfg, pool.apiKeyRef),
    authScheme: pool.authScheme || undefined,
    path: pool.path || undefined,
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
