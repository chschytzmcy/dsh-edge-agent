/**
 * http-api-routes — pure route table for the dsh-edge-agent HTTP API.
 *
 * Why a separate module? Adding new endpoints used to mean appending a
 * branch to `handleRequest()`'s if/else chain. With ~13 endpoints, that
 * chain got long enough to make the dispatcher itself hard to read —
 * and impossible to test in isolation. Extracting route definitions lets:
 *
 *   1. unit tests pin the exact set of routes + their auth/summary;
 *   2. the dispatcher shrink to a generic "match → check auth → invoke";
 *   3. OpenAPI spec generation iterate the same source of truth.
 *
 * Design choices:
 *   - Patterns use `{name}` placeholders. The matcher compiles each
 *     pattern into a RegExp once (at first match) and caches it.
 *   - Auth is `public` (no bearer) or `bearer` (require `Authorization`).
 *     We deliberately do NOT expose CORS / origin checks here — the
 *     dual-entry architecture document keeps CORS as a v2 concern
 *     (docs/dual-entry-architecture.md §7.1).
 *   - The handler signature is intentionally minimal: `(ctx, params)`.
 *     All HTTP plumbing (reqId, start, body, accessLog) is built into
 *     `ctx` so handlers don't have to know about the dispatcher.
 *
 * @module dsh-edge-agent/http-api-routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

export type RouteMethod = 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH'

export type Auth = 'public' | 'bearer'

/** Pre-parsed JSON body for routes that opt-in via `body`. `undefined`
 *  for routes that don't need a body (GET/DELETE). The dispatcher parses
 *  the body lazily — only when the matched route declares `body: 'json'`. */
export type RouteBody = any

export interface RouteContext {
  req: IncomingMessage
  res: ServerResponse
  reqId: string
  start: number
  body: RouteBody
}

export interface RouteDef {
  method: RouteMethod
  /** Path pattern with `{name}` placeholders, e.g. `/v1/sessions/{id}/cancel`. */
  pattern: string
  auth: Auth
  /** Set to `'json'` for routes that accept a JSON body. The dispatcher
   *  parses the body BEFORE invoking the handler. */
  body?: 'json'
  /** Free-form summary used by OpenAPI spec generation. */
  summary: string
  /** Async handler. Receives the per-request context and the matched
   *  path params (empty object when the pattern has no placeholders). */
  handler: (ctx: RouteContext, params: Record<string, string>) => Promise<void> | void
}

interface CompiledPattern {
  regex: RegExp
  paramNames: string[]
}

const patternCache = new WeakMap<RouteDef, CompiledPattern>()

function compilePattern(route: RouteDef): CompiledPattern {
  const cached = patternCache.get(route)
  if (cached) return cached
  const paramNames: string[] = []
  // Escape regex metachars except for `{...}` placeholders, which we
  // turn into `([^/]+)` capture groups. The placeholder regex is
  // deliberately restrictive — it won't accept path segments containing
  // slashes, which matches URL semantics for our resource ids.
  const escaped = route.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{([a-zA-Z_][a-zA-Z0-9_]*)\\\}/g, (_m, name: string) => {
    paramNames.push(name)
    return '([^/]+)'
  })
  const regex = new RegExp(`^${escaped}$`)
  const compiled: CompiledPattern = { regex, paramNames }
  patternCache.set(route, compiled)
  return compiled
}

/** Match a `(method, path)` pair against the route table. Returns the
 *  matched route and the extracted path params, or `undefined` when
 *  nothing matches. */
export function findRoute(
  routes: readonly RouteDef[],
  method: string,
  path: string,
): { route: RouteDef; params: Record<string, string> } | undefined {
  for (const route of routes) {
    if (route.method !== method) continue
    const { regex, paramNames } = compilePattern(route)
    const m = regex.exec(path)
    if (!m) continue
    const params: Record<string, string> = {}
    for (let i = 0; i < paramNames.length; i++) {
      params[paramNames[i]] = decodeURIComponent(m[i + 1])
    }
    return { route, params }
  }
  return undefined
}
