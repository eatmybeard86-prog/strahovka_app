'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const fmt = new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (kop) => fmt.format(kop / 100) + ' ₴';
const dateFmt = (iso) => iso.split('-').reverse().join('.');
const pad = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => isoDate(new Date());
// Час з бази зберігається в UTC; показуємо в місцевому.
const dateTimeFmt = (s) => {
  const d = new Date(s.replace(' ', 'T') + 'Z');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

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

let me = null;
let roles = {};
let categories = [];
let accounts = [];
const KINDS = { cash: 'Готівка', cashless: 'Безготівка' };
let editingId = null;
let editingUserId = null;

const isAdmin = () => me?.role === 'admin';
const canEdit = () => me && (me.role === 'admin' || me.role === 'editor');
// Глядач не бачить рахунків (де і в кого лежать кошти) та опису: лише готівка чи безготівка.
const seesAccounts = canEdit;
const canUseCategory = (id) => canEdit() && (!me.categories || me.categories.includes(Number(id)));

// ---------- Вхід / вихід ----------
function showLogin() {
  me = null;
  $('#app-view').hidden = true;
  $('#login-view').hidden = false;
  $('#login-form [name=login]').focus();
}
async function showApp(session) {
  me = session.user;
  roles = session.roles;
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  $('#me-name').textContent = me.name;
  $('#me-role').textContent = roles[me.role];
  $$('[data-admin]').forEach((n) => { n.hidden = !isAdmin(); });
  $$('[data-personal]').forEach((n) => { n.hidden = !me.personal; });
  $('#tx-form').hidden = !canEdit();
  $$('[data-editor]').forEach((n) => { n.hidden = !canEdit(); });
  $$('[data-accounts]').forEach((n) => { n.hidden = !seesAccounts(); });
  $$('[data-viewer]').forEach((n) => { n.hidden = seesAccounts(); });
  $('#f-q').placeholder = seesAccounts() ? 'опис, від кого або хто витратив' : 'від кого або хто витратив';
  switchTab('summary');
  resetTxForm();
  resetDebtForm();
  resetPexpForm();
  knownPeople = new Set();
  await Promise.all([loadCategories(), seesAccounts() ? loadAccounts() : null]);
  await Promise.all([loadSummary(), loadTransactions()]);
}
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('#login-error').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: { login: f.login.value, password: f.password.value } });
    f.password.value = '';
    await showApp(await api('/api/session'));
  } catch (err) {
    $('#login-error').textContent = err.message;
    f.password.select();
  }
});
$('#logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST', body: {} }).catch(() => {});
  showLogin();
});

// ---------- Зміна власного пароля ----------
const pwDialog = $('#pw-dialog');
$('#me-btn').addEventListener('click', () => { $('#pw-form').reset(); $('#pw-error').textContent = ''; pwDialog.showModal(); });
$('#pw-cancel').addEventListener('click', () => pwDialog.close());
$('#pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  if (f.password.value !== f.password2.value) { $('#pw-error').textContent = 'Нові паролі не збігаються'; return; }
  try {
    await api('/api/me/password', { method: 'POST', body: { current: f.current.value, password: f.password.value } });
    pwDialog.close();
    alert('Пароль змінено.');
  } catch (err) { $('#pw-error').textContent = err.message; }
});

// ---------- Вкладки ----------
function switchTab(name) {
  $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach((t) => { t.hidden = t.id !== 'tab-' + name; });
  if (name === 'summary' && me) loadSummary();
  if (name === 'users') loadUsers();
  if (name === 'audit') loadAudit();
  if (name === 'accounts') loadAccounts();
  if (name === 'personal' && me?.personal) loadPersonal();
}
$$('.tabs button').forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

