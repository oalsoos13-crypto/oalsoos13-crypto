'use strict';
const express = require('express');
const db = require('../db');
const audit = require('../audit');
const { requireAuth, requireRole } = require('../auth');
const { asyncH, genId, nowIso, num, badRequest, notFound, forbidden } = require('../util');
const { SEED } = require('../seed-data');

const router = express.Router();
router.use(requireAuth);

// POST /api/budgets  (marketing) — add a budget period
router.post('/budgets', requireRole('marketing_manager'), asyncH((req, res) => {
  const amount = num(req.body.amount);
  const from = req.body.from || '';
  if (!from) throw badRequest('اختر الفترة أولاً', 'NO_PERIOD');
  if (!amount) throw badRequest('أدخل قيمة الميزانية', 'NO_AMOUNT');
  const id = genId('B');
  db.prepare(`INSERT INTO budgets (id, period_from, period_to, preset, amount, created_by, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, from, req.body.to || from, req.body.preset || '', amount, req.user.id, nowIso());
  audit.fromReq(req, 'budget.add', {
    entityType: 'budget', entityId: id,
    summary: `Added budget ${amount} for ${from}..${req.body.to || from}`,
    details: { amount, from, to: req.body.to || from, preset: req.body.preset || '' },
  });
  res.json({ ok: true, id });
}));

// DELETE /api/budgets/:id  (marketing)
router.delete('/budgets/:id', requireRole('marketing_manager'), asyncH((req, res) => {
  const row = db.prepare('SELECT * FROM budgets WHERE id = ?').get(req.params.id);
  if (!row) throw notFound('الميزانية غير موجودة');
  db.prepare('DELETE FROM budgets WHERE id = ?').run(req.params.id);
  audit.fromReq(req, 'budget.delete', {
    entityType: 'budget', entityId: req.params.id,
    summary: `Deleted budget ${row.amount} (${row.period_from}..${row.period_to})`,
    details: { amount: row.amount, from: row.period_from, to: row.period_to },
  });
  res.json({ ok: true });
}));

// PUT /api/channels  (marketing) — replace channel allocation { channels: {name: amount} }
router.put('/channels', requireRole('marketing_manager'), asyncH((req, res) => {
  const incoming = req.body.channels || {};
  const now = nowIso();
  const valid = new Set(SEED.channels);
  const upsert = db.prepare(`
    INSERT INTO channel_alloc (channel, amount, updated_by, updated_at)
    VALUES (@channel, @amount, @by, @now)
    ON CONFLICT(channel) DO UPDATE SET amount=@amount, updated_by=@by, updated_at=@now
  `);
  const applied = {};
  const tx = db.transaction(() => {
    for (const ch of SEED.channels) {
      const amount = num(incoming[ch]);
      upsert.run({ channel: ch, amount, by: req.user.id, now });
      applied[ch] = amount;
    }
    // ignore unknown channels defensively
    for (const k of Object.keys(incoming)) if (!valid.has(k)) delete incoming[k];
  });
  tx();
  audit.fromReq(req, 'budget.channels.save', {
    entityType: 'channel_alloc', summary: 'Updated channel distribution', details: applied,
  });
  res.json({ ok: true, channels: applied });
}));

/* ---------- Monthly budget plan (caps + supervisor allocation + spend) ---------- */
// 'polypack' (الكوباج) and 'foc' (مجاني) are hidden for now — kept in the data
// model (labels + validation in letter.routes) so past classifications survive
// and they can be re-enabled by adding them back here.
const CAPPED_TYPES = ['pallets', 'stands', 'pricediff'];
const ALL_BUDGET_TYPES = CAPPED_TYPES.concat(['offinv']);
function curMonth() { return nowIso().slice(0, 7); }
function isMonth(m) { return /^\d{4}-\d{2}$/.test(String(m || '')); }
// Authoritative salesman -> supervisor map (from the outlets master).
function salesSupMap() {
  const out = {};
  try {
    const userByPf = new Map(db.prepare('SELECT username, name FROM users').all().map((u) => [String(u.username), u.name]));
    db.prepare('SELECT DISTINCT salesman, fsm, fsm_pf FROM outlets').all().forEach((r) => {
      if (r.salesman) out[r.salesman] = userByPf.get(String(r.fsm_pf)) || String(r.fsm || '').replace(/\s+/g, ' ').trim();
    });
  } catch (e) { /* */ }
  return out;
}
// The distribution structure from the outlets master: supervisor -> salesman ->
// coop -> [outlets]. Coops keyed by their clean coops.name via the parent code;
// each outlet carries its cust_id and display name.
let AR = { outlets: {} };
try { AR = require('../outlet_ar.json'); } catch (e) { /* optional */ }
function distStructure() {
  const coopByCode = new Map(db.prepare('SELECT code, name FROM coops').all().map((c) => [String(c.code).toUpperCase(), c.name]));
  const codeOf = (p) => { const m = String(p || '').match(/^(P\d+)/i); return m ? m[1].toUpperCase() : null; };
  const sup = salesSupMap();
  const out = {}; // supName -> salesman -> coop -> [{custId, name}]
  db.prepare('SELECT cust_id, name, parent, salesman FROM outlets ORDER BY parent, name').all().forEach((r) => {
    if (!r.salesman) return;
    const s = sup[r.salesman] || '—';
    const coop = coopByCode.get(codeOf(r.parent)) || String(r.parent || '').replace(/\s+/g, ' ').replace(/\s*PARENT$/i, '').trim();
    out[s] = out[s] || {};
    out[s][r.salesman] = out[s][r.salesman] || {};
    (out[s][r.salesman][coop] = out[s][r.salesman][coop] || []).push({ custId: String(r.cust_id), name: AR.outlets[r.name] || r.name });
  });
  return out;
}
// Spend for a month, from letters carrying a budget type, split into the letter
// value and the debit-note value, aggregated by type, supervisor, salesman,
// coop and outlet (by cust_id).
function monthSpend(month) {
  const letters = db.prepare(
    "SELECT id, sales, coop, cust_id, budget_type, value FROM letters WHERE budget_type IS NOT NULL AND TRIM(budget_type)<>'' AND substr(COALESCE(date,''),1,7)=?"
  ).all(month);
  const supMap = salesSupMap();
  const noteVal = {};
  db.prepare("SELECT letter_id, SUM(value) v FROM notes WHERE status!='rejected' GROUP BY letter_id").all()
    .forEach((r) => { noteVal[r.letter_id] = r.v; });
  const byType = {}, bySup = {}, bySales = {}, byCoop = {}, byOutlet = {};
  for (const L of letters) {
    const bt = L.budget_type, sup = supMap[L.sales] || '—', sm = L.sales || '—', coop = L.coop || '—';
    const lv = num(L.value), nv = num(noteVal[L.id] || 0);
    (byType[bt] = byType[bt] || { letter: 0, note: 0 }); byType[bt].letter += lv; byType[bt].note += nv;
    const ks = sup + '|' + bt;
    (bySup[ks] = bySup[ks] || { supervisor: sup, budgetType: bt, letter: 0, note: 0 }); bySup[ks].letter += lv; bySup[ks].note += nv;
    const km = sm + '|' + bt;
    (bySales[km] = bySales[km] || { salesman: sm, budgetType: bt, letter: 0, note: 0 }); bySales[km].letter += lv; bySales[km].note += nv;
    const kc = coop + '|' + bt;
    (byCoop[kc] = byCoop[kc] || { coop: coop, budgetType: bt, letter: 0, note: 0 }); byCoop[kc].letter += lv; byCoop[kc].note += nv;
    if (L.cust_id) {
      const ko = String(L.cust_id) + '|' + bt;
      (byOutlet[ko] = byOutlet[ko] || { custId: String(L.cust_id), budgetType: bt, letter: 0, note: 0 }); byOutlet[ko].letter += lv; byOutlet[ko].note += nv;
    }
  }
  return { byType, bySup: Object.values(bySup), bySales: Object.values(bySales), byCoop: Object.values(byCoop), byOutlet: Object.values(byOutlet) };
}

// GET /api/budget-plan?month=YYYY-MM — the month's caps, allocations and spend.
router.get('/budget-plan', asyncH((req, res) => {
  const month = isMonth(req.query.month) ? req.query.month : curMonth();
  const m = db.prepare('SELECT month, closed FROM budget_months WHERE month=?').get(month);
  const caps = {};
  db.prepare('SELECT budget_type, amount, note FROM budget_caps WHERE month=?').all(month)
    .forEach((r) => { caps[r.budget_type] = { amount: r.amount, note: r.note }; });
  const alloc = db.prepare('SELECT budget_type, supervisor, amount FROM budget_alloc WHERE month=?').all(month)
    .map((r) => ({ budgetType: r.budget_type, supervisor: r.supervisor, amount: r.amount }));
  const supervisors = db.prepare("SELECT name FROM users WHERE role='supervisor' AND active=1 ORDER BY name").all().map((r) => r.name);
  // Second-level allocations (supervisor -> salesman, salesman -> coop).
  const allocSales = db.prepare('SELECT budget_type, supervisor, salesman, amount FROM budget_alloc_sales WHERE month=?').all(month)
    .map((r) => ({ budgetType: r.budget_type, supervisor: r.supervisor, salesman: r.salesman, amount: r.amount }));
  const allocCoop = db.prepare('SELECT budget_type, salesman, coop, amount FROM budget_alloc_coop WHERE month=?').all(month)
    .map((r) => ({ budgetType: r.budget_type, salesman: r.salesman, coop: r.coop, amount: r.amount }));
  const allocOutlet = db.prepare('SELECT budget_type, coop, cust_id, amount FROM budget_alloc_outlet WHERE month=?').all(month)
    .map((r) => ({ budgetType: r.budget_type, coop: r.coop, custId: r.cust_id, amount: r.amount }));
  // The full structure (supervisor -> salesmen -> coops); a supervisor only
  // needs their own branch but the payload is small, so send it whole.
  const structure = distStructure();
  res.json({
    month, closed: !!(m && m.closed), types: ALL_BUDGET_TYPES, capped: CAPPED_TYPES,
    caps, alloc, allocSales, allocCoop, allocOutlet, supervisors, structure,
    me: req.user ? { name: req.user.name, role: req.user.role } : null,
    spend: monthSpend(month),
    months: db.prepare('SELECT month, closed FROM budget_months ORDER BY month DESC').all(),
  });
}));

// POST /api/budget-caps (admin) — set a month's ceiling for a budget type.
// Body: { month, budgetType, amount, note }. offinv is always open (amount null).
router.post('/budget-caps', requireRole(), asyncH((req, res) => {
  const month = isMonth(req.body.month) ? req.body.month : curMonth();
  const bt = String(req.body.budgetType || '');
  if (!ALL_BUDGET_TYPES.includes(bt)) throw badRequest('نوع باجت غير صحيح', 'BAD_TYPE');
  const closed = db.prepare('SELECT closed FROM budget_months WHERE month=?').get(month);
  if (closed && closed.closed) throw badRequest('الشهر مقفل (مسكّر)', 'MONTH_CLOSED');
  const amount = bt === 'offinv' ? null : num(req.body.amount);
  const now = nowIso();
  db.prepare('INSERT OR IGNORE INTO budget_months (month, created_at) VALUES (?, ?)').run(month, now);
  db.prepare(`INSERT INTO budget_caps (month, budget_type, amount, note, updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(month, budget_type) DO UPDATE SET amount=excluded.amount, note=excluded.note, updated_at=excluded.updated_at`)
    .run(month, bt, amount, String(req.body.note || '').slice(0, 300), now);
  audit.fromReq(req, 'budget.cap', { entityType: 'budget_cap', summary: `Set cap ${bt} ${month} = ${amount == null ? 'open' : amount}`, details: { month, bt, amount } });
  res.json({ ok: true });
}));

// POST /api/budget-month/close  (admin) — close/reopen a month (تسكيرة).
// Body: { month, closed }
router.post('/budget-month/close', requireRole(), asyncH((req, res) => {
  const month = isMonth(req.body.month) ? req.body.month : curMonth();
  const closed = req.body.closed === false ? 0 : 1;
  const now = nowIso();
  db.prepare('INSERT OR IGNORE INTO budget_months (month, created_at) VALUES (?, ?)').run(month, now);
  db.prepare('UPDATE budget_months SET closed=?, closed_by=?, closed_at=? WHERE month=?').run(closed, req.user.id, closed ? now : null, month);
  audit.fromReq(req, 'budget.month.close', { entityType: 'budget_month', entityId: month, summary: `${closed ? 'Closed' : 'Reopened'} month ${month}` });
  res.json({ ok: true, month, closed: !!closed });
}));

// POST /api/budget-alloc  (sales manager) — allocate a type's cap to a supervisor.
// Body: { month, budgetType, supervisor, amount }
router.post('/budget-alloc', requireRole('sales_manager'), asyncH((req, res) => {
  const month = isMonth(req.body.month) ? req.body.month : curMonth();
  const bt = String(req.body.budgetType || '');
  if (!ALL_BUDGET_TYPES.includes(bt)) throw badRequest('نوع باجت غير صحيح', 'BAD_TYPE');
  const sup = String(req.body.supervisor || '').trim();
  if (!sup) throw badRequest('اختر المشرف', 'NO_SUP');
  const closed = db.prepare('SELECT closed FROM budget_months WHERE month=?').get(month);
  if (closed && closed.closed) throw badRequest('الشهر مقفل (مسكّر)', 'MONTH_CLOSED');
  const amount = num(req.body.amount);
  const now = nowIso();
  db.prepare('INSERT OR IGNORE INTO budget_months (month, created_at) VALUES (?, ?)').run(month, now);
  db.prepare(`INSERT INTO budget_alloc (month, budget_type, supervisor, amount, updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(month, budget_type, supervisor) DO UPDATE SET amount=excluded.amount, updated_at=excluded.updated_at`)
    .run(month, bt, sup, amount, now);
  audit.fromReq(req, 'budget.alloc', { entityType: 'budget_alloc', summary: `Alloc ${bt} ${month} ${sup} = ${amount}`, details: { month, bt, sup, amount } });
  res.json({ ok: true });
}));

// POST /api/budget-alloc-sales (supervisor) — split the supervisor's own share
// of a type among their salesmen. Body: { month, budgetType, salesman, amount }.
router.post('/budget-alloc-sales', requireRole('supervisor'), asyncH((req, res) => {
  const month = isMonth(req.body.month) ? req.body.month : curMonth();
  const bt = String(req.body.budgetType || '');
  if (!ALL_BUDGET_TYPES.includes(bt)) throw badRequest('نوع باجت غير صحيح', 'BAD_TYPE');
  const salesman = String(req.body.salesman || '').trim();
  if (!salesman) throw badRequest('اختر المندوب', 'NO_SALES');
  const closed = db.prepare('SELECT closed FROM budget_months WHERE month=?').get(month);
  if (closed && closed.closed) throw badRequest('الشهر مقفل (مسكّر)', 'MONTH_CLOSED');
  // The supervisor may only distribute to their own salesmen.
  const struct = distStructure();
  const supName = req.user.role === 'admin' ? (req.body.supervisor || '').trim() : req.user.name;
  const mine = struct[supName] || {};
  if (req.user.role !== 'admin' && !mine[salesman]) throw forbidden('هذا المندوب ليس ضمن فريقك', 'NOT_MINE');
  const amount = num(req.body.amount);
  const now = nowIso();
  db.prepare('INSERT OR IGNORE INTO budget_months (month, created_at) VALUES (?, ?)').run(month, now);
  db.prepare(`INSERT INTO budget_alloc_sales (month, budget_type, supervisor, salesman, amount, updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(month, budget_type, supervisor, salesman) DO UPDATE SET amount=excluded.amount, updated_at=excluded.updated_at`)
    .run(month, bt, supName, salesman, amount, now);
  audit.fromReq(req, 'budget.alloc.sales', { entityType: 'budget_alloc_sales', summary: `Alloc ${bt} ${month} ${supName}->${salesman} = ${amount}`, details: { month, bt, supName, salesman, amount } });
  res.json({ ok: true });
}));

// POST /api/budget-alloc-coop (supervisor) — split a salesman's share of a type
// among their co-ops. Body: { month, budgetType, salesman, coop, amount }.
router.post('/budget-alloc-coop', requireRole('supervisor'), asyncH((req, res) => {
  const month = isMonth(req.body.month) ? req.body.month : curMonth();
  const bt = String(req.body.budgetType || '');
  if (!ALL_BUDGET_TYPES.includes(bt)) throw badRequest('نوع باجت غير صحيح', 'BAD_TYPE');
  const salesman = String(req.body.salesman || '').trim();
  const coop = String(req.body.coop || '').trim();
  if (!salesman || !coop) throw badRequest('اختر المندوب والجمعية', 'NO_TARGET');
  const closed = db.prepare('SELECT closed FROM budget_months WHERE month=?').get(month);
  if (closed && closed.closed) throw badRequest('الشهر مقفل (مسكّر)', 'MONTH_CLOSED');
  const struct = distStructure();
  const supName = req.user.role === 'admin' ? null : req.user.name;
  if (req.user.role !== 'admin') {
    const mine = struct[supName] || {};
    const coops = mine[salesman] || [];
    if (!coops.includes(coop)) throw forbidden('هذه الجمعية ليست ضمن مندوبك', 'NOT_MINE');
  }
  const amount = num(req.body.amount);
  const now = nowIso();
  db.prepare('INSERT OR IGNORE INTO budget_months (month, created_at) VALUES (?, ?)').run(month, now);
  db.prepare(`INSERT INTO budget_alloc_coop (month, budget_type, salesman, coop, amount, updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(month, budget_type, salesman, coop) DO UPDATE SET amount=excluded.amount, updated_at=excluded.updated_at`)
    .run(month, bt, salesman, coop, amount, now);
  audit.fromReq(req, 'budget.alloc.coop', { entityType: 'budget_alloc_coop', summary: `Alloc ${bt} ${month} ${salesman}->${coop} = ${amount}`, details: { month, bt, salesman, coop, amount } });
  res.json({ ok: true });
}));

// POST /api/budget-alloc-outlet (supervisor) — split a coop's share of a type
// among its outlets. Body: { month, budgetType, coop, custId, amount }.
router.post('/budget-alloc-outlet', requireRole('supervisor'), asyncH((req, res) => {
  const month = isMonth(req.body.month) ? req.body.month : curMonth();
  const bt = String(req.body.budgetType || '');
  if (!ALL_BUDGET_TYPES.includes(bt)) throw badRequest('نوع باجت غير صحيح', 'BAD_TYPE');
  const coop = String(req.body.coop || '').trim();
  const custId = String(req.body.custId || '').trim();
  if (!coop || !custId) throw badRequest('اختر الجمعية والأوتلت', 'NO_TARGET');
  const closed = db.prepare('SELECT closed FROM budget_months WHERE month=?').get(month);
  if (closed && closed.closed) throw badRequest('الشهر مقفل (مسكّر)', 'MONTH_CLOSED');
  // Scope: the outlet must belong to one of the supervisor's coops.
  if (req.user.role !== 'admin') {
    const mine = distStructure()[req.user.name] || {};
    const ok = Object.values(mine).some((coops) => (coops[coop] || []).some((o) => o.custId === custId));
    if (!ok) throw forbidden('هذا الأوتلت ليس ضمن نطاقك', 'NOT_MINE');
  }
  const amount = num(req.body.amount);
  const now = nowIso();
  db.prepare('INSERT OR IGNORE INTO budget_months (month, created_at) VALUES (?, ?)').run(month, now);
  db.prepare(`INSERT INTO budget_alloc_outlet (month, budget_type, coop, cust_id, amount, updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(month, budget_type, coop, cust_id) DO UPDATE SET amount=excluded.amount, updated_at=excluded.updated_at`)
    .run(month, bt, coop, custId, amount, now);
  audit.fromReq(req, 'budget.alloc.outlet', { entityType: 'budget_alloc_outlet', summary: `Alloc ${bt} ${month} ${coop}/${custId} = ${amount}`, details: { month, bt, coop, custId, amount } });
  res.json({ ok: true });
}));

module.exports = router;
