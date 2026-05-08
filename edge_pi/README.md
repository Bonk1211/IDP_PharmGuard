# PharmGuard Edge (Raspberry Pi)

## What this is

PharmGuard Edge runs on a Raspberry Pi 5 and orchestrates the physical dispensing workflow: face authentication, magazine rotation to the correct slot, pill ejection via servo, computer vision verification that the pill was taken, and telemetry POST back to the cloud backend. The Pi polls a backend endpoint for dispensing schedules and executes cycles autonomously.

## Hardware

Required:
- Raspberry Pi 5 (4GB RAM minimum; 8GB recommended)
- Raspberry Pi Camera Module 3 (CSI ribbon cable connection)
- Stepper motor (NEMA 17 or similar) with A4988 or DRV8825 driver for magazine rotation
- Servo motor (SG90 or equivalent) for the pill ejector slider-crank mechanism
- GPIO-connected relay or motor driver for hardware control

GPIO pin assignments (see `hardware/magazine.py` and `hardware/ejector.py` for details):
- Magazine stepper: STEP (GPIO 17), DIR (GPIO 27), ENABLE (GPIO 22)
- Ejector servo: PWM (GPIO 18)

## Prerequisites

- **OS**: Raspberry Pi OS Bookworm (64-bit) or later
- **Python**: 3.11 or higher
- **Camera**: Enable via `sudo raspi-config` → Interface → Camera, then reboot
- **libcamera stack**: Bookworm uses libcamera as the camera driver; picamera2 is the Python wrapper

Verify camera is detected:

```bash
libcamera-hello --list-cameras
```

## First-time Setup

### One-shot bootstrap (recommended)

From your dev machine:

```bash
make pi-bootstrap HOST=pi@pharmguard-01.local
```

This rsyncs `edge_pi/`, runs `scripts/install.sh` over ssh (idempotent), and enables the `pharmguard.service` systemd unit. Operator must have ssh-key-based auth to the Pi.

### Manual three-step path

If you'd rather see each step:

```bash
# 1. Sync from dev machine
make pi-sync HOST=pi@pharmguard-01.local

# 2. SSH in and install
ssh pi@pharmguard-01.local
cd ~/IDP_PharmGuard/edge_pi
bash scripts/install.sh

# 3. Enable + start the service (only after editing .env, see below)
sudo systemctl enable --now pharmguard
```

`install.sh` is idempotent. It:
1. Checks the OS + arch
2. Installs system dependencies (Python venv, libcamera bindings, FFmpeg, image libraries)
3. Creates a Python venv at `edge_pi/.venv`
4. Installs Python dependencies from `requirements.txt` via piwheels
5. `chmod +x` the bench / chaos / accuracy scripts (Phases 6, 8, 9)
6. Seeds `.env` from `.env.example` **only if missing** — operator config is preserved on re-runs
7. Creates `~/.pharmguard/` for the offline queue (Phase 8)
8. Refreshes the systemd unit only when its rendered template hash changes (no spurious `daemon-reload`)
9. Installs the `journald` rotation drop-in (system journal capped at 100 MB)

## Configuration

After install, edit `edge_pi/.env`:

```bash
nano ~/IDP_PharmGuard/edge_pi/.env
```

Required (the Pi `_require()` helper raises if either is empty):
- `BACKEND_URL` — backend base URL (must be `https://...` outside stub mode)
- `DEVICE_TOKEN` — 16+ char shared secret. Generate: `python3 -c 'import secrets; print(secrets.token_urlsafe(32))'`. Add the same token to the backend's `DEVICE_TOKENS` env on its side too.

Optional:
- `DISPENSER_ID` — per-Pi identifier (e.g. `dispenser-bedside-04`); reported on every adherence + alert event
- `POLL_INTERVAL_S` — schedule-poll cadence (default `30`)
- `PHARMGUARD_STUB` — set `1` for dev-without-hardware. Stub mode forces `pill_taken=False` always (HI-012). Refuse to deploy with `1` in production.
- `OFFLINE_QUEUE_PATH` — SQLite buffer path (default `~/.pharmguard/queue.db`)
- `OFFLINE_MAX_AGE_SECONDS` — refuse to dispense if oldest unposted row is older (default `3600` = 1 h)
- `OFFLINE_REPLAY_INTERVAL_S` — replay drain cadence (default `30`)
- `BENCH_MODE` — set `1` ONLY for `scripts/bench_e2e.py` runs. Mocks Face ID + swallow.
- `BENCH_LOG_PATH` — per-cycle CSV when bench mode active (default `/tmp/bench_e2e.csv`)

