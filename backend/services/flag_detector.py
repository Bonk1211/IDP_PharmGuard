"""Hybrid anomaly detector for the clinician-assistant flag pipeline.

Two passes per run:

1. **Heuristic** — deterministic Python rules over Supabase rows. Cheap,
   predictable, free. Always runs.
2. **Gemini soft pass** — single LLM call asking for "notable patterns NOT
   covered by the heuristics". Skipped when GEMINI_API_KEY missing OR when
   ``settings.agent_flag_gemini_enabled`` is False.

Persistence is INSERT-only into ``public.agent_flags``. Cross-run dedup is
handled by the partial unique index on ``(fingerprint) WHERE status='open'``
(see migration 0006). On a duplicate the Postgres `23505` error is caught
and logged as a no-op.

Public entry point: ``await detect_and_persist_flags() -> dict``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from config import settings
from db.base import get_supabase
from services import agent_tools

log = logging.getLogger(__name__)


# ──────────────────────────── kinds + statuses ──────────────────────────────

FLAG_KIND_MISSED_STREAK = "missed_streak"
FLAG_KIND_LOW_CONFIDENCE = "low_confidence"
FLAG_KIND_TRENDING_EMPTY = "trending_empty"
FLAG_KIND_NOTABLE_PATTERN = "notable_pattern"

_VALID_KINDS = {
    FLAG_KIND_MISSED_STREAK,
    FLAG_KIND_LOW_CONFIDENCE,
    FLAG_KIND_TRENDING_EMPTY,
    FLAG_KIND_NOTABLE_PATTERN,
}

_VALID_SEVERITIES = {"info", "warning", "critical"}


# Cap on how many flags a single Gemini call can introduce per run.
_GEMINI_MAX_FLAGS = 3

# Lookback for missed-streak detection. Mirrors agent_briefs lookback.
_LOOKBACK = timedelta(hours=24)


_GEMINI_PROMPT = """\
You are a clinical anomaly spotter for the PharmGuard pill dispenser.
Inspect the JSON payload below and return a JSON ARRAY (and nothing else)
of "notable patterns" that need a human's attention BUT are NOT already
covered by the heuristic kinds in `existing_open_kinds`.

Each array item must match this shape exactly:
{
  "title":        "<= 80 char one-liner",
  "detail":       "<= 200 char explanation, cite numbers from the payload",
  "patient_id":   <int or null>,
  "dispenser_id": "<string or null>",
  "fingerprint":  "<stable id, e.g. notable_pattern:patient=3:trend=...>",
  "severity":     "info"
}

