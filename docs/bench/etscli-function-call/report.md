# etscli 场景 function-call caller 测试报告

- **生成时间**: 20260929T024353Z
- **被测服务**: `http://127.0.0.1:8081` —— 自报 `未自报` 3.0.1
- **语料**: etscli 真实场景,39 正例 + 3 负例,覆盖 11 个 service
- **每 case 试验次数**: 4
- **工具集**: `bash`(执行 etscli)+ `read`(干扰项,测工具选择)

## 1. 判定

| 指标 | English | Chinese |
|---|---|---|
| HTTP 成功 | 100% | 43% |
| 有效产出(有调用) | 38% | 17% |
| **命令正确率** | **5%** | **2%** |
| 中位延迟 | 0.2s | 0.5s |

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
| English | 12 | 8 | 33% |
| Chinese | 12 | 4 | 67% |

> 闲聊/知识问答**不该**产生 etscli 调用。过度触发会白白执行命令,
> 严重时产生非预期副作用(如 `fs rm`)。

### 1.2 契约符合性明细

全部 2xx 响应均通过契约校验:必填字段齐全、类型正确、`confidence ∈ [0,1]`、
`function_calls[]` 结构合法。

## 2. 逐 case 明细

| case | 语言 | 期望命令 | HTTP | 有效产出 | 正确 | conf | 失败类型 |
|---|---|---|---|---|---|---|---|
| `auth-status` | English | `etscli auth status` | 4/4 | 0/4 | 0/4 | 1.00 | — |
| `auth-list` | English | `etscli auth list` | 4/4 | 0/4 | 0/4 | 1.00 | — |
| `auth-switch` | English | `etscli auth switch` | 4/4 | 0/4 | 0/4 | 1.00 | — |
| `auth-rename` | English | `etscli auth rename` | 4/4 | 0/4 | 0/4 | 1.00 | — |
| `auth-login` | English | `etscli auth login` | 4/4 | 4/4 | 0/4 | 0.95 | — |
| `auth-logout` | English | `etscli auth logout` | 4/4 | 0/4 | 0/4 | 1.00 | — |
| `user-list` | English | `etscli user list` | 4/4 | 4/4 | 0/4 | 0.12 | — |
| `user-detail` | English | `etscli user detail` | 4/4 | 4/4 | 0/4 | 1.00 | — |
| `user-register` | English | `etscli user register` | 4/4 | 0/4 | 0/4 | 1.00 | — |
| `user-passwd` | English | `etscli user passwd` | 4/4 | 0/4 | 0/4 | 0.98 | — |
| `chat-list` | English | `etscli chat list` | 4/4 | 0/4 | 0/4 | 1.00 | — |
| `chat-messages` | English | `etscli chat messages` | 4/4 | 0/4 | 0/4 | 1.00 | — |
| `chat-send` | English | `etscli chat send` | 4/4 | 0/4 | 0/4 | 1.00 | — |
| `chat-send-file` | English | `etscli chat send-file` | 4/4 | 0/4 | 0/4 | 1.00 | — |
| `meeting-list` | English | `etscli meeting list` | 4/4 | 0/4 | 0/4 | 0.64 | — |
| `meeting-summary` | English | `etscli meeting summary` | 4/4 | 4/4 | 0/4 | 1.00 | — |
| `meeting-detail` | English | `etscli meeting detail` | 4/4 | 4/4 | 0/4 | 0.96 | — |
| `meeting-create` | English | `etscli meeting create` | 4/4 | 0/4 | 0/4 | 0.97 | — |
| `meeting-finish` | English | `etscli meeting finish` | 4/4 | 4/4 | 0/4 | 0.69 | — |
| `file-search` | English | `etscli file search` | 4/4 | 0/4 | 0/4 | 1.00 | — |
| `file-detail` | English | `etscli file detail` | 4/4 | 4/4 | 0/4 | 0.92 | — |
| `file-upload` | English | `etscli file upload`<br/>或 `etscli file upload-dir` | 4/4 | 4/4 | 0/4 | 1.00 | — |
| `file-download` | English | `etscli file download` | 4/4 | 4/4 | 0/4 | 1.00 | — |
| `file-delete` | English | `etscli file delete`<br/>或 `etscli fs rm` | 4/4 | 0/4 | 0/4 | 1.00 | — |
| `fs-ls` | English | `etscli fs ls` | 4/4 | 0/4 | 0/4 | 1.00 | — |
| `fs-mkdir` | English | `etscli fs mkdir` | 4/4 | 0/4 | 0/4 | 1.00 | — |
| `fs-rm` | English | `etscli fs rm`<br/>或 `etscli file delete` | 4/4 | 0/4 | 0/4 | 1.00 | — |
| `fs-search` | English | `etscli fs search` | 4/4 | 0/4 | 0/4 | 1.00 | — |
| `fs-stat` | English | `etscli fs stat`<br/>或 `etscli fs stats` | 4/4 | 4/4 | 0/4 | 1.00 | — |
| `fs-add` | English | `etscli fs add` | 4/4 | 0/4 | 0/4 | 1.00 | — |
| `sharing-list` | English | `etscli sharing list` | 4/4 | 0/4 | 0/4 | 1.00 | — |
| `sharing-create` | English | `etscli sharing create` | 4/4 | 0/4 | 0/4 | 1.00 | — |
| `sharing-delete` | English | `etscli sharing delete` | 4/4 | 0/4 | 0/4 | 1.00 | — |
| `system-info` | English | `etscli system info` | 4/4 | 4/4 | 0/4 | 1.00 | — |
| `system-health` | English | `etscli system health` | 4/4 | 4/4 | 0/4 | 1.00 | — |
| `system-alarm` | English | `etscli system alarm`<br/>或 `etscli system alarm list` | 4/4 | 0/4 | 0/4 | 0.83 | — |
| `discover-scan` | English | `etscli discover scan` | 4/4 | 4/4 | 0/4 | 1.00 | — |
| `migrate-transfer` | English | `etscli migrate transfer` | 4/4 | 4/4 | 0/4 | 1.00 | — |
| `migrate-verify` | English | `etscli migrate verify` | 4/4 | 4/4 | 0/4 | 1.00 | — |
| `negative-greeting` | English | _不应调用_ | 4/4 | 4/4 | 0/4 | 1.00 | — |
| `negative-knowledge` | English | _不应调用_ | 4/4 | 0/4 | 4/4 | 1.00 | — |
| `negative-weather` | English | _不应调用_ | 4/4 | 0/4 | 4/4 | 0.93 | — |
| `auth-status` | Chinese | `etscli auth status` | 0/4 | 0/0 | 0/4 | — | encoding×4 |
| `auth-list` | Chinese | `etscli auth list` | 4/4 | 0/4 | 0/4 | 0.78 | — |
| `auth-switch` | Chinese | `etscli auth switch` | 4/4 | 4/4 | 0/4 | 0.77 | — |
| `auth-rename` | Chinese | `etscli auth rename` | 4/4 | 0/4 | 0/4 | 0.42 | — |
| `auth-login` | Chinese | `etscli auth login` | 4/4 | 0/4 | 0/4 | 0.74 | — |
| `auth-logout` | Chinese | `etscli auth logout` | 0/4 | 0/0 | 0/4 | — | encoding×4 |
| `user-list` | Chinese | `etscli user list` | 0/4 | 0/0 | 0/4 | — | encoding×4 |
| `user-detail` | Chinese | `etscli user detail` | 4/4 | 4/4 | 0/4 | 0.51 | — |
| `user-register` | Chinese | `etscli user register` | 4/4 | 4/4 | 0/4 | 0.65 | — |
| `user-passwd` | Chinese | `etscli user passwd` | 4/4 | 4/4 | 0/4 | 0.28 | — |
| `chat-list` | Chinese | `etscli chat list` | 0/4 | 0/0 | 0/4 | — | encoding×4 |
| `chat-messages` | Chinese | `etscli chat messages` | 0/4 | 0/0 | 0/4 | — | encoding×4 |
| `chat-send` | Chinese | `etscli chat send` | 0/4 | 0/0 | 0/4 | — | encoding×4 |
| `chat-send-file` | Chinese | `etscli chat send-file` | 4/4 | 0/4 | 0/4 | 0.88 | — |
| `meeting-list` | Chinese | `etscli meeting list` | 0/4 | 0/0 | 0/4 | — | encoding×4 |
| `meeting-summary` | Chinese | `etscli meeting summary` | 0/4 | 0/0 | 0/4 | — | encoding×4 |
| `meeting-detail` | Chinese | `etscli meeting detail` | 0/4 | 0/0 | 0/4 | — | encoding×4 |
| `meeting-create` | Chinese | `etscli meeting create` | 0/4 | 0/0 | 0/4 | — | encoding×4 |
| `meeting-finish` | Chinese | `etscli meeting finish` | 0/4 | 0/0 | 0/4 | — | encoding×4 |
| `file-search` | Chinese | `etscli file search` | 0/4 | 0/0 | 0/4 | — | encoding×4 |
| `file-detail` | Chinese | `etscli file detail` | 4/4 | 4/4 | 0/4 | 0.95 | — |
| `file-upload` | Chinese | `etscli file upload`<br/>或 `etscli file upload-dir` | 0/4 | 0/0 | 0/4 | — | encoding×4 |
| `file-download` | Chinese | `etscli file download` | 4/4 | 0/4 | 0/4 | 0.97 | — |
| `file-delete` | Chinese | `etscli file delete`<br/>或 `etscli fs rm` | 4/4 | 0/4 | 0/4 | 0.98 | — |
| `fs-ls` | Chinese | `etscli fs ls` | 0/4 | 0/0 | 0/4 | — | encoding×4 |
| `fs-mkdir` | Chinese | `etscli fs mkdir` | 0/4 | 0/0 | 0/4 | — | encoding×4 |
| `fs-rm` | Chinese | `etscli fs rm`<br/>或 `etscli file delete` | 0/4 | 0/0 | 0/4 | — | encoding×4 |
| `fs-search` | Chinese | `etscli fs search` | 0/4 | 0/0 | 0/4 | — | encoding×4 |
| `fs-stat` | Chinese | `etscli fs stat`<br/>或 `etscli fs stats` | 4/4 | 0/4 | 0/4 | 0.75 | — |
| `fs-add` | Chinese | `etscli fs add` | 0/4 | 0/0 | 0/4 | — | encoding×4 |
| `sharing-list` | Chinese | `etscli sharing list` | 0/4 | 0/0 | 0/4 | — | encoding×4 |
| `sharing-create` | Chinese | `etscli sharing create` | 0/4 | 0/0 | 0/4 | — | encoding×4 |
| `sharing-delete` | Chinese | `etscli sharing delete` | 4/4 | 0/4 | 0/4 | 0.96 | — |
| `system-info` | Chinese | `etscli system info` | 4/4 | 0/4 | 0/4 | 0.90 | — |
| `system-health` | Chinese | `etscli system health` | 0/4 | 0/0 | 0/4 | — | encoding×4 |
| `system-alarm` | Chinese | `etscli system alarm`<br/>或 `etscli system alarm list` | 4/4 | 0/4 | 0/4 | 0.80 | — |
| `discover-scan` | Chinese | `etscli discover scan` | 0/4 | 0/0 | 0/4 | — | encoding×4 |
| `migrate-transfer` | Chinese | `etscli migrate transfer` | 0/4 | 0/0 | 0/4 | — | encoding×4 |
| `migrate-verify` | Chinese | `etscli migrate verify` | 4/4 | 4/4 | 0/4 | 0.10 | — |
| `negative-greeting` | Chinese | _不应调用_ | 4/4 | 4/4 | 0/4 | 0.81 | — |
| `negative-knowledge` | Chinese | _不应调用_ | 4/4 | 0/4 | 4/4 | 0.79 | — |
| `negative-weather` | Chinese | _不应调用_ | 0/4 | 0/0 | 0/4 | — | encoding×4 |

