import 'dotenv/config';
import { createRequire } from 'node:module';
import { createHmac, randomBytes } from 'node:crypto';
import path from 'node:path';
const require = createRequire(path.resolve('package.json'));
const Sqlite = require('better-sqlite3');
const BASE = 'http://localhost:3000';
const DB_PATH = path.resolve(process.env.DATABASE_PATH ?? './data/bridge.sqlite');
const db = new Sqlite(DB_PATH);
db.pragma('busy_timeout = 10000');
const admin = db.prepare('SELECT id FROM users WHERE lower(email) = ?').get((process.env.ADMIN_USER_EMAIL ?? '').toLowerCase());
if (!admin) throw new Error('admin user not found');
const token = randomBytes(32).toString('base64url');
const csrf = randomBytes(32).toString('base64url');
db.prepare('INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)').run(
  createHmac('sha256', process.env.SESSION_SECRET).update(token).digest('base64url'),
  admin.id, csrf, new Date(Date.now() + 3600_000).toISOString(), new Date().toISOString());
const res = await fetch(`${BASE}/app/debugging/ct-sweep-now`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: `bridge_session=${token}` },
  body: JSON.stringify({ csrfToken: csrf }),
});
console.log(res.status, await res.text());