Rules:
- Output ONLY the JSON array. No prose, no markdown fences.
- At most 3 items. Quality over quantity.
- If nothing notable beyond the heuristics, return [].
- Do NOT re-emit anything that the heuristic kinds already cover
  (e.g. don't flag a missed streak we already caught).
"""


# ──────────────────────────── public entry point ────────────────────────────

async def detect_and_persist_flags() -> dict[str, Any]:
    """Run all detectors, persist non-duplicate open flags.

    Returns a tiny summary suitable for log lines:
        {
          "new_flags": int,
          "by_kind": {kind: int, ...},
          "checked_at_iso": str,
          "gemini_used": bool,
        }
    """
    checked_at = datetime.now(timezone.utc)

    # 1) Heuristic detectors run first (cheap + deterministic).
    heuristic_candidates = await _run_heuristics()

    # 2) Gather what's currently open so the Gemini pass avoids duplicating
    #    heuristic work.
    open_rows = await asyncio.to_thread(_fetch_open_flags)
    existing_open_kinds: set[str] = {r.get("kind") for r in open_rows if r.get("kind")}
    # Kinds we *just produced* this run also count, even though we haven't
    # persisted yet — Gemini sees the union.
    existing_open_kinds.update(c["kind"] for c in heuristic_candidates)

    # 3) Gemini soft pass.
    gemini_used = False
    gemini_candidates: list[dict[str, Any]] = []
    if settings.gemini_api_key and settings.agent_flag_gemini_enabled:
        try:
            gemini_candidates = await _detect_via_gemini(existing_open_kinds)
            gemini_used = True
        except Exception:
            log.exception("flag_detector: gemini pass failed, continuing without")

    # 4) Persist.
    all_candidates = heuristic_candidates + gemini_candidates
    by_kind: dict[str, int] = {}
    new_flags = 0
    for cand in all_candidates:
        inserted = await asyncio.to_thread(_insert_flag, cand)
        if inserted:
            new_flags += 1
            by_kind[cand["kind"]] = by_kind.get(cand["kind"], 0) + 1

    log.info(
        "flag_detector: done — new=%d by_kind=%s gemini=%s",
        new_flags,
        by_kind,
        gemini_used,
    )
    return {
        "new_flags": new_flags,
        "by_kind": by_kind,
        "checked_at_iso": checked_at.isoformat(),
        "gemini_used": gemini_used,
    }


# ──────────────────────────── heuristic dispatch ────────────────────────────

async def _run_heuristics() -> list[dict[str, Any]]:
    """Run all sync heuristics off the event loop."""
    out: list[dict[str, Any]] = []
    out += await asyncio.to_thread(
        _detect_missed_streaks, settings.agent_flag_missed_streak_threshold,
    )
    out += await asyncio.to_thread(
        _detect_low_confidence, settings.agent_flag_low_confidence_threshold,
    )
    out += await asyncio.to_thread(_detect_trending_empty)
    return out


# ──────────────────────────── heuristic 1: missed streak ────────────────────

def _detect_missed_streaks(threshold: int) -> list[dict[str, Any]]:
    if threshold < 1:
        return []
    since_iso = (datetime.now(timezone.utc) - _LOOKBACK).isoformat()
    rows = agent_tools.query_adherence(since_iso=since_iso, limit=500)

    by_patient: dict[int, list[dict[str, Any]]] = {}
    for r in rows:
        pid = r.get("patient_id")
        if pid is None:
            continue
        by_patient.setdefault(pid, []).append(r)

    candidates: list[dict[str, Any]] = []
    for pid, logs in by_patient.items():
        # query_adherence orders by timestamp DESC — i.e. logs[0] is newest.
        # Count consecutive misses from newest backwards. Once we see a taken
        # dose the streak stops (most-recent-first semantics).
        streak = 0
        for r in logs:
            if r.get("pill_taken") is False:
                streak += 1
            else:
                break
        if streak < threshold:
            continue
        candidates.append({
            "kind": FLAG_KIND_MISSED_STREAK,
            "severity": "critical" if streak >= threshold + 2 else "warning",
            "title": f"Patient #{pid} — {streak} missed doses (24 h)",
            "detail": (
                f"{streak} consecutive missed doses; threshold is {threshold}. "
                f"Most recent miss at {logs[0].get('timestamp')}."
            ),
            "patient_id": pid,
            "dispenser_id": logs[0].get("dispenser_id"),
            "slot": logs[0].get("slot"),
            "fingerprint": f"{FLAG_KIND_MISSED_STREAK}:patient={pid}",
            "payload": {
                "streak": streak,
                "threshold": threshold,
                "newest_timestamp": logs[0].get("timestamp"),
            },
            "detected_by": "heuristic",
        })
    return candidates


# ──────────────────────────── heuristic 2: low confidence ───────────────────

def _detect_low_confidence(threshold: float) -> list[dict[str, Any]]:
    if threshold <= 0.0:
        return []
    since_iso = (datetime.now(timezone.utc) - _LOOKBACK).isoformat()
    rows = agent_tools.query_adherence(since_iso=since_iso, limit=500)

    candidates: list[dict[str, Any]] = []
    for r in rows:
        score = r.get("confidence_score")
        if score is None:
            continue
        if not r.get("pill_taken"):
            continue
        if score >= threshold:
            continue
        log_id = r.get("id")
        pid = r.get("patient_id")
        candidates.append({
            "kind": FLAG_KIND_LOW_CONFIDENCE,
            "severity": "info" if score >= threshold * 0.75 else "warning",
            "title": (
                f"Low intake confidence ({score:.2f}) "
                f"for patient #{pid if pid is not None else '?'}"
            ),
            "detail": (
                f"Adherence log id={log_id} reported pill_taken=true with "
                f"confidence {score:.2f} (< {threshold:.2f}). Worth reviewing."
            ),
            "patient_id": pid,
            "dispenser_id": r.get("dispenser_id"),
            "slot": r.get("slot"),
            # One flag per log id — fingerprint dedups against re-runs only
            # while the operator hasn't resolved.
            "fingerprint": f"{FLAG_KIND_LOW_CONFIDENCE}:log={log_id}",
            "payload": {
                "log_id": log_id,
                "confidence": score,
                "threshold": threshold,
                "timestamp": r.get("timestamp"),
            },
            "detected_by": "heuristic",
        })
    return candidates


# ──────────────────────────── heuristic 3: trending empty ───────────────────

def _detect_trending_empty() -> list[dict[str, Any]]:
    """Meds whose remaining quantity won't last another 24 h.

    Hard low-stock is already covered by the existing alerts pipeline; this
    detector targets the "nearly there" band so the next nurse gets a
    heads-up BEFORE the dispenser actually runs out.
    """
    low = settings.low_stock_threshold
    band_top = low + 3  # rows in (low, low+3]

    sb = get_supabase()
    meds = (
        sb.table("medications")
        .select("id, slot, name, quantity, dispenser_id, patient_id, pills_per_dose")
        .gt("quantity", low)
        .lte("quantity", band_top)
        .execute()
        .data or []
    )
    if not meds:
        return []

    today_start = datetime.now(timezone.utc).replace(
        hour=0, minute=0, second=0, microsecond=0,
    )

    # Count today's dispenses per (dispenser_id, slot).
    logs = agent_tools.query_adherence(
        since_iso=today_start.isoformat(),
        limit=500,
    )
    dispenses_per: dict[tuple[str | None, int | None], int] = {}
    for lr in logs:
        key = (lr.get("dispenser_id"), lr.get("slot"))
        dispenses_per[key] = dispenses_per.get(key, 0) + 1

    candidates: list[dict[str, Any]] = []
    for m in meds:
        slot = m.get("slot")
        disp = m.get("dispenser_id")
        qty = m.get("quantity") or 0
        per_dose = m.get("pills_per_dose") or 1
        used_today = dispenses_per.get((disp, slot), 0)
        # If today's usage already meets/exceeds the remaining quantity at
        # the prescribed dose, the slot is on track to empty.
        if used_today * per_dose < qty:
            continue
        candidates.append({
            "kind": FLAG_KIND_TRENDING_EMPTY,
            "severity": "info",
            "title": (
                f"Slot {slot} ({m.get('name') or 'unknown'}) trending empty"
            ),
            "detail": (
                f"Quantity={qty}, dispenses today={used_today}, "
                f"pills/dose={per_dose}. Likely to empty before next refill."
            ),
            "patient_id": m.get("patient_id"),
            "dispenser_id": disp,
            "slot": slot,
            "fingerprint": (
                f"{FLAG_KIND_TRENDING_EMPTY}:dispenser={disp}:slot={slot}"
            ),
            "payload": {
                "medication_id": m.get("id"),
                "name": m.get("name"),
                "quantity": qty,
                "used_today": used_today,
                "pills_per_dose": per_dose,
            },
            "detected_by": "heuristic",
        })
    return candidates


# ──────────────────────────── gemini soft pass ──────────────────────────────

async def _detect_via_gemini(existing_open_kinds: set[str]) -> list[dict[str, Any]]:
    """Single Gemini call. Returns at most _GEMINI_MAX_FLAGS validated flag dicts."""
    today_summary = await asyncio.to_thread(agent_tools.today_summary)
    since_iso = (datetime.now(timezone.utc) - _LOOKBACK).isoformat()
    missed = await asyncio.to_thread(
        agent_tools.query_adherence,
        since_iso=since_iso, only_missed=True, limit=50,
    )
    alerts = await asyncio.to_thread(
        agent_tools.query_alerts, since_iso=since_iso, limit=50,
    )
    payload = {
        "now_local": datetime.now().astimezone().isoformat(),
        "today_summary": today_summary,
        "missed_doses": missed,
        "alerts": alerts,
        "existing_open_kinds": sorted(existing_open_kinds),
    }

    import google.generativeai as genai
    genai.configure(api_key=settings.gemini_api_key)
    model = genai.GenerativeModel(
        model_name=settings.agent_model_name,
        system_instruction=_GEMINI_PROMPT,
    )
    user_prompt = (
        "Inspect this payload and return notable patterns as a JSON array.\n\n"
        f"```json\n{json.dumps(payload, default=str, indent=2)}\n```"
    )
    resp = await asyncio.to_thread(model.generate_content, user_prompt)
    text = (getattr(resp, "text", "") or "").strip()
    if not text:
        return []

    items = _safe_parse_json_array(text)
    if not items:
        log.info("flag_detector: gemini returned no parseable items (raw=%r)", text[:200])
        return []

    out: list[dict[str, Any]] = []
    for raw in items[:_GEMINI_MAX_FLAGS]:
        if not isinstance(raw, dict):
            continue
        title = (raw.get("title") or "").strip()
        if not title:
            continue
        fp = (raw.get("fingerprint") or "").strip()
        if not fp.startswith("notable_pattern:"):
            fp = f"notable_pattern:{fp or title}"
        severity = raw.get("severity") if raw.get("severity") in _VALID_SEVERITIES else "info"
        out.append({
            "kind": FLAG_KIND_NOTABLE_PATTERN,
            "severity": severity,
            "title": title[:80],
            "detail": (raw.get("detail") or "")[:200] or None,
            "patient_id": raw.get("patient_id") if isinstance(raw.get("patient_id"), int) else None,
            "dispenser_id": raw.get("dispenser_id") if isinstance(raw.get("dispenser_id"), str) else None,
            "slot": raw.get("slot") if isinstance(raw.get("slot"), int) else None,
            "fingerprint": fp[:200],
            "payload": {"raw": raw},
            "detected_by": "gemini",
        })
    return out


def _safe_parse_json_array(text: str) -> list[Any]:
    """Tolerant parser. Tries strict JSON, then strips fences, then extracts
    the first ``[...]`` block. Returns [] on any failure."""
    candidates = [text]
    fence_match = re.search(r"```(?:json)?\s*(.+?)```", text, flags=re.S)
    if fence_match:
        candidates.append(fence_match.group(1))
    bracket_match = re.search(r"\[.*\]", text, flags=re.S)
    if bracket_match:
        candidates.append(bracket_match.group(0))
    for c in candidates:
        try:
            parsed = json.loads(c)
            if isinstance(parsed, list):
                return parsed
        except (ValueError, TypeError):
            continue
    return []


# ──────────────────────────── persistence ───────────────────────────────────

def _fetch_open_flags() -> list[dict[str, Any]]:
    sb = get_supabase()
    return (
        sb.table("agent_flags")
        .select("id, kind, fingerprint")
        .eq("status", "open")
        .execute()
        .data or []
    )


def _insert_flag(cand: dict[str, Any]) -> bool:
    """INSERT a single candidate. Returns True if a new row was created,
    False if the partial-unique-index dedup'd it (open dup) or any other
    soft failure occurred."""
    if cand["kind"] not in _VALID_KINDS:
        log.warning("flag_detector: skipping unknown kind=%r", cand["kind"])
        return False
    sb = get_supabase()
    row = {
        "kind": cand["kind"],
        "severity": cand.get("severity") or "warning",
        "title": cand["title"],
        "detail": cand.get("detail"),
        "patient_id": cand.get("patient_id"),
        "dispenser_id": cand.get("dispenser_id"),
        "slot": cand.get("slot"),
        "fingerprint": cand["fingerprint"],
        "payload": cand.get("payload") or {},
        "detected_by": cand.get("detected_by") or "heuristic",
    }
    try:
        sb.table("agent_flags").insert(row).execute()
        log.info(
            "flag_detector: inserted kind=%s fp=%s",
            row["kind"],
            row["fingerprint"],
        )
        return True
    except Exception as exc:
        # supabase-py wraps Postgres errors; check the textual code.
        msg = str(exc)
        if "23505" in msg:
            log.info(
                "flag_detector: dedup'd kind=%s fp=%s (open duplicate)",
                row["kind"],
                row["fingerprint"],
            )
        else:
            log.warning(
                "flag_detector: insert failed kind=%s fp=%s err=%s",
                row["kind"],
                row["fingerprint"],
                msg,
            )
        return False
