# 端侧训练 minimal pair 补数据清单

> 数据来源:`docs/bench/etscli-tools/match-d0/` + `match-d3/`(正式口径,§7.94.8/§7.94.9)
> 工具集:47 个 etscli 直出工具,全部核对自 `etscli <service> --help`
> 用途:给端侧 function-call 模型补**判别性对照样本**,不是补知识量

## 结论

1. **en 的错误是可枚举的结构性错误**(§7.94.9:兜底 4 / 后缀 2 / file↔fs 2 / 动词对 service 错 2 /
   弃答 5 / 幻觉 5),每一类都有确定的判别线索 → **minimal pair 有效**,按下面 P0 清单补即可。
2. **44% 的误选落在 8 个零正向用例的工具上**(`migrate_session_login` 12 次、`fs_rename` 2、
   `fs_stat` 2、`chat_files` 1、`file_upload` 1;match-d3 里 `fs_stat` 再 3 次)。
   模型不是"选错",是**没有一个正确答案可以选**。→ 补用例的优先级**高于**补对照对。
3. **cn 的错误没有结构**(55% 无关幻觉 + 32% 弃答),minimal pair 救不了;中文侧的
   唯一有效动作是把训练集里 cn 的量拉起来,而不是设计更精巧的对。
4. 总量:P0 **已导出 62 条 JSONL**;P1/P2 再约 64 条,全量 ≈126(见文末配方)。
   这不是大工程,是**定向补盲**。

---

## P0 —— 直接对应已观测错误(17 对 + 5 条反弃答,**已导出为 JSONL**)

每对**必须双向**呈现(`A→A'` 与 `B→B`),单向对会把模型教成"偏好 X"而不是"能分辨 X/Y"。
en / cn 各一条,query 模板只改名词,其余措辞**逐字相同**(否则模型学的是句式不是判别)。
A / B / C 三张表由 `scripts/etscli-minimal-pairs.py --emit-md` 生成,是本节唯一真源。

### P0-A 同动词跨 service —— 14 对

根因:模型缺「query 里的名词 → service」绑定,不是不懂动词。

| # | A | B | 判别线索 | en 模板 | cn 模板 | 证据 |
|---|---|---|---|---|---|---|
| 01 | `auth_list` | `user_list` | profile vs 账户 | enumerate every saved login profile / enumerate every account on the device | 把已保存的登录配置都列一下 / 把设备上的账户都列一下 | auth_list→user_list |
| 02 | `user_list` | `chat_list` | 账户 vs 群聊 | enumerate every account on the device / enumerate every group conversation I belong to | 把设备上的账户都列一下 / 把我参与的群聊都列一下 | user_list 塌缩 |
| 03 | `chat_list` | `meeting_list` | 群聊 vs 会议 | enumerate every group conversation I belong to / enumerate every meeting scheduled on the device | 把我参与的群聊都列一下 / 把设备上排的会议都列一下 | cn 幻觉集中区 |
| 04 | `meeting_list` | `sharing_list` | 会议 vs 分享链接 | enumerate every meeting scheduled on the device / enumerate every share link I generated | 把设备上排的会议都列一下 / 我生成的分享链接都列一下 | sharing-list→乱选 |
| 05 | `user_detail` | `meeting_detail` | 用户 vs 会议 | pull up everything recorded about user01 / pull up everything recorded about meeting mtg001 | 把 user01 的情况都查出来 / 把会议 mtg001 的情况都查出来 | detail 塌缩 |
| 06 | `user_detail` | `file_detail` | 用户 vs 密盒文件 | pull up everything recorded about user01 / pull up everything recorded about box file f_12345 | 把 user01 的情况都查出来 / 把密盒文件 f_12345 的情况都查出来 | detail 塌缩 |
| 07 | `file_search` | `fs_search` | 全设备 vs 指定目录 | look for anything named report anywhere on the device / look for anything named report under the /photos directory | 在整台设备上找一下名字是 report 的东西 / 在 /photos 目录里找一下名字是 report 的东西 | **file↔fs 双向** |
| 08 | `meeting_create` | `sharing_create` | 会议 vs 分享链接 | set up a new meeting called sprint review / set up a new share link for box file f_12345 | 帮我建一个叫 sprint review 的会议吧 / 帮我建一个 f_12345 的分享链接吧 | sharing_delete→sharing_create |
| 09 | `user_register` | `fs_mkdir` | 账户 vs 目录 | set up a new account named bob on the device / set up a new directory named backup on the device | 在设备上帮我建一个叫 bob 的账户吧 / 在设备上帮我建一个叫 backup 的目录吧 | fs_mkdir 误选 5 次 |
| 10 | `auth_rename` | `fs_rename` | 配置名 vs 路径 | profile office should be called company from now on / box file /photos/a.jpg should be called /photos/b.jpg from now on | office 这个配置以后就叫 company 了 / 密盒上的 /photos/a.jpg 以后就叫 /photos/b.jpg 了 | auth_rename→fs_rename |
| 11 | `auth_login` | `migrate_session_login` | 账号凭证 vs 迁移会话 | sign in to the device at 192.0.2.10 using the account admin / open a session for the data migration workflow | 用 admin 这个账号登录到 192.0.2.10 这台设备 / 为数据迁移流程开一个会话 | **12 次误选,头号磁吸** |
| 12 | `migrate_transfer` | `migrate_verify` | 执行迁移 vs 确认结果 | copy everything from the retired device onto the current one / confirm the migration really did succeed | 把退役设备上的东西都搬到当前这台 / 确认迁移是不是真的成功了 | transfer↔verify 互换 |
| 13 | `file_delete` | `sharing_delete` | 密盒文件 vs 分享链接 | wipe box file f_12345 for good / wipe share link sh_67890 for good | 把 f_12345 这个密盒文件彻底删掉 / 把 sh_67890 这个分享链接彻底删掉 | cn 误选落点 |
| 14 | `system_info` | `system_health` | 配置 vs 健康 | give me the config overview of this device / give me the health overview of this device | 把这台设备的配置概况给我 / 把这台设备的健康概况给我 | health→幻觉 2 次 |

