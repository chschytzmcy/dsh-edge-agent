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
 * see the full upstream tool set. G8 (2026-08-23) wires `enableToolIsolation`
 * to `filterTools(intent)` / `isToolAllowed(name, intent)`, so consumers
 * (http-api, agent-loop) can drive tool visibility from the intent-router
 * verdict. The flag is opt-out so legacy callers see the full set.
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
  /** G8: tools visible to a given intent-router verdict. REJECT → []. When
   *  `enableToolIsolation: false`, returns all tools regardless of intent
   *  (legacy / opt-out callers). When `true`, returns the tools whose realm
   *  matches `intent.category`. */
  filterTools(intent: IntentLike): ToolSummary[]
  /** G8: single-tool check for the same matrix. False for REJECT, false for
   *  realm mismatches under isolation. */
  isToolAllowed(toolName: string, intent: IntentLike): boolean
}

/** Structural shape of an intent-router verdict that `filterTools` /
 *  `isToolAllowed` consume. Local to this module to avoid a circular
 *  dependency on intent-router.ts — we accept any object that has
 *  `category` in the right shape. intent-router's `Intent` already
 *  satisfies it. */
export type IntentLike = { readonly category: 'LOCAL' | 'CLOUD' | 'SANITIZED' | 'REJECT' }

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
  private readonly enableToolIsolation: boolean
  /** Default per-tool rate limit (informational; M3 persistence picks it up). */
  private readonly defaultRateLimitPerMinute: number
  /** Tool presentation mode (informational; not consulted by this service yet). */
  private readonly presentationMode: 'native' | 'code-mode'

  constructor(ctx: Context, config?: Partial<Config>) {
    super(ctx, 'edgeTools')
    // G8: Config is now plumbed. Pre-G8 callers (existing tests / single-arg
    // constructor) get isolation OFF by default, which matches the prior
    // behavior (the flag was defined but never applied).
    this.enableToolIsolation = config?.enableToolIsolation ?? false
    this.defaultRateLimitPerMinute = config?.defaultRateLimitPerMinute ?? 60
    this.presentationMode = config?.presentationMode ?? 'native'
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

  /** G8: tools visible under a given intent-router verdict. */
  filterTools(intent: IntentLike): ToolSummary[] {
    if (intent.category === 'REJECT') return []
    if (!this.enableToolIsolation) return this.list()
    // Under isolation, classify each upstream tool by either an explicit
    // setRealm override or its `local_` / `cloud_` / `sanitized_` prefix.
    // The downstream `list(realm)` is strict (requires setRealm), so we
    // inline the prefix-aware filter here.
    const upstream = upstreamTools(this.ctx)
    const out: ToolSummary[] = []
    for (const tool of upstream) {
      const r = this.realm.get(tool.name) ?? classifyByPrefix(tool.name)
      if (r !== intent.category) continue
      out.push({ name: tool.name, description: tool.description, realm: r })
    }
    return out
  }

  /** G8: single-tool check (cheaper than `filterTools(intent).some`). */
  isToolAllowed(toolName: string, intent: IntentLike): boolean {
    if (intent.category === 'REJECT') return false
    if (!this.enableToolIsolation) return this.has(toolName)
    if (!this.has(toolName)) return false
    const toolRealm = this.realm.get(toolName) ?? classifyByPrefix(toolName)
    return toolRealm === (intent.category as ToolRealm)
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
  // G8: Config now actually flows into the service — `enableToolIsolation`
  // drives `filterTools` / `isToolAllowed`. Pre-G8 had `void config` here.
  void new ToolsServiceImpl(ctx, config)
  return async () => {}
}
