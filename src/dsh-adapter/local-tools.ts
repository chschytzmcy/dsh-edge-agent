/**
 * local-tools — M2 local tool bundle. Registers three tools through the
 * upstream DSH tool registry (`ctx.tools.register()`):
 *
 *   - local_file_read  — read a path under the workspace allowlist
 *   - local_file_write — write a path under the workspace allowlist
 *   - local_calculate — evaluate a pure-math expression (no I/O)
 *
 * `local-tools` tags each tool with realm LOCAL via `ctx.edgeTools.setRealm()`
 * so the A2 intent-router can filter by realm. The actual tool registration
 * uses DSH's `defineTool` so the parameter schema is enforced and the output
 * is strictly a lossless JSON value.
 *
 * M2 NOTE: there is no privacy-policy gate yet. `allowList` is the only
 * access control. A6 will route these reads/writes through the
 * sanitizer-pipeline + audit-log; M2 ships plain file I/O.
 *
 * @module dsh-edge-agent/local-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

import type { ToolsServiceImpl } from './tools.ts'

export const name = 'local-tools'

export const inject = ['edgeTools', 'tools'] as const

export interface Config {
  /** Paths whose prefixes are readable (and writable when `readOnly=false`). */
  allowList: string[]
  /** Disable file_write entirely when true. */
  readOnly: boolean
  /** Hard upper bound for file_read payload size. */
  maxFileSize: number
  /** Timeout for a single tool call. */
  timeoutMs: number
}

export const Config: Schema<Config> = Schema.object({
  allowList: Schema.array(Schema.string()).default([]),
  readOnly: Schema.boolean().default(true),
  maxFileSize: Schema.natural().default(10 * 1024 * 1024),
  timeoutMs: Schema.natural().default(10_000),
})

export interface LocalToolsService {
  list(): string[]
  invoke(name: string, args: unknown): Promise<unknown>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    localTools: LocalToolsServiceImpl
  }
}

export class LocalToolsServiceImpl {
  constructor(private readonly registered: { name: string }[]) {}

  list(): string[] {
    return [...this.registered.map((t) => t.name)]
  }

  async invoke(toolName: string, args: unknown): Promise<unknown> {
    void args
    if (!this.registered.some((t) => t.name === toolName)) {
      throw new Error(`local-tools: unknown tool "${toolName}"`)
    }
    // M2 does not call the registered body directly; the upstream registry
    // is the only dispatcher. This entry point exists so unit tests can
    // assert the bundle without going through the DSH loop.
    return null
  }
}

/**
 * Resolve a path and assert it is under one of the allowed prefixes.
 * `allowedPrefixes` is honored as-is (no symlink resolution in M2).
 */
export function assertUnderAllowList(path: string, allowedPrefixes: readonly string[]): string {
  if (allowedPrefixes.length === 0) {
    throw new Error('local-tools: allowList is empty; refusing to access any path')
  }
  const normalized = path
  for (const prefix of allowedPrefixes) {
    if (normalized === prefix || normalized.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)) {
      return normalized
    }
  }
  throw new Error(`local-tools: path "${path}" is not under any allowList entry`)
}

/** Pure-math expression evaluator (no `eval`, no `Function`). Whitelisted chars only. */
export function evaluateExpression(expr: string): number {
  const trimmed = expr.replace(/\s+/gu, '')
  if (!/^[0-9+\-*/().,]+$/u.test(trimmed)) {
    throw new Error(`local-tools: calculate refused non-math expression "${expr}"`)
  }
  const last = trimmed.split(',').pop() ?? trimmed
  return evalArithmetic(last)
}

function evalArithmetic(src: string): number {
  const tokens: Array<{ kind: 'num'; value: number } | { kind: 'op'; value: string } | { kind: 'lp' } | { kind: 'rp' }> = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === '(') { tokens.push({ kind: 'lp' }); i++; continue }
    if (ch === ')') { tokens.push({ kind: 'rp' }); i++; continue }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      tokens.push({ kind: 'op', value: ch }); i++; continue
    }
    if (ch >= '0' && ch <= '9') {
      let j = i + 1
      while (j < src.length && ((src[j] >= '0' && src[j] <= '9') || src[j] === '.')) j++
      tokens.push({ kind: 'num', value: Number(src.slice(i, j)) })
      i = j
      continue
    }
    throw new Error(`local-tools: unexpected character "${ch}" at position ${i}`)
  }
  const values: number[] = []
  const ops: string[] = []
  const pop = () => {
    const b = values.pop()
    const a = values.pop()
    const op = ops.pop()
    if (a === undefined || b === undefined || op === undefined) throw new Error('local-tools: malformed expression')
    switch (op) {
      case '+': values.push(a + b); break
      case '-': values.push(a - b); break
      case '*': values.push(a * b); break
      case '/':
        if (b === 0) throw new Error('local-tools: division by zero')
        values.push(a / b)
        break
      default: throw new Error(`local-tools: unknown operator "${op}"`)
    }
  }
  const prec: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2 }
  for (const tok of tokens) {
    if (tok.kind === 'num') values.push(tok.value)
    else if (tok.kind === 'op') {
      while (ops.length > 0 && ops[ops.length - 1] !== '(' && (prec[ops[ops.length - 1]] ?? 0) >= prec[tok.value]) pop()
      ops.push(tok.value)
    }
    else if (tok.kind === 'lp') ops.push('(')
    else if (tok.kind === 'rp') {
      while (ops.length > 0 && ops[ops.length - 1] !== '(') pop()
      if (ops.pop() !== '(') throw new Error('local-tools: unmatched parenthesis')
    }
  }
  while (ops.length > 0) pop()
  if (values.length !== 1) throw new Error('local-tools: malformed expression')
  return values[0] as number
}

