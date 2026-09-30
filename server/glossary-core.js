'use strict';
// Arabic -> English glossary core, shared by the API routes and the exports.
//
// Three layers, later ones win:
//   1. the shipped public/glossary_en.json (built from the historical data);
//   2. machine translations (MyMemory, free tier) of whole stored texts that
//      the glossary cannot fully translate — cached once in mt_cache;
//   3. the admin's own entries (glossary table), edited from the Settings
//      screen; these override anything the machine produced.
const path = require('path');
const db = require('./db');
const { nowIso } = require('./util');

const ArEn = require(path.join(__dirname, '..', 'public', 'ar-en.js'));
let STATIC = { exact: {}, phrases: {}, words: {} };
try { STATIC = require(path.join(__dirname, '..', 'public', 'glossary_en.json')); } catch (e) { /* optional */ }

db.exec(`CREATE TABLE IF NOT EXISTS glossary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ar TEXT NOT NULL UNIQUE,
  en TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'word',   -- word | phrase | exact
  created_by INTEGER, created_at TEXT, updated_at TEXT
)`);
db.exec(`CREATE TABLE IF NOT EXISTS mt_cache (
  ar TEXT PRIMARY KEY,
  en TEXT NOT NULL,
  provider TEXT,
  created_at TEXT
)`);

const AR = /[؀-ۿ]/;
const AR_RUN = /[؀-ۿ]+/g;

// ---------- merged glossary + translator (cached until a table changes) ----------
function merged() {
  const g = { exact: Object.assign({}, STATIC.exact), phrases: Object.assign({}, STATIC.phrases), words: Object.assign({}, STATIC.words) };
  // Machine translations are phrases: a translated segment is reused wherever
  // it appears inside a longer text, not only as a whole string.
  for (const r of db.prepare('SELECT ar, en FROM mt_cache').all()) g.phrases[r.ar] = r.en;
  for (const r of db.prepare('SELECT ar, en, kind FROM glossary').all()) {
    const bucket = r.kind === 'exact' ? g.exact : r.kind === 'phrase' ? g.phrases : g.words;
    bucket[r.ar] = r.en;
  }
  return g;
}
let cache = null;
function versionKey() {
  const a = db.prepare('SELECT COUNT(*) n, MAX(updated_at) u FROM glossary').get();
  const b = db.prepare('SELECT COUNT(*) n, MAX(created_at) u FROM mt_cache').get();
  return `${a.n}|${a.u || ''}|${b.n}|${b.u || ''}`;
}
function current() {
  const key = versionKey();
  if (!cache || cache.key !== key) { const g = merged(); cache = { key, g, tr: ArEn.make(g) }; }
  return cache;
}
const translator = () => current().tr;

