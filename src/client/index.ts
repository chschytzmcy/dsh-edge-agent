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

/** The `sessions` face — the host's client-side session directory.
 *
 *  §7.142: the SESSION-level preset signal, read exactly the way the host
 *  reads it (ui-agent-preset/src/client/seat-store.ts:265 `presetOf`:
 *  `session.projectionValues.agentPreset`). The roster's `isDefault` only
 *  says what NEW sessions run under; this says what THIS session runs
 *  under — which is what 「只有边缘模式才真正生效」 actually needs. */
interface SessionsFace {
  list: {
    getSnapshot(): {
      byId?: Record<string, { projectionValues?: { agentPreset?: unknown } } | undefined> | undefined
    }
  }
}

/** The `sidebarRight` face — the host's right-sidebar controller.
 *
 *  `openTab(kind)` acts on the session **currently on screen** (the host
 *  throws when there is none) and expands the column, because content the
 *  user cannot see is not opened; `mounted` publishes that session;
 *  `tabsIn(sessionId)` lists one session's committed tabs; `close(tabId)`
 *  closes one of the on-screen session's tabs. */
interface SidebarRightFace {
  openTab(kind: string, options?: { replaceTab?: boolean }): void
  close?(tabId: string): void
  /** The controller's per-session close — NOT part of the published face
   *  interface, but the controller instance behind the face carries it
   *  (dsh-client-ui-sidebar-right/src/client/service.ts:375 `closeIn`).
   *  We use it to clear a session's Edge tab that is not on screen. */
  closeIn?(sessionId: string, tabId: string): void
  mounted?: { getSnapshot(): string | undefined; subscribe(listener: () => void): () => void }
  tabsIn?(sessionId: string): readonly { id?: string; kind?: string }[]
}

/** §7.139: how long the auto-open ladder waits between attempts (ms).
 *
 *  The host names the on-screen session BEFORE React renders the change that
 *  brings it on screen, and the sidebar's seat mints that session's store
 *  during that render (dsh-client-ui-sidebar-right/src/client/service.ts:
 *  "It changes before React renders the selection or panel change that causes
 *  it … its seat mints its store in the same render"). So at the moment we
 *  learn about a session its store does not exist yet, and `openTab` throws
 *  "no session surface is mounted" (service.ts:746).
 *
 *  The ladder waits for that render. A ladder that runs out is restarted by
 *  the 5s roster poll, so a session that never settles is retried forever
 *  without a busy loop. */
const AUTO_OPEN_RETRY_MS = [0, 80, 300, 900, 2500] as const

/**
 * Read one property without letting a hostile scope throw.
 *
 *  The injected scope is a CORDIS CONTEXT PROXY, not a plain object: reading a
 *  name that the scope does not carry throws
 *  "cannot get property \"…\" without inject"
 *  (@deepseek-ai/cordis lib/index.js:676). §7.136 probed `scope.list` and
 *  `scope.agentPresets` unguarded — neither name is provided — so the roster
 *  watcher THREW on its first line and never read the roster: the Edge tab
 *  type was never registered, in any work mode (§7.139).
 */
