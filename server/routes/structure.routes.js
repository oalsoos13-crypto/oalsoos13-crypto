'use strict';
// Admin "structure builder": supervisors -> salesmen -> co-ops -> outlets.
// The ONLY source of truth for the structure is the outlets master (plus the
// coops and users tables); every screen (scope, budget tree, letter
// generation, monitoring, register) derives from it, so edits here are
// reflected everywhere without exception. team_map remembers which
// supervisor a salesman belongs to even before they have outlets.
const express = require('express');
const db = require('../db');
const audit = require('../audit');
const { requireAuth, requireRole } = require('../auth');
const { asyncH, nowIso, badRequest, notFound } = require('../util');

const router = express.Router();
router.use(requireAuth);
db.exec('CREATE TABLE IF NOT EXISTS team_map (salesman_pf TEXT PRIMARY KEY, fsm_pf TEXT NOT NULL, updated_at TEXT)');

const codeOf = (p) => { const m = String(p || '').match(/^(P\d+)/i); return m ? m[1].toUpperCase() : null; };
const usersByPf = () => new Map(db.prepare('SELECT username, name, role, active FROM users').all().map((u) => [String(u.username), u]));
function mustUser(map, pf, role) {
  const u = map.get(String(pf));
  if (!u || u.role !== role || !u.active) throw badRequest(`المستخدم ${pf} ليس ${role === 'supervisor' ? 'مشرفًا' : 'مندوبًا'} نشطًا | ${pf} is not an active ${role}`, 'BAD_USER');
  return u;
}
// The supervisor a salesman belongs to: team_map, else the one on most of their outlets.
function fsmOfSalesman(pf) {
  const t = db.prepare('SELECT fsm_pf FROM team_map WHERE salesman_pf=?').get(String(pf));
  if (t) return String(t.fsm_pf);
  const r = db.prepare("SELECT fsm_pf, COUNT(*) c FROM outlets WHERE salesman_pf=? AND fsm_pf IS NOT NULL AND fsm_pf<>'' GROUP BY fsm_pf ORDER BY c DESC LIMIT 1").get(String(pf));
  return r ? String(r.fsm_pf) : '';
}
function parentFor(code, coopName) {
  const ex = db.prepare("SELECT parent FROM outlets WHERE UPPER(parent) LIKE ? LIMIT 1").get(code.toUpperCase() + '-%');
  if (ex) return ex.parent;
  const ex2 = db.prepare("SELECT parent FROM outlets WHERE UPPER(parent) LIKE ? LIMIT 1").get(code.toUpperCase() + ' -%');
  return ex2 ? ex2.parent : `${code.toUpperCase()}-${String(coopName || '').toUpperCase()}`;
}
function snapshot() {
  const users = db.prepare("SELECT username, name, role FROM users WHERE active=1 AND role IN ('supervisor','salesman') ORDER BY name").all();
  const supervisors = users.filter((u) => u.role === 'supervisor').map((u) => ({ pf: String(u.username), name: u.name }));
  const outlets = db.prepare('SELECT cust_id, name, parent, fsm, fsm_pf, salesman, salesman_pf FROM outlets ORDER BY parent, name').all()
    .map((o) => ({ custId: String(o.cust_id), name: o.name, parent: o.parent, coopCode: codeOf(o.parent), fsmPf: o.fsm_pf ? String(o.fsm_pf) : '', fsm: o.fsm || '', salesmanPf: o.salesman_pf ? String(o.salesman_pf) : '', salesman: o.salesman || '' }));
  const salesmen = users.filter((u) => u.role === 'salesman').map((u) => ({ pf: String(u.username), name: u.name, fsmPf: fsmOfSalesman(u.username) }));
  const coops = db.prepare('SELECT code, name, name_ar, mains, branches FROM coops ORDER BY name').all()
    .map((c) => ({ code: String(c.code).toUpperCase(), name: c.name, nameAr: c.name_ar || '', mains: c.mains, branches: c.branches }));
  return { supervisors, salesmen, coops, outlets };
}

