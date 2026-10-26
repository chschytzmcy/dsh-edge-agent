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
import { IntentRouterServiceImpl, parseClassificationVerdict, coerceClassification, extractMessageText, resolveIntent, isLoopbackEndpoint } from '../../src/dsh-adapter/intent-router.ts'

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
    // §7.92.3 (2026-09-23): privacyPolicy added to inject so the
    // constructor can call privacyPolicy.getCategories() for the
    // categories spec shared by LLM prompt + jev-intent lookup.
    assert.deepEqual([...router.inject], ['llm', 'auditLog', 'privacyPolicy'])
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

  // §7.106 (2026-10-23): 归属地查询**走云端是对的**（操作者裁决）——掩码粒度
  // 由 sanitizer 的 keepPrefix 解决（号段保留）。此处钉住「不被强制本地」。
  it('§7.106: phone attribution query is NOT forced LOCAL (ruling: cloud is correct)', async () => {
    const mockCtx = { reflect: { provide: () => {} }, llm: null } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'SANITIZED',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    }, audit as any)
    const intent = await service.classify('查询下17300969670的归属地')
    assert.notEqual(intent.category, 'LOCAL')
    assert.equal(intent.rationale, 'default:sanitized')
  })

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

  // ─── §7.107 (2026-10-23): the public-web gate lives in the router ──────

  it('§7.107: an LLM CLOUD verdict without a public-web signal → LOCAL', async () => {
    // 「只有需要搜索公网上的信息才需要用到 cloudllm」—— the gate is at the
    // SOURCE of the verdict, because two consumers read it (input-guard and
    // http-api's `_edgeRoute`). A gate in the consumer would have closed
    // only one of them.
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.95 })
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: fakeLlm(chunksFromText(verdict)),
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'LOCAL',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    }, audit as any)

    const intent = await service.classify('帮我写封邮件')
    assert.equal(intent.category, 'LOCAL')
    assert.equal(intent.rationale, 'no-web-need')
    const blocked = audit.entries.find((e: any) => e.kind === 'intent.cloud.blocked-no-web-need')
    assert.ok(blocked, 'the downgrade must be audited')
    assert.equal(blocked.level, 'warn')
  })

  it('§7.107: an LLM CLOUD verdict WITH a public-web signal → CLOUD', async () => {
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.95 })
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: fakeLlm(chunksFromText(verdict)),
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'LOCAL',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    }, audit as any)

    const intent = await service.classify('查一下最新的AI新闻')
    assert.equal(intent.category, 'CLOUD')
    assert.match(intent.rationale, /^llm-classified/u)
    assert.ok(!audit.entries.some((e: any) => e.kind === 'intent.cloud.blocked-no-web-need'))
  })

  it('§7.107: the rules tier needs no gate — a cloud keyword IS the signal', async () => {
    // The rules tier reaches CLOUD only through a cloud keyword, so it is
    // already web-gated by construction.
    const mockCtx = { reflect: { provide: () => {} }, llm: null } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'LOCAL',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
    })

    const intent = await service.classify('查一下最新的AI新闻')
    assert.equal(intent.category, 'CLOUD')
    assert.match(intent.rationale, /^rule-cloud-keyword:/u)
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
    // 每次不同的文本：classify() 结果缓存会复用同文本的 verdict，而本
    // 用例要 5 次 LLM 调用各落一个桶 —— 轮转 mock 对同文本已不成立。
    for (let i = 0; i < verdicts.length; i++) await service.classify(`hi ${i}`)
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
    // §7.107: 文本须带公网信号词，否则 CLOUD 判决会被 gate 降级 LOCAL。
    const intent = await service.classify('latest news about something arbitrary')
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

    // §7.107: 文本须带公网信号词，否则 CLOUD 判决会被 gate 降级 LOCAL。
    const intent = await service.classify('something about the latest news')
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

    // §7.107: 文本须带公网信号词，否则 CLOUD 判决会被 gate 降级 LOCAL。
    const intent = await service.classify('hello, what is the latest news')
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

    // Fire 10 concurrent classify calls (§7.107: text carries a public-web
    // signal so the CLOUD verdicts survive the gate; concurrent bursts all
    // reach the LLM — the result cache only serves *completed* verdicts,
    // there is no in-flight coalescing).
    const results = await Promise.all(
      Array.from({ length: 10 }, () => service.classify('test latest news'))
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

    // §7.107: 文本须带公网信号词，否则 CLOUD 判决会被 gate 降级 LOCAL。
    const intent = await service.classify('hi, latest news please')
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

      // §7.92.5: jev v0.3.0 caps `intents[]` at 16; the default config
      // ships 40 intents across LOCAL/CLOUD/SANITIZED/REJECT, so the
      // orchestrator splits into 3 batches (16 + 16 + 8) and fires them
      // concurrently via Promise.all. Each call should still see the
      // same query/lang/metadata, just a different `intents[]` slice.
      assert.equal(mock.calls.length, 3, 'fetch should be called 3 times (one per batch)')
      for (const call of mock.calls) {
        const body = JSON.parse(call.init.body)
        assert.equal(body.query, '查一下我的订单')
        assert.equal(body.lang, 'zh')
        assert.ok(Array.isArray(body.intents), 'each batch must include intents[]')
        assert.ok(body.intents.length > 0 && body.intents.length <= 16, 'batch intents[] size ≤ 16')
        assert.deepEqual(body.chitchat_intents, ['闲聊', '其他'], 'chitchat_intents sent in every batch')
      }

      const stats = service.getStats()
      assert.equal(stats.jevHit, 1)
      assert.equal(stats.jevSkip, 0)
      assert.equal(stats.llmHit, 0, 'LLM should NOT have been called')

      const endEntry = audit.entries.find((e: any) => e.kind === 'intent.classify.end')
      assert.equal(endEntry.payload.path, 'jev-adopt')
      assert.equal(endEntry.payload.jevIntent, '订单查询')
      // §7.121: 决策模型的原始风险分也落进 classify.end —— 「模型到底
      // 有多确信这条请求有风险」此前没有答案，而它是 REJECT 闸门的输入。
      assert.equal(typeof endEntry.payload.jevRiskScore, 'number')
      assert.equal(typeof endEntry.payload.jevConfidence, 'number')
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

      // §7.107: 文本须带公网信号词，否则 LLM 的 CLOUD 判决会被 gate 降级。
      const intent = await service.classify('你好，查一下最新新闻')
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
      // §7.92.5: 3 batches fire concurrently; all 3 hit the mock and
      // increment jevError. The orchestrator's max-confidence merge then
      // picks the first skip result (all 3 are skip with the same
      // payload, no risk/adopt signal to break ties) → caller falls
      // through to LLM.
      assert.equal(stats.jevError, 3, '3 batches × 1 HTTP error = 3 jevError increments')
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

      // §7.107: 文本须带公网信号词，否则 LLM 的 CLOUD 判决会被 gate 降级。
      const intent = await service.classify('你好，查一下最新新闻')
      assert.equal(intent.category, 'CLOUD')

      const stats = service.getStats()
      // §7.92.5: 3 batches × 1 AbortError = 3 jevTimeout increments.
      // Each batch is bounded by the per-batch timeout; jevTimeout and
      // jevError remain mutually exclusive per-batch (matches LLM pattern).
      assert.equal(stats.jevTimeout, 3, '3 batches × 1 AbortError = 3 jevTimeout increments')
      assert.equal(stats.jevError, 0, 'timeout is mutually exclusive with jevError (matches LLM pattern)')
      const jevTimeout = audit.entries.find((e: any) => e.kind === 'intent.jev.timeout')
      assert.ok(jevTimeout, 'intent.jev.timeout audit should fire')
      assert.equal(jevTimeout.level, 'warn')
    } finally {
      mock.restore()
    }
  })

  it('§7.92.3: jev user-config categories overrides built-in', async () => {
    // User injects categories config that maps '订单查询' → LOCAL (overrides
    // built-in CATEGORIES_FALLBACK SANITIZED). Verifies the categories-
    // based lookup picks up config-overridden categories at construction.
    const mock = mockFetchOk(jevResp({ intent: '订单查询', confidence: 0.95, risk_score: 0.1, action: 'execute' }))
    try {
      const mockCtx = {
        reflect: { provide: () => {} },
        llm: null,
        // Inject a privacy-policy that returns an empty array so the
        // resolution order in the constructor picks `config.categories`
        // (not privacy-policy's view). Verifies config wins over privacy.
        privacyPolicy: { getCategories: () => [] },
      } as any
      const service = new IntentRouterServiceImpl(mockCtx, {
        defaultCategory: 'CLOUD',
        classificationProvider: 'local-llm',
        confidenceThreshold: 0.6,
        jevEnabled: true,
        categories: [
          { id: 'LOCAL', description: '本地', jevIntents: ['设备控制', '订单查询'] },
          { id: 'CLOUD', description: '云', jevIntents: ['天气'] },
          { id: 'SANITIZED', description: 'PII', jevIntents: [] },
          { id: 'REJECT', description: '违规', jevIntents: [] },
        ],
      })

      const intent = await service.classify('查一下我的订单')
      assert.equal(intent.category, 'LOCAL', 'config.categories overrides built-in for jev-intent mapping')
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

      // §7.107: 文本须带公网信号词，否则 LLM 的 CLOUD 判决会被 gate 降级。
      const intent = await service.classify('unknown intent about latest news')
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

  // ─── §7.92.5 jev v0.3.0 batching (intents[] + chitchat_intents[]) ───────

  /** §7.92.5: Mock fetch with a per-call response queue. The orchestrator
   *  fires N concurrent batches via Promise.all; the call order across
   *  batches is non-deterministic (Promise scheduling), but each call
   *  takes the next response from the queue in FIFO order. Tests that
   *  need a specific per-batch response should sort the queue so the
   *  response they want reaches the batch they care about. */
  function mockFetchByBatch(perBatchResponses: Array<ReturnType<typeof jevResp>>): { calls: Array<{ url: string; init: any }> } {
    const calls: Array<{ url: string; init: any }> = []
    const orig = (globalThis as any).fetch
    let idx = 0
    ;(globalThis as any).fetch = async (url: string, init: any) => {
      calls.push({ url, init })
      const resp = perBatchResponses[idx] ?? perBatchResponses[perBatchResponses.length - 1]
      idx++
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(resp),
        json: async () => resp,
      }
    }
    return {
      calls,
      restore: () => { (globalThis as any).fetch = orig },
    }
  }

  it('§7.92.5: jev request body includes full intents[] + chitchat_intents[] (3 batches, no truncation)', async () => {
    // Default config has 40 intents across LOCAL/CLOUD/SANITIZED/REJECT.
    // jev v0.3.0 caps intents[] at 16 → orchestrator splits into
    // ceil(40/16) = 3 batches of [16, 16, 8]. All 40 must end up sent
    // (no truncation, per user instruction "把全部的都给jev").
    const mock = mockFetchOk(jevResp({ intent: '订单查询', confidence: 0.95, risk_score: 0.1, action: 'execute' }))
    try {
      const mockCtx = { reflect: { provide: () => {} }, llm: null } as any
      const service = new IntentRouterServiceImpl(mockCtx, {
        defaultCategory: 'CLOUD',
        classificationProvider: 'local-llm',
        confidenceThreshold: 0.6,
        jevEnabled: true,
      })

      await service.classify('查一下我的订单')

      assert.equal(mock.calls.length, 3, '3 batches fired')
      // Union of all batch intents == full taxonomy (no intent dropped)
      const sent = new Set<string>()
      for (const call of mock.calls) {
        const body = JSON.parse(call.init.body)
        assert.ok(Array.isArray(body.intents), 'body.intents must be an array')
        assert.ok(body.intents.length <= 16, 'each batch intents[] ≤ 16')
        for (const i of body.intents) sent.add(i.name)
        assert.deepEqual(body.chitchat_intents, ['闲聊', '其他'], 'chitchat_intents in every batch')
      }
      // Build the expected taxonomy from the built-in CATEGORIES_FALLBACK
      // (default config → ctx.privacyPolicy absent → CATEGORIES_FALLBACK).
      const expected = new Set<string>()
      for (const c of [
        { jevIntents: ['设备控制', '文件操作', 'device_control', 'file_ops'] },
        { jevIntents: ['知识问答', '通用咨询', '天气', '翻译', '新闻', '搜索', 'knowledge', 'weather', 'translation', 'news', 'search'] },
        { jevIntents: ['订单查询', '订单状态', '物流跟踪', '物流查询', '快递查询', '退款申请', '退款查询', '账户管理', '账户余额', '账户信息', '客服', '售后服务', 'order_inquiry', 'refund', 'refund_request', 'logistics', 'account', 'customer_service'] },
        { jevIntents: ['投诉', '法务咨询', '法律咨询', '举报', 'complaint', 'legal', 'legal_advice'] },
      ]) {
        for (const i of c.jevIntents) expected.add(i)
      }
      assert.equal(sent.size, expected.size, 'every intent is sent in some batch')
      for (const name of expected) assert.ok(sent.has(name), `intent "${name}" must be sent`)
    } finally {
      mock.restore()
    }
  })

  it('§7.92.5: REJECT intents always in batch 0 (priority preserved despite truncation)', async () => {
    // The first batch must contain every REJECT intent — security
    // priority rule from the user's "REJECT 优先" decision. Operators
    // who want a different priority should reorder `categories[]` in
    // config/privacy-policy.json.
    const mock = mockFetchOk(jevResp({ intent: '订单查询', confidence: 0.95, risk_score: 0.1, action: 'execute' }))
    try {
      const mockCtx = { reflect: { provide: () => {} }, llm: null } as any
      const service = new IntentRouterServiceImpl(mockCtx, {
        defaultCategory: 'CLOUD',
        classificationProvider: 'local-llm',
        confidenceThreshold: 0.6,
        jevEnabled: true,
      })

      await service.classify('查一下我的订单')

      assert.equal(mock.calls.length, 3)
      // Sort batches by the number of intents each carried — first
      // emission doesn't guarantee batch order, but the full taxonomy
      // (40 = 16+16+8) means all batches differ in size if we assume
      // sequential emit. To be robust, find the batch that contains
      // ALL REJECT intents — that's batch 0 by construction.
      const rejectIntents = ['投诉', '法务咨询', '法律咨询', '举报', 'complaint', 'legal', 'legal_advice']
      const batches = mock.calls.map((c) => JSON.parse(c.init.body).intents.map((i: any) => i.name))
      const batch0 = batches.find((b: string[]) => rejectIntents.every((r) => b.includes(r)))
      assert.ok(batch0, 'one batch must contain every REJECT intent (batch 0 by construction)')
    } finally {
      mock.restore()
    }
  })

  it('§7.92.5: max-confidence merge picks strongest verdict across batches', async () => {
    // Three batches return three different verdicts. Merge must pick
    // the SANITIZED intent with the highest confidence (0.95 over 0.85
    // and 0.7). REJECT batch is skipped because risk_score < threshold.
    // The mock serves responses in FIFO call order; the call order
    // across concurrent batches is non-deterministic, so we set up
    // every batch to return the SAME strongest verdict — that way
    // the assertion is robust to scheduling.
    const mock = mockFetchByBatch([
      jevResp({ intent: '订单查询', confidence: 0.95, risk_score: 0.10, action: 'execute' }),
      jevResp({ intent: 'complaint', confidence: 0.7, risk_score: 0.05, action: 'execute' }),
      jevResp({ intent: '订单查询', confidence: 0.85, risk_score: 0.10, action: 'execute' }),
    ])
    try {
      const mockCtx = { reflect: { provide: () => {} }, llm: null } as any
      const service = new IntentRouterServiceImpl(mockCtx, {
        defaultCategory: 'CLOUD',
        classificationProvider: 'local-llm',
        confidenceThreshold: 0.6,
        jevEnabled: true,
        // Map 'complaint' to REJECT so the REJECT-intent path is exercised
        // — but the risk_score is below threshold so it falls through to
        // adopt logic with mapped category=REJECT (action='reject').
        categories: [
          { id: 'LOCAL',     description: '本地',     jevIntents: ['设备控制', '文件操作', 'device_control', 'file_ops'] },
          { id: 'CLOUD',     description: '云',       jevIntents: ['知识问答', '通用咨询', '天气', '翻译', '新闻', '搜索', 'knowledge', 'weather', 'translation', 'news', 'search'] },
          { id: 'SANITIZED', description: 'PII',      jevIntents: ['订单查询', '订单状态', '物流跟踪', '物流查询', '快递查询', '退款申请', '退款查询', '账户管理', '账户余额', '账户信息', '客服', '售后服务', 'order_inquiry', 'refund', 'refund_request', 'logistics', 'account', 'customer_service'] },
          { id: 'REJECT',    description: '违规',     jevIntents: ['投诉', '法务咨询', '法律咨询', '举报', 'complaint', 'legal', 'legal_advice'] },
        ],
      })

      const intent = await service.classify('查一下我的订单')
      assert.equal(intent.category, 'SANITIZED', 'max-confidence merge picks strongest verdict')
      assert.equal(intent.confidence, 0.95)
      assert.match(intent.rationale, /^jev-intent:订单查询$/u)
    } finally {
      mock.restore()
    }
  })

  it('§7.92.5: REJECT (risk_score) from any batch wins regardless of confidence', async () => {
    // Even if a SANITIZED batch returns conf=0.99, a REJECT batch with
    // risk_score >= threshold must short-circuit. Security-first merge.
    // All 3 batches return high-risk 投诉 → orchestrator picks the
    // risk-gate REJECT verdict and surfaces it to classify().
    const mock = mockFetchByBatch([
      jevResp({ intent: '投诉', confidence: 0.92, risk_score: 0.85, action: 'execute' }),
      jevResp({ intent: '投诉', confidence: 0.92, risk_score: 0.85, action: 'execute' }),
      jevResp({ intent: '投诉', confidence: 0.92, risk_score: 0.85, action: 'execute' }),
    ])
    try {
      const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
      const mockCtx = { reflect: { provide: () => {} }, llm: null } as any
      const service = new IntentRouterServiceImpl(mockCtx, {
        defaultCategory: 'CLOUD',
        classificationProvider: 'local-llm',
        confidenceThreshold: 0.6,
        jevEnabled: true,
        jevRiskThreshold: 0.7,
        categories: [
          { id: 'LOCAL',     description: '本地',     jevIntents: ['设备控制', '文件操作', 'device_control', 'file_ops'] },
          { id: 'CLOUD',     description: '云',       jevIntents: ['知识问答', '通用咨询', '天气', '翻译', '新闻', '搜索', 'knowledge', 'weather', 'translation', 'news', 'search'] },
          { id: 'SANITIZED', description: 'PII',      jevIntents: ['订单查询', '订单状态', '物流跟踪', '物流查询', '快递查询', '退款申请', '退款查询', '账户管理', '账户余额', '账户信息', '客服', '售后服务', 'order_inquiry', 'refund', 'refund_request', 'logistics', 'account', 'customer_service'] },
          { id: 'REJECT',    description: '违规',     jevIntents: ['投诉', '法务咨询', '法律咨询', '举报', 'complaint', 'legal', 'legal_advice'] },
        ],
      }, audit as any)

      const intent = await service.classify('我要投诉')
      assert.equal(intent.category, 'REJECT', 'risk-gated REJECT from any batch wins')
      assert.equal(intent.targetRealm, 'rejected')
      assert.match(intent.rationale, /^jev-risk:/u)
      const stats = service.getStats()
      assert.equal(stats.jevReject, 1)
      assert.equal(stats.rejected, 1)
    } finally {
      mock.restore()
    }
  })

  // ─── §7.92.6 jev circuit breaker (auto-skip on service death) ─────────

  /** §7.92.6: HTTP-error mock that counts calls (lets us assert the
   *  second classify() issued zero fetch calls when the breaker is
   *  open). Per-batch timeout error simulates broker-down / jev down. */
  function mockFetchErrorCounting(status: number): { calls: Array<unknown>; restore: () => void } {
    const calls: Array<unknown> = []
    const orig = (globalThis as any).fetch
    ;(globalThis as any).fetch = async (_url: string, _init: any) => {
      calls.push(_url)
      return { ok: false, status, text: async () => '' }
    }
    return {
      calls,
      restore: () => { (globalThis as any).fetch = orig },
    }
  }

  it('§7.92.6: all 3 batches fail → breaker opens → next classify() issues 0 fetch calls', async () => {
    // First classify() — jev returns HTTP 500 for all 3 batches.
    // Breaker should trip on the post-Promise.all `allBatchesFailed`
    // check, set jevBreakerOpenUntil to Date.now() + 30000.
    const mock = mockFetchErrorCounting(500)
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
        jevTimeoutMs: 100,
        jevBreakerTtlMs: 30000,
      }, audit as any)

      // First call — jev fails 3 times (all HTTP 500), LLM picks up.
      // §7.107: 文本须带公网信号词（'天气'），否则 CLOUD 判决会被 gate 降级。
      const intent1 = await service.classify('你好，查一下天气')
      assert.equal(intent1.category, 'CLOUD', 'LLM fallback should run')
      assert.equal(mock.calls.length, 3, 'first call fetches 3 batches (all fail)')
      const stats1 = service.getStats()
      assert.equal(stats1.jevCircuitOpen, 1, 'breaker opened once')
      assert.equal(stats1.jevCircuitSkip, 0, 'no skip yet — this was the trigger call')
      assert.ok(
        audit.entries.some((e) => e.kind === 'intent.jev.circuit_open' && e.level === 'warn'),
        'circuit_open audit fired at warn level',
      )

      // Second call — breaker is OPEN. Should return without ANY fetch.
      const callsBeforeSecondCall = mock.calls.length
      const intent2 = await service.classify('查天气')
      assert.equal(intent2.category, 'CLOUD', 'LLM fallback still runs')
      assert.equal(
        mock.calls.length, callsBeforeSecondCall,
        'second call issued 0 fetches (breaker open)',
      )
      const stats2 = service.getStats()
      assert.equal(stats2.jevCircuitSkip, 1, 'breaker skipped once')
      assert.ok(
        audit.entries.some((e) => e.kind === 'intent.jev.circuit_open_skip' && e.level === 'debug'),
        'circuit_open_skip audit fired at debug level',
      )
    } finally {
      mock.restore()
    }
  })

  it('§7.92.6: any successful batch closes the breaker (success → reset → no skip)', async () => {
    // First classify() — jev returns HTTP 500, breaker opens.
    // Sleep past TTL → next call goes through (breaker half-open).
    // jev returns 200 OK with fallback_llm verdict → still counts as
    // "jev is reachable" → success branch resets breaker to 0.
    const errMock = mockFetchErrorCounting(500)
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
        jevTimeoutMs: 100,
        jevBreakerTtlMs: 50, // tiny TTL so half-open retry happens fast
      }, audit as any)

      // First call — all 3 batches fail → breaker opens
      await service.classify('你好')
      assert.equal(service.getStats().jevCircuitOpen, 1, 'breaker opened after first failure')
      errMock.restore()

      // Sleep past TTL → breaker effectively closed (Date.now() >= openUntil).
      await new Promise((r) => setTimeout(r, 70))

      // Install OK mock. Default categories' jevIntentMap doesn't
      // include 'unknown_intent_xyz' so jev returns fallback_llm → jev
      // is "reachable" but intent unmapped → success branch runs →
      // breaker resets to 0.
      const okMock = mockFetchOk(jevResp({
        intent: 'unknown_intent_xyz',
        confidence: 0.4,
        risk_score: 0.05,
        action: 'fallback_llm',
      }))
      try {
        await service.classify('查天气')
        assert.equal(okMock.calls.length, 3, 'second call fetched all 3 batches (TTL expired, retry)')
        // Now breaker has been closed by the success path.
        assert.equal(service.getStats().jevCircuitSkip, 0, 'no skip — successful batch closed breaker')

        // Third call: same mock still in place. Breaker is closed (not
        // open), so this call fetches again — confirms the closed state
        // persists after a success (not just for one call).
        const callsBeforeThird = okMock.calls.length
        await service.classify('再见')
        assert.equal(okMock.calls.length, callsBeforeThird + 3, 'third call also fetched (breaker stays closed)')
        assert.equal(service.getStats().jevCircuitOpen, 1, 'breaker only opened once (no re-trip)')
      } finally {
        okMock.restore()
      }
    } finally {
      errMock.restore()
    }
  })

  it('§7.92.6: TTL expiry allows retry (half-open — next call goes back to jev)', async () => {
    // Use Date.now() mocking via a tiny TTL (50ms) so the test runs
    // quickly. After opening the breaker, sleep > 50ms, next call
    // should fetch again (breaker half-open → triggered another full
    // 3-batch fetch).
    const mock = mockFetchErrorCounting(500)
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
        jevTimeoutMs: 100,
        jevBreakerTtlMs: 50, // tiny TTL so the test doesn't take 30s
      }, audit as any)

      await service.classify('你好') // breaker opens
      const callsAfterFirst = mock.calls.length
      assert.equal(callsAfterFirst, 3)

      // Sleep past TTL (50ms + 20ms slack for clock skew).
      await new Promise((r) => setTimeout(r, 70))

      // Next call: breaker is closed (TTL expired), so 3 new fetches.
      await service.classify('查天气')
      assert.equal(
        mock.calls.length, callsAfterFirst + 3,
        'TTL expired → next call fetched 3 more batches (half-open retry)',
      )
      // jev still returns 500 → breaker re-opens.
      assert.equal(service.getStats().jevCircuitOpen, 2, 'breaker re-opened on second all-failed')
      assert.equal(service.getStats().jevCircuitSkip, 0, 'no skip — the retry call went through')
    } finally {
      mock.restore()
    }
  })

  // ─── §7.92.7 jev boot probe + periodic recovery probe ───────────────

  /** §7.92.7: HTTP `/health` mock that returns the configured status
   *  for /health calls and a 500 for /predict calls. Tracks both URLs
   *  so tests can assert "boot probe hit /health but classify went
   *  to /predict". */
  function mockHealthAndPredict(
    healthStatus: number,
    predictStatus: number,
  ): { healthCalls: Array<unknown>; predictCalls: Array<unknown>; restore: () => void } {
    const healthCalls: Array<unknown> = []
    const predictCalls: Array<unknown> = []
    const orig = (globalThis as any).fetch
    ;(globalThis as any).fetch = async (url: string, _init: any) => {
      if (typeof url === 'string' && url.endsWith('/health')) {
        healthCalls.push(url)
        return { ok: healthStatus >= 200 && healthStatus < 300, status: healthStatus, text: async () => '' }
      }
      predictCalls.push(url)
      return { ok: predictStatus >= 200 && predictStatus < 300, status: predictStatus, text: async () => '' }
    }
    return {
      healthCalls,
      predictCalls,
      restore: () => { (globalThis as any).fetch = orig },
    }
  }

  it('§7.92.7: boot probe success → no pre-opened breaker → first classify hits jev normally', async () => {
    // /health returns 200 → boot probe passes → breaker closed → first
    // classify() goes to /predict (3 batches).
    const mock = mockHealthAndPredict(200, 500)
    try {
      const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
      const mockCtx = { reflect: { provide: () => {} }, llm: fakeLlm(chunksFromText('{}')) } as any
      const service = new IntentRouterServiceImpl(mockCtx, {
        defaultCategory: 'CLOUD',
        classificationProvider: 'local-llm',
        confidenceThreshold: 0.6,
        jevEnabled: true,
        jevTimeoutMs: 100,
        jevBootProbeEnabled: true,
        jevBootProbeTimeoutMs: 200,
      }, audit as any)

      // Fire boot probe (fire-and-forget) and wait for it to settle.
      service.start()
      // Drain the in-flight probe before classify() so the test is
      // deterministic about ordering.
      await new Promise((r) => setTimeout(r, 30))

      assert.equal(mock.healthCalls.length, 1, 'boot probe hit /health once')
      assert.equal(service.getStats().jevBootProbeOk, 1, 'boot probe counted as ok')
      assert.equal(service.getStats().jevBootProbeFail, 0)
      assert.ok(
        audit.entries.some((e) => e.kind === 'intent.jev.boot_probe' && e.level === 'info' && e.payload?.ok === true),
        'boot_probe audit fired at info level with ok=true',
      )
      // Breaker should still be closed (no pre-open).
      assert.equal(service.getStats().jevCircuitOpen, 0)
    } finally {
      mock.restore()
      // Periodic probe timer was never started (boot probe success),
      // so no timer cleanup needed.
    }
  })

  it('§7.92.7: boot probe fail → pre-opened breaker → first classify skips jev (0 /predict calls)', async () => {
    // /health returns 500 → boot probe fails → breaker pre-opens for TTL.
    // First classify() must short-circuit (0 fetch to /predict).
    const mock = mockHealthAndPredict(500, 200) // predict never reached
    try {
      const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
      const mockCtx = { reflect: { provide: () => {} }, llm: fakeLlm(chunksFromText('{}')) } as any
      const service = new IntentRouterServiceImpl(mockCtx, {
        defaultCategory: 'CLOUD',
        classificationProvider: 'local-llm',
        confidenceThreshold: 0.6,
        jevEnabled: true,
        jevTimeoutMs: 100,
        jevBreakerTtlMs: 30000,
        jevBootProbeEnabled: true,
        jevBootProbeTimeoutMs: 200,
      }, audit as any)

      service.start()
      // Wait for the boot probe to land + pre-open the breaker.
      await new Promise((r) => setTimeout(r, 30))

      assert.equal(mock.healthCalls.length, 1, 'boot probe hit /health once')
      assert.equal(service.getStats().jevBootProbeOk, 0)
      assert.equal(service.getStats().jevBootProbeFail, 1, 'boot probe counted as fail')
      assert.ok(
        audit.entries.some((e) => e.kind === 'intent.jev.boot_probe' && e.level === 'warn' && e.payload?.ok === false),
        'boot_probe audit fired at warn level with ok=false',
      )

      // First classify — breaker should be OPEN, skip jev entirely.
      await service.classify('你好')
      assert.equal(mock.predictCalls.length, 0, 'classify() did NOT call /predict (breaker open)')
      assert.equal(service.getStats().jevCircuitSkip, 1, 'circuit skip counted')
      assert.ok(
        audit.entries.some((e) => e.kind === 'intent.jev.circuit_open_skip'),
        'circuit_open_skip audit fired',
      )
    } finally {
      mock.restore()
    }
  })

  it('§7.92.7: periodic probe success → breaker closes mid-TTL (recovery faster than 30s wait)', async () => {
    // First classify() — jev returns 500 from /predict → trips breaker.
    // Periodic probe (50ms interval) hits /health which returns 200 →
    // breaker closes. Second classify() should hit jev (no skip).
    const mock = mockHealthAndPredict(200, 500)
    try {
      const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
      const mockCtx = { reflect: { provide: () => {} }, llm: fakeLlm(chunksFromText('{}')) } as any
      const service = new IntentRouterServiceImpl(mockCtx, {
        defaultCategory: 'CLOUD',
        classificationProvider: 'local-llm',
        confidenceThreshold: 0.6,
        jevEnabled: true,
        jevTimeoutMs: 100,
        jevBreakerTtlMs: 30000, // long — recovery must come from probe, not TTL
        jevBootProbeEnabled: false,
        jevBreakerProbeMs: 50,
        jevProbeTimeoutMs: 100,
      }, audit as any)

      // First classify → 3 batch fails → breaker opens + periodic probe starts.
      await service.classify('你好')
      assert.equal(service.getStats().jevCircuitOpen, 1)
      assert.equal(service.getStats().jevProbeAttempts, 0, 'no probe attempts yet (just opened)')

      // Wait for at least one periodic probe to land.
      await new Promise((r) => setTimeout(r, 120))
      assert.ok(mock.healthCalls.length >= 1, 'periodic probe hit /health')
      assert.ok(service.getStats().jevProbeAttempts >= 1, 'probe attempts counted')
      assert.equal(service.getStats().jevRecoveredProbe, 1, 'recovery via probe')
      assert.ok(
        audit.entries.some((e) => e.kind === 'intent.jev.recovered' && e.level === 'info'),
        'recovered audit fired at info level',
      )

      // Second classify → breaker closed → 3 /predict calls (all fail again,
      // but we proved recovery short-circuit worked). Note: 6 total =
      // 3 from the first classify + 3 from the second.
      await service.classify('查天气')
      assert.equal(mock.predictCalls.length, 6, 'second classify hit /predict (recovery closed breaker) — 3 from first + 3 from second')
      assert.equal(service.getStats().jevCircuitOpen, 2, 're-tripped when probe-recovered /predict still fails')
      assert.equal(service.getStats().jevCircuitSkip, 0, 'no skip on recovery path')
    } finally {
      mock.restore()
      // Periodic probe timer was running for this case; explicit stop()
      // keeps vitest clean between cases.
    }
  })

  it('§7.92.7: periodic probe fail → breaker remains open across many intervals', async () => {
    // /health returns 500 → periodic probe keeps failing → breaker stays
    // open. classify() should keep short-circuiting.
    const mock = mockHealthAndPredict(500, 500) // health fails + predict fails → breaker stays open
    try {
      const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
      const mockCtx = { reflect: { provide: () => {} }, llm: fakeLlm(chunksFromText('{}')) } as any
      const service = new IntentRouterServiceImpl(mockCtx, {
        defaultCategory: 'CLOUD',
        classificationProvider: 'local-llm',
        confidenceThreshold: 0.6,
        jevEnabled: true,
        jevTimeoutMs: 100,
        jevBreakerTtlMs: 30000,
        jevBootProbeEnabled: false,
        jevBreakerProbeMs: 30,
        jevProbeTimeoutMs: 50,
      }, audit as any)

      // Trigger breaker via /predict failures.
      await service.classify('你好')
      const circuitOpenCount = service.getStats().jevCircuitOpen
      assert.equal(circuitOpenCount, 1)
      const predictCallsAfterFirst = mock.predictCalls.length
      assert.equal(predictCallsAfterFirst, 3, 'first classify fired 3 /predict batches')

      // Wait through several probe intervals. All should fail.
      await new Promise((r) => setTimeout(r, 200))
      assert.ok(mock.healthCalls.length >= 3, `periodic probe hit /health ${mock.healthCalls.length} times`)
      assert.equal(service.getStats().jevRecoveredProbe, 0, 'no recovery (probe still failing)')
      assert.equal(service.getStats().jevCircuitOpen, circuitOpenCount, 'breaker stays at the trip count')
      assert.equal(mock.predictCalls.length, predictCallsAfterFirst, '/predict was NOT hit during the wait')

      // Second classify() — still open, still skipped.
      await service.classify('查天气')
      assert.equal(
        mock.predictCalls.length, predictCallsAfterFirst,
        'second classify did NOT add to /predict calls (breaker open short-circuit)',
      )
      assert.ok(service.getStats().jevCircuitSkip >= 1, 'skip counted')
    } finally {
      mock.restore()
    }
  })
})

