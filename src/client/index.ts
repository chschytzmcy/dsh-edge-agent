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
import { SessionSummaryBar } from './sessionSummary'
import { FlowPanel } from './flowPanel'
import { TracePanel } from './tracePanel'
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

/** §7.136: the Agent Preset id this bundle declares (presets/edge*.patch.yml). */
const EDGE_PRESET_ID = 'edge'

/** How often the preset roster is re-read (ms).
 *
 *  The roster is the only client-visible source for "which preset is the
 *  active one" that does not require a live session: `agentPresets.list()`
 *  marks the row with `isDefault` — the registry's `defaultId`, i.e. the
 *  preset new sessions run under (the settings page's 「设为默认」 writes it).
 *  5s keeps the tab's appearance within a blink of the switch without
 *  hammering the host (the response is a handful of small rows).
 */
const ROSTER_POLL_MS = 5_000

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

/** The `remote.agentPresets` face — the preset roster.
 *
 *  `broken` is the activation diagnostic the registry publishes for a preset
 *  whose composition failed to mount (dsh-agent-preset-registry/src/index.ts
 *  `list()`): a broken preset has no working plugin tree, so nothing it
 *  promises can reach the model. */
interface AgentPresetsFace {
  list(): Promise<{
    ok: boolean
    value?: { presets?: Array<{ id?: string; name?: string; isDefault?: boolean; broken?: string }> }
  }>
}

/**
 * Find the roster face in whatever the framework handed us.
 *
 * The host's own preset UI injects BOTH `remote` and `remote.agentPresets`
 * (packages/client/ui-agent-preset/src/client/index.ts) and reads the roster
 * as `ctx.remote.agentPresets.list()`. A sub-namespace injection may hand
 * over the namespace itself, the parent namespace, or the enclosing context —
 * accept every shape and never let a missing face throw (the tab simply stays
 * hidden).
 */
function pickAgentPresets(raw: unknown): AgentPresetsFace | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const r = raw as { list?: unknown; agentPresets?: unknown; remote?: unknown }
  if (typeof r.list === 'function') return raw as AgentPresetsFace
  const nested = r.agentPresets as AgentPresetsFace | undefined
  if (nested !== undefined && typeof nested.list === 'function') return nested
  const remote = r.remote as { agentPresets?: unknown } | undefined
  if (remote !== undefined) {
    const face = remote.agentPresets as AgentPresetsFace | undefined
    if (face !== undefined && typeof face.list === 'function') return face
  }
  return undefined
}

/** Read `ctx.remote` — an undeclared service throws, so the read is guarded. */
function remoteFace(ctx: CordisCtx): AgentPresetsFace | undefined {
  try {
    const remote = (ctx as unknown as { remote?: unknown }).remote
    return pickAgentPresets(remote)
  } catch {
    return undefined
  }
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
  effect?(cb: () => void | (() => void), label?: string): () => void
}

/* ── The view ──────────────────────────────────────────────────────────── */

/**
 * The verdict line lives in its own module (`./verdict`) — it is a pure
 * function of the rows, so it can be asserted directly by the unit tests
 * without dragging the whole webview entry into scope.
 */
import { verdictLine } from './verdict'

