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
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const SESSION_DAYS = Number(process.env.SESSION_DAYS) || 7;
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!APP_PASSWORD) {
  console.error('Помилка: задайте пароль у змінній середовища APP_PASSWORD.');
  process.exit(1);
}

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
  CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
  CREATE INDEX IF NOT EXISTS idx_tx_cat ON transactions(category_id);
`);

// Початкові категорії — лише при першому запуску.
if (db.prepare('SELECT COUNT(*) AS n FROM categories').get().n === 0) {
  const ins = db.prepare('INSERT INTO categories (name) VALUES (?)');
  for (const name of [
    'Пальне та мастила', 'Харчування', 'Ремонт техніки', 'Засоби зв’язку',
    'Медицина', 'Спорядження та обмундирування', 'Фортифікація та будматеріали',
    'Дрони та комплектуючі', 'Інше',
  ]) ins.run(name);
}

// Секрет для підпису сесій зберігається в БД, щоб сесії переживали перезапуск.
let secret = db.prepare("SELECT value FROM settings WHERE key = 'session_secret'").get()?.value;
if (!secret) {
  secret = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT INTO settings (key, value) VALUES ('session_secret', ?)").run(secret);
}
// Зміна пароля робить недійсними всі старі сесії.
const pwTag = crypto.createHash('sha256').update('pw:' + APP_PASSWORD).digest('hex').slice(0, 16);

// ---------- Сесії ----------
function sign(data) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}
function makeToken() {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  const data = `${exp}.${pwTag}`;
  return `${data}.${sign(data)}`;
}
function validToken(token) {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [exp, tag, sig] = parts;
  const expected = sign(`${exp}.${tag}`);
  if (sig.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  return tag === pwTag && Number(exp) > Date.now();
}
function passwordMatches(input) {
  const a = crypto.createHash('sha256').update(String(input)).digest();
  const b = crypto.createHash('sha256').update(APP_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
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
function cleanText(v, max) {
  return String(v ?? '').trim().slice(0, max);
}
function validateTx(body) {
  const date = body.date;
  if (!isDate(date)) throw new HttpError(400, 'Вкажіть коректну дату');
  if (body.type !== 'income' && body.type !== 'expense') throw new HttpError(400, 'Вкажіть тип операції');
  const amount = parseAmount(body.amount);
  if (amount === null) throw new HttpError(400, 'Вкажіть суму більше нуля (до 2 знаків після коми)');
  const categoryId = Number(body.category_id);
  if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(categoryId)) {
    throw new HttpError(400, 'Оберіть категорію');
  }
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
           t.counterparty, t.description
    FROM transactions t JOIN categories c ON c.id = t.category_id
    ${f.sql} ORDER BY t.date DESC, t.id DESC LIMIT 5000`).all(...f.params);
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

// ---------- API ----------
async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  if (p === '/api/login' && m === 'POST') {
    const ip = clientIp(req);
    if (tooManyAttempts(ip)) throw new HttpError(429, 'Забагато спроб. Спробуйте за 15 хвилин.');
    const body = await readJson(req);
    if (!passwordMatches(body.password ?? '')) {
      recordFailure(ip);
      throw new HttpError(401, 'Невірний пароль');
    }
    attempts.delete(ip);
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(makeToken(), SESSION_DAYS * 86400) });
  }
  if (p === '/api/logout' && m === 'POST') {
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }

  if (!validToken(getCookie(req, 'sid'))) throw new HttpError(401, 'Потрібен вхід');

  if (p === '/api/session' && m === 'GET') return send(res, 200, { ok: true });

  // Категорії
  if (p === '/api/categories' && m === 'GET') {
    return send(res, 200, db.prepare(`
      SELECT c.id, c.name, c.archived, COUNT(t.id) AS tx_count
      FROM categories c LEFT JOIN transactions t ON t.category_id = c.id
      GROUP BY c.id ORDER BY c.archived, c.name`).all());
  }
  if (p === '/api/categories' && m === 'POST') {
    const body = await readJson(req);
    const name = cleanText(body.name, 100);
    if (!name) throw new HttpError(400, 'Вкажіть назву категорії');
    if (nameTaken(name)) throw new HttpError(409, 'Така категорія вже є');
    try {
      const r = db.prepare('INSERT INTO categories (name) VALUES (?)').run(name);
      return send(res, 201, { id: Number(r.lastInsertRowid) });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Така категорія вже є');
      throw e;
    }
  }
  let mm = p.match(/^\/api\/categories\/(\d+)$/);
  if (mm) {
    const id = Number(mm[1]);
    const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
    if (!cat) throw new HttpError(404, 'Категорію не знайдено');
    if (m === 'PUT') {
      const body = await readJson(req);
      const name = body.name === undefined ? cat.name : cleanText(body.name, 100);
      if (!name) throw new HttpError(400, 'Вкажіть назву категорії');
      if (nameTaken(name, id)) throw new HttpError(409, 'Така категорія вже є');
      const archived = body.archived === undefined ? cat.archived : (body.archived ? 1 : 0);
      try {
        db.prepare('UPDATE categories SET name = ?, archived = ? WHERE id = ?').run(name, archived, id);
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Така категорія вже є');
        throw e;
      }
      return send(res, 200, { ok: true });
    }
    if (m === 'DELETE') {
      const used = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE category_id = ?').get(id).n;
      if (used) throw new HttpError(409, 'У категорії є операції. Її можна лише архівувати.');
      db.prepare('DELETE FROM categories WHERE id = ?').run(id);
      return send(res, 200, { ok: true });
    }
  }

  // Операції
  if (p === '/api/transactions' && m === 'GET') return send(res, 200, listTx(url.searchParams));
  if (p === '/api/transactions' && m === 'POST') {
    const t = validateTx(await readJson(req));
    const r = db.prepare(`INSERT INTO transactions (date, type, amount, category_id, counterparty, description)
      VALUES (?, ?, ?, ?, ?, ?)`).run(t.date, t.type, t.amount, t.category_id, t.counterparty, t.description);
    return send(res, 201, { id: Number(r.lastInsertRowid) });
  }
  mm = p.match(/^\/api\/transactions\/(\d+)$/);
  if (mm) {
    const id = Number(mm[1]);
    if (!db.prepare('SELECT 1 FROM transactions WHERE id = ?').get(id)) throw new HttpError(404, 'Операцію не знайдено');
    if (m === 'PUT') {
      const t = validateTx(await readJson(req));
      db.prepare(`UPDATE transactions SET date = ?, type = ?, amount = ?, category_id = ?, counterparty = ?,
        description = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(t.date, t.type, t.amount, t.category_id, t.counterparty, t.description, id);
      return send(res, 200, { ok: true });
    }
    if (m === 'DELETE') {
      db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
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
    const lines = [['Дата', 'Тип', 'Категорія', 'Сума, грн', 'Від кого / кому', 'Опис'].join(';')];
    for (const r of rows) {
      lines.push([
        r.date, r.type === 'income' ? 'Надходження' : 'Витрата', r.category,
        (r.amount / 100).toFixed(2).replace('.', ','), r.counterparty, r.description,
      ].map(csvCell).join(';'));
    }
    const name = `oblik-${new Date().toISOString().slice(0, 10)}.csv`;
    return send(res, 200, '﻿' + lines.join('\r\n'), {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
    });
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
