'use strict';

const BACKEND_URL = window.APP_CONFIG.BACKEND_URL;
const UAH_RATE = window.APP_CONFIG.UAH_RATE;
const LOCAL_STATE_KEY = 'my-stata-state-v1';
const syncQueue = [];
let syncRunning = false;
let localRevision = 0;
let loaderCount = 0;

const state = {
  leads: [], payments: [], payouts: [], settings: [],
  currentMonth: monthKey(new Date()), searchQuery: '',
  activeLeadId: null, loaded: false
};

window.addEventListener('beforeunload', (e) => {
  if (syncQueue.length > 0) { e.preventDefault(); e.returnValue = 'Дані ще зберігаються на сервер. Якщо ви закриєте сторінку, вони можуть бути втрачені!'; }
});

function showLoader() { loaderCount++; document.getElementById('globalLoader').classList.add('active'); }
function hideLoader() { loaderCount = Math.max(0, loaderCount - 1); if (loaderCount === 0) document.getElementById('globalLoader').classList.remove('active'); }

function persistState() {
  try { localRevision += 1; localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify({ leads: state.leads, payments: state.payments, payouts: state.payouts, settings: state.settings })); } catch (err) {}
}

function hydrateLocalState() {
  try {
    const saved = JSON.parse(localStorage.getItem(LOCAL_STATE_KEY) || 'null');
    if (!saved) return false;
    state.leads = saved.leads || []; state.payments = saved.payments || []; state.payouts = saved.payouts || []; state.settings = saved.settings || []; state.loaded = true; return true;
  } catch (err) { localStorage.removeItem(LOCAL_STATE_KEY); return false; }
}

function enqueueSync(task) { syncQueue.push(task); processSyncQueue(); }

async function processSyncQueue() {
  if (syncRunning || syncQueue.length === 0) return;
  syncRunning = true; showLoader();
  try { await syncQueue[0](); syncQueue.shift(); } 
  catch (err) { toast('Проблема з мережею: ' + err.message + '. Дані збережені локально.', true); syncRunning = false; hideLoader(); return; }
  syncRunning = false;
  if (syncQueue.length === 0) { 
    hideLoader(); 
    toast('Успішно збережено!'); 
    loadAll(); 
  } else { processSyncQueue(); }
}

function monthKey(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
function todayStr() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function shiftMonth(key, delta) { const [y, m] = key.split('-').map(Number); return monthKey(new Date(y, m - 1 + delta, 1)); }
function fmtMoney(n, cur) { return (Number(n) || 0).toLocaleString('uk-UA', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' ' + (cur || '€'); }
function fmtEUR(n) { return fmtMoney(n, '€'); }
function fmtUAH(n) { return fmtMoney(n, '₴'); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function toast(msg, isError) {
  const t = document.getElementById('toast'); t.textContent = msg; t.className = 'toast show' + (isError ? ' toast--error' : '');
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.className = 'toast'; }, 4000);
}

async function api(action, payload) {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 15000);
  let res;
  try { res = await fetch(BACKEND_URL, { method: 'POST', body: JSON.stringify({ action, payload: payload || {} }), signal: controller.signal, cache: 'no-store' }); } 
  catch (err) { if (err.name === 'AbortError') throw new Error('Таблиця не відповіла'); throw err; } finally { clearTimeout(timeout); }
  if (!res.ok) throw new Error('Помилка ' + res.status);
  const json = await res.json(); if (!json.ok) throw new Error(json.error || 'Невідома помилка'); return json.data;
}

async function loadAll() {
  const revisionAtRequest = localRevision;
  if (!state.loaded) showLoader();
  try {
    const data = await api('getAll'); if (revisionAtRequest !== localRevision) return;
    state.leads = (data.leads || []).map(l => { l.month = (l.createdDate || '').substring(0, 7) || l.month; return l; });
    state.payments = data.payments || []; state.payouts = data.payouts || []; state.settings = data.settings || []; state.loaded = true; persistState(); renderAll();
  } catch (err) { if (!state.loaded) { state.loaded = true; renderAll(); toast('Помилка: ' + err.message, true); } } finally { hideLoader(); }
}

