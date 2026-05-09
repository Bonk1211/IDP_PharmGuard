#!/usr/bin/env python3
"""Live Pi-camera viewer with optional detection overlays.

Default: serves an MJPEG stream at http://<pi-ip>:<port>/ — open from any
browser on the LAN, no X server needed (works over SSH).

Pass --window for a local OpenCV window on the Pi's display instead.

Overlays (off by default; both can be combined):
  --spot       draw spotter.pt boxes  (production tray-empty model)
  --detect     draw pill_detector.pt boxes + class labels
"""
from __future__ import annotations

import argparse
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import cv2
from picamera2 import Picamera2

ROOT = Path(__file__).resolve().parents[1]
SPOT_DEFAULT = ROOT / "models" / "spotter.pt"
DETECT_DEFAULT = ROOT / "models" / "pill_detector.pt"


class FrameBus:
    """Latest-frame fan-out: producer overwrites, consumers read newest."""

    def __init__(self) -> None:
        self._cv = threading.Condition()
        self._jpg: bytes | None = None
        self._seq = 0
        self._stop = False

    def publish(self, jpg: bytes) -> None:
        with self._cv:
            self._jpg = jpg
            self._seq += 1
            self._cv.notify_all()

    def wait_next(self, last_seq: int, timeout: float = 2.0):
        with self._cv:
            if self._seq <= last_seq and not self._stop:
                self._cv.wait(timeout=timeout)
            return self._jpg, self._seq, self._stop

    def stop(self) -> None:
        with self._cv:
            self._stop = True
            self._cv.notify_all()


HTML_PAGE = (
    "<!doctype html>"
    "<html><head><title>PharmGuard Live</title>"
    "<style>body{margin:0;background:#111;color:#ddd;font-family:sans-serif;text-align:center}"
    "img{max-width:100vw;max-height:100vh;display:block;margin:0 auto}"
    ".bar{padding:6px;font-size:12px;opacity:.7}</style>"
    "</head><body>"
    "<div class=\"bar\">PharmGuard live &mdash; <span id=\"t\"></span></div>"
    "<img src=\"/stream.mjpg\" alt=\"live\"/>"
    "<script>setInterval(()=>{document.getElementById('t').textContent=new Date().toLocaleTimeString()},1000)</script>"
    "</body></html>"
).encode("utf-8")


def make_handler(bus: FrameBus):
    class MJPEGHandler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):  # quiet access log
            pass

        def do_GET(self):  # noqa: N802
            if self.path in ("/", "/index.html"):
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(HTML_PAGE)))
                self.end_headers()
                self.wfile.write(HTML_PAGE)
                return

            if self.path != "/stream.mjpg":
                self.send_error(404)
                return

            self.send_response(200)
            self.send_header("Cache-Control", "no-cache, private")
            self.send_header("Pragma", "no-cache")
            self.send_header(
                "Content-Type", "multipart/x-mixed-replace; boundary=FRAME"
            )
            self.end_headers()
            seq = 0
            try:
                while True:
                    jpg, seq, stopped = bus.wait_next(seq)
                    if stopped:
                        return
                    if jpg is None:
                        continue
                    self.wfile.write(b"--FRAME\r\n")
                    self.wfile.write(b"Content-Type: image/jpeg\r\n")
                    self.wfile.write(
                        f"Content-Length: {len(jpg)}\r\n\r\n".encode()
                    )
                    self.wfile.write(jpg)
                    self.wfile.write(b"\r\n")
            except (BrokenPipeError, ConnectionResetError):
                return

    return MJPEGHandler


