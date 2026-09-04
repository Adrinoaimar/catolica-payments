#!/usr/bin/env node

/**
 * Safe, network-optional preflight for the TAYPI sandbox deployment.
 *
 * This script validates shape and environment separation only. It never
 * prints secret values and never creates a payment. Pass --network when a
 * read-only reachability check against sandbox.taypi.pe is desired.
 */

const args = new Set(process.argv.slice(2))
const errors = []
const warnings = []
const env = process.env

const required = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_FIREBASE_APP_ID',
  'DATABASE_URL',
  'FIREBASE_PROJECT_ID',
  'FIREBASE_CLIENT_EMAIL',
  'FIREBASE_PRIVATE_KEY',
  'TAYPI_PUBLIC_KEY',
  'TAYPI_SECRET_KEY',
  'TAYPI_WEBHOOK_SECRET',
]

for (const name of required) {
  if (!String(env[name] ?? '').trim()) errors.push(`${name} is required`)
}

if (value('PAYMENT_PROVIDER').toLowerCase() !== 'taypi') {
  errors.push('PAYMENT_PROVIDER must be taypi for the sandbox')
}

if (value('TAYPI_SANDBOX').toLowerCase() !== 'true') {
  errors.push('TAYPI_SANDBOX must be true for this preflight')
}

const publicKey = value('TAYPI_PUBLIC_KEY')
const secretKey = value('TAYPI_SECRET_KEY')
if (publicKey && !/^taypi_pk_test_[a-f0-9]{32}$/i.test(publicKey)) {
  errors.push('TAYPI_PUBLIC_KEY must match taypi_pk_test_ plus 32 hexadecimal characters')
}
if (secretKey && !/^taypi_sk_test_[a-f0-9]{64}$/i.test(secretKey)) {
  errors.push('TAYPI_SECRET_KEY must match taypi_sk_test_ plus 64 hexadecimal characters')
}

const databaseUrl = value('DATABASE_URL')
if (databaseUrl && !/^postgres(?:ql)?:\/\//i.test(databaseUrl)) {
  errors.push('DATABASE_URL must use postgres:// or postgresql://')
}

const apiUrl = value('TAYPI_API_URL') || 'https://sandbox.taypi.pe'
try {
  const parsed = new URL(apiUrl)
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'sandbox.taypi.pe' || parsed.pathname !== '/') {
    errors.push('TAYPI_API_URL must be https://sandbox.taypi.pe in the sandbox')
  }
} catch {
  errors.push('TAYPI_API_URL must be a valid URL')
}

for (const name of Object.keys(env)) {
  if (/^VITE_(?:.*SECRET|.*SERVICE_ROLE|TAYPI_)/i.test(name)) {
    errors.push(`${name} must not be exposed to the browser`)
  }
}

if (value('FIREBASE_PRIVATE_KEY') && !/PRIVATE KEY/i.test(value('FIREBASE_PRIVATE_KEY'))) {
  warnings.push('FIREBASE_PRIVATE_KEY does not look like a service-account private key; verify Vercel formatting')
}

if (args.has('--network') && errors.length === 0) {
  try {
    const response = await fetch(apiUrl, { method: 'HEAD', signal: AbortSignal.timeout(15_000) })
    if (!response.ok) warnings.push(`TAYPI sandbox responded HTTP ${response.status} to HEAD`)
    else console.log(`TAYPI sandbox reachable: HTTP ${response.status}`)
  } catch (error) {
    errors.push(`TAYPI sandbox is not reachable: ${error instanceof Error ? error.message : 'network error'}`)
  }
}

if (errors.length) {
  console.error('TAYPI sandbox preflight failed:')
  for (const error of errors) console.error(`- ${error}`)
  if (warnings.length) {
    console.error('Warnings:')
    for (const warning of warnings) console.error(`- ${warning}`)
  }
  process.exitCode = 1
} else {
  console.log('TAYPI sandbox environment shape is valid; secret values were not printed.')
  if (!args.has('--network')) console.log('Network check skipped. Re-run with --network to verify sandbox reachability.')
  for (const warning of warnings) console.log(`Warning: ${warning}`)
}

function value(name) {
  return String(env[name] ?? '').trim()
}
