import * as db from './db.js';
import {
  CONTRACT, toNum, round2, monthKey, shiftMonth, todayStr, parseDateStr, isValidDateStr,
  computeStatusByPaidAmount, normalizeLead, normalizePayment, normalizePayout, normalizeSetting,
  createCalc, calcConversion, statusClass
} from './calc.js';

const CFG = window.APP_CONFIG;
const OWNER = String(CFG.OWNER_EMAIL || '').toLowerCase();
const $ = id => document.getElementById(id);

const state = {
  user: null,
  leads: [], payments: [], payouts: [], settings: [], meta: {},
  loaded: { leads: false, payments: false, payouts: false, settings: false, meta: false },
  currentMonth: monthKey(new Date()), searchQuery: '',
  activeLeadId: null, editingPayoutId: null, editingPaymentId: null,
  draft: {}, unsub: null, online: navigator.onLine, fromCache: false
};

let calcCache = null;
let loaderCount = 0;
let renderQueued = false;

/* ============================ утиліти ============================ */

const rate = () => toNum(state.meta.app && state.meta.app.uahRate) || toNum(CFG.UAH_RATE) || 1;
const calc = () => (calcCache || (calcCache = createCalc(state, new Date())));
const invalidate = () => { calcCache = null; scheduleRender(); };

function genId(prefix) {
  const rnd = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(36).slice(2, 10));
  return prefix + '-' + rnd;
}
function fmtMoney(n, cur) { return toNum(n).toLocaleString('uk-UA', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' ' + (cur || '€'); }
const fmtEUR = n => fmtMoney(n, '€');
const fmtUAH = n => fmtMoney(n, '₴');
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function toast(msg, isError) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' toast--error' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.className = 'toast'; }, 5000);
}

function showLoader(text) {
  loaderCount++;
  const el = $('globalLoader');
  const p = el.querySelector('p');
  if (p) p.textContent = text || 'Збереження даних...';
  el.classList.add('active');
}
function hideLoader() {
  loaderCount = Math.max(0, loaderCount - 1);
  if (loaderCount === 0) $('globalLoader').classList.remove('active');
}

function humanError(err) {
  const code = err && err.code ? String(err.code) : '';
  if (code.includes('permission-denied')) return 'Немає доступу. Увійдіть під акаунтом власника.';
  if (code.includes('unavailable') || code === 'timeout') return 'Немає зв’язку з сервером. Перевірте інтернет і повторіть.';
  if (code.includes('unauthenticated')) return 'Сесія завершилась. Увійдіть знову.';
  return (err && err.message) ? err.message : 'Невідома помилка';
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { const e = new Error('Сервер не підтвердив запис за ' + (ms / 1000) + ' с. Запис збережено локально і синхронізується, коли з’явиться зв’язок.'); e.code = 'timeout'; reject(e); }, ms);
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

// Захист від подвійного натискання + єдина обробка помилок
async function guarded(btn, loaderText, fn, okMsg) {
  if (btn && btn.disabled) return false;
  if (!navigator.onLine) { toast('Немає інтернету — зміни не збережено.', true); return false; }
  if (btn) btn.disabled = true;
  showLoader(loaderText);
  try {
    await withTimeout(fn(), 25000);
    if (okMsg) toast(okMsg);
    return true;
  } catch (err) {
    console.error(err);
    toast(humanError(err), true);
    return false;
  } finally {
    hideLoader();
    if (btn) btn.disabled = false;
  }
}

function numField(id) { return toNum($(id).value); }
function dateField(id) { const v = $(id).value; return isValidDateStr(v) ? v : todayStr(); }

/* ============================ допоміжні вибірки ============================ */

const DIRECTION_ORDER = ['Швидкий старт з блогу', 'Продажі 24/7', 'Big Money', 'Офлайн робота'];
const getDirections = () => {
  const seen = [];
  state.settings.forEach(s => { if (!seen.includes(s.direction)) seen.push(s.direction); });
  const rank = d => { const i = DIRECTION_ORDER.indexOf(d); return i === -1 ? DIRECTION_ORDER.length : i; };
  return seen.map((d, i) => [d, i]).sort((x, y) => rank(x[0]) - rank(y[0]) || x[1] - y[1]).map(x => x[0]);
};
const getTariffs = direction => state.settings.filter(s => s.direction === direction).sort((a, b) => toNum(a.order) - toNum(b.order));
const getSetting = (direction, tariff) => state.settings.find(s => s.direction === direction && s.tariff === tariff);
const leadById = id => state.leads.find(l => l.id === id);
const leadPayments = id => state.payments.filter(p => p.leadId === id);
const maxLeadNumber = () => Math.max(0, ...state.leads.map(l => toNum(l.number)), toNum(state.meta.counters && state.meta.counters.lastLeadNumber));

/* ============================ рендер ============================ */

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderAll(); });
}

function renderAll() {
  if (!state.user) return;
  renderDashboard();
  renderDealsTable();
  renderPayoutsTable();
  renderSettings();
  populateAddLeadSelectors();
  $('monthPicker').value = state.currentMonth;
  const rateInput = $('sRate');
  if (document.activeElement !== rateInput) rateInput.value = rate();
  if ($('modalLead').classList.contains('open')) refreshLeadModal();
  if ($('modalStats').classList.contains('open')) renderStatsFigures();
  renderSync();
}

function renderSync() {
  const dot = $('syncDot');
  const ok = state.online && !state.fromCache;
  dot.className = 'sync-dot ' + (ok ? 'sync-dot--ok' : 'sync-dot--bad');
  dot.title = ok ? 'З’єднано, дані синхронізуються' : 'Немає з’єднання — показано збережені дані';
}

