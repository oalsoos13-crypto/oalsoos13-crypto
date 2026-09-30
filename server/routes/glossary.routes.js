'use strict';
// Admin glossary: Arabic -> English entries the admin adds from the UI. They
// sit on top of the shipped public/glossary_en.json and are served merged to
// every client, so a word translated once is rendered in English everywhere
// (tables, documents, exports). The "pending" list scans every free-text
// column in the database for Arabic words the merged glossary cannot yet
// translate, so the admin sees exactly what still needs an entry.
const express = require('express');
const path = require('path');
const db = require('../db');
const audit = require('../audit');
const { requireAuth, requireRole } = require('../auth');
const { asyncH, nowIso, badRequest } = require('../util');

const router = express.Router();
router.use(requireAuth);

db.exec(`CREATE TABLE IF NOT EXISTS glossary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ar TEXT NOT NULL UNIQUE,
  en TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'word',   -- word | phrase | exact
  created_by INTEGER, created_at TEXT, updated_at TEXT
)`);

const ArEn = require(path.join(__dirname, '..', '..', 'public', 'ar-en.js'));
let STATIC = { exact: {}, phrases: {}, words: {} };
try { STATIC = require(path.join(__dirname, '..', '..', 'public', 'glossary_en.json')); } catch (e) { /* optional */ }

const KINDS = new Set(['word', 'phrase', 'exact']);
const AR_RUN = /[؀-ۿ]+/g;

// The shipped glossary with the admin's entries layered on top.
function merged() {
  const g = { exact: Object.assign({}, STATIC.exact), phrases: Object.assign({}, STATIC.phrases), words: Object.assign({}, STATIC.words) };
  for (const r of db.prepare('SELECT ar, en, kind FROM glossary').all()) {
    const bucket = r.kind === 'exact' ? g.exact : r.kind === 'phrase' ? g.phrases : g.words;
    bucket[r.ar] = r.en;
  }
  return g;
}
let cache = null; // { g, translator, stamp }
function current() {
  const stamp = db.prepare('SELECT COUNT(*) n, MAX(updated_at) u FROM glossary').get();
  const key = stamp.n + '|' + (stamp.u || '');
  if (!cache || cache.key !== key) { const g = merged(); cache = { key, g, tr: ArEn.make(g) }; }
  return cache;
}
function translator() { return current().tr; }

// GET /api/glossary -> merged glossary for the client translator.
router.get('/glossary', asyncH((req, res) => {
  const c = current();
  res.json({ version: c.key, glossary: c.g });
}));

// GET /api/glossary/entries?q= -> the admin's own entries.
router.get('/glossary/entries', requireRole(), asyncH((req, res) => {
  const q = String(req.query.q || '').trim();
  const rows = q
    ? db.prepare('SELECT * FROM glossary WHERE ar LIKE ? OR en LIKE ? ORDER BY updated_at DESC LIMIT 500').all('%' + q + '%', '%' + q + '%')
    : db.prepare('SELECT * FROM glossary ORDER BY updated_at DESC LIMIT 500').all();
  res.json({ entries: rows, total: db.prepare('SELECT COUNT(*) n FROM glossary').get().n, shipped: Object.keys(STATIC.words).length + Object.keys(STATIC.phrases).length + Object.keys(STATIC.exact).length });
}));

// POST /api/glossary { ar, en, kind } -> add or update one entry.
router.post('/glossary', requireRole(), asyncH((req, res) => {
  const ar = ArEn.norm(req.body.ar);
  const en = String(req.body.en || '').replace(/\s+/g, ' ').trim();
  const kind = KINDS.has(req.body.kind) ? req.body.kind : (/\s/.test(ar) ? 'phrase' : 'word');
  if (!ar || !/[؀-ۿ]/.test(ar)) throw badRequest('أدخل النص العربي | Enter the Arabic text', 'NO_AR');
  if (!en) throw badRequest('أدخل الترجمة الإنجليزية | Enter the English translation', 'NO_EN');
  const now = nowIso();
  db.prepare(`INSERT INTO glossary (ar, en, kind, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(ar) DO UPDATE SET en = excluded.en, kind = excluded.kind, updated_at = excluded.updated_at`).run(ar, en, kind, req.user.id, now, now);
  audit.fromReq(req, 'glossary.set', { entityType: 'glossary', entityId: ar, summary: `Glossary: ${ar} -> ${en}`, details: { ar, en, kind } });
  res.json({ ok: true });
}));

// POST /api/glossary/bulk { entries: [{ar, en, kind}] } -> several at once.
router.post('/glossary/bulk', requireRole(), asyncH((req, res) => {
  const list = Array.isArray(req.body.entries) ? req.body.entries : [];
  const now = nowIso(); let n = 0;
  const ins = db.prepare(`INSERT INTO glossary (ar, en, kind, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(ar) DO UPDATE SET en = excluded.en, kind = excluded.kind, updated_at = excluded.updated_at`);
  db.transaction(() => {
    for (const e of list) {
      const ar = ArEn.norm(e && e.ar), en = String((e && e.en) || '').replace(/\s+/g, ' ').trim();
      if (!ar || !en || !/[؀-ۿ]/.test(ar)) continue;
      const kind = KINDS.has(e.kind) ? e.kind : (/\s/.test(ar) ? 'phrase' : 'word');
      ins.run(ar, en, kind, req.user.id, now, now); n++;
    }
  })();
  if (n) audit.fromReq(req, 'glossary.bulk', { entityType: 'glossary', summary: `Glossary: ${n} entries saved` });
  res.json({ ok: true, saved: n });
}));

// DELETE /api/glossary/:id
router.delete('/glossary/:id', requireRole(), asyncH((req, res) => {
  const r = db.prepare('SELECT * FROM glossary WHERE id = ?').get(req.params.id);
  if (r) {
    db.prepare('DELETE FROM glossary WHERE id = ?').run(r.id);
    audit.fromReq(req, 'glossary.delete', { entityType: 'glossary', entityId: r.ar, summary: `Glossary: removed ${r.ar}` });
  }
  res.json({ ok: true });
}));

// POST /api/glossary/try { text } -> how the current glossary renders a text.
router.post('/glossary/try', asyncH((req, res) => {
  res.json({ en: translator().translate(String(req.body.text || '')) });
}));

// Every free-text column that can hold Arabic entered by users.
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
// GET /api/glossary/pending -> Arabic words the merged glossary leaves untranslated.
router.get('/glossary/pending', requireRole(), asyncH((req, res) => {
  const tr = translator();
  const strings = new Map(); // text -> where
  const add = (where) => (v) => {
    if (typeof v !== 'string' || !/[؀-ۿ]/.test(v)) return;
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
  const words = new Map(); // residual word -> { count, examples:Set, where:Set }
  let translated = 0;
  for (const [s, where] of strings) {
    const out = tr.translate(s);
    const left = out.match(AR_RUN);
    if (!left) { translated++; continue; }
    for (const w of new Set(left)) {
      if (!words.has(w)) words.set(w, { ar: w, count: 0, examples: [], where: new Set() });
      const e = words.get(w); e.count++; e.where.add(where);
      if (e.examples.length < 3) e.examples.push(s.length > 90 ? s.slice(0, 90) + '…' : s);
    }
  }
  const pending = [...words.values()].sort((a, b) => b.count - a.count).map((e) => ({ ar: e.ar, count: e.count, examples: e.examples, where: [...e.where] }));
  res.json({ strings: strings.size, translated, pending });
}));

module.exports = router;
module.exports.translator = translator;
