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
      id: it.id, scope: it.scope, custId: it.cust_id, spaceId: it.space_id, space: it.space,
      count: it.count, dimensions: it.dimensions, category: it.category, location: it.location,
      amount: it.amount, description: it.description, note: it.note,
    }));
  const installments = db.prepare('SELECT * FROM contract_installments WHERE contract_id=? ORDER BY seq,id').all(c.id)
    .map((p) => ({ id: p.id, seq: p.seq, dueDate: p.due_date, amount: p.amount, status: p.status, paidDate: p.paid_date, note: p.note }));
  return {
    id: c.id, code: c.code, title: c.title, subjectYear: c.subject_year,
    isRenewal: !!c.is_renewal, partyRep: c.party_rep, contractDate: c.contract_date,
    level: c.level, coop: c.coop, coopAr: AR.coops[c.coop] || '', custId: c.cust_id,
    period: { from: c.period_from, to: c.period_to }, renewable: !!c.renewable,
    valueMode: c.value_mode || 'lump', value: c.value, pct: c.pct,
    payFreq: c.pay_freq || 'once', bonusTerms: c.bonus_terms,
    valueKind: c.value_kind, graceDays: c.grace_days, payWithin: c.pay_within,
    kind: c.kind, parentId: c.parent_id, note: c.note, status: c.status,
    createdAt: c.created_at, updatedAt: c.updated_at,
    items, installments, total: c.value,
  };
}
const SCOPES = ['main', 'branches', 'outlet', 'all'];
const VALUE_KINDS = ['rent', 'support', 'cda', 'marketing', 'other'];
const PAY_FREQS = ['once', 'monthly', 'quarterly', 'semiannual', 'yearly'];

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

// Months (inclusive) between two YYYY-MM-DD dates; 0 if unparseable.
function monthsInclusive(from, to) {
  const a = from ? new Date(from) : null; const z = to ? new Date(to) : null;
  if (!a || !z || isNaN(a) || isNaN(z)) return 0;
  return (z.getFullYear() * 12 + z.getMonth()) - (a.getFullYear() * 12 + a.getMonth()) + 1;
}
// Auto-split a total into n equal installments across [from,to] (monthly steps).
function splitInstallments(total, n, from) {
  n = Math.max(1, Math.floor(n));
  const per = Math.round((total / n) * 1000) / 1000;
  const out = [];
  const start = from ? new Date(from) : null;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const amt = i === n - 1 ? Math.round((total - acc) * 1000) / 1000 : per;
    acc += amt;
    let due = '';
    if (start && !isNaN(start)) due = new Date(start.getFullYear(), start.getMonth() + i, start.getDate()).toISOString().slice(0, 10);
    out.push({ seq: i + 1, dueDate: due, amount: amt });
  }
  return out;
}