// ---------- Категорії ----------
async function loadCategories() {
  categories = (await api('/api/categories'))
    .sort((a, b) => a.archived - b.archived || a.name.localeCompare(b.name, 'uk'));
  renderCategorySelects();
  if (isAdmin()) renderCategoryTable();
}
function renderCategorySelects() {
  const formSel = $('#tx-form [name=category_id]');
  const current = formSel.value;
  formSel.replaceChildren(el('option', { value: '' }, '— оберіть —'),
    ...categories.filter((c) => (!c.archived || String(c.id) === current) && canUseCategory(c.id))
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

// ---------- Рахунки ----------
async function loadAccounts() {
  accounts = (await api('/api/accounts'))
    .sort((a, b) => a.archived - b.archived || a.name.localeCompare(b.name, 'uk'));
  renderAccountSelects();
  if (isAdmin()) renderAccountTable();
}
const accLabel = (a) => `${a.name} (${KINDS[a.kind].toLowerCase()})`;
function renderAccountSelects() {
  const formSel = $('#tx-form [name=account_id]');
  const current = formSel.value;
  formSel.replaceChildren(el('option', { value: '' }, '— оберіть —'),
    ...accounts.filter((a) => !a.archived || String(a.id) === current).map((a) => el('option', { value: a.id }, accLabel(a))));
  formSel.value = current;

  const filterSel = $('#f-acc');
  const fcur = filterSel.value;
  filterSel.replaceChildren(el('option', { value: '' }, 'Усі'),
    ...accounts.map((a) => el('option', { value: a.id }, a.name + (a.archived ? ' (архів)' : ''))),
    el('option', { value: 'none' }, 'Не вказано'));
  filterSel.value = fcur;
}
function renderAccountTable() {
  $('#acc-body').replaceChildren(...accounts.map((a) => el('tr', { class: a.archived ? 'archived' : '' },
    el('td', {}, a.name),
    el('td', {}, KINDS[a.kind]),
    el('td', { class: 'num' }, a.tx_count),
    el('td', {}, a.archived ? 'В архіві' : 'Активний'),
    el('td', { class: 'row-actions' },
      el('button', { class: 'link', onclick: () => renameAccount(a) }, 'Перейменувати'),
      el('button', { class: 'link', onclick: () => updateAccount(a.id, { kind: a.kind === 'cash' ? 'cashless' : 'cash' }) },
        a.kind === 'cash' ? 'Зробити безготівкою' : 'Зробити готівкою'),
      el('button', { class: 'link', onclick: () => updateAccount(a.id, { archived: !a.archived }) },
        a.archived ? 'Відновити' : 'Архівувати'),
      a.tx_count ? '' : el('button', { class: 'link danger', onclick: () => deleteAccount(a) }, 'Видалити')),
  )));
}
async function updateAccount(id, body) {
  $('#acc-error').textContent = '';
  try { await api('/api/accounts/' + id, { method: 'PUT', body }); await loadAccounts(); }
  catch (err) { $('#acc-error').textContent = err.message; }
}
function renameAccount(a) {
  const name = prompt('Нова назва рахунку:', a.name);
  if (name && name.trim() && name.trim() !== a.name) updateAccount(a.id, { name: name.trim() });
}
async function deleteAccount(a) {
  if (!confirm(`Видалити рахунок «${a.name}»?`)) return;
  try { await api('/api/accounts/' + a.id, { method: 'DELETE' }); await loadAccounts(); }
  catch (err) { $('#acc-error').textContent = err.message; }
}
$('#acc-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#acc-error').textContent = '';
  try {
    await api('/api/accounts', { method: 'POST', body: { name: e.target.name.value, kind: e.target.kind.value } });
    e.target.reset();
    await loadAccounts();
  } catch (err) { $('#acc-error').textContent = err.message; }
});

// ---------- Операції ----------
const txForm = $('#tx-form');
function updateCpLabel() {
  const income = txForm.type.value === 'income';
  $('#cp-label').textContent = income ? 'Від кого (джерело)' : 'Кому / постачальник';
  $('#spent-by-field').hidden = income;
  $('#acc-label').textContent = income ? 'На рахунок (куди надійшло)' : 'З рахунку (звідки витрачено)';
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
  renderAccountSelects();
  updateCpLabel();
}
$('#tx-cancel').addEventListener('click', resetTxForm);

txForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#tx-error').textContent = '';
  const body = {
    type: txForm.type.value, date: txForm.date.value, amount: txForm.amount.value,
    category_id: txForm.category_id.value, account_id: txForm.account_id.value, counterparty: txForm.counterparty.value,
    spent_by: txForm.spent_by.value, description: txForm.description.value,
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
  renderAccountSelects();
  if (t.account_id && ![...txForm.account_id.options].some((o) => o.value === String(t.account_id))) {
    txForm.account_id.append(el('option', { value: t.account_id }, t.account));
  }
  txForm.account_id.value = t.account_id ?? '';
  txForm.counterparty.value = t.counterparty;
  txForm.spent_by.value = t.spent_by || '';
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
  try {
    await api('/api/transactions/' + t.id, { method: 'DELETE' });
  } catch (err) { alert(err.message); return; }
  if (editingId === t.id) resetTxForm();
  await Promise.all([loadTransactions(), loadCategories()]);
}

function filterQuery() {
  const p = new URLSearchParams();
  const add = (k, v) => { if (v) p.set(k, v); };
  add('from', $('#f-from').value); add('to', $('#f-to').value);
  add('type', $('#f-type').value); add('category_id', $('#f-cat').value);
  add('account_id', $('#f-acc').value);
  add('q', $('#f-q').value.trim());
  return p.toString();
}
function authorCell(t) {
  const who = t.created_by_name || '—';
  const title = t.updated_by_name && t.updated_at !== t.created_at
    ? `Змінив: ${t.updated_by_name}, ${dateTimeFmt(t.updated_at)}` : `Внесено ${dateTimeFmt(t.created_at)}`;
  return el('td', { class: 'muted small', title }, who);
}
// Для надходження — від кого, для витрати — хто витратив (і кому, дрібніше).
function personCell(t) {
  if (t.type === 'income') return el('td', {}, t.counterparty ? `Від: ${t.counterparty}` : '');
  return el('td', {},
    t.spent_by ? `Витратив: ${t.spent_by}` : el('span', { class: 'muted' }, 'хто витратив — не вказано'),
    t.counterparty ? el('div', { class: 'muted small' }, `кому: ${t.counterparty}`) : '');
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
    seesAccounts() ? el('td', { class: t.account ? '' : 'muted' }, t.account ? `${t.account} · ${KINDS[t.account_kind].toLowerCase()}` : 'не вказано') : '',
    personCell(t),
    seesAccounts() ? el('td', { class: 'desc' }, t.description)
      : el('td', { class: t.account_kind ? '' : 'muted' }, t.account_kind ? KINDS[t.account_kind] : 'не вказано'),
    el('td', { class: 'num nowrap ' + t.type }, (t.type === 'income' ? '+' : '−') + money(t.amount)),
    authorCell(t),
    el('td', { class: 'row-actions' }, canUseCategory(t.category_id) ? [
      el('button', { class: 'link', onclick: () => editTx(t) }, 'Змінити'),
      el('button', { class: 'link danger', onclick: () => deleteTx(t) }, 'Видалити'),
    ] : []),
  )));
}
let searchTimer;
['#f-from', '#f-to', '#f-type', '#f-cat', '#f-acc'].forEach((s) => $(s).addEventListener('change', loadTransactions));
$('#f-q').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadTransactions, 300); });
$('#export').addEventListener('click', () => { window.location.href = '/api/export.csv?' + filterQuery(); });

// ---------- Особисте: борги та витрати (окремо від коштів роти) ----------
const debtForm = $('#debt-form');
const pexpForm = $('#pexp-form');
let editingDebtId = null;
let editingPexpId = null;
const amountText = (kop) => (kop / 100).toFixed(2).replace('.', ',');

async function loadPersonal() {
  await Promise.all([loadDebtSummary(), loadDebts(), loadPersonalExpenses()]);
}
let knownPeople = new Set();
function addPeople(...names) {
  for (const n of names) if (n) knownPeople.add(n);
  $('#people-list').replaceChildren(...[...knownPeople].sort((a, b) => a.localeCompare(b, 'uk')).map((n) => el('option', { value: n })));
}

