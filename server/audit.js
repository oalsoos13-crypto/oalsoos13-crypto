'use strict';
const db = require('./db');
const { nowIso, toJson } = require('./util');

const insertStmt = db.prepare(`
  INSERT INTO audit_log (ts, user_id, username, name, role, action, entity_type, entity_id, summary, details, ip)
  VALUES (@ts, @user_id, @username, @name, @role, @action, @entity_type, @entity_id, @summary, @details, @ip)
`);

/**
 * Append an immutable audit record.
 * @param {object} actor  - { id, username, name, role } (or null for anonymous/system).
 * @param {string} action - machine action key, e.g. 'note.approve.sup'.
 * @param {object} opts   - { entityType, entityId, summary, details, ip }.
 */
function record(actor, action, opts = {}) {
  insertStmt.run({
    ts: nowIso(),
    user_id: actor ? actor.id : null,
    username: actor ? actor.username : null,
    name: actor ? actor.name : null,
    role: actor ? actor.role : null,
    action,
    entity_type: opts.entityType || null,
    entity_id: opts.entityId != null ? String(opts.entityId) : null,
    summary: opts.summary || null,
    details: opts.details != null ? toJson(opts.details) : null,
    ip: opts.ip || null,
  });
}

// Convenience helper bound to an Express request (pulls actor + ip automatically).
function fromReq(req, action, opts = {}) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
    .toString().split(',')[0].trim();
  record(req.user || null, action, { ...opts, ip });
}

module.exports = { record, fromReq };
