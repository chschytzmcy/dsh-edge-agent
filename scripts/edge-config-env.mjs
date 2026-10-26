// edge-config-env.mjs — print `export K=V` lines for config/edge.json.
//
// §7.102 (2026-10-21): the repo's `.env` / `.env.sh` pair is gone; runtime
// configuration lives in config/edge.json. The e2e / bench scripts still
// need plain shell variables (they call curl / python / the dsh CLI
// directly), so scripts/edge-config-env.sh sources this output.
//
// The names emitted are the SAME DSH_EDGE_* names the plugins already
// understand — edge-config.ts's ENV_OVERRIDES layer maps them back onto the
// file view, so a sourced shell and a running plugin agree.
//
// Usage: node scripts/edge-config-env.mjs [path/to/edge.json]

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function pickConfigPath(arg) {
  if (arg) return resolve(arg)
  const candidates = [
    join(ROOT, 'config', 'edge.json'),
    join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh-edge-agent', 'edge.json'),
  ]
  return candidates.find((p) => existsSync(p)) ?? candidates[0]
}

const path = pickConfigPath(process.argv[2])
if (!existsSync(path)) {
  console.error(`[edge-config-env] no config at ${path} — nothing exported`)
  process.exit(0)
}

let cfg
try {
  cfg = JSON.parse(readFileSync(path, 'utf-8'))
} catch (e) {
  console.error(`[edge-config-env] cannot parse ${path}: ${e.message}`)
  process.exit(0)
}

const out = []
const push = (name, value) => {
  if (value === undefined || value === null || value === '') return
  if (typeof value === 'object') return
  out.push(`export ${name}=${JSON.stringify(String(value))}`)
}

// Array-valued knobs (keyword / entity lists). edge-config.ts's
// ENV_OVERRIDES layer parses them back with `v.split(',').filter(Boolean)`,
// so the CSV spelling is the contract — the same one the old .env used.
const pushCsv = (name, value) => {
  if (!Array.isArray(value) || value.length === 0) return
  out.push(`export ${name}=${JSON.stringify(value.join(','))}`)
}

const s = cfg.secrets ?? {}
push('EDGE_API_KEY', s.edgeApiKey)
push('DSH_EDGE_HTTP_TOKEN', s.edgeApiKey)
push('DEEPSEEK_API_KEY', s.deepseekApiKey)
push('DASHSCOPE_API_KEY', s.dashscopeApiKey)
push('TAVILY_API_KEY', s.tavilyApiKey)
push('BOCHA_API_KEY', s.bochaApiKey)

const http = cfg.http ?? {}
push('DSH_EDGE_HTTP_HOST', http.host)
push('DSH_EDGE_HTTP_PORT', http.port)

const local = cfg.llm?.local ?? {}
push('DSH_EDGE_LOCAL_LLM_BASEURL', local.baseUrl)
push('DSH_EDGE_LOCAL_LLM_MODEL', local.model)
push('DSH_EDGE_LOCAL_LLM_KEY_ENV', local.keyRef)
push('DSH_EDGE_LOCAL_LLM_STRIP_TOOLS', local.stripTools)
push('DSH_EDGE_LOCAL_LLM_ENABLE_THINKING', local.enableThinking)

const cloud = cfg.llm?.cloud ?? {}
push('DSH_EDGE_CLOUD_LLM_BASEURL', cloud.baseUrl)
push('DSH_EDGE_CLOUD_KEY_ENV', cloud.keyRef)
push('DSH_EDGE_CLOUD_DELEGATE', cloud.delegate)
push('DSH_EDGE_CLOUD_DELEGATE_PROVIDER', cloud.delegateProvider)
push('DSH_EDGE_CLOUD_DELEGATE_MODEL', cloud.delegateModel)
// The cloud pool's model id. The plugin side reads this name
// (edge-config.ts: DSH_EDGE_MODEL → llm.cloud.model); without it here the
// shell side could not reach that knob at all.
push('DSH_EDGE_MODEL', cloud.model)

const guard = cfg.stages?.guard ?? {}
push('DSH_EDGE_GUARD_MODEL', guard.enabled)
push('DSH_EDGE_GUARD_MODEL_PROVIDER', guard.provider)
push('DSH_EDGE_GUARD_MODEL_MODEL', guard.model)
push('DSH_EDGE_GUARD_MODEL_TIMEOUT_MS', guard.timeoutMs)
push('DSH_EDGE_GUARD_MODEL_MAX_INPUT', guard.maxInput)

const intent = cfg.stages?.intent ?? {}
push('DSH_EDGE_INTENT_PROVIDER', intent.provider)
push('DSH_EDGE_INTENT_MODEL', intent.model)
push('DSH_EDGE_INTENT_CONFIDENCE_THRESHOLD', intent.confidenceThreshold)
push('DSH_EDGE_INTENT_LLM_TIMEOUT_MS', intent.timeoutMs)
push('DSH_EDGE_INTENT_RECENT_LIMIT', intent.recentLimit)
push('DSH_EDGE_INTENT_MAX_INPUT', intent.maxInput)
pushCsv('DSH_EDGE_INTENT_CLOUD_KEYWORDS', intent.cloudKeywords)
pushCsv('DSH_EDGE_INTENT_LOCAL_ENTITIES', intent.localEntities)
pushCsv('DSH_EDGE_INTENT_FALLBACK_KEYWORDS', intent.fallbackKeywords)
// §7.115：llmFallback=false = 决策模型 only 模式（跳过 LLM 分类器）。
// 插件侧 edge-config.ts 用 `v !== 'false'` 解析，故 shell 侧直接给
// 'true' / 'false' 字面量即可往返一致。
push('DSH_EDGE_INTENT_LLM_FALLBACK', intent.llmFallback)

