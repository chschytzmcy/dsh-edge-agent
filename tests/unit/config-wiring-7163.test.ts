// §7.163 — 配置接线回归：jev.localAdoptFloor 与 checkOutput 的输出侧兜底。
//
// 这两项此前都是「配置面已声明、运行时没接线」：
//   1. jev.localAdoptFloor —— edge-config.ts 声明了类型、edge.example.json
//      写了值、intent-router.ts 的构造默认值也是它，但 apply() 的 fill 列表
//      里漏了它 ⇒ 配置文件里写了不生效，静默走构造默认值。
//   2. prompt-guard.checkOutput —— input-guard 迁移时（eaec70b）声明要
//      把它搬到 llm/stream 侧，但只搬了 desanitize，掩码侧留在 http-api
//      的旧位置且随后被删除 ⇒ checkOutput 成了死代码，未脱敏会话的输出
//      没有任何 PII 掩码。
//
// 测试策略：
//   1. 直接断言 apply() 之后的 config —— apply() 就地改写 config 对象，
//      这正是接线的唯一证据点，不需要窥探私有字段。
//   2. checkOutput 侧断言行为：未脱敏的输出被掩码、已脱敏会话不被二次掩码。

import { describe, it } from 'vitest'
import assert from 'node:assert/strict'
import { apply } from '../../src/dsh-adapter/intent-router.ts'
import { InputGuardServiceImpl } from '../../src/dsh-adapter/input-guard.ts'

