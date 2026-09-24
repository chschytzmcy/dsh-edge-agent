/**
 * §7.59 CI 锁 —— bundle-minimal/ 三文件与产品面的同步性。
 *
 * bundle-minimal 是真机 rig 的静态面(1 张派工单 cordis.patch.yml + 1 份花名册
 * package.json + 1 份 realm 种子 skill-realms.seed.json;§7.59.5 单源收敛),
 * rig 脚本(scripts/minimal-bundle-rig.sh)跑真机验证,本测试跑漂移验证:
 *   - 派工单名单恰好 = 现役 9 插件实装花名册(8 插件闭包 + file-logger 居首)。
 *     §7.93.0(2026-09-24):tools(edge-tools-registry)入图 —— realm-skill-bridge
 *     §7.92.2 inject 加了 edgeTools,极简图必须自带 provider(id≠源名:派工单
 *     id=edge-tools-registry,name 末段=tools;名单断言按 name 末段比)。
 *     §7.59.4:证伪级 stage1/1b 已退役;§7.59.5:stage2/stage2-ops 合并为单一
 *     cordis.patch.yml(headless 孪生的 8 插件图由 rig 运行时派生,不落仓库),
 *     boot 签名逐字存档于 docs/PROGRESS.md §7.59(单一存档点)
 *   - 每条 insert 的 name 末段 ∈ 极简 exports,对应 src 文件存在(①↔②互指)
 *   - Schema 必填字段 + 存储隔离锁(③必填、R7:realm-skill-bridge.configPath;
 *     所有路径表达式只准落 .dsh-edge-agent-minimal,绝不指生产 root)
 *   - inject 闭包锁:派工单名单必须覆盖全部非宿主依赖(防产品侧新增 inject 后
 *     rig 静默 pending —— 原 stage1 证伪过的那类断裂,签名存档 §7.59)
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
/** 唯一现役派工单,名字即 loader 指针名(部署 = 逐字 cp,零改名)。 */
const PATCH = 'cordis.patch.yml'

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

// (ids helper 已退役:名单断言按 name 末段比 —— edge-tools-registry id≠源名)

const CLOSURE = ['audit-log', 'privacy-policy', 'prompt-guard', 'intent-router', 'sanitizer-pipeline', 'tools', 'realm-skill-bridge', 'input-guard'] as const
/** 实装花名册 = 执法闭包 8 + file-logger(运维日志落盘)。file-logger
 *  inject=['web'],headless 冒烟图由 rig deploy 时剥除,但 exports 必须提供,
 *  否则 TUI 形状派工单断链。tools 提供 edgeTools(realm-skill-bridge §7.92.2
 *  inject 依赖),派工单 id=edge-tools-registry、name 末段=tools。 */
const ROSTER = [...CLOSURE, 'file-logger']

const patchRows = stageInserts(PATCH)

/** plugin id → 它向 ctx 提供的 service 名。每个名字都被闭合内其它文件的
 *  inject 列表引用(test 交叉验证),映射本身不引入新信息。 */