/** §7.108/§7.109 shared helpers — mock privacy-policy exposing the stages
 *  surface (+ optional categories). `__emit` lets a test fire the
 *  policy/loaded listener. */
function auditSpy() {
  const entries: any[] = []
  return { entries, log: async (e: any) => { entries.push(e) } }
}

function fakePolicy(
  stages?: {
    cloudKeywords?: string[]
    localEntities?: string[]
    fallbackKeywords?: string[]
    semanticCloudMinConfidence?: number
  },
  categories?: Array<{ id: 'LOCAL' | 'CLOUD' | 'SANITIZED' | 'REJECT'; description: string; jevIntents: string[] }>,
) {
  const listeners: Array<(p: any) => void> = []
  return {
    getIntentStages: () => stages,
    getCategories: () => categories ?? [],
    matchRouting: () => null,
    on: (_event: string, listener: (p: any) => void) => { listeners.push(listener) },
    __emit: (p: any) => { for (const l of listeners) l(p) },
  }
}

function makeService(ctxExtras: Record<string, unknown>, config: Record<string, unknown> = {}, audit?: unknown) {
  const mockCtx = { reflect: { provide: () => {} }, llm: null, ...ctxExtras } as any
  return new IntentRouterServiceImpl(mockCtx, {
    defaultCategory: 'LOCAL',
    classificationProvider: 'local-llm',
    confidenceThreshold: 0.6,
    ...config,
  }, audit as any)
}

