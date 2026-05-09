"""Clinician-assistant endpoints — gated by X-Device-API-Key.

Path: /api/agent/*
Caller: dashboard via ngrok->Pi (see frontend/src/lib/agent.ts).

Three endpoints:
  POST /chat          - one round of conversational chat (function-calling)
  POST /brief         - generate a fresh on-demand brief, persist, return it
  GET  /briefs/recent - list the last N briefs (newest first)
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from core.security import verify_device_api_key
from db.base import get_supabase
from services.agent import chat, generate_brief

log = logging.getLogger(__name__)

router = APIRouter(dependencies=[Depends(verify_device_api_key)])


class ChatMessage(BaseModel):
    """A single turn from the user-side chat history.

    `role` accepts "user" / "assistant" / "system". System messages are
    DROPPED before the LLM call — the server controls the system prompt.
    """
    role: str
    text: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(default_factory=list, max_length=50)


@router.post("/chat")
async def chat_endpoint(body: ChatRequest):
    if not body.messages:
        raise HTTPException(status_code=400, detail="messages cannot be empty")
    # Drop any 'system' messages — server-side prompt only.
    safe_messages = [
        m.model_dump() for m in body.messages if m.role in ("user", "assistant")
    ]
    if not safe_messages:
        raise HTTPException(
            status_code=400,
            detail="messages must contain at least one user/assistant turn",
        )
    try:
        result = await asyncio.wait_for(chat(safe_messages), timeout=60.0)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="agent took too long (>60 s)")
    except RuntimeError as exc:
        # _ensure_configured raises this when GEMINI_API_KEY is missing.
        raise HTTPException(status_code=503, detail=str(exc))
    return result


@router.post("/brief")
async def brief_endpoint(kind: str = Query(default="on_demand")):
    if kind not in ("shift_handover", "on_demand"):
        raise HTTPException(
            status_code=400,
            detail="kind must be 'shift_handover' or 'on_demand'",
        )
    try:
        brief = await asyncio.wait_for(generate_brief(kind=kind), timeout=60.0)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="brief took too long (>60 s)")
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    # Persist to Supabase
    sb = get_supabase()
    payload = {
        "kind": brief["kind"],
        "content": brief["content_markdown"],
        "metadata": brief["metadata"],
    }
    try:
        result = await asyncio.to_thread(
            lambda: sb.table("agent_briefs").insert(payload).execute()
        )
        row = result.data[0] if result.data else payload
    except Exception:
        log.exception("brief_endpoint: failed to persist brief")
        # Still return the generated brief even if persistence failed.
        row = payload
    return row


@router.get("/briefs/recent")
async def briefs_recent(limit: int = Query(default=5, ge=1, le=50)):
    sb = get_supabase()
    result = await asyncio.to_thread(
        lambda: sb.table("agent_briefs")
        .select("*")
        .order("generated_at", desc=True)
        .limit(limit)
        .execute()
    )
    return result.data or []
