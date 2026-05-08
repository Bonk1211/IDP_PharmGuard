# Plan: End-to-End Bench Loop (PRD Phase 6)

## Summary
Build a 200-cycle automated happy-path bench that drives `edge_pi/main.py` through the full schedule → magazine → eject → pill-ID → diverter → drawer-unlock → log loop on real Pi 5 hardware. Capture per-phase timings (YOLO inference, DB write, end-to-end cycle) and report pass/fail vs PRD success metrics (`<200 ms` YOLO, `<500 ms` DB write, `<8 s` e2e cycle). Face ID and swallow FSM are mocked in `BENCH_MODE` so the bench finishes in ~5–10 min instead of 200 swallows; mechanism + YOLO + DB write all run for real. Bench rows are partitioned by `dispenser_id="bench-001"` so production data is untouched.

## User Story
As the **PharmGuard engineering team**, I want **a one-command 200-cycle bench that produces a Pass/Fail report against the PRD's quantitative success metrics**, so that **we have a defensible "it works end-to-end at the published latencies" artefact before the pilot freeze, and any regression in a future commit shows up as a delta in the metrics report**.

## Problem → Solution
**Today**: `edge_pi/main.py` runs an infinite polling loop. There is no way to drive it through N cycles with timing instrumentation. The PRD's "<200 ms YOLO inference, <500 ms DB write, <8 s end-to-end" claims are forecasts, not measurements. There is also no way to isolate bench rows from production — `next_dispense` returns any non-null-patient row.
**After**: A new `BENCH_MODE=1` env on the Pi turns on per-phase `time.perf_counter()` instrumentation, a CSV writer at `BENCH_LOG_PATH`, and short-circuits for liveness + swallow (real Face ID + 60 s swallow watch would balloon the bench to hours). Backend `next_dispense` accepts an optional `?dispenser_id=` filter so the Pi only picks up its bench rows. A new `scripts/bench_e2e.py` orchestrator seeds 200 dispense events, waits for the Pi to drain them, reads the CSV, and prints a Pass/Fail metrics report.

## Metadata
- **Complexity**: Medium
- **Source PRD**: `.claude/PRPs/prds/pharmguard.prd.md`
- **PRD Phase**: 6 — End-to-end bench loop
- **Estimated Files**: 6 (1 backend update + 2 Pi config + 1 Pi main update + 2 new scripts)
- **Estimated Lines**: ~350 LOC

---

## UX Design

Internal change — no user-facing UX transformation. New CLI: `python3 scripts/bench_e2e.py --cycles 200`.

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| `GET /api/inventory/next-dispense` | returns any non-null-patient row | accepts optional `?dispenser_id=…` filter; backwards-compat when omitted | additive |
| Pi `main.py` cycle | no per-phase timing | when `BENCH_MODE=1`, writes one CSV row per cycle to `BENCH_LOG_PATH` | env-gated |
| Pi `main.py` Face ID gate | full liveness + backend `/verify-face` call | when `BENCH_MODE=1`, short-circuits to a synthetic match for the bench dispenser | mock |
| Pi `main.py` swallow | `monitor.watch_for_swallow(timeout_s=60)` | when `BENCH_MODE=1`, returns True instantly | mock |
| New CLI: `bench_e2e.py` | did not exist | seeds 200 rows, waits, reports metrics, cleans up | new |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `edge_pi/main.py` | full file | Cycle structure: schedule poll → liveness → magazine → eject → diverter → drawer_lock → swallow → log POST. Phase 4 + Phase 5 sentinel comments must be respected. |
| P0 | `edge_pi/scripts/bench_dual_cam.py` | full file | BENCH_SCRIPT_PATTERN — argparse + p50/p95/max + Pass/Fail print. Mirror this style for the e2e bench. |
| P0 | `backend/app/api/inventory.py` | full file | `next_dispense` lines 26–49 — where the optional `dispenser_id` filter lands |
| P0 | `backend/app/api/logs.py` | 22–48 | `create_log` decrements `medications.quantity`; the bench relies on this to drive 200 cycles |
| P0 | `edge_pi/config.py` | 38–123 | `_Settings` dataclass + lazy proxy — pattern for adding `BENCH_MODE` + `BENCH_LOG_PATH` |
| P0 | `.claude/PRPs/plans/completed/dual-camera-refactor.plan.md` | "Patterns to Mirror" | BENCH_SCRIPT_PATTERN, NAMING, LOGGING |
| P1 | `edge_pi/vision/pill_verifier.py` | 50–75 | YOLO inference call site for timing instrumentation |
| P1 | `edge_pi/vision/liveness.py` | full | Reference for the synthetic-crop short-circuit |
| P1 | `edge_pi/vision/intake_monitor.py` | 207–261 | `watch_for_swallow` — must NOT be modified; bench short-circuits at the call site |
| P2 | `.claude/PRPs/prds/pharmguard.prd.md` | Success Metrics table | The bench targets — `<200 ms` YOLO, `<500 ms` DB write, `<8 s` e2e, fail-safe 100% |
| P2 | `CLAUDE.md` | "Edge Pi" + HI-012 | Stub-mode rules — bench refuses to run when hardware stubbed |

