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
router.post('/budgets', requireRole('marketing'), asyncH((req, res) => {
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
router.delete('/budgets/:id', requireRole('marketing'), asyncH((req, res) => {
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
router.put('/channels', requireRole('marketing'), asyncH((req, res) => {
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

module.exports = router;