### 2.1 按 service 的命令正确率

| service | English 正确率 | Chinese 正确率 |
|---|---|---|
| auth | 0% (0/24) | 0% (0/24) |
| user | 0% (0/16) | 0% (0/16) |
| chat | 0% (0/16) | 0% (0/16) |
| meeting | 0% (0/20) | 0% (0/20) |
| file | 0% (0/20) | 0% (0/20) |
| fs | 0% (0/24) | 0% (0/24) |
| sharing | 0% (0/12) | 0% (0/12) |
| system | 0% (0/12) | 0% (0/12) |
| discover | 0% (0/4) | 0% (0/4) |
| migrate | 0% (0/8) | 0% (0/8) |
| negative | 67% (8/12) | 33% (4/12) |

### 2.2 歧义 case(命中 `expect` 或 `alt` 都算对)

| case | 语言 | 期望 | 也接受 |
|---|---|---|---|
| `file-upload` | English | `etscli file upload` | `etscli file upload-dir` |
| `file-delete` | English | `etscli file delete` | `etscli fs rm` |
| `fs-rm` | English | `etscli fs rm` | `etscli file delete` |
| `fs-stat` | English | `etscli fs stat` | `etscli fs stats` |
| `system-alarm` | English | `etscli system alarm` | `etscli system alarm list` |
| `file-upload` | Chinese | `etscli file upload` | `etscli file upload-dir` |
| `file-delete` | Chinese | `etscli file delete` | `etscli fs rm` |
| `fs-rm` | Chinese | `etscli fs rm` | `etscli file delete` |
| `fs-stat` | Chinese | `etscli fs stat` | `etscli fs stats` |
| `system-alarm` | Chinese | `etscli system alarm` | `etscli system alarm list` |

