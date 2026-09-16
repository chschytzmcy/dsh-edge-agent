# bundle-minimal — §7.59 最小 bundle 实证载体

验证 `docs/deploy-minimal-files.md` 5 件套主张的可复现 rig,**只允许部署到
throwaway profile(`edge-min-test` TUI 形状 / `edge-min-chat` headless 孪生)**,
绝不进 web / dsh-tui 生产 profile,也不进 release tarball。

- `package.json` — 极简花名册(exports = 7 插件闭包,`dsh.bundle.patch` 指针)
- `cordis.stage1.yml` — 只点 prompt-guard + privacy-policy → 实证「mount ≠ active」(boot fail-loud pending)
- `cordis.stage1b.yml` — +audit-log → 实证「active ≠ enforced」(全 ACTIVE 但聊天零闸门事件,caller input-guard 不在场)
- `cordis.stage2.yml` — 7 插件闭包 → 冒烟聊天实弹 BLOCK / REJECT

驱动:`bash scripts/minimal-bundle-rig.sh all`(build → 三阶段断言 → 反事实探针;
`down` / `clean` 收尾)。CI 锁:`tests/unit/bundle-minimal.test.ts` 防本目录 4 文件漂移。
`lib/` 不入库——rig 部署时 rsync 仓库 `lib/`(即 architecture.md 手工四步的逐字执行)。
