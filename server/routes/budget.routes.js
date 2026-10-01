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
// Active budget types: pallets, stands, price-diff, condition (كوديشن/polypack)
// and free (FOC). 'offinv' (خارج الاستثمار) has been removed from the budget.
const CAPPED_TYPES = ['pallets', 'stands', 'pricediff', 'polypack', 'foc'];
const ALL_BUDGET_TYPES = CAPPED_TYPES.slice();
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
  // Letters store the co-op under either its clean parent name ("RAWDA PARENT")
  // or its coops.name ("Rawda"); the distribution is keyed by coops.name. Map
  // both spellings to the canonical coops.name so spend lines up with allocation.
  const coopByCode = new Map(db.prepare('SELECT code, name FROM coops').all().map((c) => [String(c.code).toUpperCase(), c.name]));
  const codeOf = (p) => { const m = String(p || '').match(/^(P\d+)/i); return m ? m[1].toUpperCase() : null; };
  const canonCoop = new Map(); // any stored spelling -> coops.name
  db.prepare('SELECT DISTINCT parent FROM outlets').all().forEach((r) => {
    const canon = coopByCode.get(codeOf(r.parent)) || String(r.parent || '').replace(/^P\d+\s*-\s*/i, '').trim();
    const clean = String(r.parent || '').replace(/^P\d+\s*-\s*/i, '').trim();
    if (clean) canonCoop.set(clean, canon);
    if (canon) canonCoop.set(canon, canon);
  });
  const normCoop = (c) => canonCoop.get(c) || c;
  const byType = {}, bySup = {}, bySales = {}, byCoop = {}, byOutlet = {};
  for (const L of letters) {
    const bt = L.budget_type, sup = supMap[L.sales] || '—', sm = L.sales || '—', coop = normCoop(L.coop) || '—';
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

// ---- Over-budget guards. The UI only warns (red); the server REFUSES. ----
const DN_TYPES = ['pallets', 'stands', 'pricediff'];
const fmtKD = (n) => (Math.round(num(n) * 1000) / 1000).toFixed(3);
function overMsg(what, limit, would) {
  return `تجاوز البتجيت — ${what}: الحد ${fmtKD(limit)} د.ك، والمطلوب يوصل ${fmtKD(would)} د.ك | Over budget — ${what}: limit ${fmtKD(limit)} KD, this would make ${fmtKD(would)} KD`;
}
// A supervisor team's effective totals (D.N + مجاني, outlets override their
// co-op) for a month/type, with a proposed change applied first.
// change = { salesman?, coop, custId|null, amount|null, focAmount|null } (null = keep stored)
function teamTotals(month, bt, supName, change) {
  const team = distStructure()[supName] || {};
  const coopMap = new Map(db.prepare('SELECT salesman, coop, amount, foc_amount FROM budget_alloc_coop WHERE month=? AND budget_type=?').all(month, bt)
    .map((r) => [r.salesman + '|' + r.coop, { dn: num(r.amount), foc: num(r.foc_amount) }]));
  const outMap = new Map(db.prepare('SELECT coop, cust_id, amount, foc_amount FROM budget_alloc_outlet WHERE month=? AND budget_type=?').all(month, bt)
    .map((r) => [r.coop + '|' + r.cust_id, { dn: num(r.amount), foc: num(r.foc_amount) }]));
  if (change) {
    const key = change.custId ? change.coop + '|' + change.custId : change.salesman + '|' + change.coop;
    const map = change.custId ? outMap : coopMap;
    const cur = map.get(key) || { dn: 0, foc: 0 };
    map.set(key, { dn: change.amount != null ? num(change.amount) : cur.dn, foc: change.focAmount != null ? num(change.focAmount) : cur.foc });
  }
  let total = 0, foc = 0;
  for (const [sm, coops] of Object.entries(team)) for (const [coop, outlets] of Object.entries(coops)) {
    const outs = (outlets || []).map((o) => outMap.get(coop + '|' + String(o.custId))).filter(Boolean);
    if (outs.some((o) => o.dn !== 0 || o.foc !== 0)) { for (const o of outs) { total += o.dn + o.foc; foc += o.foc; } }
    else { const c = coopMap.get(sm + '|' + coop); if (c) { total += c.dn + c.foc; foc += c.foc; } }
  }
  return { total, foc };
}
// Refuse a co-op / outlet change that would push the team past the
// supervisor's allocation for the type, or past their FOC allocation.
function assertTeamWithin(month, bt, supName, change) {
  if (!supName) return;
  const share = db.prepare('SELECT amount FROM budget_alloc WHERE month=? AND budget_type=? AND supervisor=?').get(month, bt, supName);
  if (share && share.amount != null) {
    const t = teamTotals(month, bt, supName, change);
    if (t.total > num(share.amount) + 1e-9) throw badRequest(overMsg(bt, share.amount, t.total), 'OVER_ALLOC');
  }
  if (DN_TYPES.includes(bt)) {
    const focShare = db.prepare('SELECT amount FROM budget_alloc WHERE month=? AND budget_type=? AND supervisor=?').get(month, 'foc', supName);
    if (focShare && focShare.amount != null) {
      let focTotal = 0;
      for (const k of DN_TYPES) focTotal += teamTotals(month, k, supName, k === bt ? change : null).foc;
      if (focTotal > num(focShare.amount) + 1e-9) throw badRequest(overMsg('FOC (مجاني)', focShare.amount, focTotal), 'OVER_FOC');
    }
  }
}

// GET /api/budget-plan?month=YYYY-MM — the month's caps, allocations and spend.
router.get('/budget-plan', asyncH((req, res) => {
  const month = isMonth(req.query.month) ? req.query.month : curMonth();
  const m = db.prepare('SELECT month, closed FROM budget_months WHERE month=?').get(month);
  const caps = {};
  db.prepare('SELECT budget_type, amount, note, spent FROM budget_caps WHERE month=?').all(month)
    .forEach((r) => { caps[r.budget_type] = { amount: r.amount, note: r.note, spent: r.spent }; });
  const alloc = db.prepare('SELECT budget_type, supervisor, amount FROM budget_alloc WHERE month=?').all(month)
    .map((r) => ({ budgetType: r.budget_type, supervisor: r.supervisor, amount: r.amount }));
  const supervisors = db.prepare("SELECT name FROM users WHERE role='supervisor' AND active=1 ORDER BY name").all().map((r) => r.name);
  // Second-level allocations (supervisor -> salesman, salesman -> coop).
  const allocSales = db.prepare('SELECT budget_type, supervisor, salesman, amount FROM budget_alloc_sales WHERE month=?').all(month)
    .map((r) => ({ budgetType: r.budget_type, supervisor: r.supervisor, salesman: r.salesman, amount: r.amount }));
  // `amount` is the D.N part (becomes a letter); `focAmount` the مجاني part.
  const allocCoop = db.prepare('SELECT budget_type, salesman, coop, amount, foc_amount FROM budget_alloc_coop WHERE month=?').all(month)
    .map((r) => ({ budgetType: r.budget_type, salesman: r.salesman, coop: r.coop, amount: r.amount, focAmount: r.foc_amount || 0 }));
  const allocOutlet = db.prepare('SELECT budget_type, coop, cust_id, amount, foc_amount FROM budget_alloc_outlet WHERE month=?').all(month)
    .map((r) => ({ budgetType: r.budget_type, coop: r.coop, custId: r.cust_id, amount: r.amount, focAmount: r.foc_amount || 0 }));
  // The distribution structure (supervisor -> salesmen -> coops -> outlets).
  // SCOPING: a supervisor must only ever receive their OWN branch — never the
  // other supervisors' salesmen / co-ops / outlets. A salesman has no budget
  // screen and gets nothing here. Management (admin / sales_manager / marketing
  // / sales_ops) sees the whole picture. Scoping the tree server-side is the
  // authoritative fix: the client already renders only structure[me].
  const fullStructure = distStructure();
  const role = req.user ? req.user.role : null;
  const isMgmt = role === 'admin' || role === 'sales_manager' || role === 'marketing_manager' || role === 'sales_ops';
  const fullSpend = monthSpend(month);
  // FOC and الكوديشن spend is entered by hand by the admin (no letters drive
  // them): the manual figure replaces the letter-derived total for these types.
  for (const mbt of ['foc', 'polypack']) {
    if (caps[mbt] && caps[mbt].spent != null) fullSpend.byType[mbt] = { letter: 0, note: num(caps[mbt].spent), manual: true };
  }
  let structure = fullStructure;
  let outAlloc = alloc, outAllocSales = allocSales, outAllocCoop = allocCoop, outAllocOutlet = allocOutlet;
  let outSupervisors = supervisors, outSpend = fullSpend;
  if (role === 'supervisor') {
    const me = req.user.name;
    const myBranch = fullStructure[me] || {};
    structure = { [me]: myBranch };
    // Names within my own branch — used to filter every allocation / spend line
    // so nothing about another team's numbers or people crosses over.
    const mySales = new Set(Object.keys(myBranch));
    const myCoops = new Set();
    const myCust = new Set();
    Object.values(myBranch).forEach((coops) => {
      Object.keys(coops).forEach((c) => myCoops.add(c));
      Object.values(coops).forEach((outs) => (outs || []).forEach((o) => myCust.add(String(o.custId))));
    });
    outSupervisors = [me];
    outAlloc = alloc.filter((a) => a.supervisor === me);
    outAllocSales = allocSales.filter((a) => a.supervisor === me || mySales.has(a.salesman));
    outAllocCoop = allocCoop.filter((a) => mySales.has(a.salesman) || myCoops.has(a.coop));
    outAllocOutlet = allocOutlet.filter((a) => myCoops.has(a.coop) || myCust.has(String(a.custId)));
    outSpend = {
      byType: fullSpend.byType,
      bySup: (fullSpend.bySup || []).filter((r) => r.supervisor === me),
      bySales: (fullSpend.bySales || []).filter((r) => mySales.has(r.salesman)),
      byCoop: (fullSpend.byCoop || []).filter((r) => myCoops.has(r.coop)),
      byOutlet: (fullSpend.byOutlet || []).filter((r) => myCust.has(String(r.custId))),
    };
  } else if (!isMgmt) {
    // salesman (or any other non-management role): no distribution tree at all.
    structure = {};
    outSupervisors = [];
    outAlloc = []; outAllocSales = []; outAllocCoop = []; outAllocOutlet = [];
    outSpend = { byType: {}, bySup: [], bySales: [], byCoop: [], byOutlet: [] };
  }
  res.json({
    month, closed: !!(m && m.closed), types: ALL_BUDGET_TYPES, capped: CAPPED_TYPES,
    caps, alloc: outAlloc, allocSales: outAllocSales, allocCoop: outAllocCoop,
    allocOutlet: outAllocOutlet, supervisors: outSupervisors, structure,
    me: req.user ? { name: req.user.name, role: req.user.role } : null,
    spend: outSpend,
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
  // The supervisors' allocations may never exceed the admin's cap for the type.
  const cap = db.prepare('SELECT amount FROM budget_caps WHERE month=? AND budget_type=?').get(month, bt);
  if (cap && cap.amount != null) {
    const others = num(db.prepare('SELECT COALESCE(SUM(amount),0) s FROM budget_alloc WHERE month=? AND budget_type=? AND supervisor<>?').get(month, bt, sup).s);
    if (others + amount > num(cap.amount) + 1e-9) throw badRequest(overMsg(bt, cap.amount, others + amount), 'OVER_CAP');
  }
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
  // The salesmen's shares may never exceed the supervisor's own allocation.
  const supShare = db.prepare('SELECT amount FROM budget_alloc WHERE month=? AND budget_type=? AND supervisor=?').get(month, bt, supName);
  if (supShare && supShare.amount != null) {
    const others = num(db.prepare('SELECT COALESCE(SUM(amount),0) s FROM budget_alloc_sales WHERE month=? AND budget_type=? AND supervisor=? AND salesman<>?').get(month, bt, supName, salesman).s);
    if (others + amount > num(supShare.amount) + 1e-9) throw badRequest(overMsg(bt, supShare.amount, others + amount), 'OVER_ALLOC');
  }
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
    // mine[salesman] is a { coopName: [outlets] } map, not an array.
    const coops = mine[salesman] || {};
    if (!Object.prototype.hasOwnProperty.call(coops, coop)) throw forbidden('هذه الجمعية ليست ضمن مندوبك', 'NOT_MINE');
  }
  // Partial update: the UI saves the D.N (`amount`) and مجاني (`focAmount`)
  // parts from separate inputs, so a missing field keeps its stored value.
  const prev = db.prepare('SELECT amount, foc_amount FROM budget_alloc_coop WHERE month=? AND budget_type=? AND salesman=? AND coop=?').get(month, bt, salesman, coop) || {};
  const amount = req.body.amount != null ? num(req.body.amount) : num(prev.amount);
  const focAmount = req.body.focAmount != null ? num(req.body.focAmount) : num(prev.foc_amount);
  assertTeamWithin(month, bt, supName || salesSupMap()[salesman], { salesman, coop, custId: null, amount, focAmount });
  const now = nowIso();
  db.prepare('INSERT OR IGNORE INTO budget_months (month, created_at) VALUES (?, ?)').run(month, now);
  db.prepare(`INSERT INTO budget_alloc_coop (month, budget_type, salesman, coop, amount, foc_amount, updated_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(month, budget_type, salesman, coop) DO UPDATE SET amount=excluded.amount, foc_amount=excluded.foc_amount, updated_at=excluded.updated_at`)
    .run(month, bt, salesman, coop, amount, focAmount, now);
  audit.fromReq(req, 'budget.alloc.coop', { entityType: 'budget_alloc_coop', summary: `Alloc ${bt} ${month} ${salesman}->${coop} = DN ${amount} / FOC ${focAmount}`, details: { month, bt, salesman, coop, amount, focAmount } });
  res.json({ ok: true, amount, focAmount });
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
  // Partial update (D.N `amount` / مجاني `focAmount` saved from separate inputs).
  const prev = db.prepare('SELECT amount, foc_amount FROM budget_alloc_outlet WHERE month=? AND budget_type=? AND coop=? AND cust_id=?').get(month, bt, coop, custId) || {};
  const amount = req.body.amount != null ? num(req.body.amount) : num(prev.amount);
  const focAmount = req.body.focAmount != null ? num(req.body.focAmount) : num(prev.foc_amount);
  {
    // Which supervisor's team owns this outlet (admin may act for any).
    let guardSup = req.user.role === 'admin' ? null : req.user.name;
    if (!guardSup) { const st = distStructure(); for (const [sn, sms] of Object.entries(st)) { if (Object.values(sms).some((coops) => (coops[coop] || []).some((o) => o.custId === custId))) { guardSup = sn; break; } } }
    assertTeamWithin(month, bt, guardSup, { coop, custId, amount, focAmount });
  }
  const now = nowIso();
  db.prepare('INSERT OR IGNORE INTO budget_months (month, created_at) VALUES (?, ?)').run(month, now);
  db.prepare(`INSERT INTO budget_alloc_outlet (month, budget_type, coop, cust_id, amount, foc_amount, updated_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(month, budget_type, coop, cust_id) DO UPDATE SET amount=excluded.amount, foc_amount=excluded.foc_amount, updated_at=excluded.updated_at`)
    .run(month, bt, coop, custId, amount, focAmount, now);
  audit.fromReq(req, 'budget.alloc.outlet', { entityType: 'budget_alloc_outlet', summary: `Alloc ${bt} ${month} ${coop}/${custId} = DN ${amount} / FOC ${focAmount}`, details: { month, bt, coop, custId, amount, focAmount } });
  res.json({ ok: true, amount, focAmount });
}));

// POST /api/budget-spent (admin) — the month's manually entered spend for a
// type that is not driven by letters (المجاني / الكوديشن). Body: { month, budgetType, amount }.
router.post('/budget-spent', requireRole(), asyncH((req, res) => {
  const month = isMonth(req.body.month) ? req.body.month : curMonth();
  const bt = String(req.body.budgetType || '');
  if (!ALL_BUDGET_TYPES.includes(bt)) throw badRequest('نوع باجت غير صحيح', 'BAD_TYPE');
  const closed = db.prepare('SELECT closed FROM budget_months WHERE month=?').get(month);
  if (closed && closed.closed) throw badRequest('الشهر مقفل (مسكّر)', 'MONTH_CLOSED');
  const spent = req.body.amount === '' || req.body.amount == null ? null : num(req.body.amount);
  const now = nowIso();
  db.prepare('INSERT OR IGNORE INTO budget_months (month, created_at) VALUES (?, ?)').run(month, now);
  db.prepare(`INSERT INTO budget_caps (month, budget_type, amount, note, spent, updated_at) VALUES (?,?,NULL,'',?,?)
    ON CONFLICT(month, budget_type) DO UPDATE SET spent=excluded.spent, updated_at=excluded.updated_at`)
    .run(month, bt, spent, now);
  audit.fromReq(req, 'budget.spent', { entityType: 'budget_cap', summary: `Manual spend ${bt} ${month} = ${spent == null ? '—' : spent}`, details: { month, bt, spent } });
  res.json({ ok: true });
}));

// ---- Company budget (all channels, per supplier) ----
const CHANNELS = ['coop', 'ka', 'tt', 'online'];
// Budget lines in the order the business uses them.
const CB_TYPES = ['pallets', 'stands', 'polypack', 'foc', 'pricediff'];
function prevMonth(m) { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 2, 1)); return d.toISOString().slice(0, 7); }
// One amount per supplier × line × channel ('all' rows from an early version are ignored).
function cbRows(month) {
  return db.prepare("SELECT supplier_id, budget_type, channel, amount FROM company_budget WHERE month=? AND channel<>'all'").all(month)
    .map((r) => ({ supplierId: r.supplier_id, budgetType: r.budget_type, channel: r.channel, amount: r.amount }));
}
// The co-op chain's caps (what the sales manager can allocate to supervisors)
// follow the company sheet: each line's cap = the Coop column summed over the
// suppliers. Only once the month has company figures; notes/manual spend kept.
function syncCoopCaps(month, now) {
  if (!db.prepare("SELECT 1 FROM company_budget WHERE month=? AND channel<>'all' LIMIT 1").get(month)) return;
  const up = db.prepare(`INSERT INTO budget_caps (month, budget_type, amount, note, updated_at) VALUES (?,?,?,'',?)
    ON CONFLICT(month, budget_type) DO UPDATE SET amount=excluded.amount, updated_at=excluded.updated_at`);
  for (const bt of CB_TYPES) {
    const v = db.prepare(`SELECT COALESCE(SUM(b.amount),0) s FROM company_budget b JOIN company_suppliers s ON s.id=b.supplier_id AND s.active=1
      WHERE b.month=? AND b.budget_type=? AND b.channel='coop'`).get(month, bt).s;
    up.run(month, bt, Math.round(v * 1000) / 1000, now);
  }
}
// Validate + write one cell; returns the normalised cell. Throws on bad input.
function cbWrite(month, c, now) {
  const bt = String(c.budgetType || ''), ch = String(c.channel || '');
  if (!CB_TYPES.includes(bt)) throw badRequest('نوع باجت غير صحيح', 'BAD_TYPE');
  if (!CHANNELS.includes(ch)) throw badRequest('قناة غير صحيحة | Invalid channel', 'BAD_CHANNEL');
  const sup = db.prepare('SELECT id FROM company_suppliers WHERE id=? AND active=1').get(Number(c.supplierId));
  if (!sup) throw badRequest('المورد غير موجود | Supplier not found', 'BAD_SUPPLIER');
  const raw = c.amount == null ? '' : String(c.amount).replace(/,/g, '').trim();
  if (raw === '') {
    db.prepare('DELETE FROM company_budget WHERE month=? AND supplier_id=? AND budget_type=? AND channel=?').run(month, sup.id, bt, ch);
    return { supplierId: sup.id, budgetType: bt, channel: ch, amount: null };
  }
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount < 0) throw badRequest('قيمة غير صحيحة | Invalid amount', 'BAD_AMOUNT');
  db.prepare(`INSERT INTO company_budget (month, supplier_id, budget_type, channel, amount, updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(month, supplier_id, budget_type, channel) DO UPDATE SET amount=excluded.amount, updated_at=excluded.updated_at`)
    .run(month, sup.id, bt, ch, amount, now);
  return { supplierId: sup.id, budgetType: bt, channel: ch, amount };
}
const MGMT = ['sales_manager', 'marketing_manager', 'sales_ops'];
function monthClosed(month) { const r = db.prepare('SELECT closed FROM budget_months WHERE month=?').get(month); return !!(r && r.closed); }

