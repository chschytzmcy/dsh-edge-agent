/**
 * §7.182 —— 配置落点的**优先级**门禁（主人复述的规则，端到端验证）
 *
 * ## 规则（主人原话的口径）
 *
 * > 「只有 `<安装目录>/config/edge.json` 不存在，再取 `~/.dsh-edge-agent/edge.json`，
 * >   就算 `<安装目录>/config` 下有 `edge.example.json` 文件都不算」
 *
 * ⇒ 拆成四条可断言的命题：
 *
 * | # | 命题 |
 * |---|---|
 * | R1 | 候选表**只有两档**，顺序固定：顺位 1（插件目录）→ 顺位 2（home） |
 * | R2 | 插件目录下的 `edge.example.json` **永远不在候选表里**（哪怕它真实存在） |
 * | R3 | 顺位 1 存在 ⇒ **命中顺位 1**（顺位 2 即使也存在也不看） |
 * | R4 | 顺位 1 不存在 ⇒ 落到顺位 2；两个都不存在 ⇒ 内置默认值 |
 *
 * ## 为什么在临时目录上测
 *
 * 候选表与 loader 都做成了可注入（`edgeConfigCandidates(bundleRoot, homeDir)` /
 * `loadEdgeConfig(force, candidates)`）—— 否则只能靠**往运维的真 home 里写文件**
 * 来验证优先级，既脏又不可重复。
 */
import assert from 'node:assert/strict'
import { describe, it, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

import {
  edgeConfigCandidates,
  edgeConfigPath,
  loadEdgeConfig,
  resetEdgeConfigCache,
} from '../../src/dsh-adapter/edge-config.ts'

const created: string[] = []

/** 造一个「像安装目录」的根：只有 config/，没有 src/ ⇒ 不是 checkout ⇒ 顺位 1 生效。 */
function makeBundle(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-edge-bundle-'))
  created.push(root)
  mkdirSync(join(root, 'config'), { recursive: true })
  return root
}

/** 造一个「像 home」的根：底下放 .dsh-edge-agent/。 */
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-edge-home-'))
  created.push(home)
  mkdirSync(join(home, '.dsh-edge-agent'), { recursive: true })
  return home
}

function writeJson(path: string, body: unknown): void {
  writeFileSync(path, JSON.stringify(body), 'utf8')
}

/**
 * vitest 全局设了 DSH_EDGE_CONFIG_FILE=off（§7.102：不让开发机的活配置泄进断言）。
 * 本文件要断言**真实优先级**，必须临时把这个开关摘掉。
 */
function withFileLayer<T>(fn: () => T): T {
  const prev = process.env.DSH_EDGE_CONFIG_FILE
  delete process.env.DSH_EDGE_CONFIG_FILE
  resetEdgeConfigCache()
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env.DSH_EDGE_CONFIG_FILE
    else process.env.DSH_EDGE_CONFIG_FILE = prev
    resetEdgeConfigCache()
  }
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  resetEdgeConfigCache()
})

describe('§7.182 — 候选表：只有两档，顺序 = 顺位1 → 顺位2', () => {
  it('R1: 安装态的候选表恰好两条，顺序固定', () => {
    const bundle = makeBundle()
    const home = makeHome()
    const candidates = withFileLayer(() => edgeConfigCandidates(bundle, home))
    assert.deepEqual(candidates, [
      join(bundle, 'config', 'edge.json'),
      join(home, '.dsh-edge-agent', 'edge.json'),
    ])
  })

  it('R1: checkout 里跳过顺位 1，只剩 home 一条', () => {
    const bundle = makeBundle()
    mkdirSync(join(bundle, 'src', 'dsh-adapter'), { recursive: true })
    const home = makeHome()
    const candidates = withFileLayer(() => edgeConfigCandidates(bundle, home))
    assert.deepEqual(candidates, [join(home, '.dsh-edge-agent', 'edge.json')])
  })

  it('R2: 插件目录下的 edge.example.json 存在也不进候选表', () => {
    const bundle = makeBundle()
    const home = makeHome()
    writeJson(join(bundle, 'config', 'edge.example.json'), { http: { port: 1 } })
    const candidates = withFileLayer(() => edgeConfigCandidates(bundle, home))
    assert.equal(
      candidates.some(c => c.endsWith('edge.example.json')),
      false,
      `模板不得是候选: ${candidates.join(' | ')}`,
    )
  })
})

describe('§7.182 — 优先级：顺位 1 存在就命中顺位 1，否则顺位 2', () => {
  it('R3: 顺位 1 与顺位 2 都存在 ⇒ 命中顺位 1，顺位 2 不看', () => {
    const bundle = makeBundle()
    const home = makeHome()
    writeJson(join(bundle, 'config', 'edge.json'), { http: { port: 1111 } })
    writeJson(join(home, '.dsh-edge-agent', 'edge.json'), { http: { port: 2222 } })

    withFileLayer(() => {
      const candidates = edgeConfigCandidates(bundle, home)
      const cfg = loadEdgeConfig(true, candidates)
      assert.equal(edgeConfigPath(), join(bundle, 'config', 'edge.json'), '必须命中顺位 1')
      assert.equal(cfg.http?.port, 1111, '取值必须来自顺位 1')
    })
  })

  it('R4: 顺位 1 不存在 ⇒ 落到顺位 2', () => {
    const bundle = makeBundle()
    const home = makeHome()
    writeJson(join(home, '.dsh-edge-agent', 'edge.json'), { http: { port: 2222 } })

    withFileLayer(() => {
      const candidates = edgeConfigCandidates(bundle, home)
      const cfg = loadEdgeConfig(true, candidates)
      assert.equal(edgeConfigPath(), join(home, '.dsh-edge-agent', 'edge.json'), '必须命中顺位 2')
      assert.equal(cfg.http?.port, 2222)
    })
  })

  it('R2/R4: 只有 edge.example.json 存在 ⇒ 不命中它，用内置默认值', () => {
    const bundle = makeBundle()
    const home = makeHome()
    writeJson(join(bundle, 'config', 'edge.example.json'), { http: { port: 1 } })

    withFileLayer(() => {
      const candidates = edgeConfigCandidates(bundle, home)
      const cfg = loadEdgeConfig(true, candidates)
      assert.equal(edgeConfigPath(), undefined, '模板永远不是命中项')
      assert.notEqual(cfg.http?.port, 1, '模板里的取值不得生效')
      assert.equal(cfg.http?.port, 21017, '应当是内置默认值')
    })
  })

  it('R4: 两个落点都没有 ⇒ 内置默认值（path 为 undefined）', () => {
    const bundle = makeBundle()
    const home = makeHome()

    withFileLayer(() => {
      const candidates = edgeConfigCandidates(bundle, home)
      const cfg = loadEdgeConfig(true, candidates)
      assert.equal(edgeConfigPath(), undefined)
      assert.equal(cfg.http?.port, 21017)
    })
  })

  it('R4: 顺位 1 内容坏掉（解析失败）⇒ 落到顺位 2，不整套崩掉', () => {
    const bundle = makeBundle()
    const home = makeHome()
    writeFileSync(join(bundle, 'config', 'edge.json'), '{ not json', 'utf8')
    writeJson(join(home, '.dsh-edge-agent', 'edge.json'), { http: { port: 2222 } })

    withFileLayer(() => {
      const candidates = edgeConfigCandidates(bundle, home)
      const cfg = loadEdgeConfig(true, candidates)
      assert.equal(edgeConfigPath(), join(home, '.dsh-edge-agent', 'edge.json'))
      assert.equal(cfg.http?.port, 2222)
    })
  })
})
