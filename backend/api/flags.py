"""Agent flag endpoints — list / ack / resolve / dismiss.

Path:    /api/agent/flags/*
Caller:  dashboard via ngrok->Pi (frontend/src/lib/agent.ts).

All endpoints sit behind the same X-Device-API-Key as the rest of
/api/agent/* and /api/device/*.

Endpoints:
  GET  /                  - list flags (default status='open')
  POST /{flag_id}/ack     - mark acknowledged (still visible)
  POST /{flag_id}/resolve - mark resolved with optional note
  POST /{flag_id}/dismiss - mark dismissed (false positive) with optional note
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from core.security import verify_device_api_key
from db.base import get_supabase

log = logging.getLogger(__name__)

router = APIRouter(dependencies=[Depends(verify_device_api_key)])


_TERMINAL_STATUSES = {"resolved", "dismissed"}
_VALID_STATUSES = {"open", "acked", "resolved", "dismissed"}


class ResolveBody(BaseModel):
    """Body for /resolve and /dismiss. Both fields optional."""
    note: str | None = Field(default=None, max_length=500)
    resolved_by: str | None = Field(default=None, max_length=80)


# ──────────────────────────── list ──────────────────────────────────────────

@router.get("/")
async def list_flags(
    status: str | None = Query(default="open"),
    kind: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
):
    if status is not None and status not in _VALID_STATUSES:
        raise HTTPException(
            status_code=400,
            detail=f"status must be one of {sorted(_VALID_STATUSES)} or null",
        )
    sb = get_supabase()

    def _run():
        q = (
            sb.table("agent_flags")
            .select("*")
            .order("created_at", desc=True)
            .limit(limit)
        )
        if status is not None:
            q = q.eq("status", status)
        if kind is not None:
            q = q.eq("kind", kind)
        return q.execute()

    result = await asyncio.to_thread(_run)
    return result.data or []


# ──────────────────────────── transitions ───────────────────────────────────

async def _fetch_flag(flag_id: int) -> dict:
    sb = get_supabase()
    result = await asyncio.to_thread(
        lambda: sb.table("agent_flags")
        .select("*")
        .eq("id", flag_id)
        .limit(1)
        .execute()
    )
    rows = result.data or []
    if not rows:
        raise HTTPException(status_code=404, detail=f"flag {flag_id} not found")
    return rows[0]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@router.post("/{flag_id}/ack")
async def ack_flag(flag_id: int):
    existing = await _fetch_flag(flag_id)
    if existing["status"] in _TERMINAL_STATUSES:
        raise HTTPException(
            status_code=409,
            detail=f"flag {flag_id} is already {existing['status']}",
        )
    if existing["status"] == "acked":
        return existing  # idempotent

    sb = get_supabase()
    update = {"status": "acked", "acked_at": _now_iso()}
    result = await asyncio.to_thread(
        lambda: sb.table("agent_flags").update(update).eq("id", flag_id).execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail=f"flag {flag_id} not found")
    log.info("agent_flag: id=%d acked", flag_id)
    return result.data[0]


@router.post("/{flag_id}/resolve")
async def resolve_flag(flag_id: int, body: ResolveBody):
    existing = await _fetch_flag(flag_id)
    if existing["status"] in _TERMINAL_STATUSES:
        raise HTTPException(
            status_code=409,
            detail=f"flag {flag_id} is already {existing['status']}",
        )
    sb = get_supabase()
    update = {
        "status": "resolved",
        "resolved_at": _now_iso(),
        "resolved_by_user": body.resolved_by,
        "resolution_note": body.note,
    }
    result = await asyncio.to_thread(
        lambda: sb.table("agent_flags").update(update).eq("id", flag_id).execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail=f"flag {flag_id} not found")
    log.info(
        "agent_flag: id=%d resolved by=%r note_len=%d",
        flag_id,
        body.resolved_by,
        len(body.note or ""),
    )
    return result.data[0]


@router.post("/{flag_id}/dismiss")
async def dismiss_flag(flag_id: int, body: ResolveBody):
    existing = await _fetch_flag(flag_id)
    if existing["status"] in _TERMINAL_STATUSES:
        raise HTTPException(
            status_code=409,
            detail=f"flag {flag_id} is already {existing['status']}",
        )
    sb = get_supabase()
    update = {
        "status": "dismissed",
        "resolved_at": _now_iso(),
        "resolved_by_user": body.resolved_by,
        "resolution_note": body.note,
    }
    result = await asyncio.to_thread(
        lambda: sb.table("agent_flags").update(update).eq("id", flag_id).execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail=f"flag {flag_id} not found")
    log.info("agent_flag: id=%d dismissed by=%r", flag_id, body.resolved_by)
    return result.data[0]
