/**
 * verify-git-install — 「从 GitHub 仓库地址安装」这条通道的**契约门禁**
 *
 * ## 为什么要有这个门禁
 *
 * 桌面版 GUI 的「添加插件」对话框接受三种输入（宿主 `packages/client/
 * ui-plugin-manager/src/client/locales.ts:75`）：
 *
 * > 输入插件的包名、GitHub 仓库地址或本地目录路径。
 *
 * 宿主侧这条通道**已经做完了**（本仓只读参考 `deepseek-harness`）：
 *
 * | 环节 | 宿主位置 |
 * |---|---|
 * | spec 解析（git / tarball / 绝对路径 / 包名） | `boot/plugin-manager/src/install-spec.ts:69-92` |
 * | GitHub 连通性预检（`git ls-remote`，不注入凭据） | `boot/plugin-manager/src/github-connection.ts:44` |
 * | 传输选择（自建主机 HTTPS→SSH 回退） | `boot/plugin-manager/src/git-transport.ts:65-71` |
 * | 真正安装：`pnpm add <spec>`，cwd = profile 目录 | `boot/plugin-manager/src/index.ts:930` |
 * | 装后校验：必须是 bundle | `boot/plugin-manager/src/index.ts:971-972` |
 * | 装后校验：DSH 版本兼容 | `boot/plugin-manager/src/index.ts:973-974` |
 * | 装后：加载 bundle patch 文件（缺文件即失败回滚） | `boot/plugin-manager/src/index.ts:975` |
 * | 装后：写 `dsh.profile.bundles` | `boot/plugin-manager/src/index.ts:1173-1176` |
 *
 * 宿主自己的说明（`docs/user/develop/basic/publish.md:161-186`）把作者那一侧
 * 的义务讲得很直白：
 *
 * > a git install fetches **sources, not built artifacts**: nothing runs your
 * > `build` script, so a TypeScript package arrives without its `lib/` output
 * > and fails to load.
 *
 * > The **author** ships a `prepare` script — pnpm runs it after a git install —
 * > that builds the published entry points from source, **self-contained**.
 *
 * > The **user** allowlists the build. pnpm ≥10 refuses to run a git
 * > dependency's `prepare` script until it is explicitly allowed.
 *
 * ⇒ **本仓的义务只有一件：让「克隆源码 → prepare → 打包」这条链产出宿主要的
 * 全部东西**，剩下的（预检、授权、装后校验、启用）宿主都做完了。
 *
 * ## 本门禁查什么
 *
 * 宿主那几条契约，逐条变成可自动检查的断言：
 *
 * 1. **身份**：`name` / `version` 非空（宿主靠 dependencies 的键 = 包名，
 *    认出「装了什么」——`index.ts:960-968`）。
 * 2. **bundle 声明**：`dsh.bundle.patch` 必须声明，否则宿主判 `not-bundle`
 *    （`operations.ts:75-79` → `index.ts:971-972`）。
 * 3. **patch 文件真实存在**，且是合法 YAML 数组（`index.ts:975` →
 *    `app-boot/src/index.ts:538-546`）。
 * 4. **prepare 链必须产出两个入口**：
 *    - `main` / `exports['.']` —— Node 半侧；
 *    - `exports['./client']` —— 浏览器半侧（`lib/client.js`）。
 *    **浏览器半边由 `build:client`（esbuild）产出，`tsc` 产不出来** ——
 *    §7.145 记过：缺它的症状是「宿主半侧正常挂载、Edge tab 静默不出现」，
 *    日志里什么都不说。git 装只跑 `prepare`，不跑 `build` ⇒ **`prepare`
 *    链里漏了 `build:client`，GitHub 通道装出来的插件就没有 Edge tab。**
 * 5. **`engines.dsh` 必须声明**：有它则版本判定独断，否则改用
 *    `@deepseek-ai/dsh*` peers 逐个判（`app-boot/src/plugin-compatibility.ts:77-78`）。
 * 6. **`files` 白名单覆盖** bundle 需要的全部路径（npm/pnpm pack 都按它裁剪），
 *    且 `config/edge.json`（明文密钥）必须被排除。
 * 7. **prepare 自包含**：不得出现 `workspace:` 协议、不得引用仓库外的路径
 *    （`publish.md:171` 的原文要求）。
 *
 * ## `--real`：把整条通道真的走一遍
 *
 * 静态检查只能证明「我们准备齐了」。`--real` 会**克隆本仓的已提交状态**
 * （= GitHub 会给用户的那份：只有 tracked 文件，没有 `lib/`），在临时
 * profile 目录里用**桌面 runtime 自带的那个 pnpm** 装它，然后检查装出来
 * 的包里真的有 `lib/index.js`、`lib/client.js` 与 bundle patch 文件。
 *
 * pnpm 会先以「需要构建授权」失败一次（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`），
 * 本脚本按宿主 `build-approval.ts` 的做法解析 pnpm 打印的 `allowBuilds` 键、
 * 写进 profile 的 `pnpm-workspace.yaml`、再装一次 —— 与 GUI 上点
 * 「允许这些脚本并重试」走的是同一条路。
 *
 * Run via:
 *   node scripts/verify-git-install.mjs           # 静态契约（快，CI 用这个）
 *   node scripts/verify-git-install.mjs --real    # 端到端模拟（要联网）
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { parse as parseYaml, parseDocument } from 'yaml'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/**
 * pnpm 拒绝为 git 依赖跑 prepare 时打印的 `allowBuilds` 建议键。
 * 与宿主 `build-approval.ts:15` 的正则一致：键在 `allowBuilds:` 下一行、以 `: true` 结尾。
 */