// GET /api/budget-company?month=YYYY-MM — suppliers + every entered amount.
router.get('/budget-company', requireRole(...MGMT), asyncH((req, res) => {
  const month = isMonth(req.query.month) ? req.query.month : curMonth();
  const suppliers = db.prepare('SELECT id, code, name, sort FROM company_suppliers WHERE active=1 ORDER BY sort, id').all();
  const rows = cbRows(month);
  const prev = prevMonth(month);
  const prevCount = db.prepare("SELECT COUNT(*) c FROM company_budget WHERE month=? AND channel<>'all'").get(prev).c;
  res.json({ month, closed: monthClosed(month), types: CB_TYPES, channels: CHANNELS, suppliers, rows, prevMonth: prev, prevCount });
}));

// POST /api/budget-company (admin) — save cells. Body: { month, cells: [{ supplierId,
// budgetType, channel, amount }] } (or a single cell's fields at the top level).
// An empty amount clears the cell. All-or-nothing.
router.post('/budget-company', requireRole(), asyncH((req, res) => {
  const month = isMonth(req.body.month) ? req.body.month : curMonth();
  if (monthClosed(month)) throw badRequest('الشهر مقفل (مسكّر)', 'MONTH_CLOSED');
  const cells = Array.isArray(req.body.cells) ? req.body.cells : [req.body];
  if (!cells.length || cells.length > 2000) throw badRequest('بيانات ناقصة', 'NO_CELLS');
  const now = nowIso();
  const saved = db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO budget_months (month, created_at) VALUES (?, ?)').run(month, now);
    const out = cells.map((c) => cbWrite(month, c, now));
    syncCoopCaps(month, now);
    return out;
  })();
  audit.fromReq(req, 'budget.company', { entityType: 'company_budget', summary: `Company budget ${month}: ${saved.length} cell(s)`, details: { month, cells: saved.slice(0, 50) } });
  res.json({ ok: true, saved });
}));

