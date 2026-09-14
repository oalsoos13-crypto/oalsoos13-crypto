'use strict';
// Contracts module: rich per-outlet / per-coop contracts with a period, multiple
// line-items (نسبة على العقد / مبلغ ثابت / دعم / أخرى) each tied to a space
// (مساحة), an installment/payment schedule (تسليم الدفعات) that can be entered
// manually or auto-split over the period, and addenda (ملاحق) linked to a base
// contract. Space types are a data-driven lookup (in-system or Excel import).
const express = require('express');
const XLSX = require('xlsx');
const db = require('../db');
const audit = require('../audit');
const { requireAuth, requireRole } = require('../auth');
const { asyncH, nowIso, badRequest } = require('../util');

const router = express.Router();
router.use(requireAuth);

const MGMT = ['marketing', 'division']; // (+admin always, via requireRole)
const clean = (v) => String(v == null ? '' : v).trim();
const num = (v, d = 0) => { const n = parseFloat(v); return isNaN(n) ? d : n; };
const cleanCoop = (p) => String(p || '').replace(/^P\d+\s*-\s*/i, '').trim();
const cleanOut = (n) => String(n || '').replace(/^\d+\s*-\s*/, '').trim();
const ITEM_TYPES = ['pct', 'amount', 'support', 'other'];

let AR = { coops: {}, outlets: {} };
try { AR = require('../outlet_ar.json'); } catch (e) { /* optional */ }

// ---- scope helpers -------------------------------------------------------
// Which co-ops a field user is limited to (null = unrestricted).
function scopeCoops(user) {
  if (!user || (user.role !== 'salesman' && user.role !== 'supervisor')) return null;
  const col = user.role === 'salesman' ? 'salesman_pf' : 'fsm_pf';
  const rows = db.prepare(`SELECT DISTINCT parent FROM outlets WHERE ${col} = ?`).all(user.username);
  return new Set(rows.map((r) => cleanCoop(r.parent)).filter(Boolean));
}
function scopeCustIds(user) {
  if (!user || (user.role !== 'salesman' && user.role !== 'supervisor')) return null;
  const col = user.role === 'salesman' ? 'salesman_pf' : 'fsm_pf';
  const rows = db.prepare(`SELECT cust_id FROM outlets WHERE ${col} = ?`).all(user.username);
  return new Set(rows.map((r) => r.cust_id));
}
function canEdit(user) { return user.role === 'admin' || MGMT.includes(user.role); }

// Attach a contract's items + installments and Arabic display names.
function hydrate(c) {
  const items = db.prepare('SELECT * FROM contract_items WHERE contract_id=? ORDER BY sort,id').all(c.id)
    .map((it) => ({
      id: it.id, itemType: it.item_type, spaceId: it.space_id, space: it.space,
      label: it.label, pct: it.pct, baseAmount: it.base_amount, amount: it.amount, note: it.note,
    }));
  const installments = db.prepare('SELECT * FROM contract_installments WHERE contract_id=? ORDER BY seq,id').all(c.id)
    .map((p) => ({ id: p.id, seq: p.seq, dueDate: p.due_date, amount: p.amount, status: p.status, paidDate: p.paid_date, note: p.note }));
  return {
    id: c.id, code: c.code, title: c.title, level: c.level, coop: c.coop,
    coopAr: AR.coops[c.coop] || '', custId: c.cust_id, period: { from: c.period_from, to: c.period_to },
    kind: c.kind, parentId: c.parent_id, note: c.note, status: c.status,
    createdAt: c.created_at, updatedAt: c.updated_at,
    items, installments,
    total: items.reduce((s, it) => s + (it.itemType === 'pct' ? (it.baseAmount * it.pct / 100) : it.amount), 0),
  };
}

