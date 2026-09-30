'use strict';
// Month-end archiving of debit notes (D.N). The admin closes the month and
// archives every completed debit note (one that carries a co-op DN number AND
// at least one attachment) to the device as a ZIP of PDFs, organised as
//   <supervisor>/D.N/<salesman>/<coop>/<coop> - <letterNo> - <entryDate>.pdf
// The ZIP/PDF is built in the browser (Arabic renders correctly there); this
// module supplies the eligible list, the per-note payload, and commits the
// archive (marking notes+letters archived so they leave the active screens).
const express = require('express');
const db = require('../db');
const audit = require('../audit');
const { requireAuth, requireRole } = require('../auth');
const { asyncH, nowIso, fromJson, badRequest, notFound } = require('../util');

const router = express.Router();
router.use(requireAuth);

// Real salesman -> supervisor name, from the outlets master (same as state).
function salesSupMap() {
  const out = {};
  try {
    const userByPf = new Map(db.prepare('SELECT username, name FROM users').all().map((u) => [String(u.username), u.name]));
    db.prepare('SELECT DISTINCT salesman, fsm, fsm_pf FROM outlets').all().forEach((r) => {
      if (!r.salesman) return;
      out[r.salesman] = userByPf.get(String(r.fsm_pf)) || String(r.fsm || '').replace(/\s+/g, ' ').trim();
    });
  } catch (e) { /* outlets optional */ }
  return out;
}

// A note is archivable when it has a co-op DN number, at least one attachment,
// is not rejected, and has not already been archived.
function eligibleNotes(month) {
  const rows = db.prepare(
    "SELECT * FROM notes WHERE archived_at IS NULL AND status != 'rejected' AND coop_dn IS NOT NULL AND coop_dn != '' ORDER BY created_at ASC"
  ).all();
  const sup = salesSupMap();
  return rows
    .map((n) => {
      const atts = fromJson(n.attachments, []);
      if (!atts.length) return null;
      const entry = (n.created_at || n.date || '').slice(0, 10);
      const m = entry.slice(0, 7);
      if (month && m !== month) return null;
      return {
        id: n.id, letterId: n.letter_id, lysal: n.lysal, coopDN: n.coop_dn, coop: n.coop, sales: n.sales,
        supervisor: sup[n.sales] || 'بدون مشرف', value: n.value, date: n.date,
        entryDate: entry, month: m, attachments: atts.length,
      };
    })
    .filter(Boolean);
}

// Is a given month closed (تسكيرة)? Archiving is allowed only after close.
function monthClosed(month) {
  try {
    const r = db.prepare('SELECT closed FROM budget_months WHERE month=?').get(month);
    return !!(r && r.closed);
  } catch (e) { return false; }
}

// GET /api/archive/pending?month=YYYY-MM — eligible D.N (metadata only).
router.get('/archive/pending', requireRole(), asyncH((req, res) => {
  const month = String(req.query.month || '').trim() || null;
  const list = eligibleNotes(month);
  // Distinct months present (so the UI can offer a month picker).
  const months = [...new Set(eligibleNotes(null).map((x) => x.month))].sort().reverse();
  // Which of those months are already closed (archiving requires a closed month).
  const closedMap = {};
  months.forEach((m) => { closedMap[m] = monthClosed(m); });
  res.json({ ok: true, month, closed: month ? monthClosed(month) : false, months, closedMap, count: list.length, notes: list });
}));

