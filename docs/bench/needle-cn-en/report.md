# cactus-needle 中英文兼容性测试报告

- **生成时间**: 20260928T022057Z
- **被测服务**: `http://127.0.0.1:8081/extract` (cactus-needle 3.0.1)
- **每 case 重复次数**: 3
- **方法**: 固定 tool schema 目录,只变语言与 tool 数量;中文/英文 query 语义等价

## 1. 结论摘要

| 语言 | HTTP 成功率 | **有效产出率** | 中位延迟 | 失败类型分布 |
|---|---|---|---|---|
| English | 100% (15/15) | **20%** (3/15) | 8.4s | — |
| Chinese | 20% (3/15) | **0%** (0/15) | 7.7s | utf8_decode×12 |

> **两个指标的区别很重要**:`HTTP 成功率` 只说明请求没报错;
> `有效产出率` 才说明**真的返回了至少一个 function_call**(即 prefill 有用)。
> 英文 HTTP 100% 成功,但绝大多数成功响应里 `function_calls` 是空的 ——
> 对 dsh-edge-agent 而言,空产出与 502 等价(prefill 拿不到东西,只能 fall through)。

## 2. 逐 case 结果

| case | 语言 | tools | 成功 | 失败 | 成功率 | 延迟(min/max) | 产出 calls | 平均 conf | 失败类型 |
|---|---|---|---|---|---|---|---|---|---|
| `en-01` | English | 1 | 3 | 0 | 100% | 3.4/5.7s | 0/3 | 1.000 | — |
| `en-03` | English | 3 | 3 | 0 | 100% | 1.4/12.7s | 0/3 | 0.643 | — |
| `en-05` | English | 5 | 3 | 0 | 100% | 5.3/20.6s | 0/3 | 0.611 | — |
| `en-08` | English | 8 | 3 | 0 | 100% | 5.2/19.0s | 3/3 | 0.549 | — |
| `en-13` | English | 13 | 3 | 0 | 100% | 10.2/23.5s | 0/3 | 0.529 | — |
| `cn-01` | Chinese | 1 | 0 | 3 | 0% | 3.0/9.3s | — | — | utf8_decode×3 |
| `cn-03` | Chinese | 3 | 0 | 3 | 0% | 1.6/9.0s | — | — | utf8_decode×3 |
| `cn-05` | Chinese | 5 | 0 | 3 | 0% | 4.4/8.5s | — | — | utf8_decode×3 |
| `cn-08` | Chinese | 8 | 3 | 0 | 100% | 10.4/13.8s | 0/3 | 0.719 | — |
| `cn-13` | Chinese | 13 | 0 | 3 | 0% | 2.8/24.5s | — | — | utf8_decode×3 |

## 3. 失败样本

**`utf8_decode`**(case `cn-01`,Chinese,3/3 次命中):

```
engine error: 'utf-8' codec can't decode bytes in position 237-238: invalid continuation byte
```

## 4. 复现步骤

```bash
# 1. 启动 needle-http
docker start needle-http

# 2. 跑本套件
python3 scripts/needle-cn-en-compat-test.py --trials 3

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

### 5.1 首要问题:即使 HTTP 成功,产出也基本为空

英文 15 次 HTTP 成功中,只有 3 次返回了非空 `function_calls`。
典型反常:部分 case 报 `confidence` 接近 1.0 却 `function_calls: []` ——
模型"非常确定"地认为不需要调用工具。对 prefill 场景,空产出 = 无用,与 502 等价。

### 5.2 次要问题:中文请求大面积 502

中文 HTTP 成功率 20%,失败全部为 `utf8_decode`。
失败与 tool 数量、query 长度无关,表现为引擎输出缓冲区截断时切断多字节 UTF-8 字符。
两次独立运行结果完全一致(同 9 个 case 的通过/失败模式),可稳定复现。

### 5.3 对 dsh-edge-agent 的净效果

`function-call-external` 把用户 query 原样 POST 给 needle。对中文用户:

| 情况 | 占比 | plugin 代价 |
|---|---|---|
| HTTP 502 | 80% | 等满 timeout 才 fall through + 熔断器开关 |
| HTTP 200 但产出空 | 20% | 白等一轮 latency,prefill 无效 |
| 有效产出 | 0% | 真正帮上忙 |

故默认 `FUNCTION_CALL_EXTERNAL_ENABLED=false`。等引擎侧修复且有效产出率显著提升后再评估启用。

## 6. 建议修复(按优先级)

1. **[阻断性]中文 UTF-8 截断** —— 提高 native 库输出缓冲区上限
   (当前实际生效约 200 字节,远低于 Python 侧 `create_string_buffer(65536)` 的声明值),
   或改为按字节返回长度而非依赖 NUL 截断。
2. **[阻断性]截断边界** —— 截断时向前回退到最近的 UTF-8 字符起始位再返回,
   避免把半个多字节字符交给调用方。
3. **[质量]有效产出率** —— HTTP 成功率不代表可用。当前英文成功多数产出空
   `function_calls`,建议在 /health 或 /extract 响应中暴露该指标,便于调用方决策。
4. **[测试]补 CJK 回归用例** —— 现有测试似仅覆盖 ASCII,故该缺陷未被发现。
5. **[声明]`cn_grounding: true`** —— 与实测行为(中文大面积失败)不符,
   修复前建议在 /health 中如实反映。