/** 最小 ctx：apply() 只用它取 auditLog / logger / reflect。 */
function makeCtx(extra: Record<string, unknown> = {}): any {
  return {
    reflect: { provide: () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    ...extra,
  }
}

describe('§7.163 jev.localAdoptFloor 配置接线', () => {
  it('配置文件里的 localAdoptFloor 到达运行时 config(此前被静默忽略)', async () => {
    const config: Record<string, unknown> = {
      defaultCategory: 'LOCAL',
      classificationProvider: 'local-llm',
      confidenceThreshold: 0.6,
      jevEnabled: true,
      jevUrl: 'http://127.0.0.1:8001',
      jevConfidenceThreshold: 0.85,
      jevLocalAdoptFloor: 0.42,
    }

    const dispose = await apply(makeCtx(), config as never)
    try {
      // 接线成立的判据：apply() 把配置面的值搬进了运行时 config。
      assert.equal(config.jevLocalAdoptFloor, 0.42)
    } finally {
      await dispose()
    }
  })

  it('配置面未给 localAdoptFloor 时不覆盖运行时既有值(fill 语义:undefined 不填)', async () => {
    const config: Record<string, unknown> = {
      defaultCategory: 'LOCAL',
      classificationProvider: 'local-llm',
      jevEnabled: true,
      jevLocalAdoptFloor: 0.33,
    }

    const dispose = await apply(makeCtx(), config as never)
    try {
      assert.equal(config.jevLocalAdoptFloor, 0.33)
    } finally {
      await dispose()
    }
  })
})

describe('§7.163 input-guard 输出侧 PII 掩码兜底', () => {
  const PII_TEXT = '你的手机号是 13812345678'

  /** 造一个只有 promptGuard + auditLog 的 input-guard 实例。 */
  function makeGuard(opts: {
    checkOutput: (text: string, ctx?: { sanitized?: boolean }) => Promise<{ filtered: string; redacted: Array<{ type: string; masked: string }> }>
    state?: Record<string, unknown>
  }) {
    // 审计条目收集器：§7.163 实机复盘发现「掩码执行了但没留审计」，
    // 根因就是没断言这条 —— 这里把它变成可断言的对象。
    const auditEntries: Array<{ kind: string; level: string; payload: Record<string, unknown> }> = []
    const ctx: any = makeCtx({
      auditLog: {
        log: async (entry: { kind: string; level: string; payload: Record<string, unknown> }) => {
          auditEntries.push(entry)
        },
      },
    })
    // sanitizer 也要给上：生产里 apply() 的 fail-fast 保证 promptGuard /
    // sanitizer / intentRouter / privacyPolicy 四件套齐备，测试要贴近这条。
    const sanitizer = {
      sanitize: async () => ({ sanitizedText: '', sessionId: '', replacements: [] }),
      desanitize: async (text: string) => text,
    }
    const service = new InputGuardServiceImpl(
      ctx,
      { enableInputGuard: true, downgradeOnSanitizeFailure: true, localProvider: 'local-llm', localModel: 'local-model' } as never,
      { checkInput: async () => ({ safe: true }), checkOutput: opts.checkOutput } as never,
      undefined,
      undefined,
      sanitizer as never,
      ctx.auditLog as never,
    )
    // 预置 stepState：模拟 pre-step 已经跑过、但本轮没有发生脱敏替换
    // （sanitized=false ⇒ replacements=0），这正是需要掩码兜底的会话。
    const stepState = (service as unknown as { stepState: Map<string, unknown> }).stepState
    stepState.set('sess-local', {
      sanitized: false,
      replacements: 0,
      sessionId: 'sess-local',
      timestamp: Date.now(),
      ...(opts.state ?? {}),
    })
    return { service, ctx, auditEntries }
  }

  /** 把 handleLlmStream 的 chunk 流收成一段文本。 */
  async function drain(service: InstanceType<typeof InputGuardServiceImpl>): Promise<string> {
    const chunks: string[] = []
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', text: PII_TEXT }
      },
    }
    for await (const chunk of service.handleLlmStream({ sessionId: 'sess-local' } as never, () => stream as never)) {
      if (chunk.type === 'text-delta') chunks.push(String((chunk as { text?: string }).text ?? ''))
    }
    return chunks.join('')
  }

  /** 把 handleLlmStream 的 chunk 流原样收下来（用于检查 block-end）。 */
  async function drainChunks(
    service: InstanceType<typeof InputGuardServiceImpl>,
    source: Array<Record<string, unknown>>,
  ): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = []
    const stream = {
      async *[Symbol.asyncIterator]() {
        for (const c of source) yield c
      },
    }
    for await (const chunk of service.handleLlmStream({ sessionId: 'sess-local' } as never, () => stream as never)) {
      out.push(chunk as unknown as Record<string, unknown>)
    }
    return out
  }

  /** 统一的掩码桩：手机号 13812345678 → 138****5678。 */
  function maskingCheckOutput(counter: { n: number }) {
    return async (text: string, ctx?: { sanitized?: boolean }) => {
      counter.n++
      if (ctx?.sanitized) return { filtered: text, redacted: [] }
      const hit = text.includes('13812345678')
      return {
        filtered: text.replace(/13812345678/g, '138****5678'),
        redacted: hit ? [{ type: 'phone', masked: '138****5678' }] : [],
      }
    }
  }

  it('未脱敏会话的输出经过 PII 掩码(此前直通,无任何兜底)', async () => {
    let called = 0
    const { service } = makeGuard({
      checkOutput: async (text, ctx) => {
        called++
        // 语义要与 prompt-guard 一致：已脱敏会话跳过,未脱敏则掩码。
        if (ctx?.sanitized) return { filtered: text, redacted: [] }
        return { filtered: text.replace(/13812345678/g, '138****5678'), redacted: [{ type: 'phone', masked: '138****5678' }] }
      },
    })

    const output = await drain(service)

    assert.ok(called > 0, 'checkOutput 必须被调用(此前是死代码)')
    assert.ok(!output.includes('13812345678'), `输出不应含明文手机号,实得: ${output}`)
    assert.ok(output.includes('138****5678'), `输出应是掩码后的手机号,实得: ${output}`)
  })

  it('已脱敏会话的输出不被二次掩码(否则会遮掉刚还原的原文)', async () => {
    let called = 0
    const { service } = makeGuard({
      checkOutput: async (text, ctx) => {
        called++
        if (ctx?.sanitized) return { filtered: text, redacted: [] }
        return { filtered: 'MASKED', redacted: [] }
      },
      state: { sanitized: true, replacements: 2 },
    })

    const output = await drain(service)

    // 脱敏会话走 desanitize 路径：checkOutput 根本不该被调用（掩码是
    // 「没脱敏过」才做的兜底），更不能把 desanitize 还原出来的原文遮掉。
    assert.equal(called, 0, '脱敏会话不应再走输出掩码')
    assert.ok(output.includes('13812345678'), `已脱敏会话的原文应保留,实得: ${output}`)
    assert.ok(!output.includes('MASKED'), '已脱敏会话不应被二次掩码')
  })

  it('跨 chunk 拆开的 PII 仍被掩码(逐块掩码会漏)', async () => {
    const counter = { n: 0 }
    const { service } = makeGuard({ checkOutput: maskingCheckOutput(counter) })

    // 手机号被流式切成两块：两块单独看都匹配不上 11 位数字的正则。
    const chunks = await drainChunks(service, [
      { type: 'text-delta', index: 0, text: '你的手机号是 13812' },
      { type: 'text-delta', index: 0, text: '345678' },
    ])
    const output = chunks
      .filter((c) => c.type === 'text-delta')
      .map((c) => String(c.text ?? ''))
      .join('')

    assert.ok(!output.includes('13812345678'), `跨 chunk 的手机号不该漏出去,实得: ${output}`)
    assert.ok(output.includes('138****5678'), `跨 chunk 的手机号应被掩码,实得: ${output}`)
    assert.ok(output.includes('你的手机号是'), '非 PII 文本必须原样保留')
  })

  it('block-end 场景：delta 流文本完整不丢尾部，block.text 同样被掩码', async () => {
    const counter = { n: 0 }
    const { service } = makeGuard({ checkOutput: maskingCheckOutput(counter) })

    const chunks = await drainChunks(service, [
      { type: 'text-delta', index: 0, text: '你的手机号是 13812' },
      { type: 'text-delta', index: 0, text: '345678' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '你的手机号是 13812345678' } },
    ])

    const deltaText = chunks
      .filter((c) => c.type === 'text-delta')
      .map((c) => String(c.text ?? ''))
      .join('')
    const blockEnd = chunks.find((c) => c.type === 'block-end')
    const blockText = String((blockEnd?.block as { text?: string } | undefined)?.text ?? '')

    // delta 流必须自足（只看 delta 的消费方才不丢文本）。
    assert.equal(deltaText, '你的手机号是 138****5678', `delta 流应完整且已掩码,实得: ${deltaText}`)
    // block.text 是宿主的定稿来源，也必须已掩码。
    assert.equal(blockText, '你的手机号是 138****5678', `block.text 应已掩码,实得: ${blockText}`)
  })

  it('掩码必须留下审计事件(实机复盘:短回复走 block-end 路径,原来没留记录)', async () => {
    const counter = { n: 0 }
    const { service, auditEntries } = makeGuard({ checkOutput: maskingCheckOutput(counter) })

    // 短回复：总长 < 尾部待定区 ⇒ 走不到 delta head 分支，掩码发生在
    // block-end 与流尾补发这两条路径上。
    await drainChunks(service, [
      { type: 'text-delta', index: 0, text: '13812345678' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '13812345678' } },
    ])

    const maskedEvents = auditEntries.filter((e) => e.kind === 'input-guard.output.masked')
    assert.ok(maskedEvents.length > 0, '掩码执行了就必须留审计,否则面板上「没发生过」')
    assert.equal(maskedEvents[0].level, 'info')
    assert.equal(maskedEvents[0].payload.sessionId, 'sess-local')
    assert.equal(maskedEvents[0].payload.count, 1)
    assert.deepEqual(maskedEvents[0].payload.types, ['phone'])
  })
})
