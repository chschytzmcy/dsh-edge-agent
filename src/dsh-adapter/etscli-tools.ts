/**
 * etscli-tools — §7.98:把 14 个 **只读** etscli 子命令注册进 dsh 工具注册表。
 *
 * ## 为什么有这个插件
 *
 * 在此之前,47 个 `etscli_*` 工具**只存在于 `scripts/etscli-tools-test.py` 的
 * `_TOOL_SPEC` 硬编码列表里**,直接 POST 给 needle 的裸 `/extract`。
 * `ctx.tools` 里一个都没有 —— 这意味着:
 *
 * - `realm-skill-bridge.getToolSchemasForExternal()` 读到的是上游那套
 *   (bash/fs/web/...),**从没见过 etscli 工具**
 * - needle 选出的任何 etscli 工具都会撞 `tool-runner` 的 schema 面校验 →
 *   `external.unknown_tool` → denied → `executedCount` 恒为 0
 * - 于是 `function-call-external` 的 `buildSynthesisContext()` **永远不触发**,
 *   §7.96 Track B 的 synthesis few-shot 在真实部署里是不可达的死代码
 *
 * 本插件补上这一层,让「needle 选工具 → tool-runner 执法 → 真实执行 → synthesis
 * → LOCAL LLM 出回复」这条链路第一次真正跑通。
 *
 * ## 安全边界(本文件最重要的约束)
 *
 * **只注册只读工具。** 47 个 etscli 工具里 27 个有真实副作用,其中几个不可逆:
 *
 * | 排除的工具 | help 原文依据 |
 * |---|---|
 * | `auth logout` | "Remove stored credentials" —— 抹掉凭据,其他工具全砖 |
 * | `fs rm` | `--delete-type int ... (default 2)`,2 = **permanent**,不是回收站 |
 * | `file delete` | 逗号分隔批量删除,**无确认** |
 * | `chat send` / `send-file` | 向真实群发**不可撤回**的消息 |
 * | `migrate verify` | "Missing records ... trigger an **automatic re-transfer**" —— **名字像只读,实为写操作** |
 * | `migrate transfer` | 写 `~/.etscli/migrated.json` + 批量传输 |
 * | `sharing create` | 生成**公开**分享链接 |
 * | `meeting summary` | "Trigger meeting AI summary" —— 触发服务端 AI,计费 |
 * | `file download` | 远端只读,但**落本地盘** |
 * | 其余写类 | 见 `docs/PROGRESS.md` §7.98 排除表 |
 *
 * 「不注册」= 不进 `ctx.tools` = 不出现在 `getToolSchemasForExternal()` =
 * **needle 物理上无法选中**。白名单就是注册表本身,不依赖运行期拦截。
 *
 * ## 上游包的 import 纪律
 *
 * **不 import `@deepseek-ai/dsh-tools`。** 该包只存在于 dsh CLI 自带的
 * `node_modules`(`/home/etsme/.npm-global/lib/node_modules/@deepseek-ai/dsh/...`),
 * **不在 dsh-edge profile 的 `node_modules` 里** —— 从本插件 `lib/` 出发做
 * runtime import 会解析失败。本文件因此改用结构化类型 + 窄 cast 访问
 * `ctx.tools` / `ctx.shell`,与 `tools.ts:275-291`、`tool-runner.ts` 文件头
 * 声明的同款纪律一致(全仓零 `import ... from '@deepseek-ai/dsh-tools'` 的值导入)。
 *
 * @module dsh-edge-agent/etscli-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

// ─────────────────────────────────────────────────────────────────────────────
// Structural types (loose coupling — see module header)
// ─────────────────────────────────────────────────────────────────────────────

/** `ctx.tools` 里我们唯一用到的那一个方法。 */
interface ToolRegistrarLike {
  register(definition: unknown): () => void
}

/** `ctx.shell` 的最小子集。`resolve()` 填默认值/钳位,`run()` 执行。 */
interface ShellLike {
  resolve(request: { command: string; timeoutMs?: number; signal?: AbortSignal }): unknown
  run(spec: unknown): Promise<ShellRunResultLike>
}

interface CollectedOutputLike {
  text: string
  truncated?: boolean
  spillPath?: string
}

interface ShellRunResultLike {
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  aborted: boolean
  timeoutMs: number
  stdout: CollectedOutputLike
  stderr: CollectedOutputLike
}

