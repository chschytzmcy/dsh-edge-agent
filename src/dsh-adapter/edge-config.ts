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
 * Lookup order (first hit wins) — §7.182 (2026-11-11, operator ruling):
 *   1. <bundle root>/config/edge.json      — the INSTALLED bundle's own config
 *      directory. "插件装在哪，配置就在哪" — the user opens the plugin folder
 *      and finds the file they are supposed to edit. (§7.182: in a SOURCE
 *      CHECKOUT this candidate is SKIPPED — see isSourceCheckout() below —
 *      because the repository's config/ directory is no longer a supported
 *      drop point.)
 *   2. ~/.dsh-edge-agent/edge.json         — the operator's home copy. Survives
 *      a reinstall, a profile deletion, and every install channel (npm / git
 *      / tarball), so it is the落点 for anything long-lived.
 *   (no third candidate — the shipped template is NOT read at runtime; the
 *    template's values live in DEFAULT_EDGE_CONFIG below, so "no config file"
 *    means exactly what the template used to mean.)
 *
 * §7.182 (operator ruling): **the repository's config/ directory is no longer
 * a supported drop point for the live config.** Why:
 *   - it holds the operator's plaintext API keys, and a git checkout is the
 *     one place where they can leak into history (§7.178 deleted every such
 *     local config);
 *   - the npm / git / tarball channels never had that file anyway (the
 *     packaging gates exclude `config/edge.json` on purpose), so it was never
 *     a cross-channel location;
 *   - a source checkout and an installed bundle resolve to the SAME path
 *     (`edgeBundleRoot()` walks up from this module), so the ruling is
 *     enforced by isSourceCheckout() — in a checkout, candidate #1 is
 *     skipped and the runtime reads the same home copy the desktop does.
 * ⇒ One config, two legal落点: the installed bundle's own config dir (where
 *   the user looks) and `~/.dsh-edge-agent/edge.json` (where it survives).
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
  /**
   * §7.221 (2026-11-13): **不再是 web search 的凭据** —— DeepSeek 那一档已经
   * 去掉（搜索跟随所配置的云端模型）。
   *
   * 它现在的用途只有一个：**headless / CLI 部署的 DELEGATE 凭据**。那种宿主
   * 没有登录账号（`deepseek-account` 路由不可用），DELEGATE 要转发到宿主的
   * DeepSeek provider 就得有一把 key —— `scripts/deploy-profile.sh` 会把本槽位
   * export 成 `DEEPSEEK_API_KEY` 给宿主进程（见那里的注释）。
   *
   * 桌面版（有账号登录）**不需要**这个槽位。
   */
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
  /**
   * §7.210 (2026-11-12) / §7.214 (2026-11-13): 「本地」必须落在**本地**上。
   *
   * 默认 **false**（零行为变化）：本地池没配 `baseUrl` 时是 DELEGATE（转发宿主
   * provider，§7.171）⇒ LOCAL 轮次改道过去**可能出网**。上游**有意**放行这个
   * 语义（`tests/unit/input-guard-local-reroute.test.ts` 有单测断言）⇒ 改它等于
   * 改产品语义 ⇒ 主人拍板前**不改语义**，只做可见化（一条 security 级审计事件）。
   *
   * true = **opt-in 严格档**：落点不是本地 ⇒ fail-closed 拒收（这一轮不出网）。
   *
   * §7.214：判据是「委托落点是不是 LOCAL」（model-router 的 realm 说了算）——
   * 落点**证明**是本地 ⇒ 放行（那一轮没出网）；落点不是本地、或 realm **证不出来**
   * ⇒ 拒收（fail-closed）。
   *
   * 审计侧：落点不是本地时记 `input-guard.reroute.delegate-egress`（无论开关如何）；
   * 落点是本地时**不记**那条（它没出网）⇒ 落点事实改记在 `input-guard.reroute.local`
   * 行上（`delegateProvider` / `delegateRealm` / `realmSource`）。
   */
  requireLocalEndpoint?: boolean
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
  /** §7.182 (2026-11-11, owner ruling): the jev decision-model tier is
   *  **OFF by default**. It is an optional accelerator that needs a local
   *  decision-model service on 127.0.0.1:8001 (or a Bailian MaaS key);
   *  with no config file it must not be probed at all. Turn it on
   *  explicitly with `jev.enabled: true`. */
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
  /**
   * §7.222 (2026-11-14): `sanMaxSessions` / `sanSweepMs` / `sanTtlMs` 已删除。
   *
   * 它们是 `privacy.*` 同名字段的**重复副本** —— sanitizer 插件读的是
   * `privacy.*`（见 `sanitizer-pipeline.ts`），`resources.*` 里的那份**从来
   * 没有被任何代码读过**（env 桥 `edge-config-env.mjs` 导出的也是
   * `privacy.san*`）。留着它等于给 operator 两个名字、同一个含义的开关，
   * 改错一个不生效 —— 那正是「多余的配置」。生效口径唯一：`privacy.*`。
   */
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
  /** §7.182 (2026-11-11, owner ruling): the Tavily tier is **OFF by
   *  default** ⇒ out of the box the tool-level `web_search` is **not**
   *  offered at all; the model uses its own provider's native search.
   *  Opt in with `webSearch.tavilyEnabled: true`. */
  tavilyEnabled?: boolean
  /** §7.182: the 博查 AI tier is **OFF by default** (same rule). */
  bochaEnabled?: boolean
}

