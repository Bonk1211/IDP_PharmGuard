"""Gemini-powered clinician assistant: conversational chat + daily brief.

Two public entry points:

  await chat(messages)        -- function-calling loop (max 6 hops)
                                 returns {"text", "tool_calls", "metadata"}

  await generate_brief(kind)  -- single-shot summary using pre-fetched data
                                 returns {"kind", "content_markdown",
                                          "metadata"}

Both lazy-import google.generativeai. Both fail-loud with a 503-ready
RuntimeError when GEMINI_API_KEY is not configured.

This module is read-only on the Supabase side: the only writes are
agent_briefs INSERTs which happen in api/agent.py + brief_scheduler.py.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from config import settings
from services import agent_tools

log = logging.getLogger(__name__)

# Hard cap so a runaway LLM that keeps emitting function_calls can't
# spin forever. After this many hops we give up and return whatever
# text we have (or a degraded "couldn't reach an answer" fallback).
_MAX_TOOL_HOPS = 6

# How much history of adherence/alerts the brief generator pre-fetches.
_BRIEF_LOOKBACK = timedelta(hours=12)


_SYSTEM_PROMPT_CHAT = """\
You are a clinical assistant for the PharmGuard pill dispenser system.
You help nurses and pharmacists understand what's happened recently and
answer questions about patient adherence, alerts, inventory, and patients.

Hard rules:
- Use ONLY data returned by your tools. NEVER invent counts, names, or dates.
- Cite exact numbers and patient names you saw in the tool output.
- If a question is ambiguous (e.g. "evening" — does the user mean after 18:00?),
  ask the user to clarify rather than guessing.
- If the tools returned no data, say so plainly. Don't pad with caveats.
- Format responses in concise markdown. Use bullets for lists, **bold** for
  anomalies (missed doses, low confidence, expiring soon).
- Keep replies under ~250 words unless asked to expand.

Available tools (use them aggressively — start with `query_flags` for
"what needs my attention", or `today_summary` for broad questions, then
drill down):
  - query_flags          ← proactive anomalies (use FIRST for "what's wrong")
  - today_summary
  - query_adherence
  - query_alerts
  - query_medications
  - list_patients
"""


_SYSTEM_PROMPT_BRIEF = """\
You are writing a SHIFT-HANDOVER brief for the next on-duty nurse and
pharmacist at the PharmGuard ward.

Constraints:
- Markdown only. Top-level heading like "## Shift handover — {when}".
- Cover, in this order:
  1. at-a-glance numbers,
  2. "## Open flags" — list each `open_flags[].title` as a bullet (omit IDs;
     write "(none)" if `open_flags_count` is 0),
  3. missed / low-confidence doses with patient names,
  4. alerts (expiry / low_stock),
  5. anything else that needs attention next shift.
