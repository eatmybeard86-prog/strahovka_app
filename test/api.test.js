'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.ADMIN_PASSWORD = 'admin-pass-123';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oblik-'));
// Для перевірки на PostgreSQL: TEST_DATABASE_URL=postgres://… npm test (база має бути порожньою).
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const { server, init, getDb } = require('../server.js');

let base;
// Окремий «браузер» для кожного користувача.
function client() {
  let cookie = '';
  return async function call(method, p, body) {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
}
const admin = client();
const editor = client();
const viewer = client();
let fuel; let food; let cash; let card;

test.before(async () => {
  await init();
  await new Promise((r) => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }));
});
test.after(async () => { server.close(); await getDb().close(); });

test('без входу API закрите', async () => {
  const anon = client();
  assert.equal((await anon('GET', '/api/categories')).status, 401);
  assert.equal((await anon('GET', '/api/summary')).status, 401);
  assert.equal((await anon('GET', '/api/health')).status, 200);
});

test('невірний пароль або логін відхиляється', async () => {
  const anon = client();
  assert.equal((await anon('POST', '/api/login', { login: 'admin', password: 'wrong' })).status, 401);
  assert.equal((await anon('POST', '/api/login', { login: 'nobody', password: 'admin-pass-123' })).status, 401);
});

test('адміністратор: категорії, операції, звіт, CSV', async () => {
  assert.equal((await admin('POST', '/api/login', { login: 'Admin', password: 'admin-pass-123' })).status, 200);
  const s = (await admin('GET', '/api/session')).data;
  assert.equal(s.user.role, 'admin');

  fuel = (await admin('POST', '/api/categories', { name: 'Тестова' })).data.id;
  const accs = (await admin('GET', '/api/accounts')).data;
  assert.equal(accs.length, 2);
  cash = accs.find((a) => a.kind === 'cash').id;
  card = (await admin('POST', '/api/accounts', { name: 'Картка Іваненка', kind: 'cashless' })).data.id;
  assert.equal((await admin('POST', '/api/accounts', { name: 'картка іваненка', kind: 'cash' })).status, 409);
  assert.equal((await admin('POST', '/api/accounts', { name: 'Без типу' })).status, 400);
  food = (await admin('GET', '/api/categories')).data.find((c) => c.name === 'Харчування').id;
  assert.equal((await admin('POST', '/api/categories', { name: 'тестова' })).status, 409);

  assert.equal((await admin('POST', '/api/transactions', { account_id: cash, date: '2026-10-05', type: 'income', amount: '10000', category_id: fuel })).status, 201);
  assert.equal((await admin('POST', '/api/transactions', { account_id: cash, date: '2026-11-02', type: 'income', amount: '5 000,50', category_id: fuel })).status, 201);
  assert.equal((await admin('POST', '/api/transactions', { account_id: cash, date: '2026-11-03', type: 'expense', amount: 3000.25, category_id: fuel, description: 'ДП; 100 л' })).status, 201);
  assert.equal((await admin('POST', '/api/transactions', { account_id: cash, date: '2026-11-03', type: 'expense', amount: '-5', category_id: fuel })).status, 400);
  assert.equal((await admin('POST', '/api/transactions', { account_id: cash, date: '2026-13-40', type: 'expense', amount: '5', category_id: fuel })).status, 400);

  const sum = (await admin('GET', '/api/summary?from=2026-11-01&to=2026-11-30')).data;
  const row = sum.categories.find((c) => c.id === fuel);
  assert.deepEqual([row.opening, row.income, row.expense, row.closing], [1000000, 500050, 300025, 1200025]);
  const all = (await admin('GET', '/api/summary')).data.categories.find((c) => c.id === fuel);
  assert.deepEqual([all.opening, all.income, all.expense, all.closing], [0, 1500050, 300025, 1200025]);

  assert.equal((await admin('DELETE', `/api/categories/${fuel}`)).status, 409);

  // Рахунок обов'язковий; залишок видно по рахунках і за формою (готівка / безготівка).
  assert.equal((await admin('POST', '/api/transactions', { date: '2026-11-04', type: 'income', amount: '1', category_id: fuel })).status, 400);
  assert.equal((await admin('POST', '/api/transactions', { account_id: card, date: '2026-11-04', type: 'income', amount: '2000', category_id: fuel })).status, 201);
  const s2 = (await admin('GET', '/api/summary?from=2026-11-01&to=2026-11-30')).data;
  assert.equal(s2.accounts.find((a) => a.id === cash).closing, 1200025);
  assert.equal(s2.accounts.find((a) => a.id === card).closing, 200000);
  assert.equal(s2.byKind.cash.closing, 1200025);
  assert.equal(s2.byKind.cashless.closing, 200000);
  assert.equal(s2.total.closing, s2.byKind.cash.closing + s2.byKind.cashless.closing + s2.byKind.none.closing);
  assert.equal((await admin('GET', `/api/transactions?account_id=${card}`)).data.length, 1);
  assert.equal((await admin('DELETE', `/api/accounts/${card}`)).status, 409);
  assert.equal((await admin('PUT', `/api/accounts/${card}`, { name: 'Картка Іваненка І.', archived: true })).status, 200);

  const list = (await admin('GET', `/api/transactions?type=expense&category_id=${fuel}`)).data;
  assert.equal(list.length, 1);
  assert.equal(list[0].created_by_name, 'Адміністратор');
  assert.equal((await admin('PUT', `/api/transactions/${list[0].id}`, { ...list[0], amount: '100' })).status, 200);

  const csv = await admin('GET', '/api/export.csv');
  assert.match(csv.data, /"ДП; 100 л"/);
  assert.match(csv.data, /100,00/);
  assert.match(csv.data, /Картка Іваненка І\.;Безготівка/);
});