/**
 * §7.221 (2026-11-13, owner ruling): 「去掉 deepseek search，跟随所配置的云端模型」。
 *
 * 判据 —— **工具层 `web_search` 到底要不要给模型看**：
 *   - Tavily / 博查 两档**任一**「enable 且配到了 key」⇒ 工具层 `web_search`
 *     照旧提供，走 edge 自己的聚合器（Tavily → 博查）。
 *   - 两档都拿不出 ⇒ 工具层 `web_search` **不提供** ⇒ 模型只能用它**自己
 *     provider 的原生搜索** ⇒ 这才是「跟随所配置的云端模型」。
 *
 * ⚠️ 与 realm 的关系：这一条**不是** realm 规则（不是「哪个 realm 能用」），
 * 而是「这个工具**存不存在**」。因此它落在**两个**闸门上，两处共用本文件：
 *
 *   1. **宿主原生闸门（主）** —— `@deepseek-ai/dsh-tool-web` 用
 *      `when: ({ modelSelection }) => ctx.web.searchReady(modelSelection.provider)`
 *      注册 `web_search`（宿主 `dsh-tool-web/src/search.ts`）。宿主 seam 的
 *      `searchReady()` 只在**选中成功**时才去问 provider 的 `ready?.()`；
 *      **选中失败反而返回 true**（宿主源码注释：selection failure answers true,
 *      because `search()` reports that failure as a structured `WebError`）。
 *      ⇒ 所以「两档都关」必须表现为「provider 被选中 + `ready()` 答 false」，
 *      而不是「provider 不可用 / 没注册」—— 后者会让工具**反而可见**。
 *      聚合器据此实现 `ready()`（见 `web-search-tavily-bocha.ts`）。
 *   2. **edge 侧闸门（辅）** —— `realm-skill-bridge` 的工具过滤层
 *      （`filterToolsField` + Layer 3 pre-execute）。它补的是宿主闸门**管不到**
 *      的那一条面：external tool-schema face（`getToolSchemasForExternal` 直接
 *      投影 registry schema，**不经过**宿主的 `when` 谓词）。
 */
export interface EdgeWebSearchAvailability {
  /** Tavily 档：enable **且** 有 key。 */
  tavily: boolean
  /** 博查档：enable **且** 有 key。 */
  bocha: boolean
  /** 任一档可用 ⇒ 工具层 `web_search` 对模型可见。 */
  toolAvailable: boolean
}

