'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { asyncH, fromJson } = require('../util');

const router = express.Router();
router.use(requireAuth);

// GET /api/outlets — outlet master joined with contract terms.
// Readable by any authenticated user (internal reference data).
router.get('/outlets', asyncH((req, res) => {
  const rows = db.prepare(`
    SELECT o.*, c.pct, c.lumsum, c.bonus, c.slap,
           c.category_total, c.lays AS c_lays, c.iec AS c_iec, c.iec_off_shelf, c.gondola
    FROM outlets o LEFT JOIN contracts c ON c.cust_id = o.cust_id
    ORDER BY o.parent, o.name`).all();
  res.json({ total: rows.length, outlets: rows });
}));

// GET /api/sales — annual sales & targets per parent co-op.
// Management + documentation only (financial data).
router.get('/sales', requireRole('marketing', 'division', 'doc'), asyncH((req, res) => {
  const rows = db.prepare('SELECT * FROM sales_history ORDER BY parent').all()
    .map((r) => ({ ...r, years: fromJson(r.years, {}) }));
  res.json({ total: rows.length, sales: rows });
}));

module.exports = router;
