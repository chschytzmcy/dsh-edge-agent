/**
 * §7.145 未绑定会话时的面板口径。
 *
 * ## 为什么要改
 *
 * Edge tab 常驻之后（§7.142），主人可以在**还没绑定会话**的时候打开面板 ——
 * 新建会话页、guide 页、还没发第一条消息的草稿。此时面板此前把
 * **全局汇总**当成「这一轮」显示：轮次 0 / 「本轮：等待意图判定」/ 五节点流程 /
 * 「LLM 调用 0」。这些词全是「某一轮」的概念，可此时根本没有哪一轮 —— 看着像
 * 一个真的在跑的会话，是 §7.129 最怕的那种误导。
 *
 * ## 实机复验后修订的判据（2026-10-29）
 *
 * 原来的判据是「宿主给的 sessionId 为空」。**实机证明它覆盖不到真正触发的场景**：
 * 桌面版在开机时就会 `POST /api/session/create` 建一个**草稿会话**，于是 guide 页
 * 拿到的 sessionId 是**真实且非空**的 —— 判据判成「已绑定」，旧壳照旧显示
 * （实机截图：Edge / 轮次 0 / 本轮：等待意图判定 / 五节点流程 / LLM 调用 0）。
 *
 * 真正的机理在宿主侧（`src/dsh-adapter/edge-context-view.ts`）：
 *
 *   - `GLOBAL_BUCKET = '_global'` 是「所有没有 sessionId 的审计行」的兜底桶
 *     （开机探针、限流信号、宿主答案步……）；
 *   - `snapshot(sessionId)` 对**任何**会话都把 `_global` 桶**合并进来**；
 *   - 行上带 `turn`：会话自己的行 `turn >= 0`，全局行 `turn === -1`（哨兵）。
 *
 * 所以面板能不能说「这一轮」，判据是**行**而不是 id：
 *
 *   **面板里没有一条属于本会话的行 ⇒ 面板没有「这一轮」可显示。**
 *
 * 空白草稿会话正好落在这里：它自己一条行都没有，宿主合并进来的全是全局行。
 *
 * ## 改成什么
 *
 * 没绑定到任何一轮时，面板只说两件事：
 *
 *   1. **尚未绑定会话**（明说现在没有可显示的会话轮次，不假装有）；
 *   2. 下面是**全局信号**（与会话无关的那些行），按面板分组列出。
 *
 * 「本轮」语义的东西（轮次计数 / verdict / 五节点流程 / LLM 调用列表）**一律
 * 不显示** —— 没有会话就没有「这一轮」。全局信号一条都不藏：§7.129 的原则是
 * 不隐藏真发生的事，只是把它标对。
 *
 * @module dsh-edge-agent/client/unbound
 */

import { createElement as h } from 'react'
import type { ReactElement } from 'react'
import type { EdgeRow } from './types'
import { tr } from './i18n'
import { RowList } from './rows'

/**
 * 全局兜底桶的 id —— 与宿主 `edge-context-view.ts` 的 `GLOBAL_BUCKET` 一致。
 *
 * 客户端不能 import 宿主侧模块（那是 node 侧的插件，会把 node 依赖拖进 webview
 * bundle），所以这里是同一份字面量 + 交叉注释。
 */
export const GLOBAL_BUCKET = '_global'

/** 全局行在 `turn` 上的哨兵值（宿主 `edge-context-view.ts` 写入）。 */
export const GLOBAL_ROW_TURN = -1

/** 这一行是不是全局桶的行（与会话无关）。 */
export function isGlobalRow(row: EdgeRow): boolean {
  return row.turn === GLOBAL_ROW_TURN
}

/** 面板是否已经绑定到一个会话 id。 */
export function isBoundSession(sessionId: string | undefined): boolean {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return false
  // 全局桶 id 不是「绑定」—— 它是没有会话时的兜底桶名。
  return sessionId !== GLOBAL_BUCKET
}

/**
 * 面板有没有绑定到「某一轮」。
 *
 * @param sessionId - 宿主给的会话 id（可能是空的）
 * @param rows - 面板当前能看到的行（已按轮次窗口过滤）
 * @param turns - 宿主记的该会话轮次计数
 *
 * 判据（§7.145 实机复验后修订）：
 *   - 宿主没给会话（空 / `_global`）⇒ 未绑定；
 *   - 给了会话、但它一轮都没跑过（`turns === 0`）、而且面板里**没有一条属于
 *     它的行** ⇒ 未绑定（空白草稿会话的典型形态：宿主把全局桶合并进来，
 *     壳却是「本轮」）；
 *   - 否则 ⇒ 已绑定 —— 有轮次、或已经有属于这个会话的行（哪怕行上的 turn
 *     计数还是 0：§7.106 的竞态里，首轮的行先于 `turn/start` 落库）。
 */
export function isUnboundPanel(sessionId: string | undefined, rows: EdgeRow[], turns: number): boolean {
  if (!isBoundSession(sessionId)) return true
  if (turns > 0) return false
  // 没有轮次 ⇒ 只有「属于这个会话的行」才能证明面板绑到了东西。
  // 保守取法：`turn` 缺失的行算会话自己的行（不误判成未绑定）。
  return !rows.some((row) => !isGlobalRow(row))
}

/** 全局信号的一个分组。 */
export interface SignalGroup {
  /** 面板 id（intent / route / interception / threat）。 */
  panel: string
  rows: EdgeRow[]
}

/**
 * 把全局行按面板分组，保持「首次出现」的顺序。
 *
 * 不用对象键序（那对数字键会重排），显式记一份出现顺序。
 */
export function globalSignalGroups(rows: EdgeRow[]): SignalGroup[] {
  const order: string[] = []
  const byPanel = new Map<string, EdgeRow[]>()
  for (const row of rows) {
    const panel = typeof row.panel === 'string' && row.panel.length > 0 ? row.panel : 'other'
    let bucket = byPanel.get(panel)
    if (bucket === undefined) {
      bucket = []
      byPanel.set(panel, bucket)
      order.push(panel)
    }
    bucket.push(row)
  }
  return order.map((panel) => ({ panel, rows: byPanel.get(panel) ?? [] }))
}

/** 面板 id → 文案 key。 */
const PANEL_LABEL: Record<string, string> = {
  intent: 'panel.intent',
  route: 'panel.route',
  interception: 'panel.interception',
  threat: 'panel.threat',
}

/**
 * 未绑定会话时的面板。
 *
 * @param rows - 全局桶的行（只收全局行：会话自己的行在绑定视图里才有意义）
 * @param failing - edge 服务不可达（轮询连续失败）
 */
export function UnboundView(props: { rows: EdgeRow[]; failing?: boolean }): ReactElement {
  const groups = globalSignalGroups(props.rows)
  return h('div', { class: 'dsh-edge-view' },
    h('div', { class: 'dsh-edge-unbound' },
      h('b', null, tr('unbound.title')),
      h('span', null, tr('unbound.hint')),
    ),
    groups.length === 0
      ? h('div', { class: 'dsh-edge-empty' }, tr('unbound.empty'))
      : h('div', { class: 'dsh-edge-groups' },
        ...groups.map((group) => h('div', { class: 'dsh-edge-panel', key: group.panel },
          h('h4', null, tr(PANEL_LABEL[group.panel] ?? 'unbound.globalTitle')),
          h(RowList, { rows: group.rows, panel: group.panel, empty: tr('unbound.empty') }),
        )),
      ),
    props.failing === true ? h('div', { class: 'dsh-edge-stale' }, tr('row.stale')) : null,
  )
}
