"""Real-time YOLO → backend decrement demo.

Runs the trained pill_detector on a webcam (or single image) and, when a
class is seen confidently for several consecutive frames, POSTs to
``/api/inventory/dispense-by-name`` so the corresponding row in
``medications`` has its quantity decremented.

5 demo classes (must match `medications.name` exactly):
  Chloramine | Clarinase | Lomide_capsule | Paracetamol | Stadeltine

Run:
  python demo_dispense.py \\
      --model my_model.pt \\
      --source usb0 \\
      --backend-url http://localhost:8000 \\
      --device-token <DEVICE_TOKENS value> \\
      --dispenser-id dispenser-001

Tips:
  --thresh 0.6      raise to reduce false positives during demo
  --streak 5        require 5 consecutive frames before posting
  --cooldown 4.0    seconds before the same class can post again
  --dry-run         classify but don't POST (useful for tuning)
"""

import argparse
import sys
import time
from collections import deque

import cv2
import requests
from ultralytics import YOLO


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--model", required=True, help="Path to my_model.pt")
    p.add_argument(
        "--source",
        required=True,
        help='Image path, video path, "usb0" for USB cam, or "picamera0" for Pi camera',
    )
    p.add_argument("--thresh", type=float, default=0.6)
    p.add_argument("--streak", type=int, default=5,
                   help="Consecutive frames over threshold before posting")
    p.add_argument("--cooldown", type=float, default=4.0,
                   help="Seconds before the same class can re-post")
    p.add_argument("--backend-url", default="http://localhost:8000")
    p.add_argument("--device-token", default="",
                   help="Bearer token matching backend DEVICE_TOKENS")
    p.add_argument("--dispenser-id", default="dispenser-001")
    p.add_argument("--resolution", default="640x480")
    p.add_argument("--dry-run", action="store_true",
                   help="Classify but don't POST")
    return p.parse_args()


def open_source(src: str, w: int, h: int):
    """Return (cap_or_image, kind)."""
    if src.startswith("usb"):
        idx = int(src[3:])
        cap = cv2.VideoCapture(idx)
        cap.set(3, w)
        cap.set(4, h)
        return cap, "stream"
    if src.startswith("picamera"):
        from picamera2 import Picamera2  # type: ignore[import-not-found]
        cap = Picamera2()
        cap.configure(cap.create_video_configuration(
            main={"format": "RGB888", "size": (w, h)}
        ))
        cap.start()
        return cap, "picamera"
    if src.lower().endswith((".mp4", ".mov", ".avi", ".mkv")):
        return cv2.VideoCapture(src), "stream"
    return src, "image"


def read_frame(cap, kind: str):
    if kind == "image":
        return cv2.imread(cap)
    if kind == "picamera":
        return cap.capture_array()
    ok, frame = cap.read()
    return frame if ok else None


def post_decrement(args: argparse.Namespace, classname: str, conf: float) -> None:
    url = f"{args.backend_url.rstrip('/')}/api/inventory/dispense-by-name"
    headers = {}
    if args.device_token:
        headers["Authorization"] = f"Bearer {args.device_token}"
    payload = {
        "medication_name": classname,
        "dispenser_id": args.dispenser_id,
        "confidence": round(float(conf), 3),
    }
    if args.dry_run:
        print(f"[dry-run] POST {url} -> {payload}")
        return
    try:
        r = requests.post(url, json=payload, headers=headers, timeout=5)
        if r.ok:
            data = r.json()
            print(
                f"[ok] {classname}  slot={data.get('slot')}  "
                f"qty {data.get('previous_quantity')} -> {data.get('quantity')}  "
                f"conf={conf:.2f}"
            )
        elif r.status_code == 404:
            print(f"[404] '{classname}' not loaded in any slot")
        elif r.status_code == 409:
            print(f"[409] {classname} slot already empty")
        else:
            print(f"[{r.status_code}] {r.text[:200]}")
    except requests.RequestException as exc:
        print(f"[net-error] {exc}")


def main() -> int:
    args = parse_args()
    w, h = (int(x) for x in args.resolution.split("x"))

    print(f"Loading model from {args.model}…")
    model = YOLO(args.model, task="detect")
    labels = model.names
    print(f"Classes: {labels}")

    cap, kind = open_source(args.source, w, h)

    streak: dict[str, int] = {}     # classname -> consecutive frame count
    last_post: dict[str, float] = {}  # classname -> epoch seconds
    history: deque[float] = deque(maxlen=200)

    while True:
        t0 = time.perf_counter()
        frame = read_frame(cap, kind)
        if frame is None:
            print("End of source.")
            break

        if frame.shape[1] != w or frame.shape[0] != h:
            frame = cv2.resize(frame, (w, h))

        results = model(frame, verbose=False)
        detections = results[0].boxes

        # Best detection per class this frame.
        best_per_class: dict[str, float] = {}
        for det in detections:
            cls_idx = int(det.cls.item())
            conf = float(det.conf.item())
            name = labels[cls_idx]
            if conf >= args.thresh and conf > best_per_class.get(name, 0.0):
                best_per_class[name] = conf

        # Streak bookkeeping — every class not seen this frame resets.
        seen = set(best_per_class)
        for c in list(streak):
            if c not in seen:
                streak[c] = 0

        now = time.time()
        for name, conf in best_per_class.items():
            streak[name] = streak.get(name, 0) + 1
            if streak[name] == args.streak:
                last = last_post.get(name, 0.0)
                if now - last >= args.cooldown:
                    post_decrement(args, name, conf)
                    last_post[name] = now
                else:
                    print(f"[cooldown] {name} ({args.cooldown - (now - last):.1f}s left)")

        # Render annotated frame for the operator.
        annotated = results[0].plot() if len(detections) else frame
        dt = time.perf_counter() - t0
        history.append(1.0 / dt if dt > 0 else 0.0)
        fps = sum(history) / len(history)
        cv2.putText(
            annotated, f"FPS {fps:.1f}", (10, 22),
            cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2,
        )
        cv2.imshow("pill_detector demo", annotated)

        if kind == "image":
            cv2.waitKey()
            break
        key = cv2.waitKey(5) & 0xFF
        if key in (ord("q"), ord("Q")):
            break

    if hasattr(cap, "release"):
        cap.release()
    elif kind == "picamera":
        cap.stop()
    cv2.destroyAllWindows()
    return 0


if __name__ == "__main__":
    sys.exit(main())
