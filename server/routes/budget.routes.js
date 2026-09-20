'use strict';
const express = require('express');
const db = require('../db');
const audit = require('../audit');
const { requireAuth, requireRole } = require('../auth');
const { asyncH, genId, nowIso, num, badRequest, notFound } = require('../util');
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
const CAPPED_TYPES = ['rental', 'pricediff', 'polypack', 'foc'];
const ALL_BUDGET_TYPES = CAPPED_TYPES.concat(['offinv']);
function curMonth() { return nowIso().slice(0, 7); }
function isMonth(m) { return /^\d{4}-\d{2}$/.test(String(m || '')); }
// Spend for a month, from letters carrying a budget type, split into the letter
// value and the debit-note value, aggregated by type and by supervisor.
function monthSpend(month) {
  const letters = db.prepare(
    "SELECT id, sales, budget_type, value FROM letters WHERE budget_type IS NOT NULL AND TRIM(budget_type)<>'' AND substr(COALESCE(date,''),1,7)=?"
  ).all(month);
  const supMap = {};
  db.prepare("SELECT DISTINCT sales, sup FROM dist WHERE sup IS NOT NULL AND sales IS NOT NULL").all()
    .forEach((r) => { supMap[r.sales] = r.sup; });
  const noteVal = {};
  db.prepare("SELECT letter_id, SUM(value) v FROM notes WHERE status!='rejected' GROUP BY letter_id").all()
    .forEach((r) => { noteVal[r.letter_id] = r.v; });
  const byType = {}, bySup = {};
  for (const L of letters) {
    const bt = L.budget_type, sup = supMap[L.sales] || '—';
    const lv = num(L.value), nv = num(noteVal[L.id] || 0);
    (byType[bt] = byType[bt] || { letter: 0, note: 0 }); byType[bt].letter += lv; byType[bt].note += nv;
    const k = sup + '|' + bt;
    (bySup[k] = bySup[k] || { supervisor: sup, budgetType: bt, letter: 0, note: 0 }); bySup[k].letter += lv; bySup[k].note += nv;
  }
  return { byType, bySup: Object.values(bySup) };
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
  res.json({
    month, closed: !!(m && m.closed), types: ALL_BUDGET_TYPES, capped: CAPPED_TYPES,
    caps, alloc, supervisors, spend: monthSpend(month),
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

module.exports = router;
