// db.js — весь доступ к Firebase (Auth + Firestore). Интерфейс простой, чтобы app.js не знал про SDK.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, signInWithEmailAndPassword, sendPasswordResetEmail, setPersistence, browserLocalPersistence,
  onAuthStateChanged, signOut
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore, collection, doc, onSnapshot, writeBatch, runTransaction, getDocs, query, where, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

let app, auth, fs;

const clean = obj => {
  const out = {};
  Object.keys(obj).forEach(k => { if (obj[k] !== undefined && k !== 'id') out[k] = obj[k]; });
  return out;
};
const stamp = obj => ({ ...clean(obj), updatedAt: serverTimestamp() });

export function settingId(direction, tariff) {
  return (String(direction) + '__' + String(tariff)).replace(/\//g, '-').replace(/\s+/g, ' ').trim();
}

export function init(config) {
  app = initializeApp(config);
  auth = getAuth(app);
  fs = getFirestore(app);
}

export function isFileProtocol() { return location.protocol === 'file:'; }

export function onAuthChange(cb) { return onAuthStateChanged(auth, cb); }

// Вхід за поштою та паролем; сесія зберігається в браузері (не потрібно входити щоразу).
export async function signInWithPassword(email, password) {
  await setPersistence(auth, browserLocalPersistence);
  await signInWithEmailAndPassword(auth, String(email).trim(), password);
}

export function resetPassword(email) { return sendPasswordResetEmail(auth, String(email).trim()); }

export function signOutUser() { return signOut(auth); }

// Реальний час: кожна колекція окремою підпискою.
export function subscribe(handlers) {
  const unsubs = [];
  const watch = (name, cb) => {
    unsubs.push(onSnapshot(collection(fs, name), snap => {
      cb(snap.docs.map(d => {
        const data = d.data();
        delete data.updatedAt; delete data.createdAt; delete data.importedAt; // службові Timestamp не потрібні застосунку
        return { id: d.id, ...data };
      }), { fromCache: snap.metadata.fromCache, pending: snap.metadata.hasPendingWrites });
    }, err => handlers.error && handlers.error(err, name)));
  };
  watch('leads', handlers.leads);
  watch('payments', handlers.payments);
  watch('payouts', handlers.payouts);
  watch('settings', handlers.settings);
  watch('meta', handlers.meta);
  return () => unsubs.forEach(u => u());
}

// ---- Ліди ----
// Номер ліда виділяється в транзакції (лічильник у meta/counters) — дублікати неможливі.
export async function addLead({ lead, payment, localMaxNumber }) {
  const counterRef = doc(fs, 'meta', 'counters');
  let number = 0;
  await runTransaction(fs, async tx => {
    const snap = await tx.get(counterRef);
    const last = snap.exists() ? Number(snap.data().lastLeadNumber) || 0 : 0;
    number = Math.max(last, Number(localMaxNumber) || 0) + 1;
    tx.set(counterRef, { lastLeadNumber: number, updatedAt: serverTimestamp() }, { merge: true });
    tx.set(doc(fs, 'leads', lead.id), { ...stamp(lead), number, createdAt: serverTimestamp() });
    if (payment) tx.set(doc(fs, 'payments', payment.id), { ...stamp(payment), createdAt: serverTimestamp() });
  });
  return { number };
}

// Редагування ліда (+ необов'язковий автоплатіж «Доплата») — одним атомарним записом.
export async function saveLead({ id, fields, payment }) {
  const batch = writeBatch(fs);
  batch.update(doc(fs, 'leads', id), stamp(fields));
  if (payment) batch.set(doc(fs, 'payments', payment.id), { ...stamp(payment), createdAt: serverTimestamp() });
  await batch.commit();
}

export async function deleteLead(id) {
  const snap = await getDocs(query(collection(fs, 'payments'), where('leadId', '==', id)));
  const batch = writeBatch(fs);
  snap.docs.forEach(d => batch.delete(d.ref));
  batch.delete(doc(fs, 'leads', id));
  await batch.commit();
}

// ---- Платежі (+ перерахунок статусу ліда в тому ж записі) ----
export async function savePayment({ payment, isNew, leadId, leadStatus }) {
  const batch = writeBatch(fs);
  const ref = doc(fs, 'payments', payment.id);
  if (isNew) batch.set(ref, { ...stamp(payment), createdAt: serverTimestamp() });
  else batch.update(ref, stamp(payment));
  if (leadStatus) batch.update(doc(fs, 'leads', leadId), { status: leadStatus, updatedAt: serverTimestamp() });
  await batch.commit();
}

export async function deletePayment({ id, leadId, leadStatus }) {
  const batch = writeBatch(fs);
  batch.delete(doc(fs, 'payments', id));
  if (leadStatus) batch.update(doc(fs, 'leads', leadId), { status: leadStatus, updatedAt: serverTimestamp() });
  await batch.commit();
}

// ---- Виплати ----
export async function savePayout({ payout, isNew }) {
  const batch = writeBatch(fs);
  const ref = doc(fs, 'payouts', payout.id);
  if (isNew) batch.set(ref, { ...stamp(payout), createdAt: serverTimestamp() });
  else batch.update(ref, stamp(payout));
  await batch.commit();
}

export async function deletePayout(id) {
  const batch = writeBatch(fs);
  batch.delete(doc(fs, 'payouts', id));
  await batch.commit();
}

// ---- Тарифи ----
export async function saveSetting(setting) {
  const batch = writeBatch(fs);
  batch.set(doc(fs, 'settings', settingId(setting.direction, setting.tariff)), stamp(setting), { merge: true });
  await batch.commit();
}

export async function deleteSetting(direction, tariff) {
  const batch = writeBatch(fs);
  batch.delete(doc(fs, 'settings', settingId(direction, tariff)));
  await batch.commit();
}

export async function saveRate(uahRate) {
  const batch = writeBatch(fs);
  batch.set(doc(fs, 'meta', 'app'), { uahRate, updatedAt: serverTimestamp() }, { merge: true });
  await batch.commit();
}

// ---- Імпорт (з Google Таблиці / з резервної копії) ----
// Ідемпотентно: документи пишуться за тими ж id, повторний імпорт нічого не дублює.
export async function importAll(data, rate) {
  const ops = [];
  (data.leads || []).forEach(l => ops.push([doc(fs, 'leads', l.id), stamp(l)]));
  (data.payments || []).forEach(p => ops.push([doc(fs, 'payments', p.id), stamp(p)]));
  (data.payouts || []).forEach(p => ops.push([doc(fs, 'payouts', p.id), stamp(p)]));
  (data.settings || []).forEach(s => ops.push([doc(fs, 'settings', settingId(s.direction, s.tariff)), stamp(s)]));
  const maxNumber = Math.max(0, Number(data.counterMin) || 0, ...(data.leads || []).map(l => Number(l.number) || 0));
  ops.push([doc(fs, 'meta', 'counters'), { lastLeadNumber: maxNumber, updatedAt: serverTimestamp() }]);
  ops.push([doc(fs, 'meta', 'app'), { uahRate: rate, importedAt: serverTimestamp() }]);
  for (let i = 0; i < ops.length; i += 400) {
    const batch = writeBatch(fs);
    ops.slice(i, i + 400).forEach(([ref, payload]) => batch.set(ref, payload, { merge: true }));
    await batch.commit();
  }
  return ops.length;
}