## External Documentation

No external research required — stdlib only (`time.perf_counter`, `csv`, `statistics`, `pathlib`, `argparse`).

---

## Patterns to Mirror

### NAMING_CONVENTION
```python
# SOURCE: edge_pi/scripts/bench_dual_cam.py:1-25
#!/usr/bin/env python3
"""Bench two CSI cameras running simultaneously on Pi 5."""
from __future__ import annotations

import argparse
import logging
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from vision.camera import open_camera  # noqa: E402
```
Rule: `#!/usr/bin/env python3` shebang; module docstring with PRD reference; argparse with sensible defaults; no new deps; insert parent dir on `sys.path` when scripts import `vision.*`.

### CONFIG_PATTERN_PI
```python
# SOURCE: edge_pi/config.py:42-90
@dataclass(frozen=True)
class _Settings:
    BACKEND_URL: str
    DEVICE_TOKEN: str
    POLL_INTERVAL_S: float
    STUB_MODE: bool
    DISPENSER_ID: str

def _load() -> _Settings:
    backend_url = _require("BACKEND_URL")
    device_token = _require("DEVICE_TOKEN")
    poll_interval = float(os.environ.get("POLL_INTERVAL_S", "30"))
    stub_mode = os.environ.get("PHARMGUARD_STUB", "0") == "1"
    dispenser_id = os.environ.get("DISPENSER_ID", "")
    return _Settings(...)
```
Rule: frozen dataclass + `_load()` reads env. New optional fields use `os.environ.get(name, default)` (not `_require`).

### STUB_FAIL_LOUD_PATTERN (preserved)
```python
# SOURCE: edge_pi/main.py:130-151 (post-merge)
hardware_stubbed = (
    magazine.is_stub or ejector.is_stub or diverter.is_stub
    or drawer_lock.is_stub or temp_sensor.is_stub
)
if hardware_stubbed:
    if not settings.STUB_MODE:
        log.error(...)
        sys.exit(1)
    log.warning("STUB MODE: hardware not real ...")
```
Rule: BENCH_MODE must respect this. Bench refuses to run when `hardware_stubbed=True` regardless of `BENCH_MODE` value — falsified telemetry would invalidate the bench numbers.

### LOGGING_PATTERN
```python
# SOURCE: edge_pi/main.py:30 + many call sites
log = logging.getLogger(__name__)
log.info("Dispensing slot %d for patient %d", slot, patient_id)
```
Rule: positional formatters, never f-strings.

### DATA_ACCESS_PATTERN (Pi → backend)
```python
# SOURCE: edge_pi/main.py current next-dispense GET
resp = session.get(
    f"{settings.BACKEND_URL}/api/inventory/next-dispense", timeout=5
)
```
Rule: shared `session` (already authed); explicit timeout. Bench adds `params={"dispenser_id": ...}`.

### TIMING_INSTRUMENTATION_PATTERN (new)
```python
t0 = time.perf_counter()
magazine.rotate_to(slot)
t_rotate = time.perf_counter()
ejector.push()
t_eject = time.perf_counter()
pill_id_pass = verifier.confirm_tray_empty()
t_pillid = time.perf_counter()
...
```
Rule: monotonic clock only (`perf_counter`, never `time()`); record absolute checkpoints, compute deltas at write-time.

### TEST_STRUCTURE
N/A — repo has no test framework. Validation = py_compile + dry-run textual checks + Pi-hardware operator run.

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `backend/app/api/inventory.py` | UPDATE | `next_dispense` accepts optional `?dispenser_id=` query param; backwards-compat when omitted |
| `edge_pi/config.py` | UPDATE | Add `BENCH_MODE: bool` + `BENCH_LOG_PATH: str` |
| `edge_pi/.env.example` | UPDATE | Document the two new env keys |
| `edge_pi/main.py` | UPDATE | Per-phase `perf_counter` instrumentation, CSV writer when `BENCH_MODE=1`, bench short-circuits for liveness + swallow, pass `dispenser_id` to `next-dispense` |
| `edge_pi/scripts/bench_e2e.py` | CREATE | Orchestrator: seed → wait → read CSV → report → cleanup |
| `edge_pi/scripts/_bench_helpers.py` | CREATE | Metrics utilities (p50/p95/max, markdown table renderer) |

## NOT Building

