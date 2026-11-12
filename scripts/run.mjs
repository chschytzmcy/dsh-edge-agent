/**
 * run.mjs — package-manager-agnostic script runner.
 *
 * Why this exists (2026-10-23): every chain script in package.json used to
 * shell out to `npm run <other>`. The DSH desktop runtime ships **node +
 * pnpm but no npm** (`runtime/primary-runtime/dependencies/` = node, pnpm,
 * python — nothing else), so `pnpm run build` died at the first nested call
 * with `sh: npm: command not found`. The standalone `make package` /
 * `install.sh` path had the same hole: it shells out to `pnpm run compile`,
 * which then shelled out to `npm run clean`.
 *
 * This runner resolves script names straight from package.json#scripts and
 * executes them with the local shell. package.json refers to other scripts
 * as `node scripts/run.mjs <name>` — no package manager in the loop — so the
 * same tree builds under npm, under pnpm, or with neither installed.
 *
 * Usage:
 *   node scripts/run.mjs build
 *   node scripts/run.mjs verify:build
 *   node scripts/run.mjs compile verify:installable
 *
 * A script exits non-zero when any of the scripts it chains fails; the
 * failing step's output is already on the terminal (stdio is inherited).
 *
 * §7.196 (2026-11-12): **失败的门禁名必须能被机器读到**。
 *
 * CI 红了以后，失败原因此前只存在于 run 的 log 里，而 GitHub 的 log 下载
 * 需要 admin 权限（匿名 API 返回 403 `Must have admin rights to
 * Repository.`）、网页上的 log 又要求登录 ⇒ 外部只看得见一句
 * 「Process completed with exit code 1.」，**看不出是哪道门禁红的**。
 *
 * 这里把子进程的输出接过来（仍然原样转发给人看），并在失败时发一条
 * GitHub Actions 注解（`::error::`）—— 注解是**公开可读**的：
 * `GET /repos/{owner}/{repo}/check-runs/{id}/annotations` 匿名就能取到。
 * ⇒ 门禁失败**不需要登录、不需要 admin** 就能定位到具体是哪一道。
 *
 * 注解里只放失败门禁的输出尾巴（默认 2000 字符），并且过一遍凭据脱敏
 * （`npm_…` / `gh?_…` / `sk-…`）—— 门禁不该回显凭据，注解也不该。
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BIN = resolve(ROOT, 'node_modules', '.bin')

const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'))
const scripts = pkg.scripts ?? {}

/** 注解里保留的输出尾巴长度（字符）。够看出「哪道门禁、哪几条失败」。 */
const ANNOTATION_TAIL_CHARS = 2000

/** 把常见凭据形状打码 —— 注解是公开可读的，绝不能带凭据出去。 */
function redact(text) {
  return text
    .replace(/\b(npm_[A-Za-z0-9]{16,})\b/g, 'npm_***')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{16,})\b/g, 'gh_***')
    .replace(/\b(sk-[A-Za-z0-9]{16,})\b/g, 'sk-***')
}

/** 失败时发一条 GitHub Actions 注解（公开 API 可读 ⇒ 不必登录看 log）。 */
function emitFailureAnnotation(name, code, tail) {
  const body = [`gate ${name} failed (exit code ${code})`, tail.trim()]
    .filter(Boolean)
    .join('\n')
  const encoded = redact(body)
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A')
  console.error(`::error title=gate failed::${encoded}`)
}

/** Run one script body in a shell, resolving to its exit code. */
function run(name) {
  const body = scripts[name]
  if (body === undefined) {
    console.error(`run: no such script "${name}" in package.json`)
    return Promise.resolve({ code: 1, tail: '' })
  }
  console.log(`> ${name}: ${body}`)
  return new Promise((done) => {
    const child = spawn(body, {
      cwd: ROOT,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // tsc / vitest / esbuild live in node_modules/.bin. npm and pnpm put
        // that directory on PATH when they run a script; this runner may be
        // invoked from a bare shell, so it puts it there itself.
        PATH: `${BIN}${delimiter()}${process.env.PATH ?? ''}`,
      },
    })
    // 输出照旧转发给人看（stdio 由 inherit 改成 pipe 只是为了留一份尾巴）。
    let tail = ''
    const tee = (stream, out) => {
      stream.on('data', (chunk) => {
        const text = chunk.toString('utf8')
        tail = (tail + text).slice(-ANNOTATION_TAIL_CHARS * 2)
        out.write(text)
      })
    }
    tee(child.stdout, process.stdout)
    tee(child.stderr, process.stderr)
    child.on('close', (code) => done({ code: code ?? 1, tail }))
    child.on('error', (err) => {
      console.error(`run: ${name} failed to start: ${err.message}`)
      done({ code: 1, tail })
    })
  })
}

function delimiter() {
  return process.platform === 'win32' ? ';' : ':'
}

const names = process.argv.slice(2)
if (names.length === 0) {
  console.error('usage: node scripts/run.mjs <script> [<script> ...]')
  process.exit(2)
}

for (const name of names) {
  const { code, tail } = await run(name)
  if (code !== 0) {
    emitFailureAnnotation(name, code, tail)
    process.exit(code)
  }
}
