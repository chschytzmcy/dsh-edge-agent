/**
 * build-client.mjs — §7.101 desktop client bundle (esbuild).
 *
 * The client half ships as ONE esbuild-produced ESM bundle
 * (`lib/client.js`), matching dsh-context's `exports['./client']` convention:
 * the desktop app consumes it directly, so tsc never emits a runnable copy
 * of `src/client` (tsconfig.json excludes it; tsconfig.client.json type-checks
 * it with noEmit). Preact + styles are inlined — no runtime deps land in the
 * webview, and no separate CSS path is assumed by the host loader.
 */

import { build } from 'esbuild'
import { rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname ?? new URL('.', import.meta.url).pathname, '..')
const outfile = join(root, 'lib', 'client.js')

// tsc used to emit lib/types/client for the old skeleton; clear it so two
// generations of the client never coexist (walkthrough risk #2 mitigation).
rmSync(join(root, 'lib', 'types', 'client'), { recursive: true, force: true })

const result = await build({
  entryPoints: [join(root, 'src', 'client', 'index.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  minify: true,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
  metafile: true,
})

// write:true by default → metafile.outputFiles is absent; size from disk.
import { statSync } from 'node:fs'
const bytes = statSync(outfile).size
console.log(`[build-client] lib/client.js = ${Math.round(bytes / 1024)} KB`)
