/**
 * §7.59 CI lock —— bundle-minimal/ 六文件与产品面的同步性。
 *
 * bundle-minimal 是真机 rig 的静态面(4 张 stage patch + 1 份花名册 package.json
 * + 1 份 realm 种子 skill-realms.seed.json),
 * rig 脚本(scripts/minimal-bundle-rig.sh)跑真机验证,本测试跑漂移验证:
 *   - stage 名单恰好 = 设计阶梯(1:两插件 / 1b:+audit-log / 2:7 插件闭包 /
 *     2-ops:闭包 + file-logger 实装变体,TUI/web 宿主专用)
 *   - 每条 insert 的 name 末段 ∈ 极简 exports,对应 src 文件存在(①↔②互指)
 *   - Schema 必填字段 + 存储隔离锁(③必填、R7:realm-skill-bridge.configPath;
 *     所有路径表达式只准落 .dsh-edge-agent-minimal,绝不指生产 root)
 *   - inject 闭包锁:stage2 名单必须覆盖全部非宿主依赖(防产品侧新增 inject 后
 *     rig 静默 pending —— 正是 stage1 用来证伪的那类断裂)
 *   - 极简花名册 ⊆ 全量花名册(exports 值、peerDependencies 逐字镜像)
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

const REPO = resolve(import.meta.dirname, '../..')
const MIN_DIR = join(REPO, 'bundle-minimal')
const PKG = '@deepseek-harness-edge-agent/dsh-edge-agent-minimal'

interface InsertRow {
  id: string
  name: string
  config?: Record<string, unknown>
}

const minPkg = JSON.parse(readFileSync(join(MIN_DIR, 'package.json'), 'utf8'))
const rootPkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))

function stageInserts(file: string): InsertRow[] {
  // !!js 自定义 tag:yaml 包按 TAG_RESOLVE_FAILED 处理 → 值为表达式字符串(与
  // scripts/verify-patch-surface.ts 对生产 cordis.patch.yml 的解析行为一致)。
  const doc = parseYaml(readFileSync(join(MIN_DIR, file), 'utf8'), { logLevel: 'error' })
  assert.ok(Array.isArray(doc), `${file}: patch 根必须是列表`)
  const rows = doc.flatMap((item: any) => (Array.isArray(item?.insert) ? item.insert : []))
  assert.equal(doc.filter((i: any) => i && typeof i.id === 'string').length, 0, `${file}: 极简派工单不应有 override/disable 行`)
  return rows.map((r: any) => ({ id: r.id, name: r.name, config: r.config }))
}

const ids = (rows: InsertRow[]) => rows.map(r => r.id).sort()

const CLOSURE = ['audit-log', 'privacy-policy', 'prompt-guard', 'intent-router', 'sanitizer-pipeline', 'realm-skill-bridge', 'input-guard'] as const
/** 花名册允许的全部子路径:闭包 7 + file-logger(仅 stage2-ops 引用;headless
 *  宿主缺 web service,所以 rig 阶梯不挂,但 exports 必须提供否则派工单断链)。 */
const ROSTER = [...CLOSURE, 'file-logger']

/** plugin id → 它向 ctx 提供的 service 名。每个名字都被闭合内其它文件的
 *  inject 列表引用(test 交叉验证),映射本身不引入新信息。 */
const PROVIDES: Record<string, string> = {
  'audit-log': 'auditLog',
  'privacy-policy': 'privacyPolicy',
  'prompt-guard': 'promptGuard',
  'intent-router': 'intentRouter',
  'sanitizer-pipeline': 'sanitizer',
  'realm-skill-bridge': 'realmSkillBridge',
  'input-guard': 'inputGuard',
}
/** 宿主包(dsh-base / dsh-llm / dsh-tui…)提供的服务,极简图不需要点。 */
const HOST_SERVICES = new Set(['llm', 'skills', 'agents', 'tools', 'sessions', 'web', 'invariants', 'tcm', 'ohttp', 'localStorage'])

function injectList(srcFile: string): string[] {
  const m = injectOf(readFileSync(join(REPO, 'src/dsh-adapter', `${srcFile}.ts`), 'utf8'))
  assert.ok(m, `${srcFile}.ts 缺 export const inject`)
  return m!
}

