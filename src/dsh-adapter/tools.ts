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
 * Hardcoded realm tags for upstream DSH tools whose default `classifyByPrefix`
 * fallback would be wrong. Phase 5 (2026-08-26) wires web_search / web_fetch
 * (from `@deepseek-ai/dsh-tool-web`) to CLOUD: they trigger outbound calls
 * to DeepSeek's Anthropic-compatible endpoint and must NEVER run under a
 * LOCAL or REJECT intent — see `intent-router` realm routing (G8).
 *
 * Anything not in this map still falls through to `classifyByPrefix`, which
 * returns CLOUD by default (the safe path: explicit refusal rather than
 * silently routing into LOCAL).
 */
const DSH_NATIVE_REALM_MAP: Readonly<Record<string, ToolRealm>> = {
  web_search: 'CLOUD',
  web_fetch: 'CLOUD',
  bash: 'LOCAL',
  read: 'LOCAL',
  write: 'LOCAL',
  edit: 'LOCAL',
  glob: 'LOCAL',
  grep: 'LOCAL',
}

/**
 * Live snapshot of the dsh-edge-agent tool surface. Reads from `ctx.tools`
 * (upstream registry) and the in-memory realm map. The class is
 * intentionally a thin view, not a writer — to add a tool, register
 * through `ctx.tools.register()`.
 *
 * Note: DSH native tools (bash, read, write, edit, web_search, web_fetch)
 * are now used directly. Phase 5 (2026-08-26) hard-codes the realm tags
 * for DSH native tools via `DSH_NATIVE_REALM_MAP` so `filterTools(intent)`
 * correctly hides `web_search` under a LOCAL verdict without relying on
 * prefix heuristics. The map is applied lazily — every `list()` /
 * `filterTools()` call re-projects from the upstream registry, so tools
 * registered after boot (via the `tools/change` event) get the right tag.
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

  /** Resolve the realm of a tool name, applying the DSH native map before
   *  falling back to `classifyByPrefix`. Used by every realm-aware query
   *  so the hard-coded mapping stays in one place. */
  resolveRealm(toolName: string): ToolRealm {
    return this.realm.get(toolName) ?? DSH_NATIVE_REALM_MAP[toolName] ?? classifyByPrefix(toolName)
  }

  list(realm?: ToolRealm): ToolSummary[] {
    const upstream = upstreamTools(this.ctx)
    const out: ToolSummary[] = []
    for (const tool of upstream) {
      const r = this.resolveRealm(tool.name)
      if (realm !== undefined && r !== realm) continue
      out.push({ name: tool.name, description: tool.description, realm: r })
    }
    return out
  }

  has(name: string): boolean {
    return upstreamTools(this.ctx).some((tool) => tool.name === name)
  }

  realmOf(name: string): ToolRealm | undefined {
    const r = this.realm.get(name)
    if (r !== undefined) return r
    return DSH_NATIVE_REALM_MAP[name]
  }

  classify(name: string): ToolRealm {
    return this.resolveRealm(name)
  }

  /** G8: tools visible under a given intent-router verdict. */
  filterTools(intent: IntentLike): ToolSummary[] {
    if (intent.category === 'REJECT') return []
    if (!this.enableToolIsolation) return this.list()
    // Under isolation, classify each upstream tool by either an explicit
    // setRealm override, the DSH_NATIVE_REALM_MAP (Phase 5: web_search etc.),
    // or its `local_` / `cloud_` / `sanitized_` prefix. The downstream
    // `list(realm)` is strict (requires setRealm), so we inline the
    // prefix-aware filter here.
    const upstream = upstreamTools(this.ctx)
    const out: ToolSummary[] = []
    for (const tool of upstream) {
      const r = this.resolveRealm(tool.name)
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
    const toolRealm = this.resolveRealm(toolName)
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

/** Read the global upstream tool list without depending on the dsh-tools types.
 *
 * Cordis exposes registered services through a `ReflectService` proxy on
 * `ctx`: accessing `ctx.tools` triggers a Proxy `get` trap that throws
 * `cannot get property "tools" without inject` when the service has not yet
 * been bound to the active fiber. This happens at apply() time if `tools`
 * has not finished mounting — the loader wires inject dependencies AFTER
 * the apply() body starts. Defensive: catch the proxy throw and return []
 * so `DSH_NATIVE_REALM_MAP` simply skips the boot-time scan. The
 * `tools/change` listener installed below catches up once tools become
 * available.
 */
function upstreamTools(ctx: Context): UpstreamToolView[] {
  let candidate: { view?: (scope?: unknown) => { entries?: () => Iterable<[string, { description?: string }]> } } | undefined
  try {
    candidate = (ctx as unknown as { tools?: typeof candidate }).tools
  } catch {
    return []
  }
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
  const service = new ToolsServiceImpl(ctx, config)
  console.log('[edge-tools-registry] apply() called, ctx.edgeTools registered')

  // Phase 5 (2026-08-26): wire `DSH_NATIVE_REALM_MAP` into the live registry.
  // DSH tools are registered by other plugins (`@deepseek-ai/dsh-tool-web`,
  // `dsh-tool-bash`, etc.) AFTER `edge-tools-registry` boots because they
  // live in their own cordis rows. We apply the map immediately for tools
  // already present, then subscribe to `tools/change` so any later
  // registration auto-tags. The handler is a no-op for tools we don't care
  // about (resolveRealm already falls back to classifyByPrefix).
  const bootSnapshot = upstreamTools(ctx)
  console.log(`[edge-tools-registry] boot scan: ${bootSnapshot.length} tools visible via ctx.tools`)
  for (const tool of bootSnapshot) {
    const mapped = DSH_NATIVE_REALM_MAP[tool.name]
    if (mapped !== undefined) service.setRealm(tool.name, mapped)
  }
  if (bootSnapshot.length > 0) {
    console.log(`[edge-tools-registry] boot snapshot: ${bootSnapshot.map((t) => t.name).join(', ')}`)
  }
  const onToolsChange = (): void => {
    const after = upstreamTools(ctx)
    if (after.length > bootSnapshot.length) {
      console.log(`[edge-tools-registry] tools/change → ${after.length} tools now: ${after.map((t) => t.name).join(', ')}`)
    }
    for (const tool of after) {
      const mapped = DSH_NATIVE_REALM_MAP[tool.name]
      if (mapped !== undefined) service.setRealm(tool.name, mapped)
    }
  }
  // ctx.on returns a disposer; capture so the apply() return closure can
  // tear it down on plugin dispose.
  const disposeChange = (ctx as unknown as { on?: (event: string, fn: () => void) => () => void }).on?.(
    'tools/change',
    onToolsChange,
  )
  return async () => {
    disposeChange?.()
  }
}
