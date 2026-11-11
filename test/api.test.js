'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.APP_PASSWORD = 'test-pass';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oblik-'));
const { server } = require('../server.js');

let base;
let cookie = '';
async function call(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

test.before(() => new Promise((r) => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => server.close());

test('без входу API закрите', async () => {
  assert.equal((await call('GET', '/api/categories')).status, 401);
  assert.equal((await call('GET', '/api/summary')).status, 401);
});

test('невірний пароль відхиляється', async () => {
  assert.equal((await call('POST', '/api/login', { password: 'wrong' })).status, 401);
});

test('вхід, категорії, операції, звіт', async () => {
  const login = await call('POST', '/api/login', { password: 'test-pass' });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];

  const cats = (await call('GET', '/api/categories')).data;
  assert.ok(cats.length > 0);
  const fuel = (await call('POST', '/api/categories', { name: 'Тестова' })).data.id;
  assert.equal((await call('POST', '/api/categories', { name: 'тестова' })).status, 409);

  assert.equal((await call('POST', '/api/transactions', { date: '2026-10-05', type: 'income', amount: '10000', category_id: fuel })).status, 201);
  assert.equal((await call('POST', '/api/transactions', { date: '2026-11-02', type: 'income', amount: '5 000,50', category_id: fuel })).status, 201);
  assert.equal((await call('POST', '/api/transactions', { date: '2026-11-03', type: 'expense', amount: 3000.25, category_id: fuel, description: 'ДП; 100 л' })).status, 201);
  assert.equal((await call('POST', '/api/transactions', { date: '2026-11-03', type: 'expense', amount: '-5', category_id: fuel })).status, 400);
  assert.equal((await call('POST', '/api/transactions', { date: '2026-13-40', type: 'expense', amount: '5', category_id: fuel })).status, 400);

  const s = (await call('GET', '/api/summary?from=2026-11-01&to=2026-11-30')).data;
  const row = s.categories.find((c) => c.id === fuel);
  assert.deepEqual([row.opening, row.income, row.expense, row.closing], [1000000, 500050, 300025, 1200025]);

  const all = (await call('GET', '/api/summary')).data.categories.find((c) => c.id === fuel);
  assert.deepEqual([all.opening, all.income, all.expense, all.closing], [0, 1500050, 300025, 1200025]);

  assert.equal((await call('DELETE', `/api/categories/${fuel}`)).status, 409);
  assert.equal((await call('PUT', `/api/categories/${fuel}`, { archived: true })).status, 200);

  const list = (await call('GET', `/api/transactions?type=expense&category_id=${fuel}`)).data;
  assert.equal(list.length, 1);
  assert.equal((await call('PUT', `/api/transactions/${list[0].id}`, { ...list[0], amount: '100' })).status, 200);

  const csv = await call('GET', '/api/export.csv');
  assert.match(csv.data, /"ДП; 100 л"/);
  assert.match(csv.data, /100,00/);

  assert.equal((await call('DELETE', `/api/transactions/${list[0].id}`)).status, 200);
});

test('вихід скасовує cookie', async () => {
  const r = await call('POST', '/api/logout', {});
  assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
});
