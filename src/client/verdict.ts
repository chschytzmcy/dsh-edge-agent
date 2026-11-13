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

export type VerdictTone = 'local' | 'cloud' | 'wait' | 'blocked'

export function verdictLine(rows: EdgeRow[]): { text: string; tone: VerdictTone } {
  const newest = <T extends EdgeRow>(list: T[]): T | undefined => list.at(-1)
  // §7.219 (2026-11-13): 这一轮被 **fail-closed 拒收**时，它**根本没作答** ——
  // 顶部结论行**不能说「本地模型作答」**（§7.129：不写与实际行为相反的陈述）。
  //
  // 实机复现（2026-11-13，严格档 `requireLocalEndpoint=true`）：那一轮被
  // `input-guard.reroute.blocked` 拒收（LLM 调用 0、答案出口「路由未定」），
  // 可顶部仍写着「本轮：本地模型作答 —— 数据未离开设备」。
  //
  // ⇒ 判据是「**这一轮有没有被拒收**」，不是「判定成什么类别」——
  // 被拒收的那一轮**照样可能判定成 LOCAL**（那往往正是它被拒的原因）。
  //
  // 两种拒收都算：
  //   · `input-guard.reroute.blocked` —— 出网那一跳改道/委托被拒（§7.210 /
  //     §7.214 的严格档就是这条：委托落点证不出来是本地 ⇒ 拒收）；
  //   · `input-guard.blocked.*` —— 攻击 / 策略 / 模型选择那一层的拒收。
  //
  // （两类都是「本轮没作答」，口径必须一致 —— 否则会出现「严格档拒收显示已拦截，
  // 攻击拦截却仍显示作答了」的自相矛盾。）
  const rejected = newest(rows.filter(r =>
    r.kind === 'input-guard.reroute.blocked' || /^input-guard\.blocked\./.test(r.kind)))
  if (rejected !== undefined) return { text: tr('verdict.blocked'), tone: 'blocked' }
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
