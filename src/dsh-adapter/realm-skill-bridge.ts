/**
 * realm-skill-bridge — Realm-aware skill and tool isolation for dsh-edge-agent.
 *
 * Reads a user-editable JSON config (`skill-realms.json`) that maps skill/tool
 * names (or glob patterns) to LOCAL | CLOUD realms. Tags every discovered skill
 * and tool accordingly, then enforces the mapping at three enforcement points:
 *
 *   Layer 1 (agent/pre-step): filter the <available_skills> catalog so each
 *     agent only sees skills in its own realm. Skills tagged `hidden` are
 *     invisible to every agent.
 *
 *   Layer 1.5-replacement (system-prompt/assemble): filter the tool schema
 *     list BEFORE dsh-agent-loop wraps it in deepFreeze and passes to the
 *     LLM. Replaces the deleted `llm/stream` tools probe — `payload.tools`
 *     at llm/stream is already frozen (dsh-agent-loop/lib/index.js:729
 *     `markAgentLoopRequest(deepFreeze({ ... tools: header.tools, ... }))`)
 *     so splice/defineProperty mutations silently fail there. The
 *     system-prompt/assemble waterfall value IS authoritative (per the dsh
 *     type declaration: "the returned value is authoritative") and tools are
 *     a plain array at that point. After this layer the LLM never sees
 *     out-of-realm tools.
 *
 *   Layer 3 (tools/pre-execute): deny tool execution when the tool's realm
 *     does not match the calling agent's realm (defense-in-depth — also
 *     catches tools added via runtime registrations that bypass assembly).
 *
 * The config file is hot-reloaded via stat-polling (same pattern as
 * privacy-policy.ts) so changes take effect without a restart.
 *
 * @module dsh-edge-agent/realm-skill-bridge
 */

