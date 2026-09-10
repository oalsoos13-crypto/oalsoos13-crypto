'use strict';
const express = require('express');
const db = require('../db');
const config = require('../config');
const audit = require('../audit');
const { requireAuth, requireRole } = require('../auth');
const { asyncH, genId, nowIso, num, toJson, badRequest, notFound, forbidden } = require('../util');
const { SEED } = require('../seed-data');
const { SPEC_BY_KEY } = require('../letter-specs');

const router = express.Router();
router.use(requireAuth);

const typeMode = Object.fromEntries(SEED.letterTypes.map((t) => [t.k, t.mode]));
function modeOf(type) {
  if (typeMode[type]) return typeMode[type];
  if (SPEC_BY_KEY[type]) return 'spec';
  return null;
}
const getCoop = db.prepare('SELECT mains FROM coops WHERE name = ?');

function nextCounter() {
  // Atomic increment + return (RETURNING supported by better-sqlite3 / SQLite >= 3.35).
  const row = db.prepare('UPDATE counters SET value = value + 1 WHERE name = ? RETURNING value').get('lysal');
  return row.value - 1; // the value BEFORE increment is the one assigned
}
function refNo(n) {
  return 'LYSAL/' + n + '/' + config.refYear;
}

// A price-update / "change price" letter carries a table of items instead of a
// monetary debit value. Sanitize and store the rows; value is 0 (not a debit note).
function sanitizePriceRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 200).map((r) => ({
    item: String(r.item || '').slice(0, 40),
    name: String(r.name || '').slice(0, 200),
    pack: String(r.pack || '').slice(0, 60),
    coopOld: num(r.coopOld), coopNew: num(r.coopNew),
    consOld: num(r.consOld), consNew: num(r.consNew),
    barcode: String(r.barcode || '').slice(0, 40),
  })).filter((r) => r.name || r.item || r.barcode);
}

// Sanitize table rows against a spec column list (keep known keys, coerce numbers).
function sanitizeSpecRows(cols, rows) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 300).map((r) => {
    const o = {};
    for (const c of cols) o[c.key] = c.type === 'num' ? num(r[c.key]) : String(r[c.key] == null ? '' : r[c.key]).slice(0, 300);
    return o;
  }).filter((r) => cols.some((c) => r[c.key] !== '' && r[c.key] !== 0 && r[c.key] != null));
}

// Compute a spec-driven letter: value (per valueMode), items (primary table),
// and meta (scalar fields + secondary table).
function computeSpec(spec, body) {
  const items = spec.table ? sanitizeSpecRows(spec.table.cols, body.rows || body.items) : null;
  const meta = {};
  for (const f of spec.fields || []) meta[f.key] = f.type === 'number' ? num(body.fields && body.fields[f.key]) : String((body.fields && body.fields[f.key]) || '');
  if (spec.table2) meta.rows2 = sanitizeSpecRows(spec.table2.cols, body.rows2);
  let value = 0;
  if (spec.valueMode === 'direct') value = num(meta.value != null ? meta.value : body.value);
  else if (spec.valueMode && spec.valueMode.startsWith('sum:')) {
    const col = spec.valueMode.slice(4);
    value = (items || []).reduce((s, r) => s + num(r[col]), 0);
  }
  return { value, items, meta };
}

// Recompute the letter value server-side (never trust the client figure).
function computeValue(type, body, coopName) {
  const mode = typeMode[type];
  if (mode === 'pricetable') {
    return { value: 0, items: sanitizePriceRows(body.priceRows || body.items) };
  }
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

// POST /api/letters — create a letter (auto-assigns LYSAL number).
// Salesmen create co-op letters; management may also create the spec letters.
router.post('/letters', requireRole('salesman', 'marketing', 'division'), asyncH((req, res) => {
  const type = String(req.body.type || '');
  const mode = modeOf(type);
  if (!mode) throw badRequest('نوع الكتاب غير صحيح', 'BAD_TYPE');

  let coop = req.body.coop || '';
  let recipient = null;
  let calc, metaJson = null;

  if (mode === 'spec') {
    const spec = SPEC_BY_KEY[type];
    if (spec.recipient === 'coop') { recipient = null; }
    else if (spec.recipient === 'fixed') { recipient = spec.recipientFixed; coop = ''; }
    else { recipient = String(req.body.recipient || spec.recipientDefault || '').trim(); coop = ''; }
    const r = computeSpec(spec, req.body);
    if (spec.table && (!r.items || !r.items.length)) throw badRequest('أضف صفًا واحدًا على الأقل للجدول', 'NO_ROWS');
    if (spec.valueMode === 'direct' && !r.value) throw badRequest('أدخل القيمة', 'NO_VALUE');
    calc = { value: r.value, items: r.items };
    metaJson = toJson(r.meta);
  } else {
    calc = computeValue(type, req.body, coop);
    if (mode === 'pricetable') {
      if (!calc.items || !calc.items.length) throw badRequest('أضف صنفًا واحدًا على الأقل للجدول', 'NO_ROWS');
    } else if (!calc.value) {
      throw badRequest('أدخل القيمة / الأصناف', 'NO_VALUE');
    }
  }

  // Salesmen file under their own name; others may specify.
  const sales = req.user.role === 'salesman' ? req.user.name : (req.body.sales || req.user.name);
  const id = genId('L');
  const now = nowIso();
  const num_ = nextCounter();
  const lysal = refNo(num_);

  db.prepare(`INSERT INTO letters
      (id, num, lysal, type, coop, brand, sales, date, principal, note, value, base, pct, items, recipient, meta, status, created_by, created_at)
      VALUES (@id,@num,@lysal,@type,@coop,@brand,@sales,@date,@principal,@note,@value,@base,@pct,@items,@recipient,@meta,'pending',@by,@now)`)
    .run({
      id, num: num_, lysal, type, coop,
      brand: req.body.brand || '', sales,
      date: req.body.date || now.slice(0, 10),
      principal: req.body.principal || '', note: req.body.note || '',
      value: calc.value, base: calc.base ?? null, pct: calc.pct ?? null,
      items: calc.items ? toJson(calc.items) : null,
      recipient, meta: metaJson,
      by: req.user.id, now,
    });

  audit.fromReq(req, 'letter.create', {
    entityType: 'letter', entityId: id,
    summary: `Created letter ${lysal} (${type}, ${coop || recipient || ''}, ${calc.value})`,
    details: { lysal, type, coop, recipient, brand: req.body.brand || '', sales, value: calc.value },
  });
  const created = db.prepare('SELECT * FROM letters WHERE id = ?').get(id);
  res.json({ ok: true, id, lysal, num: num_, value: calc.value, letter: created });
}));

// DELETE /api/letters/:id  (own draft, or admin)
router.delete('/letters/:id', requireRole('salesman', 'marketing', 'division'), asyncH((req, res) => {
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