async function loadDebtSummary() {
  const s = await api('/api/debts/summary');
  const kpi = (label, value, cls = '') => el('div', { class: 'card kpi ' + cls }, el('span', { class: 'muted' }, label), el('strong', {}, value));
  $('#debt-kpis').replaceChildren(
    kpi('Неповернених боргів разом', money(s.total), 'expense'),
    kpi('Пар «хто кому»', String(s.pairs.length)),
  );
  $('#debt-pairs').replaceChildren(...(s.pairs.length ? s.pairs.map((p) => el('tr', {},
    el('td', {}, p.debtor), el('td', {}, p.creditor), el('td', { class: 'num strong' }, money(p.amount)),
  )) : [el('tr', {}, el('td', { colspan: 3, class: 'muted' }, 'Ніхто нікому не винен.'))]));
  $('#debt-balances').replaceChildren(...(s.balances.length ? s.balances.map((b) => el('tr', {},
    el('td', {}, b.name),
    el('td', { class: 'num income' }, money(b.owed)),
    el('td', { class: 'num expense' }, money(b.owes)),
    el('td', { class: 'num strong' }, el('span', { class: b.net < 0 ? 'negative' : '' }, (b.net > 0 ? '+' : '') + money(b.net))),
  )) : [el('tr', {}, el('td', { colspan: 4, class: 'muted' }, 'Немає неповернених боргів.'))]));
  addPeople(...s.balances.map((b) => b.name));
}

function debtQuery() {
  const p = new URLSearchParams();
  if ($('#d-status').value) p.set('status', $('#d-status').value);
  if ($('#d-person').value.trim()) p.set('person', $('#d-person').value.trim());
  return p.toString();
}
async function loadDebts() {
  const rows = await api('/api/debts?' + debtQuery());
  addPeople(...rows.flatMap((d) => [d.debtor, d.creditor]));
  $('#debt-body').replaceChildren(...(rows.length ? rows.map((d) => el('tr', { class: d.repaid_at ? 'archived' : '' },
    el('td', { class: 'nowrap' }, dateFmt(d.date)),
    el('td', {}, d.debtor),
    el('td', {}, d.creditor),
    seesAccounts() ? el('td', { class: 'desc' }, d.note) : '',
    el('td', { class: 'num nowrap strong' }, money(d.amount)),
    el('td', { class: 'small ' + (d.repaid_at ? 'badge-repaid' : 'badge-open'), title: d.repaid_at ? 'Повернуто ' + dateTimeFmt(d.repaid_at) : '' },
      d.repaid_at ? 'Повернуто' : 'Не повернуто'),
    authorCell(d),
    el('td', { class: 'row-actions' }, canEdit() ? [
      el('button', { class: 'link', onclick: () => setRepaid(d, !d.repaid_at) }, d.repaid_at ? 'Не повернуто' : 'Повернуто'),
      el('button', { class: 'link', onclick: () => editDebt(d) }, 'Змінити'),
      el('button', { class: 'link danger', onclick: () => deleteDebt(d) }, 'Видалити'),
    ] : []),
  )) : [el('tr', {}, el('td', { colspan: 8, class: 'muted' }, 'Боргів не знайдено.'))]));
}
async function refreshDebts() { await Promise.all([loadDebtSummary(), loadDebts()]); }
async function setRepaid(d, repaid) {
  if (repaid && !confirm(`Позначити, що ${d.debtor} повернув ${d.creditor} ${money(d.amount)}?`)) return;
  try { await api(`/api/debts/${d.id}/repaid`, { method: 'POST', body: { repaid } }); }
  catch (err) { alert(err.message); return; }
  await refreshDebts();
}
function resetDebtForm() {
  editingDebtId = null;
  debtForm.reset();
  debtForm.date.value = today();
  $('#debt-form-title').textContent = 'Новий борг';
  $('#debt-submit').textContent = 'Додати';
  $('#debt-cancel').hidden = true;
  $('#debt-error').textContent = '';
}
$('#debt-cancel').addEventListener('click', resetDebtForm);
function editDebt(d) {
  editingDebtId = d.id;
  debtForm.date.value = d.date;
  debtForm.debtor.value = d.debtor;
  debtForm.creditor.value = d.creditor;
  debtForm.amount.value = amountText(d.amount);
  debtForm.note.value = d.note ?? '';
  $('#debt-form-title').textContent = 'Редагування боргу';
  $('#debt-submit').textContent = 'Зберегти';
  $('#debt-cancel').hidden = false;
  debtForm.scrollIntoView({ behavior: 'smooth' });
  debtForm.amount.focus();
}
async function deleteDebt(d) {
  if (!confirm(`Видалити борг: ${d.debtor} → ${d.creditor}, ${money(d.amount)}?`)) return;
  try { await api('/api/debts/' + d.id, { method: 'DELETE' }); } catch (err) { alert(err.message); return; }
  if (editingDebtId === d.id) resetDebtForm();
  await refreshDebts();
}
debtForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#debt-error').textContent = '';
  const body = { date: debtForm.date.value, debtor: debtForm.debtor.value, creditor: debtForm.creditor.value,
    amount: debtForm.amount.value, note: debtForm.note.value };
  try {
    if (editingDebtId) await api('/api/debts/' + editingDebtId, { method: 'PUT', body });
    else await api('/api/debts', { method: 'POST', body });
    const keepDate = debtForm.date.value;
    resetDebtForm();
    debtForm.date.value = keepDate;
    await refreshDebts();
  } catch (err) { $('#debt-error').textContent = err.message; }
});
let debtTimer;
$('#d-status').addEventListener('change', loadDebts);
$('#d-person').addEventListener('input', () => { clearTimeout(debtTimer); debtTimer = setTimeout(loadDebts, 300); });

