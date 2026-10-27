#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const assetsDirectory = 'dist/assets'
const budgets = [
  // Keep the raw budget tight while allowing the stable 350 kB boundary to
  // absorb Vite/Rolldown's small per-build metadata variance. The gzip budget
  // remains the user-impacting guardrail.
  { name: 'application entry', pattern: /^index-[\w-]+\.js$/, maxBytes: 352_000, maxGzipBytes: 110_000 },
  { name: 'EPUB reader chunk', pattern: /^epub-[\w-]+\.js$/, maxBytes: 400_000, maxGzipBytes: 120_000 },
  { name: 'PDF reader chunk', pattern: /^pdf-[\w-]+\.js$/, maxBytes: 500_000, maxGzipBytes: 150_000 },
  { name: 'PDF worker', pattern: /^pdf\.worker\.min-[\w-]+\.mjs$/, maxBytes: 1_400_000, maxGzipBytes: 400_000 },
]

function formatBytes(bytes) {
  return `${(bytes / 1_000).toFixed(1)} kB`
}

async function main() {
  let assets
  try {
    assets = await readdir(assetsDirectory)
  } catch {
    throw new Error(`Missing ${assetsDirectory}. Run npm run build before npm run test:bundle.`)
  }

  const failures = []
  for (const budget of budgets) {
    const file = assets.find((asset) => budget.pattern.test(asset))
    if (!file) {
      failures.push(`${budget.name}: expected a dedicated output chunk`)
      continue
    }

    const content = await readFile(join(assetsDirectory, file))
    const gzipBytes = gzipSync(content).byteLength
    process.stdout.write(`${budget.name}: ${formatBytes(content.byteLength)} raw / ${formatBytes(gzipBytes)} gzip (${file})\n`)
    if (content.byteLength > budget.maxBytes || gzipBytes > budget.maxGzipBytes) {
      failures.push(`${budget.name}: exceeds ${formatBytes(budget.maxBytes)} raw / ${formatBytes(budget.maxGzipBytes)} gzip budget`)
    }
  }

  if (failures.length) throw new Error(`Bundle budget failed:\n- ${failures.join('\n- ')}`)
  process.stdout.write('Bundle budget passed.\n')
}

await main()