function getDirections() { const seen = []; state.settings.forEach(s => { if (!seen.includes(s.direction)) push(s.direction); }); return seen; }
function getTariffs(direction) { return state.settings.filter(s => s.direction === direction).sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0)); }
function getSetting(direction, tariff) { return state.settings.find(s => s.direction === direction && s.tariff === tariff); }
function leadPayments(leadId) { return state.payments.filter(p => p.leadId === leadId); }
function leadPaidTotal(leadId) { return leadPayments(leadId).filter(p => !p.cancelled).reduce((s, p) => s + p.amount, 0); }
function leadRemaining(lead) { return lead.cancelled ? 0 : Math.max(lead.price - leadPaidTotal(lead.id), 0); }
function leadCommissionFact(lead) { return leadPaidTotal(lead.id) * (lead.commissionPercent / 100); }
function leadCommissionPotential(lead) { return leadRemaining(lead) * (lead.commissionPercent / 100); }
function leadStatusDisplay(lead) { if (lead.cancelled) return 'Скасовано'; const paid = leadPaidTotal(lead.id); if (lead.price > 0 && paid >= lead.price) return 'Оплачено повністю'; if (paid > 0) return 'Часткова оплата'; return lead.status || 'Бронь'; }
function statusClass(st) { if (st === 'Оплачено повністю') return 'badge--green'; if (st === 'Часткова оплата') return 'badge--amber'; if (st === 'Скасовано') return 'badge--red'; return 'badge--muted'; }
function leadById(id) { return state.leads.find(l => l.id === id); }

function computeDashboard() {
  const monthLeads = state.leads.filter(l => l.month === state.currentMonth);
  
  const clientPaidFact = monthLeads.reduce((s, l) => s + leadPaidTotal(l.id), 0);
  const clientPotentialFull = state.leads.reduce((s, l) => s + leadRemaining(l), 0); 
  
  const myFact = monthLeads.reduce((s, l) => s + leadCommissionFact(l), 0);
  
  const myPotentialMonth = monthLeads.reduce((s, l) => s + leadCommissionPotential(l), 0); 
  const myPotentialFull = state.leads.reduce((s, l) => s + leadCommissionPotential(l), 0); 
  
  const expectedPayout = state.leads.reduce((s, l) => s + leadCommissionFact(l), 0) - state.payouts.reduce((s, p) => s + p.amount, 0);

  const today = new Date();
  const [selYear, selMonth] = state.currentMonth.split('-').map(Number);
  let daysPassed = 1;
  let daysInMonth = new Date(selYear, selMonth, 0).getDate(); 

  if (today.getFullYear() === selYear && (today.getMonth() + 1) === selMonth) {
    daysPassed = today.getDate(); 
  } else if (selYear < today.getFullYear() || (selYear === today.getFullYear() && selMonth < (today.getMonth() + 1))) {
    daysPassed = daysInMonth; 
  } else {
    daysPassed = 1; 
  }
  
  // Прогноз будується на потенціалі (Факт + Очікування з угод поточного місяця)
  const forecastEUR = ((myFact + myPotentialMonth) / daysPassed) * daysInMonth;

  return {
    clientPaidFact,
    clientPotentialFull,
    myFact,
    myPotentialMonth,
    myPotentialFull,
    expectedPayout,
    forecastEUR
  };
}

function renderAll() { renderDashboard(); renderDealsTable(); renderPayoutsTable(); renderSettings(); populateAddLeadSelectors(); document.getElementById('monthPicker').value = state.currentMonth; }

