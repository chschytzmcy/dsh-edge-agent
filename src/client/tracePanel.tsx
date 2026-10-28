/**
 * tracePanel — §7.133/§7.134: the Edge tab's **LLM call log**.
 *
 * ## 为什么是「索引 + 点开拉正文」
 *
 * 一次主对话的 request 正文实测 **22.5 万字符**（promptLength=225630）。
 * 把正文直接塞进 audit 行，面板的常驻内存和渲染压力会随轮次线性膨胀。
 * 所以：
 *
 *   - **索引行**（`llm.trace.index`）随 audit 行一起进面板 —— 几十字节的
 *     标量：provider / model / 归属 / 大小 / 用时 / traceId；
 *   - **正文**留在宿主的内存 ring 里，点开才 POST `api/dsh-edge/trace` 取。
 *
 * ## §7.134：按类别分组 + 请求/响应成对
 *
 * 主人要的是「按攻击检测 / 意图判定 / 路由决策等类别列出，请求和响应成对
 * 显示，上面是请求下面是响应」。所以：
 *
 * 1. **分组**：用与 Flow 面板**同一套**类别语义（`flow.guard` / `flow.intent`
 *    / `flow.route`），不另造一套 —— 同一个概念两处文案必然漂移。
 *    §7.132 的判据原样复用：
 *      - `caller = prompt-guard`     → 攻击检测
 *      - `caller = intent-classifier` → 意图判定
 *      - 无 caller 且带工具           → 路由决策（主对话出网）
 *      - 无 caller 且 `toolCount === 0` → 宿主内部调用（会话标题生成等）
 *      - 未知 caller                 → 「其他调用」—— 不猜（机器码原样显示）
 * 2. **成对**：REQ 与 RESP 各自有独立的 `traceId`（正文存储的键），但同一次
 *    往返共用一个 `callId` —— 面板按 `callId` 配对，上请求、下响应。
 *    重试时可能出现「失败 RESP + 成功 RESP」共用同一个 `callId`，
 *    此时取**最后一个** RESP（那才是这次调用的最终结果）。
 *
 * 取不到正文就**说取不到**（正文被 ring 淘汰），绝不显示一个空对象冒充
 * 「正文是空的」。
 *
 * @module dsh-edge-agent/client/tracePanel
 */