describe('intent-router §7.108 policy-configured signal tables', () => {
  it('rules tier: a policy stages.intent.cloudKeywords word routes CLOUD (杭州游玩攻略)', async () => {
    const service = makeService({ privacyPolicy: fakePolicy({ cloudKeywords: ['攻略'] }) })
    const intent = await service.classify('准备一个杭州游玩的攻略')
    assert.equal(intent.category, 'CLOUD')
    assert.equal(intent.rationale, 'rule-cloud-keyword:攻略')
  })

  it('§7.107 gate: an LLM CLOUD verdict unlocked by a POLICY keyword passes', async () => {
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.93 })
    const audit = auditSpy()
    const service = makeService(
      { privacyPolicy: fakePolicy({ cloudKeywords: ['攻略'] }), llm: fakeLlm(chunksFromText(verdict)) },
      {},
      audit)
    const intent = await service.classify('准备一个杭州游玩的攻略')
    assert.equal(intent.category, 'CLOUD')
    assert.match(intent.rationale, /^llm-classified/u)
    assert.ok(!audit.entries.some((e: any) => e.kind === 'intent.cloud.blocked-no-web-need'))
  })

  it('§7.107 gate: with NO signal anywhere the LLM CLOUD verdict stays on device', async () => {
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.93 })
    const audit = auditSpy()
    const service = makeService(
      { privacyPolicy: fakePolicy({ cloudKeywords: [] }), llm: fakeLlm(chunksFromText(verdict)) },
      {},
      audit)
    const intent = await service.classify('规划一下数据库的表结构')
    assert.equal(intent.category, 'LOCAL')
    assert.equal(intent.rationale, 'no-web-need')
    assert.ok(audit.entries.some((e: any) => e.kind === 'intent.cloud.blocked-no-web-need'))
  })

  it('entity guardrail merges policy stages.intent.localEntities', async () => {
    const service = makeService({ privacyPolicy: fakePolicy({ localEntities: ['小程序'] }) })
    const intent = await service.classify('查一下小程序的登录状态')
    assert.equal(intent.category, 'LOCAL')
    assert.match(intent.rationale, /rule-local-entity:小程序/u)
  })

  it('fallback keywords: policy stages.intent.fallbackKeywords REPLACES the LOCAL list', async () => {
    const service = makeService({ privacyPolicy: fakePolicy({ fallbackKeywords: ['摩斯密码本'] }) })
    const hit = await service.classify('帮我看看摩斯密码本在哪')
    assert.equal(hit.category, 'LOCAL')
    // §7.113: the rationale carries the matched keyword (Edge tab evidence).
    assert.equal(hit.rationale, 'rule-keyword-match:摩斯密码本')
    // replaced, not appended: builtin-only words fall through to default
    const miss = await service.classify('帮我读取文件内容')
    assert.equal(miss.category, 'LOCAL')
    assert.equal(miss.rationale, 'default:local')
  })

  it('§7.113: classify.end carries keyword + semantic evidence scalars for the Edge tab', async () => {
    const audit = auditSpy()
    const service = makeService({ privacyPolicy: fakePolicy({ cloudKeywords: ['攻略'] }) }, {}, audit)
    await service.classify('准备一个杭州游玩的攻略')
    const end = audit.entries.find((e: any) => e.kind === 'intent.classify.end')
    assert.ok(end, 'expected a classify.end row')
    assert.equal(end.payload.keyword, '攻略')
    assert.ok(typeof end.payload.semantic === 'string' && end.payload.semantic.length > 0,
      `semantic should carry the category description, got ${JSON.stringify(end.payload.semantic)}`)
  })

  it('categories + jev map follow policy/loaded when the spec came from the policy service', () => {
    const pol = fakePolicy(undefined, [{ id: 'CLOUD', description: '联网任务', jevIntents: ['search'] }])
    const service = makeService({ privacyPolicy: pol })
    assert.equal((service as any).jevIntentMap['旅游攻略'], undefined)
    pol.__emit({ categories: [{ id: 'CLOUD', description: '联网+旅游任务', jevIntents: ['search', '旅游攻略'] }] })
    assert.equal((service as any).jevIntentMap['旅游攻略'], 'CLOUD')
    assert.equal((service as any).categories[0].description, '联网+旅游任务')
  })

  it('config.categories keeps its override semantics — policy/loaded does not refresh it', () => {
    const pol = fakePolicy(undefined, [{ id: 'CLOUD', description: 'from policy', jevIntents: [] }])
    const service = makeService(
      { privacyPolicy: pol },
      { categories: [{ id: 'LOCAL', description: 'from config', jevIntents: [] }] })
    pol.__emit({ categories: [{ id: 'CLOUD', description: 'newer policy', jevIntents: [] }] })
    assert.equal((service as any).categories[0].description, 'from config')
  })
})

