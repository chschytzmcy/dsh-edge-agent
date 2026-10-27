/**
 * intent-prompts — the PROMPT TEMPLATES for the intent router.
 *
 * §7.123 (2026-10-27): these templates lived inline in `intent-router.ts`
 * (2923 lines). They are pure string construction over the operator's
 * taxonomy, so they belong with the strategy data (see `./intent-signals.ts`),
 * not with the classifier machinery. Keeping them here makes the two prompt
 * surfaces — the local LLM classifier and the Bailian decision-model —
 * reviewable side by side, which matters because they MUST agree (the LOCAL
 * catch-all wording is deliberately verbatim-identical in both).
 *
 * @module dsh-edge-agent/intent-prompts
 */

import type { IntentCategory } from './privacy-policy.js'
import { LOCAL_CATCHALL_DESCRIPTION } from './intent-signals.js'

// Re-exported: the catch-all wording is part of this module's public
// contract — the two prompt surfaces must use it verbatim, and a test that
// pins "both surfaces agree" needs to name it.
export { LOCAL_CATCHALL_DESCRIPTION }

/** The instruction shown above the category list in the LLM classifier. */
export const CLASSIFIER_HEADER = '判断以下用户请求属于哪类：'

/**
 * Confidence calibration legend.
 *
 * 2026-08-25: qwen3-4b tends to always output 0.98-0.99 regardless of
 * actual certainty, making the 0.6 gate ineffective. The explicit legend
 * teaches the model to differentiate clear vs ambiguous requests.
 */
export const CONFIDENCE_LEGEND = `confidence 含义：
- 1.0 = 非常确定（请求明确属于该类别，无歧义）
- 0.7 = 较确定（请求大概率属于该类别，但有少许模糊）
- 0.5 = 不确定（请求模糊，可能是 LOCAL 也可能是 CLOUD）
- <0.5 = 完全不确定（无法判断类别）`

/** The Bailian decision-model's intent question instructions. */
export const JEV_INTENT_INSTRUCTIONS =
  '这个用户请求应该路由到哪个处理域？只选一个最合适的。'

/** The Bailian decision-model's risk question instructions. */
export const JEV_RISK_INSTRUCTIONS = '这个请求的危险程度如何？'

/** The 4 danger levels the decision-model scores against (score/3 → 0..1). */
export const JEV_RISK_CRITERIA: readonly string[] = [
  '正常请求，无风险',
  '轻微可疑，需要留意',
  '明显危险操作',
  '高危/违法/破坏性请求',
]

export interface ClassificationPromptInput {
  /** The operator's taxonomy (from the privacy policy, hot-reloadable). */
  categories: readonly IntentCategory[]
  /** Pre-rendered recent-conversation block ('' when there is no history). */
  historyBlock: string
  /** The user request to classify (already truncated to `maxInput`). */
  promptText: string
}

export interface ClassificationPrompt {
  /** The full prompt handed to the local classifier model. */
  prompt: string
  /** The category union the model may answer with, e.g. `LOCAL|CLOUD`. */
  categoryUnion: string
  /** The rendered category lines (debug / audit visibility). */
  categoryLines: string
}

/**
 * Build the local-LLM classifier prompt.
 *
 * §7.92.3 (2026-09-23): the category list is built from the policy's
 * `categories[]` (hot-reloadable) — the LLM sees ALL of LOCAL/CLOUD/
 * SANITIZED/REJECT, giving it a path to surface SANITIZED/REJECT verdicts
 * without a separate rules pass. Order matches the policy file so
 * operators control priority by reordering rows.
 *
 * §7.110 (2026-10-24): 默认本地 — the operator's taxonomy only needs to
 * POSITIVELY define the exceptions (CLOUD / REJECT); LOCAL is the catch-all
 * default and may ship no row at all. When the policy has no LOCAL row, a
 * fixed catch-all line is appended and LOCAL is included in the output
 * union so the model can express "neither of the above".
 */
export function buildClassificationPrompt(input: ClassificationPromptInput): ClassificationPrompt {
  const hasLocalRow = input.categories.some((c) => c.id === 'LOCAL')
  const categoryLines = input.categories.map((c) => `- ${c.id}：${c.description}`).join('\n')
    + (hasLocalRow ? '' : `\n- LOCAL：${LOCAL_CATCHALL_DESCRIPTION}`)
  const categoryUnion = Array.from(new Set([
    ...input.categories.map((c) => c.id),
    'LOCAL' as const,
  ])).join('|')

  const prompt = `${CLASSIFIER_HEADER}
${categoryLines}
${input.historyBlock}
Respond ONLY with a single JSON object — no prose, no Markdown:
{ "category": ${categoryUnion}, "confidence": <0.0-1.0> }

${CONFIDENCE_LEGEND}

用户请求：${input.promptText}`

  return { prompt, categoryUnion, categoryLines }
}

/**
 * Build the Bailian decision-model's intent criteria.
 *
 * §7.110 alignment (§7.115.1 fix): after the taxonomy was simplified to
 * "default LOCAL", a policy without a LOCAL row would leave the
 * decision-model choosing between CLOUD/REJECT only — pushing everyday
 * questions into CLOUD (and, at ≥ the semantic threshold, out to the
 * network). The LOCAL catch-all must therefore be present here too, with
 * wording VERBATIM identical to the LLM prompt's catch-all line so the two
 * backends cannot drift.
 */
export function buildJevIntentCriteria(
  categories: readonly IntentCategory[],
): Record<string, string> {
  const criteria: Record<string, string> = {}
  for (const cat of categories) criteria[cat.id] = cat.description
  if (!categories.some((c) => c.id === 'LOCAL')) {
    criteria.LOCAL = LOCAL_CATCHALL_DESCRIPTION
  }
  return criteria
}
