/**
 * dsh-edge-agent — client half.
 *
 * Renders inside the DSH webui (Electron) when the desktop host loads this
 * bundle. Follows the dsh-context pattern: a Cordis plugin module that
 * registers a sidebar tab via the framework's `sidebarRightTabs` face.
 *
 * The face types are declared locally because `@deepseek-ai/dsh-client-ui-sidebar-right`
 * ships inside the desktop app.asar and is not on npm. The dsh-context
 * package does the same (see `src/client/services.ts`).
 *
 * Deferred `ctx.inject(['sidebarRightTabs'], cb)` — on profiles where the
 * face is not provided (CLI/TUI), the callback never runs, the plugin
 * mounts cleanly, and no tab is shown.
 */

import type { Context } from '@deepseek-ai/cordis'

/* ── Face types (mirror dsh-context's services.ts) ─────────────────────── */

interface SidebarGuideEntry {
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
  /** Per-session view component. dsh-context passes a React element here;
   *  we pass a plain string (placeholder) until real components ship. */
  render?: (props: { sessionId?: string }) => unknown
}

interface SidebarTabsFace {
  register(def: SidebarTabDef): () => void
}

/* ── Plugin shape ──────────────────────────────────────────────────────── */

export const name = 'dsh-edge-agent-client'

export const inject: readonly string[] = []

export function apply(ctx: Context): void {
  // Deferred inject: the face may be absent on non-web profiles.
  ctx.inject(['sidebarRightTabs'], (raw) => {
    const c = raw as unknown as Context & { sidebarRightTabs?: SidebarTabsFace }
    const tabs = c.sidebarRightTabs
    if (tabs === undefined || typeof tabs.register !== 'function') return
    tabs.register({
      id: 'dsh-edge-agent',
      kind: 'dsh-edge-agent',
      title: () => 'Edge',
      guide: [
        {
          order: 30,
          title: () => 'Edge',
          description: () =>
            'Intent classification · model routing · prompt-guard / sanitizer events',
        },
      ],
      // Placeholder body — real components land in subsequent commits.
      render: () => 'dsh-edge-agent view (skeleton)',
    })
  })
}
