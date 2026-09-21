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

// GET /api/archive/pending?month=YYYY-MM — eligible D.N (metadata only).
router.get('/archive/pending', requireRole(), asyncH((req, res) => {
  const month = String(req.query.month || '').trim() || null;
  const list = eligibleNotes(month);
  // Distinct months present (so the UI can offer a month picker).
  const months = [...new Set(eligibleNotes(null).map((x) => x.month))].sort().reverse();
  res.json({ ok: true, month, months, count: list.length, notes: list });
}));

// POST /api/archive/commit — mark the given notes (and their letters) archived.
// Body: { ids: [...], month: 'YYYY-MM' }. Call this AFTER the browser has built
// and saved the ZIP, so nothing is hidden until the archive is in hand.
router.post('/archive/commit', requireRole(), asyncH((req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.filter((x) => typeof x === 'string') : [];
  if (!ids.length) throw badRequest('لا توجد إشعارات للأرشفة', 'NO_IDS');
  const month = String(req.body.month || '').trim() || nowIso().slice(0, 7);
  const now = nowIso();
  const getN = db.prepare('SELECT id, letter_id FROM notes WHERE id = ? AND archived_at IS NULL');
  const markN = db.prepare('UPDATE notes SET archived_at=?, archived_month=?, updated_at=? WHERE id=?');
  const markL = db.prepare('UPDATE letters SET archived_at=?, archived_month=?, updated_at=? WHERE id=?');
  let done = 0;
  const tx = db.transaction(() => {
    for (const id of ids) {
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

module.exports = router;
