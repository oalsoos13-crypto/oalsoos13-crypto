'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

// Ensure the data directory exists.
fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

const db = new Database(config.dbFile);
db.pragma('journal_mode = WAL');   // better concurrency for multi-user access
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const SCHEMA_VERSION = 1;

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      username             TEXT UNIQUE NOT NULL,
      password_hash        TEXT NOT NULL,
      name                 TEXT NOT NULL,
      role                 TEXT NOT NULL,
      active               INTEGER NOT NULL DEFAULT 1,
      must_change_password INTEGER NOT NULL DEFAULT 1,
      last_login_at        TEXT,
      created_at           TEXT NOT NULL,
      updated_at           TEXT NOT NULL
    );

    -- Reference: co-operatives (m = main outlets, b = branches).
    CREATE TABLE IF NOT EXISTS coops (
      name     TEXT PRIMARY KEY,
      code     TEXT,
      mains    INTEGER NOT NULL DEFAULT 0,
      branches INTEGER NOT NULL DEFAULT 0
    );

    -- Live distribution table (managed by Division): supervisor -> salesman ->
    -- coop/outlet with WOB (weight of business) and an optional manual amount.
    -- When manual = 0 the share is derived proportionally from WOB on the client.
    CREATE TABLE IF NOT EXISTS dist (
      id         TEXT PRIMARY KEY,
      sup        TEXT,
      sales      TEXT,
      coop       TEXT,
      outlet     TEXT,
      wob        REAL NOT NULL DEFAULT 0,
      amt        REAL,
      manual     INTEGER NOT NULL DEFAULT 0,
      updated_by INTEGER,
      updated_at TEXT
    );

    -- Marketing budgets (one row per period).
    CREATE TABLE IF NOT EXISTS budgets (
      id          TEXT PRIMARY KEY,
      period_from TEXT,
      period_to   TEXT,
      preset      TEXT,
      amount      REAL NOT NULL DEFAULT 0,
      created_by  INTEGER,
      created_at  TEXT NOT NULL
    );

    -- Marketing -> channels allocation.
    CREATE TABLE IF NOT EXISTS channel_alloc (
      channel    TEXT PRIMARY KEY,
      amount     REAL NOT NULL DEFAULT 0,
      updated_by INTEGER,
      updated_at TEXT
    );

    -- Letters (support requests) that later become debit notes.
    CREATE TABLE IF NOT EXISTS letters (
      id         TEXT PRIMARY KEY,
      num        INTEGER,
      lysal      TEXT,
      type       TEXT NOT NULL,
      coop       TEXT,
      brand      TEXT,
      sales      TEXT,
      date       TEXT,
      principal  TEXT,
      note       TEXT,
      value      REAL NOT NULL DEFAULT 0,
      base       REAL,
      pct        REAL,
      items      TEXT,               -- JSON array
      status     TEXT NOT NULL DEFAULT 'pending',
      created_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT
    );

    -- Debit notes with full two-level approval trail.
    CREATE TABLE IF NOT EXISTS notes (
      id              TEXT PRIMARY KEY,
      num             INTEGER,
      lysal           TEXT,
      letter_id       TEXT,
      coop_dn         TEXT,
      type            TEXT,
      coop            TEXT,
      brand           TEXT,
      sales           TEXT,
      value           REAL NOT NULL DEFAULT 0,
      date            TEXT,
      items           TEXT,          -- JSON array
      note            TEXT,
      attachments     TEXT,          -- JSON array of {name,url}
      status          TEXT NOT NULL DEFAULT 'pending_sup',
      created_by      INTEGER,
      created_at      TEXT NOT NULL,
      sup_approved_by INTEGER,
      sup_approved_at TEXT,
      mgr_approved_by INTEGER,
      mgr_approved_at TEXT,
      rejected_by     INTEGER,
      rejected_at     TEXT,
      rejected_stage  TEXT,
      reject_reason   TEXT,
      updated_at      TEXT
    );

    -- Named atomic counters (LYSAL document sequence).
    CREATE TABLE IF NOT EXISTS counters (
      name  TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    );

    -- Append-only audit log.
    CREATE TABLE IF NOT EXISTS audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          TEXT NOT NULL,
      user_id     INTEGER,
      username    TEXT,
      name        TEXT,
      role        TEXT,
      action      TEXT NOT NULL,
      entity_type TEXT,
      entity_id   TEXT,
      summary     TEXT,
      details     TEXT,              -- JSON
      ip          TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_audit_ts     ON audit_log(ts);
    CREATE INDEX IF NOT EXISTS idx_audit_user   ON audit_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_notes_status ON notes(status);
    CREATE INDEX IF NOT EXISTS idx_notes_sales  ON notes(sales);
    CREATE INDEX IF NOT EXISTS idx_letters_status ON letters(status);
  `);

  const cur = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  if (!cur) {
    db.prepare("INSERT INTO meta(key,value) VALUES('schema_version',?)").run(String(SCHEMA_VERSION));
  }
}

migrate();

module.exports = db;
module.exports.SCHEMA_VERSION = SCHEMA_VERSION;
