'use strict';
const express = require('express');
const db = require('../db');
const config = require('../config');
const audit = require('../audit');
const { hashPassword, verifyPassword, signToken, requireAuth } = require('../auth');
const { asyncH, nowIso, badRequest, unauthorized } = require('../util');

const router = express.Router();

const findUser = db.prepare('SELECT * FROM users WHERE username = ?');

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
    .toString().split(',')[0].trim();
}

// POST /api/login  { username, password }
router.post('/login', asyncH((req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const ip = clientIp(req);
  const row = findUser.get(username);

  if (!row || !row.active || !verifyPassword(password, row.password_hash)) {
    audit.record(null, 'auth.login.fail', {
      entityType: 'user', entityId: username, summary: 'Failed login for ' + username, ip,
    });
    throw unauthorized('اسم المستخدم أو كلمة المرور غير صحيحة', 'BAD_CREDS');
  }

  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), row.id);
  const user = { id: row.id, username: row.username, name: row.name, role: row.role };
  const token = signToken(user);

  res.cookie('udc_token', token, {
    httpOnly: true, sameSite: 'lax', secure: config.isProd,
    maxAge: 12 * 60 * 60 * 1000,
  });

  audit.record(user, 'auth.login', { entityType: 'user', entityId: user.username, summary: 'Login', ip });

  res.json({
    token,
    user: { ...user, mustChangePassword: !!row.must_change_password },
  });
}));

// POST /api/logout
router.post('/logout', requireAuth, asyncH((req, res) => {
  audit.fromReq(req, 'auth.logout', { entityType: 'user', entityId: req.user.username, summary: 'Logout' });
  res.clearCookie('udc_token');
  res.json({ ok: true });
}));

// GET /api/me
router.get('/me', requireAuth, asyncH((req, res) => {
  res.json({ user: req.user });
}));

// POST /api/change-password  { currentPassword, newPassword }
router.post('/change-password', requireAuth, asyncH((req, res) => {
  const cur = String(req.body.currentPassword || '');
  const next = String(req.body.newPassword || '');
  if (next.length < 8) throw badRequest('كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل', 'WEAK');
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!row || !verifyPassword(cur, row.password_hash)) {
    throw badRequest('كلمة المرور الحالية غير صحيحة', 'BAD_CURRENT');
  }
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?')
    .run(hashPassword(next), nowIso(), req.user.id);
  audit.fromReq(req, 'auth.change_password', { entityType: 'user', entityId: req.user.username, summary: 'Changed own password' });
  res.json({ ok: true });
}));

module.exports = router;
