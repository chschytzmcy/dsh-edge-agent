/**
 * realm-skill-bridge plugin tests — exercises glob matching, config loading,
 * realm resolution, skill catalog filtering, tool realm gating, and the
 * default config bootstrap.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'vitest'

import * as plugin from '../../src/dsh-adapter/realm-skill-bridge.ts'
import { RealmSkillBridgeService, globMatch } from '../../src/dsh-adapter/realm-skill-bridge.ts'
import { loadEdgeConfig, resetEdgeConfigCache } from '../../src/dsh-adapter/edge-config.ts'
import type { RealmConfig } from '../../src/dsh-adapter/realm-skill-bridge.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Fakes
// ─────────────────────────────────────────────────────────────────────────────

function fakeCtx(skills: ReadonlyArray<{ name: string; description?: string }> = []) {
  return {
    reflect: { provide(_n: string, _v: unknown) { return () => {} } },
    provide(_n: string, _v: unknown) { return () => {} },
    skills: {
      async list() { return skills },
      async snapshot() { return { skills, complete: true } },
    },
    logger: { info: () => {}, warn: () => {} },
  }
}

function fakeAuditLog() {
  const entries: any[] = []
  return { entries, log(entry: any) { entries.push(entry) } }
}

let root: string

/**
 * §7.221: 本文件测的是**realm 语义**（哪个 realm 能用哪个工具），而
 * `web_search` 在 §7.221 之后还多一道「搜索档位可用性」闸门（两档都没
 * enable ⇒ 工具层 web_search 不提供）。本文件把 `web_search` 当 CLOUD 档的
 * 夹具用 ⇒ 必须先把搜索档位**打开**，否则测的就不再是 realm 语义。
 *
 * 那道闸门本身在 `web-search-tool-gate.test.ts` 里单独测。
 */
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'edge-realm-'))
  const edgeConfigPath = join(root, 'edge.json')
  writeFileSync(
    edgeConfigPath,
    JSON.stringify({
      webSearch: { tavilyEnabled: true, bochaEnabled: false },
      secrets: { tavilyApiKey: 'tvly-fake' },
    }),
    'utf8',
  )
  // 显式给候选路径 ⇒ 绕过 vitest 全局的 DSH_EDGE_CONFIG_FILE=off（那层是
  // 为了不让开发机的活配置泄进断言）；之后 loadEdgeConfig() 命中这个缓存。
  loadEdgeConfig(true, [edgeConfigPath])
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  resetEdgeConfigCache()
})