function pexpQuery() {
  const p = new URLSearchParams();
  if ($('#pe-from').value) p.set('from', $('#pe-from').value);
  if ($('#pe-to').value) p.set('to', $('#pe-to').value);
  if ($('#pe-person').value.trim()) p.set('person', $('#pe-person').value.trim());
  return p.toString();
}
async function loadPersonalExpenses() {
  const rows = await api('/api/personal-expenses?' + pexpQuery());
  addPeople(...rows.map((r) => r.person));
  const byPerson = new Map();
  let total = 0;
  for (const r of rows) {
    total += r.amount;
    const k = r.person.toLocaleLowerCase('uk');
    const cur = byPerson.get(k) || { name: r.person, sum: 0 };
    cur.sum += r.amount;
    byPerson.set(k, cur);
  }
  $('#pexp-totals').textContent = rows.length
    ? `Разом ${money(total)}: ` + [...byPerson.values()].sort((a, b) => b.sum - a.sum).map((p) => `${p.name} ${money(p.sum)}`).join(' · ')
    : 'Особистих витрат не знайдено.';
  $('#pexp-body').replaceChildren(...rows.map((r) => el('tr', {},
    el('td', { class: 'nowrap' }, dateFmt(r.date)),
    el('td', {}, r.person),
    seesAccounts() ? el('td', { class: 'desc' }, r.note) : '',
    el('td', { class: 'num nowrap expense' }, money(r.amount)),
    authorCell(r),
    el('td', { class: 'row-actions' }, canEdit() ? [
      el('button', { class: 'link', onclick: () => editPexp(r) }, 'Змінити'),
      el('button', { class: 'link danger', onclick: () => deletePexp(r) }, 'Видалити'),
    ] : []),
  )));
}
function resetPexpForm() {
  editingPexpId = null;
  pexpForm.reset();
  pexpForm.date.value = today();
  $('#pexp-form-title').textContent = 'Нова особиста витрата';
  $('#pexp-submit').textContent = 'Додати';
  $('#pexp-cancel').hidden = true;
  $('#pexp-error').textContent = '';
}
$('#pexp-cancel').addEventListener('click', resetPexpForm);
function editPexp(r) {
  editingPexpId = r.id;
  pexpForm.date.value = r.date;
  pexpForm.person.value = r.person;
  pexpForm.amount.value = amountText(r.amount);
  pexpForm.note.value = r.note ?? '';
  $('#pexp-form-title').textContent = 'Редагування особистої витрати';
  $('#pexp-submit').textContent = 'Зберегти';
  $('#pexp-cancel').hidden = false;
  pexpForm.scrollIntoView({ behavior: 'smooth' });
  pexpForm.amount.focus();
}
async function deletePexp(r) {
  if (!confirm(`Видалити особисту витрату ${r.person} на ${money(r.amount)}?`)) return;
  try { await api('/api/personal-expenses/' + r.id, { method: 'DELETE' }); } catch (err) { alert(err.message); return; }
  if (editingPexpId === r.id) resetPexpForm();
  await loadPersonalExpenses();
}
pexpForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#pexp-error').textContent = '';
  const body = { date: pexpForm.date.value, person: pexpForm.person.value, amount: pexpForm.amount.value, note: pexpForm.note.value };
  try {
    if (editingPexpId) await api('/api/personal-expenses/' + editingPexpId, { method: 'PUT', body });
    else await api('/api/personal-expenses', { method: 'POST', body });
    const keepDate = pexpForm.date.value;
    resetPexpForm();
    pexpForm.date.value = keepDate;
    await loadPersonalExpenses();
  } catch (err) { $('#pexp-error').textContent = err.message; }
});
let pexpTimer;
['#pe-from', '#pe-to'].forEach((s) => $(s).addEventListener('change', loadPersonalExpenses));
$('#pe-person').addEventListener('input', () => { clearTimeout(pexpTimer); pexpTimer = setTimeout(loadPersonalExpenses, 300); });