def host_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def annotate(frame, model, conf, color, prefix):
    res = model(frame, verbose=False, conf=conf)[0]
    if res.boxes is None or len(res.boxes) == 0:
        return frame, 0
    n = 0
    for b in res.boxes:
        x1, y1, x2, y2 = b.xyxy.cpu().numpy().squeeze().astype(int)
        c = float(b.conf[0])
        cls_id = int(b.cls.item())
        name = model.names.get(cls_id, str(cls_id))
        cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
        cv2.putText(
            frame, f"{prefix}{name} {c:.2f}", (x1, max(0, y1 - 6)),
            cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2,
        )
        n += 1
    return frame, n


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--width", type=int, default=640)
    ap.add_argument("--height", type=int, default=480)
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--bind", default="0.0.0.0")
    ap.add_argument("--quality", type=int, default=80, help="JPEG quality 1-100")
    ap.add_argument("--spot", action="store_true", help="overlay spotter.pt")
    ap.add_argument("--detect", action="store_true",
                    help="overlay pill_detector.pt")
    ap.add_argument("--spot-model", default=str(SPOT_DEFAULT))
    ap.add_argument("--detect-model", default=str(DETECT_DEFAULT))
    ap.add_argument("--conf", type=float, default=0.5)
    ap.add_argument("--window", action="store_true",
                    help="show local OpenCV window instead of MJPEG server")
    ap.add_argument("--flip", action="store_true", help="horizontally flip frames")
    args = ap.parse_args()

    spot = detector = None
    if args.spot or args.detect:
        from ultralytics import YOLO
        if args.spot:
            print(f"[load] spotter: {args.spot_model}")
            spot = YOLO(args.spot_model, task="detect")
        if args.detect:
            print(f"[load] detector: {args.detect_model}")
            detector = YOLO(args.detect_model, task="detect")

    print(f"[camera] picamera2 {args.width}x{args.height}")
    cam = Picamera2()
    cam.configure(cam.create_video_configuration(
        main={"format": "RGB888", "size": (args.width, args.height)}
    ))
    cam.start()
    time.sleep(1.0)

    bus = FrameBus()
    server: ThreadingHTTPServer | None = None
    server_thread: threading.Thread | None = None
    if not args.window:
        server = ThreadingHTTPServer((args.bind, args.port), make_handler(bus))
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        ip = host_ip()
        print(f"[http] open  http://{ip}:{args.port}/  (or http://localhost:{args.port}/ on the Pi)")
        print("[http] Ctrl+C to stop")

    encode_params = [int(cv2.IMWRITE_JPEG_QUALITY), args.quality]
    last_log = time.time()
    frames = 0
    inf_ms_acc = 0.0
    inf_ct = 0
    try:
        while True:
            rgb = cam.capture_array()
            frame = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
            if args.flip:
                frame = cv2.flip(frame, 1)

            spot_n = det_n = 0
            if spot is not None or detector is not None:
                t0 = time.perf_counter()
                if spot is not None:
                    frame, spot_n = annotate(frame, spot, args.conf,
                                             (0, 255, 0), "")
                if detector is not None:
                    frame, det_n = annotate(frame, detector, args.conf,
                                            (0, 200, 255), "")
                inf_ms_acc += (time.perf_counter() - t0) * 1000.0
                inf_ct += 1

            frames += 1
            now = time.time()
            elapsed = now - last_log
            if elapsed >= 2.0:
                fps = frames / elapsed
                avg_inf = (inf_ms_acc / inf_ct) if inf_ct else 0.0
                print(f"[stat] {fps:5.1f} fps  inf={avg_inf:5.1f}ms  "
                      f"spot={spot_n} det={det_n}")
                frames = 0
                inf_ms_acc = 0.0
                inf_ct = 0
                last_log = now

            cv2.putText(
                frame, time.strftime("%H:%M:%S"), (8, 18),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1,
            )

            if args.window:
                cv2.imshow("PharmGuard live", frame)
                if cv2.waitKey(1) & 0xFF in (ord("q"), 27):
                    break
            else:
                ok, buf = cv2.imencode(".jpg", frame, encode_params)
                if ok:
                    bus.publish(buf.tobytes())
    except KeyboardInterrupt:
        print("\n[stop] interrupted")
    finally:
        bus.stop()
        if server is not None:
            server.shutdown()
            server.server_close()
        if args.window:
            cv2.destroyAllWindows()
        cam.stop()
        print("[stop] camera released")
    return 0


if __name__ == "__main__":
    sys.exit(main())