const GIT_DEP_PREPARE = /ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED[\s\S]*?^allowBuilds:\r?\n[ \t]+(.+?): true$/mu

/** 收集失败项，最后一起报 —— 一次跑完比一条条试快。 */
const failures = []
const check = (ok, message) => { if (!ok) failures.push(message) }

/* ── 1. 身份 ─────────────────────────────────────────────────────────────── */

check(
  typeof manifest.name === 'string' && manifest.name.length > 0,
  'package.json#name 为空 —— 宿主靠它认出「装了什么」（plugin-manager index.ts:960-968）',
)
check(
  typeof manifest.version === 'string' && manifest.version.length > 0,
  'package.json#version 为空 —— 不兼容时要靠 name@version 定位（plugin-compatibility.ts:96）',
)

/* ── 2. bundle 声明 ──────────────────────────────────────────────────────── */

const bundlePatch = manifest.dsh?.bundle?.patch
const patchPaths = (typeof bundlePatch === 'string' ? [bundlePatch] : Array.isArray(bundlePatch) ? bundlePatch : [])
check(
  patchPaths.length > 0,
  'package.json#dsh.bundle.patch 未声明 —— 宿主会判 not-bundle（operations.ts:75-79 → index.ts:971-972）',
)

/* ── 3. patch 文件存在且是 YAML 数组 ─────────────────────────────────────── */