// ---------- Звіт ----------
function setPeriod(kind) {
  const now = new Date();
  let from = ''; let to = '';
  if (kind === 'month') { from = isoDate(new Date(now.getFullYear(), now.getMonth(), 1)); to = isoDate(new Date(now.getFullYear(), now.getMonth() + 1, 0)); }
  if (kind === 'prev') { from = isoDate(new Date(now.getFullYear(), now.getMonth() - 1, 1)); to = isoDate(new Date(now.getFullYear(), now.getMonth(), 0)); }
  if (kind === 'year') { from = `${now.getFullYear()}-01-01`; to = `${now.getFullYear()}-12-31`; }
  $('#sum-from').value = from;
  $('#sum-to').value = to;
  $$('.presets button').forEach((b) => b.classList.toggle('active', b.dataset.preset === kind));
}
$$('.presets button').forEach((b) => b.addEventListener('click', () => { setPeriod(b.dataset.preset); loadSummary(); }));
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
  const kpi = (label, value, cls = '', note = null) => el('div', { class: 'card kpi ' + cls },
    el('span', { class: 'muted' }, label), el('strong', {}, value), note ? el('span', { class: 'kpi-note' }, note) : '');
  const split = [`готівкою ${money(s.byKind.cash.closing)}`, `безготівково ${money(s.byKind.cashless.closing)}`];
  if (s.byKind.none.closing) split.push(`не вказано ${money(s.byKind.none.closing)}`);
  $('#kpis').replaceChildren(
    kpi('Надійшло за період', money(s.total.income), 'income'),
    kpi('Витрачено за період', money(s.total.expense), 'expense'),
    kpi('Залишок на кінець', signed(s.total.closing), '', split.join(' · ')),
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

  // Де лежать кошти: по рахунках і разом готівкою / безготівково (глядачу не показується).
  if (!s.accounts) return;
  const accRows = s.accounts.filter((a) => a.opening || a.income || a.expense || !a.archived);
  const accRow = (a) => el('tr', {},
    el('td', { class: a.id === null ? 'muted' : '' }, a.name + (a.archived && a.id !== null ? ' (архів)' : '')),
    el('td', {}, a.kind ? KINDS[a.kind] : '—'),
    el('td', { class: 'num' }, signed(a.opening)),
    el('td', { class: 'num income' }, money(a.income)),
    el('td', { class: 'num expense' }, money(a.expense)),
    el('td', { class: 'num strong' }, signed(a.closing)));
  $('#acc-sum-body').replaceChildren(...accRows.map(accRow));
  const footRow = (label, t, cls = '') => el('tr', { class: cls },
    el('th', { colspan: 2 }, label),
    el('th', { class: 'num' }, signed(t.opening)),
    el('th', { class: 'num' }, money(t.income)),
    el('th', { class: 'num' }, money(t.expense)),
    el('th', { class: 'num' }, signed(t.closing)));
  const foot = [footRow('Готівкою', s.byKind.cash, 'sub'), footRow('Безготівково', s.byKind.cashless, 'sub')];
  const none = s.byKind.none;
  if (none.opening || none.income || none.expense) foot.push(footRow('Рахунок не вказано', none, 'sub'));
  foot.push(footRow('Разом', s.total));
  $('#acc-sum-foot').replaceChildren(...foot);
}

