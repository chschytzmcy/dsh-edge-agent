// scripts/__asar-ls.mjs — list asar entries matching a substring.
import { openSync, readSync, closeSync } from 'node:fs'

const asarPath = process.argv[2]
const needle = (process.argv[3] ?? '').toLowerCase()

const fd = openSync(asarPath, 'r')
const head = Buffer.alloc(16)
readSync(fd, head, 0, 16, 0)
const jsonLen = head.readUInt32LE(12)
const jsonBuf = Buffer.alloc(jsonLen)
readSync(fd, jsonBuf, 0, jsonLen, 16)
closeSync(fd)
const header = JSON.parse(jsonBuf.toString('utf8'))

const results = []
function walk(node, prefix) {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const p = `${prefix}/${name}`
    if (child.files) walk(child, p)
    else results.push(p)
  }
}
walk(header, '')
for (const p of results) {
  if (needle === '' || p.toLowerCase().includes(needle)) console.log(p)
}
console.error(`-- ${results.length} files scanned`)
