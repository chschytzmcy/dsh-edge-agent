/**
 * Pipeline flow view (§7.106): the current turn condensed into a five-node
 * vertical flow — attack detection → intent classification → PII sanitize →
 * routing verdict → answer egress — each node carrying a headline verdict
 * plus evidence lines built from the very audit rows below it (the override
 * pair, the from→to route rewrite, step latencies, the egress declaration).
 *
 * Pure function of the already turn-filtered rows: every word derives from a
 * recorded kind; a stage with no rows says "等待", never a fabricated green.
 *
 * §7.107 (2026-10-23, desktop deployment round) — the panel was honest but
 * not tidy. Three defects the desktop shot exposed, all fixed here:
 *
 *  1. The intent node only read the LLM classifier (`intent.classify.*`), so
 *     a turn the **privacy-policy tier** decided (`input-guard.policy
 *     .route-applied`) — the classifier never ran, the policy short-circuits
 *     it — sat on "等待" while the routing node below announced the verdict.
 *     The policy tier IS an intent verdict and is now read as one.
 *  2. The routing node took the LAST `input-guard.route.overridden` row.
 *     The guard re-announces the rewrite on every answer step, and those
 *     later rows are local→local no-ops — the panel showed
 *     "改写 local-llm/X → local-llm/X" instead of the one line that actually
 *     matters (host model → local model). Only a real change counts now.
 *  3. Evidence lines mixed raw identifiers into the Chinese prose
 *     ("判定 dataClass=public", "理由 intent-local") and repeated the
 *     headline ("干净（公开级）" + "判定 dataClass=public" side by side).
 *     Identifiers are now translated, the duplicate verdict is gone, and
 *     every node renders with the same three-level rhythm.
 */
import { createElement as h } from 'react'
import type { ReactElement } from 'react'
import type { EdgeRow, EdgeSummary } from './types'
import { tr } from './i18n'

type Tone = 'wait' | 'run' | 'ok' | 'warn' | 'stop' | 'info'

interface FlowNode {
  label: string
  tone: Tone
  detail: string
  /** Evidence lines rendered small under the headline. */
  sub: string[]
}

/** rowsFor output is oldest-first; "latest row of a kind" is therefore the tail. */
const latest = (rows: EdgeRow[], match: (r: EdgeRow) => boolean): EdgeRow | undefined =>
  [...rows].reverse().find(match)

const field = (r: EdgeRow | undefined, key: string): unknown => r?.payload[key]
const rationaleStr = (r: EdgeRow): string => typeof r.payload.rationale === 'string' ? r.payload.rationale : ''
const ms = (v: unknown): string => typeof v === 'number' ? `${(v / 1000).toFixed(1)}s` : '?'
/** Present any scalar for the evidence line; numbers included (textLen
   landed as '?' when this only accepted strings — 2026-10-23 flow shot). */
const str = (v: unknown): string => typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '?'
const num = (v: unknown): number | undefined => typeof v === 'number' ? v : undefined
const pct = (v: unknown): string => typeof v === 'number' ? `${(v * 100).toFixed(0)}%` : '?'

/** Data-class names reach the panel as raw enum values; the panel speaks the
 *  operator's language, so the enum is translated and the raw spelling kept
 *  only in parentheses for forensics. */
function classLabel(cls: string): string {
  const key = `flow.class.${cls}`
  const label = tr(key)
  return label === key ? cls : `${label}（${cls}）`
}

/** A long regex (the policy pattern) must not blow up the narrow sidebar. */
function clip(v: string, max = 44): string {
  return v.length <= max ? v : `${v.slice(0, max - 1)}…`
}

/** §7.121: 数组型命中明细（规则名 / PII 类型 / 占位符）读成一行。
 *  后端 safePayload 现在保留字符串数组（§7.121），这里负责渲染。 */
