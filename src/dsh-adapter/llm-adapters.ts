/**
 * llm-adapters — bundled export of both local and cloud LLM adapters.
 * This is a convenience surface: cordis.yml can mount a single row
 * pointing here instead of two separate rows.
 *
 * Note: this is a re-export shim and does not register a Cordis plugin
 * itself. The individual adapter files (local-llm-adapter.ts and
 * cloud-llm-adapter.ts) own the `apply` exports.
 *
 * @module dsh-edge-agent/llm-adapters
 */

export * from './local-llm-adapter.ts'
export * from './cloud-llm-adapter.ts'
