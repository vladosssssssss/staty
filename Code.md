var SHEET_LEADS = 'Leads'; var SHEET_PAYMENTS = 'Payments'; var SHEET_PAYOUTS = 'Payouts'; var SHEET_SETTINGS = 'Settings';
var LEADS_HEADERS = ['id','number','clientName','nickname','direction','tariff','price','commissionPercent','status','comment','createdDate','month','cancelled'];
var PAYMENTS_HEADERS = ['id','leadId','amount','date','comment','cancelled'];
var PAYOUTS_HEADERS = ['id','date','amount','comment'];
var SETTINGS_HEADERS = ['direction','tariff','price1','price2','price3','percent','order'];

var DEFAULT_SETTINGS = [
  ['Швидкий старт з блогу', 'Базовий', 1190, 990, 890, 6, 1], ['Швидкий старт з блогу', 'Поглиблений', 1590, 1390, 1190, 7, 2], ['Швидкий старт з блогу', 'Персональний', 3090, 2790, 2290, 8, 3],
  ['Продажі 24/7', 'Стандарт', 1490, 1290, 990, 6, 1], ['Продажі 24/7', 'Поглиблений', 2190, 1790, 1490, 8, 2], ['Продажі 24/7', 'Персональний', 3090, 1790, 2490, 7, 3],
  ['Big Money', 'Стандарт', 4990, 2990, 2490, 8, 1], ['Big Money', 'Поглиблений', 6990, 5990, 4490, 7, 2], ['Big Money', 'Менторство', 17990, 16490, 14990, 5, 3]
];

function doGet(e) { try { ensureSheets_(); return jsonOut_({ ok: true, data: getAllData_() }); } catch (err) { return jsonOut_({ ok: false, error: String(err) }); } }
function doPost(e) {
  try {
    ensureSheets_(); var body = (e && e.postData && e.postData.contents) ? JSON.parse(e.postData.contents) : {}; var action = body.action; var payload = body.payload || {}; var result;
    switch (action) {
      case 'getAll': result = getAllData_(); break; case 'addLead': result = addLead_(payload); break; case 'updateLead': result = updateLead_(payload); break;
      case 'deleteLead': result = deleteLead_(payload); break; case 'addPayment': result = addPayment_(payload); break; case 'updatePayment': result = updatePayment_(payload); break;
      case 'deletePayment': result = deletePayment_(payload); break; case 'addPayout': result = addPayout_(payload); break; case 'updatePayout': result = updatePayout_(payload); break; case 'deletePayout': result = deletePayout_(payload); break;
      case 'updateSettings': result = updateSettings_(payload); break; default: throw new Error('Невідома дія: ' + action);
    } return jsonOut_({ ok: true, data: result });
  } catch (err) { return jsonOut_({ ok: false, error: String(err) }); }
}

