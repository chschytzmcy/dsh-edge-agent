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
export const inject = ['auditLog'] as const

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

  /** Resolve the realm for an agent by looking up its session. */
  getAgentRealm(agent: AgentLike | undefined): RealmTag | undefined {
    const sessionId = agent?.session?.header?.id
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
      const list = await this.ctx.skills.list()
      for (const skill of list) {
        const realm = this.resolveSkillRealm(skill.name)
        this.skillRealms.set(skill.name, realm)
      }
    } catch {
      // skills service not yet available — will retry on skills/change.
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
   * Filter the <available_skills> catalog injected by dsh-tool-skill so the
   * agent only sees skills in its realm. Skills tagged 'hidden' are removed
   * from every agent's catalog.
   *
   * The catalog is a UserMessage with source.kind === 'skill-catalog'.
   * Its content is a <system-reminder> block containing one line per skill:
   *
   *   - `skill-name`: Description text
   *
   * We parse each line, look up the skill's realm, and drop disallowed ones.
   */
  filterSkillCatalog(messages: readonly MessageLike[], agentRealm: RealmTag): readonly MessageLike[] {
    if (agentRealm === 'hidden') return messages
    return messages.map((msg) => {
      if (!isCatalogMessage(msg)) return msg
      const content = typeof msg.content === 'string' ? msg.content : ''
      if (!content.includes('<available_skills>')) return msg
      const filtered = this.filterCatalogContent(content, agentRealm)
      if (filtered === content) return msg
      return { ...msg, content: filtered }
    })
  }

  private filterCatalogContent(content: string, agentRealm: RealmTag): string {
    const lines = content.split('\n')
    const out: string[] = []
    for (const line of lines) {
      const m = line.match(/^-\s+`([^`]+)`:\s*(.*)$/)
      if (m !== null) {
        const skillName = m[1]
        const realm = this.skillRealm(skillName)
        if (realm === 'hidden' || realm !== agentRealm) continue
      }
      out.push(line)
    }
    return out.join('\n')
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
  session?: { header?: { id?: string; cwd?: string } }
}

interface MessageLike {
  content?: unknown
  source?: { kind?: string; form?: string; entries?: ReadonlyArray<{ name?: string }> }
  role?: string
}

function isCatalogMessage(msg: MessageLike): boolean {
  return msg.source?.kind === 'skill-catalog'
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
  const disposePreStep = (ctx as unknown as {
    on?: (event: string, fn: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) => () => void
  }).on?.('agent/pre-step', async (payload: unknown, next: () => Promise<unknown>) => {
    const decision = (await next()) as { kind: string; messages?: MessageLike[] }
    if (decision.kind === 'reject') return decision
    const p = payload as { agent?: AgentLike }
    const agentRealm = service.getAgentRealm(p.agent)
    if (agentRealm === undefined || decision.messages === undefined) return decision
    const filtered = service.filterSkillCatalog(decision.messages, agentRealm)
    if (filtered === decision.messages) return decision
    return { ...decision, messages: filtered }
  })

  // ── Layer 3: Gate tool execution by realm ─────────────────────────────────
  const disposePreExec = (ctx as unknown as {
    on?: (event: string, fn: (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>) => () => void
  }).on?.('tools/pre-execute', async (exec: unknown, next: () => Promise<unknown>) => {
    const e = exec as { name: string; agent?: AgentLike }
    const agentRealm = service.getAgentRealm(e.agent)
    const denyReason = service.checkToolRealm(e.name, agentRealm)
    if (denyReason !== undefined) {
      const toolRealms = service.toolRealm(e.name) ?? new Set<RealmTag>(['hidden' as RealmTag])
      service['auditDeny'](e.name, toolRealms, agentRealm ?? 'hidden')
      return { kind: 'deny', reason: denyReason }
    }
    return next()
  })

  return async () => {
    service.stop()
    disposeSkillsChange?.()
    disposeToolsChange?.()
    disposePreStep?.()
    disposePreExec?.()
  }
}
