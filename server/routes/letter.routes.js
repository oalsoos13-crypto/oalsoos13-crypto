'use strict';
const express = require('express');
const db = require('../db');
const config = require('../config');
const audit = require('../audit');
const { requireAuth, requireRole } = require('../auth');
const { asyncH, genId, nowIso, num, toJson, badRequest, notFound, forbidden } = require('../util');
const { SEED } = require('../seed-data');

const router = express.Router();
router.use(requireAuth);

const typeMode = Object.fromEntries(SEED.letterTypes.map((t) => [t.k, t.mode]));
const getCoop = db.prepare('SELECT mains FROM coops WHERE name = ?');

function nextCounter() {
  // Atomic increment + return (RETURNING supported by better-sqlite3 / SQLite >= 3.35).
  const row = db.prepare('UPDATE counters SET value = value + 1 WHERE name = ? RETURNING value').get('lysal');
  return row.value - 1; // the value BEFORE increment is the one assigned
}
function refNo(n) {
  return 'LYSAL/' + n + '/' + config.refYear;
}

// Recompute the letter value server-side (never trust the client figure).
function computeValue(type, body, coopName) {
  const mode = typeMode[type];
  if (mode === 'items') {
    const c = getCoop.get(coopName);
    const mains = c ? c.mains : 0;
    const items = Array.isArray(body.items) ? body.items : [];
    const perOutlet = items.reduce((s, it) => s + num(it.price), 0);
    return { value: perOutlet * mains, items: items.map((it) => ({ name: it.name || '', price: num(it.price) })) };
  }
  if (mode === 'pct') {
    const base = num(body.base), pct = num(body.pct);
    return { value: (base * pct) / 100, base, pct };
  }
  return { value: num(body.value) };
}

// POST /api/letters  (salesman) — create a letter (auto-assigns LYSAL number).
router.post('/letters', requireRole('salesman'), asyncH((req, res) => {
  const type = String(req.body.type || '');
  if (!typeMode[type]) throw badRequest('نوع الكتاب غير صحيح', 'BAD_TYPE');
  const coop = req.body.coop || '';
  // Salesmen may only file under their own name; admin may specify.
  const sales = req.user.role === 'salesman' ? req.user.name : (req.body.sales || req.user.name);

  const calc = computeValue(type, req.body, coop);
  if (!calc.value) throw badRequest('أدخل القيمة / الأصناف', 'NO_VALUE');

  const id = genId('L');
  const now = nowIso();
  const num_ = nextCounter();
  const lysal = refNo(num_);

  db.prepare(`INSERT INTO letters
      (id, num, lysal, type, coop, brand, sales, date, principal, note, value, base, pct, items, status, created_by, created_at)
      VALUES (@id,@num,@lysal,@type,@coop,@brand,@sales,@date,@principal,@note,@value,@base,@pct,@items,'pending',@by,@now)`)
    .run({
      id, num: num_, lysal, type, coop,
      brand: req.body.brand || '', sales,
      date: req.body.date || now.slice(0, 10),
      principal: req.body.principal || '', note: req.body.note || '',
      value: calc.value, base: calc.base ?? null, pct: calc.pct ?? null,
      items: calc.items ? toJson(calc.items) : null,
      by: req.user.id, now,
    });

  audit.fromReq(req, 'letter.create', {
    entityType: 'letter', entityId: id,
    summary: `Created letter ${lysal} (${type}, ${coop}, ${calc.value})`,
    details: { lysal, type, coop, brand: req.body.brand || '', sales, value: calc.value },
  });
  const created = db.prepare('SELECT * FROM letters WHERE id = ?').get(id);
  res.json({ ok: true, id, lysal, num: num_, value: calc.value, letter: created });
}));

// DELETE /api/letters/:id  (salesman own draft, or admin)
router.delete('/letters/:id', requireRole('salesman'), asyncH((req, res) => {
  const L = db.prepare('SELECT * FROM letters WHERE id = ?').get(req.params.id);
  if (!L) throw notFound('الكتاب غير موجود');
  if (req.user.role !== 'admin' && L.sales !== req.user.name) throw forbidden('لا يمكنك حذف كتاب مندوب آخر');
  if (L.status === 'noted') throw badRequest('لا يمكن حذف كتاب صدر عنه إشعار خصم', 'HAS_NOTE');
  db.prepare('DELETE FROM letters WHERE id = ?').run(req.params.id);
  audit.fromReq(req, 'letter.delete', {
    entityType: 'letter', entityId: req.params.id,
    summary: `Deleted letter ${L.lysal}`, details: { lysal: L.lysal, value: L.value },
  });
  res.json({ ok: true });
}));

module.exports = router;
