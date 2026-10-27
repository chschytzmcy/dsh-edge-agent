/**
 * §7.123 (2026-10-27) — Layer-1 stub contract + the untested config loader.
 *
 * WHY THIS FILE EXISTS
 *
 * The audit found that the whole Layer-1 security base — `tcm`, `ohttp-gateway`,
 * `secure-bridge`, `attestation` — plus `voice-input` and `plugin-host` are
 * STUBS: their crypto / network methods return zero bytes or empty objects
 * regardless of input. The README nevertheless advertised "RFC 9458 OHTTP
 * zero-trust" and "TEE remote attestation" as core features.
 *
 * These tests pin the stub behaviour on purpose. They are NOT a wish for the
 * stubs to keep returning zeros — they are a tripwire: if someone implements
 * a real TEE backend / OHTTP gateway, these assertions FAIL and force the
 * README + docs/architecture.md to be updated in the same change. A stub
 * that is silently upgraded without a doc update is exactly the drift this
 * project keeps getting audited for.
 *
 * The second half of the file covers `edge-config.ts` — the single loader
 * that decides every endpoint, port, timeout and key source, and which had
 * no dedicated test at all.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import * as tcm from '../../src/dsh-adapter/tcm.ts'
import * as ohttp from '../../src/dsh-adapter/ohttp-gateway.ts'
import * as bridge from '../../src/dsh-adapter/secure-bridge.ts'
import * as attestation from '../../src/dsh-adapter/attestation.ts'
import * as voice from '../../src/dsh-adapter/voice-input.ts'
import * as host from '../../src/dsh-adapter/plugin-host.ts'
import * as llmAdapters from '../../src/dsh-adapter/llm-adapters.ts'
import * as aggregator from '../../src/dsh-adapter/dsh-edge-agent.ts'
import * as pluginEntry from '../../src/dsh-adapter/plugin.ts'

import {
  DEFAULT_EDGE_CONFIG,
  loadEdgeConfig,
  resetEdgeConfigCache,
  mergeEdgeConfig,
  resolveSecret,
  localPool,
  cloudPool,
  jevPool,
  edgeHome,
} from '../../src/dsh-adapter/edge-config.ts'

function fakeCtx() {
  return {
    reflect: { provide(_n: string, _v: unknown) { return () => {} } },
    provide(_n: string, _v: unknown) { return () => {} },
    logger: undefined,
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Layer 1 — the stub contract (tripwire, not a wish)
 * ──────────────────────────────────────────────────────────────────────────── */

describe('Layer 1 — tcm (TEE) is a STUB: crypto is not real', () => {
  it('generateKey returns 32 zero bytes regardless of the tag', async () => {
    const svc = new tcm.TcmService(fakeCtx() as any)
    const a = await svc.generateKey('alpha')
    const b = await svc.generateKey('beta')
    assert.equal(a.length, 32)
    assert.ok(a.every((x) => x === 0), 'key 必须全是零字节（stub）')
    assert.deepEqual([...a], [...b], '不同 tag 也返回同一把零 key（stub）')
  })

  it('encrypt/decrypt are the identity function (no confidentiality)', async () => {
    const svc = new tcm.TcmService(fakeCtx() as any)
    const data = new Uint8Array([1, 2, 3, 4, 5])
    const enc = await svc.encrypt(data, 'tag')
    assert.deepEqual([...enc], [...data], 'encrypt 未做任何变换（stub）')
    const dec = await svc.decrypt(enc, 'tag')
    assert.deepEqual([...dec], [...data])
  })

  it('seal/unseal are the identity function', async () => {
    const svc = new tcm.TcmService(fakeCtx() as any)
    const data = new Uint8Array([9, 9])
    assert.deepEqual([...await svc.seal(data)], [...data])
    assert.deepEqual([...await svc.unseal(data)], [...data])
  })

  it('hash returns 32 zero bytes (not a real digest)', async () => {
    const svc = new tcm.TcmService(fakeCtx() as any)
    const h = await svc.hash(new Uint8Array([1, 2, 3]), 'sha-256')
    assert.equal(h.length, 32)
    assert.ok(h.every((x) => x === 0), 'hash 未做任何计算（stub）')
  })

  it('generateAttestation returns an empty, unsigned token', async () => {
    const svc = new tcm.TcmService(fakeCtx() as any)
    const token = await svc.generateAttestation('nonce-1')
    assert.equal(token.payload, '')
    assert.equal(token.signature, '')
    assert.equal(token.teeType, 'simulated')
    assert.equal(token.nonce, 'nonce-1')
  })

  it('getStatus reports the simulated backend', () => {
    const svc = new tcm.TcmService(fakeCtx() as any)
    const st = svc.getStatus()
    assert.equal(st.teeType, 'simulated')
    assert.equal(st.keyCount, 0)
  })

  it('exposes the canonical plugin shape', () => {
    assert.equal(tcm.name, 'tcm')
    assert.deepEqual([...tcm.inject], [])
    assert.equal(typeof tcm.apply, 'function')
    assert.ok(tcm.Config)
  })
})

