#!/usr/bin/env node

const profile = process.argv.includes('--production') || process.env.REQUIRE_PRODUCTION_ENV === 'true' ? 'production' : process.argv.includes('--staging') ? 'staging' : 'browser'
const deployment = process.argv.includes('--deployment')
const jsonOutput = process.argv.includes('--json')
const values = process.env
const missing = []
const invalid = []
const warnings = []
const capabilities = {}

const placeholderValues = new Set([
  'your-anon-key',
  'your-api-key',
  'replace-me',
  'changeme',
  'example',
])

function supplied(name) {
  return Boolean(values[name]?.trim())
}

function required(name) {
  if (!supplied(name)) missing.push(name)
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
    if ((profile === 'production' || profile === 'staging') && parsed.protocol !== 'https:') invalid.push(`${name} must use https in ${profile}`)
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

function any(names) {
  return names.some(supplied)
}

function publicSupabase({ mandatory }) {
  const names = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']
  if (!mandatory && !any(names)) {
    capabilities.supabase = 'disabled'
    warnings.push('Supabase is not configured: authentication and cloud sync stay disabled')
    return
  }
  capabilities.supabase = 'enabled'
  url('VITE_SUPABASE_URL')
  required('VITE_SUPABASE_ANON_KEY')
  notPlaceholder('VITE_SUPABASE_URL')
  notPlaceholder('VITE_SUPABASE_ANON_KEY')
}

function sharedGatewaySecurity() {
  url('SUPABASE_URL')
  required('SUPABASE_ANON_KEY')
  required('SUPABASE_JWT_SECRET')
  exactOrigin('ALLOWED_ORIGIN')
  for (const name of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_JWT_SECRET']) notPlaceholder(name)
}

function aiGateway({ mandatory }) {
  const names = ['AI_PROVIDER', 'AI_MODEL', 'AI_API_KEY', 'AI_BASE_URL', 'AI_ENV', 'AI_REQUIRE_AUTH']
  if (!mandatory && !any(names)) {
    capabilities.ai = 'disabled'
    warnings.push('AI gateway is not configured: translation and explanation use the safe unavailable state')
    return false
  }
  capabilities.ai = 'enabled'
  required('AI_PROVIDER')
  required('AI_MODEL')
  required('AI_API_KEY')
  url('AI_BASE_URL')
  required('AI_ENV')
  required('AI_REQUIRE_AUTH')
  if (values.AI_PROVIDER?.trim().toLowerCase() === 'mock') invalid.push(`AI_PROVIDER must not be mock in ${profile}`)
  if (supplied('AI_ENV') && values.AI_ENV.trim() !== 'production') invalid.push(`AI_ENV must be production when AI is enabled in ${profile}`)
  if (supplied('AI_REQUIRE_AUTH') && values.AI_REQUIRE_AUTH.trim() !== 'true') invalid.push(`AI_REQUIRE_AUTH must be true when AI is enabled in ${profile}`)
  for (const name of ['AI_API_KEY', 'AI_MODEL', 'AI_BASE_URL']) notPlaceholder(name)
  return true
}

function ocrGateway({ mandatory }) {
  const names = ['OCR_PROVIDER', 'OCR_API_KEY', 'OCR_BASE_URL', 'OCR_ENV', 'OCR_REQUIRE_AUTH']
  if (!mandatory && !any(names)) {
    capabilities.ocr = 'disabled'
    warnings.push('OCR gateway is not configured: page recognition uses the safe unavailable state')
    return false
  }
  capabilities.ocr = 'enabled'
  required('OCR_PROVIDER')
  required('OCR_API_KEY')
  url('OCR_BASE_URL')
  required('OCR_ENV')
  required('OCR_REQUIRE_AUTH')
  if (values.OCR_PROVIDER?.trim().toLowerCase() === 'mock') invalid.push(`OCR_PROVIDER must not be mock in ${profile}`)
  if (supplied('OCR_ENV') && values.OCR_ENV.trim() !== 'production') invalid.push(`OCR_ENV must be production when OCR is enabled in ${profile}`)
  if (supplied('OCR_REQUIRE_AUTH') && values.OCR_REQUIRE_AUTH.trim() !== 'true') invalid.push(`OCR_REQUIRE_AUTH must be true when OCR is enabled in ${profile}`)
  for (const name of ['OCR_API_KEY', 'OCR_BASE_URL']) notPlaceholder(name)
  return true
}

function vercelDeployment() {
  if (!deployment) {
    capabilities.vercel = 'not_checked'
    return
  }
  capabilities.vercel = 'enabled'
  required('VERCEL_TOKEN')
  required('VERCEL_ORG_ID')
  required('VERCEL_PROJECT_ID')
}

// Browser builds remain useful for local-first reading without any cloud account.
// When one public Supabase value is supplied, require the pair so an accidental
// half-configured deployment does not appear to have working sign-in/sync.
publicSupabase({ mandatory: profile === 'production' })

if (profile === 'production') {
  const aiEnabled = aiGateway({ mandatory: true })
  const ocrEnabled = ocrGateway({ mandatory: true })
  if (aiEnabled || ocrEnabled) sharedGatewaySecurity()
} else if (profile === 'staging') {
  const aiEnabled = aiGateway({ mandatory: false })
  const ocrEnabled = ocrGateway({ mandatory: false })
  if (aiEnabled || ocrEnabled) sharedGatewaySecurity()
} else {
  capabilities.ai = supplied('AI_PROVIDER') ? 'not_checked' : 'disabled'
  capabilities.ocr = supplied('OCR_PROVIDER') ? 'not_checked' : 'disabled'
  capabilities.vercel = 'not_checked'
}

vercelDeployment()

for (const name of Object.keys(values)) {
  if (/^VITE_.*(?:API_KEY|SECRET|SERVICE_ROLE|TOKEN)/.test(name) && name !== 'VITE_SUPABASE_ANON_KEY') {
    invalid.push(`${name} must not be exposed with the VITE_ prefix`)
  }
}

const payload = {
  status: missing.length || invalid.length ? 'blocked' : 'passed',
  classification: 'configuration',
  profile,
  deployment,
  missing,
  invalid,
  warnings,
  capabilities,
}

if (payload.status === 'blocked') {
  if (jsonOutput) console.log(JSON.stringify(payload))
  else {
    if (missing.length) console.error(`Missing environment variables: ${missing.join(', ')}`)
    for (const message of invalid) console.error(`Invalid environment: ${message}`)
    for (const message of warnings) console.warn(`Warning: ${message}`)
  }
  process.exit(1)
}

if (jsonOutput) console.log(JSON.stringify(payload))
else {
  for (const message of warnings) console.warn(`Warning: ${message}`)
  console.log(`${profile === 'production' ? 'Production' : profile === 'staging' ? 'Staging' : 'Browser'} environment contract: OK`)
}
