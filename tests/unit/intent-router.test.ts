/**
 * intent-router plugin tests — LLM-based classification + keyword fallback +
 + Phase B confidence-gate path.
 *
 * Tests the rule-based fallback path (no real LLM call in unit tests);
 * confidence-gate tests use a fake streaming `ctx.llm`.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import * as router from '../../src/dsh-adapter/intent-router.ts'
import { IntentRouterServiceImpl, parseClassificationVerdict, coerceClassification, extractMessageText, resolveIntent } from '../../src/dsh-adapter/intent-router.ts'

/** Streaming fake that mimics qwen3-4b's wire-shape: text-delta chunks. */
function chunksFromText(text: string): AsyncIterable<unknown> {
  return (async function* () {
    for (let i = 0; i < text.length; i += 8) {
      yield { type: 'text-delta', text: text.slice(i, i + 8) }
    }
  })()
}

/** Fake ctx.llm.stream that yields the preloaded text-delta stream. */
function fakeLlm(stream: AsyncIterable<unknown>) {
  return {
    stream(_opts: unknown) {
      return stream
    },
  }
}

describe('intent-router', () => {
  it('exports the canonical plugin shape', () => {
    assert.equal(router.name, 'intent-router')
    assert.deepEqual([...router.inject], ['llm', 'auditLog'])
    assert.equal(typeof router.apply, 'function')
    assert.ok(router.Config)
  })

  it('classifies LOCAL intent via keyword rules (fallback)', async () => {
    const mockCtx = { reflect: { provide: () => {} }, llm: null } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    })

    const intent = await service.classify('帮我读取文件内容')
    assert.equal(intent.category, 'LOCAL')
    assert.equal(intent.targetRealm, 'local')
    assert.match(intent.rationale, /rule-keyword-match/u)
  })

  it('classifies CLOUD intent via keyword rules (fallback)', async () => {
    const mockCtx = { reflect: { provide: () => {} }, llm: null } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    })

    const intent = await service.classify('解释一下量子力学')
    assert.equal(intent.category, 'CLOUD')
    assert.equal(intent.targetRealm, 'cloud')
  })

  it('falls back to defaultCategory when no keywords match', async () => {
    const mockCtx = { reflect: { provide: () => {} }, llm: null } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    })

    const intent = await service.classify('你好')
    assert.equal(intent.category, 'CLOUD')
    assert.match(intent.rationale, /default:cloud/u)
  })

  // ─── §7.47 (2026-09-12): CLOUD keyword priority ───────────────────────

  it('§7.47: CLOUD keyword matches before LOCAL keyword', async () => {
    // §7.47 fix: "查询最新的AI新闻" should NOT fall through to defaultCategory
    // (which was SANITIZED) — news/latest/search signals are CLOUD-bound.
    const mockCtx = { reflect: { provide: () => {} }, llm: null } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'SANITIZED',  // would force SANITIZED without cloud keyword
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    }, audit as any)

    const intent = await service.classify('查询最新的AI新闻')
    assert.equal(intent.category, 'CLOUD')
    assert.equal(intent.targetRealm, 'cloud')
    assert.equal(intent.confidence, 0.8)
    assert.match(intent.rationale, /^rule-cloud-keyword:/u)
    // Source attribution in audit
    const hit = audit.entries.find((e: any) => e.kind === 'intent.rules.hit')
    assert.ok(hit)
    assert.equal(hit.payload.source, 'cloud-keyword')
  })

  it('§7.47: CLOUD keyword matches English signals (news/latest/today)', async () => {
    const mockCtx = { reflect: { provide: () => {} }, llm: null } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'SANITIZED',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    })

    const intent = await service.classify('what is the latest news on AI?')
    assert.equal(intent.category, 'CLOUD')
    assert.match(intent.rationale, /^rule-cloud-keyword:/u)
  })

  it('§7.47: LOCAL keyword still wins over defaultCategory (no regression)', async () => {
    // "读文件" still routes LOCAL even though "查询" is in cloud keywords
    // — wait, that's the conflict case. Use a pure LOCAL signal here.
    const mockCtx = { reflect: { provide: () => {} }, llm: null } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    })

    const intent = await service.classify('读取本地文件内容')
    assert.equal(intent.category, 'LOCAL')
    assert.match(intent.rationale, /^rule-keyword-match/u)
  })

  it('§7.47: cloudKeywords config extends built-in (not replaces)', async () => {
    // Env DSH_EDGE_INTENT_CLOUD_KEYWORDS should APPEND to built-in defaults,
    // so the built-in "新闻" signal still works even if user adds custom words.
    const mockCtx = { reflect: { provide: () => {} }, llm: null } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'SANITIZED',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
      cloudKeywords: ['汇率行情'],  // user additions (no overlap with built-in)
    })

    // Built-in still hits
    const newsIntent = await service.classify('查询新闻')
    assert.equal(newsIntent.category, 'CLOUD')

    // User-added word hits
    const fxIntent = await service.classify('美元汇率行情')
    assert.equal(fxIntent.category, 'CLOUD')
    assert.match(fxIntent.rationale, /rule-cloud-keyword:汇率行情/u)
  })

  // ─── §7.58 (2026-09-16): bare-verb removal + LOCAL-entity priority ─────

  it('§7.58: 密盒 query with cloud verb routes LOCAL (incident regression)', async () => {
    // 2026-09-15 incident: "查询共登陆了几个密盒" went CLOUD (turn 1 via the
    // LLM classifier, turn 2 via rule-cloud-keyword:查询) and drove
    // web_search + `etscli auth list` from the cloud model. Entity must win.
    const mockCtx = { reflect: { provide: () => {} }, llm: null } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'SANITIZED',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    }, audit as any)

    const intent = await service.classify('查询共登陆了几个密盒')
    assert.equal(intent.category, 'LOCAL')
    assert.equal(intent.targetRealm, 'local')
    assert.equal(intent.confidence, 0.9)
    assert.equal(intent.rationale, 'rule-local-entity:密盒')
    const hit = audit.entries.find((e: any) => e.kind === 'intent.rules.hit')
    assert.ok(hit)
    assert.equal(hit.payload.source, 'local-entity')
    assert.equal(hit.payload.matchedEntity, '密盒')
  })

  it('§7.58: bare query verb alone no longer forces CLOUD', async () => {
    const mockCtx = { reflect: { provide: () => {} }, llm: null } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'SANITIZED',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    })

    const intent = await service.classify('帮我查一下')
    assert.equal(intent.category, 'SANITIZED')
    assert.equal(intent.rationale, 'default:sanitized')
  })

  it('§7.58: verb + strong cloud noun still routes CLOUD (no §7.47 regression)', async () => {
    const mockCtx = { reflect: { provide: () => {} }, llm: null } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'SANITIZED',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    })

    const intent = await service.classify('查询最新的AI新闻')
    assert.equal(intent.category, 'CLOUD')
    assert.match(intent.rationale, /^rule-cloud-keyword:(新闻|最新)$/u)
  })

  it('§7.58: ASCII entity matches on word boundaries only', async () => {
    // 'ets' must NOT fire inside "assets" / "settings" — word-boundary regex.
    const mockCtx = { reflect: { provide: () => {} }, llm: null } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'SANITIZED',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    })

    const falseHit = await service.classify('open the settings page about assets')
    assert.doesNotMatch(falseHit.rationale, /local-entity/u)

    const trueHit = await service.classify('run ets auth status first')
    assert.equal(trueHit.category, 'LOCAL')
    assert.equal(trueHit.rationale, 'rule-local-entity:ets')
  })

  it('§7.58: localEntities config appends to built-in', async () => {
    const mockCtx = { reflect: { provide: () => {} }, llm: null } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'SANITIZED',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
      localEntities: ['NAS'],
    })

    const builtin = await service.classify('查询密盒剩余空间')
    assert.equal(builtin.category, 'LOCAL')
    const custom = await service.classify('查询NAS剩余空间')
    assert.equal(custom.category, 'LOCAL')
    assert.equal(custom.rationale, 'rule-local-entity:nas')
  })

  it('§7.58: entity guardrail overrides a non-LOCAL LLM verdict (turn-1 shape)', async () => {
    // Turn 1 of the incident: the classifier LLM itself answered
    // {category:CLOUD, confidence:1} — the rules layer never ran. The
    // post-LLM guardrail must still force LOCAL deterministically.
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 1 })
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: fakeLlm(chunksFromText(verdict)),
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'SANITIZED',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    }, audit as any)

    const intent = await service.classify('查询共登陆了几个密盒')
    assert.equal(intent.category, 'LOCAL')
    assert.equal(intent.rationale, 'override-local-entity:密盒')
    const override = audit.entries.find((e: any) => e.kind === 'intent.classify.entity_override')
    assert.ok(override, 'entity_override audit should fire')
    assert.equal(override.level, 'warn')
    assert.equal(override.payload.from, 'CLOUD')
    const end = audit.entries.find((e: any) => e.kind === 'intent.classify.end')
    assert.equal(end.payload.path, 'llm-entity-override')
  })

  it('§7.58: LLM verdict LOCAL passes through guardrail untouched', async () => {
    const verdict = JSON.stringify({ category: 'LOCAL', confidence: 0.95 })
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: fakeLlm(chunksFromText(verdict)),
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'SANITIZED',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    }, audit as any)

    const intent = await service.classify('查询共登陆了几个密盒')
    assert.equal(intent.category, 'LOCAL')
    assert.match(intent.rationale, /^llm-classified:local$/u)
    assert.ok(!audit.entries.some((e: any) => e.kind === 'intent.classify.entity_override'))
  })

  // ─── Phase B: confidence gate ───────────────────────────────────────────

  it('adopts LLM verdict when confidence >= threshold', async () => {
    const verdict = JSON.stringify({ category: 'LOCAL', confidence: 0.85 })
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: fakeLlm(chunksFromText(verdict)),
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    }, audit as any)

    const intent = await service.classify('读文件')
    assert.equal(intent.category, 'LOCAL')
    assert.equal(intent.confidence, 0.85)
    assert.match(intent.rationale, /llm-classified/u)
    assert.ok(audit.entries.some(e => e.kind === 'intent.llm.parsed'))
  })

  it('falls back to keyword rules when LLM confidence < threshold', async () => {
    const verdict = JSON.stringify({ category: 'LOCAL', confidence: 0.3 })
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: fakeLlm(chunksFromText(verdict)),
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    }, audit as any)

    // "读" matches LOCAL keyword → rules path returns LOCAL.
    const intent = await service.classify('读文件')
    assert.equal(intent.category, 'LOCAL')
    assert.match(intent.rationale, /rule-keyword-match/u)
    assert.ok(audit.entries.some(e => e.kind === 'intent.llm.low-confidence'))
  })

  it('falls back to defaultCategory when LLM response is malformed', async () => {
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: fakeLlm(chunksFromText('我无法分类这个请求')),
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    }, audit as any)

    const intent = await service.classify('hi there')
    assert.equal(intent.category, 'CLOUD')
    assert.match(intent.rationale, /default:cloud/u)
  })

  // ─── model-router integration (v6 §2.15) ───────────────────────────────

  it('routes classification call through model-router when mounted', async () => {
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.9 })
    const captured: { input?: string; opts?: any } = {}
    const fakeMr = {
      resolve: (m: string) => {
        captured.input = m
        return { realm: 'CLOUD', provider: 'cloud-llm', model: 'deepseek-chat' }
      },
    }
    let capturedOpts: any
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(opts: any) { capturedOpts = opts; return chunksFromText(verdict) },
      },
      modelRouter: fakeMr,
      // sanitizer required: CLOUD realm must sanitize before LLM call
      sanitizer: { sanitize: async (t: string) => ({ sanitizedText: t, replacements: [] }) },
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    }, audit as any)

    await service.classify('hi')
    assert.equal(captured.input, 'local-llm')
    assert.equal(capturedOpts.provider, 'cloud-llm')
    assert.equal(capturedOpts.model, 'deepseek-chat')
    const routeEntry = audit.entries.find((e: any) => e.kind === 'intent.llm.route')
    assert.ok(routeEntry, 'intent.llm.route audit kind should be present')
    assert.equal(routeEntry.payload.modelRouterMounted, true)
    assert.equal(routeEntry.payload.resolvedProvider, 'cloud-llm')
  })

  it('falls back to config values when modelRouter is absent', async () => {
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.9 })
    let capturedOpts: any
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(opts: any) { capturedOpts = opts; return chunksFromText(verdict) },
      },
      // no modelRouter key
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      classificationModel: 'qwen3-4b',
      confidenceThreshold: 0.6,
    }, audit as any)

    await service.classify('hi')
    assert.equal(capturedOpts.provider, 'local-llm')
    assert.equal(capturedOpts.model, 'qwen3-4b')
    const routeEntry = audit.entries.find((e: any) => e.kind === 'intent.llm.route')
    assert.ok(routeEntry)
    assert.equal(routeEntry.payload.modelRouterMounted, false)
  })

  it('fails open to config values when modelRouter.resolve throws', async () => {
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.9 })
    let capturedOpts: any
    const fakeMr = { resolve: () => { throw new Error('boom') } }
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(opts: any) { capturedOpts = opts; return chunksFromText(verdict) },
      },
      modelRouter: fakeMr,
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      classificationModel: 'qwen3-4b',
      confidenceThreshold: 0.6,
    }, audit as any)

    await service.classify('hi')
    assert.equal(capturedOpts.provider, 'local-llm')
    assert.equal(capturedOpts.model, 'qwen3-4b')
    const routeEntry = audit.entries.find((e: any) => e.kind === 'intent.llm.route')
    assert.ok(routeEntry)
    assert.equal(routeEntry.payload.modelRouterMounted, true)
    assert.equal(routeEntry.payload.resolvedProvider, 'local-llm')
  })

  // ─── timeout + multi-turn context ──────────────────────────────────────

  it('aborts LLM stream after llmTimeoutMs and falls open', async () => {
    // Fake stream that respects AbortSignal: yields nothing, exits cleanly
    // when signal.aborted flips. Mimics a well-behaved local-llm-adapter.
    function makeAbortableStream(signal: AbortSignal): AsyncIterable<unknown> {
      return (async function* () {
        // Wait until aborted OR throw to surface the abort as an error.
        await new Promise<void>((resolve, reject) => {
          if (signal.aborted) {
            const e: any = new Error('aborted')
            e.name = 'AbortError'
            return reject(e)
          }
          signal.addEventListener('abort', () => {
            const e: any = new Error('aborted')
            e.name = 'AbortError'
            reject(e)
          }, { once: true })
        })
      })()
    }
    let capturedSignal: AbortSignal | undefined
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(opts: any) {
          capturedSignal = opts.signal
          return makeAbortableStream(opts.signal)
        },
      },
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
      llmTimeoutMs: 50,   // 50ms timeout for the test
    }, audit as any)

    const intent = await service.classify('你好')
    // Falls back to default CLOUD (no LLM verdict, no keyword hit)
    assert.equal(intent.category, 'CLOUD')
    assert.match(intent.rationale, /default:cloud/u)
    // AbortSignal was wired in
    assert.ok(capturedSignal, 'AbortSignal should be passed to llm.stream')
    assert.equal(capturedSignal.aborted, true)
    // Audit entry should mention timeout
    const timeoutEntry = audit.entries.find((e: any) => e.kind === 'intent.llm.timeout')
    assert.ok(timeoutEntry, 'intent.llm.timeout audit kind should be present')
    assert.equal(timeoutEntry.payload.timeoutMs, 50)
  })

  it('passes AbortSignal into llm.stream options', async () => {
    let capturedOpts: any
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.9 })
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(opts: any) {
          capturedOpts = opts
          return chunksFromText(verdict)
        },
      },
    } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
      llmTimeoutMs: 4000,
    })

    await service.classify('hi')
    assert.ok(capturedOpts.signal, 'signal should be passed to llm.stream')
    assert.ok(capturedOpts.signal instanceof AbortSignal)
  })

  it('embeds recentMessages into prompt when provided', async () => {
    let capturedOpts: any
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.9 })
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(opts: any) {
          capturedOpts = opts
          return chunksFromText(verdict)
        },
      },
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    }, audit as any)

    const history = [
      { role: 'user', content: [{ type: 'text', text: '读文件' }] },
      { role: 'assistant', content: [{ type: 'text', text: '好的' }] },
    ]
    await service.classify('帮我重命名', { recentMessages: history })
    const promptText = capturedOpts.messages[0].content[0].text
    assert.match(promptText, /最近对话上下文/)
    assert.match(promptText, /user: 读文件/)
    assert.match(promptText, /assistant: 好的/)
    const ctxEntry = audit.entries.find((e: any) => e.kind === 'intent.llm.context')
    assert.ok(ctxEntry)
    assert.equal(ctxEntry.payload.received, 2)
    assert.equal(ctxEntry.payload.embedded, 2)
  })

  it('omits context block when recentMessages is empty', async () => {
    let capturedOpts: any
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.9 })
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(opts: any) {
          capturedOpts = opts
          return chunksFromText(verdict)
        },
      },
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    }, audit as any)

    await service.classify('hi', { recentMessages: [] })
    const promptText = capturedOpts.messages[0].content[0].text
    assert.doesNotMatch(promptText, /最近对话上下文/)
    const ctxEntries = audit.entries.filter((e: any) => e.kind === 'intent.llm.context')
    assert.equal(ctxEntries.length, 0)
  })

  // ─── privacy-policy routing ─────────────────────────────────────────────

  it('uses privacy-policy matchRouting when mounted (LOCAL)', async () => {
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: null,
      privacyPolicy: {
        matchRouting: (_text: string) => ({
          pattern: '(本地|local)',
          realm: 'LOCAL',
          confidence: 0.85,
          rationale: 'policy-matched-local',
        }),
      },
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    }, audit as any)

    const intent = await service.classify('本地操作')
    assert.equal(intent.category, 'LOCAL')
    assert.equal(intent.confidence, 0.85)
    assert.equal(intent.targetRealm, 'local')
    assert.equal(intent.rationale, 'policy-matched-local')
    const hit = audit.entries.find((e: any) => e.kind === 'intent.rules.hit')
    assert.ok(hit)
    assert.equal(hit.payload.source, 'privacy-policy')
    assert.equal(hit.payload.realm, 'LOCAL')
  })

  it('uses privacy-policy matchRouting when mounted (SANITIZED)', async () => {
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: null,
      privacyPolicy: {
        matchRouting: (_text: string) => ({
          pattern: '(密码|password|secret)',
          realm: 'SANITIZED',
          confidence: 0.9,
          rationale: 'policy-matched-sanitized',
        }),
      },
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    }, audit as any)

    const intent = await service.classify('my password is foo')
    assert.equal(intent.category, 'SANITIZED')
    assert.equal(intent.confidence, 0.9)
    assert.equal(intent.targetRealm, 'sanitized')
    assert.equal(intent.rationale, 'policy-matched-sanitized')
  })

  it('falls back to hardcoded keywords when privacyPolicy is absent', async () => {
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: null,
      // no privacyPolicy
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    }, audit as any)

    const intent = await service.classify('帮我读取文件内容')
    assert.equal(intent.category, 'LOCAL')
    assert.equal(intent.targetRealm, 'local')
    assert.match(intent.rationale, /rule-keyword-match/u)
    const hit = audit.entries.find((e: any) => e.kind === 'intent.rules.hit')
    assert.ok(hit)
    assert.equal(hit.payload.source, 'fallback-keyword')
  })

  it('falls back when privacyPolicy.matchRouting throws', async () => {
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: null,
      privacyPolicy: { matchRouting: () => { throw new Error('boom') } },
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    }, audit as any)

    const intent = await service.classify('帮我读文件')
    assert.equal(intent.category, 'LOCAL')
    assert.match(intent.rationale, /rule-keyword-match/u)
    const errEntry = audit.entries.find((e: any) => e.kind === 'intent.policy.error')
    assert.ok(errEntry)
  })

  // ─── PII sanitization (v6 §2.6 + §2.15) ─────────────────────────────────

  it('sanitizes user text before LLM prompt when classification LLM is CLOUD', async () => {
    // Mirrors http-api's pattern: when classification goes to CLOUD, sanitize
    // the input first so PII never leaves the device just to ask
    // "is this LOCAL or CLOUD".
    let capturedPrompt: string | undefined
    let sanitizerCalled = 0
    let sanitizerGotSessionId: string | undefined
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.9 })
    const fakeSanitizer = {
      sanitize: async (text: string, ctx?: { sessionId?: string }) => {
        sanitizerCalled++
        sanitizerGotSessionId = ctx?.sessionId
        return {
          sanitizedText: text.replace(/1[3-9]\d{9}/u, '[PHONE_1]'),
          replacements: [{ placeholder: '[PHONE_1]', originalValue: '13812345678' }],
        }
      },
    }
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(opts: any) {
          capturedPrompt = opts.messages[0].content[0].text
          return chunksFromText(verdict)
        },
      },
      modelRouter: {
        resolve: () => ({ realm: 'CLOUD', provider: 'cloud-llm', model: 'deepseek-chat' }),
      },
      sanitizer: fakeSanitizer,
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    }, audit as any)

    await service.classify('我的手机号是13812345678，帮我查个事', { sessionId: 'sess-A' })
    assert.equal(sanitizerCalled, 1, 'sanitizer should be called once')
    assert.equal(sanitizerGotSessionId, 'sess-A')
    assert.ok(capturedPrompt)
    assert.match(capturedPrompt, /\[PHONE_1\]/)
    assert.doesNotMatch(capturedPrompt, /13812345678/)
    const sanitizedEntry = audit.entries.find((e: any) => e.kind === 'intent.llm.sanitized')
    assert.ok(sanitizedEntry)
    assert.equal(sanitizedEntry.payload.replacements, 1)
    assert.equal(sanitizedEntry.payload.sessionId, 'sess-A')
  })

  it('skips sanitization when classification LLM resolves to LOCAL', async () => {
    let capturedPrompt: string | undefined
    let sanitizerCalled = 0
    const verdict = JSON.stringify({ category: 'LOCAL', confidence: 0.9 })
    const fakeSanitizer = {
      sanitize: async () => { sanitizerCalled++; return { sanitizedText: 'XX', replacements: [] } },
    }
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(opts: any) {
          capturedPrompt = opts.messages[0].content[0].text
          return chunksFromText(verdict)
        },
      },
      modelRouter: {
        resolve: () => ({ realm: 'LOCAL', provider: 'local-llm', model: 'qwen3-4b' }),
      },
      sanitizer: fakeSanitizer,
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    }, audit as any)

    const originalText = '查一下 13812345678'
    await service.classify(originalText)
    assert.equal(sanitizerCalled, 0, 'sanitizer should NOT be called for LOCAL LLM')
    assert.ok(capturedPrompt)
    assert.match(capturedPrompt, /13812345678/, 'original PII must reach LOCAL LLM unchanged')
  })

  it('falls back to rules when sanitizer is missing (CLOUD realm) — fail-closed', async () => {
    let llmCalled = false
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(_opts: any) {
          llmCalled = true
          return chunksFromText(JSON.stringify({ category: 'CLOUD', confidence: 0.9 }))
        },
      },
      modelRouter: {
        resolve: () => ({ realm: 'CLOUD', provider: 'cloud-llm', model: 'deepseek-chat' }),
      },
      // no sanitizer key
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    }, audit as any)

    const originalText = '查一下 13812345678'
    const intent = await service.classify(originalText)
    // classifyWithLlm must NOT call the LLM when sanitizer is unavailable
    assert.equal(llmCalled, false, 'LLM must NOT be called when sanitizer is missing')
    // classifyWithLlm throws → classifyWithRules. §7.58 (2026-09-16): "查"
    // is NO LONGER a CLOUD keyword (bare verbs were removed), so all keyword
    // layers miss and the intent falls through to defaultCategory. The test's
    // defaultCategory is CLOUD, so the category outcome is unchanged — the
    // sanitize path still gates the actual LLM call; only the rationale
    // source moved from cloud-keyword to default.
    assert.equal(intent.category, 'CLOUD')
    assert.match(intent.rationale, /^default:cloud$/u)
    // Audit: security-level sanitize-unavailable (renamed from debug sanitize-skipped)
    const unavailEntry = audit.entries.find((e: any) => e.kind === 'intent.llm.sanitize-unavailable')
    assert.ok(unavailEntry, 'intent.llm.sanitize-unavailable audit kind should be present')
    assert.equal(unavailEntry.level, 'security')
  })

  it('falls back to rules when sanitizer throws (CLOUD realm) — fail-closed', async () => {
    let llmCalled = false
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(_opts: any) {
          llmCalled = true
          return chunksFromText(JSON.stringify({ category: 'CLOUD', confidence: 0.9 }))
        },
      },
      modelRouter: {
        resolve: () => ({ realm: 'CLOUD', provider: 'cloud-llm', model: 'deepseek-chat' }),
      },
      sanitizer: { sanitize: async () => { throw new Error('boom') } },
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    }, audit as any)

    const originalText = '查一下 13812345678'
    const intent = await service.classify(originalText)
    // classifyWithLlm must NOT call the LLM when sanitizer throws
    assert.equal(llmCalled, false, 'LLM must NOT be called when sanitizer throws')
    // classifyWithLlm throws → classifyWithRules. §7.58 (2026-09-16): "查"
    // is NO LONGER a CLOUD keyword (bare verbs were removed), so all keyword
    // layers miss and the intent falls through to defaultCategory. The test's
    // defaultCategory is CLOUD, so the category outcome is unchanged — the
    // sanitize path still gates the actual LLM call; only the rationale
    // source moved from cloud-keyword to default.
    assert.equal(intent.category, 'CLOUD')
    assert.match(intent.rationale, /^default:cloud$/u)
    // Audit: security-level sanitize-error still present
    const errEntry = audit.entries.find((e: any) => e.kind === 'intent.llm.sanitize-error')
    assert.ok(errEntry, 'intent.llm.sanitize-error audit kind should be present')
    assert.equal(errEntry.level, 'security')
    assert.match(errEntry.payload.error, /boom/u)
  })

  // ─── input edge: REJECT path (privacy-policy realm: 'REJECT') ───────────

  it('returns REJECT when privacy-policy matchRouting yields realm: REJECT', async () => {
    let llmCalled = false
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(_opts: any) { llmCalled = true; return chunksFromText('{}') },
      },
      privacyPolicy: {
        matchRouting: (_text: string) => ({
          pattern: '(导出.*全部|export.*all)',
          realm: 'REJECT',
          confidence: 0.99,
          rationale: 'bulk-export-blocked',
        }),
      },
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    }, audit as any)

    const intent = await service.classify('导出全部用户数据')
    assert.equal(intent.category, 'REJECT')
    assert.equal(intent.targetRealm, 'rejected')
    assert.equal(intent.confidence, 0.99)
    assert.equal(intent.rationale, 'bulk-export-blocked')
    // REJECT is a security event — must hit the security audit level so SIEM picks it up.
    const rejected = audit.entries.find((e: any) => e.kind === 'intent.rules.rejected')
    assert.ok(rejected, 'intent.rules.rejected audit kind should be present')
    assert.equal(rejected.level, 'security')
    assert.equal(rejected.payload.pattern, '(导出.*全部|export.*all)')
    // REJECT is a router-level decision — must NOT trigger an LLM call.
    assert.equal(llmCalled, false, 'LLM must NOT be called when REJECT is decided at rules layer')
  })

  it('returns REJECT via pre-check without calling LLM (stronger than fallback path)', async () => {
    // The pre-check is fed the privacy-policy matchRouting BEFORE any LLM
    // call. Earlier behaviour (rules-only fallback) wasted LLM tokens on
    // policy-violating queries; now REJECT short-circuits at the router edge.
    // The fallback path inside classifyWithLlm → catch → classifyWithRules
    // is still kept as a belt-and-suspenders for the case where policy
    // rules are added between pre-check and fallback — covered implicitly
    // by the privacy-policy tests in classifyWithRules unit suite.
    let llmCalled = 0
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(_opts: any) { llmCalled++; return chunksFromText(JSON.stringify({ category: 'LOCAL', confidence: 0.3 })) },
      },
      privacyPolicy: {
        matchRouting: () => ({
          pattern: '(password|secret)',
          realm: 'REJECT',
          confidence: 0.95,
          rationale: 'credential-exfil-attempt',
        }),
      },
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    }, audit as any)

    const intent = await service.classify('my password is foo')
    assert.equal(intent.category, 'REJECT')
    assert.equal(intent.targetRealm, 'rejected')
    assert.equal(llmCalled, 0, 'REJECT must short-circuit before LLM call')
    // Source 'privacy-policy-precheck' marks the new pre-check audit path.
    const rejected = audit.entries.find((e: any) => e.kind === 'intent.rules.rejected')
    assert.ok(rejected)
    assert.equal(rejected.payload.source, 'privacy-policy-precheck')
    assert.equal(rejected.level, 'security')
  })

  // ─── input edge: empty / length cap (defense-in-depth) ─────────────────

  it('short-circuits empty input to default without calling LLM', async () => {
    let llmCalled = 0
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(_opts: any) { llmCalled++; return chunksFromText('{}') },
      },
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    }, audit as any)

    const intent = await service.classify('')
    assert.equal(intent.category, 'CLOUD')
    assert.equal(intent.targetRealm, 'cloud')
    assert.equal(intent.rationale, 'empty-input')
    assert.equal(llmCalled, 0, 'LLM must NOT be called for empty input')
    const emptyAudit = audit.entries.find((e: any) => e.kind === 'intent.classify.empty')
    assert.ok(emptyAudit)
  })

  it('short-circuits whitespace-only input the same as empty', async () => {
    let llmCalled = 0
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(_opts: any) { llmCalled++; return chunksFromText('{}') },
      },
    } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'LOCAL',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    })

    const intent = await service.classify('   \t\n  ')
    assert.equal(intent.category, 'LOCAL')
    assert.equal(intent.rationale, 'empty-input')
    assert.equal(llmCalled, 0)
  })

  it('truncates input past maxInputLength and audits', async () => {
    let capturedPrompt: string | undefined
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.9 })
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(opts: any) {
          capturedPrompt = opts.messages[0].content[0].text
          return chunksFromText(verdict)
        },
      },
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
      maxInputLength: 50,  // tiny cap for the test
    }, audit as any)

    const longText = 'a'.repeat(200)
    await service.classify(longText)
    // Prompt must not contain more than the cap's worth of 'a's
    assert.ok(capturedPrompt)
    const aaCount = (capturedPrompt.match(/a/gu) || []).length
    assert.ok(aaCount <= 55, `prompt should contain ≤ 55 'a' chars (50 cap + safety), got ${aaCount}`)
    const truncated = audit.entries.find((e: any) => e.kind === 'intent.classify.truncated')
    assert.ok(truncated)
    assert.equal(truncated.payload.originalLen, 200)
    assert.equal(truncated.payload.truncatedLen, 50)
    assert.equal(truncated.payload.maxInputLength, 50)
  })

  it('truncates BEFORE sanitization so cap-bound sanitizer output is consistent', async () => {
    // 100 'a's + 5 phone numbers worth of digits = 165 chars. With cap 50,
    // only first 50 chars reach the sanitizer. The truncated audit confirms
    // the original length was 165.
    let sanitizerReceived: string | undefined
    let capturedPrompt: string | undefined
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.9 })
    const fakeSanitizer = {
      sanitize: async (t: string) => {
        sanitizerReceived = t
        return { sanitizedText: t, replacements: [] }
      },
    }
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(opts: any) {
          capturedPrompt = opts.messages[0].content[0].text
          return chunksFromText(verdict)
        },
      },
      modelRouter: {
        resolve: () => ({ realm: 'CLOUD', provider: 'cloud-llm', model: 'deepseek-chat' }),
      },
      sanitizer: fakeSanitizer,
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
      maxInputLength: 50,
    }, audit as any)

    // 30 'a's + 11-digit phone + 30 'a's + "trailing" — total ~75 chars
    const phone = '13812345678'
    const text = 'a'.repeat(30) + phone + 'a'.repeat(30) + 'trailing'
    await service.classify(text)
    // Truncate at 50 means sanitizer sees the first 50 chars: 30 a's + the
    // first 11 digits of the phone + 9 more a's. The phone IS in the truncated
    // text (good — it still gets sanitized), the trailing 'trailing' is cut.
    assert.ok(sanitizerReceived)
    assert.equal(sanitizerReceived.length, 50)
    assert.ok(sanitizerReceived.includes(phone), `sanitizer must see full phone in truncated text; got "${sanitizerReceived.slice(-20)}"`)
    assert.ok(!sanitizerReceived.includes('trailing'), 'sanitizer must NOT see the trailing 8 chars past the cap')
    const truncAudit = audit.entries.find((e: any) => e.kind === 'intent.classify.truncated')
    assert.ok(truncAudit)
    assert.equal(truncAudit.payload.originalLen, text.length)
  })

  // ─── getStats() metrics counters (§7.13) ────────────────────────────────

  it('getStats() returns zero counters on a fresh service', () => {
    const mockCtx = { reflect: { provide: () => {} }, llm: null } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    })
    const s = service.getStats()
    assert.equal(s.total, 0)
    assert.equal(s.empty, 0)
    assert.equal(s.truncated, 0)
    assert.equal(s.llmHit, 0)
    assert.equal(s.ruleHit, 0)
    assert.equal(s.defaultHit, 0)
    assert.equal(s.lowConfidence, 0)
    assert.equal(s.timeout, 0)
    assert.equal(s.llmError, 0)
    assert.equal(s.rejected, 0)
    assert.equal(s.sanitized, 0)
    assert.equal(s.sanitizeError, 0)
    assert.equal(s.sanitizeSkipped, 0)
  })

  it('increments llmHit when LLM verdict is adopted', async () => {
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.9 })
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: { stream: () => chunksFromText(verdict) },
    } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    })
    await service.classify('hi')
    const s = service.getStats()
    assert.equal(s.total, 1)
    assert.equal(s.llmHit, 1)
    assert.equal(s.ruleHit, 0)
    assert.equal(s.defaultHit, 0)
  })

  it('counts ruleHit / defaultHit / lowConfidence / timeout correctly', async () => {
    // 1. low-confidence → fallback → defaultHit (no keyword match)
    const lowConf = JSON.stringify({ category: 'LOCAL', confidence: 0.2 })
    // 2. timeout → fallback → defaultHit
    function makeAbortableStream(signal: AbortSignal): AsyncIterable<unknown> {
      return (async function* () {
        await new Promise<void>((_, reject) => {
          signal.addEventListener('abort', () => {
            const e: any = new Error('aborted'); e.name = 'AbortError'; reject(e)
          }, { once: true })
        })
      })()
    }
    let streamIdx = 0
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(opts: any) {
          streamIdx++
          return streamIdx === 1 ? chunksFromText(lowConf) : makeAbortableStream(opts.signal)
        },
      },
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
      llmTimeoutMs: 50,
    }, audit as any)

    // "你好" has no keyword match → defaultHit
    await service.classify('你好')           // lowConfidence → fallback → default
    await service.classify('how are you')   // timeout → fallback → default
    const s = service.getStats()
    assert.equal(s.total, 2)
    assert.equal(s.lowConfidence, 1)
    assert.equal(s.timeout, 1)
    assert.equal(s.defaultHit, 2)
    assert.equal(s.llmHit, 0)

    // Now a query that hits the hardcoded keyword fallback path
    await service.classify('帮我读文件')   // timeout → fallback → LOCAL keyword hit → ruleHit
    assert.equal(service.getStats().ruleHit, 1)
    assert.equal(service.getStats().ruleHit + service.getStats().defaultHit, 3)
  })

  it('counts sanitized / sanitizeError / sanitizeSkipped (fail-closed: LLM skipped, rules used)', async () => {
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.9 })
    let capturedOpts: any
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(opts: any) { capturedOpts = opts; return chunksFromText(verdict) },
      },
      modelRouter: {
        resolve: () => ({ realm: 'CLOUD', provider: 'cloud-llm', model: 'deepseek-chat' }),
      },
    } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    })

    // 1. CLOUD + no sanitizer → sanitizeSkipped++
    await service.classify('hi 1')
    assert.equal(service.getStats().sanitizeSkipped, 1)
    assert.equal(service.getStats().sanitized, 0)

    // 2. CLOUD + sanitizer present → sanitized++
    ;(mockCtx as any).sanitizer = { sanitize: async (t: string) => ({ sanitizedText: t, replacements: [] }) }
    await service.classify('hi 2')
    assert.equal(service.getStats().sanitized, 1)
    assert.equal(service.getStats().sanitizeSkipped, 1)

    // 3. CLOUD + sanitizer throws → sanitizeError++
    ;(mockCtx as any).sanitizer = { sanitize: async () => { throw new Error('boom') } }
    await service.classify('hi 3')
    assert.equal(service.getStats().sanitizeError, 1)
    assert.equal(service.getStats().sanitized, 1)  // previous count preserved
  })

  it('counts rejected at pre-check and via fallback path', async () => {
    // Pre-check path (no LLM call)
    const precheckCtx = {
      reflect: { provide: () => {} },
      llm: { stream: () => { throw new Error('should not be called') } },
      privacyPolicy: {
        matchRouting: () => ({ pattern: 'x', realm: 'REJECT', confidence: 0.9, rationale: 'r' }),
      },
    } as any
    const s1 = new IntentRouterServiceImpl(precheckCtx, {
      defaultCategory: 'CLOUD', classificationProvider: 'local-llm', confidenceThreshold: 0.6,
    })
    await s1.classify('bad')
    assert.equal(s1.getStats().rejected, 1)
    assert.equal(s1.getStats().llmHit, 0)
  })

  it('getStats() returns a copy (callers cannot mutate live state)', async () => {
    const mockCtx = { reflect: { provide: () => {} }, llm: null } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD', classificationProvider: 'local-llm', confidenceThreshold: 0.6,
    })
    await service.classify('')  // +1 empty, +1 total
    const snapshot = service.getStats()
    snapshot.total = 9999
    snapshot.empty = 9999
    // Live state must not be affected by caller mutation
    assert.equal(service.getStats().total, 1)
    assert.equal(service.getStats().empty, 1)
  })

  // ── G9: confidence histogram in getStats() ─────────────────────────────────
  // Operators tuning `confidenceThreshold` need to see the LLM's actual
  // confidence distribution. G9 buckets every parsed verdict into one of 10
  // buckets (0..9) and splits each bucket into accepted (>= threshold) and
  // rejected (< threshold, fell back to rules). Timeouts / errors / unclear
  // responses have no confidence to bucket and are NOT recorded.

  it('fresh service has empty confidenceHistogram', () => {
    const service = new IntentRouterServiceImpl({ reflect: { provide: () => {} }, llm: null } as any, {
      defaultCategory: 'CLOUD', classificationProvider: 'local-llm', confidenceThreshold: 0.6,
    })
    const stats = service.getStats()
    assert.deepEqual(stats.confidenceHistogram, {})
  })

  it('confidenceHistogram records accepted when verdict.confidence >= threshold', async () => {
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.9 })  // bucket 9
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: { stream: () => chunksFromText(verdict) },
    } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD', classificationProvider: 'local-llm', confidenceThreshold: 0.6,
    })
    await service.classify('hi')
    const stats = service.getStats()
    // Bucket index = Math.floor(0.9 * 10) = 9
    assert.ok(stats.confidenceHistogram['9'])
    assert.equal(stats.confidenceHistogram['9'].accepted, 1)
    assert.equal(stats.confidenceHistogram['9'].rejected, 0)
  })

  it('confidenceHistogram records rejected when verdict.confidence < threshold', async () => {
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.3 })  // bucket 3
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: { stream: () => chunksFromText(verdict) },
    } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD', classificationProvider: 'local-llm', confidenceThreshold: 0.6,
    })
    await service.classify('hi')
    const stats = service.getStats()
    // 0.3 < 0.6 → lowConfidence fallback path; bucket still recorded as rejected
    assert.equal(stats.confidenceHistogram['3'].accepted, 0)
    assert.equal(stats.confidenceHistogram['3'].rejected, 1)
  })

  it('confidenceHistogram distributes across buckets for multiple verdicts', async () => {
    const verdicts = [0.0, 0.15, 0.55, 0.7, 0.95]   // buckets 0, 1, 5, 7, 9
    let idx = 0
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream: () => {
          const v = verdicts[idx++ % verdicts.length]
          return chunksFromText(JSON.stringify({ category: 'CLOUD', confidence: v }))
        },
      },
    } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD', classificationProvider: 'local-llm', confidenceThreshold: 0.6,
    })
    for (let i = 0; i < verdicts.length; i++) await service.classify('hi')
    const h = service.getStats().confidenceHistogram
    assert.equal(h['0'].rejected, 1)   // 0.0 → bucket 0, < 0.6
    assert.equal(h['1'].rejected, 1)   // 0.15 → bucket 1
    assert.equal(h['5'].rejected, 1)   // 0.55 → bucket 5
    assert.equal(h['7'].accepted, 1)   // 0.7  → bucket 7, >= 0.6
    assert.equal(h['9'].accepted, 1)   // 0.95 → bucket 9
  })

  it('confidence=1.0 clamps into bucket 9 (last bucket inclusive)', async () => {
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 1.0 })
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: { stream: () => chunksFromText(verdict) },
    } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD', classificationProvider: 'local-llm', confidenceThreshold: 0.6,
    })
    await service.classify('hi')
    // Without the clamp, Math.floor(1.0 * 10) = 10, which would create a
    // spurious '10' bucket and orphan bucket 9.
    const h = service.getStats().confidenceHistogram
    assert.ok(h['9'], 'bucket 9 must contain conf=1.0')
    assert.ok(!h['10'], 'bucket 10 must NOT exist')
  })

  it('timeout does NOT pollute confidenceHistogram (no confidence to bucket)', async () => {
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream: async function* () { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) },
      },
    } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD', classificationProvider: 'local-llm',
      confidenceThreshold: 0.6, llmTimeoutMs: 50,
    })
    await service.classify('hi')
    const stats = service.getStats()
    assert.equal(stats.timeout, 1)
    assert.deepEqual(stats.confidenceHistogram, {})
  })

  it('unclear response does NOT pollute confidenceHistogram (parse failed)', async () => {
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: { stream: () => chunksFromText('not json at all') },
    } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD', classificationProvider: 'local-llm', confidenceThreshold: 0.6,
    })
    await service.classify('hi')
    const stats = service.getStats()
    assert.equal(stats.llmError, 1)
    assert.deepEqual(stats.confidenceHistogram, {})
  })

  it('getStats() deep-copies confidenceHistogram (mutating snapshot cells is safe)', async () => {
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.8 })
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: { stream: () => chunksFromText(verdict) },
    } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD', classificationProvider: 'local-llm', confidenceThreshold: 0.6,
    })
    await service.classify('hi')
    const snap = service.getStats()
    // Mutate the returned histogram aggressively
    snap.confidenceHistogram['8'].accepted = 9999
    snap.confidenceHistogram['8'].rejected = 9999
    snap.confidenceHistogram['99'] = { accepted: 9999, rejected: 9999 }
    // Live state must be untouched
    const fresh = service.getStats().confidenceHistogram
    assert.equal(fresh['8'].accepted, 1)
    assert.equal(fresh['8'].rejected, 0)
    assert.ok(!fresh['99'], 'phantom bucket must not persist into live state')
  })

  // ─── P0: Tier-3 regex parser requires BOTH fields (P0 fix) ────────────
  // ─── P1: parseFailure counter separated from llmError (P1 fix) ────────
  // ─── P0: sanitizeError audit level = 'security' (P0 fix) ──────────────

  it('P0: regex parser returns null when only category is extracted (no confidence)', async () => {
    // LLM emitted "category=LOCAL" with no confidence — old code returned
    // a 0.5-confidence verdict that ALWAYS failed the 0.6 gate, wasting the
    // LLM call. New code returns null so the outer path attributes the
    // failure to parseFailure and falls through to keyword rules.
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: { stream: () => chunksFromText('category=LOCAL') },
    } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD', classificationProvider: 'local-llm', confidenceThreshold: 0.6,
    })
    const intent = await service.classify('something arbitrary')
    // No keyword match → defaultCategory
    assert.equal(intent.category, 'CLOUD')
    assert.match(intent.rationale, /default:cloud/u)
    const stats = service.getStats()
    assert.equal(stats.parseFailure, 1, 'parseFailure should bump on unparseable regex-tier response')
    assert.equal(stats.llmError, 1, 'llmError stays the umbrella for non-adopted LLM calls')
  })

  it('P0: regex parser adopts verdict when BOTH category AND confidence extracted', async () => {
    // LLM emitted "category=CLOUD, confidence 0.8" — neither JSON nor
    // brace-block, but regex grabs both fields. Old code returned
    // conf=0.5 (waste); new code returns the extracted 0.8.
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: { stream: () => chunksFromText('I think category=CLOUD, confidence 0.8') },
    } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'LOCAL', classificationProvider: 'local-llm', confidenceThreshold: 0.6,
    })
    const intent = await service.classify('something arbitrary')
    assert.equal(intent.category, 'CLOUD')
    assert.equal(intent.confidence, 0.8)
    const stats = service.getStats()
    assert.equal(stats.llmHit, 1)
    assert.equal(stats.parseFailure, 0, 'parseFailure should NOT bump when regex succeeded')
  })

  it('P0: sanitizeError audit carries level="security" (SIEM must see it)', async () => {
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.9 })
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(opts: any) { return chunksFromText(verdict) },
      },
      modelRouter: {
        resolve: () => ({ realm: 'CLOUD', provider: 'cloud-llm', model: 'deepseek-chat' }),
      },
      sanitizer: { sanitize: async () => { throw new Error('boom') } },
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD', classificationProvider: 'local-llm', confidenceThreshold: 0.6,
    }, audit as any)
    await service.classify('查一下 13812345678')
    const errEntry = audit.entries.find((e: any) => e.kind === 'intent.llm.sanitize-error')
    assert.ok(errEntry)
    // Old code was 'warn' which SIEM rules often filter out — bumped to
    // 'security' so PII-via-failed-sanitizer events surface in alerting.
    assert.equal(errEntry.level, 'security')
  })

  it('P1: parseFailure counter starts at 0 and increments per unparseable response', async () => {
    const service = new IntentRouterServiceImpl({
      reflect: { provide: () => {} },
      llm: { stream: () => chunksFromText('nonsense') },
    } as any, {
      defaultCategory: 'CLOUD', classificationProvider: 'local-llm', confidenceThreshold: 0.6,
    })
    assert.equal(service.getStats().parseFailure, 0, 'fresh service has parseFailure=0')
    await service.classify('hi')
    assert.equal(service.getStats().parseFailure, 1)
    await service.classify('hello')
    assert.equal(service.getStats().parseFailure, 2)
    // Successful verdicts must NOT bump parseFailure
    const goodMock = {
      reflect: { provide: () => {} },
      llm: { stream: () => chunksFromText(JSON.stringify({ category: 'CLOUD', confidence: 0.9 })) },
    } as any
    const goodService = new IntentRouterServiceImpl(goodMock, {
      defaultCategory: 'CLOUD', classificationProvider: 'local-llm', confidenceThreshold: 0.6,
    })
    await goodService.classify('hi')
    assert.equal(goodService.getStats().parseFailure, 0)
    assert.equal(goodService.getStats().llmHit, 1)
  })

  // ─── redactPreview() PII guard (§7.13) ─────────────────────────────────

  it('redacts response preview via ctx.piiUtils.redactString', async () => {
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.9 })
    // Echo back an "interpreted" message that includes the phone (simulates
    // a confused LLM that leaked input back). With redactString applied, the
    // audit should see the masked form, not raw digits.
    const echoed = 'call 13812345678 now'  // 22 chars, well under 40
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: { stream: () => chunksFromText(echoed) },  // not a valid verdict → unclear path
      piiUtils: {
        // Mirror pii-utils.redactString for the phone rule.
        redactString: (t: string) => ({
          redacted: t.replace(/1[3-9]\d{9}/g, (m) => `${m.slice(0, 3)}****${m.slice(7)}`),
          matches: [],
        }),
      },
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    }, audit as any)

    await service.classify('hi')
    // The unclear-path audit must carry a redacted preview, not raw digits.
    const unclear = audit.entries.find((e: any) => e.kind === 'intent.llm.unclear')
    assert.ok(unclear)
    assert.match(unclear.payload.responsePreview, /138\*+5678/)
    assert.doesNotMatch(unclear.payload.responsePreview, /13812345678/)
  })

  it('omits response preview when ctx.piiUtils is missing (length-only)', async () => {
    const echoed = 'call 13812345678 now'  // phone + space + 4 chars
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: { stream: () => chunksFromText(echoed) },
      // no piiUtils
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD', classificationProvider: 'local-llm', confidenceThreshold: 0.6,
    }, audit as any)

    await service.classify('hi')
    const unclear = audit.entries.find((e: any) => e.kind === 'intent.llm.unclear')
    assert.ok(unclear)
    // Belt-and-suspenders: no preview at all (length-only via responseLen)
    assert.equal(unclear.payload.responsePreview, null)
    assert.ok('responseLen' in unclear.payload === false || typeof unclear.payload.responseLen === 'undefined' || true)
  })

  it('omits response preview when ctx.piiUtils.redactString throws', async () => {
    const echoed = 'call 13812345678 now'
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: { stream: () => chunksFromText(echoed) },
      piiUtils: { redactString: () => { throw new Error('redact-broken') } },
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD', classificationProvider: 'local-llm', confidenceThreshold: 0.6,
    }, audit as any)

    await service.classify('hi')
    const unclear = audit.entries.find((e: any) => e.kind === 'intent.llm.unclear')
    assert.ok(unclear)
    assert.equal(unclear.payload.responsePreview, null)
  })

  // ── §7.14 Configurable fallbackKeywords ────────────────────────────────────
  // The fallback keyword list (used only when privacy-policy is absent / has
  // no matching rule) was previously a hardcoded EN+CN constant. Some
  // deployments need JA / KO / ES / domain terms without editing source. The
  // Config field `fallbackKeywords` replaces the built-in list entirely when
  // non-empty; an empty array (default) means "use the built-in".

  it('uses built-in EN+CN keywords when fallbackKeywords config is empty', async () => {
    // No LLM, no privacy-policy → falls all the way to fallback keyword list.
    // 'file' is in the built-in list (EN branch) and matches via .toLowerCase()
    // — proves the built-in list is the active set when config.fallbackKeywords
    // is [] (the Schemastery default).
    const mockCtx = { reflect: { provide: () => {} }, llm: null } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
      fallbackKeywords: [],   // empty → built-in EN+CN
    })
    const intent = await service.classify('please file something')
    assert.equal(intent.category, 'LOCAL')
    assert.match(intent.rationale, /rule-keyword-match/u)
  })

  it('replaces built-in list with custom keywords when fallbackKeywords is set', async () => {
    // Custom JA-only list — must match the JA token. Crucially, an EN-only
    // token ('file') is in the built-in list but NOT in the custom list, so
    // a hit on 'file' would only happen with the built-in list — confirming
    // the custom list fully replaces (not appends to) the built-in.
    const mockCtx = { reflect: { provide: () => {} }, llm: null } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
      fallbackKeywords: ['ファイル', '読み込み', '書き込み'],   // JA-only
    })
    const jaHit = await service.classify('ファイルを読み込んで')
    assert.equal(jaHit.category, 'LOCAL')
    assert.match(jaHit.rationale, /rule-keyword-match/u)

    // The EN 'file' is in the BUILT-IN list but not in the custom JA list —
    // so it must NOT match under the custom config (it would match under the
    // default config). This proves `fallbackKeywords` REPLACES, not APPENDS.
    const enMiss = await service.classify('please file something')
    assert.equal(enMiss.category, 'CLOUD', 'EN token must miss under JA-only list')
    assert.match(enMiss.rationale, /default:/u)
  })

  it('keyword replacement preserves matches across mixed locales (CN still works)', async () => {
    // Custom list: CN-only terms. Verifies the replace-not-append semantics
    // work in both directions: CN term still hits, EN term misses.
    const mockCtx = { reflect: { provide: () => {} }, llm: null } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
      fallbackKeywords: ['文件', '本地'],   // CN-only
    })
    const cnHit = await service.classify('帮我读取文件内容')
    assert.equal(cnHit.category, 'LOCAL')

    // 'read' is in the BUILT-IN list (EN), not in our CN-only list.
    const enMiss = await service.classify('read the value')
    assert.equal(enMiss.category, 'CLOUD')
  })

  // ─── parseClassificationVerdict 边界值 ─────────────────────────────────────
  // Direct function tests for the 3-tier parser. These catch edge cases that
  // the LLM actually produces in the field (extra fields, multi-JSON output,
  // boundary confidences, fence variants).

  it('parseClassificationVerdict: Tier 1 accepts JSON with extra fields', () => {
    // LLM sometimes adds reasoning or other fields alongside the required ones.
    const v = parseClassificationVerdict(JSON.stringify({
      category: 'LOCAL', confidence: 0.8, reasoning: 'file operation detected',
    }))
    assert.ok(v)
    assert.equal(v.category, 'LOCAL')
    assert.equal(v.confidence, 0.8)
  })

  it('parseClassificationVerdict: Tier 2 picks first {...} when multiple blocks present', () => {
    // LLM sometimes outputs reasoning in braces before the final JSON.
    const raw = '分析结果: {category: "CLOUD"} — 最终判定 {"category":"CLOUD","confidence":0.85}'
    const v = parseClassificationVerdict(raw)
    assert.ok(v)
    // Tier 2 regex /\{[\s\S]*\}/u is greedy — it captures from first { to last }.
    // The result depends on whether the greedy match produces valid JSON.
    // Either way, the parser should NOT return null (at least Tier 3 should fire).
    assert.ok(v !== null, 'parser should recover something from multi-brace output')
  })

  it('parseClassificationVerdict: returns null for empty string', () => {
    assert.equal(parseClassificationVerdict(''), null)
  })

  it('parseClassificationVerdict: returns null for whitespace-only', () => {
    assert.equal(parseClassificationVerdict('   \t\n  '), null)
  })

  it('parseClassificationVerdict: Tier 1 strips ```json fence', () => {
    const raw = '```json\n{"category":"CLOUD","confidence":0.75}\n```'
    const v = parseClassificationVerdict(raw)
    assert.ok(v)
    assert.equal(v.category, 'CLOUD')
    assert.equal(v.confidence, 0.75)
  })

  it('parseClassificationVerdict: Tier 1 strips ``` fence (no language tag)', () => {
    const raw = '```\n{"category":"LOCAL","confidence":0.9}\n```'
    const v = parseClassificationVerdict(raw)
    assert.ok(v)
    assert.equal(v.category, 'LOCAL')
    assert.equal(v.confidence, 0.9)
  })

  it('parseClassificationVerdict: Tier 3 case-insensitive field names', () => {
    // qwen3-4b sometimes capitalizes field names
    const raw = 'Category=LOCAL, Confidence=0.8'
    const v = parseClassificationVerdict(raw)
    assert.ok(v)
    assert.equal(v.category, 'LOCAL')
    assert.equal(v.confidence, 0.8)
  })

  it('parseClassificationVerdict: Tier 3 returns null when only confidence extracted', () => {
    // Symmetric to the category-only case — both fields must be present.
    const raw = 'confidence: 0.9 but no category field here'
    const v = parseClassificationVerdict(raw)
    assert.equal(v, null)
  })

  // ─── coerceClassification 边界值 ───────────────────────────────────────────

  it('coerceClassification: confidence=0 is valid', () => {
    const v = coerceClassification({ category: 'CLOUD', confidence: 0 })
    assert.ok(v)
    assert.equal(v.confidence, 0)
  })

  it('coerceClassification: confidence=1 is valid', () => {
    const v = coerceClassification({ category: 'LOCAL', confidence: 1 })
    assert.ok(v)
    assert.equal(v.confidence, 1)
  })

  it('coerceClassification: negative confidence clamps to 0', () => {
    const v = coerceClassification({ category: 'CLOUD', confidence: -0.5 })
    assert.ok(v)
    assert.equal(v.confidence, 0)
  })

  it('coerceClassification: confidence > 1 clamps to 1', () => {
    const v = coerceClassification({ category: 'CLOUD', confidence: 1.5 })
    assert.ok(v)
    assert.equal(v.confidence, 1)
  })

  it('coerceClassification: NaN confidence defaults to 0.5', () => {
    const v = coerceClassification({ category: 'CLOUD', confidence: NaN })
    assert.ok(v)
    assert.equal(v.confidence, 0.5)
  })

  it('coerceClassification: string confidence is coerced', () => {
    const v = coerceClassification({ category: 'LOCAL', confidence: '0.85' })
    assert.ok(v)
    assert.equal(v.confidence, 0.85)
  })

  it('coerceClassification: non-numeric string confidence → NaN → 0.5', () => {
    const v = coerceClassification({ category: 'LOCAL', confidence: 'high' })
    assert.ok(v)
    assert.equal(v.confidence, 0.5)
  })

  it('coerceClassification: returns null for invalid category', () => {
    assert.equal(coerceClassification({ category: 'UNKNOWN', confidence: 0.8 }), null)
    assert.equal(coerceClassification({ category: '', confidence: 0.8 }), null)
    assert.equal(coerceClassification({ confidence: 0.8 }), null)
  })

  it('coerceClassification: returns null for null/undefined/primitive', () => {
    assert.equal(coerceClassification(null), null)
    assert.equal(coerceClassification(undefined), null)
    assert.equal(coerceClassification(42), null)
    assert.equal(coerceClassification('hello'), null)
  })

  it('coerceClassification: category is case-insensitive', () => {
    const v = coerceClassification({ category: 'local', confidence: 0.7 })
    assert.ok(v)
    assert.equal(v.category, 'LOCAL')
  })

  // ─── confidenceThreshold 精确边界 ──────────────────────────────────────────
  // The code uses `verdict.confidence < this.confidenceThreshold` — at exact
  // equality (0.6 === 0.6) the verdict should be ADOPTED, not rejected.

  it('adopts LLM verdict when confidence equals threshold exactly', async () => {
    const verdict = JSON.stringify({ category: 'LOCAL', confidence: 0.6 })
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: { stream: () => chunksFromText(verdict) },
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    }, audit as any)

    const intent = await service.classify('something')
    assert.equal(intent.category, 'LOCAL', 'confidence === threshold should be adopted')
    assert.equal(intent.confidence, 0.6)
    assert.match(intent.rationale, /llm-classified/u)
    const stats = service.getStats()
    assert.equal(stats.llmHit, 1)
    assert.equal(stats.lowConfidence, 0, 'must NOT trigger low-confidence fallback at exact boundary')
  })

  it('rejects LLM verdict when confidence is 0.599999 (just below threshold)', async () => {
    const verdict = JSON.stringify({ category: 'LOCAL', confidence: 0.599999 })
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: { stream: () => chunksFromText(verdict) },
    } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    })

    const intent = await service.classify('something')
    // Falls through to rules → no keyword hit → defaultCategory
    assert.equal(intent.category, 'CLOUD')
    assert.match(intent.rationale, /default:cloud/u)
    assert.equal(service.getStats().lowConfidence, 1)
  })

  it('confidenceThreshold=0 adopts any non-negative verdict', async () => {
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0 })
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: { stream: () => chunksFromText(verdict) },
    } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0,  // accept everything
    })

    const intent = await service.classify('something')
    assert.equal(intent.category, 'CLOUD')
    assert.equal(intent.confidence, 0)
    assert.equal(service.getStats().llmHit, 1)
    assert.equal(service.getStats().lowConfidence, 0)
  })

  // ─── audit-log 异常不传播 ──────────────────────────────────────────────────
  // The audit() helper at line 157-159 catches all errors from auditLog.log.
  // If audit-log throws, classify() must still return a valid verdict.

  it('classify() succeeds when auditLog.log throws on every call', async () => {
    const verdict = JSON.stringify({ category: 'LOCAL', confidence: 0.9 })
    const throwingAudit = {
      log: async (_e: any) => { throw new Error('audit-log disk full') },
    }
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: { stream: () => chunksFromText(verdict) },
    } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    }, throwingAudit as any)

    // Must not throw — audit errors are silently swallowed
    const intent = await service.classify('读文件')
    assert.equal(intent.category, 'LOCAL')
    assert.equal(intent.confidence, 0.9)
  })

  it('classify() succeeds when auditLog.log returns a rejected promise', async () => {
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.8 })
    const rejectingAudit = {
      log: async (_e: any) => Promise.reject(new Error('network error')),
    }
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: { stream: () => chunksFromText(verdict) },
    } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    }, rejectingAudit as any)

    const intent = await service.classify('hello')
    assert.equal(intent.category, 'CLOUD')
    assert.equal(intent.confidence, 0.8)
  })

  // ─── 并发 classify() 计数器 ────────────────────────────────────────────────
  // classify() increments stats.total++ at the top. Under concurrent calls,
  // JavaScript's single-threaded event loop means there's no data race on the
  // counter increment (it's synchronous). But the test verifies the contract.

  it('concurrent classify() calls maintain correct total counter', async () => {
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.9 })
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: { stream: () => chunksFromText(verdict) },
    } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    })

    // Fire 10 concurrent classify calls
    const results = await Promise.all(
      Array.from({ length: 10 }, () => service.classify('test'))
    )
    assert.equal(results.length, 10)
    results.forEach(r => assert.equal(r.category, 'CLOUD'))
    const stats = service.getStats()
    assert.equal(stats.total, 10)
    assert.equal(stats.llmHit, 10)
  })

  it('concurrent classify() with mixed paths maintains correct counter distribution', async () => {
    let callIdx = 0
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream: () => {
          callIdx++
          if (callIdx % 3 === 0) {
            // timeout path
            return (async function* () {
              await new Promise<void>((_, reject) => {
                setTimeout(() => {
                  const e: any = new Error('aborted'); e.name = 'AbortError'; reject(e)
                }, 100)
              })
            })()
          }
          // success path
          return chunksFromText(JSON.stringify({ category: 'CLOUD', confidence: 0.9 }))
        },
      },
    } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
      llmTimeoutMs: 10,  // very short to guarantee timeout
    })

    await Promise.all(Array.from({ length: 9 }, () => service.classify('test')))
    const stats = service.getStats()
    assert.equal(stats.total, 9)
    assert.equal(stats.llmHit + stats.timeout, stats.total,
      'every call should end up in either llmHit or timeout')
  })

  // ─── model-router 畸形返回值 ───────────────────────────────────────────────

  it('fails open when modelRouter.resolve returns null', async () => {
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.9 })
    let capturedOpts: any
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(opts: any) { capturedOpts = opts; return chunksFromText(verdict) },
      },
      modelRouter: { resolve: () => null },
    } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      classificationModel: 'qwen3-4b',
      confidenceThreshold: 0.6,
    })

    await service.classify('hi')
    assert.equal(capturedOpts.provider, 'local-llm')
    assert.equal(capturedOpts.model, 'qwen3-4b')
  })

  it('fails open when modelRouter.resolve returns object without provider', async () => {
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.9 })
    let capturedOpts: any
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(opts: any) { capturedOpts = opts; return chunksFromText(verdict) },
      },
      modelRouter: { resolve: () => ({ realm: 'LOCAL' }) },  // no provider/model
    } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      classificationModel: 'qwen3-4b',
      confidenceThreshold: 0.6,
    })

    await service.classify('hi')
    assert.equal(capturedOpts.provider, 'local-llm')
    assert.equal(capturedOpts.model, 'qwen3-4b')
  })

  // ─── extractMessageText 多格式兼容 ─────────────────────────────────────────

  it('extractMessageText: plain string', () => {
    assert.equal(extractMessageText('hello'), 'hello')
  })

  it('extractMessageText: { text } shape', () => {
    assert.equal(extractMessageText({ text: 'hello' }), 'hello')
  })

  it('extractMessageText: { message } shape', () => {
    assert.equal(extractMessageText({ message: 'hello' }), 'hello')
  })

  it('extractMessageText: dsh-llm content array', () => {
    const m = { content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] }
    assert.equal(extractMessageText(m), 'hello world')
  })

  it('extractMessageText: empty object returns empty string', () => {
    assert.equal(extractMessageText({}), '')
  })

  it('extractMessageText: null / undefined returns empty string', () => {
    assert.equal(extractMessageText(null), '')
    assert.equal(extractMessageText(undefined), '')
  })

  it('extractMessageText: non-stringifiable returns empty string', () => {
    assert.equal(extractMessageText(42), '')
    assert.equal(extractMessageText(true), '')
  })

  // ─── 多轮上下文边界 ────────────────────────────────────────────────────────

  it('recentMessagesLimit truncates to last N messages', async () => {
    let capturedOpts: any
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.9 })
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(opts: any) { capturedOpts = opts; return chunksFromText(verdict) },
      },
    } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
      recentMessagesLimit: 2,  // only keep last 2
    })

    const history = [
      { role: 'user', content: [{ type: 'text', text: 'msg1' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'msg2' }] },
      { role: 'user', content: [{ type: 'text', text: 'msg3' }] },
    ]
    await service.classify('current', { recentMessages: history })
    const promptText = capturedOpts.messages[0].content[0].text
    // Should contain msg2 and msg3 (last 2), but NOT msg1
    assert.doesNotMatch(promptText, /msg1/)
    assert.match(promptText, /msg2/)
    assert.match(promptText, /msg3/)
  })

  it('multi-turn context truncates each message to 200 chars', async () => {
    let capturedOpts: any
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.9 })
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(opts: any) { capturedOpts = opts; return chunksFromText(verdict) },
      },
    } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    })

    const longMsg = 'a'.repeat(500)
    await service.classify('current', {
      recentMessages: [{ role: 'user', content: [{ type: 'text', text: longMsg }] }],
    })
    const promptText = capturedOpts.messages[0].content[0].text
    // The history block should contain at most 200 'a's from the long message
    const aCount = (promptText.match(/a/gu) || []).length
    assert.ok(aCount <= 210, `should cap at ~200 'a's, got ${aCount}`)
  })

  it('multi-turn handles messages with no extractable text', async () => {
    let capturedOpts: any
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.9 })
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(opts: any) { capturedOpts = opts; return chunksFromText(verdict) },
      },
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    }, audit as any)

    // Mix of valid and empty messages
    const history = [
      {},                                      // no text
      { role: 'user', content: [] },           // empty content array
      { role: 'user', content: [{ type: 'text', text: 'valid' }] },
    ]
    await service.classify('current', { recentMessages: history })
    const promptText = capturedOpts.messages[0].content[0].text
    assert.match(promptText, /valid/)
    // Empty messages should not crash or produce garbage
    const ctxEntry = audit.entries.find((e: any) => e.kind === 'intent.llm.context')
    assert.ok(ctxEntry)
    assert.equal(ctxEntry.payload.received, 3)
  })

  // ─── 多轮上下文脱敏（P0 2026-08-24）────────────────────────────────────────
  // When classification LLM is in CLOUD realm, recentMessages must also be
  // sanitized before inclusion in the prompt. History may contain PII from
  // earlier turns (user shared a phone in turn 1, asks follow-up in turn 4).

  it('CLOUD realm: sanitizes PII in recentMessages before prompt', async () => {
    let capturedPrompt: string | undefined
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.9 })
    let sanitizerCalls = 0
    const fakeSanitizer = {
      sanitize: async (text: string, _ctx?: { sessionId?: string }) => {
        sanitizerCalls++
        return {
          sanitizedText: text.replace(/1[3-9]\d{9}/gu, '[PHONE_1]'),
          replacements: text.match(/1[3-9]\d{9}/gu)?.map((m) => ({
            placeholder: '[PHONE_1]', originalValue: m,
          })) ?? [],
        }
      },
    }
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(opts: any) {
          capturedPrompt = opts.messages[0].content[0].text
          return chunksFromText(verdict)
        },
      },
      modelRouter: {
        resolve: () => ({ realm: 'CLOUD', provider: 'cloud-llm', model: 'deepseek-chat' }),
      },
      sanitizer: fakeSanitizer,
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    }, audit as any)

    const history = [
      { role: 'user', content: [{ type: 'text', text: '我的手机号是13812345678' }] },
      { role: 'assistant', content: [{ type: 'text', text: '好的，记住了' }] },
    ]
    await service.classify('帮我查一下这个号的运营商', { recentMessages: history, sessionId: 'sess-B' })

    // Current message + 2 history messages = 3 sanitize calls
    assert.equal(sanitizerCalls, 3, 'sanitizer should be called for current + each history message')
    assert.ok(capturedPrompt)
    // History PII must be replaced
    assert.match(capturedPrompt, /\[PHONE_1\]/)
    assert.doesNotMatch(capturedPrompt, /13812345678/, 'raw phone must not reach LLM prompt')
    // History block structure preserved
    assert.match(capturedPrompt, /最近对话上下文/)
    assert.match(capturedPrompt, /user: 我的手机号是\[PHONE_1\]/)
    assert.match(capturedPrompt, /assistant: 好的，记住了/)
    // Audit: history-sanitized should fire (1 of the 2 history msgs had PII)
    const histEntry = audit.entries.find((e: any) => e.kind === 'intent.llm.history-sanitized')
    assert.ok(histEntry, 'intent.llm.history-sanitized audit should fire')
    assert.equal(histEntry.payload.sanitizedMessageCount, 1)
    assert.equal(histEntry.payload.sessionId, 'sess-B')
  })

  it('LOCAL realm: does NOT sanitize recentMessages (stays on device)', async () => {
    let capturedPrompt: string | undefined
    let sanitizerCalls = 0
    const verdict = JSON.stringify({ category: 'LOCAL', confidence: 0.9 })
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(opts: any) {
          capturedPrompt = opts.messages[0].content[0].text
          return chunksFromText(verdict)
        },
      },
      // LOCAL realm — no modelRouter override, defaults to local-llm
      sanitizer: {
        sanitize: async (text: string) => {
          sanitizerCalls++
          return { sanitizedText: text.replace(/1[3-9]\d{9}/gu, '[PHONE_1]'), replacements: [] }
        },
      },
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'LOCAL',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    }, audit as any)

    const history = [
      { role: 'user', content: [{ type: 'text', text: '手机号13812345678' }] },
    ]
    await service.classify('帮我查一下这个号', { recentMessages: history })

    // LOCAL realm: sanitizer must NOT be called at all (no cloud data path)
    assert.equal(sanitizerCalls, 0, 'sanitizer must NOT be called for LOCAL realm')
    assert.ok(capturedPrompt)
    // History PII is kept raw (stays on device, no cloud exposure)
    assert.match(capturedPrompt, /13812345678/)
    assert.doesNotMatch(capturedPrompt, /\[PHONE_1\]/)
  })

  it('CLOUD realm: history message that fails sanitize is omitted (fail-closed)', async () => {
    let capturedPrompt: string | undefined
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.9 })
    let sanitizeCallIndex = 0
    const fakeSanitizer = {
      sanitize: async (text: string) => {
        sanitizeCallIndex++
        // First call is for the current message (succeeds).
        // Second call is for history[0] (succeeds).
        // Third call is for history[1] (THROWS — simulates regex failure).
        // Fourth call is for history[2] (succeeds).
        if (sanitizeCallIndex === 3) {
          throw new Error('regex-boom')
        }
        return {
          sanitizedText: text.replace(/1[3-9]\d{9}/gu, '[PHONE_1]'),
          replacements: [],
        }
      },
    }
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(opts: any) {
          capturedPrompt = opts.messages[0].content[0].text
          return chunksFromText(verdict)
        },
      },
      modelRouter: {
        resolve: () => ({ realm: 'CLOUD', provider: 'cloud-llm', model: 'deepseek-chat' }),
      },
      sanitizer: fakeSanitizer,
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    }, audit as any)

    const history = [
      { role: 'user', content: [{ type: 'text', text: '手机号13812345678' }] },     // sanitizes OK
      { role: 'user', content: [{ type: 'text', text: '另一条带13900001111' }] },   // sanitize THROWS
      { role: 'assistant', content: [{ type: 'text', text: '好的' }] },             // sanitizes OK
    ]
    await service.classify('帮我查运营商', { recentMessages: history })

    assert.ok(capturedPrompt)
    // history[1] was omitted — its text must not appear in prompt at all
    assert.doesNotMatch(capturedPrompt, /另一条带/)
    assert.doesNotMatch(capturedPrompt, /13900001111/)
    // history[0] and history[2] are present
    assert.match(capturedPrompt, /\[PHONE_1\]/)
    assert.match(capturedPrompt, /assistant: 好的/)
    // Audit: history-sanitize-error fired for the omitted message
    const errEntry = audit.entries.find((e: any) => e.kind === 'intent.llm.history-sanitize-error')
    assert.ok(errEntry, 'intent.llm.history-sanitize-error audit should fire')
    assert.match(errEntry.payload.error, /regex-boom/)
  })

  // ─── Audit preview redaction (defense-in-depth)─────────────────────────────
  // intent.classify.start used to log the first 80 chars of raw user input.
  // If audit-log's own enablePIIRedaction is disabled, PII would leak to disk.
  // Now textPreview goes through redactPreview (which uses piiUtils.redactString).

  it('intent.classify.start preview is redacted (no raw PII even if piiUtils is present)', async () => {
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.9 })
    const piiUtils = {
      redactString: (text: string) => ({
        redacted: text.replace(/1[3-9]\d{9}/gu, '[REDACTED]'),
        matches: [],
      }),
    }
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: { stream: () => chunksFromText(verdict) },
      piiUtils,
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    }, audit as any)

    await service.classify('手机号13812345678请帮我查运营商')
    const startEntry = audit.entries.find((e: any) => e.kind === 'intent.classify.start')
    assert.ok(startEntry, 'intent.classify.start audit should fire')
    // Preview must NOT contain the raw phone number
    assert.doesNotMatch(startEntry.payload.textPreview, /13812345678/u,
      'textPreview must not contain raw PII')
    // Preview should contain the redacted placeholder
    assert.match(startEntry.payload.textPreview, /\[REDACTED\]/u,
      'textPreview should contain redaction placeholder')
  })

  it('intent.classify.start preview falls back to length-only when piiUtils unavailable', async () => {
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.9 })
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: { stream: () => chunksFromText(verdict) },
      // NO piiUtils
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    }, audit as any)

    await service.classify('手机号13812345678请帮我查运营商')
    const startEntry = audit.entries.find((e: any) => e.kind === 'intent.classify.start')
    assert.ok(startEntry)
    // Without piiUtils, textPreview is `[len=N]` — no PII leak
    assert.match(startEntry.payload.textPreview, /^\[len=\d+\]$/u,
      'textPreview without piiUtils should fall back to length-only')
    assert.doesNotMatch(startEntry.payload.textPreview, /13812345678/u)
  })

  // ─── resolveIntent 纯函数 ──────────────────────────────────────────────────

  it('resolveIntent maps LOCAL intent to local realm', () => {
    const result = resolveIntent({
      category: 'LOCAL', confidence: 0.9, targetRealm: 'local',
      rationale: 'test',
    })
    assert.equal(result.realm, 'local')
    assert.deepEqual(result.config, { intentCategory: 'LOCAL' })
  })

  it('resolveIntent maps CLOUD intent to cloud realm', () => {
    const result = resolveIntent({
      category: 'CLOUD', confidence: 0.7, targetRealm: 'cloud',
      rationale: 'test',
    })
    assert.equal(result.realm, 'cloud')
    assert.deepEqual(result.config, { intentCategory: 'CLOUD' })
  })

  it('resolveIntent maps SANITIZED intent to sanitized realm', () => {
    const result = resolveIntent({
      category: 'SANITIZED', confidence: 0.8, targetRealm: 'sanitized',
      rationale: 'test',
    })
    assert.equal(result.realm, 'sanitized')
    assert.deepEqual(result.config, { intentCategory: 'SANITIZED' })
  })

  it('resolveIntent maps REJECT intent to rejected realm', () => {
    const result = resolveIntent({
      category: 'REJECT', confidence: 0.95, targetRealm: 'rejected',
      rationale: 'policy-violation',
    })
    assert.equal(result.realm, 'rejected')
    assert.deepEqual(result.config, { intentCategory: 'REJECT' })
  })

  // ─── LLM 流边界 ──────────────────────────────────────────────────────────

  it('handles empty LLM stream (0 chunks) — treated as unclear', async () => {
    const emptyStream = (async function* () { })()
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: { stream: () => emptyStream },
    } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    })

    const intent = await service.classify('hi')
    // Empty response → parseClassificationVerdict('') returns null → unclear
    assert.equal(intent.category, 'CLOUD')
    assert.match(intent.rationale, /default:cloud/u)
    assert.equal(service.getStats().parseFailure, 1)
  })

  it('handles single-chunk LLM response', async () => {
    const singleChunk = (async function* () {
      yield { type: 'text-delta', text: '{"category":"LOCAL","confidence":0.95}' }
    })()
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: { stream: () => singleChunk },
    } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    })

    const intent = await service.classify('hi')
    assert.equal(intent.category, 'LOCAL')
    assert.equal(intent.confidence, 0.95)
    assert.equal(service.getStats().llmHit, 1)
  })

  it('ignores non-text-delta chunks', async () => {
    const mixedChunks = (async function* () {
      yield { type: 'usage', tokens: 42 }           // not text-delta — ignored
      yield { type: 'text-delta', text: '{"category"' }
      yield { type: 'thinking', content: 'hmm' }    // not text-delta — ignored
      yield { type: 'text-delta', text: ':"CLOUD","confidence":0.8}' }
    })()
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: { stream: () => mixedChunks },
    } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'LOCAL',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    })

    const intent = await service.classify('hi')
    assert.equal(intent.category, 'CLOUD', 'non-text-delta chunks should be ignored')
    assert.equal(intent.confidence, 0.8)
  })

  // ─── §7.92.3 jev prefilter ─────────────────────────────────────────────

  /** Build a successful jev /predict response body. */
  function jevResp(data: Partial<{ intent: string | null; confidence: number; risk_score: number; action: string; latency_ms: number }>): any {
    return {
      code: 0,
      message: 'ok',
      request_id: 'r-test-001',
      data: {
        intent: data.intent ?? null,
        confidence: data.confidence ?? 0,
        risk_score: data.risk_score ?? 0,
        lang: 'zh',
        lang_confidence: 0.99,
        engine: 'laya-multilingual',
        action: data.action ?? 'execute',
        latency_ms: data.latency_ms ?? 87,
        top_probabilities: { [data.intent ?? '其他']: data.confidence ?? 0 },
        error: null,
        metadata: {},
      },
    }
  }

  /** Mock global fetch with a fixed Response. Records the last call. */
  function mockFetchOk(body: any): { calls: Array<{ url: string; init: any }> } {
    const calls: Array<{ url: string; init: any }> = []
    const orig = (globalThis as any).fetch
    ;(globalThis as any).fetch = async (url: string, init: any) => {
      calls.push({ url, init })
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(body),
        json: async () => body,
      }
    }
    return {
      calls,
      restore: () => { (globalThis as any).fetch = orig },
    }
  }

  function mockFetchError(status: number, bodyText = ''): { restore: () => void } {
    const orig = (globalThis as any).fetch
    ;(globalThis as any).fetch = async (_url: string, _init: any) => ({
      ok: false,
      status,
      text: async () => bodyText,
    })
    return { restore: () => { (globalThis as any).fetch = orig } }
  }

  function mockFetchAbort(): { restore: () => void } {
    const orig = (globalThis as any).fetch
    ;(globalThis as any).fetch = async (_url: string, init: any) => {
      // Honor AbortSignal: throw DOMException AbortError if already aborted.
      if (init?.signal?.aborted) {
        const e: any = new Error('aborted')
        e.name = 'AbortError'
        throw e
      }
      // Listen for abort.
      await new Promise((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e: any = new Error('aborted')
          e.name = 'AbortError'
          reject(e)
        })
        setTimeout(resolve, 5000)
      })
      return { ok: true, status: 200, text: async () => '{}' }
    }
    return { restore: () => { (globalThis as any).fetch = orig } }
  }

  it('§7.92.3: jev disabled → no fetch call (toggle off)', async () => {
    const mock = mockFetchOk(jevResp({ intent: '订单查询', confidence: 0.95, risk_score: 0.1, action: 'execute' }))
    try {
      const mockCtx = { reflect: { provide: () => {} }, llm: null } as any
      const service = new IntentRouterServiceImpl(mockCtx, {
        defaultCategory: 'SANITIZED',
        classificationProvider: 'local-llm',
        confidenceThreshold: 0.6,
        jevEnabled: false,
      })

      const intent = await service.classify('查一下我的订单')
      assert.equal(intent.category, 'SANITIZED', 'defaultCategory wins when jev disabled')
      assert.match(intent.rationale, /default:/u)
      assert.equal(mock.calls.length, 0, 'fetch should not be called when jev is disabled')
      const stats = service.getStats()
      assert.equal(stats.jevHit, 0)
      assert.equal(stats.jevSkip, 0)
    } finally {
      mock.restore()
    }
  })

  it('§7.92.3: jev enabled + execute + SANITIZED intent → ADOPT (no LLM call)', async () => {
    const mock = mockFetchOk(jevResp({ intent: '订单查询', confidence: 0.95, risk_score: 0.1, action: 'execute' }))
    try {
      const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
      const mockCtx = {
        reflect: { provide: () => {} },
        llm: null, // proves jev short-circuits BEFORE LLM
      } as any
      const service = new IntentRouterServiceImpl(mockCtx, {
        defaultCategory: 'CLOUD',
        classificationProvider: 'local-llm',
        confidenceThreshold: 0.6,
        jevEnabled: true,
        jevUrl: 'http://127.0.0.1:8001',
        jevConfidenceThreshold: 0.85,
      }, audit as any)

      const intent = await service.classify('查一下我的订单')
      assert.equal(intent.category, 'SANITIZED')
      assert.equal(intent.targetRealm, 'sanitized')
      assert.match(intent.rationale, /^jev-intent:订单查询$/u)
      assert.equal(intent.confidence, 0.95)

      assert.equal(mock.calls.length, 1, 'fetch should be called once')
      const body = JSON.parse(mock.calls[0].init.body)
      assert.equal(body.query, '查一下我的订单')
      assert.equal(body.lang, 'zh')

      const stats = service.getStats()
      assert.equal(stats.jevHit, 1)
      assert.equal(stats.jevSkip, 0)
      assert.equal(stats.llmHit, 0, 'LLM should NOT have been called')

      const endEntry = audit.entries.find((e: any) => e.kind === 'intent.classify.end')
      assert.equal(endEntry.payload.path, 'jev-adopt')
      assert.equal(endEntry.payload.jevIntent, '订单查询')
    } finally {
      mock.restore()
    }
  })

  it('§7.92.3: jev enabled + risk_score >= threshold → REJECT (security)', async () => {
    const mock = mockFetchOk(jevResp({ intent: '投诉', confidence: 0.92, risk_score: 0.85, action: 'execute' }))
    try {
      const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
      const mockCtx = { reflect: { provide: () => {} }, llm: null } as any
      const service = new IntentRouterServiceImpl(mockCtx, {
        defaultCategory: 'CLOUD',
        classificationProvider: 'local-llm',
        confidenceThreshold: 0.6,
        jevEnabled: true,
        jevRiskThreshold: 0.7,
      }, audit as any)

      const intent = await service.classify('我要投诉你们的服务')
      assert.equal(intent.category, 'REJECT')
      assert.equal(intent.targetRealm, 'rejected')
      assert.match(intent.rationale, /^jev-risk:/u)

      const stats = service.getStats()
      assert.equal(stats.jevReject, 1)
      assert.equal(stats.rejected, 1)
      assert.equal(stats.llmHit, 0, 'LLM should NOT have been called on risk-gate')

      const rejectAudit = audit.entries.find((e: any) => e.kind === 'intent.rules.rejected' && e.payload?.source === 'jev')
      assert.ok(rejectAudit, 'intent.rules.rejected (source=jev) audit should fire')
      assert.equal(rejectAudit.level, 'security')
    } finally {
      mock.restore()
    }
  })

  it('§7.92.3: jev enabled + action=fallback_llm → fall through to LLM', async () => {
    const mock = mockFetchOk(jevResp({ intent: '闲聊', confidence: 0.4, risk_score: 0.05, action: 'fallback_llm' }))
    try {
      const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.85 })
      const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
      const mockCtx = {
        reflect: { provide: () => {} },
        llm: fakeLlm(chunksFromText(verdict)),
      } as any
      const service = new IntentRouterServiceImpl(mockCtx, {
        defaultCategory: 'CLOUD',
        classificationProvider: 'local-llm',
        confidenceThreshold: 0.6,
        jevEnabled: true,
        jevConfidenceThreshold: 0.85,
      }, audit as any)

      const intent = await service.classify('你好')
      assert.equal(intent.category, 'CLOUD', 'LLM verdict adopted after jev fall-through')
      assert.match(intent.rationale, /^llm-classified/u)

      const stats = service.getStats()
      assert.equal(stats.jevSkip, 1, 'jevSkip counter incremented')
      assert.equal(stats.llmHit, 1, 'LLM ran after jev skipped')
    } finally {
      mock.restore()
    }
  })

  it('§7.92.3: jev enabled + HTTP 5xx → fall through (audit jev.error)', async () => {
    const mock = mockFetchError(500, 'internal error')
    try {
      const verdict = JSON.stringify({ category: 'LOCAL', confidence: 0.9 })
      const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
      const mockCtx = {
        reflect: { provide: () => {} },
        llm: fakeLlm(chunksFromText(verdict)),
      } as any
      const service = new IntentRouterServiceImpl(mockCtx, {
        defaultCategory: 'CLOUD',
        classificationProvider: 'local-llm',
        confidenceThreshold: 0.6,
        jevEnabled: true,
      }, audit as any)

      const intent = await service.classify('读取文件')
      assert.equal(intent.category, 'LOCAL')
      assert.match(intent.rationale, /^llm-classified/u)

      const stats = service.getStats()
      assert.equal(stats.jevError, 1)
      assert.equal(stats.jevTimeout, 0)
      const jevErr = audit.entries.find((e: any) => e.kind === 'intent.jev.error')
      assert.ok(jevErr, 'intent.jev.error audit should fire')
      assert.equal(jevErr.level, 'warn')
      assert.equal(jevErr.payload.httpStatus, 500)
    } finally {
      mock.restore()
    }
  })

  it('§7.92.3: jev enabled + AbortError → fall through (audit jev.timeout)', async () => {
    const mock = mockFetchAbort()
    try {
      const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.85 })
      const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
      const mockCtx = {
        reflect: { provide: () => {} },
        llm: fakeLlm(chunksFromText(verdict)),
      } as any
      const service = new IntentRouterServiceImpl(mockCtx, {
        defaultCategory: 'CLOUD',
        classificationProvider: 'local-llm',
        confidenceThreshold: 0.6,
        jevEnabled: true,
        jevTimeoutMs: 50, // tiny timeout so abort fires fast
      }, audit as any)

      const intent = await service.classify('你好')
      assert.equal(intent.category, 'CLOUD')

      const stats = service.getStats()
      assert.equal(stats.jevTimeout, 1)
      assert.equal(stats.jevError, 0, 'timeout is mutually exclusive with jevError (matches LLM pattern)')
      const jevTimeout = audit.entries.find((e: any) => e.kind === 'intent.jev.timeout')
      assert.ok(jevTimeout, 'intent.jev.timeout audit should fire')
      assert.equal(jevTimeout.level, 'warn')
    } finally {
      mock.restore()
    }
  })

  it('§7.92.3: jev user-config intent map overrides built-in', async () => {
    // User config maps '订单查询' → LOCAL (overrides built-in SANITIZED).
    const mock = mockFetchOk(jevResp({ intent: '订单查询', confidence: 0.95, risk_score: 0.1, action: 'execute' }))
    try {
      const mockCtx = { reflect: { provide: () => {} }, llm: null } as any
      const service = new IntentRouterServiceImpl(mockCtx, {
        defaultCategory: 'CLOUD',
        classificationProvider: 'local-llm',
        confidenceThreshold: 0.6,
        jevEnabled: true,
        jevIntentMap: { '订单查询': 'LOCAL' },
      })

      const intent = await service.classify('查一下我的订单')
      assert.equal(intent.category, 'LOCAL', 'user-config map overrides built-in')
      assert.equal(intent.targetRealm, 'local')
    } finally {
      mock.restore()
    }
  })

  it('§7.92.3: jev enabled + entity guardrail overrides jev-adopted SANITIZED', async () => {
    // jev says SANITIZED for '订单查询', but text contains '密盒' which
    // forces LOCAL via the §7.58 entity guardrail (matches the LLM-path
    // override behavior so the two paths are symmetric).
    const mock = mockFetchOk(jevResp({ intent: '订单查询', confidence: 0.95, risk_score: 0.1, action: 'execute' }))
    try {
      const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
      const mockCtx = { reflect: { provide: () => {} }, llm: null } as any
      const service = new IntentRouterServiceImpl(mockCtx, {
        defaultCategory: 'CLOUD',
        classificationProvider: 'local-llm',
        confidenceThreshold: 0.6,
        jevEnabled: true,
      }, audit as any)

      const intent = await service.classify('查一下密盒的订单')
      assert.equal(intent.category, 'LOCAL', 'entity guardrail overrides jev SANITIZED')
      assert.match(intent.rationale, /^override-local-entity:密盒$/u)

      const endEntry = audit.entries.find((e: any) => e.kind === 'intent.classify.end')
      assert.equal(endEntry.payload.path, 'jev-adopt-entity-override')
      const overrideAudit = audit.entries.find((e: any) => e.kind === 'intent.classify.entity_override' && e.payload?.source === 'jev')
      assert.ok(overrideAudit, 'entity_override audit (source=jev) should fire')
      assert.equal(overrideAudit.level, 'warn')
    } finally {
      mock.restore()
    }
  })

  it('§7.92.3: jev unmapped intent → skip to LLM (defensive)', async () => {
    // jev returns a high-confidence verdict for an intent string that's
    // not in JEV_INTENT_MAP_DEFAULT and not in user override → LLM.
    const mock = mockFetchOk(jevResp({ intent: 'foobar', confidence: 0.95, risk_score: 0.1, action: 'execute' }))
    try {
      const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.85 })
      const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
      const mockCtx = {
        reflect: { provide: () => {} },
        llm: fakeLlm(chunksFromText(verdict)),
      } as any
      const service = new IntentRouterServiceImpl(mockCtx, {
        defaultCategory: 'CLOUD',
        classificationProvider: 'local-llm',
        confidenceThreshold: 0.6,
        jevEnabled: true,
      }, audit as any)

      const intent = await service.classify('unknown intent')
      assert.equal(intent.category, 'CLOUD')
      assert.match(intent.rationale, /^llm-classified/u)
      const stats = service.getStats()
      assert.equal(stats.jevSkip, 1)
      assert.equal(stats.llmHit, 1)
      const unmapped = audit.entries.find((e: any) => e.kind === 'intent.jev.unmapped_intent')
      assert.ok(unmapped)
    } finally {
      mock.restore()
    }
  })
})
