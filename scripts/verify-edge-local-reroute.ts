/**
 * §7.184 (2026-11-11): 边缘模式**选型不动 + 出网那一跳改道**门禁。
 *
 * 主人裁决（2026-11-11）：「选择器完全不动，实际请求改道到本地池」。
 *
 * 这条门禁守的不变量（**行为级**，纯只读、不联网、不读凭据）：
 *
 *   1. **选型不动**：apply() 里**不再**注册任何会改写会话选型的监听器
 *      （`agent/created` / `agent-preset/selected` / `session/event` 全部退役）
 *      ⇒ 宿主模型选择器保持主人选的那个，不跳；
 *   2. **改道**：LOCAL 轮次 + 非本地 provider ⇒ 出网那一跳重新派发到本地池
 *      （provider 与 model 都换）；
 *   3. 改道过去的 model 与 **wire 同源**（直连池 = 池自己的 model id）；
 *   4. 本地池拿到的是**全部**历史（本地池不出网，不裁 —— §7.131）；
 *   5. **CLOUD 轮次不改道**（本轮就是要出网的：脱敏 + 只带云段历史照旧）；
 *   6. **防自锁**：已经是本地池的 provider ⇒ 不改道；
 *   7. **标准模式零影响**：没有 step state 的会话直通、零审计行（§7.140）；
 *   8. **fail-closed**：本地路由不存在 / LLM runtime 不可用 ⇒ 抛错，
 *      绝不放行到可能上云的 provider；
 *   9. pre-step 闸门不再因「选型不是本地」拒收（改为留改道计划审计行）。
 *
 * Run via `node --import tsx/esm scripts/verify-edge-local-reroute.ts`.
 */
import {
  InputGuardServiceImpl,
  apply,
} from '../src/dsh-adapter/input-guard.ts'
import type { Config } from '../src/dsh-adapter/input-guard.ts'

const violations: string[] = []

function fail(message: string): void {
  violations.push(message)
}

/** 门禁自己的配置（不读机器上的 edge.json ⇒ 结果确定）。*/
function gateConfig(overrides: Partial<Config> = {}): Config {
  return {
    enableInputGuard: true,
    sanitizeLocalTraffic: false,
    rejectOnPolicyViolation: true,
    downgradeOnSanitizeFailure: true,
    localProvider: 'local-llm',
    localModel: 'qwen3.8-flash',
    cloudApiKeyEnv: 'DEEPSEEK_API_KEY',
    defaultCloudProvider: 'cloud-llm',
    defaultCloudModel: 'deepseek-chat',
    presetId: 'edge',
    ...overrides,
  }
}

function fakeAuditLog() {
  const entries: any[] = []
  return { entries, api: { async log(entry: any) { entries.push(entry) } } }
}

/** 记录每次 `llm.stream` 调用的假宿主 LLM runtime（离线）。 */
function fakeLlmRuntime(calls: Array<{ provider?: string; model?: string; messages?: unknown }>) {
  return {
    listProviders: () => [{ id: 'qwen-token-plan-cn', name: 'qwen-token-plan-cn' }],
    listModels: async (provider: string) => (
      provider === 'qwen-token-plan-cn' ? [{ provider, id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }] : []
    ),
    stream(options: any) {
      calls.push({ provider: options?.provider, model: options?.model, messages: options?.messages })
      return (async function* () { yield { type: 'text-delta', index: 0, text: 'ok' } })()
    },
  }
}

function fakeCtx(opts: {
  localRouteAvailable?: boolean
  llm?: unknown
  hostModel?: string
} = {}) {
  const live = ['qwen-token-plan-cn']
  return {
    reflect: { provide(_n: string, _v: unknown) { return () => {} } },
    provide(_n: string, _v: unknown) { return () => {} },
    get(name: string) {
      if (name === 'modelRouter') return { isAvailable: () => opts.localRouteAvailable ?? true }
      if (name === 'llm') return opts.llm ?? { listProviders: () => [], stream: async function* () { /* unused */ } }
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => (opts.hostModel ? { provider: live[0]!, model: opts.hostModel } : undefined) }
      }
      throw new Error(`no service ${name}`)
    },
  }
}