// POST /api/archive/commit — mark the given notes (and their letters) archived.
// Body: { ids: [...], month: 'YYYY-MM' }. Call this AFTER the browser has built
// and saved the ZIP, so nothing is hidden until the archive is in hand.
router.post('/archive/commit', requireRole(), asyncH((req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.filter((x) => typeof x === 'string') : [];
  if (!ids.length) throw badRequest('لا توجد إشعارات للأرشفة', 'NO_IDS');
  const month = String(req.body.month || '').trim();
  if (!/^\d{4}-\d{2}$/.test(month)) throw badRequest('اختر شهرًا محددًا للأرشفة', 'NO_MONTH');
  // Archiving is only allowed after the month has been closed (تسكيرة الشهر).
  if (!monthClosed(month)) throw badRequest('لا يمكن الأرشفة قبل تسكيرة الشهر', 'MONTH_NOT_CLOSED');
  // Only archive notes whose entry month matches the (closed) month being archived.
  const eligibleIds = new Set(eligibleNotes(month).map((n) => n.id));
  const now = nowIso();
  const getN = db.prepare('SELECT id, letter_id FROM notes WHERE id = ? AND archived_at IS NULL');
  const markN = db.prepare('UPDATE notes SET archived_at=?, archived_month=?, updated_at=? WHERE id=?');
  const markL = db.prepare('UPDATE letters SET archived_at=?, archived_month=?, updated_at=? WHERE id=?');
  let done = 0;
  const tx = db.transaction(() => {
    for (const id of ids) {
      if (!eligibleIds.has(id)) continue; // only this closed month's eligible notes
      const n = getN.get(id);
      if (!n) continue;
      markN.run(now, month, now, id);
      if (n.letter_id) markL.run(now, month, now, n.letter_id);
      done++;
    }
  });
  tx();
  audit.fromReq(req, 'archive.commit', {
    entityType: 'note', summary: `Archived ${done} debit note(s) for ${month}`, details: { month, count: done },
  });
  res.json({ ok: true, archived: done, month });
}));

// GET /api/archive/list?month= — previously archived notes (read-only history).
router.get('/archive/list', requireRole(), asyncH((req, res) => {
  const month = String(req.query.month || '').trim() || null;
  const rows = month
    ? db.prepare('SELECT * FROM notes WHERE archived_at IS NOT NULL AND archived_month=? ORDER BY archived_at DESC').all(month)
    : db.prepare('SELECT * FROM notes WHERE archived_at IS NOT NULL ORDER BY archived_at DESC').all();
  const months = [...new Set(db.prepare('SELECT archived_month FROM notes WHERE archived_at IS NOT NULL').all().map((r) => r.archived_month).filter(Boolean))].sort().reverse();
  res.json({
    ok: true, months,
    notes: rows.map((n) => ({
      id: n.id, lysal: n.lysal, coopDN: n.coop_dn, coop: n.coop, sales: n.sales,
      value: n.value, date: n.date, archivedAt: n.archived_at, archivedMonth: n.archived_month,
    })),
  });
}));


