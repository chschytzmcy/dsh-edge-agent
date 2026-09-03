---
name: deploy-dsh-edge-agent
version: 0.1.0
description: "dsh-edge-agent 部署 / 重启 / 状态查询 / 跟日志。触发关键词：deploy、部署、本地、远端、install、重启、restart、status、跟日志、查状态"
metadata:
  requires:
    bins: ["bash", "ssh", "curl", "ps", "tar"]
  cliHelp: "./install.sh --help  &&  ./deploy.sh"
---

# deploy-dsh-edge-agent

把本地 `src/`、`profiles/`、`cordis.patch.yml` 的改动同步到
**DSH 真正加载的位置**（`~/.dsh/profiles/<name>/node_modules/@deepseek-harness-edge-agent/dsh-edge-agent/`），
再重启对应的 `dsh` 进程。本 skill 覆盖三层部署路径。

## 工作流索引

| 场景 | 命令 | 耗时 | 备注 |
|------|------|------|------|
| **本地增量改完** | `./install.sh --skip-pnpm` | 5-10s | 90% 时间用这个 |
| 本地首次 / 加新依赖 | `./install.sh` | 30-60s | 首次或改了 package.json |
| 强制重装本包 | `./install.sh --force-install` | 30-60s | 嵌套包坏了 |
| 装到其他 profile | `./install.sh --to-profile web` | 30-60s | bundle 模式（2026-09-02 起）|
| 远端部署 | `./deploy.sh <user@host> [port]` | 1-3 min | 7 步流水线 |
| 仅编译+重启 | `./scripts/dev-restart.sh` | 5-10s | 等价于 `--skip-pnpm` |
| 查状态 | `ps` + `curl :21017/v1/health` | <1s |  |
| 跟日志 | `tail -f ~/.dsh-edge-agent/log/...` | 长跑 | ops log + audit log 分开 |

---

## 1. 本地增量改完（最常用）

每次改完 `src/*` 或 `profiles/*` 跑一次，**5-10 秒**生效：

```bash
cd /home/etsme/cy/agent/dsh-edge-agent
./install.sh --skip-pnpm
```

内部流程（看 `install.sh`）：

1. `npm run compile` — TS → JS（产出 `lib/`）
2. **跳过** `dsh plugin add`（嵌套包已存在；如需强制重装加 `--force-install`）
3. `rsync -a --delete lib/ → ~/.dsh/profiles/dsh-edge-agent/node_modules/@deepseek-harness-edge-agent/dsh-edge-agent/lib/`
4. **§3.5（2026-09-03 新加）**：`diff` 同步 repo 根 `cordis.patch.yml` → 嵌套包 `cordis.patch.yml`（**bundle-level patch**）
5. **§3.6（2026-09-03 新加）**：python3 JSON 编辑 profile `package.json`，确保 `dsh.profile.bundles` 含 `@deepseek-harness-edge-agent/dsh-edge-agent`（手动 profile 没自动加；`dsh plugin add` 因 npm 404 静默失败）
6. `diff` 同步 profile `cordis.patch.yml` / `privacy-policy.json` / `agent-presets/`
7. `kill PID → nohup bash -c "source .env.sh && dsh --profile dsh-edge-agent"`

**验证（必跑，不要跳过）**：

```bash
# 1. http-api listen :21017？
curl -s --max-time 5 http://127.0.0.1:21017/v1/health
# 期望：{"status":"ok", ...}

# 2. 19 个 plugin 全部注册？看 audit log 最近 http.started 之前的前置事件
tail -10 ~/.dsh-edge-agent/audit/audit.plain.jsonl \
  | jq -c 'select(.kind | test("started|registered|loaded"))'
# 期望：policy.signing.disabled → input-guard.hook.registered (×3) → http.started

# 3. file-logger 接管 stdout？ops log 是否带 ISO + 时区 offset？
tail -3 ~/.dsh-edge-agent/log/dsh-edge-agent.log
# 期望：2026-09-03T10:29:50.674+08:00 DEBUG ...
```

