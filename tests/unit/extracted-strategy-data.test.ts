/**
 * §7.123 (2026-10-27) — the extracted strategy-data modules.
 *
 * `intent-signals.ts` (keyword/entity tables + fallback taxonomy) and
 * `intent-prompts.ts` (the two prompt templates) were pulled out of the
 * 2900-line `intent-router.ts`. They are now directly testable, which
 * matters for two invariants that were previously only implicit in a
 * string-concatenation expression buried in the class:
 *
 *   1. The CLOUD keyword list must NOT contain bare query VERBS. A verb is
 *      a query *action*, not an online-object signal — "查" fired on
 *      "检查一下设备" and routed a local request to the cloud (2026-09-15
 *      incident, §7.58).
 *   2. The LOCAL catch-all wording must be VERBATIM IDENTICAL in the two
 *      prompt surfaces (the local LLM classifier and the Bailian
 *      decision-model). If they drift, the two backends classify the same
 *      query differently — the exact bug §7.115.1 had to fix by hand.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import {
  LOCAL_KEYWORDS_DEFAULT,
  CLOUD_KEYWORDS_DEFAULT,
  LOCAL_ENTITY_KEYWORDS_DEFAULT,
  CATEGORIES_FALLBACK,
  RULE_CATEGORIES,
  JEV_MAX_INTENTS,
} from '../../src/dsh-adapter/intent-signals.ts'
import {
  buildClassificationPrompt,
  buildJevIntentCriteria,
  CLASSIFIER_HEADER,
  CONFIDENCE_LEGEND,
  JEV_INTENT_INSTRUCTIONS,
  JEV_RISK_CRITERIA,
  LOCAL_CATCHALL_DESCRIPTION,
} from '../../src/dsh-adapter/intent-prompts.ts'
import {
  findLastUserText,
  findUserTexts,
  replaceAtUserIndex,
  replaceUserTextsAt,
} from '../../src/dsh-adapter/input-guard-messages.ts'

describe('intent-signals — the built-in routing vocabulary', () => {
  it('the CLOUD keyword list contains NO bare query verbs (§7.58)', () => {
    // These fired on local phrasing and cost a cloud round-trip.
    const forbidden = ['搜索', '查询', '查找', '搜', '查', 'search', 'query', 'find', 'look up']
    for (const verb of forbidden) {
      assert.ok(
        !CLOUD_KEYWORDS_DEFAULT.includes(verb),
        `"${verb}" 是查询动作而非公网对象信号，不得出现在 CLOUD 关键词表`,
      )
    }
  })

  it('the CLOUD keyword list keeps the online-OBJECT nouns', () => {
    for (const noun of ['新闻', '最新', '实时', '热搜', '天气', 'news', 'latest', 'weather']) {
      assert.ok(CLOUD_KEYWORDS_DEFAULT.includes(noun), `缺少公网对象信号 "${noun}"`)
    }
  })

  it('the CLOUD keyword list does not contain the ambiguous single words (§7.107)', () => {
    // 「今天」("今天开会吗") 「消息」("发个消息给张三") 「进展」「动态」are
    // ordinary device-side wording — they used to cost a cloud round-trip.
    for (const word of ['今天', '消息', '进展', '动态', 'today']) {
      assert.ok(
        !CLOUD_KEYWORDS_DEFAULT.includes(word),
        `"${word}" 是日常措辞，不得单独构成出网信号`,
      )
    }
  })

  it('the LOCAL keyword list is non-empty and covers both languages', () => {
    assert.ok(LOCAL_KEYWORDS_DEFAULT.length > 0)
    assert.ok(LOCAL_KEYWORDS_DEFAULT.some((k) => /[一-龥]/u.test(k)), '应有中文词')
    assert.ok(LOCAL_KEYWORDS_DEFAULT.some((k) => /^[a-z]+$/u.test(k)), '应有英文词')
  })

  it('the LOCAL entity list pins the LOCAL-only product entities (§7.58)', () => {
    assert.ok(LOCAL_ENTITY_KEYWORDS_DEFAULT.includes('密盒'))
    assert.ok(LOCAL_ENTITY_KEYWORDS_DEFAULT.includes('ets'))
    assert.ok(LOCAL_ENTITY_KEYWORDS_DEFAULT.includes('etscli'))
  })

  it('the fallback taxonomy covers all four categories', () => {
    assert.deepEqual(
      CATEGORIES_FALLBACK.map((c) => c.id),
      ['LOCAL', 'CLOUD', 'SANITIZED', 'REJECT'],
    )
    for (const cat of CATEGORIES_FALLBACK) {
      assert.ok(cat.description.length > 0, `${cat.id} 缺少描述`)
      assert.ok(cat.jevIntents.length > 0, `${cat.id} 缺少 jevIntents`)
    }
  })

  it('the rule-tier category union matches the 4-category model', () => {
    assert.deepEqual([...RULE_CATEGORIES], ['LOCAL', 'CLOUD', 'SANITIZED', 'REJECT'])
  })

  it('the jev intent batch cap is 16 (§7.92.5 upstream hard cap)', () => {
    assert.equal(JEV_MAX_INTENTS, 16)
  })
})

describe('intent-prompts — the two prompt surfaces', () => {
  const taxonomy = [
    { id: 'CLOUD' as const, description: '需要联网的任务', jevIntents: ['天气'] },
    { id: 'REJECT' as const, description: '危险请求', jevIntents: ['投诉'] },
  ]

  it('the LOCAL catch-all line is appended when the taxonomy has no LOCAL row (§7.110)', () => {
    const { prompt, categoryUnion, categoryLines } = buildClassificationPrompt({
      categories: taxonomy,
      historyBlock: '',
      promptText: '规划黄山两日游',
    })
    assert.ok(categoryLines.includes('- LOCAL：'))
    assert.ok(categoryLines.includes(LOCAL_CATCHALL_DESCRIPTION))
    assert.ok(categoryUnion.includes('LOCAL'))
    assert.ok(prompt.includes(CLASSIFIER_HEADER))
    assert.ok(prompt.includes(CONFIDENCE_LEGEND))
    assert.ok(prompt.includes('规划黄山两日游'))
  })

  it('NO catch-all line is added when the taxonomy already defines LOCAL', () => {
    const { categoryLines } = buildClassificationPrompt({
      categories: [
        { id: 'LOCAL' as const, description: '本地操作', jevIntents: ['文件操作'] },
        { id: 'CLOUD' as const, description: '需要联网', jevIntents: ['天气'] },
      ],
      historyBlock: '',
      promptText: 'hi',
    })
    assert.equal((categoryLines.match(/- LOCAL：/gu) ?? []).length, 1)
  })

  it('the history block is inserted into the prompt verbatim', () => {
    const historyBlock = '\n最近对话上下文（仅参考，不要分类历史消息本身）：\n- 用户：上一句\n'
    const { prompt } = buildClassificationPrompt({
      categories: taxonomy,
      historyBlock,
      promptText: '继续',
    })
    assert.ok(prompt.includes(historyBlock))
  })

  it('the two prompt surfaces use the VERBATIM-IDENTICAL LOCAL catch-all (§7.115.1)', () => {
    // If these drift, the local classifier and the Bailian decision-model
    // classify the same query differently — the exact bug that had to be
    // fixed by hand in §7.115.1.
    const criteria = buildJevIntentCriteria(taxonomy)
    assert.equal(criteria.LOCAL, LOCAL_CATCHALL_DESCRIPTION)

    const { categoryLines } = buildClassificationPrompt({
      categories: taxonomy,
      historyBlock: '',
      promptText: 'x',
    })
    assert.ok(categoryLines.includes(criteria.LOCAL))
  })

  it('the decision-model criteria carry every taxonomy category + the risk scale', () => {
    const criteria = buildJevIntentCriteria(taxonomy)
    assert.equal(criteria.CLOUD, '需要联网的任务')
    assert.equal(criteria.REJECT, '危险请求')
    assert.equal(JEV_RISK_CRITERIA.length, 4)
    assert.ok(JEV_INTENT_INSTRUCTIONS.length > 0)
  })
})

describe('input-guard-messages — the message-array contract', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'reply' },
    { role: 'user', content: 'second' },
  ]

  it('findLastUserText returns the last user turn', () => {
    const found = findLastUserText(messages)
    assert.ok(found)
    assert.equal(found!.text, 'second')
    assert.equal(found!.index, 3)
  })

  it('findUserTexts returns EVERY user turn', () => {
    const all = findUserTexts(messages)
    assert.equal(all.length, 2)
    assert.deepEqual(all.map((u) => u.text), ['first', 'second'])
    assert.deepEqual(all.map((u) => u.index), [1, 3])
  })

  it('findUserTexts ignores assistant / system turns', () => {
    const all = findUserTexts([
      { role: 'system', content: 'a@b.com' },
      { role: 'assistant', content: 'a@b.com' },
    ])
    assert.deepEqual(all, [])
  })

  it('findUserTexts joins multi-block text content', () => {
    const all = findUserTexts([
      { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
    ])
    assert.equal(all.length, 1)
    assert.equal(all[0].text, 'ab')
  })

  it('replaceAtUserIndex rewrites a string content', () => {
    const out = replaceAtUserIndex(messages, 1, 'X')
    assert.equal(out[1].content, 'X')
    assert.equal(messages[1].content, 'first', '原数组不可变')
  })

  it('replaceAtUserIndex merges multi-block text content into one block', () => {
    const out = replaceAtUserIndex(
      [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image', url: 'x' }, { type: 'text', text: 'b' }] }],
      0,
      'Z',
    )
    const content = out[0].content as any[]
    assert.equal(content.length, 2)
    assert.deepEqual(content[0], { type: 'text', text: 'Z' })
    assert.deepEqual(content[1], { type: 'image', url: 'x' }, '非 text block 必须保留')
  })

  it('replaceAtUserIndex ignores an out-of-range index', () => {
    const out = replaceAtUserIndex(messages, 99, 'X')
    assert.equal(out.length, messages.length)
    assert.equal(out[1].content, 'first')
  })

  it('replaceUserTextsAt rewrites several turns at once', () => {
    const out = replaceUserTextsAt(messages, new Map([[1, 'A'], [3, 'B']]))
    assert.equal(out[1].content, 'A')
    assert.equal(out[3].content, 'B')
    assert.equal(out[0].content, 'sys')
    assert.equal(out[2].content, 'reply')
  })
})
