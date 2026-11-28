'use strict';
// settings — налаштування (зокрема хеш SOS-пароля), sos_sessions — сесії входу з SOS-паролем.
// receipts — стиснені фото чеків до витрат (зберігаються в самій базі, щоб пережити перезапуск сервера).
// Особисті борги (debts) і особисті витрати (personal_expenses) — окремі таблиці,
// вони не впливають на загальний баланс роти. Міграція лише додає нові таблиці (CREATE IF NOT EXISTS).
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
    personal_access INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('cash', 'cashless')),
    archived INTEGER NOT NULL DEFAULT 0,
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
    spent_by TEXT NOT NULL DEFAULT '',
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
  CREATE TABLE IF NOT EXISTS debts (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL,
    debtor TEXT NOT NULL,
    creditor TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount > 0),
    note TEXT NOT NULL DEFAULT '',
    repaid_at TEXT,
    repaid_by INTEGER REFERENCES users(id),
    created_by INTEGER REFERENCES users(id),
    updated_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS personal_expenses (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL,
    person TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount > 0),
    note TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users(id),
    updated_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sos_sessions (
    token_hash TEXT PRIMARY KEY,
    login TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
  CREATE INDEX IF NOT EXISTS idx_tx_cat ON transactions(category_id);
  CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
  CREATE INDEX IF NOT EXISTS idx_debts_date ON debts(date);
  CREATE INDEX IF NOT EXISTS idx_pexp_date ON personal_expenses(date);
  CREATE TABLE IF NOT EXISTS receipts (
    id INTEGER PRIMARY KEY,
    transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    data BLOB NOT NULL,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_receipts_tx ON receipts(transaction_id);
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
    personal_access INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT ${PG_NOW}
  );
  CREATE TABLE IF NOT EXISTS accounts (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('cash', 'cashless')),
    archived INTEGER NOT NULL DEFAULT 0,
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
    spent_by TEXT NOT NULL DEFAULT '',
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
  CREATE TABLE IF NOT EXISTS debts (
    id SERIAL PRIMARY KEY,
    date TEXT NOT NULL,
    debtor TEXT NOT NULL,
    creditor TEXT NOT NULL,
    amount BIGINT NOT NULL CHECK (amount > 0),
    note TEXT NOT NULL DEFAULT '',
    repaid_at TEXT,
    repaid_by INTEGER REFERENCES users(id),
    created_by INTEGER REFERENCES users(id),
    updated_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT ${PG_NOW},
    updated_at TEXT NOT NULL DEFAULT ${PG_NOW}
  );
  CREATE TABLE IF NOT EXISTS personal_expenses (
    id SERIAL PRIMARY KEY,
    date TEXT NOT NULL,
    person TEXT NOT NULL,
    amount BIGINT NOT NULL CHECK (amount > 0),
    note TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users(id),
    updated_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT ${PG_NOW},
    updated_at TEXT NOT NULL DEFAULT ${PG_NOW}
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sos_sessions (
    token_hash TEXT PRIMARY KEY,
    login TEXT NOT NULL,
    expires_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
  CREATE INDEX IF NOT EXISTS idx_tx_cat ON transactions(category_id);
  CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
  CREATE INDEX IF NOT EXISTS idx_debts_date ON debts(date);
  CREATE INDEX IF NOT EXISTS idx_pexp_date ON personal_expenses(date);
  CREATE TABLE IF NOT EXISTS receipts (
    id SERIAL PRIMARY KEY,
    transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    data BYTEA NOT NULL,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT ${PG_NOW}
  );
  CREATE INDEX IF NOT EXISTS idx_receipts_tx ON receipts(transaction_id);
`;

function openSqlite(dataDir, memory = false) {
  const { DatabaseSync } = require('node:sqlite');
  if (!memory) fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(memory ? ':memory:' : path.join(dataDir, 'oblik.db'));
  db.exec(SQLITE_SCHEMA);
  // Міграція з першої версії: хто вніс і хто останнім змінив операцію.
  const cols = db.prepare('PRAGMA table_info(transactions)').all().map((c) => c.name);
  if (!cols.includes('created_by')) db.exec('ALTER TABLE transactions ADD COLUMN created_by INTEGER REFERENCES users(id)');
  if (!cols.includes('updated_by')) db.exec('ALTER TABLE transactions ADD COLUMN updated_by INTEGER REFERENCES users(id)');
  // Рахунок / місце зберігання коштів (додано пізніше; у старих записів може бути порожнім).
  if (!cols.includes('account_id')) db.exec('ALTER TABLE transactions ADD COLUMN account_id INTEGER REFERENCES accounts(id)');
  // Доступ до розділу «Особисте» (адміністратор має його завжди, іншим вмикає адміністратор).
  const ucols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!ucols.includes('personal_access')) db.exec('ALTER TABLE users ADD COLUMN personal_access INTEGER NOT NULL DEFAULT 0');
  // Хто витратив кошти (для витрат; додано пізніше).
  if (!cols.includes('spent_by')) db.exec("ALTER TABLE transactions ADD COLUMN spent_by TEXT NOT NULL DEFAULT ''");

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
  // Рахунок / місце зберігання коштів (додано пізніше; у старих записів може бути порожнім).
  await pool.query('ALTER TABLE transactions ADD COLUMN IF NOT EXISTS account_id INTEGER REFERENCES accounts(id)');
  // Доступ до розділу «Особисте» (адміністратор має його завжди, іншим вмикає адміністратор).
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS personal_access INTEGER NOT NULL DEFAULT 0');
  // Хто витратив кошти (для витрат; додано пізніше).
  await pool.query("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS spent_by TEXT NOT NULL DEFAULT ''");
  return {
    kind: 'postgres',
    like: 'ILIKE',
    async all(sql, params = []) { return (await pool.query(sql, params)).rows; },
    async get(sql, params = []) { return (await pool.query(sql, params)).rows[0]; },
    async run(sql, params = []) { return { changes: (await pool.query(sql, params)).rowCount }; },
    async close() { await pool.end(); },
  };
}

// memory: окрема тимчасова база в пам'яті (для SOS-входу: справжні дані туди не потрапляють).
async function openDatabase({ databaseUrl, dataDir, memory = false }) {
  if (memory) return openSqlite('', true);
  return databaseUrl ? openPostgres(databaseUrl) : openSqlite(dataDir);
}

module.exports = { openDatabase };
