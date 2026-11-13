/**
 * §7.223 (2026-11-13) —— 「一个 env 名字只对应一个配置字段」的运行时契约。
 *
 * ## 这个文件防的是什么
 *
 * 修 §7.222 撞见的那个隐患时，发现 `DSH_EDGE_STORAGE_ROOT` 这**一个**环境变量名
 * 当时被当成**四样**东西：
 *
 *   1. `tee.storageRoot`（env 桥推的）——  与第 2 项**同名**，后者静默覆盖前者
 *      ⇒ `tee.storageRoot` **永远传不出去**；
 *   2. `storage.root`（env 桥 + 插件侧 ENV_OVERRIDES）；
 *   3. dev harness 的「存储基目录」（`cordis.yml` 的 4 处 `!!js` 表达式）；
 *   4. 插件侧 ENV_OVERRIDES 映射到的那一个。
 *
 * 修完之后：`DSH_EDGE_STORAGE_ROOT` **只**表示 local-storage 的 root
 * （= `docs/privacy-policy.md` 与 `config/edge.example.json` 一直写的那个意思），
 * TCM 侧的两个路径字段各有各的名字。
 *
 * ## 为什么静态门禁不够
 *
 * `scripts/verify-env-bridge.mjs` 能查出「同名两次推」与「两半指向不同字段」，
 * 但那是**读源码**得出的结论。本文件钉的是**运行时行为**：这三个 env 真的分别
 * 落到三个字段上，而且**互不串台**。
 */
import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach } from 'vitest'

import { applyEnvOverrides, type EdgeConfig } from '../../src/dsh-adapter/edge-config.ts'

/** 本文件只关心这三个名字 ⇒ 其余 DSH_EDGE_* 一律清掉，免得开发机的环境泄进断言。 */
const TOUCHED = ['DSH_EDGE_STORAGE_ROOT', 'DSH_EDGE_TEE_STORAGE_ROOT', 'DSH_EDGE_TEE_KEY_STORE_PATH']
const saved = new Map<string, string | undefined>()

function freshConfig(): EdgeConfig {
  return {
    storage: { root: undefined },
    tee: { type: 'simulated', storageRoot: undefined, keyStorePath: undefined },
  } as unknown as EdgeConfig
}

beforeEach(() => {
  for (const k of TOUCHED) {
    saved.set(k, process.env[k])
    delete process.env[k]
  }
})

afterEach(() => {
  for (const k of TOUCHED) {
    const v = saved.get(k)
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('§7.223 · env → 配置字段：一对一，互不串台', () => {
  it('DSH_EDGE_STORAGE_ROOT 只落到 storage.root，不碰 tee.storageRoot', () => {
    process.env.DSH_EDGE_STORAGE_ROOT = '/data/local-storage'
    const cfg = applyEnvOverrides(freshConfig())

    assert.equal(cfg.storage?.root, '/data/local-storage')
    assert.equal(cfg.tee?.storageRoot, undefined, 'storage 的 env 名字不许顺手改到 TCM 的目录上')
  })

  it('DSH_EDGE_TEE_STORAGE_ROOT 只落到 tee.storageRoot，不碰 storage.root', () => {
    process.env.DSH_EDGE_TEE_STORAGE_ROOT = '/data/tcm'
    const cfg = applyEnvOverrides(freshConfig())

    assert.equal(cfg.tee?.storageRoot, '/data/tcm')
    assert.equal(cfg.storage?.root, undefined, 'TCM 的 env 名字不许顺手改到 local-storage 的 root 上')
  })

  it('DSH_EDGE_TEE_KEY_STORE_PATH 落到 tee.keyStorePath', () => {
    process.env.DSH_EDGE_TEE_KEY_STORE_PATH = '/data/tcm/keys.json'
    const cfg = applyEnvOverrides(freshConfig())

    assert.equal(cfg.tee?.keyStorePath, '/data/tcm/keys.json')
    assert.equal(cfg.tee?.storageRoot, undefined)
    assert.equal(cfg.storage?.root, undefined)
  })

  it('三个名字同时设 ⇒ 三个字段各归各位', () => {
    process.env.DSH_EDGE_STORAGE_ROOT = '/data/local-storage'
    process.env.DSH_EDGE_TEE_STORAGE_ROOT = '/data/tcm'
    process.env.DSH_EDGE_TEE_KEY_STORE_PATH = '/data/tcm/keys.json'
    const cfg = applyEnvOverrides(freshConfig())

    assert.equal(cfg.storage?.root, '/data/local-storage')
    assert.equal(cfg.tee?.storageRoot, '/data/tcm')
    assert.equal(cfg.tee?.keyStorePath, '/data/tcm/keys.json')
  })

  it('空串当未设置（不覆盖文件里的值）', () => {
    process.env.DSH_EDGE_STORAGE_ROOT = ''
    const cfg = applyEnvOverrides({
      storage: { root: '/from-file' },
      tee: { type: 'simulated' },
    } as unknown as EdgeConfig)

    assert.equal(cfg.storage?.root, '/from-file')
  })
})
