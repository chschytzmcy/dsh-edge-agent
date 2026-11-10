# etscli 直出工具形态 · function-call caller 测试报告

- **生成时间**: 20260929T055654Z
- **被测服务**: `http://127.0.0.1:8081` —— 3.0.1
- **工具形态**: **47 个 etscli 工具直出**(非 bash 包装),描述语言 `cn`
- **干扰项注入**: 每个正例 case 追加 **3** 个近义工具(词法虚高检测,期望工具不变)
- **每 case 试验次数**: 2
- **语料**: 42 例(39 正例 + 3 负例),源自 `etscli <service> --help` 与 `~/work/<workspace>/etscli/skills/*/SKILL.md` 的真实命令表

## 1. 判定

| 指标 | English | Chinese |
|---|---|---|
| HTTP 200 | 98% | 93% |
| 有效产出 | 92% | 59% |
| **工具选择正确率** | **18%** | **3%** |
| 负例正确(未调用) | 0% | 33% |
| 契约违规 | 0 | 0 |

> **工具直出形态下,`etscli_auth_status` 与 `etscli_auth_logout` 是两个不同工具**,
> 判定为精确匹配,没有模糊空间。
>
> **但直出形态有虚高风险**:工具名本身是强词法线索
> (`etscli_auth_status` 直接对上「登录状态」),词法匹配型模型可能靠
> "名字像 query"蒙对而未真正理解。`--distractors N` 用于量化这一虚高。

### 1.1 过度触发(负例)

| 语言 | 负例试验 | 正确(未调用) | 过度触发率 |
|---|---|---|---|
| English | 6 | 0 | 100% |
| Chinese | 6 | 2 | 67% |

### 1.2 按 service 的正确率

| service | English | Chinese |
|---|---|---|
| auth | 0% (0/12) | 0% (0/12) |
| user | 25% (2/8) | 0% (0/8) |
| chat | 25% (2/8) | 0% (0/8) |
| meeting | 20% (2/10) | 0% (0/10) |
| file | 20% (2/10) | 20% (2/10) |
| fs | 17% (2/12) | 0% (0/12) |
| sharing | 67% (4/6) | 0% (0/6) |
| system | 0% (0/6) | 0% (0/6) |
| discover | 0% (0/2) | 0% (0/2) |
| migrate | 0% (0/4) | 0% (0/4) |

### 1.3 错误模式分类(全错正例)

> 只统计 `correct == 0` 的正例 case(所有试验都没答对期望工具)。分类取该 case
> 首个**错误**选择,按与期望工具的结构关系归入固定枚举。每一类直接对应端侧
> 训练数据需要补的**最小对照对**(minimal pair),不是事后解释性的标签。

**English**:正例 7 全对 / 0 部分对 / **32 全错**(下表只计全错)

| 类别 | case 数 | 例(期望→实选) |
|---|---|---|
| 静默弃答(HTTP 200 但不调用) | 2 | `file-detail` file_detail→∅; `file-delete` file_delete→∅ |
| 同族后缀丢失(x ↔ x_file / x_dir / x_raw ...) | 18 | `auth-status` auth_status→auth_status_raw; `user-list` user_list→user_list_raw; `user-detail` user_detail→user_detail_raw … |
| file↔fs 跨 service 混淆(按 id vs 按路径) | 1 | `fs-search` fs_search→file_search |
| 动词对、service 错(跨 service 塌缩) | 1 | `auth-rename` auth_rename→fs_rename |
| 跨 service 无关误选(近似幻觉) | 9 | `auth-list` auth_list→migrate_verify; `auth-switch` auth_switch→fs_stat; `auth-login` auth_login→fs_mv … |
| 仅 HTTP 失败(无可判定的响应) | 1 | `fs-rm` fs_rm→无 200 响应 |

**Chinese**:正例 1 全对 / 0 部分对 / **38 全错**(下表只计全错)

| 类别 | case 数 | 例(期望→实选) |
|---|---|---|
| 静默弃答(HTTP 200 但不调用) | 13 | `auth-list` auth_list→∅; `auth-logout` auth_logout→∅; `user-list` user_list→∅ … |
| 同族后缀丢失(x ↔ x_file / x_dir / x_raw ...) | 8 | `user-detail` user_detail→user_detail_raw; `user-passwd` user_passwd→user_passwd_raw; `meeting-summary` meeting_summary→meeting_summary_export … |
| 跨 service 无关误选(近似幻觉) | 14 | `auth-status` auth_status→migrate_verify; `auth-switch` auth_switch→fs_stat; `auth-rename` auth_rename→fs_stat … |
| 仅 HTTP 失败(无可判定的响应) | 3 | `chat-send` chat_send→无 200 响应; `meeting-create` meeting_create→无 200 响应; `discover-scan` discover_scan→无 200 响应 |