/** `execute(args, exec)` 的第二个参数,我们只用 `signal`。 */
interface ToolRunExecLike {
  signal: AbortSignal
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool table
// ─────────────────────────────────────────────────────────────────────────────

interface EtscliParamSpec {
  /** 暴露给模型的名字(与 `etscli-tools-test.py` 的 `_TOOL_SPEC` 保持一致)。 */
  readonly model: string
  /** 真实 CLI flag。⚠️ 与模型侧参数名**不是**一一对应,见下表注释。 */
  readonly flag: string
  readonly type: 'string' | 'integer'
  readonly description: string
  readonly required?: true
}

interface EtscliToolSpec {
  readonly name: string
  readonly description: string
  /**
   * 固定子命令 argv 前缀。**永不来自模型或用户输入** —— 这是命令注入的
   * 第一道也是最重要的一道边界:模型只能选「用哪个只读子命令」,不能改写它。
   */
  readonly argv: readonly string[]
  readonly params: readonly EtscliParamSpec[]
  /** argv 之后的分隔符(etscli 的全局 flag 位置敏感时用)。 */
  readonly trailing?: boolean
}

/**
 * 14 个只读工具。
 *
 * ⚠️ **flag 映射刻意不等于模型侧参数名** —— 真实 CLI 的 flag 与
 * `etscli-tools-test.py` 的抽象参数名有出入,照抄参数名会静默返回空结果。
 * 实测依据(2026-09-30,`etscli <svc> --help`):
 *
 * | 工具 | 模型侧参数 | 真实 flag | 备注 |
 * |---|---|---|---|
 * | `fs ls` | `path` | `--parent` | 不是 `--path` |
 * | `fs stats` | `path` | `--parent` | 同上 |
 * | `fs stat` | `path` | `--file-id` | help: "File ID (file_uri or path)" |
 * | `fs search` | `name` | `--name` | **CLI 侧必填** |
 * | `file search` | `keyword` | `--keyword` | |
 * | `system alarm list` | `limit` | `--number` | 不是 `--limit` |
 */
const ETSCLI_TOOL_SPECS: readonly EtscliToolSpec[] = [
  {
    name: 'etscli_auth_list',
    description: 'list all saved login profiles',
    argv: ['auth', 'list'],
    params: [],
  },
  {
    name: 'etscli_auth_status',
    description: 'show the authentication status of the current profile',
    argv: ['auth', 'status'],
    params: [],
  },
  {
    name: 'etscli_user_list',
    description: 'list all users on the box',
    argv: ['user', 'list'],
    params: [],
  },
  {
    name: 'etscli_system_info',
    description: 'show system information of the box',
    argv: ['system', 'info'],
    params: [],
  },
  {
    name: 'etscli_system_health',
    description: 'check the health of the box',
    argv: ['system', 'health'],
    params: [],
  },
  {
    name: 'etscli_system_alarm_list',
    description: 'list alarms on the box',
    argv: ['system', 'alarm', 'list'],
    params: [
      { model: 'limit', flag: '--number', type: 'integer', description: 'number of alarms to fetch (0 = all)' },
    ],
  },
  {
    name: 'etscli_file_search',
    description: 'search box files by keyword',
    argv: ['file', 'search'],
    params: [
      { model: 'keyword', flag: '--keyword', type: 'string', description: 'keyword search', required: true },
    ],
  },
  {
    name: 'etscli_fs_ls',
    description: 'list files in a directory',
    argv: ['fs', 'ls'],
    params: [
      { model: 'path', flag: '--parent', type: 'string', description: 'parent folder path (e.g. "/")' },
    ],
  },
  {
    name: 'etscli_fs_stat',
    description: 'show stat info of a file',
    argv: ['fs', 'stat'],
    params: [
      { model: 'path', flag: '--file-id', type: 'string', description: 'file URI or path', required: true },
    ],
  },
  {
    name: 'etscli_fs_stats',
    description: 'show statistics of a directory',
    argv: ['fs', 'stats'],
    params: [
      { model: 'path', flag: '--parent', type: 'string', description: 'parent folder path', required: true },
    ],
  },
  {
    name: 'etscli_fs_search',
    description: 'search files by name under a directory',
    argv: ['fs', 'search'],
    params: [
      { model: 'name', flag: '--name', type: 'string', description: 'file name substring to search for', required: true },
    ],
  },
  {
    name: 'etscli_meeting_list',
    description: 'list all meetings',
    argv: ['meeting', 'list'],
    params: [],
  },
  {
    name: 'etscli_chat_list',
    description: 'list group chats',
    argv: ['chat', 'list'],
    params: [],
  },
  {
    name: 'etscli_sharing_list',
    description: 'list all sharing links',
    argv: ['sharing', 'list'],
    params: [],
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// Shell quoting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POSIX single-quote escaping。值只可能来自模型的 tool arguments,但仍然
 * 一律走这个函数 —— `ctx.shell` 最终是 `bash -c <command>`(`dsh-bash-local`
 * `:214-220`),所以引号是必需的,不是可选的洁癖。
 *
 * 单引号内除 `'` 外全部字面;`'` 用经典的 `'\''` 闭合-转义-重开。
 * 空串显式编成 `''` 而不是留空(留空会让 flag 吞掉下一个 token)。
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** 把一个工具的 args 拼成 `etscli <subcmd...> --flag <quoted> ...`。 */
export function buildCommand(
  bin: string,
  spec: EtscliToolSpec,
  args: Record<string, unknown>,
): string {
  const parts: string[] = [shellQuote(bin), ...spec.argv.map(shellQuote)]
  for (const param of spec.params) {
    const raw = args[param.model]
    if (raw === undefined || raw === null) continue
    const asText = param.type === 'integer'
      ? String(raw)
      : String(raw)
    if (asText === '') continue
    parts.push(param.flag, shellQuote(asText))
  }
  return parts.join(' ')
}

// ─────────────────────────────────────────────────────────────────────────────
// Output schema
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `@deepseek-ai/dsh-tools` 的 JSON Schema 子集受限(`json-schema.js:28-39`):
 * 只有 type / oneOf / properties / required / additionalProperties / items /
 * enum / const 是约束关键字,description / title / default / examples 是注解
 * 关键字。`type` 与 `oneOf` 互斥(`:219-221`)。
 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    exitCode: { type: 'integer' },
    signal: { type: 'string' },
    timedOut: { type: 'boolean' },
    stdout: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        truncated: { type: 'boolean' },
      },
    },
    stderr: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        truncated: { type: 'boolean' },
      },
    },
  },
} as const

