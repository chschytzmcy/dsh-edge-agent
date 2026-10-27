/**
 * §7.124 (2026-10-27): 家庭设备操作正则快速层（Tier-0）测试。
 *
 * 用户裁决：「意图识别需要先走正则，快速决策，比如开灯、关门、开空调
 * 这些家庭里家电操作，然后才是决策模型分类，最后才是 llm 分类」。
 *
 * 本文件钉住三件事：
 *
 *   1. **命中**：明确的家电指令被正则层定案为 LOCAL。
 *   2. **顺序**：正则层先于 jev 决策模型 —— 命中时 jev 一次都不被调用。
 *   3. **不误判**：疑问/否定/非指令语境一律不命中，落到下一级。
 *
 * 词表本身在 `./intent-signals.ts`（§7.123 拆出的策略数据模块）。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import { IntentRouterServiceImpl } from '../../src/dsh-adapter/intent-router.ts'
import {
  matchDeviceCommand,
  DEVICE_NOUNS_CN,
  DEVICE_ACTIONS_CN,
} from '../../src/dsh-adapter/intent-signals.ts'

/** A router with NO llm handle and jev DISABLED — so the only thing that can
 *  produce a verdict is the built-in keyword tier. Any LOCAL verdict with a
 *  `device-command:` rationale therefore came from the Tier-0 regex. */
function routerWithoutModels(overrides: Record<string, unknown> = {}) {
  const mockCtx = { reflect: { provide: () => {} }, llm: null } as any
  return new IntentRouterServiceImpl(mockCtx, {
    defaultCategory: 'LOCAL',
    classificationProvider: 'local-llm',
    confidenceThreshold: 0.6,
    jevEnabled: false,
    ...overrides,
  } as any)
}

