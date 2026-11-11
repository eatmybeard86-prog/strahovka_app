'use strict';
// Облік надходжень і витрат роти — сервер без зовнішніх залежностей.
// Потрібен Node.js 22.5+ (вбудований модуль node:sqlite).

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SESSION_DAYS = Number(process.env.SESSION_DAYS) || 7;
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
const PUBLIC_DIR = path.join(__dirname, 'public');
// Перший адміністратор створюється з цих змінних, якщо в базі ще немає користувачів.
const ADMIN_LOGIN = (process.env.ADMIN_LOGIN || 'admin').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.APP_PASSWORD || '';

const ROLES = { admin: 'Адміністратор', editor: 'Редактор', viewer: 'Лише перегляд' };

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'oblik.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
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
  -- Якщо для редактора тут є записи, він вносить операції лише в ці категорії.
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
`);
// Міграція з першої версії: хто вніс і хто останнім змінив операцію.
const txCols = db.prepare('PRAGMA table_info(transactions)').all().map((c) => c.name);
if (!txCols.includes('created_by')) db.exec('ALTER TABLE transactions ADD COLUMN created_by INTEGER REFERENCES users(id)');
if (!txCols.includes('updated_by')) db.exec('ALTER TABLE transactions ADD COLUMN updated_by INTEGER REFERENCES users(id)');

// Початкові категорії — лише при першому запуску.
if (db.prepare('SELECT COUNT(*) AS n FROM categories').get().n === 0) {
  const ins = db.prepare('INSERT INTO categories (name) VALUES (?)');
  for (const name of [
    'Пальне та мастила', 'Харчування', 'Ремонт техніки', 'Засоби зв’язку',
    'Медицина', 'Спорядження та обмундирування', 'Фортифікація та будматеріали',
    'Дрони та комплектуючі', 'Інше',
  ]) ins.run(name);
}

// ---------- Паролі ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function verifyPassword(password, stored) {
  const [alg, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}
// Для неіснуючого логіна теж рахуємо хеш, щоб час відповіді не видавав, чи є такий користувач.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
  if (!ADMIN_PASSWORD) {
    console.error('Помилка: користувачів ще немає. Задайте пароль першого адміністратора в ADMIN_PASSWORD.');
    process.exit(1);
  }
  db.prepare("INSERT INTO users (login, name, role, password_hash) VALUES (?, 'Адміністратор', 'admin', ?)")
    .run(ADMIN_LOGIN, hashPassword(ADMIN_PASSWORD));
  console.log(`Створено адміністратора з логіном «${ADMIN_LOGIN}».`);
}

// ---------- Сесії ----------
const tokenHash = (t) => crypto.createHash('sha256').update(t).digest('hex');
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(tokenHash(token), userId, Date.now() + SESSION_DAYS * 86400000);
  return token;
}
// null означає доступ до всіх категорій; інакше масив дозволених id.
function allowedCategories(user) {
  if (user.role !== 'editor') return null;
  const ids = db.prepare('SELECT category_id FROM user_categories WHERE user_id = ?').all(user.id)
    .map((r) => r.category_id);
  return ids.length ? ids : null;
}
function currentUser(req) {
  const token = getCookie(req, 'sid');
  if (!token) return null;
  const u = db.prepare(`
    SELECT u.id, u.login, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`).get(tokenHash(token), Date.now());
  return u ? { ...u, categories: allowedCategories(u) } : null;
}
function getCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
function sessionCookie(value, maxAge) {
  return `sid=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${COOKIE_SECURE ? '; Secure' : ''}`;
}

// Обмеження спроб входу: 10 невдалих спроб за 15 хвилин з однієї адреси.
const attempts = new Map();
function clientIp(req) {
  if (process.env.TRUST_PROXY === '1') {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return fwd.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '';
}
function tooManyAttempts(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > 15 * 60000) { attempts.delete(ip); return false; }
  return rec.count >= 10;
}
function recordFailure(ip) {
  const rec = attempts.get(ip);
  if (!rec || Date.now() - rec.first > 15 * 60000) attempts.set(ip, { first: Date.now(), count: 1 });
  else rec.count++;
}

// ---------- Допоміжні ----------
function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
async function readJson(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) {
    throw new HttpError(415, 'Очікується JSON');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 100000) throw new HttpError(413, 'Запит завеликий');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new HttpError(400, 'Некоректний JSON'); }
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isDate(s) {
  return typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
}
function parseAmount(v) {
  // Сума в гривнях (число або рядок з комою) → копійки.
  const s = String(v ?? '').replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const kop = Math.round(Number(s) * 100);
  return kop > 0 && kop <= 1e13 ? kop : null;
}
const hrn = (kop) => (kop / 100).toFixed(2).replace('.', ',') + ' грн';
function cleanText(v, max) {
  return String(v ?? '').trim().slice(0, max);
}
function audit(user, action, details = '') {
  db.prepare('INSERT INTO audit_log (user_id, user_name, action, details) VALUES (?, ?, ?, ?)')
    .run(user?.id ?? null, user ? `${user.name} (${user.login})` : '—', action, details);
}

// ---------- Права ----------
function requireRole(user, ...roles) {
  if (!roles.includes(user.role)) throw new HttpError(403, 'Недостатньо прав для цієї дії');
}
function requireCategory(user, categoryId) {
  if (user.categories && !user.categories.includes(categoryId)) {
    throw new HttpError(403, 'У вас немає доступу до цієї категорії');
  }
}

function validateTx(body, user) {
  const date = body.date;
  if (!isDate(date)) throw new HttpError(400, 'Вкажіть коректну дату');
  if (body.type !== 'income' && body.type !== 'expense') throw new HttpError(400, 'Вкажіть тип операції');
  const amount = parseAmount(body.amount);
  if (amount === null) throw new HttpError(400, 'Вкажіть суму більше нуля (до 2 знаків після коми)');
  const categoryId = Number(body.category_id);
  if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(categoryId)) {
    throw new HttpError(400, 'Оберіть категорію');
  }
  requireCategory(user, categoryId);
  return {
    date, type: body.type, amount, category_id: categoryId,
    counterparty: cleanText(body.counterparty, 200),
    description: cleanText(body.description, 1000),
  };
}
function txFilters(q) {
  const where = [];
  const params = [];
  if (isDate(q.get('from'))) { where.push('t.date >= ?'); params.push(q.get('from')); }
  if (isDate(q.get('to'))) { where.push('t.date <= ?'); params.push(q.get('to')); }
  if (['income', 'expense'].includes(q.get('type'))) { where.push('t.type = ?'); params.push(q.get('type')); }
  if (q.get('category_id')) { where.push('t.category_id = ?'); params.push(Number(q.get('category_id'))); }
  const search = cleanText(q.get('q'), 100);
  if (search) {
    where.push('(t.description LIKE ? OR t.counterparty LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}
function listTx(q) {
  const f = txFilters(q);
  return db.prepare(`
    SELECT t.id, t.date, t.type, t.amount, t.category_id, c.name AS category,
           t.counterparty, t.description, t.created_at, t.updated_at,
           cu.name AS created_by_name, uu.name AS updated_by_name
    FROM transactions t
    JOIN categories c ON c.id = t.category_id
    LEFT JOIN users cu ON cu.id = t.created_by
    LEFT JOIN users uu ON uu.id = t.updated_by
    ${f.sql} ORDER BY t.date DESC, t.id DESC LIMIT 5000`).all(...f.params);
}
function txLabel(t) {
  const cat = db.prepare('SELECT name FROM categories WHERE id = ?').get(t.category_id)?.name ?? '?';
  return `${t.type === 'income' ? 'Надходження' : 'Витрата'} ${hrn(t.amount)}, ${t.date}, «${cat}»`
    + (t.description ? `, ${t.description}` : '');
}
function csvCell(v) {
  const s = String(v ?? '');
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// SQLite NOCASE не працює для кирилиці, тому дублікати перевіряємо тут.
function nameTaken(name, exceptId = 0) {
  const key = name.toLocaleLowerCase('uk');
  return db.prepare('SELECT id, name FROM categories').all()
    .some((c) => c.id !== exceptId && c.name.toLocaleLowerCase('uk') === key);
}

// ---------- Користувачі ----------
const LOGIN_RE = /^[a-z0-9._-]{3,32}$/;
function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, 'Пароль має містити щонайменше 8 символів');
  if (pw.length > 200) throw new HttpError(400, 'Пароль задовгий');
}
function setUserCategories(userId, ids) {
  db.prepare('DELETE FROM user_categories WHERE user_id = ?').run(userId);
  const ins = db.prepare('INSERT OR IGNORE INTO user_categories (user_id, category_id) SELECT ?, id FROM categories WHERE id = ?');
  for (const id of Array.isArray(ids) ? ids : []) ins.run(userId, Number(id));
}
function activeAdmins(exceptId = 0) {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id != ?").get(exceptId).n;
}
function listUsers() {
  const users = db.prepare('SELECT id, login, name, role, active, created_at FROM users ORDER BY active DESC, name').all();
  const links = db.prepare('SELECT user_id, category_id FROM user_categories').all();
  return users.map((u) => ({
    ...u,
    categories: u.role === 'editor' ? links.filter((l) => l.user_id === u.id).map((l) => l.category_id) : [],
  }));
}

// ---------- API ----------
async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  if (p === '/api/health') return send(res, 200, { ok: true });

  if (p === '/api/login' && m === 'POST') {
    const ip = clientIp(req);
    if (tooManyAttempts(ip)) throw new HttpError(429, 'Забагато спроб. Спробуйте за 15 хвилин.');
    const body = await readJson(req);
    const login = cleanText(body.login, 64).toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE login = ?').get(login);
    const ok = verifyPassword(body.password ?? '', user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok || !user.active) {
      recordFailure(ip);
      throw new HttpError(401, 'Невірний логін або пароль');
    }
    attempts.delete(ip);
    audit(user, 'Вхід');
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(createSession(user.id), SESSION_DAYS * 86400) });
  }
  if (p === '/api/logout' && m === 'POST') {
    const token = getCookie(req, 'sid');
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }

  const user = currentUser(req);
  if (!user) throw new HttpError(401, 'Потрібен вхід');

  if (p === '/api/session' && m === 'GET') return send(res, 200, { user, roles: ROLES });

  if (p === '/api/me/password' && m === 'POST') {
    const body = await readJson(req);
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
    if (!verifyPassword(body.current ?? '', row.password_hash)) throw new HttpError(400, 'Поточний пароль невірний');
    validatePassword(body.password);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(body.password), user.id);
    // Завершуємо інші сесії цього користувача, поточну залишаємо.
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(user.id, tokenHash(getCookie(req, 'sid')));
    audit(user, 'Зміна власного пароля');
    return send(res, 200, { ok: true });
  }

  // Категорії: переглядати можуть усі, змінювати — адміністратор.
  if (p === '/api/categories' && m === 'GET') {
    return send(res, 200, db.prepare(`
      SELECT c.id, c.name, c.archived, COUNT(t.id) AS tx_count
      FROM categories c LEFT JOIN transactions t ON t.category_id = c.id
      GROUP BY c.id ORDER BY c.archived, c.name`).all());
  }
  if (p === '/api/categories' && m === 'POST') {
    requireRole(user, 'admin');
    const body = await readJson(req);
    const name = cleanText(body.name, 100);
    if (!name) throw new HttpError(400, 'Вкажіть назву категорії');
    if (nameTaken(name)) throw new HttpError(409, 'Така категорія вже є');
    const r = db.prepare('INSERT INTO categories (name) VALUES (?)').run(name);
    audit(user, 'Нова категорія', name);
    return send(res, 201, { id: Number(r.lastInsertRowid) });
  }
  let mm = p.match(/^\/api\/categories\/(\d+)$/);
  if (mm) {
    requireRole(user, 'admin');
    const id = Number(mm[1]);
    const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
    if (!cat) throw new HttpError(404, 'Категорію не знайдено');
    if (m === 'PUT') {
      const body = await readJson(req);
      const name = body.name === undefined ? cat.name : cleanText(body.name, 100);
      if (!name) throw new HttpError(400, 'Вкажіть назву категорії');
      if (nameTaken(name, id)) throw new HttpError(409, 'Така категорія вже є');
      const archived = body.archived === undefined ? cat.archived : (body.archived ? 1 : 0);
      db.prepare('UPDATE categories SET name = ?, archived = ? WHERE id = ?').run(name, archived, id);
      if (name !== cat.name) audit(user, 'Перейменування категорії', `«${cat.name}» → «${name}»`);
      if (archived !== cat.archived) audit(user, archived ? 'Категорію архівовано' : 'Категорію відновлено', name);
      return send(res, 200, { ok: true });
    }
    if (m === 'DELETE') {
      const used = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE category_id = ?').get(id).n;
      if (used) throw new HttpError(409, 'У категорії є операції. Її можна лише архівувати.');
      db.prepare('DELETE FROM categories WHERE id = ?').run(id);
      audit(user, 'Категорію видалено', cat.name);
      return send(res, 200, { ok: true });
    }
  }

  // Операції: переглядати можуть усі, вносити — адміністратор і редактор.
  if (p === '/api/transactions' && m === 'GET') return send(res, 200, listTx(url.searchParams));
  if (p === '/api/transactions' && m === 'POST') {
    requireRole(user, 'admin', 'editor');
    const t = validateTx(await readJson(req), user);
    const r = db.prepare(`INSERT INTO transactions
      (date, type, amount, category_id, counterparty, description, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(t.date, t.type, t.amount, t.category_id, t.counterparty, t.description, user.id, user.id);
    audit(user, 'Нова операція', txLabel(t));
    return send(res, 201, { id: Number(r.lastInsertRowid) });
  }
  mm = p.match(/^\/api\/transactions\/(\d+)$/);
  if (mm) {
    requireRole(user, 'admin', 'editor');
    const id = Number(mm[1]);
    const old = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
    if (!old) throw new HttpError(404, 'Операцію не знайдено');
    requireCategory(user, old.category_id);
    if (m === 'PUT') {
      const t = validateTx(await readJson(req), user);
      db.prepare(`UPDATE transactions SET date = ?, type = ?, amount = ?, category_id = ?, counterparty = ?,
        description = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(t.date, t.type, t.amount, t.category_id, t.counterparty, t.description, user.id, id);
      audit(user, 'Зміна операції', `було: ${txLabel(old)}; стало: ${txLabel(t)}`);
      return send(res, 200, { ok: true });
    }
    if (m === 'DELETE') {
      db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
      audit(user, 'Видалення операції', txLabel(old));
      return send(res, 200, { ok: true });
    }
  }

  // Звіт: підсумки за період по категоріях + залишок на початок періоду.
  if (p === '/api/summary' && m === 'GET') {
    const q = url.searchParams;
    const from = isDate(q.get('from')) ? q.get('from') : null;
    const to = isDate(q.get('to')) ? q.get('to') : null;
    const rows = db.prepare(`
      SELECT c.id, c.name, c.archived,
        COALESCE(SUM(CASE WHEN t.type='income'  AND (?1 IS NULL OR t.date < ?1) THEN t.amount END), 0)
          - COALESCE(SUM(CASE WHEN t.type='expense' AND (?1 IS NULL OR t.date < ?1) THEN t.amount END), 0) AS opening,
        COALESCE(SUM(CASE WHEN t.type='income'  AND (?1 IS NULL OR t.date >= ?1)
                          AND (?2 IS NULL OR t.date <= ?2) THEN t.amount END), 0) AS income,
        COALESCE(SUM(CASE WHEN t.type='expense' AND (?1 IS NULL OR t.date >= ?1)
                          AND (?2 IS NULL OR t.date <= ?2) THEN t.amount END), 0) AS expense
      FROM categories c LEFT JOIN transactions t ON t.category_id = c.id
      GROUP BY c.id ORDER BY c.archived, c.name`).all(from, to);
    // Якщо початок періоду не задано, залишок на початок дорівнює нулю.
    const categories = rows.map((r) => {
      const opening = from ? r.opening : 0;
      return { ...r, opening, closing: opening + r.income - r.expense };
    }).filter((r) => !r.archived || r.opening || r.income || r.expense);
    const total = categories.reduce((a, r) => ({
      opening: a.opening + r.opening, income: a.income + r.income,
      expense: a.expense + r.expense, closing: a.closing + r.closing,
    }), { opening: 0, income: 0, expense: 0, closing: 0 });
    return send(res, 200, { from, to, categories, total });
  }

  // Експорт у CSV (для Excel: роздільник «;», UTF-8 з BOM)
  if (p === '/api/export.csv' && m === 'GET') {
    const rows = listTx(url.searchParams).reverse();
    const lines = [['Дата', 'Тип', 'Категорія', 'Сума, грн', 'Від кого / кому', 'Опис', 'Вніс'].join(';')];
    for (const r of rows) {
      lines.push([
        r.date, r.type === 'income' ? 'Надходження' : 'Витрата', r.category,
        (r.amount / 100).toFixed(2).replace('.', ','), r.counterparty, r.description, r.created_by_name,
      ].map(csvCell).join(';'));
    }
    const name = `oblik-${new Date().toISOString().slice(0, 10)}.csv`;
    return send(res, 200, '﻿' + lines.join('\r\n'), {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
    });
  }

  // Користувачі та журнал — лише для адміністратора.
  if (p === '/api/users' && m === 'GET') {
    requireRole(user, 'admin');
    return send(res, 200, listUsers());
  }
  if (p === '/api/users' && m === 'POST') {
    requireRole(user, 'admin');
    const body = await readJson(req);
    const login = cleanText(body.login, 64).toLowerCase();
    if (!LOGIN_RE.test(login)) throw new HttpError(400, 'Логін: 3–32 символи, латинські літери, цифри, крапка, дефіс або підкреслення');
    const name = cleanText(body.name, 100);
    if (!name) throw new HttpError(400, 'Вкажіть ім’я та посаду');
    if (!ROLES[body.role]) throw new HttpError(400, 'Оберіть роль');
    validatePassword(body.password);
    if (db.prepare('SELECT 1 FROM users WHERE login = ?').get(login)) throw new HttpError(409, 'Такий логін уже зайнятий');
    const r = db.prepare('INSERT INTO users (login, name, role, password_hash) VALUES (?, ?, ?, ?)')
      .run(login, name, body.role, hashPassword(body.password));
    const id = Number(r.lastInsertRowid);
    if (body.role === 'editor') setUserCategories(id, body.categories);
    audit(user, 'Новий користувач', `${name} (${login}), роль: ${ROLES[body.role]}`);
    return send(res, 201, { id });
  }
  mm = p.match(/^\/api\/users\/(\d+)$/);
  if (mm && m === 'PUT') {
    requireRole(user, 'admin');
    const id = Number(mm[1]);
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!target) throw new HttpError(404, 'Користувача не знайдено');
    const body = await readJson(req);
    const name = body.name === undefined ? target.name : cleanText(body.name, 100);
    if (!name) throw new HttpError(400, 'Вкажіть ім’я та посаду');
    const role = body.role === undefined ? target.role : body.role;
    if (!ROLES[role]) throw new HttpError(400, 'Оберіть роль');
    const active = body.active === undefined ? target.active : (body.active ? 1 : 0);
    if (body.password) validatePassword(body.password);
    if (target.role === 'admin' && target.active && (role !== 'admin' || !active) && activeAdmins(id) === 0) {
      throw new HttpError(409, 'Має залишитися хоча б один активний адміністратор');
    }
    db.prepare('UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?').run(name, role, active, id);
    if (role === 'editor' && body.categories !== undefined) setUserCategories(id, body.categories);
    if (role !== 'editor') setUserCategories(id, []);
    const changes = [];
    if (name !== target.name) changes.push(`ім’я: ${name}`);
    if (role !== target.role) changes.push(`роль: ${ROLES[role]}`);
    if (active !== target.active) changes.push(active ? 'увімкнено' : 'вимкнено');
    if (body.password) {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(body.password), id);
      changes.push('новий пароль');
    }
    // Вимкнений користувач або новий пароль — завершуємо його сесії.
    if (!active || body.password) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    if (body.categories !== undefined && role === 'editor') changes.push('доступ до категорій');
    audit(user, 'Зміна користувача', `${target.name} (${target.login})${changes.length ? ': ' + changes.join(', ') : ''}`);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/audit' && m === 'GET') {
    requireRole(user, 'admin');
    return send(res, 200, db.prepare(
      'SELECT id, at, user_name, action, details FROM audit_log ORDER BY id DESC LIMIT 500').all());
  }

  throw new HttpError(404, 'Не знайдено');
}

// ---------- Статичні файли ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return send(res, 404, 'Не знайдено');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Метод не підтримується');
    return serveStatic(res, url.pathname);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    return send(res, 500, { error: 'Внутрішня помилка сервера' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Облік роти працює: http://localhost:${PORT}`));
}
module.exports = { server, db };