// ---------- Користувачі ----------
const userForm = $('#user-form');
let users = [];
function renderUserCats(selected = []) {
  $('#user-cats-list').replaceChildren(...categories.filter((c) => !c.archived || selected.includes(c.id))
    .map((c) => el('label', { class: 'check' },
      el('input', { type: 'checkbox', value: c.id, checked: selected.includes(c.id) }), c.name)));
}
function updateUserCatsVisibility() {
  $('#user-cats').hidden = userForm.role.value !== 'editor';
  // Адміністратор бачить «Особисте» завжди, тож галочка потрібна лише іншим ролям.
  $('#user-personal').hidden = userForm.role.value === 'admin';
}
userForm.role.addEventListener('change', updateUserCatsVisibility);

function resetUserForm() {
  editingUserId = null;
  userForm.reset();
  userForm.login.disabled = false;
  userForm.password.required = true;
  $('#user-pw-label').textContent = 'Пароль (щонайменше 8 символів)';
  $('#user-form-title').textContent = 'Новий користувач';
  $('#user-submit').textContent = 'Створити';
  $('#user-cancel').hidden = true;
  $('#user-error').textContent = '';
  renderUserCats();
  updateUserCatsVisibility();
}
$('#user-cancel').addEventListener('click', resetUserForm);

function editUser(u) {
  editingUserId = u.id;
  userForm.login.value = u.login;
  userForm.login.disabled = true;
  userForm.name.value = u.name;
  userForm.role.value = u.role;
  userForm.personal.checked = u.personal;
  userForm.password.value = '';
  userForm.password.required = false;
  $('#user-pw-label').textContent = 'Новий пароль (залиште порожнім, щоб не змінювати)';
  $('#user-form-title').textContent = 'Редагування: ' + u.name;
  $('#user-submit').textContent = 'Зберегти';
  $('#user-cancel').hidden = false;
  $('#user-error').textContent = '';
  renderUserCats(u.categories);
  updateUserCatsVisibility();
  userForm.scrollIntoView({ behavior: 'smooth' });
}

userForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#user-error').textContent = '';
  const body = {
    name: userForm.name.value,
    role: userForm.role.value,
    personal: userForm.personal.checked,
    categories: $$('#user-cats-list input:checked').map((i) => Number(i.value)),
  };
  if (userForm.password.value) body.password = userForm.password.value;
  try {
    if (editingUserId) {
      await api('/api/users/' + editingUserId, { method: 'PUT', body });
      if (editingUserId === me.id) await refreshMe();
    } else {
      await api('/api/users', { method: 'POST', body: { ...body, login: userForm.login.value } });
    }
    resetUserForm();
    await loadUsers();
  } catch (err) { $('#user-error').textContent = err.message; }
});

async function toggleUser(u) {
  const verb = u.active ? 'Вимкнути' : 'Увімкнути';
  if (!confirm(`${verb} користувача ${u.name}?`)) return;
  try {
    await api('/api/users/' + u.id, { method: 'PUT', body: { active: !u.active } });
    await loadUsers();
  } catch (err) { $('#user-error').textContent = err.message; }
}

