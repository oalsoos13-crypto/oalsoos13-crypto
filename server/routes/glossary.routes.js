'use strict';
// Admin glossary API (see glossary-core.js for the layers and the machine
// translation). Every client fetches the merged glossary; the admin manages
// entries, sees what is still untranslated and drives the machine translator.
const express = require('express');
const audit = require('../audit');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { asyncH, nowIso, badRequest } = require('../util');
const core = require('../glossary-core');

const router = express.Router();
router.use(requireAuth);

const KINDS = new Set(['word', 'phrase', 'exact']);
const AR = /[؀-ۿ]/;

// GET /api/glossary -> merged glossary for the client translator.
router.get('/glossary', asyncH((req, res) => { const c = core.current(); res.json({ version: c.key, glossary: c.g }); }));
// GET /api/glossary/version -> cheap change check.
router.get('/glossary/version', asyncH((req, res) => { res.json({ version: core.versionKey() }); }));

// GET /api/glossary/entries?q= -> the admin's own entries.
router.get('/glossary/entries', requireRole(), asyncH((req, res) => {
  const q = String(req.query.q || '').trim();
  const rows = q
    ? db.prepare('SELECT * FROM glossary WHERE ar LIKE ? OR en LIKE ? ORDER BY updated_at DESC LIMIT 500').all('%' + q + '%', '%' + q + '%')
    : db.prepare('SELECT * FROM glossary ORDER BY updated_at DESC LIMIT 500').all();
  const S = core.STATIC;
  res.json({ entries: rows, total: db.prepare('SELECT COUNT(*) n FROM glossary').get().n, shipped: Object.keys(S.words).length + Object.keys(S.phrases).length + Object.keys(S.exact).length });
}));

const upsert = db.prepare(`INSERT INTO glossary (ar, en, kind, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(ar) DO UPDATE SET en = excluded.en, kind = excluded.kind, updated_at = excluded.updated_at`);
function cleanEntry(e) {
  const ar = core.ArEn.norm(e && e.ar);
  const en = String((e && e.en) || '').replace(/\s+/g, ' ').trim();
  const kind = e && KINDS.has(e.kind) ? e.kind : (/\s/.test(ar) ? 'phrase' : 'word');
  return { ar, en, kind };
}
// POST /api/glossary { ar, en, kind } -> add or update one entry.
router.post('/glossary', requireRole(), asyncH((req, res) => {
  const { ar, en, kind } = cleanEntry(req.body);
  if (!ar || !AR.test(ar)) throw badRequest('أدخل النص العربي | Enter the Arabic text', 'NO_AR');
  if (!en) throw badRequest('أدخل الترجمة الإنجليزية | Enter the English translation', 'NO_EN');
  const now = nowIso();
  upsert.run(ar, en, kind, req.user.id, now, now);
  audit.fromReq(req, 'glossary.set', { entityType: 'glossary', entityId: ar, summary: `Glossary: ${ar} -> ${en}`, details: { ar, en, kind } });
  res.json({ ok: true });
}));
// POST /api/glossary/bulk { entries: [{ar, en, kind}] }
router.post('/glossary/bulk', requireRole(), asyncH((req, res) => {
  const list = Array.isArray(req.body.entries) ? req.body.entries : [];
  const now = nowIso(); let n = 0;
  db.transaction(() => {
    for (const e of list) { const { ar, en, kind } = cleanEntry(e); if (!ar || !en || !AR.test(ar)) continue; upsert.run(ar, en, kind, req.user.id, now, now); n++; }
  })();
  if (n) audit.fromReq(req, 'glossary.bulk', { entityType: 'glossary', summary: `Glossary: ${n} entries saved` });
  res.json({ ok: true, saved: n });
}));
// DELETE /api/glossary/:id
router.delete('/glossary/:id', requireRole(), asyncH((req, res) => {
  const r = db.prepare('SELECT * FROM glossary WHERE id = ?').get(req.params.id);
  if (r) { db.prepare('DELETE FROM glossary WHERE id = ?').run(r.id); audit.fromReq(req, 'glossary.delete', { entityType: 'glossary', entityId: r.ar, summary: `Glossary: removed ${r.ar}` }); }
  res.json({ ok: true });
}));
// POST /api/glossary/try { text } -> how the current glossary renders a text.
router.post('/glossary/try', asyncH((req, res) => { res.json({ en: core.translator().translate(String(req.body.text || '')) }); }));

// GET /api/glossary/pending -> Arabic words the merged glossary leaves untranslated.
router.get('/glossary/pending', requireRole(), asyncH((req, res) => {
  const all = core.collectStrings().size;
  const res_ = core.residualStrings();
  const words = new Map();
  for (const r of res_) {
    for (const w of new Set(r.partial.match(/[؀-ۿ]+/g) || [])) {
      if (!words.has(w)) words.set(w, { ar: w, count: 0, examples: [], where: new Set() });
      const e = words.get(w); e.count++; e.where.add(r.where);
      if (e.examples.length < 3) e.examples.push(r.ar.length > 90 ? r.ar.slice(0, 90) + '…' : r.ar);
    }
  }
  const pending = [...words.values()].sort((a, b) => b.count - a.count).map((e) => ({ ar: e.ar, count: e.count, examples: e.examples, where: [...e.where] }));
  res.json({ strings: all, translated: all - res_.length, pending, machine: core.machineStatus() });
}));

// ---- machine translation (MyMemory) ----
router.get('/glossary/machine', requireRole(), asyncH((req, res) => { res.json(core.machineStatus()); }));
router.post('/glossary/machine/run', requireRole(), asyncH(async (req, res) => {
  const r = await core.runMachine({ limit: Math.min(200, +req.body.limit || 60) });
  if (r.translated) audit.fromReq(req, 'glossary.machine', { entityType: 'glossary', summary: `Machine-translated ${r.translated} texts` });
  res.json(Object.assign({ status: core.machineStatus() }, r));
}));
router.get('/glossary/machine/list', requireRole(), asyncH((req, res) => {
  const q = String(req.query.q || '').trim();
  const rows = q
    ? db.prepare('SELECT * FROM mt_cache WHERE ar LIKE ? OR en LIKE ? ORDER BY created_at DESC LIMIT 300').all('%' + q + '%', '%' + q + '%')
    : db.prepare('SELECT * FROM mt_cache ORDER BY created_at DESC LIMIT 300').all();
  res.json({ rows, total: db.prepare('SELECT COUNT(*) n FROM mt_cache').get().n });
}));
router.post('/glossary/machine/delete', requireRole(), asyncH((req, res) => {
  db.prepare('DELETE FROM mt_cache WHERE ar = ?').run(String(req.body.ar || ''));
  res.json({ ok: true });
}));
// POST /api/glossary/machine/text { text } -> translate one text now (no caching).
router.post('/glossary/machine/text', requireRole(), asyncH(async (req, res) => {
  if (!core.enabled()) throw badRequest('الترجمة الآلية غير مفعّلة | Machine translation is off', 'MT_OFF');
  try { res.json({ en: await core.machineTranslate(String(req.body.text || '')) }); }
  catch (e) { throw badRequest((e.quota ? 'انتهت حصة اليوم المجانية | Free quota for today is used up' : 'تعذّر الاتصال بخدمة الترجمة | Could not reach the translation service') + ': ' + e.message, e.quota ? 'MT_QUOTA' : 'MT_FAIL'); }
}));

module.exports = router;
module.exports.translator = core.translator;