- Use ONLY the data provided in the prefetched payload. Do NOT invent.
- Keep it under 200 words; bullets, not prose paragraphs.
- If a section has no data, write "(none)" rather than skipping it.
"""


# ──────────────────────────── lazy model bootstrap ──────────────────────────

_model_chat = None
_model_brief = None


def _ensure_configured() -> None:
    if not settings.gemini_api_key:
        raise RuntimeError(
            "GEMINI_API_KEY not set — agent endpoints unavailable. "
            "Set it in backend/.env to enable the clinician assistant."
        )
    import google.generativeai as genai
    genai.configure(api_key=settings.gemini_api_key)


def _get_model_chat():
    """Tool-equipped model for the chat loop."""
    global _model_chat
    if _model_chat is None:
        _ensure_configured()
        import google.generativeai as genai
        _model_chat = genai.GenerativeModel(
            model_name=settings.agent_model_name,
            tools=agent_tools.build_gemini_tools(),
            system_instruction=_SYSTEM_PROMPT_CHAT,
        )
        log.info("agent: chat model loaded (%s)", settings.agent_model_name)
    return _model_chat


def _get_model_brief():
    """No tools — single-shot summary from pre-fetched data."""
    global _model_brief
    if _model_brief is None:
        _ensure_configured()
        import google.generativeai as genai
        _model_brief = genai.GenerativeModel(
            model_name=settings.agent_model_name,
            system_instruction=_SYSTEM_PROMPT_BRIEF,
        )
        log.info("agent: brief model loaded (%s)", settings.agent_model_name)
    return _model_brief


# ──────────────────────────── chat (function-calling loop) ──────────────────

def _user_messages_to_gemini(messages: list[dict]) -> list[dict]:
    """Convert {role, text} -> Gemini Content list. Drops any 'system' role
    silently (server-side prompt is the only allowed system message)."""
    out: list[dict] = []
    for m in messages:
        role = m.get("role")
        text = m.get("text", "")
        if role == "user":
            out.append({"role": "user", "parts": [{"text": text}]})
        elif role == "assistant":
            out.append({"role": "model", "parts": [{"text": text}]})
        # role == "system" → silently dropped
    return out


def _summarise_tool_result(name: str, result: Any) -> str:
    """Compress a tool result for inclusion in the response metadata.

    Avoids leaking large blobs into the chat payload. Operator clicks
    through to actual rows via the existing dashboard tables.
    """
    if isinstance(result, list):
        return f"{len(result)} rows"
    if isinstance(result, dict):
        keys = list(result.keys())[:5]
        return "fields=" + ", ".join(keys) + (" …" if len(result) > 5 else "")
    return str(result)[:80]


async def chat(messages: list[dict]) -> dict:
    """Run a function-calling loop on Gemini.

    Args:
      messages: [{role: "user"|"assistant", text: str}, ...]
                System role is dropped (server controls system prompt).

    Returns:
      {
        "text": str,                        # final assistant text reply
        "tool_calls": [                     # what the agent did to answer
          {"name": str, "args": dict, "result_summary": str},
        ],
        "metadata": {"hops": int, "latency_ms": int, "model": str,
                     "truncated": bool},
      }
    """
    t0 = time.time()
    model = _get_model_chat()
    history = _user_messages_to_gemini(messages)

    chat_session = model.start_chat(history=history[:-1] if history else [])
    last_user_msg = history[-1]["parts"][0]["text"] if history else ""
    next_payload: Any = last_user_msg

    tool_calls: list[dict] = []
    text_reply = ""
    truncated = False

    for hop in range(_MAX_TOOL_HOPS):
        try:
            resp = await asyncio.to_thread(chat_session.send_message, next_payload)
        except Exception:
            log.exception("agent.chat: Gemini call failed at hop %d", hop)
            return {
                "text": (
                    "I couldn't reach Gemini just now. "
                    "Try again in a moment, or check the backend logs."
                ),
                "tool_calls": tool_calls,
                "metadata": {
                    "hops": hop,
                    "latency_ms": int((time.time() - t0) * 1000),
                    "model": settings.agent_model_name,
                    "truncated": False,
                    "error": True,
                },
            }

        # Inspect the first candidate. Gemini puts function_call OR text
        # under candidates[0].content.parts[*].
        try:
            parts = resp.candidates[0].content.parts
        except (IndexError, AttributeError):
            parts = []

        function_call = None
        accumulated_text = ""
        for p in parts:
            fc = getattr(p, "function_call", None)
            if fc and getattr(fc, "name", None):
                function_call = fc
                break
            t = getattr(p, "text", None)
            if t:
                accumulated_text += t

        if function_call is not None:
            name = function_call.name
            raw_args = dict(function_call.args or {})
            try:
                result = await asyncio.to_thread(agent_tools.dispatch, name, raw_args)
            except Exception as exc:
                log.warning("agent.chat: tool %s failed: %s", name, exc)
                result = {"error": str(exc)}
            tool_calls.append({
                "name": name,
                "args": raw_args,
                "result_summary": _summarise_tool_result(name, result),
            })
            # Build the next message: a function_response part the model can read.
            try:
                import google.generativeai as genai
                next_payload = genai.protos.Content(
                    parts=[
                        genai.protos.Part(
                            function_response=genai.protos.FunctionResponse(
                                name=name,
                                response={"result": _coerce_to_json_safe(result)},
                            )
                        )
                    ]
                )
            except Exception:
                # Fallback shape if genai.protos isn't available in this version.
                next_payload = {
                    "role": "function",
                    "parts": [{
                        "function_response": {
                            "name": name,
                            "response": {"result": _coerce_to_json_safe(result)},
                        }
                    }],
                }
            continue  # loop again

        # No function_call → text reply, we're done.
        text_reply = accumulated_text.strip()
        break
    else:
        # for-loop exhausted without break → ran out of hops.
        truncated = True
        text_reply = (
            "I needed more lookups than I'm allowed in one turn. "
            "Try narrowing the question (e.g., a specific patient or date)."
        )

    return {
        "text": text_reply or "(no response)",
        "tool_calls": tool_calls,
        "metadata": {
            "hops": len(tool_calls) + (0 if truncated else 1),
            "latency_ms": int((time.time() - t0) * 1000),
            "model": settings.agent_model_name,
            "truncated": truncated,
        },
    }


def _coerce_to_json_safe(value: Any) -> Any:
    """Make sure a tool result can be json.dumps'd. Strips datetimes etc."""
    try:
        json.dumps(value)
        return value
    except TypeError:
        return json.loads(json.dumps(value, default=str))