async function togglePersonal(u) {
  const q = u.personal ? `Закрити для ${u.name} доступ до розділу «Особисте»?` : `Надати ${u.name} доступ до розділу «Особисте»?`;
  if (!confirm(q)) return;
  try {
    await api('/api/users/' + u.id, { method: 'PUT', body: { personal: !u.personal } });
    await loadUsers();
  } catch (err) { $('#user-error').textContent = err.message; }
}

async function loadUsers() {
  if (!isAdmin()) return;
  if (!editingUserId) resetUserForm();
  loadSos();
  users = await api('/api/users');
  const catName = (id) => categories.find((c) => c.id === id)?.name ?? '?';
  $('#user-body').replaceChildren(...users.map((u) => el('tr', { class: u.active ? '' : 'archived' },
    el('td', {}, u.name, u.id === me.id ? el('span', { class: 'muted' }, ' (ви)') : ''),
    el('td', {}, u.login),
    el('td', {}, roles[u.role]),
    el('td', { class: 'small' }, u.role !== 'editor' ? '—' : (u.categories.length ? u.categories.map(catName).join(', ') : 'усі')),
    el('td', {}, u.role === 'admin' ? 'завжди' : el('button', {
      class: 'link', title: u.personal ? 'Закрити доступ' : 'Надати доступ',
      onclick: () => togglePersonal(u),
    }, u.personal ? 'дозволено' : 'закрито')),
    el('td', {}, u.active ? 'Активний' : 'Вимкнений'),
    el('td', { class: 'row-actions' },
      el('button', { class: 'link', onclick: () => editUser(u) }, 'Змінити'),
      u.id === me.id ? '' : el('button', { class: 'link' + (u.active ? ' danger' : ''), onclick: () => toggleUser(u) },
        u.active ? 'Вимкнути' : 'Увімкнути')),
  )));
}
// ---------- SOS-пароль ----------
const sosForm = $('#sos-form');
async function loadSos() {
  sosForm.hidden = true;
  const res = await fetch('/api/sos', { credentials: 'same-origin' }).catch(() => null);
  if (!res || !res.ok) return;
  const { set } = await res.json();
  sosForm.reset();
  $('#sos-error').textContent = '';
  $('#sos-state').textContent = set ? 'Зараз SOS-пароль задано.' : 'Зараз SOS-пароль не задано.';
  sosForm.password.required = true;
  $('#sos-off').hidden = !set;
  sosForm.hidden = false;
}
sosForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#sos-error').textContent = '';
  try {
    await api('/api/sos', { method: 'PUT', body: { password: sosForm.password.value, current: sosForm.current.value } });
    await loadSos();
    alert('SOS-пароль збережено.');
  } catch (err) { $('#sos-error').textContent = err.message; }
});
$('#sos-off').addEventListener('click', async () => {
  $('#sos-error').textContent = '';
  if (!sosForm.current.value) { $('#sos-error').textContent = 'Введіть свій справжній пароль для підтвердження'; return; }
  try {
    await api('/api/sos', { method: 'DELETE', body: { current: sosForm.current.value } });
    await loadSos();
  } catch (err) { $('#sos-error').textContent = err.message; }
});

async function refreshMe() {
  const s = await api('/api/session');
  me = s.user;
  $('#me-name').textContent = me.name;
  $('#me-role').textContent = roles[me.role];
  if (!isAdmin()) await showApp(s);
}

// ---------- Журнал ----------
async function loadAudit() {
  const rows = await api('/api/audit');
  $('#audit-body').replaceChildren(...(rows.length ? rows.map((r) => el('tr', {},
    el('td', { class: 'nowrap' }, dateTimeFmt(r.at)),
    el('td', {}, r.user_name),
    el('td', {}, r.action),
    el('td', { class: 'desc small' }, r.details),
  )) : [el('tr', {}, el('td', { colspan: 4, class: 'muted' }, 'Записів ще немає.'))]));
}

// ---------- Старт ----------
setPeriod('month');
fetch('/api/session', { credentials: 'same-origin' })
  .then((r) => (r.ok ? r.json().then(showApp) : showLogin()))
  .catch(showLogin);
