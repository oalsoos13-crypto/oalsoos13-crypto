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
// Union circular master (barcode -> registered carton/piece price + circular).
// The Union price is a CEILING ("الحد الأعلى لسعر الشراء"); billing above it, or
// billing an unregistered item, is flagged when a letter carries an item table.
let UNION_PRICES = {};
try { UNION_PRICES = require('../union_prices.json'); } catch (e) { UNION_PRICES = {}; }
const bnorm = (s) => { const d = String(s == null ? '' : s).replace(/\D/g, ''); return d ? String(parseInt(d, 10)) : ''; };
function itemPriceWarnings(items) {
  const out = [];
  if (!Array.isArray(items) || !items.length) return out;
  let above = 0, unreg = 0, checked = 0;
  for (const it of items) {
    const bc = bnorm(it.barcode);
    if (!bc) continue;
    const u = UNION_PRICES[bc];
    const price = num(it.coopCarton);
    if (!u) { unreg++; continue; }
    checked++;
    if (price > 0 && u.carton > 0 && price > u.carton * 1.02) above++;
  }
  if (above) out.push({ code: 'PRICE_ABOVE_CEILING', msg: `${above} صنف بسعر أعلى من سقف تعميم الاتحاد` });
  if (unreg) out.push({ code: 'ITEM_UNREGISTERED', msg: `${unreg} صنف غير مسجّل بتعميم الاتحاد` });
  return out;
}

const getCoop = db.prepare('SELECT code, mains, listing_markets FROM coops WHERE name = ?');
const getCoopContracts = db.prepare(
  "SELECT value_mode, pct, value, value_kind, period_from, period_to, status FROM contract_hdr WHERE pcode = ? AND kind <> 'addendum'"
);

// Letter types whose cost the contract percentage already bundles (clause 3 +
// the % decomposition: rent + festivals + price-diff + listing + returns). When
// a co-op is on a percentage/CDA contract, billing these separately is a
// potential double-charge and is flagged (never blocked).
const BUNDLED_TYPES = new Set([
  'priceoff', 'listing', 'listing_dn', 'listing_supp', 'stand', 'pallet',
  'rentstand', 'rentdebit', 'priceupd', 'changeprice',
]);
// Types that themselves ARE the contract percentage being drawn down.
const REBATE_TYPES = new Set(['cda_pct']);

