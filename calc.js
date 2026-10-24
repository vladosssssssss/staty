// calc.js — вся бизнес-логика подсчётов (без DOM и без Firebase).
// Подключается и в браузере (ES-модуль), и в тестах Node.
// Логика подсчётов сохранена из оригинальной версии; исправлены только явные баги (см. README).

export const CONTRACT = 'Оплачено повністю (договір)';
export const BRON_THRESHOLD_EUR = 150;
export const STATUSES = ['Бронь', 'Часткова оплата', 'Оплачено повністю', CONTRACT];

export function toNum(v) {
  if (typeof v === 'number') return isNaN(v) ? 0 : v;
  return Number(String(v == null ? '' : v).replace(',', '.').replace(/\s+/g, '')) || 0;
}

export function round2(n) {
  return Math.round((toNum(n) + Number.EPSILON) * 100) / 100;
}

export function pad2(n) { return String(n).padStart(2, '0'); }
export function monthKey(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1); }
export function todayStr(d = new Date()) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

export function shiftMonth(key, delta) {
  const [y, m] = String(key || '').split('-').map(Number);
  if (!y || !m) return monthKey(new Date());
  return monthKey(new Date(y, m - 1 + delta, 1));
}

// 'YYYY-MM-DD' -> Date у локальному часовому поясі (без зсуву UTC)
export function parseDateStr(s) {
  const [y, m, d] = String(s || '').split('-').map(Number);
  return new Date(y || 1970, (m || 1) - 1, d || 1);
}

export function isValidDateStr(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const d = parseDateStr(s);
  return todayStr(d) === s;
}

export function computeStatusByPaidAmount(status, price, paid) {
  if (status === CONTRACT) return CONTRACT;
  const numPrice = toNum(price);
  const numPaid = toNum(paid);
  if (numPrice > 0 && numPaid >= numPrice) return 'Оплачено повністю';
  if (numPaid >= BRON_THRESHOLD_EUR) return 'Часткова оплата';
  return 'Бронь';
}

export function normalizeLead(l) {
  const createdDate = l.createdDate == null ? '' : String(l.createdDate).substring(0, 10);
  return {
    ...l,
    number: toNum(l.number),
    price: toNum(l.price),
    commissionPercent: toNum(l.commissionPercent),
    clientName: l.clientName == null ? '' : String(l.clientName),
    nickname: l.nickname == null ? '' : String(l.nickname),
    direction: l.direction == null ? '' : String(l.direction),
    tariff: l.tariff == null ? '' : String(l.tariff),
    comment: l.comment == null ? '' : String(l.comment),
    status: l.status || 'Бронь',
    createdDate,
    month: createdDate.substring(0, 7) || String(l.month || '').substring(0, 7),
    cancelled: l.cancelled === true || String(l.cancelled).toLowerCase() === 'true'
  };
}

export function normalizePayment(p) {
  return {
    ...p,
    amount: toNum(p.amount),
    date: p.date == null ? '' : String(p.date).substring(0, 10),
    comment: p.comment == null ? '' : String(p.comment),
    cancelled: p.cancelled === true || String(p.cancelled).toLowerCase() === 'true'
  };
}

export function normalizePayout(p, defaultRate) {
  const amount = toNum(p.amount);
  const rate = toNum(p.rate) || toNum(defaultRate) || 0;
  const hasUah = p.amountUAH != null && p.amountUAH !== '';
  return {
    ...p,
    amount,
    amountUAH: hasUah ? toNum(p.amountUAH) : round2(amount * rate),
    rate,
    bonus: toNum(p.bonus),
    extraPercent: toNum(p.extraPercent),
    extraAmount: toNum(p.extraAmount),
    date: p.date == null ? '' : String(p.date).substring(0, 10),
    comment: p.comment == null ? '' : String(p.comment)
  };
}

export function normalizeSetting(s) {
  return {
    ...s,
    direction: String(s.direction || ''),
    tariff: String(s.tariff || ''),
    price1: toNum(s.price1), price2: toNum(s.price2), price3: toNum(s.price3),
    percent: toNum(s.percent), order: toNum(s.order)
  };
}

