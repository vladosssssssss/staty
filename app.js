'use strict';

const BACKEND_URL = window.APP_CONFIG.BACKEND_URL;
const UAH_RATE = window.APP_CONFIG.UAH_RATE;
const LOCAL_STATE_KEY = 'my-stata-state-v1';
const BRON_THRESHOLD_EUR = 150;
let loaderCount = 0;

const state = {
  leads: [], payments: [], payouts: [], settings: [],
  currentMonth: monthKey(new Date()), searchQuery: '',
  activeLeadId: null, editingPayoutId: null, loaded: false
};

function toNum(v) {
  if (typeof v === 'number') return isNaN(v) ? 0 : v;
  return Number(String(v == null ? '' : v).replace(',', '.').replace(/\s+/g, '')) || 0;
}

function showLoader(text) {
  loaderCount++;
  const el = document.getElementById('globalLoader');
  const p = el ? el.querySelector('p') : null;
  if (p) p.textContent = text || 'Збереження даних...';
  if (el) el.classList.add('active');
}

function hideLoader() {
  loaderCount = Math.max(0, loaderCount - 1);
  if (loaderCount === 0) {
    const el = document.getElementById('globalLoader');
    if (el) el.classList.remove('active');
  }
}

function persistState() {
  try {
    localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify({
      leads: state.leads,
      payments: state.payments,
      payouts: state.payouts,
      settings: state.settings
    }));
  } catch (err) {}
}

function hydrateLocalState() {
  try {
    const saved = JSON.parse(localStorage.getItem(LOCAL_STATE_KEY) || 'null');
    if (!saved) return false;
    state.leads = (saved.leads || []).map(normalizeLeadLocal);
    state.payments = (saved.payments || []).map(normalizePaymentLocal);
    state.payouts = (saved.payouts || []).map(normalizePayoutLocal);
    state.settings = saved.settings || [];
    state.loaded = true;
    return true;
  } catch (err) {
    localStorage.removeItem(LOCAL_STATE_KEY);
    return false;
  }
}

function normalizeLeadLocal(l) {
  l.number = toNum(l.number);
  l.price = toNum(l.price);
  l.commissionPercent = toNum(l.commissionPercent);
  l.clientName = l.clientName == null ? '' : String(l.clientName);
  l.nickname = l.nickname == null ? '' : String(l.nickname);
  l.comment = l.comment == null ? '' : String(l.comment);
  l.createdDate = l.createdDate == null ? '' : String(l.createdDate);
  l.month = l.createdDate.substring(0, 7) || String(l.month || '');
  l.cancelled = !!l.cancelled;
  return l;
}

function normalizePaymentLocal(p) {
  p.amount = toNum(p.amount);
  p.date = p.date == null ? '' : String(p.date);
  p.comment = p.comment == null ? '' : String(p.comment);
  p.cancelled = !!p.cancelled;
  return p;
}

function normalizePayoutLocal(p) {
  p.amount = toNum(p.amount);
  p.bonus = toNum(p.bonus);
  p.extraPercent = toNum(p.extraPercent);
  p.extraAmount = toNum(p.extraAmount);
  p.date = p.date == null ? '' : String(p.date);
  p.comment = p.comment == null ? '' : String(p.comment);
  return p;
}

function genId(prefix) { return prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8); }
function monthKey(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
function todayStr() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function shiftMonth(key, delta) { const [y, m] = String(key || '').split('-').map(Number); if (!y || !m) return monthKey(new Date()); return monthKey(new Date(y, m - 1 + delta, 1)); }
function fmtMoney(n, cur) { return toNum(n).toLocaleString('uk-UA', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' ' + (cur || '€'); }
function fmtEUR(n) { return fmtMoney(n, '€'); }
function fmtUAH(n) { return fmtMoney(n, '₴'); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function toast(msg, isError) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' toast--error' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.className = 'toast'; }, 4000);
}

