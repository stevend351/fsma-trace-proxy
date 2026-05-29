# fsma-trace-proxy

Phone -> Airtable proxy for FSMA traceability events. Holds the Airtable PAT server-side. Append-only writes.

## Env vars

| Var | Required | Default |
|---|---|---|
| `AIRTABLE_PAT` | yes | (none) — fatal if unset |
| `AIRTABLE_BASE` | no | `appPpP3xeZr5kCwFT` (Inventory NEW) |
| `TBL_PRODUCTIONS` | no | `tblXJlTeac6vrZx1D` |
| `TBL_PULL_EVENTS` | no | `tbl8cxelqOqDIVnJt` |
| `TBL_STAGE_EVENTS` | no | `tbl4lE4O46WT0ITBb` |
| `PORT` | no | `3000` |

## Endpoints

- `GET  /api/health` — sanity check
- `POST /api/pull-event` — log a pull (auto-creates Production row if missing; also writes Stage_Event if also_staged=true)
- `POST /api/stage-event` — log a standalone stage (origin=stage-flow)
- `POST /api/production` — open/close a production day explicitly
- `GET  /api/productions?limit=50` — list recent productions
- `GET  /api/production/:date` — all pull+stage events for one production_date
- `GET  /api/lot/:lot_id` — lot trace across pull+stage

## Local run

```bash
npm install
AIRTABLE_PAT=patXXXX npm start
```

## Railway deploy

1. New project from this directory
2. Add env var `AIRTABLE_PAT` (the railway-ops PAT)
3. Deploy; Railway auto-detects Node from `package.json`

## Phone wire-up

Replace `window._pulls.push(...)` / `window._stageEvents.push(...)` in the receiving-prototype with:

```js
fetch(`${PROXY_URL}/api/pull-event`, {
  method: 'POST',
  headers: {'Content-Type':'application/json'},
  body: JSON.stringify({...event payload...})
}).then(r => r.json()).catch(err => {
  // graceful fallback: queue locally
});
```
