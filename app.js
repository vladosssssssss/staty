'use strict';

const BACKEND_URL = window.APP_CONFIG.BACKEND_URL;
const UAH_RATE = window.APP_CONFIG.UAH_RATE;
const LOCAL_STATE_KEY = 'my-stata-state-v1';
const BRON_THRESHOLD_EUR = 150; // сплачено < 150€ → Бронь; сплачено >= 150€ (і менше ціни) → Часткова оплата
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

function enqueueSync(task, onFail) { syncQueue.push({ fn: task, attempts: 0, onFail }); processSyncQueue(); }

async function processSyncQueue() {
  if (syncRunning || syncQueue.length === 0) return;
  syncRunning = true; showLoader();
  const job = syncQueue[0];
  try {
    await job.fn();
    syncQueue.shift();
  } catch (err) {
    job.attempts += 1;
    syncRunning = false; hideLoader();
    if (job.attempts >= 3) {
      // Три спроби не спрацювали — прибираємо завдання з черги, аби воно не лишалось "застряглим"
      // і не намагалось повторюватись безкінечно. Якщо для нього передали onFail — відкатуємо
      // локальні дані назад, щоб не було розсинхрону "виглядає збереженим, а насправді ні".
      syncQueue.shift();
      if (job.onFail) { try { job.onFail(err); } catch (e2) {} }
      toast('Не вдалося зберегти: ' + err.message + '. Спробуй ще раз.', true);
      if (syncQueue.length > 0) processSyncQueue();
    } else {
      toast('Проблема з мережею, повторюю спробу…', true);
      setTimeout(processSyncQueue, 1500 * job.attempts);
    }
    return;
  }
  syncRunning = false;
  if (syncQueue.length === 0) { 
    hideLoader(); 
    toast('Успішно збережено!'); 
    loadAll(); 
  } else { processSyncQueue(); }
}

function genId(prefix) { return prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8); }

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
  const controller = new AbortController(); 
  const timeout = setTimeout(() => controller.abort(), 30000); // ФІКС: Збільшений таймаут до 30 секунд
  let res;
  try { 
    res = await fetch(BACKEND_URL, { 
      method: 'POST', 
      body: JSON.stringify({ action, payload: payload || {} }), 
      signal: controller.signal, 
      cache: 'no-store',
      redirect: 'follow' // ФІКС CORS: слідуємо за редіректами Гугла
    }); 
  } 
  catch (err) { if (err.name === 'AbortError') throw new Error('Таблиця не відповіла за 30 секунд'); throw err; } finally { clearTimeout(timeout); }
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

function getDirections() { const seen = []; state.settings.forEach(s => { if (!seen.includes(s.direction)) seen.push(s.direction); }); return seen; }
function getTariffs(direction) { return state.settings.filter(s => s.direction === direction).sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0)); }
function getSetting(direction, tariff) { return state.settings.find(s => s.direction === direction && s.tariff === tariff); }

function leadPayments(leadId) { return state.payments.filter(p => p.leadId === leadId); }
function actualPaidTotal(leadId) { return leadPayments(leadId).filter(p => !p.cancelled).reduce((s, p) => s + p.amount, 0); }

function leadPaidTotal(lead) { 
  if (lead.status === 'Оплачено повністю (договір)') return lead.price / 2;
  return actualPaidTotal(lead.id); 
}

function leadRemaining(lead) { 
  if (lead.cancelled) return 0;
  if (lead.status === 'Оплачено повністю (договір)') return lead.price / 2;
  return Math.max(lead.price - actualPaidTotal(lead.id), 0); 
}

function leadClientPotential(lead) {
  if (lead.status === 'Оплачено повністю (договір)') {
      const currentRealMonth = monthKey(new Date());
      const m2 = shiftMonth(lead.month, 1);
      return (currentRealMonth < m2) ? lead.price / 2 : 0;
  }
  return leadRemaining(lead);
}

