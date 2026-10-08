#!/usr/bin/env node

const production = process.argv.includes('--production') || process.env.REQUIRE_PRODUCTION_ENV === 'true'
const jsonOutput = process.argv.includes('--json')
const values = process.env
const missing = []
const invalid = []

function required(name) {
  if (!values[name]?.trim()) missing.push(name)
}

function url(name) {
  const value = values[name]?.trim()
  if (!value) return required(name)
  try {
    const parsed = new URL(value)
    if (!['http:', 'https:'].includes(parsed.protocol)) invalid.push(`${name} must use http or https`)
  } catch {
    invalid.push(`${name} must be a valid URL`)
  }
}

// Browser configuration is required for a deployable build. The anon key is
// intentionally public; service-role and AI keys must never be VITE_ variables.
url('VITE_SUPABASE_URL')
required('VITE_SUPABASE_ANON_KEY')

if (production) {
  required('AI_PROVIDER')
  required('AI_MODEL')
  required('AI_API_KEY')
  url('AI_BASE_URL')
  if (values.VITE_AI_API_KEY || values.VITE_OPENAI_API_KEY) invalid.push('AI provider secrets must not use the VITE_ prefix')
}

if (missing.length || invalid.length) {
  if (jsonOutput) {
    console.log(JSON.stringify({ status: 'blocked', classification: 'configuration', production, missing, invalid }))
  } else {
    if (missing.length) console.error(`Missing environment variables: ${missing.join(', ')}`)
    for (const message of invalid) console.error(`Invalid environment: ${message}`)
  }
  process.exit(1)
}

if (jsonOutput) console.log(JSON.stringify({ status: 'passed', classification: 'configuration', production, missing: [], invalid: [] }))
else console.log(production ? 'Production environment contract: OK' : 'Browser environment contract: OK')