> 例:`fs-rm`(「按路径删除文件」)既可用 `etscli fs rm` 也可用
> `etscli file delete`(按 id 删除)。这类本质歧义不应让模型被扣分。

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

**`auth-rename`**(English,期望 `etscli auth rename`):

```
[]
```

**`auth-login`**(English,期望 `etscli auth login`):

```
[{"name": "read", "arguments": {"file_path": "192.168.1.100"}}]
```

**`auth-logout`**(English,期望 `etscli auth logout`):

```
[]
```

_另有 51 条,见 results.json_

**`encoding`**(case `auth-status`,4/4 次):

```
engine error: 'utf-8' codec can't decode byte 0xe7 in position 261: invalid continuation byte
```

## 4. 测试语料

> 中英文**分表列出**而非并排 —— 并排时两列紧邻,长 query 容易被误读成
> 另一列的延续。两侧 query 语义等价,只用于对比语言维度。

### 4.1 English

| case | service | expect | alt | note | query |
|---|---|---|---|---|---|
| `auth-status` | auth | `etscli auth status` | — | — | check whether the box is logged in |
| `auth-list` | auth | `etscli auth list` | — | — | list all saved login profiles |
| `auth-switch` | auth | `etscli auth switch` | — | — | switch to the office profile |
| `auth-rename` | auth | `etscli auth rename` | — | — | rename the office profile to company |
| `auth-login` | auth | `etscli auth login` | — | — | log in to the box at 192.168.1.100 as admin |
| `auth-logout` | auth | `etscli auth logout` | — | — | log out of the current profile |
| `user-list` | user | `etscli user list` | — | — | list all the users on the box |
| `user-detail` | user | `etscli user detail` | — | — | show the details of user user01 |
| `user-register` | user | `etscli user register` | — | — | register a new user called bob |
| `user-passwd` | user | `etscli user passwd` | — | — | change the password of user user01 |
| `chat-list` | chat | `etscli chat list` | — | — | list my group chats |
| `chat-messages` | chat | `etscli chat messages` | — | — | show the recent messages in a group chat |
| `chat-send` | chat | `etscli chat send` | — | — | send a text message to a group chat |
| `chat-send-file` | chat | `etscli chat send-file` | — | — | send a file to a group chat |
| `meeting-list` | meeting | `etscli meeting list` | — | — | list all the meetings on the box |
| `meeting-summary` | meeting | `etscli meeting summary` | — | — | get the summary of the latest meeting |
| `meeting-detail` | meeting | `etscli meeting detail` | — | — | show the details of the meeting with id mtg001 |
| `meeting-create` | meeting | `etscli meeting create` | — | — | create a new meeting called weekly sync |
| `meeting-finish` | meeting | `etscli meeting finish` | — | — | end the meeting that is currently running |
| `file-search` | file | `etscli file search` | — | — | search the box for files whose name contains report |
| `file-detail` | file | `etscli file detail` | — | 按 file id 操作,应走 file 而非 fs | show the details of a box file given its file id |
| `file-upload` | file | `etscli file upload` | `etscli file upload-dir` | upload / upload-dir 均可接受 | upload a local file to the box |
| `file-download` | file | `etscli file download` | — | 按 file id 操作,应走 file 而非 fs | download a file from the box by its file id |
| `file-delete` | file | `etscli file delete` | `etscli fs rm` | **⚠** 歧义:fs rm 按路径删除同样说得通,两者皆可接受 | delete a box file given its file id |
| `fs-ls` | fs | `etscli fs ls` | — | — | show the files in my album folder |
| `fs-mkdir` | fs | `etscli fs mkdir` | — | — | create a new folder named backup on the box |
| `fs-rm` | fs | `etscli fs rm` | `etscli file delete` | **⚠** 歧义:file delete 按 id 删除同样说得通,两者皆可接受 | delete a file on the box by its path |
| `fs-search` | fs | `etscli fs search` | — | — | search for files by name under a folder on the box |
| `fs-stat` | fs | `etscli fs stat` | `etscli fs stats` | stat / stats 均可接受 | show the stat info of a file on the box |
| `fs-add` | fs | `etscli fs add` | — | — | add a local file into a folder on the box |
| `sharing-list` | sharing | `etscli sharing list` | — | — | list all the sharing links I created |
| `sharing-create` | sharing | `etscli sharing create` | — | — | create a sharing link for a box file |
| `sharing-delete` | sharing | `etscli sharing delete` | — | — | delete a sharing link |
| `system-info` | system | `etscli system info` | — | — | show the system information of the box |
| `system-health` | system | `etscli system health` | — | — | check the health of the box |
| `system-alarm` | system | `etscli system alarm` | `etscli system alarm list` | alarm 及其子命令 list 均可接受 | list the alarms on the box |
| `discover-scan` | discover | `etscli discover scan` | — | — | scan the local network for boxes |
| `migrate-transfer` | migrate | `etscli migrate transfer` | — | — | migrate the data from the old box to the new one |
| `migrate-verify` | migrate | `etscli migrate verify` | — | — | verify the migration result |
| `negative-greeting` | negative | _no call expected_ | — | — | hello, thanks for your help |
| `negative-knowledge` | negative | _no call expected_ | — | — | what is the capital of France |
| `negative-weather` | negative | _no call expected_ | — | — | what is the weather like in Tokyo today |

