/**
 * provider-realm —— §7.214: 「这条 provider 落在哪个 realm」的事实源
 *
 * ## 为什么要有这个模块
 *
 * §7.190 记下的一条**既有事实**：
 *
 * > **DELEGATE 委托到云端时，闸门不拦。** `input-guard` 的 `dispatchRerouted()`
 * > 只用 `localAvailable()`（问「`local-llm` 路由在不在」），**DELEGATE 模式下
 * > 该路由是在的** ⇒ 放行；`mode` 只写进审计行，不参与判定。
 *
 * 主人当时给的选项是：「**DELEGATE 的委托目标按 model-router 的 realm 判定，
 * 非 LOCAL 就 fail-closed 拒收**」。
 *
 * §7.210 先做了**可见化 + 默认关闭的粗粒度严格档**：
 *
 *   - 一等 security 级审计事件 `input-guard.reroute.delegate-egress`；
 *   - `llm.local.requireLocalEndpoint=true` ⇒ DELEGATE 时一律 fail-closed 拒收。
 *
 * 但「一律拒收」比主人给的口径**粗一档**：DELEGATE 的落点**可能本身就是本地的**
 * （`llm.local.delegateProvider` 指向一条 model-router 标注为 LOCAL 的路由）。
 * 那种情况下改道过去**并不出网** ⇒ 按 §7.190 的口径不该拒收。
 *
 * 本模块把那把尺子单独做成一个模块：**realm 的判定只有这一处实现**，
 * 与 `cloud-llm-adapter#localProviders()` / `host-egress-guard#localProviders()`
 * 同款（model-router 的 `listDetailed()` 是同一份事实源）。
 *
 * ## 判据
 *
 * `modelRouter.listDetailed()` 返回带 `realm` 标注的路由清单
 * （`{ provider, realm, ... }`）。**只有 `realm === 'LOCAL'` 才算本地**。
 *
 * ## fail-closed：证不出来就不是本地
 *
 * 三种情况都判成「**不是 LOCAL**」：
 *
 *   1. model-router 读不到（老宿主 / fake ctx / 读它抛错）；
 *   2. `listDetailed()` 读得到，但清单里**没有**这个 provider；
 *   3. 清单里有，但 `realm` 字段缺失或不是字符串。
 *
 * ⇒ 「证明不了它是 LOCAL」=「不放行」。这是严格档的方向（**不放行**比**放行**
 * 危险）⇒ 必须 fail-closed。
 *
 * ⚠️ 刻意**不**加 `local-` 前缀兜底（`isCloudBoundProvider()` 里有那条）——
 * 那条规则服务的是**另一个方向**（「别把本地段当云段裁掉」，偏保守），
 * 而这里是「能不能放行」，偏保守就该**不放行**，不能靠前缀猜。
 *
 * @module dsh-edge-agent/provider-realm
 */

/** 判定依据（写进审计 ⇒ 事后能追「凭什么这么判」）。 */
export type RealmVerdictSource =
  /** model-router 的 `listDetailed()` 读到了这个 provider 的 realm。 */
  | 'model-router'
  /** model-router 读得到，但清单里没有这个 provider。 */
  | 'model-router-missing'
  /** model-router 读不到（老宿主 / fake ctx / 抛错）。 */
  | 'router-unavailable'
  /** 压根没有落点（DELEGATE 解析不出来）。 */
  | 'no-target'

/** 判定结果。 */
export interface ProviderRealmVerdict {
  /** 被问的那个 provider（空 = 没有落点）。 */
  provider?: string
  /**
   * `'LOCAL'` = 宿主说它是本地的；
   * 其它字符串 = 宿主给的 realm 标注（如 `CLOUD`）；
   * `'UNKNOWN'` = 证不出来（见模块注释的三种情况）。
   */
  realm: string
  /** 判定依据。 */
  source: RealmVerdictSource
  /** 能不能**证明**它是 LOCAL。`false` ⇒ 按 fail-closed 处理。 */
  isLocal: boolean
}

/** 证不出来时的 realm 取值（写进审计，避免和宿主真实的 realm 混为一谈）。 */
export const UNKNOWN_REALM = 'UNKNOWN'

/** model-router 的 `listDetailed()` 的结构（只取我们要的两个字段）。 */
interface RouterDetail {
  provider?: string
  realm?: string
}

interface RouterLike {
  listDetailed?: () => RouterDetail[]
}

/**
 * 问 model-router：这个 provider 落在哪个 realm？
 *
 * **必须走 `ctx.get()` 而不是 `ctx.modelRouter` 直取** —— cordis 4.x 的 ctx 是
 * Proxy：读一个既没 provide、也不在生效 `inject` 里的属性会**直接抛**
 * `cannot get property "modelRouter" without inject`。
 * input-guard 刻意不把 model-router 放进 `inject`（见那处的注释）⇒ 直取会炸。
 *
 * @param ctx      宿主 ctx（软读，拿不到就当「证不出来」）
 * @param provider 被问的 provider（空 = 没有落点）
 */
export function providerRealm(ctx: unknown, provider: string | undefined | null): ProviderRealmVerdict {
  const target = (provider ?? '').trim()
  if (target.length === 0) {
    return { realm: UNKNOWN_REALM, source: 'no-target', isLocal: false }
  }

  let router: RouterLike | undefined
  try {
    router = (ctx as { get?: (name: string) => unknown } | undefined)?.get?.('modelRouter') as RouterLike | undefined
  } catch {
    router = undefined
  }
  if (!router || typeof router.listDetailed !== 'function') {
    return { provider: target, realm: UNKNOWN_REALM, source: 'router-unavailable', isLocal: false }
  }

  let detailed: RouterDetail[]
  try {
    detailed = router.listDetailed() ?? []
  } catch {
    return { provider: target, realm: UNKNOWN_REALM, source: 'router-unavailable', isLocal: false }
  }

  const hit = detailed.find(d => typeof d?.provider === 'string' && d.provider === target)
  if (!hit || typeof hit.realm !== 'string' || hit.realm.length === 0) {
    return { provider: target, realm: UNKNOWN_REALM, source: 'model-router-missing', isLocal: false }
  }
  return {
    provider: target,
    realm: hit.realm,
    source: 'model-router',
    isLocal: hit.realm === 'LOCAL',
  }
}
