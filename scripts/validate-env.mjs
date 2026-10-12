#!/usr/bin/env node

const production = process.argv.includes('--production') || process.env.REQUIRE_PRODUCTION_ENV === 'true'
const jsonOutput = process.argv.includes('--json')
const values = process.env
const missing = []
const invalid = []

const placeholderValues = new Set([
  'your-anon-key',
  'your-api-key',
  'replace-me',
  'changeme',
  'example',
])

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

function exactOrigin(name) {
  const value = values[name]?.trim()
  if (!value) return required(name)
  try {
    const parsed = new URL(value)
    if (parsed.origin !== value.replace(/\/$/, '')) invalid.push(`${name} must be one exact origin without a path`)
    if (production && parsed.protocol !== 'https:') invalid.push(`${name} must use https in production`)
    if (value === '*') invalid.push(`${name} must not be a wildcard`)
  } catch {
    invalid.push(`${name} must be a valid origin`)
  }
}

function notPlaceholder(name) {
  const value = values[name]?.trim().toLowerCase()
  if (!value) return
  if (placeholderValues.has(value) || value.includes('your-project') || value.includes('placeholder')) invalid.push(`${name} still contains a placeholder value`)
}

// Browser configuration is required for a deployable build. The anon key is
// intentionally public; service-role and AI keys must never be VITE_ variables.
url('VITE_SUPABASE_URL')
required('VITE_SUPABASE_ANON_KEY')
notPlaceholder('VITE_SUPABASE_URL')
notPlaceholder('VITE_SUPABASE_ANON_KEY')

if (production) {
  required('AI_PROVIDER')
  required('AI_MODEL')
  required('AI_API_KEY')
  url('AI_BASE_URL')
  url('SUPABASE_URL')
  required('SUPABASE_ANON_KEY')
  required('OCR_PROVIDER')
  required('OCR_API_KEY')
  url('OCR_BASE_URL')
  exactOrigin('ALLOWED_ORIGIN')
  if (values.AI_PROVIDER?.trim().toLowerCase() === 'mock') invalid.push('AI_PROVIDER must not be mock in production')
  if (values.OCR_PROVIDER?.trim().toLowerCase() === 'mock') invalid.push('OCR_PROVIDER must not be mock in production')
  if (values.AI_ENV?.trim() !== 'production') invalid.push('AI_ENV must be production')
  if (values.OCR_ENV?.trim() !== 'production') invalid.push('OCR_ENV must be production')
  if (values.AI_REQUIRE_AUTH?.trim() !== 'true') invalid.push('AI_REQUIRE_AUTH must be true in production')
  for (const name of ['AI_API_KEY', 'AI_MODEL', 'AI_BASE_URL', 'OCR_API_KEY', 'OCR_BASE_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY']) notPlaceholder(name)
  for (const name of Object.keys(values)) {
    if (/^VITE_.*(?:API_KEY|SECRET|SERVICE_ROLE|TOKEN)/.test(name) && name !== 'VITE_SUPABASE_ANON_KEY') {
      invalid.push(`${name} must not be exposed with the VITE_ prefix`)
    }
  }
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