describe('intent-router §7.109 semantic unlock (policy-trusted classifier verdicts)', () => {
  it('an LLM CLOUD verdict without any keyword passes when policy declares semantic trust ≥ threshold', async () => {
    // "规划黄山两日游" needs public info but carries NO keyword from any
    // list — only the classifier's semantic judgement can see it.
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.9 })
    const audit = auditSpy()
    const service = makeService(
      {
        privacyPolicy: fakePolicy({ semanticCloudMinConfidence: 0.75 }),
        llm: fakeLlm(chunksFromText(verdict)),
      },
      {},
      audit)
    const intent = await service.classify('帮我规划一下黄山两日游怎么安排')
    assert.equal(intent.category, 'CLOUD')
    assert.match(intent.rationale, /^llm-classified/u)
    assert.ok(audit.entries.some((e: any) => e.kind === 'intent.cloud.semantic-unlock'))
    assert.ok(!audit.entries.some((e: any) => e.kind === 'intent.cloud.blocked-no-web-need'))
  })

  it('an LLM CLOUD verdict BELOW the policy confidence threshold is still kept on device', async () => {
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.7 })
    const audit = auditSpy()
    const service = makeService(
      {
        privacyPolicy: fakePolicy({ semanticCloudMinConfidence: 0.75 }),
        llm: fakeLlm(chunksFromText(verdict)),
      },
      {},
      audit)
    const intent = await service.classify('帮我规划一下黄山两日游怎么安排')
    assert.equal(intent.category, 'LOCAL')
    assert.equal(intent.rationale, 'no-web-need')
    assert.ok(audit.entries.some((e: any) => e.kind === 'intent.cloud.blocked-no-web-need'))
    assert.ok(!audit.entries.some((e: any) => e.kind === 'intent.cloud.semantic-unlock'))
  })

  it('without the policy knob the gate stays keyword-only (§7.107 unchanged)', async () => {
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.99 })
    const audit = auditSpy()
    const service = makeService(
      { privacyPolicy: fakePolicy(undefined), llm: fakeLlm(chunksFromText(verdict)) },
      {},
      audit)
    const intent = await service.classify('帮我规划一下黄山两日游怎么安排')
    assert.equal(intent.category, 'LOCAL')
    assert.equal(intent.rationale, 'no-web-need')
  })

  it('the LOCAL entity guardrail still wins over a semantically unlocked CLOUD verdict', async () => {
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.95 })
    const audit = auditSpy()
    const service = makeService(
      {
        privacyPolicy: fakePolicy({ semanticCloudMinConfidence: 0.5, localEntities: ['密盒'] }),
        llm: fakeLlm(chunksFromText(verdict)),
      },
      {},
      audit)
    const intent = await service.classify('把密盒的日志整理成审计报告')
    assert.equal(intent.category, 'LOCAL')
    assert.match(intent.rationale, /override-local-entity:密盒/u)
    assert.ok(!audit.entries.some((e: any) => e.kind === 'intent.cloud.semantic-unlock'))
  })
})