function leadCommissionFact(lead, targetMonth) {
  if (lead.status === 'Оплачено повністю (договір)') {
    const totalCommission = lead.price * (lead.commissionPercent / 100);
    const m2 = shiftMonth(lead.month, 1);
    if (targetMonth) {
      if (targetMonth === lead.month) return totalCommission / 2;
      if (targetMonth === m2) return totalCommission / 2;
      return 0; 
    } else {
      const currentRealMonth = monthKey(new Date());
      if (currentRealMonth < m2) return totalCommission / 2;
      return totalCommission;
    }
  }
  return leadPaidTotal(lead) * (lead.commissionPercent / 100);
}

function leadCommissionPotential(lead, targetMonth) {
  if (lead.status === 'Оплачено повністю (договір)') {
    if (targetMonth) {
      return 0; 
    }
    const currentRealMonth = monthKey(new Date());
    const m2 = shiftMonth(lead.month, 1);
    return (currentRealMonth < m2) ? (lead.price * (lead.commissionPercent / 100)) / 2 : 0;
  }
  return leadRemaining(lead) * (lead.commissionPercent / 100);
}

function leadStatusDisplay(lead) { 
  if (lead.cancelled) return 'Скасовано'; 
  if (lead.status === 'Оплачено повністю (договір)') return 'Оплачено повністю (договір)';
  const paid = actualPaidTotal(lead.id);
  if (lead.price > 0 && paid >= lead.price) return 'Оплачено повністю'; 
  if (paid >= BRON_THRESHOLD_EUR) return 'Часткова оплата'; 
  return 'Бронь'; 
}

function statusClass(st) { 
  if (st === 'Оплачено повністю (договір)') return 'badge--blue';
  if (st === 'Оплачено повністю') return 'badge--green'; 
  if (st === 'Часткова оплата') return 'badge--amber'; 
  if (st === 'Скасовано') return 'badge--red'; 
  return 'badge--muted'; 
}
function leadById(id) { return state.leads.find(l => l.id === id); }

// Кількість УСІХ нових лідів обраного місяця (включно з бронями), без перенесених договорів з минулого місяця.
function allLeadsCountForMonth(monthKey) {
  return state.leads.filter(l => l.month === monthKey && !l.cancelled).length;
}
// Скільки з них уже реально "зайшли в роботу" — тобто статус вище Броні
// (Часткова оплата, Оплачено повністю, Оплачено повністю (договір)).
function confirmedInWorkCountForMonth(monthKey) {
  return state.leads.filter(l => l.month === monthKey && !l.cancelled && leadStatusDisplay(l) !== 'Бронь').length;
}

function computeDashboard() {
  const monthLeads = state.leads.filter(l => l.month === state.currentMonth);
  const contractLeadsPrevMonth = state.leads.filter(l => l.status === 'Оплачено повністю (договір)' && shiftMonth(l.month, 1) === state.currentMonth);
  const allDashboardLeads = [...monthLeads, ...contractLeadsPrevMonth];
  
  const clientPaidFact = allDashboardLeads.reduce((s, l) => s + leadPaidTotal(l), 0);
  const clientPotentialMonth = monthLeads.reduce((s, l) => s + leadRemaining(l), 0);
  
  const myFact = allDashboardLeads.reduce((s, l) => s + leadCommissionFact(l, state.currentMonth), 0);
  const myPotentialMonth = monthLeads.reduce((s, l) => s + leadCommissionPotential(l, state.currentMonth), 0); 
  const myTotalMonth = myFact + myPotentialMonth;
  
  const clientPaidAllTime = state.leads.reduce((s, l) => s + leadPaidTotal(l), 0);
  const clientPotentialFull = state.leads.reduce((s, l) => s + leadClientPotential(l), 0); 
  const myFactAllTime = state.leads.reduce((s, l) => s + leadCommissionFact(l), 0);
  const myPotentialFull = state.leads.reduce((s, l) => s + leadCommissionPotential(l), 0); 
  
  const expectedPayout = myFactAllTime - state.payouts.reduce((s, p) => s + p.amount, 0);

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
  
  const forecastEUR = ((myFact + myPotentialMonth) / daysPassed) * daysInMonth;

  return {
    clientPaidFact, clientPotentialMonth, myFact, myPotentialMonth, myTotalMonth,
    clientPaidAllTime, clientPotentialFull, myFactAllTime, myPotentialFull,
    expectedPayout, forecastEUR
  };
}

