// One-shot: sync the credential rule in every shipped privacy-policy.json to
// PII_PATTERNS['credential'] (the single source of truth the drift gate reads).
import { readFileSync, writeFileSync } from 'node:fs'

const pattern = '(?:密码|口令|用户名|账号|账户|passwd|password|pwd|username|account|secret|access[ _-]?token|token|api[ _-]?key)["\' 　]{0,2}(?:[:：=]|是|为|\\s+is\\s+)["\' 　]?[^\\s"\'，,;；<>（）()]{3,64}'
for (const p of ['config/privacy-policy.json', 'dist/installable/dsh-edge-agent-desktop-safe/config/privacy-policy.json', 'dist/installable/dsh-edge-agent-full/config/privacy-policy.json']) {
  let j
  try { j = JSON.parse(readFileSync(p, 'utf8')) } catch { console.log('skip (missing):', p); continue }
  const rs = j.sanitizationRules
  if (!Array.isArray(rs)) { console.log('no rules:', p); continue }
  const rule = { pattern, dataClass: 'secret', piiType: 'credential', replacement: '<PII_CREDENTIAL_n>' }
  const i = rs.findIndex(r => r.piiType === 'credential')
  if (i >= 0) rs[i] = rule
  else {
    const k = rs.findIndex(r => r.piiType === 'api-key')
    rs.splice(k >= 0 ? k + 1 : rs.length, 0, rule)
  }
  writeFileSync(p, JSON.stringify(j, null, 2) + '\n')
  console.log('synced:', p)
}
const re = new RegExp(pattern)
console.log('用户名掩:', re.test('用户名:admin，密码：147258'))
console.log('归属地回归:', re.test('密码是abc123'))
