'use strict';
// Price-increase module: price-update products, per-outlet rollout tracker, and
// products submitted for approval. All grids are editable and Excel-importable.
const express = require('express');
const XLSX = require('xlsx');
const db = require('../db');
const audit = require('../audit');
const { requireAuth, requireRole } = require('../auth');
const { asyncH, nowIso, badRequest } = require('../util');

const router = express.Router();
router.use(requireAuth);

const MGMT = ['marketing', 'division']; // (+admin always, via requireRole)

// ---- helpers -------------------------------------------------------------

// Outlets visible to the current user (scoped by PF for field roles).
function scopedOutlets(user) {
  if (user.role === 'salesman') {
    return db.prepare('SELECT cust_id, name, parent, fsm, salesman FROM outlets WHERE salesman_pf = ? ORDER BY parent, name').all(user.username);
  }
  if (user.role === 'supervisor') {
    return db.prepare('SELECT cust_id, name, parent, fsm, salesman FROM outlets WHERE fsm_pf = ? ORDER BY parent, name').all(user.username);
  }
  return db.prepare('SELECT cust_id, name, parent, fsm, salesman FROM outlets ORDER BY parent, name').all();
}
function myCustIds(user) {
  if (user.role !== 'salesman' && user.role !== 'supervisor') return null; // unrestricted
  return new Set(scopedOutlets(user).map((o) => o.cust_id));
}

// Read a base64 CSV/XLSX upload into an array-of-arrays.
function readGrid(b64) {
  if (!b64) throw badRequest('لم يتم إرفاق ملف', 'NO_FILE');
  const buf = Buffer.from(b64.replace(/^data:[^,]*,/, ''), 'base64');
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
  const wb = isZip ? XLSX.read(buf, { type: 'buffer', cellDates: true })
    : XLSX.read(buf.toString('utf8').replace(/^﻿/, ''), { type: 'string' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw badRequest('الملف فارغ', 'EMPTY');
  return XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '', raw: false });
}
const clean = (v) => String(v == null ? '' : v).trim();

// ================= PRICE-UPDATE PRODUCTS =================
router.get('/price-products', asyncH((req, res) => {
  const rows = db.prepare('SELECT * FROM price_products ORDER BY seq, name').all();
  res.json({ total: rows.length, products: rows });
}));

const upsertPriceProduct = db.prepare(`INSERT INTO price_products
  (barcode,item_no,name,name_ar,pack,origin,price_ctn_ptt,price_pec_ptt,price_pec_rsp,price_ctn_rcp,circular,circular_date,letter_lysal,seq,added_by,added_at)
  VALUES (@barcode,@item_no,@name,@name_ar,@pack,@origin,@price_ctn_ptt,@price_pec_ptt,@price_pec_rsp,@price_ctn_rcp,@circular,@circular_date,@letter_lysal,@seq,@added_by,@added_at)
  ON CONFLICT(barcode) DO UPDATE SET
    item_no=excluded.item_no, name=excluded.name, name_ar=excluded.name_ar, pack=excluded.pack, origin=excluded.origin,
    price_ctn_ptt=excluded.price_ctn_ptt, price_pec_ptt=excluded.price_pec_ptt, price_pec_rsp=excluded.price_pec_rsp,
    price_ctn_rcp=excluded.price_ctn_rcp, circular=excluded.circular, circular_date=excluded.circular_date,
    letter_lysal=excluded.letter_lysal`);

function priceProductRow(o, by, now, seq) {
  return {
    barcode: clean(o.barcode).replace(/\.0$/, ''), item_no: clean(o.itemNo || o.item_no),
    name: clean(o.name), name_ar: clean(o.nameAr || o.name_ar), pack: clean(o.pack), origin: clean(o.origin),
    price_ctn_ptt: clean(o.priceCtnPtt || o.price_ctn_ptt), price_pec_ptt: clean(o.pricePecPtt || o.price_pec_ptt),
    price_pec_rsp: clean(o.pricePecRsp || o.price_pec_rsp), price_ctn_rcp: clean(o.priceCtnRcp || o.price_ctn_rcp),
    circular: clean(o.circular), circular_date: clean(o.circularDate || o.circular_date),
    letter_lysal: clean(o.letterLysal || o.letter_lysal), seq: seq, added_by: by, added_at: now,
  };
}

