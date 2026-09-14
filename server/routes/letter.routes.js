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

// The set of co-op (parent) names a salesman/supervisor may address, derived
// from the outlets master via their PF code. null == unrestricted (management).
const cleanCoop = (p) => String(p || '').replace(/^P\d+\s*-\s*/i, '').trim();
function scopeCoopSet(user) {
  let col = null;
  if (user.role === 'salesman') col = 'salesman_pf';
  else if (user.role === 'supervisor') col = 'fsm_pf';
  else return null;
  const rows = db.prepare(`SELECT DISTINCT parent FROM outlets WHERE ${col} = ?`).all(user.username);
  return new Set(rows.map((r) => cleanCoop(r.parent)).filter(Boolean));
}

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
  else if (spec.valueMode === 'listingdn') {
    // Per item: carton price, or consumer piece x pack; times the bonus ratio.
    const mode = String(meta.calcMode || 'carton');
    const ratio = num(meta.ratio) || 1;
    const base = (items || []).reduce((s, r) => s + (mode === 'piece' ? num(r.consPiece) * num(r.pack) : num(r.coopCarton)), 0);
    value = base * ratio;
  } else if (spec.valueMode && spec.valueMode.startsWith('sum:')) {
    const col = spec.valueMode.slice(4);
    value = (items || []).reduce((s, r) => s + num(r[col]), 0);
  }
  return { value, items, meta };
}