// Non-blocking contract-compliance checks surfaced on the create response.
function contractWarnings(coopName, type, body, value, dateStr) {
  const out = [];
  if (!coopName) return out;
  const c = getCoop.get(coopName);
  if (!c || !c.code) return out;
  const rows = getCoopContracts.all(c.code);
  if (!rows.length) { out.push({ code: 'NO_CONTRACT', msg: 'لا يوجد عقد مسجّل لهذه الجمعية' }); return out; }
  const date = String(dateStr || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  // Governing contract: one whose period covers the letter date, else the most
  // recent by end date.
  const covering = rows.filter((r) => (!r.period_from || r.period_from <= date) && (!r.period_to || r.period_to >= date));
  const gov = covering[0] || rows.slice().sort((a, b) => String(b.period_to || '').localeCompare(String(a.period_to || '')))[0];
  if (!covering.length && gov && gov.period_to) {
    out.push({ code: 'EXPIRED_CONTRACT', msg: `العقد الحاكم منتهٍ (انتهى ${gov.period_to}) — يُفوتَر بلا عقد ساري` });
  }
  const pctContract = rows.find((r) => r.value_mode === 'pct' && r.pct > 0);
  if (pctContract) {
    // Rate over-claim: a rebate letter billed above the contracted percentage.
    if (REBATE_TYPES.has(type)) {
      const asked = num(body.pct);
      if (asked > 0 && asked > pctContract.pct + 0.001) {
        out.push({ code: 'RATE_OVERCLAIM', msg: `النسبة المطلوبة ${asked}% أعلى من نسبة العقد ${pctContract.pct}%` });
      }
    } else if (BUNDLED_TYPES.has(type)) {
      out.push({ code: 'BUNDLED_IN_PCT', msg: `هذا البند مغطّى بنسبة العقد (${pctContract.pct}%) — احذر الدفع المزدوج` });
    }
  }
  return out;
}

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
function computeSpec(spec, body, coopName, recipient) {
  const items = spec.table ? sanitizeSpecRows(spec.table.cols, body.rows || body.items) : null;
  const meta = {};
  for (const f of spec.fields || []) meta[f.key] = f.type === 'number' ? num(body.fields && body.fields[f.key]) : String((body.fields && body.fields[f.key]) || '');
  if (spec.table2) meta.rows2 = sanitizeSpecRows(spec.table2.cols, body.rows2);
  // Selectable signatory (e.g. which general manager signs the Union letter).
  if (Array.isArray(spec.signChoices) && spec.signChoices.length) {
    let i = parseInt(body.signIdx, 10); if (isNaN(i) || i < 0 || i >= spec.signChoices.length) i = 0;
    const s = spec.signChoices[i];
    if (s && (s.name || s.role)) meta.sign = { role: String(s.role || ''), name: String(s.name || '') };
  }
  let value = 0;
  if (spec.valueMode === 'direct') value = num(meta.value != null ? meta.value : body.value);
  else if (spec.valueMode === 'listingdn') {
    // Per item: carton price, or consumer piece x pack; times the bonus ratio.
    // The listing consideration is one free carton per item per central market
    // (contract clause 4, "(1+1) مجانا ... و يتم ربطها بالأسواق والفروع"). The
    // multiplier is the co-op's *listing_markets* — the number of markets the
    // co-op actually lists Frito-Lay on, proven per co-op from the archive and
    // often a subset of its central markets (Rawda 8 markets → bills ×3). The
    // letter may override it (partial roll-out) via meta.markets, and a letter
    // to one named outlet counts as a single market.
    const mode = String(meta.calcMode || 'carton');
    const ratio = num(meta.ratio) || 1;
    const override = num(meta.markets);
    let markets;
    if (recipient) markets = 1;
    else if (override > 0) markets = override;
    else {
      const c = getCoop.get(coopName);
      if (!c) throw badRequest('الجمعية غير معروفة — لا يمكن حساب عدد الأسواق', 'UNKNOWN_COOP');
      markets = num(c.listing_markets) > 0 ? num(c.listing_markets) : num(c.mains);
      if (!(markets > 0)) throw badRequest('عدد أسواق الإدراج غير محدد لهذه الجمعية — أدخله يدويًا', 'NO_MARKETS');
    }
    const base = (items || []).reduce((s, r) => s + (mode === 'piece' ? num(r.consPiece) * num(r.pack) : num(r.coopCarton)), 0);
    value = Math.round(base * ratio * markets * 1000) / 1000;
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
    // otherwise multiply the per-outlet total by the co-op's listing_markets
    // (its actual listing footprint, falling back to the main-outlet count).
    // An unknown co-op must error, not silently price the note at zero.
    const items = Array.isArray(body.items) ? body.items : [];
    const perOutlet = items.reduce((s, it) => s + num(it.price), 0);
    const mapped = items.map((it) => ({ name: it.name || '', price: num(it.price) }));
    if (recipient) return { value: perOutlet, items: mapped };
    const override = num(body.markets);
    if (override > 0) return { value: perOutlet * override, items: mapped };
    const c = getCoop.get(coopName);
    if (!c) throw badRequest('الجمعية غير معروفة — لا يمكن حساب عدد الأسواق', 'UNKNOWN_COOP');
    const markets = num(c.listing_markets) > 0 ? num(c.listing_markets) : num(c.mains);
    if (!(markets > 0)) throw badRequest('عدد أسواق الإدراج غير محدد لهذه الجمعية — أدخله يدويًا', 'NO_MARKETS');
    return { value: perOutlet * markets, items: mapped };
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
    const r = computeSpec(spec, req.body, coop, recipient);
    if (spec.table && (!r.items || !r.items.length)) throw badRequest('أضف صفًا واحدًا على الأقل للجدول', 'NO_ROWS');
    if (spec.valueMode === 'direct' && !r.value) throw badRequest('أدخل القيمة', 'NO_VALUE');
    calc = { value: r.value, items: r.items };
    // If this co-op + letter type has stored calc terms, they drive the value.
    try { const lv = require('./tracking.routes').listingValue(coop, type, r.items); if (lv != null) calc.value = lv; } catch (e) { /* keep spec value */ }
    metaJson = toJson(r.meta);
  } else {
    // Classic co-op letters: the salesman picks a co-op then a specific outlet,
    // which becomes the addressed recipient.
    recipient = req.body.recipient ? String(req.body.recipient).trim() : null;
    calc = computeValue(type, req.body, coop, recipient);
    // Stored co-op + letter-type calc terms override the value when configured.
    try { const lv = require('./tracking.routes').listingValue(coop, type, calc.items); if (lv != null) calc.value = lv; } catch (e) { /* keep computed value */ }
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
  // A manual reference number (رقم الكتاب) may be supplied to match a letter that
  // was already numbered by the company's existing system; otherwise auto-assign.
  const manualNo = parseInt(req.body.lysalNo, 10);
  let num_, lysal;
  if (Number.isInteger(manualNo) && manualNo > 0) {
    num_ = manualNo; lysal = refNo(manualNo);
  } else {
    num_ = nextCounter(); lysal = refNo(num_);
  }

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
  // Contract-compliance advisories (never block the letter — informational).
  let warnings = [];
  try {
    warnings = contractWarnings(coop, type, req.body, calc.value, req.body.date)
      .concat(itemPriceWarnings(calc.items));
  } catch (e) { warnings = []; }
  res.json({ ok: true, id, lysal, num: num_, value: calc.value, letter: created, warnings });
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