import { existsSync } from 'node:fs'
import { copyFile, readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { edgeHome, loadEdgeConfig } from './edge-config.js'

export const name = 'realm-skill-bridge'
// §7.92.2 (2026-09-22): 必须声明全部 soft deps — `edgeTools` + `tools` 是
// tagToolsFromConfig() 实际读取的 ctx 属性。cordis Proxy 在未声明时会
// 静默 throw "cannot get property X without inject",原 silent catch 吞
// 掉导致 Layer 1.5-replacement 装死 1 天。必须跟 cordis.patch.yml 一致。
export const inject = ['auditLog', 'skills', 'edgeTools', 'tools'] as const

/** Realm tag for skills and tools. 'hidden' means invisible to all agents. */
export type RealmTag = 'LOCAL' | 'CLOUD' | 'SANITIZED' | 'hidden'

/**
 * §7.93 Phase 2 (2026-09-24,§7.93.1 通用化 2026-09-25): intent categories
 * function-call-external may request tool schemas for. REJECT never reaches
 * the external caller (4xx before dispatch) and 'hidden' agents get no tools
 * at all, so both are excluded from the input type; CLOUD is included for
 * completeness even though the external path skips CLOUD intents
 * (decision #4) — callers gate, this method stays total.
 */
export type ExternalToolCallIntent = 'LOCAL' | 'CLOUD' | 'SANITIZED'

/**
 * §7.93 Phase 2 (§7.93.1 通用化): one tool schema in the external caller's
 * flat wire format (cactus-needle 3.0.1 / `~/work/needle/API.md` v1.1 §4.5:
 * `{name, description, parameters}` —
 * NOT the OpenAI `{type:'function', function:{...}}` envelope). This matches
 * dsh-llm's own `ToolSchema` projection (`schemas()` whitelists exactly
 * name/description/parameters), so the conversion is a shape check, not a
 * translation.
 */
export interface ExternalToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface Config {
  /** Path to the skill-realms.json config file. */
  configPath: string
  /** Whether to hot-reload the config on file change (via stat polling). */
  hotReload: boolean
  /** Polling interval in ms for config change detection. */
  watchIntervalMs: number
}

export const Config: Schema<Config> = Schema.object({
  // §7.102 "one config file": no defaults here — apply() fills configPath
  // from config/edge.json (privacy.realmConfigPath) or the
  // ~/.dsh-edge-agent/skill-realms.json default, and the hot-reload knobs
  // from privacy.realmHotReload / realmWatchMs. (The old computed default
  // froze the HOME lookup at module-load time.)
  configPath: Schema.string(),
  hotReload: Schema.boolean(),
  watchIntervalMs: Schema.natural(),
})

/**
 * Parsed shape of skill-realms.json.
 *
 * `skills` maps skill name or glob pattern (e.g. "lark-*") to a realm.
 * `tools` maps tool name to a realm (overrides hard-coded DSH_NATIVE_REALM_MAP).
 * `defaultRealm` applies to anything not explicitly matched. "hidden" = invisible.
 */
export interface RealmConfig {
  skills: Record<string, RealmTag>
  tools: Record<string, Exclude<RealmTag, 'hidden'>>
  defaultRealm: RealmTag
}

interface AuditLogLike {
  log(entry: { level: string; kind: string; source: string; payload?: Record<string, unknown> }): void
}

/** Module augmentation: expose the service on ctx. */
declare module '@deepseek-ai/cordis' {
  interface Context {
    realmSkillBridge: RealmSkillBridgeService
    /** From @deepseek-ai/dsh-skill — augmented here to avoid importing the package. */
    skills: {
      list(options?: unknown): Promise<ReadonlyArray<{ name: string; description?: string }>>
      snapshot(options?: unknown): Promise<{ skills: ReadonlyArray<{ name: string; description?: string }>; complete: boolean }>
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Glob matching
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal glob matcher — supports `*` as "any sequence of characters".
 * We do not pull in the `minimatch` dependency for this; the only patterns
 * used in skill-realms.json are simple suffix globs like "lark-*".
 */
export function globMatch(pattern: string, value: string): boolean {
  if (!pattern.includes('*')) return pattern === value
  // Escape regex-special chars (except `*` which we convert to `.*`).
  const regex = new RegExp(
    '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
  )
  return regex.test(value)
}

// ─────────────────────────────────────────────────────────────────────────────
// Config loading
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: RealmConfig = {
  skills: {},
  tools: {},
  defaultRealm: 'hidden',
}

/**
 * Read and parse skill-realms.json. Returns DEFAULT_CONFIG on any failure
 * (missing file, invalid JSON, schema error) so the plugin still boots —
 * everything just becomes hidden until the user creates/fixes the file.
 */
async function loadConfig(configPath: string): Promise<RealmConfig> {
  try {
    const raw = await readFile(configPath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<RealmConfig>
    return {
      skills: parsed.skills && typeof parsed.skills === 'object' ? parsed.skills : {},
      tools: parsed.tools && typeof parsed.tools === 'object' ? parsed.tools : {},
      defaultRealm: isValidRealm(parsed.defaultRealm) ? parsed.defaultRealm : 'hidden',
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

function isValidRealm(value: unknown): value is RealmTag {
  return value === 'LOCAL' || value === 'CLOUD' || value === 'SANITIZED' || value === 'hidden'
}

/**
 * §7.47.6 (2026-09-13): serialize the `turnEnds` object from dsh-agent-loop
 * `turn/end` event into a compact ops-log-friendly string.
 *
 * Background: dsh-agent-loop appends `turnEnds = { kind, ...payload }` where
 * kind ∈ { 'completed', 'max-tokens', 'blocked', 'aborted', 'unknown' }.
 * For 'aborted' it also carries `reason: <AbortSignal.reason>`. The pre-fix
 * code dropped any non-string to 'unknown' — silently hiding the actual
 * termination cause. Now: stringify in `kind=key=value` form so the ops log
 * reveals e.g. `kind=aborted reason=signal-aborted` or `kind=max-tokens`.
 *
 * Falls back to 'unknown' only when dsh-agent-loop emits no reason at all
 * (truly undefined — should never happen in normal flow but guard anyway).
 */
function serializeTurnEndReason(reason: unknown): string {
  if (typeof reason === 'string') return reason
  if (reason === null || reason === undefined) return 'unknown'
  if (typeof reason !== 'object') return `unknown(${String(reason)})`
  const obj = reason as Record<string, unknown>
  const kind = typeof obj.kind === 'string' ? obj.kind : 'unknown'
  // Pull the 2 most useful fields besides kind. For 'aborted', include the
  // nested reason text so ops log shows what actually aborted the signal.
  const parts: string[] = [`kind=${kind}`]
  if (obj.reason !== undefined) {
    const r = obj.reason
    if (typeof r === 'string') parts.push(`reason=${r}`)
    else if (r !== null && typeof r === 'object') {
      const rkind = (r as Record<string, unknown>).kind
      if (typeof rkind === 'string') parts.push(`reason.kind=${rkind}`)
    }
  }
  if (typeof obj.tokenCount === 'number') parts.push(`tokenCount=${obj.tokenCount}`)
  return parts.join(' ')
}

/** Copy the bundled default template to configPath if the file does not exist. */
async function ensureDefaultConfig(configPath: string): Promise<void> {
  if (existsSync(configPath)) return
  // The template lives next to the compiled JS: <repo>/templates/skill-realms.default.json.
  // At runtime this plugin is at <repo>/src/dsh-adapter/realm-skill-bridge.ts → compiled to
  // dist/dsh-adapter/realm-skill-bridge.js. The repo root is three levels up from dist.
  let templatePath: string
  try {
    const thisFile = fileURLToPath(import.meta.url)
    const repoRoot = resolve(dirname(thisFile), '..', '..', '..')
    templatePath = resolve(repoRoot, 'templates', 'skill-realms.default.json')
  } catch {
    return
  }
  if (!existsSync(templatePath)) return
  try {
    const dir = dirname(configPath)
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true })
    await copyFile(templatePath, configPath)
  } catch {
    // Best-effort bootstrap; non-fatal.
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

export class RealmSkillBridgeService extends Service {
  /** Skill name → realm tag (including 'hidden'). */
  private readonly skillRealms = new Map<string, RealmTag>()
  /** Tool name → set of realm tags. A tool can belong to multiple realms. */
  private readonly toolRealms = new Map<string, Set<RealmTag>>()
  /** Session id → realm. Written by http-api after intent classification. */
  private readonly sessionRealms = new Map<string, RealmTag>()
  /** sessionRealms 的 LRU 上限；活跃会话远小于此（http-api 默认 8）。 */
  private static readonly SESSION_REALMS_CAP = 512
  /** Parsed realm config. Refreshed on hot-reload. */
  private realmConfig: RealmConfig = { ...DEFAULT_CONFIG }
  /** mtime of the config file at last load (for stat-polling). */
  private lastMtime = 0
  /** Hot-reload timer handle. */
  private watchTimer: ReturnType<typeof setInterval> | undefined

  constructor(
    ctx: Context,
    private readonly config: Config,
    private readonly auditLog: AuditLogLike | undefined,
  ) {
    super(ctx, 'realmSkillBridge')
  }

  /** Boot: ensure config file exists, load it, tag skills/tools. */
  async start(): Promise<void> {
    await ensureDefaultConfig(this.config.configPath)
    await this.reloadConfig()
    await this.tagSkillsAsync()
    this.tagToolsFromConfig()
    if (this.config.hotReload) {
      this.watchTimer = setInterval(() => {
        void this.checkForUpdates()
      }, this.config.watchIntervalMs)
      if (typeof this.watchTimer.unref === 'function') this.watchTimer.unref()
    }
  }

  /** Stop hot-reload timer. */
  stop(): void {
    if (this.watchTimer !== undefined) {
      clearInterval(this.watchTimer)
      this.watchTimer = undefined
    }
  }

  /** Drop all per-session realm tags (plugin dispose path). */
  clearSessionRealms(): void {
    this.sessionRealms.clear()
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Set the realm for a session (called by http-api after intent classification). */
  setSessionRealm(sessionId: string, realm: RealmTag): void {
    if (realm === 'hidden') return
    // LRU：delete-then-set 让最近路由的 session 排队尾；超限淘汰队头。
    // 该 Map 曾只增不减（每 session 一条，进程生命周期内累积），
    // 同文件的 sessionStartTimes 反而在 turn/end 有 delete —— 补齐。
    const map = this.sessionRealms
    map.delete(sessionId)
    map.set(sessionId, realm)
    while (map.size > RealmSkillBridgeService.SESSION_REALMS_CAP) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
  }

  /** Resolve the realm for an agent by looking up its session.
   *  §7.36 / §7.37 (2026-09-04): prefer `session.id` — input-guard registers
   *  via `payload.agent.session.id` (input-guard.ts:537) and that is the
   *  only key under which sessionRealms holds the realm. Reading
   *  `session.header.id` first was a wrong assumption that caused layer-1.5
   *  (llm/stream tools filter) to silently no-op: getAgentRealm returned
   *  undefined → filterToolsField skipped → tools.filtered never fired. */
  getAgentRealm(agent: AgentLike | undefined): RealmTag | undefined {
    const sessionId = agent?.session?.id
    if (!sessionId) return undefined
    return this.sessionRealms.get(sessionId)
  }

  /**
   * Resolve realm directly from a sessionId string. Used by llm/stream hook
   * where the agent's session.id path is unreliable and payload.sessionId
   * is the canonical key.
   */
  getSessionRealm(sessionId: string | undefined): RealmTag | undefined {
    if (!sessionId) return undefined
    return this.sessionRealms.get(sessionId)
  }

  /** Look up the realm tag for a skill name.
   *  Prefers the cached tag (populated by tagSkills on skills/change), but
   *  falls back to resolveSkillRealm so skills not yet discovered still get
   *  the correct realm from the config file. */
  skillRealm(name: string): RealmTag {
    return this.skillRealms.get(name) ?? this.resolveSkillRealm(name)
  }

  /** Look up the realm tags for a tool name. Returns undefined if no realm
   *  constraint is configured (tool is unconstrained). */
  toolRealm(name: string): Set<RealmTag> | undefined {
    return this.toolRealms.get(name)
  }

  // ── Config reload ───────────────────────────────────────────────────────────

  private async reloadConfig(): Promise<void> {
    const path = this.config.configPath
    if (!existsSync(path)) {
      this.realmConfig = { ...DEFAULT_CONFIG }
      this.lastMtime = 0
      return
    }
    try {
      const stats = await stat(path)
      this.realmConfig = await loadConfig(path)
      this.lastMtime = stats.mtimeMs
    } catch {
      // Parse failure — keep previous config.
    }
  }

  private async checkForUpdates(): Promise<void> {
    const path = this.config.configPath
    if (!existsSync(path)) return
    try {
      const stats = await stat(path)
      if (stats.mtimeMs > this.lastMtime) {
        await this.reloadConfig()
        this.tagSkills()
        this.tagToolsFromConfig()
        this.ctx.logger?.info?.('[realm-skill-bridge] config reloaded')
      }
    } catch {
      // stat error — ignore, will retry next tick.
    }
  }

  // ── Realm resolution ────────────────────────────────────────────────────────

  /**
   * Resolve the realm for a skill by name.
   * Priority:
   *   1. skill-realms.json exact name match
   *   2. skill-realms.json glob match (in declaration order)
   *   3. defaultRealm
   *
   * Note: SKILL.md frontmatter `metadata.realm` is intentionally NOT consumed
   * here — the config file is the single source of truth. This avoids a
   * dependency on `ctx.skills.get()` (which reads the full markdown body)
   * during the hot-path tag loop.
   */
  private resolveSkillRealm(name: string): RealmTag {
    const cfg = this.realmConfig.skills
    // Exact match
    if (cfg[name] !== undefined) return cfg[name]
    // Glob match (declaration order)
    for (const pattern of Object.keys(cfg)) {
      if (pattern.includes('*') && globMatch(pattern, name)) {
        return cfg[pattern]
      }
    }
    return this.realmConfig.defaultRealm
  }

  // ── Tagging ─────────────────────────────────────────────────────────────────

  /** Re-scan ctx.skills.list() and tag each skill by realm. */
  private tagSkills(): void {
    this.skillRealms.clear()
    // ctx.skills.list() is async; we fire-and-forget here because tagging
    // runs on a timer and on skills/change events. The next tick will
    // converge. For the initial boot, apply() awaits this separately.
    void (async () => {
      try {
        const list = await this.ctx.skills.list()
        for (const skill of list) {
          const realm = this.resolveSkillRealm(skill.name)
          this.skillRealms.set(skill.name, realm)
        }
        this.logTaggingResult()
      } catch {
        // skills service not yet injected — will retry on next tick or skills/change.
      }
    })()
  }

  /** Synchronous variant for await contexts. */
  private async tagSkillsAsync(): Promise<void> {
    this.skillRealms.clear()
    try {
      // Debug: check if ctx.skills exists
      const skillsService = (this.ctx as unknown as { skills?: unknown }).skills
      this.ctx.logger?.info?.(`[realm-skill-bridge] ctx.skills exists: ${skillsService !== undefined}`)

      // Debug: check ctx.skills methods
      if (skillsService && typeof skillsService === 'object') {
        const methods = Object.keys(skillsService as object)
        this.ctx.logger?.info?.(`[realm-skill-bridge] ctx.skills methods: ${methods.join(', ')}`)
      }

      // Try calling list() with and without cwd
      const list = await this.ctx.skills.list()
      this.ctx.logger?.info?.(`[realm-skill-bridge] ctx.skills.list() returned ${list.length} skills`)
      if (list.length > 0) {
        this.ctx.logger?.info?.(`[realm-skill-bridge] first 5 skills: ${list.slice(0, 5).map(s => s.name).join(', ')}`)
      }

      // Try with cwd parameter
      try {
        const listWithCwd = await this.ctx.skills.list({ cwd: process.cwd() })
        this.ctx.logger?.info?.(`[realm-skill-bridge] ctx.skills.list({cwd}) returned ${listWithCwd.length} skills`)
      } catch (err) {
        this.ctx.logger?.info?.(`[realm-skill-bridge] ctx.skills.list({cwd}) error: ${err}`)
      }

      for (const skill of list) {
        const realm = this.resolveSkillRealm(skill.name)
        this.skillRealms.set(skill.name, realm)
      }
    } catch (err) {
      this.ctx.logger?.info?.(`[realm-skill-bridge] tagSkillsAsync error: ${err}`)
    }
    this.logTaggingResult()
  }

  private logTaggingResult(): void {
    const visible = [...this.skillRealms.entries()].filter(([, r]) => r !== 'hidden')
    const hidden = this.skillRealms.size - visible.length
    const summary = visible.map(([n, r]) => `${n}=${r}`).join(', ')
    this.ctx.logger?.info?.(
      `[realm-skill-bridge] ${this.skillRealms.size} skills (${hidden} hidden): ${summary || '(none)'}`,
    )
  }

  /** Apply tool realm tags from skill-realms.json to ctx.edgeTools. */
  private tagToolsFromConfig(): void {
    let edgeTools: { setRealm(name: string, realm: string): void } | undefined
    try {
      edgeTools = (this.ctx as unknown as { edgeTools?: { setRealm(name: string, realm: string): void } }).edgeTools
    } catch {
      // Cordis proxy throws when edgeTools is not injected — that's fine,
      // we just skip the edgeTools.setRealm() calls.
    }
    this.toolRealms.clear()
    // §7.92.2 (2026-09-22): seed from native map (DSH_NATIVE_REALM_MAP /
    // DSH_NATIVE_MULTI_REALM, applied to edgeTools at boot by
    // edge-tools-registry) BEFORE the config loop so config wins on conflict.
    // Without this seed, filterToolsField would never filter anything when
    // user hasn't written skill-realms.json yet — web_search / web_fetch
    // would stay visible to LOCAL agents (defeating the purpose of Layer
    // 1.5-replacement). The config loop below adds more tags on top.
    //
    // Requires `tools` + `edgeTools` in plugin inject list (see
    // cordis.patch.yml) — the cordis proxy throws "cannot get property X
    // without inject" if a plugin reads a service it didn't declare.
    if (edgeTools) {
      const nativeResolver = edgeTools as unknown as {
        realm?: Map<string, Set<RealmTag>>
        resolveRealms?(name: string): Set<RealmTag>
      }
      // Walk every tool known to edgeTools, ask it for native realms,
      // and copy into this.toolRealms.
      try {
        const allTools = (this.ctx as unknown as { tools?: { view?: () => { visible?: Map<string, unknown> } } }).tools?.view?.()?.visible
        if (allTools instanceof Map) {
          for (const name of allTools.keys()) {
            // 1. explicit setRealm (Set<ToolRealm>)
            const explicit = nativeResolver.realm?.get(name)
            if (explicit !== undefined && explicit.size > 0) {
              const out = this.toolRealms.get(name) ?? new Set<RealmTag>()
              for (const r of explicit) {
                // edgeTools stores string-set realm values; map into RealmTag
                if (r === 'LOCAL' || r === 'CLOUD' || r === 'SANITIZED' || r === 'hidden') {
                  out.add(r)
                }
              }
              if (out.size > 0) this.toolRealms.set(name, out)
              continue
            }
            // 2. resolveRealms falls through to classifyByPrefix → CLOUD; we
            // don't want prefix tags (would over-restrict). So only accept
            // values when edgeTools has them via explicit + native map path.
            // realmOf (single value) is the right probe — it returns
            // undefined for prefix-only entries.
            const single = (edgeTools as unknown as { realmOf?: (n: string) => string | undefined }).realmOf?.(name)
            if (single === 'LOCAL' || single === 'CLOUD' || single === 'SANITIZED' || single === 'hidden') {
              const out = this.toolRealms.get(name) ?? new Set<RealmTag>()
              out.add(single)
              this.toolRealms.set(name, out)
            }
          }
        }
      } catch {
        // edgeTools.view() may throw if tools service hasn't mounted yet;
        // tools/change will re-fire this function once it's available.
      }
    }
    for (const [toolName, realm] of Object.entries(this.realmConfig.tools)) {
      // Store realm tag in a Set (supports multi-realm if configured multiple times)
      const existing = this.toolRealms.get(toolName) ?? new Set<RealmTag>()
      existing.add(realm as RealmTag)
      this.toolRealms.set(toolName, existing)
      // Only push non-hidden realms to edgeTools (which doesn't understand 'hidden').
      if (edgeTools && (realm === 'LOCAL' || realm === 'CLOUD' || realm === 'SANITIZED')) {
        edgeTools.setRealm(toolName, realm)
      }
    }
  }

  // ── Layer 1: Skill catalog filtering ────────────────────────────────────────

  /**
   * Filter the <available_skills> catalog so the agent only sees skills in
   * its realm. Skills tagged 'hidden' are removed from every agent's catalog.
   *
   * §7.37 (2026-09-04): Two message shapes carry the catalog:
   *   (a) standalone UserMessage with source.kind === 'skill-catalog'
   *       (string content).
   *   (b) dsh-system-prompt plugin snapshot with
   *       source.kind === 'plugin' && source.plugin ===
   *       '@deepseek-ai/dsh-system-prompt' (array content blocks,
   *       one of which is type:'text' containing `<available_skills>`).
   * Both must be filtered or the catalog leaks. (a) is the canonical
   * skill-catalog shape; (b) is what TUI / WebUI actually see because
   * dsh-system-prompt co-locates the catalog with sandbox/approval policy
   * snapshots — without this filter, LLM sees ALL 32 skills regardless
   * of realm.
   *
   * We parse each ` - \`skill-name\`: Description` line, look up the skill's
   * realm, and drop disallowed ones.
   */
  filterSkillCatalog(messages: readonly MessageLike[], agentRealm: RealmTag): readonly MessageLike[] {
    return this.filterSkillCatalogDetailed(messages, agentRealm).messages
  }

  /**
   * §7.46 (2026-09-11): 返回 `{ messages, droppedCount }` 让 pre-step
   * listener 能 emit `catalogDropped=N` 到 ops log（§7.44.1 chat-finished
   * line 加 realm/duration 时同步加的；详见 PROGRESS §7.46）。返回 messages
   * 是 filterSkillCatalog 的同一引用，方便测试不破坏。
   */
  filterSkillCatalogDetailed(
    messages: readonly MessageLike[],
    agentRealm: RealmTag,
  ): { messages: readonly MessageLike[]; droppedCount: number } {
    if (agentRealm === 'hidden') return { messages, droppedCount: 0 }
    let totalDropped = 0
    const newMessages = messages.map((msg) => {
      if (!isCatalogMessage(msg)) return msg

      // (a) string content
      if (typeof msg.content === 'string') {
        if (!msg.content.includes('<available_skills>')) return msg
        const result = this.filterCatalogText(msg.content, agentRealm)
        totalDropped += result.droppedCount
        if (!result.changed) return msg
        return { ...msg, content: result.text }
      }

      // (b) array content blocks (dsh-system-prompt snapshot shape)
      if (Array.isArray(msg.content)) {
        let changed = false
        const newBlocks = msg.content.map((block: unknown) => {
          if (!isTextBlock(block) || typeof block.text !== 'string') return block
          if (!block.text.includes('<available_skills>')) return block
          const result = this.filterCatalogText(block.text, agentRealm)
          totalDropped += result.droppedCount
          if (!result.changed) return block
          changed = true
          return { ...block, text: result.text }
        })
        if (!changed) return msg
        return { ...msg, content: newBlocks }
      }

      return msg
    })
    return { messages: newMessages, droppedCount: totalDropped }
  }

  /**
   * Pure function: parse `<available_skills>` content, drop lines whose
   * skill name resolves to a realm other than `agentRealm` (or 'hidden').
   * Returns `{ text, changed }` so the caller can short-circuit on no-op.
   *
   * §7.45 (2026-09-11): SANITIZED agents see every non-hidden skill —
   * matches `filterToolsField`'s SANITIZED branch below. Before this
   * fix, `skillRealm(name)` only returns `LOCAL`/`CLOUD`/`hidden` (never
   * `'SANITIZED'`), so `realm !== agentRealm` was always true for SANITIZED
   * agents and the entire catalog was dropped (audit observed
   * `droppedCount=33` for a session whose agentRealm=SANITIZED — LLM saw
   * zero skills and silently answered "no mibao tool available"). Skill
   * realm tag is fail-closed (default 'hidden'), so SANITIZED must
   * explicitly opt out of the strict-equality check.
   *
   * §7.47.1 (2026-09-12): Same dual fix for LOCAL/CLOUD. The catalog
   * filter uses `skillRealm` (single realm), but tools are tagged with a
   * realm SET (`toolRealms: Set<RealmTag>`). `bash` skill.realm = 'LOCAL'
   * yet bash.toolRealms = {LOCAL, CLOUD}. Before this fix, a CLOUD agent
   * (e.g. news query) saw every LOCAL skill dropped — `droppedCount=11`
   * for news session, identical to the SANITIZED bug. Symmetric for
   * LOCAL agent: CLOUD skill (e.g. web_search, web_fetch) was dropped.
   * The fix extends SANITIZED's opt-in to ALL agent realms: any
   * non-'hidden' skill is kept in the catalog. Layer 3 (tools/pre-execute)
   * remains the authoritative gate, mirroring `filterToolsField`'s
   * semantics where any non-hidden tool is offered to the LLM and only
   * blocked at execution time.
   */
  private filterCatalogText(content: string, agentRealm: RealmTag): { text: string; changed: boolean; droppedCount: number } {
    const lines = content.split('\n')
    const out: string[] = []
    let changed = false
    let droppedCount = 0
    for (const line of lines) {
      const m = line.match(/^-\s+`([^`]+)`:\s*(.*)$/)
      if (m !== null) {
        const skillName = m[1]
        const realm = this.skillRealm(skillName)
        if (realm === 'hidden') {
          changed = true
          droppedCount++
          continue
        }
        // §7.45 + §7.47.1: ALL agent realms see every non-hidden skill.
        // Layer 3 (tools/pre-execute) is the authoritative realm gate —
        // see filterToolsField line ~578-588 + checkToolRealm line ~612.
        // The catalog is a discovery surface; tool execution is the
        // privacy boundary. Restricting catalog by realm left LLM
        // without knowledge of tools it could otherwise safely call.
        void agentRealm
      }
      out.push(line)
    }
    if (droppedCount > 0) {
      try {
        (this as unknown as { auditLog?: AuditLogLike }).auditLog?.log?.({
          level: 'info',
          kind: 'realm-skill-bridge.catalog.filtered',
          source: 'realm-skill-bridge',
          payload: { agentRealm, droppedCount },
        })
      } catch { /* debug only */ }
    }
    return { text: out.join('\n'), changed, droppedCount }
  }

  // ── Layer 1.5: Filter LLM-visible tools list by agent realm ────────────────
  // §7.37 (2026-09-04): <available_skills> catalog text is injected by
  // dsh-system-prompt plugin BELOW the dsh hook surface — none of
  // agent/pre-step, agent/request, llm/stream sees it. The only tool-level
  // surface in any hook is `payload.tools` on llm/stream, so we filter
  // CLOUD tools out of LLM's view there. LLM doesn't see web_search /
  // web_fetch as available → won't pick them when LOCAL realm is set.
  // Layer 3 (tools/pre-execute) remains the authoritative gate.

  /**
   * Pure function: filter the `tools` array carried on llm/stream payload so
   * that the LLM does not see tools whose realm set does not include
   * `agentRealm`. Tools whose realm is undefined (not in our config) are
   * preserved (fail-closed: we only restrict what we explicitly tagged).
   * Returns `{ tools, changed, removed }` so callers can short-circuit.
   *
   * SANITIZED special case: an agent whose input was sanitized may safely
   * use both LOCAL tools (file ops don't leak) and CLOUD tools (input was
   * already redacted). So SANITIZED agents see every non-hidden tool.
   *
   * §7.93 Phase 2 (§7.93.1 通用化): `options.audit === false` suppresses the
   * `realm-skill-bridge.tools.filtered` audit entry. Used by
   * getToolSchemasForExternal() so the LLM-path filter audit isn't duplicated
   * per external call — function-call-external emits its own `external.*`
   * audit kinds. Default (omitted) keeps the existing audited behavior.
   */
  filterToolsField(
    tools: ReadonlyArray<unknown>,
    agentRealm: RealmTag,
    options?: { audit?: boolean },
  ): { tools: unknown[]; changed: boolean; removed: string[] } {
    const kept: unknown[] = []
    const removed: string[] = []
    for (const t of tools) {
      const name = typeof t === 'string'
        ? t
        : ((t as { name?: string; type?: { name?: string } })?.name
          ?? (t as { type?: { name?: string } })?.type?.name
          ?? null)
      if (name === null) {
        kept.push(t)
        continue
      }
      const toolRealms = this.toolRealm(name)
      // Unknown tool (no realm tag) — pass through; Layer 3 has final say
      if (toolRealms === undefined) {
        kept.push(t)
        continue
      }
      // hidden tools are never visible
      if (toolRealms.has('hidden')) {
        removed.push(name)
        continue
      }
      // §7.37: SANITIZED agents see all non-hidden tools (LOCAL + CLOUD).
      if (agentRealm === 'SANITIZED') {
        kept.push(t)
        continue
      }
      if (toolRealms.has(agentRealm)) {
        kept.push(t)
      }
      else {
        removed.push(name)
      }
    }
    if (removed.length > 0 && options?.audit !== false) {
      try {
        this.auditLog?.log({
          level: 'info',
          kind: 'realm-skill-bridge.tools.filtered',
          source: 'realm-skill-bridge',
          payload: { agentRealm, removedCount: removed.length, removed },
        })
      }
      catch { /* debug only */ }
    }
    return { tools: kept, changed: removed.length > 0, removed }
  }

  // ── §7.93 Phase 2 (§7.93.1 通用化): external tool-schema face ───────────────
  // function-call-external (Phase 4+) POSTs these to the external caller's
  // /extract endpoint (current: cactus-needle 3.0.1 / needle-http :8081).
  // Single source of truth: the SAME registry projection the LLM sees
  // (`ctx.tools.schemas()` → name/description/parameters whitelist, per
  // dsh-tools "Project visible definitions onto the allowlisted model-facing
  // schema fields") filtered by the SAME realm semantics as filterToolsField.
  // No separate tool list, no drift (user decision #8).

  /**
   * Build the external caller's wire-format tool schemas for one intent's realm.
   *
   * Pipeline: registry projection → realm filter (filterToolsField semantics,
   * audit suppressed — caller emits `external.*` audit) → shape normalization.
   *
   * Failure contract: registry unavailable (cordis proxy throw before the
   * `tools` service mounts, §7.92.2 trap) or empty → returns []. Callers MUST
   * treat [] as "no external caller" and fall through to the LLM
   * self-extraction path — never POST an empty tools array to the external
   * caller (it would echo/hallucinate).
   */
  getToolSchemasForExternal(intent: ExternalToolCallIntent): ExternalToolSchema[] {
    const raw = this.readRegistrySchemas()
    if (raw.length === 0) return []
    const filtered = this.filterToolsField(raw, intent, { audit: false })
    return normalizeExternalToolSchemas(filtered.tools)
  }

  /**
   * Defensive read of `ctx.tools.schemas()` (global view). Returns [] when
   * the service is not mounted yet or throws — the cordis proxy raises
   * "cannot get property tools without inject" on unbound fibers, and
   * tools/change re-fires tagging once available (same pattern as
   * tagToolsFromConfig, §7.92.2).
   */
  private readRegistrySchemas(): unknown[] {
    try {
      const toolsSvc = (this.ctx as unknown as {
        tools?: { schemas?: (scope?: unknown) => unknown[] }
      }).tools
      const schemas = toolsSvc?.schemas?.()
      return Array.isArray(schemas) ? schemas : []
    }
    catch {
      return []
    }
  }

  // ── Layer 3: Tool execution gating ──────────────────────────────────────────

  /**
   * Check whether a tool call is allowed in the calling agent's realm.
   * Returns a deny reason string, or undefined if the call is allowed.
   * A tool can belong to multiple realms (e.g. bash → LOCAL+CLOUD); the call
   * is allowed if the agent's realm is in the tool's realm set.
   */
  checkToolRealm(toolName: string, agentRealm: RealmTag | undefined): string | undefined {
    if (agentRealm === undefined) return undefined // unknown agent → allow (fail-open for now)
    if (agentRealm === 'hidden') return `Agent realm is 'hidden'; no tools allowed`
    const toolRealms = this.toolRealm(toolName)
    if (toolRealms === undefined) return undefined // unknown tool → no realm constraint
    if (toolRealms.has('hidden')) return `Tool "${toolName}" is hidden`
    if (!toolRealms.has(agentRealm)) {
      const realms = [...toolRealms].join(', ')
      return `Tool "${toolName}" (${realms}) not allowed in ${agentRealm} realm`
    }
    return undefined
  }

  /** Log a realm denial to the audit log (security level). */
  private auditDeny(toolName: string, toolRealms: Set<RealmTag>, agentRealm: RealmTag): void {
    this.auditLog?.log({
      level: 'security',
      kind: 'tool.realm.denied',
      source: 'realm-skill-bridge',
      payload: { tool: toolName, toolRealms: [...toolRealms], agentRealm },
    })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §7.93 Phase 2 (§7.93.1 通用化): external schema normalization (pure, exported for tests)
// ─────────────────────────────────────────────────────────────────────────────

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Normalize registry projections onto the external caller's flat wire contract
 * (`{name, description, parameters}`; current cactus-needle 3.0.1 impl follows
 * `~/work/needle/API.md` v1.1 §4.5):
 *
 * - entries without a non-empty string `name` are dropped (caller keys
 *   function_calls by name — a nameless schema is unexecutable)
 * - missing/non-string `description` → '' (caller tolerates it; the tool
 *   name + parameters carry the selection signal)
 * - missing/non-object `parameters` → permissive `{type:'object',
 *   properties:{}}` root (an unconstrained-args tool, e.g. no-arg status
 *   probes; JSON Schema semantics: absent properties = any object)
 *
 * Defensive by design: the registry projection is already whitelisted
 * upstream, but a runtime-registered tool with a hand-rolled shape must not
 * crash the external path — worst case it is dropped and the LLM path covers it.
 */
export function normalizeExternalToolSchemas(tools: ReadonlyArray<unknown>): ExternalToolSchema[] {
  const out: ExternalToolSchema[] = []
  for (const t of tools) {
    if (!isPlainRecord(t)) continue
    const name = t.name
    if (typeof name !== 'string' || name === '') continue
    out.push({
      name,
      description: typeof t.description === 'string' ? t.description : '',
      parameters: isPlainRecord(t.parameters)
        ? t.parameters
        : { type: 'object', properties: {} },
    })
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Type helpers for cross-package interop (avoid tight coupling to DSH types)
// ─────────────────────────────────────────────────────────────────────────────

interface AgentLike {
  session?: { header?: { id?: string; cwd?: string }; id?: string }
}

interface MessageLike {
  content?: unknown
  source?: {
    kind?: string
    form?: string
    plugin?: string
    entries?: ReadonlyArray<{ name?: string }>
  }
  role?: string
}

/** Minimal shape of a dsh-agent content block we care about (text only). */
interface TextBlockLike {
  type?: string
  text?: string
  [k: string]: unknown
}

function isTextBlock(block: unknown): block is TextBlockLike {
  return typeof block === 'object' && block !== null && (block as TextBlockLike).type === 'text'
}

/**
 * Recognise a message as a carrier of `<available_skills>` catalog content.
 *
 * Two shapes are accepted (§7.37):
 *   - `source.kind === 'skill-catalog'` — canonical dsh-tool-skill message
 *     (string content).
 *   - `source.kind === 'plugin' && source.plugin === '@deepseek-ai/dsh-system-prompt'`
 *     — dsh-system-prompt snapshot that bundles the catalog alongside
 *     sandbox/approval policy text. Content is array of text blocks; one
 *     block contains `<available_skills>`.
 *
 * Both must be filtered or LLM sees the full skill catalog and ignores
 * realm boundaries.
 */
function isCatalogMessage(msg: MessageLike): boolean {
  const src = msg.source
  if (!src) return false
  if (src.kind === 'skill-catalog') return true
  if (src.kind === 'plugin' && src.plugin === '@deepseek-ai/dsh-system-prompt') {
    // Cheap probe: any text in the message that mentions <available_skills>?
    const c = msg.content
    if (typeof c === 'string') return c.includes('<available_skills>')
    if (Array.isArray(c)) {
      return c.some(
        (b) => isTextBlock(b) && typeof b.text === 'string' && b.text.includes('<available_skills>'),
      )
    }
  }
  return false
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin entry point
// ─────────────────────────────────────────────────────────────────────────────

export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  // §7.102: fill unset fields from config/edge.json (privacy.*).
  const p = loadEdgeConfig().privacy
  const c = config as Partial<Config>
  if (c.configPath === undefined) {
    c.configPath = p?.realmConfigPath && p.realmConfigPath.length > 0
      ? p.realmConfigPath
      : edgeHome('skill-realms.json')
  }
  if (c.hotReload === undefined && p?.realmHotReload !== undefined) c.hotReload = p.realmHotReload
  if (c.watchIntervalMs === undefined && p?.realmWatchMs !== undefined) c.watchIntervalMs = p.realmWatchMs
  const auditLog = (ctx as unknown as { auditLog?: AuditLogLike }).auditLog
  const service = new RealmSkillBridgeService(ctx, config, auditLog)

  // Initial async tagging (needs ctx.skills.list() which is async).
  await service.start()

  // ── Subscribe to skills/change ────────────────────────────────────────────
  const disposeSkillsChange = (ctx as unknown as {
    on?: (event: string, fn: () => void) => () => void
  }).on?.('skills/change', () => {
    void service['tagSkillsAsync']()
  })

  // ── Subscribe to tools/change (to re-apply tool realm tags) ───────────────
  const disposeToolsChange = (ctx as unknown as {
    on?: (event: string, fn: () => void) => () => void
  }).on?.('tools/change', () => {
    service['tagToolsFromConfig']()
  })

  // ── Layer 1: Filter skill catalog on every agent step ─────────────────────
  // §7.36 (2026-09-04): 必须传 { global: true } —— agent/pre-step 默认 per-agent,
  // 只在注册时的 agent 实例上生效。http-api /v1/chat 路径上的 record.agent 是
  // 动态创建的(每次 followup 新 agent),per-agent 注册的 hook 收不到,导致
  // Layer 1 catalog filter 和 Layer 3 tool gating 永远不触发 → fail-open。
  // input-guard 用了 { global: true },realm-skill-bridge 之前漏了 → 整个
  // fail-open 链路"hook 在,但 agent 收不到"。
  //
  // §7.37 (2026-09-04): catalog filter on agent/pre-step is currently a no-op
  // because decision.messages is empty (msgCount=0) — <available_skills> is
  // injected by dsh-system-prompt plugin below the hook surface. Kept as a
  // no-op hook (decision.messages filter still runs in case future DSH
  // versions populate it) and supplemented by Layer 1.5 (llm/stream tools).
  const disposePreStep = (ctx as unknown as {
    on?: (
      event: string,
      fn: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>,
      options?: { global?: boolean },
    ) => () => void
  }).on?.('agent/pre-step', async (payload: unknown, next: () => Promise<unknown>) => {
    const decision = (await next()) as { kind: string; messages?: MessageLike[] }
    if (decision.kind === 'reject') return decision
    const p = payload as { agent?: AgentLike }
    const agentRealm = service.getAgentRealm(p.agent)
    if (agentRealm === undefined || decision.messages === undefined) return decision
    // §7.46 (2026-09-11): 用 detailed 版本拿到 droppedCount,
    // emit ops log 让"哪些 skill 被 filter 掉"在每个 chat 都可见
    const result = service.filterSkillCatalogDetailed(decision.messages, agentRealm)
    if (result.messages === decision.messages) return decision
    if (result.droppedCount > 0 || agentRealm !== 'hidden') {
      const sessionId = (p.agent as { session?: { id?: string } } | undefined)?.session?.id ?? 'unknown'
      try {
        ctx.logger?.info?.(
          `[realm-skill-bridge] pre-step filter sessionId=${sessionId} realm=${agentRealm} catalogDropped=${result.droppedCount}`,
        )
      } catch { /* debug only */ }
    }
    return { ...decision, messages: result.messages }
  }, { global: true })

  // ── Layer 1.5-replacement: Filter tool schemas at system-prompt/assemble ───
  // §7.37.x (2026-09-22): replace the deleted `llm/stream` tools probe.
  // Why the original probe is dead:
  //   dsh-agent-loop's buildRequest() deepFreezes the entire request payload
  //   (config + messages + system + tools + sessionId + signal) BEFORE the
  //   `llm/stream` waterfall fires. See @deepseek-ai/dsh-agent-loop/lib/index.js:729:
  //     markAgentLoopRequest(deepFreeze({
  //       ...header.config,
  //       messages: boundaryMessages,
  //       ...header.system !== void 0 ? { system: header.system } : {},
  //       ...header.tools !== void 0 ? { tools: header.tools } : {},
  //       sessionId: this.session.id, signal,
  //     }))
  //   After this, payload.tools at `llm/stream` is frozen — splice, push,
  //   Object.defineProperty all silently fail.
  //
  // Why system-prompt/assemble works:
  //   dsh-system-prompt/lib/index.js:339 builds assembly.tools via plain
  //   array concat (no freeze), then runs the `system-prompt/assemble`
  //   waterfall (line 342). The dsh type declaration explicitly states:
  //     "the returned value is authoritative"
  //   so we can return a new assembly with filtered tools. dsh-agent-loop
  //   then picks up `assembly.tools` and freezes them only later (line 729).
  //
  // Trade-off: `system-prompt/assemble` runs in `agent.preStep()` (every
  // step), so we filter once per LLM call. Layer 3 (tools/pre-execute)
  // remains the authoritative execution-time gate for runtime-added tools.
  // Layer 1.5-replacement here is a UX gate — LLM doesn't even ATTEMPT a
  // cross-realm tool call when its schema is hidden.
  const disposeAssemble = (ctx as unknown as {
    on?: (
      event: string,
      fn: (assembly: unknown, ctx2: unknown, next: () => Promise<unknown>) => Promise<unknown>,
      options?: { global?: boolean },
    ) => () => void
  }).on?.('system-prompt/assemble', async (assembly: unknown, ctx2: unknown, next: () => Promise<unknown>) => {
    const result = (await next()) as { tools?: unknown[]; [k: string]: unknown } | undefined
    if (!result || !Array.isArray(result.tools)) return result
    const assembleCtx = ctx2 as { scope?: AgentLike } | undefined
    const sessionId = assembleCtx?.scope?.session?.id
    const agentRealm = service.getSessionRealm(sessionId)
    // No realm classified yet → fail-open at this step. http-api sets
    // session realm via service.setSessionRealm() in the same request
    // lifecycle, so undefined should not happen in production. Layer 3
    // (tools/pre-execute) catches anything that slips through.
    if (agentRealm === undefined) return result
    const filter = service.filterToolsField(result.tools, agentRealm)
    if (!filter.changed) return result
    ctx.logger?.info?.(
      `[realm-skill-bridge] assemble filter sessionId=${sessionId ?? 'unknown'} realm=${agentRealm} removedCount=${filter.removed.length} removed=${filter.removed.join(',')}`,
    )
    return { ...result, tools: filter.tools }
  }, { global: true })

  // ── Layer 3: Gate tool execution by realm ─────────────────────────────────
  const disposePreExec = (ctx as unknown as {
    on?: (
      event: string,
      fn: (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>,
      options?: { global?: boolean },
    ) => () => void
  }).on?.('tools/pre-execute', async (exec: unknown, next: () => Promise<unknown>) => {
    const e = exec as { name: string; agent?: AgentLike; input?: Record<string, unknown>; args?: Record<string, unknown>; arguments?: Record<string, unknown> }
    const agentRealm = service.getAgentRealm(e.agent)
    const sessionId = (e.agent as { session?: { id?: string } } | undefined)?.session?.id ?? 'unknown'
    const denyReason = service.checkToolRealm(e.name, agentRealm)
    // §7.46.7 (2026-09-12): 尝试从 exec.args/input/arguments 抽出 skill name —
    // 当 tool=skill 时，ops log 应该报具体 skill 名（ets-auth 等），而不是只报 tool=skill。
    // dshtool-skill 的参数是 { name: '<skill>' }（lib/index.js:62），但 dsh-agent-loop
    // 把 args 放在哪个字段（input / args / arguments）随版本变，所以三个都试。
    // mibao-empty-result-diagnosis 排查时就是因为 ops log 只报 tool=skill
    // 看不出 LLM 实际选了哪个 skill（"查密盒登录状态"应该选 ets-auth，
    // 但 trace 完全看不到 skill 名字，无法判断是选错 skill 还是 skill 执行失败）。
    let skillName: string | undefined
    if (e.name === 'skill') {
      const argsObj = e.input ?? e.args ?? e.arguments
      const raw = argsObj && typeof argsObj === 'object' ? (argsObj as Record<string, unknown>).name : undefined
      skillName = typeof raw === 'string' ? raw : undefined
    }
    // §7.46 (2026-09-11): ops log 标记每个 tool call 的 allow/deny 决策,
    // 配合 chat-received/finished/preflight/pre-step 形成完整 flow log
    try {
      const skillSuffix = skillName ? ` skillName=${skillName}` : ''
      if (denyReason !== undefined) {
        ctx.logger?.info?.(
          `[realm-skill-bridge] tool deny sessionId=${sessionId} tool=${e.name}${skillSuffix} realm=${agentRealm ?? 'unknown'} reason=${denyReason}`,
        )
      } else {
        ctx.logger?.info?.(
          `[realm-skill-bridge] tool allow sessionId=${sessionId} tool=${e.name}${skillSuffix} realm=${agentRealm ?? 'unknown'}`,
        )
      }
    } catch { /* debug only */ }
    if (denyReason !== undefined) {
      const toolRealms = service.toolRealm(e.name) ?? new Set<RealmTag>(['hidden' as RealmTag])
      service['auditDeny'](e.name, toolRealms, agentRealm ?? 'hidden')
      return { kind: 'deny', reason: denyReason }
    }
    return next()
  }, { global: true })

  // ── Layer 3.5: tool execution result ops log (§7.47.6) ──────────────────
  //
  // user feedback 2026-09-13: "每次修BUG通过日志来修理，确保日志里有所有错误的信息"
  //
  // tools/pre-execute (Layer 3 above) only emits the realm check decision.
  // The actual tool execution result (success / error / duration / signal-aborted)
  // was completely invisible in ops log — 150 tool allow lines vs 3 tool result
  // lines. Diagnosing "news query returned empty because web_search hung"
  // required manual trace, not ops log. Now: subscribe to the serial
  // `tools/result` event (dispatched by dsh-tools after `tools/post-execute`
  // waterfall finishes — pure observation, no next chain so we can't break it).
  //
  // Payload shape (from dsh-tools): exec = { name, agent, signal, ... },
  // result = { isError: boolean, message?: unknown, ... }. We emit metadata
  // only — full result content stays in audit-log (opt-in via
  // DSH_EDGE_LOG_LEVEL=debug).
  const disposeToolResult = (ctx as unknown as {
    on?: (event: string, fn: (exec: unknown, result: unknown) => void, options?: { global?: boolean }) => () => void
  }).on?.('tools/result', (exec: unknown, result: unknown) => {
    try {
      const e = exec as { name?: string; agent?: AgentLike; args?: string; token?: string } | undefined
      const r = result as { isError?: boolean; signalAborted?: boolean; message?: unknown } | undefined
      const toolName = typeof e?.name === 'string' ? e.name : '<unknown>'
      const sessionId = (e?.agent as { session?: { id?: string } } | undefined)?.session?.id ?? 'unknown'
      const isError = r?.isError === true
      const signalAborted = r?.signalAborted === true
      const status = signalAborted ? 'aborted' : isError ? 'error' : 'ok'
      try {
        ctx.logger?.info?.(
          `[realm-skill-bridge] tool result sessionId=${sessionId} tool=${toolName} status=${status}${isError ? ` errorKind=${typeof r?.message === 'string' ? r.message.slice(0, 100) : 'unknown'}` : ''}`,
        )
      } catch { /* debug only */ }
    } catch { /* debug only */ }
  }, { global: true })

  // ── Flow-level ops log for every chat round-trip (§7.44.1) ───────────────
  //
  // 用户反馈 §7.44 把 ops log 默认从 debug 翻到 info 后，TUI 输入的请求
  // 在 log 里没有记录 —— 因为 TUI 不走 http-api（http-api 才有 flow
  // info log 'POST /v1/chat 200 ...ms'），TUI 直接走 dsh-agent-loop +
  // Session。session/event 上的 request/header 和 turn/end 是 user
  // prompt lifecycle 的最稳两个 marker（每个 chat round-trip 各 fire
  // 一次，TUI / http-api / 未来 webui 都覆盖）。
  //
  // 这里 emit 单行 info（metadata only：session id + turn + reason），
  // 不带任何 user PII；body capture 仍走 audit-log + opt-in
  // DSH_EDGE_LOG_LEVEL=debug。
  // §7.46 (2026-09-11): per-session start time map 算 chat duration,
  // 配合 chat finished line 的 realm= 让"这条 chat 路由了哪个 realm /
  // 用了多久"在 ops log 一目了然。
  const sessionStartTimes = new Map<string, number>()
  const disposeSessionEvents = (ctx as unknown as {
    on?: (
      event: string,
      fn: (session: unknown, evt: unknown) => void,
      options?: { global?: boolean },
    ) => () => void
  }).on?.('session/event', (session: unknown, evt: unknown) => {
    const e = evt as { type?: string; data?: Record<string, unknown> } | undefined
    if (e === undefined || typeof e.type !== 'string') return
    const sessionId = (session as { id?: string })?.id ?? 'unknown'
    // §7.44.1 (2026-09-11): 为 TUI / 任何非 http-api 入口加 flow-level
    // info log —— §7.44 把 ops log 默认翻 info 后，TUI 走 dsh-agent-loop
    // 不再被 file-logger 默认捕到（http-api 才有自己的 POST /v1/chat 200
    // 行），整轮 chat 在 log 里无痕迹。session/event 是 dsh 内部一套
    // per-session 事件流，覆盖所有 entry point（TUI / http-api / 未来
    // webui 都走）。每个 chat round-trip fire 一次 'request/header'
    // （agent-loop 在 user prompt 起点 emit，see
    // @deepseek-ai/dsh-agent-loop/lib/index.js）和一次 'turn/end'，
    // 我们在 info 级各 emit 单行（metadata only：不带 user 文本 / PII），
    // 让 ops log 始终能看到"什么时候来了什么请求、什么时候结束"。
    if (e.type === 'request/header') {
      // 之前的 'startsSeries=true' 过滤在本路径下永远不命中（实测 data
      // 里不带 startsSeries 字段，session/event 的 data shape 跟
      // SessionEventMap 声明不完全一致），改成无条件 log 每个 request/
      // header 事件 —— 实测每个 chat 恰好 fire 1 次（user/message 那
      // 种 N 次是因为 session hydration / 重注入，与 request series
      // 不是一回事）。
      const data = e.data as { reason?: string; startsSeries?: boolean } | undefined
      const reason = typeof data?.reason === 'string' ? data.reason : 'unknown'
      const ss = data?.startsSeries === true ? ' series-start' : ''
      sessionStartTimes.set(sessionId, Date.now())
      ctx.logger?.info?.(`[realm-skill-bridge] chat received sessionId=${sessionId} reason=${reason}${ss}`)
    } else if (e.type === 'turn/end') {
      const data = e.data ?? {}
      const turn = typeof data.turn === 'number' ? data.turn : -1
      // §7.47.6 (2026-09-13): serialize turnEnds object instead of dropping
      // to 'unknown'. dsh-agent-loop emits `turnEnds = { kind: "aborted",
      // reason: signal.reason }` (object, not string). Pre-§7.47.6 code
      // checked `typeof === 'string'` and silently fell back to 'unknown',
      // hiding abort reasons like max-turns / signal-abort / completed.
      // Now: stringify object into compact key=value form for ops log.
      const reason = serializeTurnEndReason(data.reason)
      const startMs = sessionStartTimes.get(sessionId)
      const durationMs = startMs !== undefined ? Date.now() - startMs : -1
      const realm = service.getSessionRealm(sessionId) ?? 'unset'
      const durationStr = durationMs >= 0 ? ` duration=${durationMs}ms` : ' duration=-1'
      ctx.logger?.info?.(
        `[realm-skill-bridge] chat finished sessionId=${sessionId} turn=${turn} reason=${reason} realm=${realm}${durationStr}`,
      )
      sessionStartTimes.delete(sessionId)
    }
  })

  return async () => {
    service.stop()
    service.clearSessionRealms()
    disposeSkillsChange?.()
    disposeToolsChange?.()
    disposePreStep?.()
    disposeAssemble?.()
    disposePreExec?.()
    disposeToolResult?.()
    disposeSessionEvents?.()
    sessionStartTimes.clear()
  }
}