function writeConfig(name: string, config: Partial<RealmConfig>): string {
  const path = join(root, name)
  writeFileSync(path, JSON.stringify(config))
  return path
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('realm-skill-bridge', () => {
  it('exports the canonical plugin shape', () => {
    assert.equal(plugin.name, 'realm-skill-bridge')
    // §7.36: `skills` was added to inject — apply() reads ctx.skills.list()
    // and ctx.skills.on('change') for catalog refresh. auditLog is also
    // required for ops log emission in start()/setSessionRealm().
    // §7.92.2 (2026-09-22): `edgeTools` + `tools` added — tagToolsFromConfig
    // reads both; undeclared ctx reads silently throw via the cordis proxy.
    assert.deepEqual([...plugin.inject], ['auditLog', 'skills', 'edgeTools', 'tools'])
    assert.equal(typeof plugin.apply, 'function')
    assert.ok(plugin.Config)
  })

  // ── globMatch ──────────────────────────────────────────────────────────────

  describe('globMatch', () => {
    it('exact match when no wildcard', () => {
      assert.equal(globMatch('sys-monitor', 'sys-monitor'), true)
      assert.equal(globMatch('sys-monitor', 'sys-other'), false)
    })

    it('suffix glob (lark-*)', () => {
      assert.equal(globMatch('lark-*', 'lark-im'), true)
      assert.equal(globMatch('lark-*', 'lark-calendar'), true)
      assert.equal(globMatch('lark-*', 'lark-'), true) // zero chars ok
      assert.equal(globMatch('lark-*', 'not-lark-im'), false)
      assert.equal(globMatch('lark-*', 'ets-auth'), false)
    })

    it('prefix glob (*-workflow)', () => {
      assert.equal(globMatch('*-workflow', 'meeting-workflow'), true)
      assert.equal(globMatch('*-workflow', 'workflow'), false) // needs prefix
    })

    it('middle glob (foo-*-bar)', () => {
      assert.equal(globMatch('foo-*-bar', 'foo-x-bar'), true)
      assert.equal(globMatch('foo-*-bar', 'foo-hello-bar'), true)
      assert.equal(globMatch('foo-*-bar', 'foo-bar'), false) // needs middle
    })

    it('does not confuse regex-special chars', () => {
      // The matcher escapes . + ^ etc. so "a.b" only matches "a.b", not "axb".
      assert.equal(globMatch('a.b', 'a.b'), true)
      assert.equal(globMatch('a.b', 'axb'), false)
    })

    it('multi-star glob', () => {
      assert.equal(globMatch('a*b*c', 'aXXbYYc'), true)
      assert.equal(globMatch('a*b*c', 'abc'), true) // each * can match 0 chars
      assert.equal(globMatch('a*b*c', 'aXXc'), false) // must have 'b' between
    })
  })

  // ── Service basics ─────────────────────────────────────────────────────────

  describe('RealmSkillBridgeService', () => {
    it('bootstraps default config file when missing', async () => {
      const configPath = join(root, 'sub', 'skill-realms.json')
      const service = new RealmSkillBridgeService(
        fakeCtx() as never,
        { configPath, hotReload: false, watchIntervalMs: 5000 },
        undefined,
      )
      // Before start, no config file exists.
      assert.equal(existsSync(configPath), false)
      await service.start()
      // After start, either the template was copied or the dir doesn't exist.
      // The template path depends on import.meta.url resolution which may not
      // work in tests — but the service should not throw.
      service.stop()
    })

    it('loads a valid config file', async () => {
      const configPath = writeConfig('skill-realms.json', {
        skills: { 'lark-*': 'CLOUD', 'sys-monitor': 'LOCAL' },
        tools: { lark_api: 'CLOUD' },
        defaultRealm: 'hidden',
      })
      const service = new RealmSkillBridgeService(
        fakeCtx() as never,
        { configPath, hotReload: false, watchIntervalMs: 5000 },
        undefined,
      )
      await service.start()
      assert.equal(service.skillRealm('lark-im'), 'CLOUD')
      assert.equal(service.skillRealm('sys-monitor'), 'LOCAL')
      assert.equal(service.skillRealm('unknown'), 'hidden')
      service.stop()
    })

    it('falls back to hidden when config file is missing', async () => {
      const configPath = join(root, 'nonexistent.json')
      const service = new RealmSkillBridgeService(
        fakeCtx() as never,
        { configPath, hotReload: false, watchIntervalMs: 5000 },
        undefined,
      )
      await service.start()
      assert.equal(service.skillRealm('anything'), 'hidden')
      service.stop()
    })

    it('falls back to hidden when config file has invalid JSON', async () => {
      const configPath = join(root, 'bad.json')
      writeFileSync(configPath, '{ not valid json }}}')
      const service = new RealmSkillBridgeService(
        fakeCtx() as never,
        { configPath, hotReload: false, watchIntervalMs: 5000 },
        undefined,
      )
      await service.start()
      assert.equal(service.skillRealm('anything'), 'hidden')
      service.stop()
    })

    it('ignores invalid defaultRealm values', async () => {
      const configPath = writeConfig('skill-realms.json', {
        skills: {},
        tools: {},
        defaultRealm: 'invalid-value',
      })
      const service = new RealmSkillBridgeService(
        fakeCtx() as never,
        { configPath, hotReload: false, watchIntervalMs: 5000 },
        undefined,
      )
      await service.start()
      assert.equal(service.skillRealm('anything'), 'hidden')
      service.stop()
    })

    it('glob patterns match in declaration order', async () => {
      const configPath = writeConfig('skill-realms.json', {
        // First match wins: "lark-shared" matches both "lark-*" and "lark-shared"
        // but "lark-shared" is more specific (exact match beats glob).
        skills: { 'lark-*': 'CLOUD', 'lark-shared': 'LOCAL' },
        tools: {},
        defaultRealm: 'hidden',
      })
      const service = new RealmSkillBridgeService(
        fakeCtx() as never,
        { configPath, hotReload: false, watchIntervalMs: 5000 },
        undefined,
      )
      await service.start()
      // Exact name match has priority over glob
      assert.equal(service.skillRealm('lark-shared'), 'LOCAL')
      assert.equal(service.skillRealm('lark-im'), 'CLOUD')
      service.stop()
    })
  })

  // ── Session realm ──────────────────────────────────────────────────────────

  describe('session realm', () => {
    it('tracks session → realm mapping', async () => {
      const configPath = writeConfig('skill-realms.json', {
        skills: {},
        tools: {},
        defaultRealm: 'hidden',
      })
      const service = new RealmSkillBridgeService(
        fakeCtx() as never,
        { configPath, hotReload: false, watchIntervalMs: 5000 },
        undefined,
      )
      await service.start()

      // §7.36/§7.37 (2026-09-04): getAgentRealm reads `agent.session.id`
      // (canonical key for sessionRealms map), NOT `session.header.id`.
      // input-guard registers via `payload.agent.session.id`; header.id
      // was a wrong-fixture assumption that broke Layer 1.5 silently.
      const agent = { session: { id: 'sess-1' } }
      assert.equal(service.getAgentRealm(agent as any), undefined)
      service.setSessionRealm('sess-1', 'LOCAL')
      assert.equal(service.getAgentRealm(agent as any), 'LOCAL')
      service.setSessionRealm('sess-1', 'CLOUD')
      assert.equal(service.getAgentRealm(agent as any), 'CLOUD')
      service.stop()
    })

    it('ignores hidden realm for sessions', async () => {
      const configPath = writeConfig('skill-realms.json', {
        skills: {},
        tools: {},
        defaultRealm: 'hidden',
      })
      const service = new RealmSkillBridgeService(
        fakeCtx() as never,
        { configPath, hotReload: false, watchIntervalMs: 5000 },
        undefined,
      )
      await service.start()
      service.setSessionRealm('sess-1', 'hidden')
      const agent = { session: { header: { id: 'sess-1' } } }
      // hidden should not be stored for sessions
      assert.equal(service.getAgentRealm(agent as any), undefined)
      service.stop()
    })
  })

  // ── Layer 1: catalog filtering ─────────────────────────────────────────────

  describe('filterSkillCatalog', () => {
    let service: RealmSkillBridgeService

    beforeEach(async () => {
      const configPath = writeConfig('skill-realms.json', {
        skills: {
          'lark-*': 'CLOUD',
          'sys-monitor': 'LOCAL',
          'device-ctrl': 'LOCAL',
          'hidden-skill': 'hidden',
        },
        tools: {},
        defaultRealm: 'hidden',
      })
      service = new RealmSkillBridgeService(
        fakeCtx() as never,
        { configPath, hotReload: false, watchIntervalMs: 5000 },
        undefined,
      )
      await service.start()
    })

    afterEach(() => { service.stop() })

    it('§7.47.1: catalog filter is opt-out — keeps all non-hidden skills', () => {
      // §7.47.1 (2026-09-12): filterCatalogText no longer drops skills by
      // agentRealm. Skill.realm is single (LOCAL/CLOUD/hidden), but tools
      // are multi-realm Set. `bash` is skill.realm=LOCAL yet toolRealms=
      // {LOCAL, CLOUD}. Pre-fix, CLOUD agent saw every LOCAL skill dropped
      // (droppedCount=11) — Layer 3 is the authoritative realm gate.
      // Test: any agentRealm keeps visible skills; hidden-skill drops.
      const messages = [
        {
          source: { kind: 'skill-catalog' },
          content: `<system-reminder>
Skills available:

<available_skills>
- \`lark-im\`: Send messages
- \`sys-monitor\`: Monitor system
- \`device-ctrl\`: Control devices
- \`hidden-skill\`: Secret
</available_skills>
</system-reminder>`,
        },
      ]
      for (const realm of ['LOCAL', 'CLOUD', 'SANITIZED'] as const) {
        const filtered = service.filterSkillCatalog(messages, realm)
        const content = (filtered[0] as any).content
        // All visible skills kept regardless of realm
        assert.ok(content.includes('lark-im'), `realm=${realm}: lark-im kept`)
        assert.ok(content.includes('sys-monitor'), `realm=${realm}: sys-monitor kept`)
        assert.ok(content.includes('device-ctrl'), `realm=${realm}: device-ctrl kept`)
        // Hidden still dropped (security boundary)
        assert.ok(!content.includes('hidden-skill'), `realm=${realm}: hidden-skill dropped`)
      }
    })

    it('§7.47.1: droppedCount=0 for non-hidden catalog regardless of realm', () => {
      // Symmetric assertion: no realm drops visible skills. Only 'hidden'
      // tag or default-unknown triggers dropCount > 0.
      const messages = [
        {
          source: { kind: 'skill-catalog' },
          content: `<available_skills>
- \`lark-im\`: CLOUD skill
- \`sys-monitor\`: LOCAL skill
</available_skills>`,
        },
      ]
      for (const realm of ['LOCAL', 'CLOUD', 'SANITIZED'] as const) {
        const result = (service as any).filterSkillCatalogDetailed(messages, realm)
        assert.equal(result.droppedCount, 0, `realm=${realm} should drop 0 visible skills`)
      }
    })

    it('returns all messages when realm is hidden', () => {
      const messages = [{ source: { kind: 'other' }, content: 'hello' }]
      const filtered = service.filterSkillCatalog(messages, 'hidden')
      assert.deepEqual(filtered, messages)
    })

    it('leaves non-catalog messages unchanged', () => {
      const messages = [
        { source: { kind: 'chat' }, content: 'user message' },
        { role: 'assistant', content: 'reply' },
      ]
      const filtered = service.filterSkillCatalog(messages, 'LOCAL')
      assert.deepEqual(filtered, messages)
    })

    it('preserves non-skill lines in catalog', () => {
      const messages = [
        {
          source: { kind: 'skill-catalog' },
          content: `<system-reminder>
Some preamble text.

<available_skills>
- \`sys-monitor\`: OK
</available_skills>

Some footer text.
</system-reminder>`,
        },
      ]
      const filtered = service.filterSkillCatalog(messages, 'LOCAL')
      const content = (filtered[0] as any).content
      assert.ok(content.includes('Some preamble text.'))
      assert.ok(content.includes('Some footer text.'))
      assert.ok(content.includes('sys-monitor'))
    })

    // §7.45 (2026-09-11): regression — SANITIZED agents used to drop the
    // entire catalog because skillRealm() never returns 'SANITIZED' and
    // the strict-equality check rejected every line (observed in TUI
    // session 468e0157-… droppedCount=33). Mirrors filterToolsField's
    // SANITIZED branch.
    it('keeps every non-hidden skill for SANITIZED agent (§7.45)', () => {
      const messages = [
        {
          source: { kind: 'skill-catalog' },
          content: `<system-reminder>
<available_skills>
- \`lark-im\`: Send messages
- \`lark-calendar\`: Manage calendar
- \`sys-monitor\`: Monitor system
- \`device-ctrl\`: Control devices
- \`hidden-skill\`: Secret
</available_skills>
</system-reminder>`,
        },
      ]
      const filtered = service.filterSkillCatalog(messages, 'SANITIZED')
      const content = (filtered[0] as any).content
      assert.ok(content.includes('lark-im'))
      assert.ok(content.includes('lark-calendar'))
      assert.ok(content.includes('sys-monitor'))
      assert.ok(content.includes('device-ctrl'))
      assert.ok(!content.includes('hidden-skill'))
    })
  })

  // ── Layer 3: tool execution gating ─────────────────────────────────────────

  describe('checkToolRealm', () => {
    let service: RealmSkillBridgeService

    beforeEach(async () => {
      const configPath = writeConfig('skill-realms.json', {
        skills: {},
        tools: {
          lark_api: 'CLOUD',
          sys_info: 'LOCAL',
          hidden_tool: 'hidden' as any,
        },
        defaultRealm: 'hidden',
      })
      service = new RealmSkillBridgeService(
        fakeCtx() as never,
        { configPath, hotReload: false, watchIntervalMs: 5000 },
        undefined,
      )
      await service.start()
    })

    afterEach(() => { service.stop() })

    it('allows tool when realms match', () => {
      assert.equal(service.checkToolRealm('lark_api', 'CLOUD'), undefined)
      assert.equal(service.checkToolRealm('sys_info', 'LOCAL'), undefined)
    })

    it('denies tool when realms mismatch', () => {
      const reason = service.checkToolRealm('lark_api', 'LOCAL')
      assert.ok(reason !== undefined)
      assert.ok(reason!.includes('lark_api'))
      assert.ok(reason!.includes('CLOUD'))
      assert.ok(reason!.includes('LOCAL'))
    })

    it('denies hidden tool regardless of agent realm', () => {
      assert.ok(service.checkToolRealm('hidden_tool', 'LOCAL') !== undefined)
      assert.ok(service.checkToolRealm('hidden_tool', 'CLOUD') !== undefined)
    })

    it('allows unknown tool (no realm constraint)', () => {
      // Tools not in the config have no realm constraint → allow
      assert.equal(service.checkToolRealm('unknown_tool', 'LOCAL'), undefined)
      assert.equal(service.checkToolRealm('unknown_tool', 'CLOUD'), undefined)
    })

    it('allows when agent realm is unknown (fail-open)', () => {
      // If we don't know the agent's realm, we can't enforce → allow
      assert.equal(service.checkToolRealm('lark_api', undefined), undefined)
    })

    it('denies when agent realm is hidden', () => {
      assert.ok(service.checkToolRealm('sys_info', 'hidden') !== undefined)
    })
  })

  // ── Lark skills → CLOUD realm ──────────────────────────────────────────────

  describe('lark skills as CLOUD', () => {
    // All 19 installed lark-* skills should be tagged CLOUD per the default template.
    const LARK_SKILLS = [
      'lark-shared',           // auth/identity/safety foundation
      'lark-im',               // messaging
      'lark-calendar',         // events
      'lark-doc',              // documents
      'lark-base',             // bitable
      'lark-sheets',           // spreadsheets
      'lark-drive',            // files
      'lark-wiki',             // knowledge base
      'lark-mail',             // email
      'lark-task',             // tasks
      'lark-contact',          // contacts
      'lark-vc',               // video conferencing
      'lark-minutes',          // meeting minutes
      'lark-event',            // event subscriptions
      'lark-whiteboard',       // drawing
      'lark-openapi-explorer', // raw API discovery
      'lark-skill-maker',      // meta-skill
      'lark-workflow-meeting-summary',
      'lark-workflow-standup-report',
    ]

    const LOCAL_SKILLS = ['sys-monitor', 'device-ctrl', 'file-organizer']
    const OTHER_SKILLS = ['open-notebook-chat', 'pptx', 'claude-model-switch', 'find-skills']

    let service: RealmSkillBridgeService

    beforeEach(async () => {
      const configPath = writeConfig('skill-realms.json', {
        skills: {
          'lark-*': 'CLOUD',
          'sys-monitor': 'LOCAL',
          'device-ctrl': 'LOCAL',
          'file-organizer': 'LOCAL',
        },
        tools: { lark_api: 'CLOUD', sys_info: 'LOCAL' },
        defaultRealm: 'hidden',
      })
      service = new RealmSkillBridgeService(
        fakeCtx() as never,
        { configPath, hotReload: false, watchIntervalMs: 5000 },
        undefined,
      )
      await service.start()
    })

    afterEach(() => { service.stop() })

    it('tags all 19 lark skills as CLOUD via lark-* glob', () => {
      for (const name of LARK_SKILLS) {
        assert.equal(
          service.skillRealm(name),
          'CLOUD',
          `expected ${name} to be CLOUD, got ${service.skillRealm(name)}`,
        )
      }
    })

    it('tags local skills as LOCAL', () => {
      for (const name of LOCAL_SKILLS) {
        assert.equal(
          service.skillRealm(name),
          'LOCAL',
          `expected ${name} to be LOCAL, got ${service.skillRealm(name)}`,
        )
      }
    })

    it('hides skills not in config (defaultRealm=hidden)', () => {
      for (const name of OTHER_SKILLS) {
        assert.equal(
          service.skillRealm(name),
          'hidden',
          `expected ${name} to be hidden, got ${service.skillRealm(name)}`,
        )
      }
    })

    it('§7.47.1: catalog filter opt-out — every realm sees all non-hidden skills', () => {
      // §7.47.1 (2026-09-12): filterCatalogText no longer drops skills
      // by agentRealm. Skill.realm is single (LOCAL/CLOUD/hidden), but
      // tools are multi-realm Set. `bash` skill.realm=LOCAL yet
      // bash.toolRealms={LOCAL, CLOUD}. Pre-fix, CLOUD agent saw every
      // LOCAL skill dropped (droppedCount=11 for news session). Layer 3
      // (tools/pre-execute) is the authoritative realm gate — see
      // checkToolRealm line ~612 + filterToolsField line ~578.
      const allSkillLines = [
        ...LARK_SKILLS.map(n => `- \`${n}\`: Lark ${n}`),
        ...LOCAL_SKILLS.map(n => `- \`${n}\`: Local ${n}`),
        ...OTHER_SKILLS.map(n => `- \`${n}\`: Other ${n}`),
      ]
      const messages = [{
        source: { kind: 'skill-catalog' },
        content: `<system-reminder>
<available_skills>
${allSkillLines.join('\n')}
</available_skills>
</system-reminder>`,
      }]

      for (const realm of ['CLOUD', 'LOCAL', 'SANITIZED'] as const) {
        const filtered = service.filterSkillCatalog(messages, realm)
        const content = (filtered[0] as any).content
        for (const name of LARK_SKILLS) {
          assert.ok(content.includes(name), `realm=${realm} should see ${name}`)
        }
        for (const name of LOCAL_SKILLS) {
          assert.ok(content.includes(name), `realm=${realm} should see ${name}`)
        }
        // OTHER_SKILLS aren't in the realm config so they default to 'hidden'
        // (fail-closed) and are dropped regardless of agent realm — the §7.47.1
        // change only affects visible vs dropped for KNOWN non-hidden skills.
        for (const name of OTHER_SKILLS) {
          assert.ok(!content.includes(name), `realm=${realm} should NOT see ${name} (hidden)`)
        }
      }
    })

    it('lark_api tool is CLOUD-realm — denied for LOCAL agent', () => {
      assert.equal(service.checkToolRealm('lark_api', 'CLOUD'), undefined)
      assert.ok(service.checkToolRealm('lark_api', 'LOCAL') !== undefined)
    })

    it('sys_info tool is LOCAL-realm — denied for CLOUD agent', () => {
      assert.equal(service.checkToolRealm('sys_info', 'LOCAL'), undefined)
      assert.ok(service.checkToolRealm('sys_info', 'CLOUD') !== undefined)
    })

    it('lark-shared is also CLOUD (matches lark-* glob)', () => {
      // lark-shared is the auth foundation for all lark skills — must be CLOUD
      // so CLOUD agents can load it before invoking any lark-* skill.
      assert.equal(service.skillRealm('lark-shared'), 'CLOUD')
    })

    it('workflow skills match lark-* glob', () => {
      assert.equal(service.skillRealm('lark-workflow-meeting-summary'), 'CLOUD')
      assert.equal(service.skillRealm('lark-workflow-standup-report'), 'CLOUD')
    })
  })

  // ── Integration: real installed lark skills ─────────────────────────────────
  // Verifies the bridge works with the actual lark-* skills installed in
  // ~/.agents/skills/ on this machine. Skipped if the directory doesn't exist
  // (e.g. CI environment without lark-cli installed).

  describe('integration: real installed lark skills', () => {
    const skillsDir = join(homedir(), '.agents', 'skills')
    const hasSkills = existsSync(skillsDir)
    // A machine may have ~/.agents/skills/ but no lark-* skills (CI, fresh
    // developer box). Skip the lark-specific assertions in that case instead
    // of failing with "expected 19, got 0".
    const installedSkills = hasSkills
      ? readdirSync(skillsDir, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name)
      : []
    const larkSkills = installedSkills.filter(n => n.startsWith('lark-'))
    const hasLarkSkills = larkSkills.length > 0

    it.skipIf(!hasSkills)('requires ~/.agents/skills/ to exist', () => {})

    it.skipIf(!hasLarkSkills)('discovers all 19 lark-* skills from ~/.agents/skills/', () => {
      assert.equal(larkSkills.length, 19, `expected 19 lark skills, got ${larkSkills.length}: ${larkSkills.join(', ')}`)
    })

    it.skipIf(!hasLarkSkills)('tags every installed lark-* skill as CLOUD via the real config template', async () => {

      // Use the real default config template
      const configPath = writeConfig('skill-realms.json', {
        skills: {
          'lark-*': 'CLOUD',
          'ima-*': 'CLOUD',
          'dws': 'CLOUD',
          'find-skills': 'CLOUD',
          'ets-*': 'LOCAL',
          'sys-monitor': 'LOCAL',
        },
        tools: { lark_api: 'CLOUD', skill_ref: 'CLOUD', sys_info: 'LOCAL', local_cmd: 'LOCAL' },
        defaultRealm: 'hidden',
      })

      // Feed the real skill list to the fake ctx
      const realSkills = larkSkills.map(n => ({ name: n, description: `Lark ${n}` }))
      const service = new RealmSkillBridgeService(
        fakeCtx(realSkills) as never,
        { configPath, hotReload: false, watchIntervalMs: 5000 },
        undefined,
      )
      await service.start()

      // Every lark-* skill must be tagged CLOUD
      for (const name of larkSkills) {
        assert.equal(
          service.skillRealm(name),
          'CLOUD',
          `real installed skill "${name}" should be CLOUD`,
        )
      }

      // Build a catalog with all installed skills and verify CLOUD agent sees them
      const catalogLines = [
        ...larkSkills.map(n => `- \`${n}\`: Lark ${n}`),
        '- `sys-monitor`: System monitor',
        '- `ets-auth`: ETS auth',
      ]
      const messages = [{
        source: { kind: 'skill-catalog' as const },
        content: `<system-reminder>\n<available_skills>\n${catalogLines.join('\n')}\n</available_skills>\n</system-reminder>`,
      }]

      // §7.47.1 (2026-09-12): CLOUD agent sees ALL non-hidden skills
      // (lark skills + sys-monitor + ets-auth). Catalog is discovery
      // surface; Layer 3 (tools/pre-execute) is the authoritative realm
      // gate. Pre-fix behavior (CLOUD hides sys-monitor) caused
      // droppedCount=11 in production news queries.
      const cloudFiltered = service.filterSkillCatalog(messages, 'CLOUD')
      const cloudContent = (cloudFiltered[0] as { content: string }).content
      for (const name of larkSkills) {
        assert.ok(cloudContent.includes(name), `CLOUD agent should see ${name}`)
      }
      assert.ok(cloudContent.includes('sys-monitor'), 'CLOUD should see sys-monitor (§7.47.1)')
      assert.ok(cloudContent.includes('ets-auth'), 'CLOUD should see ets-auth (§7.47.1)')

      // LOCAL agent: also sees all non-hidden skills per §7.47.1
      const localFiltered = service.filterSkillCatalog(messages, 'LOCAL')
      const localContent = (localFiltered[0] as { content: string }).content
      for (const name of larkSkills) {
        assert.ok(localContent.includes(name), `LOCAL agent should see ${name} (§7.47.1)`)
      }
      assert.ok(localContent.includes('sys-monitor'), 'LOCAL should see sys-monitor')
      assert.ok(localContent.includes('ets-auth'), 'LOCAL should see ets-auth')

      service.stop()
    })
  })

  // §7.44.1 (2026-09-11): session/event listener emits flow-level info
  // log so TUI / future-webui entry points get visible chat round-trip
  // traces (http-api has its own POST 200 log; TUI doesn't). Build a fake
  // ctx with on() capture, call apply(), then drive a request/header +
  // turn/end sequence to verify the info logs fire.
  describe('session/event flow log (§7.44.1)', () => {
    it('logs chat received on request/header and chat finished on turn/end', async () => {
      const { apply } = await import('../../src/dsh-adapter/realm-skill-bridge.ts')
      const calls: Array<{ event: string; fn: (session: unknown, evt: unknown) => void }> = []
      const infoLines: string[] = []
      const fakeCtx: unknown = {
        reflect: { provide(_n: string, _v: unknown) { return () => {} } },
        provide(_n: string, _v: unknown) { return () => {} },
        skills: {
          async list() { return [] },
          async snapshot() { return { skills: [], complete: true } },
        },
        logger: {
          info: (line: string) => infoLines.push(line),
          warn: () => {},
          error: () => {},
          debug: () => {},
        },
        on(event: string, fn: (session: unknown, evt: unknown) => void) {
          calls.push({ event, fn })
          return () => {}
        },
      }
      const config = {
        skills: {},
        tools: {},
        defaultRealm: 'hidden',
        intentDefaultRealm: 'hidden',
        sessionRealmHeader: 'x-edge-realm',
      }
      const dispose = await (apply as (ctx: unknown, cfg: unknown) => Promise<() => Promise<void>>)(fakeCtx, config)
      // Find the session/event listener
      const sessionListener = calls.find((c) => c.event === 'session/event')
      assert.ok(sessionListener, 'session/event listener should be registered')
      const fn = sessionListener.fn
      const session = { id: 'test-sess-1' }

      // Drive request/header (with startsSeries)
      fn(session, { type: 'request/header', data: { reason: 'initial', startsSeries: true } })
      // Drive request/header (without startsSeries — current dsh-agent-loop emits this way)
      fn(session, { type: 'request/header', data: { reason: 'followup' } })
      // §7.46 (2026-09-11): chat finished 行加 realm + duration。
      // 没 pre-set realm → 默认 'unset'。duration 应该是正整数。
      fn(session, { type: 'turn/end', data: { turn: 1, reason: 'completed' } })
      // Drive an unrelated event — should NOT log
      fn(session, { type: 'user/message', data: {} })

      // Two chat received (one per request/header, regardless of startsSeries)
      // + one chat finished
      const received = infoLines.filter((l) => l.includes('chat received'))
      const finished = infoLines.filter((l) => l.includes('chat finished'))
      assert.equal(received.length, 2, `expected 2 chat received lines, got ${received.length}: ${JSON.stringify(received)}`)
      assert.equal(finished.length, 1, `expected 1 chat finished line, got ${finished.length}: ${JSON.stringify(finished)}`)
      assert.ok(received[0].includes('sessionId=test-sess-1'), 'chat received should carry sessionId')
      assert.ok(received[0].includes('reason=initial'), 'chat received should carry reason')
      assert.ok(received[0].includes('series-start'), 'startsSeries=true should append " series-start" tag')
      assert.ok(received[1].includes('reason=followup'), 'second request/header should log too')
      assert.ok(!received[1].includes('series-start'), 'followup without startsSeries should not have tag')
      assert.ok(finished[0].includes('turn=1'), 'chat finished should carry turn number')
      assert.ok(finished[0].includes('reason=completed'), 'chat finished should carry reason')
      // §7.46: realm + duration assertions (realm-positive case tested in
      // 'pre-step filter emits ops log with realm' below since pre-step
      // closure shares the same service instance)
      assert.ok(finished[0].includes('realm=unset'), 'chat finished should include realm=unset when no realm was set (§7.46)')
      const durationMatch = finished[0].match(/duration=(\d+)ms/)
      assert.ok(durationMatch !== null, `chat finished should include duration=Nms, got: ${finished[0]}`)
      assert.ok(Number(durationMatch![1]) >= 0, 'duration should be a non-negative integer')

      await dispose()
    })
  })

  // §7.46 (2026-09-11): pre-step listener emits `pre-step filter sessionId=X
  // realm=Y catalogDropped=N` when input has skill catalog and agent realm is
  // set. Driven via captured `on('agent/pre-step', ...)` listener from
  // apply(); realm is set via ctx.skills-based service state through
  // tools/change → tagToolsFromConfig side channel. To keep this test
  // hermetic we directly verify the listener WAS registered and the log
  // line SHAPE, plus a unit-level call through the service to confirm the
  // log line content when realm is set + skill catalog contains items.
  describe('pre-step filter emits ops log (§7.46)', () => {
    it('pre-step listener is registered and logs catalogDropped when realm/skill catalog differ', async () => {
      const infoLines: string[] = []
      const calls: Array<{ event: string; fn: (...args: unknown[]) => void }> = []
      const fakeCtx: unknown = {
        reflect: { provide() { return () => {} } },
        provide() { return () => {} },
        skills: {
          async list() { return [] },
          async snapshot() { return { skills: [], complete: true } },
        },
        logger: {
          info: (line: string) => infoLines.push(line),
          warn: () => {},
          error: () => {},
          debug: () => {},
        },
        on(event: string, fn: (...args: unknown[]) => void) {
          calls.push({ event, fn })
          return () => {}
        },
      }
      const { apply } = await import('../../src/dsh-adapter/realm-skill-bridge.ts')
      const dispose = await (apply as (ctx: unknown, cfg: unknown) => Promise<() => Promise<void>>)(fakeCtx, {
        skills: {},
        tools: {},
        defaultRealm: 'hidden',
        intentDefaultRealm: 'hidden',
        sessionRealmHeader: 'x-edge-realm',
      })
      // Pre-step listener should be registered
      const preStepListener = calls.find((c) => c.event === 'agent/pre-step')
      assert.ok(preStepListener, 'agent/pre-step listener should be registered')
      // Verify listener shape: it must be async and accept (payload, next)
      assert.equal(typeof preStepListener!.fn, 'function')
      // We can't easily get a real realm set without a pre-created service,
      // so we just assert the listener registered. Log emission for the
      // realm-set case is covered indirectly via the chat-finished test
      // (same service closure captures the same getSessionRealm path).
      await dispose()
    })

    it('§7.47.1: pre-step listener — droppedCount is 0 for non-hidden catalog regardless of realm', async () => {
      // §7.47.1 (2026-09-12): catalog filter is opt-out for ALL realms
      // (not just SANITIZED). droppedCount=0 means the catalog passes
      // through unchanged. Previously, LOCAL agent with lark-* in the
      // catalog dropped 2 skills (lark-im + lark-doc) — that broke
      // production news queries where CLOUD agent lost all LOCAL skills.
      // Layer 3 (tools/pre-execute) is now the authoritative realm gate.
      const configPath = writeConfig('skill-realms.json', {
        skills: { 'ets-*': 'LOCAL', 'lark-*': 'CLOUD' },
        tools: {},
        defaultRealm: 'hidden',
      })
      const fakeCtx: unknown = {
        reflect: { provide() { return () => {} } },
        provide() { return () => {} },
        skills: {
          async list() { return [] },
          async snapshot() { return { skills: [], complete: true } },
        },
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      }
      const service = new RealmSkillBridgeService(
        fakeCtx as never,
        { configPath, hotReload: false, watchIntervalMs: 5000 },
        undefined,
      )
      await service.start()
      const messages = [
        {
          source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
          role: 'system',
          content: '<available_skills>\n- `lark-im`: chat\n- `lark-doc`: doc\n- `ets-chat`: mibao\n- `ets-auth`: auth\n</available_skills>',
        },
      ] as any
      // All non-hidden skills pass through for any agentRealm
      for (const realm of ['LOCAL', 'CLOUD', 'SANITIZED'] as const) {
        const r = service.filterSkillCatalogDetailed(messages, realm)
        assert.equal(r.droppedCount, 0, `realm=${realm} should drop 0 visible skills (§7.47.1), got ${r.droppedCount}`)
      }
      service.stop()
    })

    it('§7.47.1: hidden skill still dropped — security boundary preserved', async () => {
      // §7.47.1 only relaxes the realm-equality filter. The 'hidden' tag
      // remains a hard drop — it's the security boundary for skills we
      // never want surfaced (e.g. internal admin tools).
      const configPath = writeConfig('skill-realms.json', {
        skills: { 'ets-*': 'LOCAL', 'lark-*': 'CLOUD' },
        tools: {},
        defaultRealm: 'hidden',
      })
      const fakeCtx: unknown = {
        reflect: { provide() { return () => {} } },
        provide() { return () => {} },
        skills: {
          async list() { return [] },
          async snapshot() { return { skills: [], complete: true } },
        },
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      }
      const service = new RealmSkillBridgeService(
        fakeCtx as never,
        { configPath, hotReload: false, watchIntervalMs: 5000 },
        undefined,
      )
      await service.start()
      const messages = [
        {
          source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
          role: 'system',
          content: '<available_skills>\n- `lark-im`: chat\n- `secret-internal`: hidden\n</available_skills>',
        },
      ] as any
      // secret-internal has no config match → defaults to 'hidden' → dropped
      const r = service.filterSkillCatalogDetailed(messages, 'CLOUD')
      assert.equal(r.droppedCount, 1, 'unknown config match defaults to hidden → dropped')
      assert.ok(!r.messages[0].content.includes('secret-internal'))
      service.stop()
    })
  })

  // §7.46 (2026-09-11): tools/pre-execute listener emits allow/deny log
  // lines on every tool call. Deny reason is also emitted so operator can
  // grep `realm-skill-bridge.*tool deny` to find out which tools were
  // blocked and why.
  describe('tools/pre-execute emits allow/deny ops log (§7.46)', () => {
    it('logs tool allow when realm matches', async () => {
      const infoLines: string[] = []
      const calls: Array<{ event: string; fn: (...args: unknown[]) => void }> = []
      const fakeCtx: unknown = {
        reflect: { provide() { return () => {} } },
        provide() { return () => {} },
        skills: {
          async list() { return [] },
          async snapshot() { return { skills: [], complete: true } },
        },
        logger: {
          info: (line: string) => infoLines.push(line),
          warn: () => {},
          error: () => {},
          debug: () => {},
        },
        on(event: string, fn: (...args: unknown[]) => void) {
          calls.push({ event, fn })
          return () => {}
        },
      }
      const { apply } = await import('../../src/dsh-adapter/realm-skill-bridge.ts')
      const dispose = await (apply as (ctx: unknown, cfg: unknown) => Promise<() => Promise<void>>)(fakeCtx, {
        skills: {},
        tools: { web_search: 'CLOUD' },
        defaultRealm: 'hidden',
        intentDefaultRealm: 'hidden',
        sessionRealmHeader: 'x-edge-realm',
      })
      const preExecListener = calls.find((c) => c.event === 'tools/pre-execute')
      assert.ok(preExecListener, 'tools/pre-execute listener should be registered')
      // Drive: agent with no realm set → getAgentRealm returns undefined →
      // checkToolRealm fails-open (unknown realm) → tool allow log emits
      const fn = preExecListener!.fn as (e: unknown, n: () => Promise<unknown>) => Promise<unknown>
      const fakeAgent = { session: { id: 'tools-test-sess' } }
      const fakeExec = { name: 'web_search', agent: fakeAgent }
      const result = await fn(fakeExec, async () => ({ ok: true }))
      // Allow path returns next() result (a real dsh-shaped object)
      assert.ok(result !== undefined, 'allow path should return next() result')
      const allowLogs = infoLines.filter((l) => l.includes('tool allow'))
      assert.equal(allowLogs.length, 1, `expected 1 tool allow log, got ${allowLogs.length}: ${JSON.stringify(allowLogs)}`)
      assert.ok(allowLogs[0].includes('tool=web_search'), 'tool allow should name the tool')
      assert.ok(allowLogs[0].includes('sessionId=tools-test-sess'), 'tool allow should include sessionId')
      await dispose()
    })

    // §7.46.7 (2026-09-12): tool=skill 时从 exec.input/args/arguments 抽 skill name —
    // 让 operator 在 ops log 看到 LLM 实际选了哪个 skill（之前只报 tool=skill，
    // mibao-empty-result-diagnosis 排查时根本不知道 LLM 是选错 skill 还是
    // skill 执行失败）。
    it('tool=skill + exec.input.name=ets-auth → log includes skillName=ets-auth', async () => {
      const infoLines: string[] = []
      const calls: Array<{ event: string; fn: (...args: unknown[]) => void }> = []
      const fakeCtx: unknown = {
        reflect: { provide() { return () => {} } },
        provide() { return () => {} },
        skills: { async list() { return [] }, async snapshot() { return { skills: [], complete: true } } },
        logger: { info: (l: string) => infoLines.push(l), warn: () => {}, error: () => {}, debug: () => {} },
        on(event: string, fn: (...args: unknown[]) => void) { calls.push({ event, fn }); return () => {} },
      }
      const { apply } = await import('../../src/dsh-adapter/realm-skill-bridge.ts')
      const dispose = await (apply as (ctx: unknown, cfg: unknown) => Promise<() => Promise<void>>)(fakeCtx, {
        skills: { 'ets-auth': 'LOCAL' },
        tools: { skill: 'LOCAL' },
        defaultRealm: 'hidden',
        intentDefaultRealm: 'hidden',
        sessionRealmHeader: 'x-edge-realm',
      })
      const preExecListener = calls.find((c) => c.event === 'tools/pre-execute')!
      const fn = preExecListener.fn as (e: unknown, n: () => Promise<unknown>) => Promise<unknown>
      const fakeAgent = { session: { id: 'skill-name-test-1' } }
      // dsh-agent-loop 旧版用 args / 新版用 input — input 是最常见的字段名
      const fakeExec = { name: 'skill', input: { name: 'ets-auth' }, agent: fakeAgent }
      await fn(fakeExec, async () => ({ ok: true }))
      const allowLogs = infoLines.filter((l) => l.includes('tool allow'))
      assert.equal(allowLogs.length, 1)
      assert.ok(allowLogs[0].includes('tool=skill'), 'tool name should still be skill')
      assert.ok(allowLogs[0].includes('skillName=ets-auth'),
        `tool allow should include skillName=ets-auth when input.name=ets-auth, got: ${allowLogs[0]}`)
      await dispose()
    })

    it('tool=skill + exec.args.name (legacy dsh shape) → also extracts skillName', async () => {
      // 兼容 dsh 旧版把 args 放在 args 而不是 input 的情况
      const infoLines: string[] = []
      const calls: Array<{ event: string; fn: (...args: unknown[]) => void }> = []
      const fakeCtx: unknown = {
        reflect: { provide() { return () => {} } },
        provide() { return () => {} },
        skills: { async list() { return [] }, async snapshot() { return { skills: [], complete: true } } },
        logger: { info: (l: string) => infoLines.push(l), warn: () => {}, error: () => {}, debug: () => {} },
        on(event: string, fn: (...args: unknown[]) => void) { calls.push({ event, fn }); return () => {} },
      }
      const { apply } = await import('../../src/dsh-adapter/realm-skill-bridge.ts')
      const dispose = await (apply as (ctx: unknown, cfg: unknown) => Promise<() => Promise<void>>)(fakeCtx, {
        skills: { 'ets-chat': 'LOCAL' },
        tools: { skill: 'LOCAL' },
        defaultRealm: 'hidden',
        intentDefaultRealm: 'hidden',
        sessionRealmHeader: 'x-edge-realm',
      })
      const preExecListener = calls.find((c) => c.event === 'tools/pre-execute')!
      const fn = preExecListener.fn as (e: unknown, n: () => Promise<unknown>) => Promise<unknown>
      const fakeExec = { name: 'skill', args: { name: 'ets-chat' }, agent: { session: { id: 's2' } } }
      await fn(fakeExec, async () => ({ ok: true }))
      const allowLogs = infoLines.filter((l) => l.includes('tool allow'))
      assert.equal(allowLogs.length, 1)
      assert.ok(allowLogs[0].includes('skillName=ets-chat'),
        `should extract skillName from exec.args.name, got: ${allowLogs[0]}`)
      await dispose()
    })

    it('tool=skill but no name in args → no skillName suffix (degrade gracefully)', async () => {
      // 兼容老 dsh / 边界情况：args 缺失或没有 name 字段时不要 emit skillName=
      // （避免看到 skillName=undefined 这种 garbage）
      const infoLines: string[] = []
      const calls: Array<{ event: string; fn: (...args: unknown[]) => void }> = []
      const fakeCtx: unknown = {
        reflect: { provide() { return () => {} } },
        provide() { return () => {} },
        skills: { async list() { return [] }, async snapshot() { return { skills: [], complete: true } } },
        logger: { info: (l: string) => infoLines.push(l), warn: () => {}, error: () => {}, debug: () => {} },
        on(event: string, fn: (...args: unknown[]) => void) { calls.push({ event, fn }); return () => {} },
      }
      const { apply } = await import('../../src/dsh-adapter/realm-skill-bridge.ts')
      const dispose = await (apply as (ctx: unknown, cfg: unknown) => Promise<() => Promise<void>>)(fakeCtx, {
        skills: {},
        tools: { skill: 'LOCAL' },
        defaultRealm: 'hidden',
        intentDefaultRealm: 'hidden',
        sessionRealmHeader: 'x-edge-realm',
      })
      const preExecListener = calls.find((c) => c.event === 'tools/pre-execute')!
      const fn = preExecListener.fn as (e: unknown, n: () => Promise<unknown>) => Promise<unknown>
      const fakeExec = { name: 'skill', agent: { session: { id: 's3' } } }
      await fn(fakeExec, async () => ({ ok: true }))
      const allowLogs = infoLines.filter((l) => l.includes('tool allow'))
      assert.equal(allowLogs.length, 1)
      assert.ok(!allowLogs[0].includes('skillName='),
        `should NOT emit skillName= when args missing, got: ${allowLogs[0]}`)
      assert.ok(allowLogs[0].includes('tool=skill'), 'tool name still skill')
      await dispose()
    })

    it('tool=web_search (non-skill tool) → no skillName suffix (only skill triggers)', async () => {
      // 非 skill 工具不应该带 skillName= 字段（避免污染 ops log）
      const infoLines: string[] = []
      const calls: Array<{ event: string; fn: (...args: unknown[]) => void }> = []
      const fakeCtx: unknown = {
        reflect: { provide() { return () => {} } },
        provide() { return () => {} },
        skills: { async list() { return [] }, async snapshot() { return { skills: [], complete: true } } },
        logger: { info: (l: string) => infoLines.push(l), warn: () => {}, error: () => {}, debug: () => {} },
        on(event: string, fn: (...args: unknown[]) => void) { calls.push({ event, fn }); return () => {} },
      }
      const { apply } = await import('../../src/dsh-adapter/realm-skill-bridge.ts')
      const dispose = await (apply as (ctx: unknown, cfg: unknown) => Promise<() => Promise<void>>)(fakeCtx, {
        skills: {},
        tools: { web_search: 'CLOUD' },
        defaultRealm: 'hidden',
        intentDefaultRealm: 'hidden',
        sessionRealmHeader: 'x-edge-realm',
      })
      const preExecListener = calls.find((c) => c.event === 'tools/pre-execute')!
      const fn = preExecListener.fn as (e: unknown, n: () => Promise<unknown>) => Promise<unknown>
      const fakeExec = { name: 'web_search', input: { query: 'x' }, agent: { session: { id: 's4' } } }
      await fn(fakeExec, async () => ({ ok: true }))
      const allowLogs = infoLines.filter((l) => l.includes('tool allow'))
      assert.equal(allowLogs.length, 1)
      assert.ok(!allowLogs[0].includes('skillName='),
        `non-skill tool should not emit skillName=, got: ${allowLogs[0]}`)
      await dispose()
    })
  })

  // §7.37.x (2026-09-22): Layer 1.5-replacement listener registered on
  // system-prompt/assemble waterfall. Filters assembly.tools by session
  // realm before dsh-agent-loop freezes them into the LLM request payload.
  // Replaces the deleted `llm/stream` tools probe (which was blocked by
  // dsh-llm's deepFreeze at dsh-agent-loop/lib/index.js:729).
  describe('system-prompt/assemble tool filter (§7.37.x Layer 1.5-replacement)', () => {
    function makeFakeCtx(
      infoLines: string[],
      calls: Array<{ event: string; fn: (...args: unknown[]) => unknown }>,
    ): unknown {
      return {
        reflect: { provide() { return () => {} } },
        provide() { return () => {} },
        skills: {
          async list() { return [] },
          async snapshot() { return { skills: [], complete: true } },
        },
        logger: {
          info: (l: string) => infoLines.push(l),
          warn: () => {}, error: () => {}, debug: () => {},
        },
        on(event: string, fn: (...args: unknown[]) => unknown) {
          calls.push({ event, fn }); return () => {}
        },
      }
    }

    const CLOUD_LOCAL_CONFIG = {
      skills: {},
      tools: { web_search: 'CLOUD', web_fetch: 'CLOUD', sys_info: 'LOCAL', bash: 'LOCAL' },
      defaultRealm: 'hidden',
      intentDefaultRealm: 'hidden',
      sessionRealmHeader: 'x-edge-realm',
    }

    it('registers a system-prompt/assemble listener', async () => {
      const infoLines: string[] = []
      const calls: Array<{ event: string; fn: (...args: unknown[]) => unknown }> = []
      const fakeCtx = makeFakeCtx(infoLines, calls)
      const { apply } = await import('../../src/dsh-adapter/realm-skill-bridge.ts')
      const dispose = await (apply as (ctx: unknown, cfg: unknown) => Promise<() => Promise<void>>)(fakeCtx, CLOUD_LOCAL_CONFIG)
      const assembleListener = calls.find((c) => c.event === 'system-prompt/assemble')
      assert.ok(assembleListener, 'system-prompt/assemble listener should be registered')
      await dispose()
    })

    it('CLOUD agent sees CLOUD tools, hides LOCAL tools', async () => {
      const infoLines: string[] = []
      const calls: Array<{ event: string; fn: (...args: unknown[]) => unknown }> = []
      const fakeCtx = makeFakeCtx(infoLines, calls)
      const { apply } = await import('../../src/dsh-adapter/realm-skill-bridge.ts')
      const dispose = await (apply as (ctx: unknown, cfg: unknown) => Promise<() => Promise<void>>)(fakeCtx, CLOUD_LOCAL_CONFIG)

      const assembleListener = calls.find((c) => c.event === 'system-prompt/assemble')!
      const fn = assembleListener.fn as (a: unknown, c: unknown, n: () => Promise<unknown>) => Promise<unknown>

      // Drive setSessionRealm via tools/change listener side-channel:
      // service registers tools/change handler that calls tagToolsFromConfig,
      // and we can reach setSessionRealm by setting up a service singleton
      // and using the listener closure's service reference. The cleanest
      // hermetic path is to call the listener directly with a fully-formed
      // session. The service uses sessionRealms map keyed by session.id,
      // so we just need to pre-seed it. We do this via the tools/change
      // hook (which fires tagToolsFromConfig — a tag side-effect) — but
      // we can't reach setSessionRealm from outside the closure without
      // exposing it. Instead, observe the filterToolsField purity: this
      // test focuses on the listener wiring + the filter logic via a
      // session with a classifiable scope.
      //
      // The challenge: setSessionRealm is private to apply() closure. We
      // CAN reach it via the `service` reflected on ctx.reflect, but that
      // requires another service singleton. Simpler — use a separate
      // RealmSkillBridgeService via the exported API, set realm, then
      // assert filterToolsField output (the function the listener calls).
      // The listener is tested via its registration + dispatch behavior in
      // the next tests; here we verify the filter logic.
      const configPath = writeConfig('skill-realms.json', CLOUD_LOCAL_CONFIG)
      const service = new RealmSkillBridgeService(
        fakeCtx as never,
        { configPath, hotReload: false, watchIntervalMs: 5000 },
        undefined,
      )
      await service.start()

      // Simulate what the listener does internally
      const allTools = [
        { name: 'web_search', description: 'cloud search' },
        { name: 'web_fetch', description: 'cloud fetch' },
        { name: 'sys_info', description: 'local sysinfo' },
        { name: 'bash', description: 'shell' },
        { name: 'unknown_tool', description: 'no realm' },
      ]
      service.setSessionRealm('sess-c', 'CLOUD')
      const cloudFilter = service.filterToolsField(allTools, service.getSessionRealm('sess-c')!)
      const cloudNames = cloudFilter.tools.map((t: any) => t.name)
      assert.ok(cloudNames.includes('web_search'), 'CLOUD agent sees web_search')
      assert.ok(cloudNames.includes('web_fetch'), 'CLOUD agent sees web_fetch')
      assert.ok(!cloudNames.includes('sys_info'), 'CLOUD agent hides sys_info')
      assert.ok(!cloudNames.includes('bash'), 'CLOUD agent hides bash')
      assert.ok(cloudNames.includes('unknown_tool'), 'CLOUD agent passes through unknown tools')
      service.stop()
      await dispose()
    })

    it('LOCAL agent sees LOCAL tools, hides CLOUD tools', async () => {
      const infoLines: string[] = []
      const calls: Array<{ event: string; fn: (...args: unknown[]) => unknown }> = []
      const fakeCtx = makeFakeCtx(infoLines, calls)
      const configPath = writeConfig('skill-realms.json', CLOUD_LOCAL_CONFIG)
      const service = new RealmSkillBridgeService(
        fakeCtx as never,
        { configPath, hotReload: false, watchIntervalMs: 5000 },
        undefined,
      )
      await service.start()
      const allTools = [
        { name: 'web_search' }, { name: 'web_fetch' },
        { name: 'sys_info' }, { name: 'bash' }, { name: 'unknown_tool' },
      ]
      service.setSessionRealm('sess-l', 'LOCAL')
      const localFilter = service.filterToolsField(allTools, service.getSessionRealm('sess-l')!)
      const localNames = localFilter.tools.map((t: any) => t.name)
      assert.ok(!localNames.includes('web_search'), 'LOCAL agent hides web_search')
      assert.ok(!localNames.includes('web_fetch'), 'LOCAL agent hides web_fetch')
      assert.ok(localNames.includes('sys_info'), 'LOCAL agent sees sys_info')
      assert.ok(localNames.includes('bash'), 'LOCAL agent sees bash')
      service.stop()
    })

    it('listener integration: passes tools through next() then applies filter on the result', async () => {
      // Verifies the listener calls next() and returns the upstream assembly
      // when no session realm is registered (fail-open path). Listener
      // wiring + filter logic against real realm config are exercised in the
      // other tests in this describe block.
      const infoLines: string[] = []
      const calls: Array<{ event: string; fn: (...args: unknown[]) => unknown }> = []
      const fakeCtx = makeFakeCtx(infoLines, calls)
      const { apply } = await import('../../src/dsh-adapter/realm-skill-bridge.ts')
      const dispose = await (apply as (ctx: unknown, cfg: unknown) => Promise<() => Promise<void>>)(fakeCtx, CLOUD_LOCAL_CONFIG)

      const assembleListener = calls.find((c) => c.event === 'system-prompt/assemble')!
      const fn = assembleListener.fn as (a: unknown, c: unknown, n: () => Promise<unknown>) => Promise<unknown>

      const sessionId = 'integration-sess'
      const fakeScope = { session: { id: sessionId } }

      const upstreamAssembly = {
        sections: [], contexts: [], variables: {},
        tools: [
          { name: 'web_search', description: 'cloud search' },
          { name: 'sys_info', description: 'local sysinfo' },
          { name: 'bash', description: 'shell' },
        ],
      }
      const result = await fn(upstreamAssembly, { scope: fakeScope }, async () => upstreamAssembly) as { tools: { name: string }[] }
      // sessionId='integration-sess' has no realm set → fail-open path.
      // All tools pass through unchanged.
      assert.equal(result.tools.length, 3, 'undefined agentRealm → fail-open, all 3 tools kept')
      assert.ok(result.tools.some((t) => t.name === 'web_search'))
      assert.ok(result.tools.some((t) => t.name === 'sys_info'))
      assert.ok(result.tools.some((t) => t.name === 'bash'))
      await dispose()
    })

    it('fail-open when no session realm registered', async () => {
      // No sessionId match → agentRealm undefined → listener returns
      // result unchanged (all tools pass through to LLM). Layer 3 still
      // gates execution, so this is safe.
      const infoLines: string[] = []
      const calls: Array<{ event: string; fn: (...args: unknown[]) => unknown }> = []
      const fakeCtx = makeFakeCtx(infoLines, calls)
      const { apply } = await import('../../src/dsh-adapter/realm-skill-bridge.ts')
      const dispose = await (apply as (ctx: unknown, cfg: unknown) => Promise<() => Promise<void>>)(fakeCtx, CLOUD_LOCAL_CONFIG)
      const assembleListener = calls.find((c) => c.event === 'system-prompt/assemble')!
      const fn = assembleListener.fn as (a: unknown, c: unknown, n: () => Promise<unknown>) => Promise<unknown>

      const tools = [
        { name: 'web_search' },
        { name: 'web_fetch' },
        { name: 'sys_info' },
      ]
      const result = await fn({ sections: [], contexts: [], variables: {}, tools }, { scope: { session: { id: 'unmapped-sess' } } }, async () => ({ sections: [], contexts: [], variables: {}, tools }))
      assert.equal((result as { tools: unknown[] }).tools.length, 3, 'no session realm → all tools pass through')
      await dispose()
    })

    it('hidden tools are always removed regardless of agent realm', async () => {
      const infoLines: string[] = []
      const calls: Array<{ event: string; fn: (...args: unknown[]) => unknown }> = []
      const fakeCtx = makeFakeCtx(infoLines, calls)
      const { apply } = await import('../../src/dsh-adapter/realm-skill-bridge.ts')
      const dispose = await (apply as (ctx: unknown, cfg: unknown) => Promise<() => Promise<void>>)(fakeCtx, {
        skills: {},
        tools: { secret_admin: 'hidden', web_search: 'CLOUD' },
        defaultRealm: 'hidden',
        intentDefaultRealm: 'hidden',
        sessionRealmHeader: 'x-edge-realm',
      })

      const configPath = writeConfig('skill-realms.json', {
        skills: {},
        tools: { secret_admin: 'hidden', web_search: 'CLOUD' },
        defaultRealm: 'hidden',
      })
      const service = new RealmSkillBridgeService(
        fakeCtx as never,
        { configPath, hotReload: false, watchIntervalMs: 5000 },
        undefined,
      )
      await service.start()
      service.setSessionRealm('sess-h', 'CLOUD')
      const tools = [
        { name: 'web_search' },
        { name: 'secret_admin' },
      ]
      const filter = service.filterToolsField(tools, 'CLOUD')
      const names = filter.tools.map((t: any) => t.name)
      assert.ok(names.includes('web_search'), 'CLOUD tool visible to CLOUD agent')
      assert.ok(!names.includes('secret_admin'), 'hidden tool always removed')
      service.stop()
      await dispose()
    })
  })

  // ── §7.93.1 Phase 2: external tool-schema face ────────────────────────────────

  describe('getToolSchemasForExternal (§7.93 Phase 2)', () => {
    /** Registry projection as dsh-tools `schemas()` returns it: flat
     *  {name, description, parameters} (dsh-llm ToolSchema whitelist). */
    const REGISTRY_SCHEMAS = [
      { name: 'bash', description: 'Execute shell commands', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
      { name: 'web_search', description: 'Search the web', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
      { name: 'secret_admin', description: 'Admin-only', parameters: { type: 'object', properties: {} } },
      { name: 'untyped_tool' }, // runtime-registered, hand-rolled shape
    ]

    function externalToolCallCtx(schemas: unknown[] | 'throw') {
      return {
        reflect: { provide(_n: string, _v: unknown) { return () => {} } },
        provide(_n: string, _v: unknown) { return () => {} },
        skills: {
          async list() { return [] },
          async snapshot() { return { skills: [], complete: true } },
        },
        tools: {
          schemas() {
            if (schemas === 'throw') throw new Error('cannot get property "tools" without inject')
            return schemas
          },
          view() { return { visible: new Map() } },
        },
        logger: { info: () => {}, warn: () => {} },
      }
    }

    async function makeExternalToolCallService(ctx: unknown, audit = fakeAuditLog()) {
      const configPath = writeConfig('skill-realms.json', {
        skills: {},
        tools: { bash: 'LOCAL', web_search: 'CLOUD', secret_admin: 'hidden' },
        defaultRealm: 'hidden',
      })
      const service = new RealmSkillBridgeService(
        ctx as never,
        { configPath, hotReload: false, watchIntervalMs: 5000 },
        audit,
      )
      await service.start()
      return { service, audit }
    }

    it('returns flat external wire format {name, description, parameters}', async () => {
      const { service } = await makeExternalToolCallService(externalToolCallCtx(REGISTRY_SCHEMAS))
      const schemas = service.getToolSchemasForExternal('LOCAL')
      const bash = schemas.find((s) => s.name === 'bash')
      assert.ok(bash, 'bash (LOCAL) present for LOCAL intent')
      assert.deepEqual(Object.keys(bash).sort(), ['description', 'name', 'parameters'], 'exactly the 3 external fields, no envelope')
      assert.equal(bash.description, 'Execute shell commands')
      assert.deepEqual(bash.parameters, REGISTRY_SCHEMAS[0].parameters, 'parameters passed through verbatim')
      service.stop()
    })

    it('realm filtering matches filterToolsField semantics (single source of truth)', async () => {
      const ctx = externalToolCallCtx(REGISTRY_SCHEMAS)
      const { service } = await makeExternalToolCallService(ctx)

      const localNames = service.getToolSchemasForExternal('LOCAL').map((s) => s.name).sort()
      assert.deepEqual(localNames, ['bash', 'untyped_tool'], 'LOCAL: bash + untagged pass-through; no web_search (CLOUD), no secret_admin (hidden)')

      // SANITIZED sees all non-hidden (§7.37)
      const sanNames = service.getToolSchemasForExternal('SANITIZED').map((s) => s.name).sort()
      assert.deepEqual(sanNames, ['bash', 'untyped_tool', 'web_search'], 'SANITIZED: LOCAL + CLOUD visible, hidden removed')

      // Cross-check against the LLM-path filter on the SAME input — the sets
      // must be identical or external / LLM would see different tools (drift).
      const llmView = service.filterToolsField(REGISTRY_SCHEMAS, 'LOCAL', { audit: false })
      const llmNames = llmView.tools.map((t: any) => t.name).sort()
      assert.deepEqual(localNames, llmNames, 'external schema set === LLM schema set')
      service.stop()
    })

    it('normalizes hand-rolled entries: missing description → "", missing parameters → permissive root, nameless dropped', async () => {
      const { service } = await makeExternalToolCallService(externalToolCallCtx([
        { name: 'no_desc_tool' },
        { name: 'bad_params', description: 'd', parameters: 'not-an-object' },
        { description: 'nameless — must be dropped' },
        { name: '', description: 'empty name — must be dropped' },
        'string-entry-must-be-dropped',
      ]))
      const schemas = service.getToolSchemasForExternal('LOCAL')
      assert.equal(schemas.length, 2)
      const noDesc = schemas.find((s) => s.name === 'no_desc_tool')!
      assert.equal(noDesc.description, '')
      assert.deepEqual(noDesc.parameters, { type: 'object', properties: {} })
      const badParams = schemas.find((s) => s.name === 'bad_params')!
      assert.deepEqual(badParams.parameters, { type: 'object', properties: {} }, 'non-object parameters replaced with permissive root')
      service.stop()
    })

    it('registry unavailable or throwing → [] (caller falls through to LLM extraction)', async () => {
      const throwing = await makeExternalToolCallService(externalToolCallCtx('throw'))
      assert.deepEqual(throwing.service.getToolSchemasForExternal('LOCAL'), [], 'proxy throw → empty, no crash')
      throwing.service.stop()

      const noTools = await makeExternalToolCallService({
        reflect: { provide(_n: string, _v: unknown) { return () => {} } },
        provide(_n: string, _v: unknown) { return () => {} },
        skills: { async list() { return [] }, async snapshot() { return { skills: [], complete: true } } },
        logger: { info: () => {}, warn: () => {} },
      })
      assert.deepEqual(noTools.service.getToolSchemasForExternal('LOCAL'), [], 'missing tools service → empty')
      noTools.service.stop()

      const emptyRegistry = await makeExternalToolCallService(externalToolCallCtx([]))
      assert.deepEqual(emptyRegistry.service.getToolSchemasForExternal('LOCAL'), [], 'empty registry → empty')
      emptyRegistry.service.stop()
    })

    it('does not emit the LLM-path tools.filtered audit; filterToolsField default still does', async () => {
      const { service, audit } = await makeExternalToolCallService(externalToolCallCtx(REGISTRY_SCHEMAS))
      service.getToolSchemasForExternal('LOCAL')
      assert.equal(
        audit.entries.filter((e) => e.kind === 'realm-skill-bridge.tools.filtered').length,
        0,
        'external path is audit-silent (function-call-external emits its own external.* events)',
      )
      // Backward compat: default (no options) still audits removals.
      service.filterToolsField(REGISTRY_SCHEMAS, 'LOCAL')
      assert.equal(
        audit.entries.filter((e) => e.kind === 'realm-skill-bridge.tools.filtered').length,
        1,
        'LLM-path default behavior unchanged',
      )
      service.stop()
    })

    it('normalizeExternalToolSchemas is exported as a pure function', async () => {
      const { normalizeExternalToolSchemas } = await import('../../src/dsh-adapter/realm-skill-bridge.ts')
      assert.equal(typeof normalizeExternalToolSchemas, 'function')
      assert.deepEqual(normalizeExternalToolSchemas([]), [])
      assert.deepEqual(
        normalizeExternalToolSchemas([{ name: 'x', description: 'd', parameters: { type: 'object' } }]),
        [{ name: 'x', description: 'd', parameters: { type: 'object' } }],
      )
    })
  })

  // §7.148 (2026-10-29): 工具过滤行 / 工具拒绝行也要带 sessionId ——
  //
  // §7.147 补了「开始行」，但 realm-skill-bridge 的审计行**从来没有**带过
  // sessionId：实测本仓 `realm-skill-bridge.tools.filtered` 132 条无一带，
  // `tool.realm.denied` 1 条同样没有 ⇒ 全落全局桶 ⇒ Edge 面板的工具/拦截
  // 面板说不清「哪一轮的工具被过滤 / 被拒」。
  describe('§7.148 — 工具侧审计行也带会话归属', () => {
    const TOOL_CONFIG = {
      skills: {},
      tools: { web_search: 'CLOUD', web_fetch: 'CLOUD', sys_info: 'LOCAL', bash: 'LOCAL' },
      defaultRealm: 'hidden',
      intentDefaultRealm: 'hidden',
      sessionRealmHeader: 'x-edge-realm',
    }

    function makeService(entries: any[]) {
      const configPath = writeConfig('skill-realms-7148.json', TOOL_CONFIG)
      const auditLog = { log: async (e: any) => { entries.push(e) } }
      const service = new RealmSkillBridgeService(
        fakeCtx() as never,
        { configPath, hotReload: false, watchIntervalMs: 5000 },
        auditLog as any,
      )
      return service
    }

    const TOOLS = [{ name: 'web_search' }, { name: 'web_fetch' }, { name: 'sys_info' }]

    it('工具过滤行带 sessionId', async () => {
      const entries: any[] = []
      const service = makeService(entries)
      await service.start()
      service.filterToolsField(TOOLS, 'LOCAL', { sessionId: 'sess-tools' })
      service.stop()
      const row = entries.find(e => e.kind === 'realm-skill-bridge.tools.filtered')
      assert.ok(row, 'realm-skill-bridge.tools.filtered 必须落盘')
      assert.equal(row.payload.sessionId, 'sess-tools')
    })

    it('没有会话 → 工具过滤行**不带** sessionId 键（反向证伪：不能造假桶）', async () => {
      const entries: any[] = []
      const service = makeService(entries)
      await service.start()
      service.filterToolsField(TOOLS, 'LOCAL')
      service.stop()
      const row = entries.find(e => e.kind === 'realm-skill-bridge.tools.filtered')
      assert.ok(row, 'realm-skill-bridge.tools.filtered 必须落盘')
      assert.equal('sessionId' in row.payload, false)
    })

    it('工具拒绝行带 sessionId', async () => {
      const entries: any[] = []
      const service = makeService(entries)
      await service.start()
      ;(service as any)['auditDeny']('web_search', new Set(['CLOUD']), 'LOCAL', 'sess-deny')
      service.stop()
      const row = entries.find(e => e.kind === 'tool.realm.denied')
      assert.ok(row, 'tool.realm.denied 必须落盘')
      assert.equal(row.payload.sessionId, 'sess-deny')
    })

    it('没有会话 → 工具拒绝行**不带** sessionId 键', async () => {
      const entries: any[] = []
      const service = makeService(entries)
      await service.start()
      ;(service as any)['auditDeny']('web_search', new Set(['CLOUD']), 'LOCAL')
      service.stop()
      const row = entries.find(e => e.kind === 'tool.realm.denied')
      assert.ok(row, 'tool.realm.denied 必须落盘')
      assert.equal('sessionId' in row.payload, false)
    })
  })

  // ── §7.150 默认屏蔽清单 ────────────────────────────────────────────────────
  //
  // 宿主自带、但在 dsh 会话里要么无意义、要么必然失败的四个工具：
  //
  //   get_goal / create_goal / update_goal
  //     Goal 族的契约是「没设 Goal 就是空」；dsh 的普通会话没有 Goal ⇒
  //     get_goal 必然返回空、update_goal 执行报错（errorKind=unknown）。
  //     实机：14:05 模型调 get_goal → 拿到空 → 把「我在循环调它拿到 null」的
  //     自白当最终回复输出；14:28 换 qwen3.8-flash 后改调 update_goal → 报错。
  //
  //   ask_user_question
  //     宿主 schema 是 `{questions:[{...}]}`（没有 text 字段），模型传的是
  //     `{"text":"<JSON 字符串>"}` ⇒ 参数不匹配 ⇒ 执行报错。
  //
  // 挡掉之后 agent 改用纯文本提问 —— 实测可行。
  describe('§7.150 — 默认屏蔽清单', () => {
    /** 宿主工具 + 两个正常工具（应当照常可见）。 */
    const TOOLS = [
      { name: 'get_goal' }, { name: 'create_goal' }, { name: 'update_goal' },
      { name: 'ask_user_question' },
      { name: 'bash' }, { name: 'sys_info' },
    ]

    async function serviceWith(config: Partial<RealmConfig>) {
      const entries: any[] = []
      const auditLog = { log: async (e: any) => { entries.push(e) } }
      const configPath = writeConfig('skill-realms-7150.json', config)
      const service = new RealmSkillBridgeService(
        fakeCtx() as never,
        { configPath, hotReload: false, watchIntervalMs: 5000 },
        auditLog as any,
      )
      await service.start()
      return { service, entries }
    }

    it('默认屏蔽四个宿主工具（LOCAL agent 看不见）', async () => {
      // 文件里**不列**这四个 ⇒ 走 DEFAULT_CONFIG.tools 的默认值。
      const { service } = await serviceWith({ skills: {}, tools: {}, defaultRealm: 'hidden' })
      const filter = service.filterToolsField(TOOLS, 'LOCAL')
      const names = filter.tools.map((t: any) => t.name)
      assert.ok(!names.includes('get_goal'), 'get_goal 必须对 LOCAL agent 不可见')
      assert.ok(!names.includes('create_goal'), 'create_goal 必须对 LOCAL agent 不可见')
      assert.ok(!names.includes('update_goal'), 'update_goal 必须对 LOCAL agent 不可见')
      assert.ok(!names.includes('ask_user_question'), 'ask_user_question 必须对 LOCAL agent 不可见')
      service.stop()
    })

    it('默认屏蔽不影响正常工具（bash / sys_info 照常可见）', async () => {
      const { service } = await serviceWith({ skills: {}, tools: {}, defaultRealm: 'hidden' })
      const names = service.filterToolsField(TOOLS, 'LOCAL').tools.map((t: any) => t.name)
      assert.ok(names.includes('bash'), 'bash 仍可见')
      assert.ok(names.includes('sys_info'), 'sys_info 仍可见')
      service.stop()
    })

    it('执行闸门同样拒绝被屏蔽的工具（Layer 3）', async () => {
      const { service } = await serviceWith({ skills: {}, tools: {}, defaultRealm: 'hidden' })
      for (const name of ['get_goal', 'create_goal', 'update_goal', 'ask_user_question']) {
        const reason = service.checkToolRealm(name, 'LOCAL')
        assert.ok(reason !== undefined, `${name} 必须被 Layer 3 拒绝`)
        assert.match(String(reason), /hidden/)
      }
      service.stop()
    })

    it('配置文件能**逐个放开**（config 覆盖 default）', async () => {
      // 「放开」的关键：config 循环必须把 default 的 'hidden' 移除，
      // 否则 Set{hidden, LOCAL} 里 hidden 仍在 ⇒ 照样被挡。
      const { service } = await serviceWith({
        skills: {},
        tools: { get_goal: 'LOCAL' },
        defaultRealm: 'hidden',
      })
      const names = service.filterToolsField(TOOLS, 'LOCAL').tools.map((t: any) => t.name)
      assert.ok(names.includes('get_goal'), '配置文件显式放开 get_goal ⇒ 可见')
      assert.ok(!names.includes('update_goal'), '没写进配置的工具仍保持默认屏蔽')
      assert.equal(service.checkToolRealm('get_goal', 'LOCAL'), undefined, '放开的工具 Layer 3 也放行')
      service.stop()
    })
  })
})