// POST /api/budget-company/copy (admin) — fill this month's EMPTY cells from the
// previous month. Body: { month }
router.post('/budget-company/copy', requireRole(), asyncH((req, res) => {
  const month = isMonth(req.body.month) ? req.body.month : curMonth();
  if (monthClosed(month)) throw badRequest('الشهر مقفل (مسكّر)', 'MONTH_CLOSED');
  const prev = prevMonth(month), now = nowIso();
  const n = db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO budget_months (month, created_at) VALUES (?, ?)').run(month, now);
    const n2 = db.prepare(`INSERT OR IGNORE INTO company_budget (month, supplier_id, budget_type, channel, amount, updated_at)
      SELECT ?, b.supplier_id, b.budget_type, b.channel, b.amount, ? FROM company_budget b JOIN company_suppliers s ON s.id=b.supplier_id AND s.active=1
      WHERE b.month=? AND b.channel<>'all'`).run(month, now, prev).changes;
    syncCoopCaps(month, now); return n2;
  })();
  audit.fromReq(req, 'budget.company.copy', { entityType: 'company_budget', summary: `Company budget ${month}: copied ${n} cell(s) from ${prev}` });
  res.json({ ok: true, copied: n, from: prev });
}));

// GET /api/budget-company.xlsx?month= — the sheet as Excel (suppliers × lines × channels).
router.get('/budget-company.xlsx', requireRole(...MGMT), asyncH((req, res) => {
  const XLSX = require('xlsx');
  const month = isMonth(req.query.month) ? req.query.month : curMonth();
  const sups = db.prepare('SELECT id, code, name FROM company_suppliers WHERE active=1 ORDER BY sort, id').all();
  const LBL = { pallets: 'Pallets', stands: 'Stands', polypack: 'Condition', foc: 'Free (FOC)', pricediff: 'Price diff' };
  const val = {}; cbRows(month).forEach((r) => { val[`${r.supplierId}|${r.budgetType}|${r.channel}`] = +r.amount || 0; });
  const g = (sid, bt, ch) => val[`${sid}|${bt}|${ch}`] || 0;
  const head = ['Supplier', 'Supplier code', 'Budget line', 'Coop', 'KA', 'TT', 'Online', 'Total'];
  const aoa = [[`Company budget — ${month}`], [], head];
  const line = (a, b, c, vals) => aoa.push([a, b, c, ...vals, vals.reduce((x, y) => x + y, 0)]);
  sups.forEach((sp) => {
    CB_TYPES.forEach((bt) => line(sp.name, sp.code, LBL[bt], CHANNELS.map((ch) => g(sp.id, bt, ch))));
    line(sp.name, sp.code, 'Total', CHANNELS.map((ch) => CB_TYPES.reduce((a, bt) => a + g(sp.id, bt, ch), 0)));
    aoa.push([]);
  });
  CB_TYPES.forEach((bt) => line('Company', '', LBL[bt], CHANNELS.map((ch) => sups.reduce((a, sp) => a + g(sp.id, bt, ch), 0))));
  line('Company', '', 'Total', CHANNELS.map((ch) => sups.reduce((a, sp) => a + CB_TYPES.reduce((b, bt) => b + g(sp.id, bt, ch), 0), 0)));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [18, 14, 14, 12, 12, 12, 12, 14].map((w) => ({ wch: w }));
  Object.keys(ws).forEach((k) => { if (k[0] !== '!' && typeof ws[k].v === 'number') ws[k].z = '#,##0.000'; });
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Company budget');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="Company-Budget-${month}.xlsx"`);
  res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}));

