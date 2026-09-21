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
  'priceoff', 'pricediff', 'listing', 'listing_dn', 'listing_supp', 'linkitems',
  'stand', 'pallet', 'rentstand', 'rentdebit', 'priceupd', 'changeprice',
  'dataupd_dn',
]);
// Types that themselves ARE the contract percentage being drawn down.
const REBATE_TYPES = new Set(['cda_pct', 'pctrebate']);
// The budget classifications a letter can be tagged with. 'offinv' (خارج
// الاستثمار) is uncapped and covers the Union letters (supplementary/new items,
// price increase, data update).
const BUDGET_TYPES = new Set(['pallets', 'stands', 'pricediff', 'polypack', 'foc', 'offinv']);
// Letters addressed to the Cooperatives Union. Admin-only to create; they enter
// the chain at the sales-manager stage (no salesman/supervisor step).
const UNION_TYPES = new Set(['uoc_supp', 'uoc_union', 'uoc_newitems', 'uoc_dataupd']);
// Auto-classification: the budget type previously chosen for this letter type.
// Built-in letter-type -> budget-type defaults (a learned map row overrides).
const DEFAULT_BUDGET_MAP = { palletdn: 'pallets', standdn: 'stands', pricediff: 'pricediff' };
function autoBudgetType(letterType) {
  try { const r = db.prepare('SELECT budget_type FROM budget_type_map WHERE letter_type = ?').get(letterType); if (r) return r.budget_type; } catch (e) { /* */ }
  return DEFAULT_BUDGET_MAP[letterType] || null;
}

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
router.post('/letters', requireRole('salesman', 'sales_manager', 'marketing_manager', 'sales_ops'), asyncH((req, res) => {
  const type = String(req.body.type || '');
  const mode = modeOf(type);
  if (!mode) throw badRequest('نوع الكتاب غير صحيح', 'BAD_TYPE');
  // Union letters can only be created by the admin.
  const isUnion = UNION_TYPES.has(type);
  if (isUnion && req.user.role !== 'admin') throw forbidden('كتب الاتحاد يصدرها المدير فقط', 'UNION_ADMIN_ONLY');

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

  // Every letter enters the approval chain at the supervisor stage and is not
  // printable until it clears all stages (supervisor -> sales_manager ->
  // marketing_manager -> sales_ops -> print).
  const custId = String(req.body.custId || '').trim() || null;
  // Auto-classify by the learned letter-type -> budget-type map (only for
  // monetary letters, since only those feed the budget summary).
  const autoBt = (num(calc.value) > 0) ? autoBudgetType(type) : null;
  // Union letters skip the salesman/supervisor step and enter at the sales manager.
  const startStage = isUnion ? 'sales_manager' : 'supervisor';
  db.prepare(`INSERT INTO letters
      (id, num, lysal, type, coop, brand, sales, date, principal, note, value, base, pct, items, recipient, meta, cust_id, status, approval, appr_stage, budget_type, approved_by, approved_at, created_by, created_at)
      VALUES (@id,@num,@lysal,@type,@coop,@brand,@sales,@date,@principal,@note,@value,@base,@pct,@items,@recipient,@meta,@custId,'pending','pending',@stage,@bt,NULL,NULL,@by,@now)`)
    .run({
      stage: startStage,
      id, num: num_, lysal, type, coop,
      brand: req.body.brand || '', sales,
      date: req.body.date || now.slice(0, 10),
      principal: req.body.principal || '', note: req.body.note || '',
      value: calc.value, base: calc.base ?? null, pct: calc.pct ?? null,
      items: calc.items ? toJson(calc.items) : null,
      recipient, meta: metaJson, custId, bt: autoBt,
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

// DELETE /api/letters/:id  (ADMIN ONLY — nobody else may delete or edit)
router.delete('/letters/:id', requireRole(), asyncH((req, res) => {
  const L = db.prepare('SELECT * FROM letters WHERE id = ?').get(req.params.id);
  if (!L) throw notFound('الكتاب غير موجود');
  // Notes issued from this letter that are still live (anything not already
  // rejected — including an *approved* note).
  const liveNotes = db.prepare("SELECT id, value, coop, status FROM notes WHERE letter_id = ? AND status != 'rejected'").all(L.id);
  if (L.status === 'noted' || liveNotes.length) {
    // The admin may cancel a letter that carries a debit note, which also
    // voids the linked note(s) — the only way to clear a letter whose note was
    // already approved (there is otherwise no path back from an approved note).
    const now = nowIso();
    const tx = db.transaction(() => {
      for (const n of liveNotes) {
        db.prepare("UPDATE notes SET status='rejected', rejected_by=?, rejected_at=?, rejected_stage='admin', reject_reason=?, updated_at=? WHERE id=?")
          .run(req.user.id, now, 'إلغاء الكتاب من قبل المدير', now, n.id);
      }
      db.prepare('DELETE FROM letters WHERE id = ?').run(req.params.id);
    });
    tx();
    audit.fromReq(req, 'letter.delete', {
      entityType: 'letter', entityId: req.params.id,
      summary: `Admin cancelled letter ${L.lysal} and voided ${liveNotes.length} debit note(s)`,
      details: { lysal: L.lysal, value: L.value, voidedNotes: liveNotes.map((n) => ({ id: n.id, value: n.value, status: n.status })) },
    });
    return res.json({ ok: true, voidedNotes: liveNotes.length });
  }
  db.prepare('DELETE FROM letters WHERE id = ?').run(req.params.id);
  audit.fromReq(req, 'letter.delete', {
    entityType: 'letter', entityId: req.params.id,
    summary: `Deleted letter ${L.lysal}`, details: { lysal: L.lysal, value: L.value },
  });
  res.json({ ok: true });
}));

// GET /api/letters/suggestions — history-driven autocompletes for the create
// form. For every free-text field (recipient, salesman, and each spec text
// field) we return the distinct values used before, most-frequent first, so the
// rep picks from history instead of retyping — while still free to enter a new
// value (the frontend renders these as <datalist> comboboxes). Cached briefly.
const TEXT_FIELD_KEYS = (() => {
  const set = new Set();
  for (const s of Object.values(SPEC_BY_KEY)) {
    for (const f of s.fields || []) if (f.type === 'text') set.add(f.key);
  }
  return [...set];
})();
let _sugCache = null, _sugAt = 0;
function distinctCol(col, limit) {
  // Most-used non-empty distinct values of a plain letters column.
  return db.prepare(
    `SELECT ${col} v, COUNT(*) c FROM letters
      WHERE ${col} IS NOT NULL AND TRIM(${col}) <> ''
      GROUP BY ${col} ORDER BY c DESC, v ASC LIMIT ?`
  ).all(limit).map((r) => r.v);
}
function distinctMeta(key, limit) {
  // Most-used non-empty distinct values of a meta.<key> across all letters.
  return db.prepare(
    `SELECT json_extract(meta, '$.' || ?) v, COUNT(*) c FROM letters
      WHERE meta IS NOT NULL AND json_extract(meta, '$.' || ?) IS NOT NULL
        AND TRIM(json_extract(meta, '$.' || ?)) <> ''
      GROUP BY v ORDER BY c DESC, v ASC LIMIT ?`
  ).all(key, key, key, limit).map((r) => r.v);
}
function buildSuggestions() {
  if (_sugCache && Date.now() - _sugAt < 60000) return _sugCache;
  const fields = {};
  for (const k of TEXT_FIELD_KEYS) {
    try { const vals = distinctMeta(k, 60); if (vals.length) fields[k] = vals; } catch (e) { /* skip */ }
  }
  let recipients = [], salesmen = [];
  try { recipients = distinctCol('recipient', 200); } catch (e) { /* */ }
  try { salesmen = distinctCol('sales', 100); } catch (e) { /* */ }
  _sugCache = { recipients, salesmen, fields };
  _sugAt = Date.now();
  return _sugCache;
}
router.get('/letters/suggestions', asyncH((req, res) => {
  res.json(buildSuggestions());
}));

// A supervisor may only moderate letters whose co-op is within their scope;
// management may moderate any.
function assertCanModerate(req, L) {
  if (['sales_manager', 'marketing_manager', 'sales_ops', 'admin'].includes(req.user.role)) return;
  if (req.user.role === 'supervisor') {
    const allowed = scopeCoopSet(req.user);
    const c = cleanCoop(L.coop);
    if (allowed && c && allowed.has(c)) return;
    throw forbidden('لا يمكنك اعتماد كتاب خارج نطاقك', 'SCOPE');
  }
  throw forbidden('غير مصرح', 'ROLE');
}

// The linear approval chain. Each stage is owned by the role of the same name;
// 'print' is the terminal ready-for-admin state.
const CHAIN = ['supervisor', 'sales_manager', 'marketing_manager', 'sales_ops', 'print'];
function nextStage(stage) { const i = CHAIN.indexOf(stage); return i < 0 ? null : CHAIN[i + 1] || null; }
// The signatory who e-signs at a given stage, if the letter is his to sign.
// سائد الرمحي signs at the sales_manager stage; أحمد شوقي at the sales_ops stage.
// Letters signed by others (راشد/عماد, Union) are approved only — signed on paper.
const STAGE_SIGNER = { sales_manager: 'سائد الرمحي', sales_ops: 'أحمد شوقي' };
function letterSignerName(L) {
  try { const m = L.meta ? JSON.parse(L.meta) : null; if (m && m.sign && m.sign.name) return String(m.sign.name).trim(); } catch (e) { /* */ }
  const spec = SPEC_BY_KEY[L.type];
  return spec && spec.signatory ? String(spec.signatory.name || '').trim() : '';
}

// POST /api/letters/:id/approve — the current-stage owner (or admin) approves,
// advancing the letter one stage. When the stage is the letter's signatory's,
// a drawn e-signature (data URL) must accompany the approval and is stored.
router.post('/letters/:id/approve', requireRole('supervisor', 'sales_manager', 'marketing_manager', 'sales_ops'), asyncH((req, res) => {
  const L = db.prepare('SELECT * FROM letters WHERE id = ?').get(req.params.id);
  if (!L) throw notFound('الكتاب غير موجود');
  const stage = L.appr_stage;
  if (!stage || stage === 'print' || L.approval === 'rejected') throw badRequest('الكتاب ليس بانتظار اعتماد', 'BAD_STAGE');
  // Only the stage owner (or admin) may act, and supervisors are scope-limited.
  if (req.user.role !== 'admin' && req.user.role !== stage) throw forbidden('هذه المرحلة ليست من صلاحيتك', 'WRONG_STAGE');
  if (stage === 'supervisor') assertCanModerate(req, L);

  let meta = {};
  try { meta = L.meta ? JSON.parse(L.meta) : {}; } catch (e) { meta = {}; }
  // Capture the e-signature when this stage is the designated signatory's.
  const needSig = STAGE_SIGNER[stage] && letterSignerName(L) === STAGE_SIGNER[stage];
  if (needSig) {
    const sig = String(req.body.signature || '');
    if (!/^data:image\//.test(sig)) throw badRequest('التوقيع الإلكتروني مطلوب لهذا الكتاب', 'SIGNATURE_REQUIRED');
    if (sig.length > 400000) throw badRequest('حجم التوقيع كبير جدًا', 'SIGNATURE_TOO_BIG');
    meta.signatures = meta.signatures || {};
    meta.signatures[stage] = sig;
  }
  meta.approvals = meta.approvals || {};
  const now = nowIso();
  meta.approvals[stage] = { by: req.user.name || req.user.username, at: now };

  const next = nextStage(stage);
  const done = next === 'print';
  db.prepare(
    "UPDATE letters SET appr_stage=?, approval=?, meta=?, approved_by=?, approved_at=?, rejected_by=NULL, rejected_at=NULL, reject_reason=NULL, updated_at=? WHERE id=?"
  ).run(next, done ? 'approved' : 'pending', toJson(meta), done ? req.user.id : null, done ? now : null, now, L.id);
  audit.fromReq(req, 'letter.approve', {
    entityType: 'letter', entityId: L.id,
    summary: `Approved letter ${L.lysal} at ${stage}${needSig ? ' (e-signed)' : ''} -> ${next}`,
    details: { stage, next, signed: !!needSig },
  });
  res.json({ ok: true, stage: next, done });
}));

// POST /api/letters/:id/reject — the current-stage owner (or admin) rejects with
// a reason; the letter drops out of the chain back to the salesman.
router.post('/letters/:id/reject', requireRole('supervisor', 'sales_manager', 'marketing_manager', 'sales_ops'), asyncH((req, res) => {
  const L = db.prepare('SELECT * FROM letters WHERE id = ?').get(req.params.id);
  if (!L) throw notFound('الكتاب غير موجود');
  const stage = L.appr_stage;
  if (!stage || L.approval === 'rejected') throw badRequest('الكتاب ليس بانتظار اعتماد', 'BAD_STAGE');
  // At the final (print) stage only the admin may reject.
  if (stage === 'print') { if (req.user.role !== 'admin') throw forbidden('الطباعة والرفض النهائي للمدير فقط', 'ADMIN_ONLY'); }
  else {
    if (req.user.role !== 'admin' && req.user.role !== stage) throw forbidden('هذه المرحلة ليست من صلاحيتك', 'WRONG_STAGE');
    if (stage === 'supervisor') assertCanModerate(req, L);
  }
  const reason = String(req.body.reason || '').trim();
  if (!reason) throw badRequest('أدخل سبب الرفض', 'NO_REASON');
  const now = nowIso();
  db.prepare("UPDATE letters SET approval='rejected', appr_stage=NULL, rejected_by=?, rejected_at=?, reject_reason=?, updated_at=? WHERE id=?")
    .run(req.user.id, now, reason, now, L.id);
  audit.fromReq(req, 'letter.reject', { entityType: 'letter', entityId: L.id, summary: `Rejected letter ${L.lysal} at ${stage}`, details: { reason, stage } });
  res.json({ ok: true });
}));

// POST /api/letters/:id/budget-type — the sales manager designates which budget
// a letter belongs to (rental/pricediff/polypack/foc); admin may also set it.
// The choice is remembered per letter type so future letters auto-classify.
// Body: { budgetType } ('' clears it).
router.post('/letters/:id/budget-type', requireRole('sales_manager'), asyncH((req, res) => {
  const L = db.prepare('SELECT * FROM letters WHERE id = ?').get(req.params.id);
  if (!L) throw notFound('الكتاب غير موجود');
  const bt = String(req.body.budgetType || '').trim();
  if (bt && !BUDGET_TYPES.has(bt)) throw badRequest('نوع باجت غير صحيح', 'BAD_BUDGET_TYPE');
  // FOC is booked under the co-op's expenses, so it needs a co-op (+ outlet).
  if (bt === 'foc' && !(L.coop || L.recipient)) throw badRequest('المجاني يحتاج جمعية/أوتليت', 'FOC_NEEDS_COOP');
  const now = nowIso();
  db.prepare('UPDATE letters SET budget_type=?, updated_at=? WHERE id=?').run(bt || null, now, L.id);
  // Learn the mapping so the next letter of this type is auto-classified.
  if (bt) {
    db.prepare(`INSERT INTO budget_type_map (letter_type, budget_type, updated_at) VALUES (?,?,?)
      ON CONFLICT(letter_type) DO UPDATE SET budget_type=excluded.budget_type, updated_at=excluded.updated_at`)
      .run(L.type, bt, now);
  }
  audit.fromReq(req, 'letter.budget_type', { entityType: 'letter', entityId: L.id, summary: `Set budget type of ${L.lysal} = ${bt || '-'}`, details: { budgetType: bt } });
  res.json({ ok: true, budgetType: bt || null });
}));

// POST /api/letters/:id/print — ADMIN ONLY. A letter can be printed only after it
// has cleared the whole chain (appr_stage='print'). Records the print.
router.post('/letters/:id/print', requireRole(), asyncH((req, res) => {
  const L = db.prepare('SELECT * FROM letters WHERE id = ?').get(req.params.id);
  if (!L) throw notFound('الكتاب غير موجود');
  if (L.appr_stage !== 'print' || L.approval !== 'approved') throw badRequest('الكتاب لم يكتمل اعتماده بعد', 'NOT_READY');
  const now = nowIso();
  db.prepare('UPDATE letters SET printed_at=?, printed_by=?, updated_at=? WHERE id=?').run(now, req.user.id, now, L.id);
  audit.fromReq(req, 'letter.print', { entityType: 'letter', entityId: L.id, summary: `Printed letter ${L.lysal}` });
  res.json({ ok: true, printed_at: now });
}));

// POST /api/letters/:id/return — ADMIN ONLY. Send a letter back to an earlier
// point for correction: to the salesman (as a returned letter to redo), or
// re-queue it at the supervisor / sales_manager / marketing_manager / sales_ops
// stage. Approvals & e-signatures at or after the target stage are cleared so
// they are re-done. Works from any stage, including the final print stage.
// Body: { stage: 'salesman'|'supervisor'|'sales_manager'|'marketing_manager'|'sales_ops', reason? }
const RETURN_DEST = {
  salesman: null,
  supervisor: 'supervisor',
  sales_manager: 'sales_manager',
  marketing_manager: 'marketing_manager',
  sales_ops: 'sales_ops',
};
router.post('/letters/:id/return', requireRole(), asyncH((req, res) => {
  const L = db.prepare('SELECT * FROM letters WHERE id = ?').get(req.params.id);
  if (!L) throw notFound('الكتاب غير موجود');
  const target = String(req.body.stage || '');
  if (!(target in RETURN_DEST)) throw badRequest('مرحلة غير صحيحة', 'BAD_STAGE');
  const reason = String(req.body.reason || '').trim();
  const now = nowIso();
  let meta = {}; try { meta = L.meta ? JSON.parse(L.meta) : {}; } catch (e) { meta = {}; }
  const dest = RETURN_DEST[target];
  if (dest) {
    // Invalidate approvals/signatures from the target stage onward.
    const from = CHAIN.indexOf(dest);
    if (meta.approvals) for (const st of Object.keys(meta.approvals)) if (CHAIN.indexOf(st) >= from) delete meta.approvals[st];
    if (meta.signatures) for (const st of Object.keys(meta.signatures)) if (CHAIN.indexOf(st) >= from) delete meta.signatures[st];
  } else {
    delete meta.approvals; delete meta.signatures;
  }
  meta.returns = meta.returns || [];
  meta.returns.push({ by: req.user.name || req.user.username, at: now, to: target, reason });
  if (dest) {
    db.prepare("UPDATE letters SET appr_stage=?, approval='pending', meta=?, approved_by=NULL, approved_at=NULL, rejected_by=NULL, rejected_at=NULL, reject_reason=NULL, printed_at=NULL, printed_by=NULL, updated_at=? WHERE id=?")
      .run(dest, toJson(meta), now, L.id);
  } else {
    db.prepare("UPDATE letters SET appr_stage=NULL, approval='rejected', meta=?, approved_by=NULL, approved_at=NULL, rejected_by=?, rejected_at=?, reject_reason=?, printed_at=NULL, printed_by=NULL, updated_at=? WHERE id=?")
      .run(toJson(meta), req.user.id, now, reason || 'أُعيد للمندوب للتعديل', now, L.id);
  }
  audit.fromReq(req, 'letter.return', { entityType: 'letter', entityId: L.id, summary: `Returned letter ${L.lysal} to ${target}`, details: { to: target, reason } });
  res.json({ ok: true, stage: dest, to: target });
}));

// POST /api/letters/:id/edit — ADMIN ONLY. Edit a letter's content in place
// (same type & reference). Recomputes value/items from the submitted fields and
// preserves the approval trail/signatures already captured. Body: same shape as
// letter creation (minus type).
router.post('/letters/:id/edit', requireRole(), asyncH((req, res) => {
  const L = db.prepare('SELECT * FROM letters WHERE id = ?').get(req.params.id);
  if (!L) throw notFound('الكتاب غير موجود');
  const type = L.type;
  const mode = modeOf(type);
  if (!mode) throw badRequest('نوع الكتاب غير صحيح', 'BAD_TYPE');
  let coop = req.body.coop != null ? String(req.body.coop) : L.coop;
  let recipient = L.recipient;
  let calc;
  let baseMeta = {}; try { baseMeta = L.meta ? JSON.parse(L.meta) : {}; } catch (e) { baseMeta = {}; }
  let metaJson = L.meta;
  if (mode === 'spec') {
    const spec = SPEC_BY_KEY[type];
    if (spec.recipient === 'coop') recipient = req.body.recipient ? String(req.body.recipient).trim() : recipient;
    else if (spec.recipient === 'fixed') { recipient = spec.recipientFixed; coop = ''; }
    else recipient = String(req.body.recipient || recipient || '').trim();
    const r = computeSpec(spec, req.body, coop, recipient);
    if (spec.table && (!r.items || !r.items.length)) throw badRequest('أضف صفًا واحدًا على الأقل للجدول', 'NO_ROWS');
    if (spec.valueMode === 'direct' && !r.value) throw badRequest('أدخل القيمة', 'NO_VALUE');
    calc = { value: r.value, items: r.items };
    try { const lv = require('./tracking.routes').listingValue(coop, type, r.items); if (lv != null) calc.value = lv; } catch (e) { /* */ }
    // Merge freshly computed spec meta (sign choice, tafqit) over the preserved
    // trail (signatures/approvals/returns).
    let sm = {}; try { sm = r.meta ? (typeof r.meta === 'string' ? JSON.parse(r.meta) : r.meta) : {}; } catch (e) { sm = {}; }
    metaJson = toJson(Object.assign({}, baseMeta, sm));
  } else {
    recipient = req.body.recipient ? String(req.body.recipient).trim() : recipient;
    calc = computeValue(type, req.body, coop, recipient);
    try { const lv = require('./tracking.routes').listingValue(coop, type, calc.items); if (lv != null) calc.value = lv; } catch (e) { /* */ }
    if (mode === 'pricetable') { if (!calc.items || !calc.items.length) throw badRequest('أضف صنفًا واحدًا على الأقل للجدول', 'NO_ROWS'); }
    else if (!calc.value) throw badRequest('أدخل القيمة / الأصناف', 'NO_VALUE');
  }
  const now = nowIso();
  db.prepare(`UPDATE letters SET coop=@coop, recipient=@recipient, brand=@brand, principal=@principal,
      note=@note, date=@date, value=@value, base=@base, pct=@pct, items=@items, meta=@meta, updated_at=@now WHERE id=@id`)
    .run({
      coop, recipient,
      brand: req.body.brand != null ? req.body.brand : L.brand,
      principal: req.body.principal != null ? req.body.principal : L.principal,
      note: req.body.note != null ? req.body.note : L.note,
      date: req.body.date || L.date,
      value: calc.value, base: calc.base ?? L.base, pct: calc.pct ?? L.pct,
      items: calc.items ? toJson(calc.items) : L.items,
      meta: metaJson, now, id: L.id,
    });
  audit.fromReq(req, 'letter.edit', { entityType: 'letter', entityId: L.id, summary: `Admin edited letter ${L.lysal}`, details: { value: calc.value } });
  const updated = db.prepare('SELECT * FROM letters WHERE id = ?').get(L.id);
  res.json({ ok: true, id: L.id, letter: updated });
}));

module.exports = router;
