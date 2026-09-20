'use strict';
// Contracts module: rich per-outlet / per-coop contracts with a period, multiple
// line-items (نسبة على العقد / مبلغ ثابت / دعم / أخرى) each tied to a space
// (مساحة), an installment/payment schedule (تسليم الدفعات) that can be entered
// manually or auto-split over the period, and addenda (ملاحق) linked to a base
// contract. Space types are a data-driven lookup (in-system or Excel import).
const express = require('express');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const db = require('../db');
const audit = require('../audit');
const { requireAuth, requireRole } = require('../auth');
const { asyncH, nowIso, badRequest } = require('../util');

const router = express.Router();
router.use(requireAuth);

const MGMT = ['sales_manager', 'marketing_manager', 'sales_ops']; // (+admin always, via requireRole)
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
  const eff = effStatus(c);
  return {
    id: c.id, code: c.code, title: c.title, subjectYear: c.subject_year,
    isRenewal: !!c.is_renewal, partyRep: c.party_rep, contractDate: c.contract_date,
    level: c.level, coop: c.coop, coopAr: c.coop_ar || AR.coops[c.coop] || c.coop || '', custId: c.cust_id,
    period: { from: c.period_from, to: c.period_to }, renewable: !!c.renewable,
    valueMode: c.value_mode || 'lump', value: c.value, pct: c.pct,
    payFreq: c.pay_freq || 'once', bonusTerms: c.bonus_terms,
    valueKind: c.value_kind, graceDays: c.grace_days, payWithin: c.pay_within,
    kind: c.kind, parentId: c.parent_id, pdf: c.pdf || '', hasPdf: !!c.pdf, verified: !!c.verified, note: c.note, status: c.status,
    effStatus: eff.s, renewedCycles: eff.cycles, effectiveTo: eff.to,
    createdAt: c.created_at, updatedAt: c.updated_at,
    items, installments, total: c.value,
  };
}
// Effective status from the period + renewable clause (البند الثاني):
//  active    — today within the term
//  autorenew — renewable and the term ended (still in force; carries cycles + implied current end)
//  expired   — NOT renewable and the term ended (needs a new/renewed contract)
//  future    — term has not started;  unknown — no end date
function effStatus(c) {
  const to = c.period_to ? new Date(c.period_to) : null;
  const from = c.period_from ? new Date(c.period_from) : null;
  const today = new Date();
  if (!to || isNaN(to)) return { s: 'unknown', cycles: 0, to: c.period_to || '' };
  if (from && !isNaN(from) && from > today) return { s: 'future', cycles: 0, to: c.period_to };
  if (to >= today) return { s: 'active', cycles: 0, to: c.period_to };
  if (c.renewable) {
    const cycles = Math.max(1, Math.ceil((today - to) / (365.25 * 86400000)));
    const e = new Date(to); e.setFullYear(e.getFullYear() + cycles);
    return { s: 'autorenew', cycles, to: e.toISOString().slice(0, 10) };
  }
  return { s: 'expired', cycles: 0, to: c.period_to };
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

// ---- exports (Excel-openable CSV, UTF-8 BOM) ----------------------------
function csvCell(v) {
  if (v == null) return '';
  const s = String(v).replace(/"/g, '""');
  return /[",\n\r]/.test(s) ? `"${s}"` : s;
}
function scopedContracts(user) {
  const allowCoops = scopeCoops(user), allowCust = scopeCustIds(user);
  let rows = db.prepare('SELECT * FROM contract_hdr ORDER BY coop, created_at').all();
  if (allowCoops) rows = rows.filter((c) => (c.level === 'outlet' ? (allowCust && allowCust.has(c.cust_id)) : allowCoops.has(cleanCoop(c.coop))));
  return rows;
}
const freqAr = { once: 'دفعة واحدة', monthly: 'شهري', quarterly: 'ربع سنوي', semiannual: 'نصف سنوي', yearly: 'سنوي' };
const kindAr = { rent: 'إيجارات', support: 'دعم', cda: 'دعم تجاري CDA', marketing: 'تسويق', other: 'أخرى' };

// One row per contract (header level).
router.get('/export/contracts.csv', asyncH((req, res) => {
  const rows = scopedContracts(req.user);
  const cols = [
    ['id', (c) => c.id], ['المرجع', (c) => c.code], ['الجمعية', (c) => AR.coops[c.coop] || c.coop],
    ['المستوى', (c) => (c.level === 'coop' ? 'جمعية' : 'منفذ')], ['المنفذ', (c) => c.cust_id],
    ['السنة', (c) => c.subject_year], ['النوع', (c) => (c.kind === 'addendum' ? 'ملحق' : (c.is_renewal ? 'تجديد' : 'عقد'))],
    ['من', (c) => c.period_from], ['إلى', (c) => c.period_to],
    ['طريقة القيمة', (c) => (c.value_mode === 'pct' ? 'نسبة' : 'مبلغ')],
    ['القيمة', (c) => (c.value_mode === 'pct' ? '' : c.value)], ['النسبة%', (c) => (c.value_mode === 'pct' ? c.pct : '')],
    ['الدورية', (c) => freqAr[c.pay_freq] || c.pay_freq], ['التصنيف', (c) => kindAr[c.value_kind] || c.value_kind],
    ['فترة السماح', (c) => c.grace_days], ['الدفع خلال', (c) => c.pay_within],
    ['1+1', (c) => c.bonus_terms], ['عدد المساحات', (c) => db.prepare('SELECT COUNT(*) n FROM contract_items WHERE contract_id=?').get(c.id).n],
    ['الحالة', (c) => (c.status === 'closed' ? 'منتهي' : 'ساري')], ['ملاحظات', (c) => c.note],
  ];
  const lines = [cols.map((x) => x[0]).join(',')];
  for (const c of rows) lines.push(cols.map((x) => csvCell(x[1](c))).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="udc-contracts-${Date.now()}.csv"`);
  res.send('﻿' + lines.join('\r\n'));
}));

// One row per space/fixture item (line level), joined to its contract.
router.get('/export/contract-items.csv', asyncH((req, res) => {
  const rows = scopedContracts(req.user);
  const byId = new Map(rows.map((c) => [c.id, c]));
  const ids = rows.map((c) => c.id);
  let items = [];
  if (ids.length) items = db.prepare(`SELECT * FROM contract_items WHERE contract_id IN (${ids.map(() => '?').join(',')}) ORDER BY contract_id, sort`).all(...ids);
  const scAr = { main: 'السوق المركزي', branches: 'جميع الفروع', outlet: 'منفذ', all: 'الكل' };
  const cols = [
    ['contract_id', (it) => it.contract_id], ['المرجع', (it) => (byId.get(it.contract_id) || {}).code],
    ['الجمعية', (it) => { const c = byId.get(it.contract_id) || {}; return AR.coops[c.coop] || c.coop; }],
    ['النطاق', (it) => scAr[it.scope] || it.scope], ['الأداة', (it) => it.space], ['العدد', (it) => it.count],
    ['الأبعاد', (it) => it.dimensions], ['الصنف', (it) => it.category], ['الموقع', (it) => it.location],
    ['القيمة', (it) => it.amount || ''], ['الوصف', (it) => it.description],
  ];
  const lines = [cols.map((x) => x[0]).join(',')];
  for (const it of items) lines.push(cols.map((x) => csvCell(x[1](it))).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="udc-contract-items-${Date.now()}.csv"`);
  res.send('﻿' + lines.join('\r\n'));
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

// Aggregate analytics for the contracts dashboard (scoped per user).
router.get('/contracts/stats', asyncH((req, res) => {
  const rows = scopedContracts(req.user);
  const today = new Date().toISOString().slice(0, 10);
  const plus = (d) => { const x = new Date(); x.setDate(x.getDate() + d); return x.toISOString().slice(0, 10); }; // eslint-disable-line
  const in90 = plus(90);
  const yr = (c) => (c.subject_year || String(c.period_from || '').slice(0, 4) || '—');
  const money = (c) => (c.value_mode === 'pct' ? 0 : (c.value || 0));
  const eff = new Map(rows.map((c) => [c.id, effStatus(c)]));
  const s = {
    total: rows.length,
    base: rows.filter((c) => c.kind !== 'addendum').length,
    addendum: rows.filter((c) => c.kind === 'addendum').length,
    renewable: rows.filter((c) => c.renewable).length,
    active: rows.filter((c) => c.status !== 'closed').length,
    effActive: rows.filter((c) => eff.get(c.id).s === 'active').length,
    effAutoRenew: rows.filter((c) => eff.get(c.id).s === 'autorenew').length,
    effExpired: rows.filter((c) => eff.get(c.id).s === 'expired').length,
    effUnknown: rows.filter((c) => eff.get(c.id).s === 'unknown').length,
    lumpCount: rows.filter((c) => c.value_mode !== 'pct').length,
    lumpSum: Math.round(rows.reduce((a, c) => a + money(c), 0) * 1000) / 1000,
    pctCount: rows.filter((c) => c.value_mode === 'pct').length,
    spaces: 0,
  };
  const pcts = rows.filter((c) => c.value_mode === 'pct').map((c) => c.pct).filter((x) => x > 0);
  s.pctAvg = pcts.length ? Math.round((pcts.reduce((a, b) => a + b, 0) / pcts.length) * 100) / 100 : 0;
  s.pctMin = pcts.length ? Math.min(...pcts) : 0;
  s.pctMax = pcts.length ? Math.max(...pcts) : 0;
  if (rows.length) s.spaces = db.prepare(`SELECT COUNT(*) n FROM contract_items WHERE contract_id IN (${rows.map(() => '?').join(',')})`).get(...rows.map((c) => c.id)).n;

  const group = (keyFn, labelFn) => {
    const m = new Map();
    for (const c of rows) {
      const k = keyFn(c); if (k == null || k === '') continue;
      if (!m.has(k)) m.set(k, { key: k, label: labelFn ? labelFn(c, k) : k, count: 0, sum: 0, pctSum: 0, pctN: 0 });
      const g = m.get(k); g.count++; g.sum += money(c);
      if (c.value_mode === 'pct' && c.pct > 0) { g.pctSum += c.pct; g.pctN++; }
    }
    return [...m.values()].map((g) => ({ key: g.key, label: g.label, count: g.count, sum: Math.round(g.sum * 1000) / 1000, pctAvg: g.pctN ? Math.round((g.pctSum / g.pctN) * 100) / 100 : 0 }));
  };
  const KIND = { rent: 'إيجارات', support: 'دعم', cda: 'دعم تجاري CDA', marketing: 'تسويق', other: 'أخرى' };
  s.byKind = group((c) => c.value_kind || 'other', (c, k) => KIND[k] || k).sort((a, b) => b.count - a.count);
  s.byYear = group(yr).sort((a, b) => String(b.key).localeCompare(String(a.key)));
  s.byCoop = group((c) => c.coop, (c) => AR.coops[c.coop] || c.coop).sort((a, b) => b.sum - a.sum || b.count - a.count);

  s.expiring = rows.filter((c) => c.status !== 'closed' && c.period_to && c.period_to >= today && c.period_to <= in90)
    .map((c) => ({ id: c.id, code: c.code, coopAr: AR.coops[c.coop] || c.coop, to: c.period_to }))
    .sort((a, b) => a.to.localeCompare(b.to));
  s.expired = rows.filter((c) => c.status !== 'closed' && c.period_to && c.period_to < today).length;
  // Truly expired (not renewable, ended) — need a renewed/new contract.
  s.expiredList = rows.filter((c) => eff.get(c.id).s === 'expired')
    .map((c) => ({ id: c.id, code: c.code, coopAr: AR.coops[c.coop] || c.coop, to: c.period_to, value: c.value_mode === 'pct' ? c.pct + '%' : c.value }))
    .sort((a, b) => String(a.to).localeCompare(String(b.to)));
  // Auto-renew contracts whose current implied cycle ends within 90 days (decision window).
  s.renewalDue = rows.filter((c) => { const e = eff.get(c.id); return e.s === 'autorenew' && e.to >= today && e.to <= in90; })
    .map((c) => ({ id: c.id, code: c.code, coopAr: AR.coops[c.coop] || c.coop, to: eff.get(c.id).to, cycles: eff.get(c.id).cycles }))
    .sort((a, b) => a.to.localeCompare(b.to));
  res.json(s);
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

// Stream the original contract PDF — authenticated and scope-checked, so only
// users who can see the contract can open its PDF (files live outside /public).
const PDF_DIR = path.join(__dirname, '..', 'contract_pdfs');

// Build a clean, human-readable Arabic download name from the contract's own
// data (co-op name + type + year + reference), instead of exposing the raw
// internal file name (e.g. "52_-_2023_SALWA_CDA_DISTINCTIVE__.pdf"). Sets both
// an RFC 5987 UTF-8 name (filename*) and a plain ASCII fallback (filename=).
function contractPdfName(c) {
  const coopAr = c.coop_ar || AR.coops[c.coop] || c.coop || 'عقد';
  const typeAr = c.kind === 'addendum' ? 'ملحق عقد' : 'عقد';
  const year = c.subject_year || (c.period_from || '').slice(0, 4) || '';
  const ref = (c.code || '').replace(/[\\/:*?"<>|]+/g, '-'); // e.g. LYSAL/4218/2022
  let name = [coopAr, typeAr + (year ? ' ' + year : ''), ref].filter(Boolean).join(' - ');
  // Strip characters illegal in file names on common OSes; collapse whitespace.
  name = name.replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (name || ('contract-' + c.id)) + '.pdf';
}
function pdfDisposition(c) {
  const name = contractPdfName(c);
  // ASCII fallback: keep it meaningful but header-safe (no non-Latin, no quotes).
  const ascii = ('contract-' + c.id + (c.kind === 'addendum' ? '-addendum' : '') + '.pdf');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
router.get('/contracts/:id/pdf', asyncH((req, res) => {
  const c = db.prepare('SELECT * FROM contract_hdr WHERE id=?').get(num(req.params.id, 0));
  if (!c || !c.pdf) throw badRequest('لا يوجد ملف', 'NO_PDF');
  const allowCoops = scopeCoops(req.user), allowCust = scopeCustIds(req.user);
  if (allowCoops) {
    const ok = c.level === 'outlet' ? (allowCust && allowCust.has(c.cust_id)) : allowCoops.has(cleanCoop(c.coop));
    if (!ok) throw badRequest('غير مصرّح', 'FORBIDDEN');
  }
  const safe = path.basename(String(c.pdf)); // prevent traversal
  const fp = path.join(PDF_DIR, safe);
  if (!fp.startsWith(PDF_DIR) || !fs.existsSync(fp)) throw badRequest('الملف غير موجود', 'NOT_FOUND');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', pdfDisposition(c));
  fs.createReadStream(fp).pipe(res);
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