### P0-B 同 service 近义动词 —— 3 对

同一 service 内动词语义相邻,模型塌缩到高频那个。

| # | A | B | 判别线索 | en 模板 | cn 模板 | 证据 |
|---|---|---|---|---|---|---|
| 15 | `chat_send` | `chat_send_file` | 文字 vs 文件 | post the text hello into group chat ch_001 / post the file report.pdf into group chat ch_001 | 把 hello 这条文字发到群聊 ch_001 里 / 把 report.pdf 这个文件发到群聊 ch_001 里 | chat_send_file→chat_send |
| 16 | `file_upload` | `file_upload_dir` | 单文件 vs 目录 | push my local report.pdf onto the device / push my local /data/reports onto the device | 把我本地的 report.pdf 这个文件传到设备上 / 把我本地的 /data/reports 这个目录传到设备上 | upload_dir→upload |
| 17 | `meeting_finish` | `meeting_summary` | 结束 vs 取纪要 | for meeting mtg001, close it down now / for meeting mtg001, pull up the minutes | 会议 mtg001 这个,现在把它结束掉 / 会议 mtg001 这个,把它纪要调出来 | cn finish→summary |

### P0-C 「必须有调用」反弃答 —— 5 条

en 侧 5 个 200 空产出,query 是明确祈使句:空产出永远不是合法答案。

| 工具 | en query | cn query |
|---|---|---|
| `auth_login` | sign in to the device at 192.0.2.10 using the account admin | 用 admin 这个账号登录到 192.0.2.10 这台设备 |
| `chat_send` | post the text hello into group chat ch_001 | 把 hello 这条文字发到群聊 ch_001 里 |
| `meeting_finish` | for meeting mtg001, close it down now | 会议 mtg001 这个,现在把它结束掉 |
| `file_delete` | wipe box file f_12345 for good | 把 f_12345 这个密盒文件彻底删掉 |
| `fs_add` | tuck my local report.pdf into /photos on the device | 把我本地的 report.pdf 塞到设备的 /photos 目录 |

### P0 已导出为训练样本

`scripts/etscli-minimal-pairs.py` 是 P0 的**唯一真源**,上面三张表由 `--emit-md` 生成,勿手改。

```bash
python3 scripts/etscli-minimal-pairs.py --check   # 校验(工具存在/参数合法/双向齐全)
python3 scripts/etscli-minimal-pairs.py --out docs/bench/etscli-tools/train
```

产出 [`train/p0.jsonl`](train/p0.jsonl) + [`train/tools.json`](train/tools.json):

