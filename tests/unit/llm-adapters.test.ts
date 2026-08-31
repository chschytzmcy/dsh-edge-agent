/**
 * llm-adapters plugin tests — verifies the local + cloud adapter pair
 * each register on the LLM runtime via registerAdapter().
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import * as localAdapter from '../../src/dsh-adapter/local-llm-adapter.ts'
import * as cloudAdapter from '../../src/dsh-adapter/cloud-llm-adapter.ts'

describe('llm-adapters', () => {
  it('local-llm-adapter has the canonical shape', () => {
    assert.equal(localAdapter.name, 'local-llm-adapter')
    // 2026-08-31：注入 input-guard 以清洗 orphan tool_call（见 webui 失败复盘）
    assert.deepEqual([...localAdapter.inject], ['llm', 'auditLog', 'inputGuard'])
    assert.equal(typeof localAdapter.apply, 'function')
    assert.ok(localAdapter.Config)
  })

  it('cloud-llm-adapter has the canonical shape', () => {
    assert.equal(cloudAdapter.name, 'cloud-llm-adapter')
    // 2026-08-31：注入 input-guard 以清洗 orphan tool_call（DeepSeek 400 修复）
    assert.deepEqual([...cloudAdapter.inject], ['llm', 'auditLog', 'inputGuard'])
    assert.equal(typeof cloudAdapter.apply, 'function')
    assert.ok(cloudAdapter.Config)
  })

  it('local adapter registers itself on the LLM runtime', async () => {
    const registered: unknown[] = []
    const fakeCtx = {
      plugin: () => undefined,
      llm: { registerAdapter: (providers: string[], adapter: unknown) => { registered.push({ providers, adapter }); return () => {} } },
    } as never
    const dispose = await localAdapter.apply(fakeCtx, {
      providers: ['local-qwen3-4b'],
      baseUrl: 'http://127.0.0.1:8080/v1',
      defaultModel: 'qwen3-4b',
    })
    assert.equal(registered.length, 1)
    assert.deepEqual((registered[0] as { providers: string[] }).providers, ['local-qwen3-4b'])
    await dispose()
  })

  it('cloud adapter registers itself on the LLM runtime', async () => {
    const registered: unknown[] = []
    const fakeCtx = {
      plugin: () => undefined,
      llm: { registerAdapter: (providers: string[], adapter: unknown) => { registered.push({ providers, adapter }); return () => {} } },
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