**如果验证 fail**：
- `curl` 超时 / 连接被拒：跳 §7 排查表
- audit 没有 `input-guard.hook.registered`：bundle patch 没 sync（§3.5 漏了）；跑 `diff $REPO_ROOT/cordis.patch.yml $NESTED_PKG/cordis.patch.yml`，不一致就 `cp` 一次
- ops log 只有 env.sh 输出（13 行）但 file-logger 没接管：bundle 没注册；跑 `dsh --dump-config --profile dsh-edge-agent | grep file-logger`，不存在说明 bundle 没进 `dsh.profile.bundles`，手动编辑 profile `package.json` 加 `@deepseek-harness-edge-agent/dsh-edge-agent`

**关键点**：DSH **不会**从 `$REPO_ROOT/lib/` 加载，它从 `~/.dsh/profiles/<name>/node_modules/.../lib/` 加载。
所以 `rsync` 那一步是必需的（`deploy.sh:148-152` 注释解释过这个坑）。

如果只是改 `.env.sh` / `.env` / privacy policy 但代码没动：
```bash
pkill -f 'node.*dsh --profile dsh-edge-agent'
source .env.sh
nohup dsh --profile dsh-edge-agent > ~/.dsh-edge-agent/log/dsh-edge-agent.log 2>&1 &
```

---

## 2. 本地首次 / 加新依赖

嵌套包不存在或改了 `package.json`：

```bash
./install.sh                # 默认 profile = dsh-edge-agent
```

会额外跑：
- `dsh plugin add @deepseek-harness-edge-agent/dsh-edge-agent`
- `dsh plugin add @deepseek-ai/dsh-agent-loop`
- 7 个上游包（`dsh-tool-web` / `dsh-web` / `dsh-web-search-deepseek` /
  `dsh-skill` / `dsh-tool-skill` / `dsh-skill-filesystem`）
  → 缺任何一个 LLM 工具链就坏

加新 npm dep 后必须 `pnpm install`（`--skip-pnpm` 会漏）：

```bash
# 装新依赖
pnpm add some-package
# 然后跑完整 install（会跑 pnpm + 重装嵌套包）
./install.sh
```

---

## 3. 装到其他 profile（bundle 模式）

2026-09-02 起 `dsh-edge-agent` 作为 bundle 可装到任何 profile：

```bash
./install.sh --to-profile web          # 装到 web profile
DSH_EDGE_PROFILE=my-edge ./install.sh  # 装到自定义 profile
```

bundle 模式不拉 webui（webui 由目标 profile 自己管）。

---

## 4. 远端部署

```bash
./deploy.sh rockchip@192.168.1.121         # 默认 22 端口
./deploy.sh root@192.168.1.100 2222        # 自定义端口
```

**7 步流水线**（`deploy.sh`）：

1. 测试 SSH
2. 远端装 Node 22 / pnpm / dsh CLI（如缺）
3. 本地 `make package` 打 `dsh-edge-agent-deploy.tar.gz`
4. `scp` 到 `/tmp/`
5. 远端解压到 `/home/rockchip/dsh-edge-agent` + `pnpm install --ignore-scripts`
6. 远端 `dsh plugin add` 初始化 profile + `rsync` lib/ 到嵌套包 + 同步 `cordis.patch.yml` / `.env` / `privacy-policy.json` + 装 7 个上游包
7. `pkill` 旧进程 → `setsid` 启新 → 验 `:21017/v1/health`

打包**不**包含 `.env`、`.env.local`、`node_modules`、`*.log`（看 `Makefile:55-80`）。**远程第一次部署**需要手动把 `.env` scp 过去：

```bash
scp -P 22 .env rockchip@192.168.1.121:/home/rockchip/dsh-edge-agent/.env
```

---

## 5. 查状态

```bash
# DSH 进程在跑？
ps -eo pid,cmd | grep 'node.*dsh --profile dsh-edge-agent' | grep -v grep

# http-api 通了？
curl -s http://127.0.0.1:21017/v1/health | jq .
# 期望：{"status":"ok", ...}

# 当前 profile / log 路径
echo "profile=$DSH_EDGE_PROFILE  log=$HOME/.dsh-edge-agent/log/dsh-edge-agent.log"
```

