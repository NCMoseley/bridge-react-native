import { spawnSync, execFileSync } from 'node:child_process'
import { existsSync, copyFileSync, writeFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import dotenv from 'dotenv'

dotenv.config()

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

const localDb = resolve(
  process.env.LOCAL_DATABASE_PATH ??
    (process.env.DATABASE_PATH ? resolve(root, process.env.DATABASE_PATH) : join(root, 'data', 'bridge.sqlite')),
)

const renderHost = process.env.RENDER_HOST
const renderUser = process.env.RENDER_USER ?? 'render'
const renderKey = process.env.RENDER_SSH_KEY
const renderDbPath = process.env.RENDER_DATABASE_PATH ?? '/var/data/bridge.sqlite'
const timestamp = new Date().toISOString().replace(/[:.]/g, '-')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    encoding: 'utf-8',
    ...options,
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}`)
  }
  return result
}

function runShell(command) {
  const result = spawnSync(command, { stdio: 'inherit', shell: true, encoding: 'utf-8' })
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command}`)
  }
  return result
}

if (!existsSync(localDb)) {
  console.error(`Local database not found: ${localDb}`)
  process.exit(1)
}

const stats = statSync(localDb)
console.log(`Local database: ${localDb} (${Math.round(stats.size / 1024)} KB)`)

// Keep a local backup before doing anything. This does not modify the original.
const backupPath = join(root, 'data', `bridge.sqlite.migrate-backup-${timestamp}.sqlite`)
copyFileSync(localDb, backupPath)
console.log(`Backup created: ${backupPath}`)

// Dump the local database to SQL.
const dumpPath = join(root, 'data', `bridge.sqlite.migrate-${timestamp}.sql`)
const dumpSql = execFileSync('sqlite3', [localDb, '.dump'], {
  encoding: 'utf-8',
  maxBuffer: 200 * 1024 * 1024,
})
writeFileSync(dumpPath, dumpSql)
console.log(`SQL dump created: ${dumpPath}`)

// Warn about encryption key consistency.
const localEncryptionKey = process.env.CREDENTIAL_ENCRYPTION_KEY
if (localEncryptionKey) {
  console.log('\nIMPORTANT: Make sure RENDER has the same CREDENTIAL_ENCRYPTION_KEY as this .env:')
  console.log(`  ${localEncryptionKey}`)
  console.log('If the live CREDENTIAL_ENCRYPTION_KEY is different, stored credentials will not be decryptable.\n')
}

if (!renderHost) {
  console.log('RENDER_HOST not set. Manual upload required:')
  console.log(`  1. Stop the live service on Render.`)
  console.log(`  2. Upload the dump file to the live disk:`)
  console.log(`     scp ${dumpPath} ${renderUser}@<render-host>:/tmp/bridge-migrate.sql`)
  console.log(`  3. Apply it on the live disk:`)
  console.log(`     ssh ${renderUser}@<render-host> "rm -f ${renderDbPath} && sqlite3 ${renderDbPath} < /tmp/bridge-migrate.sql"`)
  console.log(`  4. Start the live service.`)
  process.exit(0)
}

const identity = renderKey ? `-i ${renderKey}` : ''
const remoteDump = '/tmp/bridge-migrate.sql'

console.log(`\nStopping and replacing the live database is not included here to avoid corruption.`)
console.log('Run these commands after stopping the live service on Render:\n')
console.log(`  scp ${identity} ${dumpPath} ${renderUser}@${renderHost}:${remoteDump}`)
console.log(`  ssh ${identity} ${renderUser}@${renderHost} "rm -f ${renderDbPath} && sqlite3 ${renderDbPath} < ${remoteDump}"`)
console.log('Then start the live service.\n')

// Optionally execute if RENDER_AUTO_APPLY=1 and the user has SSH access.
if (process.env.RENDER_AUTO_APPLY === '1') {
  console.log('RENDER_AUTO_APPLY is set. Copying dump and applying...')
  runShell(`scp ${identity} ${dumpPath} ${renderUser}@${renderHost}:${remoteDump}`)
  runShell(`ssh ${identity} ${renderUser}@${renderHost} "rm -f ${renderDbPath} && sqlite3 ${renderDbPath} < ${remoteDump}"`)
  console.log('Migration applied. Start the live service.')
} else {
  console.log('To auto-apply, set RENDER_AUTO_APPLY=1 (and make sure SSH is configured).')
}
