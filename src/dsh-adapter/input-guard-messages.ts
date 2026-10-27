/**
 * input-guard-messages — message-array helpers for the input guard.
 *
 * §7.123 (2026-10-27): these helpers lived at the bottom of
 * `input-guard.ts` (2086 lines) inside the same file as the hook logic.
 * They are pure functions over the agent's `messages` array — the part of
 * the module that most benefits from being readable (and unit-testable) on
 * its own, because the agent loop's message shape is the thing that keeps
 * changing upstream.
 *
 * The contract they encode:
 *   - `payload.messages` holds the REAL user turns;
 *   - `decision.messages` may carry EXTRA synthetic user-role runtime
 *     context appended by dsh-agent-instructions — that is NOT user
 *     content and must never be rewritten;
 *   - so rewriting is driven by indices collected from `payload.messages`.
 *
 * @module dsh-edge-agent/input-guard-messages
 */

/** Find the last user message with non-empty text content. */
export function findLastUserText(
  messages: ReadonlyArray<Record<string, unknown>>,
): { text: string; index: number } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== 'user') continue
    const content = m.content
    if (typeof content === 'string' && content.length > 0) {
      return { text: content, index: i }
    }
    if (Array.isArray(content)) {
      const texts: string[] = []
      for (const block of content) {
        if (block && typeof block === 'object' && (block as any).type === 'text' && typeof (block as any).text === 'string') {
          texts.push((block as any).text)
        }
      }
      const joined = texts.join('')
      if (joined.length > 0) return { text: joined, index: i }
    }
  }
  return undefined
}

/** Replace the last user message's text (immutable — returns a new array). */
export function replaceLastUserText(
  messages: ReadonlyArray<Record<string, unknown>>,
  newText: string,
): Array<Record<string, unknown>> {
  const found = findLastUserText(messages)
  if (!found) return [...messages]
  return replaceAtUserIndex(messages, found.index, newText)
}

/**
 * Replace the text of the message at `index` (immutable — returns a new array).
 *
 * Used when dsh-agent-instructions appends content at the end of
 * `decision.messages` and we still want to rewrite the ORIGINAL user
 * message (whose index came from `payload.messages`).
 */
export function replaceAtUserIndex(
  messages: ReadonlyArray<Record<string, unknown>>,
  index: number,
  newText: string,
): Array<Record<string, unknown>> {
  if (index < 0 || index >= messages.length) return [...messages]
  const result = [...messages]
  const original = result[index]
  const originalContent = original.content
  if (typeof originalContent === 'string') {
    result[index] = { ...original, content: newText }
  } else if (Array.isArray(originalContent)) {
    // 替换所有 text block 为单个合并的 text block
    const newContent: unknown[] = []
    let replaced = false
    for (const block of originalContent) {
      if (block && typeof block === 'object' && (block as any).type === 'text') {
        if (!replaced) {
          newContent.push({ type: 'text', text: newText })
          replaced = true
        }
        // 后续 text block 丢弃（已合并到 newText）
      } else {
        newContent.push(block)
      }
    }
    if (!replaced) newContent.unshift({ type: 'text', text: newText })
    result[index] = { ...original, content: newContent }
  }
  return result
}

/**
 * Collect EVERY user message in the ORIGINAL payload.
 *
 * §7.123 (2026-10-27): the previous code only ever sanitized the LAST user
 * message. That is a data-egress hole: the agent loop sends the whole
 * conversation to the model, so a phone number the user typed in turn 1 rode
 * along in `messages` history on every later cloud turn — unredacted. The
 * sanitizer is session-scoped, so the same value across turns maps to the
 * same placeholder; the leak was purely "we only rewrote index N".
 *
 * Only messages from `payload.messages` are considered — NOT
 * `decision.messages`, because dsh-agent-instructions appends synthetic
 * user-role runtime context there (a system-injected run context, not user
 * content).
 */
export function findUserTexts(
  messages: ReadonlyArray<Record<string, unknown>>,
): Array<{ text: string; index: number }> {
  const out: Array<{ text: string; index: number }> = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m?.role !== 'user') continue
    const content = m.content
    if (typeof content === 'string' && content.length > 0) {
      out.push({ text: content, index: i })
      continue
    }
    if (Array.isArray(content)) {
      const texts: string[] = []
      for (const block of content) {
        if (block && typeof block === 'object' && (block as any).type === 'text' && typeof (block as any).text === 'string') {
          texts.push((block as any).text)
        }
      }
      const joined = texts.join('')
      if (joined.length > 0) out.push({ text: joined, index: i })
    }
  }
  return out
}

/** Apply a per-index text replacement map to a messages array (immutable). */
export function replaceUserTextsAt(
  messages: ReadonlyArray<Record<string, unknown>>,
  replacements: ReadonlyMap<number, string>,
): Array<Record<string, unknown>> {
  let result: Array<Record<string, unknown>> | undefined
  for (const [index, text] of replacements) {
    result = replaceAtUserIndex(result ?? messages, index, text)
  }
  return result ?? [...messages]
}