### 1.4 虚高检测(已注入干扰项)

每个正例 case 对应 **3** 个近义干扰工具。干扰项分两类:

1. **跨 service 混淆** —— 如 `file_search` vs `fs_search`、`file_delete` vs
   `fs_rm`(按 id 操作 vs 按路径操作,是真实产品里最易混的一对)
2. **同族近义兄弟** —— `<期望工具>_raw` / `_export` / `_history` / `_preview` ...

| 指标 | English | Chinese |
|---|---|---|
| 工具正确率 | 18% (14/78) | 3% (2/78) |
| **选了干扰项** | 36/78 (46%) | 16/78 (21%) |
| 其他错误(选别的/不调用/HTTP 失败) | 28/78 | 60/78 |

> 合计被诱导 **52** / 156 次。同族后缀变体与期望工具描述几乎
> 同义、只差名字;跨 service 混淆对(file/fs)则是真实产品里最易混的一组。
> 被诱导的次数越多,基线分数里「词形匹配」的成分越重。

> **读法**:「选了干扰项」= 模型被近义兄弟**诱导**走了。
> 这与「本来就乱选」是两回事 —— 前者说明分数主要来自词法匹配(虚高),
> 后者说明模型连大致方向都没有。
>
> 判读:与无干扰基线(`--distractors 0`)对比,正确率下降幅度即为**虚高幅度**。
> 两组都跑一遍即可量化。

## 2. 逐 case 明细