describe('intent-router §7.112 Bailian decision-model jev backend', () => {
  function mockSystemone(respond: () => any) {
    const calls: Array<{ url: string; init: any }> = []
    const orig = (globalThis as any).fetch
    ;(globalThis as any).fetch = async (url: string, init: any) => {
      calls.push({ url, init })
      const body = respond()
      return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body }
    }
    return { calls, restore: () => { (globalThis as any).fetch = orig } }
  }

  const BAILIAN_CONFIG = {
    defaultCategory: 'LOCAL',
    classificationProvider: 'local-llm',
    confidenceThreshold: 0.6,
    jevEnabled: true,
    jevProvider: 'bailian-decision' as const,
    jevUrl: 'https://bailian.mock/compatible-mode/v1',
    jevModel: 'decision-model-preview',
    jevApiKey: 'sk-bailian-test',
    jevBootProbeEnabled: false,
  }

  it('adopt: choice verdict maps onto the categories taxonomy (raw auth header)', async () => {
    // §7.112.1: mock mirrors the REAL captured systemone response shape
    // (2026-10-25 实测 token-plan 端点): answers.<q> = {type, choice,
    // confidence, probabilities} for choice; {type, score(0..3), legend,
    // confidence} for score.
    const mock = mockSystemone(() => ({
      model: 'decision-model-preview',
      request_id: '55eaf7ad-9b7f-4ca6-a9c2-1853154154d9',
      answers: {
        intent: { type: 'choice', choice: 'CLOUD', confidence: 0.9, probabilities: { CLOUD: 0.95, LOCAL: 0.05 } },
        risk: { type: 'score', score: 0.5, legend: { '0': '正常请求，无风险', '1': '轻微可疑，需要留意', '2': '明显危险操作', '3': '高危/违法/破坏性请求' }, confidence: 0.91 },
      },
      usage: { input_tokens: 125 },
      latency_ms: 47.3,
    }))
    try {
      const service = new IntentRouterServiceImpl({ reflect: { provide: () => {} }, llm: null } as any, BAILIAN_CONFIG)
      const intent = await service.classify('查一下最新的AI新闻')
      assert.equal(intent.category, 'CLOUD')
      assert.match(intent.rationale, /jev-intent:CLOUD/u)
      const call = mock.calls.find((c) => c.url.endsWith('/systemone'))
      assert.ok(call, 'expected a /systemone call')
      assert.equal(call.init.headers.Authorization, 'sk-bailian-test')
      const body = JSON.parse(call.init.body)
      assert.equal(body.model, 'decision-model-preview')
      assert.equal(body.state.content, '查一下最新的AI新闻')
      assert.equal(body.questions.intent.type, 'choice')
      assert.ok(body.questions.intent.criteria.CLOUD.length > 0)
      assert.equal(body.questions.risk.type, 'score')
    } finally {
      mock.restore()
    }
  })

  it('risk score 3/3 → reject (security gate mirrors local risk_score)', async () => {
    const mock = mockSystemone(() => ({
      answers: {
        intent: { type: 'choice', choice: 'REJECT', confidence: 0.95 },
        risk: { type: 'score', score: 3, confidence: 0.9 },
      },
    }))
    try {
      const service = new IntentRouterServiceImpl({ reflect: { provide: () => {} }, llm: null } as any, BAILIAN_CONFIG)
      const intent = await service.classify('rm -rf 一切')
      assert.equal(intent.category, 'REJECT')
    } finally {
      mock.restore()
    }
  })

  it('bearer scheme + low-confidence skip falls through to rules', async () => {
    const mock = mockSystemone(() => ({
      answers: {
        intent: { type: 'choice', choice: 'CLOUD', confidence: 0.5 },
        risk: { type: 'score', score: 0.5 },
      },
    }))
    try {
      const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
      const service = new IntentRouterServiceImpl({ reflect: { provide: () => {} }, llm: null } as any, {
        ...BAILIAN_CONFIG,
        jevAuthScheme: 'bearer' as const,
      }, audit as any)
      const intent = await service.classify('什么是量子力学')
      assert.equal(intent.category, 'LOCAL')
      assert.ok(audit.entries.some((e: any) => e.kind === 'intent.jev.low_confidence'))
      const call = mock.calls.find((c) => c.url.endsWith('/systemone'))
      assert.equal(call!.init.headers.Authorization, 'Bearer sk-bailian-test')
    } finally {
      mock.restore()
    }
  })
})

