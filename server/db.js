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
      name_ar  TEXT,
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
      recipient  TEXT,               -- free-text recipient (spec letters)
      meta       TEXT,               -- JSON: extra fields + secondary table (spec letters)
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

    -- Real outlet master data (imported from COOPS_DETAILS).
    CREATE TABLE IF NOT EXISTS outlets (
      cust_id         TEXT PRIMARY KEY,
      code_com        TEXT,
      name            TEXT,
      parent          TEXT,
      fsm             TEXT, fsm_pf TEXT,
      salesman        TEXT, salesman_pf TEXT,
      route           TEXT,
      merchandiser    TEXT, merchandiser_pf TEXT,
      lays_sales      REAL, iec_sales REAL
    );

    -- Contract terms per outlet (values may be combos, kept as text).
    CREATE TABLE IF NOT EXISTS contracts (
      cust_id        TEXT PRIMARY KEY,
      pct            REAL,
      lumsum         TEXT,
      bonus          TEXT,
      slap           TEXT,
      category_total TEXT,
      lays           TEXT,
      iec            TEXT,
      iec_off_shelf  TEXT,
      gondola        TEXT
    );

    -- Annual sales & targets per parent co-op.
    CREATE TABLE IF NOT EXISTS sales_history (
      parent         TEXT PRIMARY KEY,
      fsm            TEXT,
      salesman       TEXT,
      contract       TEXT,
      years          TEXT,        -- JSON { "2015": n, ... "2026": n }
      coop_issues    TEXT,
      listing        TEXT,
      price_increase TEXT,
      iec_usa        TEXT,
      target         TEXT
    );

    -- Product catalog (barcodes) for the letter table pickers.
    CREATE TABLE IF NOT EXISTS products (
      barcode      TEXT PRIMARY KEY,
      name         TEXT,
      pack         TEXT,
      origin       TEXT,
      item         TEXT,
      brand        TEXT,
      weight       TEXT,
      cons_piece   REAL,
      coop_carton  REAL,
      circular     TEXT,
      circular_date TEXT,
      updated_at   TEXT
    );

    -- Products under a price update (source of the price-increase tracker).
    CREATE TABLE IF NOT EXISTS price_products (
      barcode        TEXT PRIMARY KEY,
      item_no        TEXT,
      name           TEXT,
      name_ar        TEXT,
      pack           TEXT,
      origin         TEXT,
      price_ctn_ptt  TEXT,
      price_pec_ptt  TEXT,
      price_pec_rsp  TEXT,
      price_ctn_rcp  TEXT,
      circular       TEXT,
      circular_date  TEXT,
      letter_lysal   TEXT,
      seq            INTEGER,
      added_by       INTEGER,
      added_at       TEXT
    );

    -- Per-outlet rollout tracking of a price increase (one row per product+outlet).
    CREATE TABLE IF NOT EXISTS price_track (
      barcode           TEXT NOT NULL,
      cust_id           TEXT NOT NULL,
      book_printing     TEXT,
      upd               TEXT,
      date_update       TEXT,
      dn_number         TEXT,
      dn_type           TEXT,
      dn_amount         TEXT,
      date_sales_new    TEXT,
      branch_connection TEXT,
      supply_branch     TEXT,
      branch_supply_date TEXT,
      stock             TEXT,
      updated_by        INTEGER,
      updated_at        TEXT,
      PRIMARY KEY (barcode, cust_id)
    );

    -- Per (co-op + letter type) calculation terms. calc_type: 'bonus' (1+1:
    -- unit + multiplier), 'amount' (fixed), 'amount_pct' (amount + amount*pct%).
    CREATE TABLE IF NOT EXISTS coop_terms (
      coop        TEXT NOT NULL,
      letter_type TEXT NOT NULL DEFAULT 'listing_dn',
      calc_type   TEXT NOT NULL DEFAULT 'bonus',
      unit        TEXT NOT NULL DEFAULT 'carton',
      multiplier  REAL NOT NULL DEFAULT 1,
      amount      REAL NOT NULL DEFAULT 0,
      pct         REAL NOT NULL DEFAULT 0,
      note        TEXT,
      updated_by  INTEGER,
      updated_at  TEXT,
      PRIMARY KEY (coop, letter_type)
    );

    -- Monthly sales reference data (per outlet x item), imported from the ERP.
    CREATE TABLE IF NOT EXISTS sales_monthly (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      customer    TEXT,
      sub_channel TEXT,
      route       TEXT,
      item_code   TEXT,
      item_desc   TEXT,
      g2024 REAL, g2025 REAL, g2026 REAL,
      v2024 REAL, v2025 REAL, v2026 REAL,
      gross_json  TEXT,
      value_json  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sm_customer ON sales_monthly(customer);
    CREATE INDEX IF NOT EXISTS idx_sm_item ON sales_monthly(item_desc);

    -- Products submitted for listing/approval (new items to be approved).
    CREATE TABLE IF NOT EXISTS approve_products (
      barcode      TEXT PRIMARY KEY,
      name         TEXT,
      name_ar      TEXT,
      pack         TEXT,
      origin       TEXT,
      cons_piece   TEXT,
      coop_carton  TEXT,
      note         TEXT,
      status       TEXT NOT NULL DEFAULT 'pending',
      added_by     INTEGER,
      added_at     TEXT
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
    CREATE INDEX IF NOT EXISTS idx_outlets_parent ON outlets(parent);
    CREATE INDEX IF NOT EXISTS idx_outlets_salesman ON outlets(salesman);
    CREATE INDEX IF NOT EXISTS idx_outlets_route ON outlets(route);
    CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
  `);

  // Additive column migrations for existing databases (idempotent).
  const letterCols = db.prepare("PRAGMA table_info(letters)").all().map((c) => c.name);
  if (!letterCols.includes('recipient')) db.exec('ALTER TABLE letters ADD COLUMN recipient TEXT');
  if (!letterCols.includes('meta')) db.exec('ALTER TABLE letters ADD COLUMN meta TEXT');
  const coopCols = db.prepare("PRAGMA table_info(coops)").all().map((c) => c.name);
  if (!coopCols.includes('name_ar')) db.exec('ALTER TABLE coops ADD COLUMN name_ar TEXT');
  const prodCols = db.prepare("PRAGMA table_info(products)").all().map((c) => c.name);
  for (const col of ['weight', 'circular', 'circular_date']) {
    if (!prodCols.includes(col)) db.exec(`ALTER TABLE products ADD COLUMN ${col} TEXT`);
  }
  // Letter-level approval (salesman -> supervisor) gating the print step.
  const letterCols2 = db.prepare("PRAGMA table_info(letters)").all().map((c) => c.name);
  const addLetterCol = (name, type) => { if (!letterCols2.includes(name)) db.exec(`ALTER TABLE letters ADD COLUMN ${name} ${type}`); };
  addLetterCol('approval', "TEXT NOT NULL DEFAULT 'pending'");
  addLetterCol('approved_by', 'INTEGER');
  addLetterCol('approved_at', 'TEXT');
  addLetterCol('rejected_by', 'INTEGER');
  addLetterCol('rejected_at', 'TEXT');
  addLetterCol('reject_reason', 'TEXT');
  addLetterCol('cust_id', 'TEXT'); // addressed outlet, links letters to the price tracker
  // coop_terms redesign: per (coop + letter_type). Recreate the table if it
  // predates the letter_type column (config-only, safe to rebuild).
  const ctInfo = db.prepare("PRAGMA table_info(coop_terms)").all();
  if (ctInfo.length && !ctInfo.some((c) => c.name === 'letter_type')) {
    db.exec('DROP TABLE coop_terms');
    db.exec(`CREATE TABLE coop_terms (
      coop TEXT NOT NULL, letter_type TEXT NOT NULL DEFAULT 'listing_dn',
      calc_type TEXT NOT NULL DEFAULT 'bonus', unit TEXT NOT NULL DEFAULT 'carton',
      multiplier REAL NOT NULL DEFAULT 1, amount REAL NOT NULL DEFAULT 0, pct REAL NOT NULL DEFAULT 0,
      note TEXT, updated_by INTEGER, updated_at TEXT, PRIMARY KEY (coop, letter_type))`);
  }

  const cur = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  if (!cur) {
    db.prepare("INSERT INTO meta(key,value) VALUES('schema_version',?)").run(String(SCHEMA_VERSION));
  }
}

migrate();

module.exports = db;
module.exports.SCHEMA_VERSION = SCHEMA_VERSION;