// ---- Monthly D.N register: the management sheet, generated from the system ----
// One row per ADMIN-APPROVED debit note of the month (entry month, same rule as
// archiving), in the columns of the existing manual sheet plus the letter ref.
const XLSX = require('xlsx');
const REG_REASON = {
  palletdn: 'pallets', pallet: 'pallets', standdn: 'stands', stand: 'stands', rentstand: 'stand rent',
  pricediff: 'price diff', priceoff: 'price diff', listing_dn: 'listing', listing: 'listing', listing_supp: 'listing',
  linkitems: 'listing', rentdebit: 'rent', dataupd_dn: 'data update', priceupd: 'price update', changeprice: 'price update',
  pctrebate: 'rebate', promotion: 'promotion', cda: 'CDA',
};
function fmtDMY(d) { const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : String(d || ''); }
function registerRows(month, ids) {
  const userByPf = new Map(db.prepare('SELECT username, name FROM users').all().map((u) => [String(u.username), u.name]));
  const outlets = db.prepare('SELECT cust_id, name, parent, fsm, fsm_pf, salesman, salesman_pf FROM outlets').all();
  const byCust = new Map(outlets.map((o) => [String(o.cust_id), o]));
  const cleanCoop = (p) => String(p || '').replace(/^P\d+\s*-\s*/i, '').trim().toUpperCase();
  const idSet = ids && ids.length ? new Set(ids) : null;
  const notes = db.prepare("SELECT * FROM notes WHERE status = 'approved' ORDER BY date ASC, created_at ASC").all()
    .filter((n) => { const m = (n.created_at || n.date || '').slice(0, 7); return (!month || m === month) && (!idSet || idSet.has(n.id)); });
  const getLetter = db.prepare('SELECT lysal, cust_id, brand, type, meta, note, coop, sales FROM letters WHERE id = ?');
  return notes.map((n) => {
    const L = getLetter.get(n.letter_id) || {};
    // The addressed outlet; otherwise the co-op's main outlet served by this salesman.
    let o = L.cust_id ? byCust.get(String(L.cust_id)) : null;
    if (!o) {
      const coopKey = cleanCoop(n.coop || L.coop);
      const cands = outlets.filter((x) => cleanCoop(x.parent) === coopKey && (!n.sales || x.salesman === n.sales));
      o = cands.find((x) => /MAIN/i.test(x.name)) || cands[0] || outlets.find((x) => cleanCoop(x.parent) === coopKey) || null;
    }
    let meta = {}; try { meta = L.meta ? JSON.parse(L.meta) : {}; } catch (e) { meta = {}; }
    const reason = REG_REASON[L.type] || (meta.reason ? String(meta.reason) : String(L.type || n.type || ''));
    const fsmName = o ? (userByPf.get(String(o.fsm_pf)) || o.fsm || '') : '';
    return {
      coop: o ? o.parent : (n.coop || L.coop || ''),
      rep: o ? `${o.salesman_pf || ''}-${o.salesman || n.sales || ''}`.replace(/^-/, '') : (n.sales || ''),
      fsm: o ? `${o.fsm_pf || ''}-${fsmName}`.replace(/^-/, '') : '',
      customer: o ? o.name : '',
      classification: o ? (/MAIN/i.test(o.name) ? 'Main' : 'Branch') : '',
      dn: n.coop_dn || '', value: Number(n.value) || 0, brand: L.brand || n.brand || '',
      date: fmtDMY(n.date), reason, note: n.note || L.note || '', letterRef: L.lysal || n.lysal || '',
    };
  });
}
const REG_HEAD = ['Co-op', 'Supervisor Name', 'FSM Supervisor', 'Customer ID & Name', 'Classification', 'Serial Number D.N', 'Value', 'Brand', 'Date', 'Reason', 'Note', 'Letter Ref'];
function parseIds(q) { return String(q || '').split(',').map((x) => x.trim()).filter(Boolean); }
// GET /api/dn-register?month=YYYY-MM[&ids=a,b] — rows as JSON.
router.get('/dn-register', requireRole(), asyncH((req, res) => {
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? req.query.month : null;
  res.json({ ok: true, month, rows: registerRows(month, parseIds(req.query.ids)) });
}));
// GET /api/dn-register.xlsx?month=YYYY-MM[&ids=a,b] — the Excel sheet.
router.get('/dn-register.xlsx', requireRole(), asyncH((req, res) => {
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? req.query.month : null;
  const rows = registerRows(month, parseIds(req.query.ids));
  const aoa = [REG_HEAD].concat(rows.map((r) => [r.coop, r.rep, r.fsm, r.customer, r.classification, r.dn, r.value, r.brand, r.date, r.reason, r.note, r.letterRef]));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [34, 26, 24, 40, 14, 18, 12, 12, 12, 16, 30, 20].map((w) => ({ wch: w }));
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(rows.length, 1), c: REG_HEAD.length - 1 } }) };
  for (let i = 0; i < rows.length; i++) { const c = ws[XLSX.utils.encode_cell({ r: i + 1, c: 6 })]; if (c) { c.t = 'n'; c.z = '0.000'; } }
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'D.N Register');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  audit.fromReq(req, 'dn.register.export', { entityType: 'note', summary: `D.N register export ${month || 'all'} (${rows.length} rows)` });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="DN-Register-${month || 'all'}.xlsx"`);
  res.send(buf);
}));

module.exports = router;
