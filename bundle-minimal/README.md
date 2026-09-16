# bundle-minimal — §7.59 最小 bundle 实证载体

验证 `docs/deploy-minimal-files.md` 5 件套主张的可复现 rig。rig 三阶段阶梯
(stage1/1b/2)**只允许部署到 throwaway profile**(`edge-min-test` TUI 形状 /
`edge-min-chat` headless 孪生),绝不进 web / dsh-tui 生产 profile;唯一的例外是
`cordis.stage2-ops.yml`——它是给真实 TUI 形状 profile 用的实装派工单(2026-09-16
起 dsh-tui 生产即挂此变体)。整个目录不进 release tarball。

- `package.json` — 极简花名册(exports = 7 插件闭包,`dsh.bundle.patch` 指针)
- `cordis.stage1.yml` — 只点 prompt-guard + privacy-policy → 实证「mount ≠ active」(boot fail-loud pending)
- `cordis.stage1b.yml` — +audit-log → 实证「active ≠ enforced」(全 ACTIVE 但聊天零闸门事件,caller input-guard 不在场)
- `cordis.stage2.yml` — 7 插件闭包 → 冒烟聊天实弹 BLOCK / REJECT。
  §7.59.1 全云不变量:localProvider 指宿主云 provider ⇒ `sanitizeLocalTraffic:true`
  + `downgradeOnSanitizeFailure:false`(LOCAL 轮也脱敏;脱敏失败 REJECT)。全量部署勿抄。
- `cordis.stage2-ops.yml` — 实装变体:stage2 + file-logger(居首)→ 运维日志落
  `<root>/log/dsh-edge-agent.log`。**仅 TUI/web 宿主可用**:file-logger
  `inject=['web']`,headless 无 web service 会 boot FAIL-LOUD,故 rig 阶梯仍走 7 插件版,
  本文件供真实 dsh-tui/web profile 部署时替换 stage2 用。手工部署时它是**第⑤步的
  前提**:派工单点了 realm-skill-bridge 还须落数据面 `skill-realms.json`(见下)。
- `skill-realms.seed.json` — §7.59.3 realm 种子:部署第⑤步落
  `<root>/skill-realms.json`(stage 派工单里 realm-skill-bridge.configPath 同路径)。
  缺表 ≠ 缺闸门:未点名工具 Layer 3 按 §7.47.1 **设计为 fail-open**(CLOUD agent 跑
  本地 bash 合法),技能则全隐;种子的实际语义 = web_search/web_fetch 锁 CLOUD →
  LOCAL/SANITIZED 轮网络工具被拒。刻意不照抄生产私有策略(ets-* 映射)。

驱动:`bash scripts/minimal-bundle-rig.sh all`(build → 三阶段断言 → 反事实探针;
`down` / `clean` 收尾;deploy 现在含第⑤步 cp 种子)。CI 锁:
`tests/unit/bundle-minimal.test.ts` 防本目录 6 文件漂移。
`lib/` 不入库——rig 部署时 rsync 仓库 `lib/`(即 architecture.md 手工步骤的逐字执行,
第⑤步 realm 种子同步由 deploy 落)。
