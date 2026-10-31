/**
 * §7.120 —— bash 里直接调 etscli 写子命令的守卫
 *
 * ## 为什么要有这一组
 *
 * §7.98 的安全边界是**注册表白名单**：只把 14 个只读 etscli 子命令注册进
 * `ctx.tools`，写子命令模型**选不到**。但 §7.118 那次实测里 agent 直接
 * `bash: etscli file upload ...` 把本地文件传到了 MEOS 设备 ——
 *
 * - 宿主的 Auto review 闸门**只在 `auto` preset 下安装**（edge preset 用
 *   `workspace-write` ⇒ 没有它）；
 * - 沙箱是**纯文件系统视角**，`etscli file upload` 改的是**远端设备**，对它
 *   完全不可见 ⇒ 不越界 ⇒ 不升级 ⇒ **不触发审批**。
 *
 * ⇒ 白名单管住了「工具清单」，没管住「模型自己在 shell 里敲什么」。
 * 主人裁决（2026-10-31）：用**插件侧守卫**封这条逃逸口（不碰宿主启动环境、
 * 不改 PATH，桌面与无头都生效）。
 *
 * 机制落点是 `tools/pre-execute` waterfall（不是 `ctx.tools.guard()` —— 它
 * 注册进的是**服务自己那个 ctx** 所在的层，插件侧绑不到边缘 preset 的
 * scope，会伸到标准模式；理由见 `src/dsh-adapter/etscli-shell-guard.ts` 模块头）。
 *
 * 这一组把四条边界钉死：
 * 1. **写子命令被拦**（含 §7.118 的事故形状）；
 * 2. **只读子命令照常放行**（不误伤）；
 * 3. **技能路径不受影响**（技能走 `skill` 工具，不经过 shell）；
 * 4. **注册与放行链的形状对**（拒绝 ⇒ deny + 不调 next；放行 ⇒ 调 next）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import {
  evaluateEtscliShellCommand,
  evaluateEtscliToolCall,
  isReadOnlyEtscliArgv,
  registerEtscliShellGuard,
  tokenizeShell,
} from '../../src/dsh-adapter/etscli-shell-guard'
import {
  apply as pluginApply,
  inject as pluginInject,
  name as pluginName,
} from '../../src/dsh-adapter/etscli-shell-guard'
import { ETSCLI_READONLY_ARGV } from '../../src/dsh-adapter/etscli-tools'

/** 主调用的判定：是否被拒 + 子命令。 */
function verdict(command: string): { denied: boolean; subcommand?: string } {
  const v = evaluateEtscliShellCommand(command, { allowlist: ETSCLI_READONLY_ARGV })
  return { denied: v.denied, subcommand: v.subcommand }
}

describe('§7.120 — 只读白名单是单一事实源', () => {
  it('白名单就是注册表派生的那 14 个只读子命令', () => {
    assert.equal(ETSCLI_READONLY_ARGV.length, 14)
    assert.ok(ETSCLI_READONLY_ARGV.some(p => p.join(' ') === 'auth list'))
    assert.ok(ETSCLI_READONLY_ARGV.some(p => p.join(' ') === 'system alarm list'))
  })

  it('前缀匹配精确到 token（fs ls ≠ fs lsx）', () => {
    assert.equal(isReadOnlyEtscliArgv(['fs', 'ls'], ETSCLI_READONLY_ARGV, ETSCLI_READONLY_ARGV), true)
    assert.equal(isReadOnlyEtscliArgv(['fs', 'ls', '--parent', '/tmp'], ETSCLI_READONLY_ARGV, ETSCLI_READONLY_ARGV), true)
    assert.equal(isReadOnlyEtscliArgv(['fs', 'lsx'], ETSCLI_READONLY_ARGV, ETSCLI_READONLY_ARGV), false)
    assert.equal(isReadOnlyEtscliArgv(['file', 'upload'], ETSCLI_READONLY_ARGV, ETSCLI_READONLY_ARGV), false)
  })
})

