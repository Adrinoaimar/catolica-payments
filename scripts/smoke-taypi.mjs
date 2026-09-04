#!/usr/bin/env node

/**
 * End-to-end smoke runner for a deployed Catolica Payments sandbox.
 *
 * It creates one low-value sandbox payment, retries the same request with
 * the same idempotency key, reads the payment, then waits for the real TAYPI
 * webhook. It never marks a payment paid from the client.
 *
 * Required environment:
 *   APP_BASE_URL, FIREBASE_ID_TOKEN, TAYPI_SMOKE_CONFIRM=SANDBOX_ONLY
 * Optional:
 *   SMOKE_AMOUNT_CENTS (default 100), SMOKE_WAIT_SECONDS (default 30),
 *   SMOKE_REFERENCE (poll an already-created reference),
 *   SMOKE_ALLOW_PENDING=true (return success before simulator/webhook step)
 */

import { randomUUID } from 'node:crypto'

const env = process.env
const baseUrl = String(env.APP_BASE_URL ?? '').trim().replace(/\/+$/, '')
const idToken = String(env.FIREBASE_ID_TOKEN ?? '').trim()
const confirm = String(env.TAYPI_SMOKE_CONFIRM ?? '').trim()
const existingReference = String(env.SMOKE_REFERENCE ?? '').trim().toUpperCase()
const amountCents = parsePositiveInteger(env.SMOKE_AMOUNT_CENTS, 100)
const waitSeconds = parseNonNegativeInteger(env.SMOKE_WAIT_SECONDS, 30)
const allowPending = String(env.SMOKE_ALLOW_PENDING ?? '').trim().toLowerCase() === 'true'

const errors = []
if (!baseUrl) errors.push('APP_BASE_URL is required')
if (!idToken) errors.push('FIREBASE_ID_TOKEN is required')
if (confirm !== 'SANDBOX_ONLY') errors.push('TAYPI_SMOKE_CONFIRM must equal SANDBOX_ONLY')
if (!Number.isSafeInteger(amountCents) || amountCents <= 0) errors.push('SMOKE_AMOUNT_CENTS must be a positive integer')
if (!Number.isSafeInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 900) errors.push('SMOKE_WAIT_SECONDS must be between 0 and 900')
try {
  const parsed = new URL(baseUrl)
  if (!['https:', 'http:'].includes(parsed.protocol)) errors.push('APP_BASE_URL must use HTTPS (HTTP is allowed only for localhost)')
  if (parsed.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) errors.push('APP_BASE_URL HTTP is allowed only for localhost')
} catch {
  errors.push('APP_BASE_URL must be a valid URL')
}

if (errors.length) fail(errors)

let reference = existingReference || ''
let createdPayment
if (!reference) {
  const idempotencyKey = `taypi-smoke-${randomUUID()}`
  const body = JSON.stringify({ amount_cents: amountCents, method: 'DIGITAL' })
  createdPayment = await request('/api/payments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body,
  })
  assertStatus(createdPayment, 201, 'create sandbox payment')
  reference = readReference(createdPayment.body)
  const retry = await request('/api/payments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body,
  })
  assertStatus(retry, 201, 'idempotent retry')
  const retryReference = readReference(retry.body)
  if (retryReference !== reference) fail([`idempotent retry returned a different reference (${retryReference})`])
  console.log(`Created sandbox payment ${reference} for S/${(amountCents / 100).toFixed(2)}.`)
  console.log('Open its QR/checkout in the app, then complete it in TAYPI sandbox simulator: https://sandbox.taypi.pe/simulator')
} else if (!/^CAT-\d{8}-[A-Z2-9]{6}$/.test(reference)) {
  fail(['SMOKE_REFERENCE has invalid format'])
}

let payment = null
const deadline = Date.now() + waitSeconds * 1000
do {
  const response = await request(`/api/payments/${encodeURIComponent(reference)}`)
  assertStatus(response, 200, 'read sandbox payment')
  payment = readPayment(response.body)
  if (payment.status !== 'PENDING') break
  if (Date.now() >= deadline) break
  await sleep(Math.min(5_000, Math.max(250, deadline - Date.now())))
} while (true)

if (payment.status === 'PAID') {
  console.log(`Sandbox E2E passed: ${reference} is PAID.`)
  process.exit(0)
}

if (payment.status === 'PENDING') {
  // One server-side reconciliation request is useful after the user scans
  // the QR but the webhook is delayed. It still cannot mark anything paid
  // unless TAYPI reports a terminal state.
  const reconcile = await request(`/api/payments/${encodeURIComponent(reference)}/reconcile`, { method: 'POST' })
  if (reconcile.status >= 200 && reconcile.status < 300) {
    payment = readPayment(reconcile.body)
    if (payment.status === 'PAID') {
      console.log(`Sandbox E2E passed after reconciliation: ${reference} is PAID.`)
      process.exit(0)
    }
  }
  console.error(`Sandbox payment remains ${payment.status}: ${reference}`)
  console.error('Complete it in the TAYPI simulator, then rerun with SMOKE_REFERENCE and a larger SMOKE_WAIT_SECONDS.')
  process.exitCode = allowPending ? 0 : 2
  process.exit()
}

console.error(`Sandbox E2E stopped at terminal state ${payment.status}: ${reference}`)
process.exitCode = 3

async function request(path, init = {}) {
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${idToken}`, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(20_000),
    })
    const text = await response.text()
    let body = {}
    try { body = text ? JSON.parse(text) : {} } catch { body = { error: 'non-JSON response' } }
    return { status: response.status, body }
  } catch (error) {
    fail([`${path} failed: ${error instanceof Error ? error.message : 'network error'}`])
  }
}

function assertStatus(response, expected, action) {
  if (response.status !== expected) {
    const message = typeof response.body?.error === 'string' ? response.body.error : `HTTP ${response.status}`
    fail([`${action} failed: ${message}`])
  }
}

function readReference(body) {
  const reference = typeof body?.payment?.reference === 'string' ? body.payment.reference.trim().toUpperCase() : ''
  if (!/^CAT-\d{8}-[A-Z2-9]{6}$/.test(reference)) fail(['API response did not include a valid payment reference'])
  return reference
}

function readPayment(body) {
  const payment = body?.payment && typeof body.payment === 'object' ? body.payment : body
  if (!payment || typeof payment.status !== 'string') fail(['API response did not include payment status'])
  return payment
}

function parsePositiveInteger(raw, fallback) {
  if (raw === undefined || raw === '') return fallback
  return /^\d+$/.test(String(raw)) ? Number(raw) : NaN
}

function parseNonNegativeInteger(raw, fallback) {
  if (raw === undefined || raw === '') return fallback
  return /^\d+$/.test(String(raw)) ? Number(raw) : NaN
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function fail(messages) {
  console.error('TAYPI sandbox smoke failed:')
  for (const message of messages) console.error(`- ${message}`)
  process.exit(1)
}
