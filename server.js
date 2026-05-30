// FSMA Trace Proxy
// Phone app -> this service -> Airtable Inventory NEW base.
// Holds the Airtable PAT server-side. Append-only writes only.

import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';

const app = express();
const PORT = process.env.PORT || 3000;

// === Config (env-driven) ===
const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
const AIRTABLE_BASE = process.env.AIRTABLE_BASE || 'appPpP3xeZr5kCwFT';
const TBL_PRODUCTIONS = process.env.TBL_PRODUCTIONS || 'tblXJlTeac6vrZx1D';
const TBL_PULL_EVENTS = process.env.TBL_PULL_EVENTS || 'tbl8cxelqOqDIVnJt';
const TBL_STAGE_EVENTS = process.env.TBL_STAGE_EVENTS || 'tbl4lE4O46WT0ITBb';

// === Cost-per-Bar config (additive — does not affect existing routes) ===
const COST_WRITE_TOKEN = process.env.COST_WRITE_TOKEN || ''; // required for snapshot writes
const FT_BASE_URL = process.env.FT_BASE_URL || 'https://film-tracker-production-6024.up.railway.app';
const FT_SERVICE_TOKEN = process.env.FT_SERVICE_TOKEN || ''; // X-Service-Token for FT state read
const SNAPSHOT_DIR = process.env.SNAPSHOT_DIR || '/tmp';
const ALLOWED_RANGES = new Set(['7d', '30d', 'mtd', 'lastmo']);

if (!AIRTABLE_PAT) {
  console.error('FATAL: AIRTABLE_PAT env var not set');
  process.exit(1);
}

// === Middleware ===
app.use(express.json({ limit: '1mb' }));
app.use(cors()); // open CORS for v1; tighten to pplx.app subdomain later

// === Helpers ===
const AT_BASE = `https://api.airtable.com/v0/${AIRTABLE_BASE}`;

async function airtableFetch(path, opts = {}) {
  const url = `${AT_BASE}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${AIRTABLE_PAT}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    const err = new Error(`Airtable ${res.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// Find or create a Production row for a given production_date (ISO YYYY-MM-DD).
// Returns the Airtable record id.
function _safeOpenedBy(v) {
  const allowed = ['Brenda','Steve','Other'];
  return allowed.includes(v) ? v : 'Other';
}

async function getOrCreateProduction(productionDate, openedBy = 'Other') {
  openedBy = _safeOpenedBy(openedBy);
  // 1. Try to find existing
  const filter = encodeURIComponent(`{production_date}='${productionDate}'`);
  const found = await airtableFetch(
    `/${TBL_PRODUCTIONS}?filterByFormula=${filter}&maxRecords=1`
  );
  if (found.records && found.records.length > 0) {
    return found.records[0].id;
  }
  // 2. Create new
  const created = await airtableFetch(`/${TBL_PRODUCTIONS}`, {
    method: 'POST',
    body: JSON.stringify({
      fields: {
        production_date: productionDate,
        status: 'in_progress',
        opened_at: new Date().toISOString(),
        opened_by: openedBy,
      },
    }),
  });
  return created.id;
}

function nowIso() {
  return new Date().toISOString();
}

function badRequest(res, msg) {
  return res.status(400).json({ error: msg });
}

// === Routes ===

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'fsma-trace-proxy',
    base: AIRTABLE_BASE,
    tables: {
      productions: TBL_PRODUCTIONS,
      pull_events: TBL_PULL_EVENTS,
      stage_events: TBL_STAGE_EVENTS,
    },
    cost_snapshot_dir: SNAPSHOT_DIR,
    cost_write_token_set: !!COST_WRITE_TOKEN,
    ft_token_set: !!FT_SERVICE_TOKEN,
    time: nowIso(),
  });
});

// === Cost-per-Bar endpoints (additive, isolated from MAKERAPP) ===
// All three endpoints below are READ-ONLY against Film Tracker and write only to
// SNAPSHOT_DIR JSON files. They do NOT touch Airtable or MAKERAPP in any way.

function snapshotPath(range) {
  return path.join(SNAPSHOT_DIR, `cost-per-bar-${range}.json`);
}

