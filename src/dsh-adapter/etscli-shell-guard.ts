/**
 * etscli-shell-guard — §7.120：封堵「bash 里直接调 etscli 写子命令」这条逃逸口
 *
 * ## 为什么需要这个模块
 *
 * §7.98 的安全边界是**注册表白名单**：只把 14 个**只读** etscli 子命令注册进
 * `ctx.tools`，写类（`file upload` / `file delete` / `fs rm` / `chat send` /
 * `auth logout` / `migrate *` / `sharing create` / `meeting summary` /
 * `file download` …）一个都不注册 ⇒ 模型在**工具清单**里选不到它们。
 *
 * 但 §7.118 那次实测把这条边界捅穿了：agent 直接
 * `bash: etscli file upload ...`，把本地文件传到了 MEOS 设备的
 * `/备忘/联系方式.txt`。原因（§7.120 查清）：
 *
 * 1. 宿主的 **Auto review 闸门只在 `auto` preset 下安装**，本仓 edge preset 用
 *    `workspace-write` ⇒ 没有风险分类器；
 * 2. 剩下的**沙箱越界升级是纯文件系统视角** —— `etscli file upload` 改的是
 *    **远端 MEOS 设备**（走 etscli 自己的协议），对文件系统沙箱完全不可见 ⇒
 *    不越界 ⇒ 不升级 ⇒ **不触发审批**；
 * 3. 于是 `bash` 这个通用逃逸口成了唯一的真身在侧：白名单管的是「工具清单」，
 *    管不住「模型自己在 shell 里敲什么」。
 *
 * ## 主人裁决（2026-10-31）与机制落点
 *
 * > 用**插件侧守卫**封堵 —— 拦 bash 里 etscli 的写子命令。
 *
 * 裁决的实质是「**插件侧**封堵，不碰宿主启动环境（不改 PATH / 不改启动脚本），
 * 桌面与无头两个 profile 都生效」。机制落点从 `ctx.tools.guard()` 换成
 * `tools/pre-execute` waterfall，理由是三条**可查证**的事实：
 *
 * 1. **`ctx.tools.guard()` 不接受调用方的 scope。**
 *    宿主实现是 `guard(guard) { return this.layers.effect(this.ctx, …) }`
 *    （`@deepseek-ai/dsh-tools` `lib/index.js:3017-3022`）—— 注册进的是
 *    **ToolRuntime 服务自己那个 ctx** 所在的层。插件侧拿到 `ctx.tools` 时，
 *    拿不到、也改不了那个 ctx ⇒ **无法把守卫绑到边缘 preset 的 scope 上**；
 *    服务在宿主根上下文提供时，那一层就是**全局层** ⇒ 标准模式会话也会被拦，
 *    而标准模式会话的审计链必须**零本项目事件**（§7.140 不变式）。
 * 2. **宿主的插件沙箱 façade 刻意不暴露 `guard`。**
 *    `dsh-cordis-host-runner/lib/types/guard.js:581-588` 给插件的 `ctx.tools`
 *    只留 `register` / `schemas` / `get`（注释里点名 `guard` 属于
 *    「identity protection, pre-policy, **monotonic guards**, …」这一串
 *    不许旁路的机制）。桌面 profile 现在给的是真服务（`ctx.tools.view()`
 *    能用 ⇒ boot scan 数出 28 个工具），但这属于**沙箱边界之外的当前状态**，
 *    不是稳定契约。
 * 3. **`tools/pre-execute` 既是宿主点名的扩展点，又是 scope 感知的。**
 *    宿主注释原话（`lib/index.js:3008`）：「Register a monotonic guard **after
 *    the extensible `tools/pre-execute` waterfall**」。派发时
 *    `carrier = scopeTarget(this, exec.agent)`（`lib/index.js:3320-3321`）——
 *    监听器按 scope 链派发，**边缘 preset 的监听器只收到边缘会话的事件**，
 *    标准模式会话的 scope 链上没有本插件的 scope ⇒ 收不到。
 *
 * 而 §7.136 已经把这条路在本仓跑通了：`realm-skill-bridge` 的 Layer 3 realm
 * 闸门就是同一个 waterfall（`realm-skill-bridge.ts:1182`），审计链里有 6 条
 * `tool.realm.denied`（`level: security`）作实证。
 *
 * 拒绝语义与 `guard()` 等价且同样**单调**：waterfall 判 `deny` 时
 * `decision.reason` 直接成为拒绝理由（`lib/index.js:3337-3343`），工具**不派发**，
 * 后续监听器与守卫都放不回来。
 *
 * ## 这条守卫堵的是「逃逸口」，不是「能力」
 *
 * 技能（`ets-file` / `ets-chat` / `ets-auth` …）走的是**宿主 skill 工具**
 * （`exec.name === 'skill'`，参数 `skillName`），**不经过 bash**，因此**不受影响**
 * —— 主人装的那些技能照常可用。本守卫只拦「模型自己在 shell 里敲 etscli」这条路。
 *
 * 诚实记录它的边界：**命令文本匹配可以被绝对路径调用、复制二进制、别名或拼接
 * 绕过** ⇒ 它不是能力层的等价物。真正封死「模型按名字够到那个二进制」仍要靠
 * 摘 PATH（主人本轮裁决不做）。两条是**纵深防御**关系。
 *
 * ## 依赖方向
 *
 * 本模块 import `etscli-tools.ts` 的 `ETSCLI_READONLY_ARGV`（白名单的**单一
 * 事实源** = 从只读工具注册表派生的那份）—— **单向**依赖：`etscli-tools.ts`
 * 不 import 本模块（否则成环：环在这里恰好不炸，那是求值顺序的运气）。
 *
 * ## 为什么是**独立插件行**，而不是写在 etscli-tools 里
 *
 * §7.118 那次 MEOS 写入事故发生在**headless HTTP profile**里，而那个 profile
 * （以及 desktop-safe preset）**本来就没挂** `etscli-tools` ⇒ 守卫写在它里面
 * 就等于**哪个部署都没上膛**（「代码写了、测试过了、闸门没装」是本仓最怕的
 * 那种状态）。独立成行后可以**按需挂载**：
 *
 * - `profiles/dsh-edge-agent/cordis.patch.yml`（headless HTTP profile ——
 *   事故发生的那个）；
 * - `presets/edge.desktop-safe.patch.yml`（桌面 preset）；
 * - `presets/edge.patch.yml`（完整 edge preset）。
 *
 * 独立行只**加一道闸**，**不**把那 14 个只读 etscli 工具带进那些 profile ——
 * 带进去是能力扩张，超出「封堵逃逸口」这件事本身。
 *
 * @module dsh-edge-agent/etscli-shell-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import { loadEdgeConfig } from './edge-config.js'
import { defaultEtscliBin, ETSCLI_READONLY_ARGV } from './etscli-tools.js'

/** 插件名（cordis patch 行的 id 与本名一致）。 */
export const name = 'etscli-shell-guard'

