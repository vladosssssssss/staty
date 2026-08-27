/**
 * ==========================================================================
 * MINI CRM — Google Apps Script backend
 * ==========================================================================
 * Зберігає все у Google Sheets цієї ж таблиці (де встановлено скрипт):
 *   - Leads     — ліди/угоди
 *   - Payments  — платежі по кожному ліду (можна декілька на лід)
 *   - Payouts   — виплати "зарплати" тобі від бізнесу
 *   - Settings  — напрямки/тарифи/ціни/відсоток комісії (редагується з сайту)
 *
 * ДЕПЛОЙ:
 *   1. Створи нову Google Таблицю (Google Sheets) — можна порожню.
 *   2. Розширення → Apps Script.
 *   3. Встав цей файл замість Code.gs, збережи.
 *   4. Розгорнути → Нове розгортання → тип "Веб-застосунок":
 *        - Виконати від імені: Я (свій акаунт)
 *        - Хто має доступ: Усі (Anyone)
 *   5. Скопіюй URL /exec — це і є посилання для script.js (BACKEND_URL).
 *   6. Перший запит з сайту сам створить листи й заповнить стартові ціни.
 *
 * Немає жодних CORS-заголовків, бо вони не потрібні: фронтенд шле POST з
 * телом як звичайний текст (text/plain), це "simple request" і браузер
 * не робить preflight OPTIONS — Apps Script такі запити віддає без проблем.
 * ==========================================================================
 */

var SHEET_LEADS = 'Leads';
var SHEET_PAYMENTS = 'Payments';
var SHEET_PAYOUTS = 'Payouts';
var SHEET_SETTINGS = 'Settings';

var LEADS_HEADERS = ['id','number','clientName','nickname','direction','tariff','price','commissionPercent','status','comment','createdDate','month','cancelled'];
var PAYMENTS_HEADERS = ['id','leadId','amount','date','comment','cancelled'];
var PAYOUTS_HEADERS = ['id','date','amount','comment'];
var SETTINGS_HEADERS = ['direction','tariff','price1','price2','price3','percent','order'];

// Дефолтні напрямки/тарифи/ціни/відсотки — те, що ти прислав.
var DEFAULT_SETTINGS = [
  // direction, tariff, price1(без знижки), price2(знижка1), price3(знижка2 / діагностика), percent, order
  ['Швидкий старт з блогу', 'Базовий',       1190, 990, 890,  6, 1],
  ['Швидкий старт з блогу', 'Поглиблений',   1590, 1390, 1190, 7, 2],
  ['Швидкий старт з блогу', 'Персональний',  3090, 2790, 2290, 8, 3],
  ['Продажі 24/7',          'Стандарт',      1490, 1290, 990,  6, 1],
  ['Продажі 24/7',          'Поглиблений',   2190, 1790, 1490, 8, 2],
  ['Продажі 24/7',          'Персональний',  3090, 1790, 2490, 7, 3],
  ['Big Money',              'Стандарт',      4990, 2990, 2490, 8, 1],
  ['Big Money',              'Поглиблений',   6990, 5990, 4490, 7, 2],
  ['Big Money',              'Менторство',   17990, 16490, 14990, 5, 3]
];

/* ------------------------------ ВХІДНІ ТОЧКИ ------------------------------ */

