import assert from 'node:assert/strict'
import test from 'node:test'
import { summarise } from './quality-gate.mjs'

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
