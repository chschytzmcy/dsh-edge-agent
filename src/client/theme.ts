/**
 * Theme-following styles, injected once into the host document.
 *
 * No host design tokens are assumed (they are not a public face): the whole
 * sheet paints from `currentColor` + `color-mix`, so dark/light and any host
 * accent follow automatically — the acceptance criterion "配色跟随,无白底
 * 穿帮" holds without knowing the desktop's variable names.
 */

const STYLE_ID = 'dsh-edge-agent-styles'

const CSS = `
/* The host's tab body is overflow:hidden (SidebarRight.module.css .tabBody) and
   hands scrolling to the occupant — without an explicit scroll container here
   the flow + panels below the fold were simply clipped (observed desktop
   10-23: threat panel unreachable). flex:none keeps sections at natural height
   inside the scroller instead of shrinking. */
.dsh-edge-view { font-size: 12px; line-height: 1.5; padding: 8px 10px; display: flex; flex-direction: column; gap: 10px; height: 100%; overflow-y: auto; box-sizing: border-box; }
.dsh-edge-view > * { flex: none; }
.dsh-edge-tab-title { font-weight: 500; }
.dsh-edge-flow { display: flex; flex-direction: column; padding: 6px 8px; border-radius: 6px; background: color-mix(in srgb, currentColor 4%, transparent); }
/* §7.107: every node renders with the same three levels — label line,
   verdict line, evidence lines. The label used to share a baseline with
   the verdict, so a long verdict wrapped under the label and the column
   lost its grid. */
.dsh-edge-flow-node { display: flex; flex-direction: column; font-size: 12px; line-height: 1.5; }
.dsh-edge-flow-head { display: flex; align-items: center; gap: 6px; }
.dsh-edge-flow-arrow { width: 8px; text-align: center; opacity: 0.35; font-size: 10px; line-height: 1.1; margin-left: 3px; }
.dsh-edge-flow-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; align-self: center; background: color-mix(in srgb, currentColor 25%, transparent); }
.dsh-edge-flow-label { flex: none; font-weight: 600; }
.dsh-edge-flow-detail { padding-left: 14px; opacity: 0.85; overflow-wrap: anywhere; }
.dsh-edge-flow-sub { font-size: 11px; line-height: 1.5; opacity: 0.55; padding-left: 26px; overflow-wrap: anywhere; }
.dsh-edge-flow-node--ok .dsh-edge-flow-dot { background: #16a34a; }
.dsh-edge-flow-node--warn .dsh-edge-flow-dot { background: #d97706; }
.dsh-edge-flow-node--stop .dsh-edge-flow-dot { background: #dc2626; }
.dsh-edge-flow-node--run .dsh-edge-flow-dot { background: #2563eb; }
.dsh-edge-flow-node--info .dsh-edge-flow-dot { background: #64748b; }
.dsh-edge-flow-node--wait { opacity: 0.5; }
.dsh-edge-verdict { font-size: 12px; font-weight: 600; padding: 5px 8px; border-radius: 6px; border-left: 2px solid currentColor; background: color-mix(in srgb, currentColor 5%, transparent); }
.dsh-edge-verdict--local { color: #16a34a; }
.dsh-edge-verdict--cloud { color: inherit; }
.dsh-edge-verdict--wait { opacity: 0.55; font-weight: 400; }
/* §7.219: 这一轮被 fail-closed 拒收 ⇒ 它**没作答** ⇒ 结论行说「已拦截」。
   颜色与 flow 节点的 stop（#dc2626）一致 —— 红色 = 这一轮没走通。 */
.dsh-edge-verdict--blocked { color: #dc2626; }
/* §7.145: 未绑定会话 —— 明说「现在没有会话」，全局信号另起一组。 */
.dsh-edge-unbound { display: flex; flex-direction: column; gap: 3px; padding: 6px 8px; border-radius: 6px; border-left: 2px solid color-mix(in srgb, currentColor 35%, transparent); background: color-mix(in srgb, currentColor 5%, transparent); }
.dsh-edge-unbound b { font-weight: 600; }
.dsh-edge-unbound span { opacity: 0.7; font-size: 11px; line-height: 1.5; }
.dsh-edge-groups { display: flex; flex-direction: column; gap: 8px; }
.dsh-edge-summary { display: flex; flex-wrap: wrap; gap: 10px; padding: 6px 8px; border-radius: 6px; background: color-mix(in srgb, currentColor 6%, transparent); }
.dsh-edge-summary b { font-weight: 600; }
.dsh-edge-panel h4 { margin: 0 0 4px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.65; font-weight: 600; }
.dsh-edge-rows { display: flex; flex-direction: column; gap: 3px; max-height: 240px; overflow-y: auto; }
.dsh-edge-row { padding: 3px 6px; border-radius: 4px; background: color-mix(in srgb, currentColor 4%, transparent); }
.dsh-edge-row-head { display: flex; gap: 6px; align-items: baseline; }
.dsh-edge-row .ts { opacity: 0.5; flex: none; font-variant-numeric: tabular-nums; font-size: 11px; }
.dsh-edge-row .k { font-weight: 600; overflow-wrap: anywhere; }
.dsh-edge-row .f { opacity: 0.75; font-size: 11px; line-height: 1.35; margin-top: 1px; overflow-wrap: anywhere; }
.dsh-edge-row.warn { background: color-mix(in srgb, #d97706 14%, transparent); }
.dsh-edge-row.error, .dsh-edge-row.security { background: color-mix(in srgb, #dc2626 14%, transparent); }
.dsh-edge-empty, .dsh-edge-stale { opacity: 0.5; font-style: italic; }
.dsh-edge-stale { color: #dc2626; opacity: 0.8; }
/* §7.133: the LLM call log — one line per call, body on demand. */
.dsh-edge-trace { display: flex; flex-direction: column; gap: 4px; }
.dsh-edge-trace-count { margin-left: auto; opacity: 0.5; font-variant-numeric: tabular-nums; }
.dsh-edge-trace-list { display: flex; flex-direction: column; gap: 4px; }
.dsh-edge-trace-item { padding: 4px 6px; border-radius: 4px; background: color-mix(in srgb, currentColor 4%, transparent); }
.dsh-edge-trace-head { display: flex; gap: 6px; align-items: baseline; width: 100%; text-align: left; background: none; border: none; color: inherit; font: inherit; padding: 0; cursor: pointer; }
.dsh-edge-trace-badge { flex: none; font-size: 10px; font-weight: 700; letter-spacing: 0.03em; padding: 0 3px; border-radius: 3px; background: color-mix(in srgb, currentColor 15%, transparent); }
.dsh-edge-trace-badge--req { color: #2563eb; }
.dsh-edge-trace-badge--resp { color: #16a34a; }
.dsh-edge-trace-model { flex: 1 1 auto; font-weight: 600; overflow-wrap: anywhere; }
.dsh-edge-trace-caller { flex: none; font-size: 10px; opacity: 0.65; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); border-radius: 3px; padding: 0 3px; }
.dsh-edge-trace-caller--main { opacity: 0.9; }
.dsh-edge-trace-sum { font-size: 11px; opacity: 0.8; padding-left: 2px; overflow-wrap: anywhere; }
.dsh-edge-trace-meta { font-size: 10px; opacity: 0.45; overflow-wrap: anywhere; }
.dsh-edge-trace-body { margin-top: 4px; }
.dsh-edge-trace-body-err { font-size: 11px; color: #d97706; }
.dsh-edge-trace-pre { margin: 0; max-height: 260px; overflow: auto; padding: 5px 6px; border-radius: 4px; background: color-mix(in srgb, currentColor 6%, transparent); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
/* §7.134: 按类别分组 + 请求/响应成对（上请求、下响应）。 */
.dsh-edge-trace-group { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
.dsh-edge-trace-group-head { display: flex; gap: 6px; align-items: baseline; padding: 1px 2px; border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent); }
.dsh-edge-trace-group-name { font-size: 11px; font-weight: 700; letter-spacing: 0.02em; }
.dsh-edge-trace-pair { display: flex; flex-direction: column; gap: 2px; padding: 4px 6px; border-radius: 4px; background: color-mix(in srgb, currentColor 4%, transparent); }
.dsh-edge-trace-half { padding-left: 6px; border-left: 2px solid transparent; }
.dsh-edge-trace-half--req { border-left-color: #2563eb; }
.dsh-edge-trace-half--resp { border-left-color: #16a34a; }
`

export function ensureStyles(doc?: Document): void {
  const d = doc ?? (typeof document !== 'undefined' ? document : undefined)
  if (d === undefined) return
  if (d.getElementById(STYLE_ID) !== null) return
  const el = d.createElement('style')
  el.id = STYLE_ID
  el.textContent = CSS
  d.head.appendChild(el)
}