如果 `:21017` 不通但进程在跑：等 3-5 秒（intentRouter / sanitizer 在做 lazy init），再查 audit log。

---

## 6. 跟日志

**ops log**（人读，本地时区 ISO 8601 + offset）：

```bash
tail -f ~/.dsh-edge-agent/log/dsh-edge-agent.log
```

格式：`2026-09-03T09:47:55.006+08:00 INFO [http-api] ...`

**audit log**（机读，JSONL，epoch ms）：

```bash
# 实时看 input-guard 事件
tail -F ~/.dsh-edge-agent/audit/audit.plain.jsonl \
  | jq 'select(.kind | startswith("input-guard"))'

# 按级别过滤
jq 'select(.level=="security")' ~/.dsh-edge-agent/audit/audit.plain.jsonl

# 本地时间显示
TZ=Asia/Shanghai jq '.ts | ./1000 | todate' ~/.dsh-edge-agent/audit/audit.plain.jsonl
```

注意：audit log 用 epoch ms（schema 不破坏 jq/datadog）；`jq todate` 默认输出 UTC `Z`。
人类读的 ops log 已修过（见 `PROGRESS §7.30`，2026-09-03）。

---

---

## 7. 常见问题

| 现象 | 原因 | 处理 |
|------|------|------|
| `./install.sh --skip-pnpm` 后代码没生效 | 嵌套包被 npm 装的新版覆盖 | `./install.sh --force-install` |
| `dsh` 启动报 `no agent factory registered` | 缺 `@deepseek-ai/dsh-agent-loop` | `./install.sh`（不带 `--skip-pnpm`）|
| `:21017` 不通但有进程 | http-api 启动慢（intent/sanitizer lazy init） | 等 5s + `tail log` |
| 远端部署后 `pkill` 杀不掉 | `setsid` 起的后台进程未收回 | 远端 `ps aux \| grep dsh \| awk` 显式 kill |
| audit 0 个 `input-guard.*` 事件 | input-guard hook 没注册 | 见下方 case A |
| **dsh 进程 alive 但 `:21017` 不 listen，ops log 只 13 行 env.sh，audit 不增** | **bundle patch 没 sync 到嵌套包 / bundle 没进 `dsh.profile.bundles`**（19 个 dsh-edge-agent plugin 全未注册） | 见下方 case B |

### Case A：audit 0 个 `input-guard.*` 事件

`input-guard.routed` 事件没出现 → pre-step hook 没注册：

```bash
# 1. dump-config 看 plugin 是否在 manifest 里
dsh --dump-config --profile dsh-edge-agent | grep -E 'input-guard|file-logger|http-api'
# 期望：3 行命中（plugin 在 manifest）

# 2. 如果有，hook 仍没跑 → 看 audit-log plugin 是否先成功
tail -30 ~/.dsh-edge-agent/audit/audit.plain.jsonl | jq -c 'select(.kind | test("started|registered|loaded"))' | head -5
# 期望：policy.signing.disabled → input-guard.hook.registered → http.started

# 3. 如果 dump-config 没有 input-guard → 跳 case B
```

### Case B（2026-09-03 发现，最隐蔽）：dsh 启动后 plugin 全没注册

**症状**（4 个全中才能确认）：

1. `dsh` node process alive 30+ 秒，状态 `Sl` ep_poll（event loop idle）
2. `ss -ltn | grep 21017` 为空（端口不 listen）
3. `~/.dsh-edge-agent/log/dsh-edge-agent.log` 只 13 行 env.sh 输出（file-logger 没接管 stdout）
4. `~/.dsh-edge-agent/audit/audit.plain.jsonl` 不增新事件（audit-log 没启动）

**根因**：dsh 启动只加载 `dsh-base` 的 30 个 plugin。dsh-edge-agent 的 19 个 plugin（包括 file-logger / http-api / input-guard）**全部未注册**，因为它们的 manifest 在 `cordis.patch.yml`（bundle-level patch）里，bundle 必须满足两个条件才会被加载：