// GET /api/structure — the whole structure (admin).
router.get('/structure', requireRole(), asyncH((req, res) => { res.json(Object.assign({ ok: true }, snapshot())); }));

// POST /api/structure/assign { salesmanPf, supervisorPf } — put a salesman under a supervisor.
router.post('/structure/assign', requireRole(), asyncH((req, res) => {
  const U = usersByPf();
  const sm = mustUser(U, req.body.salesmanPf, 'salesman');
  const sup = mustUser(U, req.body.supervisorPf, 'supervisor');
  const now = nowIso();
  db.prepare('INSERT INTO team_map (salesman_pf, fsm_pf, updated_at) VALUES (?,?,?) ON CONFLICT(salesman_pf) DO UPDATE SET fsm_pf=excluded.fsm_pf, updated_at=excluded.updated_at')
    .run(String(sm.username), String(sup.username), now);
  const r = db.prepare('UPDATE outlets SET fsm=?, fsm_pf=? WHERE salesman_pf=?').run(sup.name, String(sup.username), String(sm.username));
  audit.fromReq(req, 'structure.assign', { entityType: 'structure', summary: `Salesman ${sm.name} -> supervisor ${sup.name} (${r.changes} outlets)`, details: { salesmanPf: sm.username, supervisorPf: sup.username, outlets: r.changes } });
  res.json({ ok: true, outlets: r.changes });
}));

// POST /api/structure/coop { code, name, nameAr, mains, branches } — create/update a co-op.
router.post('/structure/coop', requireRole(), asyncH((req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  if (!/^P\d+$/.test(code)) throw badRequest('كود الجمعية يجب أن يكون بصيغة P123 | Co-op code must look like P123', 'BAD_CODE');
  const name = String(req.body.name || '').trim();
  if (!name) throw badRequest('أدخل اسم الجمعية | Co-op name is required', 'NO_NAME');
  const nameAr = String(req.body.nameAr || '').trim();
  const mains = Math.max(0, parseInt(req.body.mains, 10) || 0), branches = Math.max(0, parseInt(req.body.branches, 10) || 0);
  const ex = db.prepare('SELECT code FROM coops WHERE UPPER(code)=?').get(code);
  if (ex) db.prepare('UPDATE coops SET name=?, name_ar=?, mains=?, branches=? WHERE UPPER(code)=?').run(name, nameAr, mains, branches, code);
  else db.prepare('INSERT INTO coops (name, code, mains, branches, name_ar) VALUES (?,?,?,?,?)').run(name, code, mains, branches, nameAr);
  audit.fromReq(req, ex ? 'structure.coop.update' : 'structure.coop.create', { entityType: 'coop', entityId: code, summary: `${ex ? 'Updated' : 'Created'} co-op ${code} ${name}` });
  res.json({ ok: true, code });
}));