function renderAll() { renderDashboard(); renderDealsTable(); renderPayoutsTable(); renderSettings(); populateAddLeadSelectors(); document.getElementById('monthPicker').value = state.currentMonth; }

function renderDashboard() {
  const d = computeDashboard();
  
  document.getElementById('figMyFact').textContent = fmtEUR(d.myFact); 
  document.getElementById('figMyFactUAH').textContent = fmtUAH(d.myFact * UAH_RATE);
  
  document.getElementById('figMyPotential').innerHTML = `${fmtEUR(d.myPotentialMonth)} <span style="color:var(--text-dim)">/</span> ${fmtEUR(d.myPotentialFull)}`;
  document.getElementById('figMyPotentialUAH').innerHTML = `${fmtUAH(d.myPotentialMonth * UAH_RATE)} <span style="color:var(--text-dim)">/</span> ${fmtUAH(d.myPotentialFull * UAH_RATE)}`;

  document.getElementById('figMyTotalMonth').textContent = fmtEUR(d.myTotalMonth);
  document.getElementById('figMyTotalMonthUAH').textContent = fmtUAH(d.myTotalMonth * UAH_RATE);

  document.getElementById('figForecast').textContent = fmtEUR(d.forecastEUR);
  document.getElementById('figForecastUAH').textContent = fmtUAH(d.forecastEUR * UAH_RATE);
  
  document.getElementById('figOwed').textContent = fmtEUR(d.expectedPayout);
  document.getElementById('figOwedUAH').textContent = fmtUAH(d.expectedPayout * UAH_RATE);

  document.getElementById('mdWaitMonth').textContent = fmtEUR(d.myPotentialMonth);
  document.getElementById('mdWaitMonthUAH').textContent = fmtUAH(d.myPotentialMonth * UAH_RATE);
  document.getElementById('mdWaitAll').textContent = fmtEUR(d.myPotentialFull);
  document.getElementById('mdWaitAllUAH').textContent = fmtUAH(d.myPotentialFull * UAH_RATE);
  
  document.getElementById('mdClientPaidMonth_EUR').textContent = fmtEUR(d.clientPaidFact);
  document.getElementById('mdClientPaidMonth_UAH').textContent = fmtUAH(d.clientPaidFact * UAH_RATE);
  document.getElementById('mdClientDebtMonth_EUR').textContent = fmtEUR(d.clientPotentialMonth);
  document.getElementById('mdClientDebtMonth_UAH').textContent = fmtUAH(d.clientPotentialMonth * UAH_RATE);
  document.getElementById('mdMyFactMonth_EUR').textContent = fmtEUR(d.myFact);
  document.getElementById('mdMyFactMonth_UAH').textContent = fmtUAH(d.myFact * UAH_RATE);
  document.getElementById('mdMyDebtMonth_EUR').textContent = fmtEUR(d.myPotentialMonth);
  document.getElementById('mdMyDebtMonth_UAH').textContent = fmtUAH(d.myPotentialMonth * UAH_RATE);
  
  document.getElementById('mdClientPaidAll_EUR').textContent = fmtEUR(d.clientPaidAllTime);
  document.getElementById('mdClientPaidAll_UAH').textContent = fmtUAH(d.clientPaidAllTime * UAH_RATE);
  document.getElementById('mdClientDebtAll_EUR').textContent = fmtEUR(d.clientPotentialFull);
  document.getElementById('mdClientDebtAll_UAH').textContent = fmtUAH(d.clientPotentialFull * UAH_RATE);
  document.getElementById('mdMyFactAll_EUR').textContent = fmtEUR(d.myFactAllTime);
  document.getElementById('mdMyFactAll_UAH').textContent = fmtUAH(d.myFactAllTime * UAH_RATE);
  document.getElementById('mdMyDebtAll_EUR').textContent = fmtEUR(d.myPotentialFull);
  document.getElementById('mdMyDebtAll_UAH').textContent = fmtUAH(d.myPotentialFull * UAH_RATE);
}