| 项 | 实测值 |
|---|---|
| 样本条数 | **62**(en 31 / cn 31) |
| 其中对照对方向 | 52(P0-A 48 / P0-B 12) |
| 其中反弃答 | 10(P0-C,其中 2 条是新增 query) |
| 去重合并 | 12 行 —— 链式对照对共享 query(`user_list` 是 01 的 b 侧也是 02 的 a 侧)与 a 侧复用 |
| 覆盖工具 | 期望侧 31 / 47,`hard_negatives` 侧 30(未覆盖的主要是 P1-E 那 8 个零用例工具) |
| 与验收语料撞题 | **0** 逐字 / **0** 近重复 / 62 条 100% 独立 |

样本字段:`id` `groups[{id,role}]` `lang` `cue` `hard_negatives` `messages` `expected{tool,arguments}`
`evidence`。`tools.json` 是 47 工具的 en/cn 两套 schema(match 口径:en query 配 en 描述);
需要自包含行时加 `--with-tools`(体积 ×~40)。

**校验是硬闸**(`--check` 退出码非 0 即停),四件事:① 工具在 47 集内 ② `arguments` 的键在该
工具 schema 里且 required 齐 ③ 每个对照对每个语言 a/b 双向齐全 ④ **与 42 例验收语料不撞题**。

第 ④ 条是 §7.94.12 补的:42 例语料是**判卷卷子**,P0 训练样本若与它逐字相同或近重复,训完再考
就是背答案,§7.94.8 的验收门槛会虚高。第一版 P0 照抄语料措辞,62 条里 30 条逐字相同(48%)、
18 条近重复,独立只剩 14 条(23%) —— 已全部改写(改写原则:换动词框架、换实体名、换句式,
链式对照对仍共用同一框架以保住「只换名词」的设计)。单独看明细:

```bash
python3 scripts/etscli-minimal-pairs.py --check-corpus   # 撞题报告,逐条列 Jaccard
```

---

## P1 —— 结构性易混但当前没测到(补完即进回归套件)

### D 组 · file↔fs 轴:按 id vs 按路径

这是**产品真实存在的双入口**,不是模型缺陷。`file_*` 按 file id,`fs_*` 按路径。
模型必须学会的唯一判别线索是 **query 里出现的是 id 还是 path**。

| A(按 id) | B(按路径) | 判别线索必须出现在 query 里 |
|---|---|---|
| `file_detail` (file_id) | `fs_stat` (path) | "given its file id" vs "under the path ..." |
| `file_delete` (file_ids) | `fs_rm` (path) | "by its file id" vs "by its path" |
| `file_search` (keyword) | `fs_search` (path+name) | "whose name contains X"(全局) vs "under folder F named X" |
| `file_upload` (file→根) | `fs_add` (local+remote) | "to the box" vs "into folder F on the box" |

⚠️ 现有语料里 `file-delete` / `fs-rm` / `file-upload` 用了 `alt` 双可接受标签。
**训练集里不能这样** —— 必须按上表的线索词指定唯一 gold label,否则是在喂噪声。
（测试语料可以放宽,训练语料必须收紧。）

### E 组 · 8 个零正向用例的工具(误选磁吸区,优先级等同 P0)

每个工具至少 1 条正向用例(en+cn),让它们在训练分布里"有正确答案可选"。

| 工具 | en query | cn query | 被误选次数 |
|---|---|---|---|
| `migrate_session_login` | establish a session for the migration | 为迁移流程建立会话 | 12 |
| `fs_stat` | show the stat info of the file at /photos/a.jpg | 查看 /photos/a.jpg 的 stat 信息 | 5 |
| `fs_rename` | rename the folder /photos/a to /photos/b | 把目录 /photos/a 重命名为 /photos/b | 2 |
| `chat_files` | list the files shared in a group chat | 查看群聊里共享的文件 | 1 |
| `file_upload` | upload report.pdf to the box | 把 report.pdf 上传到密盒 | 1 |
| `fs_mv` | move /photos/a.jpg into /photos/archive | 把 /photos/a.jpg 移动到 /photos/archive | 0 |
| `migrate_record` | show the migration records | 查看迁移记录 | 0 |
| `user_delete` | delete the user named tom on the box | 删除密盒上名为 tom 的用户 | 0 |

`fs_mv` / `migrate_record` / `user_delete` 虽未被误选,但与已误选工具同族(`fs_rename` /
`migrate_session_login` / `file_delete`),一并补齐防止训练后漂移。

### F 组 · fs 内部三兄弟

`fs_stat`(文件 stat)/ `fs_stats`(目录统计) / `fs_ls`(列目录)——
三者 query 措辞极近,是 `fs` 域的天然 minimal triple。