describe('§7.120 — 写子命令被拦下', () => {
  it('§7.118 的事故形状：file upload', () => {
    const v = verdict('etscli file upload --path /Users/me/备忘/联系方式.txt')
    assert.equal(v.denied, true)
    assert.equal(v.subcommand, 'file upload')
  })

  it('§7.98 排除表里的写子命令逐个被拒', () => {
    for (const cmd of [
      'etscli auth logout',
      'etscli fs rm --file-id abc',
      'etscli file delete --id abc',
      'etscli chat send --group g --text hi',
      'etscli chat send-file --group g --file f',
      'etscli migrate verify',
      'etscli migrate transfer --all',
      'etscli sharing create --name x',
      'etscli meeting summary --id m',
      'etscli file download --id abc',
    ]) {
      assert.equal(verdict(cmd).denied, true, `必须被拒：${cmd}`)
    }
  })

  it('绝对路径调用照样被认出来', () => {
    assert.equal(verdict('/Users/me/.local/bin/etscli file upload /tmp/x').denied, true)
    assert.equal(verdict('~/.local/bin/etscli fs rm --file-id a').denied, true)
  })

  it('管道 / 逻辑连接里的调用照样被认出来', () => {
    assert.equal(verdict('echo hi | etscli file upload /tmp/x').denied, true)
    assert.equal(verdict('etscli auth list && etscli file upload /tmp/x').denied, true)
    assert.equal(verdict('etscli auth list; etscli fs rm --file-id a').denied, true)
  })

  it('引号包住的子命令照样被认出来', () => {
    assert.equal(verdict("etscli 'file' 'upload' /tmp/x").denied, true)
    assert.equal(verdict('etscli "file" "upload" /tmp/x').denied, true)
  })

  it('没给子命令 ⇒ 也拒（fail-closed：认不出来就不放行）', () => {
    assert.equal(verdict('etscli').denied, true)
  })

  it('拒绝理由里点名了子命令与可用清单（模型看得懂怎么改）', () => {
    const v = evaluateEtscliShellCommand('etscli file upload /tmp/x', { allowlist: ETSCLI_READONLY_ARGV })
    assert.ok(v.reason?.includes('file upload'))
    assert.ok(v.reason?.includes('auth list'))
  })
})

describe('§7.120 — 只读子命令照常放行', () => {
  it('白名单里的只读子命令全部放行', () => {
    for (const cmd of [
      'etscli auth list',
      'etscli auth status',
      'etscli user list',
      'etscli system info',
      'etscli system health',
      'etscli system alarm list --number 5',
      'etscli file search --keyword x',
      'etscli fs ls --parent /tmp',
      'etscli fs stat --file-id abc',
      'etscli fs stats --parent /tmp',
      'etscli fs search --name x',
      'etscli meeting list',
      'etscli chat list',
      'etscli sharing list',
    ]) {
      assert.equal(verdict(cmd).denied, false, `不该被拒：${cmd}`)
    }
  })

  it('跟 etscli 无关的命令一律放行', () => {
    assert.equal(verdict('ls -la /tmp').denied, false)
    assert.equal(verdict('grep -r foo .').denied, false)
    // 路径里带 etscli 但不是命令本身
    assert.equal(verdict('/opt/etscli-tools/run.sh').denied, false)
  })
})

describe('§7.120 — 分词器', () => {
  it('引号内的空格不拆词', () => {
    assert.deepEqual(tokenizeShell('etscli file upload "a b c"'), [
      'etscli', 'file', 'upload', 'a b c',
    ])
  })

  it('分隔符单独成 token', () => {
    assert.deepEqual(tokenizeShell('a && b | c'), ['a', '&', '&', 'b', '|', 'c'])
  })
})