/**
 * §7.221: 两档的**解析结果**（开关 + key）。这是「档位怎么算」的唯一事实源 ——
 * 聚合器（`web-search-tavily-bocha.ts`）与闸门（`realm-skill-bridge.ts`）都走
 * 这里，避免两边对「空串 / env 兜底」的判断出现分叉。
 *
 * key 的来源口径（与 §7.102 一致）：
 *   1. `config/edge.json` 的 `secrets.tavilyApiKey` / `secrets.bochaApiKey`
 *   2. `process.env` 的 `TAVILY_API_KEY` / `BOCHA_API_KEY` 兜底
 *
 * ⚠️ 「空串当未配置」：配置里写 `""`（占位）**不算**配到了 key，且**继续往
 * env 兜底**。（早先聚合器里的 `secrets.x ?? env` 会让空串**挡住** env 兜底，
 * 与本函数的 `||` 口径不一致 —— §7.221 统一成后者。）
 */
export interface EdgeWebSearchTiers {
  /** Tavily 档的开关（默认 false —— §7.182）。 */
  tavilyEnabled: boolean
  /** Tavily 档的 key（未配到 = undefined）。 */
  tavilyKey?: string
  /** 博查档的开关（默认 false —— §7.182）。 */
  bochaEnabled: boolean
  /** 博查档的 key（未配到 = undefined）。 */
  bochaKey?: string
}

/**
 * 解析 web search 的两档（§7.221）。**唯一的档位事实源**。
 */
export function resolveWebSearchTiers(cfg: EdgeConfig): EdgeWebSearchTiers {
  const s = cfg.secrets ?? {}
  const tavilyKey = (s.tavilyApiKey ?? '').trim() || (process.env.TAVILY_API_KEY ?? '').trim() || undefined
  const bochaKey = (s.bochaApiKey ?? '').trim() || (process.env.BOCHA_API_KEY ?? '').trim() || undefined
  return {
    tavilyEnabled: cfg.webSearch?.tavilyEnabled === true,
    tavilyKey,
    bochaEnabled: cfg.webSearch?.bochaEnabled === true,
    bochaKey,
  }
}

/**
 * 算出 web search 的可用性（§7.221）。
 */
export function resolveWebSearchAvailability(cfg: EdgeConfig): EdgeWebSearchAvailability {
  const t = resolveWebSearchTiers(cfg)
  const tavily = t.tavilyEnabled && Boolean(t.tavilyKey)
  const bocha = t.bochaEnabled && Boolean(t.bochaKey)
  return { tavily, bocha, toolAvailable: tavily || bocha }
}

/**
 * §7.222 (2026-11-14): `persona` / `localToolsWritable` / `localToolsAllowlist`
 * 已删除 —— 它们**声明了、进了模板，却没有任何消费者**。
 *
 * - `persona`：真正的 persona 来自**宿主 `system-prompt` 行**
 *   （`cordis.patch.yml` 的 `DSH_EDGE_PERSONA` / `presets/agent-preset-edge.json`
 *   的 `persona` 字段），不是 `edge.json` 的 `agent.persona`。edge.json 里写
 *   它**完全没有效果** —— 一个对 operator 说的假开关。
 * - `localToolsWritable` / `localToolsAllowlist`：全仓无任何读取点。工具权限
 *   由宿主的 approval / sandbox 配置决定（见 `cordis.patch.yml` 的
 *   `approval.policy` / `sandbox.mode`），edge.json 里这两个字段是摆设。
 *
 * ⇒ 本段现在只剩 `permissionMode`：它经 `scripts/edge-config-env.mjs` 导成
 *   `DSH_EDGE_PERMISSION_MODE`，再被 patch 行读成宿主的 `approval.policy` /
 *   `sandbox.mode` ⇒ **活的**。
 */
