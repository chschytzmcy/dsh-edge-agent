/**
 * The one-glance verdict line (§7.106 clarity request).
 *
 * §7.106: the panel rows are evidence, but the takeaway — did this turn leave
 * the device, and was PII scrubbed first — must read as a single line.
 *
 * §7.107: the verdict read only the LLM classifier. A turn the privacy policy
 * decided (the classifier is then skipped entirely) had no
 * `intent.classify.end` row, so the banner could fall back to "等待" while
 * the flow below had already rendered the verdict. The realm the turn
 * actually ran under is now taken from whichever tier decided it — classifier,
 * policy rule, or the guard's own routing.
 *
 * §7.129: 「数据未离开设备」是一句**断言**，必须能被出口端点证实。
 * provider 名叫 `local-llm` **不代表**落点在本机 —— config/edge.json 的
 * `llm.local.baseUrl` 可以指向公网（§7.118 的 P0）。审计里的 baseUrl 是
 * 脱敏的（`http://67.0.***.***:11434/v1`），客户端算不出它是不是本机，
 * 所以**服务端**把判定结果算成布尔值 `baseUrlIsLocal` 随出口行下发。
 *
 * 三态：
 *   - 出口行证实落在本机 → 「数据未离开设备」（隐私承诺成立）
 *   - 出口行证实不在本机 → 「落点不在本机（原文已出设备）」（**不撒谎**）
 *   - 出口行还没落（这一轮刚开始）→ 「落点待确认」（**不下断言**）
 *
 * 单独成模块：verdictLine 是纯函数（只吃 rows，不碰 React），单测可以直接
 * 断言它 —— 不必把整个 webview 入口拖进测试。
 */
import { tr } from './i18n'
import type { EdgeRow } from './types'

export type VerdictTone = 'local' | 'cloud' | 'wait' | 'warn'

/** 出口行 —— 请求真正发出去时落的那几行。 */
const EGRESS_KINDS = new Set([
  'llm.local.start', 'llm.cloud.start',
  'llm.local.end', 'llm.cloud.end',
])

export function verdictLine(rows: EdgeRow[]): { text: string; tone: VerdictTone } {
  const newest = <T extends EdgeRow>(list: T[]): T | undefined => list.at(-1)
  const classify = newest(rows.filter(r => r.kind === 'intent.classify.end'))
  const policy = newest(rows.filter(r => r.kind === 'input-guard.policy.route-applied'))
  const routed = newest(rows.filter(r => r.kind === 'input-guard.routed'))
  const host = newest(rows.filter(r => r.kind === 'llm.host.route'))
  const scrubbed = rows.some(r => r.kind === 'sanitizer.sanitized' || r.kind === 'guard.rule.sanitized')
  const category = classify?.payload.category ?? policy?.payload.policyRealm ?? routed?.payload.category
  if (category === undefined && host === undefined) return { text: tr('verdict.waiting'), tone: 'wait' }
  const local = category === 'LOCAL'
    || host !== undefined && String(host.payload.provider ?? '').startsWith('local-llm')
  if (local) {
    // 取**最新那条带 baseUrlIsLocal 的出口行** —— `.end` 行不带这个字段
    // （只有 `.start` 行知道请求发去了哪），所以按字段过滤而不是按类型。
    const onDevice = newest(rows.filter(r =>
      EGRESS_KINDS.has(r.kind) && typeof r.payload.baseUrlIsLocal === 'boolean'
    ))?.payload.baseUrlIsLocal
    if (onDevice === true) return { text: tr('verdict.local'), tone: 'local' }
    if (onDevice === false) return { text: tr('verdict.localOffDevice'), tone: 'warn' }
    return { text: tr('verdict.localPending'), tone: 'wait' }
  }
  return { text: tr('verdict.cloud') + (scrubbed ? tr('verdict.sanitized') : ''), tone: 'cloud' }
}