// ---- spaces (مساحات) lookup ---------------------------------------------
router.get('/contracts/spaces', asyncH((req, res) => {
  const rows = db.prepare('SELECT * FROM contract_spaces ORDER BY sort,name').all();
  res.json({ spaces: rows.map((s) => ({ id: s.id, name: s.name, nameEn: s.name_en, note: s.note, active: !!s.active, sort: s.sort })) });
}));
router.post('/contracts/spaces', requireRole(...MGMT), asyncH((req, res) => {
  const name = clean(req.body.name);
  if (!name) throw badRequest('اسم المساحة مطلوب', 'BAD');
  const b = req.body;
  if (b.id) {
    db.prepare('UPDATE contract_spaces SET name=?,name_en=?,note=?,active=?,sort=? WHERE id=?')
      .run(name, clean(b.name_en), clean(b.note), b.active === false ? 0 : 1, num(b.sort, 0), b.id);
    res.json({ ok: true, id: b.id });
  } else {
    const r = db.prepare('INSERT INTO contract_spaces (name,name_en,note,active,sort) VALUES (?,?,?,?,?)')
      .run(name, clean(b.name_en), clean(b.note), b.active === false ? 0 : 1, num(b.sort, 0));
    res.json({ ok: true, id: r.lastInsertRowid });
  }
  audit.fromReq(req, 'contract.space.set', { entityType: 'contract_space', entityId: String(b.id || name), summary: `Space ${name}` });
}));
router.post('/contracts/spaces/delete', requireRole(...MGMT), asyncH((req, res) => {
  db.prepare('DELETE FROM contract_spaces WHERE id=?').run(req.body.id);
  res.json({ ok: true });
}));
// Bulk import space types from an Excel/CSV file. Reads the first text column as
// the Arabic name; a second column (if present) as name_en. One space per row.
router.post('/contracts/spaces/import', requireRole(...MGMT), asyncH((req, res) => {
  const b64 = req.body.contentB64 || req.body.file || req.body.data;
  if (!b64) throw badRequest('لم يتم إرفاق ملف', 'NO_FILE');
  const buf = Buffer.from(String(b64).replace(/^data:[^,]*,/, ''), 'base64');
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
  const wb = isZip ? XLSX.read(buf, { type: 'buffer' })
    : XLSX.read(buf.toString('utf8').replace(/^﻿/, ''), { type: 'string' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw badRequest('الملف فارغ', 'EMPTY');
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: false });
  let added = 0, maxSort = num(db.prepare('SELECT MAX(sort) m FROM contract_spaces').get().m, 0);
  const exists = new Set(db.prepare('SELECT name FROM contract_spaces').all().map((r) => r.name));
  const ins = db.prepare('INSERT INTO contract_spaces (name,name_en,note,active,sort) VALUES (?,?,?,1,?)');
  const tx = db.transaction(() => {
    for (const r of rows) {
      const name = clean(r[0]);
      if (!name || /مساح|space|name|الاسم/i.test(name)) continue; // skip header-ish rows
      if (exists.has(name)) continue;
      exists.add(name);
      ins.run(name, clean(r[1]), '', ++maxSort);
      added++;
    }
  });
  tx();
  audit.fromReq(req, 'contract.space.import', { entityType: 'contract_space', summary: `Imported ${added} spaces` });
  res.json({ ok: true, added });
}));

// Co-op -> outlets picker map, scoped to the user (all roles). Mirrors the
// letter recipient scope but is available to management too.
function pickerCoops(user) {
  let rows;
  if (user.role === 'salesman') {
    rows = db.prepare('SELECT cust_id, name, parent FROM outlets WHERE salesman_pf = ? ORDER BY parent,name').all(user.username);
  } else if (user.role === 'supervisor') {
    rows = db.prepare('SELECT cust_id, name, parent FROM outlets WHERE fsm_pf = ? ORDER BY parent,name').all(user.username);
  } else {
    rows = db.prepare('SELECT cust_id, name, parent FROM outlets ORDER BY parent,name').all();
  }
  const map = new Map();
  for (const r of rows) {
    const coop = cleanCoop(r.parent) || r.parent || '';
    if (!coop) continue;
    if (!map.has(coop)) map.set(coop, []);
    const nm = cleanOut(r.name) || r.name;
    map.get(coop).push({ custId: r.cust_id, name: nm, nameAr: AR.outlets[nm] || '' });
  }
  return [...map.entries()].map(([coop, outlets]) => ({ coop, coopAr: AR.coops[coop] || '', outlets }));
}

// ---- contracts -----------------------------------------------------------
router.get('/contracts', asyncH((req, res) => {
  const allowCoops = scopeCoops(req.user);
  const allowCust = scopeCustIds(req.user);
  let rows = db.prepare('SELECT * FROM contract_hdr ORDER BY created_at DESC, id DESC').all();
  if (allowCoops) {
    rows = rows.filter((c) => (c.level === 'outlet'
      ? (allowCust && allowCust.has(c.cust_id))
      : allowCoops.has(cleanCoop(c.coop))));
  }
  const spaces = db.prepare('SELECT id,name,name_en FROM contract_spaces WHERE active=1 ORDER BY sort,name').all()
    .map((s) => ({ id: s.id, name: s.name, nameEn: s.name_en }));
  res.json({ contracts: rows.map(hydrate), coops: pickerCoops(req.user), spaces, canEdit: canEdit(req.user) });
}));

// Auto-split a total into n equal installments across [from,to] (monthly steps).
function splitInstallments(total, n, from) {
  n = Math.max(1, Math.floor(n));
  const per = Math.round((total / n) * 1000) / 1000;
  const out = [];
  let start = from ? new Date(from) : null;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    let amt = i === n - 1 ? Math.round((total - acc) * 1000) / 1000 : per;
    acc += amt;
    let due = '';
    if (start && !isNaN(start)) {
      const d = new Date(start.getFullYear(), start.getMonth() + i, start.getDate());
      due = d.toISOString().slice(0, 10);
    }
    out.push({ seq: i + 1, dueDate: due, amount: amt });
  }
  return out;
}