function renderDashboard() {
  const d = computeDashboard();
  document.getElementById('figClientPaid').textContent = fmtEUR(d.clientPaidFact); 
  document.getElementById('figMyFact').textContent = fmtEUR(d.myFact); 
  document.getElementById('figMyFactUAH').textContent = fmtUAH(d.myFact * UAH_RATE);
  
  document.getElementById('figClientPotential').textContent = fmtEUR(d.clientPotentialFull);
  document.getElementById('figMyPotential').innerHTML = `${fmtEUR(d.myPotentialMonth)} <span style="color:var(--text-dim)">/</span> ${fmtEUR(d.myPotentialFull)}`;
  document.getElementById('figMyPotentialUAH').innerHTML = `${fmtUAH(d.myPotentialMonth * UAH_RATE)} <span style="color:var(--text-dim)">/</span> ${fmtUAH(d.myPotentialFull * UAH_RATE)}`;
  
  document.getElementById('figOwed').textContent = fmtEUR(d.expectedPayout);
  document.getElementById('figOwedUAH').textContent = fmtUAH(d.expectedPayout * UAH_RATE);
  document.getElementById('figForecast').textContent = fmtEUR(d.forecastEUR);
  document.getElementById('figForecastUAH').textContent = fmtUAH(d.forecastEUR * UAH_RATE);
}

function renderDealsTable() {
  const tbody = document.getElementById('dealsBody'); const q = state.searchQuery.trim().toLowerCase();
  let list = q ? state.leads.filter(l => (l.clientName || '').toLowerCase().includes(q) || (l.nickname || '').toLowerCase().includes(q) || String(l.number).includes(q)) : state.leads.filter(l => l.month === state.currentMonth);
  list = list.slice().sort((a, b) => (b.createdDate || '').localeCompare(a.createdDate || '') || b.number - a.number);
  if (list.length === 0) { tbody.innerHTML = `<tr><td colspan="11" class="empty-row">${q ? 'Нічого не знайдено' : 'У цьому місяці ще немає лідів'}</td></tr>`; return; }
  tbody.innerHTML = list.map(lead => `
    <tr class="deal-row ${lead.cancelled ? 'row--cancelled' : ''}" data-id="${esc(lead.id)}">
      <td class="mono muted">#${lead.number}</td>
      <td><div class="cell-strong">${esc(lead.clientName || '—')}</div><div class="cell-sub">${esc(lead.nickname || '')}</div></td>
      <td><div class="cell-strong">${esc(lead.direction)}</div><div class="cell-sub">${esc(lead.tariff)}</div></td>
      <td class="mono">${fmtEUR(lead.price)}</td><td class="mono positive">${fmtEUR(leadPaidTotal(lead.id))}</td>
      <td class="mono ${leadRemaining(lead) > 0 ? 'negative' : 'muted'}">${fmtEUR(leadRemaining(lead))}</td>
      <td class="mono muted">${lead.commissionPercent}%</td>
      <td class="mono accent">${fmtEUR(leadCommissionFact(lead))}<div style="font-size: 11px; color: var(--text-muted); font-weight: normal; margin-top: 4px;">${fmtUAH(leadCommissionFact(lead) * UAH_RATE)}</div></td>
      <td><span class="badge ${statusClass(leadStatusDisplay(lead))}">${esc(leadStatusDisplay(lead))}</span></td>
      <td class="mono muted">${esc(lead.createdDate)}</td><td><button class="btn btn--tiny open-lead">Відкрити</button></td>
    </tr>`).join('');
}

function renderPayoutsTable() {
  const tbody = document.getElementById('payoutsBody'); const list = state.payouts.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  if (list.length === 0) { tbody.innerHTML = `<tr><td colspan="4" class="empty-row">Виплат ще не було</td></tr>`; return; }
  tbody.innerHTML = list.map(p => `<tr data-id="${esc(p.id)}"><td class="mono muted">${esc(p.date)}</td><td class="mono positive">${fmtEUR(p.amount)}</td><td style="text-align:left;">${esc(p.comment)}</td><td><button class="btn btn--tiny btn--danger del-payout">Видалити</button></td></tr>`).join('');
}