| case | 语言 | 期望工具 | HTTP | 产出 | 正确 | 实际产出 |
|---|---|---|---|---|---|---|
| `auth-status` | English | `etscli_auth_status` | 2/2 | 2/2 | 0/2 | ["etscli_auth_status_raw"] |
| `auth-list` | English | `etscli_auth_list` | 2/2 | 2/2 | 0/2 | ["etscli_migrate_verify"] |
| `auth-switch` | English | `etscli_auth_switch` | 2/2 | 2/2 | 0/2 | ["etscli_fs_stat"] |
| `auth-rename` | English | `etscli_auth_rename` | 2/2 | 2/2 | 0/2 | ["etscli_fs_rename"] |
| `auth-login` | English | `etscli_auth_login` | 2/2 | 2/2 | 0/2 | ["etscli_fs_mv"] |
| `auth-logout` | English | `etscli_auth_logout` | 2/2 | 2/2 | 0/2 | ["etscli_migrate_verify"] |
| `user-list` | English | `etscli_user_list` | 2/2 | 2/2 | 0/2 | ["etscli_user_list_raw"] |
| `user-detail` | English | `etscli_user_detail` | 2/2 | 2/2 | 0/2 | ["etscli_user_detail_raw"] |
| `user-register` | English | `etscli_user_register` | 2/2 | 2/2 | 2/2 | ["etscli_user_register"] |
| `user-passwd` | English | `etscli_user_passwd` | 2/2 | 2/2 | 0/2 | ["etscli_user_passwd_raw"] |
| `chat-list` | English | `etscli_chat_list` | 2/2 | 2/2 | 2/2 | ["etscli_chat_list"] |
| `chat-messages` | English | `etscli_chat_messages` | 2/2 | 2/2 | 0/2 | ["etscli_chat_messages_history"] |
| `chat-send` | English | `etscli_chat_send` | 2/2 | 2/2 | 0/2 | ["etscli_fs_rm"] |
| `chat-send-file` | English | `etscli_chat_send_file` | 2/2 | 2/2 | 0/2 | ["etscli_migrate_session_login"] |
| `meeting-list` | English | `etscli_meeting_list` | 2/2 | 2/2 | 0/2 | ["etscli_meeting_list_raw"] |
| `meeting-summary` | English | `etscli_meeting_summary` | 2/2 | 2/2 | 0/2 | ["etscli_meeting_summary_raw"] |
| `meeting-detail` | English | `etscli_meeting_detail` | 2/2 | 2/2 | 2/2 | ["etscli_meeting_detail"] |
| `meeting-create` | English | `etscli_meeting_create` | 2/2 | 2/2 | 0/2 | ["etscli_meeting_create_export"] |
| `meeting-finish` | English | `etscli_meeting_finish` | 2/2 | 2/2 | 0/2 | ["etscli_meeting_finish_raw"] |
| `file-search` | English | `etscli_file_search` | 2/2 | 2/2 | 2/2 | ["etscli_file_search"] |
| `file-detail` | English | `etscli_file_detail` | 2/2 | 0/2 | 0/2 | [] (未产出调用) |
| `file-upload` | English | `etscli_file_upload_dir` | 2/2 | 2/2 | 0/2 | ["etscli_file_upload_dir_export"] |
| `file-download` | English | `etscli_file_download` | 2/2 | 2/2 | 0/2 | ["etscli_file_download_raw"] |
| `file-delete` | English | `etscli_file_delete` / `etscli_fs_rm` | 2/2 | 0/2 | 0/2 | [] (未产出调用) |
| `fs-ls` | English | `etscli_fs_ls` | 2/2 | 2/2 | 0/2 | ["etscli_fs_ls_raw"] |
| `fs-mkdir` | English | `etscli_fs_mkdir` | 2/2 | 2/2 | 0/2 | ["etscli_fs_mkdir_export"] |
| `fs-rm` | English | `etscli_fs_rm` / `etscli_file_delete` | 0/2 | 0/0 | 0/2 | — |
| `fs-search` | English | `etscli_fs_search` | 2/2 | 2/2 | 0/2 | ["etscli_file_search"] |
| `fs-stat` | English | `etscli_fs_stats` | 2/2 | 2/2 | 0/2 | ["etscli_fs_stats_raw"] |
| `fs-add` | English | `etscli_fs_add` | 2/2 | 2/2 | 2/2 | ["etscli_fs_add"] |
| `sharing-list` | English | `etscli_sharing_list` | 2/2 | 2/2 | 0/2 | ["etscli_sharing_list_raw"] |
| `sharing-create` | English | `etscli_sharing_create` | 2/2 | 2/2 | 2/2 | ["etscli_sharing_create"] |
| `sharing-delete` | English | `etscli_sharing_delete` | 2/2 | 2/2 | 2/2 | ["etscli_sharing_delete"] |
| `system-info` | English | `etscli_system_info` | 2/2 | 2/2 | 0/2 | ["etscli_system_info_raw"] |
| `system-health` | English | `etscli_system_health` | 2/2 | 2/2 | 0/2 | ["etscli_migrate_verify"] |
| `system-alarm` | English | `etscli_system_alarm_list` | 2/2 | 2/2 | 0/2 | ["etscli_migrate_record"] |
| `discover-scan` | English | `etscli_discover_scan` | 2/2 | 2/2 | 0/2 | ["etscli_system_info"] |
| `migrate-transfer` | English | `etscli_migrate_transfer` | 2/2 | 2/2 | 0/2 | ["etscli_migrate_transfer_raw"] |
| `migrate-verify` | English | `etscli_migrate_verify` | 2/2 | 2/2 | 0/2 | ["etscli_migrate_verify_raw"] |
| `negative-greeting` | English | _不应调用_ | 2/2 | 2/2 | 0/2 | ["etscli_migrate_session_login"] |
| `negative-knowledge` | English | _不应调用_ | 2/2 | 2/2 | 0/2 | ["etscli_fs_mkdir"] |
| `negative-weather` | English | _不应调用_ | 2/2 | 2/2 | 0/2 | ["etscli_migrate_session_login"] |
| `auth-status` | Chinese | `etscli_auth_status` | 2/2 | 2/2 | 0/2 | ["etscli_migrate_verify"] |
| `auth-list` | Chinese | `etscli_auth_list` | 2/2 | 0/2 | 0/2 | [] (未产出调用) |
| `auth-switch` | Chinese | `etscli_auth_switch` | 2/2 | 2/2 | 0/2 | ["etscli_fs_stat"] |
| `auth-rename` | Chinese | `etscli_auth_rename` | 2/2 | 2/2 | 0/2 | ["etscli_fs_stat"] |
| `auth-login` | Chinese | `etscli_auth_login` | 2/2 | 2/2 | 0/2 | ["etscli_fs_rm"] |
| `auth-logout` | Chinese | `etscli_auth_logout` | 2/2 | 0/2 | 0/2 | [] (未产出调用) |
| `user-list` | Chinese | `etscli_user_list` | 2/2 | 0/2 | 0/2 | [] (未产出调用) |
| `user-detail` | Chinese | `etscli_user_detail` | 2/2 | 2/2 | 0/2 | ["etscli_user_detail_raw"] |
| `user-register` | Chinese | `etscli_user_register` | 2/2 | 2/2 | 0/2 | ["etscli_fs_stats"] |
| `user-passwd` | Chinese | `etscli_user_passwd` | 2/2 | 2/2 | 0/2 | ["etscli_user_passwd_raw"] |
| `chat-list` | Chinese | `etscli_chat_list` | 2/2 | 0/2 | 0/2 | [] (未产出调用) |
| `chat-messages` | Chinese | `etscli_chat_messages` | 2/2 | 2/2 | 0/2 | ["etscli_fs_stats"] |
| `chat-send` | Chinese | `etscli_chat_send` | 0/2 | 0/0 | 0/2 | — |
| `chat-send-file` | Chinese | `etscli_chat_send_file` | 2/2 | 2/2 | 0/2 | ["etscli_meeting_summary"] |
| `meeting-list` | Chinese | `etscli_meeting_list` | 2/2 | 0/2 | 0/2 | [] (未产出调用) |
| `meeting-summary` | Chinese | `etscli_meeting_summary` | 2/2 | 2/2 | 0/2 | ["etscli_meeting_summary_export"] |
| `meeting-detail` | Chinese | `etscli_meeting_detail` | 2/2 | 2/2 | 0/2 | ["etscli_fs_stats"] |
| `meeting-create` | Chinese | `etscli_meeting_create` | 0/2 | 0/0 | 0/2 | — |
| `meeting-finish` | Chinese | `etscli_meeting_finish` | 2/2 | 2/2 | 0/2 | ["etscli_meeting_finish_raw"] |
| `file-search` | Chinese | `etscli_file_search` | 2/2 | 0/2 | 0/2 | [] (未产出调用) |
| `file-detail` | Chinese | `etscli_file_detail` | 2/2 | 2/2 | 2/2 | ["etscli_file_detail"] |
| `file-upload` | Chinese | `etscli_file_upload_dir` | 2/2 | 0/2 | 0/2 | [] (未产出调用) |
| `file-download` | Chinese | `etscli_file_download` | 2/2 | 2/2 | 0/2 | ["etscli_file_download_raw"] |
| `file-delete` | Chinese | `etscli_file_delete` / `etscli_fs_rm` | 2/2 | 0/2 | 0/2 | [] (未产出调用) |
| `fs-ls` | Chinese | `etscli_fs_ls` | 2/2 | 2/2 | 0/2 | ["etscli_fs_ls_raw"] |
| `fs-mkdir` | Chinese | `etscli_fs_mkdir` | 2/2 | 2/2 | 0/2 | ["etscli_migrate_session_login"] |
| `fs-rm` | Chinese | `etscli_fs_rm` / `etscli_file_delete` | 2/2 | 0/2 | 0/2 | [] (未产出调用) |
| `fs-search` | Chinese | `etscli_fs_search` | 2/2 | 0/2 | 0/2 | [] (未产出调用) |
| `fs-stat` | Chinese | `etscli_fs_stats` | 2/2 | 2/2 | 0/2 | ["etscli_migrate_session_login"] |
| `fs-add` | Chinese | `etscli_fs_add` | 2/2 | 0/2 | 0/2 | [] (未产出调用) |
| `sharing-list` | Chinese | `etscli_sharing_list` | 2/2 | 2/2 | 0/2 | ["etscli_fs_stats"] |
| `sharing-create` | Chinese | `etscli_sharing_create` | 2/2 | 2/2 | 0/2 | ["etscli_fs_rm"] |
| `sharing-delete` | Chinese | `etscli_sharing_delete` | 2/2 | 0/2 | 0/2 | [] (未产出调用) |
| `system-info` | Chinese | `etscli_system_info` | 2/2 | 2/2 | 0/2 | ["etscli_migrate_verify"] |
| `system-health` | Chinese | `etscli_system_health` | 2/2 | 0/2 | 0/2 | [] (未产出调用) |
| `system-alarm` | Chinese | `etscli_system_alarm_list` | 2/2 | 2/2 | 0/2 | ["etscli_fs_rm"] |
| `discover-scan` | Chinese | `etscli_discover_scan` | 0/2 | 0/0 | 0/2 | — |
| `migrate-transfer` | Chinese | `etscli_migrate_transfer` | 2/2 | 2/2 | 0/2 | ["etscli_migrate_transfer_export"] |
| `migrate-verify` | Chinese | `etscli_migrate_verify` | 2/2 | 2/2 | 0/2 | ["etscli_migrate_verify_raw"] |
| `negative-greeting` | Chinese | _不应调用_ | 2/2 | 2/2 | 0/2 | ["etscli_fs_mkdir"] |
| `negative-knowledge` | Chinese | _不应调用_ | 2/2 | 2/2 | 0/2 | ["etscli_migrate_verify"] |
| `negative-weather` | Chinese | _不应调用_ | 2/2 | 0/2 | 2/2 | [] (未产出调用) |