function doGet(e) {
  try {
    ensureSheets_();
    return jsonOut_({ ok: true, data: getAllData_() });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    ensureSheets_();
    var body = {};
    if (e && e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    }
    var action = body.action;
    var payload = body.payload || {};
    var result;

    switch (action) {
      case 'getAll':
        result = getAllData_();
        break;
      case 'addLead':
        result = addLead_(payload);
        break;
      case 'updateLead':
        result = updateLead_(payload);
        break;
      case 'addPayment':
        result = addPayment_(payload);
        break;
      case 'updatePayment':
        result = updatePayment_(payload);
        break;
      case 'addPayout':
        result = addPayout_(payload);
        break;
      case 'updatePayout':
        result = updatePayout_(payload);
        break;
      case 'deletePayout':
        result = deletePayout_(payload);
        break;
      case 'updateSettings':
        result = updateSettings_(payload);
        break;
      default:
        throw new Error('Невідома дія: ' + action);
    }

    return jsonOut_({ ok: true, data: result });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------ ІНІЦІАЛІЗАЦІЯ ------------------------------ */

function ensureSheets_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var leads = ss.getSheetByName(SHEET_LEADS);
  if (!leads) {
    leads = ss.insertSheet(SHEET_LEADS);
    leads.appendRow(LEADS_HEADERS);
    leads.setFrozenRows(1);
  }

  var payments = ss.getSheetByName(SHEET_PAYMENTS);
  if (!payments) {
    payments = ss.insertSheet(SHEET_PAYMENTS);
    payments.appendRow(PAYMENTS_HEADERS);
    payments.setFrozenRows(1);
  }

  var payouts = ss.getSheetByName(SHEET_PAYOUTS);
  if (!payouts) {
    payouts = ss.insertSheet(SHEET_PAYOUTS);
    payouts.appendRow(PAYOUTS_HEADERS);
    payouts.setFrozenRows(1);
  }

  var settings = ss.getSheetByName(SHEET_SETTINGS);
  if (!settings) {
    settings = ss.insertSheet(SHEET_SETTINGS);
    settings.appendRow(SETTINGS_HEADERS);
    settings.setFrozenRows(1);
    DEFAULT_SETTINGS.forEach(function(row) { settings.appendRow(row); });
  }

  // Прибираємо дефолтний "Sheet1", якщо він порожній і його ніхто не чіпав.
  var def = ss.getSheetByName('Sheet1') || ss.getSheetByName('Аркуш1');
  if (def && def.getLastRow() === 0) {
    ss.deleteSheet(def);
  }

  // Примусово тримаємо колонки з датами/місяцями як текст, інакше Google
  // Sheets сам конвертує рядки на кшталт "2026-08-26" чи "2026-08" у дату
  // при записі, і рядкові порівняння (наприклад, фільтр по місяцю) ламаються.
  forceTextFormat_(leads, [11, 12]);      // createdDate, month
  forceTextFormat_(payments, [4]);        // date
  forceTextFormat_(payouts, [2]);         // date
}

function forceTextFormat_(sheet, columns) {
  var rows = Math.max(sheet.getMaxRows() - 1, 2000);
  columns.forEach(function(col) {
    sheet.getRange(2, col, rows, 1).setNumberFormat('@');
  });
}

/* ------------------------------ ЗЧИТУВАННЯ ------------------------------ */

function sheetToObjects_(sheetName, headers) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  var values = sh.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    if (row.join('') === '') continue; // пропускаємо повністю порожні рядки
    var obj = {};
    for (var j = 0; j < headers.length; j++) {
      obj[headers[j]] = row[j];
    }
    obj._row = i + 2; // фізичний номер рядка в таблиці, для швидкого апдейту
    out.push(obj);
  }
  return out;
}

function getAllData_() {
  var leads = sheetToObjects_(SHEET_LEADS, LEADS_HEADERS).map(normalizeLead_);
  var payments = sheetToObjects_(SHEET_PAYMENTS, PAYMENTS_HEADERS).map(normalizePayment_);
  var payouts = sheetToObjects_(SHEET_PAYOUTS, PAYOUTS_HEADERS).map(normalizePayout_);
  var settings = sheetToObjects_(SHEET_SETTINGS, SETTINGS_HEADERS);
  return { leads: leads, payments: payments, payouts: payouts, settings: settings };
}

function normalizeLead_(l) {
  l.number = Number(l.number) || 0;
  l.price = Number(l.price) || 0;
  l.commissionPercent = Number(l.commissionPercent) || 0;
  l.cancelled = (l.cancelled === true || l.cancelled === 'true' || l.cancelled === 'TRUE');
  l.createdDate = formatDate_(l.createdDate);
  // ВАЖЛИВО: місяць завжди рахуємо наново з createdDate, а не довіряємо тому,
  // що лежить у колонці "month" — Google Sheets інколи сам перетворює текст
  // виду "2026-08" на дату при записі, і рядкове порівняння місяця ламається.
  l.month = l.createdDate ? l.createdDate.substring(0, 7) : String(l.month || '').substring(0, 7);
  return l;
}
function normalizePayment_(p) {
  p.amount = Number(p.amount) || 0;
  p.cancelled = (p.cancelled === true || p.cancelled === 'true' || p.cancelled === 'TRUE');
  p.date = formatDate_(p.date);
  return p;
}
function normalizePayout_(p) {
  p.amount = Number(p.amount) || 0;
  p.date = formatDate_(p.date);
  return p;
}
function formatDate_(d) {
  if (!d) return '';
  if (Object.prototype.toString.call(d) === '[object Date]') {
    return Utilities.formatDate(d, Session.getScriptTimeZone() || 'Europe/Kyiv', 'yyyy-MM-dd');
  }
  return String(d).substring(0, 10);
}

/* ------------------------------ LEADS ------------------------------ */

function addLead_(p) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_LEADS);
  var id = 'L' + new Date().getTime() + Math.floor(Math.random() * 1000);
  var number = nextLeadNumber_(sh);
  var createdDate = p.createdDate || Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Europe/Kyiv', 'yyyy-MM-dd');
  var month = createdDate.substring(0, 7);
  var row = [
    id,
    number,
    p.clientName || '',
    p.nickname || '',
    p.direction || '',
    p.tariff || '',
    Number(p.price) || 0,
    Number(p.commissionPercent) || 0,
    p.status || 'Бронь',
    p.comment || '',
    createdDate,
    month,
    false
  ];
  sh.appendRow(row);
  return { id: id, number: number, createdDate: createdDate, month: month };
}

