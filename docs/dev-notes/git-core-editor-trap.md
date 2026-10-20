# dev-notes · git `core.editor` 在本仓环境的陷阱

> **状态**：✅ 已 workaround · **日期**：2026-10-20 · **trigger**：提交 ADR 0008 (`a8c7bfb`) 时第一次踩到。

## 现象

在仓库内 `git commit -m "..."`（带 `-m`）**偶发** 出错：

```
fatal: C:/Program Files/Git/: 'C:/Program Files/Git/' is outside repository at 'C:/Users/cheng/GolandProjects/gitlab/dsh-edge-agent'
```

- `-m` 给出 message，本不该打开编辑器；却报错
- 错误信息指向 `C:/Program Files/Git/`（Git for Windows 安装目录）作为"editor"
- 同一条 commit 改成 `git -c core.editor=true commit ...` 就过

## 根因

shell 进程里 `GIT_EDITOR=true` 这条变量被注入了（来源未知：不在 `.bashrc` / profile / `env`），导致：

1. `git var GIT_EDITOR` 返回字面量 `true`
2. Git 内部判定：**用户给的 editor 不为空** → 不走 fallback
3. **但** `true` 不是真实可执行路径；fallback 时又错用了 `C:/Program Files/Git/`
4. 触发链在带 `-m` 时本应短路，但 Windows 端 git 的实现偶发不短路

诊断命令：

```bash
echo "GIT_EDITOR=[$GIT_EDITOR]"    # 看见 true 就是这坑
git var GIT_EDITOR                  # 应空才正常
git config -l --show-origin | grep core.editor  # 看看 git config 有没有被污染
```

## 当前 workaround（推荐）

每条 commit 命令前显式给 core.editor：

```bash
git -c core.editor=true commit -m "..."
```

或干脆写一个 alias 进 shell：

```bash
alias gcm='git -c core.editor=true commit'
```

## 永久修（待 windows shell rc 清理）

理论上应当 `unset GIT_EDITOR` 即可——但这变量不在用户级 rc 文件（`.bashrc` / `.bash_profile`）里。在哪设的还要查：

| 候选位置 | 验证 |
|---|---|
| `C:\Program Files\Git\etc\profile` 或 `etc\bash.bashrc` | 已 `head` 排除；如再遇到应再查 |
| Windows 系统级环境变量 | `Get-ChildItem Env:GIT_EDITOR` 在 powershell 里查 |
| Claude Code harness 注入 | 同 session 内可见；跨 session 重启后是否还在看 |
| `~/.gitconfig` `[core] editor = ""` 空值 | 触发 fallback 路径不同 |

如果定位到是 harness 注入：开 ADR 那就过；但当前 workaround 已经能稳定 commit——后续只在还遇到时才升级为永久 fix。

## 关联 commit

- `a8c7bfb docs(adr): 0008 Edge tab 5 条核心架构裁决独立落档`——首次踩坑时
  用 `git -c core.editor=true commit --amend -m "..."` 救回