function formatDateDayMonth(d) {
    const m = ['січня','лютого','березня','квітня','травня','червня','липня','серпня','вересня','жовтня','листопада','грудня'][d.getMonth()];
    return `${d.getDate()} ${m}`;
}

function renderSummaryText() {
  const fromDateStr = document.getElementById('mdFromDate').value;
  const toDateStr = document.getElementById('mdToDate').value;

  if (!fromDateStr || !toDateStr) {
      toast('Оберіть дати', true); return;
  }

  const fromD = new Date(fromDateStr);
  const toD = new Date(toDateStr);

  const periodLeads = state.leads.filter(l => l.createdDate >= fromDateStr && l.createdDate <= toDateStr);
  
  const carryOverLeads = state.leads.filter(l => {
      if (l.status !== 'Оплачено повністю (договір)') return false;
      const nextMonthFirstDay = shiftMonth(l.month, 1) + '-01'; 
      return nextMonthFirstDay >= fromDateStr && nextMonthFirstDay <= toDateStr;
  });

  let myFact = 0;
  let myPotential = 0;
  let contractCount = 0;
  let contractThisMonth = 0;
  let contractNextMonth = 0;
  let carryOverAmount = 0;

  periodLeads.forEach(l => {
      if (l.status === 'Оплачено повністю (договір)') {
          contractCount++;
          const totalCommission = l.price * (l.commissionPercent / 100);
          myFact += totalCommission / 2;
          contractThisMonth += totalCommission / 2;
          contractNextMonth += totalCommission / 2;
      } else {
          myFact += leadPaidTotal(l) * (l.commissionPercent / 100);
          myPotential += leadRemaining(l) * (l.commissionPercent / 100);
      }
  });

  carryOverLeads.forEach(l => {
      const totalCommission = l.price * (l.commissionPercent / 100);
      myFact += totalCommission / 2;
      carryOverAmount += totalCommission / 2;
  });

  const pureTotal = myFact + myPotential;
  const grossTotal = pureTotal + contractNextMonth;

  let text = `З ${formatDateDayMonth(fromD)} по ${formatDateDayMonth(toD)} ти фактично заробив <b>${fmtEUR(myFact)} = ${fmtUAH(myFact * UAH_RATE)}</b>, а потенційно очікуєш з боргів ще <b>${fmtEUR(myPotential)} = ${fmtUAH(myPotential * UAH_RATE)}</b>.<br><br>`;
  
  if (carryOverAmount > 0) {
      text += `(У твій фактичний заробіток також увійшло <b>${fmtEUR(carryOverAmount)} = ${fmtUAH(carryOverAmount * UAH_RATE)}</b> з договорів минулого місяця).<br><br>`;
  }

  if (contractCount > 0) {
      text += `При цьому <b>${contractCount}</b> клієнт(ів) підписали договір у цей період. Це означає, що <b>${fmtEUR(contractThisMonth)} = ${fmtUAH(contractThisMonth * UAH_RATE)}</b> пішло у факт зараз, а <b>${fmtEUR(contractNextMonth)} = ${fmtUAH(contractNextMonth * UAH_RATE)}</b> гарантовано перейде на наступний місяць.<br><br>`;
      text += `По факту ти заробив сумарно <b>${fmtEUR(grossTotal)} = ${fmtUAH(grossTotal * UAH_RATE)}</b>, але з них <b>${fmtEUR(contractNextMonth)} = ${fmtUAH(contractNextMonth * UAH_RATE)}</b> увійшло в наступний місяць. Тому твій чистий заробіток саме за цей період становить <b>${fmtEUR(pureTotal)} = ${fmtUAH(pureTotal * UAH_RATE)}</b>.`;
  } else {
      text += `По факту твій чистий сумарний дохід (факт + борги) за цей період становить <b>${fmtEUR(pureTotal)} = ${fmtUAH(pureTotal * UAH_RATE)}</b>.`;
  }

  const box = document.getElementById('summaryTextBox');
  box.innerHTML = text;
  box.style.display = 'block';
}

