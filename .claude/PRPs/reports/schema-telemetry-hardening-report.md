# Implementation Report: Schema + Telemetry Hardening (PRD Phase 1)

## Summary
Additive schema delta on `public.medications` and `public.adherence_logs` plus matching Pydantic + TypeScript + Pi-side env updates. All code edits applied and load-tested. **Database migration is queued but unapplied** — Supabase MCP server was unreachable for the entire session (`Connection terminated due to connection timeout` on every `apply_migration`, `execute_sql`, and `list_tables` call). Plan's documented fallback applies: operator pastes `backend/migrations/0001_phase1_schema_hardening.sql` into the Supabase Studio SQL editor for project `wqijdqclqhybhdtgsznf`. Until that runs, Pi → backend → DB inserts will fail at the Postgres layer because the new columns don't exist yet.

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Small | Small |
| Confidence | 9/10 | 8/10 (DB apply blocked on infra) |
| Files Changed | 7 | 9 (added `.env.example` doc updates on both backend + Pi; one new SQL migration) |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | Author SQL migration 0001 | Complete | `backend/migrations/0001_phase1_schema_hardening.sql` |
| 2 | Apply migration via Supabase MCP | **Blocked — handoff needed** | MCP timeouts all session; SQL ready for manual apply |
| 3 | Extend `IntakeLog` model | Complete | Added `dispenser_id`, `confidence_score` (both `\| None = None`) |
| 4 | Extend `SlotUpdate` + inventory endpoints | Complete | Added 3 fields; widened `update_slot` payload + `next_dispense` response |
| 5 | Add `default_dispenser_id` to backend Settings | Complete | Documented in `backend/.env.example` |
| 6 | Extend frontend types | Complete | `SlotInfo` + `IntakeRecord` in `lib/api.ts`; `npm run build` green |
| 7 | Wire `DISPENSER_ID` env on Pi | Complete | `_Settings`, `_load()`, `report_intake` updated; `.env.example` documented |
| 8 | Validate: build + smoke + edge cases | Complete | Backend `py_compile` + Pydantic round-trip + `next build` all pass; DB-dependent smoke deferred |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis (Python) | Pass | `python3 -m py_compile` clean on `backend/app/api/{inventory,logs}.py`, `backend/app/core/config.py`, `edge_pi/{config,main}.py` |
| Static Analysis (TypeScript) | Pass | `next build` compiles, type-checks, and prerenders all 7 routes |
| Lint | N/A | `next lint` is interactive prompt (ESLint not configured in repo); not a regression |
| Pydantic round-trip | Pass | Legacy + forward-compat verified for both `IntakeLog` and `SlotUpdate`; defaults match DB |
| Pi config round-trip | Pass | `validate()` passes with and without `DISPENSER_ID` env set |
| Build | Pass | `next build` finished in 2.1s, zero TS errors |
| Integration (curl + DB) | **Deferred** | Requires migration applied + `DEVICE_TOKENS` set in `backend/.env` |
| Edge Cases | Partial | Pydantic-layer cases verified (legacy client, full client, defaults). DB-CHECK cases (`pills_per_dose=0`, `confidence_score=1.5`) deferred to post-migration. |

## Files Changed

| File | Action | Diff |
|---|---|---|
| `backend/migrations/0001_phase1_schema_hardening.sql` | CREATED | +43 |
| `backend/app/api/logs.py` | UPDATED | +2 / -0 |
| `backend/app/api/inventory.py` | UPDATED | +9 / -0 |
| `backend/app/core/config.py` | UPDATED | +1 / -0 |
| `backend/.env.example` | UPDATED | +2 / -0 |
| `frontend/src/lib/api.ts` | UPDATED | +5 / -0 |
| `edge_pi/config.py` | UPDATED | +3 / -0 |
| `edge_pi/main.py` | UPDATED | +5 / -3 |
| `edge_pi/.env.example` | UPDATED | +3 / -0 |

Plus the planning artifacts already present from the PRD/Plan steps:
- `.claude/PRPs/prds/pharmguard.prd.md`
- `.claude/PRPs/plans/schema-telemetry-hardening.plan.md`
- `.claude/PRPs/reports/schema-telemetry-hardening-report.md` (this file)

## Deviations from Plan

- **Lint command**: Plan specified `npm run lint` (Next 15 `next lint`), but that triggers an interactive ESLint setup wizard since ESLint isn't configured in this repo. Substituted `npm run build` as the static-analysis gate — it runs the same TS type checker and is non-interactive. **Why**: plan's intent (static analysis) is satisfied; running an interactive prompt headless would hang. No change to acceptance criteria.
- **`.env.example` documentation**: Plan mentioned only `backend/.env.example`. I also added a `DISPENSER_ID=` line to `edge_pi/.env.example` since the Pi-side env is the new field's primary consumer. **Why**: omitting it would leave operators with no documented way to set `DISPENSER_ID`. Strictly additive.
- **Branch decision**: User answered "Stay on main" (vs plan's default "create feat/* branch"). All edits land on `main`, uncommitted. User must commit explicitly.

## Issues Encountered

1. **Supabase MCP unreachable.** Every call (`apply_migration`, `execute_sql`, `list_tables`) returned `HttpException — Connection terminated due to connection timeout` from `https://mcp.supabase.com/mcp?project_ref=wqijdqclqhybhdtgsznf`. Reproducible across the whole session including a final retry after all code edits landed. Fallback: operator pastes the SQL file into Supabase Studio.
2. **Backend `.env` lacks `DEVICE_TOKENS`.** End-to-end curl smoke against a running uvicorn is blocked on this anyway; user can set `DEVICE_TOKENS` and re-run the validation block from the plan's "Backend Smoke" section once the DB is migrated.
3. **GateGuard fact-forcing hook fired on every Edit/Write.** Tasks proceeded but burned tokens restating facts per file. User opted to keep the hook on. Not a code issue; flagging for harness tuning.

## Tests Written

None — repo has no test framework configured (`CLAUDE.md`: "There is **no test suite** in this repo yet"). Validation strategy was per-task `VALIDATE` blocks (curl + Pydantic introspection + build), as specified in the plan.

## Open Handoff Items

To finish Phase 1 the user must:

1. **Apply the migration** in Supabase Studio:
   - Open https://supabase.com/dashboard/project/wqijdqclqhybhdtgsznf/sql/new
   - Paste contents of `backend/migrations/0001_phase1_schema_hardening.sql`
   - Run. Idempotent — safe to re-run.
2. **(Optional) Set `DEVICE_TOKENS=...`** in `backend/.env` and run the curl smoke from the plan's "Backend Smoke" block to verify end-to-end.
3. **Commit the change set.** Suggested message:
   ```
   feat(phase1): add dispenser_id, expiry_date, pills_per_dose, confidence_score schema fields

   Adds the Phase 1 schema delta required by Face ID, alerts, dashboards, and
   accuracy-validation phases of the PharmGuard PRD. Additive only — legacy
   clients keep working without new fields.
   ```
4. **Flip PRD Phase 1 status** to `complete` and add this report path to the row, once steps 1–3 are done.

## Next Steps
- [ ] User: apply SQL migration in Supabase Studio.
- [ ] User: optional curl smoke after `DEVICE_TOKENS` is set.
- [ ] User: commit the change set on `main` (or create a feature branch retroactively).
- [ ] After merge: `/prp-plan .claude/PRPs/prds/pharmguard.prd.md` will pick up Phase 2 (Dual-camera refactor) — already eligible since Phase 1 + Phase 2 are parallel-safe.