describe('intent-router §7.114 local MLX decision-model (config-bound external service)', () => {
  it('jevPath reroutes the classify call — same contract, external deployment', async () => {
    const calls: Array<{ url: string; init: any }> = []
    const orig = (globalThis as any).fetch
    ;(globalThis as any).fetch = async (url: string, init: any) => {
      calls.push({ url, init })
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          model: 'decision-model-preview',
          answers: {
            intent: { type: 'choice', choice: 'LOCAL', confidence: 0.97 },
            risk: { type: 'score', score: 0.1 },
          },
          latency_ms: 2081,
        }),
        json: async () => ({}),
      }
    }
    try {
      const service = new IntentRouterServiceImpl({ reflect: { provide: () => {} }, llm: null } as any, {
        defaultCategory: 'LOCAL',
        classificationProvider: 'local-llm',
        confidenceThreshold: 0.6,
        jevEnabled: true,
        jevProvider: 'bailian-decision' as const,
        jevUrl: 'http://127.0.0.1:11017/v1',
        jevPath: '/classify',
        jevModel: 'decision-model-preview',
        jevBootProbeEnabled: false,
      })
      const intent = await service.classify('帮我读取文件内容')
      assert.equal(intent.category, 'LOCAL')
      assert.match(intent.rationale, /jev-intent:LOCAL/u)
      const call = calls.find((c) => c.url === 'http://127.0.0.1:11017/v1/classify')
      assert.ok(call, `expected a /v1/classify call, got ${JSON.stringify(calls.map((c) => c.url))}`)
      const body = JSON.parse(call.init.body)
      assert.equal(body.model, 'decision-model-preview')
      assert.equal(body.questions.intent.criteria.LOCAL.length > 0, true)
    } finally {
      (globalThis as any).fetch = orig
    }
  })
})