### 4.2 中文

| case | service | 期望命令 | 也接受 | 备注 | query |
|---|---|---|---|---|---|
| `auth-status` | auth | `etscli auth status` | — | — | 查询密盒的登录状态 |
| `auth-list` | auth | `etscli auth list` | — | — | 列出所有已保存的 profile |
| `auth-switch` | auth | `etscli auth switch` | — | — | 切换到 office 这个 profile |
| `auth-rename` | auth | `etscli auth rename` | — | — | 把 office 这个 profile 重命名为 company |
| `auth-login` | auth | `etscli auth login` | — | — | 登录到 192.168.1.100 的密盒,用户名 admin |
| `auth-logout` | auth | `etscli auth logout` | — | — | 登出当前的 profile |
| `user-list` | user | `etscli user list` | — | — | 列出密盒上的所有用户 |
| `user-detail` | user | `etscli user detail` | — | — | 查看 user01 的详细信息 |
| `user-register` | user | `etscli user register` | — | — | 注册一个名为 bob 的新用户 |
| `user-passwd` | user | `etscli user passwd` | — | — | 修改 user01 的密码 |
| `chat-list` | chat | `etscli chat list` | — | — | 列出我的群聊列表 |
| `chat-messages` | chat | `etscli chat messages` | — | — | 查看某个群聊的最近消息 |
| `chat-send` | chat | `etscli chat send` | — | — | 往群聊里发一条文字消息 |
| `chat-send-file` | chat | `etscli chat send-file` | — | — | 把文件发送到群聊里 |
| `meeting-list` | meeting | `etscli meeting list` | — | — | 列出密盒上所有的会议 |
| `meeting-summary` | meeting | `etscli meeting summary` | — | — | 获取最近一次会议的纪要 |
| `meeting-detail` | meeting | `etscli meeting detail` | — | — | 查看 id 为 mtg001 的会议详情 |
| `meeting-create` | meeting | `etscli meeting create` | — | — | 创建一个名为 weekly sync 的新会议 |
| `meeting-finish` | meeting | `etscli meeting finish` | — | — | 结束当前正在进行的会议 |
| `file-search` | file | `etscli file search` | — | — | 搜索密盒里名字包含报告的文件 |
| `file-detail` | file | `etscli file detail` | — | 按 file id 操作,应走 file 而非 fs | 查看指定 file id 的文件详情 |
| `file-upload` | file | `etscli file upload` | `etscli file upload-dir` | upload / upload-dir 均可接受 | 把本地文件上传到密盒 |
| `file-download` | file | `etscli file download` | — | 按 file id 操作,应走 file 而非 fs | 按 file id 从密盒下载文件 |
| `file-delete` | file | `etscli file delete` | `etscli fs rm` | **⚠** 歧义:fs rm 按路径删除同样说得通,两者皆可接受 | 按 file id 删除密盒里的文件 |
| `fs-ls` | fs | `etscli fs ls` | — | — | 列出我的相册目录下的文件 |
| `fs-mkdir` | fs | `etscli fs mkdir` | — | — | 在密盒上新建一个名为 backup 的文件夹 |
| `fs-rm` | fs | `etscli fs rm` | `etscli file delete` | **⚠** 歧义:file delete 按 id 删除同样说得通,两者皆可接受 | 按路径删除密盒上的文件 |
| `fs-search` | fs | `etscli fs search` | — | — | 在密盒上按文件名搜索文件 |
| `fs-stat` | fs | `etscli fs stat` | `etscli fs stats` | stat / stats 均可接受 | 查看密盒上某个文件的 stat 信息 |
| `fs-add` | fs | `etscli fs add` | — | — | 把本地文件添加到密盒的某个目录 |
| `sharing-list` | sharing | `etscli sharing list` | — | — | 列出我创建的所有分享链接 |
| `sharing-create` | sharing | `etscli sharing create` | — | — | 为密盒里的某个文件创建分享链接 |
| `sharing-delete` | sharing | `etscli sharing delete` | — | — | 删除一个分享链接 |
| `system-info` | system | `etscli system info` | — | — | 显示密盒的系统信息 |
| `system-health` | system | `etscli system health` | — | — | 检查密盒的健康状态 |
| `system-alarm` | system | `etscli system alarm` | `etscli system alarm list` | alarm 及其子命令 list 均可接受 | 列出密盒上的告警 |
| `discover-scan` | discover | `etscli discover scan` | — | — | 扫描局域网里的密盒设备 |
| `migrate-transfer` | migrate | `etscli migrate transfer` | — | — | 把旧盒子的数据迁移到新盒子 |
| `migrate-verify` | migrate | `etscli migrate verify` | — | — | 验证迁移的结果 |
| `negative-greeting` | negative | _不应调用_ | — | — | 你好,谢谢你的帮助 |
| `negative-knowledge` | negative | _不应调用_ | — | — | 法国的首都是哪里 |
| `negative-weather` | negative | _不应调用_ | — | — | 今天东京的天气怎么样 |

