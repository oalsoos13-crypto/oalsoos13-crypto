'use strict';
const express = require('express');
const db = require('../db');
const audit = require('../audit');
const { requireAuth, requireRole } = require('../auth');
const { asyncH, genId, nowIso, num } = require('../util');

const router = express.Router();
router.use(requireAuth);

// PUT /api/dist  (division) — replace the whole distribution table.
// Body: { rows: [{ sup, sales, coop, outlet, wob, amt, manual }] }
router.put('/dist', requireRole('division'), asyncH((req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  const clean = rows
    .filter((r) => (r.sup || r.sales || r.coop))
    .map((r) => ({
      id: r.id && String(r.id).startsWith('D') ? r.id : genId('D'),
      sup: r.sup || '', sales: r.sales || '', coop: r.coop || '', outlet: r.outlet || '',
      wob: num(r.wob), amt: r.manual ? num(r.amt) : null, manual: r.manual ? 1 : 0,
    }));
  const now = nowIso();
  const insert = db.prepare(`INSERT INTO dist (id, sup, sales, coop, outlet, wob, amt, manual, updated_by, updated_at)
                             VALUES (@id, @sup, @sales, @coop, @outlet, @wob, @amt, @manual, @by, @now)`);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM dist').run();
    for (const r of clean) insert.run({ ...r, by: req.user.id, now });
  });
  tx();
  audit.fromReq(req, 'dist.save', {
    entityType: 'dist', summary: `Saved distribution (${clean.length} rows)`,
    details: { rows: clean.length, manualRows: clean.filter((r) => r.manual).length },
  });
  res.json({ ok: true, rows: clean.length });
}));

module.exports = router;