export interface EdgeAgentConfig {
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
    // §7.182: 60000 (not 20000/30000) — the shipped template used to supply
    // this value and it was the candidate #3 fallback; the template is no
    // longer a runtime candidate, so its deployment values live HERE now.
    // Without this, "no config file" would silently shrink the guard's and
    // the classifier's per-call timeout by 3x / 2x.
    guard: { provider: 'local-llm', enabled: true, timeoutMs: 60000, maxInput: 2000 },
    intent: {
      provider: 'local-llm',
      timeoutMs: 60000,
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
      // §7.115: the LLM classifier is the fallback tier (jev skips go here).
      llmFallback: true,
    },
  },
  jev: {
    // §7.182 (2026-11-11, owner ruling): OFF by default. jev is an optional
    // accelerator that needs a local decision-model service on :8001 ⇒ with
    // no config file it must not be probed. Opt in with jev.enabled=true.
    enabled: false,
    url: 'http://127.0.0.1:8001',
    timeoutMs: 2500,
    confidenceThreshold: 0.85,
    riskThreshold: 0.7,
    breakerTtlMs: 30000,
    bootProbeEnabled: true,
    bootProbeTimeoutMs: 2000,
    breakerProbeMs: 5000,
    probeTimeoutMs: 1000,
    // §7.182: the template used to carry these and was the runtime fallback;
    // it is no longer a candidate ⇒ they live here now (the service-level
    // `??` literals agree with these values — see intent-router.ts).
    provider: 'local',
    model: 'decision-model-preview',
    authScheme: 'raw',
    path: '/systemone',
    localAdoptFloor: 0.5,
    // §7.182: `apiKeyRef` is deliberately NOT folded in. The template points
    // it at `secrets.bailianApiKey`, a slot that only exists once the
    // operator fills it — with the template as a runtime candidate that made
    // every start log "密钥引用指向不存在的槽位" (the §7.171 noise). A code
    // default must not carry a reference to a slot it cannot fill: jev's
    // default provider is the local ONNX one, which needs no key at all.
  },
  functionCallExternal: {
    // Code-level fallback = the historical Schema defaults (function-call-
    // external.test.ts EXPECTED_DEFAULTS pins them). Deployment values such
    // as the 15000 ms needle timeout live in config/edge.json instead.
    enabled: false,
    url: 'http://127.0.0.1:8081',
    // §7.182: the template's deployment values moved here (the template is no
    // longer a runtime candidate) ⇒ "no config file" still means what the
    // template used to mean.
    timeoutMs: 15000,
    confidenceThreshold: 0.5,
    breakerTtlMs: 30000,
    bootProbeEnabled: true,
    bootProbeTimeoutMs: 2000,
    breakerProbeMs: 5000,
    probeTimeoutMs: 1000,
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
    // §7.222: `san*` 已移出本段（唯一生效口径是 `privacy.san*`）。
    // 本段现在只管 http-api 的三个资源闸门。
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
  // §7.182 (2026-11-11, owner ruling): Tavily / 博查 are OFF by default.
  // §7.221 (2026-11-13, owner ruling): 两档都关 ⇒ 工具层 `web_search`
  // **不提供** ⇒ 搜索跟随**所配置的云端模型**自带的原生搜索能力
  // （DeepSeek 那一档已去掉，edge 不再自建 DeepSeek 搜索、不再读
  // `DEEPSEEK_API_KEY`）。要工具层搜索就把对应开关写 true 并配上 key。
  webSearch: { tavilyEnabled: false, bochaEnabled: false },
  // §7.222: `agent` 段现在只剩 `permissionMode`（→ `DSH_EDGE_PERMISSION_MODE`
  // → 宿主的 approval.policy / sandbox.mode）。persona / localTools*
  // 是「声明了但没人读」的死字段，已删（理由见 EdgeAgentConfig 的注释）。
  agent: {
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

/**
 * Is the bundle root a SOURCE CHECKOUT (this repository) rather than an
 * installed bundle?
 *
 * §7.182 (2026-11-11): the repository's `config/` directory is no longer a
 * supported drop point for the live config — it is where plaintext API keys
 * would live inside a git checkout. An installed bundle (npm / git / tarball
 * / local directory) carries `lib/` and `config/` but never `src/`, so the
 * two are told apart reliably:
 *
 *   · source checkout  → `src/dsh-adapter/` exists  → candidate #1 SKIPPED
 *   · installed bundle → no `src/` tree             → candidate #1 ACTIVE
 *
 * ⇒ In a checkout the runtime reads the SAME home copy the desktop does
 *   (`~/.dsh-edge-agent/edge.json`), so dev and production cannot diverge.
 */
export function isSourceCheckout(bundleRoot: string = edgeBundleRoot()): boolean {
  return existsSync(join(bundleRoot, 'src', 'dsh-adapter'))
}

/**
 * Candidate paths, in priority order — **exactly two** (§7.182).
 *
 *   1. the INSTALLED bundle's own `config/edge.json` — where the user looks
 *      ("插件装在哪，配置就在哪"); skipped in a source checkout (see
 *      isSourceCheckout());
 *   2. `~/.dsh-edge-agent/edge.json` — the durable落点: survives a reinstall,
 *      a profile deletion, and every install channel.
 *
 * There is NO third candidate. The shipped template (`config/edge.example.json`)
 * used to be candidate #3; §7.182 dropped it, and its values were folded into
 * DEFAULT_EDGE_CONFIG instead ⇒ "no config file" still means exactly what the
 * template used to mean. The template file itself keeps shipping — it is what
 * an operator copies from, not a runtime input.
 */
export function edgeConfigCandidates(
  bundleRoot: string = edgeBundleRoot(),
  homeDir: string = homedir(),
): string[] {
  // §7.102: DSH_EDGE_CONFIG_FILE=off disables file-based configuration
  // entirely. Unit tests set it so a developer's local edge.json (real
  // endpoints, real API keys) cannot leak into the assertions — the suite must
  // be reproducible on any machine.
  if (typeof process !== 'undefined' && process.env?.DSH_EDGE_CONFIG_FILE === 'off') {
    return []
  }
  // §7.182: EXACTLY two candidates, in this order:
  //   1. <安装目录>/config/edge.json — 顺位 1（插件装在哪，配置就在哪）
  //   2. ~/.dsh-edge-agent/edge.json — 顺位 2（重装 / 删 profile 都活着）
  // 顺位 1 不存在才轮到顺位 2（loadEdgeConfig 按顺序命中第一个存在的文件）。
  // 插件目录下的 edge.example.json **永远不是候选** —— 它只是给人抄的模板。
  // bundleRoot / homeDir 可注入 ⇒ 门禁能在临时目录上验证真实优先级，
  // 而不必往运维的真 home 里写文件。
  const candidates: string[] = []
  if (!isSourceCheckout(bundleRoot)) {
    candidates.push(join(bundleRoot, 'config', 'edge.json'))
  }
  candidates.push(join(homeDir, '.dsh-edge-agent', 'edge.json'))
  return candidates
}

/** Path of the file that was actually loaded, or undefined when defaults
 *  are in use. Exposed for diagnostics / audit.
 *
 *  §7.182: 命中的是两档候选里的哪一个（顺位 1 插件目录 / 顺位 2 home）；
 *  模板 edge.example.json 永远不会是命中项。 */
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
    //
    // §7.221: `DEEPSEEK_API_KEY` **不再喂 web search**（DeepSeek 那一档已去掉）
    // —— 它现在只服务 **headless / CLI 的 DELEGATE**：那种宿主没有登录账号，
    // DELEGATE 要转发到宿主的 DeepSeek provider 就得有一把 key
    // （`scripts/deploy-profile.sh` 会把本槽位 export 给宿主进程）。
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
export function loadEdgeConfig(force = false, candidates?: string[]): EdgeConfig {
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
  // §7.182: 候选表默认两档（顺位 1 插件目录 / 顺位 2 home），顺序即优先级 ——
  // 第一个**存在且能解析**的文件胜出；顺位 1 不存在才落到顺位 2。
  // 插件目录下的 edge.example.json 不在候选表里，任何情况下都不会被读到。
  for (const candidate of candidates ?? edgeConfigCandidates()) {
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
  /**
   * §7.210 / §7.214: 委托落点**不是本地**时是否 fail-closed 拒收
   * （默认 false —— 零行为变化）。
   */
  requireLocalEndpoint: boolean
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
    // §7.210: 默认 false —— DELEGATE 仍照常放行（既有语义），只是多留一条
    // security 级审计事件；operator 显式写 true 才切到严格档。
    requireLocalEndpoint: pool.requireLocalEndpoint ?? false,
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
