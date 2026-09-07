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
