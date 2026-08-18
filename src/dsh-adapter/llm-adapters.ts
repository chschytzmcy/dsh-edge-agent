/**
 * llm-adapters — bundled export of both local and cloud LLM adapters.
 * This is a convenience surface: cordis.yml can mount a single row
 * pointing here instead of two separate rows.
 *
 * Note: this is a re-export shim and does not register a Cordis plugin
 * itself. The individual adapter files (local-llm-adapter.ts and
 * cloud-llm-adapter.ts) own the `apply` exports and the canonical
 * `name`/`Config` plugins; we re-export only the service classes and
 * interfaces here to avoid collisions on the shared plugin-metadata
 * names (`name`, `inject`, `Config`, `apply`).
 *
 * @module dsh-edge-agent/llm-adapters
 */

export type { LocalLlmAdapter } from './local-llm-adapter.js'
export { LocalLlmAdapterImpl } from './local-llm-adapter.js'

export type { CloudLlmAdapter } from './cloud-llm-adapter.js'
export { CloudLlmAdapterImpl } from './cloud-llm-adapter.js'