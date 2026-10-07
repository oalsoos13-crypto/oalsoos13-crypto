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
// Budget lines' display names [Arabic, English].
const BT_NAME = { pallets: ['الطبالي', 'Pallets'], stands: ['الستاندات', 'Stands'], pricediff: ['فروق الأسعار', 'Price off'], polypack: ['ليكويديشن', 'Liquidation'], foc: ['جيف أواي', 'Give Away'] };
function overMsg(what, limit, would) {
  const [ar, en] = BT_NAME[what] || [what, what];
  return `تجاوز البتجيت — ${ar}: الحد ${fmtKD(limit)} د.ك، والمطلوب يوصل ${fmtKD(would)} د.ك | Over budget — ${en}: limit ${fmtKD(limit)} KD, this would make ${fmtKD(would)} KD`;
}
// A supervisor team's effective totals (D.N + مجاني, outlets override their
// co-op) for a month/type, with a proposed change applied first.
// change = { salesman?, coop, custId|null, amount|null, focAmount|null } (null = keep stored)
// sc = { sid, ch } — one supplier × co-op channel; default: the earlier rows
// made before the split by supplier (supplier 0, channel '').
function teamTotals(month, bt, supName, change, sc = { sid: 0, ch: '' }) {
  const team = distStructure()[supName] || {};
  const coopMap = new Map(db.prepare('SELECT salesman, coop, amount, foc_amount FROM budget_alloc_coop WHERE month=? AND budget_type=? AND supplier_id=? AND channel=?').all(month, bt, sc.sid, sc.ch)
    .map((r) => [r.salesman + '|' + r.coop, { dn: num(r.amount), foc: num(r.foc_amount) }]));
  const outMap = new Map(db.prepare('SELECT coop, cust_id, amount, foc_amount FROM budget_alloc_outlet WHERE month=? AND budget_type=? AND supplier_id=? AND channel=?').all(month, bt, sc.sid, sc.ch)
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
// A change that does not raise the team's total is always allowed, so a team
// already over its share (e.g. after the share was lowered) can still be cut back.
function assertTeamWithin(month, bt, supName, change) {
  if (!supName) return;
  const share = db.prepare('SELECT amount FROM budget_alloc WHERE month=? AND budget_type=? AND supervisor=?').get(month, bt, supName);
  if (share && share.amount != null) {
    const t = teamTotals(month, bt, supName, change);
    if (t.total > num(share.amount) + 1e-9 && t.total > teamTotals(month, bt, supName, null).total + 1e-9) throw badRequest(overMsg(bt, share.amount, t.total), 'OVER_ALLOC');
  }
  if (DN_TYPES.includes(bt)) {
    const focShare = db.prepare('SELECT amount FROM budget_alloc WHERE month=? AND budget_type=? AND supervisor=?').get(month, 'foc', supName);
    if (focShare && focShare.amount != null) {
      let focTotal = 0, focNow = 0;
      for (const k of DN_TYPES) { focTotal += teamTotals(month, k, supName, k === bt ? change : null).foc; focNow += teamTotals(month, k, supName, null).foc; }
      if (focTotal > num(focShare.amount) + 1e-9 && focTotal > focNow + 1e-9) throw badRequest(overMsg('foc', focShare.amount, focTotal), 'OVER_FOC');
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
  const allocCoop = db.prepare('SELECT budget_type, supplier_id, channel, salesman, coop, amount, foc_amount FROM budget_alloc_coop WHERE month=?').all(month)
    .map((r) => ({ budgetType: r.budget_type, supplierId: r.supplier_id, channel: r.channel, salesman: r.salesman, coop: r.coop, amount: r.amount, focAmount: r.foc_amount || 0 }));
  const allocOutlet = db.prepare('SELECT budget_type, supplier_id, channel, coop, cust_id, amount, foc_amount FROM budget_alloc_outlet WHERE month=?').all(month)
    .map((r) => ({ budgetType: r.budget_type, supplierId: r.supplier_id, channel: r.channel, coop: r.coop, custId: r.cust_id, amount: r.amount, focAmount: r.foc_amount || 0 }));
  // What each supervisor received from the sales manager, per supplier × co-op
  // channel × line (all budget layers together).
  const distShares = db.prepare(`SELECT a.supervisor, a.supplier_id, a.channel, a.budget_type, SUM(a.amount) s FROM budget_alloc_sup a
      JOIN company_suppliers c ON c.id=a.supplier_id AND c.active=1 WHERE a.month=? GROUP BY a.supervisor, a.supplier_id, a.channel, a.budget_type`).all(month)
    .map((r) => ({ supervisor: r.supervisor, supplierId: r.supplier_id, channel: r.channel, budgetType: r.budget_type, amount: +r.s || 0 }));
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
  let outSupervisors = supervisors, outSpend = fullSpend, outShares = distShares;
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
    outShares = distShares.filter((a) => a.supervisor === me);
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
    outAlloc = []; outAllocSales = []; outAllocCoop = []; outAllocOutlet = []; outShares = [];
    outSpend = { byType: {}, bySup: [], bySales: [], byCoop: [], byOutlet: [] };
  }
  res.json({
    month, closed: !!(m && m.closed), types: ALL_BUDGET_TYPES, capped: CAPPED_TYPES,
    caps, alloc: outAlloc, allocSales: outAllocSales, allocCoop: outAllocCoop,
    allocOutlet: outAllocOutlet, supervisors: outSupervisors, structure,
    distShares: outShares, suppliers: activeSuppliers(), distChannels: CHANNELS.filter((ch) => CHANNEL_MANAGER[ch]),
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
    const before = num((db.prepare('SELECT amount FROM budget_alloc_sales WHERE month=? AND budget_type=? AND supervisor=? AND salesman=?').get(month, bt, supName, salesman) || {}).amount);
    if (others + amount > num(supShare.amount) + 1e-9 && amount > before + 1e-9) throw badRequest(overMsg(bt, supShare.amount, others + amount), 'OVER_ALLOC');
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
  const prev = db.prepare("SELECT amount, foc_amount FROM budget_alloc_coop WHERE month=? AND budget_type=? AND supplier_id=0 AND channel='' AND salesman=? AND coop=?").get(month, bt, salesman, coop) || {};
  const amount = req.body.amount != null ? num(req.body.amount) : num(prev.amount);
  const focAmount = req.body.focAmount != null ? num(req.body.focAmount) : num(prev.foc_amount);
  assertTeamWithin(month, bt, supName || salesSupMap()[salesman], { salesman, coop, custId: null, amount, focAmount });
  const now = nowIso();
  db.prepare('INSERT OR IGNORE INTO budget_months (month, created_at) VALUES (?, ?)').run(month, now);
  db.prepare(`INSERT INTO budget_alloc_coop (month, budget_type, salesman, coop, amount, foc_amount, updated_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(month, budget_type, supplier_id, channel, salesman, coop) DO UPDATE SET amount=excluded.amount, foc_amount=excluded.foc_amount, updated_at=excluded.updated_at`)
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
  const prev = db.prepare("SELECT amount, foc_amount FROM budget_alloc_outlet WHERE month=? AND budget_type=? AND supplier_id=0 AND channel='' AND coop=? AND cust_id=?").get(month, bt, coop, custId) || {};
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
    ON CONFLICT(month, budget_type, supplier_id, channel, coop, cust_id) DO UPDATE SET amount=excluded.amount, foc_amount=excluded.foc_amount, updated_at=excluded.updated_at`)
    .run(month, bt, coop, custId, amount, focAmount, now);
  audit.fromReq(req, 'budget.alloc.outlet', { entityType: 'budget_alloc_outlet', summary: `Alloc ${bt} ${month} ${coop}/${custId} = DN ${amount} / FOC ${focAmount}`, details: { month, bt, coop, custId, amount, focAmount } });
  res.json({ ok: true, amount, focAmount });
}));

// What a supervisor received for one supplier × co-op channel × line (all layers).
function distShare(month, supName, sid, ch, bt) {
  return num(db.prepare(`SELECT COALESCE(SUM(a.amount),0) s FROM budget_alloc_sup a JOIN company_suppliers c ON c.id=a.supplier_id AND c.active=1
    WHERE a.month=? AND a.supervisor=? AND a.supplier_id=? AND a.channel=? AND a.budget_type=?`).get(month, supName, sid, ch, bt).s);
}
const SC_NAME = { coop_main: ['مين', 'Main'], coop_branch: ['برانش', 'Branch'] };

// POST /api/budget-dist (supervisor) — distribute what the sales manager gave,
// per supplier × co-op channel × line, to the team's co-ops / outlets.
// Body: { month, cells: [{ supplierId, channel, budgetType, salesman, coop,
// custId?, field: 'amount' | 'focAmount', amount }] } (supplierId 0 / channel ''
// = the earlier distribution made before the split by supplier). All-or-nothing:
// a line's D.N parts may not go over what was received for that line, and the
// Give Away parts (on pallets / stands / price diff) together may not go over
// the Give Away received — unless the change only lowers the total (so an
// over-allocated team can be cut back).
router.post('/budget-dist', requireRole('supervisor'), asyncH((req, res) => {
  const month = isMonth(req.body.month) ? req.body.month : curMonth();
  if (monthClosed(month)) throw badRequest('الشهر مقفل (مسكّر)', 'MONTH_CLOSED');
  const cells = Array.isArray(req.body.cells) ? req.body.cells : [];
  if (!cells.length || cells.length > 2000) throw badRequest('بيانات ناقصة', 'NO_CELLS');
  const struct = distStructure();
  const isAdmin = req.user.role === 'admin';
  const supOfSales = salesSupMap();
  const parsed = cells.map((c) => {
    const bt = String(c.budgetType || '');
    if (!CAPPED_TYPES.includes(bt) || bt === 'foc') throw badRequest('نوع باجت غير صحيح', 'BAD_TYPE');
    const sid = Number(c.supplierId) || 0, ch = sid ? String(c.channel || '') : '';
    if (sid && !COOP_CHANNELS.includes(ch)) throw badRequest('قناة غير صحيحة | Invalid channel', 'BAD_CHANNEL');
    if (sid && !db.prepare('SELECT 1 FROM company_suppliers WHERE id=? AND active=1').get(sid)) throw badRequest('المورد غير موجود | Supplier not found', 'BAD_SUPPLIER');
    const salesman = String(c.salesman || '').trim(), coop = String(c.coop || '').trim(), custId = c.custId ? String(c.custId).trim() : null;
    if (!salesman || !coop) throw badRequest('اختر المندوب والجمعية', 'NO_TARGET');
    const supName = isAdmin ? supOfSales[salesman] : req.user.name;
    const coops = (struct[supName] || {})[salesman] || {};
    if (!Object.prototype.hasOwnProperty.call(coops, coop)) throw forbidden('هذه الجمعية ليست ضمن فريقك', 'NOT_MINE');
    if (custId && !(coops[coop] || []).some((o) => String(o.custId) === custId)) throw forbidden('هذا الأوتلت ليس ضمن نطاقك', 'NOT_MINE');
    const field = c.field === 'focAmount' ? 'focAmount' : 'amount';
    if (field === 'focAmount' && !DN_TYPES.includes(bt)) throw badRequest('الجيف أواي بس للطبالي والستاندات وفروق الأسعار', 'NO_FOC');
    const raw = c.amount == null ? '' : String(c.amount).replace(/,/g, '').trim();
    const amount = raw === '' ? 0 : Number(raw);
    if (!Number.isFinite(amount) || amount < 0) throw badRequest('قيمة غير صحيحة | Invalid amount', 'BAD_AMOUNT');
    return { bt, sid, ch, salesman, coop, custId, field, amount, supName };
  });
  // Totals before the change, per touched supervisor × supplier × channel.
  const groups = new Map();
  parsed.forEach((p) => { const k = `${p.supName}|${p.sid}|${p.ch}`; if (!groups.has(k)) groups.set(k, { supName: p.supName, sid: p.sid, ch: p.ch, bts: new Set() }); groups.get(k).bts.add(p.bt); });
  // Each line's D.N part counts against that line; the Give Away parts (on
  // pallets / stands / price diff) count against the Give Away line.
  const snap = (g) => { const o = {}; let foc = 0; DN_TYPES.concat(['polypack']).forEach((bt) => { const t = teamTotals(month, bt, g.supName, null, { sid: g.sid, ch: g.ch }); o[bt] = t.total - t.foc; foc += t.foc; }); o.foc = foc; return o; };
  const now = nowIso();
  db.transaction(() => {
    const before = new Map([...groups].map(([k, g]) => [k, snap(g)]));
    db.prepare('INSERT OR IGNORE INTO budget_months (month, created_at) VALUES (?, ?)').run(month, now);
    for (const p of parsed) {
      const col = p.field === 'focAmount' ? 'foc_amount' : 'amount';
      if (p.custId) {
        db.prepare(`INSERT INTO budget_alloc_outlet (month, budget_type, supplier_id, channel, coop, cust_id, ${col}, updated_at) VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(month, budget_type, supplier_id, channel, coop, cust_id) DO UPDATE SET ${col}=excluded.${col}, updated_at=excluded.updated_at`).run(month, p.bt, p.sid, p.ch, p.coop, p.custId, p.amount, now);
      } else {
        db.prepare(`INSERT INTO budget_alloc_coop (month, budget_type, supplier_id, channel, salesman, coop, ${col}, updated_at) VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(month, budget_type, supplier_id, channel, salesman, coop) DO UPDATE SET ${col}=excluded.${col}, updated_at=excluded.updated_at`).run(month, p.bt, p.sid, p.ch, p.salesman, p.coop, p.amount, now);
      }
    }
    for (const [k, g] of groups) {
      const was = before.get(k), is = snap(g);
      const sp = g.sid ? db.prepare('SELECT name FROM company_suppliers WHERE id=?').get(g.sid) : null;
      const where = sp ? ` — ${sp.name} / ${SC_NAME[g.ch][0]}` : '';
      const whereEn = sp ? ` — ${sp.name} / ${SC_NAME[g.ch][1]}` : '';
      // Earlier rows (before the split by supplier) have no share of their own: they can only go down.
      const limit = (bt) => (g.sid ? distShare(month, g.supName, g.sid, g.ch, bt) : 0);
      const legacyUp = () => badRequest('التوزيع السابق (قبل التقسيم حسب المورد) بس بتقدر تنزّله أو تمسحه — وزّع من جديد تحت المورد والقسم | The earlier distribution (before the split by supplier) can only be lowered or cleared — distribute again under a supplier and channel', 'OLD_DIST');
      for (const bt of [...g.bts]) {
        const lim = limit(bt);
        if (!g.sid && is[bt] > was[bt] + 1e-9) throw legacyUp();
        if (is[bt] > lim + 1e-9 && is[bt] > was[bt] + 1e-9) {
          const [ar, en] = BT_NAME[bt];
          throw badRequest(`تجاوز البتجيت — ${ar}${where}: المخصّص ${fmtKD(lim)} د.ك، والمطلوب يوصل ${fmtKD(is[bt])} د.ك | Over budget — ${en}${whereEn}: received ${fmtKD(lim)} KD, this would make ${fmtKD(is[bt])} KD`, 'OVER_ALLOC');
        }
      }
      const flim = limit('foc');
      if (!g.sid && is.foc > was.foc + 1e-9) throw legacyUp();
      if (is.foc > flim + 1e-9 && is.foc > was.foc + 1e-9) throw badRequest(`تجاوز الجيف أواي${where}: المخصّص ${fmtKD(flim)} د.ك، والمطلوب يوصل ${fmtKD(is.foc)} د.ك | Over the Give Away${whereEn}: received ${fmtKD(flim)} KD, this would make ${fmtKD(is.foc)} KD`, 'OVER_FOC');
    }
  })();
  audit.fromReq(req, 'budget.dist', { entityType: 'budget_alloc_coop', summary: `Distribution ${month}: ${parsed.length} cell(s)`, details: { month, cells: parsed.slice(0, 50).map(({ supName, ...r }) => r) } });
  res.json({ ok: true, saved: parsed.length });
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

// ---- Company budget ----
// Admin enters each brand's total per channel (brand_channel_budget). Each
// channel's manager splits his brand totals by line and supervisor
// (budget_alloc_sup — the co-op channel / sales manager today), and the
// admin's line view is built from those splits. Every month has the main
// budget (layer 0) and any number of extra budgets (layers 1..n) the admin
// adds; each layer mirrors the whole flow.
const CHANNELS = ['coop_main', 'coop_branch', 'ka', 'ecg_ecom', 'ecg_cng', 'tt_grocery', 'tt_ws', 'tt_horeca'];
// The managers split each channel by line and supervisor (Coop Main and Branch separately).
const LINE_CHANNELS = CHANNELS;
// Each channel manager role → the channels it splits by line and supervisor.
const MANAGER_CHANNELS = {
  sales_manager: ['coop_main', 'coop_branch'],
  ka_manager: ['ka'],
  online_manager: ['ecg_ecom', 'ecg_cng'],
  tt_manager: ['tt_grocery', 'tt_ws', 'tt_horeca'],
};
const MANAGER_ROLES = Object.keys(MANAGER_CHANNELS);
// Channel → the role that splits it.
const CHANNEL_MANAGER = {};
Object.entries(MANAGER_CHANNELS).forEach(([role, chs]) => chs.forEach((ch) => { CHANNEL_MANAGER[ch] = role; }));
const COOP_CHANNELS = MANAGER_CHANNELS.sales_manager;
// The channels a role manages: a manager sees its own, management sees all.
function roleChannels(role) { return MANAGER_CHANNELS[role] || CHANNELS.filter((ch) => CHANNEL_MANAGER[ch]); }
// Channel display names [Arabic, English] for the manager / over-cap messages.
const CH_NAME = { coop_main: ['مين ماركتس', 'Main Markets'], coop_branch: ['برانشيز', 'Branches'], ka: ['KA', 'KA'], ecg_ecom: ['إيكوم', 'ECOM'], ecg_cng: ['سي آند جي', 'C&G'], tt_grocery: ['بقالات', 'Grocery'], tt_ws: ['WS', 'WS'], tt_horeca: ['OOH', 'OOH'] };
// Budget lines in the order the business uses them.
const CB_TYPES = ['pallets', 'stands', 'polypack', 'foc', 'pricediff'];
// The sales manager runs the co-op channel only: he works from his brands'
// co-op totals and does not see the company-wide sheet.
const MGMT = ['marketing_manager', 'sales_ops'];
function monthClosed(month) { const r = db.prepare('SELECT closed FROM budget_months WHERE month=?').get(month); return !!(r && r.closed); }
function prevMonth(m) { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 2, 1)); return d.toISOString().slice(0, 7); }
const activeSuppliers = () => db.prepare('SELECT id, code, name, sort FROM company_suppliers WHERE active=1 ORDER BY sort, id').all();
const layerOf = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 0 ? n : 0; };
function monthLayers(month) {
  const extra = db.prepare('SELECT layer, name FROM budget_layers WHERE month=? AND layer>0 ORDER BY layer').all(month);
  return [{ layer: 0, name: null }].concat(extra);
}
function assertLayer(month, layer) {
  if (layer && !db.prepare('SELECT 1 FROM budget_layers WHERE month=? AND layer=?').get(month, layer)) throw badRequest('البتجيت الإضافي غير موجود | Extra budget not found', 'NO_LAYER');
}
// Each supplier's total (per layer) that the admin splits across the channels.
function supplierTotals(month) {
  return db.prepare('SELECT layer, supplier_id, amount, mdf_in, mdf_out FROM supplier_budget WHERE month=?').all(month)
    .map((r) => ({ layer: r.layer, supplierId: r.supplier_id, amount: r.amount, mdfIn: r.mdf_in || 0, mdfOut: r.mdf_out || 0 }));
}
function brandTotals(month) {
  return db.prepare('SELECT layer, supplier_id, channel, amount FROM brand_channel_budget WHERE month=?').all(month)
    .map((r) => ({ layer: r.layer, supplierId: r.supplier_id, channel: r.channel, amount: r.amount }));
}
// The managers' splits by line, per channel (co-op: sum over supervisors).
function channelLines(month) {
  return db.prepare('SELECT layer, supplier_id, channel, budget_type, SUM(amount) s FROM budget_alloc_sup WHERE month=? GROUP BY layer, supplier_id, channel, budget_type').all(month)
    .map((r) => ({ layer: r.layer, supplierId: r.supplier_id, budgetType: r.budget_type, channel: r.channel, amount: +r.s || 0 }));
}
// Co-op caps per line follow what the sales manager allocated over all layers
// (kept for the screens that still read budget_caps).
function syncCoopCaps(month, now) {
  if (!db.prepare('SELECT 1 FROM budget_alloc_sup WHERE month=? LIMIT 1').get(month)) return;
  const up = db.prepare(`INSERT INTO budget_caps (month, budget_type, amount, note, updated_at) VALUES (?,?,?,'',?)
    ON CONFLICT(month, budget_type) DO UPDATE SET amount=excluded.amount, updated_at=excluded.updated_at`);
  for (const bt of CB_TYPES) {
    const v = db.prepare('SELECT COALESCE(SUM(a.amount),0) s FROM budget_alloc_sup a JOIN company_suppliers c ON c.id=a.supplier_id AND c.active=1 WHERE a.month=? AND a.budget_type=?').get(month, bt).s;
    up.run(month, bt, Math.round(v * 1000) / 1000, now);
  }
}

// GET /api/budget-company?month= — brands, channels, layers, the admin's brand
// totals and the managers' split by line (all layers; rows carry `layer`).
router.get('/budget-company', requireRole(...MGMT), asyncH((req, res) => {
  const month = isMonth(req.query.month) ? req.query.month : curMonth();
  const prev = prevMonth(month);
  const prevCounts = {};
  db.prepare('SELECT layer, COUNT(*) c FROM (SELECT layer FROM brand_channel_budget WHERE month=? UNION ALL SELECT layer FROM supplier_budget WHERE month=?) GROUP BY layer').all(prev, prev).forEach((r) => { prevCounts[r.layer] = r.c; });
  res.json({
    month, closed: monthClosed(month), types: CB_TYPES, channels: CHANNELS, lineChannels: LINE_CHANNELS, managed: Object.keys(CHANNEL_MANAGER),
    suppliers: activeSuppliers(), layers: monthLayers(month), supTotals: supplierTotals(month), totals: brandTotals(month), lines: channelLines(month), prevMonth: prev, prevCounts,
  });
}));

// POST /api/budget-company (admin) — supplier totals and their split by channel.
// Body: { month, cells: [{ layer, supplierId, channel, amount }] } where channel
// 'total' is the supplier's total; an empty amount clears the cell. Once a
// supplier has a total, its channels together may not go over it. All-or-nothing.
router.post('/budget-company', requireRole(), asyncH((req, res) => {
  const month = isMonth(req.body.month) ? req.body.month : curMonth();
  if (monthClosed(month)) throw badRequest('الشهر مقفل (مسكّر)', 'MONTH_CLOSED');
  const cells = Array.isArray(req.body.cells) ? req.body.cells : [req.body];
  if (!cells.length || cells.length > 500) throw badRequest('بيانات ناقصة', 'NO_CELLS');
  const now = nowIso();
  const saved = db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO budget_months (month, created_at) VALUES (?, ?)').run(month, now);
    const touched = new Map();
    const out = cells.map((c) => {
      const ch = String(c.channel || ''), layer = layerOf(c.layer);
      assertLayer(month, layer);
      const SUP_FIELDS = ['total', 'mdf_in', 'mdf_out'];
      if (!SUP_FIELDS.includes(ch) && !CHANNELS.includes(ch)) throw badRequest('قناة غير صحيحة | Invalid channel', 'BAD_CHANNEL');
      const sp = db.prepare('SELECT id, name FROM company_suppliers WHERE id=? AND active=1').get(Number(c.supplierId));
      if (!sp) throw badRequest('المورد غير موجود | Supplier not found', 'BAD_SUPPLIER');
      touched.set(`${layer}|${sp.id}`, sp.name);
      const raw = c.amount == null ? '' : String(c.amount).replace(/,/g, '').trim();
      const amount = Number(raw);
      if (raw !== '' && (!Number.isFinite(amount) || amount < 0)) throw badRequest('قيمة غير صحيحة | Invalid amount', 'BAD_AMOUNT');
      if (ch === 'total' || ch === 'mdf_in' || ch === 'mdf_out') {
        // Supplier total = MDF-IN + MDF-OUT. The admin types the two parts; the
        // total is their sum. ('total' is kept for older callers.)
        const prev = db.prepare('SELECT mdf_in, mdf_out FROM supplier_budget WHERE month=? AND layer=? AND supplier_id=?').get(month, layer, sp.id) || { mdf_in: 0, mdf_out: 0 };
        let vIn = num(prev.mdf_in), vOut = num(prev.mdf_out);
        if (ch === 'mdf_in') vIn = raw === '' ? 0 : amount;
        else if (ch === 'mdf_out') vOut = raw === '' ? 0 : amount;
        else { vIn = raw === '' ? 0 : amount; vOut = 0; } // legacy 'total'
        const tot = Math.round((vIn + vOut) * 1000) / 1000;
        if (tot === 0 && raw === '') db.prepare('DELETE FROM supplier_budget WHERE month=? AND layer=? AND supplier_id=?').run(month, layer, sp.id);
        else db.prepare(`INSERT INTO supplier_budget (month, layer, supplier_id, amount, mdf_in, mdf_out, updated_at) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(month, layer, supplier_id) DO UPDATE SET amount=excluded.amount, mdf_in=excluded.mdf_in, mdf_out=excluded.mdf_out, updated_at=excluded.updated_at`).run(month, layer, sp.id, tot, vIn, vOut, now);
      } else if (raw === '') db.prepare('DELETE FROM brand_channel_budget WHERE month=? AND layer=? AND supplier_id=? AND channel=?').run(month, layer, sp.id, ch);
      else db.prepare(`INSERT INTO brand_channel_budget (month, layer, supplier_id, channel, amount, updated_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(month, layer, supplier_id, channel) DO UPDATE SET amount=excluded.amount, updated_at=excluded.updated_at`).run(month, layer, sp.id, ch, amount, now);
      return { layer, supplierId: sp.id, channel: ch, amount: raw === '' ? null : amount };
    });
    for (const [k, sname] of touched) {
      const [layer, sid] = k.split('|').map(Number);
      const tot = db.prepare('SELECT amount FROM supplier_budget WHERE month=? AND layer=? AND supplier_id=?').get(month, layer, sid);
      if (!tot) continue;
      const split = num(db.prepare('SELECT COALESCE(SUM(amount),0) s FROM brand_channel_budget WHERE month=? AND layer=? AND supplier_id=?').get(month, layer, sid).s);
      if (split > num(tot.amount) + 1e-9) throw badRequest(`مجموع الأقسام أكبر من توتال المورد — ${sname}${layer ? ` (بتجيت إضافي ${layer})` : ''}: التوتال ${num(tot.amount).toFixed(3)} د.ك، والأقسام ${split.toFixed(3)} د.ك | The channels add up to more than the supplier total — ${sname}${layer ? ` (extra budget ${layer})` : ''}: total ${num(tot.amount).toFixed(3)} KD, channels ${split.toFixed(3)} KD`, 'OVER_SUPPLIER');
    }
    return out;
  })();
  audit.fromReq(req, 'budget.company', { entityType: 'brand_budget', summary: `Brand budgets ${month}: ${saved.length} cell(s)`, details: { month, cells: saved } });
  res.json({ ok: true, saved });
}));

// POST /api/budget-company/layer (admin) — add an extra budget to the month. Body: { month }
router.post('/budget-company/layer', requireRole(), asyncH((req, res) => {
  const month = isMonth(req.body.month) ? req.body.month : curMonth();
  if (monthClosed(month)) throw badRequest('الشهر مقفل (مسكّر)', 'MONTH_CLOSED');
  const now = nowIso();
  const layer = (db.prepare('SELECT MAX(layer) m FROM budget_layers WHERE month=?').get(month).m || 0) + 1;
  db.prepare('INSERT OR IGNORE INTO budget_months (month, created_at) VALUES (?, ?)').run(month, now);
  db.prepare('INSERT INTO budget_layers (month, layer, name, created_at) VALUES (?,?,?,?)').run(month, layer, null, now);
  audit.fromReq(req, 'budget.layer.add', { entityType: 'budget_layer', entityId: `${month}#${layer}`, summary: `Extra budget ${layer} added to ${month}` });
  res.json({ ok: true, layer });
}));

// POST /api/budget-company/layer/remove (admin) — delete an extra budget with its
// brand totals and the managers' split of it. Body: { month, layer }
router.post('/budget-company/layer/remove', requireRole(), asyncH((req, res) => {
  const month = isMonth(req.body.month) ? req.body.month : curMonth();
  const layer = layerOf(req.body.layer);
  if (!layer) throw badRequest('لا يمكن حذف البتجيت الأساسي | The main budget cannot be removed', 'MAIN_LAYER');
  if (monthClosed(month)) throw badRequest('الشهر مقفل (مسكّر)', 'MONTH_CLOSED');
  assertLayer(month, layer);
  const now = nowIso();
  db.transaction(() => {
    db.prepare('DELETE FROM brand_channel_budget WHERE month=? AND layer=?').run(month, layer);
    db.prepare('DELETE FROM supplier_budget WHERE month=? AND layer=?').run(month, layer);
    db.prepare('DELETE FROM budget_alloc_sup WHERE month=? AND layer=?').run(month, layer);
    db.prepare('DELETE FROM budget_layers WHERE month=? AND layer=?').run(month, layer);
    syncAllocFromSup(month, now);
  })();
  audit.fromReq(req, 'budget.layer.remove', { entityType: 'budget_layer', entityId: `${month}#${layer}`, summary: `Extra budget ${layer} removed from ${month}` });
  res.json({ ok: true });
}));

// POST /api/budget-company/copy (admin) — fill this month's EMPTY brand totals of a
// layer from the same layer of the previous month. Body: { month, layer }
router.post('/budget-company/copy', requireRole(), asyncH((req, res) => {
  const month = isMonth(req.body.month) ? req.body.month : curMonth();
  const layer = layerOf(req.body.layer);
  if (monthClosed(month)) throw badRequest('الشهر مقفل (مسكّر)', 'MONTH_CLOSED');
  assertLayer(month, layer);
  const prev = prevMonth(month), now = nowIso();
  const n = db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO budget_months (month, created_at) VALUES (?, ?)').run(month, now);
    return db.prepare(`INSERT OR IGNORE INTO supplier_budget (month, layer, supplier_id, amount, updated_at)
      SELECT ?, b.layer, b.supplier_id, b.amount, ? FROM supplier_budget b JOIN company_suppliers s ON s.id=b.supplier_id AND s.active=1 WHERE b.month=? AND b.layer=?`).run(month, now, prev, layer).changes
      + db.prepare(`INSERT OR IGNORE INTO brand_channel_budget (month, layer, supplier_id, channel, amount, updated_at)
      SELECT ?, b.layer, b.supplier_id, b.channel, b.amount, ? FROM brand_channel_budget b JOIN company_suppliers s ON s.id=b.supplier_id AND s.active=1 WHERE b.month=? AND b.layer=?`).run(month, now, prev, layer).changes;
  })();
  audit.fromReq(req, 'budget.company.copy', { entityType: 'brand_budget', summary: `Brand budgets ${month} (layer ${layer}): copied ${n} cell(s) from ${prev}` });
  res.json({ ok: true, copied: n, from: prev });
}));

// GET /api/budget-company.xlsx?month= — per layer: brand totals + the managers' split by line.
router.get('/budget-company.xlsx', requireRole(...MGMT), asyncH((req, res) => {
  const XLSX = require('xlsx');
  const month = isMonth(req.query.month) ? req.query.month : curMonth();
  const sups = activeSuppliers();
  const CH = { coop: 'Coops', coop_main: 'Coops Main Markets', coop_branch: 'Coops Branches', ka: 'KA', ecg: 'ECG', ecg_ecom: 'ECG ECOM', ecg_cng: 'ECG C&G', tt_grocery: 'TT Grocery', tt_ws: 'TT WS', tt_horeca: 'TT OOH' };
  const LBL = { pallets: 'Pallets', stands: 'Stands', polypack: 'Liquidation', foc: 'Give Away', pricediff: 'Price off' };
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const TT = ['tt_grocery', 'tt_ws', 'tt_horeca'];
  const ECG = ['ecg_ecom', 'ecg_cng'];
  const GROUPS = { coop: COOP_CHANNELS, ecg: ECG, tt: TT };
  const COLS = ['coop_main', 'coop_branch', 'coop', 'ka', 'ecg_ecom', 'ecg_cng', 'ecg', ...TT, 'tt'];
  const allTot = brandTotals(month), allLn = channelLines(month), allSup = supplierTotals(month);
  const wb = XLSX.utils.book_new();
  for (const { layer } of monthLayers(month)) {
    const lname = layer ? `Extra ${layer}` : 'Main';
    const tot = {}; allTot.filter((r) => r.layer === layer).forEach((r) => { tot[`${r.supplierId}|${r.channel}`] = +r.amount || 0; });
    sups.forEach((sp) => { tot[`${sp.id}|coop`] = (tot[`${sp.id}|coop_main`] || 0) + (tot[`${sp.id}|coop_branch`] || 0); });
    const ln = {}; allLn.filter((r) => r.layer === layer).forEach((r) => { ln[`${r.supplierId}|${r.budgetType}|${r.channel}`] = +r.amount || 0; });
    const g = (sid, c) => GROUPS[c] ? sum(GROUPS[c].map((x) => tot[`${sid}|${x}`] || 0)) : (tot[`${sid}|${c}`] || 0);
    const st = {}, stIn = {}, stOut = {}; allSup.filter((r) => r.layer === layer).forEach((r) => { st[r.supplierId] = +r.amount || 0; stIn[r.supplierId] = +r.mdfIn || 0; stOut[r.supplierId] = +r.mdfOut || 0; });
    const split = (sid) => sum(CHANNELS.map((c) => g(sid, c)));
    const head = ['UDC Supplier', 'Code', 'MDF-IN', 'MDF-OUT', 'Total Supplier', ...COLS.map((c) => c === 'coop' ? 'Total Coops' : c === 'ecg' ? 'Total ECG' : c === 'tt' ? 'Total TT' : CH[c]), 'Split into channels', 'Remaining'];
    const a1 = [[`${lname} budget — supplier totals and their split by channel — ${month}`], [], head];
    sups.forEach((sp) => a1.push([sp.name, sp.code, stIn[sp.id] || 0, stOut[sp.id] || 0, st[sp.id] == null ? '' : st[sp.id], ...COLS.map((c) => g(sp.id, c)), split(sp.id), st[sp.id] == null ? '' : st[sp.id] - split(sp.id)]));
    const stAll = sum(sups.map((sp) => st[sp.id] || 0)), splitAll = sum(sups.map((sp) => split(sp.id)));
    a1.push(['Total Company', '', sum(sups.map((sp) => stIn[sp.id] || 0)), sum(sups.map((sp) => stOut[sp.id] || 0)), stAll, ...COLS.map((c) => sum(sups.map((sp) => g(sp.id, c)))), splitAll, sum(sups.filter((sp) => st[sp.id] != null).map((sp) => st[sp.id] - split(sp.id)))]);
    // Split by line, one section per channel and per group total (Coop, TT); brands across.
    const bh = ['Channel', 'Line', ...sups.map((sp) => sp.name + (sp.code ? ` (${sp.code})` : '')), 'Total'];
    const a2 = [[`${lname} budget — split by line, by channel (from the channel managers) — ${month}`], [], bh];
    const rowOf = (name, label, fn) => { const v = sups.map((sp) => fn(sp.id)); a2.push([name, label, ...v, sum(v)]); };
    const SECTIONS = [['coop_main'], ['coop_branch'], ['coop', COOP_CHANNELS], ['ka'], ['ecg_ecom'], ['ecg_cng'], ['ecg', ECG], ...TT.map((c) => [c]), ['tt', TT]];
    SECTIONS.forEach(([name, chs = [name]]) => {
      const label = name === 'coop' ? 'Total Coops' : name === 'ecg' ? 'Total ECG' : name === 'tt' ? 'Total TT' : CH[name];
      const managed = chs.some((ch) => CHANNEL_MANAGER[ch]);
      const L = (sid, bt) => sum(chs.filter((ch) => CHANNEL_MANAGER[ch]).map((ch) => ln[`${sid}|${bt}|${ch}`] || 0));
      const B = (sid) => sum(chs.map((ch) => tot[`${sid}|${ch}`] || 0));
      if (managed) {
        CB_TYPES.forEach((bt) => {
          if (bt === 'pallets') rowOf(label, 'Off-Shelf Display', (sid) => L(sid, 'pallets') + L(sid, 'stands'));
          rowOf(label, LBL[bt], (sid) => L(sid, bt));
        });
        rowOf(label, 'Allocated to supervisors', (sid) => sum(CB_TYPES.map((bt) => L(sid, bt))));
      }
      rowOf(label, managed ? 'Total budget' : 'Total budget (no manager yet)', B);
      if (managed) rowOf(label, 'Budget left', (sid) => B(sid) - sum(CB_TYPES.map((bt) => L(sid, bt))));
      a2.push([]);
    });
    for (const [aoa, name] of [[a1, `${lname} - brand totals`], [a2, `${lname} - split by line`]]) {
      const ws = XLSX.utils.aoa_to_sheet(aoa); ws['!cols'] = [16, 12, 14, 12, 12, 12, 12, 12, 16, 14, 14].map((w) => ({ wch: w }));
      Object.keys(ws).forEach((k) => { if (k[0] !== '!' && typeof ws[k].v === 'number') ws[k].z = '#,##0.000'; });
      XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
    }
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="Company-Budget-${month}.xlsx"`);
  res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}));

// ---- Co-op channel: the sales manager splits each brand's co-op total by line
// and supervisor, per layer ----
function managerBudget(month, layer, channels) { // { 'sid|channel': amount } — each brand's total per channel
  const m = {}; if (!channels.length) return m;
  const ph = channels.map(() => '?').join(',');
  db.prepare(`SELECT supplier_id, channel, amount FROM brand_channel_budget WHERE month=? AND layer=? AND channel IN (${ph})`).all(month, layer, ...channels).forEach((r) => { m[`${r.supplier_id}|${r.channel}`] = +r.amount || 0; });
  return m;
}
// budget_alloc (line × supervisor), which the supervisors distribute from, is
// the sum over brands and layers — once the month is allocated per brand.
function syncAllocFromSup(month, now) {
  const sums = {};
  db.prepare('SELECT budget_type, supervisor, SUM(amount) s FROM budget_alloc_sup a JOIN company_suppliers c ON c.id=a.supplier_id AND c.active=1 WHERE month=? GROUP BY budget_type, supervisor').all(month)
    .forEach((r) => { sums[`${r.budget_type}|${r.supervisor}`] = +r.s || 0; });
  if (!Object.keys(sums).length && !db.prepare('SELECT 1 FROM budget_layers WHERE month=? LIMIT 1').get(month)) return;
  db.prepare('SELECT budget_type, supervisor FROM budget_alloc WHERE month=?').all(month)
    .forEach((r) => { const k = `${r.budget_type}|${r.supervisor}`; if (!(k in sums)) sums[k] = 0; });
  const up = db.prepare(`INSERT INTO budget_alloc (month, budget_type, supervisor, amount, updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(month, budget_type, supervisor) DO UPDATE SET amount=excluded.amount, updated_at=excluded.updated_at`);
  Object.entries(sums).forEach(([k, v]) => { const [bt, sup] = k.split('|'); up.run(month, bt, sup, Math.round(v * 1000) / 1000, now); });
  syncCoopCaps(month, now);
}

// GET /api/budget-alloc-sup?month= — layers, brands, supervisors, each brand's
// co-op total per layer and the sales manager's split of it.
router.get('/budget-alloc-sup', requireRole(...MANAGER_ROLES, ...MGMT), asyncH((req, res) => {
  const month = isMonth(req.query.month) ? req.query.month : curMonth();
  const channels = roleChannels(req.user.role);
  const supervisors = db.prepare("SELECT name FROM users WHERE role='supervisor' AND active=1 ORDER BY name").all().map((r) => r.name);
  const layers = monthLayers(month);
  const budget = [];
  layers.forEach(({ layer }) => Object.entries(managerBudget(month, layer, channels)).forEach(([k, amount]) => { const [sid, channel] = k.split('|'); budget.push({ layer, supplierId: +sid, channel, amount }); }));
  const chSet = new Set(channels);
  const rows = db.prepare('SELECT layer, supplier_id, channel, budget_type, supervisor, amount FROM budget_alloc_sup WHERE month=?').all(month)
    .filter((r) => chSet.has(r.channel))
    .map((r) => ({ layer: r.layer, supplierId: r.supplier_id, channel: r.channel, budgetType: r.budget_type, supervisor: r.supervisor, amount: r.amount }));
  res.json({ month, closed: monthClosed(month), types: CB_TYPES, channels, suppliers: activeSuppliers(), supervisors, layers, budget, rows });
}));

// POST /api/budget-alloc-sup (sales manager) — { month, cells: [{ layer, supplierId,
// channel (coop_main | coop_branch), budgetType, supervisor, amount }] }. Within a
// layer, a brand's split of a channel (all lines, all supervisors) may never exceed
// its total in that channel. All-or-nothing.
router.post('/budget-alloc-sup', requireRole(...MANAGER_ROLES), asyncH((req, res) => {
  const myChannels = new Set(roleChannels(req.user.role));
  const month = isMonth(req.body.month) ? req.body.month : curMonth();
  if (monthClosed(month)) throw badRequest('الشهر مقفل (مسكّر)', 'MONTH_CLOSED');
  const cells = Array.isArray(req.body.cells) ? req.body.cells : [req.body];
  if (!cells.length || cells.length > 2000) throw badRequest('بيانات ناقصة', 'NO_CELLS');
  const sups = new Set(db.prepare("SELECT name FROM users WHERE role='supervisor' AND active=1").all().map((r) => r.name));
  const now = nowIso();
  const saved = db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO budget_months (month, created_at) VALUES (?, ?)').run(month, now);
    const touched = new Map();
    const out = cells.map((c) => {
      const bt = String(c.budgetType || ''), sv = String(c.supervisor || '').trim(), layer = layerOf(c.layer), ch = String(c.channel || '');
      assertLayer(month, layer);
      if (!myChannels.has(ch)) throw badRequest('قناة غير صحيحة | Invalid channel', 'BAD_CHANNEL');
      if (!CB_TYPES.includes(bt)) throw badRequest('نوع باجت غير صحيح', 'BAD_TYPE');
      if (!sups.has(sv)) throw badRequest('اختر المشرف', 'NO_SUP');
      const sp = db.prepare('SELECT id, name FROM company_suppliers WHERE id=? AND active=1').get(Number(c.supplierId));
      if (!sp) throw badRequest('المورد غير موجود | Supplier not found', 'BAD_SUPPLIER');
      const raw = c.amount == null ? '' : String(c.amount).replace(/,/g, '').trim();
      if (raw === '') db.prepare('DELETE FROM budget_alloc_sup WHERE month=? AND layer=? AND supplier_id=? AND channel=? AND budget_type=? AND supervisor=?').run(month, layer, sp.id, ch, bt, sv);
      else {
        const amount = Number(raw);
        if (!Number.isFinite(amount) || amount < 0) throw badRequest('قيمة غير صحيحة | Invalid amount', 'BAD_AMOUNT');
        db.prepare(`INSERT INTO budget_alloc_sup (month, layer, supplier_id, channel, budget_type, supervisor, amount, updated_at) VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(month, layer, supplier_id, channel, budget_type, supervisor) DO UPDATE SET amount=excluded.amount, updated_at=excluded.updated_at`).run(month, layer, sp.id, ch, bt, sv, amount, now);
      }
      touched.set(`${layer}|${sp.id}|${ch}`, sp.name);
      return { layer, supplierId: sp.id, channel: ch, budgetType: bt, supervisor: sv, amount: raw === '' ? null : Number(raw) };
    });
    for (const [k, sname] of touched) {
      const [ls, sids, ch] = k.split('|'); const layer = +ls, sid = +sids;
      const tot = num(db.prepare('SELECT COALESCE(SUM(amount),0) s FROM budget_alloc_sup WHERE month=? AND layer=? AND supplier_id=? AND channel=?').get(month, layer, sid, ch).s);
      const lim = managerBudget(month, layer, [ch])[`${sid}|${ch}`] || 0;
      const chn = CH_NAME[ch] || [ch, ch];
      if (tot > lim + 1e-9) throw badRequest(`تجاوز البتجيت — ${sname} / ${chn[0]}${layer ? ` (بتجيت إضافي ${layer})` : ''}: الحد ${lim.toFixed(3)} د.ك، والمطلوب يوصل ${tot.toFixed(3)} د.ك | Over budget — ${sname} / ${chn[1]}${layer ? ` (extra budget ${layer})` : ''}: limit ${lim.toFixed(3)} KD, this would make ${tot.toFixed(3)} KD`, 'OVER_CAP');
    }
    syncAllocFromSup(month, now);
    return out;
  })();
  audit.fromReq(req, 'budget.alloc.sup', { entityType: 'budget_alloc', summary: `Co-op allocation ${month}: ${saved.length} cell(s)`, details: { month, cells: saved.slice(0, 50) } });
  res.json({ ok: true, saved });
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
  db.prepare('SELECT DISTINCT month FROM budget_alloc_sup WHERE supplier_id=?').all(id).forEach((r) => { if (!monthClosed(r.month)) syncAllocFromSup(r.month, nowIso()); });
  audit.fromReq(req, 'budget.company.supplier.remove', { entityType: 'company_supplier', entityId: String(id), summary: `Removed supplier ${sup.name}` });
  res.json({ ok: true });
}));

module.exports = router;
