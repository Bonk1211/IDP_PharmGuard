"""Shared actuator interlock — the stepper and servo must never move together.

The magazine stepper (hardware/magazine.py) and the ejector servo
(hardware/ejector.py) share one mechanical envelope: if the stepper
rotates the magazine while the servo pusher is mid-stroke (or the pusher
strokes while the magazine is still turning) the pusher arm fouls the
magazine wall and the whole mechanism jams. Only ONE actuator may be in
motion at any instant.

Callers already sequence rotate-then-push, but that ordering lives in the
callers (cycle_runner, api/device, bench scripts) and is easy to break.
This lock enforces the rule one level lower, at the hardware drivers
themselves, so it holds no matter who calls them or in what order:

  * Magazine.rotate_to and Ejector.push each acquire ACTUATOR_LOCK for the
    FULL duration of their physical motion.
  * Before releasing, each sleeps SETTLE_S so the just-moved actuator has
    mechanically come to rest — the other actuator cannot start while the
    first is still oscillating / coasting down.

A plain threading.Lock is correct here because all hardware motion is
dispatched through ``asyncio.to_thread`` onto the default executor: the
two motions run on distinct OS threads against one physical machine.
Acquisition is non-reentrant and the two motions are always called
sequentially (never nested), so there is no deadlock risk.
"""

from __future__ import annotations

import threading

# Process-global: one physical dispenser per process (uvicorn --workers 1).
ACTUATOR_LOCK = threading.Lock()

# Mechanical settle time held after an actuator finishes its motion, before
# the interlock is released and the other actuator is allowed to start.
# Covers stepper post-step oscillation and servo coast-down so the two
# never physically overlap at the rotate<->push boundary.
SETTLE_S = 0.3
