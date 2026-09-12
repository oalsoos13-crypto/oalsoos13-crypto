'use strict';
const express = require('express');
const XLSX = require('xlsx');
const db = require('../db');
const audit = require('../audit');
const { requireAuth, requireRole } = require('../auth');
const { asyncH, nowIso, num, badRequest } = require('../util');

const router = express.Router();

// GET /api/products — full catalog (any authenticated user, for the pickers).
router.get('/products', requireAuth, asyncH((req, res) => {
  const rows = db.prepare(
    'SELECT barcode, name, pack, origin, item, brand, cons_piece AS consPiece, coop_carton AS coopCarton FROM products ORDER BY name'
  ).all();
  res.json({ total: rows.length, products: rows });
}));

// Map a spreadsheet header cell to a known product field.
function classify(h) {
  const s = String(h || '').toLowerCase().trim();
  if (/باركود|barcode|ean|bar code/.test(s)) return 'barcode';
  if (/رقم الصنف|item\s*#|article|sku|كود|item code|product code/.test(s)) return 'item';
  if (/الصنف|اسم|name|description|desc|product/.test(s)) return 'name';
  if (/الشد|pack|شد/.test(s)) return 'pack';
  if (/المنشأ|المشأ|بلد|origin|country/.test(s)) return 'origin';
  if (/المستهلك|consumer|rsp|retail/.test(s)) return 'consPiece';
  if (/الجمعية|carton|coop|كرتون/.test(s)) return 'coopCarton';
  if (/براند|brand/.test(s)) return 'brand';
  return null;
}

// POST /api/products/import — admin uploads a CSV/XLSX (base64) product master.
// Body: { filename, contentB64, replace? }
router.post('/products/import', requireAuth, requireRole(), asyncH((req, res) => {
  const b64 = req.body.contentB64 || '';
  if (!b64) throw badRequest('لم يتم إرفاق ملف', 'NO_FILE');
  let wb;
  try {
    const buf = Buffer.from(b64.replace(/^data:[^,]*,/, ''), 'base64');
    wb = XLSX.read(buf, { type: 'buffer' });
  } catch (e) { throw badRequest('تعذّر قراءة الملف', 'BAD_FILE'); }
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw badRequest('الملف فارغ', 'EMPTY');
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });
  if (!rows.length) throw badRequest('الملف فارغ', 'EMPTY');

  // Find the header row (the row with the most classifiable cells, scanning the top 5).
  let hdrIdx = 0, best = -1, colMap = {};
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const map = {};
    rows[i].forEach((c, ci) => { const k = classify(c); if (k && !(k in map)) map[k] = ci; });
    const score = Object.keys(map).length;
    if (score > best) { best = score; hdrIdx = i; colMap = map; }
  }
  if (colMap.barcode == null || colMap.name == null) {
    throw badRequest('لم يتم العثور على أعمدة الباركود/الصنف في الملف', 'NO_COLS');
  }

  const now = nowIso();
  const upsert = db.prepare(`INSERT INTO products
    (barcode,name,pack,origin,item,brand,cons_piece,coop_carton,updated_at)
    VALUES (@barcode,@name,@pack,@origin,@item,@brand,@cons,@coop,@now)
    ON CONFLICT(barcode) DO UPDATE SET
      name=excluded.name, pack=excluded.pack, origin=excluded.origin, item=excluded.item,
      brand=excluded.brand, cons_piece=excluded.cons_piece, coop_carton=excluded.coop_carton, updated_at=excluded.updated_at`);
  const get = (r, k) => (colMap[k] != null ? r[colMap[k]] : '');
  let imported = 0, skipped = 0;
  const tx = db.transaction(() => {
    if (req.body.replace) db.prepare('DELETE FROM products').run();
    for (let i = hdrIdx + 1; i < rows.length; i++) {
      const r = rows[i];
      const barcode = String(get(r, 'barcode') || '').replace(/\.0$/, '').trim();
      const name = String(get(r, 'name') || '').trim();
      if (!/^\d{6,14}$/.test(barcode) || !name) { skipped++; continue; }
      const cons = get(r, 'consPiece'), coop = get(r, 'coopCarton');
      upsert.run({
        barcode, name,
        pack: String(get(r, 'pack') || '').trim(),
        origin: String(get(r, 'origin') || '').trim(),
        item: String(get(r, 'item') || '').trim(),
        brand: String(get(r, 'brand') || '').trim(),
        cons: cons === '' ? null : num(cons),
        coop: coop === '' ? null : num(coop),
        now,
      });
      imported++;
    }
  });
  tx();
  const total = db.prepare('SELECT COUNT(*) n FROM products').get().n;
  audit.fromReq(req, 'products.import', {
    entityType: 'products', summary: `Imported ${imported} products (${req.body.filename || 'file'})`,
    details: { imported, skipped, total, replace: !!req.body.replace },
  });
  res.json({ ok: true, imported, skipped, total });
}));

module.exports = router;
