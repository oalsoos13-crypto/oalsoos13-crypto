# دليل التدقيق والمراجعة · Audit Guide

يشرح هذا المستند كيف يضمن النظام قابلية التدقيق (Auditability) الكاملة، وما الذي
يُسجَّل، وكيف يستخرجه المراجعون.

## 1) سجل التدقيق (`audit_log`)

جدول **مُلحَق فقط (append‑only)** — لا يوفّر النظام أي مسار لتعديل أو حذف صفوفه.
كل صف يحتوي:

| الحقل | المعنى |
|------|--------|
| `ts` | التوقيت (UTC, ISO‑8601) |
| `user_id`, `username`, `name`, `role` | هوية الفاعل وقت العملية |
| `action` | مفتاح العملية (انظر أدناه) |
| `entity_type`, `entity_id` | الكيان المتأثّر (letter/note/budget/user…) |
| `summary` | وصف مقروء |
| `details` | تفاصيل JSON (قيم، أطراف، إلخ) |
| `ip` | عنوان الشبكة المصدر |

### الأحداث المسجّلة (actions)

| المفتاح | متى |
|--------|-----|
| `auth.login` / `auth.login.fail` / `auth.logout` | دخول/فشل دخول/خروج |
| `auth.change_password` | تغيير المستخدم كلمة مروره |
| `budget.add` / `budget.delete` | إضافة/حذف ميزانية |
| `budget.channels.save` | حفظ توزيع القنوات |
| `dist.save` | حفظ توزيع المشرفين/المناديب |
| `letter.create` / `letter.delete` | إنشاء/حذف كتاب |
| `note.create` | إصدار إشعار خصم |
| `note.approve.sup` / `note.approve.mgr` | اعتماد المشرف / المدير |
| `note.reject` | رفض إشعار (يتضمّن المرحلة والسبب) |
| `user.create` / `user.update` / `user.reset_password` | إدارة المستخدمين |
| `data.export` / `data.restore` | تصدير/استعادة البيانات |

## 2) مسار الاعتماد على مستوى الإشعار

بالإضافة إلى السجل العام، يحتفظ كل صف في جدول `notes` بأثر الاعتماد كاملًا:

- `created_by`, `created_at` — من أصدر الإشعار ومتى.
- `sup_approved_by`, `sup_approved_at` — اعتماد المشرف (المستوى الأول).
- `mgr_approved_by`, `mgr_approved_at` — اعتماد المدير (المستوى الثاني).
- `rejected_by`, `rejected_at`, `rejected_stage`, `reject_reason` — عند الرفض.

يظهر هذا المسار مرئيًّا أسفل كل إشعار في الواجهة ("مسار الاعتماد").

**حالات الإشعار:** `pending_sup → pending_mgr → approved` أو `rejected`.
الرفض لا يحذف السجل؛ يعود الكتاب إلى `pending` لإعادة الإصدار.

## 3) سلامة الأرقام

يُخصَّص رقم `LYSAL/<n>/<year>` من عدّاد ذرّي (`counters`) داخل معاملة واحدة،
فلا تتكرّر الأرقام ولا تتولّد فجوات ناتجة عن التزامن.

## 4) التصدير للمراجعين

كل التصديرات بترميز **UTF‑8 with BOM** لتُفتح بالعربية مباشرة في Excel:

| التصدير | المسار | الصلاحية |
|--------|--------|---------|
| سجل التدقيق | `GET /api/audit/export.csv` (يقبل الفلاتر) | `doc`, `admin` |
| سجل الإشعارات | `GET /api/export/notes.csv` | `doc`, `admin` |
| سجل الكتب | `GET /api/export/letters.csv` | `doc`, `admin` |
| نسخة كاملة (JSON) | `GET /api/admin/export.json` | `admin` |

فلاتر سجل التدقيق: `username`, `action`, `entityType`, `entityId`, `from`, `to`.

مثال:
```
GET /api/audit/export.csv?action=note.approve&from=2026-09-01&to=2026-09-30
```

## 5) توصيات تشغيلية للتدقيق

- خذ نسخة `admin/export.json` دوريًّا واحتفظ بها خارج الخادم.
- راجع `auth.login.fail` للكشف عن محاولات الدخول الفاشلة.
- لا تُعِد استخدام حسابات؛ عطّل بدل الحذف للحفاظ على ارتباط السجل بالهوية.