describe('§7.120 — 工具执行判定（tools/pre-execute 监听器用）', () => {
  it('bash 里调写子命令 → 判拒', () => {
    const v = evaluateEtscliToolCall({ name: 'bash', arguments: { command: 'etscli file upload /tmp/x' } }, { allowlist: ETSCLI_READONLY_ARGV })
    assert.equal(v.denied, true)
    assert.ok(typeof v.reason === 'string' && v.reason.length > 0)
  })

  it('bash 里调只读子命令 → 不拦', () => {
    const v = evaluateEtscliToolCall({ name: 'bash', arguments: { command: 'etscli fs ls --parent /tmp' } }, { allowlist: ETSCLI_READONLY_ARGV })
    assert.equal(v.denied, false)
  })

  it('不依赖参数名：所有字符串值都过一遍', () => {
    assert.equal(evaluateEtscliToolCall({ name: 'bash', arguments: { cmd: 'etscli file upload /tmp/x' } }, { allowlist: ETSCLI_READONLY_ARGV }).denied, true)
    assert.equal(evaluateEtscliToolCall({ name: 'bash', arguments: { script: ['etscli file upload /tmp/x'] } }, { allowlist: ETSCLI_READONLY_ARGV }).denied, true)
    // 宿主版本的参数字段名会变（arguments / args / input）—— 三个都得认。
    assert.equal(evaluateEtscliToolCall({ name: 'bash', args: { command: 'etscli fs rm --file-id a' } }, { allowlist: ETSCLI_READONLY_ARGV }).denied, true)
    assert.equal(evaluateEtscliToolCall({ name: 'bash', input: { command: 'etscli fs rm --file-id a' } }, { allowlist: ETSCLI_READONLY_ARGV }).denied, true)
  })

  it('技能路径不受影响：skill 工具里的 etscli 文本不拦', () => {
    // 技能走宿主 skill 工具（参数 skillName），脚本内容不在 arguments 里；
    // 即使模型把命令塞进参数，也不该由「shell 逃逸口守卫」来拦。
    assert.equal(evaluateEtscliToolCall({ name: 'skill', arguments: { skillName: 'ets-file' } }, { allowlist: ETSCLI_READONLY_ARGV }).denied, false)
  })

  it('非 shell 工具不拦', () => {
    assert.equal(evaluateEtscliToolCall({ name: 'read', arguments: { path: '/tmp/etscli file upload' } }, { allowlist: ETSCLI_READONLY_ARGV }).denied, false)
  })

  it('拒绝理由与子命令标签不带本地路径', () => {
    const v = evaluateEtscliToolCall({ name: 'bash', arguments: { command: 'etscli file upload /Users/me/备忘/联系方式.txt' } }, { allowlist: ETSCLI_READONLY_ARGV })
    assert.equal(v.denied, true)
    assert.equal(v.subcommand, 'file upload')
    assert.ok(!(v.reason ?? '').includes('联系方式'))
    assert.ok(!(v.reason ?? '').includes('/Users/'))
  })
})

