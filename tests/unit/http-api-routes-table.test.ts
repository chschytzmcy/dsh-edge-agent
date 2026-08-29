/**
 * http-api-routes table tests — pin the route table's method+pattern
 * matrix and path-param extraction.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import { findRoute, type RouteDef } from '../../src/dsh-adapter/http-api-routes.ts'

function fakeRoute(pattern: string, method: 'GET' | 'POST' | 'DELETE' = 'GET', auth: 'public' | 'bearer' = 'bearer'): RouteDef {
  return {
    method,
    pattern,
    auth,
    summary: `fake ${method} ${pattern}`,
    handler: () => {},
  }
}

describe('http-api-routes — findRoute()', () => {
  const routes: RouteDef[] = [
    fakeRoute('/v1/health', 'GET', 'public'),
    fakeRoute('/v1/openapi.json', 'GET', 'public'),
    fakeRoute('/v1/chat', 'POST'),
    fakeRoute('/v1/chat/stream', 'POST'),
    fakeRoute('/v1/sessions', 'GET'),
    fakeRoute('/v1/sessions/{id}', 'GET'),
    fakeRoute('/v1/sessions/{id}', 'DELETE'),
    fakeRoute('/v1/sessions/{id}/cancel', 'POST'),
    fakeRoute('/v1/sessions/{id}/rename', 'POST'),
    fakeRoute('/v1/sessions/{id}/fork', 'POST'),
    fakeRoute('/v1/models', 'GET'),
    fakeRoute('/v1/audit', 'GET'),
  ]

  it('matches public health route', () => {
    const m = findRoute(routes, 'GET', '/v1/health')
    assert.ok(m)
    assert.equal(m?.route.auth, 'public')
    assert.deepEqual(m?.params, {})
  })

  it('matches path params and decodes URL-encoded ids', () => {
    const m = findRoute(routes, 'GET', '/v1/sessions/abc%20def')
    assert.ok(m)
    assert.deepEqual(m?.params, { id: 'abc def' })
  })

  it('distinguishes GET vs DELETE on the same /v1/sessions/{id} pattern', () => {
    const getM = findRoute(routes, 'GET', '/v1/sessions/xyz')
    const delM = findRoute(routes, 'DELETE', '/v1/sessions/xyz')
    assert.equal(getM?.route.summary, 'fake GET /v1/sessions/{id}')
    assert.equal(delM?.route.summary, 'fake DELETE /v1/sessions/{id}')
  })

  it('matches the cancel/rename/fork sub-routes', () => {
    assert.equal(findRoute(routes, 'POST', '/v1/sessions/x/cancel')?.route.pattern, '/v1/sessions/{id}/cancel')
    assert.equal(findRoute(routes, 'POST', '/v1/sessions/x/rename')?.route.pattern, '/v1/sessions/{id}/rename')
    assert.equal(findRoute(routes, 'POST', '/v1/sessions/x/fork')?.route.pattern, '/v1/sessions/{id}/fork')
  })

  it('returns undefined on no match', () => {
    assert.equal(findRoute(routes, 'GET', '/v1/nope'), undefined)
    assert.equal(findRoute(routes, 'PUT', '/v1/health'), undefined)
    assert.equal(findRoute(routes, 'GET', '/v1/sessions/x/cancel'), undefined) // wrong method (POST only)
  })

  it('does NOT match a partial prefix', () => {
    // /v1/sessions should NOT match /v1/sessions/{id} GET — strict equality.
    const m = findRoute(routes, 'GET', '/v1/sessions/x')
    assert.equal(m?.route.pattern, '/v1/sessions/{id}')
    // /v1/sessions itself should match the bare /v1/sessions GET, not the parametrized one.
    const bare = findRoute(routes, 'GET', '/v1/sessions')
    assert.equal(bare?.route.pattern, '/v1/sessions')
  })
})