- **Adversarial fault injection** — Phase 4's plan owns the 200-cycle adversarial bench; this phase is happy-path latency only.
- **Real Face ID for 200 cycles** — operator can't blink that many times in a defensible window. `BENCH_MODE` mocks it.
- **Real swallow watch for 200 cycles** — operator can't swallow 200 times. `BENCH_MODE` mocks it.
- **`is_test` boolean column on `medications`** — `dispenser_id="bench-001"` partition is enough, no migration needed.
- **Backend bench-seed endpoint** — orchestrator uses the existing `PUT /api/inventory/{slot}`. No new HTTP endpoint.
- **Frontend changes** — bench is operator-tooling only.
- **CI integration** — bench is operator-run on real Pi; CI cannot run it.
- **Pi-side network or thermal stress tests** — out of scope.
- **Cleanup robustness for orphaned bench rows** — orchestrator deletes after the bench; if it crashes, operator runs `bench_e2e.py --cleanup-only`.

---

## Step-by-Step Tasks

### Task 1: Add `?dispenser_id=` filter to `next_dispense`
- **ACTION**: Edit `backend/app/api/inventory.py`.
- **IMPLEMENT**:
  ```python
  @router.get("/next-dispense", dependencies=[Depends(verify_device_token)])
  async def next_dispense(dispenser_id: str | None = None):
      """Determine the next slot that needs dispensing.

      If `dispenser_id` is provided, restricts the search to rows tagged with
      that dispenser. Bench runs (`BENCH_MODE=1` on the Pi) rely on this to
      isolate from production rows. When omitted, behavior is unchanged.
      """
      sb = get_supabase()
      query = (
          sb.table("medications")
          .select("*")
          .gt("quantity", 0)
          .not_.is_("patient_id", "null")
      )
      if dispenser_id is not None:
          query = query.eq("dispenser_id", dispenser_id)
      result = query.limit(1).execute()
      if not result.data:
          raise HTTPException(status_code=404, detail="No pending dispenses")

      med = result.data[0]
      return {
          "patient_id": med["patient_id"],
          "slot": med["slot"],
          "medication": med["name"],
          "expiry_date": med.get("expiry_date"),
          "pills_per_dose": med.get("pills_per_dose", 1),
          "dispenser_id": med.get("dispenser_id"),
      }
  ```
- **MIRROR**: NAMING_CONVENTION, DATA_ACCESS_PATTERN.
- **IMPORTS**: No new imports.
- **GOTCHA**:
  - Phase 1 already added `dispenser_id` to medications. The filter assumes the column exists.
  - Backwards-compat: if Pi passes no param, current behavior — no production caller breaks.
- **VALIDATE**:
  ```bash
  cd backend && .venv/bin/python -m py_compile app/api/inventory.py
  ```

### Task 2: Add `BENCH_MODE` + `BENCH_LOG_PATH` to Pi settings
- **ACTION**: Edit `edge_pi/config.py`.
- **IMPLEMENT**:
  ```python
  @dataclass(frozen=True)
  class _Settings:
      BACKEND_URL: str
      DEVICE_TOKEN: str
      POLL_INTERVAL_S: float
      STUB_MODE: bool
      DISPENSER_ID: str
      BENCH_MODE: bool
      BENCH_LOG_PATH: str
  ```
  And in `_load()`:
  ```python
  bench_mode = os.environ.get("BENCH_MODE", "0") == "1"
  bench_log_path = os.environ.get("BENCH_LOG_PATH", "/tmp/bench_e2e.csv")
  return _Settings(
      BACKEND_URL=backend_url,
      DEVICE_TOKEN=device_token,
      POLL_INTERVAL_S=poll_interval,
      STUB_MODE=stub_mode,
      DISPENSER_ID=dispenser_id,
      BENCH_MODE=bench_mode,
      BENCH_LOG_PATH=bench_log_path,
  )
  ```
- **MIRROR**: CONFIG_PATTERN_PI.
- **IMPORTS**: None.
- **GOTCHA**: Both fields have safe defaults; production Pi never sets them.
- **VALIDATE**:
  ```bash
  cd /Users/limjiale/IDP_PharmGuard/edge_pi
  PHARMGUARD_STUB=1 BACKEND_URL=https://localhost \
  DEVICE_TOKEN=$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))') \
  BENCH_MODE=1 BENCH_LOG_PATH=/tmp/bench.csv \
  python3 -c "from config import settings; settings.validate(); print(settings.BENCH_MODE, settings.BENCH_LOG_PATH)"
  ```

### Task 3: Document new env keys in `.env.example`
- **ACTION**: Edit `edge_pi/.env.example`.
- **IMPLEMENT**: Append:
  ```
  # End-to-end bench loop (PRD Phase 6). Set BENCH_MODE=1 ONLY when running
  # scripts/bench_e2e.py. Bench mode mocks Face ID + swallow to keep cycle
  # time bounded; mechanism + YOLO + DB latency are still real. Bench refuses
  # to run when hardware is stubbed (HI-012 stays in force).
  BENCH_MODE=0
  BENCH_LOG_PATH=/tmp/bench_e2e.csv
  ```
