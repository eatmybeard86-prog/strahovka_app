'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const fmt = new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (kop) => fmt.format(kop / 100) + ' ₴';
const dateFmt = (iso) => iso.split('-').reverse().join('.');
const pad = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => isoDate(new Date());

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) node.append(c instanceof Node ? c : document.createTextNode(String(c ?? '')));
  return node;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') { showLogin(); throw new Error('Потрібен вхід'); }
  if (!res.ok) throw new Error(data.error || 'Помилка ' + res.status);
  return data;
}

let categories = [];
let editingId = null;

// ---------- Вхід / вихід ----------
function showLogin() {
  $('#app-view').hidden = true;
  $('#login-view').hidden = false;
  $('#login-form [name=password]').focus();
}
async function showApp() {
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  await loadCategories();
  await Promise.all([loadSummary(), loadTransactions()]);
}
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = e.target.password;
  $('#login-error').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: { password: input.value } });
    input.value = '';
    await showApp();
  } catch (err) {
    $('#login-error').textContent = err.message;
    input.select();
  }
});
$('#logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST', body: {} }).catch(() => {});
  showLogin();
});

// ---------- Вкладки ----------
$$('.tabs button').forEach((btn) => btn.addEventListener('click', () => {
  $$('.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
  $$('.tab').forEach((t) => { t.hidden = t.id !== 'tab-' + btn.dataset.tab; });
  if (btn.dataset.tab === 'summary') loadSummary();
}));

// ---------- Категорії ----------
async function loadCategories() {
  categories = await api('/api/categories');
  renderCategorySelects();
  renderCategoryTable();
}
function renderCategorySelects() {
  const formSel = $('#tx-form [name=category_id]');
  const current = formSel.value;
  formSel.replaceChildren(el('option', { value: '' }, '— оберіть —'),
    ...categories.filter((c) => !c.archived || String(c.id) === current)
      .map((c) => el('option', { value: c.id }, c.name)));
  formSel.value = current;

  const filterSel = $('#f-cat');
  const fcur = filterSel.value;
  filterSel.replaceChildren(el('option', { value: '' }, 'Усі'),
    ...categories.map((c) => el('option', { value: c.id }, c.name + (c.archived ? ' (архів)' : ''))));
  filterSel.value = fcur;
}
function renderCategoryTable() {
  $('#cat-body').replaceChildren(...categories.map((c) => el('tr', { class: c.archived ? 'archived' : '' },
    el('td', {}, c.name),
    el('td', { class: 'num' }, c.tx_count),
    el('td', {}, c.archived ? 'В архіві' : 'Активна'),
    el('td', { class: 'row-actions' },
      el('button', { class: 'link', onclick: () => renameCategory(c) }, 'Перейменувати'),
      el('button', { class: 'link', onclick: () => updateCategory(c.id, { archived: !c.archived }) },
        c.archived ? 'Відновити' : 'Архівувати'),
      c.tx_count ? '' : el('button', { class: 'link danger', onclick: () => deleteCategory(c) }, 'Видалити')),
  )));
}
async function updateCategory(id, body) {
  $('#cat-error').textContent = '';
  try { await api('/api/categories/' + id, { method: 'PUT', body }); await loadCategories(); }
  catch (err) { $('#cat-error').textContent = err.message; }
}
function renameCategory(c) {
  const name = prompt('Нова назва категорії:', c.name);
  if (name && name.trim() && name.trim() !== c.name) updateCategory(c.id, { name: name.trim() });
}
async function deleteCategory(c) {
  if (!confirm(`Видалити категорію «${c.name}»?`)) return;
  try { await api('/api/categories/' + c.id, { method: 'DELETE' }); await loadCategories(); }
  catch (err) { $('#cat-error').textContent = err.message; }
}
$('#cat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#cat-error').textContent = '';
  try {
    await api('/api/categories', { method: 'POST', body: { name: e.target.name.value } });
    e.target.reset();
    await loadCategories();
  } catch (err) { $('#cat-error').textContent = err.message; }
});

