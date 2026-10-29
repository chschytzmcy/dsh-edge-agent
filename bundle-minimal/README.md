# bundle-minimal — §7.59 最小 bundle 实证载体

验证 `docs/deploy-minimal-files.md` 5 件套主张的可复现 rig。§7.59.5 起仓库只有
**一张派工单** `cordis.patch.yml`——名字即 `package.json` 的 `dsh.bundle.patch`
指针名,部署 = 逐字 cp 进嵌套包,零改名。rig 派工单只允许部署到 throwaway
profile(`edge-min-test` TUI 形状 / `edge-min-chat` headless 孪生),绝不进任何
生产 profile(web / dsh-tui)。2026-09-16 dsh-tui 生产曾短暂挂过本派工单的
逐字节副本做端到端验证,同日已换回全量正式 bundle(PROGRESS §7.59.7)。
整个目录不进 release tarball。

> §7.59.4(user 拍板「不用证伪,保存最新的 cordis 文件即可」):stage1 / stage1b
> 证伪阶梯退役;§7.59.5:stage2 与 stage2-ops 二合一为本文件。各轮 boot 签名
> (FAIL-LOUD pending 逐字行、active≠enforced 证据)存档于 `docs/PROGRESS.md`
> §7.59 实测段(单一存档点;`deploy-minimal-files.md` 只留最终结论)——
> 文件可删,实证不可删。

- `package.json` — 极简花名册(exports = **12 条** = 3 条资源(`.` / `./package.json` /
  `./cordis.patch.yml`)+ **9 条代码入口**(7 插件执法闭包 + `audit-log` + `file-logger`);
  `dsh.bundle.patch` 指针 = `"./cordis.patch.yml"`)
- `cordis.patch.yml` — **9 行**实装图(1 个 insert 段)= file-logger(居首)+ **audit-log**
  + 7 插件执法闭包 → 冒烟聊天实弹 BLOCK / REJECT。§7.59.1 全云不变量:
  localProvider 指宿主云 provider ⇒ `sanitizeLocalTraffic:true` +
  `downgradeOnSanitizeFailure:false`(LOCAL 轮也脱敏;脱敏失败 REJECT)。全量部署勿抄。
  ⚠️ headless 宿主不可逐字挂:file-logger `inject=['web']`,headless
  (dsh-base+dsh-headless)无 web service 会 boot FAIL-LOUD——rig deploy 时为
  headless 冒烟臂**运行时派生** 7 插件图(剥 file-logger 行块,派生物不落仓库)。
- `skill-realms.seed.json` — §7.59.3 realm 种子:部署第⑤步落
  `<root>/skill-realms.json`(派工单里 realm-skill-bridge.configPath 同路径)。
  缺表 ≠ 缺闸门:未点名工具 Layer 3 按 §7.47.1 **设计为 fail-open**(CLOUD agent 跑
  本地 bash 合法),技能则全隐;种子的实际语义 = web_search/web_fetch 锁 CLOUD →
  LOCAL/SANITIZED 轮网络工具被拒。刻意不照抄生产私有策略(ets-* 映射)。

驱动:`bash scripts/minimal-bundle-rig.sh all`(build 检查 → deploy(TP 逐字 /
CP 派生)→ 冒烟断言 B1-B4 → 反事实探针 P1-P5;`down` / `clean` 收尾;deploy 含
第⑤步 cp 种子)。CI 锁:`tests/unit/bundle-minimal.test.ts` 防本目录三文件与
产品面漂移。`lib/` 不入库——rig 部署时 rsync 仓库 `lib/`(即 architecture.md
手工步骤的逐字执行)。