for (const patchPath of patchPaths) {
  const absolute = join(ROOT, patchPath.replace(/^\.\//u, ''))
  check(
    existsSync(absolute),
    `bundle patch 文件不存在：${patchPath} —— 宿主装到这一步会抛错并回滚（index.ts:975 → app-boot/src/index.ts:538-546）`,
  )
  if (!existsSync(absolute)) continue
  let parsed
  try {
    // patch 文件里带 `!!js` 标签（宿主的 patch 语法），通用 YAML 解析器不认识
    // 它 —— 只告警不影响结果。本门禁只判「是不是数组」，告警是噪音，静默掉。
    parsed = parseYaml(readFileSync(absolute, 'utf8'), { logLevel: 'silent' })
  } catch (error) {
    failures.push(`bundle patch 不是合法 YAML：${patchPath}（${error.message}）`)
    continue
  }
  check(
    Array.isArray(parsed),
    `bundle patch 必须是 YAML 数组（patch entry 列表）：${patchPath}`,
  )
}

/* ── 4. prepare 链的覆盖面 ──────────────────────────────────────────────── */

/**
 * 从 `scripts.prepare` 出发，找出**可达**的脚本集合。
 * 本仓的脚本互引一律走 `node scripts/run.mjs <name>`（run.mjs 是包管理器
 * 无关的运行器，见该文件头部），所以从这里能顺着链走到底。
 */
function reachableScripts(start) {
  const seen = new Set()
  const queue = [start]
  while (queue.length > 0) {
    const name = queue.pop()
    if (seen.has(name)) continue
    const body = manifest.scripts?.[name]
    if (typeof body !== 'string') continue
    seen.add(name)
    // `node scripts/run.mjs <name> [<name> ...]` —— run.mjs 后面**所有**参数都是脚本名
    for (const match of body.matchAll(/run\.mjs((?:\s+[A-Za-z0-9:._-]+)+)/gu)) {
      for (const referenced of match[1].trim().split(/\s+/u)) queue.push(referenced)
    }
    for (const match of body.matchAll(/\b(?:npm|pnpm|yarn)\s+run\s+([A-Za-z0-9:._-]+)/gu)) queue.push(match[1])
  }
  return seen
}

const prepareChain = reachableScripts('prepare')
check(
  prepareChain.has('compile'),
  'prepare 链没有覆盖 compile —— git 装只跑 prepare，不跑 build；Node 半侧（lib/**）会缺失',
)
check(
  prepareChain.has('build:client'),
  'prepare 链没有覆盖 build:client —— lib/client.js（浏览器半侧）由 esbuild 产出，tsc 产不出来；'
  + '缺它的症状是「宿主半侧正常、Edge tab 静默不出现」（§7.145）',
)

// 产物必须真的存在（verify:build 先跑 compile + build:client，再跑本门禁）。
check(existsSync(join(ROOT, 'lib', 'index.js')), 'lib/index.js 不存在 —— 宿主入口没构建出来')
check(existsSync(join(ROOT, 'lib', 'client.js')), 'lib/client.js 不存在 —— 浏览器半边没构建出来')

// 入口声明与产物必须对得上。
const clientExport = manifest.exports?.['./client']
check(
  typeof clientExport === 'string' && clientExport.startsWith('./'),
  'package.json#exports["./client"] 缺失 —— 声明了 dsh.client 的包必须给出浏览器入口',
)
if (typeof clientExport === 'string') {
  check(
    existsSync(join(ROOT, clientExport.replace(/^\.\//u, ''))),
    `exports["./client"] 指向的文件不存在：${clientExport}`,
  )
}

/* ── 5. engines.dsh ──────────────────────────────────────────────────────── */

check(
  typeof manifest.engines?.dsh === 'string' && manifest.engines.dsh.length > 0,
  'package.json#engines.dsh 未声明 —— 版本兼容会退回逐个 peer 判定（plugin-compatibility.ts:77-78）；'
  + '宿主自己的 publish 文档把它列为强烈建议',
)

/* ── 6. files 白名单 ─────────────────────────────────────────────────────── */

const files = Array.isArray(manifest.files) ? manifest.files : []
const negated = new Set(files.filter((entry) => entry.startsWith('!')).map((entry) => entry.slice(1)))
const shipped = new Set(files.filter((entry) => !entry.startsWith('!')))
for (const required of ['lib', 'config']) {
  check(shipped.has(required), `package.json#files 缺少 "${required}" —— 打包时会被裁掉`)
}
for (const patchPath of patchPaths) {
  const normalized = patchPath.replace(/^\.\//u, '')
  const covered = shipped.has(normalized) || [...shipped].some((entry) => normalized.startsWith(`${entry}/`))
  check(covered, `files 白名单没有覆盖 bundle patch：${patchPath}`)
}
check(
  negated.has('config/edge.json'),
  'files 没有排除 config/edge.json —— 它含明文 API key，绝不能进任何分发产物',
)
check(
  shipped.has('config') && existsSync(join(ROOT, 'config', 'edge.example.json')),
  'config/edge.example.json 不在包里 —— git 装没有 config/edge.json（密钥不入库），运行时要靠它兜底',
)

/* ── 7. prepare 自包含 ───────────────────────────────────────────────────── */

for (const name of prepareChain) {
  const body = manifest.scripts?.[name] ?? ''
  check(
    !body.includes('workspace:'),
    `scripts#${name} 引用了 workspace: 协议 —— git 装只克隆本仓，没有 monorepo 兄弟包可依赖`
    + '（publish.md:171 要求 prepare 自包含）',
  )
}

/* ── 报告 ────────────────────────────────────────────────────────────────── */

if (failures.length > 0) {
  console.error('verify-git-install: FAILED')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(
  `verify-git-install: 静态契约 OK`
  + `（bundle patch ${patchPaths.length} 个，prepare 链覆盖 ${[...prepareChain].sort().join(', ')}）`,
)

/* ── --real：端到端模拟 ──────────────────────────────────────────────────── */

if (!process.argv.includes('--real')) process.exit(0)

/** 桌面 runtime 自带的 pnpm（插件管理器跑的就是它）；PATH 上有 pnpm 就用 PATH 的。 */
function resolvePnpm() {
  const runtime = join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
  if (existsSync(runtime)) return { command: process.execPath, args: [runtime] }
  return { command: 'pnpm', args: [] }
}

const pnpm = resolvePnpm()

const tmp = join(homedir(), 'AppData', 'Local', 'Temp', 'dsh-git-install-verify')
const clone = join(tmp, 'repo')
const profile = join(tmp, 'profile')
rmSync(tmp, { recursive: true, force: true })
mkdirSync(profile, { recursive: true })

const run = (command, args, cwd, options = {}) => {
  try {
    return { code: 0, out: execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: options.shell === true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }) }
  } catch (error) {
    return { code: error.status ?? -1, out: `${error.stdout ?? ''}\n${error.stderr ?? ''}` }
  }
}

/**
 * 在 PATH 上找可执行文件，**按 Windows 的规矩补扩展名**。
 *
 * 为什么不能直接 `execFileSync('pnpm', ...)` 探：Node 在 Windows 上不会给无扩展名的
 * 命令名补 `.cmd`/`.bat`（Node 20.12+ 出于 CVE-2024-27980 直接拒绝 spawn .cmd/.bat），
 * 而 `npm i -g pnpm` 装出来的恰恰是 `pnpm.cmd`。用 execFileSync 探测会**误报**
 * 「PATH 上没有 pnpm」—— 本机实测 `pnpm.cmd` 明明在 PATH 上，仍报 ENOENT。
 *
 * 这里的规则与 cmd.exe / cross-spawn 一致：PATH 逐目录 × PATHEXT 逐扩展名。
 *
 * @param name 命令名（不带扩展名）。
 * @returns 命中的绝对路径；没找到返回 undefined。
 */
function resolveOnPath(name) {
  const directories = (process.env.PATH ?? '').split(delimiter).filter((entry) => entry !== '')
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((entry) => entry !== '')
    : ['']
  for (const directory of directories) {
    for (const extension of extensions) {
      // Windows 文件名大小写不敏感，但这里两种写法都试，避免在大小写敏感的盘上漏掉。
      for (const suffix of extension === '' ? [''] : [extension.toLowerCase(), extension]) {
        const candidate = join(directory, name + suffix)
        if (existsSync(candidate)) return candidate
      }
    }
    // PATH 上也可能直接放了一个无扩展名的可执行文件（POSIX 习惯）。
    const bare = join(directory, name)
    if (existsSync(bare)) return bare
  }
  return undefined
}

// **前置条件**：PATH 上必须有 `pnpm` 可执行文件。
//
// 为什么：pnpm 为 git 依赖做准备时，会往 clone 的 manifest 里注入一条
// `<pm>-install` 脚本，内容就是 `<pm> install`（pnpm 自己的源码：
// `dist/pnpm.mjs:130133` 决定 pm 名、`:130157` 注入脚本、`:130158` 用 shell 跑它）。
// `prepare` 非空 ⇒ 一定走这条路（`:130185`）⇒ shell 必须能在 PATH 上找到 `pnpm`。
//
// `<pm>` 为什么是 pnpm：pnpm 用 `preferredPM(clone 根目录)` 决定（`:130053`）——
// **先看 package-lock.json，再看 yarn.lock，再看 pnpm-lock.yaml**。本仓的
// `package-lock.json` 在 `.gitignore` 里（clone 里没有），`pnpm-lock.yaml` 被跟踪
// ⇒ 判定为 pnpm ⇒ 注入 `pnpm install`。
//
// 桌面 runtime 的 `bin/` 里**只有 node/node.cmd，没有 pnpm**（宿主
// `apps/desktop-host/src/index.ts:44` 把 runtime\bin 前置到 PATH）⇒ 这条通道
// 在桌面版上要求机器上另有一个 `pnpm`（例如 `npm i -g pnpm` 装到
// `C:\Users\<user>\AppData\Roaming\npm`，该目录本就在用户 PATH 上）。
//
// 这里显式检查并给出可执行的补救，而不是让 pnpm 抛一句
// 「'pnpm' is not recognized」把人卡住。
{
  const found = resolveOnPath('pnpm')
  // 按**裸名**走 shell 跑 —— 这正是 pnpm 的 lifecycle 跑注入脚本的方式
  // （注入的脚本体是 `pnpm install`，由 cmd.exe 按 PATHEXT 找 pnpm.cmd）。
  // 不用绝对路径：cmd 在 `/d /s /c` 下的引号规则极易踩坑；
  // 也不传 args：Node 20+ 对「shell + args」会打 DEP0190 警告（参数不转义只拼接）。
  const probe = run('pnpm --version', [], ROOT, { shell: true })
  check(
    found !== undefined && probe.code === 0,
    'PATH 上没有可用的 `pnpm`（含 pnpm.cmd / pnpm.exe）—— pnpm 为 git 依赖注入的 `pnpm install` '
    + '步骤需要它。补救：`npm i -g pnpm`（装到用户 PATH 上的 npm 全局目录，Windows 上是 '
    + '`C:\\Users\\<用户>\\AppData\\Roaming\\npm`），装完**重启桌面版**让它继承新 PATH；'
    + '或改走 npm / tarball 通道（宿主 publish.md 的建议）。'
    + (probe.out ? `\n探测输出：${probe.out.trim().slice(0, 500)}` : ''),
  )
}

try {
  // 0. 必须先提交：`git clone` 拿到的是**已提交状态**。工作区脏着跑，
  //    测的是旧代码，会给出**假的通过** —— 这一条就是防这个。
  const dirty = run('git', ['status', '--porcelain'], ROOT)
  check(
    dirty.out.trim() === '',
    '工作区有未提交改动 —— --real 克隆的是已提交状态，测到的不是当前代码。请先提交再跑。',
  )

  // 1. 克隆**已提交状态** —— 这就是 GitHub 会给用户的那份（只有 tracked 文件）。
  const cloned = run('git', ['clone', '--quiet', '--no-hardlinks', ROOT, clone], tmp)
  if (cloned.code !== 0) {
    console.error('verify-git-install: git clone 失败：\n' + cloned.out)
    process.exit(1)
  }
  check(!existsSync(join(clone, 'lib', 'index.js')), '克隆出来的仓库里居然有 lib/index.js —— 克隆的不是 tracked-only 状态')

  // 2. 临时 profile：与桌面 profile 同形（app-boot/src/profile.ts:184-189）。
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-git-verify', private: true, dependencies: {} }, null, 2), 'utf8')
  writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n', 'utf8')

  // 3. 装。规格用本地 file:// 克隆 —— 与 GitHub 走**同一条 pnpm 代码路径**。
  const spec = `git+file:///${clone.replace(/\\/gu, '/')}`
  let installed = run(pnpm.command, [...pnpm.args, 'add', spec, '--reporter', 'append-only'], profile)

  if (installed.code !== 0) {
    // 预期：pnpm 要求放行构建脚本。按宿主 build-approval.ts 的做法取它打印的键。
    //
    // 键的取法与宿主一致（build-approval.ts:15 的正则）：必须是 `allowBuilds:`
    // 那一行**下面**、以 `: true` 结尾的那一行。
    const key = GIT_DEP_PREPARE.exec(installed.out)?.[1]?.trim()
    check(key !== undefined, 'pnpm 安装失败，且没能从输出里解析出 allowBuilds 建议键：\n' + installed.out.slice(-2000))
    if (key !== undefined) {
      // 用 **YAML 文档 API** 写回 —— 与宿主 approveBuilds（build-approval.ts:94-95）
      // 同一个姿势。原因：键以 `@` 开头（scoped 包名 `@作者/插件名`）时是 YAML 的
      // 保留指示符，字符串拼接写出来的是**非法 YAML**（实测报
      // `bad indentation of a mapping entry`）。让 yaml 库自己决定要不要加引号。
      const policyPath = join(profile, 'pnpm-workspace.yaml')
      const document = parseDocument(readFileSync(policyPath, 'utf8'))
      document.setIn(['allowBuilds', key], true)
      writeFileSync(policyPath, String(document), 'utf8')
      installed = run(pnpm.command, [...pnpm.args, 'add', spec, '--reporter', 'append-only'], profile)
    }
  }
  check(installed.code === 0, 'pnpm add 失败：\n' + installed.out.slice(-2000))

  // 4. 装出来的东西必须齐。
  const pkgDir = join(profile, 'node_modules', manifest.name)
  check(existsSync(join(pkgDir, 'lib', 'index.js')), '装出来的包里没有 lib/index.js（Node 半侧）')
  check(existsSync(join(pkgDir, 'lib', 'client.js')), '装出来的包里没有 lib/client.js（浏览器半侧）⇒ Edge tab 会静默消失')
  for (const patchPath of patchPaths) {
    check(
      existsSync(join(pkgDir, patchPath.replace(/^\.\//u, ''))),
      `装出来的包里没有 bundle patch：${patchPath} ⇒ 宿主加载这一层会失败`,
    )
  }
  const installedManifest = existsSync(join(pkgDir, 'package.json'))
    ? JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
    : {}
  check(
    installedManifest.dsh?.bundle?.patch !== undefined,
    '装出来的包没有 dsh.bundle.patch ⇒ 宿主判 not-bundle',
  )
  check(
    !existsSync(join(pkgDir, 'config', 'edge.json')),
    '装出来的包里出现了 config/edge.json —— 明文密钥泄漏',
  )

  // 5. profile 必须记下这个依赖（宿主靠它认出装了什么）。
  const profileManifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  check(
    typeof profileManifest.dependencies?.[manifest.name] === 'string',
    'profile 的 dependencies 里没有记下本插件 ⇒ 宿主认不出装了什么（index.ts:960-968）',
  )
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error('verify-git-install --real: FAILED')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('verify-git-install --real: 端到端 OK（克隆 → pnpm add → payload 完整）')
