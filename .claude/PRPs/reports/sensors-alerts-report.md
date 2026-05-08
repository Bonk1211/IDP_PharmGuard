# Report: Sensor + Alerts Pipeline (PRD Phase 5)

## Summary
Phase 5 ships the alerts pipeline end-to-end: a `public.alerts` Postgres table, a new FastAPI router at `/api/alerts/*` that mirrors the `logs.py` WebSocket-broadcast contract, a Pi-side DS18B20 1-wire reader with the STUB_FAIL_LOUD pattern, and a frontend `Alert` type + `fetchAlerts()` Supabase helper. Migration applied via Supabase MCP.

## Branch
`worktree-agent-ac2371a9ed919b10b` (off `main`).

## Files Created
- `.claude/PRPs/plans/sensors-alerts.plan.md` — full plan.
- `backend/migrations/0003_alerts.sql` — idempotent DDL for `public.alerts` + 3 indexes + 2 named CHECK constraints.
- `backend/app/api/alerts.py` — router with `GET /`, `POST /temperature`, `POST /scan`, `WS /ws`. Async `_insert_alert` writes the row and broadcasts to a private `_ws_clients` list.
- `edge_pi/hardware/temp_sensor.py` — DS18B20 1-wire reader (no third-party dep), STUB_FAIL_LOUD with safe 22 C stub value.

## Files Modified
- `backend/app/main.py` — mount `alerts.router` under `/api/alerts`; alphabetized import.
- `backend/app/core/config.py` — three new settings: `expiry_warn_days=14`, `low_stock_threshold=3`, `over_temp_celsius=30.0`.
- `edge_pi/main.py` — one delimited Phase 5 block at the **top** of the `while True` body (lines ~163-174 post-edit), plus an `import` at line 21, a `report_temperature` helper at lines 78-91, and a constructor `temp_sensor = TempSensor()` at line 121. All edits cleanly delimited.
- `frontend/src/lib/api.ts` — appends `Alert`, `AlertKind`, `AlertSeverity`, `fetchAlerts()`. Fully additive.

## DB Migration Result
**Applied successfully via `mcp__supabase__apply_migration` (name: `phase5_alerts`).** No fallback path needed. Verified with `mcp__supabase__execute_sql` against `information_schema.columns`:

| column | type | nullable | default |
|---|---|---|---|
| id | bigint | NO | (identity) |
| dispenser_id | text | YES | — |
| kind | text | NO | — |
| severity | text | NO | `'info'::text` |
| payload | jsonb | NO | `'{}'::jsonb` |
| created_at | timestamp with time zone | NO | `now()` |

Two CHECK constraints (`alerts_kind_allowed`, `alerts_severity_allowed`) and three indexes (`alerts_created_at_idx DESC`, `alerts_dispenser_id_idx`, `alerts_kind_idx`) created.

## Validation Results

| Check | Result |
|---|---|
| `py_compile backend/app/api/alerts.py backend/app/main.py backend/app/core/config.py` | OK (exit 0) |
| `py_compile edge_pi/hardware/temp_sensor.py edge_pi/main.py` | OK (exit 0) |
| Pi temp sensor stub smoke (`PHARMGUARD_STUB=1`) | `is_stub=True`, `read_celsius()=22.0` |
| Pi temp sensor fail-loud (no stub) | `RuntimeError: TempSensor: no 1-wire device under /sys/bus/w1/devices/28-*; set PHARMGUARD_STUB=1 to allow stub mode` |
| `cd frontend && npm run build` | Compiled successfully in 2.1 s; 7 routes (incl. `/patients/[id]/enroll`) generated; no new TS errors |
| Backend boot (`uvicorn app.main:app --port 8002`) | Started; `/health` → 200 `{"status":"ok"}` |
| `/api/alerts` paths in OpenAPI | `['/api/alerts/', '/api/alerts/scan', '/api/alerts/temperature']` (WS routes intentionally absent from OpenAPI) |
| WS routes via `app.routes` introspection | `['/api/alerts/ws', '/api/logs/ws']` — both registered |
| Supabase column check | All 6 columns present with expected types/defaults |