function renderDealsTable() {
  const tbody = document.getElementById('dealsBody'); const q = state.searchQuery.trim().toLowerCase();
  
  function rowHtml(lead, monthToPass) {
    return `<tr class="deal-row ${lead.cancelled ? 'row--cancelled' : ''}" data-id="${esc(lead.id)}">
      <td class="mono muted">#${lead.number}</td>
      <td><div class="cell-strong">${esc(lead.clientName || '—')}</div><div class="cell-sub">${esc(lead.nickname || '')}</div></td>
      <td><div class="cell-strong">${esc(lead.direction)}</div><div class="cell-sub">${esc(lead.tariff)}</div></td>
      <td class="mono">${fmtEUR(lead.price)}</td><td class="mono positive">${fmtEUR(leadPaidTotal(lead))}</td>
      <td class="mono ${leadRemaining(lead) > 0 ? 'negative' : 'muted'}">${fmtEUR(leadRemaining(lead))}</td>
      <td class="mono muted">${lead.commissionPercent}%</td>
      <td class="mono accent">${fmtEUR(leadCommissionFact(lead, monthToPass))}<div style="font-size: 11px; color: var(--text-muted); font-weight: normal; margin-top: 4px;">${fmtUAH(leadCommissionFact(lead, monthToPass) * UAH_RATE)}</div></td>
      <td><span class="badge ${statusClass(leadStatusDisplay(lead))}">${esc(leadStatusDisplay(lead))}</span></td>
      <td class="mono muted">${esc(lead.createdDate)}</td><td><button class="btn btn--tiny open-lead">Відкрити</button></td>
    </tr>`;
  }

  if (q) {
    let list = state.leads.filter(l => (l.clientName || '').toLowerCase().includes(q) || (l.nickname || '').toLowerCase().includes(q) || String(l.number).includes(q));
    list = list.slice().sort((a, b) => (b.createdDate || '').localeCompare(a.createdDate || '') || b.number - a.number);
    if (list.length === 0) { tbody.innerHTML = `<tr><td colspan="11" class="empty-row">Нічого не знайдено</td></tr>`; return; }
    tbody.innerHTML = list.map(l => rowHtml(l, null)).join('');
    return;
  }

  const thisMonth = state.leads.filter(l => l.month === state.currentMonth).sort((a, b) => (b.createdDate || '').localeCompare(a.createdDate || '') || b.number - a.number);
  const prevMonth = state.leads.filter(l => l.status === 'Оплачено повністю (договір)' && shiftMonth(l.month, 1) === state.currentMonth).sort((a, b) => (b.createdDate || '').localeCompare(a.createdDate || '') || b.number - a.number);

  if (thisMonth.length === 0 && prevMonth.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11" class="empty-row">У цьому місяці ще немає лідів</td></tr>`; return;
  }

  let html = thisMonth.map(l => rowHtml(l, state.currentMonth)).join('');
  if (prevMonth.length > 0) {
    html += `<tr><td colspan="11" style="text-align:center; background:var(--surface-3); color:var(--text-muted); font-size:11px; text-transform:uppercase; letter-spacing:0.5px; padding:10px;">↑ Нові ліди цього місяця &nbsp;|&nbsp; ↓ Перенесені договори з минулого місяця</td></tr>`;
    html += prevMonth.map(l => rowHtml(l, state.currentMonth)).join('');
  }
  tbody.innerHTML = html;
}

