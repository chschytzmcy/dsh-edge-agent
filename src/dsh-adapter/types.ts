/**
 * Type-only re-exports of every DSH / Cordis surface consumed by the
 * edge-agent plugins. No runtime side effects — this file is `.d.ts`-
 * friendly and is the canonical place the UI / business layer reaches
 * to learn upstream types.
 *
 * Boundary rule: code outside `src/dsh-adapter/` must NOT import
 * `@deepseek-ai/*` directly. It must come through this facade or the
 * services exposed in `src/dsh-adapter/<plugin>.ts`.
 */

export type { Context } from '@deepseek-ai/cordis'

export type {
  Agent,
  AgentHandle,
  AgentStatus,
  AgentOptions,
  AgentEvent,
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
  UserMessage,
  EpochHeader,
} from '@deepseek-ai/dsh-session'

export type {
  Tool,
  ToolExecution,
  ToolExecutionResult,
  ToolRegistry,
} from '@deepseek-ai/dsh-tools'

export type {
  PromptSection,
  PromptAssembly,
} from '@deepseek-ai/dsh-system-prompt'

export type {
  Scope,
  ScopeKey,
} from '@deepseek-ai/dsh-scope'

export type Schema, SchemaOptions, TypeSchema } from '@deepseek-ai/schemastery'
