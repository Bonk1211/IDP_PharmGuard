"""asyncio.Task supervisor for the dispense cycle.

Started from backend/main.py:lifespan; one instance per process.
Catches broad exceptions inside the loop body so a transient GPIO /
network glitch does not propagate to the FastAPI lifespan and kill
the HTTP API. Only failures inside ``CycleState.init`` (HI-012
violations + camera init failure when stub disallowed) raise out of
``HardwareLoop.start`` and abort startup — that's the fail-loud path.

Operator-triggered out-of-cycle dispense lands via
``trigger_dispense_now`` (called from api/device.py). The supervisor
loop sleeps via ``asyncio.wait_for(self._dispense_now_event.wait(),
timeout=poll_interval_s)`` so the wait wakes early on trigger.
"""

from __future__ import annotations

import asyncio
import logging

from config import settings
from scheduler.cycle_runner import CycleState, run_cycle

log = logging.getLogger(__name__)

_INITIAL_BACKOFF_S = 1.0
_MAX_BACKOFF_S = 60.0


class HardwareLoop:
    def __init__(self) -> None:
        self._state: CycleState | None = None
        self._task: asyncio.Task | None = None
        self._dispense_now_event = asyncio.Event()
        self._stop_event = asyncio.Event()

    async def start(self) -> None:
        """Build CycleState + launch the supervised loop. May raise from init()."""
        self._state = CycleState()
        await self._state.init()  # HI-012 fail-loud lives here
        self._task = asyncio.create_task(
            self._supervised_loop(), name="hardware_loop"
        )

    async def stop(self) -> None:
        """Cancel the loop, await its exit, then clean up hardware. Idempotent."""
        self._stop_event.set()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            except Exception:
                log.exception("hardware loop exited with exception during stop")
            self._task = None
        if self._state is not None:
            await self._state.cleanup()

    def trigger_dispense_now(self) -> None:
        """Wake the supervisor early so the next cycle runs immediately."""
        self._dispense_now_event.set()

    def status(self) -> dict:
        """Snapshot for /api/device/status."""
        if self._state is None:
            return {
                "headless": False,
                "hardware_stubbed": True,
                "cycle_n": 0,
                "last_cycle": None,
                "task_running": False,
            }
        return {
            "headless": False,
            "hardware_stubbed": self._state.hardware_stubbed,
            "cycle_n": self._state.cycle_n,
            "last_cycle": self._state.last_cycle_summary,
            "task_running": self._task is not None and not self._task.done(),
        }

    async def _supervised_loop(self) -> None:
        """Run cycles forever. Exponential backoff on exception, reset on success."""
        assert self._state is not None
        backoff = _INITIAL_BACKOFF_S
        while not self._stop_event.is_set():
            try:
                await run_cycle(self._state)
                backoff = _INITIAL_BACKOFF_S  # reset after a successful pass
                # Sleep until poll_interval_s OR until trigger_dispense_now flips.
                try:
                    await asyncio.wait_for(
                        self._dispense_now_event.wait(),
                        timeout=settings.poll_interval_s,
                    )
                    self._dispense_now_event.clear()
                except asyncio.TimeoutError:
                    pass
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception(
                    "hardware loop crashed; restarting in %.1fs", backoff
                )
                try:
                    await asyncio.sleep(backoff)
                except asyncio.CancelledError:
                    raise
                backoff = min(backoff * 2, _MAX_BACKOFF_S)