// ---------- Операції ----------
const txForm = $('#tx-form');
function updateCpLabel() {
  $('#cp-label').textContent = txForm.type.value === 'income' ? 'Від кого (джерело)' : 'Кому / постачальник';
}
txForm.querySelectorAll('[name=type]').forEach((r) => r.addEventListener('change', updateCpLabel));

function resetTxForm() {
  editingId = null;
  txForm.reset();
  txForm.date.value = today();
  $('#tx-form-title').textContent = 'Нова операція';
  $('#tx-submit').textContent = 'Додати';
  $('#tx-cancel').hidden = true;
  $('#tx-error').textContent = '';
  renderCategorySelects();
  updateCpLabel();
}
$('#tx-cancel').addEventListener('click', resetTxForm);

txForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#tx-error').textContent = '';
  const body = {
    type: txForm.type.value, date: txForm.date.value, amount: txForm.amount.value,
    category_id: txForm.category_id.value, counterparty: txForm.counterparty.value,
    description: txForm.description.value,
  };
  try {
    if (editingId) await api('/api/transactions/' + editingId, { method: 'PUT', body });
    else await api('/api/transactions', { method: 'POST', body });
    const keepDate = txForm.date.value;
    const keepType = txForm.type.value;
    resetTxForm();
    txForm.date.value = keepDate;
    txForm.type.value = keepType;
    updateCpLabel();
    await Promise.all([loadTransactions(), loadCategories()]);
  } catch (err) { $('#tx-error').textContent = err.message; }
});

function editTx(t) {
  editingId = t.id;
  txForm.type.value = t.type;
  txForm.date.value = t.date;
  txForm.amount.value = (t.amount / 100).toFixed(2).replace('.', ',');
  renderCategorySelects();
  if (![...txForm.category_id.options].some((o) => o.value === String(t.category_id))) {
    txForm.category_id.append(el('option', { value: t.category_id }, t.category));
  }
  txForm.category_id.value = t.category_id;
  txForm.counterparty.value = t.counterparty;
  txForm.description.value = t.description;
  $('#tx-form-title').textContent = 'Редагування операції';
  $('#tx-submit').textContent = 'Зберегти';
  $('#tx-cancel').hidden = false;
  updateCpLabel();
  txForm.scrollIntoView({ behavior: 'smooth' });
  txForm.amount.focus();
}
async function deleteTx(t) {
  if (!confirm(`Видалити операцію від ${dateFmt(t.date)} на ${money(t.amount)}?`)) return;
  await api('/api/transactions/' + t.id, { method: 'DELETE' });
  if (editingId === t.id) resetTxForm();
  await Promise.all([loadTransactions(), loadCategories()]);
}

function filterQuery() {
  const p = new URLSearchParams();
  const add = (k, v) => { if (v) p.set(k, v); };
  add('from', $('#f-from').value); add('to', $('#f-to').value);
  add('type', $('#f-type').value); add('category_id', $('#f-cat').value);
  add('q', $('#f-q').value.trim());
  return p.toString();
}
async function loadTransactions() {
  const rows = await api('/api/transactions?' + filterQuery());
  let inc = 0; let exp = 0;
  for (const t of rows) { if (t.type === 'income') inc += t.amount; else exp += t.amount; }
  $('#tx-totals').textContent = rows.length
    ? `Знайдено ${rows.length}. Надходження: ${money(inc)} · Витрати: ${money(exp)} · Різниця: ${money(inc - exp)}`
    : 'Операцій не знайдено.';
  $('#tx-body').replaceChildren(...rows.map((t) => el('tr', {},
    el('td', { class: 'nowrap' }, dateFmt(t.date)),
    el('td', {}, t.category),
    el('td', {}, t.counterparty),
    el('td', { class: 'desc' }, t.description),
    el('td', { class: 'num nowrap ' + t.type }, (t.type === 'income' ? '+' : '−') + money(t.amount)),
    el('td', { class: 'row-actions' },
      el('button', { class: 'link', onclick: () => editTx(t) }, 'Змінити'),
      el('button', { class: 'link danger', onclick: () => deleteTx(t) }, 'Видалити')),
  )));
}
let searchTimer;
['#f-from', '#f-to', '#f-type', '#f-cat'].forEach((s) => $(s).addEventListener('change', loadTransactions));
$('#f-q').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadTransactions, 300); });
$('#export').addEventListener('click', () => { window.location.href = '/api/export.csv?' + filterQuery(); });