// Add a single price-update product (management/admin).
router.post('/price-products', requireRole(...MGMT), asyncH((req, res) => {
  const b = req.body || {};
  const barcode = clean(b.barcode).replace(/\.0$/, '');
  if (!/^\d{6,14}$/.test(barcode)) throw badRequest('باركود غير صحيح', 'BAD_BARCODE');
  const now = nowIso();
  const maxSeq = db.prepare('SELECT MAX(seq) m FROM price_products').get().m || 0;
  upsertPriceProduct.run(priceProductRow(b, req.user.id, now, b.seq ? +b.seq : maxSeq + 1));
  audit.fromReq(req, 'price.product.add', { entityType: 'price_product', entityId: barcode, summary: `Price product ${barcode}` });
  res.json({ ok: true, barcode });
}));

// Bulk import price-update products from the DATA-sheet layout.
router.post('/price-products/import', requireRole(...MGMT), asyncH((req, res) => {
  const rows = readGrid(req.body.contentB64);
  // find header row (has barcode + name columns)
  let hdr = -1, map = {};
  const classify = (h) => {
    const s = clean(h).toLowerCase();
    if (/باركود|barcode/.test(s)) return 'barcode';
    if (/رقم الصنف|item\s*no|item#/.test(s)) return 'itemNo';
    if (/item-?\s*name|english/.test(s)) return 'name';
    if (/اسم الصنف|أسم/.test(s)) return 'nameAr';
    if (/الشد|pack/.test(s)) return 'pack';
    if (/المنشأ|origin/.test(s)) return 'origin';
    if (/ctn\s*ptt/.test(s)) return 'priceCtnPtt';
    if (/pec\s*ptt/.test(s)) return 'pricePecPtt';
    if (/pec\s*rsp/.test(s)) return 'pricePecRsp';
    if (/ctn\s*rcp/.test(s)) return 'priceCtnRcp';
    if (/تاريخ التعميم|circular date/.test(s)) return 'circularDate';
    if (/رقم التعميم|circular/.test(s)) return 'circular';
    if (/رقم الكتاب|lysal|letter/.test(s)) return 'letterLysal';
    return null;
  };
  for (let i = 0; i < Math.min(6, rows.length); i++) {
    const m = {}; rows[i].forEach((c, ci) => { const k = classify(c); if (k && !(k in m)) m[k] = ci; });
    if (m.barcode != null && (m.name != null || m.nameAr != null)) { hdr = i; map = m; break; }
  }
  if (hdr < 0) throw badRequest('لم يتم العثور على أعمدة الباركود/الصنف', 'NO_COLS');
  const get = (r, k) => (map[k] != null ? r[map[k]] : '');
  const now = nowIso();
  let n = 0; const base = db.prepare('SELECT MAX(seq) m FROM price_products').get().m || 0;
  const tx = db.transaction(() => {
    for (let i = hdr + 1; i < rows.length; i++) {
      const r = rows[i]; const bc = clean(get(r, 'barcode')).replace(/\.0$/, '');
      if (!/^\d{6,14}$/.test(bc)) continue;
      const o = {}; Object.keys(map).forEach((k) => { o[k] = get(r, k); });
      upsertPriceProduct.run(priceProductRow(o, req.user.id, now, base + (++n)));
    }
  });
  tx();
  audit.fromReq(req, 'price.product.import', { entityType: 'price_product', summary: `Imported ${n} price products` });
  res.json({ ok: true, imported: n, total: db.prepare('SELECT COUNT(*) n FROM price_products').get().n });
}));

router.delete('/price-products/:barcode', requireRole(...MGMT), asyncH((req, res) => {
  db.prepare('DELETE FROM price_products WHERE barcode = ?').run(req.params.barcode);
  db.prepare('DELETE FROM price_track WHERE barcode = ?').run(req.params.barcode);
  res.json({ ok: true });
}));

// ================= PRICE-INCREASE TRACKER =================
const TRACK_FIELDS = ['book_printing', 'upd', 'date_update', 'dn_number', 'dn_type', 'dn_amount', 'date_sales_new', 'branch_connection', 'supply_branch', 'branch_supply_date', 'stock'];

router.get('/price-track', asyncH((req, res) => {
  const products = db.prepare('SELECT barcode, name, name_ar, pack, circular, circular_date, letter_lysal, seq FROM price_products ORDER BY seq, name').all();
  const outlets = scopedOutlets(req.user);
  const ids = new Set(outlets.map((o) => o.cust_id));
  const cells = {};
  db.prepare('SELECT * FROM price_track').all().forEach((t) => {
    if (!ids.has(t.cust_id)) return; // only cells for outlets the user can see
    cells[t.barcode + '|' + t.cust_id] = t;
  });

  // Auto-fill D.N fields from approved price-increase letters (same outlet+product).
  const TYPE_LABEL = { changeprice: 'تحديث سعر', priceupd: 'تحديث بيانات', uoc_union: 'زيادة أسعار - اتحاد' };
  const cc = (p) => String(p || '').replace(/^P\d+\s*-\s*/i, '').trim();
  const coopOutlets = {};
  outlets.forEach((o) => { const c = cc(o.parent); (coopOutlets[c] = coopOutlets[c] || []).push(o.cust_id); });
  const appr = db.prepare("SELECT lysal, type, value, items, cust_id, coop FROM letters WHERE approval='approved' AND type IN ('changeprice','priceupd','uoc_union') ORDER BY created_at ASC").all();
  for (const L of appr) {
    let its = []; try { its = JSON.parse(L.items || '[]'); } catch (e) { /* skip */ }
    const barcodes = its.map((it) => String(it.barcode || it.barcodeNew || '').replace(/\.0$/, '')).filter((b) => /^\d{6,14}$/.test(b));
    if (!barcodes.length) continue;
    const targets = L.cust_id ? [L.cust_id] : (coopOutlets[L.coop] || []);
    const info = { dn_number: L.lysal || '', dn_type: TYPE_LABEL[L.type] || L.type, dn_amount: L.value != null ? String(L.value) : '' };
    for (const b of barcodes) for (const cid of targets) {
      if (!ids.has(cid)) continue;
      const key = b + '|' + cid;
      const cur = cells[key] || { barcode: b, cust_id: cid };
      ['dn_number', 'dn_type', 'dn_amount'].forEach((f) => { if (!cur[f]) cur[f] = info[f]; });
      cur._autoDn = true;
      cells[key] = cur;
    }
  }
  res.json({ products, outlets, cells });
}));

const upsertTrack = db.prepare(`INSERT INTO price_track
  (barcode,cust_id,book_printing,upd,date_update,dn_number,dn_type,dn_amount,date_sales_new,branch_connection,supply_branch,branch_supply_date,stock,updated_by,updated_at)
  VALUES (@barcode,@cust_id,@book_printing,@upd,@date_update,@dn_number,@dn_type,@dn_amount,@date_sales_new,@branch_connection,@supply_branch,@branch_supply_date,@stock,@updated_by,@updated_at)
  ON CONFLICT(barcode,cust_id) DO UPDATE SET
    book_printing=excluded.book_printing, upd=excluded.upd, date_update=excluded.date_update,
    dn_number=excluded.dn_number, dn_type=excluded.dn_type, dn_amount=excluded.dn_amount,
    date_sales_new=excluded.date_sales_new, branch_connection=excluded.branch_connection,
    supply_branch=excluded.supply_branch, branch_supply_date=excluded.branch_supply_date,
    stock=excluded.stock, updated_by=excluded.updated_by, updated_at=excluded.updated_at`);

// Save one tracker cell (product x outlet). Field users limited to own outlets.
router.post('/price-track/cell', requireRole('salesman', 'supervisor', ...MGMT), asyncH((req, res) => {
  const b = req.body || {};
  const barcode = clean(b.barcode), cust_id = clean(b.cust_id);
  if (!barcode || !cust_id) throw badRequest('بيانات ناقصة', 'BAD');
  const mine = myCustIds(req.user);
  if (mine && !mine.has(cust_id)) throw badRequest('هذا المنفذ خارج نطاقك', 'SCOPE');
  const row = { barcode, cust_id, updated_by: req.user.id, updated_at: nowIso() };
  TRACK_FIELDS.forEach((f) => { row[f] = clean(b[f]); });
  upsertTrack.run(row);
  res.json({ ok: true });
}));

// Bulk import tracker rows (long format: barcode, cust_id + the 11 fields).
router.post('/price-track/import', requireRole('salesman', 'supervisor', ...MGMT), asyncH((req, res) => {
  const rows = readGrid(req.body.contentB64);
  const classify = (h) => {
    const s = clean(h).toLowerCase();
    if (/باركود|barcode/.test(s)) return 'barcode';
    if (/cust|كود المنفذ|cust id|custid/.test(s)) return 'cust_id';
    if (/book printing|طباعة/.test(s)) return 'book_printing';
    if (/date update|تاريخ التحديث/.test(s)) return 'date_update';
    if (/^update$|تحديث/.test(s)) return 'upd';
    if (/d\.?n number|رقم الاشعار|رقم الإشعار/.test(s)) return 'dn_number';
    if (/d\.?n type|نوع الاشعار|نوع الإشعار/.test(s)) return 'dn_type';
    if (/d\.?n amount|قيمة الاشعار|قيمة الإشعار|amount/.test(s)) return 'dn_amount';
    if (/sales at new price|البيع بالسعر/.test(s)) return 'date_sales_new';
    if (/branch connection|ربط الفرع/.test(s)) return 'branch_connection';
    if (/supply to the branch|توريد/.test(s)) return 'supply_branch';
    if (/branch supply date|تاريخ التوريد/.test(s)) return 'branch_supply_date';
    if (/stock|مخزون/.test(s)) return 'stock';
    return null;
  };
  let hdr = -1, map = {};
  for (let i = 0; i < Math.min(4, rows.length); i++) {
    const m = {}; rows[i].forEach((c, ci) => { const k = classify(c); if (k && !(k in m)) m[k] = ci; });
    if (m.barcode != null && m.cust_id != null) { hdr = i; map = m; break; }
  }
  if (hdr < 0) throw badRequest('يجب أن يحوي الملف عمودي الباركود وكود المنفذ (Barcode, Cust ID)', 'NO_COLS');
  const get = (r, k) => (map[k] != null ? clean(r[map[k]]) : '');
  const mine = myCustIds(req.user);
  const now = nowIso(); let n = 0;
  const tx = db.transaction(() => {
    for (let i = hdr + 1; i < rows.length; i++) {
      const r = rows[i]; const barcode = get(r, 'barcode').replace(/\.0$/, ''); const cust_id = get(r, 'cust_id');
      if (!barcode || !cust_id) continue;
      if (mine && !mine.has(cust_id)) continue;
      const row = { barcode, cust_id, updated_by: req.user.id, updated_at: now };
      TRACK_FIELDS.forEach((f) => { row[f] = get(r, f); });
      upsertTrack.run(row); n++;
    }
  });
  tx();
  audit.fromReq(req, 'price.track.import', { entityType: 'price_track', summary: `Imported ${n} tracker rows` });
  res.json({ ok: true, imported: n });
}));

// ================= PRODUCTS TO APPROVE =================
router.get('/approve-products', asyncH((req, res) => {
  const rows = db.prepare('SELECT * FROM approve_products ORDER BY added_at DESC').all();
  res.json({ total: rows.length, products: rows });
}));

const upsertApprove = db.prepare(`INSERT INTO approve_products
  (barcode,name,name_ar,pack,origin,cons_piece,coop_carton,note,status,added_by,added_at)
  VALUES (@barcode,@name,@name_ar,@pack,@origin,@cons_piece,@coop_carton,@note,@status,@added_by,@added_at)
  ON CONFLICT(barcode) DO UPDATE SET
    name=excluded.name, name_ar=excluded.name_ar, pack=excluded.pack, origin=excluded.origin,
    cons_piece=excluded.cons_piece, coop_carton=excluded.coop_carton, note=excluded.note`);

function approveRow(o, by, now) {
  return {
    barcode: clean(o.barcode).replace(/\.0$/, ''), name: clean(o.name), name_ar: clean(o.nameAr || o.name_ar),
    pack: clean(o.pack), origin: clean(o.origin), cons_piece: clean(o.consPiece || o.cons_piece),
    coop_carton: clean(o.coopCarton || o.coop_carton), note: clean(o.note),
    status: clean(o.status) || 'pending', added_by: by, added_at: now,
  };
}

router.post('/approve-products', requireRole('salesman', 'supervisor', ...MGMT), asyncH((req, res) => {
  const b = req.body || {};
  const barcode = clean(b.barcode).replace(/\.0$/, '');
  if (!/^\d{6,14}$/.test(barcode)) throw badRequest('باركود غير صحيح', 'BAD_BARCODE');
  upsertApprove.run(approveRow(b, req.user.id, nowIso()));
  audit.fromReq(req, 'approve.product.add', { entityType: 'approve_product', entityId: barcode, summary: `Approve product ${barcode}` });
  res.json({ ok: true, barcode });
}));

router.post('/approve-products/import', requireRole('salesman', 'supervisor', ...MGMT), asyncH((req, res) => {
  const rows = readGrid(req.body.contentB64);
  const classify = (h) => {
    const s = clean(h).toLowerCase();
    if (/باركود|barcode/.test(s)) return 'barcode';
    if (/item-?\s*name|english/.test(s)) return 'name';
    if (/اسم|name|صنف/.test(s)) return 'nameAr';
    if (/الشد|pack/.test(s)) return 'pack';
    if (/المنشأ|origin/.test(s)) return 'origin';
    if (/مستهلك|consumer|rsp/.test(s)) return 'consPiece';
    if (/الجمعية|coop|carton/.test(s)) return 'coopCarton';
    if (/ملاحظ|note/.test(s)) return 'note';
    return null;
  };
  let hdr = -1, map = {};
  for (let i = 0; i < Math.min(6, rows.length); i++) {
    const m = {}; rows[i].forEach((c, ci) => { const k = classify(c); if (k && !(k in m)) m[k] = ci; });
    if (m.barcode != null) { hdr = i; map = m; break; }
  }
  if (hdr < 0) throw badRequest('لم يتم العثور على عمود الباركود', 'NO_COLS');
  const get = (r, k) => (map[k] != null ? r[map[k]] : '');
  const now = nowIso(); let n = 0;
  const tx = db.transaction(() => {
    for (let i = hdr + 1; i < rows.length; i++) {
      const r = rows[i]; const bc = clean(get(r, 'barcode')).replace(/\.0$/, '');
      if (!/^\d{6,14}$/.test(bc)) continue;
      const o = {}; Object.keys(map).forEach((k) => { o[k] = get(r, k); });
      upsertApprove.run(approveRow(o, req.user.id, now)); n++;
    }
  });
  tx();
  audit.fromReq(req, 'approve.product.import', { entityType: 'approve_product', summary: `Imported ${n} approve products` });
  res.json({ ok: true, imported: n, total: db.prepare('SELECT COUNT(*) n FROM approve_products').get().n });
}));

router.delete('/approve-products/:barcode', requireRole('salesman', 'supervisor', ...MGMT), asyncH((req, res) => {
  db.prepare('DELETE FROM approve_products WHERE barcode = ?').run(req.params.barcode);
  res.json({ ok: true });
}));

module.exports = router;
// Exported for the letter route to auto-add price-increase items to the tracker.
module.exports.addPriceProductsFromItems = function (items, letterLysal, userId) {
  if (!Array.isArray(items) || !items.length) return;
  const now = nowIso();
  const base = db.prepare('SELECT MAX(seq) m FROM price_products').get().m || 0;
  let n = 0;
  const tx = db.transaction(() => {
    for (const it of items) {
      const bc = clean(it.barcode || it.barcodeNew).replace(/\.0$/, '');
      if (!/^\d{6,14}$/.test(bc)) continue;
      const exists = db.prepare('SELECT 1 FROM price_products WHERE barcode = ?').get(bc);
      if (exists) continue;
      const coop = [it.coopCarton, it.newSell, it.coopNew].find((v) => v != null && v !== '');
      const cons = [it.consPiece, it.newCons, it.consNew].find((v) => v != null && v !== '');
      upsertPriceProduct.run(priceProductRow({
        barcode: bc, name: it.name || '', pack: it.pack || '',
        priceCtnRcp: coop != null ? coop : '', pricePecRsp: cons != null ? cons : '',
        circular: it.circular || '', circularDate: it.cdate || '', letterLysal: letterLysal || '',
      }, userId, now, base + (++n)));
    }
  });
  tx();
};
