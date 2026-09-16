'use strict';
// Idempotent database seeding: reference data, atomic counter, and default users.
// Safe to run repeatedly — existing rows are left untouched.
const fs = require('fs');
const path = require('path');
const db = require('./db');
const config = require('./config');
const { hashPassword } = require('./auth');
const { nowIso } = require('./util');
const { SEED, DEFAULT_DIST, DEFAULT_USERS } = require('./seed-data');

function seedCoops() {
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO coops (name, code, mains, branches) VALUES (?, ?, ?, ?)'
  );
  const tx = db.transaction((rows) => {
    for (const c of rows) stmt.run(c.n, c.p || '', c.m || 0, c.b || 0);
  });
  tx(SEED.coops);
  // Fill Arabic co-op names (idempotent — only where missing).
  let arMap;
  try { arMap = require('./coop_ar.json'); } catch (e) { arMap = null; }
  if (arMap) {
    const upd = db.prepare('UPDATE coops SET name_ar = ? WHERE name = ? AND (name_ar IS NULL OR name_ar = \'\')');
    const tx2 = db.transaction(() => { for (const [en, ar] of Object.entries(arMap)) upd.run(ar, en); });
    tx2();
  }
}

function seedDist() {
  const count = db.prepare('SELECT COUNT(*) n FROM dist').get().n;
  if (count > 0) return; // only seed the distribution mapping once
  const now = nowIso();
  const stmt = db.prepare(
    'INSERT INTO dist (id, sup, sales, coop, outlet, wob, amt, manual, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?)'
  );
  const tx = db.transaction((rows) => {
    rows.forEach((r, i) =>
      stmt.run('D' + String(i + 1).padStart(4, '0'), r.sup, r.sales, r.coop, r.outlet, r.wob || 0, now)
    );
  });
  tx(DEFAULT_DIST);
}

function seedMaster() {
  if (db.prepare('SELECT COUNT(*) n FROM outlets').get().n > 0) return; // seed once
  let master;
  try { master = require('./coops_master.json'); } catch (e) { return; }
  const S = (v) => (v == null ? null : String(v));
  const N = (v) => (v == null || v === '' || isNaN(+v) ? null : +v);
  const insO = db.prepare(`INSERT OR IGNORE INTO outlets
    (cust_id,code_com,name,parent,fsm,fsm_pf,salesman,salesman_pf,route,merchandiser,merchandiser_pf,lays_sales,iec_sales)
    VALUES (@cust_id,@code_com,@name,@parent,@fsm,@fsm_pf,@salesman,@salesman_pf,@route,@merchandiser,@merchandiser_pf,@lays,@iec)`);
  const insC = db.prepare(`INSERT OR IGNORE INTO contracts
    (cust_id,pct,lumsum,bonus,slap,category_total,lays,iec,iec_off_shelf,gondola)
    VALUES (@cust_id,@pct,@lumsum,@bonus,@slap,@category_total,@lays,@iec,@iec_off_shelf,@gondola)`);
  const insS = db.prepare(`INSERT OR IGNORE INTO sales_history
    (parent,fsm,salesman,contract,years,coop_issues,listing,price_increase,iec_usa,target)
    VALUES (@parent,@fsm,@salesman,@contract,@years,@coop_issues,@listing,@price_increase,@iec_usa,@target)`);
  const tx = db.transaction(() => {
    for (const o of master.outlets || []) insO.run({
      cust_id: S(o.custId), code_com: S(o.codeCom), name: S(o.name), parent: S(o.parent),
      fsm: S(o.fsm), fsm_pf: S(o.fsmPf), salesman: S(o.salesman), salesman_pf: S(o.salesmanPf),
      route: S(o.route), merchandiser: S(o.merchandiser), merchandiser_pf: S(o.merchandiserPf),
      lays: N(o.laysSales), iec: N(o.iecSales),
    });
    for (const [cust, c] of Object.entries(master.contracts || {})) insC.run({
      cust_id: S(cust), pct: N(c.pct), lumsum: S(c.lumsum), bonus: S(c.bonus), slap: S(c.slap),
      category_total: S(c.categoryTotal), lays: S(c.lays), iec: S(c.iec),
      iec_off_shelf: S(c.iecOffShelf), gondola: S(c.gondola),
    });
    for (const s of master.sales || []) insS.run({
      parent: S(s.parent), fsm: S(s.fsm), salesman: S(s.salesman), contract: S(s.contract),
      years: JSON.stringify(s.years || {}), coop_issues: S(s.coopIssues), listing: S(s.listing),
      price_increase: S(s.priceIncrease), iec_usa: S(s.iecUsa), target: S(s.target),
    });
  });
  tx();
}

