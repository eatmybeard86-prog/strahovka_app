'use strict';
// Облік надходжень і витрат роти.
// Дані: PostgreSQL (DATABASE_URL, напр. безкоштовна база Neon) або вбудований SQLite (Node.js 22.5+).

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { openDatabase } = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATABASE_URL = process.env.DATABASE_URL || '';
const SESSION_DAYS = Number(process.env.SESSION_DAYS) || 7;
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
const PUBLIC_DIR = path.join(__dirname, 'public');
// Перший адміністратор створюється з цих змінних, якщо в базі ще немає користувачів.
const ADMIN_LOGIN = (process.env.ADMIN_LOGIN || 'admin').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.APP_PASSWORD || '';

const ROLES = { admin: 'Адміністратор', editor: 'Редактор', viewer: 'Лише перегляд' };
const DEFAULT_CATEGORIES = [
  'Пальне та мастила', 'Харчування', 'Ремонт техніки', 'Засоби зв’язку',
  'Медицина', 'Спорядження та обмундирування', 'Фортифікація та будматеріали',
  'Дрони та комплектуючі', 'Інше',
];

let db; // встановлюється в init()
const nowText = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

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

// ---------- Ініціалізація ----------
async function init() {
  db = await openDatabase({ databaseUrl: DATABASE_URL, dataDir: DATA_DIR });
  if ((await db.get('SELECT COUNT(*) AS n FROM categories')).n === 0) {
    for (const name of DEFAULT_CATEGORIES) await db.run('INSERT INTO categories (name) VALUES ($1)', [name]);
  }
  if ((await db.get('SELECT COUNT(*) AS n FROM users')).n === 0) {
    if (!ADMIN_PASSWORD) {
      throw new Error('Користувачів ще немає. Задайте пароль першого адміністратора в ADMIN_PASSWORD.');
    }
    await db.run("INSERT INTO users (login, name, role, password_hash) VALUES ($1, 'Адміністратор', 'admin', $2)",
      [ADMIN_LOGIN, hashPassword(ADMIN_PASSWORD)]);
    console.log(`Створено адміністратора з логіном «${ADMIN_LOGIN}».`);
  }
  return db;
}

