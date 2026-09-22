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
    version: '2.0',
    updatedAt: null,
    updatedBy: null,
    vision: 'أتمتة كاملة لدورة حياة إشعارات الخصم وفق المعايير العالمية (PMI)، بحيث يصبح كل إشعار موثّقاً ومعتمَداً ومؤرشفاً إلكترونياً، مع شفافية وحوكمة تامّة على البتجيت والصرف.',
    goals: [
      'تقليل الأخطاء اليدوية في إصدار الإشعارات إلى الحد الأدنى.',
      'ضبط البتجيت لكل جمعية/مندوب ومقارنة المصروف بالموزّع لحظياً.',
      'سلسلة اعتماد واضحة (٤ مراحل) قبل الطباعة لضمان الرقابة.',
      'أرشفة شهرية منظّمة قابلة للتدقيق (PDF لكل إشعار).',
      'شفافية كاملة عبر سجل تدقيق (Audit) لكل عملية.',
      'صلاحيات دقيقة حسب الدور تحمي البيانات والعمليات.',
    ],
    refs: [
      { n: 'PMBOK® Guide — 6th Edition (المرجع الأساسي)', by: 'PMI', yr: '2017' },
      { n: 'ISO 21502 — إرشادات إدارة المشاريع', by: 'ISO', yr: '2020' },
      { n: 'PRINCE2 (الحوكمة)', by: 'AXELOS', yr: '2017' },
      { n: 'Scrum Guide (أجايل)', by: 'Scrum.org', yr: '2020' },
    ],
    // Each phase carries sub-steps (L2/L3) — the deeper breakdown per PMI level.
    phases: [
      { id: 1, ar: 'البدء والدخول والأدوار والنطاق', pmi: 'البدء Initiating', st: 'done', start: '2026-05-01', end: '2026-05-07', note: 'الدخول، الصلاحيات، الأدوار الستة، النطاق.',
        subs: ['تعريف المشكلة والهدف ودراسة الجدوى', 'تحديد أصحاب العلاقة (المناديب/المشرفين/المدراء/الأدمن)', 'تحديد النطاق (داخل/خارج)', 'إعداد الدخول والمصادقة JWT'] },
      { id: 2, ar: 'المتطلبات والتحليل', pmi: 'التخطيط Planning', st: 'done', start: '2026-05-08', end: '2026-05-20', note: 'المتطلبات الوظيفية وغير الوظيفية، تحليل البيانات.',
        subs: ['المتطلبات الوظيفية (مدخلات/قواعد/تقارير)', 'المتطلبات غير الوظيفية (أداء/أمن/لغة)', 'تحليل العملية الحالية مقابل المستهدفة', 'تحليل مصادر البيانات (أوتليت/جمعيات/عقود)'] },
      { id: 3, ar: 'التصميم والتخطيط', pmi: 'التخطيط Planning', st: 'done', start: '2026-05-21', end: '2026-06-10', note: 'سير العمل، نموذج البيانات، الشاشات، الأدوار.',
        subs: ['تصميم سير العمل وانتقالات الحالة', 'نموذج البيانات (الجداول والعلاقات)', 'تصميم الشاشات والتقارير', 'مصفوفة الأدوار والصلاحيات'] },
      { id: 4, ar: 'إعداد وتوزيع البتجيت', pmi: 'التخطيط Planning', st: 'done', start: '2026-06-11', end: '2026-06-30', note: 'سقوف ← مدير مبيعات ← مشرف ← مندوب/جمعية/أوتليت.',
        subs: ['سقوف الأدمن الشهرية', 'توزيع مدير المبيعات على المشرفين', 'توزيع المشرف على المندوب/الجمعية/الأوتليت', 'مقارنة المصروف بالموزّع'] },
      { id: 5, ar: 'البناء والتنفيذ', pmi: 'التنفيذ Executing', st: 'done', start: '2026-06-15', end: '2026-08-15', note: 'قاعدة البيانات، منطق الخادم، الواجهة، التكامل.',
        subs: ['بناء قاعدة البيانات والترحيلات', 'منطق الخادم (قواعد/حسابات/تحقق)', 'بناء الواجهة والشاشات', 'التكامل (استيراد/تصدير) وضبط الإصدارات'] },
      { id: 6, ar: 'الاختبار والجودة', pmi: 'المراقبة M&C', st: 'partial', start: '2026-07-01', end: '', note: 'اختبار E2E ويدوي منجز؛ لا يوجد إطار وحدات رسمي.',
        subs: ['اختبار تكامل End-to-End', 'اختبار دقة البيانات والأداء', 'اختبار الصلاحيات والأمن', 'قبول المستخدم UAT وإصلاح الأخطاء'] },
      { id: 7, ar: 'العرض والاعتماد', pmi: 'التنفيذ Executing', st: 'ongoing', start: '2026-06-01', end: '', note: 'عرض واعتماد المالك مع كل ميزة.',
        subs: ['تجهيز العرض والبيانات', 'عرض السير والشاشات للمالك', 'جمع الملاحظات وقرار المضي'] },
      { id: 8, ar: 'النشر والتشغيل', pmi: 'التنفيذ Executing', st: 'done', start: '2026-07-01', end: '2026-08-20', note: 'نشر تلقائي على Render، قرص دائم، فحص بعد النشر.',
        subs: ['فحص ما قبل النشر ونسخة احتياطية', 'ترحيل وتنظيف البيانات', 'النشر للإنتاج', 'فحص المسار الحرج بعد النشر'] },
      { id: 9, ar: 'التدريب وإدارة التغيير', pmi: 'التنفيذ Executing', st: 'notstarted', start: '', end: '', note: 'لا يوجد دليل مستخدم/تدريب رسمي بعد.',
        subs: ['إعداد دليل المستخدم والمواد', 'جلسات تدريب حسب الدور', 'إدارة التغيير والتبليغ'] },
      { id: 10, ar: 'التغذية الراجعة والتقييم', pmi: 'المراقبة M&C', st: 'ongoing', start: '2026-06-01', end: '', note: 'ملاحظات المالك مستمرة، سجل تدقيق للاستخدام.',
        subs: ['جمع التغذية الراجعة ومقاييس الاستخدام', 'التقييم مقابل الأهداف والمؤشرات', 'تخطيط التحسينات'] },
      { id: 11, ar: 'الدعم والصيانة والتكرار', pmi: 'مستمر Ongoing', st: 'ongoing', start: '2026-08-20', end: '', note: 'معالجة الأعطال، تحسينات، متطلبات جديدة.',
        subs: ['معالجة الأعطال (تشخيص وحل)', 'تحسينات وضبط الأداء', 'دورات تكرار لمتطلبات جديدة'] },
      { id: 12, ar: 'الإغلاق', pmi: 'الإغلاق Closing', st: 'na', start: '', end: '', note: 'غير منطبق — المشروع في تطوير نشط.',
        subs: ['الإغلاق الرسمي والتسليم', 'تحرير الموارد', 'مراجعة ما بعد المشروع والدروس المستفادة'] },
    ],
    gaps: [
      'دليل مستخدم رسمي + مواد تدريب (المرحلة 8) — موجود بالمعيار، ناقص عندك.',
      'سجل مخاطر رسمي (Risk Register) وخطة استجابة — PMBOK مجال المخاطر.',
      'إطار اختبار وحدات آلي (Unit tests) — المرحلة 6 (الجودة).',
      'توثيق فني رسمي (Design/Requirements docs) — حالياً تعليقات كود فقط.',
      'معايير قبول موثّقة (Acceptance criteria) وخطة جودة رسمية.',
      'ميثاق مشروع + جدول زمني/WBS رسمي — اختياري لأن المنهجية رشيقة (Agile).',
    ],
    // Standard Operating Procedures — the step-by-step operating procedures.
    sops: [
      { code: 'SOP-01', title: 'إنشاء كتاب إشعار خصم (المندوب)', role: 'المندوب', steps: [
        'ادخل بحساب المندوب واذهب لشاشة الكتب.', 'اضغط «كتاب جديد» واختر النوع (طبالي/استاند/فروق أسعار).',
        'اختر الجمعية من نطاقك، و(اختياري) الأوتليت.', 'أدخل القيمة والسبب.', 'احفظ — يدخل الكتاب دورة الاعتماد عند المشرف.'] },
      { code: 'SOP-02', title: 'توليد الكتب من توزيعة البتجيت (المندوب)', role: 'المندوب', steps: [
        'تأكد أن المشرف وزّع البتجيت لهذا الشهر.', 'من شاشة الكتب اضغط زر ⚡ «توليد الكتب من التوزيعة».',
        'راجع الكتب المتولّدة (كتاب لكل جمعية/أوتليت بقيمة التوزيعة).', 'الكتب تدخل الاعتماد تلقائياً؛ التكرار محمي.'] },
      { code: 'SOP-03', title: 'اعتماد الكتاب (كل مرحلة)', role: 'المشرف/المدراء', steps: [
        'افتح الكتاب المعروض للاعتماد وعاينه.', 'اعتمد مع التوقيع لينتقل للمرحلة التالية، أو ارفض بسبب.',
        'الترتيب: مشرف ← مدير مبيعات ← مدير تسويق ← مدير عمليات ← جاهز.'] },
      { code: 'SOP-04', title: 'الطباعة (الأدمن)', role: 'الأدمن', steps: [
        'افتح «طابور الطباعة».', 'تأكد أن الكتاب أكمل كل المراحل.', 'اطبع — يُسجَّل تاريخ الطباعة تلقائياً.'] },
      { code: 'SOP-05', title: 'إدخال إشعار الجمعية D.N (المندوب)', role: 'المندوب', steps: [
        'بعد طباعة الكتاب، افتحه لإدخال الإشعار.', 'أدخل رقم الإشعار بالجمعية (إلزامي).',
        'أرفق الصور/الإثباتات.', 'احفظ — ينتظر اعتماد الأدمن.'] },
      { code: 'SOP-06', title: 'توزيع البتجيت (المشرف)', role: 'المشرف', steps: [
        'افتح شاشة «توزيع البتجيت» واختر الشهر.', 'وزّع الحصة على كل مندوب.',
        'وزّع على الجمعيات، و(اختياري) على الأوتليت.', 'راجع عمود «المصروف» مقابل الموزّع.'] },
      { code: 'SOP-07', title: 'إقفال الشهر والأرشفة (الأدمن)', role: 'الأدمن', steps: [
        'سكّر الشهر (شرط إلزامي).', 'اضغط أرشفة لتوليد ZIP منظّم (المشرف ← D.N ← المندوب ← الجمعية).',
        'كل PDF = الكتاب + المرفقات + السمري.', 'بعد الأرشفة تختفي من الشاشات النشطة (نسخة محفوظة).'] },
      { code: 'SOP-08', title: 'إدارة المستخدمين والنسخ الاحتياطي (الأدمن)', role: 'الأدمن', steps: [
        'من الإعدادات أدر المستخدمين والأدوار وكلمات المرور.', 'نزّل نسخة احتياطية دورياً.',
        'راجع سجل التدقيق (Audit) للعمليات.'] },
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
    if (typeof saved.vision === 'string') base.vision = saved.vision;
    if (Array.isArray(saved.goals)) base.goals = saved.goals;
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
  if (typeof req.body.vision === 'string') cur.vision = req.body.vision.slice(0, 2000);
  if (Array.isArray(req.body.goals)) cur.goals = req.body.goals.map((g) => String(g).slice(0, 300)).filter(Boolean).slice(0, 30);
  cur.updatedAt = nowIso();
  cur.updatedBy = req.user.name;
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(META_KEY, JSON.stringify({ phases: cur.phases, vision: cur.vision, goals: cur.goals, updatedAt: cur.updatedAt, updatedBy: cur.updatedBy }));
  audit.fromReq(req, 'methodology.update', { entityType: 'methodology', summary: `Updated methodology (${cur.updatedBy})` });
  res.json(cur);
}));

module.exports = router;