function seedProducts() {
  if (db.prepare('SELECT COUNT(*) n FROM products').get().n > 0) return; // seed once
  let list;
  try { list = require('./products.json'); } catch (e) { return; }
  const now = nowIso();
  const ins = db.prepare(`INSERT OR IGNORE INTO products
    (barcode,name,pack,origin,item,brand,weight,cons_piece,coop_carton,circular,circular_date,updated_at)
    VALUES (@barcode,@name,@pack,@origin,@item,@brand,@weight,@cons,@coop,@circular,@cdate,@now)`);
  const tx = db.transaction((rows) => {
    for (const p of rows) ins.run({
      barcode: String(p.barcode), name: p.name || '', pack: p.pack || '', origin: p.origin || '',
      item: p.item || '', brand: p.brand || '', weight: p.weight || '',
      cons: p.consPiece == null ? null : +p.consPiece,
      coop: p.coopCarton == null ? null : +p.coopCarton,
      circular: p.circular || '', cdate: p.circularDate || '', now,
    });
  });
  tx(list);
}

function seedPriceProducts() {
  if (db.prepare('SELECT COUNT(*) n FROM price_products').get().n > 0) return; // seed once
  let list;
  try { list = require('./price_track_seed.json'); } catch (e) { return; }
  const now = nowIso();
  const ins = db.prepare(`INSERT OR IGNORE INTO price_products
    (barcode,item_no,name,name_ar,pack,circular,circular_date,letter_lysal,seq,added_at)
    VALUES (@barcode,@item_no,@name,@name_ar,@pack,@circular,@circular_date,@letter_lysal,@seq,@now)`);
  const tx = db.transaction((rows) => {
    for (const p of rows) ins.run({
      barcode: String(p.barcode), item_no: p.itemNo || '', name: p.name || '', name_ar: p.nameAr || '',
      pack: p.pack || '', circular: p.circular || '', circular_date: p.circularDate || '',
      letter_lysal: p.letterLysal || '', seq: p.seq || 0, now,
    });
  });
  tx(list);
}

