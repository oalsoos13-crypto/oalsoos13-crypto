'use strict';
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const config = require('./config');
const { unauthorized, forbidden } = require('./util');

function hashPassword(plain) {
  return bcrypt.hashSync(String(plain), config.bcryptRounds);
}
function verifyPassword(plain, hash) {
  try { return bcrypt.compareSync(String(plain), hash); } catch { return false; }
}

function signToken(user) {
  return jwt.sign(
    { sub: user.id, u: user.username, n: user.name, r: user.role },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );
}

const getUserById = db.prepare(
  'SELECT id, username, name, role, active, must_change_password FROM users WHERE id = ?'
);

// Resolve the bearer token (Authorization header or httpOnly cookie) to a fresh user row.
function authenticate(req) {
  let token = null;
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) token = h.slice(7).trim();
  if (!token && req.cookies && req.cookies.udc_token) token = req.cookies.udc_token;
  if (!token) return null;

  let payload;
  try { payload = jwt.verify(token, config.jwtSecret); }
  catch { return null; }

  const row = getUserById.get(payload.sub);
  if (!row || !row.active) return null;
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    role: row.role,
    mustChangePassword: !!row.must_change_password,
  };
}

// Express middleware: requires a valid session.
function requireAuth(req, res, next) {
  const user = authenticate(req);
  if (!user) return next(unauthorized('Authentication required', 'NO_AUTH'));
  req.user = user;
  next();
}

// Express middleware factory: requires one of the given roles (admin always allowed).
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(unauthorized());
    if (req.user.role === 'admin' || roles.includes(req.user.role)) return next();
    return next(forbidden('Insufficient role for this action', 'ROLE'));
  };
}

module.exports = {
  hashPassword, verifyPassword, signToken, authenticate, requireAuth, requireRole,
};