function renderPayoutsTable() {
  const tbody = document.getElementById('payoutsBody'); const list = state.payouts.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  if (list.length === 0) { tbody.innerHTML = `<tr><td colspan="5" class="empty-row">Виплат ще не було</td></tr>`; return; }
  tbody.innerHTML = list.map(p => `
    <tr data-id="${esc(p.id)}">
      <td class="mono muted">${esc(p.date)}</td>
      <td class="mono positive">
        ${fmtUAH(p.amount * UAH_RATE)}
        <div style="font-size: 10.5px; color: var(--text-muted); margin-top: 4px;">≈ ${fmtEUR(p.amount)}</div>
      </td>
      <td class="mono accent">${p.bonus > 0 ? '+ ' + fmtUAH(p.bonus) : '—'}</td>
      <td style="text-align:left;">${esc(p.comment)}</td>
      <td><button class="btn btn--tiny btn--danger del-payout">Видалити</button></td>
    </tr>
  `).join('');
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

function openModal(id) { 
  document.getElementById(id).classList.add('open'); 
  if (id === 'modalStats') {
    document.getElementById('mdTabMonth').click();
  }
  if (id === 'modalConversion') {
    document.getElementById('cvPaymentsCount').value = allLeadsCountForMonth(state.currentMonth);
    document.getElementById('cvConversionPercent').value = '';
    document.getElementById('cvConfirmedCount').value = confirmedInWorkCountForMonth(state.currentMonth);
    document.getElementById('cvResultBox').style.display = 'none';
  }
}

function calcConversion() {
  const paymentsCount = Number(document.getElementById('cvPaymentsCount').value) || 0;
  const knownPercent = Number(document.getElementById('cvConversionPercent').value) || 0;
  const confirmedCount = Number(document.getElementById('cvConfirmedCount').value) || 0;

  if (paymentsCount <= 0) { toast('Вкажи кількість оплат', true); return; }
  if (knownPercent <= 0) { toast('Вкажи відому конверсію, %', true); return; }

  // Якщо paymentsCount оплат = knownPercent% від загального потоку "дверей",
  // то весь потік = paymentsCount / (knownPercent / 100).
  // Конверсія confirmedCount людей у роботу — це їхня частка від того ж потоку.
  const totalPool = paymentsCount / (knownPercent / 100);
  const confirmedPercent = totalPool > 0 ? (confirmedCount / totalPool) * 100 : 0;

  document.getElementById('cvResultPercent').textContent = confirmedPercent.toFixed(2) + '%';
  document.getElementById('cvResultPool').textContent = 'Орієнтовний загальний потік («двері»): ' + Math.round(totalPool) + ' ос.';
  document.getElementById('cvResultBox').style.display = 'block';
}
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
  const date = document.getElementById('fDate').value || todayStr(); const comment = document.getElementById('fComment').value.trim();
  const leadId = genId('local'); const paymentId = firstPayment > 0 ? genId('local-pay') : null;
  const localLead = { id: leadId, number: Math.max(0, ...state.leads.map(l => Number(l.number) || 0)) + 1, clientName, nickname, direction, tariff, price, commissionPercent: Number(s.percent), status, comment, createdDate: date, month: date.substring(0, 7), cancelled: false };
  state.leads.push(localLead); if (firstPayment > 0) state.payments.push({ id: paymentId, leadId, amount: firstPayment, date, comment: 'Перший платіж', cancelled: false });
  state.currentMonth = date.substring(0, 7); persistState(); renderAll(); closeModal('modalAddLead');

  // id відправляється на бекенд одразу — лід локально і на сервері має однаковий id з самого початку,
  // тож навіть повторна спроба після мережевого збою не створить дубль (бекенд це перевіряє за id).
  enqueueSync(async () => {
    await api('addLead', { id: leadId, clientName, nickname, direction, tariff, price, commissionPercent: Number(s.percent), status, comment, createdDate: date });
  }, () => {
    // Три спроби провалились — лід так і не потрапив у таблицю. Прибираємо його й з локального стану,
    // щоб не було ситуації "виглядає доданим, а насправді ні".
    state.leads = state.leads.filter(l => l.id !== leadId);
    state.payments = state.payments.filter(p => p.leadId !== leadId);
    persistState(); renderAll();
  });

  if (firstPayment > 0) {
    enqueueSync(async () => {
      if (!leadById(leadId)) return; // лід не зберігся — платіж уже не актуальний
      await api('addPayment', { id: paymentId, leadId, amount: firstPayment, date, comment: 'Перший платіж' });
    }, () => {
      if (!leadById(leadId)) return;
      state.payments = state.payments.filter(p => p.id !== paymentId);
      persistState(); renderAll();
      toast('Лід збережено, але перший платіж не вдалося додати. Додай його вручну.', true);
    });
  }
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
  const factEUR = leadCommissionFact(lead); 
  const fullCommissionEUR = lead.price * (lead.commissionPercent / 100);
  const paid = leadPaidTotal(lead);

  const tariffHTML = `<div style="font-weight:400; color:var(--text-muted); font-family:var(--font-body); line-height:1.3; text-align:center; white-space:normal; width:100%; word-break:break-word;">${esc(lead.direction)}<br><span style="color:var(--text); font-weight:700;">${esc(lead.tariff)}</span> <span style="font-size: 10px; color: var(--gold);">(${lead.commissionPercent}%)</span></div>`;

  document.getElementById('ldSummary').innerHTML = `
    <div class="mini-fig">
      <span>Тариф</span>
      ${tariffHTML}
    </div>
    <div class="mini-fig">
      <span>Ціна</span>
      <b class="mono">${fmtEUR(lead.price)}
        <div style="font-size: 10.5px; color: var(--text-muted); font-weight: 500; margin-top: 4px;">
          Мої: <span style="color:var(--gold)">${fmtEUR(fullCommissionEUR)}</span> = <span style="color:var(--gold)">${fmtUAH(fullCommissionEUR * UAH_RATE)}</span>
        </div>
      </b>
    </div>
    <div class="mini-fig">
      <span>Сплачено</span>
      <b class="mono positive">${fmtEUR(paid)}
        <div style="font-size: 10.5px; color: var(--text-muted); font-weight: 500; margin-top: 4px;">
          Факт: <span style="color:var(--gold)">${fmtEUR(factEUR)}</span> = <span style="color:var(--gold)">${fmtUAH(factEUR * UAH_RATE)}</span>
        </div>
      </b>
    </div>
    <div class="mini-fig">
      <span>Залишок</span>
      <b class="mono negative">${fmtEUR(leadRemaining(lead))}</b>
    </div>`;
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
  if (amount <= 0) { toast('Вкажи суму', true); return; } const paymentId = genId('local-pay'); const payment = { id: paymentId, leadId: state.activeLeadId, amount, date, comment, cancelled: false }; state.payments.push(payment);
  persistState(); renderAll(); closeModal('modalAddPayment'); openLeadDetail(state.activeLeadId);
  enqueueSync(async () => { await api('addPayment', { id: paymentId, leadId: payment.leadId, amount, date, comment }); openLeadDetail(state.activeLeadId); }, () => {
    state.payments = state.payments.filter(p => p.id !== paymentId); persistState(); renderAll();
    if (state.activeLeadId) openLeadDetail(state.activeLeadId);
  });
});