function list(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** §7.122: 未知 path 的兜底 —— 宁可显示机器码原文，也不要显示一个
 *  会误导的「分类器 X」（那正是本次要修的毛病）。 */
function decidedByFallback(path: string): string {
  return path.length > 0 ? path : tr('flow.intent.byUnknown')
}

function guardNode(rows: EdgeRow[]): FlowNode {
  const end = latest(rows, r => r.kind === 'guard.model-detect.end')
  const unsafe = latest(rows, r => r.kind === 'guard.model-detect.unsafe')
  const err = latest(rows, r => /^guard\.model-detect\.(error|timeout|provider_error)$/.test(r.kind))
  const skipped = latest(rows, r => /^guard\.model-detect\.skip/.test(r.kind))
  const started = latest(rows, r => r.kind === 'guard.model-detect.start')
  const injection = latest(rows, r => r.kind === 'input.injection.warned' || r.kind === 'input.injection')
  if (injection !== undefined && (unsafe === undefined && end === undefined)) {
    // §7.121: 原始判断数据 —— 命中了哪条规则 + 那条规则的**正则原文**。
    //  光有「命中告警级注入特征」等于没给证据：operator 无法判断是误报
    //  还是规则本身写宽了。
    const names = list(field(injection, 'patterns'))
    const sources = list(field(injection, 'patternSources'))
    const sub: string[] = []
    if (names.length > 0) sub.push(`${tr('flow.lbl.hit')} ${names.join(', ')}`)
    if (sources.length > 0) sub.push(`${tr('flow.lbl.regex')} ${clip(sources[0], 40)}`)
    if (sub.length === 0) sub.push(tr('flow.g.guardrule'))
    return {
      label: tr('flow.guard'), tone: 'warn',
      detail: tr('flow.guard.injection'),
      sub,
    }
  }
  if (err !== undefined && (end === undefined || err.ts > end.ts)) {
    return {
      label: tr('flow.guard'), tone: 'warn',
      detail: tr('flow.guard.failopen'),
      sub: [
        `${tr('flow.lbl.cause')} ${str(field(err, 'reason'))} · ${ms(field(err, 'durationMs'))}`,
        tr('flow.g.regexOn'),
      ],
    }
  }
  if (unsafe !== undefined) {
    // §7.121: 原始判断数据 —— 模型判不安全的**威胁类型**与**理由**。
    const threats = list(field(unsafe, 'threats'))
    const sub: string[] = []
    if (threats.length > 0) sub.push(`${tr('flow.lbl.hit')} ${threats.join(', ')}`)
    const rationale = field(unsafe, 'rationale')
    if (typeof rationale === 'string' && rationale.length > 0) sub.push(`${tr('flow.lbl.why')} ${clip(rationale, 40)}`)
    sub.push(`${tr('flow.lbl.model')} ${str(field(unsafe, 'provider'))}/${str(field(unsafe, 'model'))} · ${ms(field(unsafe, 'durationMs'))}`)
    return {
      label: tr('flow.guard'), tone: 'stop',
      detail: `${tr('flow.guard.unsafe')} · ${str(field(unsafe, 'dataClass'))}`,
      sub,
    }
  }
  if (end !== undefined) {
    const cls = typeof end.payload.dataClass === 'string' ? end.payload.dataClass : '?'
    // The headline already says the verdict ("干净（公开级）"); repeating it
    // as "判定 dataClass=public" underneath was noise in a narrow column.
    // The evidence line now carries what the headline cannot: who judged,
    // how long it took, how much text was scanned.
    const sub = [
      // §7.179：显示**真实落点**。DELEGATE 模式下本地池把请求转发给宿主
      // provider（§7.171）⇒ 真正跑的是宿主那个模型，不是路由名 local-llm。
      // `modelProvider` 是 adapter 侧解析出来的实际落点，缺省才退回路由名。
      `${tr('flow.lbl.model')} ${str(field(end, 'modelProvider') ?? field(end, 'provider'))}/${str(field(end, 'model'))}`,
      `${tr('flow.lbl.elapsed')} ${ms(field(end, 'durationMs'))} · ${tr('flow.lbl.scanned')} ${str(field(end, 'textLen'))} ${tr('flow.lbl.chars')}`,
    ]
    // §7.121: 原始判断数据 —— 模型判「安全」的**理由原文**（§7.121 起
    //  guard.model-detect.end 落 rationale）。这是「为什么判安全」的唯一
    //  出处，此前整条链路都丢了。
    const rationale = field(end, 'rationale')
    if (typeof rationale === 'string' && rationale.length > 0) {
      sub.push(`${tr('flow.lbl.why')} ${clip(rationale, 40)}`)
    }
    // 正则档命中的规则也要在「安全」轮次露出：模型说安全，但正则档
    // 命中了 warn 规则 —— 两者并存才是完整的判断依据。
    if (injection !== undefined) {
      const names = list(field(injection, 'patterns'))
      if (names.length > 0) sub.push(`${tr('flow.lbl.hit')} ${names.join(', ')}`)
    }
    return {
      label: tr('flow.guard'), tone: 'ok',
      detail: cls === 'public' ? tr('flow.guard.public') : classLabel(cls),
      sub,
    }
  }
  if (skipped !== undefined) {
    const sub: string[] = []
    const reason = field(skipped, 'reason')
    if (typeof reason === 'string' && reason.length > 0) sub.push(`${tr('flow.lbl.cause')} ${reason}`)
    const pattern = field(skipped, 'rationale')
    if (typeof pattern === 'string' && pattern.length > 0) sub.push(`${tr('flow.lbl.why')} ${clip(pattern, 40)}`)
    return { label: tr('flow.guard'), tone: 'ok', detail: tr('flow.guard.skipped'), sub }
  }
  if (started !== undefined) return { label: tr('flow.guard'), tone: 'run', detail: tr('flow.guard.running'), sub: [] }
  return { label: tr('flow.guard'), tone: 'wait', detail: tr('flow.wait'), sub: [] }
}

function intentNode(rows: EdgeRow[]): FlowNode {
  const end = latest(rows, r => r.kind === 'intent.classify.end')
  const override = latest(rows, r => r.kind === 'intent.classify.entity_override')
  const rejected = latest(rows, r => r.kind === 'intent.rules.rejected')
  const started = latest(rows, r => r.kind === 'intent.classify.start')
  // §7.121: jev（决策模型）的**原始返回** —— intent/confidence/riskScore。
  // 此前只有 intent.classify.end 的转述结论，「模型到底怎么说的」不可见。
  const jev = latest(rows, r => r.kind === 'intent.jev.response')
  // §7.107: the privacy-policy tier decides BEFORE the classifier runs
  // (input-guard.ts §7.87.13.2 short-circuits the LLM call). A turn decided
  // by the policy therefore has NO intent.classify.* row at all — reading
  // only the classifier left the node on "等待" while the routing node
  // below announced the verdict. The policy tier is an intent verdict.
  const policy = latest(rows, r => r.kind === 'input-guard.policy.route-applied')
  if (rejected !== undefined && (end === undefined || rejected.ts > end.ts)) {
    // §7.121: 拒绝也要给原始依据 —— 命中的意图 + 风险分。
    const sub: string[] = []
    const risk = field(rejected, 'riskScore')
    if (typeof risk === 'number') sub.push(`${tr('flow.lbl.risk')} ${risk.toFixed(2)}`)
    const intent = field(rejected, 'intent')
    if (typeof intent === 'string' && intent.length > 0) sub.push(`${tr('flow.lbl.hit')} ${intent}`)
    return { label: tr('flow.intent'), tone: 'stop', detail: tr('flow.intent.rejected'), sub }
  }
  if (end !== undefined) {
    const cat = str(field(end, 'category'))
    const conf = pct(field(end, 'confidence'))
    const sub: string[] = [`${tr('flow.lbl.verdict')} ${cat} · ${conf} · ${str(field(end, 'rationale'))}`]
    if (override !== undefined && override.ts <= end.ts) {
      sub.push(`${tr('flow.lbl.override')} ${str(field(override, 'from'))} → ${str(field(override, 'to'))} · ${tr('flow.lbl.entity')} ${str(field(override, 'entity'))}`)
      sub.push(`${tr('flow.lbl.llmSay')} ${str(field(override, 'llmRationale'))} · ${pct(field(override, 'llmConfidence'))} ${tr('flow.lbl.overridden')}`)
    }
    // classifier/textLen live on the classify.start row; duration/category on end.
    const startRow = latest(rows, r => r.kind === 'intent.classify.start')
    const textLen = field(end, 'textLen') ?? field(startRow, 'textLen')
    // §7.122: 「分类器」这一行此前**无条件**显示配置里的 provider 名，
    // 但那是**备用**分类器 —— jev 预筛命中时 LLM 分类器压根没被调用。
    // 面板要显示**本轮实际是谁判的**，所以按 path 分支：
    //   jev-adopt* → 决策模型裁决（LLM 分类器未调用）
    //   llm*      → LLM 分类器裁决
    //   cache     → 缓存命中
    //   rules-*   → 规则档裁决
    // 同时标出 provider 的**真实落点**（provider 名里的 "local" 不代表落
    // 点在本机 —— config/edge.json 的 llm.local.baseUrl 可以是公网）。
    const pathRaw = field(end, 'path')
    const path = typeof pathRaw === 'string' ? pathRaw : ''
    const classifierProvider = str(field(startRow, 'classifier'))
    // §7.179：真实落点。DELEGATE 模式下分类器跑在宿主 provider 上（§7.171），
    // 路由名 `local-llm` 不是落点 —— 显示真实落点才不与实际行为相反。
    const classifierLanding = str(field(startRow, 'modelProvider') ?? classifierProvider)
    const classifierEndpoint = field(startRow, 'classifierEndpoint')
    const classifierIsLocal = field(startRow, 'classifierIsLocal')
    const jevDecided = path.startsWith('jev-adopt') || path.startsWith('jev-reject')
    const llmDecided = path.startsWith('llm')
    const decidedBy = jevDecided
      ? tr('flow.intent.byJev')
      : llmDecided
        ? tr('flow.intent.byLlm')
        : path === 'cache'
          ? tr('flow.intent.byCache')
          : path.startsWith('rules-')
            ? tr('flow.intent.byRules')
            : path === 'gate-no-web-need'
              ? tr('flow.intent.byGate')
              : path === 'device-command'
                ? tr('flow.intent.byDeviceCommand')
                : decidedByFallback(path)
    // 裁决者身份：LLM 路径带上 provider/model 实体；其它路径不带
    // （jev / 缓存 / 规则档的「模型身份」在各自的证据行里）。
    const classifierModel = str(field(startRow, 'model'))
    const identity = llmDecided && classifierModel !== '?'
      ? ` ${classifierLanding}/${classifierModel}`
      : llmDecided ? ` ${classifierLanding}` : ''
    sub.push(`${tr('flow.lbl.decidedBy')} ${decidedBy}${identity}`)
    // 真实落点 —— operator 判断「原文有没有出网」要看的不是 provider 名
    if (typeof classifierEndpoint === 'string' && classifierEndpoint.length > 0) {
      const localMark = classifierIsLocal === true ? tr('flow.lbl.onDevice') : tr('flow.lbl.offDevice')
      sub.push(`${tr('flow.lbl.endpoint')} ${clip(classifierEndpoint, 34)} · ${localMark}`)
    }
    sub.push(`${tr('flow.lbl.elapsed')} ${ms(field(end, 'durationMs'))} · ${tr('flow.lbl.scanned')} ${str(textLen)} ${tr('flow.lbl.chars')}`)
    // §7.121: 原始判断数据 —— 命中了**哪个关键字**（规则档的正则命中），
    // 以及分类器对该档位的**语义说明**。§7.113 已把这两个字段写进
    // classify.end，但只有 rows 面板读，flow 面板一直读不到。
    const keyword = field(end, 'keyword')
    if (typeof keyword === 'string' && keyword.length > 0) {
      sub.push(`${tr('flow.lbl.keyword')} ${clip(keyword, 30)}`)
    }
    const semantic = field(end, 'semantic')
    if (typeof semantic === 'string' && semantic.length > 0) {
      sub.push(`${tr('flow.lbl.semantic')} ${clip(semantic, 40)}`)
    }
    // §7.121: 决策路径的**机器码**（llm / jev-adopt / cache / rules-* …），
    // 让 operator 分得清「这次是缓存命中」还是「真判了一次」。
    // §7.122: 路径已并入「裁决者」行；这里只在裁决者行没带出路径时补。
    if (typeof pathRaw === 'string' && pathRaw.length > 0 && !jevDecided && !llmDecided && path !== 'cache') {
      sub.push(`${tr('flow.lbl.path')} ${pathRaw}`)
    }
    // §7.121: jev 决策模型的原始返回（intent / confidence / riskScore）。
    // 优先读 classify.end 上已并入的 jev* 字段（那条路径恒为 info 级），
    // 回退到 intent.jev.response 行（本地流那条路径可能是 debug 级，
    // 会被 audit 的 minLevel 挡掉而收不到）。
    const jevIntent = field(end, 'jevIntent')
    const jevConf = field(end, 'jevConfidence')
    const jevRisk = field(end, 'jevRiskScore')
    const jevParts: string[] = []
    if (typeof jevIntent === 'string' && jevIntent.length > 0) jevParts.push(`intent=${jevIntent}`)
    if (typeof jevConf === 'number') jevParts.push(`confidence=${jevConf.toFixed(2)}`)
    if (typeof jevRisk === 'number') jevParts.push(`riskScore=${jevRisk.toFixed(2)}`)
    if (jevParts.length > 0) {
      const jevProvider = jev !== undefined ? str(field(jev, 'provider')) : '?'
      const jevModel = jev !== undefined ? str(field(jev, 'model')) : '?'
      sub.push(`${tr('flow.lbl.jev')} ${jevProvider}/${jevModel} · ${jevParts.join(' · ')}`)
    }
    // `default:sanitized` rationale = the classifier never returned a verdict
    // (error/timeout upstream — e.g. the model answered non-JSON). Surface
    // WHY from the error rows instead of pretending an LLM decided.
    const isDefault = rationaleStr(end).startsWith('default:')
    // §7.107: the router's public-web gate — the classifier said CLOUD, the
    // gate kept the turn on the device because nothing asked for the public
    // web. The row's own rationale says so; name it in the headline too.
    const noWebNeed = rationaleStr(end) === 'no-web-need'
    if (isDefault) {
      const causeRow = latest(rows, r => /^intent\.(classify\.llm_error|llm\.(timeout|error|provider_error))$/u.test(r.kind))
      if (causeRow !== undefined) sub.push(`${tr('flow.lbl.cause')} ${str(field(causeRow, 'error') ?? field(causeRow, 'reason'))} → ${str(causeRow.kind)}`)
      else sub.push(tr('flow.intent.defaultNoCause'))
    }
    if (noWebNeed) sub.push(tr('flow.intent.noWebNeedWhy'))
    // §7.122: headline 里的「LLM 裁决」此前是**假定** classifier 判的 ——
    // jev 预筛命中时实际是决策模型判的。把 headline 改成跟随裁决者。
    const viaLabel = isDefault
      ? tr('flow.intent.viaDefault')
      : override !== undefined && override.ts <= end.ts
        ? tr('flow.intent.viaEntity')
        : jevDecided
          ? tr('flow.intent.viaJev')
          : llmDecided
            ? tr('flow.intent.viaLlm')
            : path === 'cache'
              ? tr('flow.intent.viaCache')
              : path.startsWith('rules-')
                ? tr('flow.intent.viaRules')
                : path === 'device-command'
                  ? tr('flow.intent.viaDeviceCommand')
                  : tr('flow.intent.viaLlm')
    return {
      label: tr('flow.intent'), tone: isDefault ? 'warn' : 'ok',
      detail: noWebNeed
        ? `${cat} ${conf} · ${tr('flow.intent.noWebNeed')}`
        : `${cat} ${conf} · ${viaLabel}`,
      sub,
    }
  }
  if (policy !== undefined) {
    // Policy tier verdict — no classifier ran, and none was needed.
    const realm = str(field(policy, 'policyRealm'))
    const confidence = pct(field(policy, 'policyConfidence'))
    const pattern = str(field(policy, 'policyPattern'))
    const rationale = str(field(policy, 'policyRationale'))
    const sub: string[] = []
    if (pattern !== '?') sub.push(`${tr('flow.lbl.rule')} ${clip(pattern)}`)
    if (rationale !== '?') sub.push(`${tr('flow.lbl.reason')} ${rationale}`)
    sub.push(`${tr('flow.lbl.confidence')} ${confidence}`)
    return {
      label: tr('flow.intent'), tone: 'ok',
      detail: `${realm} · ${tr('flow.intent.viaPolicy')}`,
      sub,
    }
  }
  if (started !== undefined) return { label: tr('flow.intent'), tone: 'run', detail: tr('flow.running'), sub: [] }
  return { label: tr('flow.intent'), tone: 'wait', detail: tr('flow.wait'), sub: [] }
}

function sanitizeNode(rows: EdgeRow[], category: string | undefined): FlowNode {
  const done = latest(rows, r => r.kind === 'sanitizer.sanitized' || r.kind === 'input-guard.sanitized' || r.kind === 'guard.rule.sanitized')
  const failed = latest(rows, r => /^input-guard\.sanitize\.(downgraded|failed)$/.test(r.kind))
  const back = latest(rows, r => r.kind === 'sanitizer.desanitized')
  if (failed !== undefined) {
    return { label: tr('flow.sanitize'), tone: 'warn', detail: tr('flow.sanitize.failed'), sub: [`${tr('flow.lbl.cause')} ${str(field(failed, 'reason')) ?? '-'}`] }
  }
  if (done !== undefined) {
    // §7.121: 计数字段名有两个来源 —— sanitizer 落的是 `replacementCount`，
    // 老的 input-guard / guard.rule 行落的是 `count` / `replacements`。
    // 此前只读后两个，sanitizer 那一路永远显示不出「已替换 N 处」。
    const n = typeof done.payload.count === 'number'
      ? done.payload.count
      : typeof done.payload.replacementCount === 'number'
        ? done.payload.replacementCount
        : typeof done.payload.replacements === 'number'
          ? done.payload.replacements
          : undefined
    const sub = [typeof n === 'number' ? `${tr('flow.sanitize.hits')} ${n} ${tr('flow.sanitize.unit')}` : tr('flow.sanitize.done')]
    // §7.121: 原始判断数据 —— **命中了哪条 PII 规则** + 替换成的占位符。
    //  只说「已替换 3 处」看不出是手机号还是身份证，也看不出替成了什么。
    const piiTypes = list(field(done, 'piiTypes'))
    if (piiTypes.length > 0) sub.push(`${tr('flow.lbl.hit')} ${piiTypes.join(', ')}`)
    const placeholders = list(field(done, 'placeholders'))
    if (placeholders.length > 0) sub.push(`${tr('flow.lbl.ph')} ${placeholders.join(', ')}`)
    if (back !== undefined) sub.push(tr('flow.s.desanitized'))
    return { label: tr('flow.sanitize'), tone: 'ok', detail: tr('flow.s.done'), sub }
  }
  if (category === 'LOCAL') {
    // §7.129 / §7.130: 「无需脱敏」的理由是「答案不出设备」—— 依据是
    // **category（哪个池）**，不是端点落在哪台机。主人裁决：category=LOCAL
    // 即不算出公网，`llm.local` 池是 operator 自有设施（当前部署指向
    // <内网主机>，那是 operator 自己的机器/内网）。§7.129 曾按出口端点把这个节点
    // 改成「未脱敏（落点不在本机）」，该推导已由 §7.130 撤回。
    return { label: tr('flow.sanitize'), tone: 'ok', detail: tr('flow.sanitize.localSkip'), sub: [tr('flow.s.localWhy')] }
  }
  if (category !== undefined) {
    return { label: tr('flow.sanitize'), tone: 'ok', detail: tr('flow.sanitize.clean'), sub: [tr('flow.s.cleanWhy')] }
  }
  return { label: tr('flow.sanitize'), tone: 'wait', detail: tr('flow.wait'), sub: [] }
}

function routeNode(rows: EdgeRow[]): FlowNode {
  const routed = latest(rows, r => r.kind === 'input-guard.routed')
  // §7.175 (2026-11-11): `input-guard.route.overridden` **退役** ——
  // 路由改写机制整体撤掉了（宿主的 prepareRequest() 会对被改写的
  // provider/model 直接抛错），所以面板不再有「从 → 到」的改写证据行。
  //
  // 取代它的是两件事：
  //   · `input-guard.intent.local` —— 本轮判定为 LOCAL 时记下宿主**实际
  //     选的** provider/model（那就是本轮真正用的模型）。
  //   · `input-guard.blocked.model-selection` —— 判定 LOCAL 却选了云端模型
  //     ⇒ fail-closed 拒收（已被下面的 blocked 分支覆盖）。
  const intentLocal = latest(rows, r => r.kind === 'input-guard.intent.local')
  const blocked = latest(rows, r => /^input-guard\.blocked\./.test(r.kind))
  // §7.175: `cloud-key.missing` / `cloud.unavailable` 随「云端不可用 → 降级
  // LOCAL」一起退役（边缘模式恒用本地模型，云池不参与路由判定）。
  // `route-missing` 还在 —— 那是「本地路由没注册」（§7.171），语义不同。
  const missing = latest(rows, r => /route-missing/.test(r.kind))
  if (blocked !== undefined) {
    // Evidence = classification metadata ONLY (reason/riskLevel/rationale).
    // The payload's `preview` can carry raw user text (audit stays local);
    // the panel's hard rule is no original content — never surface it here.
    const what = blocked.kind.replace('input-guard.blocked.', '')
    const reason = str(field(blocked, 'reason'))
    const rationale = str(field(blocked, 'rationale'))
    const risk = str(field(blocked, 'riskLevel'))
    const cause = reason !== '?' ? reason : rationale !== '?' ? rationale : '?'
    const sub = [`${tr('flow.lbl.cause')} ${cause}`]
    const extras = [
      risk !== '?' ? `${tr('flow.lbl.risk')} ${risk}` : null,
      num(field(blocked, 'confidence')) !== undefined ? `${tr('flow.lbl.confidence')} ${pct(field(blocked, 'confidence'))}` : null,
    ].filter((v): v is string => v !== null)
    if (extras.length > 0) sub.push(extras.join(' · '))
    return { label: tr('flow.route'), tone: 'stop', detail: `${tr('flow.route.blocked')} · ${what}`, sub }
  }
  if (missing !== undefined) return { label: tr('flow.route'), tone: 'warn', detail: tr('flow.route.fallback'), sub: [`${tr('flow.lbl.cause')} ${str(field(missing, 'reason'))}`] }
  if (routed !== undefined) {
    const cat = str(field(routed, 'category'))
    const sub: string[] = []
    // §7.175: 路由不再被改写 ⇒ 「实际用的模型」就是宿主选的那个。
    // `input-guard.intent.local` 带 provider/model（判定 LOCAL 的那一轮）。
    if (intentLocal !== undefined) {
      const provider = str(field(intentLocal, 'provider'))
      const model = str(field(intentLocal, 'model'))
      if (provider !== '?' || model !== '?') {
        sub.push(`${tr('flow.lbl.route')} ${provider}/${model}`)
      }
    }
    sub.push(`${tr('flow.lbl.entry')} ${str(field(routed, 'routeSource'))} · ${tr('flow.lbl.pool')} ${routed.payload.edgeRouteUsed === true ? tr('flow.lbl.used') : tr('flow.lbl.hostOwn')}`)
    return {
      label: tr('flow.route'), tone: 'ok',
      detail: `${cat} · ${tr('flow.route.kept')}`,
      sub,
    }
  }
  if (intentStarted(rows)) return { label: tr('flow.route'), tone: 'run', detail: tr('flow.running'), sub: [] }
  return { label: tr('flow.route'), tone: 'wait', detail: tr('flow.wait'), sub: [] }
}

/** §7.175 (2026-11-11): `sameModel()` 与 `reasonLabel()` 随路由改写机制
 *  一起退役 —— 前者比较改写前后的 provider/model，后者翻译改写的机器
 *  原因码（intent-local / policy-rule / …）。改写没了，两者都没有读者。*/

const intentStarted = (rows: EdgeRow[]): boolean => rows.some(r => r.kind.startsWith('intent.classify.'))

function threatNode(rows: EdgeRow[]): FlowNode {
  const escalated = latest(rows, r => r.kind === 'td-bus.escalated')
  const rate = latest(rows, r => r.kind === 'input.rate-limit' || r.kind === 'input.global-rate-limit')
  const blocked = latest(rows, r => r.kind === 'http.chat.threat-blocked')
  if (blocked !== undefined) {
    return { label: tr('flow.threat'), tone: 'stop', detail: tr('flow.threat.blocked'), sub: [`${tr('flow.lbl.cause')} ${str(field(blocked, 'reason')) ?? '-'}`] }
  }
  if (escalated !== undefined) {
    return {
      label: tr('flow.threat'), tone: 'warn', detail: tr('flow.threat.escalated'),
      sub: [`${str(field(escalated, 'from'))} → ${str(field(escalated, 'to'))} · ${str(field(escalated, 'count'))}/${str(field(escalated, 'threshold'))}`],
    }
  }
  if (rate !== undefined) {
    // §7.121: 限流也要给原始计数（命中的是会话档还是全局档）。
    const global = rate.kind === 'input.global-rate-limit'
    return {
      label: tr('flow.threat'), tone: 'warn', detail: tr('flow.threat.rate'),
      sub: [`${tr('flow.lbl.scope')} ${global ? tr('flow.lbl.global') : tr('flow.lbl.session')}`],
    }
  }
  // §7.121: 「本轮窗口无异常」也要给依据 —— 本轮到底看了多少条信号。
  const watched = rows.filter(r => r.kind.startsWith('guard.') || r.kind.startsWith('input.') || r.kind.startsWith('td-bus.')).length
  return {
    label: tr('flow.threat'), tone: 'ok', detail: tr('flow.threat.calm'),
    sub: [`${tr('flow.lbl.watched')} ${watched}`],
  }
}

function answerNode(rows: EdgeRow[], summary: EdgeSummary): FlowNode {
  // §7.132: 出口行必须先分清「**主对话出网**」与「插件的内部 LLM 调用」。
  //
  // 插件自己也调 LLM（prompt-guard 的安检、intent-router 的分类器、宿主的
  // 会话标题生成），它们同样落 `llm.local.start` / `llm.local.end` 审计行。
  // 主人现场看到的就是这个：同一屏里「意图判定 / 路由决策」都还在等，下面
  // 却有「答案出口：作答中… · messageCount=1 · promptLen=125」—— 那是**安检
  // 的内部调用**（单条消息 125 字符），不是主对话的出网（同一时刻还有一条
  // messageCount=5 · promptLen=10171 才是）。面板因此把主对话的真实状态盖住了。
  //
  // 判据（实测 18:24-18:25 那轮）：
  // - `internal` 字段 → 我们自己的内部调用（prompt-guard / intent-classifier）
  // - `tools === 0`  → 一切不带工具的调用（内部调用恒为 0；主对话恒带 30+ 件）
  // - 两者都没有 → 旧数据（没有 tools 字段）→ **保留**，退化到旧行为而不是
  //   把主对话误判成内部调用而漏掉出网
  const isConversation = (r: EdgeRow): boolean => {
    const internal = field(r, 'internal')
    if (internal !== undefined && internal !== null) return false
    const tools = field(r, 'tools')
    if (typeof tools === 'number' && tools === 0) return false
    return true
  }
  // §7.181 (2026-11-11): DELEGATE 池的出口行是 `llm.{local,cloud}.delegate.*`
  // （§7.171 之后桌面跑的就是它），字段形状也不同：委托行带 `from`（池）与
  // `toProvider`/`toModel`（真实落点）；直连行带 `provider`/`model`（池自己的
  // 路由）。面板此前只认直连行 ⇒ 明明作答了，答案出口却写「路由未定」。
  const isDirectEnd = (r: EdgeRow): boolean => r.kind === 'llm.local.end' || r.kind === 'llm.cloud.end'
  const isDirectStart = (r: EdgeRow): boolean => r.kind === 'llm.local.start' || r.kind === 'llm.cloud.start'
  const isDelegateEnd = (r: EdgeRow): boolean => /^llm\.(local|cloud)\.delegate\.end$/.test(r.kind)
  const isDelegateStart = (r: EdgeRow): boolean => /^llm\.(local|cloud)\.delegate\.resolved$/.test(r.kind)

  /**
   * 出口行 → 「池 + 真实落点」。
   *
   * 委托行的池是 `from`（local-llm / cloud-llm），落点是 toProvider/toModel；
   * 直连行的 provider/model 就是池自己的路由（落点 = 池）。
   */
  const egressTarget = (r: EdgeRow): { pool: string; provider: string; model: string } => {
    const from = str(field(r, 'from'))
    if (from !== '?') {
      return { pool: from, provider: str(field(r, 'toProvider')), model: str(field(r, 'toModel')) }
    }
    const provider = str(field(r, 'provider'))
    return { pool: provider, provider, model: str(field(r, 'model') ?? field(r, 'route')) }
  }
  // No in-window host.route ≠ no route: `request/context` fires only on
  // CHANGES, so a same-model turn carries the session's last observed route
  // forward (flagged with a 沿用 note — the distinction from a fresh
  // announcement stays honest). Nothing ever seen → honest pending.
  const host = latest(rows, r => r.kind === 'llm.host.route')
  // §7.121: `llm.host.route` only exists when the **host** answered through
  // its own model. In the desktop deployment the answer goes through an
  // **edge adapter** (local-llm / cloud-llm), and the adapter's own
  // `llm.local.end` / `llm.cloud.end` row IS the answer egress — but the
  // node read neither, so it printed 「路由未定」 while the turn had
  // demonstrably answered (real session: 90 llm.local.* rows, 0
  // llm.host.route). Read the adapter rows first — they are the actual
  // wire traffic — and fall back to the host announcement.
  const adapter = latest(rows, r => (isDirectEnd(r) || isDelegateEnd(r)) && isConversation(r))
  // §7.127: an answer that is still in flight is NOT an undecided route.
  // `llm.local.start` lands when the request leaves and carries the egress
  // target (provider/model/promptLen); `llm.local.end` lands only when the
  // answer comes back. The desktop shot exposed the gap: a 101s answer sat
  // on 「路由未定」 for its whole duration — but the route had been decided
  // long before (the routing node above already showed the rewrite, and
  // the start row names the model the bytes are going to). Read the
  // in-flight and failed states off the start/error rows so the node stops
  // claiming the route is undecided while it is plainly running.
  const started = latest(rows, r => (isDirectStart(r) || isDelegateStart(r)) && isConversation(r))
  // §7.132: sse_interrupted 也是出网失败态（云侧 SSE 中断）—— 与
  // http_error / network_error 同属「作答失败」，一并纳入判定。
  const failed = latest(rows, r => /^llm\.(local|cloud)\.(http_error|network_error|sse_interrupted)$/.test(r.kind) && isConversation(r))
  const inFlight = started !== undefined
    && (adapter === undefined || started.ts > adapter.ts)
    && (failed === undefined || failed.ts < started.ts)
  if (inFlight && started !== undefined) {
    const { provider, model } = egressTarget(started)
    const sub: string[] = [`${tr('flow.lbl.route')} ${provider}/${model}`]
    const raw: string[] = []
    const messageCount = field(started, 'messageCount')
    if (typeof messageCount === 'number') raw.push(`messageCount=${messageCount}`)
    const promptLen = field(started, 'promptLen')
    if (typeof promptLen === 'number') raw.push(`promptLen=${promptLen}`)
    if (raw.length > 0) sub.push(`${tr('flow.lbl.raw')} ${raw.join(' · ')}`)
    return { label: tr('flow.answer'), tone: 'run', detail: tr('flow.answer.running'), sub }
  }
  if (failed !== undefined && (adapter === undefined || failed.ts > adapter.ts)) {
    const provider = str(field(failed, 'provider'))
    const model = str(field(failed, 'model') ?? field(failed, 'route'))
    const status = field(failed, 'status')
    const errMsg = field(failed, 'error')
    // §7.127: 宁可显示机器码原文，也不要显示一个没信息量的占位符
    // （`error` 字段历史上被序列化成 "[object Object]"，等于没说话）。
    const cause = typeof status === 'number'
      ? `status=${status}`
      : typeof errMsg === 'string' && errMsg.length > 0 && errMsg !== '[object Object]'
        ? errMsg
        : failed.kind
    return {
      label: tr('flow.answer'), tone: 'warn', detail: tr('flow.answer.failed'),
      sub: [
        `${tr('flow.lbl.route')} ${provider}/${model}`,
        `${tr('flow.lbl.cause')} ${cause} · ${tr('flow.lbl.elapsed')} ${ms(field(failed, 'durationMs'))}`,
      ],
    }
  }
  // §7.184 (2026-11-11): 边缘模式「选型不动、请求改道」 —— 改道行本身就是一次
  // **路由宣告**（这一轮已经确定跑在本地池了）⇒ 出口行还没到时也不能写
  // 「路由未定」（那是与实际行为相反的陈述）。
  const rerouted = latest(rows, r => r.kind === 'input-guard.reroute.local')
  const rerouteFrom = rerouted !== undefined
    ? field(rerouted, 'from') as { provider?: unknown; model?: unknown } | undefined
    : undefined
  const rerouteTo = rerouted !== undefined
    ? field(rerouted, 'to') as { provider?: unknown; model?: unknown } | undefined
    : undefined
  const effective = adapter !== undefined
    ? { ...egressTarget(adapter), carried: false }
    : host !== undefined
      ? { pool: str(field(host, 'provider')), provider: str(field(host, 'provider')), model: str(field(host, 'model')), carried: false }
      : rerouteTo !== undefined && str(rerouteTo.provider) !== '?'
        ? { pool: str(rerouteTo.provider), provider: str(rerouteTo.provider), model: str(rerouteTo.model), carried: false }
        : summary.lastRoute !== undefined
          ? { pool: summary.lastRoute.provider, provider: summary.lastRoute.provider, model: summary.lastRoute.model, carried: true }
          : undefined
  if (effective === undefined) {
    return { label: tr('flow.answer'), tone: 'wait', detail: tr('flow.answer.pending'), sub: [] }
  }
  const { pool, provider, model, carried } = effective
  // §7.129 / §7.130: 「全部留在本机」的判据是**哪个池**（category），不是端点
  // 落在哪台机。DELEGATE 下出口的 provider 是宿主提供商（如 qwen-token-plan-cn），
  // 但走的是**本地池**（local-llm）⇒ 仍按 LOCAL 口径显示。
  const local = pool.startsWith('local-llm')
  // §7.181: 出口步数 —— 委托行（`llm.local.delegate.end`）与直连行
  // （`llm.local.end`）都算；用 isConversation 排除内部调用（安检 / 分类器），
  // 判别字段由 adapter 侧带上（§7.181 补齐了委托行的 tools/internal）。
  const answerSteps = rows.filter(r => (r.kind === 'llm.local.end' || r.kind === 'llm.local.delegate.end') && isConversation(r))
  const sub: string[] = [
    `${tr('flow.lbl.route')} ${pool}/${model}${carried ? ` · ${tr('flow.answer.carried')}` : ''}`,
    // §7.129 / §7.130: 「全部留在本机」的依据是 **category（哪个池）**。
    // §7.129 曾按出口端点改成「全部离开了本机」，该推导已由 §7.130 撤回 ——
    // 主人裁决：category=LOCAL 即不算出公网，llm.local 池是 operator 自有设施。
    local ? tr('flow.a.localKeep') : tr('flow.a.cloudSend'),
  ]
  // §7.181: DELEGATE 的落点 provider 与池不同 ⇒ 补一行「真实落点」。
  if (provider !== '?' && provider !== pool) {
    sub.push(`${tr('flow.lbl.endpoint')} ${provider}/${model}`)
  }
  // §7.184 (2026-11-11): 边缘模式**选型不动、请求改道** —— 宿主模型选择器里
  // 仍然显示主人选的那个（云端模型），但这一轮真正跑的是本地池。
  // ⇒ 面板必须把两者都写出来，否则就是「界面上写的名字跟实际跑的不是一回事」。
  {
    const fromProvider = str(rerouteFrom?.provider)
    const toProvider = str(rerouteTo?.provider)
    if (fromProvider !== '?' && toProvider !== '?') {
      sub.push(`${tr('flow.lbl.rerouted')} ${fromProvider}/${str(rerouteFrom?.model)} → ${toProvider}/${str(rerouteTo?.model)}`)
    }
  }
  if (local && answerSteps.length > 0) {
    const total = answerSteps.reduce((n, r) => n + (typeof r.payload.durationMs === 'number' ? r.payload.durationMs : 0), 0)
    const lastStep = answerSteps.at(-1)!
    // §7.181: 委托行没有 promptLen（转发给宿主，落点那边才有）⇒ 上下文规模改用
    // 委托行自带的 messageCount（**条消息**，不是字）—— 单位不同，标签也跟着不同。
    const delegateStep = isDelegateEnd(lastStep)
    const ctx = delegateStep
      ? num(field(latest(rows, r => isDelegateStart(r) && isConversation(r)), 'messageCount'))
      : num(field(lastStep, 'promptLen'))
    const ctxText = ctx === undefined
      ? ''
      : ` · ${tr('flow.lbl.context')} ${ctx} ${delegateStep ? tr('flow.lbl.msgs') : tr('flow.lbl.chars')}`
    sub.push(`${tr('flow.lbl.steps')} ×${answerSteps.length} · ${tr('flow.lbl.total')} ${ms(total)}${ctxText}`)
  }
  // §7.121: 原始判断数据 —— 这一轮实际走了哪条线路的**原始字段**。
  const egress = adapter ?? host
  if (egress !== undefined) {
    const raw: string[] = []
    const route = field(egress, 'route')
    if (typeof route === 'string' && route.length > 0 && route !== model) raw.push(`route=${route}`)
    const dur = field(egress, 'durationMs')
    if (typeof dur === 'number') raw.push(`durationMs=${dur}`)
    const promptLen = field(egress, 'promptLen')
    if (typeof promptLen === 'number') raw.push(`promptLen=${promptLen}`)
    const resultLen = field(egress, 'resultLen')
    if (typeof resultLen === 'number') raw.push(`resultLen=${resultLen}`)
    if (raw.length > 0) sub.push(`${tr('flow.lbl.raw')} ${raw.join(' · ')}`)
  }
  const tok = summary.tokens
  if (tok !== undefined && (tok.input !== undefined || tok.output !== undefined)) {
    sub.push(`token ${tok.input ?? 0} ${tr('flow.lbl.in')} / ${tok.output ?? 0} ${tr('flow.lbl.out')}`)
  }
  return {
    label: tr('flow.answer'),
    tone: local ? 'ok' : 'info',
    detail: local ? `${tr('flow.answer.local')} · ${model}` : `${tr('flow.answer.cloud')} ${provider}/${model}`,
    sub,
  }
}

const ARROW = '│'

export function FlowPanel(props: { rows: EdgeRow[]; summary: EdgeSummary }): ReactElement {
  const { rows, summary } = props
  const classifyEnd = latest(rows, r => r.kind === 'intent.classify.end')
  const policy = latest(rows, r => r.kind === 'input-guard.policy.route-applied')
  // §7.107: the category the turn actually ran under — the classifier's
  // verdict when it spoke, the policy tier's realm when the policy decided
  // first (the classifier is then skipped entirely).
  const category = classifyEnd !== undefined
    ? String(classifyEnd.payload.category ?? '')
    : policy !== undefined
      ? String(policy.payload.policyRealm ?? '')
      : undefined
  const nodes: FlowNode[] = [
    guardNode(rows),
    intentNode(rows),
    sanitizeNode(rows, category),
    routeNode(rows),
    answerNode(rows, summary),
    threatNode(rows),
  ]
  // §7.107: three-level rhythm for every node — label line, verdict line,
  // evidence lines. The label used to share a baseline with the verdict,
  // so a long verdict wrapped under the label and the column lost its
  // grid. The verdict now always starts on its own line.
  const children = nodes.flatMap((n, i) => [
    h('div', { key: `n${i}`, class: `dsh-edge-flow-node dsh-edge-flow-node--${n.tone}` },
      h('div', { class: 'dsh-edge-flow-head' },
        h('span', { class: 'dsh-edge-flow-dot' }),
        h('span', { class: 'dsh-edge-flow-label' }, n.label),
      ),
      h('div', { class: 'dsh-edge-flow-detail' }, n.detail),
      n.sub.length > 0
        ? h('div', { class: 'dsh-edge-flow-sub' }, ...n.sub.map((s, j) => h('div', { key: j }, s)))
        : null,
    ),
    ...(i < nodes.length - 1 ? [h('div', { key: `a${i}`, class: 'dsh-edge-flow-arrow' }, ARROW)] : []),
  ])
  return h('div', { class: 'dsh-edge-flow' }, ...children)
}
