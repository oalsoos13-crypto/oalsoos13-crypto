'use strict';
const express = require('express');
const db = require('../db');
const config = require('../config');
const audit = require('../audit');
const { requireAuth, requireRole, hashPassword } = require('../auth');
const { asyncH, nowIso, badRequest, notFound } = require('../util');

const router = express.Router();
// Admin-only, guarded per-route. Do NOT use a pass-through `router.use(requireRole())`
// here: this router shares the '/api' mount, so a blanket gate would also reject
// unmatched requests (turning 404s into 403s) and anything routed through it.
const guard = [requireAuth, requireRole()]; // requireRole() with no args => admin only

const ROLES = ['admin', 'marketing', 'division', 'doc', 'supervisor', 'salesman'];

// GET /api/admin/users
router.get('/admin/users', guard, asyncH((req, res) => {
  const rows = db.prepare(
    `SELECT id, username, name, role, active, must_change_password, last_login_at, created_at
     FROM users ORDER BY role, name`
  ).all();
  res.json({ users: rows });
}));

// POST /api/admin/users  { username, name, role, password? }
router.post('/admin/users', guard, asyncH((req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const name = String(req.body.name || '').trim();
  const role = String(req.body.role || '');
  if (!username || !name) throw badRequest('اسم المستخدم والاسم مطلوبان');
  if (!ROLES.includes(role)) throw badRequest('دور غير صحيح');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    throw badRequest('اسم المستخدم مستخدم مسبقًا', 'DUP');
  }
  const pw = req.body.password ? String(req.body.password) : config.defaultPassword;
  const now = nowIso();
  const info = db.prepare(
    `INSERT INTO users (username, password_hash, name, role, active, must_change_password, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 1, ?, ?)`
  ).run(username, hashPassword(pw), name, role, now, now);
  audit.fromReq(req, 'user.create', {
    entityType: 'user', entityId: username, summary: `Created user ${username} (${role})`,
    details: { username, name, role },
  });
  res.json({ ok: true, id: info.lastInsertRowid });
}));

// PATCH /api/admin/users/:id  { name?, role?, active? }
router.patch('/admin/users/:id', guard, asyncH((req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) throw notFound('المستخدم غير موجود');
  const name = req.body.name != null ? String(req.body.name).trim() : u.name;
  const role = req.body.role != null ? String(req.body.role) : u.role;
  if (!ROLES.includes(role)) throw badRequest('دور غير صحيح');
  let active = req.body.active != null ? (req.body.active ? 1 : 0) : u.active;
  // Never allow disabling / demoting the last active admin.
  if (u.role === 'admin' && (role !== 'admin' || !active)) {
    const admins = db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND active=1").get().n;
    if (admins <= 1) throw badRequest('لا يمكن تعطيل أو تنزيل آخر مدير نظام', 'LAST_ADMIN');
  }
  db.prepare('UPDATE users SET name=?, role=?, active=?, updated_at=? WHERE id=?')
    .run(name, role, active, nowIso(), u.id);
  audit.fromReq(req, 'user.update', {
    entityType: 'user', entityId: u.username,
    summary: `Updated user ${u.username}`, details: { name, role, active },
  });
  res.json({ ok: true });
}));

// POST /api/admin/users/:id/reset-password  { password? }
router.post('/admin/users/:id/reset-password', guard, asyncH((req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) throw notFound('المستخدم غير موجود');
  const pw = req.body.password ? String(req.body.password) : config.defaultPassword;
  db.prepare('UPDATE users SET password_hash=?, must_change_password=1, updated_at=? WHERE id=?')
    .run(hashPassword(pw), nowIso(), u.id);
  audit.fromReq(req, 'user.reset_password', {
    entityType: 'user', entityId: u.username, summary: `Reset password for ${u.username}`,
  });
  res.json({ ok: true });
}));

// GET /api/admin/export.json — full database backup (excluding password hashes).
const BACKUP_TABLES = ['budgets', 'channel_alloc', 'dist', 'letters', 'notes', 'counters', 'coops', 'audit_log'];
router.get('/admin/export.json', guard, asyncH((req, res) => {
  const dump = { meta: { exportedAt: nowIso(), schemaVersion: db.SCHEMA_VERSION, by: req.user.username } };
  for (const t of BACKUP_TABLES) dump[t] = db.prepare(`SELECT * FROM ${t}`).all();
  dump.users = db.prepare('SELECT id, username, name, role, active, must_change_password, created_at FROM users').all();
  audit.fromReq(req, 'data.export', { summary: 'Exported full backup (JSON)' });
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="udc-backup-${Date.now()}.json"`);
  res.send(JSON.stringify(dump, null, 2));
}));

// POST /api/admin/restore — restore business data from a backup (destructive).
// Does NOT touch users. Body: the JSON produced by export.json.
router.post('/admin/restore', guard, asyncH((req, res) => {
  const b = req.body || {};
  const restoreTables = ['budgets', 'channel_alloc', 'dist', 'letters', 'notes', 'coops'];
  const tx = db.transaction(() => {
    for (const t of restoreTables) {
      if (!Array.isArray(b[t])) continue;
      db.prepare(`DELETE FROM ${t}`).run();
      const rows = b[t];
      if (!rows.length) continue;
      const cols = Object.keys(rows[0]);
      const stmt = db.prepare(
        `INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`
      );
      for (const r of rows) stmt.run(r);
    }
    if (Array.isArray(b.counters)) {
      for (const c of b.counters) {
        db.prepare('INSERT INTO counters(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value')
          .run(c.name, c.value);
      }
    }
  });
  tx();
  audit.fromReq(req, 'data.restore', { summary: 'Restored business data from backup' });
  res.json({ ok: true });
}));

module.exports = router;
