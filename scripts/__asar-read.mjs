// scripts/__asar-read.mjs — extract a file from an Electron asar archive.
// Usage: node scripts/__asar-read.mjs "<asar path>" "<internal path>" [outFile]
// asar layout: [u32 4][u32 headerPickleSize][u32 jsonLen+? ][u32 jsonLen][json][files...]

import { openSync, readSync, writeFileSync, closeSync } from 'node:fs'

const asarPath = process.argv[2]
const internal = process.argv[3]
const outFile = process.argv[4]

const fd = openSync(asarPath, 'r')
const head = Buffer.alloc(16)
readSync(fd, head, 0, 16, 0)
const jsonLen = head.readUInt32LE(12)
const jsonBuf = Buffer.alloc(jsonLen)
readSync(fd, jsonBuf, 0, jsonLen, 16)
const header = JSON.parse(jsonBuf.toString('utf8'))

const parts = internal.split('/').filter(Boolean)
let node = header
for (const p of parts) {
  node = node.files?.[p]
  if (!node) {
    console.error(`not found: ${internal} (at '${p}')`)
    process.exit(1)
  }
}
if (!node.files && typeof node.offset === 'string') {
  const off = 16 + jsonLen + Number(node.offset)
  const buf = Buffer.alloc(Number(node.size))
  readSync(fd, buf, 0, Number(node.size), off)
  closeSync(fd)
  if (outFile) {
    writeFileSync(outFile, buf)
    console.log(`wrote ${outFile} (${buf.length} bytes)`)
  } else {
    process.stdout.write(buf)
  }
} else {
  console.error('path is a directory or malformed')
  process.exit(1)
}