/** 覆写池形态 ⇒ 门禁不依赖机器上那份 edge.json。*/
class GateGuard extends InputGuardServiceImpl {
  constructor(ctx: any, config: Config, private readonly mode: 'direct' | 'delegate', auditLog?: any) {
    super(ctx, config, undefined, undefined, undefined, undefined, auditLog)
  }

  protected override localPoolShape(): any {
    return this.mode === 'direct'
      ? { baseUrl: 'http://127.0.0.1:8080/v1', model: 'qwen3.8-max' }
      : { delegate: true }
  }
}

/** 造一个边缘模式会话的 step 状态（llm/stream 靠它认出「这是边缘会话」）。*/
function armEdgeSession(svc: InputGuardServiceImpl, sessionId: string, category: 'LOCAL' | 'CLOUD'): void {
  svc.setTurnCategory(sessionId, category)
  svc.setStepState(sessionId, {
    sanitized: false, replacements: 0, sessionId, timestamp: Date.now(), routeSource: 'webui',
  })
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of stream) { /* drain */ }
}

const CLOUD_OPTIONS = {
  sessionId: 's1',
  provider: 'qwen-token-plan-cn',
  model: 'deepseek-v4.1-flash',
  messages: [{ role: 'user', content: 'hi' }],
}

// ── 1. LOCAL 轮次 + 非本地 provider ⇒ 改道 ───────────────────────────────────

{
  const audit = fakeAuditLog()
  const calls: Array<{ provider?: string; model?: string; messages?: unknown }> = []
  const ctx = fakeCtx({ llm: fakeLlmRuntime(calls) })
  const svc = new GateGuard(ctx as any, gateConfig(), 'direct', audit.api)
  armEdgeSession(svc, 's1', 'LOCAL')

  await drain(svc.handleLlmStream(CLOUD_OPTIONS as never, async function* () {
    throw new Error('改道后不该走到默认处理')
  }))

  if (calls.length !== 1) {
    fail(`LOCAL 轮次 + 非本地 provider 没有改道（calls=${calls.length}）—— 这一轮会带着原文上云`)
  } else {
    if (calls[0]!.provider !== 'local-llm') fail(`改道后的 provider='${calls[0]!.provider}' ≠ 'local-llm'`)
    if (calls[0]!.model !== 'qwen3.8-max') {
      fail(`改道后的 model='${calls[0]!.model}' ≠ 直连池自己的 model='qwen3.8-max'（与 wire 不同源 ⇒ 写了跟实际不符的名字）`)
    }
  }
  const line = audit.entries.find(e => e.kind === 'input-guard.reroute.local')
  if (!line) fail('改道没有留审计行（input-guard.reroute.local）—— 事后无法对账')
  else if ((line.payload as any).from?.provider !== 'qwen-token-plan-cn') {
    fail(`改道审计的 from.provider='${String((line.payload as any).from?.provider)}' ≠ 实际被改掉的 provider='qwen-token-plan-cn'`)
  }
}

// ── 2. 本地池拿到全部历史（不裁） ───────────────────────────────────────────

{
  const audit = fakeAuditLog()
  const calls: Array<{ provider?: string; model?: string; messages?: unknown }> = []
  const ctx = fakeCtx({ llm: fakeLlmRuntime(calls) })
  const svc = new GateGuard(ctx as any, gateConfig(), 'direct', audit.api)
  armEdgeSession(svc, 's1', 'LOCAL')

  const messages = [
    { role: 'user', content: '第一条' },
    { role: 'assistant', content: '本地回复', source: { kind: 'model', provider: 'local-llm', model: 'qwen3.8-max' } },
    { role: 'user', content: '第二条' },
  ]
  await drain(svc.handleLlmStream({ ...CLOUD_OPTIONS, messages } as never, async function* () {
    throw new Error('改道后不该走到默认处理')
  }))

  if (calls.length !== 1) fail('改道没有发生')
  else if ((calls[0]!.messages as unknown[]).length !== 3) {
    fail(`本地池只拿到 ${(calls[0]!.messages as unknown[]).length} 条历史（应为 3）—— 本地池按 §7.131 带**全部**历史`)
  }
}

// ── 3. CLOUD 轮次 ⇒ 不改道 ──────────────────────────────────────────────────