// POST /api/structure/outlet { custId, name, coopCode, salesmanPf } — create/update/move an outlet.
router.post('/structure/outlet', requireRole(), asyncH((req, res) => {
  const custId = String(req.body.custId || '').trim();
  if (!custId) throw badRequest('أدخل رقم العميل | Customer ID is required', 'NO_CUST');
  const code = String(req.body.coopCode || '').trim().toUpperCase();
  const coop = db.prepare('SELECT code, name FROM coops WHERE UPPER(code)=?').get(code);
  if (!coop) throw badRequest('الجمعية غير موجودة | Unknown co-op code', 'NO_COOP');
  const ex = db.prepare('SELECT * FROM outlets WHERE cust_id=?').get(custId);
  let name = String(req.body.name != null ? req.body.name : (ex ? ex.name : '')).trim();
  if (!name) throw badRequest('أدخل اسم الأوتلت | Outlet name is required', 'NO_NAME');
  if (!new RegExp('^' + custId + '\\s*-').test(name)) name = `${custId}-${name}`; // keep the "custId-NAME" convention
  const parent = parentFor(code, coop.name);
  const U = usersByPf();
  let salesman = '', salesmanPf = '', fsm = '', fsmPf = '';
  const spf = String(req.body.salesmanPf || '').trim();
  if (spf) {
    const sm = mustUser(U, spf, 'salesman'); salesman = sm.name; salesmanPf = String(sm.username);
    fsmPf = fsmOfSalesman(salesmanPf); const su = fsmPf ? U.get(fsmPf) : null; fsm = su ? su.name : (ex ? ex.fsm || '' : '');
  }
  if (ex) db.prepare('UPDATE outlets SET name=?, parent=?, salesman=?, salesman_pf=?, fsm=?, fsm_pf=? WHERE cust_id=?').run(name, parent, salesman || null, salesmanPf || null, fsm || null, fsmPf || null, custId);
  else db.prepare('INSERT INTO outlets (cust_id, name, parent, fsm, fsm_pf, salesman, salesman_pf) VALUES (?,?,?,?,?,?,?)').run(custId, name, parent, fsm || null, fsmPf || null, salesman || null, salesmanPf || null);
  audit.fromReq(req, ex ? 'structure.outlet.update' : 'structure.outlet.create', { entityType: 'outlet', entityId: custId, summary: `${ex ? 'Updated' : 'Created'} outlet ${name} @ ${parent} -> ${salesman || 'unassigned'}` });
  res.json({ ok: true, custId, parent });
}));

// POST /api/structure/coop-salesman { coopCode, salesmanPf } — move ALL of a co-op's outlets to a salesman.
router.post('/structure/coop-salesman', requireRole(), asyncH((req, res) => {
  const code = String(req.body.coopCode || '').trim().toUpperCase();
  if (!/^P\d+$/.test(code)) throw badRequest('كود جمعية غير صحيح | Bad co-op code', 'BAD_CODE');
  const U = usersByPf();
  const spf = String(req.body.salesmanPf || '').trim();
  let salesman = null, salesmanPf = null, fsm = null, fsmPf = null;
  if (spf) { const sm = mustUser(U, spf, 'salesman'); salesman = sm.name; salesmanPf = String(sm.username); fsmPf = fsmOfSalesman(salesmanPf) || null; const su = fsmPf ? U.get(fsmPf) : null; fsm = su ? su.name : null; }
  const r = db.prepare("UPDATE outlets SET salesman=?, salesman_pf=?, fsm=?, fsm_pf=? WHERE UPPER(parent) LIKE ? OR UPPER(parent) LIKE ?").run(salesman, salesmanPf, fsm, fsmPf, code + '-%', code + ' -%');
  audit.fromReq(req, 'structure.coop.move', { entityType: 'coop', entityId: code, summary: `Co-op ${code} -> ${salesman || 'unassigned'} (${r.changes} outlets)` });
  res.json({ ok: true, outlets: r.changes });
}));

// DELETE /api/structure/outlet/:custId — remove an outlet (refused when letters reference it).
router.delete('/structure/outlet/:custId', requireRole(), asyncH((req, res) => {
  const custId = String(req.params.custId);
  const ex = db.prepare('SELECT name FROM outlets WHERE cust_id=?').get(custId);
  if (!ex) throw notFound('الأوتلت غير موجود');
  const used = db.prepare('SELECT COUNT(*) c FROM letters WHERE cust_id=?').get(custId).c;
  if (used) throw badRequest(`لا يمكن حذف أوتلت عليه ${used} كتاب — انقله بدل الحذف | Outlet has ${used} letters — move it instead`, 'IN_USE');
  db.prepare('DELETE FROM outlets WHERE cust_id=?').run(custId);
  db.prepare('DELETE FROM budget_alloc_outlet WHERE cust_id=?').run(custId);
  audit.fromReq(req, 'structure.outlet.delete', { entityType: 'outlet', entityId: custId, summary: `Deleted outlet ${ex.name}` });
  res.json({ ok: true });
}));

module.exports = router;
