/**
 * §7.100 cloud-llm DELEGATE mode — probe resolution chain, forwarding,
 * explicit failure, apply() dispatch. The direct-connect regressions stay
 * in cloud-llm-adapter.test.ts (explicit baseUrl must keep the old behavior
 * byte-for-byte; these two files together pin both modes).
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import {
  apply,
  probeCloudTarget,
  CloudLlmDelegateAdapterImpl,
} from '../../src/dsh-adapter/cloud-llm-adapter.ts'

type Recorded = { provider: string; model: string }

function mkLlm(routes: string[], opts: {
  duplicate?: boolean
  script?: any[]
  modelsByProvider?: Record<string, any[]>
} = {}) {
  const llm: any = {
    registered: [] as Array<{ providers: string[]; adapter: unknown }>,
    calls: [] as Recorded[],
    disposed: false,
    registerAdapter(providers: string[], adapter: unknown) {
      if (opts.duplicate) {
        const e: any = new Error('no adapter registered for provider "cloud-llm"')
        e.code = 'DUPLICATE_ADAPTER'
        throw e
      }
      llm.registered.push({ providers, adapter })
      return Object.assign(() => { llm.disposed = true }, { replace: () => {} })
    },
    listProviders: () => routes.map((id) => ({ id, name: id })),
    stream(options: any) {
      llm.calls.push({ provider: options.provider, model: options.model })
      const script = opts.script ?? [
        { type: 'text-delta', index: 0, text: 'hi' },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
      return (async function* () { for (const c of script) yield c })()
    },
    listModels: async (p: string) => opts.modelsByProvider?.[p] ?? [{ provider: p, id: 'first-model', name: 'first-model' }],
    resolveModelInfo: async (p: string, m: string) => ({ provider: p, id: m, name: m, context: { contextWindow: 32768 } }),
  }
  return llm
}

function mkCtx(llm: any, selection?: { provider?: string; model?: string }) {
  const ctx: any = {
    llm,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    handlers: {} as Record<string, (payload?: unknown) => void>,
    get(name: string) {
      if (name === 'agentDefaultModel') return selection ? { currentSelection: () => selection } : undefined
      throw new Error(`no service ${name}`)
    },
    on(ev: string, cb: (payload?: unknown) => void) { ctx.handlers[ev] = cb; return () => { delete ctx.handlers[ev] } },
  }
  return ctx
}

const cfg = (over: Record<string, unknown> = {}): any => ({
  providers: ['cloud-llm'],
  baseUrl: '',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  defaultModel: 'deepseek-chat',
  ...over,
})

async function drain(iterable: AsyncIterable<any>): Promise<any[]> {
  const out: any[] = []
  for await (const c of iterable) out.push(c)
  return out
}

describe('§7.100 probeCloudTarget resolution chain', () => {
  it('step 1: env delegateProvider wins when live', () => {
    const llm = mkLlm(['deepseek-official', 'q4b'])
    const t = probeCloudTarget(
      { llm, getAgentDefaultModel: () => ({ currentSelection: () => ({ provider: 'deepseek-account', model: 'x' }) }) } as any,
      cfg({ delegateProvider: 'q4b' }),
    )
    assert.equal(t?.provider, 'q4b')
    assert.equal(t?.source, 'env')
  })

  it('step 1: env override naming an own/unlive route fails loudly (never self-delegate)', () => {
    const llm = mkLlm(['deepseek-official'])
    assert.equal(probeCloudTarget({ llm, getAgentDefaultModel: () => undefined } as any, cfg({ delegateProvider: 'cloud-llm' })), null)
    assert.equal(probeCloudTarget({ llm, getAgentDefaultModel: () => undefined } as any, cfg({ delegateProvider: 'ghost' })), null)
  })

  it('step 2: host selection when its provider is live', () => {
    const llm = mkLlm(['deepseek-account', 'deepseek-official'])
    const t = probeCloudTarget(
      { llm, getAgentDefaultModel: () => ({ currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) }) } as any,
      cfg(),
    )
    assert.equal(t?.provider, 'deepseek-account')
    assert.equal(t?.model, 'deepseek-flash')
    assert.equal(t?.source, 'selection')
  })

  it('step 2: delegateModel config beats selection.model', () => {
    const llm = mkLlm(['deepseek-account'])
    const t = probeCloudTarget(
      { llm, getAgentDefaultModel: () => ({ currentSelection: () => ({ provider: 'deepseek-account', model: 'selection-m' }) }) } as any,
      cfg({ delegateModel: 'override-m' }),
    )
    assert.equal(t?.model, 'override-m')
  })

  it('guardrails: selection pointing at cloud-llm / local-llm is never delegated', () => {
    for (const bad of ['cloud-llm', 'local-llm']) {
      const llm = mkLlm([bad, 'deepseek-official'])
      const t = probeCloudTarget(
        { llm, getAgentDefaultModel: () => ({ currentSelection: () => ({ provider: bad }) }) } as any,
        cfg(),
      )
      assert.ok(t, 'probe should fall through to step 3')
      assert.notEqual(t!.provider, bad)
      assert.equal(t!.source, 'probe')
    }
  })

  it('step 3: dormant selection falls to probe; stable ids beat registry order', () => {
    const llm = mkLlm(['qwen-token-plan-cn', 'deepseek-official'])
    const t = probeCloudTarget(
      { llm, getAgentDefaultModel: () => ({ currentSelection: () => ({ provider: 'ghost-route' }) }) } as any,
      cfg(),
    )
    assert.equal(t?.provider, 'deepseek-official')
    assert.equal(t?.source, 'probe')

    const llm2 = mkLlm(['q4b'])
    const t2 = probeCloudTarget({ llm: llm2, getAgentDefaultModel: () => undefined } as any, cfg())
    assert.equal(t2?.provider, 'q4b')
  })

  it('step 4: no usable host route → null', () => {
    const llm = mkLlm(['cloud-llm', 'local-llm'])
    assert.equal(probeCloudTarget({ llm, getAgentDefaultModel: () => undefined } as any, cfg()), null)
  })

  it('kill switch: delegateEnabled=false → null', () => {
    const llm = mkLlm(['deepseek-official'])
    assert.equal(probeCloudTarget({ llm, getAgentDefaultModel: () => undefined } as any, cfg({ delegateEnabled: false })), null)
  })

  it('broken registry surfaces never throw out of the probe', () => {
    const badLlm = { listProviders() { throw new Error('boom') } }
    assert.equal(probeCloudTarget({ llm: badLlm, getAgentDefaultModel: () => undefined } as any, cfg()), null)
  })
})

describe('§7.100 CloudLlmDelegateAdapterImpl.stream', () => {
  it('forwards to the selected host route, overriding provider + model', async () => {
    const llm = mkLlm(['deepseek-account'])
    const d = new CloudLlmDelegateAdapterImpl(
      cfg(),
      { llm, getAgentDefaultModel: () => ({ currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) }) } as any,
    )
    const out = await drain(d.stream({ provider: 'cloud-llm', model: 'deepseek-chat', messages: [] } as any))
    assert.deepEqual(llm.calls, [{ provider: 'deepseek-account', model: 'deepseek-flash' }])
    // verbatim passthrough — no synthesized terminal chunks (would double finish)
    assert.equal(out.length, 2)
    assert.equal(out[0].type, 'text-delta')
    assert.equal(out[1].type === 'finish' && out[1].reason.kind, 'stop')
  })

  it('missing model on selection resolves host first model id', async () => {
    const llm = mkLlm(['deepseek-official'], { modelsByProvider: { 'deepseek-official': [{ provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'deepseek-v4-flash' }] } })
    const d = new CloudLlmDelegateAdapterImpl(
      cfg(),
      { llm, getAgentDefaultModel: () => ({ currentSelection: () => ({ provider: 'deepseek-official' }) }) } as any,
    )
    await drain(d.stream({ provider: 'cloud-llm', model: 'placeholder', messages: [] } as any))
    assert.equal(llm.calls[0]!.model, 'deepseek-v4-flash')
  })

  it('no target → LlmError NO_CLOUD_TARGET, never a silent zero-chunk stream', async () => {
    const llm = mkLlm(['cloud-llm', 'local-llm'])
    const d = new CloudLlmDelegateAdapterImpl(cfg(), { llm, getAgentDefaultModel: () => undefined } as any)
    await assert.rejects(
      () => drain(d.stream({ provider: 'cloud-llm', model: 'm', messages: [] } as any)),
      (err: any) => err.code === 'NO_CLOUD_TARGET',
    )
    assert.equal(llm.calls.length, 0)
  })

  it('runaway tool-call parity (§7.47.5) trips through the delegate', async () => {
    const script = [
      { type: 'tool-call-delta', index: 0, partial: { id: '1', name: 't', arguments: '{}' } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
    let tripped = false
    for (let i = 0; i < 22; i++) {
      const llm = mkLlm(['deepseek-official'], { script })
      const d = new CloudLlmDelegateAdapterImpl(cfg(), { llm, getAgentDefaultModel: () => undefined } as any)
      try {
        await drain(d.stream({ provider: 'cloud-llm', model: 'm', messages: [], sessionId: 'runaway-sess' } as any))
      } catch (err: any) {
        if (err.code === 'MAX_TURNS_EXCEEDED') { tripped = true; break }
        throw err
      }
    }
    assert.ok(tripped)
  })

  it('listModels proxies the target provider; resolveModel re-labels provider but keeps contextWindow', async () => {
    const llm = mkLlm(['deepseek-official'], { modelsByProvider: { 'deepseek-official': [{ provider: 'deepseek-official', id: 'dm', name: 'dm' }] } })
    const d = new CloudLlmDelegateAdapterImpl(
      cfg(),
      { llm, getAgentDefaultModel: () => ({ currentSelection: () => ({ provider: 'deepseek-official', model: 'dm' }) }) } as any,
    )
    const models = await d.listModels('cloud-llm')
    assert.equal(models[0]!.id, 'dm')
    const info = await d.resolveModel('cloud-llm', 'whatever')
    assert.equal(info.provider, 'cloud-llm')   // re-labeled onto the route the caller picked
    assert.equal(info.context?.contextWindow, 32768) // §7.43 compaction reads this off our return
  })
})

describe('§7.100 apply() dispatch', () => {
  it('empty baseUrl registers the delegate adapter and subscribes llm/adapters-updated', async () => {
    const llm = mkLlm(['deepseek-official'])
    const ctx = mkCtx(llm, { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    const dispose = await apply(ctx as any, cfg())
    assert.equal(llm.registered.length, 1)
    assert.ok(llm.registered[0]!.adapter instanceof CloudLlmDelegateAdapterImpl)
    assert.equal(typeof ctx.handlers['llm/adapters-updated'], 'function')
    await dispose()
    assert.equal(llm.disposed, true)
    assert.equal(ctx.handlers['llm/adapters-updated'], undefined, 'listener disposed too')
  })

  it('explicit baseUrl keeps the direct adapter (zero-change regression fence)', async () => {
    const llm = mkLlm(['deepseek-official'])
    const ctx = mkCtx(llm)
    await apply(ctx as any, cfg({ baseUrl: 'https://api.deepseek.com' }))
    assert.equal(llm.registered[0]!.adapter.constructor.name, 'CloudLlmAdapterImpl')
  })

  it('DUPLICATE_ADAPTER → stands down loudly, apply never throws, security audit emitted', async () => {
    const llm = mkLlm(['cloud-llm'], { duplicate: true })
    const ctx = mkCtx(llm)
    const audits: string[] = []
    ctx.auditLog = { log: async (e: any) => { audits.push(e.kind) } }
    const dispose = await apply(ctx as any, cfg())
    await dispose()
    assert.ok(audits.includes('llm.cloud.registration.duplicate'))
  })
})
