'use strict';
// Project methodology (PMI PMBOK 6th Ed., 2017) reference — persisted so the
// admin can edit each phase/SOP from the UI. All narrative content is bilingual
// ({ ar, en }) so the whole screen switches with the language toggle. Every save
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
const bi = (ar, en) => ({ ar, en });
// Normalise any value to a { ar, en } object (accepts plain strings from old data).
function nbi(v) {
  if (v && typeof v === 'object') return { ar: String(v.ar || '').slice(0, 500), en: String(v.en || '').slice(0, 500) };
  const s = String(v == null ? '' : v).slice(0, 500);
  return { ar: s, en: s };
}
function nbiList(a) { return Array.isArray(a) ? a.map(nbi).filter((x) => x.ar || x.en) : []; }

// Default content (seeded on first read). Dates are best-effort estimates.
function defaults() {
  return {
    version: '3.0',
    updatedAt: null,
    updatedBy: null,
    vision: bi(
      'أتمتة كاملة لدورة حياة إشعارات الخصم وفق المعايير العالمية (PMI)، بحيث يصبح كل إشعار موثّقاً ومعتمَداً ومؤرشفاً إلكترونياً، مع شفافية وحوكمة تامّة على البتجيت والصرف.',
      'Full automation of the debit-note lifecycle per the global PMI standard, so every note is documented, approved and archived electronically, with complete transparency and governance over budget and spend.'),
    goals: [
      bi('تقليل الأخطاء اليدوية في إصدار الإشعارات إلى الحد الأدنى.', 'Minimise manual errors in issuing debit notes.'),
      bi('ضبط البتجيت لكل جمعية/مندوب ومقارنة المصروف بالموزّع لحظياً.', 'Control the budget per co-op/salesman and compare spend vs. allocation in real time.'),
      bi('سلسلة اعتماد واضحة (٤ مراحل) قبل الطباعة لضمان الرقابة.', 'A clear 4-stage approval chain before printing for control.'),
      bi('أرشفة شهرية منظّمة قابلة للتدقيق (PDF لكل إشعار).', 'Organised, auditable monthly archiving (a PDF per note).'),
      bi('شفافية كاملة عبر سجل تدقيق (Audit) لكل عملية.', 'Full transparency via an audit log of every action.'),
      bi('صلاحيات دقيقة حسب الدور تحمي البيانات والعمليات.', 'Precise role-based permissions protecting data and operations.'),
    ],
    refs: [
      { n: bi('PMBOK® Guide — 6th Edition (المرجع الأساسي)', 'PMBOK® Guide — 6th Edition (primary reference)'), by: 'PMI', yr: '2017' },
      { n: bi('ISO 21502 — إرشادات إدارة المشاريع', 'ISO 21502 — project management guidance'), by: 'ISO', yr: '2020' },
      { n: bi('PRINCE2 (الحوكمة)', 'PRINCE2 (governance)'), by: 'AXELOS', yr: '2017' },
      { n: bi('Scrum Guide (أجايل)', 'Scrum Guide (Agile)'), by: 'Scrum.org', yr: '2020' },
    ],
    phases: [
      { id: 1, name: bi('البدء والدخول والأدوار والنطاق', 'Initiation, login, roles & scope'), pmi: bi('البدء Initiating', 'Initiating'), st: 'done', start: '2026-05-01', end: '2026-05-07', note: bi('الدخول، الصلاحيات، الأدوار الستة، النطاق.', 'Login, permissions, six roles, scope.'),
        subs: [bi('تعريف المشكلة والهدف ودراسة الجدوى', 'Define the problem, goal & feasibility'), bi('تحديد أصحاب العلاقة', 'Identify stakeholders'), bi('تحديد النطاق (داخل/خارج)', 'Define scope (in/out)'), bi('إعداد الدخول والمصادقة JWT', 'Set up login & JWT authentication')] },
      { id: 2, name: bi('المتطلبات والتحليل', 'Requirements & analysis'), pmi: bi('التخطيط Planning', 'Planning'), st: 'done', start: '2026-05-08', end: '2026-05-20', note: bi('المتطلبات الوظيفية وغير الوظيفية، تحليل البيانات.', 'Functional & non-functional requirements, data analysis.'),
        subs: [bi('المتطلبات الوظيفية (مدخلات/قواعد/تقارير)', 'Functional requirements (inputs/rules/reports)'), bi('المتطلبات غير الوظيفية (أداء/أمن/لغة)', 'Non-functional requirements (performance/security/language)'), bi('تحليل العملية الحالية مقابل المستهدفة', 'As-is vs. to-be process analysis'), bi('تحليل مصادر البيانات', 'Data-source analysis')] },
      { id: 3, name: bi('التصميم والتخطيط', 'Design & planning'), pmi: bi('التخطيط Planning', 'Planning'), st: 'done', start: '2026-05-21', end: '2026-06-10', note: bi('سير العمل، نموذج البيانات، الشاشات، الأدوار.', 'Workflow, data model, screens, roles.'),
        subs: [bi('تصميم سير العمل وانتقالات الحالة', 'Workflow & state-transition design'), bi('نموذج البيانات (الجداول والعلاقات)', 'Data model (tables & relations)'), bi('تصميم الشاشات والتقارير', 'Screens & reports design'), bi('مصفوفة الأدوار والصلاحيات', 'Roles & permissions matrix')] },
      { id: 4, name: bi('إعداد وتوزيع البتجيت', 'Budget setup & distribution'), pmi: bi('التخطيط Planning', 'Planning'), st: 'done', start: '2026-06-11', end: '2026-06-30', note: bi('سقوف ← مدير مبيعات ← مشرف ← مندوب/جمعية/أوتليت.', 'Caps → sales manager → supervisor → salesman/coop/outlet.'),
        subs: [bi('سقوف الأدمن الشهرية', 'Admin monthly caps'), bi('توزيع مدير المبيعات على المشرفين', 'Sales manager distributes to supervisors'), bi('توزيع المشرف على المندوب/الجمعية/الأوتليت', 'Supervisor distributes to salesman/coop/outlet'), bi('مقارنة المصروف بالموزّع', 'Compare spend vs. allocation')] },
      { id: 5, name: bi('البناء والتنفيذ', 'Build & implementation'), pmi: bi('التنفيذ Executing', 'Executing'), st: 'done', start: '2026-06-15', end: '2026-08-15', note: bi('قاعدة البيانات، منطق الخادم، الواجهة، التكامل.', 'Database, server logic, UI, integration.'),
        subs: [bi('بناء قاعدة البيانات والترحيلات', 'Build database & migrations'), bi('منطق الخادم (قواعد/حسابات/تحقق)', 'Server logic (rules/calc/validation)'), bi('بناء الواجهة والشاشات', 'Build UI & screens'), bi('التكامل (استيراد/تصدير) وضبط الإصدارات', 'Integration (import/export) & version control')] },
      { id: 6, name: bi('الاختبار والجودة', 'Testing & quality'), pmi: bi('المراقبة M&C', 'Monitoring & Controlling'), st: 'partial', start: '2026-07-01', end: '', note: bi('اختبار E2E ويدوي منجز؛ لا يوجد إطار وحدات رسمي.', 'E2E and manual testing done; no formal unit-test framework.'),
        subs: [bi('اختبار تكامل End-to-End', 'End-to-end integration testing'), bi('اختبار دقة البيانات والأداء', 'Data-accuracy & performance testing'), bi('اختبار الصلاحيات والأمن', 'Permissions & security testing'), bi('قبول المستخدم UAT وإصلاح الأخطاء', 'UAT & bug fixing')] },
      { id: 7, name: bi('العرض والاعتماد', 'Demo & approval'), pmi: bi('التنفيذ Executing', 'Executing'), st: 'ongoing', start: '2026-06-01', end: '', note: bi('عرض واعتماد المالك مع كل ميزة.', 'Owner demo & approval with each feature.'),
        subs: [bi('تجهيز العرض والبيانات', 'Prepare demo & data'), bi('عرض السير والشاشات للمالك', 'Walk the owner through flow & screens'), bi('جمع الملاحظات وقرار المضي', 'Collect feedback & go/no-go')] },
      { id: 8, name: bi('النشر والتشغيل', 'Deployment & go-live'), pmi: bi('التنفيذ Executing', 'Executing'), st: 'done', start: '2026-07-01', end: '2026-08-20', note: bi('نشر تلقائي على Render، قرص دائم، فحص بعد النشر.', 'Auto-deploy on Render, persistent disk, post-deploy check.'),
        subs: [bi('فحص ما قبل النشر ونسخة احتياطية', 'Pre-deployment check & backup'), bi('ترحيل وتنظيف البيانات', 'Data migration & cleanup'), bi('النشر للإنتاج', 'Deploy to production'), bi('فحص المسار الحرج بعد النشر', 'Post-deploy critical-path check')] },
      { id: 9, name: bi('التدريب وإدارة التغيير', 'Training & change management'), pmi: bi('التنفيذ Executing', 'Executing'), st: 'notstarted', start: '', end: '', note: bi('لا يوجد دليل مستخدم/تدريب رسمي بعد.', 'No formal user manual/training yet.'),
        subs: [bi('إعداد دليل المستخدم والمواد', 'Prepare user manual & materials'), bi('جلسات تدريب حسب الدور', 'Role-based training sessions'), bi('إدارة التغيير والتبليغ', 'Change management & communication')] },
      { id: 10, name: bi('التغذية الراجعة والتقييم', 'Feedback & evaluation'), pmi: bi('المراقبة M&C', 'Monitoring & Controlling'), st: 'ongoing', start: '2026-06-01', end: '', note: bi('ملاحظات المالك مستمرة، سجل تدقيق للاستخدام.', 'Continuous owner feedback, usage audit log.'),
        subs: [bi('جمع التغذية الراجعة ومقاييس الاستخدام', 'Collect feedback & usage metrics'), bi('التقييم مقابل الأهداف والمؤشرات', 'Evaluate vs. goals & KPIs'), bi('تخطيط التحسينات', 'Plan improvements')] },
      { id: 11, name: bi('الدعم والصيانة والتكرار', 'Support, maintenance & iteration'), pmi: bi('مستمر Ongoing', 'Ongoing'), st: 'ongoing', start: '2026-08-20', end: '', note: bi('معالجة الأعطال، تحسينات، متطلبات جديدة.', 'Bug handling, enhancements, new requirements.'),
        subs: [bi('معالجة الأعطال (تشخيص وحل)', 'Issue handling (diagnose & resolve)'), bi('تحسينات وضبط الأداء', 'Enhancements & performance tuning'), bi('دورات تكرار لمتطلبات جديدة', 'Iterations for new requirements')] },
      { id: 12, name: bi('الإغلاق', 'Closure'), pmi: bi('الإغلاق Closing', 'Closing'), st: 'na', start: '', end: '', note: bi('غير منطبق — المشروع في تطوير نشط.', 'N-A — project in active development.'),
        subs: [bi('الإغلاق الرسمي والتسليم', 'Formal closure & handover'), bi('تحرير الموارد', 'Release resources'), bi('مراجعة ما بعد المشروع والدروس المستفادة', 'Post-project review & lessons learned')] },
    ],
    gaps: [
      bi('دليل مستخدم رسمي + مواد تدريب (المرحلة 8) — موجود بالمعيار، ناقص عندك.', 'Formal user manual + training material (phase 8) — in the standard, missing here.'),
      bi('سجل مخاطر رسمي (Risk Register) وخطة استجابة — PMBOK مجال المخاطر.', 'Formal risk register + response plan — PMBOK risk area.'),
      bi('إطار اختبار وحدات آلي (Unit tests) — المرحلة 6 (الجودة).', 'Automated unit-test framework — phase 6 (quality).'),
      bi('توثيق فني رسمي (Design/Requirements docs) — حالياً تعليقات كود فقط.', 'Formal technical docs (design/requirements) — currently only code comments.'),
      bi('معايير قبول موثّقة (Acceptance criteria) وخطة جودة رسمية.', 'Documented acceptance criteria + formal quality plan.'),
      bi('ميثاق مشروع + جدول زمني/WBS رسمي — اختياري لأن المنهجية رشيقة (Agile).', 'Project charter + formal schedule/WBS — optional since the methodology is Agile.'),
    ],
    sops: [
      { code: 'SOP-01', title: bi('إنشاء كتاب إشعار خصم (المندوب)', 'Create a debit-note letter (salesman)'), role: bi('المندوب', 'Salesman'), steps: [
        bi('ادخل بحساب المندوب واذهب لشاشة الكتب.', 'Log in as the salesman and open the Letters screen.'), bi('اضغط «كتاب جديد» واختر النوع (طبالي/استاند/فروق أسعار).', 'Click "New letter" and pick the type (pallets/stands/price-diff).'),
        bi('اختر الجمعية من نطاقك، و(اختياري) الأوتليت.', 'Pick the co-op from your scope, and optionally the outlet.'), bi('أدخل القيمة والسبب.', 'Enter the value and reason.'), bi('احفظ — يدخل الكتاب دورة الاعتماد عند المشرف.', 'Save — the letter enters the approval chain at the supervisor.')] },
      { code: 'SOP-02', title: bi('توليد الكتب من توزيعة البتجيت (المندوب)', 'Generate letters from the budget distribution (salesman)'), role: bi('المندوب', 'Salesman'), steps: [
        bi('تأكد أن المشرف وزّع البتجيت لهذا الشهر.', 'Make sure the supervisor distributed the budget for the month.'), bi('من شاشة الكتب اضغط زر ⚡ «توليد الكتب من التوزيعة».', 'On the Letters screen press the ⚡ "Generate from budget" button.'),
        bi('راجع الكتب المتولّدة (كتاب لكل جمعية/أوتليت بقيمة التوزيعة).', 'Review the generated letters (one per coop/outlet with its allocation).'), bi('الكتب تدخل الاعتماد تلقائياً؛ التكرار محمي.', 'Letters enter approval automatically; duplicates are prevented.')] },
      { code: 'SOP-03', title: bi('اعتماد الكتاب (كل مرحلة)', 'Approve a letter (each stage)'), role: bi('المشرف/المدراء', 'Supervisor/Managers'), steps: [
        bi('افتح الكتاب المعروض للاعتماد وعاينه.', 'Open the letter awaiting approval and review it.'), bi('اعتمد مع التوقيع لينتقل للمرحلة التالية، أو ارفض بسبب.', 'Approve with signature to move to the next stage, or reject with a reason.'),
        bi('الترتيب: مشرف ← مدير مبيعات ← مدير تسويق ← مدير عمليات ← جاهز.', 'Order: supervisor → sales manager → marketing manager → sales ops → ready.')] },
      { code: 'SOP-04', title: bi('الطباعة (الأدمن)', 'Printing (admin)'), role: bi('الأدمن', 'Admin'), steps: [
        bi('افتح «طابور الطباعة».', 'Open the Print Queue.'), bi('تأكد أن الكتاب أكمل كل المراحل.', 'Confirm the letter cleared all stages.'), bi('اطبع — يُسجَّل تاريخ الطباعة تلقائياً.', 'Print — the print date is recorded automatically.')] },
      { code: 'SOP-05', title: bi('إدخال إشعار الجمعية D.N (المندوب)', 'Enter the co-op debit note D.N (salesman)'), role: bi('المندوب', 'Salesman'), steps: [
        bi('بعد طباعة الكتاب، افتحه لإدخال الإشعار.', 'After the letter is printed, open it to enter the note.'), bi('أدخل رقم الإشعار بالجمعية (إلزامي).', 'Enter the co-op debit-note number (required).'),
        bi('أرفق الصور/الإثباتات.', 'Attach the photos/evidence.'), bi('احفظ — ينتظر اعتماد الأدمن.', 'Save — it awaits admin approval.')] },
      { code: 'SOP-06', title: bi('توزيع البتجيت (المشرف)', 'Distribute the budget (supervisor)'), role: bi('المشرف', 'Supervisor'), steps: [
        bi('افتح شاشة «توزيع البتجيت» واختر الشهر.', 'Open the Budget Distribution screen and pick the month.'), bi('وزّع الحصة على كل مندوب.', 'Distribute the share to each salesman.'),
        bi('وزّع على الجمعيات، و(اختياري) على الأوتليت.', 'Distribute to co-ops, and optionally to outlets.'), bi('راجع عمود «المصروف» مقابل الموزّع.', 'Review the "spend" column vs. the allocation.')] },
      { code: 'SOP-07', title: bi('إقفال الشهر والأرشفة (الأدمن)', 'Month close & archive (admin)'), role: bi('الأدمن', 'Admin'), steps: [
        bi('سكّر الشهر (شرط إلزامي).', 'Close the month (mandatory first step).'), bi('اضغط أرشفة لتوليد ZIP منظّم (المشرف ← D.N ← المندوب ← الجمعية).', 'Press Archive to build an organised ZIP (supervisor → D.N → salesman → coop).'),
        bi('كل PDF = الكتاب + المرفقات + السمري.', 'Each PDF = the letter + attachments + summary.'), bi('بعد الأرشفة تختفي من الشاشات النشطة (نسخة محفوظة).', 'After archiving they leave the active screens (a copy is kept).')] },
      { code: 'SOP-08', title: bi('إدارة المستخدمين والنسخ الاحتياطي (الأدمن)', 'User management & backup (admin)'), role: bi('الأدمن', 'Admin'), steps: [
        bi('من الإعدادات أدر المستخدمين والأدوار وكلمات المرور.', 'From Settings manage users, roles and passwords.'), bi('نزّل نسخة احتياطية دورياً.', 'Download a backup periodically.'),
        bi('راجع سجل التدقيق (Audit) للعمليات.', 'Review the audit log of operations.')] },
    ],
  };
}