// Create or update a contract with its nested items and installments.
router.post('/contracts', requireRole(...MGMT), asyncH((req, res) => {
  const b = req.body || {};
  const level = clean(b.level) === 'coop' ? 'coop' : 'outlet';
  const coop = cleanCoop(b.coop) || clean(b.coop);
  const cust_id = level === 'outlet' ? clean(b.custId || b.cust_id) : '';
  if (!coop) throw badRequest('الجمعية مطلوبة', 'BAD');
  if (level === 'outlet' && !cust_id) throw badRequest('المنفذ مطلوب لعقد المنفذ', 'BAD');
  const kind = clean(b.kind) === 'addendum' ? 'addendum' : 'base';
  const parent_id = kind === 'addendum' ? (num(b.parentId, 0) || null) : null;
  const now = nowIso();

  const items = Array.isArray(b.items) ? b.items : [];
  // Installments: explicit array, or auto-split when b.autoSplit is a count.
  let installments = Array.isArray(b.installments) ? b.installments : [];
  const total = items.reduce((s, it) => {
    const t = clean(it.itemType);
    return s + (t === 'pct' ? (num(it.baseAmount) * num(it.pct) / 100) : num(it.amount));
  }, 0);
  if ((!installments.length) && num(b.autoSplit, 0) > 0) {
    installments = splitInstallments(total, num(b.autoSplit), clean(b.periodFrom || (b.period && b.period.from)));
  }

  const hdr = {
    code: clean(b.code), title: clean(b.title), level, coop, cust_id,
    period_from: clean(b.periodFrom || (b.period && b.period.from)),
    period_to: clean(b.periodTo || (b.period && b.period.to)),
    kind, parent_id, note: clean(b.note),
    status: clean(b.status) === 'closed' ? 'closed' : 'active',
  };

  const tx = db.transaction(() => {
    let id = num(b.id, 0);
    if (id) {
      db.prepare(`UPDATE contract_hdr SET code=@code,title=@title,level=@level,coop=@coop,cust_id=@cust_id,
        period_from=@period_from,period_to=@period_to,kind=@kind,parent_id=@parent_id,note=@note,status=@status,
        updated_by=@by,updated_at=@now WHERE id=@id`).run({ ...hdr, by: req.user.id, now, id });
      db.prepare('DELETE FROM contract_items WHERE contract_id=?').run(id);
      db.prepare('DELETE FROM contract_installments WHERE contract_id=?').run(id);
    } else {
      const r = db.prepare(`INSERT INTO contract_hdr (code,title,level,coop,cust_id,period_from,period_to,kind,parent_id,note,status,created_by,created_at,updated_by,updated_at)
        VALUES (@code,@title,@level,@coop,@cust_id,@period_from,@period_to,@kind,@parent_id,@note,@status,@by,@now,@by,@now)`)
        .run({ ...hdr, by: req.user.id, now });
      id = r.lastInsertRowid;
    }
    const insIt = db.prepare(`INSERT INTO contract_items (contract_id,item_type,space_id,space,label,pct,base_amount,amount,note,sort)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    items.forEach((it, i) => {
      const t = ITEM_TYPES.includes(clean(it.itemType)) ? clean(it.itemType) : 'amount';
      insIt.run(id, t, num(it.spaceId, null) || null, clean(it.space), clean(it.label),
        num(it.pct), num(it.baseAmount), num(it.amount), clean(it.note), i);
    });
    const insP = db.prepare(`INSERT INTO contract_installments (contract_id,seq,due_date,amount,status,paid_date,note)
      VALUES (?,?,?,?,?,?,?)`);
    installments.forEach((p, i) => {
      insP.run(id, num(p.seq, i + 1), clean(p.dueDate), num(p.amount),
        clean(p.status) === 'paid' ? 'paid' : 'pending', clean(p.paidDate), clean(p.note));
    });
    return id;
  });
  const id = tx();
  audit.fromReq(req, 'contract.set', { entityType: 'contract', entityId: String(id), summary: `Contract ${hdr.code || id} (${coop})` });
  res.json({ ok: true, id, contract: hydrate(db.prepare('SELECT * FROM contract_hdr WHERE id=?').get(id)) });
}));

router.post('/contracts/:id/delete', requireRole(...MGMT), asyncH((req, res) => {
  const id = num(req.params.id, 0);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM contract_items WHERE contract_id=?').run(id);
    db.prepare('DELETE FROM contract_installments WHERE contract_id=?').run(id);
    db.prepare('DELETE FROM contract_hdr WHERE parent_id=?').run(id); // orphan addenda
    db.prepare('DELETE FROM contract_hdr WHERE id=?').run(id);
  });
  tx();
  audit.fromReq(req, 'contract.delete', { entityType: 'contract', entityId: String(id), summary: `Deleted contract ${id}` });
  res.json({ ok: true });
}));

// Toggle an installment paid/pending.
router.post('/contracts/installments/:id/pay', requireRole(...MGMT), asyncH((req, res) => {
  const id = num(req.params.id, 0);
  const paid = req.body.paid !== false;
  db.prepare('UPDATE contract_installments SET status=?, paid_date=? WHERE id=?')
    .run(paid ? 'paid' : 'pending', paid ? (clean(req.body.paidDate) || nowIso().slice(0, 10)) : '', id);
  res.json({ ok: true });
}));

module.exports = router;