function injectOf(text: string): string[] {
  const m = text.match(/export const inject = \[([\s\S]*?)\]/)
  if (!m) return []
  return [...m[1]!.matchAll(/'([A-Za-z][\w]*)'/g)].map(x => x[1]!)
}

describe('bundle-minimal:stage 阶梯名单', () => {
  it('stage1 恰好点 privacy-policy + prompt-guard(证伪前提:不含 audit-log)', () => {
    const rows = stageInserts('cordis.stage1.yml')
    assert.deepEqual(ids(rows), ['privacy-policy', 'prompt-guard'])
  })

  it('stage1 的 prompt-guard 一行不写 config(主张:派工单不必抄全量 config)', () => {
    const row = stageInserts('cordis.stage1.yml').find(r => r.id === 'prompt-guard')!
    assert.equal(row.config, undefined)
  })

  it('stage1b = stage1 + audit-log(三插件全 ACTIVE)', () => {
    assert.deepEqual(ids(stageInserts('cordis.stage1b.yml')), ['audit-log', 'privacy-policy', 'prompt-guard'])
  })

  it('stage2 = 恰 7 插件能力闭包', () => {
    assert.deepEqual(ids(stageInserts('cordis.stage2.yml')), [...CLOSURE].sort())
  })

  it('stage2-ops = 闭包 + file-logger,且 file-logger 居首(mount FIRST 才能兜住后续插件的 ctx.logger)', () => {
    const rows = stageInserts('cordis.stage2-ops.yml')
    assert.equal(rows[0]!.id, 'file-logger', 'file-logger 必须是第一行')
    assert.deepEqual(ids(rows), ROSTER.slice().sort())
  })
})

describe('bundle-minimal:花名册 ↔ 派工单互指', () => {
  const allRows = ['cordis.stage1.yml', 'cordis.stage1b.yml', 'cordis.stage2.yml', 'cordis.stage2-ops.yml'].flatMap(f => stageInserts(f))

  it('每条 insert 的 name = PKG/<sub>,<sub> ∈ 极简 exports 且 import 路径规范、src 存在', () => {
    for (const row of allRows) {
      assert.ok(row.name.startsWith(`${PKG}/`), `name 前缀错: ${row.name}`)
      const sub = row.name.slice(PKG.length + 1)
      assert.ok(ROSTER.includes(sub), `name 末段越界: ${sub}`)
      const exp = minPkg.exports[`./${sub}`]
      assert.ok(exp, `极简 package.json 缺 exports['./${sub}']`)
      assert.equal(exp.import, `./lib/types/dsh-adapter/${sub}.js`)
      assert.equal(exp.types, `./lib/types/dsh-adapter/${sub}.d.ts`)
      assert.ok(existsSync(join(REPO, 'src/dsh-adapter', `${sub}.ts`)), `源文件缺失: src/dsh-adapter/${sub}.ts(sanitizer 的源是 sanitizer-pipeline.ts,不是 pipeline.ts)`)
    }
  })

  it('极简 exports 子路径与花名册双向相等(闭包 7 + file-logger;菜单↔花名册闭环)', () => {
    const subs = Object.keys(minPkg.exports).filter(k => k !== '.' && k !== './package.json' && k !== './cordis.patch.yml').map(k => k.slice(2)).sort()
    assert.deepEqual(subs, ROSTER.slice().sort())
  })
})

