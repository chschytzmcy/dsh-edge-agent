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
  'flow.sanitize.failed': 'scrub failed → answered locally',
  'flow.sanitize.localSkip': 'not needed (local)',
  'flow.sanitize.clean': 'no PII found',
  'flow.route.blocked': 'blocked',
  'flow.route.fallback': 'answered locally (cloud unavailable)',
  'flow.route.forced': 'privacy guard held → local',
  'flow.route.kept': 'as selected',
  'flow.answer.pending': 'route not settled yet',
  'flow.answer.local': 'local model · stayed on device',
  'flow.answer.cloud': 'cloud:',
  'flow.lbl.cause': 'cause',
  'flow.lbl.judge': 'verdict',
  'flow.lbl.model': 'model',
  'flow.lbl.input': 'input',
  'flow.lbl.verdict': 'verdict',
  'flow.lbl.override': 'override',
  'flow.lbl.entity': 'entity',
  'flow.lbl.llmSay': 'LLM said',
  'flow.lbl.overridden': '— overridden by rule',
  'flow.lbl.classifier': 'classifier',
  'flow.lbl.rewrite': 'rewrite',
  'flow.lbl.reason': 'reason',
  'flow.lbl.entry': 'entry',
  'flow.lbl.edgePool': 'edge cloud pool',
  'flow.lbl.used': 'used',
  'flow.lbl.hostOwn': 'host route',
  'flow.lbl.steps': 'steps',
  'flow.lbl.total': 'total',
  'flow.lbl.context': 'context',
  'flow.lbl.in': 'in',
  'flow.lbl.out': 'out',
  'flow.lbl.route': 'route',
  'flow.g.guardrule': 'warn-tier pattern hit',
  'flow.g.regexOn': 'regex tier still on duty',
  'flow.s.done': 'scrubbed',
  'flow.sanitize.unit': 'spans',
  'flow.s.localWhy': 'answer never leaves the device — nothing to scrub',
  'flow.s.cleanWhy': 'checked, no PII in the outbound text',
  'flow.s.desanitized': 'placeholders restored in the answer',
  'flow.a.localKeep': 'question, context and answer all stayed on this machine',
  'flow.a.cloudSend': 'outbound text was checked / scrubbed first',
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
  'flow.sanitize.failed': '脱敏失败 → 转本地作答',
  'flow.sanitize.localSkip': '无需（本地作答）',
  'flow.sanitize.clean': '未发现 PII',
  'flow.route.blocked': '已拦截',
  'flow.route.fallback': '转本地作答（云不可用）',
  'flow.route.forced': '隐私护栏生效 → 本地作答',
  'flow.route.kept': '按原选择',
  'flow.answer.pending': '路由未定',
  'flow.answer.local': '本地模型 · 未出设备',
  'flow.answer.cloud': '云端：',
  'flow.lbl.cause': '原因',
  'flow.lbl.judge': '判定',
  'flow.lbl.model': '模型',
  'flow.lbl.input': '输入',
  'flow.lbl.verdict': '裁决',
  'flow.lbl.override': '改判',
  'flow.lbl.entity': '实体',
  'flow.lbl.llmSay': 'LLM 原判',
  'flow.lbl.overridden': '——被规则改判',
  'flow.lbl.classifier': '分类器',
  'flow.lbl.rewrite': '改写',
  'flow.lbl.reason': '理由',
  'flow.lbl.entry': '入口',
  'flow.lbl.edgePool': 'edge 云池',
  'flow.lbl.used': '已使用',
  'flow.lbl.hostOwn': '走宿主路由',
  'flow.lbl.steps': '步数',
  'flow.lbl.total': '合计',
  'flow.lbl.context': '上下文',
  'flow.lbl.in': '入',
  'flow.lbl.out': '出',
  'flow.lbl.route': '路由',
  'flow.g.guardrule': '命中告警级注入特征',
  'flow.g.regexOn': '正则档仍在执勤',
  'flow.s.done': '已脱敏',
  'flow.sanitize.unit': '处',
  'flow.s.localWhy': '答案不出设备，无需脱敏',
  'flow.s.cleanWhy': '已检查，出向文本无 PII',
  'flow.s.desanitized': '答案中的占位符已还原',
  'flow.a.localKeep': '问题、上下文、答案全部留在本机',
  'flow.a.cloudSend': '出网文本已先行检查/脱敏',
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
