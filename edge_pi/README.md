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

Clone the repository or rsync the `edge_pi/` directory from your dev machine:

```bash
# Option A: Git clone
git clone https://github.com/your-org/IDP_PharmGuard.git
cd IDP_PharmGuard/edge_pi

# Option B: rsync from dev machine (see scripts/sync_from_dev.sh)
./scripts/sync_from_dev.sh pi@pharmguard-01.local
```

Then run the install script:

```bash
bash scripts/install.sh
```

This script will:
1. Check that you are on Raspberry Pi OS (64-bit)
2. Install system dependencies: Python venv, pip, libcamera bindings, FFmpeg, image libraries
3. Create a Python virtual environment at `edge_pi/.venv`
4. Install Python dependencies from `requirements.txt` (including piwheels for ARM wheels)
5. Install the systemd service unit at `/etc/systemd/system/pharmguard.service`
6. Print instructions to enable and start the service

You may need to `chmod +x scripts/*.sh` if the scripts are not executable.

## Configuration

Create a `.env` file in the `edge_pi/` directory to override defaults:

```bash
cat > .env << EOF
BACKEND_URL=https://cloud.pharmguard.example.com
DEVICE_ID=pi-01
POLL_INTERVAL_S=30
EOF
```

Currently, `main.py` hardcodes `BACKEND_URL=http://localhost:8000`. Update the `.env` entries or edit `main.py` to point to your cloud backend.

Environment variables:
- `BACKEND_URL`: Base URL of the backend API (default: `http://localhost:8000`)
- `DEVICE_ID`: Unique identifier for this Pi (optional; can be used for telemetry)
- `POLL_INTERVAL_S`: Seconds between dispensing schedule polls (default: 30)

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