import { createElement as h, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { EdgeRow } from './types'
import { fetchTraceBody } from './store'
import { tr } from './i18n'

/** The index row's payload — all scalars (the host's safePayload keeps them). */
export interface TraceIndex {
  traceId: string
  kind: 'REQ' | 'RESP'
  provider: string
  model: string
  caller?: string
  messageCount?: number
  droppedMessages?: number
  promptLength?: number
  contentLength?: number
  toolCallCount?: number
  toolCount?: number
  durationMs?: number
  finishReason?: string
  error?: string
  bodyBytes?: number
  baseUrl?: string
  /** §7.134: 一次 LLM 往返的配对键（REQ/RESP 共用）。 */
  callId?: string
}

/**
 * §7.134: 调用归属的**类别**。
 *
 * 顺序与 Flow 面板的节点顺序一致（攻击检测 → 意图判定 → 路由决策），
 * 面板按这个顺序分组。
 */
export type TraceGroup = 'guard' | 'intent' | 'route' | 'host' | 'other'

/** §7.134: 类别在面板上的显示顺序。 */
export const TRACE_GROUP_ORDER: readonly TraceGroup[] = ['guard', 'intent', 'route', 'host', 'other']

/**
 * §7.134: 一次 trace 属于哪一类 —— §7.132 的判据，**原样**搬过来。
 *
 * 未知 caller 归「其他」而不是硬塞进某一类：一个我们认不出的调用方，
 * 不该被归到「攻击检测」或「路由决策」里去（§7.129：不得断言与数据相矛盾
 * 的事）。
 */
export function traceGroup(t: TraceIndex): TraceGroup {
  if (t.caller === 'prompt-guard') return 'guard'
  if (t.caller === 'intent-classifier') return 'intent'
  if (typeof t.caller === 'string' && t.caller.length > 0) return 'other'
  // 没有 caller：带工具 = 主对话出网（路由决策），一件不带 = 宿主内部调用。
  if (t.toolCount === 0) return 'host'
  return 'route'
}

/** §7.134: 类别的标题文案 —— 复用 Flow 面板的同一批键。 */
export function traceGroupLabel(g: TraceGroup): string {
  switch (g) {
    case 'guard': return tr('flow.guard')
    case 'intent': return tr('flow.intent')
    case 'route': return tr('flow.route')
    case 'host': return tr('trace.caller.host')
    case 'other': return tr('trace.group.other')
  }
}

/** §7.134: 一次往返（REQ + RESP）在面板上的形态。 */
export interface TracePair {
  /** 配对键；旧数据（无 callId）用 traceId 顶上，每条自成一对。 */
  key: string
  /** 请求（上面那条）。 */
  req?: TraceIndex
  /** 响应（下面那条）；重试时取最后一个 —— 那才是最终结果。 */
  resp?: TraceIndex
  /** 归属类别。 */
  group: TraceGroup
}

const str = (v: unknown): string => typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '?'
const num = (v: unknown): number | undefined => typeof v === 'number' ? v : undefined

/** Read one index row. Rows that don't carry a usable traceId are skipped —
 *  a row without an id can never be opened, and showing it would be a
 *  promise the panel cannot keep. */
export function readTraceIndex(row: EdgeRow): TraceIndex | undefined {
  if (row.kind !== 'llm.trace.index') return undefined
  const p = row.payload ?? {}
  const traceId = typeof p.traceId === 'string' ? p.traceId : ''
  if (traceId.length === 0) return undefined
  const kind = p.kind === 'RESP' ? 'RESP' : 'REQ'
  const out: TraceIndex = {
    traceId,
    kind,
    provider: str(p.provider),
    model: str(p.model),
  }
  if (typeof p.caller === 'string') out.caller = p.caller
  for (const key of ['messageCount', 'droppedMessages', 'promptLength', 'contentLength', 'toolCallCount', 'toolCount', 'durationMs', 'bodyBytes'] as const) {
    const v = num(p[key])
    if (v !== undefined) out[key] = v
  }
  for (const key of ['finishReason', 'error', 'baseUrl', 'callId'] as const) {
    if (typeof p[key] === 'string') out[key] = p[key] as string
  }
  return out
}

/**
 * §7.134: 把索引行配成「请求 / 响应」对。
 *
 * - 有 `callId` → 同 callId 的行归一组；组内 RESP 取**最后一个**
 *   （重试时先失败后成功，最终结果才是那次调用的答案）。
 * - 无 `callId`（§7.133 之前的数据）→ 每条自成一组，**不硬配**：
 *   把两条不相干的调用凑成一对是面板在说假话。
 *
 * 输入顺序是**时间正序**（审计行的自然顺序）；返回的组也是正序 ——
 * 调用方决定要不要反转。
 */
export function pairTraces(traces: TraceIndex[]): TracePair[] {
  const byKey = new Map<string, TracePair>()
  for (const t of traces) {
    const key = t.callId !== undefined && t.callId.length > 0 ? t.callId : `solo:${t.traceId}`
    let pair = byKey.get(key)
    if (pair === undefined) {
      pair = { key, group: traceGroup(t) }
      byKey.set(key, pair)
    }
    if (t.kind === 'REQ') {
      pair.req = t
    } else {
      // 最后一个 RESP 覆盖前面的 —— 重试后的最终结果才是答案。
      pair.resp = t
    }
  }
  return [...byKey.values()]
}

/**
 * Who made this call — §7.132's判据, verbatim.
 *
 * An unknown `caller` string is shown as the machine code rather than guessed
 * into a bucket: a call we cannot attribute must not be attributed.
 */
export function callerLabel(t: TraceIndex): string {
  if (t.caller === 'prompt-guard') return tr('trace.caller.guard')
  if (t.caller === 'intent-classifier') return tr('trace.caller.classifier')
  if (typeof t.caller === 'string' && t.caller.length > 0) return t.caller
  if (t.toolCount === 0) return tr('trace.caller.host')
  return tr('trace.caller.conversation')
}

function bytesLabel(n: number | undefined): string {
  if (n === undefined) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** The one-line summary of a call. */
export function traceSummary(t: TraceIndex): string {
  const parts: string[] = []
  if (t.kind === 'REQ') {
    if (t.messageCount !== undefined) parts.push(`${t.messageCount} ${tr('trace.lbl.messages')}`)
    if (t.promptLength !== undefined) parts.push(`${t.promptLength} ${tr('trace.lbl.chars')}`)
    if (t.droppedMessages !== undefined && t.droppedMessages > 0) {
      parts.push(`${tr('trace.lbl.dropped')} ${t.droppedMessages}`)
    }
  } else {
    if (t.contentLength !== undefined) parts.push(`${t.contentLength} ${tr('trace.lbl.chars')}`)
    if (t.toolCallCount !== undefined) parts.push(`${tr('trace.lbl.toolCalls')} ${t.toolCallCount}`)
    if (t.durationMs !== undefined) parts.push(`${tr('flow.lbl.elapsed')} ${(t.durationMs / 1000).toFixed(1)}s`)
  }
  return parts.join(' · ')
}

export function TracePanel(props: { rows: EdgeRow[] }): ReactElement {
  const { rows } = props
  const [openId, setOpenId] = useState<string | undefined>(undefined)
  const [body, setBody] = useState<{ id: string; text?: string; error?: string } | undefined>(undefined)

  const traces: TraceIndex[] = []
  for (const row of rows) {
    const t = readTraceIndex(row)
    if (t !== undefined) traces.push(t)
  }
  // Newest first — the operator asking "what did we just send" wants the last
  // call on top, not at the bottom of a list.
  traces.reverse()

  useEffect(() => {
    if (openId === undefined) {
      setBody(undefined)
      return
    }
    let cancelled = false
    setBody({ id: openId })
    void fetchTraceBody(openId).then((res) => {
      if (cancelled) return
      setBody(res.ok ? { id: openId, text: res.text } : { id: openId, error: res.error })
    })
    return () => { cancelled = true }
  }, [openId])

  const head = h('div', { class: 'dsh-edge-flow-head' },
    h('span', { class: 'dsh-edge-flow-dot' }),
    h('span', { class: 'dsh-edge-flow-label' }, tr('trace.title')),
    h('span', { class: 'dsh-edge-trace-count' }, `${traces.length}`),
  )

  if (traces.length === 0) {
    return h('div', { class: 'dsh-edge-panel dsh-edge-trace' },
      head,
      h('div', { class: 'dsh-edge-empty' }, tr('trace.empty')),
    )
  }

  /**
   * §7.134: 先按类别分组，组内再按 callId 配对。
   *
   * 组内顺序：最新的在前（`traces` 已反转）—— 但**一次往返内部**必须
   * 「上请求、下响应」，所以配对时 REQ 恒在上。
   */
  const groups = new Map<TraceGroup, TracePair[]>()
  for (const pair of pairTraces(traces)) {
    const list = groups.get(pair.group)
    if (list === undefined) groups.set(pair.group, [pair])
    else list.push(pair)
  }

  const renderOne = (t: TraceIndex): ReactElement => {
    const open = openId === t.traceId
    const loaded = body?.id === t.traceId ? body : undefined
    const meta: string[] = []
    if (t.baseUrl !== undefined && t.baseUrl.length > 0) meta.push(t.baseUrl)
    if (t.toolCount !== undefined && t.toolCount > 0) meta.push(`${tr('trace.lbl.tools')} ${t.toolCount}`)
    if (t.finishReason !== undefined && t.finishReason.length > 0) meta.push(t.finishReason)
    if (t.error !== undefined && t.error.length > 0) meta.push(`${tr('flow.lbl.cause')} ${t.error}`)
    const size = bytesLabel(t.bodyBytes)
    if (size.length > 0) meta.push(size)
    return h('div', { class: `dsh-edge-trace-half dsh-edge-trace-half--${t.kind.toLowerCase()}` },
      h('button', {
        class: 'dsh-edge-trace-head',
        type: 'button',
        onClick: () => setOpenId(open ? undefined : t.traceId),
      },
        h('span', { class: `dsh-edge-trace-badge dsh-edge-trace-badge--${t.kind.toLowerCase()}` },
          t.kind === 'REQ' ? tr('trace.req') : tr('trace.resp')),
        h('span', { class: 'dsh-edge-trace-model' }, `${t.provider}/${t.model}`),
        h('span', { class: `dsh-edge-trace-caller${t.caller === undefined && t.toolCount !== 0 ? ' dsh-edge-trace-caller--main' : ''}` },
          callerLabel(t)),
      ),
      h('div', { class: 'dsh-edge-trace-sum' }, traceSummary(t)),
      meta.length > 0 ? h('div', { class: 'dsh-edge-trace-meta' }, meta.join(' · ')) : null,
      open
        ? h('div', { class: 'dsh-edge-trace-body' },
          loaded === undefined
            ? h('div', { class: 'dsh-edge-empty' }, tr('trace.body.loading'))
            : loaded.error !== undefined
              ? h('div', { class: 'dsh-edge-trace-body-err' },
                loaded.error === 'trace-not-found'
                  ? tr('trace.body.gone')
                  : `${tr('trace.body.error')} · ${loaded.error}`)
              : h('pre', { class: 'dsh-edge-trace-pre' }, loaded.text ?? ''),
        )
        : null,
    )
  }

  const sections: ReactElement[] = []
  for (const g of TRACE_GROUP_ORDER) {
    const pairs = groups.get(g)
    if (pairs === undefined || pairs.length === 0) continue
    const items = pairs.map((pair) => {
      // 上请求、下响应 —— 主人的原话。缺哪一半就只显示那半，不补。
      const halves: ReactElement[] = []
      if (pair.req !== undefined) halves.push(renderOne(pair.req))
      if (pair.resp !== undefined) halves.push(renderOne(pair.resp))
      return h('div', { key: pair.key, class: 'dsh-edge-trace-pair' }, ...halves)
    })
    sections.push(h('div', { key: g, class: 'dsh-edge-trace-group' },
      h('div', { class: 'dsh-edge-trace-group-head' },
        h('span', { class: 'dsh-edge-trace-group-name' }, traceGroupLabel(g)),
        h('span', { class: 'dsh-edge-trace-count' }, `${pairs.length}`),
      ),
      h('div', { class: 'dsh-edge-trace-list' }, ...items),
    ))
  }

  return h('div', { class: 'dsh-edge-panel dsh-edge-trace' },
    head,
    ...sections,
  )
}
