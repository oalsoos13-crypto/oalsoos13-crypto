'use strict';
// Idempotent database seeding: reference data, atomic counter, and default users.
// Safe to run repeatedly — existing rows are left untouched.
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
    (barcode,name,pack,origin,item,brand,cons_piece,coop_carton,updated_at)
    VALUES (@barcode,@name,@pack,@origin,@item,@brand,@cons,@coop,@now)`);
  const tx = db.transaction((rows) => {
    for (const p of rows) ins.run({
      barcode: String(p.barcode), name: p.name || '', pack: p.pack || '', origin: p.origin || '',
      item: p.item || '', brand: p.brand || '',
      cons: p.consPiece == null ? null : +p.consPiece,
      coop: p.coopCarton == null ? null : +p.coopCarton, now,
    });
  });
  tx(list);
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
      const pw = u.role === 'admin' ? config.adminPassword : config.defaultPassword;
      insert.run({ username: u.u, hash: hashPassword(pw), name: u.name, role: u.role, now });
      created++;
    }
  });
  tx(DEFAULT_USERS);
  return created;
}

function run() {
  seedCoops();
  seedDist();
  seedMaster();
  seedProducts();
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