function renderSettings() {
  const wrap = document.getElementById('settingsGroups'); const ae = document.activeElement; if (ae && wrap.contains(ae) && ae.matches('input, select, textarea')) return;
  wrap.innerHTML = getDirections().map(dir => `<div class="settings-group"><h3>${esc(dir)}</h3><table class="settings-table">
    <thead><tr><th>Тариф</th><th>Ціна 1</th><th>Ціна 2</th><th>Ціна 3</th><th>Комісія</th><th></th></tr></thead><tbody>${getTariffs(dir).map(s => `
    <tr data-direction="${esc(dir)}" data-tariff="${esc(s.tariff)}"><td class="cell-strong" style="text-align:left;">${esc(s.tariff)}</td>
    <td data-label="Ціна 1"><input type="number" class="s-price1" value="${s.price1}"></td><td data-label="Ціна 2"><input type="number" class="s-price2" value="${s.price2}"></td>
    <td data-label="Ціна 3"><input type="number" class="s-price3" value="${s.price3}"></td><td data-label="Комісія"><span class="pct-field"><input type="number" class="s-percent" value="${s.percent}"> %</span></td>
    <td><button class="btn btn--tiny btn--primary save-settings-row">Зберегти</button></td></tr>`).join('')}</tbody></table></div>`).join('');
}

function populateAddLeadSelectors() { const dirSel = document.getElementById('fDirection'); dirSel.innerHTML = getDirections().map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join(''); populateTariffSelector(dirSel.value); }
function populateTariffSelector(direction) { const tSel = document.getElementById('fTariff'); tSel.innerHTML = getTariffs(direction).map(t => `<option value="${esc(t.tariff)}">${esc(t.tariff)} · ${t.percent}%</option>`).join(''); populatePriceOptions(direction, tSel.value); }
function populatePriceOptions(direction, tariff) {
  const wrap = document.getElementById('fPriceOptions'); const s = getSetting(direction, tariff); if (!s) { wrap.innerHTML = ''; return; }
  const opts = [{ label: 'Без знижки', value: s.price1 }, { label: 'Знижка 1', value: s.price2 }, { label: 'Знижка 2 / діагностика', value: s.price3 }];
  wrap.innerHTML = opts.map((o, i) => `<label class="price-opt"><input type="radio" name="fPriceOpt" value="${o.value}" ${i === 0 ? 'checked' : ''}><span class="price-opt__label">${o.label}</span><span class="price-opt__dash">—</span><span class="price-opt__value mono">${fmtEUR(o.value)}</span></label>`).join('');
}

function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
document.addEventListener('click', e => { if (e.target.matches('[data-close-modal]')) closeModal(e.target.getAttribute('data-close-modal')); if (e.target.classList.contains('modal-overlay')) e.target.classList.remove('open'); });

