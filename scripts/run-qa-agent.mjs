import { mkdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

const command = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const result = spawnSync(command, ['playwright', 'test', 'tests/qa', '--reporter=json'], {
  encoding: 'utf8',
  env: process.env,
})

let report
try {
  report = JSON.parse(result.stdout || '{}')
} catch {
  report = { rawOutput: result.stdout }
}

const summary = {
  generatedAt: new Date().toISOString(),
  exitCode: result.status ?? 1,
  status: result.status === 0 ? 'passed' : 'failed',
  report,
  stderr: result.stderr || undefined,
}

await mkdir('test-results', { recursive: true })
await writeFile('test-results/qa-report.json', `${JSON.stringify(summary, null, 2)}\n`)
process.stdout.write(`QA ${summary.status}: test-results/qa-report.json\n`)
if (result.stderr) process.stderr.write(result.stderr)
process.exit(summary.exitCode)