// POST /api/budget-company/supplier (admin) — add or edit a supplier. Body: { id?, code, name }
router.post('/budget-company/supplier', requireRole(), asyncH((req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const code = String(req.body.code || '').trim().slice(0, 40);
  if (!name) throw badRequest('اسم المورد مطلوب | Supplier name is required', 'NO_NAME');
  const now = nowIso();
  let id = Number(req.body.id) || 0;
  if (id) {
    if (!db.prepare('SELECT id FROM company_suppliers WHERE id=? AND active=1').get(id)) throw notFound('المورد غير موجود | Supplier not found');
    db.prepare('UPDATE company_suppliers SET name=?, code=?, updated_at=? WHERE id=?').run(name, code, now, id);
  } else {
    const sort = (db.prepare('SELECT MAX(sort) m FROM company_suppliers').get().m || 0) + 1;
    id = db.prepare('INSERT INTO company_suppliers (code, name, sort, created_at) VALUES (?,?,?,?)').run(code, name, sort, now).lastInsertRowid;
  }
  audit.fromReq(req, 'budget.company.supplier', { entityType: 'company_supplier', entityId: String(id), summary: `Supplier ${name} (${code || 'no code'})` });
  res.json({ ok: true, id });
}));

// POST /api/budget-company/supplier/:id/remove (admin) — hide a supplier (its
// entered amounts are kept for history).
router.post('/budget-company/supplier/:id/remove', requireRole(), asyncH((req, res) => {
  const id = Number(req.params.id);
  const sup = db.prepare('SELECT id, name FROM company_suppliers WHERE id=? AND active=1').get(id);
  if (!sup) throw notFound('المورد غير موجود | Supplier not found');
  db.prepare('UPDATE company_suppliers SET active=0, updated_at=? WHERE id=?').run(nowIso(), id);
  db.prepare('SELECT DISTINCT month FROM company_budget WHERE supplier_id=?').all(id).forEach((r) => { if (!monthClosed(r.month)) syncCoopCaps(r.month, nowIso()); });
  audit.fromReq(req, 'budget.company.supplier.remove', { entityType: 'company_supplier', entityId: String(id), summary: `Removed supplier ${sup.name}` });
  res.json({ ok: true });
}));

module.exports = router;
