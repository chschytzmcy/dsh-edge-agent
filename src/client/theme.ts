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
.dsh-edge-view { font-size: 12px; line-height: 1.5; padding: 8px 10px; display: flex; flex-direction: column; gap: 10px; }
.dsh-edge-summary { display: flex; flex-wrap: wrap; gap: 10px; padding: 6px 8px; border-radius: 6px; background: color-mix(in srgb, currentColor 6%, transparent); }
.dsh-edge-summary b { font-weight: 600; }
.dsh-edge-panel h4 { margin: 0 0 4px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.65; font-weight: 600; }
.dsh-edge-rows { display: flex; flex-direction: column; gap: 2px; max-height: 180px; overflow-y: auto; }
.dsh-edge-row { display: flex; gap: 6px; padding: 2px 6px; border-radius: 4px; background: color-mix(in srgb, currentColor 4%, transparent); white-space: nowrap; overflow: hidden; }
.dsh-edge-row .ts { opacity: 0.5; flex: none; font-variant-numeric: tabular-nums; }
.dsh-edge-row .k { flex: none; font-weight: 550; }
.dsh-edge-row .f { opacity: 0.8; overflow: hidden; text-overflow: ellipsis; }
.dsh-edge-row.warn { background: color-mix(in srgb, #d97706 14%, transparent); }
.dsh-edge-row.error, .dsh-edge-row.security { background: color-mix(in srgb, #dc2626 14%, transparent); }
.dsh-edge-empty, .dsh-edge-stale { opacity: 0.5; font-style: italic; }
.dsh-edge-stale { color: #dc2626; opacity: 0.8; }
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
