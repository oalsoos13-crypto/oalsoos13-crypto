'use strict';
const db = require('./db');
const { fromJson } = require('./util');
const { SEED } = require('./seed-data');

// Resolve user id -> display name (cached per call).
function nameResolver() {
  const rows = db.prepare('SELECT id, name FROM users').all();
  const map = new Map(rows.map((r) => [r.id, r.name]));
  return (id) => (id != null && map.has(id) ? map.get(id) : null);
}

function mapLetter(r, nameOf) {
  return {
    id: r.id, num: r.num, lysal: r.lysal, type: r.type, coop: r.coop,
    brand: r.brand, sales: r.sales, date: r.date, principal: r.principal,
    note: r.note, value: r.value, base: r.base, pct: r.pct,
    items: fromJson(r.items, null), status: r.status,
    createdBy: r.created_by, createdByName: nameOf(r.created_by),
    createdAt: r.created_at,
  };
}

function mapNote(r, nameOf) {
  return {
    id: r.id, num: r.num, lysal: r.lysal, letterId: r.letter_id, coopDN: r.coop_dn,
    type: r.type, coop: r.coop, brand: r.brand, sales: r.sales, value: r.value,
    date: r.date, items: fromJson(r.items, null), note: r.note,
    attachments: fromJson(r.attachments, []), status: r.status,
    createdBy: r.created_by, createdByName: nameOf(r.created_by), createdAt: r.created_at,
    supApprovedBy: r.sup_approved_by, supApprovedByName: nameOf(r.sup_approved_by), supApprovedAt: r.sup_approved_at,
    mgrApprovedBy: r.mgr_approved_by, mgrApprovedByName: nameOf(r.mgr_approved_by), mgrApprovedAt: r.mgr_approved_at,
    rejectedBy: r.rejected_by, rejectedByName: nameOf(r.rejected_by), rejectedAt: r.rejected_at,
    rejectedStage: r.rejected_stage, rejectReason: r.reject_reason,
  };
}

function mapDist(r) {
  return {
    id: r.id, sup: r.sup, sales: r.sales, coop: r.coop, outlet: r.outlet,
    wob: r.wob, amt: r.amt, manual: !!r.manual,
  };
}

// Build the complete client state object (mirrors the original in-browser DB shape).
function buildState() {
  const nameOf = nameResolver();

  const budgets = db.prepare('SELECT * FROM budgets ORDER BY created_at ASC').all().map((b) => ({
    id: b.id, from: b.period_from, to: b.period_to, preset: b.preset,
    amount: b.amount, created: (b.created_at || '').slice(0, 10),
    createdByName: nameOf(b.created_by),
  }));

  const channels = {};
  db.prepare('SELECT channel, amount FROM channel_alloc').all()
    .forEach((c) => { channels[c.channel] = c.amount; });

  const dist = db.prepare(
    "SELECT * FROM dist ORDER BY (sup=''), sup, (sales=''), sales, (coop=''), coop, outlet"
  ).all().map(mapDist);
  const letters = db.prepare('SELECT * FROM letters ORDER BY created_at ASC').all().map((r) => mapLetter(r, nameOf));
  const notes = db.prepare('SELECT * FROM notes ORDER BY created_at ASC').all().map((r) => mapNote(r, nameOf));

  const counter = db.prepare("SELECT value FROM counters WHERE name='lysal'").get();

  const coops = db.prepare('SELECT name, code, mains, branches FROM coops ORDER BY mains DESC, name ASC')
    .all().map((c) => ({ n: c.name, p: c.code, m: c.mains, b: c.branches }));

  return {
    year: require('./config').refYear,
    budgets,
    budget: { channels },
    dist,
    letters,
    notes,
    counter: counter ? counter.value : 0,
    ref: {
      coops,
      brands: SEED.brands,
      principals: SEED.principals,
      channels: SEED.channels,
      letterTypes: SEED.letterTypes,
      supervisors: SEED.supervisors,
      channelsEn: SEED.channelsEn,
    },
  };
}

module.exports = { buildState, mapLetter, mapNote, mapDist };
