// One-shot: sync the credential rule + keepPrefix band-masking into every
// shipped privacy-policy.json (repo + both installable variants).
import { readFileSync, writeFileSync } from 'node:fs'

const credential = '(?:密码|口令|用户名|账号|账户|passwd|password|pwd|username|account|secret|access[ _-]?token|token|api[ _-]?key)["\' 　]{0,2}(?:[:：=]|是|为|\\s+is\\s+)["\' 　]?[^\\s"\'，,;；<>（）()]{3,64}'
const KEEP = { phone: 7, 'id-card': 6 }

for (const p of ['config/privacy-policy.json', 'dist/installable/dsh-edge-agent-desktop-safe/config/privacy-policy.json', 'dist/installable/dsh-edge-agent-full/config/privacy-policy.json']) {
  let j
  try { j = JSON.parse(readFileSync(p, 'utf8')) } catch { console.log('skip (missing):', p); continue }
  const rs = j.sanitizationRules
  if (!Array.isArray(rs)) { console.log('no rules:', p); continue }
  for (const r of rs) {
    if (r.piiType === 'credential') r.pattern = credential
    const keep = KEEP[r.piiType]
    if (keep === undefined) delete r.keepPrefix
    else r.keepPrefix = keep
  }
  writeFileSync(p, JSON.stringify(j, null, 2) + '\n')
  console.log('synced:', p, '| keepPrefix:', rs.filter(r => r.keepPrefix).map(r => `${r.piiType}:${r.keepPrefix}`).join(','))
}