- **MIRROR**: existing `.env.example` comment style.
- **GOTCHA**: keep `"0"`/`"1"` semantics consistent with `PHARMGUARD_STUB`.

### Task 4: Instrument `edge_pi/main.py` with timing + bench short-circuits
- **ACTION**: Edit `edge_pi/main.py`. Touch as few lines as possible to ease future merges; localise to the cycle body.
- **IMPLEMENT**:
  - At top of file: `import csv` and `from pathlib import Path`.
  - Add a module-level helper after `_build_session()`:
    ```python
    _BENCH_FIELDS = (
        "cycle", "patient_id", "slot",
        "t_schedule_ms", "t_auth_ms", "t_rotate_ms", "t_eject_ms",
        "t_pillid_ms", "t_diverter_ms", "t_drawer_ms",
        "t_log_ms", "t_total_ms",
        "pill_taken",
    )

    def _open_bench_writer():
        """Open the BENCH_LOG_PATH CSV for append. Returns None when bench off."""
        if not settings.BENCH_MODE:
            return None
        path = Path(settings.BENCH_LOG_PATH)
        path.parent.mkdir(parents=True, exist_ok=True)
        new = not path.exists()
        f = path.open("a", newline="")
        w = csv.DictWriter(f, fieldnames=_BENCH_FIELDS)
        if new:
            w.writeheader()
        w._fh = f  # stash for flush()/close()
        return w
    ```
  - Inside `run()` after `liveness = LivenessDetector(...)`, refuse to run bench on stub hardware (HI-012 extension):
    ```python
    if settings.BENCH_MODE and hardware_stubbed:
        log.error(
            "BENCH_MODE=1 but hardware is stubbed — bench numbers would be invalid."
        )
        sys.exit(4)

    bench_writer = _open_bench_writer()
    cycle_n = 0
    ```
  - In the `while True:` cycle, instrument with `time.perf_counter()` checkpoints. Pass `dispenser_id` as a query param when set. Mock liveness + swallow when `BENCH_MODE`. Wrap, do NOT gut, the existing logic. The full cycle body should look like:
    ```python
    while True:
        # ── Phase 5: tray temperature sample ─ (preserved verbatim) ─
        try:
            value_c = temp_sensor.read_celsius()
            if value_c is not None:
                report_temperature(value_c)
        except Exception:
            log.exception("temperature sample failed")
        # ── /Phase 5 ──

        try:
            t0 = time.perf_counter()
            params = {"dispenser_id": settings.DISPENSER_ID} if settings.DISPENSER_ID else None
            resp = session.get(
                f"{settings.BACKEND_URL}/api/inventory/next-dispense",
                params=params, timeout=5,
            )
            t_schedule = time.perf_counter()
            if resp.status_code != 200:
                time.sleep(settings.POLL_INTERVAL_S)
                continue

            task = resp.json()
            patient_id = task["patient_id"]
            slot = task["slot"]
            log.info("Dispensing slot %d for patient %d", slot, patient_id)

            if settings.BENCH_MODE:
                # mock Face ID — synthetic match so right-patient gate passes
                auth = {"patient_id": patient_id, "name": "bench", "distance": 0.0}
            else:
                auth = None if hardware_stubbed else authenticate_patient(liveness)
            t_auth = time.perf_counter()
            if not hardware_stubbed and auth is None:
                log.warning("Skipping cycle: authentication failed for slot %d", slot)
                time.sleep(settings.POLL_INTERVAL_S)
                continue
            if auth is not None and auth.get("patient_id") != patient_id:
                log.warning(
                    "Authenticated patient_id=%s does not match scheduled %d; skipping cycle",
                    auth.get("patient_id"), patient_id,
                )
                time.sleep(settings.POLL_INTERVAL_S)
                continue

            magazine.rotate_to(slot)
            t_rotate = time.perf_counter()
            ejector.push()
            t_eject = time.perf_counter()

            # ── Phase 4: diverter + drawer-lock ──
            if hardware_stubbed:
                pill_taken_actual = False
                t_pillid = t_diverter = t_drawer = t_eject
                log.info("Stub mode: skipping vision verify, diverter, drawer_lock, swallow watch")
            else:
                pill_id_pass = verifier.confirm_tray_empty()
                t_pillid = time.perf_counter()
                if pill_id_pass:
                    diverter.deliver()
                    t_diverter = time.perf_counter()
                    drawer_lock.hold_unlocked()
                    t_drawer = time.perf_counter()
                    pill_taken_actual = True
                    if not settings.BENCH_MODE:
                        monitor.watch_for_swallow(timeout_s=60)
                else:
                    log.warning("Pill-ID verification failed; routing to reject bin")
                    diverter.reject()
                    t_diverter = time.perf_counter()
                    t_drawer = t_diverter
                    pill_taken_actual = False
            # ── /Phase 4 ──

            report_intake(patient_id, slot, verified=pill_taken_actual)
            t_log = time.perf_counter()
            log.info("Cycle complete — pill_taken=%s", pill_taken_actual)

            if bench_writer is not None:
                cycle_n += 1
                bench_writer.writerow({
                    "cycle": cycle_n,
                    "patient_id": patient_id,
                    "slot": slot,
                    "t_schedule_ms": (t_schedule - t0) * 1000.0,
                    "t_auth_ms":     (t_auth - t_schedule) * 1000.0,
                    "t_rotate_ms":   (t_rotate - t_auth) * 1000.0,
                    "t_eject_ms":    (t_eject - t_rotate) * 1000.0,
                    "t_pillid_ms":   (t_pillid - t_eject) * 1000.0,
                    "t_diverter_ms": (t_diverter - t_pillid) * 1000.0,
                    "t_drawer_ms":   (t_drawer - t_diverter) * 1000.0,
                    "t_log_ms":      (t_log - t_drawer) * 1000.0,
                    "t_total_ms":    (t_log - t0) * 1000.0,
                    "pill_taken":    pill_taken_actual,
                })
                bench_writer._fh.flush()

        except Exception:
            log.exception("Error in main loop")

        time.sleep(settings.POLL_INTERVAL_S)
    ```