function load() {
  const row = db.prepare('SELECT value FROM meta WHERE key=?').get(META_KEY);
  if (!row || !row.value) return defaults();
  try {
    const saved = JSON.parse(row.value);
    const base = defaults();
    const byId = new Map((saved.phases || []).map((p) => [p.id, p]));
    base.phases = base.phases.map((p) => {
      const s = byId.get(p.id);
      if (!s) return p;
      return {
        ...p,
        name: s.name ? nbi(s.name) : p.name,
        pmi: s.pmi ? nbi(s.pmi) : p.pmi,
        st: s.st ?? p.st, start: s.start ?? p.start, end: s.end ?? p.end,
        note: s.note ? nbi(s.note) : p.note,
        subs: Array.isArray(s.subs) ? nbiList(s.subs) : p.subs,
      };
    });
    if (saved.vision) base.vision = nbi(saved.vision);
    if (Array.isArray(saved.goals)) base.goals = nbiList(saved.goals);
    if (Array.isArray(saved.gaps)) base.gaps = nbiList(saved.gaps);
    if (Array.isArray(saved.sops)) {
      base.sops = saved.sops.map((s) => ({
        code: String(s.code || '').slice(0, 20), title: nbi(s.title), role: nbi(s.role),
        steps: nbiList(s.steps),
      })).filter((s) => s.title.ar || s.title.en);
    }
    base.updatedAt = saved.updatedAt || null;
    base.updatedBy = saved.updatedBy || null;
    return base;
  } catch (e) { return defaults(); }
}

