'use strict';
/*
 * Declarative registry of letter templates ("co-op books").
 * One spec per letter type drives BOTH the create form (client) and the
 * printed document (client), and validation/storage (server). Served to the
 * client via /api/state -> ref.letterSpecs.
 *
 * Field reference:
 *  k         : unique type key (also stored on letters.type)
 *  ar/en     : dropdown label
 *  group     : 'coop' | 'market' | 'union' | 'export'  (for grouping in UI)
 *  lang      : 'ar' | 'en'  -> printed document direction/language
 *  recipient : 'coop'  -> pick from the co-op dropdown
 *              'free'  -> free-text recipient input (with optional default)
 *              'fixed' -> constant string (recipientFixed)
 *  subject   : { ar, en }  printed subject line (supports {placeholders})
 *  intro     : { ar, en }  opening paragraph (supports {placeholders})
 *  closing   : [ lines ]   closing paragraph lines (already language-correct)
 *  signatory : { role, name }
 *  fields    : [ { key, ar, en, type } ]  extra scalar inputs (text/number/date)
 *  table     : { title:{ar,en}, cols:[ {key, ar, en, type, group?} ] } | null
 *  table2    : optional second table (same shape)
 *  valueMode : 'none' | 'direct'(value field) | 'sum:<colKey>'  (letter value)
 *  debitFlow : false  -> letter-only (no co-op debit-note/approval step)
 *
 * {placeholders} are substituted from: the record's own fields (coop, date,
 * lysal), and any `fields[].key` / built-in (value).
 */

const SIGN = {
  coop: { role: 'مدير المبيعات', name: 'سائد الرمحي' },
  salesops: { role: 'مدير عمليات البيع والتسويق', name: 'أحمد شوقي' },
  gm: { role: 'المدير العام', name: 'راشد المنيع' },
  execadmin: { role: 'المدير التنفيذي الإداري', name: 'عماد فايز الرفاعي' },
};
// Selectable signatories for the Union letters: the GM or the executive
// administrative director (each choice carries its own role + name).
const GM_CHOICES = [SIGN.gm, SIGN.execadmin];
// The co-op letters are signed by whichever sales manager owns the account, so
// every co-op spec offers the same roster rather than a single fixed name.
const COOP_CHOICES = [SIGN.coop, SIGN.salesops];