- **MIRROR**: TIMING_INSTRUMENTATION_PATTERN, LOGGING_PATTERN, STUB_FAIL_LOUD_PATTERN.
- **IMPORTS**: add `csv` and `from pathlib import Path` at top.
- **GOTCHA**:
  - **HI-012 invariant preserved**: stub-mode still forces `pill_taken_actual=False`. BENCH_MODE refuses to run on stubbed hardware (the new `sys.exit(4)`).
  - Phase 4 sentinel comments + Phase 5 sentinel comments stay around their respective blocks — preserve verbatim.
  - `params=None` (not `params={}`) when `DISPENSER_ID` is empty — preserves current behavior for production.
  - `bench_writer._fh.flush()` ensures CSV durability on Pi reboots.
- **VALIDATE**:
  ```bash
  cd /Users/limjiale/IDP_PharmGuard/edge_pi
  python3 -m py_compile main.py
  PHARMGUARD_STUB=1 BACKEND_URL=https://localhost \
  DEVICE_TOKEN=$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))') \
  BENCH_MODE=1 \
  python3 -c "import main; print('main OK with BENCH_MODE=1')"
  ```

### Task 5: Create `edge_pi/scripts/_bench_helpers.py`
- **ACTION**: New helper module.
- **IMPLEMENT**:
  ```python
  """Metrics helpers for bench_e2e.py — pure stdlib."""
  from __future__ import annotations

  import csv
  import statistics
  from pathlib import Path
  from typing import NamedTuple


  class Stat(NamedTuple):
      n: int
      mean: float
      p50: float
      p95: float
      max: float


  def summarise(samples: list[float]) -> Stat:
      if not samples:
          return Stat(0, 0.0, 0.0, 0.0, 0.0)
      s = sorted(samples)
      return Stat(
          n=len(samples),
          mean=statistics.mean(samples),
          p50=s[len(s) // 2],
          p95=s[int(len(s) * 0.95)],
          max=s[-1],
      )


  def read_csv(path: Path) -> list[dict[str, str]]:
      with path.open() as f:
          return list(csv.DictReader(f))


  def render_report(stats: dict[str, Stat], targets: dict[str, float]) -> str:
      lines = [
          "| metric | n | mean | p50 | p95 | max | target | pass |",
          "|---|---|---|---|---|---|---|---|",
      ]
      ok = True
      for col, st in stats.items():
          target = targets.get(col)
          passed = "—" if target is None else ("✓" if st.p95 < target else "✗")
          if target is not None:
              ok = ok and st.p95 < target
          target_str = f"<{target}" if target is not None else "—"
          lines.append(
              f"| {col} | {st.n} | {st.mean:.1f} | {st.p50:.1f} | "
              f"{st.p95:.1f} | {st.max:.1f} | {target_str} | {passed} |"
          )
      lines.append("")
      lines.append(f"**Overall**: {'PASS' if ok else 'FAIL'}")
      return "\n".join(lines)
  ```
- **MIRROR**: BENCH_SCRIPT_PATTERN.
- **IMPORTS**: stdlib only.
- **GOTCHA**: same `int(len(s) * 0.95)` percentile as `bench_dual_cam.py:53` — be consistent.
- **VALIDATE**:
  ```bash
  python3 -m py_compile scripts/_bench_helpers.py
  python3 -c "from scripts._bench_helpers import summarise; print(summarise([1.0,2.0,3.0,4.0,5.0]))"
  ```