function renderDashboard() {
  const d = calc().dashboard(state.currentMonth, new Date());
  const R = rate();
  const set = (id, v) => { $(id).textContent = v; };
  set('figMyFact', fmtEUR(d.myFact)); set('figMyFactUAH', fmtUAH(d.myFact * R));
  $('figMyPotential').innerHTML = `${fmtEUR(d.myPotentialMonth)} <span style="color:var(--text-dim)">/</span> ${fmtEUR(d.myPotentialFull)}`;
  $('figMyPotentialUAH').innerHTML = `${fmtUAH(d.myPotentialMonth * R)} <span style="color:var(--text-dim)">/</span> ${fmtUAH(d.myPotentialFull * R)}`;
  set('figMyTotalMonth', fmtEUR(d.myTotalMonth)); set('figMyTotalMonthUAH', fmtUAH(d.myTotalMonth * R));
  set('figForecast', fmtEUR(d.forecastEUR)); set('figForecastUAH', fmtUAH(d.forecastEUR * R));
  set('figOwed', fmtEUR(d.expectedPayout)); set('figOwedUAH', fmtUAH(d.expectedPayout * R));
  renderStatsFigures(d);
}

function renderStatsFigures(dIn) {
  const d = dIn || calc().dashboard(state.currentMonth, new Date());
  const R = rate();
  const pair = (id, eur) => { $(id + '_EUR').textContent = fmtEUR(eur); $(id + '_UAH').textContent = fmtUAH(eur * R); };
  $('mdWaitMonth').textContent = fmtEUR(d.myPotentialMonth); $('mdWaitMonthUAH').textContent = fmtUAH(d.myPotentialMonth * R);
  $('mdWaitAll').textContent = fmtEUR(d.myPotentialFull); $('mdWaitAllUAH').textContent = fmtUAH(d.myPotentialFull * R);
  pair('mdClientPaidMonth', d.clientPaidFact); pair('mdClientDebtMonth', d.clientPotentialMonth);
  pair('mdMyFactMonth', d.myFact); pair('mdMyDebtMonth', d.myPotentialMonth);
  pair('mdClientPaidAll', d.clientPaidAllTime); pair('mdClientDebtAll', d.clientPotentialFull);
  pair('mdMyFactAll', d.myFactAllTime); pair('mdMyDebtAll', d.myPotentialFull);
}

function dealRowHtml(lead, monthToPass) {
  const c = calc();
  const R = rate();
  const paidInView = c.leadPaidTotal(lead, monthToPass);
  const totalPaidAll = c.leadPaidTotal(lead, null);
  const rem = c.leadRemaining(lead, monthToPass);
  const factEUR = c.leadCommissionFact(lead, monthToPass);
  const st = c.leadStatusDisplay(lead);
  const showTotalHint = monthToPass && lead.status !== CONTRACT && Math.abs(totalPaidAll - paidInView) > 0.01;
  return `<tr class="deal-row ${lead.cancelled ? 'row--cancelled' : ''}" data-id="${esc(lead.id)}">
      <td class="mono muted">#${esc(lead.number)}</td>
      <td><div class="cell-strong">${esc(lead.clientName || '—')}</div><div class="cell-sub">${esc(lead.nickname || '')}</div></td>
      <td><div class="cell-strong">${esc(lead.direction)}</div><div class="cell-sub">${esc(lead.tariff)}</div></td>
      <td class="mono">${fmtEUR(lead.price)}</td>
      <td class="mono positive">${fmtEUR(paidInView)}${showTotalHint ? `<div style="font-size: 10.5px; color: var(--text-muted); font-weight: normal; margin-top: 3px;">Всього: ${fmtEUR(totalPaidAll)}</div>` : ''}</td>
      <td class="mono ${rem > 0 ? 'negative' : 'muted'}">${fmtEUR(rem)}</td>
      <td class="mono muted">${esc(lead.commissionPercent)}%</td>
      <td class="mono accent">${fmtEUR(factEUR)}<div style="font-size: 11px; color: var(--text-muted); font-weight: normal; margin-top: 4px;">${fmtUAH(factEUR * R)}</div></td>
      <td><span class="badge ${statusClass(st)}">${esc(st)}</span></td>
      <td class="mono muted">${esc(lead.createdDate)}</td><td><button class="btn btn--tiny open-lead">Відкрити</button></td>
    </tr>`;
}

function renderDealsTable() {
  const tbody = $('dealsBody');
  if (!allLoaded()) { tbody.innerHTML = `<tr><td colspan="11" class="empty-row">Завантаження…</td></tr>`; return; }
  const q = String(state.searchQuery || '').trim();
  if (q) {
    const list = calc().searchLeads(q);
    tbody.innerHTML = list.length ? list.map(l => dealRowHtml(l, null)).join('') : `<tr><td colspan="11" class="empty-row">Нічого не знайдено</td></tr>`;
    return;
  }
  const { thisMonth, extra } = calc().monthRows(state.currentMonth);
  if (!thisMonth.length && !extra.length) {
    tbody.innerHTML = `<tr><td colspan="11" class="empty-row">У цьому місяці ще немає лідів</td></tr>`;
    return;
  }
  let html = thisMonth.map(l => dealRowHtml(l, state.currentMonth)).join('');
  if (extra.length) {
    html += `<tr><td colspan="11" style="text-align:center; background:var(--surface-3); color:var(--text-muted); font-size:11px; text-transform:uppercase; letter-spacing:0.5px; padding:10px;">↑ Нові ліди цього місяця &nbsp;|&nbsp; ↓ Перенесені договори та доплати з минулих місяців</td></tr>`;
    html += extra.map(l => dealRowHtml(l, state.currentMonth)).join('');
  }
  tbody.innerHTML = html;
}