document.getElementById('btnAddLead').addEventListener('click', () => {
  ['fClientName', 'fNickname', 'fComment', 'fCustomPrice'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('fFirstPayment').value = '0'; document.getElementById('fDate').value = todayStr();
  document.getElementById('fCustomPriceToggle').checked = false; document.getElementById('fCustomPrice').hidden = true;
  populateAddLeadSelectors(); openModal('modalAddLead');
});
document.getElementById('fDirection').addEventListener('change', e => populateTariffSelector(e.target.value));
document.getElementById('fTariff').addEventListener('change', () => populatePriceOptions(document.getElementById('fDirection').value, document.getElementById('fTariff').value));
document.getElementById('fCustomPriceToggle').addEventListener('change', e => document.getElementById('fCustomPrice').hidden = !e.target.checked);

document.getElementById('btnSaveLead').addEventListener('click', async () => {
  const clientName = document.getElementById('fClientName').value.trim(); const nickname = document.getElementById('fNickname').value.trim();
  const direction = document.getElementById('fDirection').value; const tariff = document.getElementById('fTariff').value; const s = getSetting(direction, tariff);
  if (!clientName) { toast('Вкажи ім’я клієнта', true); return; }
  let price = s.price1; if (document.getElementById('fCustomPriceToggle').checked) price = Number(document.getElementById('fCustomPrice').value) || 0; else { const checked = document.querySelector('input[name="fPriceOpt"]:checked'); if (checked) price = Number(checked.value); }
  const status = document.getElementById('fStatus').value; const firstPayment = Number(document.getElementById('fFirstPayment').value) || 0;
  const date = document.getElementById('fDate').value || todayStr(); const comment = document.getElementById('fComment').value.trim(); const tempId = 'local-' + Date.now();
  const localLead = { id: tempId, number: Math.max(0, ...state.leads.map(l => Number(l.number) || 0)) + 1, clientName, nickname, direction, tariff, price, commissionPercent: Number(s.percent), status, comment, createdDate: date, month: date.substring(0, 7), cancelled: false };
  state.leads.push(localLead); if (firstPayment > 0) state.payments.push({ id: 'local-pay-' + Date.now(), leadId: tempId, amount: firstPayment, date, comment: 'Перший платіж', cancelled: false });
  state.currentMonth = date.substring(0, 7); persistState(); renderAll(); closeModal('modalAddLead');
  enqueueSync(async () => { const created = await api('addLead', { clientName, nickname, direction, tariff, price, commissionPercent: Number(s.percent), status, comment, createdDate: date }); localLead.id = created.id; state.payments.forEach(p => { if (p.leadId === tempId) p.leadId = created.id; }); if (state.activeLeadId === tempId) state.activeLeadId = created.id; persistState(); if (firstPayment > 0) await api('addPayment', { leadId: created.id, amount: firstPayment, date, comment: 'Перший платіж' }); });
});

document.getElementById('dealsBody').addEventListener('click', e => { if (e.target.classList.contains('open-lead')) openLeadDetail(e.target.closest('tr').getAttribute('data-id')); });
function openLeadDetail(id) {
  const lead = leadById(id); if (!lead) return; state.activeLeadId = id;
  document.getElementById('ldTitle').textContent = `#${lead.number} · ${lead.clientName}${lead.nickname ? ' (' + lead.nickname + ')' : ''}`;
  document.getElementById('ldClientName').value = lead.clientName || ''; document.getElementById('ldNickname').value = lead.nickname || '';
  document.getElementById('ldPrice').value = lead.price; document.getElementById('ldStatus').value = lead.status;
  document.getElementById('ldComment').value = lead.comment || ''; document.getElementById('ldCancelled').checked = !!lead.cancelled;
  renderLeadDetailSummary(lead); renderLeadPayments(lead); openModal('modalLead');
}

function renderLeadDetailSummary(lead) {
  const factEUR = leadCommissionFact(lead); const payments = leadPayments(lead.id).filter(p => !p.cancelled).sort((a, b) => a.date.localeCompare(b.date)); const firstPayDate = payments.length > 0 ? payments[0].date : '—';
  const tariffHTML = `<div style="font-weight:400; color:var(--text-muted); font-family:var(--font-body); line-height:1.3; text-align:center; white-space:normal; width:100%; word-break:break-word;">${esc(lead.direction)}<br><span style="color:var(--text); font-weight:700;">${esc(lead.tariff)}</span></div>`;

  document.getElementById('ldSummary').innerHTML = `
    <div class="mini-fig"><span>Тариф</span>${tariffHTML}</div><div class="mini-fig"><span>Ціна</span><b class="mono">${fmtEUR(lead.price)}</b></div>
    <div class="mini-fig"><span>Сплачено</span><b class="mono positive">${fmtEUR(leadPaidTotal(lead.id))}</b></div><div class="mini-fig"><span>Залишок</span><b class="mono negative">${fmtEUR(leadRemaining(lead))}</b></div>
    <div class="mini-fig"><span>Комісія</span><b class="mono">${lead.commissionPercent}%</b></div><div class="mini-fig"><span>Мій факт</span><b class="mono accent">${fmtEUR(factEUR)}<div style="font-size: 10px; color: var(--text-muted); font-weight: 500; margin-top: 2px;">${fmtUAH(factEUR * UAH_RATE)}</div></b></div>
    <div class="mini-fig"><span>Потенціал</span><b class="mono">${fmtEUR(leadCommissionPotential(lead))}</b></div><div class="mini-fig"><span>Перша оплата</span><b class="mono">${esc(firstPayDate)}</b></div>`;
}

function renderLeadPayments(lead) {
  const tbody = document.getElementById('ldPaymentsBody'); const list = leadPayments(lead.id).slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  if (list.length === 0) { tbody.innerHTML = `<tr><td colspan="5" class="empty-row">Платежів ще немає</td></tr>`; return; }
  tbody.innerHTML = list.map((p, i) => `<tr class="${p.cancelled ? 'row--cancelled' : ''}" data-id="${esc(p.id)}"><td class="mono muted">${esc(p.date)}</td><td class="mono ${p.cancelled ? 'muted' : 'positive'}">${fmtEUR(p.amount)}</td><td style="text-align:left;">${esc(p.comment || ('Платіж ' + (i + 1)))}</td><td><span class="badge ${p.cancelled ? 'badge--red' : 'badge--green'}">${p.cancelled ? 'Скасовано' : 'Зараховано'}</span></td><td><div style="display:flex;gap:6px;justify-content:center;"><button class="btn btn--tiny toggle-payment">${p.cancelled ? 'Відновити' : 'Скасувати'}</button><button class="btn btn--tiny btn--danger delete-payment" title="Видалити повністю" style="padding:4px 8px;font-size:14px;line-height:1;">✕</button></div></td></tr>`).join('');
}

document.getElementById('btnSaveLeadEdit').addEventListener('click', async () => {
  const id = state.activeLeadId;
  const payload = { id, clientName: document.getElementById('ldClientName').value.trim(), nickname: document.getElementById('ldNickname').value.trim(), price: Number(document.getElementById('ldPrice').value) || 0, status: document.getElementById('ldStatus').value, comment: document.getElementById('ldComment').value.trim(), cancelled: document.getElementById('ldCancelled').checked };
  const lead = leadById(id); if (lead) Object.assign(lead, payload); persistState(); renderAll(); openLeadDetail(id);
  enqueueSync(async () => { if (lead) payload.id = lead.id; await api('updateLead', payload); openLeadDetail(payload.id); });
});

document.getElementById('btnDeleteLead').addEventListener('click', async () => {
  const id = state.activeLeadId; if (!confirm('Видалити цей лід і всі його платежі назавжди?')) return;
  state.leads = state.leads.filter(l => l.id !== id); state.payments = state.payments.filter(p => p.leadId !== id);
  persistState(); renderAll(); closeModal('modalLead');
  enqueueSync(async () => { await api('deleteLead', { id }); });
});

document.getElementById('ldPaymentsBody').addEventListener('click', async e => {
  const row = e.target.closest('tr'); if (!row) return; const id = row.getAttribute('data-id');
  
  if (e.target.classList.contains('toggle-payment')) {
    const payment = state.payments.find(p => p.id === id); if (!payment) return;
    payment.cancelled = !payment.cancelled; persistState(); renderAll(); enqueueSync(async () => { await api('updatePayment', { id, cancelled: payment.cancelled }); openLeadDetail(state.activeLeadId); });
  }
  
  if (e.target.classList.contains('delete-payment')) {
    if (!confirm('Видалити цей платіж назавжди?')) return;
    state.payments = state.payments.filter(p => p.id !== id); persistState(); renderAll(); enqueueSync(async () => { await api('deletePayment', { id }); openLeadDetail(state.activeLeadId); });
  }
});

document.getElementById('btnAddPayment').addEventListener('click', () => {
  document.getElementById('pAmount').value = ''; document.getElementById('pDate').value = todayStr();
  const count = leadPayments(state.activeLeadId).length + 1;
  const names = ['Перший', 'Другий', 'Третій', 'Четвертий', 'П’ятий', 'Шостий', 'Сьомий', 'Восьмий', 'Дев’ятий', 'Десятий'];
  document.getElementById('pComment').value = count <= 10 ? `${names[count - 1]} платіж` : `${count}-й платіж`;
  openModal('modalAddPayment');
});

document.getElementById('btnSavePayment').addEventListener('click', async () => {
  const amount = Number(document.getElementById('pAmount').value) || 0; const date = document.getElementById('pDate').value || todayStr(); const comment = document.getElementById('pComment').value.trim();
  if (amount <= 0) { toast('Вкажи суму', true); return; } const payment = { id: 'local-pay-' + Date.now(), leadId: state.activeLeadId, amount, date, comment, cancelled: false }; state.payments.push(payment);
  persistState(); renderAll(); closeModal('modalAddPayment'); openLeadDetail(state.activeLeadId); enqueueSync(async () => { await api('addPayment', { leadId: payment.leadId, amount, date, comment }); openLeadDetail(state.activeLeadId); });
});

document.getElementById('btnAddPayout').addEventListener('click', () => { document.getElementById('oAmount').value = ''; document.getElementById('oDate').value = todayStr(); document.getElementById('oComment').value = ''; openModal('modalAddPayout'); });
document.getElementById('btnSavePayout').addEventListener('click', async () => {
  const amount = Number(document.getElementById('oAmount').value) || 0; const date = document.getElementById('oDate').value || todayStr(); const comment = document.getElementById('oComment').value.trim();
  if (amount <= 0) { toast('Вкажи суму', true); return; } const payout = { id: 'local-out-' + Date.now(), amount, date, comment }; state.payouts.push(payout);
  persistState(); renderAll(); closeModal('modalAddPayout'); enqueueSync(async () => { const created = await api('addPayout', { amount, date, comment }); payout.id = created.id; persistState(); });
});
document.getElementById('payoutsBody').addEventListener('click', async e => {
  if (!e.target.classList.contains('del-payout')) return; const id = e.target.closest('tr').getAttribute('data-id'); if (!confirm('Видалити цю виплату?')) return;
  const payout = state.payouts.find(item => item.id === id); state.payouts = state.payouts.filter(p => p.id !== id); persistState(); renderAll(); enqueueSync(async () => { await api('deletePayout', { id: payout ? payout.id : id }); });
});

document.getElementById('settingsGroups').addEventListener('click', async e => {
  if (!e.target.classList.contains('save-settings-row')) return; const row = e.target.closest('tr');
  const payload = { direction: row.getAttribute('data-direction'), tariff: row.getAttribute('data-tariff'), price1: Number(row.querySelector('.s-price1').value) || 0, price2: Number(row.querySelector('.s-price2').value) || 0, price3: Number(row.querySelector('.s-price3').value) || 0, percent: Number(row.querySelector('.s-percent').value) || 0 };
  const setting = getSetting(payload.direction, payload.tariff); if (setting) Object.assign(setting, payload); persistState(); renderAll(); enqueueSync(async () => { await api('updateSettings', payload); });
});

document.getElementById('tabs').addEventListener('click', e => { if (!e.target.matches('.tab')) return; document.querySelectorAll('.tab').forEach(t => t.classList.remove('active')); e.target.classList.add('active'); document.querySelectorAll('.view').forEach(v => v.classList.remove('active')); document.getElementById('view-' + e.target.getAttribute('data-tab')).classList.add('active'); });
document.getElementById('monthPrev').addEventListener('click', () => { state.currentMonth = shiftMonth(state.currentMonth, -1); renderAll(); });
document.getElementById('monthNext').addEventListener('click', () => { state.currentMonth = shiftMonth(state.currentMonth, 1); renderAll(); });
document.getElementById('monthToday').addEventListener('click', () => { state.currentMonth = monthKey(new Date()); renderAll(); });
document.getElementById('monthPicker').addEventListener('change', e => { if (e.target.value) { state.currentMonth = e.target.value; renderAll(); } });
document.getElementById('searchInput').addEventListener('input', e => { state.searchQuery = e.target.value; document.getElementById('searchClear').hidden = !state.searchQuery; renderDealsTable(); });
document.getElementById('searchClear').addEventListener('click', () => { state.searchQuery = ''; document.getElementById('searchInput').value = ''; document.getElementById('searchClear').hidden = true; renderDealsTable(); });

if (hydrateLocalState()) renderAll();
loadAll();