const jev = cfg.jev ?? {}
push('DSH_EDGE_INTENT_JEV_ENABLED', jev.enabled)
push('DSH_EDGE_INTENT_JEV_URL', jev.url)
push('DSH_EDGE_INTENT_JEV_TIMEOUT_MS', jev.timeoutMs)
push('DSH_EDGE_INTENT_JEV_CONFIDENCE_THRESHOLD', jev.confidenceThreshold)
push('DSH_EDGE_INTENT_JEV_RISK_THRESHOLD', jev.riskThreshold)
// Breaker / boot-probe knobs — the plugin side consumes these names
// (edge-config.ts), so the shell side has to be able to reach them too.
push('DSH_EDGE_INTENT_JEV_BREAKER_TTL_MS', jev.breakerTtlMs)
push('DSH_EDGE_INTENT_JEV_BOOT_PROBE_ENABLED', jev.bootProbeEnabled)
push('DSH_EDGE_INTENT_JEV_BOOT_PROBE_TIMEOUT_MS', jev.bootProbeTimeoutMs)
push('DSH_EDGE_INTENT_JEV_BREAKER_PROBE_MS', jev.breakerProbeMs)
push('DSH_EDGE_INTENT_JEV_PROBE_TIMEOUT_MS', jev.probeTimeoutMs)

const fce = cfg.functionCallExternal ?? {}
push('DSH_EDGE_FUNCTION_CALL_EXTERNAL_ENABLED', fce.enabled)
push('DSH_EDGE_FUNCTION_CALL_EXTERNAL_URL', fce.url)
push('DSH_EDGE_FUNCTION_CALL_EXTERNAL_TIMEOUT_MS', fce.timeoutMs)
push('DSH_EDGE_FUNCTION_CALL_EXTERNAL_CONFIDENCE_THRESHOLD', fce.confidenceThreshold)

const privacy = cfg.privacy ?? {}
push('DSH_EDGE_INPUT_GUARD', privacy.inputGuardEnabled)
push('DSH_EDGE_REJECT_POLICY', privacy.rejectPolicyEnabled)
push('DSH_EDGE_SANITIZE_DOWNGRADE', privacy.sanitizeDowngradeEnabled)
push('DSH_EDGE_REALM_HOT_RELOAD', privacy.realmHotReload)
push('DSH_EDGE_REALM_WATCH_MS', privacy.realmWatchMs)
push('DSH_EDGE_REALM_CONFIG', privacy.realmConfigPath)
push('DSH_EDGE_POLICY_HOT_RELOAD', privacy.policyHotReload)
push('DSH_EDGE_POLICY_WATCH_MS', privacy.policyWatchMs)
push('DSH_EDGE_PRIVACY_POLICY_PATH', privacy.policyPath)
push('DSH_EDGE_SAN_TTL_MS', privacy.sanTtlMs)
push('DSH_EDGE_SAN_MAX_SESSIONS', privacy.sanMaxSessions)
push('DSH_EDGE_SAN_SWEEP_MS', privacy.sanSweepMs)

const audit = cfg.audit ?? {}
push('DSH_EDGE_AUDIT_MIN_LEVEL', audit.minLevel)
push('DSH_EDGE_AUDIT_FLUSH_MS', audit.flushMs)
push('DSH_EDGE_LOG_LEVEL', audit.logLevel)
push('DSH_EDGE_LOG_MAX_AGE_DAYS', audit.logMaxAgeDays)
push('DSH_EDGE_LOG_MAX_ROTATED', audit.logMaxRotated)
push('DSH_EDGE_LOG_ROOT', audit.logRoot)
push('DSH_EDGE_AUDIT_ROOT', audit.root)

const resources = cfg.resources ?? {}
push('DSH_EDGE_MAX_SESSIONS', resources.maxSessions)
push('DSH_EDGE_MAX_BODY_BYTES', resources.maxBodyBytes)
push('DSH_EDGE_SESSION_IDLE_MS', resources.sessionIdleMs)

const tee = cfg.tee ?? {}
push('DSH_EDGE_TEE_TYPE', tee.type)
push('DSH_EDGE_STORAGE_ROOT', tee.storageRoot)

const threat = cfg.threat ?? {}
push('DSH_EDGE_TD_CLOUD_RATE', threat.cloudRate)
push('DSH_EDGE_TD_BLOCK_LEVEL', threat.blockLevel)

const etscli = cfg.etscli ?? {}
push('DSH_EDGE_ETSCLI_BIN', etscli.bin)
push('DSH_EDGE_ETSCLI_TIMEOUT_MS', etscli.timeoutMs)

const storage = cfg.storage ?? {}
push('DSH_EDGE_STORAGE_ROOT', storage.root)

const agent = cfg.agent ?? {}
push('DSH_EDGE_PERMISSION_MODE', agent.permissionMode)

console.log(out.join('\n'))