### Task 6: Create `edge_pi/scripts/bench_e2e.py`
- **ACTION**: Orchestrator script.
- **IMPLEMENT**:
  ```python
  #!/usr/bin/env python3
  """End-to-end bench: 200 happy-path cycles on real Pi 5, metrics report.

  Prereqs:
    - Pi 5 with cam 0 + cam 1 attached and main.py running with BENCH_MODE=1.
    - Backend reachable at $BACKEND_URL with DEVICE_TOKEN authorised.

  Flow:
    1. Seed N rows tagged dispenser_id="bench-001" via PUT /api/inventory/{slot}.
    2. Wait for adherence_logs entries with dispenser_id="bench-001" to reach N.
    3. Read BENCH_LOG_PATH CSV.
    4. Render Pass/Fail markdown report against PRD targets.
    5. Cleanup: zero out the bench rows.

  PRD Phase 6 targets:
    - YOLO inference (t_pillid_ms) p95 < 200 ms
    - DB write (t_log_ms) p95 < 500 ms
    - End-to-end (t_total_ms) p95 < 8000 ms
  """
  from __future__ import annotations

  import argparse
  import logging
  import os
  import sys
  import time
  from pathlib import Path

  import requests

  sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
  from scripts._bench_helpers import read_csv, render_report, summarise  # noqa: E402

  log = logging.getLogger(__name__)

  TARGETS_MS = {
      "t_pillid_ms": 200.0,
      "t_log_ms": 500.0,
      "t_total_ms": 8000.0,
  }

  DEFAULT_BENCH_DISPENSER = "bench-001"
  DEFAULT_BENCH_PATIENT = 1


  def seed(backend_url, token, dispenser_id, patient_id, total_cycles):
      per_slot = -(-total_cycles // 10)  # ceil
      headers = {"Authorization": f"Bearer {token}"}
      for slot in range(10):
          payload = {
              "medication_name": f"BENCH_{slot}",
              "quantity": per_slot,
              "patient_id": patient_id,
              "dispenser_id": dispenser_id,
              "pills_per_dose": 1,
          }
          r = requests.put(f"{backend_url}/api/inventory/{slot}", headers=headers, json=payload, timeout=10)
          r.raise_for_status()
      log.info("Seeded 10 slots × %d cycles for dispenser_id=%s", per_slot, dispenser_id)


  def count_logs(backend_url, token, dispenser_id):
      headers = {"Authorization": f"Bearer {token}"}
      r = requests.get(f"{backend_url}/api/logs/", headers=headers, timeout=10)
      r.raise_for_status()
      return sum(1 for row in r.json() if row.get("dispenser_id") == dispenser_id)


  def cleanup(backend_url, token, dispenser_id):
      headers = {"Authorization": f"Bearer {token}"}
      for slot in range(10):
          payload = {
              "medication_name": f"BENCH_{slot}",
              "quantity": 0,
              "patient_id": DEFAULT_BENCH_PATIENT,
              "dispenser_id": dispenser_id,
              "pills_per_dose": 1,
          }
          requests.put(f"{backend_url}/api/inventory/{slot}", headers=headers, json=payload, timeout=10)
      log.info("Bench rows for dispenser_id=%s zeroed", dispenser_id)


  def main():
      ap = argparse.ArgumentParser()
      ap.add_argument("--cycles", type=int, default=200)
      ap.add_argument("--dispenser-id", default=DEFAULT_BENCH_DISPENSER)
      ap.add_argument("--patient-id", type=int, default=DEFAULT_BENCH_PATIENT)
      ap.add_argument("--bench-log", default=os.environ.get("BENCH_LOG_PATH", "/tmp/bench_e2e.csv"))
      ap.add_argument("--wait-seconds", type=int, default=900)
      ap.add_argument("--cleanup-only", action="store_true")
      args = ap.parse_args()

      logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

      backend_url = os.environ["BACKEND_URL"]
      token = os.environ["DEVICE_TOKEN"]

      if args.cleanup_only:
          cleanup(backend_url, token, args.dispenser_id)
          return 0

      csv_path = Path(args.bench_log)
      if csv_path.exists():
          csv_path.unlink()

      seed(backend_url, token, args.dispenser_id, args.patient_id, args.cycles)

      log.info("Waiting for Pi to drain %d cycles (timeout %ds)", args.cycles, args.wait_seconds)
      deadline = time.time() + args.wait_seconds
      last = 0
      while time.time() < deadline:
          n = count_logs(backend_url, token, args.dispenser_id)
          if n != last:
              log.info("  …%d/%d", n, args.cycles)
              last = n
          if n >= args.cycles:
              break
          time.sleep(5)
      else:
          log.warning("Drain timed out at %d/%d cycles", last, args.cycles)

      cleanup(backend_url, token, args.dispenser_id)

      if not csv_path.exists():
          log.error("No bench CSV at %s — was main.py running with BENCH_MODE=1?", csv_path)
          return 2

      rows = read_csv(csv_path)
      log.info("Read %d bench rows from %s", len(rows), csv_path)

      cols = [k for k in rows[0].keys() if k.startswith("t_") and k.endswith("_ms")]
      stats = {col: summarise([float(r[col]) for r in rows]) for col in cols}
      print(render_report(stats, TARGETS_MS))
      return 0 if all(stats[c].p95 < TARGETS_MS[c] for c in TARGETS_MS) else 1


  if __name__ == "__main__":
      sys.exit(main())
  ```