test('створення користувачів і перевірка прав', async () => {
  assert.equal((await admin('POST', '/api/users', { login: 'ed', name: 'Редактор', role: 'editor', password: 'short' })).status, 400);
  assert.equal((await admin('POST', '/api/users', { login: 'editor1', name: 'Старшина', role: 'editor', password: 'editor-pass', categories: [fuel] })).status, 201);
  assert.equal((await admin('POST', '/api/users', { login: 'viewer1', name: 'Командир', role: 'viewer', password: 'viewer-pass' })).status, 201);
  assert.equal((await admin('POST', '/api/users', { login: 'viewer1', name: 'Дубль', role: 'viewer', password: 'viewer-pass' })).status, 409);

  assert.equal((await editor('POST', '/api/login', { login: 'editor1', password: 'editor-pass' })).status, 200);
  assert.equal((await viewer('POST', '/api/login', { login: 'viewer1', password: 'viewer-pass' })).status, 200);

  // Перегляд — усім.
  assert.equal((await viewer('GET', '/api/summary')).status, 200);
  assert.equal((await viewer('GET', '/api/transactions')).status, 200);
  // Глядач нічого не змінює.
  assert.equal((await viewer('POST', '/api/transactions', { account_id: cash, date: '2026-11-05', type: 'expense', amount: '1', category_id: fuel })).status, 403);
  assert.equal((await viewer('POST', '/api/categories', { name: 'X' })).status, 403);
  assert.equal((await viewer('POST', '/api/accounts', { name: 'X', kind: 'cash' })).status, 403);
  assert.equal((await editor('POST', '/api/accounts', { name: 'X', kind: 'cash' })).status, 403);
  assert.equal((await viewer('GET', '/api/users')).status, 403);
  assert.equal((await viewer('GET', '/api/audit')).status, 403);

  // Редактор — лише у своїй категорії.
  assert.equal((await editor('POST', '/api/transactions', { account_id: cash, date: '2026-11-05', type: 'expense', amount: '200', category_id: fuel })).status, 201);
  assert.equal((await editor('POST', '/api/transactions', { account_id: cash, date: '2026-11-05', type: 'expense', amount: '200', category_id: food })).status, 403);
  assert.equal((await editor('POST', '/api/categories', { name: 'Y' })).status, 403);
  const own = (await editor('GET', `/api/transactions?category_id=${fuel}`)).data[0];
  assert.equal(own.created_by_name, 'Старшина');
  // Перенести операцію в чужу категорію не можна.
  assert.equal((await editor('PUT', `/api/transactions/${own.id}`, { ...own, category_id: food })).status, 403);

  const foodTx = (await admin('POST', '/api/transactions', { account_id: cash, date: '2026-11-05', type: 'income', amount: '50', category_id: food })).data.id;
  assert.equal((await editor('DELETE', `/api/transactions/${foodTx}`)).status, 403);
  assert.equal((await editor('DELETE', `/api/transactions/${own.id}`)).status, 200);

  // Журнал фіксує дії.
  const log = (await admin('GET', '/api/audit')).data;
  assert.ok(log.some((r) => r.action === 'Видалення операції' && r.user_name.includes('editor1')));
});

test('вимкнення користувача завершує його сесію; останнього адміна не вимкнути', async () => {
  const users = (await admin('GET', '/api/users')).data;
  const v = users.find((u) => u.login === 'viewer1');
  assert.equal((await admin('PUT', `/api/users/${v.id}`, { active: false })).status, 200);
  assert.equal((await viewer('GET', '/api/summary')).status, 401);
  assert.equal((await viewer('POST', '/api/login', { login: 'viewer1', password: 'viewer-pass' })).status, 401);

  const a = users.find((u) => u.login === 'admin');
  assert.equal((await admin('PUT', `/api/users/${a.id}`, { role: 'viewer' })).status, 409);
});

test('зміна власного пароля', async () => {
  assert.equal((await editor('POST', '/api/me/password', { current: 'wrong', password: 'new-pass-123' })).status, 400);
  assert.equal((await editor('POST', '/api/me/password', { current: 'editor-pass', password: 'new-pass-123' })).status, 200);
  const fresh = client();
  assert.equal((await fresh('POST', '/api/login', { login: 'editor1', password: 'new-pass-123' })).status, 200);
});

test('вихід завершує сесію', async () => {
  const r = await editor('POST', '/api/logout', {});
  assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
});

test('вікно keepalive за київським часом', () => {
  const { inKeepaliveWindow, kyivHour } = require('../server.js');
  assert.equal(inKeepaliveWindow(6, '7-23'), false);
  assert.equal(inKeepaliveWindow(7, '7-23'), true);
  assert.equal(inKeepaliveWindow(22, '7-23'), true);
  assert.equal(inKeepaliveWindow(23, '7-23'), false);
  assert.equal(inKeepaliveWindow(3, '0-24'), true);
  assert.equal(inKeepaliveWindow(2, '22-6'), true);
  assert.equal(inKeepaliveWindow(12, '22-6'), false);
  assert.equal(inKeepaliveWindow(12, 'off'), false);
  // 2026-01-15 10:00 UTC — це 12:00 у Києві (зимовий час, UTC+2).
  assert.equal(kyivHour(new Date('2026-01-15T10:00:00Z')), 12);
});
