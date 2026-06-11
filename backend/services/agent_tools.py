"""Read-only Supabase tools exposed to the clinician-assistant LLM agent.

Each tool is a small async-safe Python function that wraps a single
Supabase query. The Gemini agent (services/agent.py) declares them as
function-calling tools; when the LLM emits a function_call, dispatch()
validates args via Pydantic and invokes the matching callable.

All tools are STRICTLY READ-ONLY — no INSERT/UPDATE/DELETE. The only
writes the agent system performs are the brief INSERTs in
api/agent.py + scheduler/brief_scheduler.py, which bypass these tools.

Adding a new tool:
  1. Define a Pydantic model with `model_config = {"extra": "forbid"}`.
  2. Write the callable: `def my_tool(**kwargs) -> list[dict] | dict`.
  3. Append to TOOLS at the bottom with name, description, schema, callable.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from pydantic import BaseModel, Field

from config import settings
from db.base import get_supabase

log = logging.getLogger(__name__)


def _today_iso_bounds() -> tuple[str, str]:
    """Returns (since_iso, until_iso) covering the current calendar day in UTC."""
    now = datetime.now(timezone.utc)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=1)
    return start.isoformat(), end.isoformat()


def _attach_patient_names(rows: list[dict]) -> list[dict]:
    """Stitch a flat `patient_name` onto rows bearing `patient_id` with one
    extra lookup. Used where a PostgREST embed isn't available (agent_flags
    has no FK to patients). Null patient_id → patient_name None."""
    ids = {r["patient_id"] for r in rows if r.get("patient_id") is not None}
    if not ids:
        for r in rows:
            r.setdefault("patient_name", None)
        return rows
    res = (
        get_supabase()
        .table("patients")
        .select("id, name")
        .in_("id", sorted(ids))
        .execute()
    )
    names = {p["id"]: p["name"] for p in (res.data or [])}
    for r in rows:
        r["patient_name"] = names.get(r.get("patient_id"))
    return rows


# ──────────────────────────── tool: today_summary ───────────────────────────

class TodaySummaryArgs(BaseModel):
    model_config = {"extra": "forbid"}


def today_summary(**_: Any) -> dict:
    """Counts of dispenses, taken, missed, low-stock, expiring-soon (today)."""
    sb = get_supabase()
    since, until = _today_iso_bounds()
    logs = (
        sb.table("adherence_logs")
        .select("pill_taken")
        .gte("timestamp", since)
        .lt("timestamp", until)
        .execute()
    )
    rows = logs.data or []
    n_dispenses = len(rows)
    n_pill_taken = sum(1 for r in rows if r.get("pill_taken"))
    n_missed = n_dispenses - n_pill_taken

    meds = sb.table("medications").select("quantity, expiry_date").execute()
    med_rows = meds.data or []
    low_stock = sum(
        1
        for m in med_rows
        if (m.get("quantity") or 0) <= settings.low_stock_threshold
    )
    cutoff_date = (datetime.now(timezone.utc).date()
                   + timedelta(days=settings.expiry_warn_days))
    expiring_soon = 0
    for m in med_rows:
        exp = m.get("expiry_date")
        if not exp:
            continue
        try:
            exp_date = datetime.fromisoformat(str(exp)).date()
        except ValueError:
            continue
        if exp_date <= cutoff_date:
            expiring_soon += 1

    return {
        "n_dispenses": n_dispenses,
        "n_pill_taken": n_pill_taken,
        "n_missed": n_missed,
        "low_stock_count": low_stock,
        "expiring_soon_count": expiring_soon,
    }


# ──────────────────────────── tool: query_adherence ─────────────────────────

class QueryAdherenceArgs(BaseModel):
    model_config = {"extra": "forbid"}
    patient_id: int | None = Field(default=None, description="Filter by patient_id (numeric).")
    since_iso: str | None = Field(default=None, description="ISO-8601 lower bound (inclusive).")
    until_iso: str | None = Field(default=None, description="ISO-8601 upper bound (exclusive).")
    only_missed: bool = Field(default=False, description="If true, return only rows where pill_taken=false.")
    limit: int = Field(default=50, ge=1, le=500)


def query_adherence(**kwargs: Any) -> list[dict]:
    args = QueryAdherenceArgs(**kwargs)
    sb = get_supabase()
    q = (
        sb.table("adherence_logs")
        .select(
            "id, patient_id, slot, pill_taken, timestamp, dispenser_id, "
            "confidence_score, patient:patients(name)"
        )
        .order("timestamp", desc=True)
        .limit(args.limit)
    )
    if args.patient_id is not None:
        q = q.eq("patient_id", args.patient_id)
    if args.since_iso is not None:
        q = q.gte("timestamp", args.since_iso)
    if args.until_iso is not None:
        q = q.lt("timestamp", args.until_iso)
    if args.only_missed:
        q = q.eq("pill_taken", False)
    rows = q.execute().data or []
    # Flatten the embed so the LLM sees a plain `patient_name` field and can
    # cite names instead of numeric IDs.
    for r in rows:
        r["patient_name"] = (r.pop("patient", None) or {}).get("name")
    return rows


# ──────────────────────────── tool: query_alerts ────────────────────────────

class QueryAlertsArgs(BaseModel):
    model_config = {"extra": "forbid"}
    kind: str | None = Field(
        default=None, description="Alert kind: 'expiry' or 'low_stock'.",
    )
    severity: str | None = Field(default=None, description="'info', 'warning', or 'critical'.")
    since_iso: str | None = Field(default=None)
    limit: int = Field(default=50, ge=1, le=500)


def query_alerts(**kwargs: Any) -> list[dict]:
    args = QueryAlertsArgs(**kwargs)
    sb = get_supabase()
    q = (
        sb.table("alerts")
        .select("id, kind, severity, dispenser_id, payload, created_at")
        .order("created_at", desc=True)
        .limit(args.limit)
    )
    if args.kind is not None:
        q = q.eq("kind", args.kind)
    if args.severity is not None:
        q = q.eq("severity", args.severity)
    if args.since_iso is not None:
        q = q.gte("created_at", args.since_iso)
    return q.execute().data or []


# ──────────────────────────── tool: query_medications ───────────────────────

class QueryMedicationsArgs(BaseModel):
    model_config = {"extra": "forbid"}
    dispenser_id: str | None = Field(default=None)
    low_stock_only: bool = Field(default=False)
    expires_before_days: int | None = Field(
        default=None, ge=0, le=365,
        description="If set, only meds expiring within this many days from today.",
    )


def query_medications(**kwargs: Any) -> list[dict]:
    args = QueryMedicationsArgs(**kwargs)
    sb = get_supabase()
    q = (
        sb.table("medications")
        .select("id, slot, name, quantity, patient_id, expiry_date, pills_per_dose, dispenser_id")
        .order("slot")
    )
    if args.dispenser_id is not None:
        q = q.eq("dispenser_id", args.dispenser_id)
    if args.low_stock_only:
        q = q.lte("quantity", settings.low_stock_threshold)
    rows = q.execute().data or []
    if args.expires_before_days is not None:
        cutoff = datetime.now(timezone.utc).date() + timedelta(days=args.expires_before_days)
        kept: list[dict] = []
        for m in rows:
            exp = m.get("expiry_date")
            if not exp:
                continue
            try:
                exp_date = datetime.fromisoformat(str(exp)).date()
            except ValueError:
                continue
            if exp_date <= cutoff:
                kept.append(m)
        rows = kept
    return rows


# ──────────────────────────── tool: list_patients ───────────────────────────

class ListPatientsArgs(BaseModel):
    model_config = {"extra": "forbid"}
    status: str | None = Field(default=None, description="'Active', 'At Risk', 'Under Treatment', etc.")
    dispenser_id: str | None = Field(default=None)


def list_patients(**kwargs: Any) -> list[dict]:
    args = ListPatientsArgs(**kwargs)
    sb = get_supabase()
    q = (
        sb.table("patients")
        .select("id, name, gender, age, condition, status, dispenser_id")
        .order("name")
    )
    if args.status is not None:
        q = q.eq("status", args.status)
    if args.dispenser_id is not None:
        q = q.eq("dispenser_id", args.dispenser_id)
    return q.execute().data or []


# ──────────────────────────── tool: query_flags ────────────────────────────

class QueryFlagsArgs(BaseModel):
    model_config = {"extra": "forbid"}
    status: str | None = Field(
        default="open",
        description="Filter by status: open | acked | resolved | dismissed.",
    )
    kind: str | None = Field(
        default=None,
        description="Filter by kind: missed_streak | low_confidence | trending_empty | notable_pattern.",
    )
    patient_id: int | None = Field(default=None)
    limit: int = Field(default=20, ge=1, le=200)


def query_flags(**kwargs: Any) -> list[dict]:
    args = QueryFlagsArgs(**kwargs)
    sb = get_supabase()
    q = (
        sb.table("agent_flags")
        .select("*")
        .order("created_at", desc=True)
        .limit(args.limit)
    )
    if args.status is not None:
        q = q.eq("status", args.status)
    if args.kind is not None:
        q = q.eq("kind", args.kind)
    if args.patient_id is not None:
        q = q.eq("patient_id", args.patient_id)
    return _attach_patient_names(q.execute().data or [])


# ──────────────────────────── tool: adherence_stats ─────────────────────────

class AdherenceStatsArgs(BaseModel):
    model_config = {"extra": "forbid"}
    lookback_days: int = Field(default=7, ge=1, le=90, description="Window size in days.")
    patient_id: int | None = Field(default=None, description="Limit to one patient.")


# PostgREST silently caps un-ranged selects at 1000 rows; page past it so a
# busy 90-day window can't skew the rates. Hard ceiling keeps a runaway
# table from stalling the tool.
_STATS_PAGE = 1000
_STATS_MAX_ROWS = 20_000


def adherence_stats(**kwargs: Any) -> list[dict]:
    """Per-patient adherence rate + missed streak over a lookback window,
    computed server-side so the LLM never has to eyeball raw rows. Patients
    with ZERO logs in the window are still reported (n_scheduled=0,
    no_data_in_window=true) — a silent dispenser is a risk signal."""
    args = AdherenceStatsArgs(**kwargs)
    sb = get_supabase()
    since = (datetime.now(timezone.utc) - timedelta(days=args.lookback_days)).isoformat()

    rows: list[dict] = []
    while len(rows) < _STATS_MAX_ROWS:
        q = (
            sb.table("adherence_logs")
            .select("patient_id, pill_taken, timestamp")
            .gte("timestamp", since)
            .order("timestamp", desc=True)
            .range(len(rows), len(rows) + _STATS_PAGE - 1)
        )
        if args.patient_id is not None:
            q = q.eq("patient_id", args.patient_id)
        page = q.execute().data or []
        rows.extend(page)
        if len(page) < _STATS_PAGE:
            break

    # Full roster (or the one filtered patient) — needed both for names and
    # to surface zero-log patients below.
    pq = sb.table("patients").select("id, name")
    if args.patient_id is not None:
        pq = pq.eq("id", args.patient_id)
    patients = pq.execute().data or []
    names = {p["id"]: p["name"] for p in patients}

    by_patient: dict[int, list[dict]] = {}
    for r in rows:
        pid = r.get("patient_id")
        if pid is None:
            continue
        by_patient.setdefault(pid, []).append(r)

    out: list[dict] = []
    for pid, logs in by_patient.items():  # logs are newest-first
        n_scheduled = len(logs)
        n_taken = sum(1 for entry in logs if entry.get("pill_taken"))
        n_missed = n_scheduled - n_taken
        streak = 0
        for entry in logs:
            if entry.get("pill_taken"):
                break
            streak += 1
        last_taken_at = next(
            (e.get("timestamp") for e in logs if e.get("pill_taken")), None,
        )
        out.append({
            "patient_id": pid,
            "patient_name": names.get(pid),
            "lookback_days": args.lookback_days,
            "n_scheduled": n_scheduled,
            "n_taken": n_taken,
            "n_missed": n_missed,
            "adherence_pct": (
                round(100 * n_taken / n_scheduled, 1) if n_scheduled else None
            ),
            "current_missed_streak": streak,
            # last_event_at is the newest LOG (taken or missed); last_taken_at
            # is the newest dose actually taken — don't conflate them.
            "last_event_at": logs[0].get("timestamp") if logs else None,
            "last_taken_at": last_taken_at,
        })

    # Patients with no logs at all in the window — report, don't hide.
    for p in patients:
        if p["id"] in by_patient:
            continue
        out.append({
            "patient_id": p["id"],
            "patient_name": p["name"],
            "lookback_days": args.lookback_days,
            "n_scheduled": 0,
            "n_taken": 0,
            "n_missed": 0,
            "adherence_pct": None,
            "current_missed_streak": 0,
            "last_event_at": None,
            "last_taken_at": None,
            "no_data_in_window": True,
        })

    # Worst adherence first; no-data patients sort last but stay visible.
    out.sort(
        key=lambda s: s["adherence_pct"] if s["adherence_pct"] is not None else 101.0
    )
    return out


# ──────────────────────────── tool: patient_overview ────────────────────────

class PatientOverviewArgs(BaseModel):
    model_config = {"extra": "forbid"}
    patient_id: int | None = Field(default=None, description="Numeric id, if known.")
    name: str | None = Field(
        default=None,
        description="Full or partial patient name (case-insensitive).",
    )


def _ilike_escape(term: str) -> str:
    """Sanitise a user-typed search term for a PostgREST ilike filter:
    strip reserved punctuation that breaks filter parsing, escape LIKE
    wildcards so '%'/'_' in the input match literally."""
    term = term.replace(",", " ").replace("(", " ").replace(")", " ")
    term = term.replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_")
    return term.strip()


def patient_overview(**kwargs: Any) -> dict:
    """Everything about one patient in a single call: chart row, loaded
    medications, recent adherence, open flags. One hop instead of four."""
    args = PatientOverviewArgs(**kwargs)
    if args.patient_id is None and not (args.name or "").strip():
        raise ValueError("provide patient_id or name")
    sb = get_supabase()

    pq = sb.table("patients").select(
        "id, name, gender, age, condition, status, allergies, "
        "contraindications, dispenser_id"
    )
    if args.patient_id is not None:
        pq = pq.eq("id", args.patient_id)
    else:
        needle = _ilike_escape(args.name)
        if not needle:
            return {"error": "no patient matched"}
        pq = pq.ilike("name", f"%{needle}%")
    candidates = pq.execute().data or []
    if not candidates:
        return {"error": "no patient matched"}
    if len(candidates) > 1:
        # Cap the list — an over-broad needle ('%a%') can match the whole
        # roster and flood the model context.
        return {
            "ambiguous": [
                {"id": c["id"], "name": c["name"]} for c in candidates[:8]
            ],
            "ambiguous_count": len(candidates),
        }
    patient = candidates[0]
    pid = patient["id"]

    medications = (
        sb.table("medications")
        .select("slot, name, quantity, expiry_date, pills_per_dose, schedule_at")
        .eq("patient_id", pid)
        .order("slot")
        .execute()
        .data
        or []
    )
    recent_adherence = (
        sb.table("adherence_logs")
        .select("slot, pill_taken, timestamp, confidence_score")
        .eq("patient_id", pid)
        .order("timestamp", desc=True)
        .limit(10)
        .execute()
        .data
        or []
    )
    open_flags = (
        sb.table("agent_flags")
        .select("kind, severity, status, title, detail, created_at")
        .eq("patient_id", pid)
        .eq("status", "open")
        .order("created_at", desc=True)
        .limit(10)
        .execute()
        .data
        or []
    )
    return {
        "patient": patient,
        "medications": medications,
        "recent_adherence": recent_adherence,
        "open_flags": open_flags,
    }


# ──────────────────────────── tool: query_schedules ─────────────────────────

class QuerySchedulesArgs(BaseModel):
    model_config = {"extra": "forbid"}
    patient_id: int | None = Field(default=None)
    due_within_hours: float | None = Field(
        default=None, ge=0, le=24,
        description="Only doses whose next occurrence is within this many hours.",
    )


def query_schedules(**kwargs: Any) -> list[dict]:
    """Scheduled doses (medications.schedule_at, daily HH:MM) with the next
    due time computed in Pi-local time — the same clock the device scheduler
    uses. Soonest first."""
    args = QuerySchedulesArgs(**kwargs)
    sb = get_supabase()
    q = (
        sb.table("medications")
        .select(
            "slot, name, quantity, pills_per_dose, schedule_at, patient_id, "
            "patient:patients(name)"
        )
        .not_.is_("schedule_at", "null")
        .order("slot")
    )
    if args.patient_id is not None:
        q = q.eq("patient_id", args.patient_id)
    rows = q.execute().data or []

    now = datetime.now().astimezone()
    out: list[dict] = []
    for r in rows:
        raw = str(r.get("schedule_at") or "").strip()
        parts = raw.split(":")
        try:
            due = now.replace(
                hour=int(parts[0]), minute=int(parts[1]), second=0, microsecond=0,
            )
        except (IndexError, ValueError):
            continue  # malformed schedule_at — skip, never raise
        if due <= now:
            due += timedelta(days=1)
        hours_until = (due - now).total_seconds() / 3600.0
        if args.due_within_hours is not None and hours_until > args.due_within_hours:
            continue
        r["patient_name"] = (r.pop("patient", None) or {}).get("name")
        r["next_due_iso"] = due.isoformat()
        r["hours_until_due"] = round(hours_until, 2)
        out.append(r)
    out.sort(key=lambda x: x["next_due_iso"])
    return out


# ──────────────────────────── registry ──────────────────────────────────────

ToolFn = Callable[..., Any]


class ToolDef(BaseModel):
    model_config = {"arbitrary_types_allowed": True, "extra": "forbid"}
    name: str
    description: str
    args_schema: type[BaseModel]
    fn: ToolFn


TOOLS: list[ToolDef] = [
    ToolDef(
        name="query_flags",
        description=(
            "List agent-detected flags (proactive anomalies). Default returns "
            "OPEN flags. Use this FIRST when the clinician asks 'what needs my "
            "attention' / 'anything wrong' — start here BEFORE today_summary. "
            "Each row has kind, severity, title, detail, fingerprint."
        ),
        args_schema=QueryFlagsArgs,
        fn=query_flags,
    ),
    ToolDef(
        name="today_summary",
        description=(
            "Returns counts for today's activity: total dispenses, pills taken, "
            "missed, low-stock medications, and meds expiring soon. Use this "
            "FIRST when the user asks 'what's happened today' to get the big "
            "picture before drilling down."
        ),
        args_schema=TodaySummaryArgs,
        fn=today_summary,
    ),
    ToolDef(
        name="query_adherence",
        description=(
            "List adherence log rows. Filter by patient_id, time bounds, "
            "or only_missed=true to find missed doses. Default limit 50, "
            "newest first. Returns rows with pill_taken (bool), confidence_score, "
            "slot, timestamp."
        ),
        args_schema=QueryAdherenceArgs,
        fn=query_adherence,
    ),
    ToolDef(
        name="query_alerts",
        description=(
            "List alert rows (expiry / low_stock). Filter by kind, severity, "
            "or since_iso. Default limit 50, newest first."
        ),
        args_schema=QueryAlertsArgs,
        fn=query_alerts,
    ),
    ToolDef(
        name="query_medications",
        description=(
            "List the magazine slots and their loaded medications. Filter by "
            "dispenser_id, low_stock_only, or expires_before_days. Returns "
            "name, quantity, expiry_date, slot."
        ),
        args_schema=QueryMedicationsArgs,
        fn=query_medications,
    ),
    ToolDef(
        name="list_patients",
        description=(
            "List patients. Filter by status ('Active', 'At Risk', etc.) or "
            "dispenser_id. Returns id, name, condition, status, dispenser_id."
        ),
        args_schema=ListPatientsArgs,
        fn=list_patients,
    ),
    ToolDef(
        name="patient_overview",
        description=(
            "Everything about ONE patient in a single call: chart row, loaded "
            "medications, last 10 adherence logs, open flags. Use FIRST for any "
            "single-patient question ('how is Mary doing?'). Accepts patient_id "
            "or a (partial) name; returns {ambiguous: [...]} when several match "
            "— ask the user to pick."
        ),
        args_schema=PatientOverviewArgs,
        fn=patient_overview,
    ),
    ToolDef(
        name="adherence_stats",
        description=(
            "Per-patient adherence over a lookback window (default 7 days): "
            "n_taken, n_missed, adherence_pct, current_missed_streak, "
            "last_event_at, last_taken_at. Sorted worst-first; patients with "
            "NO logs in the window appear with no_data_in_window=true — treat "
            "a silent dispenser as a risk signal. Use for 'which patients are "
            "at risk' and any rate/trend question — do NOT eyeball raw logs."
        ),
        args_schema=AdherenceStatsArgs,
        fn=adherence_stats,
    ),
    ToolDef(
        name="query_schedules",
        description=(
            "Upcoming scheduled doses (daily HH:MM schedule) with patient_name, "
            "next_due_iso and hours_until_due, soonest first. Use for 'who is "
            "due next' / 'what's coming up'; narrow with due_within_hours."
        ),
        args_schema=QuerySchedulesArgs,
        fn=query_schedules,
    ),
]

_BY_NAME: dict[str, ToolDef] = {t.name: t for t in TOOLS}


def dispatch(name: str, raw_args: dict[str, Any]) -> Any:
    """Validate args via Pydantic, invoke the tool. Raises ValueError on
    unknown tool name or bad args (caller should catch + tell the LLM)."""
    tool = _BY_NAME.get(name)
    if tool is None:
        raise ValueError(f"unknown tool: {name}")
    args = dict(raw_args or {})
    validated = tool.args_schema(**args)
    log.info("agent: dispatching tool=%s args=%s", name, validated.model_dump())
    return tool.fn(**validated.model_dump())


def build_openai_tools() -> list[dict]:
    """Convert TOOLS into the OpenAI/DeepSeek tool-call payload.

    Format:
        [
          {"type": "function",
           "function": {"name": ..., "description": ..., "parameters": <schema>}},
          ...
        ]
    Pass directly as `tools=` to `client.chat.completions.create(...)`.
    """
    decls: list[dict] = []
    for t in TOOLS:
        schema = _normalise_schema(t.args_schema.model_json_schema())
        decls.append({
            "type": "function",
            "function": {
                "name": t.name,
                "description": t.description,
                "parameters": schema,
            },
        })
    return decls


def _normalise_schema(node: Any) -> Any:
    """Collapse Pydantic's `anyOf: [T, null]` (optional fields) into the
    non-null branch and drop noisy `title` keys. OpenAI accepts full JSON
    Schema otherwise — no constraint-key stripping needed.
    """
    if isinstance(node, dict):
        if "anyOf" in node:
            options = node.pop("anyOf")
            non_null = [
                o for o in options
                if not (isinstance(o, dict) and o.get("type") == "null")
            ]
            if non_null and isinstance(non_null[0], dict):
                for k, v in non_null[0].items():
                    node.setdefault(k, v)
        node.pop("title", None)
        return {k: _normalise_schema(v) for k, v in node.items()}
    if isinstance(node, list):
        return [_normalise_schema(v) for v in node]
    return node