{
  const audit = fakeAuditLog()
  const calls: Array<{ provider?: string; model?: string; messages?: unknown }> = []
  const ctx = fakeCtx({ llm: fakeLlmRuntime(calls) })
  const svc = new GateGuard(ctx as any, gateConfig(), 'direct', audit.api)
  armEdgeSession(svc, 's1', 'CLOUD')

  let defaultUsed = false
  await drain(svc.handleLlmStream(CLOUD_OPTIONS as never, async function* () {
    defaultUsed = true
    yield { type: 'text-delta', index: 0, text: 'x' }
  }))

  if (!defaultUsed) fail('CLOUD 轮次没走默认处理 —— 本轮就是要出网的（脱敏 + 只带云段历史照旧）')
  if (calls.length !== 0) fail('CLOUD 轮次被改道了 —— 它本来就该出网')
  if (audit.entries.some(e => e.kind === 'input-guard.reroute.local')) fail('CLOUD 轮次不该留 reroute.local 审计行')
}

// ── 4. 已是本地池 ⇒ 不改道（防自锁） ────────────────────────────────────────

{
  const audit = fakeAuditLog()
  const calls: Array<{ provider?: string; model?: string; messages?: unknown }> = []
  const ctx = fakeCtx({ llm: fakeLlmRuntime(calls) })
  const svc = new GateGuard(ctx as any, gateConfig(), 'direct', audit.api)
  armEdgeSession(svc, 's1', 'LOCAL')

  let defaultUsed = false
  await drain(svc.handleLlmStream(
    { sessionId: 's1', provider: 'local-llm', model: 'qwen3.8-max', messages: [] } as never,
    async function* () { defaultUsed = true; yield { type: 'text-delta', index: 0, text: 'x' } },
  ))

  if (!defaultUsed) fail('本地 provider 的请求没走默认处理')
  if (calls.length !== 0) fail('本地 provider 被重新派发了 —— 会无限循环')
  if (audit.entries.some(e => e.kind === 'input-guard.reroute.local')) fail('本地 provider 不该留 reroute.local 审计行')
}

// ── 5. 标准模式 ⇒ 直通、零记录 ──────────────────────────────────────────────

{
  const audit = fakeAuditLog()
  const calls: Array<{ provider?: string; model?: string; messages?: unknown }> = []
  const ctx = fakeCtx({ llm: fakeLlmRuntime(calls) })
  const svc = new GateGuard(ctx as any, gateConfig(), 'direct', audit.api)
  // 没有 armEdgeSession ⇒ 标准模式会话。

  let defaultUsed = false
  await drain(svc.handleLlmStream(CLOUD_OPTIONS as never, async function* () {
    defaultUsed = true
    yield { type: 'text-delta', index: 0, text: 'x' }
  }))

  if (!defaultUsed) fail('标准模式会话没走默认处理')
  if (calls.length !== 0) fail('标准模式会话被改道了 —— 标准模式必须是纯宿主（§7.140）')
  if (audit.entries.length !== 0) fail('标准模式会话留了 edge 审计行 —— 标准模式不该有 edge 事件')
}

// ── 6. fail-closed：本地路由不存在 ⇒ 抛错 ───────────────────────────────────

{
  const audit = fakeAuditLog()
  const calls: Array<{ provider?: string; model?: string; messages?: unknown }> = []
  const ctx = fakeCtx({ llm: fakeLlmRuntime(calls), localRouteAvailable: false })
  const svc = new GateGuard(ctx as any, gateConfig(), 'direct', audit.api)
  armEdgeSession(svc, 's1', 'LOCAL')

  let threw = false
  try {
    await drain(svc.handleLlmStream(CLOUD_OPTIONS as never, async function* () {
      throw new Error('改不动时绝不能走到默认处理（那会把原文送上去）')
    }))
  } catch {
    threw = true
  }
  if (!threw) fail('本地路由不存在时没有抛错 —— 这一轮会被放行到云端')
  if (calls.length !== 0) fail('本地路由不存在时仍然发出了请求')
  const blocked = audit.entries.find(e => e.kind === 'input-guard.reroute.blocked')
  if (!blocked) fail('本地路由不存在时没有留 blocked 审计行 —— 事后看不出为什么没改道')
}

