"""DeepSeek-powered clinician assistant: conversational chat + daily brief.

Two public entry points:

  await chat(messages)        -- tool-calling loop (max 6 hops)
                                 returns {"text", "tool_calls", "metadata"}

  await generate_brief(kind)  -- single-shot summary using pre-fetched data
                                 returns {"kind", "content_markdown",
                                          "metadata"}

Both fail-loud with a 503-ready RuntimeError when DEEPSEEK_API_KEY is not
configured.

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
from services import agent_tools, deepseek_client

log = logging.getLogger(__name__)

_MAX_TOOL_HOPS = 6
_BRIEF_LOOKBACK = timedelta(hours=12)


_SYSTEM_PROMPT_CHAT = """\
You are a clinical assistant for the PharmGuard pill dispenser system.
You help nurses and pharmacists understand what's happened recently and
answer questions about patient adherence, alerts, inventory, and patients.

Hard rules:
- Use ONLY data returned by your tools. NEVER invent counts, names, or dates.
- Refer to patients by NAME (tools return patient_name); never expose raw
  numeric IDs unless the user asks for them.
- Cite exact numbers and patient names you saw in the tool output.
- If the tools returned no data, say so plainly. Don't pad with caveats.
- Answer shape: ONE-line verdict first, then at most 5 markdown bullets;
  **bold** anomalies (missed doses, low confidence, expiring soon). End with
  ONE short follow-up question only when it would change the action.
- Keep replies under ~200 words unless asked to expand.

Tool routing (use tools aggressively):
  - query_flags        ← FIRST for "what needs my attention" / "anything wrong"
  - today_summary      ← broad "what's happened today" questions
  - patient_overview   ← FIRST for any single-patient question (id or name)
  - adherence_stats    ← "who is at risk", adherence rates, missed streaks
  - query_schedules    ← "who is due next", upcoming doses
  - query_adherence    ← raw dose-by-dose history with time bounds
  - query_alerts       ← expiry / low-stock alert feed
  - query_medications  ← magazine slots and stock levels
  - list_patients      ← roster lookups and status filters
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


# ──────────────────────────── chat (tool-calling loop) ──────────────────────

def _messages_to_openai(messages: list[dict]) -> list[dict]:
    """Convert {role, text} -> OpenAI chat-completions message list. Drops
    any 'system' role silently (server-side prompt is the only system msg)."""
    out: list[dict] = []
    for m in messages:
        role = m.get("role")
        text = m.get("text", "")
        if role in ("user", "assistant"):
            out.append({"role": role, "content": text})
    return out


def _summarise_tool_result(name: str, result: Any) -> str:
    if isinstance(result, list):
        return f"{len(result)} rows"
    if isinstance(result, dict):
        keys = list(result.keys())[:5]
        return "fields=" + ", ".join(keys) + (" …" if len(result) > 5 else "")
    return str(result)[:80]


async def chat(messages: list[dict]) -> dict:
    """Run a tool-calling loop on DeepSeek (OpenAI-compatible chat API).

    Args:
      messages: [{role: "user"|"assistant", text: str}, ...]
                System role is dropped (server controls system prompt).

    Returns:
      {
        "text": str,
        "tool_calls": [{"name": str, "args": dict, "result_summary": str}, ...],
        "metadata": {"hops": int, "latency_ms": int, "model": str,
                     "truncated": bool},
      }
    """
    t0 = time.time()
    client = deepseek_client.get_client()
    tools = agent_tools.build_openai_tools()

    # Give the model a clock so "today" / "this evening" / "last night"
    # resolve without a clarifying round-trip. Pi-local time, same clock
    # the device scheduler uses. Kept as a SEPARATE system message so the
    # static prompt prefix above it stays byte-identical across requests
    # and remains eligible for provider-side context caching.
    clock_msg = (
        f"Current local datetime: {datetime.now().astimezone().isoformat()} — "
        "resolve relative dates ('today', 'this evening', 'last night') "
        "against this."
    )
    conversation: list[dict] = [
        {"role": "system", "content": _SYSTEM_PROMPT_CHAT},
        {"role": "system", "content": clock_msg},
    ] + _messages_to_openai(messages)

    tool_calls_out: list[dict] = []
    text_reply = ""
    truncated = False

    for hop in range(_MAX_TOOL_HOPS):
        try:
            resp = await asyncio.to_thread(
                client.chat.completions.create,
                model=settings.deepseek_model,
                messages=conversation,
                tools=tools,
                tool_choice="auto",
            )
        except Exception:
            log.exception("agent.chat: DeepSeek call failed at hop %d", hop)
            return {
                "text": (
                    "I couldn't reach the assistant just now. "
                    "Try again in a moment, or check the backend logs."
                ),
                "tool_calls": tool_calls_out,
                "metadata": {
                    "hops": hop,
                    "latency_ms": int((time.time() - t0) * 1000),
                    "model": settings.deepseek_model,
                    "truncated": False,
                    "error": True,
                },
            }

        msg = resp.choices[0].message
        tc_list = getattr(msg, "tool_calls", None) or []

        if tc_list:
            conversation.append({
                "role": "assistant",
                "content": msg.content or "",
                "tool_calls": [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.function.name,
                            "arguments": tc.function.arguments or "{}",
                        },
                    }
                    for tc in tc_list
                ],
            })
            for tc in tc_list:
                name = tc.function.name
                try:
                    raw_args = json.loads(tc.function.arguments or "{}")
                except json.JSONDecodeError:
                    raw_args = {}
                try:
                    result = await asyncio.to_thread(
                        agent_tools.dispatch, name, raw_args,
                    )
                except Exception as exc:
                    log.warning("agent.chat: tool %s failed: %s", name, exc)
                    result = {"error": str(exc)}
                tool_calls_out.append({
                    "name": name,
                    "args": raw_args,
                    "result_summary": _summarise_tool_result(name, result),
                })
                conversation.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": json.dumps(
                        _coerce_to_json_safe(result), default=str,
                    ),
                })
            continue

        text_reply = (msg.content or "").strip()
        break
    else:
        truncated = True
        text_reply = (
            "I needed more lookups than I'm allowed in one turn. "
            "Try narrowing the question (e.g., a specific patient or date)."
        )

    return {
        "text": text_reply or "(no response)",
        "tool_calls": tool_calls_out,
        "metadata": {
            "hops": len(tool_calls_out) + (0 if truncated else 1),
            "latency_ms": int((time.time() - t0) * 1000),
            "model": settings.deepseek_model,
            "truncated": truncated,
        },
    }


def _coerce_to_json_safe(value: Any) -> Any:
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

    client = deepseek_client.get_client()
    try:
        resp = await asyncio.to_thread(
            client.chat.completions.create,
            model=settings.deepseek_model,
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT_BRIEF},
                {"role": "user", "content": user_prompt},
            ],
        )
        content_md = (resp.choices[0].message.content or "").strip()
    except Exception:
        log.exception("agent.generate_brief: DeepSeek call failed")
        content_md = (
            "## Brief unavailable\n\n"
            "LLM call failed. Check backend logs and DEEPSEEK_API_KEY."
        )

    return {
        "kind": kind,
        "content_markdown": content_md or "## Brief\n\n(empty response)",
        "metadata": {
            "model": settings.deepseek_model,
            "latency_ms": int((time.time() - t0) * 1000),
            "lookback_hours": _BRIEF_LOOKBACK.total_seconds() / 3600.0,
            "n_missed": len(missed),
            "n_alerts": len(alerts),
            "n_low_stock": len(low_stock),
            "n_open_flags": len(open_flags),
        },
    }
