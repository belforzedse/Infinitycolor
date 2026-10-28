'use strict'

const DEFAULT_DEADLINE_MS = 120_000
const DEFAULT_RETRY_INTERVAL_MS = 1_000
const PER_OPERATION_TIMEOUT_MS = 3_000

const FATAL_DATABASE_CODES = new Set([
  '08P01', // protocol violation
  '28P01', // invalid password
  '28000', // invalid authorization specification
  '3D000', // database does not exist
  '42501', // insufficient privilege
])
const RETRYABLE_ERROR_MESSAGES = new Map([
  ['timeout expired', 'ETIMEDOUT'],
  ['Connection terminated due to connection timeout', 'ETIMEDOUT'],
  ['Query read timeout', 'ETIMEDOUT'],
  ['Connection terminated unexpectedly', 'ECONNRESET'],
])

function databaseConfigFromEnv(env) {
  const required = [
    'DATABASE_HOST',
    'DATABASE_PORT',
    'DATABASE_NAME',
    'DATABASE_USERNAME',
    'DATABASE_PASSWORD',
  ]
  const missing = required.filter((key) => !env[key])
  if (missing.length) {
    throw new Error(`Database readiness check requires ${missing.join(', ')}`)
  }

  const port = Number(env.DATABASE_PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Database readiness check requires a valid DATABASE_PORT')
  }

  return {
    host: env.DATABASE_HOST,
    port,
    database: env.DATABASE_NAME,
    user: env.DATABASE_USERNAME,
    password: env.DATABASE_PASSWORD,
  }
}

function errorCode(error) {
  if (typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)) {
    return error.code
  }
  return RETRYABLE_ERROR_MESSAGES.get(error?.message) || 'unknown'
}

function isRetryable(error) {
  const code = errorCode(error)
  if (FATAL_DATABASE_CODES.has(code)) return false

  return (
    code.startsWith('08') ||
    code === '57P01' ||
    code === '57P02' ||
    code === '57P03' ||
    code === '53300' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'EAI_AGAIN'
  )
}

async function waitForDatabase({
  Client,
  env = process.env,
  timeoutMs = DEFAULT_DEADLINE_MS,
  retryIntervalMs = DEFAULT_RETRY_INTERVAL_MS,
  operationTimeoutMs = PER_OPERATION_TIMEOUT_MS,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (typeof Client !== 'function') {
    throw new TypeError('A PostgreSQL Client constructor is required')
  }
  const config = databaseConfigFromEnv(env)
  const deadline = now() + timeoutMs
  let lastErrorCode = 'unknown'

  while (now() < deadline) {
    const remainingMs = deadline - now()
    const client = new Client({
      ...config,
      connectionTimeoutMillis: Math.max(1, Math.min(operationTimeoutMs, remainingMs)),
      query_timeout: Math.max(1, Math.min(operationTimeoutMs, remainingMs)),
    })

    let attemptError
    let emittedClientError
    // pg 8.x emits client-level errors for dead sockets after it rejects any
    // active query. Keep this listener for the client's lifetime so late
    // teardown events cannot become uncaught EventEmitter errors.
    client.on('error', (error) => {
      if (!emittedClientError) emittedClientError = error
    })
    try {
      await client.connect()
      if (emittedClientError) throw emittedClientError
      await client.query('SELECT 1')
      if (emittedClientError) throw emittedClientError
    } catch (error) {
      attemptError = error
    } finally {
      try {
        await client.end()
      } catch (error) {
        if (!attemptError) attemptError = error
      }
    }
    if (!attemptError && emittedClientError) attemptError = emittedClientError

    if (!attemptError) return

    lastErrorCode = errorCode(attemptError)
    if (!isRetryable(attemptError)) {
      throw new Error(`Database readiness check failed (${lastErrorCode})`)
    }

    const waitMs = Math.min(retryIntervalMs, deadline - now())
    if (waitMs > 0) await sleep(waitMs)
  }

  throw new Error(
    `Database did not become ready within ${timeoutMs}ms (last error: ${lastErrorCode})`,
  )
}

if (require.main === module) {
  const { Client } = require('pg')
  waitForDatabase({ Client }).catch((error) => {
    // The helper reports only sanitized codes and required variable names.
    console.error(error.message)
    process.exitCode = 1
  })
}

module.exports = { waitForDatabase }