// Compute date range start/end (YYYY-MM-DD in America/Los_Angeles) for a preset.
function computeRange(range, nowDate = new Date()) {
  // Get today's date in PT
  const pt = new Date(nowDate.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const y = pt.getFullYear();
  const m = pt.getMonth(); // 0-indexed
  const d = pt.getDate();
  const today = new Date(y, m, d);
  const fmt = (date) => {
    const yr = date.getFullYear();
    const mo = String(date.getMonth() + 1).padStart(2, '0');
    const da = String(date.getDate()).padStart(2, '0');
    return `${yr}-${mo}-${da}`;
  };
  if (range === '7d') {
    const start = new Date(today); start.setDate(start.getDate() - 6);
    return { start: fmt(start), end: fmt(today) };
  }
  if (range === '30d') {
    const start = new Date(today); start.setDate(start.getDate() - 29);
    return { start: fmt(start), end: fmt(today) };
  }
  if (range === 'mtd') {
    const start = new Date(y, m, 1);
    return { start: fmt(start), end: fmt(today) };
  }
  if (range === 'lastmo') {
    const lastMoEnd = new Date(y, m, 0); // day 0 of this month = last day of last month
    const lastMoStart = new Date(lastMoEnd.getFullYear(), lastMoEnd.getMonth(), 1);
    return { start: fmt(lastMoStart), end: fmt(lastMoEnd) };
  }
  return null;
}

// GET /api/bars-per-range?start=YYYY-MM-DD&end=YYYY-MM-DD
// or   /api/bars-per-range?range=7d|30d|mtd|lastmo
// Reads Film Tracker state, computes bars per SKU for plans FINISHED in the window.
app.get('/api/bars-per-range', async (req, res) => {
  try {
    let start = req.query.start;
    let end = req.query.end;
    if (req.query.range) {
      const r = String(req.query.range).toLowerCase();
      if (!ALLOWED_RANGES.has(r)) return badRequest(res, `invalid range: ${r}`);
      const computed = computeRange(r);
      if (!computed) return badRequest(res, `cannot compute range: ${r}`);
      start = computed.start;
      end = computed.end;
    }
    if (!start || !end) return badRequest(res, 'start and end (or range) required');
    if (!FT_SERVICE_TOKEN) return res.status(500).json({ error: 'FT_SERVICE_TOKEN not configured' });

    const ftRes = await fetch(`${FT_BASE_URL}/api/state`, {
      headers: { 'X-Service-Token': FT_SERVICE_TOKEN },
    });
    if (!ftRes.ok) {
      const txt = await ftRes.text();
      return res.status(502).json({ error: `FT state fetch failed ${ftRes.status}`, body: txt.slice(0, 300) });
    }
    const ft = await ftRes.json();
    const plans = Array.isArray(ft.plans) ? ft.plans : [];
    const flavors = Array.isArray(ft.flavors) ? ft.flavors : [];
    const flavorById = new Map(flavors.map(f => [f.id, f]));

    const startDate = new Date(`${start}T00:00:00-08:00`); // PT-ish; finished_at is UTC ISO
    const endDate = new Date(`${end}T23:59:59-08:00`);

    const barsBySku = {};
    const matchedPlans = [];
    for (const plan of plans) {
      if (plan.status !== 'FINISHED') continue;
      if (!plan.finished_at) continue;
      const fa = new Date(plan.finished_at);
      if (fa < startDate || fa > endDate) continue;
      matchedPlans.push(plan.id);
      const rows = Array.isArray(plan.rows) ? plan.rows : [];
      for (const row of rows) {
        const flavor = flavorById.get(row.flavor_id);
        const sku = flavor?.sku || flavor?.name || `flavor_${row.flavor_id}`;
        const bars = Number(row.batches || 0) * Number(row.bars_per_batch || 0);
        if (!bars) continue;
        barsBySku[sku] = (barsBySku[sku] || 0) + bars;
      }
    }
    const total = Object.values(barsBySku).reduce((a, b) => a + b, 0);
    return res.json({
      ok: true,
      start, end,
      total_bars: total,
      bars_by_sku: barsBySku,
      matched_plan_ids: matchedPlans,
    });
  } catch (e) {
    console.error('bars-per-range error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/cost-snapshot/:range  -> read snapshot (dashboard reads this)
app.get('/api/cost-snapshot/:range', (req, res) => {
  const r = String(req.params.range).toLowerCase();
  if (!ALLOWED_RANGES.has(r)) return badRequest(res, `invalid range: ${r}`);
  const p = snapshotPath(r);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'snapshot not found', range: r });
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'snapshot parse failed', detail: e.message });
  }
});

