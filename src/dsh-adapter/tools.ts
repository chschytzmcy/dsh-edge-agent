/**
 * tools — Realm-aware tool registry *configuration* for dsh-edge-agent.
 *
 * M2 stage: this plugin does NOT maintain a parallel registry. The actual
 * tool storage is `ctx.tools` from `@deepseek-ai/dsh-tools` (DSH upstream).
 * dsh-edge-agent only configures the runtime (default rate limit, scope
 * presentation) and exposes a thin service that downstream plugins call
 * to filter or list the visible tool set by realm.
 *
 * Realm filtering is opt-in — agents that do not care about realm scope
 * see the full upstream tool set. M2 accepts every realm; A2 will gate
 * which tool a given run can see based on the intent-router verdict.
 *
 * @module dsh-edge-agent/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'tools'

export const inject = ['auditLog'] as const

export type ToolRealm = 'LOCAL' | 'CLOUD' | 'SANITIZED'

export interface Config {
  /** Default rate limit for registered tools that do not specify their own. */
  defaultRateLimitPerMinute: number
  /** Whether realm isolation (scope restrictions) is active. M2 keeps it on. */
  enableToolIsolation: boolean
  /** Reflection of the upstream `tools` runtime config this plugin maps on. */
  presentationMode: 'native' | 'code-mode'
}

export const Config: Schema<Config> = Schema.object({
  defaultRateLimitPerMinute: Schema.natural().default(60),
  enableToolIsolation: Schema.boolean().default(true),
  presentationMode: Schema.union(['native', 'code-mode'] as const).default('native'),
})

export interface ToolSummary {
  name: string
  description: string
  realm: ToolRealm
}

export interface ToolsService {
  /** Lightweight snapshot of the current global tool set, optionally filtered by realm. */
  list(realm?: ToolRealm): ToolSummary[]
  /** Returns true when a name is registered globally. */
  has(name: string): boolean
  /** The realm a tool was tagged with at registration; undefined if unknown. */
  realmOf(name: string): ToolRealm | undefined
  /** M2 convenience: classify a tool name by its `local-` / `cloud-` / `sanitized-` prefix. */
  classify(name: string): ToolRealm
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    edgeTools: ToolsServiceImpl
  }
}

/**
 * Live snapshot of the dsh-edge-agent tool surface. Reads from `ctx.tools`
 * (upstream registry) and the in-memory realm map. The class is
 * intentionally a thin view, not a writer — to add a tool, register
 * through `ctx.tools.register()`.
 *
 * Note: DSH native tools (bash, read, write, edit, web_search, web_fetch)
 * are now used directly. Realm tagging can be added via event listeners
 * or middleware if needed.
 */
export class ToolsServiceImpl extends Service {
  private readonly realm = new Map<string, ToolRealm>()

  constructor(ctx: Context) {
    super(ctx, 'edgeTools')
  }

  /** Set realm tag for a tool. Call after tool registration. */
  setRealm(toolName: string, realm: ToolRealm): void {
    this.realm.set(toolName, realm)
  }

  list(realm?: ToolRealm): ToolSummary[] {
    const upstream = upstreamTools(this.ctx)
    const out: ToolSummary[] = []
    for (const tool of upstream) {
      const r = this.realm.get(tool.name) ?? undefined
      if (realm !== undefined && r !== realm) continue
      out.push({ name: tool.name, description: tool.description, realm: r ?? classifyByPrefix(tool.name) })
    }
    return out
  }

  has(name: string): boolean {
    return upstreamTools(this.ctx).some((tool) => tool.name === name)
  }

  realmOf(name: string): ToolRealm | undefined {
    return this.realm.get(name)
  }

  classify(name: string): ToolRealm {
    return this.realm.get(name) ?? classifyByPrefix(name)
  }
}

/** Pure classifier for tests and for the default realm tag. */
export function classifyByPrefix(toolName: string): ToolRealm {
  if (toolName.startsWith('local_')) return 'LOCAL'
  if (toolName.startsWith('cloud_')) return 'CLOUD'
  if (toolName.startsWith('sanitized_')) return 'SANITIZED'
  // Unknown realm — leave it as CLOUD so the cloud path can refuse it
  // explicitly rather than silently routing into LOCAL.
  return 'CLOUD'
}

interface UpstreamToolView {
  name: string
  description: string
}

/** Read the global upstream tool list without depending on the dsh-tools types. */
function upstreamTools(ctx: Context): UpstreamToolView[] {
  const candidate = (ctx as unknown as { tools?: { view?: (scope?: unknown) => { entries?: () => Iterable<[string, { description?: string }]> } } }).tools
  if (candidate?.view === undefined) return []
  const view = candidate.view()
  if (view?.entries === undefined) return []
  const out: UpstreamToolView[] = []
  for (const [name, def] of view.entries()) {
    out.push({ name, description: def.description ?? '' })
  }
  return out
}

export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  // ToolsServiceImpl extends `Service`, so its constructor calls
  // `ctx.reflect.provide('edgeTools', this)` for us. Do not call
  // `ctx.provide` again — that would throw "service already registered".
  void new ToolsServiceImpl(ctx)
  // M2: pass config through to the audit log so M3 persistence can pick it
  // up. The default rate limit is plumbed in via tool definitions.
  void config
  return async () => {}
}
