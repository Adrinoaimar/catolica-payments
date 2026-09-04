#!/usr/bin/env node

const errors = []
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
  'CRON_SECRET',
  'TAYPI_PUBLIC_KEY',
  'TAYPI_SECRET_KEY',
  'TAYPI_WEBHOOK_SECRET',
]

for (const name of required) {
  if (!String(env[name] ?? '').trim()) errors.push(`${name} is required`)
}

if (String(env.PAYMENT_PROVIDER ?? '').trim().toLowerCase() !== 'taypi') {
  errors.push('PAYMENT_PROVIDER must be taypi for a production deployment')
}

if (String(env.VITE_DEMO_MODE ?? '').trim().toLowerCase() === 'true') {
  errors.push('VITE_DEMO_MODE must not be true in production')
}

if (String(env.TAYPI_SANDBOX ?? '').trim().toLowerCase() === 'true') {
  errors.push('TAYPI_SANDBOX must not be true in production')
}

if (/^taypi_(?:pk|sk)_test_/i.test(String(env.TAYPI_PUBLIC_KEY ?? '').trim())
  || /^taypi_(?:pk|sk)_test_/i.test(String(env.TAYPI_SECRET_KEY ?? '').trim())) {
  errors.push('TAYPI test keys must not be used in production')
}

if (!/^taypi_pk_live_[A-Za-z0-9_-]+$/.test(String(env.TAYPI_PUBLIC_KEY ?? '').trim())
  || !/^taypi_sk_live_[A-Za-z0-9_-]+$/.test(String(env.TAYPI_SECRET_KEY ?? '').trim())) {
  errors.push('TAYPI live keys are required in production')
}

if (String(env.CRON_SECRET ?? '').trim().length < 32) {
  errors.push('CRON_SECRET must contain at least 32 characters')
}

for (const name of ['TAYPI_API_URL']) {
  const value = String(env[name] ?? '').trim()
  if (!value) continue
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
      errors.push(`${name} must use HTTPS`)
    }
  } catch {
    errors.push(`${name} must be a valid URL`)
  }
}

if (String(env.TAYPI_API_URL ?? '').trim()) {
  try {
    const url = new URL(String(env.TAYPI_API_URL).trim())
    if (url.protocol !== 'https:' || url.hostname !== 'app.taypi.pe') {
      errors.push('TAYPI_API_URL must be https://app.taypi.pe in production')
    }
  } catch { /* URL validation above reports malformed values. */ }
}

for (const name of Object.keys(env)) {
  if (/^VITE_(?:.*SECRET|.*SERVICE_ROLE|TAYPI_)/i.test(name)) {
    errors.push(`${name} must not be exposed to the browser`)
  }
}

if (errors.length) {
  console.error('Production environment is not ready:')
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
} else {
  console.log('Production environment shape is valid; secret values were not printed.')
}
