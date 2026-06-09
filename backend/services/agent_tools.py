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
        .select("id, patient_id, slot, pill_taken, timestamp, dispenser_id, confidence_score")
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
    return q.execute().data or []


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
    return q.execute().data or []


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
