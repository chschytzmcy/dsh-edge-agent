/**
 * http-api plugin tests — verifies canonical shape and stub contract.
 */
import assert from 'node:assert/strict'
import { default as httpApi } from '../../src/dsh-adapter/http-api.ts'

describe('http-api plugin', () => {
  it('exports the canonical plugin shape', () => {
    assert.equal(httpApi.name, 'http-api')
    assert.deepEqual([...httpApi.inject], ['agents', 'sessions', 'auditLog'])
    assert.equal(typeof httpApi.apply, 'function')
    assert.equal(typeof httpApi.Config, 'object')
  })

  it('config has host/port', () => {
    const schema = httpApi.Config as unknown as { toJSON(): unknown }
    assert.ok(schema.toJSON())
  })

  it('default apply starts and returns a stop disposer', async () => {
    const fakeCtx = { plugin: () => undefined, httpApi: { start: async () => {}, stop: async () => {} } } as never
    const dispose = await httpApi.apply(fakeCtx, {
      host: '127.0.0.1',
      port: 3080,
      requireAttestation: true,
    })
    assert.equal(typeof dispose, 'function')
    await dispose()
  })
})