function EdgeView(props: SessionProps) {
  const sessionId = props.sessionId ?? '_global'
  const [, setTick] = useState(0)
  useEffect(() => {
    ensureStyles()
    return edgeStore.attach(sessionId, () => setTick(t => t + 1))
  }, [sessionId])

  const summary: EdgeSummary = edgeStore.summaryFor(sessionId)
  // Raw event panels dropped 2026-10-23 (operator: 「下面那段不关心」) —
  // the flow view carries the evidence lines; rows stay in the store for
  // anything that later wants them back.
  const allRows: EdgeRow[] = edgeStore.currentRows(sessionId, summary.turns, summary.turnStartTs)
  const verdict = verdictLine(allRows)
  return h('div', { class: 'dsh-edge-view' },
    h(SessionSummaryBar, { summary }),
    h('div', { class: `dsh-edge-verdict dsh-edge-verdict--${verdict.tone}` }, verdict.text),
    h(FlowPanel, { rows: allRows, summary }),
    // §7.133: the LLM call log — one line per call (index), body on demand.
    h(TracePanel, { rows: allRows }),
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

  // ── §7.136: the Edge tab exists only in 边缘模式 ─────────────────────────
  //
  // 主人裁决（2026-10-28）：「只有选择 边缘模式 才会出现 edge tab」。
  //
  // The webview's module graph is GLOBAL — the host composes ONE boot graph
  // for the whole app (@deepseek-ai/dsh-client-modules), and the sidebar's tab
  // registry lists every registered tab type for every session. So the only
  // way to make the tab appear in one work mode and not in another is to
  // register / unregister the tab TYPE.
  //
  // The signal: `agentPresets.list()` marks the roster row with `isDefault` —
  // the registry's `defaultId`, i.e. the preset new sessions run under (the
  // settings page's 「设为默认」 writes exactly that). We poll it and register
  // the type only while the active preset is ours.
  //
  // Known gap (documented in docs/PROGRESS.md §7.136): a per-session pick
  // (the conversation chip's preset selector) does NOT change the default,
  // so the tab stays hidden for that session — the SERVER side still behaves
  // per session (the Edge hooks are scope-bound to the preset, see
  // src/dsh-adapter/input-guard.ts).
  let tabVisible = false
  let disposeTabType: (() => void) | undefined
  const setTabVisible = (visible: boolean): void => {
    tabVisible = visible
    if (visible) {
      if (disposeTabType !== undefined) return
      ctx.inject(['sidebarRightTabs'], (raw) => {
        // The roster may have flipped back while the face was still pending;
        // registering then would publish a tab nobody asked for.
        if (!tabVisible || disposeTabType !== undefined) return
        const c = raw as unknown as CordisCtx & { sidebarRightTabs?: SidebarTabsFace }
        const tabs = c.sidebarRightTabs
        if (tabs === undefined || typeof tabs.register !== 'function') return
        try {
          const dispose = tabs.register({
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
          disposeTabType = dispose
        } catch (error) {
          reportFailure('sidebar tab type registration', error)
        }
      })
      return
    }
    // Hide: drop the type again — the sidebar refreshes on registry change.
    const dispose = disposeTabType
    disposeTabType = undefined
    if (typeof dispose === 'function') dispose()
  }

  // Roster watcher — deferred: a missing remote must never pend this fiber
  // (the web boot audit THROWS on a pending entry; a missing tab is a small
  // loss, a boot failure is the app).
  ctx.inject(['remote', 'remote.agentPresets'], (raw) => {
    const api = pickAgentPresets(raw) ?? remoteFace(ctx)
    if (api === undefined || typeof api.list !== 'function') return
    const check = async (): Promise<void> => {
      try {
        const result = await api.list()
        if (!result.ok) return
        const presets = result.value?.presets
        if (!Array.isArray(presets)) return
        const edge = presets.find((p) => p.id === EDGE_PRESET_ID)
        const active = presets.find((p) => p.isDefault === true)
        // A preset that failed to mount has no working composition: showing
        // the tab would promise panels the server cannot fill.
        const healthy = edge !== undefined && edge.broken === undefined
        setTabVisible(healthy && active?.id === EDGE_PRESET_ID)
      } catch (error) {
        // A roster fault must not blank the panel: keep the current state.
        reportFailure('preset roster read', error)
      }
    }
    void check()
    const timer = setInterval(() => { void check() }, ROSTER_POLL_MS)
    ctx.effect?.(() => () => {
      clearInterval(timer)
      setTabVisible(false)
    }, 'dsh-edge-agent: preset roster watcher')
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
