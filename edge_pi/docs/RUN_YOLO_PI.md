# Run YOLO Live on Brand-New Raspberry Pi 5

End-to-end guide. Bare Pi 5 → camera preview with YOLO overlays in browser.

Model: `edge_pi/models/pill_detector.pt` — pill class detector.

Live tool: `edge_pi/scripts/live_camera.py`. Streams MJPEG to LAN, no X server needed.

---

## 1. Hardware checklist

- Raspberry Pi 5 (4GB or 8GB).
- Pi Camera Module (v2 / v3 / HQ) on **CAM1** ribbon, lock latch.
- 32GB+ A2 microSD or NVMe.
- 5V/5A USB-C PSU (Pi 5 throttles on weaker supplies).
- Ethernet or known Wi-Fi.
- Active cooling fan recommended — YOLO sustained = warm SoC.

---

## 2. Flash OS

Raspberry Pi Imager → **Raspberry Pi OS (64-bit) Bookworm**, **NOT** Lite if you want the desktop. Lite is fine — we stream to browser.

In Imager → gear icon:
- Hostname: `pharmguard-pi` (or any).
- Enable SSH, set password or paste public key.
- Set Wi-Fi SSID + country.
- Set locale + timezone.

Eject. Boot Pi. Wait ~60s. SSH in:
```bash
ssh pi@pharmguard-pi.local
```

---

## 3. First-boot sanity

```bash
sudo apt-get update && sudo apt-get upgrade -y
sudo reboot
```

After reboot, verify camera:
```bash
rpicam-hello --timeout 2000 --nopreview
# expect: "Made X buffers" lines, no error.
libcamera-hello --list-cameras  # alt name on older firmware
```

If "no cameras available": ribbon flipped, or `Camera` not enabled in `sudo raspi-config` → Interface → Camera. Reboot.

Check arch + python:
```bash
uname -m       # aarch64
python3 -V     # 3.11+
```

---

## 4. Get repo onto Pi

Two options.

### A. From your Mac (rsync, recommended for dev)
On Mac:
```bash
make pi-sync HOST=pi@pharmguard-pi.local
```
Pushes `edge_pi/` only, excluding `.venv` and `__pycache__`.

### B. Directly on Pi (git)
```bash
sudo apt-get install -y git
git clone https://github.com/<you>/IDP_PharmGuard.git ~/IDP_PharmGuard
```
Models are tracked in git (`edge_pi/models/*.pt` ~37MB) — clone gets them.

Verify on Pi:
```bash
ls -lh ~/IDP_PharmGuard/edge_pi/models/pill_detector.pt
```

---

## 5. Install deps

One-shot installer handles apt + venv + pip + systemd:
```bash
cd ~/IDP_PharmGuard/edge_pi
bash scripts/install.sh
```