describe('bundle-minimal:必填字段与存储隔离', () => {
  it('凡点 privacy-policy 的 stage 都有 policyPath;schemastery 缺必填会静默丢插件,连 pending 都看不到', () => {
    for (const f of ['cordis.stage1.yml', 'cordis.stage1b.yml', 'cordis.stage2.yml', 'cordis.stage2-ops.yml']) {
      const row = stageInserts(f).find(r => r.id === 'privacy-policy')!
      assert.equal(typeof row.config?.policyPath, 'string', `${f}: privacy-policy 缺必填 policyPath`)
    }
  })

  it('凡点 audit-log 的 stage 都有 root(audit-log.ts:75 必填)', () => {
    for (const f of ['cordis.stage1b.yml', 'cordis.stage2.yml', 'cordis.stage2-ops.yml']) {
      const row = stageInserts(f).find(r => r.id === 'audit-log')!
      assert.equal(typeof row.config?.root, 'string', `${f}: audit-log 缺必填 root`)
    }
  })

  it('stage2-ops 的 file-logger 有必填 root(file-logger.ts:156 required;缺了同 schemastery 静默丢 → 无 ops log 且不报错)', () => {
    const row = stageInserts('cordis.stage2-ops.yml').find(r => r.id === 'file-logger')!
    assert.equal(typeof row.config?.root, 'string', 'file-logger 缺必填 root')
  })

  it('R7 隔离锁:stage2(-ops) realm-skill-bridge 必须显式 configPath(代码默认硬编码生产 root 且不读 env)', () => {
    for (const f of ['cordis.stage2.yml', 'cordis.stage2-ops.yml']) {
      const row = stageInserts(f).find(r => r.id === 'realm-skill-bridge')!
      assert.equal(typeof row.config?.configPath, 'string', `${f}: realm-skill-bridge.configPath 缺失 → 会写 ~/.dsh-edge-agent/skill-realms.json 污染生产`)
    }
  })

  it('§7.59.1 全云不变量锁:stage2(-ops) 的 input-guard 必须 sanitizeLocalTraffic=true 且 downgradeOnSanitizeFailure=false', () => {
    // localProvider 在本图被改指宿主云 provider,"LOCAL 轮=不出境"前提失效。
    // 两行任意回滚 = 原文上云或降级路径把未脱敏文本递给云端。
    for (const f of ['cordis.stage2.yml', 'cordis.stage2-ops.yml']) {
      const cfg = stageInserts(f).find(r => r.id === 'input-guard')!.config ?? {}
      assert.equal(cfg.sanitizeLocalTraffic, true, `${f}: 缺 sanitizeLocalTraffic=true → LOCAL 轮原文出境`)
      assert.equal(cfg.downgradeOnSanitizeFailure, false, `${f}: 缺 downgradeOnSanitizeFailure=false → 脱敏失败降级"假 LOCAL"(原文上云)`)
    }
  })

  it('§7.59.2 探针真实性锁:stage2(-ops) 的 intent-router 必须显式 classificationModel 且不得含虚构型号', () => {
    // 不显式写 = 吃 intent-router.ts:78 默认 'qwen3-4b' → llm/stream probe 与
    // intent.classify.start 打印本图【不存在】的模型名,误导读日志的人。
    for (const f of ['cordis.stage2.yml', 'cordis.stage2-ops.yml']) {
      const cfg = stageInserts(f).find(r => r.id === 'intent-router')!.config ?? {}
      assert.equal(typeof cfg.classificationModel, 'string', `${f}: classificationModel 缺省 → 日志打虚构的 qwen3-4b`)
      assert.doesNotMatch(String(cfg.classificationModel), /qwen/i, `${f}: 本图无本地 LLM,哨兵值不应冒充真实型号名`)
    }
  })

  it('§7.59.3 realm 种子锁:skill-realms.seed.json 合法 JSON、web 工具锁 CLOUD、defaultRealm=hidden、无生产策略/路径', () => {
    // configPath 只有【表】没有数据面 = tools 全 fail-open(§7.47.1)+技能全隐;
    // 种子必须显式、可解析、不含生产私有映射(ets-* 等),路径不碰生产 root。
    const raw = readFileSync(join(MIN_DIR, 'skill-realms.seed.json'), 'utf8')
    const seed = JSON.parse(raw) as { skills: Record<string, string>; tools: Record<string, string>; defaultRealm: string }
    assert.equal(seed.defaultRealm, 'hidden', '未点名技能必须隐——种子不得放宽成 allow-all')
    assert.deepEqual(Object.keys(seed.skills), [], '种子不得携带生产私有 skill 映射(如 ets-*)')
    assert.deepEqual(seed.tools, { web_search: 'CLOUD', web_fetch: 'CLOUD' }, '种子语义 = web 工具锁 CLOUD(LOCAL/SANITIZED 轮禁网)')
    for (const v of Object.values(seed.tools)) {
      // realm-skill-bridge.ts:63 tools 值类型 Exclude<RealmTag,'hidden'>
      assert.ok(['LOCAL', 'CLOUD', 'SANITIZED'].includes(v), `tools 值非法: ${v}`)
    }
    assert.doesNotMatch(raw, /\.dsh-edge-agent(?!-minimal)/, '种子出现生产 root 路径')
  })

  it('所有路径 config 表达式只落 .dsh-edge-agent-minimal,绝不指生产 root', () => {
    const rows = ['cordis.stage1.yml', 'cordis.stage1b.yml', 'cordis.stage2.yml', 'cordis.stage2-ops.yml'].flatMap(f => stageInserts(f))
    for (const row of rows) {
      for (const [k, v] of Object.entries(row.config ?? {})) {
        if (typeof v !== 'string' || !v.includes('.dsh-edge-agent')) continue
        assert.ok(v.includes('.dsh-edge-agent-minimal'), `${row.id}.${k} 未指向 minimal root: ${v}`)
        assert.doesNotMatch(v, /\.dsh-edge-agent(?!-minimal)/, `${row.id}.${k} 疑似指向生产 root: ${v}`)
      }
    }
  })
})

