> # ⚠️ 阅读前必看:本报告的适用范围
>
> 本报告基于**合成场景**(「列出 .md 文件」+ 通用 `bash/glob` 工具描述)。
>
> **其中的「English 100% 有效产出」不代表真实能力。** 后续用
> [etscli 真实场景套件](../etscli-tools/report.md)复测发现:
> needle 在 etscli 场景下**命令正确率仅 5%**(18 个正例全部不产出调用)。
>
> 即:needle 的高分是**过拟合到「列文件 → 调 bash」这一简单模式**的,
> 换到真实目标领域即归零。
>
> 本报告中**仍然成立**的结论:
> - 中文 502 `utf8_decode`(输出缓冲区截断)—— 与场景无关,已定位到 `_worker.py`
> - 中文 `calls: []` 静默失败 —— 与场景无关
> - 中文有效产出 0%
>
> 本报告中**已被推翻**的结论:
> - ~~English 100% 可用~~ → 仅为合成场景下的过拟合表现
>
> 保留本报告是为了记录 needle 的引擎层缺陷(与测试语料无关),
> **能力评估请以 etscli 套件为准**。

# cactus-needle 中英文能力测试报告

> 机读产物:[`results.json`](results.json)(逐 case 逐次的原始判定)

- **生成时间**: 20260928T045556Z
- **被测服务**: `http://127.0.0.1:8081/extract` (cactus-needle 3.0.1)
- **每 case 重复次数**: 9
- **方法学(v2)**:工具集**固定且适配所有 query**(glob/read/bash/web_search/web_fetch),
  只变**语言 × query 长度**两个变量;中英语义等价,逐档加长

## 1. 最终判定

| 能力 | English | Chinese |
|---|---|---|
| HTTP 200(不报错) | **100%** | 67% |
| **有效 tool call 产出** | **100%** | **0%** |
| 中位延迟 | 6.2s | 7.8s |

> **English:可用。** 工具集适配时稳定返回 `function_calls`,三档长度均 100% 有效产出。
> 
> **Chinese:不可用。** 有效 tool call 产出 **0%**(0/9)—— 无论 query 长短。
> 中文有**两种失败形态,且不按长度整齐分离**:
> 
> - **崩溃式** —— 返回 502 `utf8_decode`(实测出现在 **short** 档)
> - **静默式** —— 返回 200 但 `function_calls: []`,部分还报 `confidence≈0.9`(实测在 **medium/long** 档)
> 
> 两种形态**功能上等价** —— 都拿不到 tool call,plugin 都只能 fall through。
> 区别只在可观测性:502 会报错,静默式**不报错**,调用方若只看 HTTP 状态会误判为健康。
> 
> 引擎 `/health` 声明的 `cn_grounding: true` 与实测(中文有效产出 0%)严重不符。
>
### 1.1 长度维度拆解

| query 长度 | English HTTP / 产出 | Chinese HTTP / 产出 |
|---|---|---|
| short | 9/9 / 1/1/1/1/1/1/1/1/1 | 0/9 / — |
| medium | 9/9 / 1/1/1/1/1/1/1/1/1 | 9/9 / 0/0/0/0/0/0/0/0/0 |
| long | 9/9 / 1/1/1/1/1/1/1/1/1 | 9/9 / 0/0/0/0/0/0/0/0/0 |

> 格式为 `HTTP 成功次数/试验次数` / `每次的 function_calls 数`
>
> **注意方向与直觉相反**:中文**短** query 反而崩溃(502),**中长** query 反而
> 200 但空产出。原因是输出缓冲区截断取决于**模型实际生成多长**,
> 而非 query 本身长度 —— 短 query 可能触发更长推理,更早撞上 ~200 字节上限。
> 所以两种中文失败形态**不按长度整齐分离**,不能用长度预测会不会崩。
>
### 1.2 v1 方法学缺陷(已修正,勿再引用 v1 结论)

v1 用「工具目录取前 n 个」来变 tool 数量,导致**工具可用性成为隐藏变量**:
`en-01` 集合里只有 `[skill]`,而 query 是「列出 .md 文件」—— 压根没有文件工具,
`calls: []` 属于**合理应答**,却被计入失败,误报成「英文有效产出仅 20%」。

v2 固定工具集后,英文有效产出为 100%,**v1 关于英文的结论作废**。

## 2. 逐 case 明细

| case | 语言 | 长度 | HTTP | 有效产出 | calls(每次) | conf(每次) | 失败类型 |
|---|---|---|---|---|---|---|---|
| `en-short` | English | short | 9/9 | 9/9 | (1,1,1,1,1,1,1,1,1) | (0.99,0.99,0.99,0.99,0.99,0.99,0.99,0.99,0.99) | — |
| `en-medium` | English | medium | 9/9 | 9/9 | (1,1,1,1,1,1,1,1,1) | (0.51,0.51,0.51,0.51,0.51,0.51,0.51,0.51,0.51) | — |
| `en-long` | English | long | 9/9 | 9/9 | (1,1,1,1,1,1,1,1,1) | (0.45,0.45,0.45,0.45,0.45,0.45,0.45,0.45,0.45) | — |
| `cn-short` | Chinese | short | 0/9 | 0/9 | — | — | utf8_decode×9 |
| `cn-medium` | Chinese | medium | 9/9 | 0/9 | (0,0,0,0,0,0,0,0,0) | (0.72,0.72,0.72,0.72,0.72,0.72,0.72,0.72,0.72) | — |
| `cn-long` | Chinese | long | 9/9 | 0/9 | (0,0,0,0,0,0,0,0,0) | (0.66,0.66,0.66,0.66,0.66,0.66,0.66,0.66,0.66) | — |