Installs:
- `python3-libcamera`, `python3-picamera2` (apt — required, can't pip).
- venv at `edge_pi/.venv`.
- `requirements.txt` via piwheels mirror (precompiled aarch64 wheels = fast).
- systemd unit `pharmguard.service` (don't auto-start yet for live test).

Cold install ≈ 5–10 min. ultralytics + torch are big.

If install.sh chokes: re-run. apt + pip both idempotent.

---

## 6. Wire env (skip for camera-only test)

Live YOLO viewer needs **no backend, no token, no Supabase**. Camera + models only.

For full `main.py` flow later: copy `.env.example` → `.env`, fill `BACKEND_URL` + `DEVICE_TOKEN`. Not required for live preview.

---

## 7. Run live YOLO

Activate venv:
```bash
cd ~/IDP_PharmGuard/edge_pi
source .venv/bin/activate
```

Pill detector overlay:
```bash
python scripts/live_camera.py --detect
```

Output:
```
[load] detector: .../models/pill_detector.pt
[camera] picamera2 640x480
[http] open  http://192.168.x.y:8080/
[stat] 14.2 fps  inf=42.1ms  spot=0 det=2
```

Open `http://<pi-ip>:8080/` in any browser on same LAN. Live MJPEG with boxes + class labels.

---

## 8. Useful flags

| Flag | Purpose | Default |
|------|---------|---------|
| `--width N --height N` | capture size — bigger = slower, more accurate | 640x480 |
| `--conf 0.3` | detection confidence threshold | 0.5 |
| `--quality 60` | JPEG quality, lower = less LAN bandwidth | 80 |
| `--port 8080` | MJPEG port | 8080 |
| `--flip` | mirror horizontally (selfie-style) | off |
| `--window` | local OpenCV window on Pi display (needs HDMI + desktop) | off |
| `--detect-model PATH` | custom weights | `models/pill_detector.pt` |

Stop: `Ctrl+C`.

---

## 9. Performance tuning

Pi 5 + ultralytics CPU inference baseline:
- 640×480: **~12–18 fps**.
- 1280×720: drops ~half.

Speed-ups:

1. **Lower res first** — `--width 480 --height 360` often doubles fps.
2. **Higher conf** — `--conf 0.6` skips drawing low-confidence boxes (minor).
3. **Export NCNN** — biggest win on Pi 5:
   ```bash
   yolo export model=models/pill_detector.pt format=ncnn
   # produces models/pill_detector_ncnn_model/
   ```
   Then point `--detect-model` at the exported dir. Often **2–3× faster** than `.pt` on Pi.
4. **Active cooling** — without fan, SoC throttles after ~2 min sustained. Fps drops silently.

Watch thermal:
```bash
vcgencmd measure_temp     # want <80C
```

---

## 10. Troubleshooting

**`No module named 'picamera2'`** — installed via apt, but venv hides it. Re-create venv with system packages:
```bash
python3 -m venv --system-site-packages .venv
source .venv/bin/activate
pip install -r requirements.txt --extra-index-url https://www.piwheels.org/simple
```
The shipped `install.sh` already does the right thing on a fresh box; this fix is for hand-rolled venvs.

**`No cameras available`** — `sudo raspi-config` → Interface Options → Camera → enable. Reboot. Re-seat ribbon (blue tab toward Ethernet).

**Browser shows blank / spinning** — firewall blocking 8080. Test from Pi itself:
```bash
curl -I http://localhost:8080/
```
If 200, it's a network ACL, not the script.

**`torch` install hangs / OOM** — out of swap. Add 2GB:
```bash
sudo dphys-swapfile swapoff
sudo sed -i 's/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=2048/' /etc/dphys-swapfile
sudo dphys-swapfile setup && sudo dphys-swapfile swapon
```

**Low fps + warm chip** — throttling. Check `vcgencmd get_throttled` — non-zero = under-voltage or thermal. Get a real 5A PSU + fan.

**Black frames in browser** — picamera2 races with another consumer. Make sure no other process holds `/dev/video0`:
```bash
sudo lsof /dev/video0
```

---

## 11. Run as background service (optional)

`live_camera.py` is foreground only. Keep it running over SSH disconnect:
```bash
sudo apt-get install -y tmux
tmux new -s yolo
# inside tmux:
source ~/IDP_PharmGuard/edge_pi/.venv/bin/activate
python ~/IDP_PharmGuard/edge_pi/scripts/live_camera.py --detect
# detach: Ctrl+B then D
# reattach: tmux attach -t yolo
```

The systemd `pharmguard.service` runs `main.py` (full dispense loop), **not** `live_camera.py`. Don't enable that service unless backend + hardware wired up.

---

## 12. Promote new weights

Re-trained on Mac:
```bash
cp ml/pill_detector/my_model.pt       edge_pi/models/pill_detector.pt
git add edge_pi/models/pill_detector.pt && git commit -m "weights: <run id>"
make pi-sync HOST=pi@pharmguard-pi.local
```
On Pi: re-run `live_camera.py`. ultralytics reloads weights on each invocation.