// GET /api/methodology — the current methodology (any authenticated user).
router.get('/methodology', asyncH((req, res) => {
  res.json(load());
}));

// POST /api/methodology — admin edits; stamps the edit. Content is bilingual.
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
    if (s.name != null) p.name = nbi(s.name);
    if (s.note != null) p.note = nbi(s.note);
    if (Array.isArray(s.subs)) p.subs = nbiList(s.subs).slice(0, 20);
  }
  if (req.body.vision != null) cur.vision = nbi(req.body.vision);
  if (Array.isArray(req.body.goals)) cur.goals = nbiList(req.body.goals).slice(0, 30);
  if (Array.isArray(req.body.gaps)) cur.gaps = nbiList(req.body.gaps).slice(0, 30);
  if (Array.isArray(req.body.sops)) {
    cur.sops = req.body.sops.slice(0, 40).map((s) => ({
      code: String(s.code || '').slice(0, 20), title: nbi(s.title), role: nbi(s.role),
      steps: nbiList(s.steps).slice(0, 30),
    })).filter((s) => s.title.ar || s.title.en);
  }
  cur.updatedAt = nowIso();
  cur.updatedBy = req.user.name;
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(META_KEY, JSON.stringify({ phases: cur.phases, vision: cur.vision, goals: cur.goals, gaps: cur.gaps, sops: cur.sops, updatedAt: cur.updatedAt, updatedBy: cur.updatedBy }));
  audit.fromReq(req, 'methodology.update', { entityType: 'methodology', summary: `Updated methodology (${cur.updatedBy})` });
  res.json(cur);
}));

module.exports = router;
