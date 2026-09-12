/* =====================================================================
   UDC · Debit Note System — client (v2, API-backed, multi-user, audited)
   Talks to the Node/SQLite backend; no business data is stored in the
   browser (only the auth token + language preference).
   ===================================================================== */
const LOGOS = window.LOGOS || {};
let currentUser = null;
let TOKEN = null;
let YEAR = 2026;
// Reference data (co-ops, brands, channels, letter types, supervisors…),
// populated from the server via /api/state.
let SEED = {
  coops: [], brands: [], principals: [], channels: [],
  letterTypes: [], supervisors: [], channelsEn: {},
};

const KD = (n) =>
  (Number(n) || 0).toLocaleString("en-US", {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  });
/* ---------- i18n ---------- */
let LANG = "ar";
const T = {
  barTitle: { ar: "نظام إشعارات الخصم", en: "Debit Note System" },
  barSub: {
    ar: "UDC · الشركة المتحدة المتميزة للتجارة العامة للمواد الغذائية",
    en: "UDC · United Distinctive Co. for Gen. Trad. for Foodstuffs",
  },
  langBtn: { ar: "EN", en: "ع" },
  roles: { ar: "الأدوار", en: "Roles" },
  back: { ar: "الأدوار", en: "Roles" },
  homeTitle: { ar: "اختر جهتك للدخول", en: "Choose your role" },
  homeSub: {
    ar: "كل جهة إلها صفحتها المنفصلة — والبتجيت بينزل من فوق لتحت",
    en: "Each party has its own page — budget cascades top-down",
  },
  enter: { ar: "دخول", en: "Enter" },
  r_marketing: { ar: "الماركتينج", en: "Marketing" },
  r_marketing_d: {
    ar: "إنشاء الميزانية وتوزيعها على القنوات.",
    en: "Create the budget and distribute it across channels.",
  },
  r_division: { ar: "مدير القسم", en: "Division Manager" },
  r_division_d: {
    ar: "استلام ميزانية الجمعيات وتوزيعها على المشرفين.",
    en: "Receive the co-ops budget and split it among supervisors.",
  },
  r_supervisor: { ar: "السوبر فايزر", en: "Supervisor" },
  r_supervisor_d: {
    ar: "توزيع الحصة على المناديب ومتابعة الجمعيات.",
    en: "Allocate to salesmen and follow up co-ops.",
  },
  r_salesman: { ar: "المندوب", en: "Salesman" },
  r_salesman_d: {
    ar: "إنشاء الكتب وتوليد إشعارات الخصم.",
    en: "Create letters and generate debit notes.",
  },
  r_doc: { ar: "التوثيق والتتبّع", en: "Documentation & Tracking" },
  r_doc_d: {
    ar: "أرشفة الكتب والإشعارات ومتابعة المتبقّي.",
    en: "Archive letters and notes, track the remaining budget.",
  },
  c_total: { ar: "إجمالي الميزانية", en: "Total budget" },
  c_distCh: { ar: "الموزّع على القنوات", en: "Distributed to channels" },
  c_unalloc: { ar: "غير موزّع", en: "Unallocated" },
  c_recv: { ar: "الحصة المستلمة", en: "Received" },
  c_distSup: { ar: "الموزّع على المشرفين", en: "Distributed to supervisors" },
  c_rem: { ar: "المتبقّي", en: "Remaining" },
  c_coopBudget: {
    ar: "ميزانية الجمعيات (من الماركتينج)",
    en: "Co-ops budget (from Marketing)",
  },
  c_distSales: { ar: "الموزّع على المناديب", en: "Distributed to salesmen" },
  c_avail: { ar: "الحصة المتاحة", en: "Available" },
  c_spent: { ar: "المصروف (إشعارات)", en: "Spent (notes)" },
  c_spentAll: { ar: "المصروف", en: "Spent" },
  c_notes: { ar: "عدد الإشعارات", en: "Debit notes" },
  kd: { ar: "د.ك", en: "KD" },
  totalBudget: { ar: "إجمالي البتجيت", en: "Total budget" },
  period: { ar: "الفترة", en: "Period" },
  save: { ar: "حفظ", en: "Save" },
  chanDist: {
    ar: "توزيع البتجيت على القنوات",
    en: "Distribute budget across channels",
  },
  saveDist: { ar: "حفظ التوزيع", en: "Save distribution" },
  distSups: {
    ar: "توزيع الحصص على المشرفين",
    en: "Allocate shares to supervisors",
  },
  distSales: {
    ar: "توزيع الحصص على المناديب",
    en: "Allocate shares to salesmen",
  },
  add: { ar: "إضافة", en: "Add" },
  supervisor: { ar: "المشرف", en: "Supervisor" },
  salesman: { ar: "المندوب", en: "Salesman" },
  share: { ar: "الحصة (د.ك)", en: "Share (KD)" },
  choose: { ar: "— اختر —", en: "— select —" },
  coopsRef: { ar: "الجمعيات (مرجع)", en: "Co-ops (reference)" },
  coopsN: { ar: "جمعية", en: "co-ops" },
  coop: { ar: "الجمعية", en: "Co-op" },
  mainOut: { ar: "أوتليت المين", en: "Main outlets" },
  branches: { ar: "الفروع", en: "Branches" },
  total: { ar: "الإجمالي", en: "Total" },
  letters: { ar: "الكتب", en: "Letters" },
  newLetter: { ar: "كتاب جديد", en: "New letter" },
  th_type: { ar: "النوع", en: "Type" },
  th_brand: { ar: "البراند", en: "Brand" },
  th_value: { ar: "القيمة", en: "Value" },
  th_date: { ar: "التاريخ", en: "Date" },
  th_status: { ar: "الحالة", en: "Status" },
  th_actions: { ar: "إجراءات", en: "Actions" },
  st_draft: { ar: "مسودّة", en: "Draft" },
  st_appr: { ar: "معتمد", en: "Approved" },
  st_noted: { ar: "مُنشأ إشعاره", en: "Note created" },
  approve: { ar: "اعتماد", en: "Approve" },
  mkNote: { ar: "إنشاء إشعار", en: "Create note" },
  print: { ar: "طباعة", en: "Print" },
  del: { ar: "حذف", en: "Delete" },
  noLetters: {
    ar: "لا يوجد كتب بعد — ابدأ بإنشاء كتاب جديد.",
    en: "No letters yet — start by creating a new one.",
  },
  noNotes: {
    ar: "لا يوجد إشعارات بعد — تُنشأ من كتاب معتمد في صفحة المندوب.",
    en: "No debit notes yet — created from an approved letter in the Salesman page.",
  },
  fType: { ar: "نوع الكتاب", en: "Letter type" },
  fBrand: { ar: "البراند", en: "Brand" },
  fDate: { ar: "التاريخ", en: "Date" },
  fPrin: { ar: "المبدأ", en: "Principal" },
  fNote: { ar: "ملاحظات", en: "Notes" },
  items: {
    ar: "الأصناف المعتمدة (اسم + سعر)",
    en: "Approved items (name + price)",
  },
  addItem: { ar: "إضافة صنف", en: "Add item" },
  itemName: { ar: "اسم الصنف", en: "Item name" },
  price: { ar: "السعر", en: "Price" },
  valFormula: {
    ar: "القيمة = مجموع الأسعار × أوتليت المين",
    en: "Value = sum of prices × main outlets",
  },
  base: { ar: "قيمة الأساس (د.ك)", en: "Base value (KD)" },
  pct: { ar: "النسبة %", en: "Percent %" },
  valOut: { ar: "القيمة الناتجة", en: "Result" },
  valDirect: { ar: "قيمة الكتاب (د.ك)", en: "Letter value (KD)" },
  saveLetter: { ar: "حفظ الكتاب", en: "Save letter" },
  cancel: { ar: "إلغاء", en: "Cancel" },
  close: { ar: "إغلاق", en: "Close" },
  enterVal: {
    ar: "أدخل قيمة الكتاب أولاً",
    en: "Enter the letter value first",
  },
  saved: { ar: "تم الحفظ", en: "Saved" },
  savedLetter: { ar: "تم حفظ الكتاب", en: "Letter saved" },
  apprd: { ar: "تم الاعتماد", en: "Approved" },
  noteReg: { ar: "سجل إشعارات الخصم", en: "Debit notes register" },
  nextNo: { ar: "الرقم التالي", en: "Next no." },
  th_noteNo: { ar: "رقم الإشعار", en: "Note no." },
  viewPrint: { ar: "عرض / طباعة", en: "View / Print" },
  letterReg: { ar: "سجل الكتب", en: "Letters register" },
  spendByType: { ar: "المصروف حسب نوع الكتاب", en: "Spend by letter type" },
  spendByCoop: { ar: "المصروف حسب الجمعية", en: "Spend by co-op" },
  noteCount: { ar: "عدد الإشعارات", en: "Notes" },
  listLetters: { ar: "كتب الليستنق", en: "Listing letters" },
  noMove: { ar: "لا يوجد حركة بعد.", en: "No activity yet." },
  noteMade: { ar: "تم إنشاء الإشعار", en: "Debit note created" },
  updated: { ar: "تم التحديث", en: "Updated" },
  previewLetter: { ar: "معاينة الكتاب", en: "Letter preview" },
  debitNote: { ar: "إشعار خصم", en: "Debit note" },
  loginTitle: { ar: "تسجيل الدخول", en: "Sign in" },
  loginSub: {
    ar: "ادخل باسم المستخدم الخاص بك",
    en: "Enter with your username",
  },
  username: { ar: "اسم المستخدم", en: "Username" },
  password: { ar: "كلمة المرور", en: "Password" },
  loginBtn: { ar: "دخول", en: "Sign in" },
  wrongCreds: {
    ar: "اسم المستخدم أو كلمة المرور غير صحيحة",
    en: "Invalid username or password",
  },
  logout: { ar: "خروج", en: "Logout" },
  passHint: {
    ar: "كلمة المرور الافتراضية: 1234",
    en: "Default password: 1234",
  },
  selPeriod: { ar: "اختر الفترة", en: "Select period" },
  p_today: { ar: "اليوم", en: "Today" },
  p_yest: { ar: "أمس", en: "Yesterday" },
  p_tweek: { ar: "هذا الأسبوع", en: "This Week" },
  p_lweek: { ar: "الأسبوع الماضي", en: "Last Week" },
  p_tmonth: { ar: "هذا الشهر", en: "This Month" },
  p_lmonth: { ar: "الشهر الماضي", en: "Last Month" },
  p_tquarter: { ar: "هذا الربع", en: "This Quarter" },
  p_tyear: { ar: "هذه السنة", en: "This Year" },
  apply: { ar: "تطبيق", en: "Apply" },
  clr: { ar: "مسح", en: "Clear" },
  noPeriod: { ar: "لم تُحدَّد", en: "Not set" },
  addBudget: { ar: "إضافة بتجيت", en: "Add budget" },
  amount: { ar: "المبلغ", en: "Amount" },
  budgetsTracking: { ar: "تتبّع البتجيتات", en: "Budgets tracking" },
  th_period: { ar: "الفترة", en: "Period" },
  th_amount: { ar: "المبلغ", en: "Amount" },
  th_created: { ar: "تاريخ الإنشاء", en: "Created" },
  noBudgets: {
    ar: "لا يوجد بتجيتات بعد — أضف بتجيت بفترته ومبلغه.",
    en: "No budgets yet — add one with its period and amount.",
  },
  budgetAdded: { ar: "تمت إضافة البتجيت", en: "Budget added" },
  pickPeriod: { ar: "اختر الفترة أولاً", en: "Pick a period first" },
  enterAmount: { ar: "أدخل المبلغ", en: "Enter the amount" },
  totalWob: { ar: "إجمالي WOB", en: "Total WOB" },
  distTable: {
    ar: "جدول التوزيع (حسب WOB)",
    en: "Distribution table (by WOB)",
  },
  mainCoop: { ar: "الجمعية المين", en: "Main co-op" },
  outlet: { ar: "الأوتليت", en: "Outlet" },
  wob: { ar: "WOB", en: "WOB" },
  myAssignments: { ar: "توزيعاتي", en: "My assignments" },
  noAssign: {
    ar: "لا يوجد توزيعات لك بعد.",
    en: "No assignments for you yet.",
  },
  c_rowsN: { ar: "عدد الصفوف", en: "Rows" },
  amtEditable: {
    ar: "المبلغ قابل للتعديل يدوياً · ↺ يرجّعه لـ WOB",
    en: "Amount is editable · ↺ resets to WOB",
  },
  enterDN: { ar: "إدخال إشعار الخصم", en: "Enter debit note" },
  dnNumber: {
    ar: "رقم الإشعار (من الجمعية)",
    en: "Debit note no. (from co-op)",
  },
  letterNo: { ar: "رقم الكتاب", en: "Letter no." },
  coopDN: { ar: "رقم الإشعار بالجمعية", en: "Co-op note no." },
  saveDN: { ar: "حفظ الإشعار", en: "Save note" },
  dnSaved: { ar: "تم حفظ الإشعار", en: "Debit note saved" },
  attachments: { ar: "المرفقات (صور/PDF)", en: "Attachments (images/PDF)" },
  st_pending: { ar: "بانتظار الإشعار", en: "Awaiting note" },
  st_done: { ar: "مكتمل", en: "Completed" },
  printLetter: { ar: "طباعة الكتاب", en: "Print letter" },
  viewDN: { ar: "عرض الإشعار", en: "View note" },
  pendSupTitle: {
    ar: "إشعارات بانتظار موافقتك",
    en: "Notes awaiting your approval",
  },
  pendMgrTitle: {
    ar: "إشعارات بانتظار الاعتماد",
    en: "Notes awaiting approval",
  },
  noPending: { ar: "لا يوجد إشعارات بانتظار.", en: "Nothing pending." },
  view: { ar: "عرض", en: "View" },
  reject: { ar: "رفض", en: "Reject" },
  rejected: { ar: "تم الرفض", en: "Rejected" },
  st_waitSup: { ar: "بانتظار موافقة المشرف", en: "Awaiting supervisor" },
  st_waitMgr: { ar: "بانتظار موافقة المدير", en: "Awaiting manager" },
  st_approved2: { ar: "معتمد", en: "Approved" },
  st_rejected: { ar: "مرفوض", en: "Rejected" },
  /* ---- v2 additions ---- */
  r_admin: { ar: "مدير النظام", en: "Administrator" },
  r_audit: { ar: "سجل التدقيق", en: "Audit Log" },
  r_audit_d: { ar: "استعراض كل العمليات وتصديرها للمراجعة.", en: "Review and export every action." },
  r_users: { ar: "المستخدمون", en: "Users" },
  r_users_d: { ar: "إدارة الحسابات والأدوار وكلمات المرور.", en: "Manage accounts, roles and passwords." },
  r_backup: { ar: "النسخ والتصدير", en: "Backup & Export" },
  r_backup_d: { ar: "نسخ احتياطي واستعادة وتصدير البيانات.", en: "Backup, restore and export data." },
  changePw: { ar: "تغيير كلمة المرور", en: "Change password" },
  changePwSub: { ar: "اختر كلمة مرور جديدة قوية.", en: "Choose a new strong password." },
  mustChangeMsg: { ar: "لأسباب أمنية، يجب تغيير كلمة المرور الافتراضية قبل المتابعة.", en: "For security, you must change the default password before continuing." },
  currentPw: { ar: "كلمة المرور الحالية", en: "Current password" },
  newPw: { ar: "كلمة المرور الجديدة", en: "New password" },
  confirmPw: { ar: "تأكيد كلمة المرور", en: "Confirm password" },
  pwTooShort: { ar: "8 أحرف على الأقل.", en: "At least 8 characters." },
  pwMismatch: { ar: "كلمتا المرور غير متطابقتين.", en: "Passwords do not match." },
  pwChanged: { ar: "تم تغيير كلمة المرور", en: "Password changed" },
  confirmDel: { ar: "تأكيد الحذف؟", en: "Confirm delete?" },
  overBudgetWarn: { ar: "التوزيع أكبر من إجمالي الميزانية. المتابعة؟", en: "Distribution exceeds total budget. Continue?" },
  rejectReason: { ar: "سبب الرفض", en: "Reject reason" },
  rejectReasonPh: { ar: "اكتب سبب الرفض…", en: "Type the reason…" },
  confirmReject: { ar: "تأكيد الرفض", en: "Confirm reject" },
  needReason: { ar: "أدخل سبب الرفض.", en: "Enter a reason." },
  approvalTrail: { ar: "مسار الاعتماد", en: "Approval trail" },
  createdBy: { ar: "أنشأه", en: "Created by" },
  supApproved: { ar: "اعتماد المشرف", en: "Supervisor approved" },
  mgrApproved: { ar: "اعتماد المدير", en: "Manager approved" },
  rejectedBy: { ar: "رفضه", en: "Rejected by" },
  sup: { ar: "مشرف", en: "supervisor" },
  mgr: { ar: "مدير", en: "manager" },
  auditLog: { ar: "سجل التدقيق", en: "Audit log" },
  action: { ar: "العملية", en: "Action" },
  fromDate: { ar: "من تاريخ", en: "From" },
  toDate: { ar: "إلى تاريخ", en: "To" },
  apply: { ar: "تطبيق", en: "Apply" },
  loading: { ar: "جارِ التحميل…", en: "Loading…" },
  noAudit: { ar: "لا توجد سجلات.", en: "No records." },
  showing: { ar: "المعروض", en: "Showing" },
  viewAll: { ar: "عرض الكل", en: "View all" },
  exportCsv: { ar: "تصدير CSV", en: "Export CSV" },
  th_time: { ar: "الوقت", en: "Time" },
  th_role: { ar: "الدور", en: "Role" },
  th_detail: { ar: "التفاصيل", en: "Detail" },
  userMgmt: { ar: "إدارة المستخدمين", en: "User management" },
  addUser: { ar: "مستخدم جديد", en: "New user" },
  name: { ar: "الاسم", en: "Name" },
  active: { ar: "مُفعّل", en: "Active" },
  inactive: { ar: "معطّل", en: "Disabled" },
  pwPending: { ar: "بانتظار تغيير كلمة المرور", en: "password change pending" },
  lastLogin: { ar: "آخر دخول", en: "Last login" },
  edit: { ar: "تعديل", en: "Edit" },
  resetPw: { ar: "إعادة تعيين", en: "Reset pw" },
  initialPw: { ar: "كلمة المرور المبدئية", en: "Initial password" },
  defaultPwNote: { ar: "اتركه فارغًا لاستخدام الافتراضي", en: "Leave blank for default" },
  confirmResetPw: { ar: "إعادة تعيين كلمة المرور لهذا المستخدم؟", en: "Reset this user's password?" },
  pwReset: { ar: "تمت إعادة التعيين", en: "Password reset" },
  backupTitle: { ar: "نسخة احتياطية", en: "Backup" },
  backupDesc: { ar: "تنزيل كامل البيانات كملف JSON.", en: "Download all data as a JSON file." },
  downloadBackup: { ar: "تنزيل نسخة احتياطية", en: "Download backup" },
  restoreTitle: { ar: "استعادة", en: "Restore" },
  restoreWarn: { ar: "⚠ الاستعادة تستبدل بيانات العمل الحالية (لا تشمل المستخدمين).", en: "⚠ Restore replaces current business data (users excluded)." },
  chooseBackup: { ar: "اختر ملف النسخة", en: "Choose backup file" },
  confirmRestore: { ar: "هل أنت متأكد؟ سيتم استبدال البيانات الحالية.", en: "Are you sure? Current data will be replaced." },
  restoreDone: { ar: "تمت الاستعادة", en: "Restore complete" },
  dataExports: { ar: "تصدير البيانات", en: "Data exports" },
  notesCsv: { ar: "الإشعارات CSV", en: "Notes CSV" },
  lettersCsv: { ar: "الكتب CSV", en: "Letters CSV" },
  auditCsv: { ar: "التدقيق CSV", en: "Audit CSV" },
  /* price-update letter type + letterhead */
  priceRows: { ar: "أصناف تحديث السعر", en: "Price-update items" },
  addRow: { ar: "إضافة صف", en: "Add row" },
  addRowFirst: { ar: "أضف صنفًا واحدًا على الأقل", en: "Add at least one item" },
  th_item: { ar: "رقم الصنف", en: "Item #" },
  th_name: { ar: "اسم الصنف", en: "Name" },
  th_pack: { ar: "الشد", en: "Pack" },
  th_barcode: { ar: "باركود الحبة", en: "Barcode" },
  coopOld: { ar: "جمعية-قديم", en: "Coop-old" },
  coopNew: { ar: "جمعية-جديد", en: "Coop-new" },
  consOld: { ar: "مستهلك-قديم", en: "Cons-old" },
  consNew: { ar: "مستهلك-جديد", en: "Cons-new" },
  st_letterOnly: { ar: "كتاب فقط", en: "Letter only" },
  lhFull: { ar: "ليتر هيد كامل", en: "Full letterhead" },
  lhBlank: { ar: "ورق مطبوع مسبقًا", en: "Pre-printed paper" },
  lhToggleHint: { ar: "تبديل: طباعة الليتر هيد كامل أو ترك مساحة للورق المطبوع", en: "Toggle full letterhead vs blank margins" },
  /* outlets & sales master data */
  r_outlets: { ar: "المنافذ والعقود", en: "Outlets & Contracts" },
  r_outlets_d: { ar: "المنافذ الفعلية وخطوط السير وشروط العقود.", en: "Real outlets, routes and contract terms." },
  r_sales: { ar: "المبيعات والتارجت", en: "Sales & Targets" },
  r_sales_d: { ar: "المبيعات السنوية والتارجت وحالة الإدراج.", en: "Annual sales, targets and listing status." },
  outletsTitle: { ar: "المنافذ والعقود", en: "Outlets & contracts" },
  salesTitle: { ar: "المبيعات السنوية والتارجت", en: "Annual sales & targets" },
  route: { ar: "خط السير", en: "Route" },
  merchandiser: { ar: "المندِّب", en: "Merchandiser" },
  contract: { ar: "العقد", en: "Contract" },
  target: { ar: "التارجت", en: "Target" },
  search: { ar: "بحث…", en: "Search…" },
  noOutlets: { ar: "لا توجد منافذ.", en: "No outlets." },
  noSales: { ar: "لا توجد بيانات مبيعات.", en: "No sales data." },
  sales: { ar: "المبيعات", en: "Sales" },
  salesYtd: { ar: "المبيعات حتى الآن", en: "Sales YTD" },
  yoy: { ar: "مقابل 2025", en: "vs 2025" },
  atRisk: { ar: "تحت الخطر (Risk)", en: "At risk" },
  annualTrend: { ar: "المبيعات السنوية (إجمالي)", en: "Annual sales (total)" },
  top10_2026: { ar: "أعلى 10 جمعيات (2026)", en: "Top 10 co-ops (2026)" },
  outletLinkHint: { ar: "المبلغ قابل للتعديل · اختر منفذًا لتعبئة WOB تلقائيًا", en: "Amount editable · pick an outlet to auto-fill WOB" },
  recipient: { ar: "المستلِم", en: "Recipient" },
  r_products: { ar: "المنتجات والباركود", en: "Products & Barcodes" },
  r_products_d: { ar: "كتالوج المنتجات — استيراد من ملف واستخدامه بالجداول.", en: "Product catalog — import from file, use in tables." },
  productsTitle: { ar: "المنتجات والباركود", en: "Products & barcodes" },
  importFile: { ar: "استيراد ملف", en: "Import file" },
  importHint: { ar: "ارفع Excel/CSV فيه أعمدة: الباركود، اسم الصنف، الشد، بلد المنشأ، سعر المستهلك، سعر الجمعية — يُدمج حسب الباركود.", en: "Upload Excel/CSV with columns: barcode, name, pack, origin, consumer price, coop price — merged by barcode." },
  imported: { ar: "مستورد", en: "Imported" },
  skipped: { ar: "متجاوَز", en: "Skipped" },
  total: { ar: "الإجمالي", en: "Total" },
  importDone: { ar: "تم الاستيراد", en: "Import done" },
  noProducts: { ar: "لا توجد منتجات — استورد ملفًا.", en: "No products — import a file." },
  origin: { ar: "بلد المنشأ", en: "Origin" },
  consPiece: { ar: "سعر المستهلك", en: "Consumer" },
  coopCarton: { ar: "سعر الجمعية", en: "Coop" },
};
function t(k) {
  const e = T[k];
  return e ? e[LANG] : k;
}
function chan(c) {
  return LANG === "en" ? SEED.channelsEn[c] || c : c;
}
function ltName(k) {
  const x = SEED.letterTypes.find((t) => t.k === k);
  return x ? (LANG === "en" ? x.en : x.ar) : k;
}
function toggleLang() {
  LANG = LANG === "ar" ? "en" : "ar";
  try { localStorage.setItem("udc_lang", LANG); } catch (e) {}
  applyDir();
  render();
}
function applyDir() {
  document.documentElement.lang = LANG;
  document.documentElement.dir = LANG === "ar" ? "rtl" : "ltr";
  document.getElementById("barTitle").textContent = t("barTitle");
  document.getElementById("barSub").textContent = t("barSub");
  document.getElementById("langBtn").textContent = t("langBtn");
}
/* ---------- API client + server-backed state ---------- */
async function api(path, opts) {
  opts = opts || {};
  const headers = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (TOKEN) headers["Authorization"] = "Bearer " + TOKEN;
  const res = await fetch("/api" + path, {
    method: opts.method || "GET",
    headers,
    credentials: "same-origin",
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (opts.raw) return res;
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) {
    if (res.status === 401) { TOKEN = null; currentUser = null; }
    const err = new Error((data && data.error) || "HTTP " + res.status);
    err.code = data && data.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

let DB = {
  budgets: [],
  budget: { channels: {} },
  dist: [],
  letters: [],
  notes: [],
  counter: 0,
  ref: SEED,
};

// Pull the full application state from the server into the local cache.
async function loadState() {
  const r = await api("/state");
  currentUser = r.user;
  const s = r.state;
  DB.budgets = s.budgets || [];
  DB.budget = s.budget || { channels: {} };
  DB.dist = s.dist || [];
  DB.letters = s.letters || [];
  DB.notes = s.notes || [];
  DB.counter = s.counter || 0;
  SEED = s.ref || SEED;
  DB.ref = SEED;
  if (s.year) YEAR = s.year;
}
function toast(m) {
  const t = document.getElementById("toast");
  t.textContent = m;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 1900);
}
function refNo(n) {
  return "LYSAL/" + n + "/" + YEAR;
}
function coop(n) {
  return DB.ref.coops.find((c) => c.n === n);
}
function esc(s) {
  return String(s == null ? "" : s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
}
function spent() {
  return DB.notes
    .filter((n) => n.status === "approved")
    .reduce((s, n) => s + (+n.value || 0), 0);
}
function budgetTotal() {
  return sum(DB.budgets.map((b) => b.amount));
}
function spentInPeriod(f, t) {
  return DB.notes
    .filter((n) => n.status === "approved")
    .reduce((s, n) => {
      const d = n.date || "";
      if (f && t) {
        return d >= f && d <= t ? s + (+n.value || 0) : s;
      }
      return s + (+n.value || 0);
    }, 0);
}
function sum(a) {
  return a.reduce((s, x) => s + (+x || 0), 0);
}
function coopChannelBudget() {
  return +(DB.budget.channels || {})["الجمعيات"] || 0;
}
function scopeName() {
  return currentUser && currentUser.role !== "admin" ? currentUser.name : null;
}
/* ---------- roles ---------- */
const ROLES = [
  { k: "marketing", ic: "◵" },
  { k: "division", ic: "⇲" },
  { k: "supervisor", ic: "⋔" },
  { k: "salesman", ic: "✎" },
  { k: "doc", ic: "❏" },
];
let role = null;
function go(r) {
  role = r;
  render();
}
function render() {
  applyDir();
  if (!currentUser) {
    document.getElementById("roleChip").innerHTML = "";
    document.getElementById("userBox").innerHTML = "";
    renderLogin();
    return;
  }
  document.getElementById("userBox").innerHTML =
    `<span class="userN">${esc(currentUser.name)}</span><button class="lang" title="${t("changePw")}" onclick="openChangePw()">🔑</button><button class="lang" onclick="logout()">${t("logout")}</button>`;
  // Force a password change on first login.
  if (currentUser.mustChangePassword) {
    document.getElementById("roleChip").innerHTML = "";
    renderChangePw(true);
    return;
  }
  const isAdmin = currentUser.role === "admin";
  if (isAdmin && !role) {
    document.getElementById("roleChip").innerHTML = "";
    renderHome();
    return;
  }
  // Read-only reference/report views each role may open beyond its own home.
  const EXTRA = {
    marketing: ["sales", "outlets", "products"],
    division: ["outlets", "sales", "products"],
    supervisor: ["outlets", "products"],
    doc: ["outlets", "sales", "products"],
    salesman: ["outlets", "products"],
  };
  let rk;
  if (isAdmin) rk = role;
  else if (role && (EXTRA[currentUser.role] || []).includes(role)) rk = role;
  else rk = currentUser.role;
  role = rk;
  document.getElementById("roleChip").innerHTML =
    `<span class="role-chip">${t("r_" + rk)}</span>`;
  // Navigation buttons (right side of the role bar).
  let nav = "";
  if (isAdmin) {
    nav = `<button class="back" onclick="go(null)">← ${t("back")}</button>`;
  } else {
    const extras = EXTRA[currentUser.role] || [];
    const btns = extras
      .filter((v) => v !== rk)
      .map((v) => `<button class="back" onclick="go('${v}')">${t("r_" + v)}</button>`)
      .join("");
    const backBtn = rk !== currentUser.role ? `<button class="back" onclick="go('${currentUser.role}')">← ${t("back")}</button>` : "";
    nav = backBtn + btns;
  }
  document.getElementById("app").innerHTML =
    `<div class="rolebar"><div class="wrap"><div><h2>${t("r_" + rk)}</h2><div class="sub">${t("r_" + rk + "_d")}</div></div><div class="navbtns">${nav}</div></div></div><div class="page"><div class="wrap" id="rv"></div></div>`;
  const view = {
    marketing: vMarketing,
    division: vDivision,
    supervisor: vSupervisor,
    salesman: vSalesman,
    doc: vDoc,
    audit: vAudit,
    users: vUsers,
    backup: vBackup,
    outlets: vOutlets,
    sales: vSales,
    products: vProducts,
  }[rk];
  if (view) view();
  else renderHome();
}
function renderLogin() {
  document.getElementById("app").innerHTML =
    `<div class="login-wrap"><div class="login-card">
   <h2>${t("loginTitle")}</h2><p>${t("loginSub")}</p>
   <div class="field"><label>${t("username")}</label><input id="lgU" autocomplete="username" onkeydown="if(event.key==='Enter')doLogin()"></div>
   <div class="field" style="margin-top:12px"><label>${t("password")}</label><input id="lgP" type="password" autocomplete="current-password" onkeydown="if(event.key==='Enter')doLogin()"></div>
   <div class="login-err" id="lgErr"></div>
   <div class="actions" style="margin-top:6px"><button class="btn primary" style="width:100%;justify-content:center" onclick="doLogin()">${t("loginBtn")}</button></div>
   <p style="margin-top:14px;font-size:12px">${t("passHint")}</p>
 </div></div>`;
}
async function doLogin() {
  const u = document.getElementById("lgU").value.trim().toLowerCase(),
    p = document.getElementById("lgP").value;
  const btn = document.querySelector(".login-card .btn");
  if (btn) btn.disabled = true;
  try {
    const r = await api("/login", { method: "POST", body: { username: u, password: p } });
    TOKEN = r.token;
    try { localStorage.setItem("udc_token", TOKEN); } catch (e) {}
    currentUser = r.user;
    role = null;
    await loadState();
    render();
  } catch (e) {
    if (btn) btn.disabled = false;
    document.getElementById("lgErr").textContent = e.message || t("wrongCreds");
  }
}
async function logout() {
  try { await api("/logout", { method: "POST" }); } catch (e) {}
  TOKEN = null;
  currentUser = null;
  role = null;
  try { localStorage.removeItem("udc_token"); } catch (e) {}
  render();
}
/* ---------- change password ---------- */
function renderChangePw(force) {
  document.getElementById("app").innerHTML =
    `<div class="login-wrap"><div class="login-card">
   <h2>${t("changePw")}</h2>
   ${force ? `<div class="pwd-warn">${t("mustChangeMsg")}</div>` : `<p>${t("changePwSub")}</p>`}
   <div class="field"><label>${t("currentPw")}</label><input id="cpCur" type="password" autocomplete="current-password"></div>
   <div class="field" style="margin-top:12px"><label>${t("newPw")}</label><input id="cpNew" type="password" autocomplete="new-password"></div>
   <div class="field" style="margin-top:12px"><label>${t("confirmPw")}</label><input id="cpConf" type="password" autocomplete="new-password" onkeydown="if(event.key==='Enter')doChangePw()"></div>
   <div class="login-err" id="cpErr"></div>
   <div class="actions" style="margin-top:10px;gap:8px">
     <button class="btn primary" style="flex:1;justify-content:center" onclick="doChangePw()">${t("save")}</button>
     ${force ? `<button class="btn ghost" onclick="logout()">${t("logout")}</button>` : `<button class="btn ghost" onclick="closeModal();render()">${t("cancel")}</button>`}
   </div>
 </div></div>`;
}
function openChangePw() {
  renderChangePw(false);
}
async function doChangePw() {
  const cur = document.getElementById("cpCur").value;
  const nw = document.getElementById("cpNew").value;
  const cf = document.getElementById("cpConf").value;
  const err = document.getElementById("cpErr");
  if (nw.length < 8) { err.textContent = t("pwTooShort"); return; }
  if (nw !== cf) { err.textContent = t("pwMismatch"); return; }
  try {
    await api("/change-password", { method: "POST", body: { currentPassword: cur, newPassword: nw } });
    const me = await api("/me");
    currentUser = me.user;
    role = null;
    toast(t("pwChanged"));
    render();
  } catch (e) {
    err.textContent = e.message;
  }
}
const ADMIN_ROLES = [
  { k: "outlets", ic: "🏪" },
  { k: "products", ic: "📦" },
  { k: "sales", ic: "📈" },
  { k: "audit", ic: "🛡" },
  { k: "users", ic: "👥" },
  { k: "backup", ic: "💾" },
];
function renderHome() {
  const cards = ROLES.concat(currentUser.role === "admin" ? ADMIN_ROLES : []);
  document.getElementById("app").innerHTML =
    `<div class="wrap"><div class="home-hero"><h2>${t("homeTitle")}</h2><p>${t("homeSub")}</p></div><div class="roles">${cards.map((r) => `<div class="role-card" onclick="go('${r.k}')"><div class="ic">${r.ic}</div><h3>${t("r_" + r.k)}</h3><p>${t("r_" + r.k + "_d")}</p><div class="enter">${t("enter")} →</div></div>`).join("")}</div></div>`;
}
function card(cls, lbl, val, kd, extra) {
  return `<div class="card ${cls || ""}"><div class="lbl">${lbl}</div><div class="val">${val}${kd ? ` <small>${t("kd")}</small>` : ""}</div>${extra || ""}</div>`;
}
/* ---------- marketing ---------- */
function vMarketing() {
  const total = budgetTotal(),
    sp = spent(),
    alloc = sum(Object.values(DB.budget.channels || {}));
  document.getElementById("rv").innerHTML = `
  <div class="cards">${card("accent", t("c_total"), KD(total), 1)}${card("warn", t("c_spentAll"), KD(sp), 1)}${card("ok", t("c_rem"), KD(total - sp), 1)}</div>
  <div class="panel"><header><h3>${t("addBudget")}</h3></header><div class="body"><div class="grid g3">
    <div class="field"><label>${t("period")}</label><input readonly style="cursor:pointer;background:#fff" value="${esc(periodLabel())}" onclick="openPeriod()"></div>
    <div class="field"><label>${t("amount")} (${t("kd")})</label><input id="nbAmount" type="number" step="0.001"></div>
    <div class="field"><label>&nbsp;</label><button class="btn primary" onclick="addBudget()">＋ ${t("addBudget")}</button></div>
  </div></div></div>
  <div class="panel"><header><h3>${t("budgetsTracking")}</h3></header><div class="tbl-wrap">${tblBudgets()}</div></div>
  <div class="panel"><header><h3>${t("chanDist")}</h3></header><div class="body"><div class="grid">
    ${DB.ref.channels.map((c) => `<div class="field"><label>${chan(c)}</label><input class="chIn" data-c="${esc(c)}" type="number" step="0.001" value="${(DB.budget.channels || {})[c] || ""}"></div>`).join("")}
    </div><div class="actions"><button class="btn gold" onclick="saveChannels()">${t("saveDist")}</button></div></div></div>`;
}
function tblBudgets() {
  if (!DB.budgets.length) return `<div class="empty">${t("noBudgets")}</div>`;
  return `<table><thead><tr><th>${t("th_period")}</th><th>${t("th_amount")}</th><th>${t("c_spentAll")}</th><th>${t("c_rem")}</th><th>${t("th_created")}</th><th>${t("th_actions")}</th></tr></thead><tbody>${DB.budgets
    .slice()
    .reverse()
    .map((b) => {
      const s = spentInPeriod(b.from, b.to),
        rem = b.amount - s,
        lab = b.preset
          ? t(b.preset)
          : b.from
            ? b.from === b.to
              ? fmtD(b.from)
              : fmtD(b.from) + " — " + fmtD(b.to)
            : t("noPeriod");
      return `<tr><td>${lab}</td><td class="mono">${KD(b.amount)}</td><td class="mono">${KD(s)}</td><td class="mono" style="color:${rem < 0 ? "var(--danger)" : "var(--ok)"}">${KD(rem)}</td><td>${esc(b.created)}</td><td><button class="btn danger sm" onclick="delBudget('${b.id}')">${t("del")}</button></td></tr>`;
    })
    .join("")}</tbody></table>`;
}
async function addBudget() {
  const amt = +document.getElementById("nbAmount").value || 0;
  if (!draftPeriod || !draftPeriod.from) {
    toast(t("pickPeriod"));
    return;
  }
  if (!amt) {
    toast(t("enterAmount"));
    return;
  }
  try {
    await api("/budgets", {
      method: "POST",
      body: { amount: amt, from: draftPeriod.from, to: draftPeriod.to, preset: draftPeriod.preset || "" },
    });
    draftPeriod = null;
    await loadState();
    toast(t("budgetAdded"));
    render();
  } catch (e) { toast(e.message); }
}
async function delBudget(id) {
  if (!confirm(t("confirmDel"))) return;
  try {
    await api("/budgets/" + id, { method: "DELETE" });
    await loadState();
    render();
  } catch (e) { toast(e.message); }
}

/* ---------- period range picker ---------- */
let pFrom = null,
  pTo = null,
  calY = 0,
  calM = 0,
  pPreset = "",
  draftPeriod = null;
function ymd(d) {
  return (
    d.getFullYear() +
    "-" +
    String(d.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getDate()).padStart(2, "0")
  );
}
function parseD(s) {
  const p = (s || "").split("-");
  return p.length === 3 ? new Date(+p[0], +p[1] - 1, +p[2]) : null;
}
function fmtD(s) {
  const d = parseD(s);
  if (!d) return "";
  return new Intl.DateTimeFormat(LANG === "ar" ? "ar" : "en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(d);
}
function periodLabel() {
  const p = draftPeriod;
  if (!p || !p.from) return "";
  if (p.preset) return t(p.preset);
  return p.from === p.to ? fmtD(p.from) : fmtD(p.from) + " — " + fmtD(p.to);
}
function presetRange(k) {
  const n = new Date();
  n.setHours(0, 0, 0, 0);
  let a = new Date(n),
    b = new Date(n);
  const dow = n.getDay();
  if (k === "p_today") {
  } else if (k === "p_yest") {
    a.setDate(a.getDate() - 1);
    b.setDate(b.getDate() - 1);
  } else if (k === "p_tweek") {
    a.setDate(n.getDate() - dow);
    b.setDate(a.getDate() + 6);
  } else if (k === "p_lweek") {
    a.setDate(n.getDate() - dow - 7);
    b.setDate(a.getDate() + 6);
  } else if (k === "p_tmonth") {
    a = new Date(n.getFullYear(), n.getMonth(), 1);
    b = new Date(n.getFullYear(), n.getMonth() + 1, 0);
  } else if (k === "p_lmonth") {
    a = new Date(n.getFullYear(), n.getMonth() - 1, 1);
    b = new Date(n.getFullYear(), n.getMonth(), 0);
  } else if (k === "p_tquarter") {
    const q = Math.floor(n.getMonth() / 3);
    a = new Date(n.getFullYear(), q * 3, 1);
    b = new Date(n.getFullYear(), q * 3 + 3, 0);
  } else if (k === "p_tyear") {
    a = new Date(n.getFullYear(), 0, 1);
    b = new Date(n.getFullYear(), 11, 31);
  }
  return [ymd(a), ymd(b)];
}
function openPeriod() {
  const p = draftPeriod;
  if (p && p.from) {
    pFrom = p.from;
    pTo = p.to;
    pPreset = p.preset || "";
  } else {
    pFrom = pTo = null;
    pPreset = "";
  }
  const d0 = parseD(pFrom) || new Date();
  calY = d0.getFullYear();
  calM = d0.getMonth();
  renderPicker();
}
function setPreset(k) {
  pPreset = k;
  const [a, b] = presetRange(k);
  pFrom = a;
  pTo = b;
  const d = parseD(a);
  calY = d.getFullYear();
  calM = d.getMonth();
  renderPicker();
}
function pickDay(s) {
  pPreset = "";
  if (!pFrom || pTo) {
    pFrom = s;
    pTo = null;
  } else {
    if (s < pFrom) {
      pTo = pFrom;
      pFrom = s;
    } else pTo = s;
  }
  renderPicker();
}
function navM(step) {
  calM += step;
  if (calM < 0) {
    calM = 11;
    calY--;
  }
  if (calM > 11) {
    calM = 0;
    calY++;
  }
  renderPicker();
}
function renderPicker() {
  const presets = [
    "p_today",
    "p_yest",
    "p_tweek",
    "p_lweek",
    "p_tmonth",
    "p_lmonth",
    "p_tquarter",
    "p_tyear",
  ];
  const monthName = new Intl.DateTimeFormat(LANG === "ar" ? "ar" : "en", {
    month: "long",
    year: "numeric",
  }).format(new Date(calY, calM, 1));
  const wd =
    LANG === "ar"
      ? ["أحد", "إث", "ثل", "أر", "خم", "جم", "سب"]
      : ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  const first = new Date(calY, calM, 1).getDay();
  const dim = new Date(calY, calM + 1, 0).getDate();
  const prevDim = new Date(calY, calM, 0).getDate();
  let cells = [];
  for (let i = 0; i < first; i++)
    cells.push({ d: prevDim - first + 1 + i, mut: 1 });
  for (let d = 1; d <= dim; d++) cells.push({ d, mut: 0 });
  while (cells.length % 7) cells.push({ d: cells.length, mut: 1, tail: 1 });
  const grid = cells
    .map((c) => {
      if (c.mut) return `<div class="rp-day mut">${c.d}</div>`;
      const s = ymd(new Date(calY, calM, c.d));
      let cls = "rp-day";
      if (pFrom && pTo && s >= pFrom && s <= pTo) cls += " in";
      if (s === pFrom || s === pTo) cls += " edge";
      return `<div class="${cls}" onclick="pickDay('${s}')">${c.d}</div>`;
    })
    .join("");
  const sel = pFrom
    ? pTo && pTo !== pFrom
      ? fmtD(pFrom) + " — " + fmtD(pTo)
      : fmtD(pFrom)
    : t("noPeriod");
  modal(`<div class="doc-tools"><b style="color:var(--ink)">${t("selPeriod")}</b><button class="btn ghost sm" onclick="closeModal()">✕ ${t("close")}</button></div>
  <div class="rp">
    <div class="rp-presets">${presets.map((k) => `<button class="rp-preset ${pPreset === k ? "on" : ""}" onclick="setPreset('${k}')">${t(k)}</button>`).join("")}</div>
    <div class="rp-cal"><div class="rp-head"><button class="rp-nav" onclick="navM(-1)">‹</button><b>${monthName}</b><button class="rp-nav" onclick="navM(1)">›</button></div>
      <div class="rp-grid">${wd.map((w) => `<div class="rp-wd">${w}</div>`).join("")}${grid}</div></div>
  </div>
  <div class="rp-foot"><span class="rp-sel">${sel}</span><div class="actions" style="margin:0"><button class="btn ghost sm" onclick="clearPeriod()">${t("clr")}</button><button class="btn primary sm" onclick="applyPeriod()">${t("apply")}</button></div></div>`);
}
function applyPeriod() {
  if (!pFrom) {
    closeModal();
    return;
  }
  draftPeriod = { from: pFrom, to: pTo || pFrom, preset: pPreset || "" };
  closeModal();
  render();
}
function clearPeriod() {
  draftPeriod = null;
  pFrom = pTo = null;
  pPreset = "";
  closeModal();
  render();
}

async function saveChannels() {
  const channels = {};
  document
    .querySelectorAll(".chIn")
    .forEach((i) => (channels[i.dataset.c] = +i.value || 0));
  const alloc = sum(Object.values(channels));
  const total = budgetTotal();
  if (total && alloc > total + 0.0005) {
    if (!confirm(t("overBudgetWarn"))) return;
  }
  try {
    await api("/channels", { method: "PUT", body: { channels } });
    await loadState();
    toast(t("saved"));
    render();
  } catch (e) { toast(e.message); }
}
/* ---------- division ---------- */
function distPool() {
  return coopChannelBudget();
}
function totalWob() {
  return sum(DB.dist.map((r) => +r.wob || 0));
}
function manualSum() {
  return sum(DB.dist.filter((r) => r.manual).map((r) => +r.amt || 0));
}
function wobRest() {
  return sum(DB.dist.filter((r) => !r.manual).map((r) => +r.wob || 0));
}
function rowAmt(r) {
  if (r.manual) return +r.amt || 0;
  const rest = Math.max(0, distPool() - manualSum()),
    wr = wobRest();
  return wr > 0 ? (rest * (+r.wob || 0)) / wr : 0;
}
function setAmt(i, v) {
  DB.dist[i].amt = +v || 0;
  DB.dist[i].manual = true;
  refreshDistAmts();
}
function clearAmt(i) {
  DB.dist[i].manual = false;
  delete DB.dist[i].amt;
  renderDistRows();
}
let distOutlets = [];
async function vDivision() {
  const pool = distPool(),
    tw = totalWob(),
    alloc = sum(DB.dist.map(rowAmt));
  document.getElementById("rv").innerHTML =
    `<div class="cards">${card("accent", t("c_coopBudget"), KD(pool), 1)}${card("", t("totalWob"), tw.toLocaleString("en-US"), 0)}${card("warn", t("c_distSup"), KD(alloc), 1)}</div>
  ${mgrApprovalsPanel()}
  <div class="panel"><header><h3>${t("distTable")}</h3><div style="display:flex;gap:8px;align-items:center"><span class="pill-info">${t("outletLinkHint")}</span><button class="btn gold sm" onclick="addDist()">＋ ${t("add")}</button></div></header>
   <datalist id="outletDL"></datalist>
   <div class="tbl-wrap"><table><thead><tr><th>${t("supervisor")}</th><th>${t("salesman")}</th><th>${t("mainCoop")}</th><th>${t("outlet")}</th><th>${t("wob")}</th><th>${t("amount")} (${t("kd")})</th><th></th></tr></thead><tbody id="distRows"></tbody></table></div>
   <div class="actions" style="padding:0 16px 16px"><button class="btn primary" onclick="saveDist()">${t("save")}</button></div></div>`;
  renderDistRows();
  // Load real outlets (once) to power the outlet picker + WOB auto-fill.
  if (!distOutlets.length) {
    try { distOutlets = (await api("/outlets")).outlets; } catch (e) {}
  }
  const dl = document.getElementById("outletDL");
  if (dl) dl.innerHTML = distOutlets.map((o) => `<option value="${esc(o.name)}">`).join("");
}
// Fill a distribution row from a chosen real outlet (keeps sup/salesman as-is).
function pickDistOutlet(i, val) {
  DB.dist[i].outlet = val;
  const o = distOutlets.find((x) => x.name === val);
  if (o) {
    if (!DB.dist[i].coop) {
      const short = String(o.parent || "").replace(/^P\d+-/, "").replace(/ PARENT$/i, "");
      const hit = DB.ref.coops.find((c) => c.n.toUpperCase() === short.toUpperCase());
      if (hit) DB.dist[i].coop = hit.n;
    }
    if (!(+DB.dist[i].wob) && o.lays_sales != null) DB.dist[i].wob = Math.round(+o.lays_sales);
  }
  renderDistRows();
  refreshDistAmts();
}
// Order rows so each supervisor → salesman → main coop → outlet group is contiguous.
// Empty values sort last so newly added blank rows stay at the bottom.
function sortDist() {
  const key = (v) => String(v || "");
  const cmp = (a, b) => {
    for (const f of ["sup", "sales", "coop", "outlet"]) {
      const av = key(a[f]), bv = key(b[f]);
      if (!av && bv) return 1;
      if (av && !bv) return -1;
      const c = av.localeCompare(bv, undefined, { sensitivity: "base" });
      if (c) return c;
    }
    return 0;
  };
  DB.dist.sort(cmp);
}
function renderDistRows() {
  const box = document.getElementById("distRows");
  if (!DB.dist.length)
    DB.dist = [{ sup: "", sales: "", coop: "", outlet: "", wob: "" }];
  sortDist();
  box.innerHTML = DB.dist
    .map(
      (r, i) => {
        const newSup = i === 0 || DB.dist[i - 1].sup !== r.sup;
        const repSales = !newSup && DB.dist[i - 1].sales === r.sales;
        return `<tr class="${newSup ? "grp" : ""}">
   <td class="${newSup ? "" : "rep"}"><select onchange="DB.dist[${i}].sup=this.value"><option value="">${t("choose")}</option>${DB.ref.supervisors.map((s) => `<option ${r.sup === s ? "selected" : ""}>${esc(s)}</option>`).join("")}</select></td>
   <td class="${repSales ? "rep" : ""}"><input value="${esc(r.sales)}" oninput="DB.dist[${i}].sales=this.value" style="min-width:110px"></td>
   <td><select onchange="DB.dist[${i}].coop=this.value"><option value="">${t("choose")}</option>${DB.ref.coops.map((c) => `<option ${r.coop === c.n ? "selected" : ""}>${esc(c.n)}</option>`).join("")}</select></td>
   <td><input value="${esc(r.outlet)}" list="outletDL" onchange="pickDistOutlet(${i},this.value)" oninput="DB.dist[${i}].outlet=this.value" style="min-width:120px"></td>
   <td><input type="number" step="0.01" value="${r.wob}" oninput="DB.dist[${i}].wob=+this.value||0;refreshDistAmts()" style="max-width:85px"></td>
   <td><div style="display:flex;gap:4px;align-items:center"><input type="number" step="0.001" class="amtIn" value="${Number(rowAmt(r)).toFixed(3)}" oninput="setAmt(${i},this.value)" style="max-width:96px;${r.manual ? "border-color:#1c4e8a;font-weight:700;color:#123f70" : ""}"><button class="rm" style="width:26px;height:26px;font-size:12px;flex:none" title="WOB" onclick="clearAmt(${i})">↺</button></div></td>
   <td><button class="rm" onclick="DB.dist.splice(${i},1);renderDistRows()">✕</button></td></tr>`;
      },
    )
    .join("");
}
function refreshDistAmts() {
  document.querySelectorAll("#distRows tr").forEach((tr, i) => {
    const r = DB.dist[i];
    if (!r) return;
    const inp = tr.querySelector(".amtIn");
    if (inp && !r.manual) inp.value = Number(rowAmt(r)).toFixed(3);
  });
}
function addDist() {
  DB.dist.push({ sup: "", sales: "", coop: "", outlet: "", wob: "" });
  renderDistRows();
}
async function saveDist() {
  const rows = DB.dist
    .filter((r) => r.sup || r.sales || r.coop)
    .map((r) => ({
      sup: r.sup || "",
      sales: r.sales || "",
      coop: r.coop || "",
      outlet: r.outlet || "",
      wob: +r.wob || 0,
      amt: r.manual ? +r.amt || 0 : null,
      manual: !!r.manual,
    }));
  try {
    await api("/dist", { method: "PUT", body: { rows } });
    await loadState();
    toast(t("saved"));
    render();
  } catch (e) { toast(e.message); }
}
/* ---------- supervisor ---------- */
function vSupervisor() {
  const me = scopeName();
  const myRows = me ? DB.dist.filter((r) => r.sup === me) : DB.dist;
  const recv = sum(myRows.map(rowAmt));
  document.getElementById("rv").innerHTML =
    `<div class="cards">${card("accent", t("c_recv"), KD(recv), 1)}${card("", t("c_rowsN"), myRows.length, 0)}</div>
  ${supApprovalsPanel(me)}
  <div class="panel"><header><h3>${t("myAssignments")}</h3></header><div class="tbl-wrap"><table><thead><tr><th>${t("salesman")}</th><th>${t("mainCoop")}</th><th>${t("outlet")}</th><th>${t("wob")}</th><th>${t("amount")} (${t("kd")})</th></tr></thead><tbody>${myRows.length ? myRows.map((r) => `<tr><td>${esc(r.sales)}</td><td>${esc(r.coop)}</td><td>${esc(r.outlet)}</td><td class="mono">${+r.wob || 0}</td><td class="mono">${KD(rowAmt(r))}</td></tr>`).join("") : `<tr><td colspan="5"><div class="empty">${t("noAssign")}</div></td></tr>`}</tbody></table></div></div>
  <div class="panel"><header><h3>${t("coopsRef")}</h3><span class="pill-info">${DB.ref.coops.length} ${t("coopsN")}</span></header><div class="tbl-wrap" style="max-height:300px"><table><thead><tr><th>${t("coop")}</th><th>${t("mainOut")}</th><th>${t("branches")}</th></tr></thead><tbody>${DB.ref.coops.map((c) => `<tr><td>${esc(c.n)}</td><td class="mono">${c.m}</td><td>${c.b}</td></tr>`).join("")}</tbody></table></div></div>`;
}
/* ---------- salesman ---------- */
let draftItems = [{ name: "", price: "" }];
let draftPrice = [];
function vSalesman() {
  const me = scopeName();
  const myLetters = me ? DB.letters.filter((l) => l.sales === me) : DB.letters;
  document.getElementById("rv").innerHTML = `
  <div class="panel"><header><h3>${t("letters")} (${myLetters.length})</h3><button class="btn gold sm" onclick="openLetterForm()">＋ ${t("newLetter")}</button></header><div class="tbl-wrap">${tblSalesLetters(myLetters.slice().reverse())}</div></div>`;
}
function tblSalesLetters(list) {
  if (!list.length) return `<div class="empty">${t("noLetters")}</div>`;
  return `<table><thead><tr><th>${t("letterNo")}</th><th>${t("th_type")}</th><th>${t("coop")}</th><th>${t("th_brand")}</th><th>${t("th_value")}</th><th>${t("th_date")}</th><th>${t("th_status")}</th><th>${t("th_actions")}</th></tr></thead><tbody>${list
    .map((L) => {
      const isPrice = L.type === "changeprice" || !!specOf(L.type);
      const done = L.status === "noted";
      const n = DB.notes.find((x) => x.letterId === L.id);
      const na = (n && n.attachments && n.attachments.length) || 0;
      const statusCell = isPrice
        ? `<span class="tag done">${t("st_letterOnly")}</span>`
        : `${n ? noteStatusTag(n) : `<span class="tag draft">${t("st_pending")}</span>`}${na ? ` <span class="pill-info" style="padding:1px 7px">📎 ${na}</span>` : ""}`;
      const dnBtn = isPrice
        ? ""
        : done
          ? `<button class="btn primary sm" onclick="openDocById('${n.id}')">${t("viewDN")}</button>`
          : `<button class="btn gold sm" onclick="openDNForm('${L.id}')">${t("enterDN")}</button>`;
      return `<tr><td class="mono">${esc(L.lysal || "")}</td><td>${esc(ltName(L.type))}</td><td>${esc(L.coop)}</td><td>${esc(L.brand || "")}</td><td class="mono">${isPrice ? "—" : KD(L.value)}</td><td>${esc(L.date || "")}</td><td>${statusCell}</td><td><div class="actions"><button class="btn ghost sm" onclick="printLetter('${L.id}')">${t("printLetter")}</button>${dnBtn}<button class="btn danger sm" onclick="delLetter('${L.id}')">${t("del")}</button></div></td></tr>`;
    })
    .join("")}</tbody></table>`;
}
let dnAttach = [];
function openDNForm(id) {
  const L = DB.letters.find((x) => x.id === id);
  dnAttach = [];
  modal(`<div class="doc-tools"><b style="color:var(--ink)">${t("enterDN")} — ${esc(L.coop)}</b><button class="btn ghost sm" onclick="closeModal()">✕ ${t("close")}</button></div>
  <div style="padding:22px 24px;max-height:74vh;overflow:auto">
   <div class="grid g3">
     <div class="field"><label>${t("coopDN")}</label><input id="dnNo" placeholder="مثال: 111"></div>
     <div class="field"><label>${t("th_value")} (${t("kd")})</label><input id="dnVal" type="number" step="0.001" value="${L.value}"></div>
     <div class="field"><label>${t("fDate")}</label><input id="dnDate" type="date" value="${L.date || new Date().toISOString().slice(0, 10)}"></div>
   </div>
   <div class="field" style="margin-top:14px"><label>${t("attachments")}</label><input type="file" multiple accept="image/*,.pdf" onchange="onAttach(this)"></div>
   <div id="attList" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px"></div>
   <div class="actions" style="margin-top:16px"><button class="btn primary" onclick="saveDN('${id}')">${t("saveDN")}</button><button class="btn ghost" onclick="closeModal()">${t("cancel")}</button></div>
  </div>`);
  renderAttList();
}
function onAttach(input) {
  [...input.files].forEach((f) => {
    const rd = new FileReader();
    rd.onload = () => {
      dnAttach.push({ name: f.name, url: rd.result });
      renderAttList();
    };
    rd.readAsDataURL(f);
  });
  input.value = "";
}
function renderAttList() {
  const b = document.getElementById("attList");
  if (!b) return;
  b.innerHTML = dnAttach
    .map(
      (a, i) =>
        `<div class="att-item">${a.url.startsWith("data:image") ? `<img src="${a.url}">` : `<div style="padding:14px 6px;font-size:22px">📄</div>`}<div>${esc(a.name)}</div><button class="btn danger sm" style="margin-top:4px;padding:2px 8px" onclick="dnAttach.splice(${i},1);renderAttList()">✕</button></div>`,
    )
    .join("");
}
async function saveDN(letterId) {
  const coopDN = (document.getElementById("dnNo").value || "").trim();
  const val = +document.getElementById("dnVal").value || undefined;
  const date = document.getElementById("dnDate").value;
  try {
    await api("/notes", {
      method: "POST",
      body: { letterId, coopDN, value: val, date, attachments: dnAttach.slice() },
    });
    dnAttach = [];
    await loadState();
    closeModal();
    toast(t("dnSaved"));
    render();
  } catch (e) { toast(e.message); }
}
function tblLetters(list) {
  if (!list.length) return `<div class="empty">${t("noLetters")}</div>`;
  return `<table><thead><tr><th>${t("th_type")}</th><th>${t("coop")}</th><th>${t("th_brand")}</th><th>${t("th_value")}</th><th>${t("th_date")}</th><th>${t("th_status")}</th><th>${t("th_actions")}</th></tr></thead><tbody>${list
    .map((L) => {
      const done = L.status === "noted";
      return `<tr><td>${esc(ltName(L.type))}</td><td>${esc(L.coop)}</td><td>${esc(L.brand || "")}</td><td class="mono">${KD(L.value)}</td><td>${esc(L.date || "")}</td><td><span class="tag ${done ? "done" : "draft"}">${done ? t("st_done") : t("st_pending")}</span></td><td><button class="btn ghost sm" onclick="printLetter('${L.id}')">${t("printLetter")}</button></td></tr>`;
    })
    .join("")}</tbody></table>`;
}
function specOf(k) {
  return ((DB.ref && DB.ref.letterSpecs) || []).find((s) => s.k === k);
}
/* ---------- product catalog (barcodes) for table pickers ---------- */
let productCache = [], prodByBC = {}, prodByName = {};
async function ensureProducts() {
  if (productCache.length) { buildProdDatalists(); return; }
  try {
    const r = await api("/products");
    productCache = r.products || [];
    prodByBC = {}; prodByName = {};
    productCache.forEach((p) => { prodByBC[String(p.barcode)] = p; prodByName[(p.name || "").trim()] = p; });
  } catch (e) {}
  buildProdDatalists();
}
function buildProdDatalists() {
  let host = document.getElementById("prodDLs");
  if (!host) { host = document.createElement("div"); host.id = "prodDLs"; host.hidden = true; document.body.appendChild(host); }
  const bc = productCache.map((p) => `<option value="${esc(p.barcode)}">${esc(p.name)}</option>`).join("");
  const nm = productCache.map((p) => `<option value="${esc(p.name)}"></option>`).join("");
  host.innerHTML = `<datalist id="prodBC">${bc}</datalist><datalist id="prodNM">${nm}</datalist>`;
}
// Fill a row object's known columns from a matched product.
function fillRowFromProduct(row, cols, p) {
  const keys = new Set(cols.map((c) => c.key));
  const set = (k, v) => { if (keys.has(k) && v != null && v !== "") row[k] = v; };
  set("barcode", p.barcode); set("name", p.name); set("pack", p.pack);
  set("origin", p.origin); set("item", p.item);
  set("consPiece", p.consPiece); set("coopCarton", p.coopCarton);
  set("consOld", p.consPiece); set("coopOld", p.coopCarton);   // "current" columns (change-price / union)
  set("curCons", p.consPiece); set("curSell", p.coopCarton);
}
function lookupProduct(field, val) {
  if (field === "barcode") return prodByBC[String(val).replace(/\D/g, "")];
  return prodByName[String(val).trim()];
}
function specPick(which, i, field, val) {
  const arr = specRowsArr(which);
  arr[i][field] = val;
  const p = lookupProduct(field, val);
  if (p) fillRowFromProduct(arr[i], (which === 2 ? curSpec().table2 : curSpec().table).cols, p);
  renderSpecRows(which);
}
function pricePick(i, field, val) {
  draftPrice[i][field] = val;
  const p = lookupProduct(field, val);
  if (p) {
    const cols = [{ key: "barcode" }, { key: "name" }, { key: "consOld" }, { key: "coopOld" }];
    fillRowFromProduct(draftPrice[i], cols, p);
  }
  renderPriceRows();
}
function typeLabel(x) {
  return LANG === "en" ? x.en : x.ar;
}
function colLabel(c) {
  return LANG === "en" ? c.en : c.ar;
}
function openLetterForm() {
  draftItems = [{ name: "", price: "" }];
  draftPrice = [emptyPriceRow()];
  draftSpecRows = [];
  draftSpecRows2 = [];
  const coopOpts = DB.ref.coops
    .map((c) => `<option value="${esc(c.n)}">${esc(c.n)} — ${c.m} ${t("mainOut")}</option>`)
    .join("");
  const topts = DB.ref.letterTypes
    .map((x) => `<option value="${x.k}">${esc(typeLabel(x))}</option>`)
    .join("");
  const today = new Date().toISOString().slice(0, 10);
  modal(`<div class="doc-tools"><b style="color:var(--ink)">${t("newLetter")}</b><button class="btn ghost sm" onclick="closeModal()">✕ ${t("close")}</button></div>
  <div style="padding:22px 24px;max-height:74vh;overflow:auto">
   <div class="grid g3">
     <div class="field"><label>${t("fType")}</label><select id="fType" onchange="typeChanged()">${topts}</select></div>
     <div class="field"><label>${t("fDate")}</label><input id="fDate" type="date" value="${today}"></div>
   </div>
   <div id="classicFields" class="grid g3" style="margin-top:12px">
     <div class="field"><label>${t("coop")}</label><select id="fCoop" onchange="calcVal()">${coopOpts}</select></div>
     <div class="field"><label>${t("fBrand")}</label><select id="fBrand">${DB.ref.brands.map((b) => `<option>${esc(b)}</option>`).join("")}</select></div>
     <div class="field"><label>${t("salesman")}</label><input id="fSales" value="${esc(scopeName() || "")}" ${scopeName() ? "readonly" : ""}></div>
     <div class="field"><label>${t("fPrin")}</label><select id="fPrin">${DB.ref.principals.map((p) => `<option>${p}</option>`).join("")}</select></div>
   </div>
   <div id="typeArea" style="margin-top:16px"></div>
   <div class="field" style="margin-top:14px"><label>${t("fNote")}</label><textarea id="fNote"></textarea></div>
   <div class="actions" style="margin-top:16px"><button class="btn primary" onclick="saveLetter()">${t("saveLetter")}</button><button class="btn ghost" onclick="closeModal()">${t("cancel")}</button></div></div>`);
  typeChanged();
  ensureProducts();
}
/* ---- spec-driven letter form ---- */
let draftSpecRows = [], draftSpecRows2 = [];
function specRowsArr(which) { return which === 2 ? draftSpecRows2 : draftSpecRows; }
function curSpec() { return specOf(document.getElementById("fType").value); }
function emptySpecRow(cols) { const o = {}; cols.forEach((c) => (o[c.key] = "")); return o; }
function specTableEditor(tbl, which) {
  return `<div style="margin-top:14px"><label class="hint" style="font-weight:700">${esc(LANG === "en" ? tbl.title.en : tbl.title.ar)}</label>
    <div class="tbl-scroll"><table class="price-edit"><thead><tr>${tbl.cols.map((c) => `<th>${esc(colLabel(c))}</th>`).join("")}<th></th></tr></thead><tbody id="specRows${which}"></tbody></table></div>
    <button class="btn ghost sm" style="margin-top:8px" onclick="addSpecRow(${which})">＋ ${t("addRow")}</button></div>`;
}
function specFormHTML(spec) {
  let h = "";
  if (spec.recipient === "coop")
    h += `<div class="field" style="max-width:360px"><label>${t("coop")}</label><select id="spCoop">${DB.ref.coops.map((c) => `<option value="${esc(c.n)}">${esc(c.n)}</option>`).join("")}</select></div>`;
  else if (spec.recipient === "fixed")
    h += `<div class="field" style="max-width:360px"><label>${t("recipient")}</label><input value="${esc(spec.recipientFixed)}" readonly></div>`;
  else
    h += `<div class="field" style="max-width:420px"><label>${t("recipient")}</label><input id="spRecipient" value="${esc(spec.recipientDefault || "")}"></div>`;
  if (spec.fields && spec.fields.length)
    h += `<div class="grid g3" style="margin-top:10px">${spec.fields.map((f) => `<div class="field"><label>${esc(LANG === "en" ? f.en : f.ar)}</label><input id="spf_${f.key}" type="${f.type === "number" ? "number" : f.type === "date" ? "date" : "text"}" ${f.type === "number" ? 'step="0.001"' : ""}></div>`).join("")}</div>`;
  if (spec.table) h += specTableEditor(spec.table, 1);
  if (spec.table2) h += specTableEditor(spec.table2, 2);
  return h;
}
function renderSpecRows(which) {
  const s = curSpec();
  if (!s) return;
  const tbl = which === 2 ? s.table2 : s.table;
  const arr = specRowsArr(which);
  if (!arr.length) arr.push(emptySpecRow(tbl.cols));
  const box = document.getElementById("specRows" + which);
  if (!box) return;
  box.innerHTML = arr
    .map((r, i) => `<tr>${tbl.cols.map((c) => {
      const pick = c.key === "barcode" || c.key === "name";
      const attrs = pick
        ? `list="${c.key === "barcode" ? "prodBC" : "prodNM"}" onchange="specPick(${which},${i},'${c.key}',this.value)" oninput="specRowsArr(${which})[${i}].${c.key}=this.value"`
        : `${c.type === "num" ? 'type="number" step="0.001"' : ""} oninput="specRowsArr(${which})[${i}].${c.key}=this.value"`;
      return `<td><input value="${esc(r[c.key])}" ${attrs} style="${c.wide ? "min-width:150px" : "width:90px"}"></td>`;
    }).join("")}<td><button class="rm" onclick="specRowsArr(${which}).splice(${i},1);renderSpecRows(${which})">✕</button></td></tr>`)
    .join("");
}
function addSpecRow(which) {
  const s = curSpec();
  const tbl = which === 2 ? s.table2 : s.table;
  specRowsArr(which).push(emptySpecRow(tbl.cols));
  renderSpecRows(which);
}
function typeChanged() {
  const k = document.getElementById("fType").value;
  const a = document.getElementById("typeArea");
  const classic = document.getElementById("classicFields");
  const spec = specOf(k);
  if (spec) {
    if (classic) classic.hidden = true;
    a.innerHTML = specFormHTML(spec);
    if (spec.table) renderSpecRows(1);
    if (spec.table2) renderSpecRows(2);
    return;
  }
  if (classic) classic.hidden = false;
  const mode = (DB.ref.letterTypes.find((x) => x.k === k) || {}).mode;
  if (mode === "pricetable") {
    a.innerHTML = `<label class="hint" style="font-weight:700">${t("priceRows")}</label>
      <div class="tbl-scroll"><table class="price-edit"><thead><tr>
        <th>${t("th_item")}</th><th>${t("th_name")}</th><th>${t("th_pack")}</th>
        <th>${t("coopOld")}</th><th>${t("coopNew")}</th><th>${t("consOld")}</th><th>${t("consNew")}</th><th>${t("th_barcode")}</th><th></th>
      </tr></thead><tbody id="priceRows"></tbody></table></div>
      <button class="btn ghost sm" style="margin-top:8px" onclick="addPriceRow()">＋ ${t("addRow")}</button>`;
    renderPriceRows();
  } else if (mode === "items")
    ((a.innerHTML = `<label class="hint" style="font-weight:700">${t("items")}</label><div id="itemRows" style="margin-top:8px"></div><button class="btn ghost sm" onclick="addItem()">＋ ${t("addItem")}</button><div class="total-line"><span>${t("valFormula")} (<b id="outCount">0</b>)</span><b><span id="calcVal">0.000</span> ${t("kd")}</b></div>`),
      renderItems());
  else if (mode === "pct")
    a.innerHTML = `<div class="grid g3"><div class="field"><label>${t("base")}</label><input id="fBase" type="number" step="0.001" oninput="calcVal()"></div><div class="field"><label>${t("pct")}</label><input id="fPct" type="number" step="0.01" oninput="calcVal()"></div><div class="field"><label>${t("valOut")}</label><input id="fValOut" readonly></div></div>`;
  else
    a.innerHTML = `<div class="field" style="max-width:280px"><label>${t("valDirect")}</label><input id="fValDirect" type="number" step="0.001" oninput="calcVal()"></div>`;
  calcVal();
}
function renderItems() {
  const box = document.getElementById("itemRows");
  if (!box) return;
  box.innerHTML = draftItems
    .map(
      (it, i) =>
        `<div class="row-items"><div class="field"><label>${t("itemName")}</label><input value="${esc(it.name)}" oninput="draftItems[${i}].name=this.value"></div><div class="field" style="max-width:140px"><label>${t("price")}</label><input type="number" step="0.001" value="${it.price}" oninput="draftItems[${i}].price=this.value;calcVal()"></div><button class="rm" onclick="draftItems.splice(${i},1);renderItems();calcVal()">✕</button></div>`,
    )
    .join("");
}
function addItem() {
  draftItems.push({ name: "", price: "" });
  renderItems();
}
/* price-update table editor */
function emptyPriceRow() {
  return { item: "", name: "", pack: "", coopOld: "", coopNew: "", consOld: "", consNew: "", barcode: "" };
}
function renderPriceRows() {
  const box = document.getElementById("priceRows");
  if (!box) return;
  if (!draftPrice.length) draftPrice = [emptyPriceRow()];
  const inp = (i, f, extra) =>
    `<input value="${esc(draftPrice[i][f])}" oninput="draftPrice[${i}].${f}=this.value" ${extra || ""}>`;
  box.innerHTML = draftPrice
    .map(
      (r, i) => `<tr>
      <td>${inp(i, "item", 'style="width:70px"')}</td>
      <td><input value="${esc(r.name)}" list="prodNM" onchange="pricePick(${i},'name',this.value)" oninput="draftPrice[${i}].name=this.value" style="min-width:150px"></td>
      <td>${inp(i, "pack", 'style="width:90px"')}</td>
      <td>${inp(i, "coopOld", 'type="number" step="0.001" style="width:70px"')}</td>
      <td>${inp(i, "coopNew", 'type="number" step="0.001" style="width:70px"')}</td>
      <td>${inp(i, "consOld", 'type="number" step="0.001" style="width:70px"')}</td>
      <td>${inp(i, "consNew", 'type="number" step="0.001" style="width:70px"')}</td>
      <td><input value="${esc(r.barcode)}" list="prodBC" onchange="pricePick(${i},'barcode',this.value)" oninput="draftPrice[${i}].barcode=this.value" style="width:120px;direction:ltr"></td>
      <td><button class="rm" onclick="draftPrice.splice(${i},1);renderPriceRows()">✕</button></td></tr>`,
    )
    .join("");
}
function addPriceRow() {
  draftPrice.push(emptyPriceRow());
  renderPriceRows();
}
function calcVal() {
  const k = document.getElementById("fType").value,
    mode = SEED.letterTypes.find((x) => x.k === k).mode;
  if (mode === "items") {
    const c = coop(document.getElementById("fCoop").value),
      out = c ? c.m : 0,
      s = draftItems.reduce((a, it) => a + (+it.price || 0), 0),
      val = s * out;
    const oc = document.getElementById("outCount");
    if (oc) oc.textContent = out;
    const cv = document.getElementById("calcVal");
    if (cv) cv.textContent = KD(val);
    return val;
  } else if (mode === "pct") {
    const b = +document.getElementById("fBase").value || 0,
      p = +document.getElementById("fPct").value || 0,
      val = (b * p) / 100;
    const o = document.getElementById("fValOut");
    if (o) o.value = KD(val);
    return val;
  } else return +(document.getElementById("fValDirect") || {}).value || 0;
}
async function saveSpecLetter(spec) {
  const g = (id) => document.getElementById(id);
  const body = { type: spec.k, date: g("fDate").value, note: g("fNote").value };
  if (spec.recipient === "coop") body.coop = g("spCoop").value;
  else if (spec.recipient === "free") body.recipient = g("spRecipient").value;
  if (spec.fields) {
    body.fields = {};
    spec.fields.forEach((f) => { const el = g("spf_" + f.key); body.fields[f.key] = el ? el.value : ""; });
  }
  const nonEmpty = (rows, cols) => rows.filter((r) => cols.some((c) => String(r[c.key] || "").trim() !== ""));
  if (spec.table) body.rows = nonEmpty(draftSpecRows, spec.table.cols);
  if (spec.table2) body.rows2 = nonEmpty(draftSpecRows2, spec.table2.cols);
  if (spec.table && (!body.rows || !body.rows.length)) { toast(t("addRowFirst")); return; }
  try {
    const r = await api("/letters", { method: "POST", body });
    await loadState();
    closeModal();
    toast(t("savedLetter"));
    render();
    const L = DB.letters.find((x) => x.id === r.id);
    if (L) openDoc(L, true);
  } catch (e) { toast(e.message); }
}
async function saveLetter() {
  const type = document.getElementById("fType").value;
  const spec = specOf(type);
  if (spec) return saveSpecLetter(spec);
  const mode = (DB.ref.letterTypes.find((x) => x.k === type) || {}).mode;
  const body = {
    type,
    coop: document.getElementById("fCoop").value,
    brand: document.getElementById("fBrand").value,
    sales: document.getElementById("fSales").value,
    date: document.getElementById("fDate").value,
    principal: document.getElementById("fPrin").value,
    note: document.getElementById("fNote").value,
  };
  if (mode === "items")
    body.items = draftItems
      .filter((it) => it.name || it.price)
      .map((it) => ({ name: it.name, price: +it.price || 0 }));
  if (mode === "pct") {
    body.base = +document.getElementById("fBase").value || 0;
    body.pct = +document.getElementById("fPct").value || 0;
  }
  if (mode === "value") {
    body.value = +(document.getElementById("fValDirect") || {}).value || 0;
  }
  if (mode === "pricetable") {
    body.priceRows = draftPrice
      .filter((r) => r.name || r.item || r.barcode)
      .map((r) => ({
        item: r.item, name: r.name, pack: r.pack,
        coopOld: +r.coopOld || 0, coopNew: +r.coopNew || 0,
        consOld: +r.consOld || 0, consNew: +r.consNew || 0,
        barcode: r.barcode,
      }));
    if (!body.priceRows.length) { toast(t("addRowFirst")); return; }
  } else if (!calcVal()) {
    toast(t("enterVal"));
    return;
  }
  try {
    const r = await api("/letters", { method: "POST", body });
    await loadState();
    closeModal();
    toast(t("savedLetter"));
    render();
    const L = DB.letters.find((x) => x.id === r.id);
    if (L) openDoc(L, true);
  } catch (e) { toast(e.message); }
}
async function delLetter(id) {
  if (!confirm(t("confirmDel"))) return;
  try {
    await api("/letters/" + id, { method: "DELETE" });
    await loadState();
    render();
  } catch (e) { toast(e.message); }
}
/* ---------- doc/tracking ---------- */
function noteStatusTag(n) {
  const s = n.status || "approved";
  const map = {
    pending_sup: ["draft", t("st_waitSup")],
    pending_mgr: ["draft", t("st_waitMgr")],
    approved: ["appr", t("st_approved2")],
    rejected: ["", t("st_rejected")],
  };
  const a = map[s] || ["appr", t("st_approved2")];
  return `<span class="tag ${a[0]}">${a[1]}</span>`;
}
function tblApprovals(list, level) {
  if (!list.length) return `<div class="empty">${t("noPending")}</div>`;
  return `<table><thead><tr><th>${t("letterNo")}</th><th>${t("coopDN")}</th><th>${t("coop")}</th><th>${t("salesman")}</th><th>${t("th_value")}</th><th>${t("th_actions")}</th></tr></thead><tbody>${list.map((n) => `<tr><td class="mono">${esc(n.lysal || "")}</td><td class="mono">${esc(n.coopDN || "")}</td><td>${esc(n.coop)}</td><td>${esc(n.sales || "")}</td><td class="mono">${KD(n.value)}</td><td><div class="actions"><button class="btn ghost sm" onclick="openDocById('${n.id}')">${t("view")}</button><button class="btn gold sm" onclick="${level === "sup" ? "supApprove" : "mgrApprove"}('${n.id}')">${t("approve")}</button><button class="btn danger sm" onclick="rejectNote('${n.id}')">${t("reject")}</button></div></td></tr>`).join("")}</tbody></table>`;
}
function supApprovalsPanel(me) {
  const myS = new Set(
    DB.dist.filter((r) => !me || r.sup === me).map((r) => r.sales),
  );
  const pend = DB.notes.filter(
    (n) => n.status === "pending_sup" && (!me || myS.has(n.sales)),
  );
  return `<div class="panel"><header><h3>${t("pendSupTitle")} (${pend.length})</h3></header><div class="tbl-wrap">${tblApprovals(pend, "sup")}</div></div>`;
}
function mgrApprovalsPanel() {
  const pend = DB.notes.filter((n) => n.status === "pending_mgr");
  return `<div class="panel"><header><h3>${t("pendMgrTitle")} (${pend.length})</h3></header><div class="tbl-wrap">${tblApprovals(pend, "mgr")}</div></div>`;
}
async function supApprove(id) {
  try {
    await api("/notes/" + id + "/approve-sup", { method: "POST" });
    await loadState();
    toast(t("apprd"));
    render();
  } catch (e) { toast(e.message); }
}
async function mgrApprove(id) {
  try {
    await api("/notes/" + id + "/approve-mgr", { method: "POST" });
    await loadState();
    toast(t("apprd"));
    render();
  } catch (e) { toast(e.message); }
}
function rejectNote(id) {
  const n = DB.notes.find((x) => x.id === id);
  modal(`<div class="doc-tools"><b style="color:var(--ink)">${t("reject")} — ${esc(n ? n.lysal : "")}</b><button class="btn ghost sm" onclick="closeModal()">✕ ${t("close")}</button></div>
  <div style="padding:20px 24px">
    <div class="field"><label>${t("rejectReason")}</label><textarea id="rjReason" rows="3" placeholder="${t("rejectReasonPh")}"></textarea></div>
    <div class="login-err" id="rjErr"></div>
    <div class="actions" style="margin-top:14px"><button class="btn danger" onclick="doReject('${id}')">${t("confirmReject")}</button><button class="btn ghost" onclick="closeModal()">${t("cancel")}</button></div>
  </div>`);
}
async function doReject(id) {
  const reason = (document.getElementById("rjReason").value || "").trim();
  if (!reason) { document.getElementById("rjErr").textContent = t("needReason"); return; }
  try {
    await api("/notes/" + id + "/reject", { method: "POST", body: { reason } });
    closeModal();
    await loadState();
    toast(t("rejected"));
    render();
  } catch (e) { document.getElementById("rjErr").textContent = e.message; }
}
function vDoc() {
  const total = budgetTotal(),
    sp = spent(),
    pct = total ? Math.min(100, Math.round((sp / total) * 100)) : 0;
  const byType = {};
  DB.notes.forEach(
    (n) => (byType[n.type] = (byType[n.type] || 0) + (+n.value || 0)),
  );
  const byCoop = {};
  DB.notes.forEach((n) => {
    byCoop[n.coop] = byCoop[n.coop] || { c: 0, v: 0 };
    byCoop[n.coop].c++;
    byCoop[n.coop].v += +n.value || 0;
  });
  document.getElementById("rv").innerHTML =
    `<div class="cards">${card("accent", t("c_total"), KD(total), 1)}${card("warn", t("c_spentAll"), KD(sp), 1, `<div class="bar"><i style="width:${pct}%"></i></div>`)}${card("ok", t("c_rem"), KD(total - sp), 1)}${card("", t("c_notes"), DB.notes.length, 0)}</div>
  <div class="panel"><header><h3>${t("dataExports")}</h3></header><div class="body"><div class="actions">
    <button class="btn ghost" onclick="dl('/export/notes.csv')">⬇ ${t("notesCsv")}</button>
    <button class="btn ghost" onclick="dl('/export/letters.csv')">⬇ ${t("lettersCsv")}</button>
    <button class="btn ghost" onclick="dl('/audit/export.csv')">⬇ ${t("auditCsv")}</button>
  </div></div></div>
  <div class="panel"><header><h3>${t("auditLog")}</h3><button class="btn ghost sm" onclick="openAuditModal()">${t("viewAll")} →</button></header><div class="tbl-wrap" id="docAuditBox"><div class="empty">${t("loading")}</div></div></div>
  <div class="panel"><header><h3>${t("noteReg")} (${DB.notes.length})</h3><span class="pill-info">${t("nextNo")}: ${refNo(DB.counter)}</span></header><div class="tbl-wrap">${tblNotes(DB.notes.slice().reverse())}</div></div>
  <div class="panel"><header><h3>${t("letterReg")} (${DB.letters.length})</h3></header><div class="tbl-wrap">${tblLetters(DB.letters.slice().reverse())}</div></div>
  <div class="panel"><header><h3>${t("spendByType")}</h3></header><div class="tbl-wrap">${
    Object.keys(byType).length
      ? `<table><thead><tr><th>${t("th_type")}</th><th>${t("c_spentAll")}</th></tr></thead><tbody>${Object.entries(
          byType,
        )
          .map(
            ([k, v]) =>
              `<tr><td>${esc(ltName(k))}</td><td class="mono">${KD(v)}</td></tr>`,
          )
          .join("")}</tbody></table>`
      : `<div class="empty">${t("noMove")}</div>`
  }</div></div>
  <div class="panel"><header><h3>${t("spendByCoop")}</h3></header><div class="tbl-wrap">${
    Object.keys(byCoop).length
      ? `<table><thead><tr><th>${t("coop")}</th><th>${t("noteCount")}</th><th>${t("c_spentAll")}</th></tr></thead><tbody>${Object.entries(
          byCoop,
        )
          .sort((a, b) => b[1].v - a[1].v)
          .map(
            ([c, o]) =>
              `<tr><td>${esc(c)}</td><td>${o.c}</td><td class="mono">${KD(o.v)}</td></tr>`,
          )
          .join("")}</tbody></table>`
      : `<div class="empty">${t("noMove")}</div>`
  }</div></div>`;
  loadDocAudit();
}
async function loadDocAudit() {
  const box = document.getElementById("docAuditBox");
  if (!box) return;
  try {
    const r = await api("/audit?limit=25");
    if (!r.rows.length) { box.innerHTML = `<div class="empty">${t("noAudit")}</div>`; return; }
    box.innerHTML = `<table><thead><tr><th>${t("th_time")}</th><th>${t("username")}</th><th>${t("action")}</th><th>${t("th_detail")}</th></tr></thead><tbody>${r.rows
      .map((a) => `<tr><td class="mono-sm">${fmtTs(a.ts)}</td><td>${esc(a.name || a.username || "-")}</td><td class="mono-sm">${esc(a.action)}</td><td>${esc(a.summary || "")}</td></tr>`)
      .join("")}</tbody></table>`;
  } catch (e) {
    box.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}
function openAuditModal() {
  modal(`<div class="doc-tools"><b style="color:var(--ink)">${t("auditLog")}</b><div class="actions"><button class="btn gold sm" onclick="dl('/audit/export.csv')">⬇ ${t("exportCsv")}</button><button class="btn ghost sm" onclick="closeModal()">✕ ${t("close")}</button></div></div><div style="padding:16px 20px;max-height:74vh;overflow:auto" id="auditModalBox"><div class="empty">${t("loading")}</div></div>`);
  api("/audit?limit=1000").then((r) => {
    const box = document.getElementById("auditModalBox");
    if (!box) return;
    box.innerHTML = r.rows.length
      ? `<table><thead><tr><th>${t("th_time")}</th><th>${t("username")}</th><th>${t("th_role")}</th><th>${t("action")}</th><th>${t("th_detail")}</th></tr></thead><tbody>${r.rows.map((a) => `<tr><td class="mono-sm">${fmtTs(a.ts)}</td><td>${esc(a.name || a.username || "-")}</td><td>${a.role ? `<span class="badge role-${esc(a.role)}">${esc(a.role)}</span>` : ""}</td><td class="mono-sm">${esc(a.action)}</td><td>${esc(a.summary || "")}</td></tr>`).join("")}</tbody></table>`
      : `<div class="empty">${t("noAudit")}</div>`;
  }).catch((e) => { const b = document.getElementById("auditModalBox"); if (b) b.innerHTML = `<div class="empty">${esc(e.message)}</div>`; });
}
function tblNotes(list) {
  if (!list.length) return `<div class="empty">${t("noNotes")}</div>`;
  return `<table><thead><tr><th>${t("letterNo")}</th><th>${t("coopDN")}</th><th>${t("coop")}</th><th>${t("th_type")}</th><th>${t("th_value")}</th><th>${t("th_date")}</th><th>${t("th_status")}</th><th>${t("th_actions")}</th></tr></thead><tbody>${list.map((n) => `<tr><td class="mono">${esc(n.lysal || "")}</td><td class="mono">${esc(n.coopDN || "")}</td><td>${esc(n.coop)}</td><td>${esc(ltName(n.type))}</td><td class="mono">${KD(n.value)}</td><td>${esc(n.date)}</td><td>${noteStatusTag(n)}</td><td><button class="btn primary sm" onclick="openDocById('${n.id}')">${t("viewPrint")}</button></td></tr>`).join("")}</tbody></table>`;
}
/* ---------- printable (Arabic official, on company letterhead) ---------- */
// Sales manager who signs the official letters (change here if it differs).
const SIGNATORY = { role: "مدير المبيعات", name: "سائد الرمحي" };
// Print mode: 'preprinted' = leave blank top/bottom margins for pre-printed
// letterhead paper (no logo printed); 'full' = render the full letterhead.
let LH_MODE = "preprinted";
function setLhMode(m, rec, isLetter) {
  LH_MODE = m;
  openDoc(rec, isLetter);
}

function signBlock() {
  return `<div class="sign"><div class="role">${esc(SIGNATORY.role)}</div><div class="who">${esc(SIGNATORY.name)}</div></div>`;
}
function metaBlock(rec, isLetter) {
  return `<div class="meta"><span>التاريخ : <b>${esc(rec.date || "")}</b></span><span class="mono">${esc(rec.lysal || "")}</span></div>${
    !isLetter && rec.coopDN ? `<div class="meta2">رقم الإشعار بالجمعية: <b>${esc(rec.coopDN)}</b></div>` : ""
  }`;
}
function toBlock(rec) {
  return `<div class="to">السـادة / جمعيـة ${esc(rec.coop)} التعاونيـة &nbsp;&nbsp; المحتـرمين</div><div class="greet">تحيـة طيبـة وبعـد،،،</div>`;
}

// Price-update ("change price") letter body.
function priceLetterInner(rec) {
  const rows = Array.isArray(rec.items) ? rec.items : [];
  const table = `<table class="pt"><thead>
    <tr><th rowspan="2">م</th><th rowspan="2">رقم الصنف</th><th rowspan="2">أسم الصنف</th><th rowspan="2">الشـد</th>
        <th colspan="2">سعر البيع للجمعية</th><th colspan="2">سعر البيع للمستهلك</th><th rowspan="2">باركود الحبة</th></tr>
    <tr><th>القديم</th><th>الجديد</th><th>القديم</th><th>الجديد</th></tr></thead>
    <tbody>${rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.item)}</td><td class="nm">${esc(r.name)}</td><td>${esc(r.pack)}</td><td>${KD(r.coopOld)}</td><td>${KD(r.coopNew)}</td><td>${KD(r.consOld)}</td><td>${KD(r.consNew)}</td><td class="bc">${esc(r.barcode)}</td></tr>`).join("")}</tbody></table>`;
  return `${metaBlock(rec, true)}${toBlock(rec)}
  <div class="subj">الموضـوع : تحديـث بيانـات</div>
  <div class="body">بالإشـارة إلى الموضـوع أعـلاه، يرجـى من سيادتكـم التكـرم بالموافقـة على تحديث بيانات الأصنـاف المذكـورة بالجـدول أدنـاه وربطهـا بالفـروع وهي كالتالـي :</div>
  ${table}
  ${rec.note ? `<div class="body">ملاحظات: ${esc(rec.note)}</div>` : ""}
  <div class="body">شاكريـن لكـم حسـن تعاونكـم،،،،</div>
  <div class="body">وتفضلـوا بقبـول فائـق الاحتـرام،،،</div>
  ${signBlock()}`;
}

// Debit-note letter body (Listing/Stand/Pallet/Price Off/CDA).
function debitLetterInner(rec, isLetter) {
  const c = coop(rec.coop),
    out = c ? c.m : 0;
  const items =
    rec.items && rec.items.length
      ? `<table class="items"><thead><tr><th>السعر</th><th>اسم الصنف</th></tr></thead><tbody>${rec.items.map((it) => `<tr><td class="mono">${KD(it.price)}</td><td>${esc(it.name)}</td></tr>`).join("")}<tr><td class="mono"><b>${KD(rec.items.reduce((s, i) => s + i.price, 0))}</b></td><td><b>الإجمالي للأوتليت الواحد</b></td></tr></tbody></table><div class="body">وذلك مقابل اعتماد الأصناف أعلاه في <b>${out}</b> أوتليت (${KD(rec.items.reduce((s, i) => s + i.price, 0))} × ${out} = <span class="val-big">${KD(rec.value)} د.ك</span>).</div>`
      : "";
  const reason =
    rec.type === "listing" ? "مقابل اعتماد الأصناف التالية :"
    : rec.type === "pallet" ? "مقابل طبالي عرض وذلك القيمة."
    : rec.type === "priceoff" ? "مقابل تخفيض سعر (Price Off) وذلك القيمة."
    : rec.type === "stand" ? "مقابل ستاند عرض وذلك القيمة."
    : "مقابل دعم تجاري (CDA) وذلك القيمة.";
  return `${metaBlock(rec, isLetter)}${toBlock(rec)}
  <div class="subj">الموضـوع : عمل إشعار خصم</div>
  <div class="body">بالإشـارة إلى الموضـوع أعـلاه، يرجـى من سيادتكـم التكـرم بالموافقـة على عمل إشعار خصم من حساب الشركة المتحدة المتميزة للتجارة العامة للمواد الغذائية لديكم بقيمة (<span class="val-big">${KD(rec.value)} د.ك</span>) ${reason}</div>
  ${items}${rec.note ? `<div class="body">ملاحظات: ${esc(rec.note)}</div>` : ""}
  <div class="body" style="margin-top:14px">وتفضلـوا بقبـول فائـق الاحتـرام والتقديـر،،،</div>
  ${signBlock()}`;
}

// Substitute {placeholders} in spec subject/intro from the record.
function specSubst(str, rec) {
  const m = rec.meta || {};
  return String(str || "").replace(/\{(\w+)\}/g, (_, k) => {
    if (k === "value") return KD(rec.value);
    if (k === "coop") return rec.coop || "";
    if (k === "recipient") return rec.recipient || "";
    if (k === "date") return rec.date || "";
    if (k === "lysal") return rec.lysal || "";
    return m[k] != null ? m[k] : "";
  });
}
function specTablePrint(tbl, rows) {
  if (!rows || !rows.length) return "";
  const head = tbl.cols.map((c) => `<th>${esc(colLabel(c))}</th>`).join("");
  const body = rows.map((r) => `<tr>${tbl.cols.map((c) => `<td class="${c.wide ? "nm" : ""}">${c.type === "num" ? KD(r[c.key]) : esc(r[c.key])}</td>`).join("")}</tr>`).join("");
  return `<table class="pt"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}
function specDocHTML(rec, spec) {
  const en = spec.lang === "en";
  const lg = en ? "en" : "ar";
  const subject = specSubst(spec.subject[lg], rec);
  const intro = specSubst(spec.intro[lg], rec);
  const who = spec.recipient === "coop" ? rec.coop : (rec.recipient || spec.recipientFixed || "");
  const to = en
    ? `<div class="to">${esc(who)}</div>`
    : `<div class="to">السـادة / ${esc(who)} &nbsp;&nbsp; المحتـرمين</div><div class="greet">تحيـة طيبـة وبعـد،،،</div>`;
  const meta = `<div class="meta"><span>${en ? "Date" : "التاريخ"} : <b>${esc(rec.date || "")}</b></span><span class="mono">${esc(rec.lysal || "")}</span></div>`;
  const t1 = spec.table ? specTablePrint(spec.table, rec.items) : "";
  const t2 = spec.table2 ? specTablePrint(spec.table2, (rec.meta && rec.meta.rows2) || []) : "";
  const closing = (spec.closing || []).map((l) => `<div class="body">${esc(l)}</div>`).join("");
  const sign = spec.signatory && (spec.signatory.name || spec.signatory.role)
    ? `<div class="sign"><div class="role">${esc(spec.signatory.role)}</div><div class="who">${esc(spec.signatory.name)}</div></div>`
    : "";
  const inner = `${meta}${to}<div class="subj">${en ? "Subject: " : "الموضـوع : "}${esc(subject)}</div><div class="body">${esc(intro)}</div>${t1}${t2}${rec.note ? `<div class="body">${esc(rec.note)}</div>` : ""}${closing}${sign}`;
  const head = LH_MODE === "full" ? `<div class="lh-h"><img src="${LOGOS.header}" alt="UDC"></div>` : "";
  const foot = LH_MODE === "full" ? `<div class="lh-f"><img src="${LOGOS.footer}" alt=""></div>` : "";
  return `<div class="doc lh-${LH_MODE}${en ? " ltr" : ""}"${en ? ' dir="ltr"' : ""}>${head}<div class="lh-body">${inner}</div>${foot}</div>`;
}
function docHTML(rec, isLetter) {
  const spec = specOf(rec.type);
  if (spec) return specDocHTML(rec, spec);
  const inner = rec.type === "changeprice" ? priceLetterInner(rec) : debitLetterInner(rec, isLetter);
  const head = LH_MODE === "full" ? `<div class="lh-h"><img src="${LOGOS.header}" alt="UDC"></div>` : "";
  const foot = LH_MODE === "full" ? `<div class="lh-f"><img src="${LOGOS.footer}" alt=""></div>` : "";
  return `<div class="doc lh-${LH_MODE}">${head}<div class="lh-body">${inner}</div>${foot}</div>`;
}
function fmtTs(s) {
  if (!s) return "";
  try {
    return new Intl.DateTimeFormat(LANG === "ar" ? "ar" : "en-GB", {
      dateStyle: "medium", timeStyle: "short",
    }).format(new Date(s));
  } catch (e) { return s; }
}
function approvalTrail(n) {
  if (!n) return "";
  const steps = [];
  steps.push(`<div class="step">✎ <b>${t("createdBy")}:</b> ${esc(n.createdByName || "-")} — ${fmtTs(n.createdAt)}</div>`);
  if (n.supApprovedAt)
    steps.push(`<div class="step">✔ <b>${t("supApproved")}:</b> ${esc(n.supApprovedByName || "-")} — ${fmtTs(n.supApprovedAt)}</div>`);
  if (n.mgrApprovedAt)
    steps.push(`<div class="step">✔ <b>${t("mgrApproved")}:</b> ${esc(n.mgrApprovedByName || "-")} — ${fmtTs(n.mgrApprovedAt)}</div>`);
  if (n.rejectedAt)
    steps.push(`<div class="step" style="color:var(--danger)">✕ <b>${t("rejectedBy")} (${n.rejectedStage === "mgr" ? t("mgr") : t("sup")}):</b> ${esc(n.rejectedByName || "-")} — ${fmtTs(n.rejectedAt)}<br>${t("rejectReason")}: ${esc(n.rejectReason || "")}</div>`);
  return `<div class="approv-trail no-print"><b style="color:#123f70">${t("approvalTrail")}</b>${steps.join("")}</div>`;
}
let curDoc = null;
function toggleLh() {
  LH_MODE = LH_MODE === "full" ? "preprinted" : "full";
  if (curDoc) openDoc(curDoc.rec, curDoc.isLetter);
}
function openDoc(rec, isLetter) {
  curDoc = { rec, isLetter };
  const att =
    !isLetter && rec.attachments && rec.attachments.length
      ? `<div class="att-strip no-print"><b style="width:100%;color:#123f70;font-size:13px">${t("attachments")}</b>${rec.attachments.map((a) => (a.url.startsWith("data:image") ? `<a class="att-item" href="${a.url}" target="_blank"><img src="${a.url}"><div>${esc(a.name)}</div></a>` : `<a class="att-item" href="${a.url}" target="_blank"><div style="padding:14px;font-size:22px">📄</div><div>${esc(a.name)}</div></a>`)).join("")}</div>`
      : "";
  const trail = !isLetter ? `<div style="padding:0 24px 18px">${approvalTrail(rec)}</div>` : "";
  const lhBtn = `<button class="btn ghost sm no-print" onclick="toggleLh()" title="${t("lhToggleHint")}">🏷 ${LH_MODE === "full" ? t("lhFull") : t("lhBlank")}</button>`;
  modal(
    `<div class="doc-tools"><b style="color:var(--ink)">${isLetter ? t("previewLetter") : t("debitNote") + " " + esc(rec.id)}</b><div class="actions">${lhBtn}<button class="btn gold sm" onclick="window.print()">${t("print")}</button><button class="btn ghost sm" onclick="closeModal()">✕ ${t("close")}</button></div></div>${docHTML(rec, isLetter)}${att}${trail}`,
  );
}
function openDocById(id) {
  openDoc(
    DB.notes.find((n) => n.id === id),
    false,
  );
}
function printLetter(id) {
  openDoc(
    DB.letters.find((l) => l.id === id),
    true,
  );
}
function modal(h) {
  document.getElementById("modalHost").innerHTML =
    `<div class="overlay" onclick="if(event.target===this)closeModal()"><div class="doc-wrap">${h}</div></div>`;
}
function closeModal() {
  document.getElementById("modalHost").innerHTML = "";
}
/* ================= v2: audit, users, backup, exports ================= */
function dl(url) {
  // Download a protected endpoint via fetch (adds the bearer token), then trigger save.
  api(url, { raw: true })
    .then((res) => (res.ok ? res.blob().then((b) => ({ b, res })) : Promise.reject(new Error("HTTP " + res.status))))
    .then(({ b, res }) => {
      const dispo = res.headers.get("Content-Disposition") || "";
      const m = /filename="?([^"]+)"?/.exec(dispo);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(b);
      a.download = m ? m[1] : "export";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    })
    .catch((e) => toast(e.message));
}

/* ---------- audit log (admin + doc) ---------- */
let auditRows = [];
function vAudit() {
  document.getElementById("rv").innerHTML = `
  <div class="panel"><header><h3>${t("auditLog")}</h3>
    <button class="btn gold sm" onclick="dl('/audit/export.csv' + auditQuery())">⬇ ${t("exportCsv")}</button></header>
    <div class="audit-toolbar">
      <div class="field"><label>${t("username")}</label><input id="afUser"></div>
      <div class="field"><label>${t("action")}</label><input id="afAction" placeholder="note.approve..."></div>
      <div class="field"><label>${t("fromDate")}</label><input id="afFrom" type="date"></div>
      <div class="field"><label>${t("toDate")}</label><input id="afTo" type="date"></div>
      <div class="field"><label>&nbsp;</label><button class="btn primary" onclick="loadAudit()">${t("apply")}</button></div>
    </div>
    <div class="tbl-wrap" id="auditBox"><div class="empty">${t("loading")}</div></div>
  </div>`;
  loadAudit();
}
function auditQuery() {
  const g = (id) => (document.getElementById(id) ? document.getElementById(id).value.trim() : "");
  const p = [];
  if (g("afUser")) p.push("username=" + encodeURIComponent(g("afUser").toLowerCase()));
  if (g("afAction")) p.push("action=" + encodeURIComponent(g("afAction")));
  if (g("afFrom")) p.push("from=" + encodeURIComponent(g("afFrom")));
  if (g("afTo")) p.push("to=" + encodeURIComponent(g("afTo")));
  return p.length ? "?" + p.join("&") : "";
}
async function loadAudit() {
  try {
    const r = await api("/audit" + auditQuery() + (auditQuery() ? "&" : "?") + "limit=500");
    auditRows = r.rows;
    const box = document.getElementById("auditBox");
    if (!r.rows.length) { box.innerHTML = `<div class="empty">${t("noAudit")}</div>`; return; }
    box.innerHTML = `<table><thead><tr><th>${t("th_time")}</th><th>${t("username")}</th><th>${t("th_role")}</th><th>${t("action")}</th><th>${t("th_detail")}</th></tr></thead><tbody>${r.rows
      .map((a) => `<tr><td class="mono-sm">${fmtTs(a.ts)}</td><td>${esc(a.name || a.username || "-")}</td><td>${a.role ? `<span class="badge role-${esc(a.role)}">${esc(a.role)}</span>` : ""}</td><td class="mono-sm">${esc(a.action)}</td><td>${esc(a.summary || "")}</td></tr>`)
      .join("")}</tbody></table><div class="hint" style="padding:8px 12px">${t("showing")} ${r.rows.length} / ${r.total}</div>`;
  } catch (e) {
    document.getElementById("auditBox").innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

/* ---------- user management (admin) ---------- */
const USER_ROLES = ["admin", "marketing", "division", "supervisor", "salesman", "doc"];
let usersCache = [];
async function vUsers() {
  document.getElementById("rv").innerHTML =
    `<div class="panel"><header><h3>${t("userMgmt")}</h3><button class="btn gold sm" onclick="openUserForm()">＋ ${t("addUser")}</button></header><div class="tbl-wrap" id="usersBox"><div class="empty">${t("loading")}</div></div></div>`;
  await refreshUsers();
}
async function refreshUsers() {
  try {
    const r = await api("/admin/users");
    usersCache = r.users;
    const box = document.getElementById("usersBox");
    box.innerHTML = `<table><thead><tr><th>${t("username")}</th><th>${t("name")}</th><th>${t("th_role")}</th><th>${t("th_status")}</th><th>${t("lastLogin")}</th><th>${t("th_actions")}</th></tr></thead><tbody>${r.users
      .map((u) => `<tr><td class="mono-sm">${esc(u.username)}</td><td>${esc(u.name)}</td><td><span class="badge role-${esc(u.role)}">${esc(u.role)}</span></td><td>${u.active ? `<span class="badge on">${t("active")}</span>` : `<span class="badge off">${t("inactive")}</span>`}${u.must_change_password ? ` <span class="pill-info">${t("pwPending")}</span>` : ""}</td><td class="mono-sm">${u.last_login_at ? fmtTs(u.last_login_at) : "-"}</td><td><div class="actions"><button class="btn ghost sm" onclick="openUserForm(${u.id})">${t("edit")}</button><button class="btn ghost sm" onclick="resetUserPw(${u.id})">${t("resetPw")}</button></div></td></tr>`)
      .join("")}</tbody></table>`;
  } catch (e) {
    document.getElementById("usersBox").innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}
function openUserForm(id) {
  const u = id ? usersCache.find((x) => x.id === id) : null;
  const roleOpts = USER_ROLES.map((r) => `<option value="${r}" ${u && u.role === r ? "selected" : ""}>${t("r_" + r) || r}</option>`).join("");
  modal(`<div class="doc-tools"><b style="color:var(--ink)">${u ? t("edit") : t("addUser")}</b><button class="btn ghost sm" onclick="closeModal()">✕ ${t("close")}</button></div>
  <div style="padding:20px 24px">
    <div class="grid">
      <div class="field"><label>${t("username")}</label><input id="uU" value="${u ? esc(u.username) : ""}" ${u ? "readonly" : ""}></div>
      <div class="field"><label>${t("name")}</label><input id="uN" value="${u ? esc(u.name) : ""}"></div>
      <div class="field"><label>${t("th_role")}</label><select id="uR">${roleOpts}</select></div>
      ${u ? `<div class="field"><label>${t("th_status")}</label><select id="uA"><option value="1" ${u.active ? "selected" : ""}>${t("active")}</option><option value="0" ${!u.active ? "selected" : ""}>${t("inactive")}</option></select></div>`
          : `<div class="field"><label>${t("initialPw")}</label><input id="uP" placeholder="${t("defaultPwNote")}"></div>`}
    </div>
    <div class="login-err" id="uErr"></div>
    <div class="actions" style="margin-top:14px"><button class="btn primary" onclick="saveUser(${id || 0})">${t("save")}</button><button class="btn ghost" onclick="closeModal()">${t("cancel")}</button></div>
  </div>`);
}
async function saveUser(id) {
  const err = document.getElementById("uErr");
  try {
    if (id) {
      await api("/admin/users/" + id, {
        method: "PATCH",
        body: {
          name: document.getElementById("uN").value.trim(),
          role: document.getElementById("uR").value,
          active: document.getElementById("uA").value === "1",
        },
      });
    } else {
      await api("/admin/users", {
        method: "POST",
        body: {
          username: document.getElementById("uU").value.trim().toLowerCase(),
          name: document.getElementById("uN").value.trim(),
          role: document.getElementById("uR").value,
          password: document.getElementById("uP").value || undefined,
        },
      });
    }
    closeModal();
    toast(t("saved"));
    refreshUsers();
  } catch (e) { err.textContent = e.message; }
}
async function resetUserPw(id) {
  if (!confirm(t("confirmResetPw"))) return;
  try {
    await api("/admin/users/" + id + "/reset-password", { method: "POST" });
    toast(t("pwReset"));
    refreshUsers();
  } catch (e) { toast(e.message); }
}

/* ---------- backup / restore (admin) ---------- */
function vBackup() {
  document.getElementById("rv").innerHTML = `
  <div class="panel"><header><h3>${t("backupTitle")}</h3></header><div class="body">
    <p class="hint">${t("backupDesc")}</p>
    <div class="actions"><button class="btn primary" onclick="dl('/admin/export.json')">⬇ ${t("downloadBackup")}</button></div>
  </div></div>
  <div class="panel"><header><h3>${t("restoreTitle")}</h3></header><div class="body">
    <div class="pwd-warn">${t("restoreWarn")}</div>
    <label class="btn gold filebtn">📂 ${t("chooseBackup")}<input type="file" accept="application/json,.json" onchange="doRestore(this)"></label>
    <span id="restoreMsg" class="hint" style="margin-inline-start:10px"></span>
  </div></div>
  <div class="panel"><header><h3>${t("dataExports")}</h3></header><div class="body">
    <div class="actions">
      <button class="btn ghost" onclick="dl('/export/notes.csv')">⬇ ${t("notesCsv")}</button>
      <button class="btn ghost" onclick="dl('/export/letters.csv')">⬇ ${t("lettersCsv")}</button>
      <button class="btn ghost" onclick="dl('/audit/export.csv')">⬇ ${t("auditCsv")}</button>
    </div>
  </div></div>`;
}
function doRestore(input) {
  const f = input.files[0];
  if (!f) return;
  if (!confirm(t("confirmRestore"))) { input.value = ""; return; }
  const rd = new FileReader();
  rd.onload = async () => {
    try {
      const data = JSON.parse(rd.result);
      await api("/admin/restore", { method: "POST", body: data });
      document.getElementById("restoreMsg").textContent = t("restoreDone");
      toast(t("restoreDone"));
    } catch (e) {
      document.getElementById("restoreMsg").textContent = e.message;
    }
    input.value = "";
  };
  rd.readAsText(f);
}

/* ---------- outlets & contracts (imported master data) ---------- */
let outletsCache = [];
async function vOutlets() {
  document.getElementById("rv").innerHTML = `
  <div class="panel"><header><h3>${t("outletsTitle")}</h3>
    <div style="display:flex;gap:8px;align-items:center"><input id="olq" placeholder="${t("search")}" oninput="renderOutlets()" style="min-width:200px"><span class="pill-info" id="olCount"></span></div>
  </header><div class="tbl-wrap" id="outletsBox"><div class="empty">${t("loading")}</div></div></div>`;
  try {
    const r = await api("/outlets");
    outletsCache = r.outlets;
    renderOutlets();
  } catch (e) {
    document.getElementById("outletsBox").innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}
function contractLabel(o) {
  const p = [];
  if (o.pct != null) p.push((+o.pct * 100).toFixed(2).replace(/\.00$/, "") + "%");
  if (o.lumsum) p.push("Lump " + o.lumsum);
  if (o.bonus) p.push("Bonus " + o.bonus);
  if (o.slap) p.push(o.slap);
  return p.join(" · ") || "—";
}
function renderOutlets() {
  const q = (document.getElementById("olq")?.value || "").trim().toLowerCase();
  const rows = outletsCache.filter((o) =>
    !q || [o.name, o.parent, o.salesman, o.route, o.cust_id, o.merchandiser].some((v) => String(v || "").toLowerCase().includes(q)));
  document.getElementById("olCount").textContent = rows.length + " / " + outletsCache.length;
  document.getElementById("outletsBox").innerHTML = rows.length
    ? `<table><thead><tr><th>CUST</th><th>${t("outlet")}</th><th>${t("coop")}</th><th>${t("route")}</th><th>${t("r_salesman")}</th><th>${t("merchandiser")}</th><th>${t("contract")}</th><th>Lays</th><th>IEC</th></tr></thead><tbody>${rows
        .map((o) => `<tr><td class="mono-sm">${esc(o.cust_id)}</td><td>${esc(o.name)}</td><td>${esc(o.parent)}</td><td class="mono-sm">${esc(o.route || "")}</td><td>${esc(o.salesman || "")}</td><td>${esc(o.merchandiser || "")}</td><td class="mono-sm">${esc(contractLabel(o))}</td><td class="mono">${o.lays_sales != null ? KD(o.lays_sales) : "—"}</td><td class="mono">${o.iec_sales != null ? KD(o.iec_sales) : "—"}</td></tr>`)
        .join("")}</tbody></table>`
    : `<div class="empty">${t("noOutlets")}</div>`;
}

/* ---------- sales & targets (imported master data) ---------- */
const SALE_YEARS = [2020, 2021, 2022, 2023, 2024, 2025, 2026];
const ALL_YEARS = [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
let salesCache = [];
async function vSales() {
  document.getElementById("rv").innerHTML =
    `<div id="salesDash"></div>
     <div class="panel"><header><h3>${t("salesTitle")}</h3><input id="slq" placeholder="${t("search")}" oninput="renderSales()" style="min-width:200px"></header><div class="tbl-wrap" id="salesBox"><div class="empty">${t("loading")}</div></div></div>`;
  try {
    const r = await api("/sales");
    salesCache = r.sales;
    renderSalesDash();
    renderSales();
  } catch (e) {
    document.getElementById("salesBox").innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}
function yearTotal(y) {
  return salesCache.reduce((a, s) => a + (+(s.years && s.years[y]) || 0), 0);
}
// Lightweight, dependency-free bar chart (vertical) — theme-consistent.
function barChart(pairs, fmt) {
  const max = Math.max(1, ...pairs.map((p) => p[1]));
  return `<div class="bars">${pairs
    .map(([label, v]) => {
      const h = Math.round((v / max) * 100);
      return `<div class="bar-col"><div class="bar-track"><div class="bar-fill" style="height:${h}%" title="${fmt ? fmt(v) : v}"></div></div><div class="bar-lbl">${esc(label)}</div></div>`;
    })
    .join("")}</div>`;
}
// Horizontal bars (for ranked lists).
function hBars(pairs, fmt) {
  const max = Math.max(1, ...pairs.map((p) => p[1]));
  return `<div class="hbars">${pairs
    .map(([label, v]) => `<div class="hbar-row"><div class="hbar-lbl" title="${esc(label)}">${esc(label)}</div><div class="hbar-track"><div class="hbar-fill" style="width:${Math.round((v / max) * 100)}%"></div></div><div class="hbar-val mono">${fmt ? fmt(v) : v}</div></div>`)
    .join("")}</div>`;
}
function renderSalesDash() {
  const box = document.getElementById("salesDash");
  if (!box) return;
  const t26 = yearTotal(2026), t25 = yearTotal(2025);
  const yoy = t25 ? Math.round(((t26 - t25) / t25) * 100) : 0;
  const listingDone = salesCache.filter((s) => String(s.listing || "").toUpperCase() === "DONE").length;
  const risk = salesCache.filter((s) => /risk/i.test(String(s.target || ""))).length;
  const trend = ALL_YEARS.map((y) => ["" + y, yearTotal(y)]);
  const top = salesCache
    .map((s) => [s.parent.replace(/^P\d+-/, "").replace(/ PARENT$/i, ""), +(s.years && s.years[2026]) || 0])
    .filter((p) => p[1] > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  box.innerHTML = `
  <div class="cards">
    ${card("accent", t("salesYtd") + " 2026", KD(t26), 1)}
    ${card("", t("sales") + " 2025", KD(t25), 1)}
    ${card(yoy >= 0 ? "ok" : "warn", t("yoy"), `<bdi dir="ltr">${(yoy >= 0 ? "+" : "") + yoy}%</bdi>`, 0)}
    ${card("", "LISTING", `<bdi dir="ltr">${listingDone} / ${salesCache.length}</bdi>`, 0)}
    ${card(risk ? "warn" : "ok", t("atRisk"), risk, 0)}
  </div>
  <div class="panel"><header><h3>${t("annualTrend")}</h3></header><div class="body">${barChart(trend, KD)}</div></div>
  <div class="panel"><header><h3>${t("top10_2026")}</h3></header><div class="body">${top.length ? hBars(top, KD) : `<div class="empty">${t("noSales")}</div>`}</div></div>`;
}
function renderSales() {
  const q = (document.getElementById("slq")?.value || "").trim().toLowerCase();
  const rows = salesCache.filter((s) => !q || [s.parent, s.salesman, s.fsm].some((v) => String(v || "").toLowerCase().includes(q)));
  const yh = SALE_YEARS.map((y) => `<th>${y}</th>`).join("");
  document.getElementById("salesBox").innerHTML = rows.length
    ? `<table><thead><tr><th>${t("coop")}</th><th>${t("r_salesman")}</th>${yh}<th>${t("target")}</th><th>LISTING</th></tr></thead><tbody>${rows
        .map((s) => `<tr><td>${esc(s.parent)}</td><td>${esc(s.salesman || "")}</td>${SALE_YEARS.map((y) => `<td class="mono">${s.years && s.years[y] != null ? KD(s.years[y]) : "—"}</td>`).join("")}<td class="mono">${esc(s.target || "—")}</td><td>${esc(s.listing || "")}</td></tr>`)
        .join("")}</tbody></table>`
    : `<div class="empty">${t("noSales")}</div>`;
}

/* ---------- products catalog (view + import) ---------- */
async function vProducts() {
  const isAdmin = currentUser.role === "admin";
  document.getElementById("rv").innerHTML = `
  <div class="panel"><header><h3>${t("productsTitle")}</h3>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <input id="pq" placeholder="${t("search")}" oninput="renderProducts()" style="min-width:200px">
      <span class="pill-info" id="pCount"></span>
      ${isAdmin ? `<label class="btn gold sm filebtn">⬆ ${t("importFile")}<input type="file" accept=".csv,.xlsx,.xls" onchange="doImportProducts(this)"></label>` : ""}
    </div>
  </header>
  ${isAdmin ? `<div class="hint" style="padding:8px 16px">${t("importHint")}</div>` : ""}
  <div id="importMsg" class="hint" style="padding:0 16px"></div>
  <div class="tbl-wrap" id="productsBox"><div class="empty">${t("loading")}</div></div></div>`;
  productCache = [];
  await ensureProducts();
  renderProducts();
}
function renderProducts() {
  const q = (document.getElementById("pq")?.value || "").trim().toLowerCase();
  const rows = productCache.filter((p) => !q || [p.barcode, p.name, p.pack, p.origin].some((v) => String(v || "").toLowerCase().includes(q)));
  const cc = document.getElementById("pCount");
  if (cc) cc.textContent = rows.length + " / " + productCache.length;
  const box = document.getElementById("productsBox");
  if (!box) return;
  box.innerHTML = rows.length
    ? `<table><thead><tr><th>${t("th_barcode")}</th><th>${t("th_name")}</th><th>${t("th_pack")}</th><th>${t("origin")}</th><th>${t("consPiece")}</th><th>${t("coopCarton")}</th></tr></thead><tbody>${rows
        .slice(0, 500)
        .map((p) => `<tr><td class="mono-sm">${esc(p.barcode)}</td><td>${esc(p.name)}</td><td>${esc(p.pack || "")}</td><td>${esc(p.origin || "")}</td><td class="mono">${p.consPiece != null ? KD(p.consPiece) : "—"}</td><td class="mono">${p.coopCarton != null ? KD(p.coopCarton) : "—"}</td></tr>`)
        .join("")}</tbody></table>${rows.length > 500 ? `<div class="hint" style="padding:8px 12px">${t("showing")} 500 / ${rows.length}</div>` : ""}`
    : `<div class="empty">${t("noProducts")}</div>`;
}
function doImportProducts(input) {
  const f = input.files[0];
  if (!f) return;
  const msg = document.getElementById("importMsg");
  msg.textContent = t("loading");
  const rd = new FileReader();
  rd.onload = async () => {
    try {
      const r = await api("/products/import", { method: "POST", body: { filename: f.name, contentB64: String(rd.result) } });
      msg.textContent = `${t("imported")}: ${r.imported} · ${t("skipped")}: ${r.skipped} · ${t("total")}: ${r.total}`;
      toast(t("importDone"));
      productCache = [];
      await ensureProducts();
      renderProducts();
    } catch (e) { msg.textContent = e.message; }
    input.value = "";
  };
  rd.readAsDataURL(f);
}

/* ---------- init ---------- */
(async function () {
  try { TOKEN = localStorage.getItem("udc_token") || null; } catch (e) {}
  try { const lg = localStorage.getItem("udc_lang"); if (lg) LANG = lg; } catch (e) {}
  applyDir();
  if (TOKEN) {
    try { await loadState(); } catch (e) { TOKEN = null; currentUser = null; }
  }
  render();
})();
