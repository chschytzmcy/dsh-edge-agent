# etscli 场景 function-call caller 测试报告

- **生成时间**: 20260928T055219Z
- **被测服务**: `http://127.0.0.1:8081` —— 自报 `未自报` 3.0.1
- **语料**: etscli 真实场景,18 正例 + 2 负例,覆盖 10 个 service
- **每 case 试验次数**: 2
- **工具集**: `bash`(执行 etscli)+ `read`(干扰项,测工具选择)

## 1. 判定

| 指标 | English | Chinese |
|---|---|---|
| HTTP 成功 | 100% | 25% |
| 有效产出(有调用) | 35% | 10% |
| **命令正确率** | **5%** | **5%** |
| 中位延迟 | 2.8s | 6.6s |

> **三层评分的区别很重要:**
>
> - `HTTP 成功` —— 服务没报错
> - `有效产出` —— 产出了至少一个 `function_call`(prefill 有用的前提)
> - **`命令正确率`** —— 产出的调用里出现了**期望的 etscli 命令**
>
> etscli 是确定性 CLI,同一意图**只有一个正确命令**(`auth status` 不能写成
> `auth list`)。所以第三层才是真正的能力指标 —— 前两层通过但命令选错,
> 对智能体而言依然是失败。**选型应以命令正确率为准。**

> **契约符合性:0 次违规。** 0 次表示每次 2xx 响应的字段与类型
> 都符合 `docs/function-call-external-http-contract.md`。

### 1.1 过度触发检测(负例)

| 语言 | 负例 | 正确(未触发) | 过度触发率 |
|---|---|---|---|
| English | 4 | 2 | 50% |
| Chinese | 4 | 2 | 50% |

> 闲聊/知识问答**不该**产生 etscli 调用。过度触发会白白执行命令,
> 严重时产生非预期副作用(如 `fs rm`)。

### 1.2 契约符合性明细

全部 2xx 响应均通过契约校验:必填字段齐全、类型正确、`confidence ∈ [0,1]`、
`function_calls[]` 结构合法。

## 2. 逐 case 明细

| case | 语言 | 期望命令 | HTTP | 有效产出 | 正确 | conf | 失败类型 |
|---|---|---|---|---|---|---|---|
| `auth-status` | English | `etscli auth status` | 2/2 | 0/2 | 0/2 | 1.00 | — |
| `auth-list` | English | `etscli auth list` | 2/2 | 0/2 | 0/2 | 1.00 | — |
| `auth-switch` | English | `etscli auth switch` | 2/2 | 0/2 | 0/2 | 1.00 | — |
| `fs-ls` | English | `etscli fs ls` | 2/2 | 0/2 | 0/2 | 1.00 | — |
| `fs-mkdir` | English | `etscli fs mkdir` | 2/2 | 0/2 | 0/2 | 1.00 | — |
| `fs-rm` | English | `etscli fs rm` | 2/2 | 0/2 | 0/2 | 1.00 | — |
| `file-search` | English | `etscli file search` | 2/2 | 0/2 | 0/2 | 1.00 | — |
| `file-detail` | English | `etscli file detail` | 2/2 | 2/2 | 0/2 | 0.92 | — |
| `meeting-list` | English | `etscli meeting list` | 2/2 | 0/2 | 0/2 | 0.64 | — |
| `meeting-summary` | English | `etscli meeting summary` | 2/2 | 2/2 | 0/2 | 1.00 | — |
| `meeting-create` | English | `etscli meeting create` | 2/2 | 0/2 | 0/2 | 0.97 | — |
| `chat-list` | English | `etscli chat list` | 2/2 | 0/2 | 0/2 | 1.00 | — |
| `chat-send` | English | `etscli chat send` | 2/2 | 0/2 | 0/2 | 1.00 | — |
| `system-health` | English | `etscli system health` | 2/2 | 2/2 | 0/2 | 1.00 | — |
| `system-info` | English | `etscli system info` | 2/2 | 2/2 | 0/2 | 1.00 | — |
| `user-list` | English | `etscli user list` | 2/2 | 2/2 | 0/2 | 0.12 | — |
| `sharing-list` | English | `etscli sharing list` | 2/2 | 0/2 | 0/2 | 1.00 | — |
| `discover-scan` | English | `etscli discover scan` | 2/2 | 2/2 | 0/2 | 1.00 | — |
| `negative-greeting` | English | _不应调用_ | 2/2 | 2/2 | 0/2 | 1.00 | — |
| `negative-knowledge` | English | _不应调用_ | 2/2 | 0/2 | 2/2 | 1.00 | — |
| `auth-status` | Chinese | `etscli auth status` | 0/2 | 0/0 | 0/2 | — | encoding×2 |
| `auth-list` | Chinese | `etscli auth list` | 2/2 | 0/2 | 0/2 | 0.78 | — |
| `auth-switch` | Chinese | `etscli auth switch` | 2/2 | 2/2 | 0/2 | 0.77 | — |
| `fs-ls` | Chinese | `etscli fs ls` | 0/2 | 0/0 | 0/2 | — | encoding×2 |
| `fs-mkdir` | Chinese | `etscli fs mkdir` | 0/2 | 0/0 | 0/2 | — | encoding×2 |
| `fs-rm` | Chinese | `etscli fs rm` | 0/2 | 0/0 | 0/2 | — | encoding×2 |
| `file-search` | Chinese | `etscli file search` | 0/2 | 0/0 | 0/2 | — | encoding×2 |
| `file-detail` | Chinese | `etscli file detail` | 0/2 | 0/0 | 0/2 | — | encoding×2 |
| `meeting-list` | Chinese | `etscli meeting list` | 0/2 | 0/0 | 0/2 | — | encoding×2 |
| `meeting-summary` | Chinese | `etscli meeting summary` | 0/2 | 0/0 | 0/2 | — | encoding×2 |
| `meeting-create` | Chinese | `etscli meeting create` | 0/2 | 0/0 | 0/2 | — | encoding×2 |
| `chat-list` | Chinese | `etscli chat list` | 0/2 | 0/0 | 0/2 | — | encoding×2 |
| `chat-send` | Chinese | `etscli chat send` | 0/2 | 0/0 | 0/2 | — | encoding×2 |
| `system-health` | Chinese | `etscli system health` | 0/2 | 0/0 | 0/2 | — | encoding×2 |
| `system-info` | Chinese | `etscli system info` | 2/2 | 0/2 | 0/2 | 0.90 | — |
| `user-list` | Chinese | `etscli user list` | 0/2 | 0/0 | 0/2 | — | encoding×2 |
| `sharing-list` | Chinese | `etscli sharing list` | 0/2 | 0/0 | 0/2 | — | encoding×2 |
| `discover-scan` | Chinese | `etscli discover scan` | 0/2 | 0/0 | 0/2 | — | encoding×2 |
| `negative-greeting` | Chinese | _不应调用_ | 2/2 | 2/2 | 0/2 | 0.81 | — |
| `negative-knowledge` | Chinese | _不应调用_ | 2/2 | 0/2 | 2/2 | 0.79 | — |

