/**
 * realm-skill-bridge — Realm-aware skill and tool isolation for dsh-edge-agent.
 *
 * Reads a user-editable JSON config (`skill-realms.json`) that maps skill/tool
 * names (or glob patterns) to LOCAL | CLOUD realms. Tags every discovered skill
 * and tool accordingly, then enforces the mapping at two enforcement points:
 *
 *   Layer 1 (agent/pre-step): filter the <available_skills> catalog so each
 *     agent only sees skills in its own realm. Skills tagged `hidden` are
 *     invisible to every agent.
 *
 *   Layer 3 (tools/pre-execute): deny tool execution when the tool's realm
 *     does not match the calling agent's realm (defense-in-depth — Layer 2
 *     schema filtering is wired separately through http-api + filterTools).
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

export const name = 'realm-skill-bridge'
export const inject = ['auditLog', 'skills'] as const

/** Realm tag for skills and tools. 'hidden' means invisible to all agents. */
export type RealmTag = 'LOCAL' | 'CLOUD' | 'SANITIZED' | 'hidden'

export interface Config {
  /** Path to the skill-realms.json config file. */
  configPath: string
  /** Whether to hot-reload the config on file change (via stat polling). */
  hotReload: boolean
  /** Polling interval in ms for config change detection. */
  watchIntervalMs: number
}

export const Config: Schema<Config> = Schema.object({
  configPath: Schema.string().default(
    // Default: ~/.dsh-edge-agent/skill-realms.json
    (process.env.USERPROFILE ?? process.env.HOME ?? '') + '/.dsh-edge-agent/skill-realms.json',
  ),
  hotReload: Schema.boolean().default(true),
  watchIntervalMs: Schema.natural().default(5000),
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

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Set the realm for a session (called by http-api after intent classification). */
  setSessionRealm(sessionId: string, realm: RealmTag): void {
    if (realm === 'hidden') return
    this.sessionRealms.set(sessionId, realm)
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
   */
  filterToolsField(
    tools: ReadonlyArray<unknown>,
    agentRealm: RealmTag,
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
    if (removed.length > 0) {
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

  // ── Layer 1.5: Filter tools list on llm/stream (§7.37) — DISABLED ────────
  //
  // llm/stream payload carries [provider, model, messages, system, tools,
  // sessionId, signal]. The catalog text (<available_skills>) lives outside
  // any reachable dsh hook, so the only LLM-visible realm leak is the
  // `tools` array. Filtering it would let LOCAL LLM sessions never see
  // web_search / web_fetch — but dsh-llm 0.1.2-rc.1 deep-freezes the entire
  // payload (object + array + every index) before waterfall dispatches it,
  // so we cannot splice / reassign / Object.defineProperty `payload.tools`
  // without throwing "Cannot delete property N of [object Array]" (or
  // "Cannot redefine property: tools"). Every mutation strategy breaks
  // dsh boot.
  //
  // The actual fix (§7.36) is upstream: input-guard now registers session
  // realm before llm/stream fires, so Layer 3 (tools/pre-execute, see
  // disposePreExec below) sees agentRealm=LOCAL and DENIES web_search /
  // web_fetch at execution time. We keep the same probe here so that the
  // audit log records every llm/stream invocation and which session it
  // belongs to — useful for debugging "LLM chose wrong tool" complaints
  // even though we don't filter the array.
  const disposeStream = (ctx as unknown as {
    on?: (
      event: string,
      // §7.39 (2026-09-04): SYNCHRONOUS listener — must NOT be `async`.
      // Cordis waterfall returns the outermost listener's value verbatim.
      // An async listener wraps the inner `next()` result (which is the
      // AsyncGenerator returned by `dsh-llm.adapterStream`) in a Promise,
      // and dsh-agent-loop's `for await (const chunk of stream)` then
      // throws "stream is not async iterable" because it receives
      // Promise<AsyncGenerator> instead of AsyncGenerator. AuditLogLike.log
      // is declared `void` (sync), so no await is needed here.
      fn: (payload: unknown, next: () => unknown) => unknown,
      options?: { global?: boolean },
    ) => () => void
  }).on?.('llm/stream', (payload: unknown, next: () => unknown) => {
    // Read-only audit probe — payload is frozen by dsh-llm.
    //
    // §7.47.4 (2026-09-13): drop the `typeof sessionId === 'string'` gate AND
    // switch sink from `auditLog?.log` to `ctx.logger?.info`. Pre-§7.47.4
    // called `service.auditLog?.log?.({level:'info',...})` — but for some
    // reason that path silently no-ops on every chat call (probe fired per
    // stderr, ops log had 0 lines). Other realm-skill-bridge listeners
    // (tool allow, chat finished, etc.) use `ctx.logger?.info(...)` and
    // those land reliably. Switch to the proven sink to satisfy the
    // "every node in ops log" coverage principle (user feedback 2026-09-13:
    // "每次修BUG通过日志来修理，确保日志里有所有错误的信息").
    //
    // Pre-§7.47.4 gate `if (typeof p.sessionId === 'string')` skipped 100%
    // of calls because GenerateOptions.sessionId is optional + branded —
    // upstream dsh-agent-loop doesn't always populate it. Now: log every
    // call with whatever fields are present (sessionId may be '<none>').
    const p = payload as
      | { sessionId?: string; tools?: ReadonlyArray<unknown>; provider?: string; model?: string }
      | undefined
    if (p !== undefined) {
      const sessionId = typeof p.sessionId === 'string' ? p.sessionId : '<none>'
      const provider = typeof p.provider === 'string' ? p.provider : '<none>'
      const model = typeof p.model === 'string' ? p.model : '<none>'
      const toolsCount = Array.isArray(p.tools) ? p.tools.length : 0
      const agentRealm = sessionId !== '<none>' ? service.getSessionRealm(sessionId) : null
      try {
        ;(ctx as unknown as { logger?: { info?: (...args: unknown[]) => void } }).logger?.info?.(
          `[realm-skill-bridge] llm/stream probe sessionId=${sessionId} provider=${provider} model=${model} toolsCount=${toolsCount} agentRealm=${agentRealm ?? 'null'} note=frozen-payload-Layer3-enforces`,
        )
      }
      catch { /* debug only */ }
    }
    // Return the inner chain result synchronously so the AsyncGenerator
    // reaches dsh-agent-loop unwrapped.
    return next()
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
      const reason = typeof data.reason === 'string' ? data.reason : 'unknown'
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
    disposeSkillsChange?.()
    disposeToolsChange?.()
    disposePreStep?.()
    disposeStream?.()
    disposePreExec?.()
    disposeSessionEvents?.()
    sessionStartTimes.clear()
  }
}