# ──────────────────────────── brief (single-shot) ───────────────────────────

async def generate_brief(kind: str = "shift_handover") -> dict:
    """Generate a markdown shift-handover brief from pre-fetched data."""
    if kind not in ("shift_handover", "on_demand"):
        raise ValueError(f"unknown brief kind: {kind}")

    t0 = time.time()
    since_iso = (datetime.now(timezone.utc) - _BRIEF_LOOKBACK).isoformat()

    # Pre-fetch the inputs synchronously inside threads so we don't block
    # the asyncio loop while Supabase round-trips.
    summary = await asyncio.to_thread(agent_tools.today_summary)
    missed = await asyncio.to_thread(
        agent_tools.query_adherence,
        since_iso=since_iso, only_missed=True, limit=50,
    )
    alerts = await asyncio.to_thread(
        agent_tools.query_alerts, since_iso=since_iso, limit=50,
    )
    low_stock = await asyncio.to_thread(
        agent_tools.query_medications, low_stock_only=True,
    )
    open_flags = await asyncio.to_thread(
        agent_tools.query_flags, status="open", limit=10,
    )
    # Strip the heavyweight `payload` jsonb from each flag — the brief only
    # needs the human-readable surface (kind/severity/title/detail).
    open_flags_brief = [
        {
            "kind": f.get("kind"),
            "severity": f.get("severity"),
            "title": f.get("title"),
            "detail": f.get("detail"),
            "patient_id": f.get("patient_id"),
        }
        for f in open_flags
    ]

    payload = {
        "now_local": datetime.now().astimezone().isoformat(),
        "lookback_hours": _BRIEF_LOOKBACK.total_seconds() / 3600.0,
        "today_summary": summary,
        "missed_doses": missed,
        "alerts": alerts,
        "low_stock_medications": low_stock,
        "open_flags": open_flags_brief,
        "open_flags_count": len(open_flags),
    }

    user_prompt = (
        "Pre-fetched data for the brief (DO NOT add or invent anything "
        "outside this payload):\n\n"
        f"```json\n{json.dumps(payload, default=str, indent=2)}\n```"
    )

    model = _get_model_brief()
    try:
        resp = await asyncio.to_thread(model.generate_content, user_prompt)
        content_md = (getattr(resp, "text", "") or "").strip()
    except Exception:
        log.exception("agent.generate_brief: Gemini call failed")
        content_md = (
            "## Brief unavailable\n\n"
            "Gemini call failed. Check backend logs and GEMINI_API_KEY."
        )

    return {
        "kind": kind,
        "content_markdown": content_md or "## Brief\n\n(empty response)",
        "metadata": {
            "model": settings.agent_model_name,
            "latency_ms": int((time.time() - t0) * 1000),
            "lookback_hours": _BRIEF_LOOKBACK.total_seconds() / 3600.0,
            "n_missed": len(missed),
            "n_alerts": len(alerts),
            "n_low_stock": len(low_stock),
            "n_open_flags": len(open_flags),
        },
    }