function jsonOut_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
function ensureSheets_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet(); function checkAndCreate(name, headers) { var sh = ss.getSheetByName(name); if (!sh) { sh = ss.insertSheet(name); sh.appendRow(headers); sh.setFrozenRows(1); } return sh; }
  var leads = checkAndCreate(SHEET_LEADS, LEADS_HEADERS); var payments = checkAndCreate(SHEET_PAYMENTS, PAYMENTS_HEADERS); var payouts = checkAndCreate(SHEET_PAYOUTS, PAYOUTS_HEADERS); var settings = checkAndCreate(SHEET_SETTINGS, SETTINGS_HEADERS);
  if (settings.getLastRow() === 1) DEFAULT_SETTINGS.forEach(function(row) { settings.appendRow(row); }); var def = ss.getSheetByName('Sheet1') || ss.getSheetByName('Аркуш1'); if (def && def.getLastRow() === 0) ss.deleteSheet(def);
  forceTextFormat_(leads, [11, 12]); forceTextFormat_(payments, [4]); forceTextFormat_(payouts, [2]);
}
function forceTextFormat_(sheet, columns) { var rows = Math.max(sheet.getMaxRows() - 1, 2000); columns.forEach(function(col) { sheet.getRange(2, col, rows, 1).setNumberFormat('@'); }); }
function sheetToObjects_(sheetName, headers) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName); var lastRow = sh.getLastRow(); if (lastRow < 2) return [];
  var values = sh.getRange(2, 1, lastRow - 1, headers.length).getValues(); var out = [];
  for (var i = 0; i < values.length; i++) { if (values[i].join('') === '') continue; var obj = { _row: i + 2 }; for (var j = 0; j < headers.length; j++) obj[headers[j]] = values[i][j]; out.push(obj); } return out;
}
function getAllData_() { return { leads: sheetToObjects_(SHEET_LEADS, LEADS_HEADERS).map(normalizeLead_), payments: sheetToObjects_(SHEET_PAYMENTS, PAYMENTS_HEADERS).map(normalizePayment_), payouts: sheetToObjects_(SHEET_PAYOUTS, PAYOUTS_HEADERS).map(normalizePayout_), settings: sheetToObjects_(SHEET_SETTINGS, SETTINGS_HEADERS) }; }
function normalizeLead_(l) { l.number = Number(l.number) || 0; l.price = Number(l.price) || 0; l.commissionPercent = Number(l.commissionPercent) || 0; l.cancelled = (String(l.cancelled).toLowerCase() === 'true'); l.createdDate = formatDate_(l.createdDate); l.month = l.createdDate ? l.createdDate.substring(0, 7) : String(l.month || '').substring(0, 7); return l; }
function normalizePayment_(p) { p.amount = Number(p.amount) || 0; p.cancelled = (String(p.cancelled).toLowerCase() === 'true'); p.date = formatDate_(p.date); return p; }
function normalizePayout_(p) { p.amount = Number(p.amount) || 0; p.date = formatDate_(p.date); return p; }
function formatDate_(d) { if (!d) return ''; if (Object.prototype.toString.call(d) === '[object Date]') return Utilities.formatDate(d, Session.getScriptTimeZone() || 'Europe/Kyiv', 'yyyy-MM-dd'); return String(d).substring(0, 10); }

function findRowById_(sheetName, headers, id) { var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName); var lastRow = sh.getLastRow(); if (lastRow < 2) return null; var ids = sh.getRange(2, 1, lastRow - 1, 1).getValues(); for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return { sheet: sh, row: i + 2 }; return null; }
function nextLeadNumber_(sh) { var lastRow = sh.getLastRow(); if (lastRow < 2) return 1; var nums = sh.getRange(2, 2, lastRow - 1, 1).getValues(); var max = 0; for (var i = 0; i < nums.length; i++) max = Math.max(max, Number(nums[i][0]) || 0); return max + 1; }

function addLead_(p) {
  var lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_LEADS); var id = Utilities.getUuid(); var number = nextLeadNumber_(sh); var date = p.createdDate || formatDate_(new Date());
    sh.appendRow([id, number, p.clientName || '', p.nickname || '', p.direction || '', p.tariff || '', Number(p.price) || 0, Number(p.commissionPercent) || 0, p.status || 'Бронь', p.comment || '', date, date.substring(0, 7), false]);
    return { id: id, number: number, createdDate: date, month: date.substring(0, 7) };
  } finally { lock.releaseLock(); }
}

function updateLead_(p) {
  var lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    var found = findRowById_(SHEET_LEADS, LEADS_HEADERS, p.id); if (!found) throw new Error('Лід не знайдено');
    var rowRange = found.sheet.getRange(found.row, 1, 1, LEADS_HEADERS.length); var rowValues = rowRange.getValues()[0];
    ['clientName','nickname','direction','tariff','price','commissionPercent','status','comment','cancelled'].forEach(function(field) { if (p.hasOwnProperty(field)) rowValues[LEADS_HEADERS.indexOf(field)] = p[field]; });
    rowRange.setValues([rowValues]); return { id: p.id, updated: true };
  } finally { lock.releaseLock(); }
}

function deleteLead_(p) {
  var lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    var found = findRowById_(SHEET_LEADS, LEADS_HEADERS, p.id); if (!found) throw new Error('Лід не знайдено'); found.sheet.deleteRow(found.row);
    var pSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PAYMENTS);
    if (pSheet.getLastRow() >= 2) {
      var pVals = pSheet.getRange(2, 1, pSheet.getLastRow() - 1, PAYMENTS_HEADERS.length).getValues();
      for (var i = pVals.length - 1; i >= 0; i--) { if (String(pVals[i][1]) === String(p.id)) pSheet.deleteRow(i + 2); }
    } return { id: p.id, deleted: true };
  } finally { lock.releaseLock(); }
}

