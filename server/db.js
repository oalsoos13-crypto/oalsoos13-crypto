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
    -- listing_markets = the number of central markets a NEW-ITEM listing fee is
    -- actually billed against. It is NOT the same as mains: the real letters
    -- show co-ops that list Frito-Lay on a fixed subset of their markets
    -- (Rawda has 8 central markets but every listing DN bills x3, Jaber
    -- Al-Ahmad has 4 but bills x2). NULL/0 means fall back to mains.
    CREATE TABLE IF NOT EXISTS coops (
      name     TEXT PRIMARY KEY,
      name_ar  TEXT,
      code     TEXT,
      mains    INTEGER NOT NULL DEFAULT 0,
      branches INTEGER NOT NULL DEFAULT 0,
      listing_markets INTEGER
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
      brand        TEXT,
      item_no      TEXT,
      carton_barcode TEXT,
      pack         TEXT,
      origin       TEXT,
      cons_piece   TEXT,
      coop_carton  TEXT,
      circular     TEXT,
      circular_date TEXT,
      union_lysal  TEXT,
      note         TEXT,
      status       TEXT NOT NULL DEFAULT 'pending',
      added_by     INTEGER,
      added_at     TEXT
    );

    -- ===== Contracts module (rich model) =====
    -- Space types (مساحات) used by contract line-items. Data-driven lookup;
    -- populated in-system or imported from the co-op's spaces file.
    CREATE TABLE IF NOT EXISTS contract_spaces (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      name     TEXT NOT NULL,        -- Arabic name of the space type
      name_en  TEXT,
      note     TEXT,
      active   INTEGER NOT NULL DEFAULT 1,
      sort     INTEGER NOT NULL DEFAULT 0
    );

    -- Contract header. A contract is per-outlet (level='outlet', cust_id set) or
    -- per-coop (level='coop'). Addenda (ملحق) point at a base contract via
    -- parent_id with kind='addendum'. Value is a single agreed lump sum
    -- (قيمة العقد) paid via debit note; the space placements below say what the
    -- co-op grants in return.
    CREATE TABLE IF NOT EXISTS contract_hdr (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      code          TEXT,             -- contract number / reference
      title         TEXT,
      subject_year  TEXT,             -- السنة التسويقية (e.g. 2021)
      is_renewal    INTEGER NOT NULL DEFAULT 0,   -- تجديد عقد
      party_rep     TEXT,             -- ممثل الطرف الأول
      contract_date TEXT,             -- تاريخ إبرام العقد
      level         TEXT NOT NULL DEFAULT 'coop', -- 'outlet' | 'coop'
      coop          TEXT,             -- parent co-op (cleaned name)
      cust_id       TEXT,             -- outlet, when level='outlet'
      period_from   TEXT,
      period_to     TEXT,
      renewable     INTEGER NOT NULL DEFAULT 1,    -- قابل للتجديد
      value_mode    TEXT NOT NULL DEFAULT 'lump',  -- 'lump' | 'pct' (نسبة من المبيعات)
      value         REAL NOT NULL DEFAULT 0,       -- قيمة العقد (when lump)
      pct           REAL NOT NULL DEFAULT 0,       -- نسبة الخصم % (when pct)
      pay_freq      TEXT NOT NULL DEFAULT 'once',  -- 'once'|'monthly'|'quarterly'|'semiannual'|'yearly'
      bonus_terms   TEXT,                          -- شروط 1+1 وخلافه
      value_kind    TEXT NOT NULL DEFAULT 'rent',  -- 'rent'|'support'|'cda'|'marketing'|'other'
      grace_days    INTEGER NOT NULL DEFAULT 45,   -- فترة سماح السداد
      pay_within    INTEGER NOT NULL DEFAULT 14,   -- الدفع خلال (يوم)
      kind          TEXT NOT NULL DEFAULT 'base',  -- 'base' | 'addendum'
      parent_id     INTEGER,          -- base contract id, when kind='addendum'
      pdf           TEXT,             -- original contract PDF (served via auth route)
      verified      INTEGER NOT NULL DEFAULT 0,    -- passed blind double-entry verification
      coop_ar       TEXT,             -- authoritative Arabic co-op name (as printed in the contract)
      note          TEXT,
      status        TEXT NOT NULL DEFAULT 'active',-- 'active' | 'closed'
      created_by    INTEGER,
      created_at    TEXT,
      updated_by    INTEGER,
      updated_at    TEXT
    );

    -- Contract space placements (البند الأول: الأدوات/المساحات). Each fixture
    -- (جدولة / إستاند / طبلة / متر طولي / ثلاجة) has a scope (main market / all
    -- branches / a specific outlet), a count, dimensions, product category, and
    -- a shelf location.
    CREATE TABLE IF NOT EXISTS contract_items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL,
      scope       TEXT NOT NULL DEFAULT 'main',  -- 'main'|'branches'|'outlet'|'all'
      cust_id     TEXT,              -- outlet, when scope='outlet'
      space_id    INTEGER,           -- FK contract_spaces.id (fixture type)
      space       TEXT,              -- resolved fixture name (denormalized)
      count       INTEGER NOT NULL DEFAULT 1,    -- العدد
      dimensions  TEXT,              -- الأبعاد (free text)
      category    TEXT,              -- الصنف / العلامة
      location    TEXT,              -- الموقع على الرف
      amount      REAL NOT NULL DEFAULT 0,       -- قيمة إيجار هذه المساحة (اختياري)
      description TEXT,              -- الوصف الكامل للمساحة (نص العقد)
      note        TEXT,
      sort        INTEGER NOT NULL DEFAULT 0
    );

    -- Installments / payment delivery schedule (تسليم الدفعات).
    CREATE TABLE IF NOT EXISTS contract_installments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL,
      seq         INTEGER NOT NULL DEFAULT 1,
      due_date    TEXT,
      amount      REAL NOT NULL DEFAULT 0,
      status      TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'paid'
      paid_date   TEXT,
      note        TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_citems_contract ON contract_items(contract_id);
    CREATE INDEX IF NOT EXISTS idx_cinst_contract  ON contract_installments(contract_id);
    CREATE INDEX IF NOT EXISTS idx_chdr_coop       ON contract_hdr(coop);
    CREATE INDEX IF NOT EXISTS idx_chdr_cust       ON contract_hdr(cust_id);
    CREATE INDEX IF NOT EXISTS idx_chdr_parent     ON contract_hdr(parent_id);

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
  if (!coopCols.includes('listing_markets')) db.exec('ALTER TABLE coops ADD COLUMN listing_markets INTEGER');
  // One-off data corrections for existing databases (idempotent):
  // Rawda P9 really has 8 central markets; the two "(?)" placeholder rows are
  // outlets of Rawda mis-seeded as standalone co-ops (they distorted the
  // main-outlet count that prices listing debit notes).
  try {
    db.prepare("UPDATE coops SET mains = 8 WHERE code = 'P9' AND mains = 6").run();
    db.prepare("DELETE FROM coops WHERE name IN ('Hawally (?)', 'Nugra (?)')").run();
    // Normalise lower-case P-codes so joins are case-consistent (p655 -> P655).
    db.prepare("UPDATE coops SET code = UPPER(code) WHERE code GLOB '*[a-z]*'").run();
  } catch (e) { /* corrections are best-effort */ }
  // Link every contract to its co-op by P-code, so a letter (which knows its
  // co-op) can find the governing contract. contract_hdr.coop uses the long
  // outlet-parent name and never matches coops.name, but contract_hdr.coop_ar
  // matches coops.name_ar. Resolved once here into contract_hdr.pcode.
  const chCols = db.prepare("PRAGMA table_info(contract_hdr)").all().map((c) => c.name);
  if (chCols.length && !chCols.includes('pcode')) db.exec('ALTER TABLE contract_hdr ADD COLUMN pcode TEXT');
  try {
    const normAr = (s) => String(s || '').replace(/[ـ]/g, '').replace(/[إأآا]/g, 'ا')
      .replace(/[ىي]/g, 'ي').replace(/[ةه]/g, 'ه').replace(/\s+/g, ' ')
      .replace(/(جمعيه|التعاونيه|المحترمين)/g, '').trim();
    // Drop the seh/heh and the ya/alef-maqsura variance too, so "الصليبيخات"
    // matches "الصليبخات" and "الروضه وحولي" still carries "الروضه".
    const nc = (s) => normAr(s).replace(/\s/g, '');
    // Uppercase P-codes (some rows carry lower-case "p655"/"p702") and skip the
    // junk rows whose code is blank (Arabic-named duplicates) — otherwise their
    // empty code would win the exact match and block the real P-code.
    const coopList = db.prepare("SELECT code, name_ar FROM coops WHERE name_ar IS NOT NULL AND TRIM(COALESCE(code,'')) <> ''").all()
      .map((c) => ({ code: String(c.code).toUpperCase(), k: nc(c.name_ar) })).filter((c) => c.k.length >= 3);
    const byExact = new Map(coopList.map((c) => [c.k, c.code]));
    // Known spelling variants the fuzzy match can't bridge (صليبيخات vs
    // صليبخات, صباح الناصر vs صباح ناصر).
    const ALIAS = [
      [/شمالغربالصليب/, 'P655'], [/الصليبيخات/, 'P44'], [/صباحالناصر/, 'P49'],
    ];
    const resolve = (arName) => {
      const k = nc(arName);
      if (byExact.has(k)) return byExact.get(k);
      for (const [rx, code] of ALIAS) if (rx.test(k)) return code;
      // token containment: the contract name contains a co-op's whole name
      // (e.g. "الاندلسوالرقعي" contains "الاندلس"), longest match wins.
      let best = null, bl = 0;
      for (const c of coopList) {
        if (c.k.length > bl && (k.includes(c.k) || c.k.includes(k))) { best = c.code; bl = c.k.length; }
      }
      return best;
    };
    const setP = db.prepare('UPDATE contract_hdr SET pcode = ? WHERE id = ?');
    const link = db.transaction(() => {
      for (const r of db.prepare('SELECT id, coop_ar FROM contract_hdr WHERE pcode IS NULL AND coop_ar IS NOT NULL').all()) {
        const code = resolve(r.coop_ar);
        if (code) setP.run(code, r.id);
      }
    });
    link();
  } catch (e) { /* linkage is best-effort */ }
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
  // Multi-stage approval chain: supervisor -> sales_manager -> marketing_manager
  // -> sales_ops -> print (admin). appr_stage holds the stage currently pending.
  // Signatures captured at approval are stored in meta.signatures (data URLs).
  addLetterCol('appr_stage', 'TEXT');
  addLetterCol('printed_at', 'TEXT');
  addLetterCol('printed_by', 'INTEGER');
  // Backfill for letters created before the chain existed: an already-approved
  // letter is treated as ready to print; a still-pending one enters the chain at
  // the first (supervisor) stage. Rejected letters keep a null stage.
  db.exec(
    "UPDATE letters SET appr_stage = CASE " +
    "WHEN approval = 'approved' THEN 'print' " +
    "WHEN approval = 'pending' THEN 'supervisor' " +
    "ELSE appr_stage END " +
    "WHERE appr_stage IS NULL AND approval IN ('approved','pending')"
  );
  // Role model change: the old marketing/division/doc roles are retired. Any
  // existing account on them is deactivated (reversible) so it can neither log in
  // nor break the role-keyed UI; an admin can reassign it from the Users screen.
  db.exec("UPDATE users SET active = 0 WHERE role IN ('marketing','division','doc')");
  // Salesmen & supervisors can no longer self-change their password (admin-only),
  // so clear any pending forced-change flag that would otherwise deadlock them.
  db.exec("UPDATE users SET must_change_password = 0 WHERE role IN ('salesman','supervisor') AND must_change_password = 1");
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

  // Contracts redesign: contract_items moved from priced line-items to space
  // placements. Recreate if it still has the old 'item_type' column (no real
  // contract data predates this change).
  const ciInfo = db.prepare("PRAGMA table_info(contract_items)").all();
  if (ciInfo.length && ciInfo.some((c) => c.name === 'item_type')) {
    db.exec('DROP TABLE contract_items');
    db.exec(`CREATE TABLE contract_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, contract_id INTEGER NOT NULL,
      scope TEXT NOT NULL DEFAULT 'main', cust_id TEXT, space_id INTEGER, space TEXT,
      count INTEGER NOT NULL DEFAULT 1, dimensions TEXT, category TEXT, location TEXT,
      note TEXT, sort INTEGER NOT NULL DEFAULT 0)`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_citems_contract ON contract_items(contract_id)');
  }
  // New contract_hdr columns (additive).
  const chInfo = db.prepare("PRAGMA table_info(contract_hdr)").all().map((c) => c.name);
  const addHdr = (name, decl) => { if (!chInfo.includes(name)) db.exec(`ALTER TABLE contract_hdr ADD COLUMN ${name} ${decl}`); };
  addHdr('subject_year', 'TEXT');
  addHdr('is_renewal', 'INTEGER NOT NULL DEFAULT 0');
  addHdr('party_rep', 'TEXT');
  addHdr('contract_date', 'TEXT');
  addHdr('renewable', 'INTEGER NOT NULL DEFAULT 1');
  addHdr('value', 'REAL NOT NULL DEFAULT 0');
  addHdr('value_kind', "TEXT NOT NULL DEFAULT 'rent'");
  addHdr('grace_days', 'INTEGER NOT NULL DEFAULT 45');
  addHdr('pay_within', 'INTEGER NOT NULL DEFAULT 14');
  addHdr('value_mode', "TEXT NOT NULL DEFAULT 'lump'");
  addHdr('pct', 'REAL NOT NULL DEFAULT 0');
  addHdr('pay_freq', "TEXT NOT NULL DEFAULT 'once'");
  addHdr('bonus_terms', 'TEXT');
  addHdr('pdf', 'TEXT');
  addHdr('verified', 'INTEGER NOT NULL DEFAULT 0');
  addHdr('coop_ar', 'TEXT'); // authoritative Arabic co-op name (from the contract itself)
  const ciCols = db.prepare("PRAGMA table_info(contract_items)").all().map((c) => c.name);
  if (!ciCols.includes('description')) db.exec('ALTER TABLE contract_items ADD COLUMN description TEXT');
  if (!ciCols.includes('amount')) db.exec('ALTER TABLE contract_items ADD COLUMN amount REAL NOT NULL DEFAULT 0');

  // New-item approval cycle: extra columns on approve_products for the Union
  // letter (brand + item #) and the returned Union circular / approval (الكتاب
  // الثاني): circular no, circular date and the LYSAL of the Union request.
  const apCols = db.prepare("PRAGMA table_info(approve_products)").all().map((c) => c.name);
  const addApCol = (name, decl) => { if (!apCols.includes(name)) db.exec(`ALTER TABLE approve_products ADD COLUMN ${name} ${decl}`); };
  addApCol('brand', 'TEXT');
  addApCol('item_no', 'TEXT');
  addApCol('carton_barcode', 'TEXT');
  addApCol('circular', 'TEXT');
  addApCol('circular_date', 'TEXT');
  addApCol('union_lysal', 'TEXT');

  const cur = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  if (!cur) {
    db.prepare("INSERT INTO meta(key,value) VALUES('schema_version',?)").run(String(SCHEMA_VERSION));
  }
}

migrate();

module.exports = db;
module.exports.SCHEMA_VERSION = SCHEMA_VERSION;