function renderPayoutsTable() {
  const tbody = $('payoutsBody');
  if (!allLoaded()) { tbody.innerHTML = `<tr><td colspan="7" class="empty-row">Завантаження…</td></tr>`; return; }
  const list = state.payouts.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  if (!list.length) { tbody.innerHTML = `<tr><td colspan="7" class="empty-row">Виплат ще не було</td></tr>`; return; }
  tbody.innerHTML = list.map(p => {
    const baseUAH = toNum(p.amountUAH);
    const bonusUAH = toNum(p.bonus);
    const extraPct = toNum(p.extraPercent);
    const extraUAH = toNum(p.extraAmount);
    const totalUAH = baseUAH + bonusUAH + extraUAH;
    const totalEUR = totalUAH / (toNum(p.rate) || rate());
    let extraHtml = '—';
    if (extraUAH > 0 || extraPct > 0) {
      extraHtml = `${extraUAH > 0 ? '+ ' + fmtUAH(extraUAH) : ''}${extraPct > 0 ? `<div style="font-size: 11px; color: var(--text-muted); margin-top: 3px;">Доп. ${esc(extraPct)}%</div>` : ''}`;
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
  const wrap = $('settingsGroups');
  const ae = document.activeElement;
  if (ae && wrap.contains(ae) && ae.matches('input, select, textarea')) return; // не збиваємо введення
  if (!allLoaded()) { wrap.innerHTML = ''; return; }
  const dirs = getDirections();
  if (!dirs.length) { wrap.innerHTML = `<div class="empty-row">Тарифів ще немає.</div>`; return; }
  wrap.innerHTML = dirs.map(dir => `<div class="settings-group"><h3>${esc(dir)}</h3><table class="settings-table">
    <thead><tr><th>Тариф</th><th>Ціна 1</th><th>Ціна 2</th><th>Ціна 3</th><th>Комісія</th><th></th></tr></thead><tbody>${getTariffs(dir).map(s => `
    <tr data-direction="${esc(dir)}" data-tariff="${esc(s.tariff)}"><td class="cell-strong" style="text-align:left;">${esc(s.tariff)}</td>
    <td data-label="Ціна 1"><input type="number" min="0" step="0.01" class="s-price1" value="${esc(s.price1)}"></td><td data-label="Ціна 2"><input type="number" min="0" step="0.01" class="s-price2" value="${esc(s.price2)}"></td>
    <td data-label="Ціна 3"><input type="number" min="0" step="0.01" class="s-price3" value="${esc(s.price3)}"></td><td data-label="Комісія"><span class="pct-field"><input type="number" min="0" max="100" step="0.1" class="s-percent" value="${esc(s.percent)}"> %</span></td>
    <td><div style="display:flex;gap:6px;justify-content:center;"><button class="btn btn--tiny btn--primary save-settings-row">Зберегти</button></div></td></tr>`).join('')}</tbody></table></div>`).join('');
}

function populateAddLeadSelectors() {
  if ($('modalAddLead').classList.contains('open')) return; // не скидаємо вибір, поки форма відкрита
  const dirSel = $('fDirection');
  const prev = dirSel.value;
  const dirs = getDirections();
  dirSel.innerHTML = dirs.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
  if (dirs.includes(prev)) dirSel.value = prev;
  populateTariffSelector(dirSel.value);
}

function populateTariffSelector(direction, keepTariff) {
  const tSel = $('fTariff');
  const prev = keepTariff || tSel.value;
  const list = getTariffs(direction);
  tSel.innerHTML = list.map(t => `<option value="${esc(t.tariff)}">${esc(t.tariff)} · ${esc(t.percent)}%</option>`).join('');
  if (list.some(t => t.tariff === prev)) tSel.value = prev;
  populatePriceOptions(direction, tSel.value);
}

function populatePriceOptions(direction, tariff) {
  const wrap = $('fPriceOptions');
  const s = getSetting(direction, tariff);
  if (!s) { wrap.innerHTML = ''; return; }
  const opts = [
    { label: 'Без знижки', value: s.price1 },
    { label: 'Знижка 1', value: s.price2 },
    { label: 'Знижка 2 / діагностика', value: s.price3 }
  ];
  wrap.innerHTML = opts.map((o, i) => `<label class="price-opt"><input type="radio" name="fPriceOpt" value="${esc(o.value)}" ${i === 0 ? 'checked' : ''}><span class="price-opt__label">${o.label}</span><span class="price-opt__dash">—</span><span class="price-opt__value mono">${fmtEUR(o.value)}</span></label>`).join('');
}

const allLoaded = () => Object.values(state.loaded).every(Boolean);

/* ============================ модальні вікна ============================ */

function openModal(id) {
  $(id).classList.add('open');
  if (id === 'modalStats') { $('mdTabMonth').click(); renderStatsFigures(); }
  if (id === 'modalConversion') {
    const c = calc();
    $('cvPaymentsCount').value = c.allLeadsCountForMonth(state.currentMonth);
    $('cvConversionPercent').value = '';
    $('cvConfirmedCount').value = c.confirmedInWorkCountForMonth(state.currentMonth);
    $('cvResultBox').style.display = 'none';
  }
}
function closeModal(id) { $(id).classList.remove('open'); }

let downOnOverlay = false;
document.addEventListener('mousedown', e => { downOnOverlay = e.target.classList && e.target.classList.contains('modal-overlay'); });
document.addEventListener('click', e => {
  if (e.target.matches('[data-close-modal]')) closeModal(e.target.getAttribute('data-close-modal'));
  else if (downOnOverlay && e.target.classList.contains('modal-overlay')) e.target.classList.remove('open');
  downOnOverlay = false;
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const open = [...document.querySelectorAll('.modal-overlay.open')];
  if (open.length) open[open.length - 1].classList.remove('open');
});

/* ============================ нові ліди ============================ */

$('btnAddLead').addEventListener('click', () => {
  if (!getDirections().length) { toast('Спочатку додайте тарифи у вкладці «Тарифи та ціни».', true); return; }
  ['fClientName', 'fNickname', 'fComment', 'fCustomPrice'].forEach(id => { $(id).value = ''; });
  $('fStatus').value = 'Бронь';
  $('fFirstPayment').value = '0';
  $('fDate').value = todayStr();
  $('fCustomPriceToggle').checked = false;
  $('fCustomPrice').hidden = true;
  state.draft.leadId = genId('lead');
  state.draft.leadPaymentId = genId('pay');
  $('fDirection').value = '';
  populateAddLeadSelectors();
  $('fDirection').selectedIndex = 0;
  populateTariffSelector($('fDirection').value);
  openModal('modalAddLead');
});

$('fDirection').addEventListener('change', e => populateTariffSelector(e.target.value));
$('fTariff').addEventListener('change', () => populatePriceOptions($('fDirection').value, $('fTariff').value));
$('fCustomPriceToggle').addEventListener('change', e => { $('fCustomPrice').hidden = !e.target.checked; });

function getSelectedAddLeadPrice() {
  const s = getSetting($('fDirection').value, $('fTariff').value);
  let price = s ? toNum(s.price1) : 0;
  if ($('fCustomPriceToggle').checked) price = numField('fCustomPrice');
  else {
    const checked = document.querySelector('input[name="fPriceOpt"]:checked');
    if (checked) price = toNum(checked.value);
  }
  return price;
}

$('fStatus').addEventListener('change', e => {
  const st = e.target.value;
  if (st === 'Оплачено повністю') $('fFirstPayment').value = String(getSelectedAddLeadPrice());
  else if (st === 'Бронь' || st === CONTRACT) $('fFirstPayment').value = '0';
});

$('btnSaveLead').addEventListener('click', async e => {
  const btn = e.currentTarget;
  const clientName = $('fClientName').value.trim();
  const nickname = $('fNickname').value.trim();
  const direction = $('fDirection').value;
  const tariff = $('fTariff').value;
  const s = getSetting(direction, tariff);
  if (!clientName) { toast('Вкажи ім’я клієнта', true); return; }
  if (!s) { toast('Оберіть напрямок і тариф', true); return; }

  const price = getSelectedAddLeadPrice();
  if (!(price > 0)) { toast('Вкажи ціну тарифу більше нуля', true); return; }
  const rawStatus = $('fStatus').value;
  let firstPayment = numField('fFirstPayment');
  if (firstPayment < 0) { toast('Сума платежу не може бути від’ємною', true); return; }
  if (rawStatus === 'Оплачено повністю' && firstPayment <= 0) firstPayment = price;
  if (rawStatus === CONTRACT) firstPayment = 0;
  if (firstPayment > price && !confirm(`Перший платіж (${fmtEUR(firstPayment)}) більший за ціну тарифу (${fmtEUR(price)}). Продовжити?`)) return;

  const date = isValidDateStr($('fDate').value) ? $('fDate').value : todayStr();
  const leadId = state.draft.leadId || genId('lead');
  const paymentId = state.draft.leadPaymentId || genId('pay');
  const lead = {
    id: leadId, clientName, nickname, direction, tariff, price,
    commissionPercent: toNum(s.percent),
    status: computeStatusByPaidAmount(rawStatus, price, firstPayment),
    comment: $('fComment').value.trim(), createdDate: date, month: date.substring(0, 7), cancelled: false
  };
  const payment = firstPayment > 0 ? { id: paymentId, leadId, amount: round2(firstPayment), date, comment: 'Перший платіж', cancelled: false } : null;

  const ok = await guarded(btn, 'Збереження...', () => db.addLead({ lead, payment, localMaxNumber: maxLeadNumber() }), 'Лід збережено');
  if (ok) {
    state.draft.leadId = null; state.draft.leadPaymentId = null;
    state.currentMonth = date.substring(0, 7);
    closeModal('modalAddLead');
    invalidate();
  }
});

/* ============================ картка ліда ============================ */

$('dealsBody').addEventListener('click', e => {
  if (e.target.classList.contains('open-lead')) openLeadDetail(e.target.closest('tr').getAttribute('data-id'));
});

function openLeadDetail(id) {
  const lead = leadById(id);
  if (!lead) return;
  state.activeLeadId = id;
  $('ldClientName').value = lead.clientName || '';
  $('ldNickname').value = lead.nickname || '';
  $('ldPrice').value = lead.price;
  $('ldCommissionPercent').value = lead.commissionPercent;
  $('ldStatus').value = lead.status === CONTRACT ? CONTRACT : computeStatusByPaidAmount(lead.status, lead.price, calc().actualPaidTotal(lead.id));
  $('ldComment').value = lead.comment || '';
  $('ldCancelled').checked = !!lead.cancelled;
  refreshLeadModal();
  openModal('modalLead');
}

// Оновлює лише розрахункові блоки (не чіпає поля, які користувач зараз редагує)
function refreshLeadModal() {
  const lead = leadById(state.activeLeadId);
  if (!lead) { closeModal('modalLead'); closeModal('modalAddPayment'); return; }
  $('ldTitle').textContent = `#${lead.number} · ${lead.clientName}${lead.nickname ? ' (' + lead.nickname + ')' : ''}`;
  renderLeadDetailSummary(lead);
  renderLeadPayments(lead);
}

function renderLeadDetailSummary(lead) {
  const c = calc();
  const R = rate();
  const factEUR = c.leadCommissionFact(lead);
  const fullCommissionEUR = toNum(lead.price) * (toNum(lead.commissionPercent) / 100);
  const paid = c.leadPaidTotal(lead);
  const tariffHTML = `<div style="font-weight:400; color:var(--text-muted); font-family:var(--font-body); line-height:1.3; text-align:center; white-space:normal; width:100%; word-break:break-word;">${esc(lead.direction)}<br><span style="color:var(--text); font-weight:700;">${esc(lead.tariff)}</span> <span style="font-size: 10px; color: var(--gold);">(${esc(lead.commissionPercent)}%)</span></div>`;
  $('ldSummary').innerHTML = `
    <div class="mini-fig"><span>Тариф</span>${tariffHTML}</div>
    <div class="mini-fig"><span>Ціна</span>
      <b class="mono">${fmtEUR(lead.price)}
        <div style="font-size: 10.5px; color: var(--text-muted); font-weight: 500; margin-top: 4px;">Мої: <span style="color:var(--gold)">${fmtEUR(fullCommissionEUR)}</span> = <span style="color:var(--gold)">${fmtUAH(fullCommissionEUR * R)}</span></div>
      </b></div>
    <div class="mini-fig"><span>Сплачено</span>
      <b class="mono positive">${fmtEUR(paid)}
        <div style="font-size: 10.5px; color: var(--text-muted); font-weight: 500; margin-top: 4px;">Факт: <span style="color:var(--gold)">${fmtEUR(factEUR)}</span> = <span style="color:var(--gold)">${fmtUAH(factEUR * R)}</span></div>
      </b></div>
    <div class="mini-fig"><span>Залишок</span><b class="mono negative">${fmtEUR(c.leadRemaining(lead))}</b></div>`;
}

function renderLeadPayments(lead) {
  const tbody = $('ldPaymentsBody');
  const list = leadPayments(lead.id).slice().sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  if (!list.length) { tbody.innerHTML = `<tr><td colspan="5" class="empty-row">Платежів ще немає</td></tr>`; return; }
  tbody.innerHTML = list.map((p, i) => `<tr class="${p.cancelled ? 'row--cancelled' : ''}" data-id="${esc(p.id)}"><td class="mono muted">${esc(p.date)}</td><td class="mono ${p.cancelled ? 'muted' : 'positive'}">${fmtEUR(p.amount)}</td><td style="text-align:left;">${esc(p.comment || ('Платіж ' + (i + 1)))}</td><td><span class="badge ${p.cancelled ? 'badge--red' : 'badge--green'}">${p.cancelled ? 'Скасовано' : 'Зараховано'}</span></td><td><div style="display:flex;gap:6px;justify-content:center;"><button class="btn btn--tiny edit-payment">Ред.</button><button class="btn btn--tiny toggle-payment">${p.cancelled ? 'Відновити' : 'Скасувати'}</button><button class="btn btn--tiny btn--danger delete-payment" title="Видалити повністю" style="padding:4px 8px;font-size:14px;line-height:1;">✕</button></div></td></tr>`).join('');
}

$('btnSaveLeadEdit').addEventListener('click', async e => {
  const btn = e.currentTarget;
  const id = state.activeLeadId;
  const lead = leadById(id);
  if (!lead) return;

  const clientName = $('ldClientName').value.trim();
  if (!clientName) { toast('Вкажи ім’я клієнта', true); return; }
  const newPrice = numField('ldPrice');
  const pct = numField('ldCommissionPercent');
  if (newPrice < 0) { toast('Ціна не може бути від’ємною', true); return; }
  if (pct < 0 || pct > 100) { toast('Комісія має бути від 0 до 100 %', true); return; }

  const selectedStatus = $('ldStatus').value;
  const currentPaid = calc().actualPaidTotal(lead.id);
  let payment = null;
  let finalStatus = selectedStatus;

  if (selectedStatus === 'Оплачено повністю') {
    const diff = round2(newPrice - currentPaid);
    if (diff > 0) payment = { id: genId('pay'), leadId: lead.id, amount: diff, date: todayStr(), comment: 'Доплата (повна оплата)', cancelled: false };
    finalStatus = 'Оплачено повністю';
  } else if (selectedStatus !== CONTRACT) {
    finalStatus = computeStatusByPaidAmount(selectedStatus, newPrice, currentPaid);
  }

  const fields = {
    clientName, nickname: $('ldNickname').value.trim(), price: newPrice, commissionPercent: pct,
    status: finalStatus, comment: $('ldComment').value.trim(), cancelled: $('ldCancelled').checked
  };
  await guarded(btn, 'Збереження...', () => db.saveLead({ id, fields, payment }), 'Зміни збережено');
});

$('btnDeleteLead').addEventListener('click', async e => {
  const btn = e.currentTarget;
  const lead = leadById(state.activeLeadId);
  if (!lead) return;
  const n = leadPayments(lead.id).length;
  if (!confirm(`Видалити лід #${lead.number} (${lead.clientName}) і всі його платежі (${n}) назавжди?`)) return;
  const ok = await guarded(btn, 'Видалення...', () => db.deleteLead(lead.id), 'Лід видалено');
  if (ok) { closeModal('modalLead'); state.activeLeadId = null; invalidate(); }
});

/* ============================ платежі ============================ */

function paidAfter(leadId, { excludeId, addAmount, cancelledOverride } = {}) {
  return leadPayments(leadId).reduce((s, p) => {
    if (p.id === excludeId) return s;
    const cancelled = (cancelledOverride && cancelledOverride.id === p.id) ? cancelledOverride.value : p.cancelled;
    return cancelled ? s : s + toNum(p.amount);
  }, 0) + (addAmount || 0);
}

$('ldPaymentsBody').addEventListener('click', async e => {
  const row = e.target.closest('tr');
  if (!row) return;
  const id = row.getAttribute('data-id');
  const lead = leadById(state.activeLeadId);
  const payment = state.payments.find(p => p.id === id);
  if (!lead || !payment) return;

  if (e.target.classList.contains('edit-payment')) {
    state.editingPaymentId = id;
    $('paymentModalTitle').textContent = 'Редагувати платіж';
    $('btnSavePayment').textContent = 'Зберегти';
    $('pAmount').value = payment.amount;
    $('pDate').value = payment.date || todayStr();
    $('pComment').value = payment.comment || '';
    openModal('modalAddPayment');
    return;
  }

  if (e.target.classList.contains('toggle-payment')) {
    const nextCancelled = !payment.cancelled;
    const newPaid = paidAfter(lead.id, { cancelledOverride: { id, value: nextCancelled } });
    const nextStatus = computeStatusByPaidAmount(lead.status, lead.price, newPaid);
    await guarded(e.target, 'Збереження...', () => db.savePayment({
      payment: { id, cancelled: nextCancelled }, isNew: false, leadId: lead.id, leadStatus: nextStatus
    }), nextCancelled ? 'Платіж скасовано' : 'Платіж відновлено');
    return;
  }

  if (e.target.classList.contains('delete-payment')) {
    if (!confirm(`Видалити платіж ${fmtEUR(payment.amount)} від ${payment.date} назавжди?`)) return;
    const nextStatus = computeStatusByPaidAmount(lead.status, lead.price, paidAfter(lead.id, { excludeId: id }));
    await guarded(e.target, 'Видалення...', () => db.deletePayment({ id, leadId: lead.id, leadStatus: nextStatus }), 'Платіж видалено');
  }
});

$('btnAddPayment').addEventListener('click', () => {
  const lead = leadById(state.activeLeadId);
  if (!lead) return;
  state.editingPaymentId = null;
  state.draft.paymentId = genId('pay');
  $('paymentModalTitle').textContent = 'Новий платіж';
  $('btnSavePayment').textContent = 'Додати';
  const rem = calc().leadRemaining(lead);
  $('pAmount').value = rem > 0 ? String(round2(rem)) : '';
  $('pDate').value = todayStr();
  const count = leadPayments(lead.id).length + 1;
  const names = ['Перший', 'Другий', 'Третій', 'Четвертий', 'П’ятий', 'Шостий', 'Сьомий', 'Восьмий', 'Дев’ятий', 'Десятий'];
  $('pComment').value = count === 1 ? 'Перший платіж' : (count <= 10 ? `${names[count - 1]} платіж (доплата)` : `${count}-й платіж (доплата)`);
  openModal('modalAddPayment');
});

$('btnSavePayment').addEventListener('click', async e => {
  const btn = e.currentTarget;
  const amount = round2(numField('pAmount'));
  const date = isValidDateStr($('pDate').value) ? $('pDate').value : todayStr();
  const comment = $('pComment').value.trim();
  if (!(amount > 0)) { toast('Вкажи суму більше нуля', true); return; }
  const lead = leadById(state.activeLeadId);
  if (!lead) return;

  const editing = state.editingPaymentId ? state.payments.find(p => p.id === state.editingPaymentId) : null;
  const base = paidAfter(lead.id, { excludeId: editing ? editing.id : null });
  const keepsActive = !(editing && editing.cancelled);
  const newPaid = base + (keepsActive ? amount : 0);
  if (lead.status !== CONTRACT && keepsActive && newPaid > toNum(lead.price) + 0.005 &&
      !confirm(`Загальна сума платежів (${fmtEUR(newPaid)}) перевищить ціну тарифу (${fmtEUR(lead.price)}). Продовжити?`)) return;
  const nextStatus = computeStatusByPaidAmount(lead.status, lead.price, newPaid);

  if (editing) {
    const ok = await guarded(btn, 'Збереження...', () => db.savePayment({
      payment: { id: editing.id, amount, date, comment }, isNew: false, leadId: lead.id, leadStatus: nextStatus
    }), 'Платіж оновлено');
    if (ok) { state.editingPaymentId = null; closeModal('modalAddPayment'); }
  } else {
    const id = state.draft.paymentId || genId('pay');
    const ok = await guarded(btn, 'Збереження оплати...', () => db.savePayment({
      payment: { id, leadId: lead.id, amount, date, comment, cancelled: false }, isNew: true, leadId: lead.id, leadStatus: nextStatus
    }), 'Платіж додано');
    if (ok) { state.draft.paymentId = null; closeModal('modalAddPayment'); }
  }
});

/* ============================ виплати ЗП ============================ */

function updatePayoutTotalPreview() {
  const total = numField('oAmountUAH') + numField('oBonusUAH') + numField('oExtraAmountUAH');
  $('oTotalPreview').innerHTML = `${fmtUAH(total)} <span style="font-size: 11px; color: var(--text-muted); font-weight: 400;">(≈ ${fmtEUR(total / rate())})</span>`;
}
['oAmountUAH', 'oBonusUAH', 'oExtraPercent', 'oExtraAmountUAH'].forEach(id => $(id).addEventListener('input', updatePayoutTotalPreview));

$('btnAddPayout').addEventListener('click', () => {
  state.editingPayoutId = null;
  state.draft.payoutId = genId('out');
  $('payoutModalTitle').textContent = 'Нова виплата ЗП';
  $('oAmountUAH').value = '';
  $('oBonusUAH').value = '0';
  $('oExtraPercent').value = '0';
  $('oExtraAmountUAH').value = '0';
  $('oDate').value = todayStr();
  $('oComment').value = '';
  updatePayoutTotalPreview();
  openModal('modalAddPayout');
});

function openEditPayout(id) {
  const p = state.payouts.find(x => x.id === id);
  if (!p) return;
  state.editingPayoutId = id;
  $('payoutModalTitle').textContent = 'Редагувати виплату ЗП';
  $('oAmountUAH').value = String(toNum(p.amountUAH));
  $('oBonusUAH').value = String(toNum(p.bonus));
  $('oExtraPercent').value = String(toNum(p.extraPercent));
  $('oExtraAmountUAH').value = String(toNum(p.extraAmount));
  $('oDate').value = p.date || todayStr();
  $('oComment').value = p.comment || '';
  updatePayoutTotalPreview();
  openModal('modalAddPayout');
}

$('btnSavePayout').addEventListener('click', async e => {
  const btn = e.currentTarget;
  const amountUAH = round2(numField('oAmountUAH'));
  const bonus = round2(numField('oBonusUAH'));
  const extraPercent = numField('oExtraPercent');
  const extraAmount = round2(numField('oExtraAmountUAH'));
  const date = isValidDateStr($('oDate').value) ? $('oDate').value : todayStr();
  const comment = $('oComment').value.trim();

  if (amountUAH < 0 || bonus < 0 || extraAmount < 0 || extraPercent < 0) { toast('Суми не можуть бути від’ємними', true); return; }
  if (amountUAH <= 0 && bonus <= 0 && extraAmount <= 0) { toast('Вкажи суму ЗП, бонус або суму доп. %', true); return; }

  const editing = state.editingPayoutId ? state.payouts.find(x => x.id === state.editingPayoutId) : null;
  let usedRate = rate();
  let amountEUR = Math.round((amountUAH / usedRate) * 1e6) / 1e6;
  if (editing && round2(editing.amountUAH) === amountUAH) { usedRate = toNum(editing.rate) || usedRate; amountEUR = editing.amount; } // сума ₴ не змінилась — не перераховуємо за новим курсом

  const payout = {
    id: editing ? editing.id : (state.draft.payoutId || genId('out')),
    date, amount: amountEUR, amountUAH, rate: usedRate, comment, bonus, extraPercent, extraAmount
  };
  const ok = await guarded(btn, 'Збереження...', () => db.savePayout({ payout, isNew: !editing }), 'Виплату збережено');
  if (ok) { state.editingPayoutId = null; state.draft.payoutId = null; closeModal('modalAddPayout'); }
});

$('payoutsBody').addEventListener('click', async e => {
  const row = e.target.closest('tr');
  if (!row) return;
  const id = row.getAttribute('data-id');
  if (e.target.classList.contains('edit-payout')) { openEditPayout(id); return; }
  if (e.target.classList.contains('del-payout')) {
    const p = state.payouts.find(x => x.id === id);
    if (!p || !confirm(`Видалити виплату від ${p.date} (${fmtUAH(p.amountUAH)})?`)) return;
    await guarded(e.target, 'Видалення...', () => db.deletePayout(id), 'Виплату видалено');
  }
});

/* ============================ тарифи / курс / бекап ============================ */

$('settingsGroups').addEventListener('click', async e => {
  const row = e.target.closest('tr');
  if (!row) return;
  const direction = row.getAttribute('data-direction');
  const tariff = row.getAttribute('data-tariff');

  if (e.target.classList.contains('save-settings-row')) {
    const cur = getSetting(direction, tariff);
    const price1 = numField2(row, '.s-price1'), price2 = numField2(row, '.s-price2'), price3 = numField2(row, '.s-price3'), percent = numField2(row, '.s-percent');
    if ([price1, price2, price3, percent].some(v => v < 0) || percent > 100) { toast('Перевір значення: ціни ≥ 0, комісія 0–100 %', true); return; }
    document.activeElement && document.activeElement.blur();
    await guarded(e.target, 'Збереження...', () => db.saveSetting({ direction, tariff, price1, price2, price3, percent, order: cur ? cur.order : 99 }), 'Тариф збережено');
    return;
  }
});
function numField2(row, sel) { return toNum(row.querySelector(sel).value); }

$('btnSaveRate').addEventListener('click', async e => {
  const v = numField('sRate');
  if (!(v > 0) || v > 1000) { toast('Вкажіть коректний курс (більше 0)', true); return; }
  await guarded(e.currentTarget, 'Збереження...', () => db.saveRate(v), 'Курс збережено');
});



function stripSystem(o) { const c = { ...o }; delete c._row; delete c.updatedAt; delete c.createdAt; return c; }

function validateImport(d) {
  const errs = [];
  if (!d || typeof d !== 'object') return ['невірний формат'];
  if (!Array.isArray(d.leads)) return ['немає списку leads'];
  if (!Array.isArray(d.payments)) return ['немає списку payments'];
  const ids = new Set(d.leads.map(l => l && l.id));
  d.leads.forEach((l, i) => {
    if (!l || !l.id || typeof l.id !== 'string' || l.id.includes('/')) errs.push(`лід №${i + 1}: некоректний id`);
    else if (!isValidDateStr(String(l.createdDate || '').substring(0, 10))) errs.push(`лід ${l.id}: некоректна дата`);
  });
  d.payments.forEach((p, i) => {
    if (!p || !p.id || typeof p.id !== 'string' || p.id.includes('/')) errs.push(`платіж №${i + 1}: некоректний id`);
    else if (!(toNum(p.amount) > 0)) errs.push(`платіж ${p.id}: сума має бути більше 0`);
    else if (!ids.has(p.leadId) && !state.leads.some(l => l.id === p.leadId)) errs.push(`платіж ${p.id}: лід ${p.leadId} не знайдено`);
  });
  (d.payouts || []).forEach((p, i) => { if (!p || !p.id || typeof p.id !== 'string' || p.id.includes('/')) errs.push(`виплата №${i + 1}: некоректний id`); });
  return errs;
}

/* ============================ статистика та зріз ============================ */

$('mdTabMonth').addEventListener('click', () => {
  $('mdTabMonth').classList.add('active'); $('mdTabAll').classList.remove('active');
  $('mdViewMonth').style.display = 'block'; $('mdViewAll').style.display = 'none';
  $('summaryTextBox').style.display = 'none';
  const [y, m] = state.currentMonth.split('-').map(Number);
  $('mdFromDate').value = `${y}-${String(m).padStart(2, '0')}-01`;
  let endD = new Date(y, m, 0).getDate();
  const today = new Date();
  if (today.getFullYear() === y && (today.getMonth() + 1) === m) endD = today.getDate();
  $('mdToDate').value = `${y}-${String(m).padStart(2, '0')}-${String(endD).padStart(2, '0')}`;
});

$('mdTabAll').addEventListener('click', () => {
  $('mdTabAll').classList.add('active'); $('mdTabMonth').classList.remove('active');
  $('mdViewAll').style.display = 'block'; $('mdViewMonth').style.display = 'none';
  $('summaryTextBox').style.display = 'none';
  if (state.leads.length) {
    const first = state.leads.map(l => l.createdDate).filter(Boolean).sort()[0];
    $('mdFromDate').value = first;
    $('mdToDate').value = todayStr();
  }
});

function formatDateDayMonth(d) {
  const m = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'][d.getMonth()];
  return `${d.getDate()} ${m}`;
}

function renderSummaryText() {
  const from = $('mdFromDate').value;
  const to = $('mdToDate').value;
  if (!from || !to) { toast('Оберіть дати', true); return; }
  if (from > to) { toast('Дата «з» не може бути пізніше за дату «по»', true); return; }
  const R = rate();
  const r = calc().periodSummary(from, to);
  const both = v => `<b>${fmtEUR(v)} = ${fmtUAH(v * R)}</b>`;

  let text = `З ${formatDateDayMonth(parseDateStr(from))} по ${formatDateDayMonth(parseDateStr(to))} ти фактично заробив ${both(r.myFact)}, а потенційно очікуєш з боргів ще ${both(r.myPotential)}.<br><br>`;
  if (r.carryOverAmount > 0) text += `(У твій фактичний заробіток також увійшло ${both(r.carryOverAmount)} з договорів минулого місяця).<br><br>`;
  if (r.contractCount > 0) {
    text += `При цьому <b>${r.contractCount}</b> клієнт(ів) підписали договір у цей період. `;
    if (r.contractNextMonth > 0) {
      text += `Це означає, що ${both(r.contractThisMonth)} пішло у факт зараз, а ${both(r.contractNextMonth)} гарантовано перейде на наступний місяць.<br><br>`;
      text += `По факту ти заробив сумарно ${both(r.grossTotal)}, але з них ${both(r.contractNextMonth)} увійшло в наступний місяць. Тому твій чистий заробіток саме за цей період становить ${both(r.pureTotal)}.`;
    } else {
      text += `Обидві половини їхніх виплат (${both(r.contractThisMonth * 2)}) потрапили в цей період.<br><br>По факту твій чистий сумарний дохід (факт + борги) за цей період становить ${both(r.pureTotal)}.`;
    }
  } else {
    text += `По факту твій чистий сумарний дохід (факт + борги) за цей період становить ${both(r.pureTotal)}.`;
  }
  const box = $('summaryTextBox');
  box.innerHTML = text;
  box.style.display = 'block';
}

$('btnShowSummary').addEventListener('click', renderSummaryText);
$('btnOpenStatsTop').addEventListener('click', () => openModal('modalStats'));
$('btnOpenConversion').addEventListener('click', () => openModal('modalConversion'));
$('btnCalcConversion').addEventListener('click', () => {
  const paymentsCount = numField('cvPaymentsCount');
  const knownPercent = numField('cvConversionPercent');
  const confirmedCount = numField('cvConfirmedCount');
  if (paymentsCount <= 0) { toast('Вкажи кількість оплат', true); return; }
  if (knownPercent <= 0) { toast('Вкажи відому конверсію, %', true); return; }
  const r = calcConversion(paymentsCount, knownPercent, confirmedCount);
  $('cvResultPercent').textContent = r.confirmedPercent.toFixed(2) + '%';
  $('cvResultPool').textContent = 'Орієнтовний загальний потік («двері»): ' + Math.round(r.totalPool) + ' ос.';
  $('cvResultBox').style.display = 'block';
});

/* ============================ навігація ============================ */

$('tabs').addEventListener('click', e => {
  if (!e.target.matches('.tab')) return;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  e.target.classList.add('active');
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $('view-' + e.target.getAttribute('data-tab')).classList.add('active');
});
$('monthPrev').addEventListener('click', () => { state.currentMonth = shiftMonth(state.currentMonth, -1); renderAll(); });
$('monthNext').addEventListener('click', () => { state.currentMonth = shiftMonth(state.currentMonth, 1); renderAll(); });
$('monthToday').addEventListener('click', () => { state.currentMonth = monthKey(new Date()); renderAll(); });
$('monthPicker').addEventListener('change', e => { if (e.target.value) { state.currentMonth = e.target.value; renderAll(); } });
$('searchInput').addEventListener('input', e => { state.searchQuery = e.target.value; $('searchClear').hidden = !state.searchQuery; renderDealsTable(); });
$('searchClear').addEventListener('click', () => { state.searchQuery = ''; $('searchInput').value = ''; $('searchClear').hidden = true; renderDealsTable(); });

window.addEventListener('online', () => { state.online = true; renderSync(); });
window.addEventListener('offline', () => { state.online = false; renderSync(); });

/* ============================ вхід і підписка на дані ============================ */

function showLogin(msg, isError) {
  $('appContainer').hidden = true;
  $('loginScreen').hidden = false;
  const err = $('loginError');
  err.hidden = !msg;
  err.textContent = msg || '';
  err.className = 'login-error' + (isError ? '' : ' login-error--info');
}

function startSession(user) {
  state.user = user;
  $('userEmail').textContent = user.email || '';
  $('loginScreen').hidden = true;
  $('appContainer').hidden = false;
  showLoader('Завантаження даних...');
  const done = key => (docs, meta) => {
    if (key === 'meta') {
      state.meta = {};
      docs.forEach(d => { state.meta[d.id] = d; });
    } else if (key === 'leads') state.leads = docs.map(normalizeLead);
    else if (key === 'payments') state.payments = docs.map(normalizePayment);
    else if (key === 'payouts') state.payouts = docs.map(d => normalizePayout(d, rate()));
    else if (key === 'settings') state.settings = docs.map(normalizeSetting);
    state.fromCache = !!(meta && meta.fromCache && !state.online);
    if (!state.loaded[key]) {
      state.loaded[key] = true;
      if (allLoaded()) hideLoader();
    }
    invalidate();
  };
  state.unsub = db.subscribe({
    leads: done('leads'), payments: done('payments'), payouts: done('payouts'),
    settings: done('settings'), meta: done('meta'),
    error: (err, name) => {
      console.error('subscribe error', name, err);
      if (loaderCount > 0) hideLoader();
      toast(humanError(err), true);
    }
  });
}

function stopSession() {
  if (state.unsub) { state.unsub(); state.unsub = null; }
  state.user = null;
  state.leads = []; state.payments = []; state.payouts = []; state.settings = []; state.meta = {};
  Object.keys(state.loaded).forEach(k => { state.loaded[k] = false; });
  loaderCount = 0; $('globalLoader').classList.remove('active');
  calcCache = null;
}

$('loginEmail').value = CFG.OWNER_EMAIL || '';
$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('btnLogin');
  btn.disabled = true;
  try { await db.signInWithPassword($('loginEmail').value, $('loginPassword').value); $('loginPassword').value = ''; } catch (err) {
    console.error(err);
    const code = err && err.code ? err.code : '';
    if (['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found', 'auth/invalid-email'].includes(code)) showLogin('Невірна пошта або пароль.', true);
    else if (code === 'auth/too-many-requests') showLogin('Забагато спроб. Зачекайте кілька хвилин і спробуйте знову.', true);
    else if (code === 'auth/unauthorized-domain') showLogin('Цей домен не додано до дозволених у Firebase (Authentication → Settings → Authorized domains).', true);
    else if (code === 'auth/operation-not-allowed') showLogin('Вхід за паролем не увімкнено у Firebase.', true);
    else showLogin('Не вдалося увійти: ' + humanError(err), true);
  } finally { btn.disabled = false; }
});

$('btnLogout').addEventListener('click', async () => {
  stopSession();
  try { await db.signOutUser(); } catch (e) { console.error(e); }
  showLogin('', false);
});

function boot() {
  if (location.protocol === 'file:') {
    $('btnLogin').disabled = true;
    showLogin('Сторінку відкрито як локальний файл — вхід з file:// не працює. Відкрийте сайт за адресою https://… (Firebase Hosting) або через http://localhost.', true);
    return;
  }
  try {
    db.init(CFG.FIREBASE);
  } catch (err) {
    console.error(err);
    showLogin('Не вдалося ініціалізувати Firebase: ' + humanError(err), true);
    return;
  }
  db.onAuthChange(user => {
    if (!user) { stopSession(); showLogin('', false); return; }
    if (OWNER && String(user.email || '').toLowerCase() !== OWNER) {
      stopSession();
      db.signOutUser().finally(() => showLogin(`Доступ лише для ${CFG.OWNER_EMAIL}. Ви увійшли як ${user.email}.`, true));
      return;
    }
    if (!state.user) startSession(user);
  });
}

boot();