// ---------- Звіт ----------
function setPreset(kind) {
  const now = new Date();
  let from = ''; let to = '';
  if (kind === 'month') { from = isoDate(new Date(now.getFullYear(), now.getMonth(), 1)); to = isoDate(new Date(now.getFullYear(), now.getMonth() + 1, 0)); }
  if (kind === 'prev') { from = isoDate(new Date(now.getFullYear(), now.getMonth() - 1, 1)); to = isoDate(new Date(now.getFullYear(), now.getMonth(), 0)); }
  if (kind === 'year') { from = `${now.getFullYear()}-01-01`; to = `${now.getFullYear()}-12-31`; }
  $('#sum-from').value = from;
  $('#sum-to').value = to;
  $$('.presets button').forEach((b) => b.classList.toggle('active', b.dataset.preset === kind));
  loadSummary();
}
$$('.presets button').forEach((b) => b.addEventListener('click', () => setPreset(b.dataset.preset)));
['#sum-from', '#sum-to'].forEach((s) => $(s).addEventListener('change', () => {
  $$('.presets button').forEach((b) => b.classList.remove('active'));
  loadSummary();
}));

function signed(kop) { return el('span', { class: kop < 0 ? 'negative' : '' }, money(kop)); }
async function loadSummary() {
  const p = new URLSearchParams();
  if ($('#sum-from').value) p.set('from', $('#sum-from').value);
  if ($('#sum-to').value) p.set('to', $('#sum-to').value);
  const s = await api('/api/summary?' + p);
  const kpi = (label, value, cls = '') => el('div', { class: 'card kpi ' + cls }, el('span', { class: 'muted' }, label), el('strong', {}, value));
  $('#kpis').replaceChildren(
    kpi('Надійшло за період', money(s.total.income), 'income'),
    kpi('Витрачено за період', money(s.total.expense), 'expense'),
    kpi('Залишок на кінець', signed(s.total.closing)),
  );
  const shown = s.categories.filter((c) => c.opening || c.income || c.expense);
  $('#sum-body').replaceChildren(...(shown.length ? shown.map((c) => el('tr', {},
    el('td', {}, c.name + (c.archived ? ' (архів)' : '')),
    el('td', { class: 'num' }, signed(c.opening)),
    el('td', { class: 'num income' }, money(c.income)),
    el('td', { class: 'num expense' }, money(c.expense)),
    el('td', { class: 'num strong' }, signed(c.closing)),
  )) : [el('tr', {}, el('td', { colspan: 5, class: 'muted' }, 'За цей період операцій немає.'))]));
  $('#sum-foot').replaceChildren(el('tr', {},
    el('th', {}, 'Разом'),
    el('th', { class: 'num' }, signed(s.total.opening)),
    el('th', { class: 'num' }, money(s.total.income)),
    el('th', { class: 'num' }, money(s.total.expense)),
    el('th', { class: 'num' }, signed(s.total.closing)),
  ));
}

// ---------- Старт ----------
resetTxForm();
setPresetSilently('month');
function setPresetSilently(kind) {
  const now = new Date();
  $('#sum-from').value = isoDate(new Date(now.getFullYear(), now.getMonth(), 1));
  $('#sum-to').value = isoDate(new Date(now.getFullYear(), now.getMonth() + 1, 0));
  $$('.presets button').forEach((b) => b.classList.toggle('active', b.dataset.preset === kind));
}
fetch('/api/session', { credentials: 'same-origin' })
  .then((r) => (r.ok ? showApp() : showLogin()))
  .catch(showLogin);
