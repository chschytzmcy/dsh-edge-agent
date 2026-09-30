/**
 * §7.98 — etscli-tools:只读工具注册表的安全边界单测。
 *
 * 重点不是"能不能跑通 etscli",而是**命令拼装不会变成命令注入通道**:
 *   - `shellQuote` 对恶意值(引号/反引号/分号/换行/反斜杠)必须闭合
 *   - `buildCommand` 的子命令前缀**永不**来自 args(模型改不了)
 *   - flag 名用的是**真实 CLI flag**,不是 bench 的抽象参数名
 *     (fs ls/stats → --parent,fs stat → --file-id,alarm list → --number)
 *   - 缺 required 参数时不拼出空 flag(否则下一个 token 会被吞掉)
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { buildCommand, shellQuote } from '../../src/dsh-adapter/etscli-tools.js'

const BIN = '/home/etsme/.local/bin/etscli'

describe('shellQuote', () => {
  it('普通值原样包进单引号', () => {
    assert.equal(shellQuote('hello'), "'hello'")
    assert.equal(shellQuote('/root/dir'), "'/root/dir'")
  })

  it('空串编成 \'\' 而不是留空', () => {
    // 留空会让 `etscli fs ls --parent ''` 的 flag 吞掉后一个 token
    assert.equal(shellQuote(''), "''")
  })

  it('内嵌单引号用经典闭合-转义-重开', () => {
    assert.equal(shellQuote("it's"), "'it'\\''s'")
  })

  it('命令替换 / 分号 / 反引号全部落在引号内失效', () => {
    // 这些是注入尝试的典型载荷;正确转义后它们只是字面文本
    for (const payload of ['$(id)', '`id`', '; id', 'a && id', 'a | id', 'a\nid', 'a>b']) {
      const quoted = shellQuote(payload)
      assert.ok(quoted.startsWith("'") && quoted.endsWith("'"), `未闭合: ${payload} → ${quoted}`)
      // 不含单引号的载荷 → 恰好 2 个引号(开 + 闭),内部无引号
      const unescaped = (quoted.match(/'(?<!\\)/g) ?? []).length
      assert.equal(unescaped, 2, `引号数异常: ${payload} → ${quoted}`)
    }
  })

  it('反斜杠不被当作转义(单引号内它是字面量)', () => {
    assert.equal(shellQuote('a\\b'), "'a\\b'")
  })
})

describe('buildCommand', () => {
  it('无参工具:只拼固定子命令', () => {
    assert.equal(
      buildCommand(BIN, { name: 'x', description: '', argv: ['auth', 'list'], params: [] }, {}),
      `'/home/etsme/.local/bin/etscli' 'auth' 'list'`,
    )
  })

  it('子命令前缀来自固定表,args 改不动它', () => {
    // 即便模型塞了 auth/argv 里的东西,也只会变成 flag 值,不会改写子命令
    const cmd = buildCommand(
      BIN,
      { name: 'x', description: '', argv: ['auth', 'list'], params: [] },
      { auth: 'rm', argv: 'user delete' },
    )
    assert.equal(cmd, `'/home/etsme/.local/bin/etscli' 'auth' 'list'`)
  })

  it('fs ls 用 --parent(不是 --path)', () => {
    const cmd = buildCommand(
      BIN,
      {
        name: 'etscli_fs_ls',
        description: '',
        argv: ['fs', 'ls'],
        params: [{ model: 'path', flag: '--parent', type: 'string', description: '' }],
      },
      { path: '/' },
    )
    assert.equal(cmd, `'/home/etsme/.local/bin/etscli' 'fs' 'ls' --parent '/'`)
  })

  it('fs stat 用 --file-id(不是 --path)', () => {
    const cmd = buildCommand(
      BIN,
      {
        name: 'etscli_fs_stat',
        description: '',
        argv: ['fs', 'stat'],
        params: [{ model: 'path', flag: '--file-id', type: 'string', description: '', required: true }],
      },
      { path: 'estor://X' },
    )
    assert.ok(cmd.includes("--file-id 'estor://X'"), cmd)
    assert.ok(!cmd.includes('--path'), cmd)
  })

  it('system alarm list 用 --number(不是 --limit)', () => {
    const cmd = buildCommand(
      BIN,
      {
        name: 'etscli_system_alarm_list',
        description: '',
        argv: ['system', 'alarm', 'list'],
        params: [{ model: 'limit', flag: '--number', type: 'integer', description: '' }],
      },
      { limit: 5 },
    )
    assert.equal(cmd, `'/home/etsme/.local/bin/etscli' 'system' 'alarm' 'list' --number '5'`)
  })

  it('undefined / null 参数不拼 flag', () => {
    const spec = {
      name: 'x', description: '',
      argv: ['fs', 'ls'],
      params: [{ model: 'path', flag: '--parent', type: 'string' as const, description: '' }],
    }
    for (const args of [{}, { path: undefined }, { path: null }]) {
      const cmd = buildCommand(BIN, spec, args)
      assert.equal(cmd, `'/home/etsme/.local/bin/etscli' 'fs' 'ls'`)
    }
  })

  it('空串参数被跳过,不产生空 flag', () => {
    const cmd = buildCommand(
      BIN,
      {
        name: 'x', description: '',
        argv: ['fs', 'ls'],
        params: [{ model: 'path', flag: '--parent', type: 'string' as const, description: '' }],
      },
      { path: '' },
    )
    assert.equal(cmd, `'/home/etsme/.local/bin/etscli' 'fs' 'ls'`)
  })

  it('注入载荷作为参数值时被引号困住', () => {
    const cmd = buildCommand(
      BIN,
      {
        name: 'etscli_file_search',
        description: '',
        argv: ['file', 'search'],
        params: [{ model: 'keyword', flag: '--keyword', type: 'string' as const, description: '', required: true }],
      },
      { keyword: "$(rm -rf /); id" },
    )
    // flag 裸、值被单引号困住 —— 分号/$( ) 落在引号内只是字面文本
    assert.equal(cmd, `'/home/etsme/.local/bin/etscli' 'file' 'search' --keyword '$(rm -rf /); id'`)
    // 结构性检查:把引号内的内容整段挖掉,剩下的裸区不得含任何 shell 元字符
    const bare = cmd.replace(/'[^']*'/g, ' ')
    assert.ok(!/[;|&`<>$()\\]/.test(bare), `裸区出现 shell 元字符: ${bare}`)
  })
})