async function api(action, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  let res;
  try {
    res = await fetch(BACKEND_URL, {
      method: 'POST',
      body: JSON.stringify({ action, payload: payload || {} }),
      signal: controller.signal,
      cache: 'no-store',
      redirect: 'follow'
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Таблиця не відповіла за 30 секунд');
    throw err;
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) throw new Error('Помилка сервера: ' + res.status);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'Невідома помилка');
  return json.data;
}

async function loadAll(showFullLoader) {
  if (!state.loaded || showFullLoader) showLoader('Завантаження даних...');
  try {
    const data = await api('getAll');
    state.leads = (data.leads || []).map(normalizeLeadLocal);
    state.payments = (data.payments || []).map(normalizePaymentLocal);
    state.payouts = (data.payouts || []).map(normalizePayoutLocal);
    state.settings = data.settings || [];
    state.loaded = true;
    persistState();
    renderAll();
  } catch (err) {
    if (!state.loaded) {
      state.loaded = true;
      renderAll();
    }
    toast('Помилка завантаження: ' + err.message, true);
  } finally {
    if (!state.loaded || showFullLoader || loaderCount > 0) hideLoader();
  }
}

function getDirections() { const seen = []; state.settings.forEach(s => { if (!seen.includes(s.direction)) seen.push(s.direction); }); return seen; }
function getTariffs(direction) { return state.settings.filter(s => s.direction === direction).sort((a, b) => toNum(a.order) - toNum(b.order)); }
function getSetting(direction, tariff) { return state.settings.find(s => s.direction === direction && s.tariff === tariff); }

function leadById(id) { return state.leads.find(l => l.id === id); }
function leadPayments(leadId) { return state.payments.filter(p => p.leadId === leadId); }

function paymentMonth(p, lead) {
  const m = String(p.date || '').substring(0, 7);
  if (m && m.length === 7) return m;
  return lead ? String(lead.month || '') : '';
}

function actualPaidTotal(leadId) {
  return leadPayments(leadId).filter(p => !p.cancelled).reduce((s, p) => s + toNum(p.amount), 0);
}

function actualPaidInMonth(lead, targetMonth) {
  if (!lead || lead.cancelled) return 0;
  const valid = leadPayments(lead.id).filter(p => !p.cancelled);
  if (!targetMonth) return valid.reduce((s, p) => s + toNum(p.amount), 0);
  return valid
    .filter(p => paymentMonth(p, lead) === targetMonth)
    .reduce((s, p) => s + toNum(p.amount), 0);
}

function leadPaidTotal(lead, targetMonth) {
  if (!lead || lead.cancelled) return 0;
  const price = toNum(lead.price);
  if (lead.status === 'Оплачено повністю (договір)') {
    const m2 = shiftMonth(lead.month, 1);
    if (targetMonth) {
      if (targetMonth === lead.month || targetMonth === m2) return price / 2;
      return 0;
    }
    const currentRealMonth = monthKey(new Date());
    return (currentRealMonth < m2 && state.currentMonth < m2) ? price / 2 : price;
  }
  if (targetMonth) return actualPaidInMonth(lead, targetMonth);
  return actualPaidTotal(lead.id);
}

function leadRemaining(lead, targetMonth) {
  if (!lead || lead.cancelled) return 0;
  const price = toNum(lead.price);
  if (lead.status === 'Оплачено повністю (договір)') {
    const m2 = shiftMonth(lead.month, 1);
    const refMonth = targetMonth || state.currentMonth || monthKey(new Date());
    return (refMonth < m2 && monthKey(new Date()) < m2) ? price / 2 : 0;
  }
  return Math.max(price - actualPaidTotal(lead.id), 0);
}

function leadClientPotential(lead) {
  if (!lead || lead.cancelled) return 0;
  if (lead.status === 'Оплачено повністю (договір)') return 0;
  return leadRemaining(lead);
}

function leadCommissionFact(lead, targetMonth) {
  if (!lead || lead.cancelled) return 0;
  const pct = toNum(lead.commissionPercent) / 100;
  const price = toNum(lead.price);

  if (lead.status === 'Оплачено повністю (договір)') {
    const totalCommission = price * pct;
    const m2 = shiftMonth(lead.month, 1);
    if (targetMonth) {
      if (targetMonth === lead.month || targetMonth === m2) return totalCommission / 2;
      return 0;
    } else {
      const currentRealMonth = monthKey(new Date());
      return (currentRealMonth < m2) ? totalCommission / 2 : totalCommission;
    }
  }
  return leadPaidTotal(lead, targetMonth) * pct;
}

function leadCommissionPotential(lead, targetMonth) {
  if (!lead || lead.cancelled) return 0;
  if (lead.status === 'Оплачено повністю (договір)') return 0;
  if (targetMonth && lead.month !== targetMonth) return 0;
  return leadRemaining(lead) * (toNum(lead.commissionPercent) / 100);
}

function computeStatusByPaidAmount(status, price, paid) {
  if (status === 'Оплачено повністю (договір)') return 'Оплачено повністю (договір)';
  const numPrice = toNum(price);
  const numPaid = toNum(paid);
  if (numPrice > 0 && numPaid >= numPrice) return 'Оплачено повністю';
  if (numPaid >= BRON_THRESHOLD_EUR) return 'Часткова оплата';
  return 'Бронь';
}

function computeLeadStatusFromPaid(lead) {
  return computeStatusByPaidAmount(lead.status, lead.price, actualPaidTotal(lead.id));
}

function leadStatusDisplay(lead) {
  if (lead.cancelled) return 'Скасовано';
  return computeLeadStatusFromPaid(lead);
}

function statusClass(st) {
  if (st === 'Оплачено повністю (договір)') return 'badge--blue';
  if (st === 'Оплачено повністю') return 'badge--green';
  if (st === 'Часткова оплата') return 'badge--amber';
  if (st === 'Скасовано') return 'badge--red';
  return 'badge--muted';
}

function allLeadsCountForMonth(mKey) {
  return state.leads.filter(l => l.month === mKey && !l.cancelled).length;
}

function confirmedInWorkCountForMonth(mKey) {
  return state.leads.filter(l => l.month === mKey && !l.cancelled && leadStatusDisplay(l) !== 'Бронь').length;
}

function computeDashboard() {
  const monthLeads = state.leads.filter(l => l.month === state.currentMonth && !l.cancelled);
  const contractLeadsPrevMonth = state.leads.filter(l => !l.cancelled && l.status === 'Оплачено повністю (договір)' && shiftMonth(l.month, 1) === state.currentMonth);
  const doplataLeadsPrevMonths = state.leads.filter(l => !l.cancelled && l.month !== state.currentMonth && l.status !== 'Оплачено повністю (договір)' && actualPaidInMonth(l, state.currentMonth) > 0);

  const newMoneyLeads = [...monthLeads, ...doplataLeadsPrevMonths];
  const allDashboardLeads = [...monthLeads, ...doplataLeadsPrevMonths, ...contractLeadsPrevMonth];

  const clientPaidFact = allDashboardLeads.reduce((s, l) => s + leadPaidTotal(l, state.currentMonth), 0);
  const clientPotentialMonth = monthLeads.reduce((s, l) => s + leadClientPotential(l), 0);

  const myFact = allDashboardLeads.reduce((s, l) => s + leadCommissionFact(l, state.currentMonth), 0);
  const myFactNewMonth = newMoneyLeads.reduce((s, l) => s + leadCommissionFact(l, state.currentMonth), 0);

  const myPotentialMonth = monthLeads.reduce((s, l) => s + leadCommissionPotential(l, state.currentMonth), 0);
  const myTotalMonth = myFact + myPotentialMonth;

  const activeLeads = state.leads.filter(l => !l.cancelled);
  const clientPaidAllTime = activeLeads.reduce((s, l) => s + leadPaidTotal(l), 0);
  const clientPotentialFull = activeLeads.reduce((s, l) => s + leadClientPotential(l), 0);
  const myFactAllTime = activeLeads.reduce((s, l) => s + leadCommissionFact(l), 0);
  const myPotentialFull = activeLeads.reduce((s, l) => s + leadCommissionPotential(l), 0);

  const expectedPayout = myFactAllTime - state.payouts.reduce((s, p) => s + toNum(p.amount), 0);

  const today = new Date();
  const [selYear, selMonth] = state.currentMonth.split('-').map(Number);
  let daysPassed = 1;
  const daysInMonth = new Date(selYear, selMonth, 0).getDate();

  if (today.getFullYear() === selYear && (today.getMonth() + 1) === selMonth) {
    daysPassed = today.getDate();
  } else if (selYear < today.getFullYear() || (selYear === today.getFullYear() && selMonth < (today.getMonth() + 1))) {
    daysPassed = daysInMonth;
  } else {
    daysPassed = 1;
  }

  const forecastEUR = (myFactNewMonth / daysPassed) * daysInMonth;

  return {
    clientPaidFact, clientPotentialMonth, myFact, myPotentialMonth, myTotalMonth,
    clientPaidAllTime, clientPotentialFull, myFactAllTime, myPotentialFull,
    expectedPayout, forecastEUR
  };
}

function renderAll() {
  renderDashboard();
  renderDealsTable();
  renderPayoutsTable();
  renderSettings();
  populateAddLeadSelectors();
  document.getElementById('monthPicker').value = state.currentMonth;
}

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
    toast('Оберіть дати', true);
    return;
  }

  const fromD = new Date(fromDateStr);
  const toD = new Date(toDateStr);

  const periodLeads = state.leads.filter(l => !l.cancelled && l.createdDate >= fromDateStr && l.createdDate <= toDateStr);

  const carryOverLeads = state.leads.filter(l => {
    if (l.cancelled || l.status !== 'Оплачено повністю (договір)') return false;
    const nextMonthFirstDay = shiftMonth(l.month, 1) + '-01';
    return nextMonthFirstDay >= fromDateStr && nextMonthFirstDay <= toDateStr;
  });

  let myFact = 0;
  let myPotential = 0;
  let contractCount = 0;
  let contractThisMonth = 0;
  let contractNextMonth = 0;
  let carryOverAmount = 0;

  state.payments.forEach(p => {
    if (p.cancelled) return;
    const lead = leadById(p.leadId);
    if (!lead || lead.cancelled || lead.status === 'Оплачено повністю (договір)') return;
    const pDate = String(p.date || lead.createdDate || '');
    if (pDate >= fromDateStr && pDate <= toDateStr) {
      myFact += toNum(p.amount) * (toNum(lead.commissionPercent) / 100);
    }
  });

  periodLeads.forEach(l => {
    if (l.status === 'Оплачено повністю (договір)') {
      contractCount++;
      const totalCommission = toNum(l.price) * (toNum(lead.commissionPercent) / 100);
      myFact += totalCommission / 2;
      contractThisMonth += totalCommission / 2;
      contractNextMonth += totalCommission / 2;
    } else {
      myPotential += leadRemaining(l) * (toNum(l.commissionPercent) / 100);
    }
  });

  carryOverLeads.forEach(l => {
    const totalCommission = toNum(l.price) * (toNum(lead.commissionPercent) / 100);
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
  const tbody = document.getElementById('dealsBody');
  const rawQuery = String(state.searchQuery || '').trim().toLowerCase();

  function rowHtml(lead, monthToPass) {
    const paidInView = leadPaidTotal(lead, monthToPass);
    const totalPaidAll = leadPaidTotal(lead, null);
    const rem = leadRemaining(lead, monthToPass);
    const factEUR = leadCommissionFact(lead, monthToPass);
    const showTotalHint = monthToPass && lead.status !== 'Оплачено повністю (договір)' && Math.abs(totalPaidAll - paidInView) > 0.01;

    return `<tr class="deal-row ${lead.cancelled ? 'row--cancelled' : ''}" data-id="${esc(lead.id)}">
      <td class="mono muted">#${lead.number}</td>
      <td><div class="cell-strong">${esc(lead.clientName || '—')}</div><div class="cell-sub">${esc(lead.nickname || '')}</div></td>
      <td><div class="cell-strong">${esc(lead.direction)}</div><div class="cell-sub">${esc(lead.tariff)}</div></td>
      <td class="mono">${fmtEUR(lead.price)}</td>
      <td class="mono positive">${fmtEUR(paidInView)}${showTotalHint ? `<div style="font-size: 10.5px; color: var(--text-muted); font-weight: normal; margin-top: 3px;">Всього: ${fmtEUR(totalPaidAll)}</div>` : ''}</td>
      <td class="mono ${rem > 0 ? 'negative' : 'muted'}">${fmtEUR(rem)}</td>
      <td class="mono muted">${lead.commissionPercent}%</td>
      <td class="mono accent">${fmtEUR(factEUR)}<div style="font-size: 11px; color: var(--text-muted); font-weight: normal; margin-top: 4px;">${fmtUAH(factEUR * UAH_RATE)}</div></td>
      <td><span class="badge ${statusClass(leadStatusDisplay(lead))}">${esc(leadStatusDisplay(lead))}</span></td>
      <td class="mono muted">${esc(lead.createdDate)}</td><td><button class="btn btn--tiny open-lead">Відкрити</button></td>
    </tr>`;
  }

  if (rawQuery) {
    const cleanQ = rawQuery.replace(/^[@#]+/, '');
    const isExactNumberQuery = rawQuery.startsWith('#') && /^\d+$/.test(cleanQ);

    let list = state.leads.filter(l => {
      const numStr = String(l.number || '');
      if (isExactNumberQuery) return numStr === cleanQ;

      const name = String(l.clientName || '').toLowerCase();
      const nick = String(l.nickname || '').toLowerCase();
      const nickClean = nick.replace(/^@+/, '');
      const dir = String(l.direction || '').toLowerCase();
      const tariff = String(l.tariff || '').toLowerCase();
      const comment = String(l.comment || '').toLowerCase();
      const date = String(l.createdDate || '').toLowerCase();
      const status = String(leadStatusDisplay(l) || '').toLowerCase();

      return (
        name.includes(rawQuery) ||
        nick.includes(rawQuery) ||
        (cleanQ && nickClean.includes(cleanQ)) ||
        numStr.includes(cleanQ || rawQuery) ||
        dir.includes(rawQuery) ||
        tariff.includes(rawQuery) ||
        comment.includes(rawQuery) ||
        date.includes(rawQuery) ||
        status.includes(rawQuery)
      );
    });

    list = list.slice().sort((a, b) => {
      const aNumExact = String(a.number) === cleanQ ? 1 : 0;
      const bNumExact = String(b.number) === cleanQ ? 1 : 0;
      if (aNumExact !== bNumExact) return bNumExact - aNumExact;
      return String(b.createdDate || '').localeCompare(String(a.createdDate || '')) || toNum(b.number) - toNum(a.number);
    });

    if (list.length === 0) { tbody.innerHTML = `<tr><td colspan="11" class="empty-row">Нічого не знайдено</td></tr>`; return; }
    tbody.innerHTML = list.map(l => rowHtml(l, null)).join('');
    return;
  }

  const thisMonth = state.leads
    .filter(l => l.month === state.currentMonth)
    .sort((a, b) => String(b.createdDate || '').localeCompare(String(a.createdDate || '')) || toNum(b.number) - toNum(a.number));

  const prevMonthExtra = state.leads
    .filter(l => {
      if (l.month === state.currentMonth) return false;
      const isContractCarry = l.status === 'Оплачено повністю (договір)' && shiftMonth(l.month, 1) === state.currentMonth;
      const isDoplataInMonth = l.status !== 'Оплачено повністю (договір)' && actualPaidInMonth(l, state.currentMonth) > 0;
      return isContractCarry || isDoplataInMonth;
    })
    .sort((a, b) => String(b.createdDate || '').localeCompare(String(a.createdDate || '')) || toNum(b.number) - toNum(a.number));

  if (thisMonth.length === 0 && prevMonthExtra.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11" class="empty-row">У цьому місяці ще немає лідів</td></tr>`;
    return;
  }

  let html = thisMonth.map(l => rowHtml(l, state.currentMonth)).join('');
  if (prevMonthExtra.length > 0) {
    html += `<tr><td colspan="11" style="text-align:center; background:var(--surface-3); color:var(--text-muted); font-size:11px; text-transform:uppercase; letter-spacing:0.5px; padding:10px;">↑ Нові ліди цього місяця &nbsp;|&nbsp; ↓ Перенесені договори та доплати з минулих місяців</td></tr>`;
    html += prevMonthExtra.map(l => rowHtml(l, state.currentMonth)).join('');
  }
  tbody.innerHTML = html;
}

function renderPayoutsTable() {
  const tbody = document.getElementById('payoutsBody');
  const list = state.payouts.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  if (list.length === 0) { tbody.innerHTML = `<tr><td colspan="7" class="empty-row">Виплат ще не було</td></tr>`; return; }
  tbody.innerHTML = list.map(p => {
    const baseUAH = Math.round(toNum(p.amount) * UAH_RATE * 100) / 100;
    const bonusUAH = toNum(p.bonus);
    const extraPct = toNum(p.extraPercent);
    const extraUAH = toNum(p.extraAmount);
    const totalUAH = baseUAH + bonusUAH + extraUAH;
    const totalEUR = totalUAH / UAH_RATE;

    let extraHtml = '—';
    if (extraUAH > 0 || extraPct > 0) {
      extraHtml = `${extraUAH > 0 ? '+ ' + fmtUAH(extraUAH) : ''}${extraPct > 0 ? `<div style="font-size: 11px; color: var(--text-muted); margin-top: 3px;">Доп. ${extraPct}%</div>` : ''}`;
    }

    return `
    <tr data-id="${esc(p.id)}">
      <td class="mono muted">${esc(p.date)}</td>
      <td class="mono positive">
        ${fmtUAH(baseUAH)}
        <div style="font-size: 10.5px; color: var(--text-muted); margin-top: 4px;">≈ ${fmtEUR(p.amount)}</div>
      </td>
      <td class="mono accent">${bonusUAH > 0 ? '+ ' + fmtUAH(bonusUAH) : '—'}</td>
      <td class="mono accent">${extraHtml}</td>
      <td class="mono" style="font-weight:700; color:var(--text);">
        ${fmtUAH(totalUAH)}
        <div style="font-size: 10.5px; color: var(--text-muted); font-weight: 400; margin-top: 4px;">≈ ${fmtEUR(totalEUR)}</div>
      </td>
      <td style="text-align:left;">${esc(p.comment)}</td>
      <td>
        <div style="display:flex; gap:6px; justify-content:center;">
          <button class="btn btn--tiny edit-payout">Редагувати</button>
          <button class="btn btn--tiny btn--danger del-payout">Видалити</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function renderSettings() {
  const wrap = document.getElementById('settingsGroups');
  const ae = document.activeElement;
  if (ae && wrap.contains(ae) && ae.matches('input, select, textarea')) return;
  wrap.innerHTML = getDirections().map(dir => `<div class="settings-group"><h3>${esc(dir)}</h3><table class="settings-table">
    <thead><tr><th>Тариф</th><th>Ціна 1</th><th>Ціна 2</th><th>Ціна 3</th><th>Комісія</th><th></th></tr></thead><tbody>${getTariffs(dir).map(s => `
    <tr data-direction="${esc(dir)}" data-tariff="${esc(s.tariff)}"><td class="cell-strong" style="text-align:left;">${esc(s.tariff)}</td>
    <td data-label="Ціна 1"><input type="number" class="s-price1" value="${s.price1}"></td><td data-label="Ціна 2"><input type="number" class="s-price2" value="${s.price2}"></td>
    <td data-label="Ціна 3"><input type="number" class="s-price3" value="${s.price3}"></td><td data-label="Комісія"><span class="pct-field"><input type="number" class="s-percent" value="${s.percent}"> %</span></td>
    <td><button class="btn btn--tiny btn--primary save-settings-row">Зберегти</button></td></tr>`).join('')}</tbody></table></div>`).join('');
}

function populateAddLeadSelectors() {
  const dirSel = document.getElementById('fDirection');
  dirSel.innerHTML = getDirections().map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
  populateTariffSelector(dirSel.value);
}

function populateTariffSelector(direction) {
  const tSel = document.getElementById('fTariff');
  tSel.innerHTML = getTariffs(direction).map(t => `<option value="${esc(t.tariff)}">${esc(t.tariff)} · ${t.percent}%</option>`).join('');
  populatePriceOptions(direction, tSel.value);
}

function populatePriceOptions(direction, tariff) {
  const wrap = document.getElementById('fPriceOptions');
  const s = getSetting(direction, tariff);
  if (!s) { wrap.innerHTML = ''; return; }
  const opts = [
    { label: 'Без знижки', value: s.price1 },
    { label: 'Знижка 1', value: s.price2 },
    { label: 'Знижка 2 / діагностика', value: s.price3 }
  ];
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
  const paymentsCount = toNum(document.getElementById('cvPaymentsCount').value);
  const knownPercent = toNum(document.getElementById('cvConversionPercent').value);
  const confirmedCount = toNum(document.getElementById('cvConfirmedCount').value);

  if (paymentsCount <= 0) { toast('Вкажи кількість оплат', true); return; }
  if (knownPercent <= 0) { toast('Вкажи відому конверсію, %', true); return; }

  const totalPool = paymentsCount / (knownPercent / 100);
  const confirmedPercent = totalPool > 0 ? (confirmedCount / totalPool) * 100 : 0;

  document.getElementById('cvResultPercent').textContent = confirmedPercent.toFixed(2) + '%';
  document.getElementById('cvResultPool').textContent = 'Орієнтовний загальний потік («двері»): ' + Math.round(totalPool) + ' ос.';
  document.getElementById('cvResultBox').style.display = 'block';
}

function closeModal(id) { document.getElementById(id).classList.remove('open'); }
document.addEventListener('click', e => {
  if (e.target.matches('[data-close-modal]')) closeModal(e.target.getAttribute('data-close-modal'));
  if (e.target.classList.contains('modal-overlay')) e.target.classList.remove('open');
});

document.getElementById('btnAddLead').addEventListener('click', () => {
  ['fClientName', 'fNickname', 'fComment', 'fCustomPrice'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('fStatus').value = 'Бронь';
  document.getElementById('fFirstPayment').value = '0';
  document.getElementById('fDate').value = todayStr();
  document.getElementById('fCustomPriceToggle').checked = false;
  document.getElementById('fCustomPrice').hidden = true;
  populateAddLeadSelectors();
  openModal('modalAddLead');
});

document.getElementById('fDirection').addEventListener('change', e => populateTariffSelector(e.target.value));
document.getElementById('fTariff').addEventListener('change', () => populatePriceOptions(document.getElementById('fDirection').value, document.getElementById('fTariff').value));
document.getElementById('fCustomPriceToggle').addEventListener('change', e => document.getElementById('fCustomPrice').hidden = !e.target.checked);

function getSelectedAddLeadPrice() {
  const direction = document.getElementById('fDirection').value;
  const tariff = document.getElementById('fTariff').value;
  const s = getSetting(direction, tariff);
  let price = s ? toNum(s.price1) : 0;
  if (document.getElementById('fCustomPriceToggle').checked) {
    price = toNum(document.getElementById('fCustomPrice').value);
  } else {
    const checked = document.querySelector('input[name="fPriceOpt"]:checked');
    if (checked) price = toNum(checked.value);
  }
  return price;
}

document.getElementById('fStatus').addEventListener('change', e => {
  const st = e.target.value;
  if (st === 'Оплачено повністю') {
    document.getElementById('fFirstPayment').value = String(getSelectedAddLeadPrice());
  } else if (st === 'Бронь' || st === 'Оплачено повністю (договір)') {
    document.getElementById('fFirstPayment').value = '0';
  }
});

document.getElementById('btnSaveLead').addEventListener('click', async () => {
  const clientName = document.getElementById('fClientName').value.trim();
  const nickname = document.getElementById('fNickname').value.trim();
  const direction = document.getElementById('fDirection').value;
  const tariff = document.getElementById('fTariff').value;
  const s = getSetting(direction, tariff);
  if (!clientName) { toast('Вкажи ім’я клієнта', true); return; }

  const price = getSelectedAddLeadPrice();
  const rawStatus = document.getElementById('fStatus').value;
  let firstPayment = toNum(document.getElementById('fFirstPayment').value);
  if (rawStatus === 'Оплачено повністю' && firstPayment <= 0 && price > 0) {
    firstPayment = price;
  }
  if (rawStatus === 'Оплачено повністю (договір)') {
    firstPayment = 0;
  }

  const finalStatus = computeStatusByPaidAmount(rawStatus, price, firstPayment);
  const date = document.getElementById('fDate').value || todayStr();
  const comment = document.getElementById('fComment').value.trim();
  const leadId = genId('local');
  const paymentId = firstPayment > 0 ? genId('local-pay') : null;
  const commissionPercent = toNum(s ? s.percent : 0);

  showLoader('Збереження в таблицю...');
  try {
    const res = await api('addLead', {
      id: leadId,
      clientName,
      nickname,
      direction,
      tariff,
      price,
      commissionPercent,
      status: finalStatus,
      comment,
      createdDate: date,
      firstPayment,
      paymentId
    });

    if (firstPayment > 0 && (!res || !res.paymentCreated)) {
      await api('addPayment', {
        id: paymentId,
        leadId,
        amount: firstPayment,
        date,
        comment: 'Перший платіж'
      });
    }

    const assignedNumber = (res && res.number) ? toNum(res.number) : (Math.max(0, ...state.leads.map(l => toNum(l.number))) + 1);
    const confirmedLead = normalizeLeadLocal({
      id: leadId,
      number: assignedNumber,
      clientName,
      nickname,
      direction,
      tariff,
      price,
      commissionPercent,
      status: finalStatus,
      comment,
      createdDate: date,
      month: date.substring(0, 7),
      cancelled: false
    });

    state.leads.push(confirmedLead);
    if (firstPayment > 0) {
      state.payments.push(normalizePaymentLocal({
        id: paymentId,
        leadId,
        amount: firstPayment,
        date,
        comment: 'Перший платіж',
        cancelled: false
      }));
    }

    state.currentMonth = date.substring(0, 7);
    persistState();
    renderAll();
    closeModal('modalAddLead');
    toast('Успішно збережено!');
  } catch (err) {
    toast('Не вдалося зберегти: ' + err.message, true);
  } finally {
    hideLoader();
  }
});

document.getElementById('dealsBody').addEventListener('click', e => {
  if (e.target.classList.contains('open-lead')) openLeadDetail(e.target.closest('tr').getAttribute('data-id'));
});

function openLeadDetail(id) {
  const lead = leadById(id);
  if (!lead) return;
  state.activeLeadId = id;
  document.getElementById('ldTitle').textContent = `#${lead.number} · ${lead.clientName}${lead.nickname ? ' (' + lead.nickname + ')' : ''}`;
  document.getElementById('ldClientName').value = lead.clientName || '';
  document.getElementById('ldNickname').value = lead.nickname || '';
  document.getElementById('ldPrice').value = lead.price;
  document.getElementById('ldCommissionPercent').value = lead.commissionPercent;
  document.getElementById('ldStatus').value = lead.status === 'Оплачено повністю (договір)' ? 'Оплачено повністю (договір)' : computeLeadStatusFromPaid(lead);
  document.getElementById('ldComment').value = lead.comment || '';
  document.getElementById('ldCancelled').checked = !!lead.cancelled;
  renderLeadDetailSummary(lead);
  renderLeadPayments(lead);
  openModal('modalLead');
}

function renderLeadDetailSummary(lead) {
  const factEUR = leadCommissionFact(lead);
  const fullCommissionEUR = toNum(lead.price) * (toNum(lead.commissionPercent) / 100);
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
  const tbody = document.getElementById('ldPaymentsBody');
  const list = leadPayments(lead.id).slice().sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  if (list.length === 0) { tbody.innerHTML = `<tr><td colspan="5" class="empty-row">Платежів ще немає</td></tr>`; return; }
  tbody.innerHTML = list.map((p, i) => `<tr class="${p.cancelled ? 'row--cancelled' : ''}" data-id="${esc(p.id)}"><td class="mono muted">${esc(p.date)}</td><td class="mono ${p.cancelled ? 'muted' : 'positive'}">${fmtEUR(p.amount)}</td><td style="text-align:left;">${esc(p.comment || ('Платіж ' + (i + 1)))}</td><td><span class="badge ${p.cancelled ? 'badge--red' : 'badge--green'}">${p.cancelled ? 'Скасовано' : 'Зараховано'}</span></td><td><div style="display:flex;gap:6px;justify-content:center;"><button class="btn btn--tiny toggle-payment">${p.cancelled ? 'Відновити' : 'Скасувати'}</button><button class="btn btn--tiny btn--danger delete-payment" title="Видалити повністю" style="padding:4px 8px;font-size:14px;line-height:1;">✕</button></div></td></tr>`).join('');
}

document.getElementById('btnSaveLeadEdit').addEventListener('click', async () => {
  const id = state.activeLeadId;
  const lead = leadById(id);
  if (!lead) return;

  const newPrice = toNum(document.getElementById('ldPrice').value);
  const newCommissionPercent = toNum(document.getElementById('ldCommissionPercent').value);
  const selectedStatus = document.getElementById('ldStatus').value;
  const currentPaid = actualPaidTotal(lead.id);

  let autoPayment = null;
  let finalStatus = selectedStatus;

  if (selectedStatus === 'Оплачено повністю') {
    const diff = newPrice - currentPaid;
    if (diff > 0) {
      autoPayment = {
        id: genId('local-pay'),
        leadId: lead.id,
        amount: diff,
        date: todayStr(),
        comment: 'Доплата (повна оплата)',
        cancelled: false
      };
    }
    finalStatus = 'Оплачено повністю';
  } else if (selectedStatus !== 'Оплачено повністю (договір)') {
    finalStatus = computeStatusByPaidAmount(selectedStatus, newPrice, currentPaid);
  }

  const payload = {
    id,
    clientName: document.getElementById('ldClientName').value.trim(),
    nickname: document.getElementById('ldNickname').value.trim(),
    price: newPrice,
    commissionPercent: newCommissionPercent,
    status: finalStatus,
    comment: document.getElementById('ldComment').value.trim(),
    cancelled: document.getElementById('ldCancelled').checked
  };

  showLoader('Збереження в таблицю...');
  try {
    await api('updateLead', payload);
    if (autoPayment) {
      await api('addPayment', {
        id: autoPayment.id,
        leadId: autoPayment.leadId,
        amount: autoPayment.amount,
        date: autoPayment.date,
        comment: autoPayment.comment
      });
    }

    Object.assign(lead, payload);
    normalizeLeadLocal(lead);
    if (autoPayment) {
      state.payments.push(normalizePaymentLocal(autoPayment));
    }

    persistState();
    renderAll();
    if (document.getElementById('modalLead').classList.contains('open')) {
      openLeadDetail(id);
    }
    toast('Успішно збережено!');
  } catch (err) {
    toast('Не вдалося зберегти: ' + err.message, true);
  } finally {
    hideLoader();
  }
});

document.getElementById('btnDeleteLead').addEventListener('click', async () => {
  const id = state.activeLeadId;
  if (!confirm('Видалити цей лід і всі його платежі назавжди?')) return;

  showLoader('Видалення з таблиці...');
  try {
    await api('deleteLead', { id });
    state.leads = state.leads.filter(l => l.id !== id);
    state.payments = state.payments.filter(p => p.leadId !== id);
    persistState();
    renderAll();
    closeModal('modalLead');
    toast('Успішно видалено!');
  } catch (err) {
    toast('Не вдалося видалити: ' + err.message, true);
  } finally {
    hideLoader();
  }
});

document.getElementById('ldPaymentsBody').addEventListener('click', async e => {
  const row = e.target.closest('tr');
  if (!row) return;
  const id = row.getAttribute('data-id');
  const lead = leadById(state.activeLeadId);
  if (!lead) return;

  if (e.target.classList.contains('toggle-payment')) {
    const payment = state.payments.find(p => p.id === id);
    if (!payment) return;
    const nextCancelled = !payment.cancelled;
    const newPaid = leadPayments(lead.id)
      .filter(p => (p.id === id ? !nextCancelled : !p.cancelled))
      .reduce((s, p) => s + toNum(p.amount), 0);
    const nextStatus = computeStatusByPaidAmount(lead.status, lead.price, newPaid);

    showLoader('Збереження в таблицю...');
    try {
      const res = await api('updatePayment', {
        id,
        cancelled: nextCancelled,
        leadId: lead.id,
        leadStatus: nextStatus
      });
      if (lead.status !== nextStatus && (!res || !res.leadStatusUpdated)) {
        await api('updateLead', { id: lead.id, status: nextStatus });
      }

      payment.cancelled = nextCancelled;
      lead.status = nextStatus;
      persistState();
      renderAll();
      if (document.getElementById('modalLead').classList.contains('open')) {
        openLeadDetail(lead.id);
      }
      toast('Успішно збережено!');
    } catch (err) {
      toast('Не вдалося зберегти: ' + err.message, true);
    } finally {
      hideLoader();
    }
  }

  if (e.target.classList.contains('delete-payment')) {
    if (!confirm('Видалити цей платіж назавжди?')) return;
    const newPaid = leadPayments(lead.id)
      .filter(p => p.id !== id && !p.cancelled)
      .reduce((s, p) => s + toNum(p.amount), 0);
    const nextStatus = computeStatusByPaidAmount(lead.status, lead.price, newPaid);

    showLoader('Видалення з таблиці...');
    try {
      const res = await api('deletePayment', {
        id,
        leadId: lead.id,
        leadStatus: nextStatus
      });
      if (lead.status !== nextStatus && (!res || !res.leadStatusUpdated)) {
        await api('updateLead', { id: lead.id, status: nextStatus });
      }

      state.payments = state.payments.filter(p => p.id !== id);
      lead.status = nextStatus;
      persistState();
      renderAll();
      if (document.getElementById('modalLead').classList.contains('open')) {
        openLeadDetail(lead.id);
      }
      toast('Успішно видалено!');
    } catch (err) {
      toast('Не вдалося видалити: ' + err.message, true);
    } finally {
      hideLoader();
    }
  }
});

document.getElementById('btnAddPayment').addEventListener('click', () => {
  const lead = leadById(state.activeLeadId);
  const rem = lead ? leadRemaining(lead) : 0;
  document.getElementById('pAmount').value = rem > 0 ? String(rem) : '';
  document.getElementById('pDate').value = todayStr();
  const count = leadPayments(state.activeLeadId).length + 1;
  const names = ['Перший', 'Другий', 'Третій', 'Четвертий', 'П’ятий', 'Шостий', 'Сьомий', 'Восьмий', 'Дев’ятий', 'Десятий'];
  document.getElementById('pComment').value = count === 1 ? 'Перший платіж' : (count <= 10 ? `${names[count - 1]} платіж (доплата)` : `${count}-й платіж (доплата)`);
  openModal('modalAddPayment');
});

document.getElementById('btnSavePayment').addEventListener('click', async () => {
  const amount = toNum(document.getElementById('pAmount').value);
  const date = document.getElementById('pDate').value || todayStr();
  const comment = document.getElementById('pComment').value.trim();
  if (amount <= 0) { toast('Вкажи суму', true); return; }

  const lead = leadById(state.activeLeadId);
  if (!lead) return;

  const paymentId = genId('local-pay');
  const newPaid = actualPaidTotal(lead.id) + amount;
  const nextStatus = computeStatusByPaidAmount(lead.status, lead.price, newPaid);

  showLoader('Збереження оплати в таблицю...');
  try {
    const res = await api('addPayment', {
      id: paymentId,
      leadId: lead.id,
      amount,
      date,
      comment,
      leadStatus: nextStatus
    });

    if (lead.status !== nextStatus && (!res || !res.leadStatusUpdated)) {
      await api('updateLead', { id: lead.id, status: nextStatus });
    }

    state.payments.push(normalizePaymentLocal({
      id: paymentId,
      leadId: lead.id,
      amount,
      date,
      comment,
      cancelled: false
    }));
    lead.status = nextStatus;

    persistState();
    renderAll();
    closeModal('modalAddPayment');
    if (document.getElementById('modalLead').classList.contains('open')) {
      openLeadDetail(lead.id);
    }
    toast('Успішно збережено!');
  } catch (err) {
    toast('Не вдалося зберегти оплату: ' + err.message, true);
  } finally {
    hideLoader();
  }
});

function updatePayoutTotalPreview() {
  const baseUAH = toNum(document.getElementById('oAmountUAH').value);
  const bonusUAH = toNum(document.getElementById('oBonusUAH').value);
  const extraUAH = toNum(document.getElementById('oExtraAmountUAH').value);
  const total = baseUAH + bonusUAH + extraUAH;
  const totalEUR = total / UAH_RATE;
  const el = document.getElementById('oTotalPreview');
  if (el) {
    el.innerHTML = `${fmtUAH(total)} <span style="font-size: 11px; color: var(--text-muted); font-weight: 400;">(≈ ${fmtEUR(totalEUR)})</span>`;
  }
}

['oAmountUAH', 'oBonusUAH', 'oExtraPercent', 'oExtraAmountUAH'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', updatePayoutTotalPreview);
});

document.getElementById('btnAddPayout').addEventListener('click', () => {
  state.editingPayoutId = null;
  document.getElementById('payoutModalTitle').textContent = 'Нова виплата ЗП';
  document.getElementById('oAmountUAH').value = '';
  document.getElementById('oBonusUAH').value = '0';
  document.getElementById('oExtraPercent').value = '0';
  document.getElementById('oExtraAmountUAH').value = '0';
  document.getElementById('oDate').value = todayStr();
  document.getElementById('oComment').value = '';
  updatePayoutTotalPreview();
  openModal('modalAddPayout');
});

function openEditPayout(id) {
  const p = state.payouts.find(x => x.id === id);
  if (!p) return;
  state.editingPayoutId = id;
  document.getElementById('payoutModalTitle').textContent = 'Редагувати виплату ЗП';
  const baseUAH = Math.round(toNum(p.amount) * UAH_RATE * 100) / 100;
  document.getElementById('oAmountUAH').value = baseUAH > 0 ? String(baseUAH) : '0';
  document.getElementById('oBonusUAH').value = String(toNum(p.bonus));
  document.getElementById('oExtraPercent').value = String(toNum(p.extraPercent));
  document.getElementById('oExtraAmountUAH').value = String(toNum(p.extraAmount));
  document.getElementById('oDate').value = p.date || todayStr();
  document.getElementById('oComment').value = p.comment || '';
  updatePayoutTotalPreview();
  openModal('modalAddPayout');
}

document.getElementById('btnSavePayout').addEventListener('click', async () => {
  const amountUAH = toNum(document.getElementById('oAmountUAH').value);
  const bonusUAH = toNum(document.getElementById('oBonusUAH').value);
  const extraPercent = toNum(document.getElementById('oExtraPercent').value);
  const extraAmountUAH = toNum(document.getElementById('oExtraAmountUAH').value);
  const date = document.getElementById('oDate').value || todayStr();
  const comment = document.getElementById('oComment').value.trim();

  if (amountUAH <= 0 && bonusUAH <= 0 && extraAmountUAH <= 0) {
    toast('Вкажи суму ЗП, бонус або суму доп. %', true);
    return;
  }

  const amountEUR = amountUAH / UAH_RATE;

  showLoader('Збереження в таблицю...');
  try {
    if (state.editingPayoutId) {
      const payload = {
        id: state.editingPayoutId,
        amount: amountEUR,
        bonus: bonusUAH,
        extraPercent,
        extraAmount: extraAmountUAH,
        date,
        comment
      };
      await api('updatePayout', payload);
      const target = state.payouts.find(x => x.id === state.editingPayoutId);
      if (target) {
        Object.assign(target, payload);
        normalizePayoutLocal(target);
      }
    } else {
      const payoutId = genId('local-out');
      const payload = {
        id: payoutId,
        amount: amountEUR,
        bonus: bonusUAH,
        extraPercent,
        extraAmount: extraAmountUAH,
        date,
        comment
      };
      await api('addPayout', payload);
      state.payouts.push(normalizePayoutLocal(payload));
    }

    state.editingPayoutId = null;
    persistState();
    renderAll();
    closeModal('modalAddPayout');
    toast('Успішно збережено!');
  } catch (err) {
    toast('Не вдалося зберегти виплату: ' + err.message, true);
  } finally {
    hideLoader();
  }
});

document.getElementById('payoutsBody').addEventListener('click', async e => {
  const row = e.target.closest('tr');
  if (!row) return;
  const id = row.getAttribute('data-id');

  if (e.target.classList.contains('edit-payout')) {
    openEditPayout(id);
    return;
  }

  if (e.target.classList.contains('del-payout')) {
    if (!confirm('Видалити цю виплату?')) return;
    showLoader('Видалення з таблиці...');
    try {
      await api('deletePayout', { id });
      state.payouts = state.payouts.filter(p => p.id !== id);
      persistState();
      renderAll();
      toast('Успішно видалено!');
    } catch (err) {
      toast('Не вдалося видалити: ' + err.message, true);
    } finally {
      hideLoader();
    }
  }
});

document.getElementById('settingsGroups').addEventListener('click', async e => {
  if (!e.target.classList.contains('save-settings-row')) return;
  const row = e.target.closest('tr');
  const payload = {
    direction: row.getAttribute('data-direction'),
    tariff: row.getAttribute('data-tariff'),
    price1: toNum(row.querySelector('.s-price1').value),
    price2: toNum(row.querySelector('.s-price2').value),
    price3: toNum(row.querySelector('.s-price3').value),
    percent: toNum(row.querySelector('.s-percent').value)
  };

  showLoader('Збереження в таблицю...');
  try {
    await api('updateSettings', payload);
    const setting = getSetting(payload.direction, payload.tariff);
    if (setting) Object.assign(setting, payload);
    persistState();
    renderAll();
    toast('Успішно збережено!');
  } catch (err) {
    toast('Не вдалося зберегти: ' + err.message, true);
  } finally {
    hideLoader();
  }
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
    const sorted = [...state.leads].sort((a, b) => String(a.createdDate || '').localeCompare(String(b.createdDate || '')));
    document.getElementById('mdFromDate').value = sorted[0].createdDate;
    document.getElementById('mdToDate').value = todayStr();
  }
});

document.getElementById('tabs').addEventListener('click', e => {
  if (!e.target.matches('.tab')) return;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  e.target.classList.add('active');
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + e.target.getAttribute('data-tab')).classList.add('active');
});

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
loadAll(false);