### 2.1 按 service 的命令正确率

| service | English 正确率 | Chinese 正确率 |
|---|---|---|
| auth | 0% (0/6) | 0% (0/6) |
| fs | 0% (0/6) | 0% (0/6) |
| file | 0% (0/4) | 0% (0/4) |
| meeting | 0% (0/6) | 0% (0/6) |
| chat | 0% (0/4) | 0% (0/4) |
| system | 0% (0/4) | 0% (0/4) |
| user | 0% (0/2) | 0% (0/2) |
| sharing | 0% (0/2) | 0% (0/2) |
| discover | 0% (0/2) | 0% (0/2) |
| negative | 50% (2/4) | 50% (2/4) |

## 3. 错例样本

以下 case 产出了调用,但**命令不对** —— 这类错误比 502 更隐蔽:

**`auth-status`**(English,期望 `etscli auth status`):

```
[]
```

**`auth-list`**(English,期望 `etscli auth list`):

```
[]
```

**`auth-switch`**(English,期望 `etscli auth switch`):

```
[]
```

**`fs-ls`**(English,期望 `etscli fs ls`):

```
[]
```

**`fs-mkdir`**(English,期望 `etscli fs mkdir`):

```
[]
```

**`fs-rm`**(English,期望 `etscli fs rm`):

```
[]
```

_另有 17 条,见 results.json_

**`encoding`**(case `auth-status`,2/2 次):

```
engine error: 'utf-8' codec can't decode byte 0xe7 in position 261: invalid continuation byte
```

## 4. 测试语料

> 中英文**分表列出**而非并排 —— 并排时两列紧邻,长 query 容易被误读成
> 另一列的延续。两侧 query 语义等价,只用于对比语言维度。

### 4.1 English