1. **嵌套包根 `cordis.patch.yml` 存在**（bundle manifest 在嵌套包根，文件路径在嵌套包 `package.json` 的 `dsh.bundle.patch` 字段）
2. **`~/.dsh/profiles/<name>/package.json` 的 `dsh.profile.bundles` 包含本 bundle 名**（profile manifest 的 bundles 列表）

`install.sh`（**修复前**）只同步 `profiles/$PROFILE/cordis.patch.yml` 到 `$PROFILE_DIR/cordis.patch.yml`（profile overlay 层），**从来没同步** repo 根 `cordis.patch.yml` 到嵌套包。手动创建的 profile（不在 `PROFILE_TEMPLATES` 里）的 `bundles` 列表只初始有 `[@deepseek-ai/dsh-base]`，`dsh plugin add` 因本包不在 npm registry 报 404 静默失败 → bundles 永远不增。

**修复**（`install.sh` §3.5 + §3.6，2026-09-03 加）：

```bash
# §3.5：sync repo 根 patch → 嵌套包
diff -q "$REPO_ROOT/cordis.patch.yml" "$NESTED_PKG/cordis.patch.yml" || \
  cp "$REPO_ROOT/cordis.patch.yml" "$NESTED_PKG/cordis.patch.yml"

# §3.6：python3 JSON 编辑 profile package.json，确保 bundle 在列表里
python3 - ...  # 见 install.sh
```

**如果还在 fail，手动恢复**：

```bash
# 1. 确认嵌套包 cordis.patch.yml 存在
ls -la ~/.dsh/profiles/dsh-edge-agent/node_modules/@deepseek-harness-edge-agent/dsh-edge-agent/cordis.patch.yml

# 不存在就 cp 一次：
cp /home/etsme/cy/agent/dsh-edge-agent/cordis.patch.yml \
   ~/.dsh/profiles/dsh-edge-agent/node_modules/@deepseek-harness-edge-agent/dsh-edge-agent/cordis.patch.yml

# 2. 确认 profile bundles 列表包含本包
cat ~/.dsh/profiles/dsh-edge-agent/package.json | python3 -c "
import json, sys
d = json.load(sys.stdin)
bundles = d['dsh']['profile']['bundles']
target = '@deepseek-harness-edge-agent/dsh-edge-agent'
print('OK' if target in bundles else f'MISSING {target!r}; current: {bundles}')
"

# 3. 不在的话手动加
python3 -c "
import json
p = '/home/etsme/.dsh/profiles/dsh-edge-agent/package.json'
with open(p) as f: d = json.load(f)
target = '@deepseek-harness-edge-agent/dsh-edge-agent'
bundles = d['dsh']['profile']['bundles']
if target not in bundles:
    bundles.append(target)
    deps = d.setdefault('dependencies', {})
    deps[target] = 'file:./node_modules/@deepseek-harness-edge-agent/dsh-edge-agent'
    with open(p, 'w') as f: json.dump(d, f, indent=2)
    print('added')
else:
    print('already there')
"

# 4. 重启
./install.sh --skip-pnpm

# 5. 验证
dsh --dump-config --profile dsh-edge-agent | grep -E 'input-guard|file-logger|http-api' | wc -l
# 期望：3
```

- `.env` 含 `DEEPSEEK_API_KEY`、`EDGE_API_KEY`、`DSH_AUTH_TOKEN` 等敏感字段，**严禁** commit。
  `.gitignore` 已覆盖。
- 远端部署**不打包** `.env`（`Makefile` 的 `package` 步骤用 `test -f .env && cp` 但 deploy.sh 也不传）。
- 测试 fixture / scratch 文件必须用占位号（`13800000000` / `192.0.2.1` / `00:00:00:00:00:00`），
  **禁止**写真实手机号 / MAC / IP。`.gitignore` 已覆盖 `mac_address.txt` / `phone.txt` /
  `answer.txt` / `final_answer.txt` 等，但**不要依赖** gitignore 防泄漏，源头就要用占位。