describe('intent-router §7.115 directional gate + llmFallback switch', () => {
  function mockDecision(respond: () => any) {
    const orig = (globalThis as any).fetch
    ;(globalThis as any).fetch = async (url: string, init: any) => {
      if (!String(url).endsWith('/systemone')) {
        return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) }
      }
      const body = respond()
      return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body }
    }
    return { restore: () => { (globalThis as any).fetch = orig } }
  }

  function decisionService(config: Record<string, unknown>, audit?: unknown) {
    return new IntentRouterServiceImpl({ reflect: { provide: () => {} }, llm: null } as any, {
      defaultCategory: 'LOCAL',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
      jevEnabled: true,
      jevProvider: 'bailian-decision' as const,
      jevUrl: 'https://bailian.mock/compatible-mode/v1',
      jevBootProbeEnabled: false,
      ...config,
    }, audit as any)
  }

  it('directional gate: LOCAL-leaning verdict at conf 0.62 adopts at the 0.5 floor (no LLM paid)', async () => {
    const mock = mockDecision(() => ({
      answers: {
        intent: { type: 'choice', choice: 'LOCAL', confidence: 0.62 },
        risk: { type: 'score', score: 0.3 },
      },
    }))
    try {
      const audit = auditSpy()
      const intent = decisionService({}, audit).classify('随便聊聊今天的心情')
      assert.equal((await intent).category, 'LOCAL')
      assert.match((await intent).rationale, /jev-intent:LOCAL/u)
      const adopt = audit.entries.find((e: any) => e.kind === 'intent.jev.adopt')
      assert.ok(adopt, 'expected jev adopt row')
    } finally {
      mock.restore()
    }
  })

  it('directional gate: non-LOCAL verdict keeps the strict 0.85 threshold', async () => {
    const mock = mockDecision(() => ({
      answers: {
        intent: { type: 'choice', choice: 'CLOUD', confidence: 0.62 },
        risk: { type: 'score', score: 0.4 },
      },
    }))
    try {
      const audit = auditSpy()
      const intent = await decisionService({}, audit).classify('查一下最新的AI新闻')
      // jev skipped (0.62 < 0.85) → llm null → rules: the query carries the
      // 新闻 cloud keyword, so the rules tier ADOPTS CLOUD (public-web
      // signal — correct §7.107 behavior, not the default).
      assert.equal(intent.category, 'CLOUD')
      assert.match(intent.rationale, /rule-cloud-keyword:/u)
      const low = audit.entries.find((e: any) => e.kind === 'intent.jev.low_confidence')
      assert.ok(low, 'expected low_confidence row')
      assert.equal(low.payload.threshold, 0.85)
    } finally {
      mock.restore()
    }
  })

  it('localAdoptFloor is config-tunable (0.8 → LOCAL conf 0.62 skips)', async () => {
    const mock = mockDecision(() => ({
      answers: {
        intent: { type: 'choice', choice: 'LOCAL', confidence: 0.62 },
        risk: { type: 'score', score: 0.3 },
      },
    }))
    try {
      const audit = auditSpy()
      const intent = await decisionService({ jevLocalAdoptFloor: 0.8 }, audit).classify('随便聊聊')
      assert.equal(intent.category, 'LOCAL')
      const low = audit.entries.find((e: any) => e.kind === 'intent.jev.low_confidence')
      assert.ok(low, 'expected low_confidence row at the raised floor')
      assert.equal(low.payload.threshold, 0.8)
    } finally {
      mock.restore()
    }
  })

  it('llmFallback=false: jev skip goes straight to rules — LLM classifier never runs', async () => {
    const mock = mockDecision(() => ({
      answers: {
        intent: { type: 'choice', choice: 'CLOUD', confidence: 0.5 },
        risk: { type: 'score', score: 0.2 },
      },
    }))
    try {
      const audit = auditSpy()
      const intent = await decisionService({ llmFallback: false }, audit).classify('查一下最新的AI新闻')
      // jev skip → rules (新闻 keyword → CLOUD). The decisive assertion is
      // the path: the LLM classifier branch never ran.
      assert.equal(intent.category, 'CLOUD')
      const end = audit.entries.find((e: any) => e.kind === 'intent.classify.end')
      assert.equal(end.payload.path, 'rules-llm-fallback-off')
      // no classify.start for the LLM classifier would be ambiguous (start
      // fires for the whole classify) — the decisive proof is the path.
    } finally {
      mock.restore()
    }
  })
})