describe('Layer 1 — ohttp-gateway is a STUB: no HPKE, no relay', () => {
  it('send always answers 200 with an empty body', async () => {
    const svc = new ohttp.OhttpServiceImpl(fakeCtx() as any)
    const res = await svc.send({
      url: 'https://example.invalid/x',
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
      body: new Uint8Array([1, 2, 3]),
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.length, 0)
    assert.deepEqual(res.headers, {})
  })

  it('exposes the canonical plugin shape', () => {
    assert.equal(ohttp.name, 'ohttp-gateway')
    assert.deepEqual([...ohttp.inject], ['tcm', 'auditLog'])
    assert.equal(typeof ohttp.apply, 'function')
  })
})

describe('Layer 1 — secure-bridge is a STUB: no outbound enforcement', () => {
  it('sendCloudRequest always answers 200 and isBlocked() is always false', async () => {
    const svc = new bridge.SecureBridgeServiceImpl(fakeCtx() as any)
    const res = await svc.sendCloudRequest({
      url: 'https://example.invalid/y',
      method: 'POST',
      headers: {},
      body: { secret: true },
    })
    assert.equal(res.status, 200)
    assert.equal(res.body, null)
    assert.equal(svc.isBlocked(), false)
  })

  it('exposes the canonical plugin shape', () => {
    assert.equal(bridge.name, 'secure-bridge')
    assert.deepEqual([...bridge.inject], ['tcm', 'ohttp', 'privacyPolicy', 'auditLog'])
    assert.equal(typeof bridge.apply, 'function')
  })
})

describe('Layer 1 — attestation is a STUB: nothing is verifiable', () => {
  it('verifyToken always reports valid:false', async () => {
    const svc = new attestation.AttestationServiceImpl(fakeCtx() as any)
    const res = await svc.verifyToken('anything')
    assert.equal(res.valid, false)
    assert.equal(res.policyId, '')
  })

  it('generateToken returns an empty string', async () => {
    const svc = new attestation.AttestationServiceImpl(fakeCtx() as any)
    assert.equal(await svc.generateToken('nonce'), '')
  })

  it('exposes the canonical plugin shape', () => {
    assert.equal(attestation.name, 'attestation')
    assert.deepEqual([...attestation.inject], ['tcm', 'auditLog'])
    assert.equal(typeof attestation.apply, 'function')
  })
})

describe('Layer 1 — voice-input is a STUB: transcription returns empty', () => {
  it('transcribe returns an empty string', async () => {
    const svc = new voice.VoiceInputServiceImpl(fakeCtx() as any)
    assert.equal(await svc.transcribe(new Uint8Array([1, 2, 3])), '')
  })

  it('transcribeStream returns an empty string', async () => {
    const svc = new voice.VoiceInputServiceImpl(fakeCtx() as any)
    async function* src() { yield new Uint8Array([1]) }
    assert.equal(await svc.transcribeStream(src()), '')
  })

  it('exposes the canonical plugin shape', () => {
    assert.equal(voice.name, 'voice-input')
    assert.deepEqual([...voice.inject], ['sessions', 'auditLog'])
    assert.equal(typeof voice.apply, 'function')
  })
})

describe('Layer 1 — plugin-host is a STUB: the registry is inert', () => {
  it('registerDescriptor does not register anything', () => {
    const svc = new host.PluginHostServiceImpl(fakeCtx() as any)
    svc.registerDescriptor({ id: 'x', name: 'x', version: '1', grants: [], installedAt: 0 })
    assert.deepEqual(svc.list(), [])
    assert.equal(svc.get('x'), null)
  })

  it('revoke on an unknown id is a no-op', () => {
    const svc = new host.PluginHostServiceImpl(fakeCtx() as any)
    svc.revoke('nope')
    assert.deepEqual(svc.list(), [])
  })

  it('exposes the canonical plugin shape', () => {
    assert.equal(host.name, 'plugin-host')
    assert.deepEqual([...host.inject], ['agents', 'sessions'])
    assert.equal(typeof host.apply, 'function')
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * Aggregator / re-export shims
 * ──────────────────────────────────────────────────────────────────────────── */

describe('bundle entry points', () => {
  it('the bundle aggregator injects only auditLog (must not pend on host services)', () => {
    // §7.33: declaring `invariants` / `localStorage` here made cordis
    // 0.2.1-rc.2 hang pending a service the desktop-safe patch never
    // inserts ("pending (waiting for service: localStorage)"). `auditLog`
    // is the only declared dep.
    assert.equal(aggregator.name, 'dsh-edge-agent')
    assert.deepEqual([...aggregator.inject], ['auditLog'])
    assert.equal(typeof aggregator.apply, 'function')
    assert.ok(aggregator.Config)
  })

  it('plugin.ts wires the boot event + shutdown disposers', async () => {
    assert.equal(typeof pluginEntry.apply, 'function')
    const dispose = await pluginEntry.apply(fakeCtx() as any, {} as any)
    assert.equal(typeof dispose, 'function')
    await dispose()
  })

  it('llm-adapters re-exports both adapter classes', () => {
    assert.equal(typeof llmAdapters.LocalLlmAdapterImpl, 'function')
    assert.equal(typeof llmAdapters.CloudLlmAdapterImpl, 'function')
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * edge-config — the loader that decides every endpoint / port / key
 * ──────────────────────────────────────────────────────────────────────────── */

describe('edge-config loader', () => {
  it('falls back to the built-in defaults when no file is configured', () => {
    // DSH_EDGE_CONFIG_FILE=off (vitest env) → no file candidate is used.
    resetEdgeConfigCache()
    const cfg = loadEdgeConfig(true)
    assert.ok(cfg)
    assert.equal(cfg.http?.port, DEFAULT_EDGE_CONFIG.http?.port)
    assert.equal(cfg.http?.host, DEFAULT_EDGE_CONFIG.http?.host)
  })

  it('mergeEdgeConfig maps a config section onto a plugin Config object in place', () => {
    // §7.102: `mergeEdgeConfig(section, mapping, target)` copies
    // `cfg[section][edgeField]` → `target[configField]`, skipping
    // undefined / null / empty-string values (an empty string means
    // "not configured", not "set to empty").
    const target: Record<string, unknown> = { host: 'default-host', port: 1, untouched: 'keep-me' }
    const out = mergeEdgeConfig('http', { host: 'host', port: 'port' }, target)
    assert.equal(out, target, '原对象就地修改并返回')
    assert.equal(out.host, DEFAULT_EDGE_CONFIG.http?.host)
    assert.equal(out.port, DEFAULT_EDGE_CONFIG.http?.port)
    assert.equal(out.untouched, 'keep-me', '未在 mapping 里的字段不动')
  })

  it('resolveSecret returns undefined for an unknown / empty ref', () => {
    const cfg = { ...DEFAULT_EDGE_CONFIG, secrets: { edgeApiKey: 'abc' } } as any
    assert.equal(resolveSecret(cfg, 'edgeApiKey'), 'abc')
    assert.equal(resolveSecret(cfg, 'nope'), undefined)
    assert.equal(resolveSecret(cfg, undefined), undefined)
    assert.equal(resolveSecret({ secrets: { edgeApiKey: '' } } as any, 'edgeApiKey'), undefined)
  })

  it('localPool resolves the keyRef into a literal api key', () => {
    const cfg = {
      ...DEFAULT_EDGE_CONFIG,
      secrets: { localKey: 'sk-local' },
      llm: { local: { baseUrl: 'http://127.0.0.1:1/v1', model: 'm', keyRef: 'localKey' } },
    } as any
    const pool = localPool(cfg)
    assert.equal(pool.baseUrl, 'http://127.0.0.1:1/v1')
    assert.equal(pool.model, 'm')
    assert.equal(pool.apiKey, 'sk-local')
    assert.equal(pool.stripTools, false)
    assert.equal(pool.enableThinking, false)
    assert.equal(pool.reasoningEffortNone, false)
  })

  it('cloudPool with an empty baseUrl means DELEGATE mode', () => {
    const cfg = {
      ...DEFAULT_EDGE_CONFIG,
      secrets: {},
      llm: { cloud: { baseUrl: '', model: '', keyRef: '', delegate: true } },
    } as any
    const pool = cloudPool(cfg)
    assert.equal(pool.baseUrl, undefined)
    assert.equal(pool.delegate, true)
    assert.equal(pool.apiKey, undefined)
  })

  it('jevPool exposes the intent-recognizer pool', () => {
    const cfg = {
      ...DEFAULT_EDGE_CONFIG,
      secrets: { jevKey: 'sk-jev' },
      jev: { enabled: true, url: 'http://127.0.0.1:8001', provider: 'bailian-decision', apiKeyRef: 'jevKey' },
    } as any
    const pool = jevPool(cfg)
    assert.equal(pool.enabled, true)
    assert.equal(pool.url, 'http://127.0.0.1:8001')
    assert.equal(pool.apiKey, 'sk-jev')
  })

  it('edgeHome builds a path under the edge storage root', () => {
    const home = edgeHome('audit', 'audit.plain.jsonl')
    assert.ok(home.includes('audit'), home)
    assert.ok(home.includes('audit.plain.jsonl'), home)
  })
})
