// _config-ship-policy.mjs — §7.189：`config/` 目录「什么能出货」的单一事实源。
//
// ── 这条纪律要防的事故（2026-11-11 实测） ────────────────────────────────
//
// `config/edge.json.bak-20261029-220133`（一份含 **5 个真 API key** 的备份）
// 被三个生产者**原样**拷进了发布面：
//
//   · dist/installable/<variant>/config/     ← 桌面 profile 用 link: 挂载它
//   · dist/<variant>.tar.gz                  ← 可分发 tarball
//   · dist/.npm-stage/config/                ← pnpm publish 的 cwd
//
// 根因不是「谁忘了排除」，而是**排除写成了精确文件名**：
//
//   if (f === 'edge.json') continue
//
// 按名排除挡不住它的**兄弟**：`edge.json.bak-<时间戳>`（同一份明文的备份）、
// `.DS_Store`（编辑器垃圾）。§7.154 已经在 .gitignore 里补过同样的教训
// （`config/edge.json.bak-*`），但那条规则只管 git，管不到 staging。
//
// 三个生产者各写各的排除逻辑（这正是 §7.162 记过的「两个生产者、两份白名单」）
// ⇒ 这次把它们收敛到一个模块里。
//
// ── 为什么是白名单，不是黑名单 ───────────────────────────────────────────
//
// `config/` 是**产物的一部分**，它该装什么由包自己决定。默认**不出货**：
// 任何新落进来的文件（备份、编辑器垃圾、临时导出）都要**显式**加进
// SHIPPABLE_CONFIG_FILES 才能出货。这样「加一个文件忘了想安全」会立刻被门禁
// 抓住，而不是等到某天有人把它递给别人。
//
// ── 为什么还要一组 npm 排除项（CONFIG_NEGATIONS） ───────────────────────
//
// 出货有**两条互不相干的通道**，各算各的文件清单：
//
//   1. 本地 staging —— rebuild-installable.mjs / _pack-core.mjs 的 stageVariant()
//      自己遍历目录、自己拷文件 ⇒ 用本模块的白名单；
//   2. npm pack —— npm 自己按 package.json#files + .npmignore 算清单
//      ⇒ 用 `files` 里的 `!` 排除项。
//
// 只堵一条，另一条就会漏。所以两边都补，并且有门禁盯着
// `package.json#files` 里的排除项不漂移（verify-installable.mjs）。
//
// ── DEMO 例外 ─────────────────────────────────────────────────────────────
//
// DEMO 产物（§7.160）**故意**带 `config/edge.json`（活配置），它只给主人
// 自己在本机演示用。⇒ 门禁验 DEMO 时用 `allowSecretConfig: true`。
//
// 用法：
//   import { isShippableConfigFile, configShipViolations } from './_config-ship-policy.mjs'

/**
 * 允许随产物出货的 `config/` 文件（白名单）。
 *
 * - `edge.example.json`   —— 空密钥模板，运维照着抄的那份；
 * - `privacy-policy.json` —— 被强制的隐私策略本身。
 */
export const SHIPPABLE_CONFIG_FILES = ['edge.example.json', 'privacy-policy.json']

/**
 * `package.json#files` 里**必须**出现的排除项。
 *
 * 这些是 npm-packlist（gitignore 语法）的排除式，覆盖本地白名单之外的
 * 形状：活配置本身、活配置的备份、编辑器垃圾。
 *
 * 门禁（verify-installable.mjs）会核对这一组确实在 `files` 里 ⇒
 * 本地 staging 与 npm pack 两条通道不会各走各的。
 */
export const CONFIG_NEGATIONS = [
  '!config/edge.json',
  '!config/edge.json.*',
  '!config/*.bak*',
  '!config/.DS_Store',
]

/**
 * 判断 `config/` 下的一个文件名能不能出货。
 *
 * @param {string} name `config/` 下的**文件名**（不含目录前缀）
 * @param {{ allowSecretConfig?: boolean }} [opts]
 *   `allowSecretConfig: true` —— DEMO 产物口径（§7.160）：额外放行
 *   `edge.json`（活配置）。可分发产物一律 false。
 */
export function isShippableConfigFile(name, { allowSecretConfig = false } = {}) {
  const n = String(name)
  if (SHIPPABLE_CONFIG_FILES.includes(n)) return true
  if (allowSecretConfig && n === 'edge.json') return true
  return false
}

/**
 * 给一个「不该出货却出货了」的文件名归类，用于门禁给出可读的失败原因。
 *
 * @param {string} name `config/` 下的文件名
 * @returns {string} 归类标签
 */
export function classifyConfigViolation(name) {
  const n = String(name)
  if (n === 'edge.json') return '明文活配置'
  if (/\.bak/u.test(n)) return '活配置的备份'
  if (n.startsWith('.')) return '隐藏/编辑器垃圾文件'
  if (n.endsWith('.example.json')) return '示例文件（模板只允许 edge.example.json 一个名字）'
  return '不在出货白名单里'
}

/**
 * 在一串**相对路径**里找出所有不该出货的 `config/` 文件。
 *
 * @param {string[]} paths 相对路径列表（如 `config/edge.json`）
 * @param {{ allowSecretConfig?: boolean }} [opts] 同 isShippableConfigFile
 * @returns {Array<{ path: string, name: string, reason: string }>}
 */
export function configShipViolations(paths, { allowSecretConfig = false } = {}) {
  const violations = []
  for (const raw of paths) {
    const norm = String(raw).replace(/\\/gu, '/')
    if (!norm.startsWith('config/')) continue
    const name = norm.slice('config/'.length)
    if (name === '') continue
    if (isShippableConfigFile(name, { allowSecretConfig })) continue
    violations.push({ path: norm, name, reason: classifyConfigViolation(name) })
  }
  return violations
}

/**
 * 把违规项渲染成一句人话（门禁的失败信息）。
 *
 * @param {{ path: string, name: string, reason: string }} v
 */
export function describeConfigViolation(v) {
  return `config/${v.name} 随产物出货（${v.reason}）—— 出货白名单只有：${SHIPPABLE_CONFIG_FILES.join(' / ')}`
}