> 语料来源:`etscli <service> --help` 的 10 个 service + `~/work/etsme/etscli/skills/*/SKILL.md`
> 的命令表。每条期望命令都核对过子命令确实存在。
> `⚠` 标注的 case 存在本质歧义(如按路径 vs 按 id 删除),接受任一合理答案。

## 5. 对 dsh-edge-agent 的影响

- 英文命令正确率 **5%** / 中文 **2%**。
- dsh-edge-agent 是中文产品,**中文命令正确率是启用 `function-call-external` 的先决条件**。

❌ 未达启用门槛。开启会是净损耗(白等 latency + 熔断器反复开关),
建议保持 `FUNCTION_CALL_EXTERNAL_ENABLED=false`。

## 6. 建议

**中文能力**(阻断性):
- 命令正确率仅 2%。etscli 训练语料中中文样本的覆盖度是关键,
  中文 query → 英文命令的映射需要显式训练,而非依赖模型的中文理解力。
- 静默式错误(有调用但命令错)比报错更危险 —— 需在训练中强化命令精确性。

**命令精确性**:错例集中在具体命令选择(`auth status` vs `auth list`)。
建议训练时以**完整命令序列**为监督目标,而非仅工具名。

**通用**:
- 失败语义应可区分(过载 / 编码 / 截断),便于调用方决定重试与熔断。
- `/health` 声明的能力应与实际行为一致。
- 持续扩充语料 —— 当前 21 例覆盖 10 个 service,建议每 service ≥3 例。
