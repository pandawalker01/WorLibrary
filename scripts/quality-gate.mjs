#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

const reportPath = process.env.QUALITY_REPORT_PATH || 'test-results/release-report.json'
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', env: process.env })
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  }
}

function parseConfiguration(result) {
  try {
    return JSON.parse(result.stdout.trim())
  } catch {
    return { status: 'blocked', classification: 'configuration', missing: [], invalid: ['Environment validator did not return JSON'] }
  }
}

function compactOutput(result) {
  const output = `${result.stdout}${result.stderr}`.trim()
  return output.length > 8_000 ? `${output.slice(0, 8_000)}\n…truncated` : output || undefined
}

export function summarise(checks) {
  const codeFailures = checks.filter((check) => check.classification === 'code' && check.status === 'failed')
  const blocked = checks.filter((check) => check.status === 'blocked')
  const configurationBlocked = blocked.filter((check) => check.classification === 'configuration')
  const infrastructureBlocked = blocked.filter((check) => check.classification === 'infrastructure')
  const status = codeFailures.length ? 'failed' : blocked.length ? 'blocked' : 'passed'
  return {
    status,
    exitCode: status === 'passed' ? 0 : status === 'blocked' ? 2 : 1,
    codeFailures: codeFailures.map(({ name }) => name),
    configurationBlocked: configurationBlocked.map(({ name }) => name),
    infrastructureBlocked: infrastructureBlocked.map(({ name }) => name),
  }
}

function classifyPlaywright(result) {
  try {
    const payload = JSON.parse(result.stdout)
    const messages = (payload.errors || []).map((error) => error.message || '').join('\n')
    if (/webServer was not able to start|EACCES|EPERM|address already in use/i.test(messages)) return { classification: 'infrastructure', status: 'blocked' }
  } catch {
    // A non-JSON result is a real test runner failure and remains a code failure.
  }
  return { classification: 'code', status: result.exitCode === 0 ? 'passed' : 'failed' }
}

async function main() {
  const configurationResult = run('node', ['scripts/validate-env.mjs', '--production', '--json'])
  const configuration = parseConfiguration(configurationResult)
  const checks = [{
    name: 'production-environment',
    classification: 'configuration',
    status: configurationResult.exitCode === 0 ? 'passed' : 'blocked',
    details: { missing: configuration.missing || [], invalid: configuration.invalid || [] },
  }]

  for (const [name, command, args] of [
    ['typecheck', npm, ['run', 'typecheck']],
    ['build', npm, ['run', 'build']],
    ['bundle-budget', npm, ['run', 'test:bundle']],
    ['ai-gateway', npm, ['run', 'test:gateway']],
    ['playwright', npx, ['playwright', 'test', '--reporter=json']],
  ]) {
    const result = run(command, args)
    const classification = name === 'playwright' ? classifyPlaywright(result) : { classification: 'code', status: result.exitCode === 0 ? 'passed' : 'failed' }
    checks.push({ name, ...classification, output: compactOutput(result) })
  }

  const outcome = summarise(checks)
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), reportPath, releaseReady: outcome.status === 'passed', ...outcome, checks }
  await mkdir(new URL('.', `file://${process.cwd()}/${reportPath}`).pathname, { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`Quality gate ${report.status}: ${reportPath}\n`)
  if (outcome.configurationBlocked.length) process.stdout.write(`Configuration blocked: ${outcome.configurationBlocked.join(', ')}\n`)
  if (outcome.infrastructureBlocked.length) process.stdout.write(`Infrastructure blocked: ${outcome.infrastructureBlocked.join(', ')}\n`)
  if (outcome.codeFailures.length) process.stderr.write(`Code failures: ${outcome.codeFailures.join(', ')}\n`)
  process.exit(outcome.exitCode)
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) await main()
