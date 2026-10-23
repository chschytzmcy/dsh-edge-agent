/**
 * dsh-edge-agent — client half (§7.101).
 *
 * Mounts the desktop right-sidebar "Edge" tab: 4 live panels (intent /
 * route / interception / threat) + a session summary bar, fed by the host
 * `edge-context-view` fold over the `/api/dsh-edge/context` pull route
 * (docs/notes/dsh-context-walkthrough.md).
 *
 * Wiring follows dsh-context v0.73.3 exactly:
 *   - `sidebarRightTabs.register` seats the tab TYPE (deferred: CLI/TUI
 *     profiles never compose the face and must mount cleanly).
 *   - `slots.register('sidebar.right.pane.tab', {key: <tab kind>})` seats
 *     the body component, receiving the framework session-scoped kit
 *     (`sessionId`, and the projection seat we do not use — edge privacy
 *     events cannot ride session projections, walkthrough §1).
 *   - `locale.register/bind` paints zh/en labels; without the face the
 *     built-in English table keeps the tab readable.
 *
 * Face types are declared locally because the client UI packages ship
 * inside the desktop app.asar and are not on npm (dsh-context does the
 * same). Every face is re-proved at its call site; a hostile or absent
 * face costs the feature, never the bundle.
 */

import { createElement as h, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { edgeStore } from './store'
import { ensureStyles } from './theme'
import { EDGE_DICTIONARIES, EDGE_LOCALE_NS, setTranslator, tr } from './i18n'
import { IntentPanel } from './intentPanel'
import { RoutePanel } from './routePanel'
import { InterceptionPanel } from './interceptionPanel'
import { ThreatPanel } from './threatPanel'
import { SessionSummaryBar } from './sessionSummary'
import { FlowPanel } from './flowPanel'
import type { EdgeRow, EdgeSummary } from './types'

/* ── Identity ──────────────────────────────────────────────────────────── */

export const name = 'dsh-edge-agent-client'

/**
 * Hard service dependencies — exactly the pair dsh-context declares.
 *
 * `sidebarRightTabs` stays OUT of this list on purpose. The right Sidebar
 * publishes that registry through `ctx.reflect.provide()` from its own fiber
 * scope (dsh-client-ui-sidebar-right/src/client/index.ts:150), and dsh-context
 * — the reference implementation whose Context tab demonstrably appears on
 * this desktop — keeps it on a deferred `ctx.inject` for the same reason:
 * the face is optional by contract, so this fiber must never pend on it.
 *
 * The cost of pend matters: the web boot audits every entry
 * (dsh-client-web/src/boot-client.ts:66-88) and THROWS when one is still
 * pending, which fails the whole application, not just this tab. A missing
 * tab is a small loss; a boot failure is the app.
 */
export const inject: readonly string[] = ['slots', 'locale']

const TAB_ID = 'dsh-edge-agent'

/* ── Face types (mirror dsh-context's services.ts) ─────────────────────── */

interface SidebarGuideEntry {
  /** Unique id of the guide entry.
   *
   *  The sidebar-right registry rejects a definition whose guide entries
   *  share an id (`new Set(entries.map(e => e.id)).size !== entries.length`),
   *  and the guide body forwards `entry.id` as the slot's `entryId`, so an
   *  entry without one renders with `entryId: undefined`. */
  id: string
  order: number
  title: () => string
  description?: () => string
  icon?: { size?: number }
}

interface SidebarTabDef {
  id: string
  kind: string
  title: () => string
  guide?: readonly SidebarGuideEntry[]
}

interface SidebarTabsFace {
  register(def: SidebarTabDef): () => void
}

interface SlotRegistration {
  name: string
  key?: string
  id?: string
  order?: number
  locale?: string
  label?: () => string
}

interface SlotsFace {
  inject(name: string, callback: () => unknown): unknown
  register(reg: SlotRegistration, component: (props: { sessionId?: string } & Record<string, unknown>) => unknown): unknown
}

interface LocaleFace {
  register(ns: string, dicts: Record<string, Record<string, string>>): () => void
  bind(ns: string): (key: string, params?: Record<string, string | number>) => string
}

interface SessionProps {
  sessionId?: string
}

/** Minimal Cordis context shape consumed by the client. Local declaration
 *  — the verify:boundary gate blocks `@deepseek-ai/*` imports outside
 *  src/dsh-adapter/ (this module is shipped as the webview bundle and has
 *  no compile-time view of the host types). */
interface CordisCtx {
  inject(deps: readonly string[], cb: (raw: unknown) => void): void
  on?(event: string, cb: (session: unknown, event: unknown) => void): () => void
}

/* ── The view ──────────────────────────────────────────────────────────── */

/**
 * One-glance verdict for the current turn (§7.106 clarity request): the
 * panel rows are evidence, but the takeaway — did this turn leave the
 * device, and was PII scrubbed first — must read as a single line.
 */
function verdictLine(rows: EdgeRow[]): { text: string; tone: 'local' | 'cloud' | 'wait' } {
  const newest = <T extends EdgeRow>(list: T[]): T | undefined => list.at(-1)
  const classify = newest(rows.filter(r => r.kind === 'intent.classify.end'))
  const host = newest(rows.filter(r => r.kind === 'llm.host.route'))
  const scrubbed = rows.some(r => r.kind === 'sanitizer.sanitized' || r.kind === 'guard.rule.sanitized')
  if (classify === undefined && host === undefined) return { text: tr('verdict.waiting'), tone: 'wait' }
  const local = classify !== undefined && classify.payload.category === 'LOCAL'
    || host !== undefined && String(host.payload.provider ?? '').startsWith('local-llm')
  if (local) return { text: tr('verdict.local'), tone: 'local' }
  return { text: tr('verdict.cloud') + (scrubbed ? tr('verdict.sanitized') : ''), tone: 'cloud' }
}

function EdgeView(props: SessionProps) {
  const sessionId = props.sessionId ?? '_global'
  const [, setTick] = useState(0)
  useEffect(() => {
    ensureStyles()
    return edgeStore.attach(sessionId, () => setTick(t => t + 1))
  }, [sessionId])

  const summary: EdgeSummary = edgeStore.summaryFor(sessionId)
  const rows = (panel: EdgeRow['panel']) => edgeStore.rowsFor(sessionId, panel, summary.turns)
  const allRows: EdgeRow[] = (['intent', 'route', 'interception', 'threat'] as const).flatMap(rows)
  const verdict = verdictLine(allRows)
  return h('div', { class: 'dsh-edge-view' },
    h(SessionSummaryBar, { summary }),
    h('div', { class: `dsh-edge-verdict dsh-edge-verdict--${verdict.tone}` }, verdict.text),
    h(FlowPanel, { rows: allRows, summary }),
    h(IntentPanel, { rows: rows('intent') }),
    h(RoutePanel, { rows: rows('route') }),
    h(InterceptionPanel, { rows: rows('interception') }),
    h(ThreatPanel, { rows: rows('threat') }),
    edgeStore.failing(sessionId) ? h('div', { class: 'dsh-edge-stale' }, tr('row.stale')) : null,
  )
}

/* ── Plugin apply ──────────────────────────────────────────────────────── */

/**
 * Report a registration failure to the webview console.
 *
 * A failed registration and a missing plugin produce the SAME symptom — no
 * Edge tab — and this bundle's whole failure mode used to be invisible: the
 * catch blocks were empty, so a registry that rejected the definition (a
 * taken id, a colliding kind, a duplicate guide-entry id) left no trace.
 * The tab registry throws exactly on those conditions
 * (dsh-client-ui-sidebar-right/src/client/tab-registry.ts:256-261), and the
 * slot runtime rethrows a delayed setup failure asynchronously
 * (ui-renderer/src/client/registry.ts:257) — so a silent catch here can even
 * swallow an error the host meant to surface.
 *
 * The failure still costs only the tab: the plugin stays healthy and the
 * other panels keep working. It is just no longer silent.
 */
function reportFailure(what: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[dsh-edge-agent] ${what} failed: ${message}`)
}

export function apply(ctx: CordisCtx): void {
  // Locale first: the tab title/guide are painted at registration time.
  ctx.inject(['locale'], (raw) => {
    const c = raw as unknown as CordisCtx & { locale?: LocaleFace }
    const locale = c.locale
    if (locale === undefined || typeof locale.register !== 'function' || typeof locale.bind !== 'function') return
    try {
      locale.register(EDGE_LOCALE_NS, EDGE_DICTIONARIES)
      setTranslator(locale.bind(EDGE_LOCALE_NS))
    } catch (error) {
      // The built-in EN table stays active — the tab stays readable.
      reportFailure('locale registration', error)
    }
  })

  // Tab type seat — deferred; absent on CLI/TUI hosts.
  ctx.inject(['sidebarRightTabs'], (raw) => {
    const c = raw as unknown as CordisCtx & { sidebarRightTabs?: SidebarTabsFace }
    const tabs = c.sidebarRightTabs
    if (tabs === undefined || typeof tabs.register !== 'function') return
    try {
      tabs.register({
        id: TAB_ID,
        kind: TAB_ID,
        title: () => tr('tab.title'),
        guide: [{
          // The registry validates guide entries by `id` uniqueness
          // (`new Set(entries.map(e => e.id)).size === entries.length`) and
          // the guide body keys capsules by it — an undefined id would make
          // one entry look duplicated to a second contributor.
          id: `${TAB_ID}-guide`,
          order: 30,
          title: () => tr('tab.title'),
          description: () => tr('guide.description'),
        }],
      })
    } catch (error) {
      reportFailure('sidebar tab type registration', error)
    }
  })

  // Body seat — keyed by the tab kind, painted with the React tree.
  ctx.inject(['slots'], (raw) => {
    const c = raw as unknown as CordisCtx & { slots?: SlotsFace }
    const slots = c.slots
    if (slots === undefined || typeof slots.register !== 'function' || typeof slots.inject !== 'function') return
    try {
      slots.inject('sidebar.right.pane.tab', () => slots.register(
        { name: 'sidebar.right.pane.tab', key: TAB_ID, locale: EDGE_LOCALE_NS },
        (props: SessionProps) => h(EdgeView, { ...props }),
      ))
      // The chip's title seat. The harness dispatches the title under the
      // TYPE's id (SidebarRight.tsx:211 → `entryKey = definition?.id ?? tab.kind`),
      // so the key here must be the registry id, not the kind — they are equal
      // for this plugin, and the pair stays in one place so they cannot drift.
      slots.inject('sidebar.right.pane.tab.title', () => slots.register(
        { name: 'sidebar.right.pane.tab.title', key: TAB_ID },
        () => h('span', { className: 'dsh-edge-tab-title' }, tr('tab.title')),
      ))
    } catch (error) {
      reportFailure('sidebar tab body registration', error)
    }
  })
}

/* Keep the framework's tree in charge of mounting: `render` is exported for
 * the standalone smoke harness only (tests/browser debug). React 19 dropped
 * legacy render(); the harness uses createRoot against a host element. */
export function render(element: ReactElement, container: Element): () => void {
  const root = createRoot(container)
  root.render(element)
  return () => root.unmount()
}
export { h }