/**
 * 没有服务依赖（§7.169）：只用 `ctx.on`（cordis 的框架动词）。
 *
 * **刻意不声明 `auditLog`**：声明成硬依赖后，本行要等 auditLog 服务就绪
 * 才 apply —— 那条服务一旦缺席，**闸门整个不装上**（逃逸口静默敞开）。
 * 闸门必须先于任何证据通道就位。审计服务改为**延迟注入**捕获
 * （见 apply() 内注释）：审计是证据通道，不是闸门的依赖。
 */
export const inject = [] as const

/** 能执行任意命令的工具名（小写比较）。 */
export const SHELL_TOOL_NAMES: readonly string[] = ['bash', 'pwsh']

/**
 * 只读子命令白名单：每项是一段 argv 前缀（`['fs','ls']` 匹配
 * `fs ls --path /tmp`）。
 *
 * **由调用方传入**（单一事实源 = `etscli-tools.ts` 从注册表派生的那份），
 * 本模块**不 import** 它 —— 否则 `etscli-tools → etscli-shell-guard →
 * etscli-tools` 会成环：模块求值顺序一变就是 TDZ 崩，而崩点还是「运行期
> 才炸」的那种。
 */
export type EtscliReadonlyAllowlist = readonly (readonly string[])[]

/** 守卫的选项（白名单必填 —— 少传就是「白名单为空 ⇒ 全拒」的 fail-closed）。 */
export interface EtscliGuardOptions {
  /** 只读子命令白名单（argv 前缀）。 */
  allowlist: EtscliReadonlyAllowlist
  /** etscli 二进制路径（用于识别绝对路径调用）。 */
  bin?: string
  /** 拒绝时的回调（证据要落盘）。 */
  onDeny?: (denial: EtscliGuardDenial) => void
}