document.getElementById('btnAddPayout').addEventListener('click', () => { 
  document.getElementById('oAmountUAH').value = ''; 
  document.getElementById('oBonusUAH').value = '0'; 
  document.getElementById('oDate').value = todayStr(); 
  document.getElementById('oComment').value = ''; 
  openModal('modalAddPayout'); 
});

document.getElementById('btnSavePayout').addEventListener('click', async () => {
  const amountUAH = Number(document.getElementById('oAmountUAH').value) || 0; 
  const bonusUAH = Number(document.getElementById('oBonusUAH').value) || 0; 
  const date = document.getElementById('oDate').value || todayStr(); 
  const comment = document.getElementById('oComment').value.trim();
  
  if (amountUAH <= 0 && bonusUAH <= 0) { toast('Вкажи суму ЗП або бонус', true); return; } 
  
  const amountEUR = amountUAH / UAH_RATE; 
  const payoutId = genId('local-out');
  
  const payout = { id: payoutId, amount: amountEUR, bonus: bonusUAH, date, comment }; 
  state.payouts.push(payout);
  persistState(); renderAll(); closeModal('modalAddPayout'); 
  
  enqueueSync(async () => { 
    await api('addPayout', { id: payoutId, amount: amountEUR, bonus: bonusUAH, date, comment }); 
  }, () => {
    state.payouts = state.payouts.filter(p => p.id !== payoutId); persistState(); renderAll();
  });
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

document.getElementById('mdTabMonth').addEventListener('click', () => {
  document.getElementById('mdTabMonth').classList.add('active');
  document.getElementById('mdTabAll').classList.remove('active');
  document.getElementById('mdViewMonth').style.display = 'block';
  document.getElementById('mdViewAll').style.display = 'none';
  document.getElementById('summaryTextBox').style.display = 'none';

  const [y, m] = state.currentMonth.split('-');
  document.getElementById('mdFromDate').value = `${y}-${m}-01`;
  
  let endD = new Date(y, m, 0).getDate();
  const today = new Date();
  if (today.getFullYear() == y && (today.getMonth() + 1) == m) endD = today.getDate();
  document.getElementById('mdToDate').value = `${y}-${m}-${String(endD).padStart(2, '0')}`;
});

document.getElementById('mdTabAll').addEventListener('click', () => {
  document.getElementById('mdTabAll').classList.add('active');
  document.getElementById('mdTabMonth').classList.remove('active');
  document.getElementById('mdViewAll').style.display = 'block';
  document.getElementById('mdViewMonth').style.display = 'none';
  document.getElementById('summaryTextBox').style.display = 'none';

  if (state.leads.length > 0) {
      const sorted = [...state.leads].sort((a,b) => a.createdDate.localeCompare(b.createdDate));
      document.getElementById('mdFromDate').value = sorted[0].createdDate;
      document.getElementById('mdToDate').value = todayStr();
  }
});

document.getElementById('tabs').addEventListener('click', e => { if (!e.target.matches('.tab')) return; document.querySelectorAll('.tab').forEach(t => t.classList.remove('active')); e.target.classList.add('active'); document.querySelectorAll('.view').forEach(v => v.classList.remove('active')); document.getElementById('view-' + e.target.getAttribute('data-tab')).classList.add('active'); });
document.getElementById('monthPrev').addEventListener('click', () => { state.currentMonth = shiftMonth(state.currentMonth, -1); renderAll(); });
document.getElementById('monthNext').addEventListener('click', () => { state.currentMonth = shiftMonth(state.currentMonth, 1); renderAll(); });
document.getElementById('monthToday').addEventListener('click', () => { state.currentMonth = monthKey(new Date()); renderAll(); });
document.getElementById('monthPicker').addEventListener('change', e => { if (e.target.value) { state.currentMonth = e.target.value; renderAll(); } });
document.getElementById('searchInput').addEventListener('input', e => { state.searchQuery = e.target.value; document.getElementById('searchClear').hidden = !state.searchQuery; renderDealsTable(); });
document.getElementById('searchClear').addEventListener('click', () => { state.searchQuery = ''; document.getElementById('searchInput').value = ''; document.getElementById('searchClear').hidden = true; renderDealsTable(); });

document.getElementById('btnOpenStatsTop').addEventListener('click', () => { openModal('modalStats'); });
document.getElementById('btnShowSummary').addEventListener('click', () => { renderSummaryText(); });
document.getElementById('btnOpenConversion').addEventListener('click', () => { openModal('modalConversion'); });
document.getElementById('btnCalcConversion').addEventListener('click', calcConversion);

if (hydrateLocalState()) renderAll();
loadAll();
