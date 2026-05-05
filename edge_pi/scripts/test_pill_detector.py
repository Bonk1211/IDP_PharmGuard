#!/usr/bin/env python3
"""Headless smoke test: capture frames from Pi camera, run pill_detector.pt, save annotated frames."""
import argparse
import sys
import time
from pathlib import Path

import cv2
import numpy as np
from picamera2 import Picamera2
from ultralytics import YOLO


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=str(Path(__file__).resolve().parents[1] / "models" / "pill_detector.pt"))
    ap.add_argument("--frames", type=int, default=10)
    ap.add_argument("--width", type=int, default=640)
    ap.add_argument("--height", type=int, default=480)
    ap.add_argument("--thresh", type=float, default=0.25)
    ap.add_argument("--out", default="/tmp/pill_detector_out")
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"[load] {args.model}")
    model = YOLO(args.model, task="detect")
    print(f"[classes] {model.names}")

    print(f"[camera] starting picamera2 at {args.width}x{args.height}")
    cam = Picamera2()
    cam.configure(cam.create_video_configuration(main={"format": "RGB888", "size": (args.width, args.height)}))
    cam.start()
    time.sleep(1.0)

    fps_buf = []
    try:
        for i in range(args.frames):
            t0 = time.perf_counter()
            frame_rgb = cam.capture_array()
            frame_bgr = cv2.cvtColor(frame_rgb, cv2.COLOR_RGB2BGR)

            results = model(frame_bgr, verbose=False, conf=args.thresh)
            r = results[0]

            n = len(r.boxes) if r.boxes is not None else 0
            cls_counts = {}
            if n:
                for b in r.boxes:
                    name = model.names[int(b.cls.item())]
                    conf = b.conf.item()
                    cls_counts[name] = cls_counts.get(name, 0) + 1
                    if i == 0:
                        x1, y1, x2, y2 = b.xyxy.cpu().numpy().squeeze().astype(int)
                        print(f"   - {name}: {conf:.2f}  bbox=({x1},{y1},{x2},{y2})")

            annotated = r.plot()
            out_path = out_dir / f"frame_{i:02d}.jpg"
            cv2.imwrite(str(out_path), annotated)

            dt = time.perf_counter() - t0
            fps_buf.append(1.0 / dt if dt > 0 else 0.0)
            print(f"[{i+1:02d}/{args.frames}] {dt*1000:5.1f}ms  detections={n}  {cls_counts}")

        avg_fps = float(np.mean(fps_buf)) if fps_buf else 0.0
        print(f"\n[avg] {avg_fps:.2f} fps  ({(1000/avg_fps if avg_fps else 0):.1f} ms/frame)")
        print(f"[out] {out_dir}")
    finally:
        cam.stop()


if __name__ == "__main__":
    sys.exit(main() or 0)
