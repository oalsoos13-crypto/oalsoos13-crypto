'use strict';
// Project methodology (PMI PMBOK 6th Ed., 2017) reference — persisted so the
// admin can edit each phase's status and start/end dates from the UI. Every save
// stamps updatedAt + updatedBy, so the screen shows the real last-edit date.
const express = require('express');
const db = require('../db');
const audit = require('../audit');
const { requireAuth, requireRole } = require('../auth');
const { asyncH, nowIso, badRequest } = require('../util');

const router = express.Router();
router.use(requireAuth);

const META_KEY = 'methodology';
const STATUSES = ['done', 'ongoing', 'partial', 'notstarted', 'na'];
const isDate = (s) => s === '' || s == null || /^\d{4}-\d{2}-\d{2}$/.test(String(s));

// Default content (seeded on first read). Dates are best-effort estimates —
// the admin edits them from the screen; each edit updates the timestamp.
function defaults() {
  return {
    version: '1.0',
    updatedAt: null,
    updatedBy: null,
    refs: [
      { n: 'PMBOK® Guide — 6th Edition (المرجع الأساسي)', by: 'PMI', yr: '2017' },
      { n: 'ISO 21502 — إرشادات إدارة المشاريع', by: 'ISO', yr: '2020' },
      { n: 'PRINCE2 (الحوكمة)', by: 'AXELOS', yr: '2017' },
      { n: 'Scrum Guide (أجايل)', by: 'Scrum.org', yr: '2020' },
    ],
    phases: [
      { id: 1, ar: 'البدء والدخول والأدوار والنطاق', pmi: 'البدء Initiating', st: 'done', start: '2026-05-01', end: '2026-05-07', note: 'الدخول، الصلاحيات، الأدوار الستة، النطاق.' },
      { id: 2, ar: 'المتطلبات والتحليل', pmi: 'التخطيط Planning', st: 'done', start: '2026-05-08', end: '2026-05-20', note: 'المتطلبات الوظيفية وغير الوظيفية، تحليل البيانات.' },
      { id: 3, ar: 'التصميم والتخطيط', pmi: 'التخطيط Planning', st: 'done', start: '2026-05-21', end: '2026-06-10', note: 'سير العمل، نموذج البيانات، الشاشات، الأدوار.' },
      { id: 4, ar: 'إعداد وتوزيع البتجيت', pmi: 'التخطيط Planning', st: 'done', start: '2026-06-11', end: '2026-06-30', note: 'سقوف ← مدير مبيعات ← مشرف ← مندوب/جمعية/أوتليت.' },
      { id: 5, ar: 'البناء والتنفيذ', pmi: 'التنفيذ Executing', st: 'done', start: '2026-06-15', end: '2026-08-15', note: 'قاعدة البيانات، منطق الخادم، الواجهة، التكامل.' },
      { id: 6, ar: 'الاختبار والجودة', pmi: 'المراقبة M&C', st: 'partial', start: '2026-07-01', end: '', note: 'اختبار E2E ويدوي منجز؛ لا يوجد إطار وحدات رسمي.' },
      { id: 7, ar: 'العرض والاعتماد', pmi: 'التنفيذ Executing', st: 'ongoing', start: '2026-06-01', end: '', note: 'عرض واعتماد المالك مع كل ميزة.' },
      { id: 8, ar: 'النشر والتشغيل', pmi: 'التنفيذ Executing', st: 'done', start: '2026-07-01', end: '2026-08-20', note: 'نشر تلقائي على Render، قرص دائم، فحص بعد النشر.' },
      { id: 9, ar: 'التدريب وإدارة التغيير', pmi: 'التنفيذ Executing', st: 'notstarted', start: '', end: '', note: 'لا يوجد دليل مستخدم/تدريب رسمي بعد.' },
      { id: 10, ar: 'التغذية الراجعة والتقييم', pmi: 'المراقبة M&C', st: 'ongoing', start: '2026-06-01', end: '', note: 'ملاحظات المالك مستمرة، سجل تدقيق للاستخدام.' },
      { id: 11, ar: 'الدعم والصيانة والتكرار', pmi: 'مستمر Ongoing', st: 'ongoing', start: '2026-08-20', end: '', note: 'معالجة الأعطال، تحسينات، متطلبات جديدة.' },
      { id: 12, ar: 'الإغلاق', pmi: 'الإغلاق Closing', st: 'na', start: '', end: '', note: 'غير منطبق — المشروع في تطوير نشط.' },
    ],
    gaps: [
      'دليل مستخدم رسمي + مواد تدريب (المرحلة 8) — موجود بالمعيار، ناقص عندك.',
      'سجل مخاطر رسمي (Risk Register) وخطة استجابة — PMBOK مجال المخاطر.',
      'إطار اختبار وحدات آلي (Unit tests) — المرحلة 6 (الجودة).',
      'توثيق فني رسمي (Design/Requirements docs) — حالياً تعليقات كود فقط.',
      'معايير قبول موثّقة (Acceptance criteria) وخطة جودة رسمية.',
      'ميثاق مشروع + جدول زمني/WBS رسمي — اختياري لأن المنهجية رشيقة (Agile).',
    ],
  };
}

function load() {
  const row = db.prepare('SELECT value FROM meta WHERE key=?').get(META_KEY);
  if (!row || !row.value) return defaults();
  try {
    const saved = JSON.parse(row.value);
    const base = defaults();
    // Merge saved edits over the current defaults so newly added phases/refs
    // still appear, while the admin's status/dates/notes win.
    const byId = new Map((saved.phases || []).map((p) => [p.id, p]));
    base.phases = base.phases.map((p) => {
      const s = byId.get(p.id);
      return s ? { ...p, st: s.st ?? p.st, start: s.start ?? p.start, end: s.end ?? p.end, note: s.note ?? p.note } : p;
    });
    base.updatedAt = saved.updatedAt || null;
    base.updatedBy = saved.updatedBy || null;
    return base;
  } catch (e) { return defaults(); }
}

// GET /api/methodology — the current methodology (any authenticated user).
router.get('/methodology', asyncH((req, res) => {
  res.json(load());
}));

// POST /api/methodology — admin edits phase status/dates/notes; stamps the edit.
router.post('/methodology', requireRole(), asyncH((req, res) => {
  const cur = load();
  const incoming = Array.isArray(req.body.phases) ? req.body.phases : [];
  const byId = new Map(incoming.map((p) => [Number(p.id), p]));
  for (const p of cur.phases) {
    const s = byId.get(p.id);
    if (!s) continue;
    if (s.st != null) {
      if (!STATUSES.includes(String(s.st))) throw badRequest('حالة غير صحيحة', 'BAD_STATUS');
      p.st = String(s.st);
    }
    if (s.start != null) { if (!isDate(s.start)) throw badRequest('تاريخ بداية غير صحيح', 'BAD_DATE'); p.start = String(s.start || ''); }
    if (s.end != null) { if (!isDate(s.end)) throw badRequest('تاريخ نهاية غير صحيح', 'BAD_DATE'); p.end = String(s.end || ''); }
    if (s.note != null) p.note = String(s.note).slice(0, 400);
  }
  cur.updatedAt = nowIso();
  cur.updatedBy = req.user.name;
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(META_KEY, JSON.stringify({ phases: cur.phases, updatedAt: cur.updatedAt, updatedBy: cur.updatedBy }));
  audit.fromReq(req, 'methodology.update', { entityType: 'methodology', summary: `Updated methodology (${cur.updatedBy})` });
  res.json(cur);
}));

module.exports = router;