/** 命令里出现的 shell 分隔符 / 重定向符 —— 遇到它就算「上一条命令结束」。 */
const SEPARATORS = new Set([';', '|', '&', '>', '<', '`', '(', ')'])

/** 守卫的判定结果。 */
export interface EtscliShellVerdict {
  /** 是否拒绝这次执行。 */
  denied: boolean
  /** 被拦下的子命令（`file upload` 这种），用于审计与给模型的提示。 */
  subcommand?: string
  /** 拒绝理由（返回给宿主，会变成工具结果里的 `Error: <reason>`）。 */
  reason?: string
}

/** 允许：没命中任何 etscli 调用。 */
const ALLOW: EtscliShellVerdict = { denied: false }

/**
 * 极简 shell 分词。
 *
 * 够用就好：这里的目的是**找出命令文本里有没有 etscli 调用**，不是做一个
 * 完整的 shell 解析器。处理引号、转义、以及 `;` `|` `&` `>` `<` 这些分隔符，
 * 好让 `etscli` 后面只取到属于它自己的那几个 token。
 */
export function tokenizeShell(command: string): string[] {
  const tokens: string[] = []
  let cur = ''
  let has = false
  let quote: '"' | "'" | null = null

  const flush = (): void => {
    if (has) {
      tokens.push(cur)
      cur = ''
      has = false
    }
  }

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote !== null) {
      if (ch === '\\' && quote === '"' && i + 1 < command.length) {
        cur += command[++i]!
        has = true
        continue
      }
      if (ch === quote) {
        quote = null
        has = true
        continue
      }
      cur += ch
      has = true
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      has = true
      continue
    }
    if (ch === '\\' && i + 1 < command.length) {
      cur += command[++i]!
      has = true
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      flush()
      continue
    }
    if (SEPARATORS.has(ch)) {
      flush()
      tokens.push(ch)
      continue
    }
    cur += ch
    has = true
  }
  flush()
  return tokens
}

/** 取路径的末段（`/usr/local/bin/etscli` → `etscli`）。 */
function baseName(token: string): string {
  const cut = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'))
  return cut < 0 ? token : token.slice(cut + 1)
}

/**
 * 这串 argv 是不是白名单里的只读子命令？
 *
 * 判据用**前缀匹配**：白名单项 `['fs','ls']` 匹配 `fs ls --path /tmp`。
 * 精确到 token，不会把 `fs lsx` 误判成 `fs ls`。
 */
export function isReadOnlyEtscliArgv(
  argv: readonly string[],
  allowlist: EtscliReadonlyAllowlist,
): boolean {
  return allowlist.some(prefix =>
    prefix.every((token, index) => argv[index] === token),
  )
}

/**
 * 判定一条 shell 命令里有没有「不该出现的 etscli 调用」。
 *
 * 规则：**只放行白名单里那 14 个只读子命令**，其余一律拒绝。
 *
 * 为什么用白名单而不是黑名单（把 `file upload` / `fs rm` 这些逐个列出来禁）：
 * 黑名单只能挡住**已经想到的**写子命令 —— etscli 加一个新写命令，黑名单就漏一个。
 * 白名单的漏法是**多挡**（新加的只读命令也会被挡），而白名单那份清单就在
 * `etscli-tools.ts` 里（注册什么就放行什么），两者天然同步。
 *
 * @param command - shell 命令文本
 * @param options.allowlist - 只读子命令白名单（argv 前缀）
 * @param options.bin - 配置里的 etscli 二进制路径（用于识别绝对路径调用）
 */