> 同一 case 内 3 次试验的 confidence 完全相同 —— 引擎为**贪心解码**,
> 对同一 (query, tools) 永远返回同一结果。因此失败是**稳定复现**的,不是随机波动。

## 3. 失败样本

**`utf8_decode`**(case `cn-short`,Chinese,9/9 次命中):

```
engine error: 'utf-8' codec can't decode bytes in position 218-219: invalid continuation byte
```

## 4. 复现步骤

```bash
# 1. 启动 needle-http
docker start needle-http

# 2. 跑本套件
python3 scripts/needle-cn-en-compat-test.py --trials 9

# 3. 手工对照(单次)
curl -s -X POST http://127.0.0.1:8081/extract -H 'content-type: application/json' \
  -d '{"query":"list all .md files under /home/etsme/work",
       "tools":[{"name":"bash","description":"run shell","parameters":{"type":"object","properties":{}}}],
       "system":"date: 2026-09-28 Mon; locale: en-US"}'   # → 200

curl -s -X POST http://127.0.0.1:8081/extract -H 'content-type: application/json' \
  -d '{"query":"列出 /home/etsme/work 下的所有 .md 文件",
       "tools":[{"name":"bash","description":"run shell","parameters":{"type":"object","properties":{}}}],
       "system":"date: 2026-09-28 Mon; locale: zh-CN"}'   # → 502 utf-8
```

## 5. 影响评估

### 5.1 英文侧:无阻塞问题

英文有效 tool call 产出 100%,延迟中位 6.2s。
除长 query 的缓冲区截断风险外,英文路径本身可用。

### 5.2 中文侧:两重独立故障

**故障 A —— 提取不出工具(静默失败,危害更大)**

返回 HTTP 200 但 `function_calls: []`。这不是「判断无需调工具」,因为 query 明确要求
文件操作;且部分 case 报 `confidence ≈ 0.9` 却零产出 —— **高置信度的空答案**,
调用方若只看 confidence 或 HTTP 状态会被误导。**这比 502 更危险,因为它不报错。**

**故障 B —— 输出缓冲区截断崩溃(显式失败)**

输出超出引擎缓冲区,截断点落进多字节 UTF-8 字符中间 → 502 `utf8_decode`。
定位见 `~/work/needle/needle/_worker.py:90-109`。
实测出现在 **short** 档而非长档 —— 截断取决于模型生成多长,与 query 长度非线性。

### 5.3 对 dsh-edge-agent 的净效果

`function-call-external` 把用户 query 原样 POST 给 needle。dsh-edge-agent 是中文产品,
所以走的是**两条都堵**的路径:

| 情况 | 占比 | plugin 代价 |
|---|---|---|
| HTTP 502(长 query) | 33% | 等满 timeout 才 fall through + 熔断器反复开关 |
| HTTP 200 但产出空(短 query) | 67% | 白等一轮 latency,prefill 完全无效 |
| 有效产出 | 0% | 真正帮上忙 |

**结论**:`FUNCTION_CALL_EXTERNAL_ENABLED` 保持 **false**。
开启对中文用户是净损耗 —— 唯一收益路径(短 query 提取到工具)实测为 0%。

**但这不否定 §7.94 的架构决策**:`ExternalToolCaller` 抽象的价值正在于此 ——
引擎不可用时零成本规避(关开关),换成合格实现时零成本切换(改 URL)。
等自训端侧模型就位后,实现同一份 HTTP 契约即可接入,plugin 一行不改。

## 6. 建议修复(按优先级)

1. **[阻断-A]中文 tool call 提取能力** —— 这是最根本的问题:引擎对中文 query
   不产出 tool call。需排查 tokenizer 的 CJK 覆盖率 / 训练语料中中文 tool-call 样本占比。
   修好这一条,即使 B 未修,短中文 query 也能用。
2. **[阻断-B]输出缓冲区上限** —— 提高 native 库输出上限(实际生效约 200 字节,
   远低于 Python 侧 `create_string_buffer(65536)` 的声明值),或改为按字节返回长度
   而非依赖 NUL 截断。
3. **[阻断-B]截断回退到字符边界** —— 截断时向前回退到最近的 UTF-8 字符起始位再返回,
   避免把半个多字节字符交给调用方。
4. **[质量]空产出不应静默** —— `calls: []` 且 `confidence` 很高属于自相矛盾,
   建议对 `type: respond` 要求低 confidence,或在响应中显式区分
   「判断无需调工具」与「提取失败」。
5. **[测试]补 CJK 回归用例** —— 现有测试似仅覆盖 ASCII,两重故障都因此未被发现。
6. **[声明]`cn_grounding: true`** —— 与实测(中文有效产出 0%)严重不符,
   修复前建议在 /health 中如实反映。