// Create or update a contract with its space placements and installments.
router.post('/contracts', requireRole(...MGMT), asyncH((req, res) => {
  const b = req.body || {};
  const level = clean(b.level) === 'outlet' ? 'outlet' : 'coop';
  const coop = cleanCoop(b.coop) || clean(b.coop);
  const cust_id = level === 'outlet' ? clean(b.custId || b.cust_id) : '';
  if (!coop) throw badRequest('الجمعية مطلوبة', 'BAD');
  if (level === 'outlet' && !cust_id) throw badRequest('المنفذ مطلوب لعقد المنفذ', 'BAD');
  const kind = clean(b.kind) === 'addendum' ? 'addendum' : 'base';
  const parent_id = kind === 'addendum' ? (num(b.parentId, 0) || null) : null;
  const now = nowIso();
  const value = num(b.value, 0);

  const items = Array.isArray(b.items) ? b.items : [];
  let installments = Array.isArray(b.installments) ? b.installments : [];
  if ((!installments.length) && num(b.autoSplit, 0) > 0) {
    installments = splitInstallments(value, num(b.autoSplit), clean(b.periodFrom || (b.period && b.period.from)));
  }

  const hdr = {
    code: clean(b.code), title: clean(b.title), subject_year: clean(b.subjectYear),
    is_renewal: b.isRenewal ? 1 : 0, party_rep: clean(b.partyRep), contract_date: clean(b.contractDate),
    level, coop, cust_id,
    period_from: clean(b.periodFrom || (b.period && b.period.from)),
    period_to: clean(b.periodTo || (b.period && b.period.to)),
    renewable: b.renewable === false ? 0 : 1,
    value_mode: clean(b.valueMode) === 'pct' ? 'pct' : 'lump',
    value, pct: num(b.pct, 0),
    pay_freq: PAY_FREQS.includes(clean(b.payFreq)) ? clean(b.payFreq) : 'once',
    bonus_terms: clean(b.bonusTerms),
    value_kind: VALUE_KINDS.includes(clean(b.valueKind)) ? clean(b.valueKind) : 'rent',
    grace_days: num(b.graceDays, 45), pay_within: num(b.payWithin, 14),
    kind, parent_id, note: clean(b.note),
    status: clean(b.status) === 'closed' ? 'closed' : 'active',
  };

  const tx = db.transaction(() => {
    let id = num(b.id, 0);
    if (id) {
      db.prepare(`UPDATE contract_hdr SET code=@code,title=@title,subject_year=@subject_year,is_renewal=@is_renewal,
        party_rep=@party_rep,contract_date=@contract_date,level=@level,coop=@coop,cust_id=@cust_id,
        period_from=@period_from,period_to=@period_to,renewable=@renewable,value_mode=@value_mode,value=@value,pct=@pct,
        pay_freq=@pay_freq,bonus_terms=@bonus_terms,value_kind=@value_kind,
        grace_days=@grace_days,pay_within=@pay_within,kind=@kind,parent_id=@parent_id,note=@note,status=@status,
        updated_by=@by,updated_at=@now WHERE id=@id`).run({ ...hdr, by: req.user.id, now, id });
      db.prepare('DELETE FROM contract_items WHERE contract_id=?').run(id);
      db.prepare('DELETE FROM contract_installments WHERE contract_id=?').run(id);
    } else {
      const r = db.prepare(`INSERT INTO contract_hdr (code,title,subject_year,is_renewal,party_rep,contract_date,
        level,coop,cust_id,period_from,period_to,renewable,value_mode,value,pct,pay_freq,bonus_terms,value_kind,
        grace_days,pay_within,kind,parent_id,note,status,created_by,created_at,updated_by,updated_at)
        VALUES (@code,@title,@subject_year,@is_renewal,@party_rep,@contract_date,@level,@coop,@cust_id,@period_from,@period_to,
        @renewable,@value_mode,@value,@pct,@pay_freq,@bonus_terms,@value_kind,@grace_days,@pay_within,@kind,@parent_id,@note,@status,
        @by,@now,@by,@now)`)
        .run({ ...hdr, by: req.user.id, now });
      id = r.lastInsertRowid;
    }
    const insIt = db.prepare(`INSERT INTO contract_items (contract_id,scope,cust_id,space_id,space,count,dimensions,category,location,amount,description,note,sort)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    items.forEach((it, i) => {
      const sc = SCOPES.includes(clean(it.scope)) ? clean(it.scope) : 'main';
      insIt.run(id, sc, sc === 'outlet' ? clean(it.custId) : '', num(it.spaceId, null) || null, clean(it.space),
        num(it.count, 1), clean(it.dimensions), clean(it.category), clean(it.location), num(it.amount, 0), clean(it.description), clean(it.note), i);
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

// Prorate a contract's value for a billing sub-period → suggested debit-note.
// amount = value × (billed months / contract months). Used to pre-fill the
// rent debit note (LYSAL) generated from the contract, as in the samples.
router.get('/contracts/:id/debit-note', asyncH((req, res) => {
  const c = db.prepare('SELECT * FROM contract_hdr WHERE id=?').get(num(req.params.id, 0));
  if (!c) throw badRequest('العقد غير موجود', 'NOT_FOUND');
  const from = clean(req.query.from) || c.period_from;
  const to = clean(req.query.to) || c.period_to;
  const contractMonths = monthsInclusive(c.period_from, c.period_to) || 12;
  const billedMonths = monthsInclusive(from, to) || contractMonths;
  let amount, base = num(req.query.base, 0);
  if ((c.value_mode || 'lump') === 'pct') {
    // نسبة من صافي المبيعات: amount = net-sales base × pct%
    amount = Math.round((base * (c.pct / 100)) * 1000) / 1000;
  } else {
    // lump: prorate the contract value across the billed months
    amount = Math.round((c.value * (billedMonths / contractMonths)) * 1000) / 1000;
  }
  res.json({
    contractId: c.id, code: c.code, coop: c.coop, coopAr: AR.coops[c.coop] || '',
    custId: c.cust_id, level: c.level, valueKind: c.value_kind,
    valueMode: c.value_mode || 'lump', pct: c.pct, base,
    from, to, contractMonths, billedMonths, contractValue: c.value, amount,
  });
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
