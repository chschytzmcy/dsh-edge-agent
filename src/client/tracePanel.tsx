/**
 * tracePanel — §7.133: the Edge tab's **LLM call log**.
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
 * ## 归属（谁调的这次 LLM）
 *
 * §7.132 的判据在这里复用，不另造一套：
 *
 *   - `caller = prompt-guard`   → 安检（语义检测）
 *   - `caller = intent-classifier` → 分类器（jev 决策模型 / LLM 分类器）
 *   - 没有 caller 且 `toolCount === 0` → 宿主自己的内部调用（比如会话标题
 *     生成）—— 不是主对话出网
 *   - 没有 caller 且带工具 → 主对话出网
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
  for (const key of ['finishReason', 'error', 'baseUrl'] as const) {
    if (typeof p[key] === 'string') out[key] = p[key] as string
  }
  return out
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

  const items = traces.map((t) => {
    const open = openId === t.traceId
    const loaded = body?.id === t.traceId ? body : undefined
    const meta: string[] = []
    if (t.baseUrl !== undefined && t.baseUrl.length > 0) meta.push(t.baseUrl)
    if (t.toolCount !== undefined && t.toolCount > 0) meta.push(`${tr('trace.lbl.tools')} ${t.toolCount}`)
    if (t.finishReason !== undefined && t.finishReason.length > 0) meta.push(t.finishReason)
    if (t.error !== undefined && t.error.length > 0) meta.push(`${tr('flow.lbl.cause')} ${t.error}`)
    const size = bytesLabel(t.bodyBytes)
    if (size.length > 0) meta.push(size)
    return h('div', { key: t.traceId, class: 'dsh-edge-trace-item' },
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
  })

  return h('div', { class: 'dsh-edge-panel dsh-edge-trace' },
    head,
    h('div', { class: 'dsh-edge-trace-list' }, ...items),
  )
}
