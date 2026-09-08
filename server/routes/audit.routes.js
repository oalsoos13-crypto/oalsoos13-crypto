'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { asyncH, num } = require('../util');

const router = express.Router();
// Guard each route individually (admin implicitly allowed by requireRole).
// NOTE: do NOT use a pass-through `router.use(requireRole(...))` here — this
// router shares the '/api' mount, so a blanket gate would reject requests for
// routes defined in other routers mounted after this one.
const guard = [requireAuth, requireRole('doc')];

// Build a WHERE clause + params from query filters.
function buildFilter(q) {
  const where = [];
  const params = {};
  if (q.username) { where.push('username = @username'); params.username = String(q.username).toLowerCase(); }
  if (q.action) { where.push('action LIKE @action'); params.action = '%' + q.action + '%'; }
  if (q.entityType) { where.push('entity_type = @entityType'); params.entityType = q.entityType; }
  if (q.entityId) { where.push('entity_id = @entityId'); params.entityId = String(q.entityId); }
  if (q.from) { where.push('ts >= @from'); params.from = String(q.from); }
  if (q.to) { where.push('ts <= @to'); params.to = String(q.to) + '￿'; } // inclusive day
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return { clause, params };
}

// GET /api/audit — paginated audit rows, newest first.
router.get('/audit', guard, asyncH((req, res) => {
  const { clause, params } = buildFilter(req.query);
  const limit = Math.min(1000, Math.max(1, num(req.query.limit, 200)));
  const offset = Math.max(0, num(req.query.offset, 0));
  const total = db.prepare(`SELECT COUNT(*) n FROM audit_log ${clause}`).get(params).n;
  const rows = db.prepare(
    `SELECT * FROM audit_log ${clause} ORDER BY id DESC LIMIT @limit OFFSET @offset`
  ).all({ ...params, limit, offset });
  res.json({ total, limit, offset, rows });
}));

function csvCell(v) {
  if (v == null) return '';
  const s = String(v).replace(/"/g, '""');
  return /[",\n\r]/.test(s) ? `"${s}"` : s;
}

// GET /api/audit/export.csv — full filtered export (UTF-8 BOM for Excel/Arabic).
router.get('/audit/export.csv', guard, asyncH((req, res) => {
  const { clause, params } = buildFilter(req.query);
  const rows = db.prepare(`SELECT * FROM audit_log ${clause} ORDER BY id DESC`).all(params);
  const cols = ['id', 'ts', 'username', 'name', 'role', 'action', 'entity_type', 'entity_id', 'summary', 'ip', 'details'];
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map((c) => csvCell(r[c])).join(','));
  const csv = '﻿' + lines.join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="udc-audit-${Date.now()}.csv"`);
  res.send(csv);
}));

function sendCsv(res, name, cols, rows) {
  const lines = [cols.map((c) => c.h).join(',')];
  for (const r of rows) lines.push(cols.map((c) => csvCell(c.f ? c.f(r) : r[c.k])).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}-${Date.now()}.csv"`);
  res.send('﻿' + lines.join('\r\n'));
}

// GET /api/export/notes.csv — debit notes register for auditors.
router.get('/export/notes.csv', guard, asyncH((req, res) => {
  const rows = db.prepare(`
    SELECT n.*, s.name AS sup_name, m.name AS mgr_name, rj.name AS rej_name, cr.name AS creator
    FROM notes n
    LEFT JOIN users s  ON s.id  = n.sup_approved_by
    LEFT JOIN users m  ON m.id  = n.mgr_approved_by
    LEFT JOIN users rj ON rj.id = n.rejected_by
    LEFT JOIN users cr ON cr.id = n.created_by
    ORDER BY n.created_at DESC`).all();
  sendCsv(res, 'udc-notes', [
    { h: 'lysal', k: 'lysal' }, { h: 'coop_dn', k: 'coop_dn' }, { h: 'coop', k: 'coop' },
    { h: 'type', k: 'type' }, { h: 'brand', k: 'brand' }, { h: 'salesman', k: 'sales' },
    { h: 'value', k: 'value' }, { h: 'date', k: 'date' }, { h: 'status', k: 'status' },
    { h: 'created_by', k: 'creator' }, { h: 'created_at', k: 'created_at' },
    { h: 'sup_approved_by', k: 'sup_name' }, { h: 'sup_approved_at', k: 'sup_approved_at' },
    { h: 'mgr_approved_by', k: 'mgr_name' }, { h: 'mgr_approved_at', k: 'mgr_approved_at' },
    { h: 'rejected_by', k: 'rej_name' }, { h: 'rejected_at', k: 'rejected_at' },
    { h: 'rejected_stage', k: 'rejected_stage' }, { h: 'reject_reason', k: 'reject_reason' },
  ], rows);
}));

// GET /api/export/letters.csv — letters register for auditors.
router.get('/export/letters.csv', guard, asyncH((req, res) => {
  const rows = db.prepare(`
    SELECT l.*, cr.name AS creator FROM letters l
    LEFT JOIN users cr ON cr.id = l.created_by ORDER BY l.created_at DESC`).all();
  sendCsv(res, 'udc-letters', [
    { h: 'lysal', k: 'lysal' }, { h: 'type', k: 'type' }, { h: 'coop', k: 'coop' },
    { h: 'brand', k: 'brand' }, { h: 'salesman', k: 'sales' }, { h: 'principal', k: 'principal' },
    { h: 'value', k: 'value' }, { h: 'date', k: 'date' }, { h: 'status', k: 'status' },
    { h: 'created_by', k: 'creator' }, { h: 'created_at', k: 'created_at' },
  ], rows);
}));

module.exports = router;