After editing `.env`, restart the service:

```bash
sudo systemctl restart pharmguard
```

The full env reference is in `.env.example`.

## Run

### Development

Run directly with Python:

```bash
python main.py
```

Logs appear on stdout. To enable debug logging, set `LOGLEVEL=DEBUG` (requires edits to `main.py`).

### Production

Enable and start the systemd service:

```bash
sudo systemctl enable --now pharmguard
```

Check status:

```bash
sudo systemctl status pharmguard
```

View logs:

```bash
journalctl -u pharmguard -f
```

Restart after code updates:

```bash
sudo systemctl restart pharmguard
```

## Pilot operator scripts

Bench + chaos + accuracy harnesses ship under `scripts/` (all `chmod +x` by `install.sh`):

- `scripts/bench_dual_cam.py` — Phase 2 dual-cam frame-interval bench (`p95 < 100 ms` per cam)
- `scripts/bench_e2e.py` — Phase 6 200-cycle end-to-end latency bench (`<200 ms` YOLO, `<500 ms` DB write, `<8 s` e2e)
- `scripts/chaos_offline.py` — Phase 8 network-outage chaos test (no falsified `pill_taken=true`; queue replays cleanly on recovery)
- `scripts/bench_accuracy.py` — Phase 9 confusion-matrix bench against an operator-supplied labelled dataset (`>99%` accuracy, `<0.1%` FPR)
- `scripts/tune_threshold.py` — Phase 9 threshold sweep for `PillVerifier.conf_thresh`

Each script's docstring documents its prerequisites + exit code semantics.

## What's NOT on the Pi

The Pi runs `edge_pi/` and its `models/` subdirectory only. Do NOT deploy:
- `backend/` (FastAPI server — runs on cloud or dev machine)
- `frontend/` (Next.js dashboard — runs in browser)
- `ml/` (model training pipelines — runs on GPU cluster)
- `scripts/` (top-level; for repo management, not Pi)

## Updating the Deployed Pi

After code changes on your dev machine, sync to the Pi:

```bash
./scripts/sync_from_dev.sh pi@pharmguard-01.local
```

Then restart the service on the Pi:

```bash
ssh pi@pharmguard-01.local sudo systemctl restart pharmguard
```

The sync script excludes `.venv`, `__pycache__`, and logs; model files in `models/` are included.

## Logs

View live logs:

```bash
journalctl -u pharmguard -f
```

View the last 50 lines:

```bash
journalctl -u pharmguard -n 50
```

## Troubleshooting

**Camera not detected**
- Ensure the ribbon cable is fully seated in the CSI port.
- Run `libcamera-hello --list-cameras` to verify the OS sees the camera.
- Check that Camera is enabled in `raspi-config`.

**GPIO permission denied**
- The systemd service runs as root (via `sudo systemctl start`). If running manually, prepend `sudo python main.py`.
- Ensure `RPi.GPIO` is installed in the venv: `pip list | grep RPi.GPIO`.

**mediapipe wheel installation fails on aarch64**
- Use piwheels: the install script includes `--extra-index-url https://www.piwheels.org/simple`.
- If a wheel is missing, build from source (slow) or check https://www.piwheels.org/ for availability.

**Model file not found (pill_detector.pt or spotter.pt)**
- Verify `edge_pi/models/` contains both model files.
- Ensure you ran `sync_from_dev.sh` or that the models directory is included in your clone.

**Backend unreachable**
- Check `BACKEND_URL` in `.env` or `main.py`. If running locally, ensure the backend service is running on the configured port.
- Test connectivity: `curl -v https://your-backend-url/health`.
- Check network from the Pi: `ping 8.8.8.8` and `nslookup your-backend-url`.