export function createCalc(data, now = new Date()) {
  const leads = data.leads || [];
  const payments = data.payments || [];
  const payouts = data.payouts || [];
  const realMonth = monthKey(now);

  const byLead = new Map();
  for (const p of payments) {
    if (!byLead.has(p.leadId)) byLead.set(p.leadId, []);
    byLead.get(p.leadId).push(p);
  }
  const leadById = new Map(leads.map(l => [l.id, l]));

  const paymentsOf = id => byLead.get(id) || [];
  const isContract = l => l.status === CONTRACT;

  function paymentMonth(p, lead) {
    const m = String(p.date || '').substring(0, 7);
    if (m && m.length === 7) return m;
    return lead ? String(lead.month || '') : '';
  }

  function actualPaidTotal(leadId) {
    return paymentsOf(leadId).filter(p => !p.cancelled).reduce((s, p) => s + toNum(p.amount), 0);
  }

  function actualPaidInMonth(lead, targetMonth) {
    if (!lead || lead.cancelled) return 0;
    const valid = paymentsOf(lead.id).filter(p => !p.cancelled);
    if (!targetMonth) return valid.reduce((s, p) => s + toNum(p.amount), 0);
    return valid.filter(p => paymentMonth(p, lead) === targetMonth).reduce((s, p) => s + toNum(p.amount), 0);
  }

  function leadPaidTotal(lead, targetMonth) {
    if (!lead || lead.cancelled) return 0;
    const price = toNum(lead.price);
    if (isContract(lead)) {
      const m2 = shiftMonth(lead.month, 1);
      if (targetMonth) return (targetMonth === lead.month || targetMonth === m2) ? price / 2 : 0;
      return realMonth < m2 ? price / 2 : price;
    }
    if (targetMonth) return actualPaidInMonth(lead, targetMonth);
    return actualPaidTotal(lead.id);
  }

  function leadRemaining(lead, targetMonth) {
    if (!lead || lead.cancelled) return 0;
    const price = toNum(lead.price);
    if (isContract(lead)) {
      const m2 = shiftMonth(lead.month, 1);
      const refMonth = targetMonth || realMonth;
      return (refMonth < m2 && realMonth < m2) ? price / 2 : 0;
    }
    return Math.max(price - actualPaidTotal(lead.id), 0);
  }

  function leadClientPotential(lead) {
    if (!lead || lead.cancelled) return 0;
    if (isContract(lead)) return 0;
    return leadRemaining(lead);
  }

  function leadCommissionFact(lead, targetMonth) {
    if (!lead || lead.cancelled) return 0;
    const pct = toNum(lead.commissionPercent) / 100;
    const price = toNum(lead.price);
    if (isContract(lead)) {
      const total = price * pct;
      const m2 = shiftMonth(lead.month, 1);
      if (targetMonth) return (targetMonth === lead.month || targetMonth === m2) ? total / 2 : 0;
      return realMonth < m2 ? total / 2 : total;
    }
    return leadPaidTotal(lead, targetMonth) * pct;
  }

  function leadCommissionPotential(lead, targetMonth) {
    if (!lead || lead.cancelled) return 0;
    if (isContract(lead)) return 0;
    if (targetMonth && lead.month !== targetMonth) return 0;
    return leadRemaining(lead) * (toNum(lead.commissionPercent) / 100);
  }

  function leadStatusDisplay(lead) {
    if (lead.cancelled) return 'Скасовано';
    return computeStatusByPaidAmount(lead.status, lead.price, actualPaidTotal(lead.id));
  }

  function allLeadsCountForMonth(m) {
    return leads.filter(l => l.month === m && !l.cancelled).length;
  }

  function confirmedInWorkCountForMonth(m) {
    return leads.filter(l => l.month === m && !l.cancelled && leadStatusDisplay(l) !== 'Бронь').length;
  }

  function dashboard(month, today = now) {
    const monthLeads = leads.filter(l => l.month === month && !l.cancelled);
    const contractPrev = leads.filter(l => !l.cancelled && isContract(l) && shiftMonth(l.month, 1) === month);
    const doplataPrev = leads.filter(l => !l.cancelled && l.month !== month && !isContract(l) && actualPaidInMonth(l, month) > 0);

    const newMoneyLeads = [...monthLeads, ...doplataPrev];
    const all = [...monthLeads, ...doplataPrev, ...contractPrev];

    const clientPaidFact = all.reduce((s, l) => s + leadPaidTotal(l, month), 0);
    const clientPotentialMonth = monthLeads.reduce((s, l) => s + leadClientPotential(l), 0);

    const myFact = all.reduce((s, l) => s + leadCommissionFact(l, month), 0);
    const myFactNewMonth = newMoneyLeads.reduce((s, l) => s + leadCommissionFact(l, month), 0);

    const myPotentialMonth = monthLeads.reduce((s, l) => s + leadCommissionPotential(l, month), 0);
    const myTotalMonth = myFact + myPotentialMonth;

    const active = leads.filter(l => !l.cancelled);
    const clientPaidAllTime = active.reduce((s, l) => s + leadPaidTotal(l), 0);
    const clientPotentialFull = active.reduce((s, l) => s + leadClientPotential(l), 0);
    const myFactAllTime = active.reduce((s, l) => s + leadCommissionFact(l), 0);
    const myPotentialFull = active.reduce((s, l) => s + leadCommissionPotential(l), 0);

    const paidOutEUR = payouts.reduce((s, p) => s + toNum(p.amount), 0);
    const expectedPayout = myFactAllTime - paidOutEUR;

    const [selYear, selMonth] = month.split('-').map(Number);
    const daysInMonth = new Date(selYear, selMonth, 0).getDate();
    let forecastEUR;
    if (month === monthKey(today)) forecastEUR = (myFactNewMonth / today.getDate()) * daysInMonth;
    else forecastEUR = myFactNewMonth; // минулий або майбутній місяць — екстраполяція не потрібна

    return {
      clientPaidFact, clientPotentialMonth, myFact, myPotentialMonth, myTotalMonth,
      clientPaidAllTime, clientPotentialFull, myFactAllTime, myPotentialFull,
      expectedPayout, forecastEUR, paidOutEUR
    };
  }

  const byNewest = (a, b) =>
    String(b.createdDate || '').localeCompare(String(a.createdDate || '')) || toNum(b.number) - toNum(a.number);

  function monthRows(month) {
    const thisMonth = leads.filter(l => l.month === month).sort(byNewest);
    const extra = leads.filter(l => {
      if (l.month === month) return false;
      const carry = isContract(l) && shiftMonth(l.month, 1) === month;
      const doplata = !isContract(l) && actualPaidInMonth(l, month) > 0;
      return carry || doplata;
    }).sort(byNewest);
    return { thisMonth, extra };
  }

  function searchLeads(rawQueryInput) {
    const rawQuery = String(rawQueryInput || '').trim().toLowerCase();
    if (!rawQuery) return [];
    const cleanQ = rawQuery.replace(/^[@#]+/, '');
    const exactNum = rawQuery.startsWith('#') && /^\d+$/.test(cleanQ);
    const list = leads.filter(l => {
      const numStr = String(l.number || '');
      if (exactNum) return numStr === cleanQ;
      const name = String(l.clientName || '').toLowerCase();
      const nick = String(l.nickname || '').toLowerCase();
      const nickClean = nick.replace(/^@+/, '');
      return (
        name.includes(rawQuery) || nick.includes(rawQuery) ||
        (cleanQ && nickClean.includes(cleanQ)) ||
        numStr.includes(cleanQ || rawQuery) ||
        String(l.direction || '').toLowerCase().includes(rawQuery) ||
        String(l.tariff || '').toLowerCase().includes(rawQuery) ||
        String(l.comment || '').toLowerCase().includes(rawQuery) ||
        String(l.createdDate || '').toLowerCase().includes(rawQuery) ||
        String(leadStatusDisplay(l) || '').toLowerCase().includes(rawQuery)
      );
    });
    return list.sort((a, b) => {
      const ae = String(a.number) === cleanQ ? 1 : 0;
      const be = String(b.number) === cleanQ ? 1 : 0;
      if (ae !== be) return be - ae;
      return byNewest(a, b);
    });
  }

  // Зріз за довільний період (кнопка «Сформувати зріз за обрані дати»)
  function periodSummary(fromStr, toStr) {
    const periodLeads = leads.filter(l => !l.cancelled && l.createdDate >= fromStr && l.createdDate <= toStr);
    const carryOverLeads = leads.filter(l => {
      if (l.cancelled || !isContract(l)) return false;
      const nextFirst = shiftMonth(l.month, 1) + '-01';
      return nextFirst >= fromStr && nextFirst <= toStr;
    });

    let myFact = 0, myPotential = 0, contractCount = 0, contractThisMonth = 0, contractNextMonth = 0, carryOverAmount = 0;

    payments.forEach(p => {
      if (p.cancelled) return;
      const lead = leadById.get(p.leadId);
      if (!lead || lead.cancelled || isContract(lead)) return;
      const pDate = String(p.date || lead.createdDate || '');
      if (pDate >= fromStr && pDate <= toStr) myFact += toNum(p.amount) * (toNum(lead.commissionPercent) / 100);
    });

    periodLeads.forEach(l => {
      if (isContract(l)) {
        contractCount++;
        const total = toNum(l.price) * (toNum(l.commissionPercent) / 100);
        myFact += total / 2;
        contractThisMonth += total / 2;
        // друга половина «переходить на наступний місяць» лише якщо вона ще не потрапила в цей період
        const nextFirst = shiftMonth(l.month, 1) + '-01';
        if (nextFirst > toStr) contractNextMonth += total / 2;
      } else {
        myPotential += leadRemaining(l) * (toNum(l.commissionPercent) / 100);
      }
    });

    carryOverLeads.forEach(l => {
      const total = toNum(l.price) * (toNum(l.commissionPercent) / 100);
      myFact += total / 2;
      carryOverAmount += total / 2;
    });

    const pureTotal = myFact + myPotential;
    const grossTotal = pureTotal + contractNextMonth;
    return { myFact, myPotential, contractCount, contractThisMonth, contractNextMonth, carryOverAmount, pureTotal, grossTotal };
  }

  return {
    realMonth, paymentsOf, actualPaidTotal, actualPaidInMonth, leadPaidTotal, leadRemaining,
    leadClientPotential, leadCommissionFact, leadCommissionPotential, leadStatusDisplay,
    allLeadsCountForMonth, confirmedInWorkCountForMonth, dashboard, monthRows, searchLeads, periodSummary
  };
}

export function calcConversion(paymentsCount, knownPercent, confirmedCount) {
  const totalPool = paymentsCount / (knownPercent / 100);
  const confirmedPercent = totalPool > 0 ? (confirmedCount / totalPool) * 100 : 0;
  return { totalPool, confirmedPercent };
}

export function statusClass(st) {
  if (st === CONTRACT) return 'badge--blue';
  if (st === 'Оплачено повністю') return 'badge--green';
  if (st === 'Часткова оплата') return 'badge--amber';
  if (st === 'Скасовано') return 'badge--red';
  return 'badge--muted';
}