function seedSalesMonthly() {
  if (db.prepare('SELECT COUNT(*) n FROM sales_monthly').get().n > 0) return; // seed once
  const fp = path.join(__dirname, 'seed_data', 'coops_sales.xlsx');
  if (!fs.existsSync(fp)) return;
  let rows;
  try {
    const XLSX = require('xlsx');
    const wb = XLSX.read(fs.readFileSync(fp), { type: 'buffer' });
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, blankrows: false, defval: '' });
  } catch (e) { return; }
  // header rows: 1=metric, 2=year, 3=month labels; data from row 4.
  const years = rows[2] || [];
  const metrics = rows[1] || [];
  const num = (v) => { const n = parseFloat(String(v).replace(/,/g, '')); return isNaN(n) ? 0 : n; };
  const ins = db.prepare(`INSERT INTO sales_monthly
    (customer,sub_channel,route,item_code,item_desc,g2024,g2025,g2026,v2024,v2025,v2026,gross_json,value_json)
    VALUES (@customer,@sub_channel,@route,@item_code,@item_desc,@g2024,@g2025,@g2026,@v2024,@v2025,@v2026,@gross_json,@value_json)`);
  const tx = db.transaction(() => {
    for (let i = 4; i < rows.length; i++) {
      const r = rows[i]; if (!r || (!r[0] && !r[3])) continue;
      const cust0 = String(r[0] || '').trim();
      if (!cust0 || /^grand total/i.test(cust0)) continue; // skip totals rows
      const gross = {}, value = {}; const tot = { g: {}, v: {} };
      for (let c = 4; c < r.length; c++) {
        const metric = String(metrics[c] || '').toLowerCase();
        const yr = String(years[c] || '').trim();
        const mon = String((rows[3] || [])[c] || '').trim();
        if (!yr || !mon) continue;
        const val = num(r[c]); if (!val) continue;
        const bag = /invoic/.test(metric) ? value : gross;
        const totBag = /invoic/.test(metric) ? tot.v : tot.g;
        (bag[yr] = bag[yr] || {})[mon] = val;
        totBag[yr] = (totBag[yr] || 0) + val;
      }
      const idesc = String(r[3] || '');
      const codeMatch = idesc.match(/^(\d+)/);
      ins.run({
        customer: String(r[0] || ''), sub_channel: String(r[1] || ''), route: String(r[2] || ''),
        item_code: codeMatch ? codeMatch[1] : '', item_desc: idesc,
        g2024: tot.g['2024'] || 0, g2025: tot.g['2025'] || 0, g2026: tot.g['2026'] || 0,
        v2024: tot.v['2024'] || 0, v2025: tot.v['2025'] || 0, v2026: tot.v['2026'] || 0,
        gross_json: JSON.stringify(gross), value_json: JSON.stringify(value),
      });
    }
  });
  tx();
}

function seedCounter() {
  db.prepare('INSERT OR IGNORE INTO counters (name, value) VALUES (?, ?)')
    .run('lysal', config.startCounter);
}

function seedUsers() {
  const exists = db.prepare('SELECT 1 FROM users WHERE username = ?');
  const insert = db.prepare(`
    INSERT INTO users (username, password_hash, name, role, active, must_change_password, created_at, updated_at)
    VALUES (@username, @hash, @name, @role, 1, 1, @now, @now)
  `);
  const now = nowIso();
  let created = 0;
  const tx = db.transaction((rows) => {
    for (const u of rows) {
      if (exists.get(u.u)) continue;
      // Explicit per-user password (u.pw) wins; otherwise fall back to the role default.
      const pw = u.pw || (u.role === 'admin' ? config.adminPassword : config.defaultPassword);
      insert.run({ username: u.u, hash: hashPassword(pw), name: u.name, role: u.role, now });
      created++;
    }
  });
  tx(DEFAULT_USERS);
  return created;
}