describe('bundle-minimal:inject 闭包锁', () => {
  it('stage2 名单覆盖 7 源文件全部非宿主 inject 依赖(产品侧新增依赖未同步 stage2 会在此炸)', () => {
    const provided = new Set(stageInserts('cordis.stage2.yml').map(r => PROVIDES[r.id]))
    const missing = new Set<string>()
    for (const sub of CLOSURE) {
      for (const svc of injectList(sub)) {
        if (!HOST_SERVICES.has(svc) && !provided.has(svc)) missing.add(`${sub} → ${svc}`)
      }
    }
    assert.deepEqual([...missing], [], 'stage2 派工单缺依赖(补插件行或确认宿主提供)')
  })

  it('stage2-ops 名单覆盖闭包 + file-logger 依赖(file-logger 只多加 web,在 HOST_SERVICES → TUI/web 宿主可挂)', () => {
    const provided = new Set(stageInserts('cordis.stage2-ops.yml').map(r => PROVIDES[r.id]).filter(Boolean))
    const missing = new Set<string>()
    for (const sub of ROSTER) {
      for (const svc of injectList(sub)) {
        if (!HOST_SERVICES.has(svc) && !provided.has(svc)) missing.add(`${sub} → ${svc}`)
      }
    }
    assert.deepEqual([...missing], [], 'stage2-ops 派工单缺依赖')
    assert.ok(injectList('file-logger').includes('web'), 'file-logger 若不再 inject web,需重评 headless 可用性(可删本变体限制)')
  })

  it('PROVIDES 映射与源码一致:每个 service 名至少被 src/dsh-adapter 某个 inject 列表引用(闭包外也算,如 inputGuard 被 *-llm-adapter 消费)', () => {
    const injected = new Set(
      readdirSync(join(REPO, 'src/dsh-adapter'))
        .filter(f => f.endsWith('.ts'))
        .flatMap(f => injectOf(readFileSync(join(REPO, 'src/dsh-adapter', f), 'utf8'))),
    )
    for (const [id, svc] of Object.entries(PROVIDES)) {
      assert.ok(injected.has(svc), `${id} 提供的 ${svc} 没有任何 inject 引用 → 映射过期`)
    }
  })

  it('stage1 的证伪签名前提:prompt-guard/privacy-policy 的 inject 都含 auditLog(stage1 不点它 ⇒ 必然 pending)', () => {
    assert.ok(injectList('privacy-policy').includes('auditLog'))
    assert.ok(injectList('prompt-guard').includes('auditLog'))
    assert.ok(injectList('prompt-guard').includes('privacyPolicy'))
  })
})

describe('bundle-minimal:花名册镜像全量包', () => {
  it('极简 exports ⊆ root exports,同名条目 import/types 逐字相等', () => {
    for (const [k, v] of Object.entries(minPkg.exports)) {
      assert.ok(k in rootPkg.exports, `root exports 缺 ${k}(极简条目需在全量包存在同值镜像)`)
      assert.deepEqual(v, rootPkg.exports[k], `${k} 与全量包镜像不一致`)
    }
  })

  it('root peerDependencies 全部原样出现在极简包(主张:纯声明,不被 loader 消费)', () => {
    for (const [name, ver] of Object.entries(rootPkg.peerDependencies)) {
      assert.equal(minPkg.peerDependencies[name], ver, `peer ${name} 版本漂移`)
    }
  })

  it('指针主张:极简 package.json 声明 dsh.bundle.patch = ./cordis.patch.yml(rig 部署时由 stage 文件落名)', () => {
    assert.equal(minPkg.dsh.bundle.patch, './cordis.patch.yml')
    assert.ok(existsSync(join(REPO, 'scripts/minimal-bundle-rig.sh')))
  })
})
