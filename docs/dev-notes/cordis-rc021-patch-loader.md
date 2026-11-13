# dev-notes · cordis 0.2.1-rc.2 patch loader 行为 + Edge tab 装载链路

> **状态**：✅ 3 件事都已在 v6 commit `773613f` + 后续 edit 落档 · **日期**：2026-10-20

## 摘要

在桌面 0.2.1-rc.2 跑通 Edge tab 这条路时，v3 → v4 → v5 → v6 共踩了 3 个不同的 patch loader bug。本文档把它们 + 诊断 + 修法全部独立留档，下次再踩不会再费时。

---

## Bug 1 · `inject:` 和 `config:` 字段在 0.2.1-rc.2 静默 skip

### 现象
cordis.desktop-safe.patch.yml 里 `- id: edge-context-view` 这行写了：
```yaml
inject: [auditLog]
config:
  bufferSize: !!js parseInt(process.env.DSH_EDGE_VIEW_BUFFER_SIZE ?? '64', 10)
```
桌面启动后 Edge tab 不出现；控制台 0 红错；cordis 静默 skip 这一行。

### 根因
cordis 0.2.1-rc.2 patch loader 不解析 `inject:` 和 `config:` 字段：
- `inject:` 是 0.2.2+ 引入的"硬注入"语法；rc.0.2.1 看到就 skip 这行而不是 throw
- `config:` 内置 `!!js process.env...` 这种 yaml tag 在 rc.0.2.1 没注册；skip

0.2.1-rc.2 实际接受的服务依赖模式是 plugin 内部 `ctx.inject(['xxx'], cb)` deferred——这才是 dsh-context 用的方式。

### 修法
完全删除 `inject:` 和 `config:` 字段；host plugin 内部用 `ctx.inject`。

```yaml
# BAD (v3 / v4):
- id: edge-context-view
  name: '@scope/pkg/sub/path'
  inject: [auditLog]
  config:
    bufferSize: !!js process.env.X ?? '64'

# GOOD (v6):
- id: edge-context-view
  name: '@scope/pkg'                    # ← 裸包名，跟 dsh-context `name: dsh-context` 同款
  # （无 inject）
  # （无 config）
```

并把 `.ts` 顶层改为（host plugin 内部 deferred inject）：
```ts
export async function apply(ctx, config) {
  // 读 process.env 在 plugin 自己内部，不走 cordis config 字段
  const bufferSize = parseInt(process.env.DSH_EDGE_VIEW_BUFFER_SIZE ?? '64', 10)
  ctx.inject(['connection'], (raw) => { /* 软依赖装载 */ })
}
```

---

## Bug 2 · `name: '@scope/pkg/sub/path'` 触发 `ERR_PACKAGE_PATH_NOT_EXPORTED`

### 现象
v5 patch row 用了这种 file-path 形态：
```yaml
- id: edge-context-view
  name: '@dsh-edge/dsh-edge-agent/lib/types/dsh-adapter/edge-context-view.js'
```

桌面启动直接 crash（Windows correlation id `7F082FCF-6162-4740-B46B-1BAA9AF23686`），错误信息：
```
dsh: warning: 1 entry did not activate edge-context-view (...edge-context-view.js):
failed to import: Error [ERR_PACKAGE_PATH_NOT_EXPORTED]:
Package subpath './lib/types/dsh-adapter/edge-context-view.js' is not defined by
"exports" in ... package.json
```

### 根因
`name:` 字段被 cordis 走 `require(specifier)`。当 specifier 是 `@scope/pkg/lib/...`：
- Node ESM 走 `package.json#exports` 解析
- `exports` 没有暴露 `./lib/types/...` 这种内嵌路径（暴露的是 `./types/...` 但**没有暴露 `./lib/types/...`**）
- Node 抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`
- cordis patch loader 不 catch 这个 → 整 desktop profile 启动失败

### 修法
v6 已 revert：
- `name` 改回裸包名：`'@dsh-edge/dsh-edge-agent'`
- 同时在 `src/dsh-adapter/index.ts` 加 `export * from './edge-context-view.js'`，让 main entry `lib/types/index.js` 暴露该 plugin
- cordis `require('@scope/pkg')` 走 main → main re-export 该 plugin → plugin 实装

### 历史教训
写 cordis patch row 时 `name:` 字段永远只用"包级 + 留 main 来 map"。**不要把 file-path tail 放到 name 字段**——这等价于"绕过 exports 但完全无 fallback"。

---

## Bug 3 · `package.json#exports` `./cordis.desktop-safe.patch.yml` 指向不存在的文件

### 现象
v3 时 installable package.json 写了：
```jsonc
"./cordis.desktop-safe.patch.yml": "./cordis.patch.yml"
```
但 installable 目录里只有 `cordis.desktop-safe.patch.yml`，**没有** `cordis.patch.yml`。

桌面 GUI 报的早期报错：
```
dsh: failed to read overlay .../cordis.patch.yml: ENOENT
```

### 修法
**两件事都要做**：
1. exports entry 指向真实文件：
   ```jsonc
   "./cordis.desktop-safe.patch.yml": "./cordis.desktop-safe.patch.yml"
   ```
2. installable 目录里**确保**该文件存在（cp 时不要漏）