## Cron / Scheduler Approach
**Operator-poked `POST /api/alerts/scan`** rather than a backend startup task / `asyncio.create_task` loop. Rationale documented in plan §Summary; condensed:
1. Survives uvicorn `--reload` and multi-worker deployments without duplicating alerts.
2. Testable as a one-shot HTTP call — no process loop to wait on.
3. Phase 7 dashboard or any external driver (`crontab`, systemd timer, Supabase pg_cron) can drive cadence per environment.

The scan handler walks all `medications` rows and inserts `expiry`/`low_stock` alert rows for every match, with `severity=critical` when expired/zero-quantity and `severity=warning` otherwise. Each insert WS-broadcasts within the same async hop so end-to-end latency for connected dashboards is one network round-trip — well under the 5 s success target.

## WS Broadcast Policy
A **separate** `_ws_clients` list is held in `alerts.py` rather than reusing `logs._ws_clients`. The logs WS already carries `adherence_logs` row frames consumed by `frontend/src/components/IntakeLog.tsx`; co-mingling alert frames would force every WS consumer to add a discriminator. New endpoint `/api/alerts/ws` keeps the contracts disjoint.

## HI-012 Stub-Mode Invariant
Preserved by construction:
- `temp_sensor.STUB_TEMP_C = 22.0` (constant safe-room value).
- Default backend `over_temp_celsius = 30.0` (>22).
- Backend `POST /temperature` only inserts an alert when `value_c > threshold`.
- Therefore stub-mode samples never produce an over-temp alert. Verified by inspection.

## Risks for Phase 4 Merge

The only conflict surface with Phase 4 (diverter + drawer-lock hardware) is `edge_pi/main.py`. My edit-line ranges:
- **Line 21**: one new import (`from hardware.temp_sensor import TempSensor`).
- **Lines 78-91**: new `report_temperature` helper (between `report_intake` and `run`).
- **Line 121**: one new local `temp_sensor = TempSensor()` between `magazine = Magazine()` and the HI-012 stub guard.
- **Lines 163-174 (post-edit)**: a 12-line Phase 5 block at the **very top** of the `while True` body, bracketed by `# ── Phase 5: …` / `# ── /Phase 5 ──` comment delimiters, before any next-dispense fetch.

Phase 4 is expected to edit the magazine/diverter/drawer-lock block lower in the loop (after `magazine.rotate_to`/`ejector.push`) and the constructor list at lines 119-121. Conflict resolution should be mechanical: keep both new constructors, keep both new imports, keep the Phase 5 block at the loop top, let Phase 4 add its own delimited block lower down. No overlapping line edits.

Backend `app/main.py`, `app/core/config.py`, `app/api/alerts.py`, the migration file, and the frontend `lib/api.ts` are independent of Phase 4 and should merge clean.

## What Was Not Built (Phase 5 explicitly excludes)
- Frontend alerts UI panel (Phase 7 owns dashboard surfaces).
- Alert acknowledgement / resolved column (table is append-only in V1).
- Email / SMS routing.
- Alert deduplication (Phase 7 may add `acknowledged_at`).
- BME280 / I²C humidity sensor (DS18B20 only; one sensor satisfies the success metric).
- Multi-sensor enumeration (single `28-*` device).
- WS reconnection / heartbeat (Phase 7 owns client-side reconnection).
- Backend cron job in Supabase pg_cron (operator-poked endpoint is the contract; pg_cron is one valid driver).

## Notes for the Orchestrator
- This worktree leaves `.claude/PRPs/prds/pharmguard.prd.md` untouched per instructions; the orchestrator should flip Phase 5 row to `complete` after all parallel agents return.
- The plan file lives at `.claude/PRPs/plans/sensors-alerts.plan.md` — orchestrator should archive to `.claude/PRPs/plans/completed/sensors-alerts.plan.md` post-merge.
- This report lives at `.claude/PRPs/reports/sensors-alerts-report.md` per the existing `dual-camera-refactor-report.md` / `face-id-end-to-end-report.md` convention.