| case | service | expect | query |
|---|---|---|---|
| `auth-status` | auth | `etscli auth status` | check whether the box is logged in |
| `auth-list` | auth | `etscli auth list` | list all saved login profiles |
| `auth-switch` | auth | `etscli auth switch` | switch to the office profile |
| `fs-ls` | fs | `etscli fs ls` | show the files in my album folder |
| `fs-mkdir` | fs | `etscli fs mkdir` | create a new folder named backup in the box |
| `fs-rm` | fs | `etscli fs rm` | delete the file named old.txt from the box |
| `file-search` | file | `etscli file search` | search the box for files whose name contains report |
| `file-detail` | file | `etscli file detail` | show the details of a file given its id |
| `meeting-list` | meeting | `etscli meeting list` | list all the meetings on the box |
| `meeting-summary` | meeting | `etscli meeting summary` | get the summary of the latest meeting |
| `meeting-create` | meeting | `etscli meeting create` | create a new meeting called weekly sync |
| `chat-list` | chat | `etscli chat list` | list my group chats |
| `chat-send` | chat | `etscli chat send` | send a message to a group chat |
| `system-health` | system | `etscli system health` | check the health of the box |
| `system-info` | system | `etscli system info` | show the system information of the box |
| `user-list` | user | `etscli user list` | list all the users on the box |
| `sharing-list` | sharing | `etscli sharing list` | list all the sharing links I created |
| `discover-scan` | discover | `etscli discover scan` | scan the local network for boxes |
| `negative-greeting` | negative | _no call expected_ | hello, thanks for your help |
| `negative-knowledge` | negative | _no call expected_ | what is the capital of France |

### 4.2 中文

| case | service | 期望命令 | query |
|---|---|---|---|
| `auth-status` | auth | `etscli auth status` | 查询密盒的登录状态 |
| `auth-list` | auth | `etscli auth list` | 列出所有已保存的 profile |
| `auth-switch` | auth | `etscli auth switch` | 切换到 office 这个 profile |
| `fs-ls` | fs | `etscli fs ls` | 列出我的相册目录下的文件 |
| `fs-mkdir` | fs | `etscli fs mkdir` | 在密盒里新建一个名为 backup 的文件夹 |
| `fs-rm` | fs | `etscli fs rm` | 删掉密盒里名为 old.txt 的文件 |
| `file-search` | file | `etscli file search` | 搜索密盒里名字包含报告的文件 |
| `file-detail` | file | `etscli file detail` | 查看指定文件 id 的详细信息 |
| `meeting-list` | meeting | `etscli meeting list` | 列出密盒上所有的会议 |
| `meeting-summary` | meeting | `etscli meeting summary` | 获取最近一次会议的纪要 |
| `meeting-create` | meeting | `etscli meeting create` | 创建一个名为 weekly sync 的新会议 |
| `chat-list` | chat | `etscli chat list` | 列出我的群聊列表 |
| `chat-send` | chat | `etscli chat send` | 往群聊里发一条消息 |
| `system-health` | system | `etscli system health` | 检查密盒的健康状态 |
| `system-info` | system | `etscli system info` | 显示密盒的系统信息 |
| `user-list` | user | `etscli user list` | 列出密盒上的所有用户 |
| `sharing-list` | sharing | `etscli sharing list` | 列出我创建的所有分享链接 |
| `discover-scan` | discover | `etscli discover scan` | 扫描局域网里的密盒设备 |
| `negative-greeting` | negative | _不应调用_ | 你好,谢谢你的帮助 |
| `negative-knowledge` | negative | _不应调用_ | 法国的首都是哪里 |

> 语料来源:`etscli -h` 的 11 个 service + `~/work/etsme/etscli/skills/*/SKILL.md`
> 的命令表。期望命令取各 skill 中**确定性唯一**的映射 —— 避免出现多个合理答案。

## 5. 对 dsh-edge-agent 的影响

- 英文命令正确率 **5%** / 中文 **5%**。
- dsh-edge-agent 是中文产品,**中文命令正确率是启用 `function-call-external` 的先决条件**。

❌ 未达启用门槛。开启会是净损耗(白等 latency + 熔断器反复开关),
建议保持 `FUNCTION_CALL_EXTERNAL_ENABLED=false`。

## 6. 建议

**中文能力**(阻断性):
- 命令正确率仅 5%。etscli 训练语料中中文样本的覆盖度是关键,
  中文 query → 英文命令的映射需要显式训练,而非依赖模型的中文理解力。
- 静默式错误(有调用但命令错)比报错更危险 —— 需在训练中强化命令精确性。

**命令精确性**:错例集中在具体命令选择(`auth status` vs `auth list`)。
建议训练时以**完整命令序列**为监督目标,而非仅工具名。

**通用**:
- 失败语义应可区分(过载 / 编码 / 截断),便于调用方决定重试与熔断。
- `/health` 声明的能力应与实际行为一致。
- 持续扩充语料 —— 当前 21 例覆盖 10 个 service,建议每 service ≥3 例。