const PROVIDES: Record<string, string> = {
  'audit-log': 'auditLog',
  'privacy-policy': 'privacyPolicy',
  'prompt-guard': 'promptGuard',
  'intent-router': 'intentRouter',
  'sanitizer-pipeline': 'sanitizer',
  'edge-tools-registry': 'edgeTools',
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

describe('bundle-minimal:单一派工单名单', () => {
  it('cordis.patch.yml = 恰 9 插件实装花名册,且 file-logger 居首(mount FIRST 才能兜住后续插件的 ctx.logger)', () => {
    assert.equal(patchRows[0]!.id, 'file-logger', 'file-logger 必须是第一行')
    // 按 name 末段(= 源文件名 = 花名册名)比,不按 id —— edge-tools-registry
    // 的 id 与源名 'tools' 不同(dsh-base 同名冲突改名,§7.93.0)。
    const subs = patchRows.map(r => r.name.slice(PKG.length + 1)).sort()
    assert.deepEqual(subs, ROSTER.slice().sort())
  })
})

describe('bundle-minimal:花名册 ↔ 派工单互指', () => {
  it('每条 insert 的 name = PKG/<sub>,<sub> ∈ 极简 exports 且 import 路径规范、src 存在', () => {
    for (const row of patchRows) {
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
  it('privacy-policy 有必填 policyPath;schemastery 缺必填会静默丢插件,连 pending 都看不到', () => {
    const row = patchRows.find(r => r.id === 'privacy-policy')!
    assert.equal(typeof row.config?.policyPath, 'string', 'privacy-policy 缺必填 policyPath')
  })

  it('audit-log 有必填 root(audit-log.ts:75 必填)', () => {
    const row = patchRows.find(r => r.id === 'audit-log')!
    assert.equal(typeof row.config?.root, 'string', 'audit-log 缺必填 root')
  })

  it('file-logger 有必填 root(file-logger.ts:156 required;缺了同 schemastery 静默丢 → 无 ops log 且不报错)', () => {
    const row = patchRows.find(r => r.id === 'file-logger')!
    assert.equal(typeof row.config?.root, 'string', 'file-logger 缺必填 root')
  })

  it('R7 隔离锁:realm-skill-bridge 必须显式 configPath(代码默认硬编码生产 root 且不读 env)', () => {
    const row = patchRows.find(r => r.id === 'realm-skill-bridge')!
    assert.equal(typeof row.config?.configPath, 'string', 'realm-skill-bridge.configPath 缺失 → 会写 ~/.dsh-edge-agent/skill-realms.json 污染生产')
  })

  it('§7.59.1 全云不变量锁:input-guard 必须 sanitizeLocalTraffic=true 且 downgradeOnSanitizeFailure=false', () => {
    // localProvider 在本图被改指宿主云 provider,"LOCAL 轮=不出境"前提失效。
    // 两行任意回滚 = 原文上云或降级路径把未脱敏文本递给云端。
    const cfg = patchRows.find(r => r.id === 'input-guard')!.config ?? {}
    assert.equal(cfg.sanitizeLocalTraffic, true, '缺 sanitizeLocalTraffic=true → LOCAL 轮原文出境')
    assert.equal(cfg.downgradeOnSanitizeFailure, false, '缺 downgradeOnSanitizeFailure=false → 脱敏失败降级"假 LOCAL"(原文上云)')
  })

  it('§7.59.2 探针真实性锁:intent-router 必须显式 classificationModel 且不得含虚构型号', () => {
    // 不显式写 = 吃 intent-router.ts:78 默认 'qwen3-4b' → llm/stream probe 与
    // intent.classify.start 打印本图【不存在】的模型名,误导读日志的人。
    const cfg = patchRows.find(r => r.id === 'intent-router')!.config ?? {}
    assert.equal(typeof cfg.classificationModel, 'string', 'classificationModel 缺省 → 日志打虚构的 qwen3-4b')
    assert.doesNotMatch(String(cfg.classificationModel), /qwen/i, '本图无本地 LLM,哨兵值不应冒充真实型号名')
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
    for (const row of patchRows) {
      for (const [k, v] of Object.entries(row.config ?? {})) {
        if (typeof v !== 'string' || !v.includes('.dsh-edge-agent')) continue
        assert.ok(v.includes('.dsh-edge-agent-minimal'), `${row.id}.${k} 未指向 minimal root: ${v}`)
        assert.doesNotMatch(v, /\.dsh-edge-agent(?!-minimal)/, `${row.id}.${k} 疑似指向生产 root: ${v}`)
      }
    }
  })
})

describe('bundle-minimal:inject 闭包锁', () => {
  it('派工单名单覆盖 9 源文件全部非宿主 inject 依赖(产品侧新增依赖未同步派工单会在此炸)', () => {
    const provided = new Set(patchRows.map(r => PROVIDES[r.id]).filter(Boolean))
    const missing = new Set<string>()
    for (const sub of ROSTER) {
      for (const svc of injectList(sub)) {
        if (!HOST_SERVICES.has(svc) && !provided.has(svc)) missing.add(`${sub} → ${svc}`)
      }
    }
    assert.deepEqual([...missing], [], '派工单缺依赖(补插件行或确认宿主提供)')
    // rig 的 headless 派生图剥 file-logger 的前提就是它只多依赖 web:
    // 若此断言炸,说明 file-logger 依赖面变了,headless 派生逻辑需重评。
    assert.ok(injectList('file-logger').includes('web'), 'file-logger 若不再 inject web,需重评 headless 剥离派生')
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

  it('依赖闭包不变式(证伪阶梯退役后的留守断言):prompt-guard/privacy-policy 的 inject 仍含 auditLog', () => {
    // stage1/1b 的 FAIL-LOUD pending 签名已存档 §7.59;这里锁"若依赖边变了,
    // 存档叙述即过期"——injectList 三行同时是派工单闭包锁的输入前提。
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

  it('指针主张:极简 package.json 声明 dsh.bundle.patch = ./cordis.patch.yml(单源,部署零改名)', () => {
    assert.equal(minPkg.dsh.bundle.patch, `./${PATCH}`)
    assert.ok(existsSync(join(MIN_DIR, PATCH)), `仓库内派工单必须就叫 ${PATCH}(名字即指针名)`)
    assert.ok(existsSync(join(REPO, 'scripts/minimal-bundle-rig.sh')))
  })
})
