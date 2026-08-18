/**
 * llm-adapters plugin tests — verifies the local + cloud adapter pair
 * each register on the LLM runtime via registerAdapter().
 */
import assert from 'node:assert/strict'
import { default as localAdapter } from '../../src/dsh-adapter/local-llm-adapter.ts'
import { default as cloudAdapter } from '../../src/dsh-adapter/cloud-llm-adapter.ts'

describe('llm-adapters', () => {
  it('local-llm-adapter has the canonical shape', () => {
    assert.equal(localAdapter.name, 'local-llm-adapter')
    assert.deepEqual([...localAdapter.inject], [])
    assert.equal(typeof localAdapter.apply, 'function')
    assert.equal(typeof localAdapter.Config, 'object')
  })

  it('cloud-llm-adapter has the canonical shape', () => {
    assert.equal(cloudAdapter.name, 'cloud-llm-adapter')
    assert.deepEqual([...cloudAdapter.inject], ['secureBridge', 'auditLog'])
    assert.equal(typeof cloudAdapter.apply, 'function')
    assert.equal(typeof cloudAdapter.Config, 'object')
  })

  it('local adapter registers itself on the LLM runtime', async () => {
    const registered: unknown[] = []
    const fakeCtx = {
      plugin: () => undefined,
      llm: { registerAdapter: (providers: string[], adapter: unknown) => { registered.push({ providers, adapter }) } },
    } as never
    const dispose = await localAdapter.apply(fakeCtx, {
      providers: ['local-qwen3-4b'],
      modelPath: '/tmp/qwen3-4b.gguf',
      contextSize: 8192,
      threads: 4,
    })
    assert.equal(registered.length, 1)
    assert.deepEqual((registered[0] as { providers: string[] }).providers, ['local-qwen3-4b'])
    await dispose()
  })

  it('cloud adapter registers itself on the LLM runtime', async () => {
    const registered: unknown[] = []
    const fakeCtx = {
      plugin: () => undefined,
      llm: { registerAdapter: (providers: string[], adapter: unknown) => { registered.push({ providers, adapter }) } },
    } as never
    const dispose = await cloudAdapter.apply(fakeCtx, {
      providers: ['cloud-deepseek-v4'],
      baseUrl: 'https://api.deepseek.com',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
    })
    assert.equal(registered.length, 1)
    assert.deepEqual((registered[0] as { providers: string[] }).providers, ['cloud-deepseek-v4'])
    await dispose()
  })
})