// Seed real co-op contracts from server/seed_data/contracts.json (once, only if
// the contracts table is empty). Each entry mirrors the /contracts POST body;
// the co-op is matched from Arabic to our parent name when possible.
const CONTRACTS_SEED_V = '7';
function seedContracts() {
  const have = db.prepare('SELECT COUNT(*) n FROM contract_hdr').get().n;
  const ver = (db.prepare("SELECT value FROM meta WHERE key='contracts_seed_v'").get() || {}).value;
  if (have) {
    // Already at the current seed version, or the user has created their own
    // contracts (created_by set) — never overwrite those.
    if (ver === CONTRACTS_SEED_V) return 0;
    const userMade = db.prepare('SELECT COUNT(*) n FROM contract_hdr WHERE created_by IS NOT NULL').get().n;
    if (userMade) return 0;
    // Only seed-origin rows present and version is stale → refresh to the full set.
    db.exec('DELETE FROM contract_items; DELETE FROM contract_hdr; DELETE FROM contract_installments');
  }
  let list = [];
  try { list = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed_data', 'contracts.json'), 'utf8')); }
  catch (e) { return 0; }
  if (!Array.isArray(list) || !list.length) return 0;

  let AR = { coops: {} };
  try { AR = require('./outlet_ar.json'); } catch (e) { /* optional */ }
  // Normalize Arabic for matching: unify alef/hamza/ya/ta-marbuta, drop
  // diacritics/tatweel and the generic words جمعية / التعاونية / الزراعية.
  const norm = (s) => String(s || '')
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي').replace(/ة/g, 'ه')
    .replace(/جمعيه|التعاونيه|الزراعيه|التعاونيةه/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const toks = (s) => new Set(norm(s).split(' ').filter((w) => w.length > 2 && w !== 'ال'));
  const rev = new Map();      // exact normalized Arabic -> English parent
  const revToks = [];         // [tokenSet, English] for fuzzy overlap
  for (const [en, ar] of Object.entries(AR.coops || {})) { rev.set(norm(ar), en); revToks.push([toks(ar), en]); }
  const matchCoop = (e) => {
    if (e.coop) return e.coop;
    const a = norm(e.coopAr);
    if (!a) return e.coopAr || '';
    if (rev.has(a)) return rev.get(a);
    for (const [nar, en] of rev) { if (nar && (nar.includes(a) || a.includes(nar))) return en; }
    // token overlap: our coop's core tokens all present in the contract name
    const at = toks(e.coopAr);
    let best = '', bestScore = 0;
    for (const [ct, en] of revToks) {
      if (!ct.size) continue;
      let inter = 0; for (const w of ct) if (at.has(w)) inter++;
      const score = inter / ct.size;
      if (score > bestScore) { bestScore = score; best = en; }
    }
    return bestScore >= 0.8 ? best : (e.coopAr || '');
  };
  const n = (v, d = 0) => { const x = parseFloat(v); return isNaN(x) ? d : x; };
  const now = nowIso();
  const insH = db.prepare(`INSERT INTO contract_hdr (code,title,subject_year,is_renewal,party_rep,contract_date,
    level,coop,cust_id,period_from,period_to,renewable,value_mode,value,pct,pay_freq,bonus_terms,value_kind,
    grace_days,pay_within,kind,parent_id,pdf,verified,note,status,created_at,updated_at)
    VALUES (@code,@title,@subject_year,@is_renewal,@party_rep,@contract_date,@level,@coop,@cust_id,@period_from,@period_to,
    @renewable,@value_mode,@value,@pct,@pay_freq,@bonus_terms,@value_kind,@grace_days,@pay_within,@kind,@parent_id,@pdf,@verified,@note,@status,@now,@now)`);
  const insI = db.prepare(`INSERT INTO contract_items (contract_id,scope,cust_id,space_id,space,count,dimensions,category,location,amount,description,note,sort)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let cnt = 0;
  const tx = db.transaction((rows) => {
    for (const e of rows) {
      const coop = matchCoop(e);
      const r = insH.run({
        code: e.code || '', title: e.title || '', subject_year: e.subjectYear || '',
        is_renewal: e.isRenewal ? 1 : 0, party_rep: e.partyRep || '', contract_date: e.contractDate || '',
        level: e.level === 'outlet' ? 'outlet' : 'coop', coop, cust_id: e.custId || '',
        period_from: e.periodFrom || '', period_to: e.periodTo || '', renewable: e.renewable === false ? 0 : 1,
        value_mode: e.valueMode === 'pct' ? 'pct' : 'lump', value: n(e.value), pct: n(e.pct),
        pay_freq: e.payFreq || 'once', bonus_terms: e.bonusTerms || '',
        value_kind: e.valueKind || 'rent', grace_days: n(e.graceDays, 45), pay_within: n(e.payWithin, 14),
        kind: e.kind === 'addendum' ? 'addendum' : 'base', parent_id: e.parentId || null,
        pdf: e.pdf || null, verified: e.verified ? 1 : 0,
        note: e.note || '', status: e.status === 'closed' ? 'closed' : 'active', now,
      });
      const id = r.lastInsertRowid;
      (e.items || []).forEach((it, i) => {
        const sc = ['main', 'branches', 'outlet', 'all'].includes(it.scope) ? it.scope : 'main';
        insI.run(id, sc, it.custId || '', null, it.space || '', n(it.count, 1),
          it.dimensions || '', it.category || '', it.location || '', n(it.amount), it.description || '', it.note || '', i);
      });
      cnt++;
    }
  });
  tx(list);
  // Link each addendum (ملحق) to a base contract of the same co-op — preferring
  // one with the same reference code — so it groups under its base.
  const adds = db.prepare("SELECT id, coop, code FROM contract_hdr WHERE kind='addendum' AND parent_id IS NULL").all();
  const link = db.prepare('UPDATE contract_hdr SET parent_id=? WHERE id=?');
  const findBase = db.prepare("SELECT id FROM contract_hdr WHERE kind='base' AND coop=? AND id<>? ORDER BY (code=?) DESC, id");
  const tx2 = db.transaction(() => {
    for (const a of adds) { const b = findBase.get(a.coop, a.id, a.code || ''); if (b) link.run(b.id, a.id); }
  });
  tx2();
  db.prepare("INSERT INTO meta(key,value) VALUES('contracts_seed_v',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(CONTRACTS_SEED_V);
  return cnt;
}

// Co-ops/entities that appear in the contracts but were not in the original
// master list. Registered here so contracts link to a real co-op record and
// show up in the co-op reference. Idempotent (INSERT OR IGNORE by name).
function seedExtraCoops() {
  const extra = [
    'جمعية العبدلي التعاونية',
    'جمعية الشرق التعاونية',
    'جمعية الصليبية التعاونية',
    'جمعية النزهة التعاونية',
    'جمعية غرناطة التعاونية',
    'جمعية جليب الشيوخ التعاونية',
    'جمعية الثروة الحيوانية التعاونية',
    'جمعية شمال غرب الصليبيخات',
    'جمعية ضاحية عبد الله السالم والمنصورية التعاونية',
    'السوق المركزي للعاملين بوزارة الداخلية',
  ];
  const ins = db.prepare('INSERT OR IGNORE INTO coops (name, name_ar, code, mains, branches) VALUES (?,?,?,0,0)');
  const tx = db.transaction(() => { for (const n of extra) ins.run(n, n, ''); });
  tx();
}

// Seed the default contract fixture/space types (أدوات العقد) once.
function seedContractSpaces() {
  const have = db.prepare('SELECT COUNT(*) n FROM contract_spaces').get().n;
  if (have) return;
  const rows = [
    ['جدولة', 'Gondola'],
    ['إستاند', 'Stand'],
    ['طبلة', 'Promo table'],
    ['متر طولي (رف)', 'Linear shelf meter'],
    ['رف', 'Shelf'],
    ['ثلاجة', 'Chiller'],
    ['برواز / برندة', 'Frame'],
  ];
  const ins = db.prepare('INSERT INTO contract_spaces (name,name_en,active,sort) VALUES (?,?,1,?)');
  const tx = db.transaction(() => { rows.forEach((r, i) => ins.run(r[0], r[1], i)); });
  tx();
}

function run() {
  seedCoops();
  seedDist();
  seedMaster();
  seedProducts();
  seedPriceProducts();
  seedSalesMonthly();
  seedExtraCoops();
  seedContractSpaces();
  seedContracts();
  seedCounter();
  const createdUsers = seedUsers();
  return { createdUsers };
}

// When executed directly (npm run seed), report a summary.
if (require.main === module) {
  const r = run();
  const counts = {
    users: db.prepare('SELECT COUNT(*) n FROM users').get().n,
    coops: db.prepare('SELECT COUNT(*) n FROM coops').get().n,
    dist: db.prepare('SELECT COUNT(*) n FROM dist').get().n,
  };
  // eslint-disable-next-line no-console
  console.log('[seed] done.', { newUsers: r.createdUsers, ...counts });
  if (r.createdUsers > 0) {
    // eslint-disable-next-line no-console
    console.log(
      '[seed] Default password for new non-admin users:', JSON.stringify(config.defaultPassword),
      '| admin:', JSON.stringify(config.adminPassword),
      '\n[seed] ALL users must change their password on first login.'
    );
  }
}

module.exports = { run };