| 工具 | 判别线索 | en | cn |
|---|---|---|---|
| `fs_stat` | 具体文件路径 | show the stat info of the file at /a.txt | 查看 /a.txt 的 stat 信息 |
| `fs_stats` | 目录路径 + "statistics" | show the statistics of the folder /photos | 查看目录 /photos 的统计信息 |
| `fs_ls` | 目录路径 + "list the files" | list the files in my album folder | 列出我的相册目录下的文件 |

---

## P2 —— 抗干扰负样本(不是新工具)

§7.94.8 测出 match-d3 下 en 56% 的基线分被 `_raw/_export/_history` 类同族后缀拽走
(同族后缀丢失类 27 个全错里占 18 个)。对策**不是**再注册 117 个假工具,而是:

- 训练集里把 `x` 与 `x_raw` 形态的**对照**放在一起(query 明确说明需要格式化/摘要/原始输出
  时才选 `_raw`),让"后缀是有语义的,不是随机的";
- 回归测试继续用 `--distractors 3` 测**抗干扰**(干扰项着陆率 ≤ 15% 是验收门槛之一)。

---

## 数据配方

| 组 | 对数 | 方向 | 语言 | 条数 |
|---|---|---|---|---|
| **P0-A 同动词跨 service** | 14 | ×2 双向 | en+cn | **48** ✅已导出 |
| **P0-B 同 service 动词** | 3 | ×2 双向 | en+cn | **12** ✅已导出 |
| **P0-C 反弃答正例** | 5 | 单向 | en+cn | **2 + 8 复用** ✅已导出 |
| P1-D file↔fs 轴 | 4 | ×2 双向 | en+cn | 16(估) |
| P1-E 零用例工具兜底 | 8 | 单向 | en+cn | 16 |
| P1-F fs 三兄弟 | 3 | ×2 双向 | en+cn | 12 |
| P2 抗干扰对照 | ~10 | ×2 | en | 20(估) |
| **合计** | | | | **62 已导出 + P1/P2 约 64 = ≈126** |

配比原则:
- **en:cn 至少 1:1**,但注意 cn 侧 pair 帮不上忙(错误无结构)——cn 的量要靠**普通正例**
  堆,不是靠对照对。
- 每条 pair 两条 query 的**句式必须逐字相同**,只换名词/参数类型。改写句式 = 判别线索
  被稀释,模型学到的是风格不是边界。
- 每 5 条 pair 配 1 条**邻近负例**(不该调工具的闲聊 / 知识问答),防止为补 pair 训出过度触发。
- 全部 query 里的实体用占位值(`user01` / `mtg001` / `192.0.2.10` / `/photos/a.jpg`),
  与既有语料一致(§test-fixture-no-real-pii)。

## 训练后怎么验

复用现成套件,不另造:

```bash
python3 scripts/etscli-tools-test.py --url <新模型> --desc-lang match --distractors 3
```

- 看报告 `### 1.3 错误模式分类`:各类计数应逐项下降,**「动词对、service 错」和
  「同 service 兜底」应先归零**(这两类就是 P0-A/P0-B 修的);
- 「跨 service 无关误选」不降 = 训练分布里 P0-A 的量不够或句式没控住;
- 验收门槛(§7.94.8 正式口径):en ≥ 60% / cn ≥ 40% / 干扰着陆率 ≤ 15% / cn HTTP ≥ 90% / 契约违规 = 0。

## 已知坑

1. **单向 pair = 教偏见**。只给 `detail→不是 list` 的样本,模型学不到"什么时候该 list"。
2. **`alt` 双可接受标签不能进训练集**(语料里 `file-delete`/`fs-rm`/`fs-stat`/`fs-stats`/
   `system-alarm` 都有)——那是测试宽容,训练必须唯一 gold。
3. **别只补 en**。en 44% 有结构可救,cn 3% 是能力问题;如果端侧模型 cn 上不去,
   要判断的是"要不要在架构层绕开"(§7.93 prefill / 翻译管线),不是继续加 pair。
4. **pair 要成组补,不要单点**。`list` 家族有 8 个候选,补 2 个会让剩下 6 个变成新的磁吸。
5. **训练集绝不能照抄验收语料措辞**。P0 第一版就是这么写的(48% 逐字撞题),`--check` 现在
   把这条并进默认闸;P1/P2 补数据时同样过这道闸。
