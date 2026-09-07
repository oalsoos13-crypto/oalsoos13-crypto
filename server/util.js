'use strict';
const crypto = require('crypto');

// ISO timestamp (UTC) used for all created_at / *_at columns and audit rows.
function nowIso() {
  return new Date().toISOString();
}

// Local date (YYYY-MM-DD).
function today() {
  return new Date().toISOString().slice(0, 10);
}

// Short unique id with a type prefix, e.g. "L" + timestamp/random => "Lk3f9a2b7c1".
function genId(prefix) {
  return (prefix || '') + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

// Safe number coercion.
function num(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

// JSON stringify/parse that never throws.
function toJson(v) {
  try { return JSON.stringify(v == null ? null : v); } catch { return 'null'; }
}
function fromJson(s, def = null) {
  if (s == null) return def;
  try { return JSON.parse(s); } catch { return def; }
}

// Small async wrapper so route handlers can throw / return promises.
function asyncH(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Typed HTTP error.
class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || undefined;
  }
}
const badRequest = (m, c) => new HttpError(400, m, c);
const unauthorized = (m, c) => new HttpError(401, m || 'Unauthorized', c);
const forbidden = (m, c) => new HttpError(403, m || 'Forbidden', c);
const notFound = (m, c) => new HttpError(404, m || 'Not found', c);
const conflict = (m, c) => new HttpError(409, m, c);

module.exports = {
  nowIso, today, genId, num, toJson, fromJson, asyncH,
  HttpError, badRequest, unauthorized, forbidden, notFound, conflict,
};