export function evaluateEtscliShellCommand(
  command: string,
  options: { allowlist: EtscliReadonlyAllowlist; bin?: string },
): EtscliShellVerdict {
  if (typeof command !== 'string' || command.length === 0) return ALLOW
  const binBase = options.bin ? baseName(options.bin) : 'etscli'
  const tokens = tokenizeShell(command)

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (baseName(token) !== binBase) continue

    // etscli 后面属于它的 argv：遇到分隔符就停。
    const argv: string[] = []
    for (let j = i + 1; j < tokens.length; j++) {
      const next = tokens[j]!
      if (SEPARATORS.has(next)) break
      argv.push(next)
    }
    // 子命令部分 = 前导的非 flag token（最多 3 段，白名单最长的是
    // `system alarm list`）。**刻意不把参数值算进去** —— 那些是本地路径 /
    // 文件名，不该出现在拒绝理由和审计行里。
    const sub: string[] = []
    for (const arg of argv) {
      if (arg.startsWith('-')) {
        // flag 之前的都是全局 flag，跳过；flag 之后的都是参数，停。
        if (sub.length > 0) break
        continue
      }
      sub.push(arg)
      if (sub.length >= 3) break
    }
    if (isReadOnlyEtscliArgv(sub, options.allowlist)) continue

    // 给模型看的标签只取**前两段命令词**（`file upload` / `fs rm` / `chat send`…），
    // 位置参数（本地路径 / 文件名）一律不进标签 —— 拒绝理由会回到模型的上下文里，
    // 审计行也会落盘，不该带着本地路径。
    const label = sub
      .filter(token => !token.includes('/') && !token.includes('\\'))
      .slice(0, 2)
      .join(' ')

    const shown = label.length > 0 ? label : '(未指定子命令)'
    const reason =
      `etscli-shell-guard: \`etscli ${shown}\` 不是只读子命令，已拒绝执行。` +
      `shell 里只允许这 ${options.allowlist.length} 个只读子命令：` +
      `${options.allowlist.map(p => p.join(' ')).join('、')}；` +
      `需要别的 etscli 能力请走对应的 skill 或已注册的 etscli_* 工具。`
    return { denied: true, subcommand: shown, reason }
  }

  return ALLOW
}

/**
 * 宿主执行信封（`dsh-tools` 的 exec 形状）的结构化描述。
 *
 * 参数字段名在宿主版本间会变（`arguments` / `args` / `input`），所以三个都读。
 */
export interface ToolExecLike {
  name?: unknown
  arguments?: unknown
  args?: unknown
  input?: unknown
}

/** 收集参数对象里所有字符串值（深度受限）。 */
function collectStrings(value: unknown, out: string[], depth: number): void {
  if (depth > 6 || out.length >= 32) return
  if (typeof value === 'string') {
    if (value.length > 0) out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectStrings(item, out, depth + 1)
    }
  }
}

/**
 * 判定一次工具执行里有没有「不该出现的 etscli 调用」。
 *
 * 只看 **shell 类工具**（`bash` / `pwsh`）—— 技能走的是 `skill` 工具（参数
 * `skillName`），不受影响；`etscli_*` 白名单工具走绝对路径直接调二进制，
 * 也不经过 shell 工具。
 *
 * 参数值**不按参数名取**：把 exec 的参数对象里所有字符串值都过一遍。这样
 * 不用依赖宿主 bash 工具的参数名（`command` / `cmd` / …），也不会因为参数名
 * 变了就漏检。
 */
export function evaluateEtscliToolCall(
  exec: unknown,
  options: { allowlist: EtscliReadonlyAllowlist; bin?: string },
): EtscliShellVerdict {
  const typed = (exec ?? {}) as ToolExecLike
  const name = typeof typed.name === 'string' ? typed.name.toLowerCase() : ''
  if (!SHELL_TOOL_NAMES.includes(name)) return ALLOW
  const args = typed.arguments ?? typed.args ?? typed.input
  if (args === null || typeof args !== 'object') return ALLOW

  const texts: string[] = []
  collectStrings(args, texts, 0)
  for (const text of texts) {
    const verdict = evaluateEtscliShellCommand(text, {
      allowlist: options.allowlist,
      bin: options.bin,
    })
    if (verdict.denied) return verdict
  }
  return ALLOW
}

