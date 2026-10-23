/**
 * Edge tab i18n. Labels ride the host `locale` service when it is composed
 * (zh/en dictionaries registered in index.ts); without it the built-in
 * English table keeps the tab readable — a missing face must degrade, never
 * blank the panel (fail-open discipline, same as the store).
 */

type Dict = Record<string, string>

const EN: Dict = {
  'tab.title': 'Edge',
  'panel.intent': 'Intent',
  'panel.route': 'Route',
  'panel.interception': 'Interception',
  'panel.threat': 'Threat',
  'summary.turns': 'turns',
  'summary.tokens': 'tokens',
  'summary.noTokens': 'no usage reported',
  'summary.age': 'age',
  'row.empty': 'no events yet',
  'row.stale': 'edge host unreachable',
  'guide.description': 'Intent classification · model routing · guard / sanitizer events · threat levels',
  'verdict.local': 'This turn: answered locally — data never left the device',
  'verdict.cloud': 'This turn: answered by the cloud route',
  'verdict.sanitized': ' (PII sanitized first)',
  'verdict.waiting': 'This turn: awaiting classification',
  'flow.guard': 'attack check',
  'flow.intent': 'intent verdict',
  'flow.sanitize': 'PII scrub',
  'flow.route': 'routing',
  'flow.answer': 'answer egress',
  'flow.wait': 'waiting',
  'flow.running': 'running…',
  'flow.guard.injection': 'injection pattern hit (warned, passed)',
  'flow.guard.failopen': 'model check failed → regex tier held',
  'flow.guard.public': 'clean (public data)',
  'flow.guard.skipped': 'rules tier only',
  'flow.guard.running': 'model judging…',
  'flow.intent.rejected': 'policy denied',
  'flow.intent.viaEntity': 'entity rule',
  'flow.intent.viaLlm': 'LLM verdict',
  'flow.sanitize.hits': 'scrubbed',
  'flow.sanitize.done': 'scrubbed',
  'flow.sanitize.failed': 'scrub failed → forced local',
  'flow.sanitize.localSkip': 'not needed (local)',
  'flow.sanitize.clean': 'no PII found',
  'flow.route.blocked': 'blocked',
  'flow.route.fallback': 'local fallback (cloud unavailable)',
  'flow.route.forced': 'forced local',
  'flow.route.kept': 'as selected',
  'flow.answer.pending': 'route not settled yet',
  'flow.answer.local': 'local model · stayed on device',
  'flow.answer.cloud': 'cloud:',
}

const ZH: Dict = {
  'tab.title': 'Edge',
  'panel.intent': '意图',
  'panel.route': '路由',
  'panel.interception': '拦截',
  'panel.threat': '威胁',
  'summary.turns': '轮次',
  'summary.tokens': 'token',
  'summary.noTokens': '未上报用量',
  'summary.age': '时长',
  'row.empty': '暂无事件',
  'row.stale': 'edge 服务不可达',
  'guide.description': '意图分类 · 模型路由 · 防护/脱敏事件 · 威胁档位',
  'verdict.local': '本轮：本地模型作答 —— 数据未离开设备',
  'verdict.cloud': '本轮：云端作答',
  'verdict.sanitized': '（已先脱敏）',
  'verdict.waiting': '本轮：等待意图判定',
  'flow.guard': '攻击检测',
  'flow.intent': '意图判定',
  'flow.sanitize': 'PII 脱敏',
  'flow.route': '路由决策',
  'flow.answer': '答案出口',
  'flow.wait': '等待',
  'flow.running': '进行中…',
  'flow.guard.injection': '命中注入特征（告警放行）',
  'flow.guard.failopen': '模型检测失败 → 正则档兜底',
  'flow.guard.public': '干净（公开级）',
  'flow.guard.skipped': '仅规则档',
  'flow.guard.running': '模型判定中…',
  'flow.intent.rejected': '策略拒绝',
  'flow.intent.viaEntity': '实体规则裁决',
  'flow.intent.viaLlm': 'LLM 裁决',
  'flow.sanitize.hits': '已替换',
  'flow.sanitize.done': '已脱敏',
  'flow.sanitize.failed': '脱敏失败 → 强制本地',
  'flow.sanitize.localSkip': '无需（本地作答）',
  'flow.sanitize.clean': '未发现 PII',
  'flow.route.blocked': '已拦截',
  'flow.route.fallback': '降级本地（云不可用）',
  'flow.route.forced': '强制本地',
  'flow.route.kept': '按原选择',
  'flow.answer.pending': '路由未定',
  'flow.answer.local': '本地模型 · 未出设备',
  'flow.answer.cloud': '云端：',
}

let t: (key: string) => string = (key) => EN[key] ?? key

/** Bind the host locale when available. */
export function setTranslator(bind: ((key: string, params?: Record<string, string | number>) => string) | undefined): void {
  if (typeof bind !== 'function') return
  t = (key) => {
    try {
      const out = bind(key)
      // The host returns the key itself for unknown entries; fall back to EN.
      return out === key ? (EN[key] ?? key) : out
    } catch {
      return EN[key] ?? key
    }
  }
}

export function tr(key: string): string {
  return t(key)
}

export const EDGE_LOCALE_NS = 'dsh-edge-agent'
export const EDGE_DICTIONARIES = { zh: ZH, en: EN }
