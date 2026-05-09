"""Periodic shift-handover-brief generator.

Runs as a long-lived asyncio.Task spawned from backend/main.py:lifespan,
sibling to HardwareLoop. Wakes at each configured local hour
(``settings.agent_brief_local_hours``, e.g. "7,19"), calls
services.agent.generate_brief, and persists the result to agent_briefs.

Crash-safe: a broad `except` catches any failure (Gemini outage,
Supabase outage, malformed config) and waits 60 s before retrying so
the loop never permanently exits.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta

from config import settings
from db.base import get_supabase
from services.agent import generate_brief

log = logging.getLogger(__name__)


def _parse_target_hours(csv: str) -> list[int]:
    """Parse `"7,19"` -> [7, 19]. Drops out-of-range values."""
    out: list[int] = []
    for part in (csv or "").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            h = int(part)
        except ValueError:
            log.warning("brief scheduler: ignoring non-int hour %r", part)
            continue
        if 0 <= h <= 23:
            out.append(h)
        else:
            log.warning("brief scheduler: ignoring out-of-range hour %d", h)
    return sorted(set(out))


def _seconds_until_next_target(target_hours: list[int], now: datetime | None = None) -> float:
    """Compute seconds until the next target local hour. Wraps midnight.

    If no target hours configured, returns 24 h (noop wakeup).
    """
    if not target_hours:
        return 24 * 3600.0
    now = now or datetime.now().astimezone()
    candidates: list[datetime] = []
    for h in target_hours:
        candidate = now.replace(hour=h, minute=0, second=0, microsecond=0)
        if candidate <= now:
            candidate = candidate + timedelta(days=1)
        candidates.append(candidate)
    nxt = min(candidates)
    return max(0.0, (nxt - now).total_seconds())


async def brief_scheduler_loop() -> None:
    """Long-running task. Sleeps until the next target hour, then generates
    + persists a brief. Crash-safe: any exception is logged + 60 s backoff.
    Shut down via task.cancel() from the lifespan teardown.
    """
    log.info(
        "brief scheduler: started — target hours=%s",
        settings.agent_brief_local_hours,
    )
    while True:
        try:
            target_hours = _parse_target_hours(settings.agent_brief_local_hours)
            wait_s = _seconds_until_next_target(target_hours)
            log.info(
                "brief scheduler: next brief in %.1f h (%d:00)",
                wait_s / 3600.0,
                _next_hour_label(target_hours) if target_hours else -1,
            )
            await asyncio.sleep(wait_s)

            log.info("brief scheduler: generating shift_handover brief")
            brief = await generate_brief(kind="shift_handover")
            sb = get_supabase()
            await asyncio.to_thread(
                lambda: sb.table("agent_briefs").insert({
                    "kind": "shift_handover",
                    "content": brief["content_markdown"],
                    "metadata": brief["metadata"],
                }).execute()
            )
            log.info(
                "brief scheduler: persisted (latency=%dms, n_missed=%s)",
                brief["metadata"].get("latency_ms"),
                brief["metadata"].get("n_missed"),
            )
        except asyncio.CancelledError:
            log.info("brief scheduler: cancelled, exiting")
            raise
        except Exception:
            log.exception("brief scheduler: crashed, retrying in 60 s")
            try:
                await asyncio.sleep(60)
            except asyncio.CancelledError:
                raise


def _next_hour_label(target_hours: list[int]) -> int:
    """Just the numeric hour of the next firing — used for log clarity."""
    now = datetime.now().astimezone()
    for h in sorted(target_hours):
        candidate = now.replace(hour=h, minute=0, second=0, microsecond=0)
        if candidate > now:
            return h
    return min(target_hours)  # wrapped to tomorrow