describe('§7.120 — 注册到宿主（tools/pre-execute waterfall）', () => {
  /** 造一个最小 ctx：`ctx.on` 记录监听器，`ctx.tools.register` 只是占位。 */
  function fakeCtx(): { ctx: any; listeners: Array<(exec: unknown, next: () => Promise<unknown>) => Promise<unknown>>; disposer: () => void } {
    const listeners: Array<(exec: unknown, next: () => Promise<unknown>) => Promise<unknown>> = []
    const disposer = () => {}
    const ctx = {
      tools: { register() { return () => {} } },
      on(event: string, fn: (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>) {
        assert.equal(event, 'tools/pre-execute')
        listeners.push(fn)
        return disposer
      },
    }
    return { ctx, listeners, disposer }
  }

  it('ctx.on 缺失 ⇒ 拒绝启动（逃逸口不能静默敞开）', () => {
    const ctx = { tools: { register() { return () => {} } } } as any
    assert.throws(
      () => registerEtscliShellGuard(ctx, { allowlist: ETSCLI_READONLY_ARGV }),
      /etscli-shell-guard/,
    )
  })

  it('注册成功 ⇒ 返回宿主给的 disposer', () => {
    const { ctx, listeners, disposer } = fakeCtx()
    const out = registerEtscliShellGuard(ctx, { allowlist: ETSCLI_READONLY_ARGV })
    assert.equal(out, disposer)
    assert.equal(listeners.length, 1)
  })

  it('写子命令 ⇒ deny + 拒绝理由（工具不派发）', async () => {
    const { ctx, listeners } = fakeCtx()
    registerEtscliShellGuard(ctx, { allowlist: ETSCLI_READONLY_ARGV })
    let nextCalled = false
    const decision = await listeners[0]!(
      { name: 'bash', arguments: { command: 'etscli file upload /tmp/x' } },
      async () => { nextCalled = true; return { kind: 'allow' } },
    )
    assert.equal(nextCalled, false)
    assert.equal((decision as { kind: string }).kind, 'deny')
    assert.ok(((decision as { reason?: string }).reason ?? '').includes('file upload'))
  })

  it('只读子命令 ⇒ 放行且必须调用 next（不能截断宿主链条）', async () => {
    const { ctx, listeners } = fakeCtx()
    registerEtscliShellGuard(ctx, { allowlist: ETSCLI_READONLY_ARGV })
    let nextCalled = false
    const decision = await listeners[0]!(
      { name: 'bash', arguments: { command: 'etscli fs ls --parent /tmp' } },
      async () => { nextCalled = true; return { kind: 'allow' } },
    )
    assert.equal(nextCalled, true)
    assert.deepEqual(decision, { kind: 'allow' })
  })

  it('被拒时回调带出工具名与子命令（证据要落）', async () => {
    const { ctx, listeners } = fakeCtx()
    const seen: Array<{ tool: string; subcommand: string }> = []
    registerEtscliShellGuard(ctx, { allowlist: ETSCLI_READONLY_ARGV, onDeny: d => seen.push({ tool: d.tool, subcommand: d.subcommand }) })
    await listeners[0]!(
      { name: 'bash', arguments: { command: 'etscli file upload /tmp/x' } },
      async () => ({ kind: 'allow' }),
    )
    assert.equal(seen.length, 1)
    assert.equal(seen[0]!.tool, 'bash')
    assert.equal(seen[0]!.subcommand, 'file upload')
  })
})

describe('§7.120 — 插件行（独立挂载，不带 etscli-tools 那一整套工具）', () => {
  it('插件形状齐备（cordis patch 行靠它认）', () => {
    assert.equal(pluginName, 'etscli-shell-guard')
    // §7.169: inject 必须是**空** —— 闸门不能因为某个服务缺席就不装上
    // （那等于逃逸口静默敞开）。审计服务走**延迟注入**。
    assert.deepEqual([...pluginInject], [])
    assert.equal(typeof pluginApply, 'function')
  })

  it('apply()：挂上监听器 + 记「已上膛」启动行 + 返回 disposer', async () => {
    const listeners: Array<(exec: unknown, next: () => Promise<unknown>) => Promise<unknown>> = []
    const logged: string[] = []
    const ctx = {
      on(event: string, fn: (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>) {
        assert.equal(event, 'tools/pre-execute')
        listeners.push(fn)
        return () => {}
      },
      logger: { info: (m: string) => logged.push(m), warn: (m: string) => logged.push(m) },
      // §7.169: 「已上膛」启动行走**延迟注入的 fileLogger** —— 只有 ops log
      // 通道真的就位了才打（否则那一行会静默丢掉）。
      inject(deps: string[], cb: (raw: unknown) => void) {
        if (deps.includes('fileLogger')) cb({ fileLogger: {} })
        return () => {}
      },
    }
    const disposer = await pluginApply(ctx as any, {})
    assert.equal(listeners.length, 1)
    assert.equal(typeof disposer, 'function')
    assert.ok(logged.some(line => line.includes('armed on tools/pre-execute')))
    // 启动行必须把**白名单规模**写出来 —— 白名单是空的/没接上的话一眼能看出来。
    assert.ok(logged.some(line => line.includes(`read-only allowlist=${ETSCLI_READONLY_ARGV.length}`)))
  })

  it('§7.169：审计服务缺席也**照样上膛**（闸门不因证据通道缺失而消失）', async () => {
    const listeners: Array<(exec: unknown, next: () => Promise<unknown>) => Promise<unknown>> = []
    const logged: string[] = []
    const ctx = {
      on(_event: string, fn: (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>) {
        listeners.push(fn)
        return () => {}
      },
      logger: { info: (m: string) => logged.push(m), warn: (m: string) => logged.push(m) },
      // 审计服务**永远**不就绪（auditLog 的回调不触发），fileLogger 就绪。
      inject(deps: string[], cb: (raw: unknown) => void) {
        if (deps.includes('fileLogger')) cb({ fileLogger: {} })
        return () => {}
      },
    }
    await pluginApply(ctx as any, {})
    assert.equal(listeners.length, 1, '闸门必须已经挂上 —— 审计缺席不是免装的理由')
    assert.ok(logged.some(line => line.includes('armed on tools/pre-execute')))
  })

  it('§7.169：ops log 通道没就位时，闸门照样挂上（启动行等通道就位再记）', async () => {
    const listeners: Array<(exec: unknown, next: () => Promise<unknown>) => Promise<unknown>> = []
    const logged: string[] = []
    const ctx = {
      on(_event: string, fn: (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>) {
        listeners.push(fn)
        return () => {}
      },
      logger: { info: (m: string) => logged.push(m), warn: (m: string) => logged.push(m) },
      // fileLogger 永远不就绪 ⇒ 启动行此刻还没法落盘。
      inject(_deps: string[], _cb: (raw: unknown) => void) { return () => {} },
    }
    await pluginApply(ctx as any, {})
    assert.equal(listeners.length, 1, '通道没就位不是闸门不上的理由')
    // 此刻**不**该有一行「已上膛」—— 那会是一行落不了盘的假凭据。
    assert.equal(logged.filter(line => line.includes('armed on tools/pre-execute')).length, 0)
  })

  it('apply()：拒绝时同时落 ops log 与审计行，且**不记命令原文**', async () => {
    const listeners: Array<(exec: unknown, next: () => Promise<unknown>) => Promise<unknown>> = []
    const logged: string[] = []
    const audited: any[] = []
    const ctx = {
      on(_event: string, fn: (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>) {
        listeners.push(fn)
        return () => {}
      },
      logger: { info: (m: string) => logged.push(m), warn: (m: string) => logged.push(m) },
      // §7.169: 宿主语义 —— 审计服务经**延迟注入**送达（`ctx.get('auditLog')`
      // 在未声明 inject 时恒为 undefined，见守卫源码里的说明）。
      inject(deps: string[], cb: (raw: unknown) => void) {
        if (deps.includes('fileLogger')) cb({ fileLogger: {} })
        if (deps.includes('auditLog')) {
          cb({ auditLog: { log: async (entry: any) => { audited.push(entry) } } })
        }
        return () => {}
      },
    }
    await pluginApply(ctx as any, {})
    await listeners[0]!(
      { name: 'bash', arguments: { command: 'etscli file upload /Users/me/备忘/联系方式.txt' } },
      async () => ({ kind: 'allow' }),
    )
    assert.ok(logged.some(line => line.includes('denied tool=bash subcommand=file upload')))
    assert.equal(audited.length, 1)
    assert.equal(audited[0].level, 'security')
    assert.equal(audited[0].kind, 'etscli.shell.denied')
    assert.equal(audited[0].payload.subcommand, 'file upload')
    // 命令原文（含本地路径与文件名）**不得**进审计行。
    assert.ok(!JSON.stringify(audited[0]).includes('联系方式'))
  })
})
