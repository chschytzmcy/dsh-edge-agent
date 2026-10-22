// scripts/_probe-guide-entries.mjs — dump the guide-entry validation in the
// sidebar-right registry (the `register()` path), so our client's guide
// entries match the runtime contract exactly.
import { readFileSync } from 'node:fs'

const src = readFileSync(process.argv[2], 'utf8')
const idx = src.indexOf('new Set(')
if (idx === -1) {
  console.log('no new Set( in file')
  process.exit(1)
}
console.log(src.slice(Math.max(0, idx - 1100), idx + 700))