/** 喂给模型的文本上限。`etscli file search` 在满库时能吐几百 KB。 */
const MAX_OUTPUT_CHARS = 8_000

function renderResult(value: {
  exitCode?: number
  signal?: string
  timedOut: boolean
  stdout: { text: string; truncated?: boolean }
  stderr: { text: string; truncated?: boolean }
}): string {
  const out = value.stdout.text ?? ''
  const err = value.stderr.text ?? ''
  const head = value.timedOut
    ? '[etscli] command timed out'
    : `[exit code: ${value.exitCode ?? 'null'}${value.signal !== undefined ? ` (signal ${value.signal})` : ''}]`
  const body = out.length > MAX_OUTPUT_CHARS
    ? `${out.slice(0, MAX_OUTPUT_CHARS)}\n… [truncated ${out.length - MAX_OUTPUT_CHARS} chars]`
    : out
  const errPart = err.trim() === '' ? '' : `\n--- stderr ---\n${err.slice(0, 2_000)}`
  return `${head}\n${body}${errPart}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin
// ─────────────────────────────────────────────────────────────────────────────

export const name = 'etscli-tools'

export const inject = ['tools', 'shell']

export interface Config {
  /** etscli 可执行文件绝对路径。 */
  etscliBin: string
  /** 单次调用超时(交给 `ctx.shell` 钳位,不是我们自己掐表)。 */
  timeoutMs: number
}

export const Config: Schema<Config> = Schema.object({
  etscliBin: Schema.string().default(
    `${(process.env.USERPROFILE ?? process.env.HOME) ?? ''}/.local/bin/etscli`,
  ),
  timeoutMs: Schema.natural().default(30_000),
})

export async function apply(ctx: Context, config: Config): Promise<void> {
  // 代理 trap 防护同 `tools.ts:275-291`:cordis 未 inject 的 service 访问会静默
  // throw "cannot get property X without inject"(§7.92.2),包 try/catch 后给出
  // 可读的失败原因而不是半个插件静默装死。
  let registrar: ToolRegistrarLike | undefined
  let shell: ShellLike | undefined
  try {
    registrar = (ctx as unknown as { tools?: ToolRegistrarLike }).tools
    shell = (ctx as unknown as { shell?: ShellLike }).shell
  } catch (err) {
    throw new Error(`[etscli-tools] cannot access ctx.tools / ctx.shell: ${String(err)}`)
  }
  if (registrar === undefined) throw new Error('[etscli-tools] ctx.tools is not available')
  if (shell === undefined) throw new Error('[etscli-tools] ctx.shell is not available')

  ctx.logger?.info?.(
    `[etscli-tools] registering ${ETSCLI_TOOL_SPECS.length} read-only tools, bin=${config.etscliBin}`,
  )

  for (const spec of ETSCLI_TOOL_SPECS) {
    // 重复注册同名会 throw 并中断整个 apply()(NamedEntries,dsh-tools `lib/index.js:2538`),
    // 留下半注册状态。所以这里**不做部分成功兜底** —— 要么全进,要么整个插件失败、
    // 启动时立刻可见,绝不留下「注册了一半还以为全好了」的静默状态。
    registrar.register({
      name: spec.name,
      description: spec.description,
      parameters: Object.fromEntries(
        spec.params.map(p => [
          p.model,
          {
            type: p.type,
            ...(p.required ? { required: true } : {}),
            description: p.description,
          },
        ]),
      ),
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args: unknown, value: Parameters<typeof renderResult>[0]) => [
          { type: 'text', text: renderResult(value) },
        ],
      },
      timeoutMs: config.timeoutMs,
      // 契约要求**精确** `true` 才并发(省略/抛异常都退回串行)。14 个全是只读,
      // 无共享可变状态,明确 opt in。
      isConcurrencySafe: () => true,
      async execute(args: unknown, exec: ToolRunExecLike) {
        const record: Record<string, unknown> =
          args !== null && typeof args === 'object' && !Array.isArray(args)
            ? (args as Record<string, unknown>)
            : {}
        const command = buildCommand(config.etscliBin, spec, record)
        const result = await shell!.run(
          shell!.resolve({
            command,
            timeoutMs: config.timeoutMs,
            // 透传调用方的 signal:上游 turn 被取消时,子进程必须跟着被杀,
            // 否则 etscli 会变成孤儿进程继续跑(§7.42 的 async-wrap 教训同源)。
            signal: exec.signal,
          }),
        )
        // 注意:execute 返回**纯 JSON**,不是 ContentBlock —— 投影成模型可读的
        // 文本是 output.render 的活儿(见模块头引的 dsh-tool-web web_fetch)。
        //
        // ⚠️ **null 字段必须省略,不能置 null**:output.schema 的受限关键词里
        // 表达不了 nullable(`signal: {type:'string'}` 遇到 `null` 直接判
        // "must be a string",整次执行被拒 —— §7.98 smoke 实测
        // INVALID_TOOL_OUTPUT)。正常退出时 signal=null、被信号杀死时
        // exitCode=null,两个可空字段都只在非 null 时才进对象。
        const value: Record<string, unknown> = {
          timedOut: result.timedOut,
          stdout: { text: result.stdout.text ?? '', truncated: result.stdout.truncated ?? false },
          stderr: { text: result.stderr.text ?? '', truncated: result.stderr.truncated ?? false },
        }
        if (result.exitCode !== null) value.exitCode = result.exitCode
        if (result.signal !== null) value.signal = result.signal
        return value
      },
    })
  }

  ctx.logger?.info?.(
    `[etscli-tools] registered: ${ETSCLI_TOOL_SPECS.map(s => s.name).join(', ')}`,
  )

  // 把注册表当前的全量工具名打进 ops log。用途有二:
  //   1. §7.98 的 realm 白名单要靠它 —— `filterToolsField` 对**未点名**的工具
  //      fail-open 保留(`realm-skill-bridge.ts:713-717`),不逐个标 `"hidden"`
  //      就等于把 `bash` 一起发给 needle(needle 选中它 = 可执行任意命令)。
  //      凭这份真实清单才能保证不漏标。
  //   2. 排查"needle 为什么选了个奇怪的东西"时的第一手证据。
  try {
    const all = (ctx as unknown as {
      tools?: { schemas?: () => Array<{ name?: string }> }
    }).tools?.schemas?.() ?? []
    const names = all.map(s => s?.name).filter((n): n is string => typeof n === 'string')
    const ours = new Set(ETSCLI_TOOL_SPECS.map(s => s.name))
    ctx.logger?.info?.(
      `[etscli-tools] registry total=${names.length} ` +
      `etscli=${names.filter(n => ours.has(n)).length} ` +
      `other=[${names.filter(n => !ours.has(n)).sort().join(', ')}]`,
    )
  } catch (err) {
    ctx.logger?.warn?.(`[etscli-tools] failed to dump registry tool list: ${String(err)}`)
  }
}
