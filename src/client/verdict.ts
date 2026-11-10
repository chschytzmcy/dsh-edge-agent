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
 * §7.129 / §7.130: 判定「是否出网」的依据是 **category（哪个池）**，不是端点
 * 落在哪台机。主人裁决（2026-10-27）：「只要定位到 category=LOCAL，就不算到
 * 公网，不用关心具体的模型来源」—— `llm.local` 池是 operator 自有设施
 * （当前部署指向内网主机，那是 operator 自己的机器/内网，不是公网），所以
 * provider 名叫 `local-llm`、端点不在本机，**都不构成出网**。
 *
 * 因此：§7.129 曾把 verdict 改成「按出口端点判定」（已证实本机 / 不在本机 /
 * 待确认三态），该结论由 §7.130 撤回。端点位置不参与出网判断。
 *
 * 单独成模块：verdictLine 是纯函数（只吃 rows，不碰 React），单测可以直接
 * 断言它 —— 不必把整个 webview 入口拖进测试。
 */
import { tr } from './i18n'
import type { EdgeRow } from './types'

export type VerdictTone = 'local' | 'cloud' | 'wait'

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
  if (local) return { text: tr('verdict.local'), tone: 'local' }
  return { text: tr('verdict.cloud') + (scrubbed ? tr('verdict.sanitized') : ''), tone: 'cloud' }
}
