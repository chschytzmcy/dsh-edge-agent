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

export const inject = ['auditLog', 'tools'] as const

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
  write: 'LOCAL',
  edit: 'LOCAL',
  glob: 'LOCAL',
  grep: 'LOCAL',
}

/**
 * Tools that belong to multiple realms. These override DSH_NATIVE_REALM_MAP
 * when present. `bash` and `read` are tagged both LOCAL and CLOUD so that
 * CLOUD agents can invoke lark-cli (and other safe CLI tools) via bash,
 * and read local files (e.g. skill reference docs like lark-shared/SKILL.md).
 * Since `bash` already grants equivalent file access, `read` in CLOUD is
 * consistent rather than a new risk.
 *
 * `skill` is the universal skill loader — it loads SKILL.md content regardless
 * of realm. The actual realm separation happens at the skill level (ets-* →
 * LOCAL, lark-* → CLOUD) via realm-skill-bridge catalog filtering. Making the
 * tool itself multi-realm lets LOCAL agents load ets-* skills and CLOUD agents
 * load lark-* skills, each seeing only their own catalog.
 */
const DSH_NATIVE_MULTI_REALM: Readonly<Record<string, readonly ToolRealm[]>> = {
  bash: ['LOCAL', 'CLOUD'],
  read: ['LOCAL', 'CLOUD'],
  skill: ['LOCAL', 'CLOUD'],
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
  /** Tool name → set of realms it belongs to. A tool can be in multiple realms. */
  private readonly realm = new Map<string, Set<ToolRealm>>()
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

  /** Set realm tag for a tool. Additive — a tool can belong to multiple realms
   *  (e.g. bash is both LOCAL and CLOUD). Call after tool registration. */
  setRealm(toolName: string, realm: ToolRealm): void {
    const existing = this.realm.get(toolName) ?? new Set<ToolRealm>()
    existing.add(realm)
    this.realm.set(toolName, existing)
  }

  /** Resolve the realms of a tool name. Checks:
   *  1. Explicit setRealm/addRealm calls (multi-realm Set)
   *  2. DSH_NATIVE_MULTI_REALM (bash → [LOCAL, CLOUD])
   *  3. DSH_NATIVE_REALM_MAP (single-realm fallback)
   *  4. classifyByPrefix (default)
   */
  resolveRealms(toolName: string): Set<ToolRealm> {
    // 1. Explicit multi-realm tags
    const explicit = this.realm.get(toolName)
    if (explicit !== undefined && explicit.size > 0) return explicit
    // 2. Multi-realm native map
    const multi = DSH_NATIVE_MULTI_REALM[toolName]
    if (multi !== undefined) return new Set(multi)
    // 3. Single-realm native map
    const single = DSH_NATIVE_REALM_MAP[toolName]
    if (single !== undefined) return new Set([single])
    // 4. Prefix fallback
    return new Set([classifyByPrefix(toolName)])
  }

  /** Backward-compatible single-value resolver. Returns the first realm
   *  from the resolved set. For multi-realm tools (like bash), prefer
   *  resolveRealms() + Set.has() checks instead. */
  resolveRealm(toolName: string): ToolRealm {
    const realms = this.resolveRealms(toolName)
    return realms.values().next().value!
  }

  list(realm?: ToolRealm): ToolSummary[] {
    const upstream = upstreamTools(this.ctx)
    const out: ToolSummary[] = []
    for (const tool of upstream) {
      const realms = this.resolveRealms(tool.name)
      // When filtering by realm, include tools that belong to that realm
      if (realm !== undefined && !realms.has(realm)) continue
      // For the summary, use the first realm (or 'LOCAL' for multi-realm like bash)
      const primaryRealm = realms.values().next().value!
      out.push({ name: tool.name, description: tool.description, realm: primaryRealm })
    }
    return out
  }

  has(name: string): boolean {
    return upstreamTools(this.ctx).some((tool) => tool.name === name)
  }

  realmOf(name: string): ToolRealm | undefined {
    const explicit = this.realm.get(name)
    if (explicit !== undefined && explicit.size > 0) return explicit.values().next().value
    const multi = DSH_NATIVE_MULTI_REALM[name]
    if (multi !== undefined) return multi[0]
    return DSH_NATIVE_REALM_MAP[name]
  }

  classify(name: string): ToolRealm {
    return this.resolveRealm(name)
  }

  /** G8: tools visible under a given intent-router verdict. */
  filterTools(intent: IntentLike): ToolSummary[] {
    if (intent.category === 'REJECT') return []
    if (!this.enableToolIsolation) return this.list()
    // Under isolation, include tools whose realm set contains the intent's
    // category. Multi-realm tools (e.g. bash → LOCAL+CLOUD) appear in both.
    const upstream = upstreamTools(this.ctx)
    const out: ToolSummary[] = []
    for (const tool of upstream) {
      const realms = this.resolveRealms(tool.name)
      if (!realms.has(intent.category as ToolRealm)) continue
      const primaryRealm = realms.values().next().value!
      out.push({ name: tool.name, description: tool.description, realm: primaryRealm })
    }
    return out
  }

  /** G8: single-tool check (cheaper than `filterTools(intent).some`). */
  isToolAllowed(toolName: string, intent: IntentLike): boolean {
    if (intent.category === 'REJECT') return false
    if (!this.enableToolIsolation) return this.has(toolName)
    if (!this.has(toolName)) return false
    const realms = this.resolveRealms(toolName)
    return realms.has(intent.category as ToolRealm)
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
  let candidate: { view?: (scope?: unknown) => { visible?: Map<string, { description?: string }> } } | undefined
  try {
    candidate = (ctx as unknown as { tools?: typeof candidate }).tools
  } catch {
    return []
  }
  if (candidate?.view === undefined) return []
  const view = candidate.view()
  const visible = view?.visible
  if (visible === undefined) return []
  const out: UpstreamToolView[] = []
  for (const [name, def] of visible.entries()) {
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
    // Apply multi-realm native map first
    const multiRealms = DSH_NATIVE_MULTI_REALM[tool.name]
    if (multiRealms !== undefined) {
      for (const r of multiRealms) service.setRealm(tool.name, r)
      continue
    }
    // Then single-realm native map
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
      const multiRealms = DSH_NATIVE_MULTI_REALM[tool.name]
      if (multiRealms !== undefined) {
        for (const r of multiRealms) service.setRealm(tool.name, r)
        continue
      }
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
