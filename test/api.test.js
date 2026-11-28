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
  // Глядач бачить лише готівка / безготівка: без рахунків (у кого і де) і без опису.
  const vs = (await viewer('GET', '/api/summary')).data;
  assert.equal(vs.accounts, undefined);
  assert.equal(vs.byKind.cashless.closing, 200000);
  const vtx = (await viewer('GET', `/api/transactions?account_id=${card}`)).data;
  assert.ok(vtx.length > 1);
  assert.ok(vtx.every((t) => !('account' in t) && !('account_id' in t) && !('description' in t)));
  assert.ok(vtx.some((t) => t.account_kind === 'cashless'));
  assert.equal((await viewer('GET', '/api/transactions?kind=cashless')).data.length, 1);
  assert.equal((await viewer('GET', '/api/transactions?q=' + encodeURIComponent('100 л'))).data.length, 0);
  assert.equal((await viewer('GET', '/api/accounts')).status, 403);
  const vcsv = (await viewer('GET', '/api/export.csv')).data;
  assert.doesNotMatch(vcsv, /Рахунок|Опис|Картка Іваненка|ДП; 100 л/);
  assert.match(vcsv, /Готівка \/ безготівка/);
  assert.match(vcsv, /;Безготівка;/);
  assert.equal((await editor('GET', '/api/accounts')).status, 200);
  assert.ok((await editor('GET', '/api/summary')).data.accounts);
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

test('журнал і список показують, від кого надходження і хто витратив', async () => {
  const inc = (await admin('POST', '/api/transactions', { account_id: cash, date: '2026-11-25', type: 'income', amount: '700', category_id: food, counterparty: 'Батьківський комітет' })).data.id;
  const exp = (await admin('POST', '/api/transactions', { account_id: cash, date: '2026-11-26', type: 'expense', amount: '300', category_id: food, counterparty: 'АТБ', spent_by: 'Сидоренко' })).data.id;
  // Для надходження «хто витратив» не зберігається.
  const inc2 = (await admin('POST', '/api/transactions', { account_id: cash, date: '2026-11-26', type: 'income', amount: '1', category_id: food, spent_by: 'Хтось' })).data.id;
  const rows = (await admin('GET', '/api/transactions')).data;
  assert.equal(rows.find((t) => t.id === exp).spent_by, 'Сидоренко');
  assert.equal(rows.find((t) => t.id === inc2).spent_by, '');
  assert.equal((await viewer('GET', '/api/transactions?q=Сидоренко')).data.length, 1);

  const log = (await admin('GET', '/api/audit')).data.map((r) => r.details);
  assert.ok(log.some((d) => d.startsWith('Надходження 700') && d.includes('від кого: Батьківський комітет')));
  assert.ok(log.some((d) => d.startsWith('Витрата 300') && d.includes('витратив: Сидоренко') && d.includes('кому: АТБ')));

  const t = rows.find((r) => r.id === exp);
  assert.equal((await admin('PUT', `/api/transactions/${exp}`, { ...t, amount: '300', spent_by: 'Петренко' })).status, 200);
  assert.ok((await admin('GET', '/api/audit')).data.some((r) => r.action === 'Зміна операції' && r.details.includes('стало:') && r.details.includes('витратив: Петренко')));
  assert.ok((await admin('GET', '/api/export.csv')).data.includes('Петренко'));
  for (const id of [inc, exp, inc2]) assert.equal((await admin('DELETE', `/api/transactions/${id}`)).status, 200);
});

