#!/usr/bin/env node
/**
 * verify-tag-version.mjs — the tag↔manifest-version assertion, in ONE place.
 *
 * ## Why it exists
 *
 * The `v*` tag is what triggers the publish workflow, and the artefacts that
 * workflow ships carry a version of their own:
 *
 *   - the npm package    — `package.json#version` (the staged manifest);
 *   - the git tarballs   — `package.json#version` + the variant suffix
 *                          (`0.1.3-desktop-safe`, `0.1.3-full`).
 *
 * A tag that does not match the manifest publishes a version nobody can find:
 * the release would be titled `v0.1.4` while its assets are `0.1.3-*`.
 *
 * This check existed as six lines of inline shell in the npm job only. The git
 * release job (§7.201) needs the same assertion — it ships the same versioned
 * artefacts — and **two copies of one rule drift** (the repository already
 * learned that with the CHANGELOG check, which moved into
 * `scripts/verify-npm-publish.mjs --check-changelog` for exactly this reason).
 *
 * ## Usage
 *
 *   node scripts/verify-tag-version.mjs v0.1.4        # check a tag
 *   node scripts/verify-tag-version.mjs 0.1.4         # the leading `v` is optional
 *   node scripts/verify-tag-version.mjs --selftest    # self-proof + refutation
 *
 * Exit codes: 0 = the tag matches; 1 = it does not; 2 = usage/selftest error.
 *
 * Read-only: writes nothing inside the repository.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Strip the leading `v` a git tag conventionally carries.
 *
 * @param {string} tag
 * @returns {string}
 */
export function normalizeTag(tag) {
  return String(tag ?? '').trim().replace(/^v/u, '')
}

/**
 * Does the tag name the manifest's version?
 *
 * @param {string} tag the tag as pushed (with or without the leading `v`)
 * @param {string} version the manifest's version
 * @returns {boolean}
 */
export function tagMatchesVersion(tag, version) {
  return normalizeTag(tag) === String(version ?? '').trim()
}

/* ── self-proof + refutation ───────────────────────────────────────────── */

function selftest() {
  let failures = 0
  const expect = (label, actual, wanted) => {
    const ok = actual === wanted
    if (!ok) failures++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label} — expected ${wanted}, got ${actual}`)
  }

  console.log('verify-tag-version --selftest')

  expect('带 v 的 tag 匹配', tagMatchesVersion('v0.1.4', '0.1.4'), true)
  expect('不带 v 的 tag 也匹配', tagMatchesVersion('0.1.4', '0.1.4'), true)
  expect('版本不同 ⇒ 不匹配', tagMatchesVersion('v0.1.4', '0.1.3'), false)
  expect('前缀相同但版本不同 ⇒ 不匹配', tagMatchesVersion('v0.1.40', '0.1.4'), false)
  expect('空 tag ⇒ 不匹配', tagMatchesVersion('', '0.1.4'), false)
  expect('剥 v', normalizeTag('v1.2.3'), '1.2.3')

  if (failures > 0) {
    console.error(`\nselftest FAILED: ${failures} assertion(s)`)
    process.exit(2)
  }
  console.log('\nselftest OK —— tag 与清单版本一致时放行，不一致时拦住')
}

/* ── entry ──────────────────────────────────────────────────────────────── */

const args = process.argv.slice(2)

const isEntry = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isEntry) {
  if (args.includes('--selftest')) {
    selftest()
  } else if (args.length !== 1) {
    console.error('usage: node scripts/verify-tag-version.mjs <tag> | --selftest')
    process.exit(2)
  } else {
    const tag = args[0]
    const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
    if (tagMatchesVersion(tag, version)) {
      console.log(`tag ${tag} matches package.json#version ${version}`)
    } else {
      console.error(
        `::error::tag ${tag} does not match package.json#version ${version} — the published`
        + ' artefacts would carry a version nobody can find.',
      )
      process.exit(1)
    }
  }
}