- **MIRROR**: BENCH_SCRIPT_PATTERN.
- **IMPORTS**: stdlib + `requests` (already in Pi `requirements.txt`).
- **GOTCHA**:
  - `ceil(total/10)` via `-(-total_cycles // 10)`.
  - `count_logs` is a client-side scan — acceptable for `<1000` rows.
  - `cleanup` zeroes quantity (not DELETE) to preserve any FK from `adherence_logs`.
  - **Operator must confirm** that `patient_id=1` has no production rows in slots 0-9 before running, or the seed will overwrite production data via the existing `update_slot` upsert.
- **VALIDATE**:
  ```bash
  python3 -m py_compile scripts/bench_e2e.py
  python3 scripts/bench_e2e.py --help
  ```

### Task 7: Local validation suite
- **ACTION**: Static analysis on every changed file.
- **IMPLEMENT**:
  ```bash
  cd /Users/limjiale/IDP_PharmGuard/backend
  .venv/bin/python -m py_compile app/api/inventory.py

  cd /Users/limjiale/IDP_PharmGuard/edge_pi
  python3 -m py_compile config.py main.py scripts/bench_e2e.py scripts/_bench_helpers.py

  PHARMGUARD_STUB=1 BACKEND_URL=https://localhost \
  DEVICE_TOKEN=$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))') \
  BENCH_MODE=1 \
  python3 -c "import main; print('main OK with BENCH_MODE=1')"

  python3 -c "
  from vision.intake_monitor import _STEP_ORDER, REQUIRED_CONFIDENCE
  assert _STEP_ORDER == ('STEP_1_HAND','STEP_2_TILT','STEP_3_LEVEL','STEP_4_MOUTH','STEP_5_TONGUE')
  assert REQUIRED_CONFIDENCE == 0.85
  print('FSM constants intact')
  "
  ```