### 预防
`scripts/verify-installable.mjs` 现在有一条显式 verify：`dsh.bundle.patch` 字段指向的 yaml 文件必须实际存在。这条 v3 时代已经写得对；但**只查 `dsh.bundle.patch`，没查 `exports["./cordis.*.patch.yml"]` 这类相邻 export entry**。

v3 这条 bug 之前没被截住，因为 `patch-surface` 没覆盖到 export entry 字段一致性。**值得**在 `scripts/verify-patch-surface.ts` 里追一条 export 字段与文件存在性交叉 verify（如再有精力的话）。

---

## 整体诊断 checklist — 桌面 Edge tab 装配

逐项过：

```bash
# 1. confirm installable dir 现状
ls dist/installable/dsh-edge-agent-desktop-safe/
# 期望：package.json + cordis.desktop-safe.patch.yml + lib/ + presets/
#     lib/ 必须含 client.js

# 2. patch row 形态（关键）
grep -A3 "edge-context-view" dist/installable/dsh-edge-agent-desktop-safe/cordis.desktop-safe.patch.yml
# 期望只含：id + name + (注释)，不要有 inject / config

# 3. package.json#dsh.client 仅 entry
grep -A4 '"client"' dist/installable/dsh-edge-agent-desktop-safe/package.json
# 期望：仅 entry 字段，不要有 inject / platform

# 4. main entry 必须 re-export edge-context-view
#    §7.222: main entry 的源码是 src/index.ts（→ lib/index.js）——
#    旧的 src/dsh-adapter/index.ts 是被 dsh-edge-agent.ts 取代的过期副本，已删。
grep "edge-context-view" src/index.ts lib/index.js
# 期望看到 export * from './edge-context-view.js'

# 5. verify installable
npm run verify:installable
# 期望：OK (2 bundles)

# 6. 桌面 GUI 重 Add + 重启
# 期望：tray 退，桌面起来，右栏 Edge tab 出现
```

---

## 历史 chain / commit 索引

- v4 plan `4f16ccc`: hook Edge tab 大图 + 4 panel + summary
- v4 实现 `ab999ce` / `9622965` / `515cd62` / `25127f8`: 端到端实现 + 文档对齐
- ADR 0008 `a8c7bfb`: 5 条架构裁决落档（A 审计源 / B POST route / C session event / D 注入 1 硬 / E SessionEventMap 封闭）
- verify-installable `f0f6392`: installable 完整性 checker
- v6 `773613f`: 修 Bug 1 + Bug 3 + main re-export bridge

---

## 桌面端 0.2.1-rc.2 patch row 模板

如未来还要给本仓库 / 别 DSH 插件写 patch row，最稳的形态：

```yaml
- id: <a-plugin-id>            # 全局唯一
  name: '<package-name>'        # 裸包名（NOT subpath）
  # no inject: (0.2.1-rc.2 不识别)
  # no config: (0.2.1-rc.2 不识别)
```

配套要求：
- `package.json#main` 入口 `lib/types/index.js` 必须 export plugin（hook 进 re-export 链）
- host plugin 用 `ctx.inject(['xxx'], cb)` deferred
- 不发新 cordis event type；不增新 audit kind；不增 SessionEvent kind

更详细的论证见 `docs/decisions/0008-edge-context-view.md` 5 条裁决 A-E。

---

## ⚠️ 勘误（2026-10-20 晚，asar 源码核验后）

上面"裸包名是唯一稳态形态"的结论**只对了一半**，且"配套要求"里的
`lib/types/index.js` 已过时（tsconfig outDir 已改 `lib`）。经解析桌面 App
`app.asar` 内 `@deepseek-ai/dsh-client-modules` 权威源码，修正如下：

1. **子路径 row 是合法形态**——v7 的 `ERR_PACKAGE_PATH_NOT_EXPORTED` 真因
   是 exports 指向不存在的旧布局文件，不是子路径本身。exports 与产物路径
   一致时，`name: '@scope/pkg/<sub>'` 正常 mount（本仓库 desktop-safe 的
   16 行子路径 row 全部激活成功，插件管理页可证）。
2. **裸包名 row 有独立且必要的用途**：webview client bundle 的发现挂在
   loader entry NAME 上（`locatePkgJson` → `exactPackageSpecifier` 只接受
   bare package-root specifier）。想要浏览器半生效，patch 里必须有一条
   `- name: '<package-name>'` 裸名 row；子路径 row 再多也不会触发 client
   扫描。dsh-context 的"单条裸名 row"正是这个原因。
3. **client 三重契约**（缺一即静默失败，宿主仅在 composition throw 时报警）：
   - manifest `dsh.client.platform === "web"`（缺失→ resolveMeta return null）
   - `exports["./client"]` 字符串指向落盘存在的 bundle
   - bundle 自注册 `window.__ModuleLoader__.load({ id: <pkgName>, factory })`
     （纯 ESM 导出 name/apply 无效——webview 按 classic script 执行）
4. webview seed 词表无 preact，slot 组件必须返回 React element
   （require('react') / 'react/jsx-runtime' / 'react-dom/client'）。
5. cordis Proxy ctx：undeclared service 的属性读/写一律 throw
   （`cannot get property "x" without inject` / `...without provide`），
   apply() 内可选服务访问必须 defer(ctx.inject)/typeof-guard/try-catch。

完整五层根因链 + 当前未闭环状态见 `docs/PROGRESS.md` §7.101.x。
