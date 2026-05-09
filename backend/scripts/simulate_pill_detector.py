#!/usr/bin/env python3
"""Live Pi-camera simulation of the dispenser's pill-detection pipeline.

Mirrors the production PillVerifier behaviour (spotter.pt + EMPTY_FRAME_STREAK)
so the operator can rehearse real cases on the bench:

  1) EMPTY   — tray clear; verifier should confirm-empty almost immediately.
  2) LOADED  — pill in tray; verifier should NOT confirm empty before timeout.
  3) PICKUP  — start with pill, remove it during the window; verifier should
               flip to empty after EMPTY_FRAME_STREAK consecutive clean frames.
  4) WATCH   — free-running feed; optionally classifies the visible pill with
               pill_detector.pt to sanity-check pill identity.

Annotated frames are written to /tmp/pill_sim/<scenario>/.
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import cv2
from picamera2 import Picamera2
from ultralytics import YOLO

ROOT = Path(__file__).resolve().parents[1]
SPOTTER_DEFAULT = ROOT / "models" / "spotter.pt"
DETECTOR_DEFAULT = ROOT / "models" / "pill_detector.pt"

# Mirrors edge_pi/vision/pill_verifier.py
EMPTY_FRAME_STREAK = 3


def open_camera(width: int, height: int) -> Picamera2:
    cam = Picamera2()
    cam.configure(cam.create_video_configuration(
        main={"format": "RGB888", "size": (width, height)}
    ))
    cam.start()
    time.sleep(1.0)
    return cam


def grab_bgr(cam: Picamera2):
    rgb = cam.capture_array()
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)


def detect(model: YOLO, frame, conf_thresh: float):
    """Return (n_boxes, top_conf, ultralytics_result)."""
    res = model(frame, verbose=False, conf=conf_thresh)
    r = res[0]
    if r.boxes is None or len(r.boxes) == 0:
        return 0, 0.0, r
    confs = [float(b.conf[0]) for b in r.boxes]
    return len(r.boxes), max(confs), r


def classify_top(detector: YOLO | None, frame, conf_thresh: float):
    if detector is None:
        return None
    res = detector(frame, verbose=False, conf=conf_thresh)
    r = res[0]
    if r.boxes is None or len(r.boxes) == 0:
        return None
    top = max(r.boxes, key=lambda b: float(b.conf[0]))
    return detector.names[int(top.cls.item())], float(top.conf[0])


def run_scenario(
    key: str,
    title: str,
    prompt: str,
    duration_s: float,
    cam: Picamera2,
    spotter: YOLO,
    detector: YOLO | None,
    conf: float,
    fps_hint: int,
    out_root: Path,
) -> dict:
    print()
    print(f"=== {title} ===")
    print(f"setup: {prompt}")
    input("press ENTER when ready (Ctrl+C to abort)... ")

    out_dir = out_root / key
    out_dir.mkdir(parents=True, exist_ok=True)

    save_every = max(1, fps_hint // 2)
    log_every = max(1, fps_hint)

    start = time.time()
    deadline = start + duration_s
    frame_n = 0
    pill_frames = 0
    empty_streak = 0
    saw_pill = False
    confirmed_empty_at: float | None = None

    while time.time() < deadline:
        frame = grab_bgr(cam)
        n, top_conf, r = detect(spotter, frame, conf)
        frame_n += 1

        if n > 0:
            pill_frames += 1
            empty_streak = 0
            saw_pill = True
        else:
            empty_streak += 1
            if confirmed_empty_at is None and empty_streak >= EMPTY_FRAME_STREAK:
                confirmed_empty_at = time.time() - start
                print(f"  ✓ confirm_tray_empty would return TRUE "
                      f"at frame {frame_n} (t={confirmed_empty_at:.2f}s)")

        cls = classify_top(detector, frame, conf) if n > 0 else None

        if frame_n % save_every == 0:
            annotated = r.plot()
            label = f"n={n} top={top_conf:.2f} streak={empty_streak}"
            if cls:
                label += f" | {cls[0]} {cls[1]:.2f}"
            cv2.putText(annotated, label, (10, 25),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)
            cv2.imwrite(str(out_dir / f"f{frame_n:04d}.jpg"), annotated)

        if frame_n % log_every == 0:
            cls_str = f"  cls={cls[0]}@{cls[1]:.2f}" if cls else ""
            print(f"  [{frame_n:04d}] dets={n} top={top_conf:.2f} "
                  f"streak={empty_streak}{cls_str}")

    elapsed = time.time() - start
    pct = 100.0 * pill_frames / frame_n if frame_n else 0.0
    if confirmed_empty_at is None:
        verdict = "NO empty-streak (verifier would TIMEOUT)"
    elif saw_pill:
        verdict = f"transition empty @ t={confirmed_empty_at:.2f}s after pill seen"
    else:
        verdict = f"empty confirmed @ t={confirmed_empty_at:.2f}s"

    print(f"  summary: {frame_n} frames in {elapsed:.1f}s "
          f"({frame_n/elapsed:.1f} fps); pill in {pill_frames}/{frame_n} "
          f"({pct:.1f}%); {verdict}")

    return {
        "key": key,
        "frames": frame_n,
        "pill_frames": pill_frames,
        "saw_pill": saw_pill,
        "confirmed_empty_at": confirmed_empty_at,
    }


SCENARIOS = {
    "empty":  ("EMPTY",  "leave the tray completely empty.",                                 1.0),
    "loaded": ("LOADED", "place ONE pill in the tray and keep it there.",                    1.0),
    "pickup": ("PICKUP", "start with a pill in tray; remove it during the window.",          1.5),
    "watch":  ("WATCH",  "free-form — vary lighting, angle, occlusion, multiple pills.",      2.0),
}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--spotter", default=str(SPOTTER_DEFAULT))
    ap.add_argument("--detector", default=str(DETECTOR_DEFAULT),
                    help="pill classifier; pass '' to skip identity overlay")
    ap.add_argument("--width", type=int, default=640)
    ap.add_argument("--height", type=int, default=480)
    ap.add_argument("--conf", type=float, default=0.5,
                    help="matches PillVerifier default (0.5)")
    ap.add_argument("--fps-hint", type=int, default=10,
                    help="logging cadence; not a capture limit")
    ap.add_argument("--duration", type=float, default=8.0,
                    help="base seconds per scenario (some scale this)")
    ap.add_argument("--scenarios", default="empty,loaded,pickup,watch",
                    help="comma-separated subset to run")
    ap.add_argument("--out", default="/tmp/pill_sim")
    args = ap.parse_args()

    out_root = Path(args.out)
    out_root.mkdir(parents=True, exist_ok=True)

    print(f"[load] spotter: {args.spotter}")
    spotter = YOLO(args.spotter, task="detect")
    print(f"  classes: {spotter.names}")

    detector: YOLO | None = None
    if args.detector:
        print(f"[load] detector: {args.detector}")
        detector = YOLO(args.detector, task="detect")
        print(f"  classes: {detector.names}")

    print(f"[camera] picamera2 {args.width}x{args.height}")
    cam = open_camera(args.width, args.height)

    requested = [s.strip() for s in args.scenarios.split(",") if s.strip()]
    results: list[dict] = []
    try:
        for key in requested:
            if key not in SCENARIOS:
                print(f"[warn] unknown scenario {key!r}, skipping")
                continue
            title, prompt, scale = SCENARIOS[key]
            results.append(run_scenario(
                key, title, prompt, args.duration * scale,
                cam, spotter, detector, args.conf, args.fps_hint, out_root,
            ))
    finally:
        cam.stop()

    print()
    print("=== summary ===")
    expected = {
        "empty":  "confirm_empty=YES, no pill seen",
        "loaded": "confirm_empty=NO  (timeout), pill seen throughout",
        "pickup": "confirm_empty=YES after pill removed",
        "watch":  "free-form",
    }
    for r in results:
        ce = r["confirmed_empty_at"]
        ce_str = f"empty@{ce:.2f}s" if ce is not None else "no-empty-streak"
        print(f"  {r['key']:7s} → frames={r['frames']:4d} pill_seen={r['saw_pill']!s:5s} "
              f"{ce_str}    expected: {expected.get(r['key'], '-')}")
    print(f"[out ] {out_root}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
