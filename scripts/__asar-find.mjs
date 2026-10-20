// scripts/__asar-find.mjs — find which asar file contains a byte offset
// of a needle string. Usage: node __asar-find.mjs <asar> "<needle>"
import { openSync, readSync, closeSync } from 'node:fs'

const asarPath = process.argv[2]
const needle = process.argv[3]

const fd = openSync(asarPath, 'r')
const head = Buffer.alloc(16)
readSync(fd, head, 0, 16, 0)
const jsonLen = head.readUInt32LE(12)
const jsonBuf = Buffer.alloc(jsonLen)
readSync(fd, jsonBuf, 0, jsonLen, 16)
const dataStart = 16 + jsonLen
const header = JSON.parse(jsonBuf.toString('utf8'))

const files = []
function walk(node, prefix) {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const p = `${prefix}/${name}`
    if (child.files) walk(child, p)
    else if (typeof child.offset === 'string') {
      files.push({ p, off: dataStart + Number(child.offset), size: Number(child.size) })
    }
  }
}
walk(header, '')

// Read in 4MB chunks, find needle occurrences, map to files.
const CHUNK = 4 * 1024 * 1024
const needleBuf = Buffer.from(needle)
const total = files.reduce((m, f) => Math.max(m, f.off + f.size), 0)
let pos = dataStart
const found = []
while (pos < total) {
  const len = Math.min(CHUNK + needleBuf.length, total - pos)
  const buf = Buffer.alloc(len)
  readSync(fd, buf, 0, len, pos)
  let idx = buf.indexOf(needleBuf)
  while (idx !== -1) {
    const abs = pos + idx
    const file = files.find((f) => abs >= f.off && abs < f.off + f.size)
    found.push({ abs, file: file ? file.p : '(unknown)' })
    idx = buf.indexOf(needleBuf, idx + 1)
  }
  pos += CHUNK
}
closeSync(fd)
const byFile = new Map()
for (const f of found) byFile.set(f.file, (byFile.get(f.file) ?? 0) + 1)
for (const [file, count] of byFile) console.log(`${count}\t${file}`)