// ── 7. fail-closed：LLM runtime 不可用 ⇒ 抛错 ───────────────────────────────

{
  const audit = fakeAuditLog()
  const ctx = fakeCtx({ llm: {} })
  const svc = new GateGuard(ctx as any, gateConfig(), 'direct', audit.api)
  armEdgeSession(svc, 's1', 'LOCAL')

  let threw = false
  try {
    await drain(svc.handleLlmStream(CLOUD_OPTIONS as never, async function* () {
      throw new Error('重新派发不可用时绝不能走到默认处理')
    }))
  } catch {
    threw = true
  }
  if (!threw) fail('LLM runtime 不可用时没有抛错 —— 这一轮会被放行到云端')
  const blocked = audit.entries.find(e => e.kind === 'input-guard.reroute.blocked')
  if (!blocked) fail('LLM runtime 不可用时没有留 blocked 审计行')
}

// ── 8. apply() 接线：选型不再被改写 ─────────────────────────────────────────

{
  const handlers: Record<string, (...args: any[]) => unknown> = {}
  const audits: any[] = []
  const ctx = {
    reflect: { provide(_n: string, _v: unknown) { return () => {} } },
    provide(_n: string, _v: unknown) { return () => {} },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on(event: string, handler: any) {
      handlers[event] = handler
      return () => { delete handlers[event] }
    },
    promptGuard: { checkInput: async () => ({ safe: true }) },
    privacyPolicy: { matchRouting: () => null },
    intentRouter: { classify: async () => ({ category: 'LOCAL', confidence: 1 }) },
    sanitizer: { sanitize: async () => ({ sanitizedText: '', replacements: [] }) },
    auditLog: { log: async (e: any) => { audits.push(e) } },
    get(name: string) {
      if (name === 'modelRouter') return { isAvailable: () => true }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'qwen-token-plan-cn', model: 'deepseek-v4.1-flash' }) }
      throw new Error(`no service ${name}`)
    },
  }

  const dispose = await apply(ctx as any, gateConfig())

  for (const retired of ['agent/created', 'agent-preset/selected', 'session/event']) {
    if (handlers[retired] !== undefined) {
      fail(`仍然注册了 '${retired}' 监听器 —— 它会改写会话选型 ⇒ 宿主模型选择器会跳（主人裁决：选择器完全不动）`)
    }
  }
  if (typeof handlers['llm/stream'] !== 'function') {
    fail("没有注册 'llm/stream' 监听器 —— 改道没有落点")
  }

  await dispose()
}

// ── 9. pre-step 闸门：不再因「选型不是本地」拒收 ────────────────────────────

{
  const audit = fakeAuditLog()
  const ctx = fakeCtx({ llm: fakeLlmRuntime([]) })
  const svc = new GateGuard(ctx as any, gateConfig(), 'direct', audit.api)

  const messages = [{ role: 'user', content: '查本地IP' }]
  const agent = { session: { id: 's1' }, id: 'a1' }
  const payload = {
    agent,
    messages,
    step: 1,
    modelSelection: { provider: 'qwen-token-plan-cn', model: 'deepseek-v4.1-flash' },
  }
  const result = await svc.handlePreStep(payload as never, async () => ({ kind: 'enter', messages }) as never)

  if (result.kind === 'reject') {
    fail(`pre-step 仍然因「选型不是本地」拒收这一轮（reason=${String(result.reason)}）—— 旧口径已退役（能改道就不必拒）`)
  }
  const planned = audit.entries.find(e => e.kind === 'input-guard.reroute.planned')
  if (!planned) fail('pre-step 没有留改道计划审计行（input-guard.reroute.planned）')
  else if ((planned.payload as any).from?.provider !== 'qwen-token-plan-cn') {
    fail('改道计划审计的 from.provider 不是宿主选的那个')
  }
}

if (violations.length > 0) {
  console.error('Edge local reroute gate FAILED:')
  for (const v of violations) console.error(`  - ${v}`)
  process.exit(1)
}

console.log('edge-local-reroute OK (选型不动 + LOCAL 轮次改道到本地池 + 同源 model id + 全部历史 + CLOUD 不改道 + 防自锁 + 标准模式零影响 + fail-closed)')