// ---------- Сесії ----------
const tokenHash = (t) => crypto.createHash('sha256').update(t).digest('hex');
async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.run('DELETE FROM sessions WHERE expires_at < $1', [Date.now()]);
  await db.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
    [tokenHash(token), userId, Date.now() + SESSION_DAYS * 86400000]);
  return token;
}
// null означає доступ до всіх категорій; інакше масив дозволених id.
async function allowedCategories(user) {
  if (user.role !== 'editor') return null;
  const ids = (await db.all('SELECT category_id FROM user_categories WHERE user_id = $1', [user.id]))
    .map((r) => r.category_id);
  return ids.length ? ids : null;
}
async function currentUser(req) {
  const token = getCookie(req, 'sid');
  if (!token) return null;
  const u = await db.get(`
    SELECT u.id, u.login, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = $1 AND s.expires_at > $2 AND u.active = 1`, [tokenHash(token), Date.now()]);
  return u ? { ...u, categories: await allowedCategories(u) } : null;
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
const toId = (v) => (Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : 0);
const hrn = (kop) => (kop / 100).toFixed(2).replace('.', ',') + ' грн';
function cleanText(v, max) {
  return String(v ?? '').trim().slice(0, max);
}
async function audit(user, action, details = '') {
  await db.run('INSERT INTO audit_log (at, user_id, user_name, action, details) VALUES ($1, $2, $3, $4, $5)',
    [nowText(), user?.id ?? null, user ? `${user.name} (${user.login})` : '—', action, details]);
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

async function validateTx(body, user) {
  const date = body.date;
  if (!isDate(date)) throw new HttpError(400, 'Вкажіть коректну дату');
  if (body.type !== 'income' && body.type !== 'expense') throw new HttpError(400, 'Вкажіть тип операції');
  const amount = parseAmount(body.amount);
  if (amount === null) throw new HttpError(400, 'Вкажіть суму більше нуля (до 2 знаків після коми)');
  const categoryId = toId(body.category_id);
  if (!categoryId || !(await db.get('SELECT 1 AS x FROM categories WHERE id = $1', [categoryId]))) {
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
  const add = (cond, value) => { params.push(value); where.push(cond.replace('?', '$' + params.length)); };
  if (isDate(q.get('from'))) add('t.date >= ?', q.get('from'));
  if (isDate(q.get('to'))) add('t.date <= ?', q.get('to'));
  if (['income', 'expense'].includes(q.get('type'))) add('t.type = ?', q.get('type'));
  if (toId(q.get('category_id'))) add('t.category_id = ?', toId(q.get('category_id')));
  const search = cleanText(q.get('q'), 100);
  if (search) {
    params.push(`%${search}%`);
    const n = '$' + params.length;
    where.push(`(t.description ${db.like} ${n} OR t.counterparty ${db.like} ${n})`);
  }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}
function listTx(q) {
  const f = txFilters(q);
  return db.all(`
    SELECT t.id, t.date, t.type, t.amount, t.category_id, c.name AS category,
           t.counterparty, t.description, t.created_at, t.updated_at,
           cu.name AS created_by_name, uu.name AS updated_by_name
    FROM transactions t
    JOIN categories c ON c.id = t.category_id
    LEFT JOIN users cu ON cu.id = t.created_by
    LEFT JOIN users uu ON uu.id = t.updated_by
    ${f.sql} ORDER BY t.date DESC, t.id DESC LIMIT 5000`, f.params);
}
async function txLabel(t) {
  const cat = (await db.get('SELECT name FROM categories WHERE id = $1', [t.category_id]))?.name ?? '?';
  return `${t.type === 'income' ? 'Надходження' : 'Витрата'} ${hrn(t.amount)}, ${t.date}, «${cat}»`
    + (t.description ? `, ${t.description}` : '');
}
function csvCell(v) {
  const s = String(v ?? '');
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Назви категорій порівнюємо без урахування регістру (і для кирилиці).
async function nameTaken(name, exceptId = 0) {
  const key = name.toLocaleLowerCase('uk');
  return (await db.all('SELECT id, name FROM categories'))
    .some((c) => c.id !== exceptId && c.name.toLocaleLowerCase('uk') === key);
}

// ---------- Користувачі ----------
const LOGIN_RE = /^[a-z0-9._-]{3,32}$/;
function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, 'Пароль має містити щонайменше 8 символів');
  if (pw.length > 200) throw new HttpError(400, 'Пароль задовгий');
}
async function setUserCategories(userId, ids) {
  await db.run('DELETE FROM user_categories WHERE user_id = $1', [userId]);
  const existing = new Set((await db.all('SELECT id FROM categories')).map((c) => c.id));
  const unique = new Set((Array.isArray(ids) ? ids : []).map(toId).filter((id) => existing.has(id)));
  for (const id of unique) {
    await db.run('INSERT INTO user_categories (user_id, category_id) VALUES ($1, $2)', [userId, id]);
  }
}
async function activeAdmins(exceptId = 0) {
  return (await db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id != $1", [exceptId])).n;
}
async function listUsers() {
  const users = await db.all('SELECT id, login, name, role, active, created_at FROM users ORDER BY active DESC, name');
  const links = await db.all('SELECT user_id, category_id FROM user_categories');
  return users.map((u) => ({
    ...u,
    categories: u.role === 'editor' ? links.filter((l) => l.user_id === u.id).map((l) => l.category_id) : [],
  }));
}

// Звіт: залишок на початок періоду і рух за період по кожній категорії.
async function summary(from, to) {
  const cats = await db.all('SELECT id, name, archived FROM categories ORDER BY archived, name');
  const sumBy = async (where, params) => {
    const rows = await db.all(`
      SELECT category_id,
        COALESCE(SUM(CASE WHEN type = 'income' THEN amount END), 0) AS income,
        COALESCE(SUM(CASE WHEN type = 'expense' THEN amount END), 0) AS expense
      FROM transactions ${where} GROUP BY category_id`, params);
    return new Map(rows.map((r) => [r.category_id, r]));
  };
  const before = from ? await sumBy('WHERE date < $1', [from]) : new Map();
  const conds = []; const params = [];
  if (from) { params.push(from); conds.push('date >= $' + params.length); }
  if (to) { params.push(to); conds.push('date <= $' + params.length); }
  const during = await sumBy(conds.length ? 'WHERE ' + conds.join(' AND ') : '', params);

  const categories = cats.map((c) => {
    const b = before.get(c.id); const d = during.get(c.id);
    const opening = b ? b.income - b.expense : 0;
    const income = d ? d.income : 0;
    const expense = d ? d.expense : 0;
    return { ...c, opening, income, expense, closing: opening + income - expense };
  }).filter((r) => !r.archived || r.opening || r.income || r.expense);
  const total = categories.reduce((a, r) => ({
    opening: a.opening + r.opening, income: a.income + r.income,
    expense: a.expense + r.expense, closing: a.closing + r.closing,
  }), { opening: 0, income: 0, expense: 0, closing: 0 });
  return { from, to, categories, total };
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
    const user = await db.get('SELECT * FROM users WHERE login = $1', [login]);
    const ok = verifyPassword(body.password ?? '', user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok || !user.active) {
      recordFailure(ip);
      throw new HttpError(401, 'Невірний логін або пароль');
    }
    attempts.delete(ip);
    await audit(user, 'Вхід');
    const token = await createSession(user.id);
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(token, SESSION_DAYS * 86400) });
  }
  if (p === '/api/logout' && m === 'POST') {
    const token = getCookie(req, 'sid');
    if (token) await db.run('DELETE FROM sessions WHERE token_hash = $1', [tokenHash(token)]);
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }

  const user = await currentUser(req);
  if (!user) throw new HttpError(401, 'Потрібен вхід');

  if (p === '/api/session' && m === 'GET') return send(res, 200, { user, roles: ROLES });

  if (p === '/api/me/password' && m === 'POST') {
    const body = await readJson(req);
    const row = await db.get('SELECT password_hash FROM users WHERE id = $1', [user.id]);
    if (!verifyPassword(body.current ?? '', row.password_hash)) throw new HttpError(400, 'Поточний пароль невірний');
    validatePassword(body.password);
    await db.run('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(body.password), user.id]);
    // Завершуємо інші сесії цього користувача, поточну залишаємо.
    await db.run('DELETE FROM sessions WHERE user_id = $1 AND token_hash != $2', [user.id, tokenHash(getCookie(req, 'sid'))]);
    await audit(user, 'Зміна власного пароля');
    return send(res, 200, { ok: true });
  }

  // Категорії: переглядати можуть усі, змінювати — адміністратор.
  if (p === '/api/categories' && m === 'GET') {
    return send(res, 200, await db.all(`
      SELECT c.id, c.name, c.archived, COUNT(t.id) AS tx_count
      FROM categories c LEFT JOIN transactions t ON t.category_id = c.id
      GROUP BY c.id, c.name, c.archived ORDER BY c.archived, c.name`));
  }
  if (p === '/api/categories' && m === 'POST') {
    requireRole(user, 'admin');
    const body = await readJson(req);
    const name = cleanText(body.name, 100);
    if (!name) throw new HttpError(400, 'Вкажіть назву категорії');
    if (await nameTaken(name)) throw new HttpError(409, 'Така категорія вже є');
    const r = await db.get('INSERT INTO categories (name) VALUES ($1) RETURNING id', [name]);
    await audit(user, 'Нова категорія', name);
    return send(res, 201, { id: r.id });
  }
  let mm = p.match(/^\/api\/categories\/(\d+)$/);
  if (mm) {
    requireRole(user, 'admin');
    const id = toId(mm[1]);
    const cat = await db.get('SELECT * FROM categories WHERE id = $1', [id]);
    if (!cat) throw new HttpError(404, 'Категорію не знайдено');
    if (m === 'PUT') {
      const body = await readJson(req);
      const name = body.name === undefined ? cat.name : cleanText(body.name, 100);
      if (!name) throw new HttpError(400, 'Вкажіть назву категорії');
      if (await nameTaken(name, id)) throw new HttpError(409, 'Така категорія вже є');
      const archived = body.archived === undefined ? cat.archived : (body.archived ? 1 : 0);
      await db.run('UPDATE categories SET name = $1, archived = $2 WHERE id = $3', [name, archived, id]);
      if (name !== cat.name) await audit(user, 'Перейменування категорії', `«${cat.name}» → «${name}»`);
      if (archived !== cat.archived) await audit(user, archived ? 'Категорію архівовано' : 'Категорію відновлено', name);
      return send(res, 200, { ok: true });
    }
    if (m === 'DELETE') {
      const used = (await db.get('SELECT COUNT(*) AS n FROM transactions WHERE category_id = $1', [id])).n;
      if (used) throw new HttpError(409, 'У категорії є операції. Її можна лише архівувати.');
      await db.run('DELETE FROM categories WHERE id = $1', [id]);
      await audit(user, 'Категорію видалено', cat.name);
      return send(res, 200, { ok: true });
    }
  }

  // Операції: переглядати можуть усі, вносити — адміністратор і редактор.
  if (p === '/api/transactions' && m === 'GET') return send(res, 200, await listTx(url.searchParams));
  if (p === '/api/transactions' && m === 'POST') {
    requireRole(user, 'admin', 'editor');
    const t = await validateTx(await readJson(req), user);
    const now = nowText();
    const r = await db.get(`INSERT INTO transactions
      (date, type, amount, category_id, counterparty, description, created_by, updated_by, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $8) RETURNING id`,
      [t.date, t.type, t.amount, t.category_id, t.counterparty, t.description, user.id, now]);
    await audit(user, 'Нова операція', await txLabel(t));
    return send(res, 201, { id: r.id });
  }
  mm = p.match(/^\/api\/transactions\/(\d+)$/);
  if (mm) {
    requireRole(user, 'admin', 'editor');
    const id = toId(mm[1]);
    const old = await db.get('SELECT * FROM transactions WHERE id = $1', [id]);
    if (!old) throw new HttpError(404, 'Операцію не знайдено');
    requireCategory(user, old.category_id);
    if (m === 'PUT') {
      const t = await validateTx(await readJson(req), user);
      await db.run(`UPDATE transactions SET date = $1, type = $2, amount = $3, category_id = $4, counterparty = $5,
        description = $6, updated_by = $7, updated_at = $8 WHERE id = $9`,
        [t.date, t.type, t.amount, t.category_id, t.counterparty, t.description, user.id, nowText(), id]);
      await audit(user, 'Зміна операції', `було: ${await txLabel(old)}; стало: ${await txLabel(t)}`);
      return send(res, 200, { ok: true });
    }
    if (m === 'DELETE') {
      await db.run('DELETE FROM transactions WHERE id = $1', [id]);
      await audit(user, 'Видалення операції', await txLabel(old));
      return send(res, 200, { ok: true });
    }
  }

  if (p === '/api/summary' && m === 'GET') {
    const q = url.searchParams;
    return send(res, 200, await summary(isDate(q.get('from')) ? q.get('from') : null, isDate(q.get('to')) ? q.get('to') : null));
  }

  // Експорт у CSV (для Excel: роздільник «;», UTF-8 з BOM)
  if (p === '/api/export.csv' && m === 'GET') {
    const rows = (await listTx(url.searchParams)).reverse();
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
    return send(res, 200, await listUsers());
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
    if (await db.get('SELECT 1 AS x FROM users WHERE login = $1', [login])) throw new HttpError(409, 'Такий логін уже зайнятий');
    const r = await db.get('INSERT INTO users (login, name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING id',
      [login, name, body.role, hashPassword(body.password)]);
    if (body.role === 'editor') await setUserCategories(r.id, body.categories);
    await audit(user, 'Новий користувач', `${name} (${login}), роль: ${ROLES[body.role]}`);
    return send(res, 201, { id: r.id });
  }
  mm = p.match(/^\/api\/users\/(\d+)$/);
  if (mm && m === 'PUT') {
    requireRole(user, 'admin');
    const id = toId(mm[1]);
    const target = await db.get('SELECT * FROM users WHERE id = $1', [id]);
    if (!target) throw new HttpError(404, 'Користувача не знайдено');
    const body = await readJson(req);
    const name = body.name === undefined ? target.name : cleanText(body.name, 100);
    if (!name) throw new HttpError(400, 'Вкажіть ім’я та посаду');
    const role = body.role === undefined ? target.role : body.role;
    if (!ROLES[role]) throw new HttpError(400, 'Оберіть роль');
    const active = body.active === undefined ? target.active : (body.active ? 1 : 0);
    if (body.password) validatePassword(body.password);
    if (target.role === 'admin' && target.active && (role !== 'admin' || !active) && (await activeAdmins(id)) === 0) {
      throw new HttpError(409, 'Має залишитися хоча б один активний адміністратор');
    }
    await db.run('UPDATE users SET name = $1, role = $2, active = $3 WHERE id = $4', [name, role, active, id]);
    if (role === 'editor' && body.categories !== undefined) await setUserCategories(id, body.categories);
    if (role !== 'editor') await setUserCategories(id, []);
    const changes = [];
    if (name !== target.name) changes.push(`ім’я: ${name}`);
    if (role !== target.role) changes.push(`роль: ${ROLES[role]}`);
    if (active !== target.active) changes.push(active ? 'увімкнено' : 'вимкнено');
    if (body.password) {
      await db.run('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(body.password), id]);
      changes.push('новий пароль');
    }
    // Вимкнений користувач або новий пароль — завершуємо його сесії.
    if (!active || body.password) await db.run('DELETE FROM sessions WHERE user_id = $1', [id]);
    if (body.categories !== undefined && role === 'editor') changes.push('доступ до категорій');
    await audit(user, 'Зміна користувача', `${target.name} (${target.login})${changes.length ? ': ' + changes.join(', ') : ''}`);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/audit' && m === 'GET') {
    requireRole(user, 'admin');
    return send(res, 200, await db.all(
      'SELECT id, at, user_name, action, details FROM audit_log ORDER BY id DESC LIMIT 500'));
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
  init().then((d) => {
    server.listen(PORT, () => console.log(`Облік роти працює: http://localhost:${PORT} (база: ${d.kind})`));
  }).catch((e) => {
    console.error('Помилка запуску:', e.message);
    process.exit(1);
  });
}
module.exports = { server, init, getDb: () => db };