test('особисті борги й витрати: окремо від коштів роти, права за ролями', async () => {
  const before = (await admin('GET', '/api/summary')).data.total;

  // Доступ до «Особисте» за замовчуванням закритий для всіх, крім адміністратора.
  assert.equal((await editor('GET', '/api/session')).data.user.personal, false);
  assert.equal((await viewer('GET', '/api/debts/summary')).status, 403);
  assert.equal((await editor('POST', '/api/debts', { date: '2026-11-20', debtor: 'А', creditor: 'Б', amount: '1' })).status, 403);
  assert.equal((await editor('GET', '/api/personal-expenses')).status, 403);
  assert.equal((await admin('GET', '/api/session')).data.user.personal, true);
  const ids = Object.fromEntries((await admin('GET', '/api/users')).data.map((u) => [u.login, u]));
  assert.equal(ids.viewer1.personal, false);
  assert.equal((await viewer('PUT', `/api/users/${ids.viewer1.id}`, { personal: true })).status, 403);
  for (const login of ['editor1', 'viewer1']) {
    assert.equal((await admin('PUT', `/api/users/${ids[login].id}`, { personal: true })).status, 200);
  }
  assert.equal((await viewer('GET', '/api/session')).data.user.personal, true);
  assert.ok((await admin('GET', '/api/audit')).data.some((r) => r.details.includes('доступ до «Особисте» надано')));

  // Борги: Іван винен Петру 1000, Петро винен Івану 300, Олег винен Петру 200.
  assert.equal((await admin('POST', '/api/debts', { date: '2026-11-20', debtor: 'Іван', creditor: 'Петро', amount: '1000', note: 'на ремонт авто' })).status, 201);
  assert.equal((await editor('POST', '/api/debts', { date: '2026-11-21', debtor: 'петро', creditor: ' Іван ', amount: '300' })).status, 201);
  const oleg = (await admin('POST', '/api/debts', { date: '2026-11-22', debtor: 'Олег', creditor: 'Петро', amount: '200,50' })).data.id;
  assert.equal((await admin('POST', '/api/debts', { date: '2026-11-22', debtor: 'Олег', creditor: 'олег', amount: '1' })).status, 400);
  assert.equal((await admin('POST', '/api/debts', { date: '2026-11-22', debtor: 'Олег', creditor: 'Петро', amount: '0' })).status, 400);
  assert.equal((await admin('POST', '/api/debts', { date: '2026-11-22', debtor: '', creditor: 'Петро', amount: '5' })).status, 400);

  let s = (await viewer('GET', '/api/debts/summary')).data;
  assert.deepEqual(s.pairs.map((p) => [p.debtor, p.creditor, p.amount]), [['Іван', 'Петро', 70000], ['Олег', 'Петро', 20050]]);
  assert.equal(s.total, 90050);
  const petro = s.balances.find((b) => b.name === 'Петро');
  assert.deepEqual([petro.owed, petro.owes, petro.net], [120050, 30000, 90050]);
  assert.equal(s.balances.find((b) => b.name === 'Олег').net, -20050);

  // Позначити повернутим — зникає з підсумку; можна повернути в активні.
  assert.equal((await viewer('POST', `/api/debts/${oleg}/repaid`, { repaid: true })).status, 403);
  assert.equal((await editor('POST', `/api/debts/${oleg}/repaid`, { repaid: true })).status, 200);
  s = (await admin('GET', '/api/debts/summary')).data;
  assert.equal(s.total, 70000);
  assert.equal((await admin('GET', '/api/debts?status=repaid')).data.length, 1);
  assert.equal((await admin('GET', '/api/debts?status=open')).data.length, 2);
  assert.equal((await admin('GET', '/api/debts?person=' + encodeURIComponent('олег'))).data.length, 1);
  assert.equal((await admin('POST', `/api/debts/${oleg}/repaid`, { repaid: false })).status, 200);
  assert.equal((await admin('GET', '/api/debts/summary')).data.total, 90050);

  // Зміна і видалення.
  const d = (await admin('GET', '/api/debts?person=' + encodeURIComponent('Олег'))).data[0];
  assert.equal((await editor('PUT', `/api/debts/${d.id}`, { ...d, amount: '250' })).status, 200);
  assert.equal((await admin('GET', '/api/debts/summary')).data.total, 95000);
  assert.equal((await viewer('DELETE', `/api/debts/${d.id}`)).status, 403);
  assert.equal((await admin('DELETE', `/api/debts/${d.id}`)).status, 200);
  assert.equal((await admin('DELETE', `/api/debts/${d.id}`)).status, 404);

  // Особисті витрати.
  assert.equal((await editor('POST', '/api/personal-expenses', { date: '2026-11-23', person: 'Іван', amount: '450', note: 'берці' })).status, 201);
  assert.equal((await admin('POST', '/api/personal-expenses', { date: '2026-11-24', person: 'Петро', amount: '120' })).status, 201);
  assert.equal((await viewer('POST', '/api/personal-expenses', { date: '2026-11-24', person: 'Петро', amount: '120' })).status, 403);
  assert.equal((await admin('POST', '/api/personal-expenses', { date: 'вчора', person: 'Петро', amount: '120' })).status, 400);
  assert.equal((await admin('GET', '/api/personal-expenses?person=' + encodeURIComponent('іван'))).data.length, 1);
  assert.equal((await admin('GET', '/api/personal-expenses?from=2026-11-24')).data.length, 1);
  const pe = (await admin('GET', '/api/personal-expenses?person=' + encodeURIComponent('Петро'))).data[0];
  assert.equal((await editor('PUT', `/api/personal-expenses/${pe.id}`, { ...pe, amount: '150' })).status, 200);
  assert.equal((await editor('DELETE', `/api/personal-expenses/${pe.id}`)).status, 200);

  // Глядач бачить імена й суми, але не примітки.
  const vd = (await viewer('GET', '/api/debts')).data;
  assert.ok(vd.length > 0 && vd.every((r) => !('note' in r)));
  const vpe = (await viewer('GET', '/api/personal-expenses')).data;
  assert.ok(vpe.length > 0 && vpe.every((r) => !('note' in r)));
  assert.equal((await admin('GET', '/api/debts')).data.find((r) => r.debtor === 'Іван').note, 'на ремонт авто');

  // Загальний баланс роти не змінився.
  assert.deepEqual((await admin('GET', '/api/summary')).data.total, before);
  const log = (await admin('GET', '/api/audit')).data;
  assert.ok(log.some((r) => r.action === 'Борг повернуто'));
  assert.ok(log.some((r) => r.action === 'Нова особиста витрата'));

  // Адміністратор закриває доступ — сервер одразу відмовляє.
  const vid = (await admin('GET', '/api/users')).data.find((u) => u.login === 'viewer1').id;
  assert.equal((await admin('PUT', `/api/users/${vid}`, { personal: false })).status, 200);
  assert.equal((await viewer('GET', '/api/debts')).status, 403);
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

test('SOS-пароль відкриває приманку без доступу до справжніх даних', async () => {
  const real = (await admin('GET', '/api/transactions')).data;
  const realSummary = (await admin('GET', '/api/summary')).data;
  // Задати SOS-пароль може лише адміністратор, з підтвердженням справжнім паролем.
  const ed = client();
  assert.equal((await ed('POST', '/api/login', { login: 'editor1', password: 'new-pass-123' })).status, 200);
  assert.equal((await ed('GET', '/api/sos')).status, 403);
  assert.equal((await admin('GET', '/api/sos')).data.set, false);
  assert.equal((await admin('PUT', '/api/sos', { password: 'sos-pass-999', current: 'wrong' })).status, 400);
  assert.equal((await admin('PUT', '/api/sos', { password: 'admin-pass-123', current: 'admin-pass-123' })).status, 400);
  assert.equal((await admin('PUT', '/api/sos', { password: 'sos-pass-999', current: 'admin-pass-123' })).status, 200);
  assert.equal((await admin('GET', '/api/sos')).data.set, true);
  // Справжній пароль не може збігатися з SOS.
  assert.equal((await admin('POST', '/api/me/password', { current: 'admin-pass-123', password: 'sos-pass-999' })).status, 400);
  // SOS-пароль з логіном не-адміністратора не працює.
  assert.equal((await client()('POST', '/api/login', { login: 'editor1', password: 'sos-pass-999' })).status, 401);

  const intruder = client();
  assert.equal((await intruder('POST', '/api/login', { login: 'admin', password: 'sos-pass-999' })).status, 200);
  const s = (await intruder('GET', '/api/session')).data;
  assert.equal(s.user.role, 'admin');
  assert.equal(s.user.login, 'admin');
  const fake = (await intruder('GET', '/api/transactions')).data;
  assert.ok(fake.length > 0, 'приманка не порожня');
  assert.ok(fake.every((t) => t.amount === 100000 || t.amount === 500000));
  assert.equal((await intruder('GET', '/api/summary?from=2000-01-01&to=2100-01-01')).data.total.closing, 0);
  const realIds = new Set(real.map((t) => t.description));
  assert.ok(!fake.some((t) => realIds.has(t.description) && t.description.startsWith('Тест')));
  assert.notDeepEqual((await intruder('GET', '/api/summary')).data.total, realSummary.total);
  const fakeUsers = (await intruder('GET', '/api/users')).data;
  assert.deepEqual(fakeUsers.map((u) => u.login), ['admin']);
  assert.equal((await intruder('GET', '/api/sos')).status, 404);

  // Зміни в приманці не торкаються справжніх даних.
  const cat = (await intruder('GET', '/api/categories')).data[0].id;
  const acc = (await intruder('GET', '/api/accounts')).data[0].id;
  assert.equal((await intruder('POST', '/api/transactions', { date: '2026-01-05', type: 'expense', amount: '1', category_id: cat, account_id: acc, description: 'від зловмисника' })).status, 201);
  for (const t of fake.slice(0, 3)) assert.equal((await intruder('DELETE', '/api/transactions/' + t.id)).status, 200);
  assert.deepEqual((await admin('GET', '/api/transactions')).data, real);
  assert.deepEqual((await admin('GET', '/api/summary')).data, realSummary);

  // Справжній журнал знає про SOS-вхід, журнал приманки — ні.
  assert.ok((await admin('GET', '/api/audit')).data.some((r) => r.action === 'Вхід із SOS-паролем'));
  assert.ok(!(await intruder('GET', '/api/audit')).data.some((r) => /SOS/.test(r.action)));

  // Справжній пароль і далі відкриває справжні дані.
  const again = client();
  assert.equal((await again('POST', '/api/login', { login: 'admin', password: 'admin-pass-123' })).status, 200);
  assert.deepEqual((await again('GET', '/api/transactions')).data, real);

  // Вимкнення SOS-пароля завершує сесії-приманки.
  assert.equal((await admin('DELETE', '/api/sos', { current: 'admin-pass-123' })).status, 200);
  assert.equal((await intruder('GET', '/api/session')).status, 401);
  assert.equal((await client()('POST', '/api/login', { login: 'admin', password: 'sos-pass-999' })).status, 401);
});

test('автовихід через 5 хвилин без дій (звичайна і SOS-сесія)', async () => {
  const realDb = getDb();
  const u = client();
  assert.equal((await u('POST', '/api/login', { login: 'admin', password: 'admin-pass-123' })).status, 200);
  const s = await u('GET', '/api/session');
  assert.equal(s.status, 200);
  assert.equal(s.data.idleMinutes, 5);
  // Строк сесії — 5 хвилин (плюс невеликий запас), а не дні.
  const newest = async (t) => Number((await realDb.get(`SELECT MAX(expires_at) AS e FROM ${t}`)).e);
  const left = (await newest('sessions')) - Date.now();
  assert.ok(left > 4 * 60000 && left <= 6 * 60000, `залишок ${left} мс`);
  // Запит продовжує сесію: відсунемо строк майже до кінця і перевіримо, що він знову ~5 хв.
  await realDb.run('UPDATE sessions SET expires_at = $1 WHERE expires_at = $2', [Date.now() + 1000, await newest('sessions')]);
  assert.equal((await u('GET', '/api/session')).status, 200);
  assert.ok((await newest('sessions')) - Date.now() > 4 * 60000);
  // Після 5 хвилин без дій — потрібен новий вхід.
  await realDb.run('UPDATE sessions SET expires_at = $1 WHERE expires_at = $2', [Date.now() - 1, await newest('sessions')]);
  assert.equal((await u('GET', '/api/session')).status, 401);

  // SOS-сесія так само.
  assert.equal((await admin('PUT', '/api/sos', { password: 'sos-pass-777', current: 'admin-pass-123' })).status, 200);
  const intruder = client();
  assert.equal((await intruder('POST', '/api/login', { login: 'admin', password: 'sos-pass-777' })).status, 200);
  assert.equal((await intruder('GET', '/api/session')).status, 200);
  const sosLeft = (await newest('sos_sessions')) - Date.now();
  assert.ok(sosLeft > 4 * 60000 && sosLeft <= 6 * 60000);
  await realDb.run('UPDATE sos_sessions SET expires_at = $1', [Date.now() - 1]);
  assert.equal((await intruder('GET', '/api/session')).status, 401);
  assert.equal((await admin('DELETE', '/api/sos', { current: 'admin-pass-123' })).status, 200);
});

test('фото чеків: додати, переглянути, права, SOS-приманка без справжніх фото', async () => {
  // Окремий запит із «сирим» тілом (фото), з кукі вказаного клієнта.
  const cookieOf = async (login, password) => {
    const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login, password }) });
    assert.equal(r.status, 200);
    return r.headers.get('set-cookie').split(';')[0];
  };
  const upload = (cookie, txId, body, type = 'image/jpeg') => fetch(`${base}/api/transactions/${txId}/receipts`,
    { method: 'POST', headers: { Cookie: cookie, 'Content-Type': type }, body });
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]);
  const adminCookie = await cookieOf('admin', 'admin-pass-123');
  const a = client();
  assert.equal((await a('POST', '/api/login', { login: 'admin', password: 'admin-pass-123' })).status, 200);

  const exp = (await a('POST', '/api/transactions', { account_id: cash, date: '2026-11-20', type: 'expense', amount: '250', category_id: food, description: 'Чек тест' })).data.id;
  const inc = (await a('POST', '/api/transactions', { account_id: cash, date: '2026-11-20', type: 'income', amount: '250', category_id: food })).data.id;

  const r1 = await upload(adminCookie, exp, jpeg);
  assert.equal(r1.status, 201);
  const rid = (await r1.json()).id;
  assert.equal((await upload(adminCookie, inc, jpeg)).status, 400, 'до надходження фото не додається');
  assert.equal((await upload(adminCookie, exp, Buffer.from('<svg/>'), 'image/svg+xml')).status, 415);
  assert.equal((await upload(adminCookie, exp, Buffer.from('not a picture at all'))).status, 400);
  assert.equal((await upload(adminCookie, exp, Buffer.alloc(1024 * 1024 + 10, 0xff))).status, 413);

  const list = (await a('GET', `/api/transactions/${exp}/receipts`)).data;
  assert.equal(list.length, 1);
  assert.equal(list[0].size, jpeg.length);
  const tx = (await a('GET', '/api/transactions?q=Чек тест')).data.find((t) => t.id === exp);
  assert.equal(tx.receipts, 1);
  const img = await fetch(`${base}/api/receipts/${rid}`, { headers: { Cookie: adminCookie } });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.match(img.headers.get('cache-control'), /no-store/);
  assert.ok(Buffer.from(await img.arrayBuffer()).equals(jpeg));
  assert.equal((await fetch(`${base}/api/receipts/${rid}`)).status, 401);

  // Не більше 5 фото до однієї витрати.
  for (let i = 0; i < 4; i++) assert.equal((await upload(adminCookie, exp, jpeg)).status, 201);
  assert.equal((await upload(adminCookie, exp, jpeg)).status, 400);

  // Глядач бачить фото, але не додає і не видаляє; редактор без доступу до категорії — теж ні.
  assert.equal((await a('POST', '/api/users', { login: 'viewer2', name: 'Глядач', role: 'viewer', password: 'viewer-pass' })).status, 201);
  const viewerCookie = await cookieOf('viewer2', 'viewer-pass');
  assert.equal((await fetch(`${base}/api/receipts/${rid}`, { headers: { Cookie: viewerCookie } })).status, 200);
  assert.equal((await upload(viewerCookie, exp, jpeg)).status, 403);
  assert.equal((await fetch(`${base}/api/receipts/${rid}`, { method: 'DELETE', headers: { Cookie: viewerCookie } })).status, 403);
  const editorCookie = await cookieOf('editor1', 'new-pass-123'); // доступ лише до категорії «Тестова»
  assert.equal((await upload(editorCookie, exp, jpeg)).status, 403);
  assert.equal((await fetch(`${base}/api/receipts/${rid}`, { method: 'DELETE', headers: { Cookie: editorCookie } })).status, 403);

  // Журнал фіксує додавання.
  assert.ok((await a('GET', '/api/audit')).data.some((e) => e.action === 'Додано фото чека'));

  // SOS-приманка: справжніх фото немає, навіть за номером.
  assert.equal((await a('PUT', '/api/sos', { password: 'sos-pass-555', current: 'admin-pass-123' })).status, 200);
  const sosCookie = await cookieOf('admin', 'sos-pass-555');
  assert.equal((await fetch(`${base}/api/receipts/${rid}`, { headers: { Cookie: sosCookie } })).status, 404);
  const fake = await (await fetch(`${base}/api/transactions`, { headers: { Cookie: sosCookie } })).json();
  assert.ok(fake.every((t) => t.receipts === 0));
  assert.equal((await a('DELETE', '/api/sos', { current: 'admin-pass-123' })).status, 200);

  // Видалення фото і видалення операції разом із фото.
  assert.equal((await a('DELETE', `/api/receipts/${rid}`)).status, 200);
  assert.equal((await a('GET', `/api/transactions/${exp}/receipts`)).data.length, 4);
  assert.equal((await a('DELETE', `/api/transactions/${exp}`)).status, 200);
  assert.equal(Number((await getDb().get('SELECT COUNT(*) AS n FROM receipts')).n), 0);
});