// POST /api/cost-snapshot/:range  -> write snapshot (Make scenario calls this)
// Auth: X-Cost-Write-Token header must match COST_WRITE_TOKEN env
// Body: arbitrary snapshot JSON (will be stored verbatim with server timestamp added)
app.post('/api/cost-snapshot/:range', (req, res) => {
  if (!COST_WRITE_TOKEN) return res.status(500).json({ error: 'COST_WRITE_TOKEN not configured' });
  const provided = req.get('X-Cost-Write-Token') || '';
  if (provided !== COST_WRITE_TOKEN) return res.status(401).json({ error: 'invalid write token' });
  const r = String(req.params.range).toLowerCase();
  if (!ALLOWED_RANGES.has(r)) return badRequest(res, `invalid range: ${r}`);
  const body = req.body || {};
  const enriched = {
    ...body,
    range: r,
    written_at: nowIso(),
  };
  try {
    fs.writeFileSync(snapshotPath(r), JSON.stringify(enriched, null, 2));
    res.json({ ok: true, range: r, path: snapshotPath(r), written_at: enriched.written_at });
  } catch (e) {
    console.error('snapshot write error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/pull-event
// Body: {
//   production_date: "YYYY-MM-DD",
//   lot_id, sku, supplier,
//   qty_pulled, qty_original, qty_remaining_after,
//   unit, from_location,
//   also_staged (bool),
//   user, device_id?, notes?,
//   correction_of_event_id? (Airtable rec id)
// }
app.post('/api/pull-event', async (req, res) => {
  try {
    const b = req.body || {};
    const required = ['production_date', 'lot_id', 'sku', 'supplier', 'qty_pulled', 'qty_original', 'qty_remaining_after', 'unit', 'from_location', 'user'];
    for (const k of required) {
      if (b[k] === undefined || b[k] === null || b[k] === '') {
        return badRequest(res, `missing required field: ${k}`);
      }
    }

    const prodId = await getOrCreateProduction(b.production_date, b.user);

    const fields = {
      lot_id: String(b.lot_id),
      production_date: [prodId],
      sku: String(b.sku),
      supplier: String(b.supplier),
      qty_pulled: Number(b.qty_pulled),
      qty_original: Number(b.qty_original),
      qty_remaining_after: Number(b.qty_remaining_after),
      unit_txt: String(b.unit),
      from_location_txt: String(b.from_location),
      also_staged: !!b.also_staged,
      timestamp: b.timestamp || nowIso(),
      user_txt: String(b.user),
    };
    if (b.device_id) fields.device_id = String(b.device_id);
    if (b.notes) fields.notes = String(b.notes);
    if (b.correction_of_event_id) fields.correction_of = [b.correction_of_event_id];

    const created = await airtableFetch(`/${TBL_PULL_EVENTS}`, {
      method: 'POST',
      body: JSON.stringify({ fields }),
    });

    // If also_staged, write a Stage_Event too (origin=pull-inline, linked_pull_event=created.id)
    let stageRec = null;
    if (b.also_staged) {
      const stageFields = {
        lot_id: fields.lot_id,
        production_date: [prodId],
        sku: fields.sku,
        qty: fields.qty_pulled,
        unit_txt: fields.unit_txt,
        from_location_txt: fields.from_location_txt,
        to_location_txt: 'Main Kitchen',
        origin_txt: 'pull-inline',
        linked_pull_event: [created.id],
        timestamp: fields.timestamp,
        user_txt: fields.user_txt,
      };
      if (b.device_id) stageFields.device_id = fields.device_id;
      stageRec = await airtableFetch(`/${TBL_STAGE_EVENTS}`, {
        method: 'POST',
        body: JSON.stringify({ fields: stageFields }),
      });
    }

    res.json({
      ok: true,
      production_id: prodId,
      pull_event: { id: created.id, fields: created.fields },
      stage_event: stageRec ? { id: stageRec.id, fields: stageRec.fields } : null,
    });
  } catch (e) {
    console.error('pull-event error:', e.message);
    res.status(e.status || 500).json({ error: e.message, body: e.body });
  }
});

// POST /api/stage-event
// Body: {
//   production_date, lot_id, sku, qty, unit,
//   from_location, to_location? (default Main Kitchen),
//   user, device_id?, notes?,
//   correction_of_event_id?
// }
// origin is always 'stage-flow' for this endpoint.
app.post('/api/stage-event', async (req, res) => {
  try {
    const b = req.body || {};
    const required = ['production_date', 'lot_id', 'sku', 'qty', 'unit', 'from_location', 'user'];
    for (const k of required) {
      if (b[k] === undefined || b[k] === null || b[k] === '') {
        return badRequest(res, `missing required field: ${k}`);
      }
    }
    const prodId = await getOrCreateProduction(b.production_date, b.user);

    const fields = {
      lot_id: String(b.lot_id),
      production_date: [prodId],
      sku: String(b.sku),
      qty: Number(b.qty),
      unit_txt: String(b.unit),
      from_location_txt: String(b.from_location),
      to_location_txt: String(b.to_location || 'Main Kitchen'),
      origin_txt: String(b.origin || 'stage-flow'),
      timestamp: b.timestamp || nowIso(),
      user_txt: String(b.user),
    };
    if (b.device_id) fields.device_id = String(b.device_id);
    if (b.notes) fields.notes = String(b.notes);
    if (b.correction_of_event_id) fields.correction_of = [b.correction_of_event_id];

    const created = await airtableFetch(`/${TBL_STAGE_EVENTS}`, {
      method: 'POST',
      body: JSON.stringify({ fields }),
    });

    res.json({
      ok: true,
      production_id: prodId,
      stage_event: { id: created.id, fields: created.fields },
    });
  } catch (e) {
    console.error('stage-event error:', e.message);
    res.status(e.status || 500).json({ error: e.message, body: e.body });
  }
});

// POST /api/production  (explicit open/close)
// Body: { production_date, action: 'open'|'close', user, notes? }
app.post('/api/production', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.production_date || !b.action || !b.user) {
      return badRequest(res, 'production_date, action, user required');
    }
    if (b.action === 'open') {
      const id = await getOrCreateProduction(b.production_date, b.user);
      return res.json({ ok: true, production_id: id });
    }
    if (b.action === 'close') {
      // find then patch
      const filter = encodeURIComponent(`{production_date}='${b.production_date}'`);
      const found = await airtableFetch(`/${TBL_PRODUCTIONS}?filterByFormula=${filter}&maxRecords=1`);
      if (!found.records || found.records.length === 0) {
        return res.status(404).json({ error: 'production not found' });
      }
      const id = found.records[0].id;
      const fields = { status: 'closed', closed_at: nowIso() };
      if (b.notes) fields.notes = String(b.notes);
      const patched = await airtableFetch(`/${TBL_PRODUCTIONS}/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ fields }),
      });
      return res.json({ ok: true, production_id: id, fields: patched.fields });
    }
    return badRequest(res, `unknown action: ${b.action}`);
  } catch (e) {
    console.error('production error:', e.message);
    res.status(e.status || 500).json({ error: e.message, body: e.body });
  }
});

// GET /api/productions  -> list recent
app.get('/api/productions', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const data = await airtableFetch(
      `/${TBL_PRODUCTIONS}?pageSize=${limit}&sort%5B0%5D%5Bfield%5D=production_date&sort%5B0%5D%5Bdirection%5D=desc`
    );
    res.json({ ok: true, productions: data.records });
  } catch (e) {
    console.error('list productions error:', e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// GET /api/production/:date  -> all events for a production_date
app.get('/api/production/:date', async (req, res) => {
  try {
    const date = req.params.date;
    const filter = encodeURIComponent(`{production_date}='${date}'`);
    const [pulls, stages] = await Promise.all([
      airtableFetch(`/${TBL_PULL_EVENTS}?filterByFormula=${filter}&pageSize=100`),
      airtableFetch(`/${TBL_STAGE_EVENTS}?filterByFormula=${filter}&pageSize=100`),
    ]);
    res.json({
      ok: true,
      production_date: date,
      pull_events: pulls.records,
      stage_events: stages.records,
    });
  } catch (e) {
    console.error('production detail error:', e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// GET /api/lot/:lot_id  -> lot trace
app.get('/api/lot/:lot_id', async (req, res) => {
  try {
    const lot = req.params.lot_id;
    const filter = encodeURIComponent(`{lot_id}='${lot}'`);
    const [pulls, stages] = await Promise.all([
      airtableFetch(`/${TBL_PULL_EVENTS}?filterByFormula=${filter}&pageSize=100`),
      airtableFetch(`/${TBL_STAGE_EVENTS}?filterByFormula=${filter}&pageSize=100`),
    ]);
    res.json({
      ok: true,
      lot_id: lot,
      pull_events: pulls.records,
      stage_events: stages.records,
    });
  } catch (e) {
    console.error('lot trace error:', e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`fsma-trace-proxy listening on :${PORT}`);
  console.log(`  base=${AIRTABLE_BASE}`);
  console.log(`  productions=${TBL_PRODUCTIONS}`);
  console.log(`  pull_events=${TBL_PULL_EVENTS}`);
  console.log(`  stage_events=${TBL_STAGE_EVENTS}`);
});
