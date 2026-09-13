/**
 * §7.47.5 (2026-09-13) shared module: per-session consecutive tool-call
 * runaway guard for LLM adapters.
 *
 * Originally introduced in §7.42 (2026-09-05, local-llm-adapter only) as
 * MAX_CONSECUTIVE_TOOL_CALLS guard. §7.47.5 discovered that cloud-llm-adapter
 * never adopted the guard, so cloud models (DeepSeek) could loop tool-calls
 * indefinitely — news用例 hits the bug deterministically: "查询最新的AI新闻"
 * triggers web_search → web_fetch cycles that never terminate with text
 * (DeepSeek picks "call more tools" over "synthesize answer"), eventually
 * dsh-agent-loop upper layer aborts with unknown reason → resultLen=0 →
 * user sees empty reply.
 *
 * User feedback 2026-09-13: "每次修BUG通过日志来修理，确保日志里有所有错误的信息"
 * — ops log showed 5+ tool-calls + chat finished reason=unknown + 0 errors,
 * completely hiding the runaway. Adding the guard makes the failure mode
 * visible (audit event + throw with deterministic MAX_TURNS_EXCEEDED code).
 *
 * The module-level Map + prune logic is shared between both adapters so
 * we get unified session-level accounting: a session running across both
 * adapters (e.g. classifier fallback LOCAL → CLOUD) maintains a single count.
 */

export const MAX_CONSECUTIVE_TOOL_CALLS = 20

interface ToolCallRunEntry {
  count: number
  lastSeen: number
}

const _sessionToolCallRuns = new Map<string, ToolCallRunEntry>()
let _pruneCounter = 0

/** Resolve session key from GenerateOptions. Empty/missing falls back to 'default'. */
function resolveSessionKey(sessionId: unknown): string {
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : 'default'
}

/**
 * Increment the consecutive-tool-call counter for this session and check
 * whether it has exceeded the runaway threshold. Side effects:
 *   - bumps the counter on each call (caller should only invoke when the
 *     response was finishKind='tool-calls' with no text progress)
 *   - periodically prunes stale entries (every 100 calls, drops entries
 *     unseen for >5 min)
 *   - resets the counter on natural-termination finish (stop / length)
 *
 * Returns the new count after increment. Caller decides whether to throw
 * based on `> MAX_CONSECUTIVE_TOOL_CALLS`. We separate the increment + the
 * throw so the audit + logger emit can fire BEFORE the throw (so ops log
 * records the runaway even when the throw aborts the stream).
 */
export function bumpSessionToolCallCount(sessionId: unknown): number {
  const key = resolveSessionKey(sessionId)
  const now = Date.now()
  const entry = _sessionToolCallRuns.get(key) ?? { count: 0, lastSeen: now }
  entry.count += 1
  entry.lastSeen = now
  _sessionToolCallRuns.set(key, entry)

  if (++_pruneCounter % 100 === 0) {
    const cutoff = now - 5 * 60 * 1000
    for (const [k, v] of _sessionToolCallRuns) {
      if (v.lastSeen < cutoff) _sessionToolCallRuns.delete(k)
    }
  }
  return entry.count
}

/** Reset the counter for this session (called when the agent loop terminates
 *  naturally — finishKind=stop / length). */
export function resetSessionToolCallCount(sessionId: unknown): void {
  const key = resolveSessionKey(sessionId)
  _sessionToolCallRuns.delete(key)
}

/** Read-only accessor for tests / ops log debugging. */
export function peekSessionToolCallCount(sessionId: unknown): number {
  const key = resolveSessionKey(sessionId)
  return _sessionToolCallRuns.get(key)?.count ?? 0
}