// ---------- every free-text column users can type Arabic into ----------
const TEXT_SOURCES = [
  ['letters', ['recipient', 'note', 'items', 'meta']],
  ['notes', ['note']],
  ['contract_hdr', ['title', 'note', 'bonus_terms', 'party_rep', 'code']],
  ['contract_items', ['space', 'description', 'category', 'location', 'dimensions']],
  ['contract_spaces', ['name']],
  ['products', ['name', 'brand', 'origin', 'pack']],
  ['price_products', ['name_ar']],
  ['approve_products', ['name_ar', 'brand', 'origin']],
  ['coops', ['name', 'name_ar']],
  ['users', ['name']],
];
const SKIP_KEYS = new Set(['url', 'signatures', 'sig', 'attachments']);
function walkJson(x, add) {
  if (x == null) return;
  if (typeof x === 'string') add(x);
  else if (Array.isArray(x)) x.forEach((y) => walkJson(y, add));
  else if (typeof x === 'object') for (const k of Object.keys(x)) { if (!SKIP_KEYS.has(k)) walkJson(x[k], add); }
}
// Map: stored Arabic text -> where it was first seen ("table.column").
function collectStrings() {
  const strings = new Map();
  const add = (where) => (v) => {
    if (typeof v !== 'string' || !AR.test(v)) return;
    const s = v.replace(/\s+/g, ' ').trim(); if (!s) return;
    if (!strings.has(s)) strings.set(s, where);
  };
  for (const [table, cols] of TEXT_SOURCES) {
    let rows; try { rows = db.prepare(`SELECT ${cols.map((c) => '"' + c + '"').join(',')} FROM ${table}`).all(); } catch (e) { continue; }
    for (const r of rows) for (const c of cols) {
      const v = r[c]; if (v == null) continue;
      if (typeof v === 'string' && /^[\[{]/.test(v)) { try { walkJson(JSON.parse(v), add(table + '.' + c)); continue; } catch (e) { /* plain text */ } }
      add(table + '.' + c)(v);
    }
  }
  return strings;
}
// Stored texts the current glossary still leaves (partly) Arabic.
function residualStrings() {
  const tr = translator();
  const out = [];
  for (const [s, where] of collectStrings()) {
    const t = tr.translate(s);
    if (AR.test(t)) out.push({ ar: s, where, partial: t });
  }
  return out;
}

// ---------- machine translation (MyMemory free tier) ----------
const MT = {
  provider: (process.env.MT_PROVIDER || 'mymemory').toLowerCase(),   // 'mymemory' | 'off'
  url: process.env.MYMEMORY_URL || 'https://api.mymemory.translated.net/get',
  email: (process.env.MYMEMORY_EMAIL || '').trim(),                    // raises the free quota (5k -> 50k chars/day)
  chunk: 450,                                                          // MyMemory accepts up to 500 chars per call
  perRun: Math.max(1, +process.env.MT_PER_RUN || 40),
};
MT.dailyChars = +process.env.MT_DAILY_CHARS || (MT.email ? 45000 : 4500);
const enabled = () => MT.provider === 'mymemory';

const today = () => new Date().toISOString().slice(0, 10);
const metaGet = (k) => { const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(k); return r ? r.value : null; };
const metaSet = (k, v) => db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(k, String(v));
const usedToday = () => +(metaGet('mt_usage:' + today()) || 0);
const addUsage = (n) => metaSet('mt_usage:' + today(), usedToday() + n);
const lastRun = () => { try { return JSON.parse(metaGet('mt_last') || 'null'); } catch (e) { return null; } };
const setLast = (o) => metaSet('mt_last', JSON.stringify(o));

class QuotaError extends Error { constructor(m) { super(m || 'quota'); this.quota = true; } }

// Natural segments of a stored text (clauses between ؛ ; | — . , etc.).
function segments(text) {
  return String(text).split(/\s*[;؛|—\n]\s*|\s*·\s*|(?<=[.،,!?])\s+|\s+-\s+/).map((s) => s.trim()).filter(Boolean);
}
// Split a long text into chunks the API accepts, on natural boundaries.
function chunks(text) {
  const out = []; let cur = '';
  const parts = String(text).split(/(?<=[;؛|\n.!?])\s+|(?<=[،,])\s+/);
  for (const p of parts) {
    if (!p) continue;
    if ((cur + ' ' + p).trim().length <= MT.chunk) { cur = (cur + ' ' + p).trim(); continue; }
    if (cur) out.push(cur);
    if (p.length <= MT.chunk) { cur = p; continue; }
    for (let i = 0; i < p.length; i += MT.chunk) out.push(p.slice(i, i + MT.chunk));
    cur = '';
  }
  if (cur) out.push(cur);
  return out;
}
async function callMyMemory(q) {
  const u = new URL(MT.url);
  u.searchParams.set('q', q); u.searchParams.set('langpair', 'ar|en');
  if (MT.email) u.searchParams.set('de', MT.email);
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 12000);
  let res, data;
  try {
    res = await fetch(u, { signal: ctl.signal, headers: { 'User-Agent': 'UDC-DebitNotes/1.0' } });
    data = await res.json().catch(() => null);
  } finally { clearTimeout(timer); }
  if (res.status === 429 || res.status === 403 || (data && (data.quotaFinished === true || data.responseStatus === 429 || data.responseStatus === 403))) {
    throw new QuotaError((data && data.responseDetails) || ('HTTP ' + res.status));
  }
  const text = data && data.responseData && data.responseData.translatedText;
  if (!res.ok || !data || +data.responseStatus !== 200 || !text) throw new Error((data && data.responseDetails) || ('HTTP ' + res.status));
  if (/^MYMEMORY WARNING/i.test(text)) throw new QuotaError(text);
  return String(text).trim();
}
// Clean up the machine output a little (spacing, capital, ASCII digits).
function tidy(s) {
  s = ArEn.latinDigits(String(s || '')).replace(/\s+([,;:.)])/g, '$1').replace(/\(\s+/g, '(').replace(/\s{2,}/g, ' ').trim();
  return s && /^[a-z]/.test(s) ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
async function machineTranslate(text) {
  const parts = chunks(text);
  const need = parts.reduce((a, p) => a + p.length, 0);
  if (usedToday() + need > MT.dailyChars) throw new QuotaError('daily budget reached');
  const out = [];
  for (const p of parts) {
    if (!AR.test(p)) { out.push(p); continue; }
    out.push(await callMyMemory(p));
    addUsage(p.length);
  }
  return tidy(out.join(' '));
}

let running = false, pendingTimer = null;
// Translate stored texts the glossary cannot finish, a batch at a time.
async function runMachine(opts) {
  opts = opts || {};
  if (!enabled()) return { enabled: false, translated: 0 };
  if (running) return { enabled: true, busy: true, translated: 0 };
  running = true;
  const summary = { enabled: true, translated: 0, failed: 0, remaining: 0, quota: false, error: null, at: nowIso() };
  try {
    const has = db.prepare('SELECT 1 FROM mt_cache WHERE ar = ?');
    const ins = db.prepare('INSERT OR REPLACE INTO mt_cache (ar, en, provider, created_at) VALUES (?, ?, ?, ?)');
    // Only the segments the glossary cannot finish are sent (between ؛ ; | — .
    // etc.), so the free quota goes to genuinely new text and every translated
    // segment is reused inside any other text that contains it.
    const tr = translator();
    const seen = new Set();
    const todo = [];
    for (const r of residualStrings()) {
      for (const seg of segments(r.ar)) {
        const key = ArEn.norm(seg);
        if (!key || !AR.test(key) || seen.has(key) || has.get(key)) continue;
        if (!AR.test(tr.translate(key))) continue; // this segment is already covered
        seen.add(key); todo.push(key);
      }
    }
    // Shortest first: many small item names beat one long note on a tight budget.
    todo.sort((a, b) => a.length - b.length);
    const limit = Math.min(todo.length, opts.limit || MT.perRun);
    for (let i = 0; i < limit; i++) {
      const r = { ar: todo[i] };
      try {
        const en = await machineTranslate(r.ar);
        if (en && !AR.test(en)) { ins.run(r.ar, en, 'mymemory', nowIso()); summary.translated++; }
        else summary.failed++;
      } catch (e) {
        if (e.quota) { summary.quota = true; summary.error = e.message; break; }
        summary.failed++; summary.error = e.message;
        if (/fetch failed|ENOTFOUND|ECONNREFUSED|abort/i.test(String(e.message))) break; // offline: stop this run
      }
    }
    summary.remaining = Math.max(0, todo.length - summary.translated);
  } finally { running = false; }
  // A run that had nothing to do keeps the last meaningful summary.
  if (summary.translated || summary.failed || summary.quota || summary.error) setLast(summary);
  return summary;
}
// Debounced "something was saved": translate new text shortly after.
function touch() {
  if (!enabled()) return;
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => { runMachine().catch(() => {}); }, 3000);
}
function schedule() {
  if (!enabled()) return;
  setTimeout(() => { runMachine().catch(() => {}); }, 15000);
  setInterval(() => { runMachine().catch(() => {}); }, 10 * 60 * 1000).unref();
}
function machineStatus() {
  const cached = db.prepare('SELECT COUNT(*) n FROM mt_cache').get().n;
  return { provider: MT.provider, enabled: enabled(), emailSet: !!MT.email, dailyChars: MT.dailyChars, usedToday: usedToday(), cached, last: lastRun(), running };
}

module.exports = {
  ArEn, STATIC, merged, current, translator, versionKey, collectStrings, residualStrings,
  runMachine, touch, schedule, machineStatus, machineTranslate, enabled,
};