const LETTER_SPECS = [
  /* ---------- 2) Price Updation (زيادة أسعار) ---------- */
  {
    k: 'priceupd', ar: 'تحديث بيانات / زيادة أسعار', en: 'Price Updation',
    group: 'coop', lang: 'ar', recipient: 'coop', debitFlow: false, valueMode: 'none',
    subject: { ar: 'تحديـث بيانـات', en: 'Data / Price Update' },
    intro: {
      ar: 'بالإشـارة إلى الموضـوع أعـلاه، يرجـى من سيادتكـم التكـرم بالموافقـة على تحديث بيانات زيادة أسعار الأصنـاف المذكـورة بالجـدول أدنـاه وربطهـا بالفـروع وهي كالتالـي :',
      en: 'With reference to the above, kindly approve the price update for the items listed below:',
    },
    table: {
      title: { ar: 'الأصناف', en: 'Items' },
      cols: [
        { key: 'item', ar: 'رقم الصنف', en: 'Item #', type: 'text' },
        { key: 'name', ar: 'اسم الصنف', en: 'Name', type: 'text', wide: true },
        { key: 'origin', ar: 'بلد المنشأ', en: 'Origin', type: 'text' },
        { key: 'pack', ar: 'الشد', en: 'Pack', type: 'text' },
        { key: 'coopCarton', ar: 'سعر الكرتون للجمعية', en: 'Coop carton', type: 'num' },
        { key: 'consPiece', ar: 'سعر الحبة للمستهلك', en: 'Consumer piece', type: 'num' },
        { key: 'barcode', ar: 'رقم الباركود', en: 'Barcode', type: 'text' },
      ],
    },
    closing: ['وتفضلـوا بقبـول فائـق الاحتـرام،،،'],
    signatory: SIGN.coop,
  },

  /* ---------- 4) Supplementary Listing (اعتماد أصناف تكميلية) ---------- */
  {
    k: 'listing_supp', ar: 'اعتماد أصناف تكميلية', en: 'Supplementary Listing',
    group: 'coop', lang: 'ar', recipient: 'coop', debitFlow: false, valueMode: 'none',
    subject: { ar: 'اعتمـاد اصنـاف تكميليــة', en: 'Supplementary Listing' },
    intro: {
      ar: 'بالإشـارة إلى الموضـوع أعـلاه، يرجـى من سيادتكـم التكـرم بالموافقـة على إعتمـاد الأصنـاف التكميليـة المذكـورة بالجـدول أدنـاه وربطهـا بالفـروع وهي كالتالـي :',
      en: 'With reference to the above, kindly approve listing the supplementary items below:',
    },
    table: {
      title: { ar: 'الأصناف التكميلية', en: 'Items' },
      cols: [
        { key: 'name', ar: 'اسم الصنف', en: 'Name', type: 'text', wide: true },
        { key: 'origin', ar: 'بلد المنشأ', en: 'Origin', type: 'text' },
        { key: 'pack', ar: 'الشد', en: 'Pack', type: 'text' },
        { key: 'coopCarton', ar: 'سعر الكرتون للجمعية', en: 'Coop carton', type: 'num' },
        { key: 'consPiece', ar: 'سعر الحبة للمستهلك', en: 'Consumer piece', type: 'num' },
        { key: 'barcode', ar: 'رقم الباركود', en: 'Barcode', type: 'text' },
      ],
    },
    closing: ['شـاكرين لكـم حسـن تعاونكـم،،،،', 'وتفضلـوا بقبـول فائـق الاحتـرام،،،'],
    signatory: SIGN.coop,
  },

  /* ---------- 5) Rent Stand (إيجار استاند) ---------- */
  {
    // A permission request, not a charge: none of the archived ايجار استاند
    // letters carries an amount, and the template never printed one either —
    // yet valueMode:'direct' made the form reject a submission without it.
    k: 'rentstand', ar: 'إيجار استاند', en: 'Rent Stand',
    group: 'coop', lang: 'ar', recipient: 'coop', debitFlow: false, valueMode: 'none',
    subject: { ar: 'ايجار استاند', en: 'Stand Rental' },
    intro: {
      ar: 'بالاشـارة الى الموضوع اعـلاه، يرجـى من سيادتكم التكرم بالموافقه على ايجار عدد ({count}) استاند بمساحة {size} {place} لمدة {duration} من تاريخ التركيب لعرض منتجات {brand}.',
      en: 'With reference to the above, kindly approve renting ({count}) stand(s) of size {size} {place} for {duration} to display {brand} products.',
    },
    fields: [
      { key: 'count', ar: 'عدد الاستاندات', en: 'Count', type: 'number' },
      { key: 'size', ar: 'المساحة', en: 'Size', type: 'text' },
      { key: 'place', ar: 'الموقع', en: 'Place', type: 'text' },
      { key: 'duration', ar: 'المدة', en: 'Duration', type: 'text' },
      { key: 'brand', ar: 'المنتجات', en: 'Products', type: 'text' },
    ],
    closing: ['وتفضـلوا بقبـول فائـق الاحـترام والتقـدير،،،'],
    signatory: SIGN.coop, signChoices: COOP_CHOICES,
  },

  /* ---------- 4b) New-items Listing Debit Note (إشعار + جدول) ---------- */
  {
    k: 'listing_dn', ar: 'اعتماد أصناف جديدة (إشعار + جدول)', en: 'New Items Listing (DN + table)',
    group: 'coop', lang: 'ar', recipient: 'coop', debitFlow: false, valueMode: 'listingdn',
    subject: { ar: 'عمـل إشعـار خصـم', en: 'Debit Note' },
    intro: {
      ar: 'بالاشـارة الى الموضـوع اعـلاه، يرجـى من سيادتكم التكرم بالموافقـة على عمـل إشعـار خصم من حسـاب الشـركة المتحـدة المتميـزة للتجـارة العامـه للمـواد الغـذائية لديكـم بقيمـة ({value} د.ك) {tafqit} وذلك القيمة مقابل اعتماد أصناف جديدة.',
      en: 'With reference to the above, kindly approve a debit note against United Distinctive Co. for (KD {value}) being the listing of new items.',
    },
    // Number of central markets the listing fee is billed against. Leave blank
    // to use the co-op's stored listing_markets (or its main-outlet count);
    // set it for a partial roll-out (e.g. listing on 2 of the co-op's markets).
    fields: [
      { key: 'markets', ar: 'عدد أسواق الإدراج (اتركه فارغًا للافتراضي)', en: 'Listing markets (blank = default)', type: 'number' },
    ],
    table: {
      title: { ar: 'الأصناف', en: 'Items' },
      cols: [
        { key: 'item', ar: 'رقم الصنف', en: 'Item #', type: 'text' },
        { key: 'name', ar: 'اسم الصنف', en: 'Name', type: 'text', wide: true },
        { key: 'origin', ar: 'بلد المنشأ', en: 'Origin', type: 'text' },
        { key: 'pack', ar: 'الشد', en: 'Pack', type: 'text' },
        { key: 'coopCarton', ar: 'سعر الكرتون للجمعية', en: 'Coop carton', type: 'num' },
        { key: 'consPiece', ar: 'سعر الحبة للمستهلك', en: 'Consumer piece', type: 'num' },
        { key: 'barcode', ar: 'رقم الباركود', en: 'Barcode', type: 'text' },
      ],
    },
    closing: ['وتفضلـوا بقبـول فائـق الاحتـرام والتقديـر،،،'],
    signatory: SIGN.coop,
  },

  /* ---------- 4d) Price-Difference Debit Note (إشعار خصم — فروق أسعار) ----------
   * The single largest family in the archive (~886 letters). A flat value with
   * an optional qualifier appended to "فروق اسعار" (مهرجان يوليو / السوق المركزي
   * / سوق A). Verbatim body per 9218-JLEEB and the 800+ matching letters. */
  {
    k: 'pricediff', ar: 'إشعار خصم — فروق أسعار', en: 'Price-Difference Debit Note',
    group: 'coop', lang: 'ar', recipient: 'coop', debitFlow: false, valueMode: 'direct',
    subject: { ar: 'عمــل إشعـار خصـم', en: 'Debit Note' },
    intro: {
      ar: 'بالاشـارة الى الموضـوع اعـلاه ، يرجـى من سيادتكم التكرم بالموافقـة على عمل إشعـار خصم من حسـاب الشـركة المتحـدة المتميـزة للتجـارة العامـه للمـواد الغـذائية لديكـم بقيمـة ({value} د.ك) {tafqit} وذلك القيمة مقابل فروق اسعار{reason}.',
      en: 'With reference to the above, kindly approve a debit note against United Distinctive Co. for (KD {value}) being price differences{reason}.',
    },
    fields: [
      { key: 'reason', ar: 'تفصيل إضافي (مهرجان / السوق) — اختياري', en: 'Qualifier (festival / outlet)', type: 'text' },
      { key: 'value', ar: 'القيمة (د.ك)', en: 'Value (KD)', type: 'number' },
    ],
    closing: ['وتفضـلوا بقبـــول فائـــق الاحـــترام والتقـــدير،،،'],
    signatory: SIGN.coop, signChoices: COOP_CHOICES,
  },

  /* ---------- 4c-2) Pallets Debit Note (إشعار خصم — طبالي) ----------
   * Modeled on the archive's 90+ 'عمل إشعار خصم ... مقابل ايجار طبلية' letters. */
  {
    k: 'palletdn', ar: 'إشعار خصم — طبالي', en: 'Pallets Debit Note',
    group: 'coop', lang: 'ar', recipient: 'coop', debitFlow: false, valueMode: 'direct',
    subject: { ar: 'عمــل إشعـار خصـم', en: 'Debit Note' },
    intro: {
      ar: 'بالاشـارة الى الموضـوع اعـلاه ، يرجـى من سيادتكم التكرم بالموافقـة على عمل إشعـار خصم من حسـاب الشـركة المتحـدة المتميـزة للتجـارة العامـه للمـواد الغـذائية لديكـم بقيمـة ({value} د.ك) {tafqit} وذلك القيمة مقابل {reason}.',
      en: 'With reference to the above, kindly approve a debit note against United Distinctive Co. for (KD {value}) being {reason}.',
    },
    fields: [
      {
        key: 'reason', ar: 'السبب (اختر أو اكتب)', en: 'Reason (pick or type)', type: 'text',
        presets: ['إيجار طبلية', 'إيجار طبلية بالسوق المركزي', '1 طبلية بالسوق المركزي', '1 طبلية بالسوق المركزي القديم', 'عدد (1) طبلية', 'إيجار طبالي بالسوق المركزي الجديد'],
      },
      { key: 'value', ar: 'القيمة (د.ك)', en: 'Value (KD)', type: 'number' },
    ],
    closing: ['وتفضـلوا بقبـــول فائـــق الاحـــترام والتقـــدير،،،'],
    signatory: SIGN.coop, signChoices: COOP_CHOICES,
  },

  /* ---------- 4c-3) Stands Debit Note (إشعار خصم — استاند) ---------- */
  {
    k: 'standdn', ar: 'إشعار خصم — استاند', en: 'Stands Debit Note',
    group: 'coop', lang: 'ar', recipient: 'coop', debitFlow: false, valueMode: 'direct',
    subject: { ar: 'عمــل إشعـار خصـم', en: 'Debit Note' },
    intro: {
      ar: 'بالاشـارة الى الموضـوع اعـلاه ، يرجـى من سيادتكم التكرم بالموافقـة على عمل إشعـار خصم من حسـاب الشـركة المتحـدة المتميـزة للتجـارة العامـه للمـواد الغـذائية لديكـم بقيمـة ({value} د.ك) {tafqit} وذلك القيمة مقابل {reason}.',
      en: 'With reference to the above, kindly approve a debit note against United Distinctive Co. for (KD {value}) being {reason}.',
    },
    fields: [
      {
        key: 'reason', ar: 'السبب (اختر أو اكتب)', en: 'Reason (pick or type)', type: 'text',
        presets: ['إيجار استاند', 'إيجار 2 استاند', 'استاند فريتولي', 'إيجار استاند أمريكي', 'إيجار استاند بالسوق المركزي'],
      },
      { key: 'value', ar: 'القيمة (د.ك)', en: 'Value (KD)', type: 'number' },
    ],
    closing: ['وتفضـلوا بقبـــول فائـــق الاحـــترام والتقـــدير،،،'],
    signatory: SIGN.coop, signChoices: COOP_CHOICES,
  },

  /* ---------- 4d-2) General Debit Note — free "مقابل" reason ----------
   * Same debit-note body but the reason after "مقابل" is free text, e.g.
   * "1 طبلية بالسوق المركزي القديم" (LYSAL/11579). Covers any debit note
   * whose reason isn't one of the fixed types above. */
  {
    k: 'gendn', ar: 'إشعار خصم — سبب آخر', en: 'Debit Note — Other reason',
    group: 'coop', lang: 'ar', recipient: 'coop', debitFlow: false, valueMode: 'direct',
    subject: { ar: 'عمــل إشعـار خصـم', en: 'Debit Note' },
    intro: {
      ar: 'بالاشـارة الى الموضـوع اعـلاه ، يرجـى من سيادتكم التكرم بالموافقـة على عمل إشعـار خصم من حسـاب الشـركة المتحـدة المتميـزة للتجـارة العامـه للمـواد الغـذائية لديكـم بقيمـة ({value} د.ك) {tafqit} وذلك القيمة مقابل {reason}.',
      en: 'With reference to the above, kindly approve a debit note against United Distinctive Co. for (KD {value}) being {reason}.',
    },
    fields: [
      {
        key: 'reason', ar: 'السبب (اختر أو اكتب)', en: 'Reason (pick or type)', type: 'text',
        // Curated from past debit-note letters; the rep can still type anything.
        presets: [
          '1 طبلية بالسوق المركزي القديم',
          'طبلية بالسوق المركزي',
          'إيجار طبلية',
          'بدل توالف',
          'دعم سعر لمنتجات الشركة',
          'فرق دعم سعر',
          'توريد الفواتير',
          'اعتماد أصناف',
          'مساحة عرض',
          'مهرجان',
          'دعم للجمعية',
        ],
      },
      { key: 'value', ar: 'القيمة (د.ك)', en: 'Value (KD)', type: 'number' },
    ],
    closing: ['وتفضـلوا بقبـــول فائـــق الاحـــترام والتقـــدير،،،'],
    signatory: SIGN.coop, signChoices: COOP_CHOICES,
  },

  /* ---------- 4e) Data-Update Debit Note (إشعار خصم — تحديث بيانات) ----------
   * ~80 letters. Flat negotiated fee, no table. Optional brand suffix. */
  {
    k: 'dataupd_dn', ar: 'إشعار خصم — تحديث بيانات', en: 'Data-Update Debit Note',
    group: 'coop', lang: 'ar', recipient: 'coop', debitFlow: false, valueMode: 'direct',
    subject: { ar: 'عمــل إشعـار خصـم', en: 'Debit Note' },
    intro: {
      ar: 'بالاشـارة الى الموضـوع اعـلاه ، يرجـى من سيادتكم التكرم بالموافقـة على عمل إشعـار خصم من حسـاب الشـركة المتحـدة المتميـزة للتجـارة العامـه للمـواد الغـذائية لديكـم بقيمـة ({value} د.ك) {tafqit} وذلك القيمة مقابل تحديث بيانات{brand}.',
      en: 'With reference to the above, kindly approve a debit note against United Distinctive Co. for (KD {value}) being the item-data update{brand}.',
    },
    fields: [
      { key: 'brand', ar: 'البيان (اختياري: فريتولي الامريكي / ليز السعودي …)', en: 'Qualifier', type: 'text' },
      { key: 'value', ar: 'القيمة (د.ك)', en: 'Value (KD)', type: 'number' },
    ],
    closing: ['وتفضـلوا بقبـــول فائـــق الاحـــترام والتقـــدير،،،'],
    signatory: SIGN.coop, signChoices: COOP_CHOICES,
  },

  /* ---------- 4f) Percentage Sales-Rebate Debit Note (خصم % على المبيعات) ----------
   * The CDA quarterly/monthly rebate drawn down by debit note (البند الثالث). */
  {
    k: 'pctrebate', ar: 'إشعار خصم — نسبة على المبيعات', en: 'Percentage Sales Rebate',
    group: 'coop', lang: 'ar', recipient: 'coop', debitFlow: false, valueMode: 'direct',
    subject: { ar: 'عمــل إشعـار خصـم', en: 'Debit Note' },
    intro: {
      ar: 'بالاشـارة الى الموضـوع اعـلاه ، يرجـى من سيادتكم التكرم بالموافقـة على عمل إشعـار خصم من حسـاب الشـركة المتحـدة المتميـزة للتجـارة العامـه للمـواد الغـذائية لديكـم بقيمـة ({value} د.ك) {tafqit} وذلك القيمة مقابل خصم ({pct}%) على اجمالي مبيعات {brand} عن {period} وذلك حسب العقد المبرم بيننا.',
      en: 'With reference to the above, kindly approve a debit note against United Distinctive Co. for (KD {value}) being a {pct}% rebate on total {brand} sales for {period}, as per the contract.',
    },
    fields: [
      { key: 'pct', ar: 'النسبة %', en: 'Rate %', type: 'number' },
      { key: 'brand', ar: 'المنتج / العلامة', en: 'Brand', type: 'text' },
      { key: 'period', ar: 'الفترة', en: 'Period', type: 'text' },
      { key: 'value', ar: 'القيمة (د.ك)', en: 'Value (KD)', type: 'number' },
    ],
    closing: ['وتفضـلوا بقبـــول فائـــق الاحـــترام والتقـــدير،،،'],
    signatory: SIGN.coop, signChoices: COOP_CHOICES,
  },

  /* ---------- 4g) Link Items to Branches (ربط أصناف معتمدة بالفروع) ----------
   * ~20 letters. No money; approves linking already-listed items to branches. */
  {
    k: 'linkitems', ar: 'ربط أصناف معتمدة بالفروع', en: 'Link Items to Branches',
    group: 'coop', lang: 'ar', recipient: 'coop', debitFlow: false, valueMode: 'none',
    subject: { ar: 'ربــط أصنــاف معتمــدة بالفــروع', en: 'Link Approved Items to Branches' },
    intro: {
      ar: 'بالإشـارة الـى الموضـوع اعـلاه ، يرجــى مـن سيادتكـم التكـرم بالموافقـة علـى ربـط الأصنــاف التاليــة :',
      en: 'With reference to the above, kindly approve linking the following items to the branches:',
    },
    table: {
      title: { ar: 'الأصناف', en: 'Items' },
      cols: [
        { key: 'name', ar: 'الصــنف', en: 'Item', type: 'text', wide: true },
        { key: 'origin', ar: 'المنشــأ', en: 'Origin', type: 'text' },
        { key: 'pack', ar: 'الشـــد', en: 'Pack', type: 'text' },
        { key: 'coopCarton', ar: 'سعـر بيـع الكرتون للجمعية', en: 'Coop carton', type: 'num' },
        { key: 'consPiece', ar: 'سعر بيع الحبة للمستهلك', en: 'Consumer piece', type: 'num' },
        { key: 'barcode', ar: 'باركود الحبة', en: 'Barcode', type: 'text' },
      ],
    },
    closing: ['وتفضـلوا بقبـــول فائـــق الاحـــترام والتقـــدير،،،'],
    signatory: SIGN.coop, signChoices: COOP_CHOICES,
  },

  /* ---------- 4h) Consumer Special Offers (عروض خاصة للمستهلك) ----------
   * ~24 letters. Approves the promo pack + promo consumer price. No money. */
  {
    k: 'promotion', ar: 'عروض خاصة للمستهلك', en: 'Consumer Special Offers',
    group: 'coop', lang: 'ar', recipient: 'coop', debitFlow: false, valueMode: 'none',
    subject: { ar: 'عروض خاصة للـمـستهـلك', en: 'Consumer Special Offers' },
    intro: {
      ar: 'بالإشـارة إلى الموضوع أعلاه ، يـرجـى من سيادتكـم التكـرم بالموافقـة علـى اعتماد العـروض الخـاصة الموضح أدنـاه بالسـوق المركـزي لـدى جمعيتكـم الموقـرة وهـي كالتالـي:',
      en: 'With reference to the above, kindly approve the special consumer offers below for the central market of your esteemed co-operative:',
    },
    table: {
      title: { ar: 'العروض', en: 'Offers' },
      cols: [
        { key: 'name', ar: 'الصنف', en: 'Item', type: 'text', wide: true },
        { key: 'pack', ar: 'الشد', en: 'Pack', type: 'text' },
        { key: 'promoCost', ar: 'سعر تكلفة العرض', en: 'Promo cost', type: 'num' },
        { key: 'promoCons', ar: 'سعر العرض للزبون', en: 'Promo consumer', type: 'num' },
        { key: 'barcode', ar: 'الباركود', en: 'Barcode', type: 'text' },
      ],
    },
    closing: ['وتفضـلوا بقبـول فائـق الإحـترام والتقـدير ،،،'],
    signatory: SIGN.coop, signChoices: COOP_CHOICES,
  },

  /* ---------- 5b) Rent Debit Note (إشعار خصم إيجارات) ---------- */
  {
    k: 'rentdebit', ar: 'إشعار خصم — إيجارات', en: 'Rent Debit Note',
    group: 'coop', lang: 'ar', recipient: 'coop', debitFlow: false, valueMode: 'direct',
    subject: { ar: 'عمـل إشعـار خصـم', en: 'Debit Note' },
    intro: {
      ar: 'بالاشـارة الى الموضـوع اعـلاه، يرجـى من سيادتكم التكرم بالموافقـة على عمـل إشعـار خصم من حسـاب الشـركة المتحـدة المتميـزة للتجـارة العامـه للمـواد الغـذائية لديكـم بقيمـة ({value} د.ك) وذلك القيمة إيجـارات عن الفتـرة من {from} حتى {to} وذلك بنـاءً على العقـد المبـرم بيننا.',
      en: 'With reference to the above, kindly approve a debit note against the account of United Distinctive General Trading & Foodstuff Co. for (KD {value}) being rent for the period from {from} to {to}, as per the contract concluded between us.',
    },
    fields: [
      { key: 'from', ar: 'الفترة من', en: 'From', type: 'text' },
      { key: 'to', ar: 'حتى', en: 'To', type: 'text' },
      { key: 'value', ar: 'القيمة (د.ك)', en: 'Value (KD)', type: 'number' },
    ],
    closing: ['وتفضـلوا بقبـول فائـق الاحـترام والتقـدير،،،'],
    signatory: SIGN.coop,
  },

  /* ---------- 8a) UOC — supplementary items request to the Union (الكتاب الأول) ----------
   * Stage 1 of the new-item approval cycle: the company's letter to the Union
   * requesting approval of a supplementary item. Mirrors the real 10057/11677
   * letters exactly (subject "اصناف تكميلية", GM signatory راشد المنيع). */
  {
    k: 'uoc_supp', ar: 'طلب اعتماد أصناف تكميلية — الاتحاد', en: 'Union Supplementary Items',
    group: 'union', lang: 'ar', recipient: 'fixed', recipientFixed: 'إتحاد الجمعيات التعاونية الاستهلاكية',
    debitFlow: false, valueMode: 'none',
    subject: { ar: 'اصنـاف تكميليـة', en: 'Supplementary Items' },
    intro: {
      ar: 'بالإشـارة إلـى الموضـوع أعـلاه، يـرجـى من سيادتكم الموافقـة علـى الأصنـاف التكميليـة الموضحـة بالجـدول أدنـاه:',
      en: 'With reference to the above, kindly approve the supplementary items detailed in the table below:',
    },
    table: {
      title: { ar: 'الأصناف التكميلية', en: 'Items' },
      cols: [
        { key: 'item', ar: 'رقم الصنف', en: 'Item #', type: 'text' },
        { key: 'brand', ar: 'العلامة التجارية', en: 'Brand', type: 'text' },
        { key: 'name', ar: 'وصف الصنف', en: 'Description', type: 'text', wide: true },
        { key: 'origin', ar: 'المنشأ', en: 'Origin', type: 'text' },
        { key: 'pack', ar: 'الشد', en: 'Pack', type: 'text' },
        { key: 'coopCarton', ar: 'سعر شراء الجمعية من', en: 'Coop purchase', type: 'num' },
        { key: 'consPiece', ar: 'سعر البيع الحبة للمستهلك', en: 'Consumer piece', type: 'num' },
        { key: 'barcode', ar: 'الباركود', en: 'Barcode', type: 'text' },
      ],
    },
    closing: ['وتفضلـوا بقبـول فائـق الإحتـرام والتقديـر،،،'],
    signatory: SIGN.gm, signChoices: GM_CHOICES,
  },

  /* ---------- 8) UOC — price increase request to the Union ---------- */
  {
    k: 'uoc_union', ar: 'طلب زيادة أسعار — الاتحاد', en: 'Union Price Increase',
    group: 'union', lang: 'ar', recipient: 'fixed', recipientFixed: 'إتحاد الجمعيات التعاونية',
    debitFlow: false, valueMode: 'none',
    subject: { ar: 'طلب زيادة أسعـار', en: 'Price Increase Request' },
    intro: {
      ar: 'بالإشـارة إلـى الموضـوع أعـلاه، يـرجـى من سيادتكم التكرم بالموافقـة علـى طلب رفع السعر، حيث ان السعر المسجل لدى الاتحاد لم يتم تحديثه كما هو موضح بالجدول أدنـاه:',
      en: 'With reference to the above, kindly approve the price increase request as detailed below:',
    },
    table: {
      title: { ar: 'الأسعار', en: 'Prices' },
      cols: [
        { key: 'name', ar: 'الصنف', en: 'Item', type: 'text', wide: true },
        { key: 'barcode', ar: 'الباركود', en: 'Barcode', type: 'text' },
        { key: 'pack', ar: 'الشد', en: 'Pack', type: 'text' },
        { key: 'curSell', ar: 'الحالي - سعر البيع', en: 'Current sell', type: 'num' },
        { key: 'curCons', ar: 'الحالي - سعر المستهلك', en: 'Current cons.', type: 'num' },
        { key: 'newSell', ar: 'الجديد - سعر البيع', en: 'New sell', type: 'num' },
        { key: 'newCons', ar: 'الجديد - سعر المستهلك', en: 'New cons.', type: 'num' },
        { key: 'pct', ar: 'النسبة', en: '%', type: 'text' },
      ],
    },
    table2: {
      title: { ar: 'التعاميم', en: 'Circulars' },
      cols: [
        { key: 'circular', ar: 'رقم التعميم', en: 'Circular #', type: 'text' },
        { key: 'cdate', ar: 'تاريخ التعميم', en: 'Circular date', type: 'text' },
        { key: 'weight', ar: 'الوزن', en: 'Weight', type: 'text' },
        { key: 'gramPrice', ar: 'السعر بالجرام', en: 'Price/gram', type: 'text' },
      ],
    },
    closing: ['وتفضلـوا بقبـول فائـق الإحتـرام والتقديـر،،،'],
    signatory: SIGN.gm, signChoices: GM_CHOICES,
  },

  /* ---------- 8c) UOC — new items approval to the Union (اعتماد أصناف جديدة) ---------- */
  {
    k: 'uoc_newitems', ar: 'اعتماد أصناف جديدة — الاتحاد', en: 'Union New Items',
    group: 'union', lang: 'ar', recipient: 'fixed', recipientFixed: 'إتحاد الجمعيات التعاونية الاستهلاكية',
    debitFlow: false, valueMode: 'none',
    subject: { ar: 'اعتمـاد اصنـاف جديـدة', en: 'New Items Approval' },
    intro: {
      ar: 'بالإشـارة إلـى الموضـوع أعـلاه، يـرجـى من سيادتكم الموافقـة علـى اعتمـاد الأصنـاف الجديـدة الموضحـة بالجـدول أدنـاه:',
      en: 'With reference to the above, kindly approve the new items detailed in the table below:',
    },
    table: {
      title: { ar: 'الأصناف الجديدة', en: 'New items' },
      cols: [
        { key: 'item', ar: 'رقم الصنف', en: 'Item #', type: 'text' },
        { key: 'brand', ar: 'العلامة التجارية', en: 'Brand', type: 'text' },
        { key: 'name', ar: 'وصف الصنف', en: 'Description', type: 'text', wide: true },
        { key: 'origin', ar: 'المنشأ', en: 'Origin', type: 'text' },
        { key: 'pack', ar: 'الشد', en: 'Pack', type: 'text' },
        { key: 'coopCarton', ar: 'سعر شراء الجمعية', en: 'Coop purchase', type: 'num' },
        { key: 'consPiece', ar: 'سعر البيع الحبة للمستهلك', en: 'Consumer piece', type: 'num' },
        { key: 'barcode', ar: 'الباركود', en: 'Barcode', type: 'text' },
      ],
    },
    closing: ['وتفضلـوا بقبـول فائـق الإحتـرام والتقديـر،،،'],
    signatory: SIGN.gm, signChoices: GM_CHOICES,
  },

  /* ---------- 8d) UOC — data update to the Union (تحديث بيانات) ---------- */
  {
    k: 'uoc_dataupd', ar: 'تحديث بيانات — الاتحاد', en: 'Union Data Update',
    group: 'union', lang: 'ar', recipient: 'fixed', recipientFixed: 'إتحاد الجمعيات التعاونية الاستهلاكية',
    debitFlow: false, valueMode: 'none',
    subject: { ar: 'تحديـث بيانـات اصنـاف', en: 'Items Data Update' },
    intro: {
      ar: 'بالإشـارة إلـى الموضـوع أعـلاه، يـرجـى من سيادتكم الموافقـة علـى تحديـث بيانـات الأصنـاف الموضحـة بالجـدول أدنـاه:',
      en: 'With reference to the above, kindly approve the item-data update detailed in the table below:',
    },
    table: {
      title: { ar: 'تحديث البيانات', en: 'Data update' },
      cols: [
        { key: 'item', ar: 'رقم الصنف', en: 'Item #', type: 'text' },
        { key: 'name', ar: 'وصف الصنف', en: 'Description', type: 'text', wide: true },
        { key: 'barcodeOld', ar: 'الباركود الحالي', en: 'Old barcode', type: 'text' },
        { key: 'barcodeNew', ar: 'الباركود الجديد', en: 'New barcode', type: 'text' },
        { key: 'pack', ar: 'الشد', en: 'Pack', type: 'text' },
        { key: 'coopCarton', ar: 'سعر شراء الجمعية', en: 'Coop purchase', type: 'num' },
        { key: 'consPiece', ar: 'سعر البيع الحبة للمستهلك', en: 'Consumer piece', type: 'num' },
      ],
    },
    closing: ['وتفضلـوا بقبـول فائـق الإحتـرام والتقديـر،،،'],
    signatory: SIGN.gm, signChoices: GM_CHOICES,
  },

];

const SPEC_BY_KEY = Object.fromEntries(LETTER_SPECS.map((s) => [s.k, s]));

module.exports = { LETTER_SPECS, SPEC_BY_KEY, SIGN };
