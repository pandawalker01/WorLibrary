import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { summarise } from './quality-gate.mjs'

for (const failed of [false, true]) {
  test(`CLI executes child checks and writes a report with exit status (${failed ? 'failed' : 'passed'})`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'quality cli space-'))
    try {
      await mkdir(join(root, 'scripts'))
      await copyFile(new URL('./quality-gate.mjs', import.meta.url), join(root, 'scripts/quality-gate.mjs'))
      await writeFile(join(root, 'scripts/validate-env.mjs'), 'console.log(JSON.stringify({missing:[],invalid:[]}))')
      const npmCli = join(root, 'fake npm.mjs')
      await writeFile(npmCli, `console.log(JSON.stringify({errors:[]})); process.exit(process.argv.includes('build') && ${failed} ? 7 : 0)`)
      const reportPath = join(root, 'reports with spaces', 'release.json')
      const result = spawnSync(process.execPath, [join(root, 'scripts/quality-gate.mjs')], {
        cwd: root, encoding: 'utf8', env: { ...process.env, npm_execpath: npmCli, QUALITY_REPORT_PATH: reportPath },
      })
      assert.equal(result.status, failed ? 1 : 0, result.stderr)
      const report = JSON.parse(await readFile(reportPath, 'utf8'))
      assert.equal(report.releaseReady, !failed)
      assert.equal(report.checks.length, 8)
      assert.deepEqual(report.codeFailures, failed ? ['build'] : [])
      assert.ok(report.checks.every(check => check.name === 'build' && failed || check.status === 'passed'))
    } finally { await rm(root, { recursive: true, force: true }) }
  })
}

test('quality report treats missing deployment configuration as blocked, not a code failure', () => {
  const result = summarise([
    { name: 'production-environment', classification: 'configuration', status: 'blocked' },
    { name: 'typecheck', classification: 'code', status: 'passed' },
  ])
  assert.equal(result.status, 'blocked')
  assert.equal(result.exitCode, 2)
  assert.deepEqual(result.configurationBlocked, ['production-environment'])
  assert.deepEqual(result.codeFailures, [])
})

test('code failures remain failures even when configuration is blocked', () => {
  const result = summarise([
    { name: 'production-environment', classification: 'configuration', status: 'blocked' },
    { name: 'playwright', classification: 'code', status: 'failed' },
  ])
  assert.equal(result.status, 'failed')
  assert.equal(result.exitCode, 1)
  assert.deepEqual(result.codeFailures, ['playwright'])
})

test('test infrastructure blockers do not masquerade as code failures', () => {
  const result = summarise([
    { name: 'playwright', classification: 'infrastructure', status: 'blocked' },
    { name: 'typecheck', classification: 'code', status: 'passed' },
  ])
  assert.equal(result.status, 'blocked')
  assert.equal(result.exitCode, 2)
  assert.deepEqual(result.infrastructureBlocked, ['playwright'])
  assert.deepEqual(result.codeFailures, [])
})
