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

// POST /api/notes  (salesman) — enter the debit note AFTER the letter is printed.
// A monetary letter (value > 0) "returns" as a debit note once the admin prints
// it: the salesman must supply the co-op DN number, its value, and at least one
// attachment (camera photo / image / PDF). It then awaits ADMIN approval.
// Body: { letterId, coopDN, value?, date?, attachments }
router.post('/notes', requireRole('salesman'), asyncH((req, res) => {
  const L = getLetter.get(req.body.letterId);
  if (!L) throw notFound('الكتاب غير موجود');
  if (req.user.role !== 'admin' && L.sales !== req.user.name) throw forbidden('كتاب مندوب آخر');
  // The debit note is only entered after the admin has printed the letter.
  if (!L.printed_at) throw badRequest('لا يمكن إدخال الإشعار قبل طباعة الكتاب', 'NOT_PRINTED');
  if (!(num(L.value) > 0)) throw badRequest('هذا الكتاب غير مالي — لا يحتاج إشعار خصم', 'NOT_MONETARY');
  // Block if an active (non-rejected) note already exists for this letter.
  const active = db.prepare("SELECT id FROM notes WHERE letter_id = ? AND status != 'rejected'").get(L.id);
  if (active) throw badRequest('يوجد إشعار خصم فعّال لهذا الكتاب', 'HAS_NOTE');

  const coopDN = String(req.body.coopDN || '').trim();
  if (!coopDN) throw badRequest('أدخل رقم الإشعار بالجمعية', 'NO_DN_NO');
  const atts = sanitizeAttachments(req.body.attachments);
  if (!atts.length) throw badRequest('أرفق صورة الإشعار أو ملف PDF', 'NO_ATTACHMENT');

  const id = genId('N');
  const now = nowIso();
  const value = req.body.value != null && req.body.value !== '' ? num(req.body.value) : L.value;

  db.prepare(`INSERT INTO notes
      (id, num, lysal, letter_id, coop_dn, type, coop, brand, sales, value, date, items, note, attachments, status, created_by, created_at)
      VALUES (@id,@num,@lysal,@letterId,@coopDN,@type,@coop,@brand,@sales,@value,@date,@items,@note,@att,'pending',@by,@now)`)
    .run({
      id, num: L.num, lysal: L.lysal, letterId: L.id, coopDN,
      type: L.type, coop: L.coop, brand: L.brand, sales: L.sales, value,
      date: req.body.date || L.date || now.slice(0, 10),
      items: L.items, note: L.note || '',
      att: toJson(atts),
      by: req.user.id, now,
    });
  db.prepare('UPDATE letters SET status = ?, updated_at = ? WHERE id = ?').run('noted', now, L.id);

  audit.fromReq(req, 'note.create', {
    entityType: 'note', entityId: id,
    summary: `Entered debit note ${L.lysal} (coopDN ${coopDN}, ${value})`,
    details: { lysal: L.lysal, letterId: L.id, coopDN, value, coop: L.coop },
  });
  res.json({ ok: true, id, lysal: L.lysal });
}));

// POST /api/notes/:id/approve  (ADMIN ONLY) — the debit note is not approved
// until the admin approves it.
router.post('/notes/:id/approve', requireRole(), asyncH((req, res) => {
  const n = getNote.get(req.params.id);
  if (!n) throw notFound('الإشعار غير موجود');
  if (n.status !== 'pending') throw badRequest('الإشعار ليس بانتظار الاعتماد', 'BAD_STATE');
  const now = nowIso();
  db.prepare(`UPDATE notes SET status='approved', mgr_approved_by=?, mgr_approved_at=?, updated_at=? WHERE id=?`)
    .run(req.user.id, now, now, n.id);
  audit.fromReq(req, 'note.approve', {
    entityType: 'note', entityId: n.id,
    summary: `Admin approved debit note ${n.lysal}`, details: { lysal: n.lysal, value: n.value, coop: n.coop },
  });
  res.json({ ok: true });
}));

// POST /api/notes/:id/reject  (ADMIN ONLY) — reject with a reason; the letter
// returns so the salesman can re-enter the debit note. Body: { reason }
router.post('/notes/:id/reject', requireRole(), asyncH((req, res) => {
  const n = getNote.get(req.params.id);
  if (!n) throw notFound('الإشعار غير موجود');
  if (n.status !== 'pending') throw badRequest('لا يمكن رفض إشعار في هذه الحالة', 'BAD_STATE');
  const reason = String(req.body.reason || '').trim();
  if (!reason) throw badRequest('أدخل سبب الرفض', 'NO_REASON');
  const now = nowIso();
  const tx = db.transaction(() => {
    db.prepare(`UPDATE notes SET status='rejected', rejected_by=?, rejected_at=?, rejected_stage='admin', reject_reason=?, updated_at=? WHERE id=?`)
      .run(req.user.id, now, reason, now, n.id);
    // Return the letter so the salesman can re-enter the debit note.
    db.prepare("UPDATE letters SET status='pending', updated_at=? WHERE id=?").run(now, n.letter_id);
  });
  tx();
  audit.fromReq(req, 'note.reject', {
    entityType: 'note', entityId: n.id,
    summary: `Admin rejected debit note ${n.lysal}: ${reason}`,
    details: { lysal: n.lysal, reason, value: n.value },
  });
  res.json({ ok: true });
}));

module.exports = router;
