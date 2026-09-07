# النشر · Deployment

## Render.com (موصى به)

النظام سيرفر Node + قاعدة SQLite، فيحتاج **قرص دائم (Persistent Disk)** للحفاظ على
البيانات. الملف `render.yaml` في جذر المشروع يعرّف كل شي تلقائيًّا.

### الطريقة الأسهل — Blueprint (بالنقر)
1. سجّل دخول على https://render.com واربط حساب GitHub.
2. **New +** → **Blueprint**.
3. اختر ريبو `oalsoos13-crypto/oalsoos13-crypto` (الفرع
   `claude/oalsoos13-crypto-analysis-lbunyk`).
4. Render يقرأ `render.yaml` وينشئ الخدمة + القرص الدائم تلقائيًّا.
5. في صفحة الخدمة → **Environment** اضبط (اختياري لكن مُستحسن):
   - `ADMIN_PASSWORD` = كلمة مرور قوية للمدير.
   - `DEFAULT_PASSWORD` = كلمة المرور المبدئية لباقي المستخدمين.
   (`JWT_SECRET` يُولَّد تلقائيًّا. لو ما ضبطت كلمات المرور، بتُستخدم الافتراضية
   ويُفرض تغييرها عند أول دخول.)
6. **Create** → انتظر البناء → بيطلعلك اللينك بالشكل:
   `https://udc-debit-note-system.onrender.com`

> **مهم:** خطة فيها Persistent Disk مدفوعة (Starter فأعلى). بدون قرص دائم على
> الخطة المجانية، بيانات SQLite بتنمسح مع كل إعادة نشر/تشغيل.

### إعداد يدوي (بدل الـ Blueprint)
- New + → **Web Service** → اربط الريبو.
- Runtime: Node، Build: `npm ci`، Start: `npm start`، Health check: `/api/health`.
- أضف قرصًا دائمًا (Disk) بمسار `/data`، واضبط `DB_FILE=/data/udc.db`.
- أضف متغيّرات: `NODE_ENV=production`، `JWT_SECRET` (قيمة عشوائية طويلة)،
  `ADMIN_PASSWORD`، `DEFAULT_PASSWORD`.

## استضافات أخرى (Docker)
يوجد `Dockerfile` جاهز. اربط قرص/حجم دائم على `/data`:
```bash
docker build -t udc .
docker run -d -p 3000:3000 \
  -e JWT_SECRET="$(openssl rand -hex 48)" \
  -e ADMIN_PASSWORD="Strong@Admin1" \
  -e DEFAULT_PASSWORD="Strong@User1" \
  -v udc_data:/data \
  --name udc udc
```

## بعد النشر
- افتح اللينك → سجّل دخول بـ `admin` → غيّر كلمة المرور (إجباري).
- من دور «النسخ والتصدير» خذ نسخة احتياطية دورية.