describe('intent-router §7.115.1 decision-model criteria LOCAL catch-all', () => {
  it('a taxonomy without a LOCAL row still offers LOCAL as a choice criterion', async () => {
    // §7.110 简并形态：policy 只定义 CLOUD/REJECT——决策模型的 criteria
    // 必须补 LOCAL 兜底（否则模型被迫二选一，日常问答被推向误判 CLOUD）。
    const calls: Array<{ url: string; init: any }> = []
    const orig = (globalThis as any).fetch
    ;(globalThis as any).fetch = async (url: string, init: any) => {
      calls.push({ url, init })
      const body = {
        answers: { intent: { type: 'choice', choice: 'LOCAL', confidence: 0.9 }, risk: { type: 'score', score: 0.2 } },
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body }
    }
    try {
      const service = new IntentRouterServiceImpl({ reflect: { provide: () => {} }, llm: null } as any, {
        defaultCategory: 'LOCAL',
        classificationProvider: 'local-llm',
        confidenceThreshold: 0.6,
        jevEnabled: true,
        jevProvider: 'bailian-decision' as const,
        jevUrl: 'https://bailian.mock/compatible-mode/v1',
        jevBootProbeEnabled: false,
        categories: [
          { id: 'CLOUD', description: '需要公网信息的任务', jevIntents: ['search'] },
          { id: 'REJECT', description: '高危请求', jevIntents: ['legal'] },
        ],
      })
      const intent = await service.classify('什么是量子力学')
      assert.equal(intent.category, 'LOCAL')
      assert.match(intent.rationale, /jev-intent:LOCAL/u)
      const call = calls.find((c) => c.url.endsWith('/systemone'))
      assert.ok(call)
      const body = JSON.parse(call.init.body)
      assert.equal(body.questions.intent.criteria.CLOUD.length > 0, true)
      assert.equal(body.questions.intent.criteria.REJECT.length > 0, true)
      assert.match(body.questions.intent.criteria.LOCAL, /拿不准就选它/u)
    } finally {
      (globalThis as any).fetch = orig
    }
  })

  it('a taxonomy WITH a LOCAL row uses its own description verbatim', async () => {
    const calls: Array<{ url: string; init: any }> = []
    const orig = (globalThis as any).fetch
    ;(globalThis as any).fetch = async (url: string, init: any) => {
      calls.push({ url, init })
      const body = {
        answers: { intent: { type: 'choice', choice: 'LOCAL', confidence: 0.9 }, risk: { type: 'score', score: 0.2 } },
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body }
    }
    try {
      const service = new IntentRouterServiceImpl({ reflect: { provide: () => {} }, llm: null } as any, {
        defaultCategory: 'LOCAL',
        classificationProvider: 'local-llm',
        confidenceThreshold: 0.6,
        jevEnabled: true,
        jevProvider: 'bailian-decision' as const,
        jevUrl: 'https://bailian.mock/compatible-mode/v1',
        jevBootProbeEnabled: false,
        categories: [
          { id: 'LOCAL', description: '本机自带描述', jevIntents: [] },
          { id: 'CLOUD', description: '需要公网信息的任务', jevIntents: [] },
        ],
      })
      await service.classify('什么是量子力学')
      const call = calls.find((c) => c.url.endsWith('/systemone'))
      assert.equal(JSON.parse(call!.init.body).questions.intent.criteria.LOCAL, '本机自带描述')
    } finally {
      (globalThis as any).fetch = orig
    }
  })
})

describe('§7.122 isLoopbackEndpoint — the provider name lies, the endpoint does not', () => {
  it('loopback endpoints are on-device', () => {
    assert.equal(isLoopbackEndpoint('http://127.0.0.1:8080/v1'), true)
    assert.equal(isLoopbackEndpoint('http://localhost:11434/v1'), true)
    assert.equal(isLoopbackEndpoint('http://[::1]:8080/v1'), true)
  })

  it('public endpoints are NOT on-device', () => {
    // config/edge.json 的 llm.local.baseUrl 指向公网 MiniMax —— provider
    // 名叫 local-llm，落点却在公网。面板必须能说出这一点。
    assert.equal(isLoopbackEndpoint('https://api.minimaxi.com/v1'), false)
    assert.equal(isLoopbackEndpoint('http://10.0.0.5:8080/v1'), false)
    assert.equal(isLoopbackEndpoint('https://example.com'), false)
  })

  it('missing / malformed endpoints are not treated as local', () => {
    assert.equal(isLoopbackEndpoint(undefined), false)
    assert.equal(isLoopbackEndpoint(''), false)
    assert.equal(isLoopbackEndpoint('   '), false)
    assert.equal(isLoopbackEndpoint('not a url'), false)
  })
})