/** 守卫被拒绝时的回调载荷。 */
export interface EtscliGuardDenial {
  /** 触发拒绝的工具名。 */
  tool: string
  /** 被拦下的子命令。 */
  subcommand: string
  /** 拒绝理由。 */
  reason: string
}

/** 宿主 `tools/pre-execute` waterfall 的判定形状（结构化类型 —— 见模块头的 import 纪律）。 */
interface PreToolDecision {
  kind: 'allow' | 'deny' | 'ask' | 'cancel'
  reason?: string
}

/** 我们用到的 `ctx.on` 形状（结构化类型）。 */
type OnLike = (
  event: string,
  fn: (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>,
) => (() => void) | undefined

/**
 * 把守卫注册到宿主的 `tools/pre-execute` waterfall。
 *
 * 契约（`@deepseek-ai/dsh-tools` `lib/index.js:3319-3343`）：
 *
 * - 监听器返回 `{kind:'deny', reason}` ⇒ 这次执行**不派发**，`reason` 成为
 *   拒绝理由（工具结果里的 `Error: <reason>`），后续监听器/守卫放不回来；
 * - 放行时必须 `return next()` —— 直接 `allow` 会把后面的链条截断。
 *
 * 本监听器从**本插件自己的 ctx** 注册，而本插件挂在边缘 preset 的 scope 里
 * ⇒ 宿主按 scope 链派发（`scopeTarget(this, exec.agent)`）⇒ 标准模式会话
 * 收不到本事件 ⇒ 守卫不会伸到标准模式（§7.140 的零事件不变式不受影响）。
 *
 * @returns 宿主返回的**精确 disposer**（用于有序拆卸 / HMR 清理）
 */
export function registerEtscliShellGuard(
  ctx: Context,
  options: EtscliGuardOptions,
): () => void {
  const on = (ctx as unknown as { on?: OnLike }).on
  if (typeof on !== 'function') {
    // 缺了闸门就等于逃逸口敞开 —— 按本仓「宁可在启动时就说清楚缺了谁」的纪律，
    // 直接拒绝启动，而不是让每一道闸在运行期静默失效。
    throw new Error(
      '[etscli-shell-guard] ctx.on is not available: the etscli write-subcommand ' +
      'escape hatch would be open silently (tools/pre-execute could not be observed). Refusing to start.',
    )
  }
  const disposer = on.call(ctx, 'tools/pre-execute', async (exec: unknown, next: () => Promise<unknown>) => {
    const verdict = evaluateEtscliToolCall(exec, {
      allowlist: options.allowlist,
      bin: options.bin,
    })
    if (!verdict.denied) return next()
    const typed = (exec ?? {}) as ToolExecLike
    const tool = typeof typed.name === 'string' ? typed.name.toLowerCase() : 'unknown'
    const reason = verdict.reason ?? 'etscli-shell-guard: 拒绝执行'
    options.onDeny?.({
      tool,
      subcommand: verdict.subcommand ?? '(未指定子命令)',
      reason,
    })
    return { kind: 'deny', reason } satisfies PreToolDecision
  })
  return typeof disposer === 'function' ? disposer : () => {}
}

// ── 插件入口 ────────────────────────────────────────────────────────────────

export interface Config {
  /**
   * etscli 二进制绝对路径 —— 只用来**识别**绝对路径调用
   * （`/Users/me/.local/bin/etscli file upload …`）。
   *
   * 缺省顺序：本项 → `config/edge.json` 的 `etscli.bin` → `~/.local/bin/etscli`
   * （§7.102「one config file」：运行期配置只有一个读点）。
   */
  etscliBin?: string
}

export const Config: Schema<Config> = Schema.object({
  etscliBin: Schema.string(),
})

/**
 * 装上这道闸。
 *
 * 装的顺序与两件记录：
 *
 * 1. **启动行**（`armed`）：只记拒绝行的话，"守卫没装上" 和 "守卫装上了但这次
 *    没人触发" 在日志里长得一模一样 ⇒ 启动时把**白名单规模**与**机制落点**
 *    写出来。不记放行行（每次 bash 调用都记会淹掉真正的拒绝行；realm 闸门那层
 *    已经在逐次记 tool allow/deny）。
 * 2. **拒绝行**：ops log `warn` + 审计行 `etscli.shell.denied`
 *    （`level: security`；载荷**不含命令原文** —— 里面可能有本地路径与文件名）。
 */
export async function apply(ctx: Context, config: Config): Promise<() => void> {
  const configured = loadEdgeConfig().etscli
  const bin = (config.etscliBin && config.etscliBin.length > 0)
    ? config.etscliBin
    : (configured?.bin && configured.bin.length > 0 ? configured.bin : defaultEtscliBin())

  // 审计服务用**延迟注入**捕获（§7.169）。
  //
  // 为什么不用 `ctx.get('auditLog')`：宿主 cordis 的 `get(name)` 走
  // `ctx[isolate][name]` —— 只有**声明在 inject 里**的名字才进 isolate 表。
  // 本插件刻意不声明 auditLog（见上方 inject 的说明），所以
  // `ctx.get('auditLog')` 恒为 undefined ⇒ 拒绝路径的审计行**从未落过地**
  // （实测 2026-10-31：探针打印 `ctx.get(auditLog) type=undefined`）。
  //
  // 延迟注入（`ctx.inject(['auditLog'], cb)`）另起一根 fiber，它自己的
  // isolate 表里有 auditLog ⇒ 回调里拿得到服务。拒绝真发生时，审计行
  // 才需要它，那时服务早已就位。
  let auditLog: { log?: (entry: unknown) => Promise<unknown> } | undefined
  ctx.inject(['auditLog'], (raw: any) => {
    auditLog = raw?.auditLog as typeof auditLog
  })

  const disposer = registerEtscliShellGuard(ctx, {
    // 白名单的单一事实源：从只读工具注册表派生的那份（本模块 import 过来，
    // 单向依赖）。守卫不自己造第二份清单。
    allowlist: ETSCLI_READONLY_ARGV,
    bin,
    onDeny: denial => {
      ctx.logger?.warn?.(
        `[etscli-shell-guard] denied tool=${denial.tool} subcommand=${denial.subcommand}`,
      )
      void auditLog?.log?.({
        level: 'security',
        kind: 'etscli.shell.denied',
        source: 'etscli-shell-guard',
        payload: {
          tool: denial.tool,
          subcommand: denial.subcommand,
          // 刻意**不记命令原文**：里面可能有本地路径与文件名。
          reason: denial.reason.slice(0, 300),
        },
      })?.catch?.(() => {})
    },
  })

  // 「已上膛」的凭据必须落在**已经就位**的通道上（§7.169）。
  //
  // 为什么不能直接在 apply() 末尾 `ctx.logger.info(...)`：ops log 的落盘
  // 导出器由 `file-logger` 插件注册，而**插件的 apply 先后由模块解析速度
  // 决定**（实测：守卫比 file-logger 先 apply）⇒ apply 那一刻 logger 还没
  // 有导出器 ⇒ 那一行**静默丢失**（实测 t0 丢、t300 起才落盘）。
  //
  // 办法：延迟注入 `fileLogger`。宿主 cordis 只在 providing fiber **变为
  // ACTIVE 之后**才 notify 依赖方（`_updateState`），而导出器正是在那之前
  // 注册好的 ⇒ 回调触发时通道必定可用 ⇒ 这一行必定落盘，且**与加载顺序
  // 无关**。服务已经就位时回调立即触发（桌面 preset 就是这种），还没就位
  // 就等它（headless profile 是这种）。
  //
  // 刻意**不在 apply 时先打一次**：那一刻通道可能还没有导出器，那一行会
  // 悄悄丢掉，还会让后面那次被"只记一次"的标志吞掉 ⇒ 反而永远看不到。
  ctx.inject(['fileLogger'], () => {
    ctx.logger?.info?.(
      `[etscli-shell-guard] armed on tools/pre-execute, read-only allowlist=${ETSCLI_READONLY_ARGV.length} ` +
      `bin=${bin} shellTools=${SHELL_TOOL_NAMES.join('/')}`,
    )
  })

  return disposer
}
