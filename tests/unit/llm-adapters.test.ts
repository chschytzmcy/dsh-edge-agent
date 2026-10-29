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
    // §7.152 (2026-10-29)：+sanitizer / +modelRouter —— DIRECT 云池的出网准备器
    // (CloudEgressGuard.prepare) 直取这两个服务；宿主树布局（独立 HTTP profile）
    // 没有 row 级 inject 覆盖，未声明=Proxy 抛 ⇒ 整轮 SANITIZE_FAILED 502（实机
    // 复现）。刻意不用 ctx.get+静默兜底改 sanitizer：拿不到 sanitizer 还出网就是
    // fail-open 送未脱敏文本，隐私方向不可让。preset 布局 row 级 inject 覆盖本
    // 声明，那边行为不变（§7.151 的软取路径）。详见 src 注释。
    assert.deepEqual([...cloudAdapter.inject], ['llm', 'auditLog', 'inputGuard', 'sanitizer', 'modelRouter'])
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
      providers: ['local-llm'],
      baseUrl: 'http://127.0.0.1:8080/v1',
      defaultModel: 'qwen3-4b',
    })
    assert.equal(registered.length, 1)
    assert.deepEqual((registered[0] as { providers: string[] }).providers, ['local-llm'])
    await dispose()
  })

  it('cloud adapter registers itself on the LLM runtime', async () => {
    const registered: unknown[] = []
    const fakeCtx = {
      plugin: () => undefined,
      llm: { registerAdapter: (providers: string[], adapter: unknown) => { registered.push({ providers, adapter }); return () => {} } },
    } as never
    const dispose = await cloudAdapter.apply(fakeCtx, {
      providers: ['cloud-llm'],
      baseUrl: 'https://api.deepseek.com',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
    })
    assert.equal(registered.length, 1)
    assert.deepEqual((registered[0] as { providers: string[] }).providers, ['cloud-llm'])
    await dispose()
  })
})