function readProperty(source: unknown, key: string): unknown {
  if (source === null || typeof source !== 'object') return undefined
  try {
    return (source as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

/**
 * Find the roster face in whatever the framework handed us.
 *
 * The host's own preset UI injects BOTH `remote` and `remote.agentPresets`
 * (packages/client/ui-agent-preset/src/client/index.ts:65-67) and reads the
 * roster as `ctx.remote.agentPresets.list()`. A sub-namespace injection may hand
 * over the namespace itself, the parent namespace, or the enclosing context —
 * accept every shape and never let a missing face throw (the tab simply stays
 * hidden).
 */
function pickAgentPresets(raw: unknown): AgentPresetsFace | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  // The namespace itself (a scope that carries the methods directly).
  if (typeof readProperty(raw, 'list') === 'function') return raw as AgentPresetsFace
  const candidates: unknown[] = []
  // The namespace under its bare name.
  candidates.push(readProperty(raw, 'agentPresets'))
  // The namespace under the parent namespace (`ctx.remote.agentPresets`).
  const remote = readProperty(raw, 'remote')
  if (remote !== undefined) candidates.push(readProperty(remote, 'agentPresets'))
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue
    if (typeof readProperty(candidate, 'list') === 'function') return candidate as AgentPresetsFace
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
  /** Read a service by name; `undefined` when it is not registered.
   *  The host's own client code reads faces this way
   *  (dsh-client-ui-chat/src/client/apply.ts:280 `ctx.get('sidebarRightTabs')`). */
  get?(name: string): unknown
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

  // ── §7.142: the Edge tab is ALWAYS there; 边缘模式 is what makes it LIVE ──
  //
  // 主人裁决（2026-10-28 15:40）：「edge tab 一直都在，只有边缘模式才真正生效」
  // —— 推翻了 §7.136 的「只有边缘模式才出现 tab」。
  //
  // 之前 tab 的可见性跟**名册默认 preset** 走，而默认 preset 归宿主管：主人把
  // 默认改回标准模式（§7.141）之后，任何工作方式都看不见 Edge tab，连手动
  // 选了边缘模式的会话也看不见 —— 主人说「回退到之前」。
  //
  // 现在分成两件事，各归其位：
  //   - **可见性**：tab 类型常驻注册（任何工作方式都有这个 chip，可点开）。
  //   - **生效性**：只有**边缘模式会话**才自动打开面板、才有本项目能力。
  //     能力隔离在服务端早已完成（hook 绑 preset 作用域，§7.136；§7.140 实测
  //     标准模式会话审计链零事件），客户端这边不再重复扮演能力开关。
  //
  // 「这个会话是不是边缘模式」按**会话级**信号判定，不再看默认 preset：宿主
  // 自己就是用 `session.projectionValues.agentPreset` 判的
  // (ui-agent-preset/src/client/seat-store.ts:265 `presetOf`)。
  let tabRegistered = false
  let disposeTabType: (() => void) | undefined
  /** Is 边缘模式 mounted and healthy? A broken preset has no working
   *  composition, so the tab would promise panels the server cannot fill. */
  let edgeHealthy = true
  /** The roster's default preset — only a FALLBACK, for the sessions face
   *  being unreadable (then the host cannot name this session's preset). */
  let defaultIsEdge = false

  // ── §7.139: 边缘模式 opens its own tab ──────────────────────────────────
  //
  // 主人报（2026-10-28）：「重新启动了 dsh 桌面版，全部工作模式都没有出现
  // edge tab」。定性结论（§7.138）：tab 类型确实注册了（在会话里点开可见），
  // 但宿主**不会自动打开任何一个 tab** —— 默认页是 guide，tab 要从 guide 点
  // 开 (dsh-client-ui-sidebar-right/src/client/contract/seed.ts:26
  // `defaultSeed`: 只有唯一 guide 条目才作默认页，否则默认页是 guide)。
  //
  // 所以边缘模式自己开：会话上台的那一刻，把 Edge tab 开在它里面。这正是
  // 宿主自己的插件用的导航（`ctx.sidebarRight.openTab(kind)`，
  // dsh-experimental-client-ui-forge/src/client/mount.ts:251）。
  //
  // §7.142: 「谁是边缘模式」现在按**会话**判定（见 sessionUsesEdge），不再按
  // 名册默认 preset 判定 —— 主人手动选边缘模式的会话照样自动开面板。

  /** Sessions the Edge tab was auto-opened in — one open per session, and
   *  never re-opened after the user closed it themselves. */
  const openedSessions = new Set<string>()
  /** The host's right-sidebar controller, once it is readable. */
  let sidebar: SidebarRightFace | undefined
  /** The retry ladder in flight (at most one: only the on-screen session
   *  matters, and the ladder is restarted for the next one). */
  let pendingOpen: { sessionId: string; attempt: number; timer: ReturnType<typeof setTimeout> } | undefined

  /** The Edge tab record of one session, if that session has one. */
  const edgeTabIn = (sessionId: string): { id?: string } | undefined => {
    if (sidebar === undefined || typeof sidebar.tabsIn !== 'function') return undefined
    try {
      return sidebar.tabsIn(sessionId).find(tab => tab.kind === TAB_ID)
    } catch (error) {
      reportFailure('edge tab lookup', error)
      return undefined
    }
  }

  /** The preset THIS session runs under, or undefined when the host cannot say.
   *
   *  Read through `ctx.get` — never `inject`: the sessions face is optional
   *  by contract and this fiber must never pend on it (a pending entry fails
   *  the whole web boot — dsh-client-web/src/boot-client.ts:66-88). */
  const sessionPresetOf = (sessionId: string): string | undefined => {
    let raw: unknown
    try {
      raw = ctx.get?.('sessions')
    } catch {
      return undefined
    }
    const sessions = raw as SessionsFace | undefined
    if (sessions === undefined || typeof sessions.list?.getSnapshot !== 'function') return undefined
    try {
      const byId = sessions.list.getSnapshot()?.byId
      const value = byId?.[sessionId]?.projectionValues?.agentPreset
      return typeof value === 'string' ? value : undefined
    } catch (error) {
      reportFailure('session preset lookup', error)
      return undefined
    }
  }

  /** Does this session run under 边缘模式?
   *
   *  The host's own reading wins — `session.projectionValues.agentPreset`, the
   *  same source the preset chip reads (ui-agent-preset/src/client/seat-store.ts
   *  `presetOf`). The roster's default is only the FALLBACK, for a host that
   *  cannot name this session's preset at all. */
  const sessionUsesEdge = (sessionId: string): boolean => {
    const preset = sessionPresetOf(sessionId)
    if (preset !== undefined) return preset === EDGE_PRESET_ID
    return defaultIsEdge
  }

  /** One rung of the auto-open ladder: open the Edge tab in `sessionId`. */
  const tryAutoOpen = (sessionId: string, attempt: number): void => {
    const timer = setTimeout(() => {
      pendingOpen = undefined
      if (!tabRegistered || sidebar === undefined) return
      // The session moved on while we waited — that ladder is not ours.
      if (sidebar.mounted?.getSnapshot() !== sessionId) return
      // §7.142: only an 边缘模式 session opens itself into the Edge panel.
      // The panel stays honest in other modes: the chip is there (the type is
      // registered for every session), the data is simply this session's own.
      if (!edgeHealthy || !sessionUsesEdge(sessionId)) return
      if (edgeTabIn(sessionId) !== undefined) {
        openedSessions.add(sessionId)
        return
      }
      try {
        sidebar.openTab(TAB_ID)
        openedSessions.add(sessionId)
      } catch (error) {
        // Two known throws, both transient: the session's store is not minted
        // yet (service.ts:746), or the tab type is not registered yet (the
        // `sidebarRightTabs` injection is deferred). Both clear on their own.
        const next = attempt + 1
        if (next >= AUTO_OPEN_RETRY_MS.length) {
          reportFailure('edge tab auto-open', error)
          return
        }
        tryAutoOpen(sessionId, next)
      }
    }, AUTO_OPEN_RETRY_MS[attempt])
    pendingOpen = { sessionId, attempt, timer }
  }

  /** Start the ladder for the session on screen, unless it is already open. */
  const scheduleAutoOpen = (): void => {
    if (!tabRegistered || sidebar === undefined) return
    const sessionId = sidebar.mounted?.getSnapshot()
    if (typeof sessionId !== 'string' || sessionId === '') return
    if (openedSessions.has(sessionId)) return
    // §7.142: a session that is not 边缘模式 never opens itself into the
    // Edge panel — the chip is there, the panel is the user's call.
    if (!edgeHealthy || !sessionUsesEdge(sessionId)) return
    if (pendingOpen !== undefined) {
      if (pendingOpen.sessionId === sessionId) return
      clearTimeout(pendingOpen.timer)
      pendingOpen = undefined
    }
    tryAutoOpen(sessionId, 0)
  }

  /** Adopt the host's right-sidebar controller as soon as it is readable.
   *
   *  Read, never injected: the face is optional by contract, and this fiber
   *  must never pend on it (a pending entry fails the whole web boot —
   *  dsh-client-web/src/boot-client.ts:66-88). The roster poll calls this
   *  every 5s, so a face that shows up late is still adopted. */
  const adoptSidebar = (): void => {
    if (sidebar !== undefined) return
    let raw: unknown
    try {
      raw = ctx.get?.('sidebarRight')
    } catch {
      return
    }
    const face = raw as SidebarRightFace | undefined
    if (face === undefined || typeof face.openTab !== 'function') return
    sidebar = face
    const mounted = face.mounted
    if (mounted !== undefined && typeof mounted.subscribe === 'function') {
      // The snapshot publishes the session that just came on screen.
      mounted.subscribe(() => { scheduleAutoOpen() })
    }
    scheduleAutoOpen()
  }

  /** Register the Edge tab TYPE — once, for every work mode (§7.142).
   *
   *  The tab registry is global (the host composes ONE boot graph for the
   *  whole app), so the TYPE is what makes the chip exist at all. §7.136
   *  registered and un-registered it with the roster, which tied the chip's
   *  existence to the DEFAULT preset — 主人裁决（2026-10-28）：「edge tab
   *  一直都在，只有边缘模式才真正生效」⇒ 常驻注册，模式的差别交给
   *  auto-open 与服务端的能力隔离。 */
  const registerTabType = (): void => {
    if (disposeTabType !== undefined) return
    ctx.inject(['sidebarRightTabs'], (raw) => {
      if (disposeTabType !== undefined) return
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
        tabRegistered = true
      } catch (error) {
        reportFailure('sidebar tab type registration', error)
      }
      // The session on screen may have arrived before the type existed.
      scheduleAutoOpen()
    })
  }

  // Roster watcher — deferred: a missing remote must never pend this fiber
  // (the web boot audit THROWS on a pending entry; a missing tab is a small
  // loss, a boot failure is the app).
  //
  // §7.142: the roster no longer decides whether the tab EXISTS. It answers
  // two narrower questions: is 边缘模式 healthy (a broken preset cannot fill
  // the panels), and — only as a fallback — is it the DEFAULT.
  ctx.inject(['remote', 'remote.agentPresets'], (raw) => {
    const api = pickAgentPresets(raw) ?? remoteFace(ctx)
    if (api === undefined || typeof api.list !== 'function') return
    const check = async (): Promise<void> => {
      try {
        // The right-sidebar controller may have shown up since the last tick;
        // adopting it is what makes the auto-open possible at all.
        adoptSidebar()
        const result = await api.list()
        if (!result.ok) return
        const presets = result.value?.presets
        if (!Array.isArray(presets)) return
        const edge = presets.find((p) => p.id === EDGE_PRESET_ID)
        const active = presets.find((p) => p.isDefault === true)
        // A preset that failed to mount has no working composition: opening
        // the tab would promise panels the server cannot fill.
        edgeHealthy = edge !== undefined && edge.broken === undefined
        defaultIsEdge = active?.id === EDGE_PRESET_ID
        // The session on screen may have arrived while the tab type was not
        // registered yet — the ladder retries, and this is the cheap retry.
        scheduleAutoOpen()
      } catch (error) {
        // A roster fault must not blank the panel: keep the current state.
        reportFailure('preset roster read', error)
      }
    }
    void check()
    const timer = setInterval(() => { void check() }, ROSTER_POLL_MS)
    ctx.effect?.(() => () => {
      clearInterval(timer)
      // Unload: drop the tab type again (the sidebar refreshes on registry
      // change). §7.142: this happens on UNLOAD, not on a preset switch.
      const dispose = disposeTabType
      disposeTabType = undefined
      tabRegistered = false
      if (typeof dispose === 'function') dispose()
    }, 'dsh-edge-agent: preset roster watcher')
  })

  // §7.142: the tab type is registered for EVERY work mode — the chip is
  // always there, and 边缘模式 is what makes the session open into it.
  registerTabType()

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
