/**
 * `@deepseek-ai/dsh-sandbox` 的**本地桩**（只在单元测试里用）。
 *
 * ## 为什么需要桩
 *
 * 宿主 `@deepseek-ai/dsh-tools` 顶层 import 了三个符号：
 *
 * ```js
 * import { ESCALATION_TARGETS, approveEscalation, validateEscalationArgs }
 *   from "@deepseek-ai/dsh-sandbox";
 * ```
 *
 * 而本仓的 devDependencies 里**没有**这个包（它是宿主侧包，本仓只依赖
 * dsh-tools / dsh-llm / dsh-scope 等）。⇒ 不顶替它，`import
 * '@deepseek-ai/dsh-tools'` 在测试里**直接抛**
 * `Cannot find package '@deepseek-ai/dsh-sandbox'`，真运行时集成测试连跑都跑不起来。
 *
 * ## 顶替的边界（必须说清楚）
 *
 * - **管道本身是真宿主代码**：`dsh-tools` 的 `execute` → `prepareExecution` →
 *   `tools/pre-execute` waterfall → `guardReason` → 物化拒绝结果 —— 全是
 *   `node_modules/@deepseek-ai/dsh-tools` 的原样实现，本测试验的就是它。
 * - **只顶替三个符号**，且都与「沙箱权限升级」有关，与 pre-execute → deny 这条
 *   路径无关：
 *   - `ESCALATION_TARGETS`：一个常量数组（照抄宿主值）；
 *   - `validateEscalationArgs`：参数配对校验（照抄宿主实现，逐字一致）；
 *   - `approveEscalation`：宿主走审批服务；桩**直接抛错**（fail-closed）——
 *     任何测试若真走到升级审批，必须立刻炸出来，而不是被静默放行。
 *
 * 换句话说：桩**只影响**「工具请求把沙箱放宽」这条分支。本仓关心的
 * 「bash 里跑 etscli 写子命令」那条分支，一行宿主代码都没被换掉。
 */

/** 宿主 `dsh-sandbox/lib/index.js:43` 的原值。 */
export const ESCALATION_TARGETS: readonly string[] = ['workspace-write', 'danger-full-access']

/**
 * 宿主 `dsh-sandbox/lib/index.js:52-56` 的原实现（逐字照抄）。
 *
 * @param sandboxPermissions - `sandbox_permissions` 参数（可缺省）
 * @param justification - `justification` 参数（可缺省）
 */
export function validateEscalationArgs(
  sandboxPermissions?: string,
  justification?: string,
): void {
  if (sandboxPermissions !== undefined && justification === undefined) {
    throw new Error('invalid escalation: sandbox_permissions requires a justification')
  }
  if (justification !== undefined && sandboxPermissions === undefined) {
    throw new Error('invalid escalation: justification is only valid together with sandbox_permissions')
  }
  if (justification !== undefined && justification.trim().length === 0) {
    throw new Error('invalid justification: expected a non-empty sentence')
  }
}

/**
 * 宿主走审批服务（`ctx.approval.request`）；本桩**不做审批**，直接失败。
 *
 * fail-closed 的理由：桩若静默放行，「沙箱升级被批准」这件事在测试里就会变成
 * 一件**没发生过却显示发生过**的事 —— 与本仓的诚实性纪律相反。
 */
export async function approveEscalation(_input: unknown): Promise<never> {
  throw new Error(
    '[stub @deepseek-ai/dsh-sandbox] approveEscalation is not available in the unit-test harness: ' +
    'a test reaching sandbox escalation would be exercising a path this stub cannot faithfully model.',
  )
}
