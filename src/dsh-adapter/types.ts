/**
 * Type-only re-exports of every DSH / Cordis surface consumed by the
 * edge-agent plugins. No runtime side effects — this file is `.d.ts`-
 * friendly and is the canonical place the UI / business layer reaches
 * to learn upstream types.
 *
 * Boundary rule: code outside `src/dsh-adapter/` must NOT import
 * `@deepseek-ai/*` directly. It must come through this facade or the
 * services exposed in `src/dsh-adapter/<plugin>.js`.
 *
 * Schemastery note: `@deepseek-ai/schemastery` only ships a default
 * export (`Schema`). Consumers should import that directly when they
 * need a schema constructor. There is no `Schema`/`SchemaOptions`/
 * `TypeSchema` named export to re-export here.
 */

export type { Context } from '@deepseek-ai/cordis'

export type {
  Agent,
  AgentHandle,
  AgentStatus,
  AgentOptions,
  CreateAgentOptions,
  PreStepDecision,
  RequestErrorAction,
  InboxTarget,
} from '@deepseek-ai/dsh-agent'

export type {
  LlmAdapter,
  LlmCallConfig,
  LlmModelInfo,
  LlmRuntime,
  GenerateOptions,
  Message,
  StreamChunk,
  PreparedLlmCall,
  BlockAssembler,
  LlmError,
} from '@deepseek-ai/dsh-llm'

export type {
  Session,
  SessionId,
  SessionEvent,
  SessionHeader,
  SessionEventMap,
  TurnEndReason,
  EpochHeader,
} from '@deepseek-ai/dsh-session'

export type {
  ToolExecution,
  ToolExecutionResult,
} from '@deepseek-ai/dsh-tools'

export type {
  PromptSection,
  PromptAssembly,
} from '@deepseek-ai/dsh-system-prompt'

export type {
  Scope,
  ScopeKey,
} from '@deepseek-ai/dsh-scope'