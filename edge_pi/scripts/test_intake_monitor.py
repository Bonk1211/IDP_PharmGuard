#!/usr/bin/env python3
"""Live test for IntakeMonitor (MediaPipe swallow FSM).

Bridges Pi camera into cv2 via rpicam-vid → MJPEG/TCP, since picamera2 is bound
to the system Python 3.13 and this script must run under Python 3.11 (mediapipe).
"""
from __future__ import annotations

import argparse
import logging
import signal
import subprocess
import sys
import time
from pathlib import Path

import cv2

# Make `vision` importable when running from any cwd.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from vision.camera import Cv2Source  # noqa: E402
from vision.intake_monitor import (  # noqa: E402
    _STEP_ORDER,
    INSPECTION_HOLD_TIME,
    POSE_HOLD_TIME,
    REQUIRED_CONFIDENCE,
    SMOOTHING_ALPHA,
    IntakeMonitor,
)


def start_rpicam(width: int, height: int, framerate: int, port: int) -> subprocess.Popen:
    cmd = [
        "rpicam-vid", "-n", "-t", "0",
        "--codec", "mjpeg", "-q", "70",
        "--width", str(width), "--height", str(height),
        "--framerate", str(framerate),
        "-l", "-o", f"tcp://0.0.0.0:{port}",
    ]
    print(f"[rpicam] launching: {' '.join(cmd)}")
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    return proc


def open_capture(port: int, retries: int = 30) -> cv2.VideoCapture:
    url = f"tcp://localhost:{port}"
    for i in range(retries):
        cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG)
        if cap.isOpened():
            ok, _ = cap.read()
            if ok:
                print(f"[cv2 ] capture opened on {url} after {i+1} attempt(s)")
                return cap
            cap.release()
        time.sleep(0.5)
    raise RuntimeError(f"could not open {url}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--width", type=int, default=640)
    ap.add_argument("--height", type=int, default=480)
    ap.add_argument("--fps", type=int, default=15)
    ap.add_argument("--port", type=int, default=8888)
    ap.add_argument("--timeout", type=float, default=120.0)
    ap.add_argument("--out", default="/tmp/intake_out")
    ap.add_argument("--save-every", type=int, default=10, help="save annotated frame every N frames")
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    rpicam = start_rpicam(args.width, args.height, args.fps, args.port)
    cap = None
    monitor = None
    try:
        cap = open_capture(args.port)
        monitor = IntakeMonitor(camera=Cv2Source(cap))

        deadline = time.time() + args.timeout
        step_idx = 0
        smoothed = 0.0
        timer_start = 0.0
        last_step = None
        frame_n = 0
        ok_frames = 0
        face_frames = 0

        print(f"[fsm ] starting (timeout {args.timeout}s) — pose into the camera. Steps: {' → '.join(_STEP_ORDER)}")

        while time.time() < deadline:
            frame = monitor._read_frame()  # type: ignore[attr-defined]
            if frame is None:
                time.sleep(0.02)
                continue
            frame_n += 1
            ok_frames += 1
            frame = cv2.flip(frame, 1)
            h, w = frame.shape[:2]
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            face_res = monitor._face_mesh.process(rgb)  # type: ignore[attr-defined]
            hand_res = monitor._hands.process(rgb)  # type: ignore[attr-defined]

            step = _STEP_ORDER[step_idx]
            if step != last_step:
                print(f"[step] → {step}")
                last_step = step

            if not face_res.multi_face_landmarks:
                timer_start = 0.0
                if frame_n % args.fps == 0:
                    print(f"[{frame_n:04d}] step={step} no_face")
                if frame_n % args.save_every == 0:
                    cv2.imwrite(str(out_dir / f"noface_{frame_n:05d}.jpg"), frame)
                continue

            face_frames += 1
            lms = face_res.multi_face_landmarks[0].landmark
            hand_lms = hand_res.multi_hand_landmarks
            n_hands = len(hand_lms) if hand_lms else 0

            raw = monitor._raw_confidence(step, frame, lms, hand_lms, w, h)  # type: ignore[attr-defined]
            smoothed = (1 - SMOOTHING_ALPHA) * smoothed + SMOOTHING_ALPHA * raw
            target = INSPECTION_HOLD_TIME if step == "STEP_4_MOUTH" else POSE_HOLD_TIME
            held = (time.time() - timer_start) if timer_start else 0.0

            if smoothed >= REQUIRED_CONFIDENCE:
                if step == "STEP_4_MOUTH" and monitor._pill_in_mouth(frame, lms, w, h):  # type: ignore[attr-defined]
                    timer_start = time.time()
                else:
                    if timer_start == 0.0:
                        timer_start = time.time()
                    if time.time() - timer_start >= target:
                        print(f"[step] ✓ {step} held {target}s — advancing")
                        timer_start = 0.0
                        smoothed = 0.0
                        step_idx += 1
                        if step_idx >= len(_STEP_ORDER):
                            print("[fsm ] SUCCESS — all 5 steps complete")
                            return 0
            else:
                timer_start = 0.0

            if frame_n % args.fps == 0:
                bar = "█" * int(smoothed * 20) + "·" * (20 - int(smoothed * 20))
                print(f"[{frame_n:04d}] step={step} raw={raw:.2f} smooth={smoothed:.2f} [{bar}] hands={n_hands} held={held:.1f}/{target}s")

            if frame_n % args.save_every == 0:
                annotated = frame.copy()
                cv2.putText(annotated, f"{step} smooth={smoothed:.2f} hands={n_hands}",
                            (10, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)
                cv2.imwrite(str(out_dir / f"frame_{frame_n:05d}.jpg"), annotated)

        print(f"[fsm ] TIMEOUT — reached step {_STEP_ORDER[step_idx]} after {frame_n} frames "
              f"(face seen in {face_frames}/{ok_frames})")
        return 1
    finally:
        if monitor is not None:
            monitor.close()
        if cap is not None:
            cap.release()
        if rpicam.poll() is None:
            rpicam.send_signal(signal.SIGINT)
            try:
                rpicam.wait(timeout=3)
            except subprocess.TimeoutExpired:
                rpicam.kill()
        print(f"[out ] {out_dir}")


if __name__ == "__main__":
    sys.exit(main())