export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  const edgeTools = (ctx as unknown as { edgeTools: ToolsServiceImpl }).edgeTools
  const disposers: Array<() => void> = []
  const registered: { name: string }[] = []

  // ---- local_file_read ----
  const fileRead = defineTool({
    name: 'local_file_read',
    description: 'Read a UTF-8 file under the local-tools allowList. Returns { path, content, sizeBytes }.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Absolute or workspace-relative path to read.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          content: { type: 'string', required: true },
          sizeBytes: { type: 'number', required: true },
        },
      },
      render(_args, value) {
        const v = value as { path: string; content: string; sizeBytes: number }
        const block: ContentBlock = { type: 'text', text: v.content }
        return [block]
      },
    },
    timeoutMs: config.timeoutMs,
    async execute(args) {
      const path = (args as { path: string }).path
      const safe = assertUnderAllowList(path, config.allowList)
      const fs = await import('node:fs/promises')
      const stat = await fs.stat(safe)
      if (stat.size > config.maxFileSize) {
        throw new Error(`local-tools: file ${safe} is ${stat.size} bytes, exceeds maxFileSize ${config.maxFileSize}`)
      }
      const content = await fs.readFile(safe, 'utf-8')
      return { path: safe, content, sizeBytes: stat.size }
    },
  })
  disposers.push((ctx as unknown as { tools: { register: (def: typeof fileRead) => () => void } }).tools.register(fileRead))
  edgeTools.setRealm('local_file_read', 'LOCAL')
  registered.push({ name: 'local_file_read' })

  // ---- local_file_write ----
  if (!config.readOnly) {
    const fileWrite = defineTool({
      name: 'local_file_write',
      description: 'Write a UTF-8 file under the local-tools allowList. Returns { path, bytesWritten }.',
      parameters: {
        path: { type: 'string', required: true, description: 'Destination path under the allowList.' },
        content: { type: 'string', required: true, description: 'Content to write.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            bytesWritten: { type: 'number', required: true },
          },
        },
        render(_args, value) {
          const v = value as { path: string; bytesWritten: number }
          const block: ContentBlock = { type: 'text', text: `wrote ${v.bytesWritten} bytes to ${v.path}` }
          return [block]
        },
      },
      timeoutMs: config.timeoutMs,
      async execute(args) {
        const { path, content } = args as { path: string; content: string }
        const safe = assertUnderAllowList(path, config.allowList)
        const fs = await import('node:fs/promises')
        await fs.writeFile(safe, content, 'utf-8')
        return { path: safe, bytesWritten: Buffer.byteLength(content, 'utf-8') }
      },
    })
    disposers.push((ctx as unknown as { tools: { register: (def: typeof fileWrite) => () => void } }).tools.register(fileWrite))
    edgeTools.setRealm('local_file_write', 'LOCAL')
    registered.push({ name: 'local_file_write' })
  }

  // ---- local_calculate ----
  const calculate = defineTool({
    name: 'local_calculate',
    description: 'Evaluate a pure-math expression (numbers, + - * / ( )). Returns { result, expression }.',
    parameters: {
      expr: { type: 'string', required: true, description: 'Arithmetic expression to evaluate.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          result: { type: 'number', required: true },
          expression: { type: 'string', required: true },
        },
      },
      render(_args, value) {
        const v = value as { result: number; expression: string }
        const block: ContentBlock = { type: 'text', text: String(v.result) }
        return [block]
      },
    },
    timeoutMs: config.timeoutMs,
    async execute(args) {
      const expr = (args as { expr: string }).expr
      const result = evaluateExpression(expr)
      return { result, expression: expr }
    },
  })
  disposers.push((ctx as unknown as { tools: { register: (def: typeof calculate) => () => void } }).tools.register(calculate))
  edgeTools.setRealm('local_calculate', 'LOCAL')
  registered.push({ name: 'local_calculate' })

  const localTools = new LocalToolsServiceImpl(registered)
  const dispose = ctx.provide('localTools', localTools)
  disposers.push(dispose)

  return async () => {
    for (const fn of disposers) fn()
  }
}