// Recompute the letter value server-side (never trust the client figure).
function computeValue(type, body, coopName, recipient) {
  const mode = typeMode[type];
  if (mode === 'pricetable') {
    return { value: 0, items: sanitizePriceRows(body.priceRows || body.items) };
  }
  if (mode === 'items') {
    // Addressed to a single outlet (scoped salesman) -> multiplier of 1;
    // otherwise multiply the per-outlet total by the co-op's main-outlet count.
    const c = getCoop.get(coopName);
    const mains = recipient ? 1 : (c ? c.mains : 0);
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
    if (spec.recipient === 'coop') { recipient = req.body.recipient ? String(req.body.recipient).trim() : null; }
    else if (spec.recipient === 'fixed') { recipient = spec.recipientFixed; coop = ''; }
    else { recipient = String(req.body.recipient || spec.recipientDefault || '').trim(); coop = ''; }
    const r = computeSpec(spec, req.body);
    if (spec.table && (!r.items || !r.items.length)) throw badRequest('أضف صفًا واحدًا على الأقل للجدول', 'NO_ROWS');
    if (spec.valueMode === 'direct' && !r.value) throw badRequest('أدخل القيمة', 'NO_VALUE');
    calc = { value: r.value, items: r.items };
    // Listing debit note: value comes from the co-op's stored calc terms.
    if (type === 'listing_dn') {
      try { calc.value = require('./tracking.routes').listingValue(coop, r.items); } catch (e) { /* keep spec value */ }
    }
    metaJson = toJson(r.meta);
  } else {
    // Classic co-op letters: the salesman picks a co-op then a specific outlet,
    // which becomes the addressed recipient.
    recipient = req.body.recipient ? String(req.body.recipient).trim() : null;
    calc = computeValue(type, req.body, coop, recipient);
    if (mode === 'pricetable') {
      if (!calc.items || !calc.items.length) throw badRequest('أضف صنفًا واحدًا على الأقل للجدول', 'NO_ROWS');
    } else if (!calc.value) {
      throw badRequest('أدخل القيمة / الأصناف', 'NO_VALUE');
    }
  }

  // Enforce recipient scope for field users: the co-op must be one they cover.
  const allowed = scopeCoopSet(req.user);
  if (allowed && coop && !allowed.has(coop)) {
    throw forbidden('لا يمكنك إصدار كتاب لجمعية خارج نطاقك', 'SCOPE');
  }

  // Salesmen file under their own name; others may specify.
  const sales = req.user.role === 'salesman' ? req.user.name : (req.body.sales || req.user.name);
  const id = genId('L');
  const now = nowIso();
  const num_ = nextCounter();
  const lysal = refNo(num_);

  // Salesmen's letters need supervisor approval before printing; letters made
  // by management are approved on creation.
  const approval = req.user.role === 'salesman' ? 'pending' : 'approved';
  const custId = String(req.body.custId || '').trim() || null;
  db.prepare(`INSERT INTO letters
      (id, num, lysal, type, coop, brand, sales, date, principal, note, value, base, pct, items, recipient, meta, cust_id, status, approval, approved_by, approved_at, created_by, created_at)
      VALUES (@id,@num,@lysal,@type,@coop,@brand,@sales,@date,@principal,@note,@value,@base,@pct,@items,@recipient,@meta,@custId,'pending',@approval,@appBy,@appAt,@by,@now)`)
    .run({
      id, num: num_, lysal, type, coop,
      brand: req.body.brand || '', sales,
      date: req.body.date || now.slice(0, 10),
      principal: req.body.principal || '', note: req.body.note || '',
      value: calc.value, base: calc.base ?? null, pct: calc.pct ?? null,
      items: calc.items ? toJson(calc.items) : null,
      recipient, meta: metaJson, custId,
      approval, appBy: approval === 'approved' ? req.user.id : null, appAt: approval === 'approved' ? now : null,
      by: req.user.id, now,
    });

  // Price-increase letters feed the price-update tracker automatically.
  const PRICE_TYPES = ['changeprice', 'priceupd', 'uoc_union'];
  if (PRICE_TYPES.includes(type) && Array.isArray(calc.items) && calc.items.length) {
    try { require('./tracking.routes').addPriceProductsFromItems(calc.items, lysal, req.user.id); } catch (e) { /* non-fatal */ }
  }

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

// A supervisor may only moderate letters whose co-op is within their scope;
// management may moderate any.
function assertCanModerate(req, L) {
  if (['marketing', 'division', 'admin'].includes(req.user.role)) return;
  if (req.user.role === 'supervisor') {
    const allowed = scopeCoopSet(req.user);
    const c = cleanCoop(L.coop);
    if (allowed && c && allowed.has(c)) return;
    throw forbidden('لا يمكنك اعتماد كتاب خارج نطاقك', 'SCOPE');
  }
  throw forbidden('غير مصرح', 'ROLE');
}

// POST /api/letters/:id/approve — supervisor/management approve; enables print.
router.post('/letters/:id/approve', requireRole('supervisor', 'marketing', 'division'), asyncH((req, res) => {
  const L = db.prepare('SELECT * FROM letters WHERE id = ?').get(req.params.id);
  if (!L) throw notFound('الكتاب غير موجود');
  assertCanModerate(req, L);
  const now = nowIso();
  db.prepare("UPDATE letters SET approval='approved', approved_by=?, approved_at=?, rejected_by=NULL, rejected_at=NULL, reject_reason=NULL, updated_at=? WHERE id=?")
    .run(req.user.id, now, now, L.id);
  audit.fromReq(req, 'letter.approve', { entityType: 'letter', entityId: L.id, summary: `Approved letter ${L.lysal}` });
  res.json({ ok: true });
}));

// POST /api/letters/:id/reject — supervisor/management reject with a reason.
router.post('/letters/:id/reject', requireRole('supervisor', 'marketing', 'division'), asyncH((req, res) => {
  const L = db.prepare('SELECT * FROM letters WHERE id = ?').get(req.params.id);
  if (!L) throw notFound('الكتاب غير موجود');
  assertCanModerate(req, L);
  const reason = String(req.body.reason || '').trim();
  const now = nowIso();
  db.prepare("UPDATE letters SET approval='rejected', rejected_by=?, rejected_at=?, reject_reason=?, updated_at=? WHERE id=?")
    .run(req.user.id, now, reason, now, L.id);
  audit.fromReq(req, 'letter.reject', { entityType: 'letter', entityId: L.id, summary: `Rejected letter ${L.lysal}`, details: { reason } });
  res.json({ ok: true });
}));

module.exports = router;