## 3. 失败样本

**`encoding`**(`fs-rm`,2/2 次):

```
engine error: 'utf-8' codec can't decode bytes in position 266-267: invalid continuation byte
```

## 4. 工具集

共 **47** 个 etscli 工具,全部核对自 `etscli <service> --help`:

| 工具 | 描述 | 参数 |
|---|---|---|
| `etscli_auth_status` | 查看当前 profile 认证状态(含自动重新登录开关) | — |
| `etscli_auth_list` | 列出所有已保存的 profile | — |
| `etscli_auth_switch` | 切换当前使用的 profile | name |
| `etscli_auth_login` | 账号登录并存储凭证 | server, username, password |
| `etscli_auth_logout` | 登出并清除凭证 | — |
| `etscli_auth_rename` | 重命名一个已存在的 profile | old, new |
| `etscli_user_list` | 列出设备上的所有用户 | — |
| `etscli_user_detail` | 查看指定用户的详细信息 | uid |
| `etscli_user_register` | 注册一个新用户 | username, password |
| `etscli_user_passwd` | 修改指定用户的密码 | uid, new_password |
| `etscli_user_delete` | 删除指定用户 | uid |
| `etscli_chat_list` | 列出群聊 | — |
| `etscli_chat_messages` | 查看群聊中的消息 | chat_id |
| `etscli_chat_files` | 查看群聊中的文件 | chat_id |
| `etscli_chat_send` | 向群聊发送一条文字消息 | chat_id, text |
| `etscli_chat_send_file` | 向群聊发送一个文件 | chat_id, file |
| `etscli_meeting_list` | 列出所有会议 | — |
| `etscli_meeting_detail` | 查看指定会议的详细信息 | meeting_id |
| `etscli_meeting_create` | 创建一个新会议 | name |
| `etscli_meeting_finish` | 结束一个进行中的会议 | meeting_id |
| `etscli_meeting_summary` | 获取会议纪要 | meeting_id |
| `etscli_file_search` | 按关键字搜索密盒中的文件 | keyword |
| `etscli_file_detail` | 按 file id 查看文件详情 | file_id |
| `etscli_file_upload` | 上传一个本地文件到密盒 | file |
| `etscli_file_upload_dir` | 上传一个本地目录到密盒 | dir |
| `etscli_file_download` | 按 file id 下载文件到本地 | file_id, output |
| `etscli_file_delete` | 按 file id 删除文件 | file_ids |
| `etscli_fs_ls` | 列出指定目录下的文件 | — |
| `etscli_fs_mkdir` | 创建一个目录 | path |
| `etscli_fs_stat` | 查看文件的状态信息(stat) | path |
| `etscli_fs_stats` | 查看目录的统计信息 | path |
| `etscli_fs_rm` | 按路径删除文件或目录 | path |
| `etscli_fs_mv` | 按路径移动文件或目录 | src, dst |
| `etscli_fs_rename` | 按路径重命名文件或目录 | src, dst |
| `etscli_fs_search` | 按名称在目录下搜索文件 | — |
| `etscli_fs_add` | 把本地文件添加到密盒的指定目录 | local, remote |
| `etscli_sharing_list` | 列出所有分享链接 | — |
| `etscli_sharing_create` | 为文件创建分享链接 | file_id |
| `etscli_sharing_delete` | 删除一个分享链接 | share_id |
| `etscli_system_info` | 查看设备的系统信息 | — |
| `etscli_system_health` | 查看设备的健康状态 | — |
| `etscli_system_alarm_list` | 列出设备上的告警 | — |
| `etscli_discover_scan` | 扫描局域网中的密盒设备 | — |
| `etscli_migrate_session_login` | 为迁移流程建立会话 | — |
| `etscli_migrate_transfer` | 把旧设备的数据迁移到当前设备 | — |
| `etscli_migrate_verify` | 验证迁移结果 | — |
| `etscli_migrate_record` | 查看迁移记录 | — |

## 5. 结论

- English 工具选择正确率 **18%**,Chinese **3%**。
- ❌ 未达门槛(`EN ≥ 70%` / `CN ≥ 50%` / 契约零违规),建议保持关闭。

> 换用端侧模型后用同一命令复测,`--url` 指向新服务即可:
> `python3 scripts/etscli-tools-test.py --url <新模型> --rounds 3`
