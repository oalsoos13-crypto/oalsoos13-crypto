'use strict';
const express = require('express');
const db = require('../db');
const audit = require('../audit');
const { requireAuth, requireRole } = require('../auth');
const { asyncH, genId, nowIso, num, toJson, badRequest, notFound, forbidden } = require('../util');

const router = express.Router();
router.use(requireAuth);

const getLetter = db.prepare('SELECT * FROM letters WHERE id = ?');
const getNote = db.prepare('SELECT * FROM notes WHERE id = ?');

// Salesmen (by first name) supervised by a given supervisor full name.
function salesmenUnder(supName) {
  return new Set(
    db.prepare('SELECT DISTINCT sales FROM dist WHERE sup = ?').all(supName).map((r) => r.sales)
  );
}

function sanitizeAttachments(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 20).map((a) => ({
    name: String(a && a.name ? a.name : 'file').slice(0, 160),
    url: typeof a.url === 'string' && (a.url.startsWith('data:') || a.url.startsWith('http'))
      ? a.url : '',
  })).filter((a) => a.url);
}

// POST /api/notes  (salesman) — create a debit note from a letter.
// Body: { letterId, coopDN, value?, date?, attachments? }
router.post('/notes', requireRole('salesman'), asyncH((req, res) => {
  const L = getLetter.get(req.body.letterId);
  if (!L) throw notFound('الكتاب غير موجود');
  if (req.user.role !== 'admin' && L.sales !== req.user.name) throw forbidden('كتاب مندوب آخر');
  // Block if an active (non-rejected) note already exists for this letter.
  const active = db.prepare("SELECT id FROM notes WHERE letter_id = ? AND status != 'rejected'").get(L.id);
  if (active) throw badRequest('يوجد إشعار خصم فعّال لهذا الكتاب', 'HAS_NOTE');

  const id = genId('N');
  const now = nowIso();
  const value = req.body.value != null && req.body.value !== '' ? num(req.body.value) : L.value;

  db.prepare(`INSERT INTO notes
      (id, num, lysal, letter_id, coop_dn, type, coop, brand, sales, value, date, items, note, attachments, status, created_by, created_at)
      VALUES (@id,@num,@lysal,@letterId,@coopDN,@type,@coop,@brand,@sales,@value,@date,@items,@note,@att,'pending_sup',@by,@now)`)
    .run({
      id, num: L.num, lysal: L.lysal, letterId: L.id,
      coopDN: String(req.body.coopDN || '').trim(),
      type: L.type, coop: L.coop, brand: L.brand, sales: L.sales, value,
      date: req.body.date || L.date || now.slice(0, 10),
      items: L.items, note: L.note || '',
      att: toJson(sanitizeAttachments(req.body.attachments)),
      by: req.user.id, now,
    });
  db.prepare('UPDATE letters SET status = ?, updated_at = ? WHERE id = ?').run('noted', now, L.id);

  audit.fromReq(req, 'note.create', {
    entityType: 'note', entityId: id,
    summary: `Created debit note ${L.lysal} (coopDN ${req.body.coopDN || '-'}, ${value})`,
    details: { lysal: L.lysal, letterId: L.id, coopDN: req.body.coopDN || '', value, coop: L.coop },
  });
  res.json({ ok: true, id, lysal: L.lysal });
}));

// POST /api/notes/:id/approve-sup  (supervisor)
router.post('/notes/:id/approve-sup', requireRole('supervisor'), asyncH((req, res) => {
  const n = getNote.get(req.params.id);
  if (!n) throw notFound('الإشعار غير موجود');
  if (n.status !== 'pending_sup') throw badRequest('الإشعار ليس بانتظار اعتماد المشرف', 'BAD_STATE');
  if (req.user.role !== 'admin') {
    const mine = salesmenUnder(req.user.name);
    if (!mine.has(n.sales)) throw forbidden('هذا الإشعار خارج نطاق مناديبك');
  }
  const now = nowIso();
  db.prepare(`UPDATE notes SET status='pending_mgr', sup_approved_by=?, sup_approved_at=?, updated_at=? WHERE id=?`)
    .run(req.user.id, now, now, n.id);
  audit.fromReq(req, 'note.approve.sup', {
    entityType: 'note', entityId: n.id,
    summary: `Supervisor approved ${n.lysal}`, details: { lysal: n.lysal, value: n.value, sales: n.sales },
  });
  res.json({ ok: true });
}));

// POST /api/notes/:id/approve-mgr  (division)
router.post('/notes/:id/approve-mgr', requireRole('division'), asyncH((req, res) => {
  const n = getNote.get(req.params.id);
  if (!n) throw notFound('الإشعار غير موجود');
  if (n.status !== 'pending_mgr') throw badRequest('الإشعار ليس بانتظار اعتماد المدير', 'BAD_STATE');
  const now = nowIso();
  db.prepare(`UPDATE notes SET status='approved', mgr_approved_by=?, mgr_approved_at=?, updated_at=? WHERE id=?`)
    .run(req.user.id, now, now, n.id);
  audit.fromReq(req, 'note.approve.mgr', {
    entityType: 'note', entityId: n.id,
    summary: `Manager approved ${n.lysal}`, details: { lysal: n.lysal, value: n.value, coop: n.coop },
  });
  res.json({ ok: true });
}));

// POST /api/notes/:id/reject  (supervisor at sup stage, division at mgr stage, or admin)
// Body: { reason }
router.post('/notes/:id/reject', requireRole('supervisor', 'division'), asyncH((req, res) => {
  const n = getNote.get(req.params.id);
  if (!n) throw notFound('الإشعار غير موجود');
  if (n.status !== 'pending_sup' && n.status !== 'pending_mgr') {
    throw badRequest('لا يمكن رفض إشعار في هذه الحالة', 'BAD_STATE');
  }
  const stage = n.status === 'pending_sup' ? 'sup' : 'mgr';
  // Stage-appropriate authority (admin overrides).
  if (req.user.role !== 'admin') {
    if (stage === 'sup') {
      if (req.user.role !== 'supervisor') throw forbidden('اعتماد/رفض المشرف فقط');
      const mine = salesmenUnder(req.user.name);
      if (!mine.has(n.sales)) throw forbidden('خارج نطاق مناديبك');
    } else if (stage === 'mgr' && req.user.role !== 'division') {
      throw forbidden('اعتماد/رفض المدير فقط');
    }
  }
  const reason = String(req.body.reason || '').trim();
  if (!reason) throw badRequest('أدخل سبب الرفض', 'NO_REASON');
  const now = nowIso();
  const tx = db.transaction(() => {
    db.prepare(`UPDATE notes SET status='rejected', rejected_by=?, rejected_at=?, rejected_stage=?, reject_reason=?, updated_at=? WHERE id=?`)
      .run(req.user.id, now, stage, reason, now, n.id);
    // Return the letter to 'pending' so the salesman can re-issue a note.
    db.prepare("UPDATE letters SET status='pending', updated_at=? WHERE id=?").run(now, n.letter_id);
  });
  tx();
  audit.fromReq(req, 'note.reject', {
    entityType: 'note', entityId: n.id,
    summary: `Rejected ${n.lysal} at ${stage}: ${reason}`,
    details: { lysal: n.lysal, stage, reason, value: n.value },
  });
  res.json({ ok: true });
}));

module.exports = router;
