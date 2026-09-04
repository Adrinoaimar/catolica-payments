#!/usr/bin/env node

/** Apply the single additive PostgreSQL migration to Neon.
 *
 * Uses a session-capable client because the migration contains functions and
 * multiple statements. The script never prints DATABASE_URL or query text.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Pool } from '@neondatabase/serverless'

const connectionString = String(process.env.DATABASE_URL ?? '').trim()
if (!connectionString) fail('DATABASE_URL is required')
if (!/^postgres(?:ql)?:\/\//i.test(connectionString)) fail('DATABASE_URL must use postgres:// or postgresql://')

const migrationPath = fileURLToPath(new URL('../database/migrations/0001_initial.sql', import.meta.url))
const migration = await readFile(migrationPath, 'utf8')
if (!migration.trim()) fail('database/migrations/0001_initial.sql is empty')

const pool = new Pool({ connectionString })
try {
  await pool.query('BEGIN')
  await pool.query(migration)
  await pool.query('COMMIT')
  console.log('Neon migration 0001_initial.sql applied successfully.')
} catch (error) {
  try { await pool.query('ROLLBACK') } catch { /* Preserve original failure. */ }
  console.error(`Neon migration failed: ${error instanceof Error ? error.message : 'database error'}`)
  process.exitCode = 1
} finally {
  await pool.end()
}

function fail(message) {
  console.error(`Neon migration blocked: ${message}`)
  process.exit(1)
}