function nextLeadNumber_(sh) {
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return 1;
  var nums = sh.getRange(2, 2, lastRow - 1, 1).getValues();
  var max = 0;
  for (var i = 0; i < nums.length; i++) {
    var n = Number(nums[i][0]) || 0;
    if (n > max) max = n;
  }
  return max + 1;
}

function findRowById_(sheetName, headers, id) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return null;
  var ids = sh.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) {
      return { sheet: sh, row: i + 2 };
    }
  }
  return null;
}

function updateLead_(p) {
  var found = findRowById_(SHEET_LEADS, LEADS_HEADERS, p.id);
  if (!found) throw new Error('Лід не знайдено: ' + p.id);
  var editable = ['clientName','nickname','direction','tariff','price','commissionPercent','status','comment','cancelled'];
  editable.forEach(function(field) {
    if (p.hasOwnProperty(field)) {
      var col = LEADS_HEADERS.indexOf(field) + 1;
      found.sheet.getRange(found.row, col).setValue(p[field]);
    }
  });
  return { id: p.id, updated: true };
}

/* ------------------------------ PAYMENTS ------------------------------ */

function addPayment_(p) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PAYMENTS);
  var id = 'P' + new Date().getTime() + Math.floor(Math.random() * 1000);
  var date = p.date || Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Europe/Kyiv', 'yyyy-MM-dd');
  var row = [id, p.leadId, Number(p.amount) || 0, date, p.comment || '', false];
  sh.appendRow(row);
  return { id: id, date: date };
}

function updatePayment_(p) {
  var found = findRowById_(SHEET_PAYMENTS, PAYMENTS_HEADERS, p.id);
  if (!found) throw new Error('Платіж не знайдено: ' + p.id);
  var editable = ['amount','date','comment','cancelled'];
  editable.forEach(function(field) {
    if (p.hasOwnProperty(field)) {
      var col = PAYMENTS_HEADERS.indexOf(field) + 1;
      found.sheet.getRange(found.row, col).setValue(p[field]);
    }
  });
  return { id: p.id, updated: true };
}

/* ------------------------------ PAYOUTS (виплати ЗП тобі) ------------------------------ */

function addPayout_(p) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PAYOUTS);
  var id = 'O' + new Date().getTime() + Math.floor(Math.random() * 1000);
  var date = p.date || Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Europe/Kyiv', 'yyyy-MM-dd');
  sh.appendRow([id, date, Number(p.amount) || 0, p.comment || '']);
  return { id: id, date: date };
}

function updatePayout_(p) {
  var found = findRowById_(SHEET_PAYOUTS, PAYOUTS_HEADERS, p.id);
  if (!found) throw new Error('Виплату не знайдено: ' + p.id);
  var editable = ['amount','date','comment'];
  editable.forEach(function(field) {
    if (p.hasOwnProperty(field)) {
      var col = PAYOUTS_HEADERS.indexOf(field) + 1;
      found.sheet.getRange(found.row, col).setValue(p[field]);
    }
  });
  return { id: p.id, updated: true };
}

function deletePayout_(p) {
  var found = findRowById_(SHEET_PAYOUTS, PAYOUTS_HEADERS, p.id);
  if (!found) throw new Error('Виплату не знайдено: ' + p.id);
  found.sheet.deleteRow(found.row);
  return { id: p.id, deleted: true };
}

/* ------------------------------ SETTINGS (тарифи/ціни/%) ------------------------------ */

function updateSettings_(p) {
  // p: { direction, tariff, price1, price2, price3, percent }
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SETTINGS);
  var lastRow = sh.getLastRow();
  var values = lastRow >= 2 ? sh.getRange(2, 1, lastRow - 1, 2).getValues() : [];
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]) === String(p.direction) && String(values[i][1]) === String(p.tariff)) {
      var row = i + 2;
      sh.getRange(row, 3).setValue(Number(p.price1) || 0);
      sh.getRange(row, 4).setValue(Number(p.price2) || 0);
      sh.getRange(row, 5).setValue(Number(p.price3) || 0);
      sh.getRange(row, 6).setValue(Number(p.percent) || 0);
      return { updated: true };
    }
  }
  // якщо такого напрямку/тарифу ще нема — додаємо новий рядок
  sh.appendRow([p.direction, p.tariff, Number(p.price1) || 0, Number(p.price2) || 0, Number(p.price3) || 0, Number(p.percent) || 0, 99]);
  return { created: true };
}