- **MIRROR**: Phase 2 + Phase 3 validation suites.
- **GOTCHA**: dev mac lacks `cv2`/`mediapipe`/`ultralytics` — same constraint Phases 2/3 hit. The constants check imports `intake_monitor` which needs `cv2`. If that fails, fall back to grep-style regression on the source file (mirroring Phase 2 report's pattern).
- **VALIDATE**: every step prints OK or its expected output.

### Task 8: Operator-attested Pi run
- **ACTION**: Operator drives the bench on real Pi 5 hardware.
- **IMPLEMENT**:
  ```bash
  # On Pi: set BENCH_MODE=1, BENCH_LOG_PATH=/tmp/bench_e2e.csv, DISPENSER_ID=bench-001 in .env
  sudo systemctl restart pharmguard
  journalctl -u pharmguard -f &
  TAIL=$!

  # Operator workstation (or same Pi):
  cd ~/IDP_PharmGuard/edge_pi
  BACKEND_URL=https://<host> DEVICE_TOKEN=<token> python3 scripts/bench_e2e.py --cycles 200

  kill $TAIL
  # Cleanup: revert BENCH_MODE=0 in .env, restart pharmguard
  ```
- **MIRROR**: Phase 2 / Phase 4 operator run patterns.
- **GOTCHA**:
  - Operator must confirm `patient_id=1` has no production rows in slots 0-9 before running.
  - When done, restart pharmguard with `BENCH_MODE=0` to return to production.
- **VALIDATE**: bench script exits 0 with markdown report `Overall: PASS`.

---

## Testing Strategy

Repo has no test framework. Validation = py_compile + textual regression + Pi-hardware operator attestation.

### Manual / Smoke Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| `next_dispense` without dispenser_id | curl no-param | returns first available row (legacy) | normal |
| `next_dispense` with dispenser_id (no rows) | curl `?dispenser_id=bench-001` | 404 "No pending dispenses" | yes |
| `next_dispense` with dispenser_id (rows seeded) | seed bench rows, curl | returns one bench row | normal |
| Pi BENCH_MODE off | normal env | no CSV file written; cycle behaves as before | normal (regression guard) |
| Pi BENCH_MODE on + stubbed hardware | run() invoked | exit code 4 with HI-012 message | yes |
| Pi BENCH_MODE on + real hardware | run on Pi 5 | per-cycle CSV row written | normal |
| Bench script seed | `bench_e2e.py --cycles 200` | 10 slots seeded | normal |
| Bench drain timeout | Pi service down during bench | "Drain timed out" warning, cleanup runs anyway | yes |
| Bench cleanup-only | `--cleanup-only` | zeroes bench rows | yes |
| FSM constants | regression check | byte-identical | yes |

### Edge Cases Checklist
- [x] Empty input — `next_dispense` returns 404 when no rows match.
- [x] Concurrent access — bench partitions by `dispenser_id`; production unaffected.
- [x] Network failure — orchestrator's `requests` calls have explicit timeouts.
- [x] CSV file ownership — `_open_bench_writer` creates parent dirs; first cycle writes header.
- [x] Stub-mode regression — bench refuses to start; HI-012 intact.

---

## Validation Commands

### Static Analysis
```bash
cd /Users/limjiale/IDP_PharmGuard/backend && .venv/bin/python -m py_compile app/api/inventory.py
cd /Users/limjiale/IDP_PharmGuard/edge_pi && python3 -m py_compile config.py main.py scripts/bench_e2e.py scripts/_bench_helpers.py
```

### Stub-Mode Import Smoke
See Task 7. EXPECT: `main OK with BENCH_MODE=1` (run() not invoked).

### Constants Regression
See Task 7 step 4. EXPECT: `FSM constants intact`.

### Frontend Build
N/A — no frontend impact.

### Pi Operator Run
See Task 8. EXPECT: `Overall: PASS`.

### Manual Validation Checklist
- [ ] `backend/app/api/inventory.py::next_dispense` accepts optional `dispenser_id`.
- [ ] `edge_pi/config.py` exposes `BENCH_MODE` + `BENCH_LOG_PATH`.
- [ ] `edge_pi/.env.example` documents both new keys.
- [ ] `edge_pi/main.py` writes per-cycle CSV when BENCH_MODE=1; refuses on stub.
- [ ] `edge_pi/scripts/bench_e2e.py` exists with `--cycles`, `--cleanup-only`, `--help`.
- [ ] `edge_pi/scripts/_bench_helpers.py` exists with `summarise`, `read_csv`, `render_report`.
- [ ] Pi-attested run reports Pass.
- [ ] PRD Phase 6 row updated.

---

## Acceptance Criteria
- [ ] All 8 tasks completed.
- [ ] BENCH_MODE refuses to run on stubbed hardware (`sys.exit(4)`).
- [ ] FSM constants from Phase 3 regression-pass.
- [ ] `next_dispense` backwards-compat preserved.
- [ ] Operator-run bench prints `Overall: PASS`.
- [ ] PRD Phase 6 row flipped to `complete` after operator attestation.

## Completion Checklist
- [ ] Pi follows existing patterns (CONFIG_PATTERN_PI, LOGGING, BENCH_SCRIPT_PATTERN, STUB_FAIL_LOUD).
- [ ] Backend `next_dispense` change is purely additive.
- [ ] No new dependencies on Pi or backend.
- [ ] Phase 4 + Phase 5 sentinel comments preserved in `main.py`.
- [ ] HI-012 invariant: stub-mode never logs `pill_taken=true`; bench refuses on stub.
- [ ] PRD updated.

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Pi 5 thermal throttling under sustained 200-cycle YOLO | M | M | Active cooling; abort if `vcgencmd measure_temp` exceeds 80 °C |
| Bench seeds collide with production rows in slots 0-9 | M | M | Operator must confirm patient_id=1 has no production rows; doc'd in Task 8 GOTCHA |
| `count_logs` paginates / truncates | L | L | `list_logs` returns all rows by default; tolerable for `<1000` |
| BENCH_MODE accidentally left on in production | L | H | Document the cleanup step; optionally have main.py log a loud per-iteration warning |
| `.env` parsing miss — BENCH_MODE="0" treated as truthy | L | M | `os.environ.get("BENCH_MODE", "0") == "1"` — only literal `"1"` truthy |
| Cleanup leaves orphaned `adherence_logs` rows | M | L | Acceptable — clearly tagged by dispenser_id |
| The `(patient_id, slot)` mismatch in `update_slot` (Phase 1 known bug) bites bench seed | M | M | Operator-side guard rail |

## Notes
- **BENCH_MODE is mock-mode**, not real-mode. The bench measures mechanism + YOLO + backend latency, NOT Face ID accuracy or swallow detection. Phase 9 measures Face ID + pill-ID accuracy.
- **No deps added** — stdlib + existing `requests`.
- **No migrations** — partition is `dispenser_id="bench-001"`.
- **No frontend changes** — operator tooling.
- **Phase 4 and Phase 5 sentinel comments** stay around the diverter/drawer-lock and Phase-5-temperature blocks. Bench instrumentation wraps without removing them.
- After this plan ships, update `pharmguard.prd.md` Phase 6 row to:
  ```
  | 6 | End-to-end bench loop | ... | in-progress | - | 3, 4 | .claude/PRPs/plans/end-to-end-bench-loop.plan.md |
  ```
  Then to `complete` after operator attestation.

Sources:
- Internal patterns only — no external research required.