function addPayment_(p) {
  var lock = LockService.getScriptLock(); lock.waitLock(10000);
  try { var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PAYMENTS); var id = Utilities.getUuid(); var date = p.date || formatDate_(new Date()); sh.appendRow([id, p.leadId, Number(p.amount) || 0, date, p.comment || '', false]); return { id: id, date: date }; } finally { lock.releaseLock(); }
}
function updatePayment_(p) {
  var lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    var found = findRowById_(SHEET_PAYMENTS, PAYMENTS_HEADERS, p.id); if (!found) throw new Error('Платіж не знайдено');
    var rowRange = found.sheet.getRange(found.row, 1, 1, PAYMENTS_HEADERS.length); var rowValues = rowRange.getValues()[0];
    ['amount','date','comment','cancelled'].forEach(function(field) { if (p.hasOwnProperty(field)) rowValues[PAYMENTS_HEADERS.indexOf(field)] = p[field]; });
    rowRange.setValues([rowValues]); return { id: p.id, updated: true };
  } finally { lock.releaseLock(); }
}
function deletePayment_(p) {
  var lock = LockService.getScriptLock(); lock.waitLock(10000);
  try { var found = findRowById_(SHEET_PAYMENTS, PAYMENTS_HEADERS, p.id); if (!found) throw new Error('Платіж не знайдено'); found.sheet.deleteRow(found.row); return { id: p.id, deleted: true }; } finally { lock.releaseLock(); }
}

function addPayout_(p) {
  var lock = LockService.getScriptLock(); lock.waitLock(10000);
  try { var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PAYOUTS); var id = Utilities.getUuid(); var date = p.date || formatDate_(new Date()); sh.appendRow([id, date, Number(p.amount) || 0, p.comment || '']); return { id: id, date: date }; } finally { lock.releaseLock(); }
}
function updatePayout_(p) {
  var lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    var found = findRowById_(SHEET_PAYOUTS, PAYOUTS_HEADERS, p.id); if (!found) throw new Error('Виплату не знайдено');
    var rowRange = found.sheet.getRange(found.row, 1, 1, PAYOUTS_HEADERS.length); var rowValues = rowRange.getValues()[0];
    ['amount','date','comment'].forEach(function(field) { if (p.hasOwnProperty(field)) rowValues[PAYOUTS_HEADERS.indexOf(field)] = p[field]; });
    rowRange.setValues([rowValues]); return { id: p.id, updated: true };
  } finally { lock.releaseLock(); }
}
function deletePayout_(p) {
  var lock = LockService.getScriptLock(); lock.waitLock(10000);
  try { var found = findRowById_(SHEET_PAYOUTS, PAYOUTS_HEADERS, p.id); if (!found) throw new Error('Виплату не знайдено'); found.sheet.deleteRow(found.row); return { id: p.id, deleted: true }; } finally { lock.releaseLock(); }
}

function updateSettings_(p) {
  var lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SETTINGS); var lastRow = sh.getLastRow();
    if (lastRow >= 2) {
      var range = sh.getRange(2, 1, lastRow - 1, SETTINGS_HEADERS.length); var values = range.getValues();
      for (var i = 0; i < values.length; i++) {
        if (String(values[i][0]) === String(p.direction) && String(values[i][1]) === String(p.tariff)) {
          values[i][2] = Number(p.price1) || 0; values[i][3] = Number(p.price2) || 0; values[i][4] = Number(p.price3) || 0; values[i][5] = Number(p.percent) || 0;
          sh.getRange(i + 2, 1, 1, SETTINGS_HEADERS.length).setValues([values[i]]); return { updated: true };
        }
      }
    }
    sh.appendRow([p.direction, p.tariff, Number(p.price1) || 0, Number(p.price2) || 0, Number(p.price3) || 0, Number(p.percent) || 0, 99]); return { created: true };
  } finally { lock.releaseLock(); }
}
