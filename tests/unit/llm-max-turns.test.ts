/**
 * Unit tests for the shared per-session counter module
 * `src/dsh-adapter/llm-max-turns.ts`.
 *
 * §7.50 (2026-09-13): added tests for the new SSE retry budget counter
 * (`tryConsumeSseRetryBudget` / `resetSessionSseRetryCount` /
 * `peekSessionSseRetryCount`). The pre-existing tool-call counter is
 * also covered for symmetry — both counters share the same Map pattern
 * and 5-min prune cadence.
 */
import { describe, expect, it } from 'vitest'

import {
  MAX_CONSECUTIVE_TOOL_CALLS,
  MAX_SSE_RETRIES_PER_SESSION,
  bumpSessionToolCallCount,
  peekSessionSseRetryCount,
  peekSessionToolCallCount,
  resetSessionSseRetryCount,
  resetSessionToolCallCount,
  tryConsumeSseRetryBudget,
} from '../../src/dsh-adapter/llm-max-turns.js'

describe('llm-max-turns: tool-call counter', () => {
  it('bumps per-session count and reads via peek', () => {
    const sessionId = `toolcall-${Date.now()}-1`
    expect(peekSessionToolCallCount(sessionId)).toBe(0)
    expect(bumpSessionToolCallCount(sessionId)).toBe(1)
    expect(bumpSessionToolCallCount(sessionId)).toBe(2)
    expect(peekSessionToolCallCount(sessionId)).toBe(2)
    resetSessionToolCallCount(sessionId)
    expect(peekSessionToolCallCount(sessionId)).toBe(0)
  })

  it('falls back to "default" key for missing/empty sessionId', () => {
    expect(peekSessionToolCallCount(undefined)).toBe(0)
    bumpSessionToolCallCount(undefined)
    expect(peekSessionToolCallCount(undefined)).toBe(1)
    bumpSessionToolCallCount('')
    // same "default" bucket — counter accumulates
    expect(peekSessionToolCallCount('')).toBe(2)
    resetSessionToolCallCount('')
    expect(peekSessionToolCallCount(undefined)).toBe(0)
  })

  it('exports a sane threshold for MAX_CONSECUTIVE_TOOL_CALLS', () => {
    expect(MAX_CONSECUTIVE_TOOL_CALLS).toBe(20)
  })
})

describe('llm-max-turns: SSE retry budget (§7.50)', () => {
  it('consumes up to MAX_SSE_RETRIES_PER_SESSION attempts then refuses', () => {
    const sessionId = `sse-${Date.now()}-1`
    expect(peekSessionSseRetryCount(sessionId)).toBe(0)
    expect(MAX_SSE_RETRIES_PER_SESSION).toBe(1)

    expect(tryConsumeSseRetryBudget(sessionId)).toBe(true)
    expect(peekSessionSseRetryCount(sessionId)).toBe(1)
    // Second call exhausts budget → returns false so caller throws.
    expect(tryConsumeSseRetryBudget(sessionId)).toBe(false)
    expect(peekSessionSseRetryCount(sessionId)).toBe(1)

    // Reset clears the bucket so a future successful call starts fresh.
    resetSessionSseRetryCount(sessionId)
    expect(peekSessionSseRetryCount(sessionId)).toBe(0)
    expect(tryConsumeSseRetryBudget(sessionId)).toBe(true)
  })

  it('separates budget across sessions', () => {
    const sA = `sse-${Date.now()}-A`
    const sB = `sse-${Date.now()}-B`
    // Session A consumes its budget.
    expect(tryConsumeSseRetryBudget(sA)).toBe(true)
    expect(tryConsumeSseRetryBudget(sA)).toBe(false)
    // Session B is independent.
    expect(tryConsumeSseRetryBudget(sB)).toBe(true)
    expect(peekSessionSseRetryCount(sB)).toBe(1)
    expect(peekSessionSseRetryCount(sA)).toBe(1)
  })

  it('falls back to "default" key for missing/empty sessionId', () => {
    // Use a fresh bucket by resetting first.
    resetSessionSseRetryCount(undefined)
    expect(tryConsumeSseRetryBudget(undefined)).toBe(true)
    expect(tryConsumeSseRetryBudget(undefined)).toBe(false)
    // '' resolves to the same "default" bucket as undefined.
    expect(tryConsumeSseRetryBudget('')).toBe(false)
    resetSessionSseRetryCount('')
    expect(peekSessionSseRetryCount(undefined)).toBe(0)
  })

  it('reset on successful stream allows future retries in same session', () => {
    const sessionId = `sse-${Date.now()}-reset`
    expect(tryConsumeSseRetryBudget(sessionId)).toBe(true)
    expect(tryConsumeSseRetryBudget(sessionId)).toBe(false)
    // Stream completes → resetSessionSseRetryCount called by adapter
    resetSessionSseRetryCount(sessionId)
    // Next call in this session has a fresh budget.
    expect(tryConsumeSseRetryBudget(sessionId)).toBe(true)
  })
})