- 远程 SSH 首次连接会触发 host key 指纹确认。deploy.sh 默认 `StrictHostKeyChecking=no`，
  已知风险：MITM 可植入恶意跳板。生产部署建议改为 `StrictHostKeyChecking=yes` + `known_hosts`
  预填充。

---

## 9. 不在本 skill 范围

- **CI 流水线**：见 `.github/workflows/`（如有）。本 skill 是开发本地循环。
- **rollback**：没有自动回滚。手工 `git checkout <last-good-tag> && ./install.sh --skip-pnpm`。
- **跨 profile 迁移 data**：6 个 channel（log / audit / storage / sessions / skill-realms /
  tcm）落在 `~/.dsh-edge-agent/<channel>`，跟 `~/.dsh/` 完全独立。`install.sh` 不迁移这些。
  如果 profile 换了，**user-level 数据不动**（按 `dsh-edge-agent-data-path.md` 决策）。
- **kill 残留 / OOM**：本 skill 不处理。`pkill -9` 后手动 `rm /tmp/dsh-*.sock`。

---

## 10. 起 web profile（完整版：webui + dsh-im + dsh-edge-agent bundle）

### 术语对齐（重要）

| 概念 | 是什么 | 例子 |
|---|---|---|
| **profile 容器** | `~/.dsh/profiles/<name>/` 目录（运行环境，自带 package.json + cordis.yml + bundles 列表） | `~/.dsh/profiles/dsh-edge-agent/`、`~/.dsh/profiles/web/` |
| **bundle 组件** | npm 包，写进 profile 的 `dsh.profile.bundles` 列表 | `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`@linxin666/dsh-web-ui-all`、`@xmanrui/dsh-im`、`@deepseek-harness-edge-agent/dsh-edge-agent` |

**`dsh-edge-agent` 是 bundle，不是 profile**。跟 `@xmanrui/dsh-im`、`@linxin666/dsh-web-ui-all` 同级 — 都是装到 profile 里的组件。

本仓库 install.sh:78 默认 `PROFILE=dsh-edge-agent` — 容器名跟 bundle 名撞车纯属历史包袱，容器里装的 bundles = `[dsh-base, dsh-edge-agent]`，headless（只有自研 http-api :21017，没有 webui）。

### 本地两个 profile 的边界

| 容器 | bundles | listen | 用途 |
|---|---|---|---|
| `~/.dsh/profiles/dsh-edge-agent/` | dsh-base + dsh-edge-agent | `:21017` 自研 http-api | **headless**，程序 / curl 调用，无 webui |
| `~/.dsh/profiles/web/` | dsh-base + dsh-web-app + dsh-web-ui-all + dsh-im + dsh-edge-agent | `:21018` 自研 http-api (dsh-edge-agent bundle) + `:3080` dsh-web-app + webui | **完整版**，浏览器 + 程序都能调用 |

**两个 profile 可同时跑**，互不依赖。

### 启动 web profile（webui + dsh-im）

`~/.dsh/profiles/web/` 已经装好、bundles 注册齐，只缺进程：

```bash
# 1. 确认 web profile 没在跑
ps -eo cmd | grep 'dsh --profile web' | grep -v grep || echo "OK: web profile not running"

# 2. ⚠️ 如果 headless profile (`dsh-edge-agent`) 也跑着，必须先 source .env.sh
#    （避免 web bundle http-api 撞 headless :21017；详见下一节「⚠️ 双 profile 同时跑」）
#    如果只跑 web profile，可省略 source 这步
cd ~/.dsh/profiles/web
if [ -f .env.sh ]; then
  setsid nohup bash -c 'source .env.sh && exec dsh --profile web' > run.log 2>&1 < /dev/null &
else
  setsid nohup dsh --profile web > run.log 2>&1 < /dev/null &
fi
disown

# 3. 等 5s（webui 第一次加载慢，30s 都可能）+ 验证
sleep 5
curl -s --max-time 5 http://127.0.0.1:3080/ | head -20
# 期望：HTML（webui 页面）