describe('§7.124 device-command regex tier', () => {
  // ------------------------------------------------------------------
  // 1. 词表匹配 —— 纯函数层
  // ------------------------------------------------------------------
  describe('matchDeviceCommand', () => {
    it('matches plain switch commands (动宾式)', () => {
      for (const text of ['开灯', '关灯', '打开空调', '开空调', '关门', '开电视']) {
        const m = matchDeviceCommand(text)
        assert.ok(m, `expected a match for ${text}`)
        assert.ok(m!.device.length > 0)
      }
    })

    it('matches the inverted order with a disposal prefix (受事前置)', () => {
      const m = matchDeviceCommand('把灯打开')
      assert.ok(m)
      assert.equal(m!.device, '灯')
      assert.equal(m!.action, '打开')
    })

    it('matches the inverted order with a param-class verb', () => {
      const m = matchDeviceCommand('空调调到26度')
      assert.ok(m)
      assert.equal(m!.device, '空调')
      assert.equal(m!.action, '调到')
    })

    it('matches english commands on word boundaries', () => {
      for (const text of ['turn on the light', 'switch off the ac', 'open the door']) {
        assert.ok(matchDeviceCommand(text), `expected a match for ${text}`)
      }
    })

    it('does NOT match a question about a device', () => {
      for (const text of ['怎么开空调', '要不要开灯', '空调的价格', '介绍一下空调']) {
        assert.equal(matchDeviceCommand(text), undefined, `should not match: ${text}`)
      }
    })

    it('does NOT match a negated command', () => {
      for (const text of ['别开灯', '不要关空调']) {
        assert.equal(matchDeviceCommand(text), undefined, `should not match: ${text}`)
      }
    })

    it('does NOT match when the verb and the noun are not adjacent', () => {
      // 「空调」and「打开」both present, but the sentence is about PRICE, not
      // about switching. Adjacency is what separates the two.
      assert.equal(matchDeviceCommand('空调的价格和打开方式'), undefined)
      assert.equal(matchDeviceCommand('打开网页看看'), undefined)
    })

    it('does NOT match a device with no action verb', () => {
      assert.equal(matchDeviceCommand('空调'), undefined)
      assert.equal(matchDeviceCommand('电视开着'), undefined)
    })

    it('does NOT match non-device operations', () => {
      for (const text of ['关闭数据库', '删除文件', '帮我查一下最新新闻']) {
        assert.equal(matchDeviceCommand(text), undefined, `should not match: ${text}`)
      }
    })

    it('honours operator-supplied extension terms', () => {
      const m = matchDeviceCommand('开启加湿器', { devices: ['加湿器'] })
      assert.ok(m)
      assert.equal(m!.device, '加湿器')
    })
  })

  // ------------------------------------------------------------------
  // 2. 顺序 —— 正则层先于 jev
  // ------------------------------------------------------------------
  describe('classify() ordering', () => {
    it('decides a device command via the regex tier, never touching jev', async () => {
      let jevCalled = false
      const mockCtx = {
        reflect: { provide: () => {} },
        llm: null,
        fetch: async () => {
          jevCalled = true
          throw new Error('jev must not be called for a device command')
        },
      } as any
      const service = new IntentRouterServiceImpl(mockCtx, {
        defaultCategory: 'CLOUD',
        classificationProvider: 'local-llm',
        confidenceThreshold: 0.6,
        jevEnabled: true,
        jevUrl: 'http://127.0.0.1:8001',
      } as any)

      const intent = await service.classify('开灯')

      assert.equal(jevCalled, false, 'the regex tier must short-circuit jev')
      assert.equal(intent.category, 'LOCAL')
      assert.equal(intent.targetRealm, 'local')
      assert.match(intent.rationale, /^device-command:/u)
      assert.equal(service.getStats().deviceCommandHit, 1)
    })

    it('routes a device command to LOCAL even when defaultCategory is CLOUD', async () => {
      const service = routerWithoutModels({ defaultCategory: 'CLOUD' })
      const intent = await service.classify('打开空调')
      assert.equal(intent.category, 'LOCAL')
      assert.match(intent.rationale, /^device-command:/u)
    })

    it('marks the regex verdict as a MEASURED confidence (§7.123 provenance)', async () => {
      const service = routerWithoutModels()
      const intent = await service.classify('关灯')
      // A regex verdict is measured, not model-reported — but it is ALSO not
      // a CLOUD verdict, so the semantic-unlock guard is irrelevant here.
      assert.equal(intent.confidenceReported, true)
      assert.equal(intent.confidence, 0.95)
    })

    it('falls through to the next tier when the regex does not match', async () => {
      const service = routerWithoutModels()
      // A plain question — no device command, so the keyword tier decides.
      const intent = await service.classify('帮我查一下最新新闻')
      assert.notEqual(intent.rationale.startsWith('device-command:'), true)
      assert.equal(service.getStats().deviceCommandHit, 0)
    })

    it('does not match an empty input', async () => {
      const service = routerWithoutModels()
      await service.classify('')
      assert.equal(service.getStats().deviceCommandHit, 0)
    })
  })

  // ------------------------------------------------------------------
  // 3. 词表卫生 —— 防止后续维护引入退化
  // ------------------------------------------------------------------
  describe('vocabulary hygiene', () => {
    it('keeps the device nouns specific (no generic placeholders)', () => {
      for (const generic of ['东西', '那个', '它', '东西儿', '设备']) {
        assert.equal(
          DEVICE_NOUNS_CN.includes(generic),
          false,
          `generic noun must not be in the device list: ${generic}`,
        )
      }
    })

    it('keeps the action list free of interrogative verbs', () => {
      for (const bad of ['怎么', '如何', '是否', '要不要']) {
        assert.equal(DEVICE_ACTIONS_CN.includes(bad), false, `interrogative in action list: ${bad}`)
      }
    })

    it('has no duplicate entries in the vocabulary', () => {
      assert.equal(new Set(DEVICE_NOUNS_CN).size, DEVICE_NOUNS_CN.length)
      assert.equal(new Set(DEVICE_ACTIONS_CN).size, DEVICE_ACTIONS_CN.length)
    })
  })
})
