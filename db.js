'use strict';
// Сховище даних: PostgreSQL, якщо задано DATABASE_URL (наприклад, безкоштовна база Neon),
// інакше вбудований SQLite у файлі DATA_DIR/oblik.db.
// SQL у застосунку пишеться з плейсхолдерами $1, $2… і працює з обома базами.

const fs = require('node:fs');
const path = require('node:path');

const SQLITE_SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    login TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS user_categories (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, category_id)
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
    amount INTEGER NOT NULL CHECK (amount > 0),
    category_id INTEGER NOT NULL REFERENCES categories(id),
    counterparty TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL DEFAULT (datetime('now')),
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    user_name TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
  CREATE INDEX IF NOT EXISTS idx_tx_cat ON transactions(category_id);
  CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
`;

// Час зберігається як текст «YYYY-MM-DD HH:MM:SS» в UTC в обох базах.
const PG_NOW = "to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')";
const PG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS categories (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT ${PG_NOW}
  );
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    login TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT ${PG_NOW}
  );
  CREATE TABLE IF NOT EXISTS user_categories (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, category_id)
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    date TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
    amount BIGINT NOT NULL CHECK (amount > 0),
    category_id INTEGER NOT NULL REFERENCES categories(id),
    counterparty TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT ${PG_NOW},
    updated_at TEXT NOT NULL DEFAULT ${PG_NOW},
    created_by INTEGER REFERENCES users(id),
    updated_by INTEGER REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id SERIAL PRIMARY KEY,
    at TEXT NOT NULL DEFAULT ${PG_NOW},
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    user_name TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
  CREATE INDEX IF NOT EXISTS idx_tx_cat ON transactions(category_id);
  CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
`;

function openSqlite(dataDir) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'oblik.db'));
  db.exec(SQLITE_SCHEMA);
  // Міграція з першої версії: хто вніс і хто останнім змінив операцію.
  const cols = db.prepare('PRAGMA table_info(transactions)').all().map((c) => c.name);
  if (!cols.includes('created_by')) db.exec('ALTER TABLE transactions ADD COLUMN created_by INTEGER REFERENCES users(id)');
  if (!cols.includes('updated_by')) db.exec('ALTER TABLE transactions ADD COLUMN updated_by INTEGER REFERENCES users(id)');

  const prep = (sql) => db.prepare(sql.replace(/\$(\d+)/g, '?$1'));
  const plain = (rows) => rows.map((r) => ({ ...r }));
  return {
    kind: 'sqlite',
    like: 'LIKE',
    async all(sql, params = []) { return plain(prep(sql).all(...params)); },
    async get(sql, params = []) { const r = prep(sql).get(...params); return r ? { ...r } : undefined; },
    async run(sql, params = []) { return { changes: Number(prep(sql).run(...params).changes) }; },
    async close() { db.close(); },
  };
}

async function openPostgres(url) {
  const pg = require('pg');
  // BIGINT і NUMERIC (суми в копійках, COUNT, SUM) повертаємо числами, а не рядками.
  pg.types.setTypeParser(20, (v) => Number(v));
  pg.types.setTypeParser(1700, (v) => Number(v));
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url) || url.includes('host=/');
  const pool = new pg.Pool({
    connectionString: url,
    ssl: local ? false : { rejectUnauthorized: true },
    max: 5,
    idleTimeoutMillis: 30000,
  });
  await pool.query(PG_SCHEMA);
  return {
    kind: 'postgres',
    like: 'ILIKE',
    async all(sql, params = []) { return (await pool.query(sql, params)).rows; },
    async get(sql, params = []) { return (await pool.query(sql, params)).rows[0]; },
    async run(sql, params = []) { return { changes: (await pool.query(sql, params)).rowCount }; },
    async close() { await pool.end(); },
  };
}

async function openDatabase({ databaseUrl, dataDir }) {
  return databaseUrl ? openPostgres(databaseUrl) : openSqlite(dataDir);
}

module.exports = { openDatabase };