# 4. 看 run.log 启动行
cat ~/.dsh/profiles/web/run.log
# 期望：dsh web: http://127.0.0.1:3080
```

### ⚠️ 双 profile 同时跑：dsh-edge-agent bundle 资源冲突

`dsh-edge-agent` bundle 默认绑 `:21017`（自研 http-api）+ 6 个 channel 路径落 `~/.dsh-edge-agent/`（**单 bundle root**）+ 依赖 secrets（`DEEPSEEK_API_KEY` / `EDGE_API_KEY` 等）。两个 profile 同时跑 dsh-edge-agent bundle 会：

1. **端口冲突**：bundle http-api 默认 `:21017`，headless profile 已占 → web profile 启动直接 EADDRINUSE 崩溃
2. **路径覆盖**：6 个 channel 写同一个目录 → log/audit 互相覆盖
3. **Secrets 缺失**（最隐蔽）：web profile 进程**不会**自动 source repo 根 `.env`（DEEPSEEK_API_KEY / EDGE_API_KEY 都在那里）。headless profile 走 install.sh 第 7 步 `source .env.sh && exec dsh` 自动拿到；web profile 是手动 setsid 启的，绕过 → CLOUD-route 请求报 `llm.cloud.missing_key`，UI 静默 401 / token error

**解决**：web profile 启动前显式 export 端口 + 各 channel env + **source repo `.env`**：

```bash
# 写在 ~/.dsh/profiles/web/.env.sh 一次性
cat > ~/.dsh/profiles/web/.env.sh <<'EOF'
export DSH_EDGE_HTTP_PORT=21018  # headless 占 :21017；bundle http-api 走 :21018
export DSH_EDGE_LOG_ROOT=/home/etsme/.dsh-edge-agent-web/log
export DSH_EDGE_AUDIT_ROOT=/home/etsme/.dsh-edge-agent-web/audit
export DSH_EDGE_STORAGE_ROOT=/home/etsme/.dsh-edge-agent-web/storage
export DSH_EDGE_SESSIONS_ROOT=/home/etsme/.dsh-edge-agent-web/sessions
export DSH_EDGE_SKILL_ROOT=/home/etsme/.dsh-edge-agent-web/skill-realms
export DSH_EDGE_TCM_ROOT=/home/etsme/.dsh-edge-agent-web/tcm

# Source repo-level .env（DEEPSEEK_API_KEY / EDGE_API_KEY）。headless 走
# install.sh 第 7 步自动 source，web profile 手动启必须显式 source，否则
# CLOUD-route 报 llm.cloud.missing_key。如果 repo 搬家，改 $REPO 路径。
REPO="$HOME/cy/agent/dsh-edge-agent"
if [ -f "$REPO/.env" ]; then
  set -a
  source "$REPO/.env"
  set +a
fi
EOF

# 启动时 source
cd ~/.dsh/profiles/web
setsid nohup bash -c 'source .env.sh && exec dsh --profile web' \
  > run.log 2>&1 < /dev/null &
disown
```

或者 inline：

```bash
cd ~/.dsh/profiles/web
DSH_EDGE_HTTP_PORT=21018 \
DSH_EDGE_LOG_ROOT=/home/etsme/.dsh-edge-agent-web/log \
DSH_EDGE_AUDIT_ROOT=/home/etsme/.dsh-edge-agent-web/audit \
DSH_EDGE_STORAGE_ROOT=/home/etsme/.dsh-edge-agent-web/storage \
DSH_EDGE_SESSIONS_ROOT=/home/etsme/.dsh-edge-agent-web/sessions \
DSH_EDGE_SKILL_ROOT=/home/etsme/.dsh-edge-agent-web/skill-realms \
DSH_EDGE_TCM_ROOT=/home/etsme/.dsh-edge-agent-web/tcm \
setsid nohup bash -c 'source /home/etsme/cy/agent/dsh-edge-agent/.env && exec dsh --profile web' \
  > run.log 2>&1 < /dev/null &
