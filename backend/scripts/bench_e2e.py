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
  - DB write    (t_log_ms)    p95 < 500 ms
  - End-to-end  (t_total_ms)  p95 < 8000 ms
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


def seed(backend_url: str, token: str, dispenser_id: str, patient_id: int, total_cycles: int) -> None:
    per_slot = -(-total_cycles // 10)  # ceil division
    headers = {"Authorization": f"Bearer {token}"}
    for slot in range(10):
        payload = {
            "medication_name": f"BENCH_{slot}",
            "quantity": per_slot,
            "patient_id": patient_id,
            "dispenser_id": dispenser_id,
            "pills_per_dose": 1,
        }
        r = requests.put(
            f"{backend_url}/api/inventory/{slot}",
            headers=headers,
            json=payload,
            timeout=10,
        )
        r.raise_for_status()
    log.info("Seeded 10 slots × %d cycles for dispenser_id=%s", per_slot, dispenser_id)


def count_logs(backend_url: str, token: str, dispenser_id: str) -> int:
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.get(f"{backend_url}/api/logs/", headers=headers, timeout=10)
    r.raise_for_status()
    return sum(1 for row in r.json() if row.get("dispenser_id") == dispenser_id)


def cleanup(backend_url: str, token: str, dispenser_id: str) -> None:
    headers = {"Authorization": f"Bearer {token}"}
    for slot in range(10):
        payload = {
            "medication_name": f"BENCH_{slot}",
            "quantity": 0,
            "patient_id": DEFAULT_BENCH_PATIENT,
            "dispenser_id": dispenser_id,
            "pills_per_dose": 1,
        }
        requests.put(
            f"{backend_url}/api/inventory/{slot}",
            headers=headers,
            json=payload,
            timeout=10,
        )
    log.info("Bench rows for dispenser_id=%s zeroed", dispenser_id)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cycles", type=int, default=200)
    ap.add_argument("--dispenser-id", default=DEFAULT_BENCH_DISPENSER)
    ap.add_argument("--patient-id", type=int, default=DEFAULT_BENCH_PATIENT)
    ap.add_argument("--bench-log", default=os.environ.get("BENCH_LOG_PATH", "/tmp/bench_e2e.csv"))
    ap.add_argument("--wait-seconds", type=int, default=900, help="upper bound on drain wait")
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
