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
  ramiz: { role: 'مدير المبيعات', name: 'محمد اقبال' },
  gm: { role: 'المدير العام', name: 'راشد المنيع' },
  smkt: { role: 'Sales Manager – SMKT', name: 'Muhammad Adnan Iqbal' },
  ecom: { role: 'Sales Manager – SMKT & E-Commerce', name: 'Muhammad Adnan Iqbal' },
};

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
    k: 'rentstand', ar: 'إيجار استاند', en: 'Rent Stand',
    group: 'coop', lang: 'ar', recipient: 'coop', debitFlow: false, valueMode: 'direct',
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
      { key: 'value', ar: 'القيمة (د.ك)', en: 'Value (KD)', type: 'number' },
    ],
    closing: ['وتفضـلوا بقبـول فائـق الاحـترام والتقـدير،،،'],
    signatory: SIGN.coop,
  },

  /* ---------- 11) Ramiz — new items (اعتماد أصناف جديدة) ---------- */
  {
    k: 'ramiz', ar: 'رامز — اعتماد أصناف جديدة', en: 'Ramiz — New Items',
    group: 'market', lang: 'ar', recipient: 'free', recipientDefault: 'سوق رامز المركزي',
    debitFlow: false, valueMode: 'none',
    subject: { ar: 'اعتماد اصناف جديدة', en: 'New Items Approval' },
    intro: {
      ar: 'يسر الشركة المتحدة المتميزة تعديل اسعار منتجاتنا ليتم اعتمادها لديكم في افرع اسواقكم.',
      en: 'United Distinctive Co. is pleased to update our product prices for approval in your outlets.',
    },
    table: {
      title: { ar: 'الأصناف', en: 'Items' },
      cols: [
        { key: 'name', ar: 'الصنف بالعربي', en: 'Item', type: 'text', wide: true },
        { key: 'barcodeOld', ar: 'الباركود الحالي', en: 'Old barcode', type: 'text' },
        { key: 'barcodeNew', ar: 'الباركود الجديد', en: 'New barcode', type: 'text' },
        { key: 'costOld', ar: 'التكلفة الحالية', en: 'Old cost', type: 'num' },
        { key: 'costNew', ar: 'التكلفة الجديدة', en: 'New cost', type: 'num' },
        { key: 'price', ar: 'سعر البيع', en: 'Sell price', type: 'num' },
      ],
    },
    closing: ['نرجو اعتماد الاصناف اعلاه في اقرب وقت .', 'و تقبلوا فائق الاحترام و التقدير'],
    signatory: SIGN.ramiz,
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
    signatory: SIGN.gm,
  },

  /* ---------- 7) Promo Support Debit Note (English) ---------- */
  {
    k: 'promo', ar: 'دعم برومو (Promo Support DN)', en: 'Promo Support DN',
    group: 'export', lang: 'en', recipient: 'free', debitFlow: false, valueMode: 'sum:amount',
    subject: { ar: '[{principal}] Promo Support for {period}', en: '[{principal}] Promo Support for {period}' },
    intro: {
      ar: 'As agreed, we confirm KD {value}/- as the promo support for {period}.',
      en: 'As agreed, we confirm KD {value}/- as the promo support for {period}.',
    },
    fields: [
      { key: 'dept', ar: 'القسم', en: 'Department', type: 'text' },
      { key: 'principal', ar: 'Principal', en: 'Principal', type: 'text' },
      { key: 'period', ar: 'الفترة', en: 'Period', type: 'text' },
    ],
    table: {
      title: { ar: 'التفاصيل', en: 'Details' },
      cols: [
        { key: 'desc', ar: 'Description', en: 'Description', type: 'text', wide: true },
        { key: 'amount', ar: 'Amount (KD)', en: 'Amount (KD)', type: 'num' },
      ],
    },
    closing: ['Thanks, and Regards.'],
    signatory: SIGN.ecom,
  },

  /* ---------- 6) Credit Note (English) ---------- */
  {
    k: 'credit', ar: 'إشعار دائن (Credit Note)', en: 'Credit Note',
    group: 'export', lang: 'en', recipient: 'free', debitFlow: false, valueMode: 'sum:amount',
    subject: { ar: 'Credit Note {title}', en: 'Credit Note {title}' },
    intro: {
      ar: 'We are pleased to submit this credit note against {reason}:',
      en: 'We are pleased to submit this credit note against {reason}:',
    },
    fields: [
      { key: 'title', ar: 'العميل/العنوان', en: 'Title', type: 'text' },
      { key: 'reason', ar: 'السبب', en: 'Reason', type: 'text' },
      { key: 'settled', ar: 'ملاحظة التسوية', en: 'Settlement note', type: 'text' },
    ],
    table: {
      title: { ar: 'التفاصيل', en: 'Details' },
      cols: [
        { key: 'desc', ar: 'Details', en: 'Details', type: 'text', wide: true },
        { key: 'amount', ar: 'Amounts (KD)', en: 'Amounts (KD)', type: 'num' },
      ],
    },
    closing: ['Kind Regards,'],
    signatory: SIGN.smkt,
  },

  /* ---------- 9) IFA — Promo Price Support (English) ---------- */
  {
    k: 'ifa', ar: 'IFA — دعم سعر برومو', en: 'IFA Promo Price Support',
    group: 'export', lang: 'en', recipient: 'free', debitFlow: false, valueMode: 'sum:pdTotal',
    subject: { ar: 'PROMO PRICE SUPPORT.', en: 'PROMO PRICE SUPPORT.' },
    intro: {
      ar: 'As agreed, we confirm KD {value}/- as promo price support during the promotion from {from} till {to} for the below items.',
      en: 'As agreed, we confirm KD {value}/- as promo price support during the promotion from {from} till {to} for the below items.',
    },
    fields: [
      { key: 'attn', ar: 'Attn', en: 'Attn', type: 'text' },
      { key: 'from', ar: 'من', en: 'From', type: 'text' },
      { key: 'to', ar: 'إلى', en: 'To', type: 'text' },
    ],
    table: {
      title: { ar: 'Items', en: 'Items' },
      cols: [
        { key: 'promoDate', ar: 'PROMO DATE', en: 'PROMO DATE', type: 'text' },
        { key: 'article', ar: 'ARTICLE', en: 'ARTICLE', type: 'text' },
        { key: 'desc', ar: 'DESCRIPTION', en: 'DESCRIPTION', type: 'text', wide: true },
        { key: 'cpMap', ar: 'CP/MAP', en: 'CP/MAP', type: 'num' },
        { key: 'promoRsp', ar: 'PROMO RSP', en: 'PROMO RSP', type: 'num' },
        { key: 'pdUnit', ar: 'PD Value', en: 'PD Value', type: 'num' },
        { key: 'soldQty', ar: 'SOLD QTY', en: 'SOLD QTY', type: 'num' },
        { key: 'pdTotal', ar: 'PD Total', en: 'PD Total', type: 'num' },
      ],
    },
    closing: ['Thanks, and Regards'],
    signatory: SIGN.smkt,
  },

  /* ---------- 10) Addendum (English) ---------- */
  {
    k: 'addendum', ar: 'ملحق اتفاقية (Addendum)', en: 'Addendum',
    group: 'export', lang: 'en', recipient: 'free', debitFlow: false, valueMode: 'none',
    subject: { ar: 'Business Agreement Addendum', en: 'Business Agreement Addendum' },
    intro: {
      ar: 'Please find below the agreed counter-parts, to be attached as an addendum to the original business agreement:',
      en: 'Please find below the agreed counter-parts, to be attached as an addendum to the original business agreement:',
    },
    table: {
      title: { ar: 'Rebate Break-down', en: 'Rebate Break-down' },
      cols: [
        { key: 'item', ar: 'Item', en: 'Item', type: 'text' },
        { key: 'rebate', ar: 'Rebate', en: 'Rebate', type: 'text' },
        { key: 'counter', ar: 'Counter parts', en: 'Counter parts', type: 'text', wide: true },
      ],
    },
    closing: ['Regards,'],
    signatory: { role: '', name: '' },
  },
];

const SPEC_BY_KEY = Object.fromEntries(LETTER_SPECS.map((s) => [s.k, s]));

module.exports = { LETTER_SPECS, SPEC_BY_KEY, SIGN };