disown
```

**两个 profile 的资源分布**：

| profile | bundle http-api | 6 channel 根 | secrets | audit log 命令 |
|---|---|---|---|---|
| `dsh-edge-agent` | `:21017`（默认） | `/home/etsme/.dsh-edge-agent/<channel>`（默认） | repo `.env`（install.sh 第 7 步自动 source） | `tail -f ~/.dsh-edge-agent/audit/audit.plain.jsonl` |
| `web` | `:21018`（DSH_EDGE_HTTP_PORT override） | `/home/etsme/.dsh-edge-agent-web/<channel>`（6 个 env override） | repo `.env`（`.env.sh` 显式 source，**必须**） | `tail -f ~/.dsh-edge-agent-web/audit/audit.plain.jsonl` |

### 验证（必跑）

```bash
# 1. 双 profile 同时 listen？
ss -ltn | grep -E ':(21017|21018|3080)'
# 期望：三行（headless http-api :21017 + web bundle http-api :21018 + webui :3080）

# 2. dsh node 进程两个？
ps -eo pid,etime,cmd | grep -E 'dsh --profile (dsh-edge-agent|web)' | grep -v grep
# 期望：两行（两个 PID）

# 3. web profile audit 写到独立目录？
ls /home/etsme/.dsh-edge-agent-web/audit/audit.plain.jsonl 2>/dev/null \
  && echo "OK: web profile isolated audit log"

# 4. headless profile audit 还在原路径？
ls ~/.dsh-edge-agent/audit/audit.plain.jsonl && echo "OK: headless audit unaffected"

# 5. webui 真能访问？
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3080/
# 期望：200

# 6. web profile 的 bundle http-api 也通？
curl -s --max-time 5 http://127.0.0.1:21018/v1/health
# 期望：{"status":"ok"}
```

### 停 web profile

```bash
pkill -f 'node.*dsh --profile web'
# 端口释放？
ss -ltn | grep ':3080' && echo "WARN: still listening" || echo "OK: port freed"
```

### 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| **web profile 启动直接 EADDRINUSE `:21017` crash** | **web profile 的 dsh-edge-agent bundle http-api 默认 `:21017`，跟 headless profile 撞** | 在 `~/.dsh/profiles/web/.env.sh` 加 `export DSH_EDGE_HTTP_PORT=21018`，重启 |
| **web UI 能开但发请求报 token error / audit 出 `llm.cloud.missing_key`** | **web profile 进程没 source repo `.env`，DEEPSEEK_API_KEY 缺失；CLOUD-route 静默拒绝** | 在 `~/.dsh/profiles/web/.env.sh` 加 source repo `.env` 块（见上节），`pkill -f 'dsh --profile web'` + 重启 |
| `:3080` 30s 还没起来 | webui 首次加载 linxin666/dsh-web-ui-all 一坨包，慢 | 等 30-60s，tail run.log 看 `[dsh-web-app]` 启动行 |
| `no agent factory registered` | 缺 `@deepseek-ai/dsh-agent-loop` 包 | `./install.sh --to-profile web` 重装 |
| katex CSS / node-pty 报错 | §7.20 blocker | 已降级到 web profile bundle 模式（不主动拉 webui），重启就行 |
| 端口被占 | 之前 dsh-web 没杀干净 | `ss -ltnp \| grep 3080` 看 PID，kill 后重启 |
| web profile audit 写到 `~/.dsh-edge-agent/`（跟 headless 覆盖） | 没设 DSH_EDGE_AUDIT_ROOT | 按上面 env 切到独立路径，重启 |

### 不在本节范围

- **第一次创建 web profile**（`~/.dsh/profiles/web/` 还没建）：`./install.sh --to-profile web` 跑 §3，会同步 bundle patch + 注册 bundles + rsync lib/。装好再走本节「启动 web profile」。
- **dsh-web-ui 主题 / 皮肤切换**：看 linxin666 上游文档，本 skill 不管。
- **dsh-im 长连接 / 消息持久化**：跟 web profile 自己的 storage 配置有关，DSH_EDGE_STORAGE_ROOT env 已切到独立路径，**不会**跟 headless profile 串。