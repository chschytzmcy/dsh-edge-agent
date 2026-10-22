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
