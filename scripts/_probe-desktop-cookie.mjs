// scripts/_probe-desktop-cookie.mjs
// Read the Electron app's Chromium cookie store and print the DSH auth
// cookie for 127.0.0.1, so the running desktop instance can be probed with
// the same harness as the CLI-booted web app.

import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'

const dbPath = process.argv[2]
if (!dbPath || !existsSync(dbPath)) {
  console.error(`cookie db not found: ${dbPath}`)
  process.exit(1)
}

const db = new DatabaseSync(dbPath, { readOnly: true })
const rows = db
  .prepare('SELECT host_key, name, value, path, expires_utc FROM cookies WHERE name LIKE ?')
  .all('dsh-auth-%')

for (const r of rows) {
  console.log(`${r.host_key}\t${r.name}\t${r.path}\texpires=${r.expires_utc}`)
  console.log(`VALUE=${r.value}`)
}
if (rows.length === 0) console.log('(no dsh-auth cookie)')
db.close()
