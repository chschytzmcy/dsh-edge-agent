// eslint flat config —— 只落「真 bug」类规则，风格类一概不管。
//
// 取舍（P2 引入门禁的第一步）：
// - no-explicit-any 关掉：仓库的 soft-service 模式（(ctx as any).xxx 取
//   可选依赖）是刻意的，类型收窄属于另一个工程阶段。
// - no-empty 允许空 catch：防御性 catch{} 在隐私路径上是有意为之
//   （审计永不因 viewer/服务故障中断）。审计可见性另案处理。
// - no-unused-vars 降为 warn 并忽略 _ 前缀。
// 其余 recommended 规则（no-fallthrough / no-constant-condition /
// no-async-promise-executor / no-self-compare / @typescript-eslint/no-*
// 的误用类）按 error 落地。
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'lib/**',
      'dist/**',
      'node_modules/**',
      'bundle-minimal/**',
      '.npm-cache/**',
      'profiles/**',
      'png/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
)
