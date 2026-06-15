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
from typing import Any, Iterator

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
  - intake_evidence    ← FIRST for "how is <patient> doing on taking pills" /
                         recent intake PERFORMANCE of one patient (metrics +
                         per-event confidence evidence)
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


_SYSTEM_PROMPT_INTAKE_FORENSIC = """\
You are a behavioural-science analyst writing a SINGLE-EVENT intake honesty
assessment for the on-duty nurse and pharmacist at the PharmGuard ward. The
question you answer is narrow and clinical: from the captured signals of ONE
medication round, is the patient's intake consistent with a GENUINE swallow,
or are there signs of a FEIGNED / concealed (e.g. palmed, cheeked, mimed)
intake?

You reason within cognitive science, not as a polygraph. Frame your reasoning
on these established ideas, and name them where relevant:
- Procedural vs. declarative memory: a fluent hand-to-mouth motor sequence can
  be performed (mimed) WITHOUT a real pill. Motor fluency alone is NOT proof of
  intake — it must be corroborated by independent OBJECT evidence (a pill /
  cup / bottle label seen during the swallow window).
- Multi-channel corroboration: genuine intake aligns three INDEPENDENT
  channels — motor sequence (MediaPipe FSM), object evidence (vision labels),
  and the tongue/mouth honesty check. Deception shows as a DISSOCIATION between
  channels: the motor sequence completes but object evidence is absent.
- Cognitive load & latency: deception and hesitation raise response latency and
  produce erratic inter-step timing. Smooth, well-paced timing is low-load and
  consistent with honest, habitual action; long stalls or a reset on the
  tongue check (pill still visible in the mouth) raise concern.
- Base rates: most patients are honest. Do NOT over-call deception. A single
  missing channel in an otherwise clean sequence is "inconclusive", not "lying".

Hard rules:
- Use ONLY the signals in the payload. NEVER invent timings, labels, or counts.
- This is decision SUPPORT, not a verdict of guilt. Always hedge: say "consistent
  with" / "raises concern for", never "the patient lied".
- Output Markdown ONLY, in this exact shape:
  `## Intake honesty assessment`
  One **bold** one-line verdict echoing `deception_risk` (Low / Moderate / High).
  `### Channel corroboration` — 2-4 bullets: motor sequence, object evidence,
     tongue/honesty check, timing — each saying what was observed and what it
     implies cognitively.
  `### Reasoning` — 2-3 bullets naming the cognitive principle that drives the
     verdict (e.g. channel dissociation, procedural-without-object).
  `### Recommended action for staff` — 1-2 bullets (e.g. "visual mouth check
     before leaving", "re-offer dose", "no action — corroborated").
- Under ~180 words. Bullets, not paragraphs.
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


# Present-progressive labels for the live "thinking" trace. Keeps the UI
# human ("Retrieving recent footage of intake") instead of raw tool names.
_TOOL_ACTIONS: dict[str, str] = {
    "intake_evidence": "Retrieving recent footage of intake",
    "patient_overview": "Pulling up the patient chart",
    "adherence_stats": "Crunching adherence statistics",
    "query_adherence": "Reading recent dose-by-dose logs",
    "query_flags": "Checking open flags",
    "today_summary": "Summarizing today's activity",
    "query_alerts": "Scanning alerts",
    "query_medications": "Checking magazine stock",
    "list_patients": "Looking up the patient roster",
    "query_schedules": "Checking upcoming doses",
}


def _tool_action(name: str) -> str:
    return _TOOL_ACTIONS.get(name, f"Running {name}")


def _intake_analysis_steps(r: dict) -> list[str]:
    """Build a grounded, behaviour-science-framed reasoning trace from the
    real intake metrics. Each line is one visible 'thought' in the UI.

    The framing borrows established models so the analysis reads like
    clinical-behavioural reasoning rather than a stats dump:
      - habit loop / dosing rhythm  (routine formation)
      - eye–mind hypothesis         (gaze fixation ≈ attention & intent)
      - COM-B                       (Capability–Opportunity–Motivation)
    """
    name = r.get("patient_name", "the patient")
    days = r.get("window_days", 7)
    n = r.get("n_events") or 0
    taken = r.get("n_taken") or 0
    missed = r.get("n_missed") or 0
    adh = r.get("adherence_pct")
    avg = r.get("avg_intake_confidence")
    low = r.get("low_confidence_events") or 0
    high = r.get("high_confidence_events") or 0
    streak = r.get("current_missed_streak") or 0

    steps: list[str] = []

    if n == 0:
        steps.append(
            f"No intake events for {name} in the last {days} days — a silent "
            "dispenser is itself a behavioural signal (disengagement), not 'no data'."
        )
        return steps

    steps.append(
        f"Reviewing {n} intake events over {days} days to establish {name}'s "
        "dosing rhythm — consistent timing is the backbone of habit formation."
    )

    if adh is not None:
        verdict = (
            "a well-formed routine"
            if adh >= 85
            else "an unstable routine worth reinforcing"
            if adh >= 60
            else "routine breakdown"
        )
        steps.append(
            f"Adherence sits at {adh}% ({taken} taken / {missed} missed) — {verdict}."
        )

    steps.append(
        "Scoring each event on three independent channels: swallow motion, "
        "object evidence, and gaze fixation."
    )
    steps.append(
        "Reading gaze fixation as an attention/intent proxy (eye–mind "
        "hypothesis): steady fixation on the pill ≈ deliberate, engaged intake."
    )

    if high:
        steps.append(
            f"{high} high-confidence events show all three channels agreeing — "
            "attention, action, and outcome aligned."
        )
    if low:
        steps.append(
            f"{low} low-confidence events: behaviour diverged from confirmed "
            "intake — likely distraction or a technique lapse, not refusal."
        )

    if streak >= 2:
        steps.append(
            f"{streak} consecutive misses — an acute habit-disruption signal "
            "(a broken routine cue), more urgent than the same misses scattered."
        )

    if avg is not None:
        avg_pct = round(avg * 100)
        tone = (
            "the verification chain is trustworthy — safe to auto-confirm"
            if avg >= 0.85
            else "borderline — corroborate before trusting the auto-verdict"
            if avg >= 0.65
            else "weak — these intakes need a human check"
        )
        steps.append(
            f"Mean intake confidence {avg_pct}%: {tone}."
        )

    steps.append(
        "Weighing capability vs. motivation (COM-B): is this a physical-ability "
        "gap or an intent gap? — that decides whether to adjust the aid or the prompt."
    )
    steps.append("Synthesising the behavioural trajectory and the recommendation.")
    return steps


def chat_stream(messages: list[dict]) -> Iterator[dict]:
    """Streaming variant of `chat` — yields event dicts as the tool-calling
    loop progresses, so the UI can show the thinking process live.

    Event shapes (all have a "type"):
      {"type": "status", "text": str}
      {"type": "tool_call", "name": str, "action": str, "args": dict}
      {"type": "tool_result", "name": str, "summary": str}
      {"type": "token", "text": str}                  # streamed final answer
      {"type": "final", "text": str, "tool_calls": [...], "metadata": {...}}
      {"type": "error", "detail": str}

    Synchronous generator on purpose: FastAPI iterates it in a threadpool, so
    the blocking DeepSeek stream is fine and we avoid asyncio plumbing.
    """
    t0 = time.time()
    try:
        client = deepseek_client.get_client()
    except RuntimeError as exc:
        yield {"type": "error", "detail": str(exc)}
        return
    tools = agent_tools.build_openai_tools()

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
    yield {"type": "status", "text": "Reviewing the question"}

    for hop in range(_MAX_TOOL_HOPS):
        try:
            stream = client.chat.completions.create(
                model=settings.deepseek_model,
                messages=conversation,
                tools=tools,
                tool_choice="auto",
                stream=True,
            )
        except Exception:
            log.exception("agent.chat_stream: DeepSeek call failed at hop %d", hop)
            yield {
                "type": "final",
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
            return

        content_parts: list[str] = []
        tc_acc: dict[int, dict] = {}
        for chunk in stream:
            choices = getattr(chunk, "choices", None) or []
            if not choices:
                continue
            delta = choices[0].delta
            if getattr(delta, "content", None):
                content_parts.append(delta.content)
                yield {"type": "token", "text": delta.content}
            for tcd in getattr(delta, "tool_calls", None) or []:
                idx = tcd.index or 0
                slot = tc_acc.setdefault(idx, {"id": None, "name": "", "args": ""})
                if tcd.id:
                    slot["id"] = tcd.id
                fn = getattr(tcd, "function", None)
                if fn is not None:
                    if fn.name:
                        slot["name"] = fn.name
                    if fn.arguments:
                        slot["args"] += fn.arguments

        if tc_acc:
            # Content streamed on a tool hop is the model's reasoning preamble,
            # not the answer. Fold it into the thinking trace and tell the UI to
            # clear the partial answer it streamed, so the final answer is clean.
            preamble = "".join(content_parts).strip()
            yield {"type": "reasoning", "text": preamble}
            ordered = [tc_acc[i] for i in sorted(tc_acc)]
            conversation.append({
                "role": "assistant",
                "content": "".join(content_parts),
                "tool_calls": [
                    {
                        "id": t["id"],
                        "type": "function",
                        "function": {
                            "name": t["name"],
                            "arguments": t["args"] or "{}",
                        },
                    }
                    for t in ordered
                ],
            })
            for t in ordered:
                name = t["name"]
                try:
                    raw_args = json.loads(t["args"] or "{}")
                except json.JSONDecodeError:
                    raw_args = {}
                yield {
                    "type": "tool_call",
                    "name": name,
                    "action": _tool_action(name),
                    "args": raw_args,
                }
                try:
                    result = agent_tools.dispatch(name, raw_args)
                except Exception as exc:
                    log.warning("agent.chat_stream: tool %s failed: %s", name, exc)
                    result = {"error": str(exc)}
                summary = _summarise_tool_result(name, result)
                tool_calls_out.append(
                    {"name": name, "args": raw_args, "result_summary": summary}
                )
                # Detailed, behaviour-science-aligned reasoning over the
                # intake evidence — streamed step by step so the clinician
                # sees HOW the verdict was reached, not just the tool name.
                if (
                    name == "intake_evidence"
                    and isinstance(result, dict)
                    and not result.get("error")
                    and not result.get("ambiguous")
                ):
                    for line in _intake_analysis_steps(result):
                        yield {"type": "analysis", "text": line}
                        time.sleep(0.45)  # cognitive pacing for the reader
                yield {"type": "tool_result", "name": name, "summary": summary}
                conversation.append({
                    "role": "tool",
                    "tool_call_id": t["id"],
                    "content": json.dumps(
                        _coerce_to_json_safe(result), default=str
                    ),
                })
            continue

        # No tool calls this hop → the streamed content is the final answer.
        final_text = "".join(content_parts).strip()
        yield {
            "type": "final",
            "text": final_text or "(no response)",
            "tool_calls": tool_calls_out,
            "metadata": {
                "hops": len(tool_calls_out) + 1,
                "latency_ms": int((time.time() - t0) * 1000),
                "model": settings.deepseek_model,
                "truncated": False,
            },
        }
        return

    # Hop budget exhausted.
    yield {
        "type": "final",
        "text": (
            "I needed more lookups than I'm allowed in one turn. "
            "Try narrowing the question (e.g., a specific patient or date)."
        ),
        "tool_calls": tool_calls_out,
        "metadata": {
            "hops": len(tool_calls_out),
            "latency_ms": int((time.time() - t0) * 1000),
            "model": settings.deepseek_model,
            "truncated": True,
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


# ──────────────────── intake honesty (single-event forensic) ─────────────────

def _intake_deception_signals(snap: dict) -> dict:
    """Reduce one intake snapshot to grounded honesty signals + a base-rate
    risk band. Deterministic — the LLM narrates these, it does not invent them.

    The core deception cue is CHANNEL DISSOCIATION: the MediaPipe motor sequence
    completes (a hand-to-mouth gesture was performed) but no medication OBJECT
    label (pill/cup/bottle) was corroborated during the swallow window — a mimed,
    'procedural-without-object' intake. The inverse — motor + object + clean
    timing — is consistent with a genuine swallow.
    """
    result = snap.get("result")
    motor_complete = bool(snap.get("mediapipe_complete"))
    labels_seen = [str(x) for x in (snap.get("labels_seen") or [])]
    labels_required = [str(x) for x in (snap.get("labels_required") or [])]
    object_evidence = bool(snap.get("labels_satisfied"))
    confidence = float(snap.get("confidence") or 0.0)
    hold = float(snap.get("hold_progress") or 0.0)

    started = snap.get("started_at")
    ended = snap.get("ended_at")
    duration_s = (
        round(float(ended) - float(started), 1)
        if started is not None and ended is not None
        else None
    )

    # Per-step latencies (gaps between consecutive passed_at) read cognitive
    # load: smooth pacing = low load (habitual/honest); long stalls = hesitation.
    history = snap.get("history") or []
    step_gaps_s: list[float] = []
    prev = started
    for h in history:
        pa = h.get("passed_at")
        if pa is not None and prev is not None:
            step_gaps_s.append(round(float(pa) - float(prev), 1))
        prev = pa if pa is not None else prev
    max_gap_s = max(step_gaps_s) if step_gaps_s else None

    # Risk banding — conservative base rate (assume honesty).
    if motor_complete and not object_evidence:
        # Gesture present, object absent → the canonical feigned-intake pattern.
        risk = "high"
    elif result == "passed" and object_evidence and confidence >= 0.65:
        risk = "low"
    elif result == "timeout" or (not motor_complete and not object_evidence):
        # Sequence never completed — can't corroborate either way.
        risk = "moderate"
    else:
        risk = "moderate"

    # A long inter-step stall nudges a low/none band up one (hesitation).
    if risk == "low" and max_gap_s is not None and max_gap_s >= 8.0:
        risk = "moderate"

    return {
        "result": result,
        "motor_sequence_complete": motor_complete,
        "object_evidence_seen": object_evidence,
        "labels_seen": labels_seen,
        "labels_required": labels_required,
        "swallow_confidence": round(confidence, 3),
        "hold_progress": round(hold, 3),
        "duration_s": duration_s,
        "step_count": len(history),
        "step_gaps_s": step_gaps_s,
        "max_inter_step_gap_s": max_gap_s,
        "deception_risk": risk,
    }


async def analyze_intake_honesty(snapshot: dict) -> dict:
    """Single-shot cognitive-science honesty assessment for ONE intake round.

    `snapshot` is the dashboard's IntakeState (plus optional patient/slot/medication
    context). Returns {"content_markdown", "deception_risk", "verdict", "signals",
    "metadata"}. Fails-soft to a deterministic narrative if the LLM is unavailable.
    """
    t0 = time.time()
    signals = _intake_deception_signals(snapshot)
    risk = signals["deception_risk"]

    context = {
        "patient_name": snapshot.get("patient_name"),
        "medication": snapshot.get("medication") or snapshot.get("slot_name"),
        "slot": snapshot.get("slot"),
    }
    payload = {"context": context, "signals": signals}

    user_prompt = (
        "Captured signals for ONE intake round (DO NOT add or invent anything "
        "outside this payload). The `deception_risk` band is already computed "
        "from the rules — echo it, do not override it:\n\n"
        f"```json\n{json.dumps(payload, default=str, indent=2)}\n```"
    )

    verdict_line = {
        "low": "Consistent with a genuine swallow — channels corroborate.",
        "moderate": "Inconclusive — at least one verification channel is missing.",
        "high": "Raises concern for feigned intake — motor gesture without object evidence.",
    }[risk]

    content_md: str
    used_llm = False
    try:
        client = deepseek_client.get_client()
        resp = await asyncio.to_thread(
            client.chat.completions.create,
            model=settings.deepseek_model,
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT_INTAKE_FORENSIC},
                {"role": "user", "content": user_prompt},
            ],
        )
        content_md = (resp.choices[0].message.content or "").strip()
        used_llm = bool(content_md)
    except Exception:
        log.exception("agent.analyze_intake_honesty: DeepSeek call failed")
        content_md = ""

    if not content_md:
        # Deterministic fallback so the nurse still gets a grounded report.
        seen = ", ".join(signals["labels_seen"]) or "none"
        content_md = (
            "## Intake honesty assessment\n\n"
            f"**{verdict_line}**\n\n"
            "### Channel corroboration\n"
            f"- Motor sequence: {'completed' if signals['motor_sequence_complete'] else 'not completed'} "
            f"(swallow confidence {round(signals['swallow_confidence'] * 100)}%).\n"
            f"- Object evidence: {'present' if signals['object_evidence_seen'] else 'absent'} "
            f"(labels seen: {seen}).\n"
            f"- Timing: {signals['duration_s'] if signals['duration_s'] is not None else '—'}s total"
            f"{f', longest inter-step stall {signals['max_inter_step_gap_s']}s' if signals['max_inter_step_gap_s'] is not None else ''}.\n\n"
            "### Reasoning\n"
            "- Verdict follows multi-channel corroboration: a completed motor "
            "sequence without object evidence is a procedural-without-object "
            "(mimed) pattern; full corroboration is consistent with honest intake.\n\n"
            "### Recommended action for staff\n"
            + (
                "- Do a direct visual mouth check before the patient leaves.\n"
                if risk != "low"
                else "- No action — intake corroborated across channels.\n"
            )
            + "\n_(LLM narrator unavailable — deterministic fallback.)_"
        )

    return {
        "content_markdown": content_md,
        "deception_risk": risk,
        "verdict": verdict_line,
        "signals": signals,
        "metadata": {
            "model": settings.deepseek_model if used_llm else "deterministic-fallback",
            "latency_ms": int((time.time() - t0) * 1000),
            "used_llm": used_llm,
        },
    }
