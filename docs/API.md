# واجهة الـ API · API Reference

كل المسارات تحت البادئة `/api`. تُرجع JSON. الأخطاء بالشكل:
`{ "error": "...", "code": "..." }` مع رمز HTTP مناسب.

## المصادقة · Auth

المصادقة عبر JWT. بعد الدخول أرسل الرمز في:
`Authorization: Bearer <token>` (أو كوكي `udc_token` httpOnly تُضبط تلقائيًّا).

| الطريقة | المسار | الوصف | الصلاحية |
|--------|--------|-------|---------|
| POST | `/login` | `{username, password}` → `{token, user}` | عام |
| POST | `/logout` | إنهاء الجلسة | مصادَق |
| GET  | `/me` | المستخدم الحالي | مصادَق |
| POST | `/change-password` | `{currentPassword, newPassword}` (≥8) | مصادَق |

## الحالة · State

| GET | `/state` | كامل حالة التطبيق `{user, state}` | مصادَق |

`state` يحوي: `year, budgets, budget.channels, dist, letters, notes, counter, ref`.

## الميزانية · Budgets (marketing)

| POST | `/budgets` | `{amount, from, to, preset}` |
| DELETE | `/budgets/:id` | حذف ميزانية |
| PUT | `/channels` | `{channels:{name:amount}}` توزيع القنوات |

## التوزيع · Distribution (division)

| PUT | `/dist` | `{rows:[{sup,sales,coop,outlet,wob,amt,manual}]}` (استبدال كامل) |

## الكتب · Letters (salesman)

| POST | `/letters` | إنشاء كتاب — القيمة تُحسب في الخادم |
| DELETE | `/letters/:id` | حذف كتاب (غير مُشعَر عنه، لصاحبه) |

جسم الإنشاء: `{type, coop, brand, date, principal, note, items?|base,pct?|value?}`
حسب نوع الكتاب (`items` للـ Listing، `base/pct` لـ CDA%، `value` للبقية).

## الإشعارات والاعتماد · Notes & Approvals

| POST | `/notes` | `{letterId, coopDN, value?, date?, attachments?}` (salesman) |
| POST | `/notes/:id/approve-sup` | اعتماد المشرف (supervisor) |
| POST | `/notes/:id/approve-mgr` | اعتماد المدير (division) |
| POST | `/notes/:id/reject` | `{reason}` رفض (supervisor/division) |

## التدقيق والتصدير · Audit & Export (doc/admin)

| GET | `/audit` | فلاتر: `username, action, entityType, entityId, from, to, limit, offset` |
| GET | `/audit/export.csv` | تصدير مُفلتَر |
| GET | `/export/notes.csv` | سجل الإشعارات |
| GET | `/export/letters.csv` | سجل الكتب |

## الإدارة · Admin (admin only)

| GET | `/admin/users` | قائمة المستخدمين |
| POST | `/admin/users` | `{username, name, role, password?}` |
| PATCH | `/admin/users/:id` | `{name?, role?, active?}` |
| POST | `/admin/users/:id/reset-password` | `{password?}` |
| GET | `/admin/export.json` | نسخة احتياطية كاملة |
| POST | `/admin/restore` | استعادة بيانات العمل (JSON) |

## أخرى

| GET | `/health` | فحص الحياة `{ok, ts}` | عام |

### أكواد الأخطاء الشائعة
`BAD_CREDS` (401)، `NO_AUTH` (401)، `ROLE` (403)، `BAD_STATE` (400)،
`HAS_NOTE` (400)، `NO_REASON` (400)، `LAST_ADMIN` (400)، `DUP` (400)، `NO_ROUTE` (404).
