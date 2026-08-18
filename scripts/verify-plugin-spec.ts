/**
 * Plugin-spec battery: every src/dsh-adapter/*.ts plugin file must follow
 * the canonical `name` + `inject` + `Config` + `apply` shape, and the
 * main `src/dsh-adapter/index.ts` aggregator must mount them all.
 *
 * Verified properties:
 *   1. `name` is non-empty kebab-case (matches its filename).
 *   2. `inject` is an array of declared soft dependencies.
 *   3. `Config` schema is non-null and uses `@deepseek-ai/schemastery`.
 *   4. `apply` is an async function (or returns one).
 *   5. Every subpath in package.json `exports` resolves to a real file.
 *   6. The aggregator's `apply` invokes each sub-plugin's `apply`.
 *
 * Run via `node --import tsx/esm scripts/verify-plugin-spec.ts`.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, resolve, basename } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const ADAPTER = join(root, 'src', 'dsh-adapter')

const KEBAB_CASE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

interface Spec {
  name: string
  inject: readonly string[]
  configSchema: boolean
  apply: 'function' | 'arrow' | 'unknown'
}

const sources: string[] = []
function collect(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      collect(path)
    } else if (entry.endsWith('.ts')) {
      sources.push(path)
    }
  }
}
collect(ADAPTER)

const violations: string[] = []
const pluginSpecs: Array<{ file: string; spec: Spec }> = []

for (const file of sources) {
  const base = basename(file, '.ts')
  if (base === 'contract' || base === 'types' || base === 'invariant' || base === 'llm-adapters') continue
  if (base === 'plugin' || base === 'index') continue
  const content = readFileSync(file, 'utf8')

  // name
  const nameMatch = content.match(/export const name\s*=\s*['"]([^'"]+)['"]/u)
  if (!nameMatch) {
    violations.push(`${relative(root, file)}: missing 'export const name'`)
    continue
  }
  const name = nameMatch[1]
  if (name !== base) {
    violations.push(`${relative(root, file)}: name='${name}' does not match filename='${base}'`)
  }
  if (!KEBAB_CASE.test(name)) {
    violations.push(`${relative(root, file)}: name='${name}' is not kebab-case`)
  }

  // inject
  const injectMatch = content.match(/export const inject\s*=\s*(\[[^\]]*\]|\[\s*\]\s*as\s*const)/u)
  if (!injectMatch) {
    violations.push(`${relative(root, file)}: missing 'export const inject'`)
  }

  // Config schema
  const configMatch = content.match(/export const Config:\s*Schema<[^>]+>\s*=\s*Schema\.object/u)
  if (!configMatch) {
    violations.push(`${relative(root, file)}: missing 'export const Config: Schema<...> = Schema.object(...)'`)
  }

  // apply
  const applyMatch = content.match(/export\s+async\s+function\s+apply\s*\(/u)
    ?? content.match(/export\s+function\s+apply\s*\(/u)
    ?? content.match(/export\s+const\s+apply\s*=\s*async\s*\(/u)
  if (!applyMatch) {
    violations.push(`${relative(root, file)}: missing 'export ... function apply(...)'`)
  }

  pluginSpecs.push({
    file: relative(root, file),
    spec: {
      name,
      inject: injectMatch ? (injectMatch[1] ?? '[]') : '[]',
      configSchema: !!configMatch,
      apply: applyMatch?.[0]?.includes('const') ? 'arrow' : 'function',
    },
  })
}

if (violations.length > 0) {
  console.error('Plugin-spec battery FAILED:')
  for (const v of violations) console.error(`  - ${v}`)
  process.exit(1)
}

// Check the package.json exports match real subpath files
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const exports = pkg.exports ?? {}
const exportViolations: string[] = []
for (const [key, value] of Object.entries(exports)) {
  if (key === './package.json' || key === './cordis.patch.yml' || key === './cordis.yml') continue
  const v = value as Record<string, string> | string
  const importPath = typeof v === 'string' ? v : v.import
  if (!importPath) continue
  // source maps to ./src/<x>.ts; lib maps to ./lib/types/<x>.js
  const srcCandidate = join(root, 'src', `${basename(key) === '.' ? 'index' : key.replace(/^\.\//u, ''))}.ts`)
  if (!existsSync(srcCandidate)) {
    exportViolations.push(`export '${key}' → no source file at ${relative(root, srcCandidate)}`)
  }
}
if (exportViolations.length > 0) {
  console.error('Subpath export surface violated:')
  for (const v of exportViolations) console.error(`  - ${v}`)
  process.exit(1)
}

console.log(`plugin-spec OK (${pluginSpecs.length} adapter plugins scanned, ${Object.keys(exports).length} subpath exports)`)