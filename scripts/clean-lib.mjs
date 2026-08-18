/**
 * clean-lib: removes the entire lib/ directory. Run by `pnpm run clean`.
 *
 * lib/ is exclusively generated output. Resolve the path from this script
 * instead of the caller's cwd so the cleanup target cannot drift outside
 * the package.
 */
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const libDir = fileURLToPath(new URL('../lib/', import.meta.url))
rmSync(libDir, { recursive: true, force: true })
console.log(`cleaned ${libDir}`)