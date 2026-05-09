#!/usr/bin/env bash
set -euo pipefail

##
## PharmGuard Edge — Raspberry Pi one-shot setup script.
##
## Idempotent: re-running on a configured Pi is safe.
##   - .env is seeded from .env.example only when missing (operator config preserved)
##   - systemd unit is refreshed only when the rendered template hash changes
##   - journald drop-in is refreshed only when its content differs
##   - apt + pip steps are idempotent by construction
##
## Installs system dependencies, creates a Python venv, installs pip packages,
## seeds .env, registers the systemd service unit, installs the journald
## rotation drop-in, and creates the offline-queue directory (Phase 8).
##

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
INSTALL_DIR="$REPO_ROOT/backend"
VENV_PATH="$INSTALL_DIR/.venv"
CURRENT_USER="${SUDO_USER:-$(whoami)}"

# Allow overriding the Python used for the venv. Default: system `python3`.
# Trixie ships Python 3.13 by default but mediapipe has no cp313 wheel
# (supported up to cp312). On Trixie, install Python 3.12 via apt or
# pyenv and run with PHARMGUARD_PYTHON=python3.12 (or pyenv-shimmed path).
PHARMGUARD_PYTHON="${PHARMGUARD_PYTHON:-python3}"

echo "=== PharmGuard Edge Setup ==="
echo "Install directory: $INSTALL_DIR"
echo "Virtual environment: $VENV_PATH"
echo "Python: $PHARMGUARD_PYTHON ($($PHARMGUARD_PYTHON --version 2>&1 || echo not-found))"
echo "User: $CURRENT_USER"
echo ""

# Refuse to build a venv with cp313 because mediapipe (Phase 2 + 3) has
# no cp313 wheel as of 2026-05. The error from `pip install` is opaque;
# fail loud here with a fix hint.
PY_VER="$($PHARMGUARD_PYTHON -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || echo unknown)"
if [[ "$PY_VER" == "3.13" || "$PY_VER" == "3.14" ]]; then
    echo "ERROR: Python $PY_VER detected — mediapipe has no wheel for this version."
    echo "       Install Python 3.11 or 3.12 alongside, then re-run with:"
    echo "         PHARMGUARD_PYTHON=python3.12 bash scripts/install.sh"
    echo "       See edge_pi/README.md for the apt + pyenv recipes."
    exit 5
fi

##
## Check OS and architecture
##
if [[ ! -f /etc/os-release ]]; then
    echo "WARNING: Could not detect OS. Assuming Raspberry Pi OS Bookworm."
else
    OS_NAME=$(grep "^NAME=" /etc/os-release | cut -d'"' -f2)
    echo "Detected OS: $OS_NAME"
fi

ARCH=$(uname -m)
if [[ "$ARCH" != "aarch64" ]]; then
    echo "WARNING: Expected aarch64, got $ARCH. Continuing anyway."
fi
echo ""

##
## Update package lists and install system dependencies
##
echo "Updating package lists..."
sudo apt-get update

echo "Installing system dependencies..."
# Trixie note: libatlas-base-dev was removed (ATLAS deprecated upstream;
# numpy uses OpenBLAS via wheels). libtiff / libopenjp2 are no longer
# required either — piwheels ships Pillow with vendored image libs.
# libcap-dev is needed by python-prctl (transitive dep of picamera2)
# when pip builds it from source against an alt-Python venv (cp312 on
# Trixie via PHARMGUARD_PYTHON). On Bookworm cp311 the wheel exists.
sudo apt-get install -y \
    python3-venv \
    python3-pip \
    python3-dev \
    libcap-dev \
    ffmpeg \
    python3-libcamera \
    python3-picamera2

echo "System dependencies installed."
echo ""

##
## Create and activate Python venv
##
echo "Setting up Python virtual environment..."
if [[ ! -d "$VENV_PATH" ]]; then
    "$PHARMGUARD_PYTHON" -m venv "$VENV_PATH"
    echo "Created venv at $VENV_PATH (using $PHARMGUARD_PYTHON)"
else
    echo "Venv already exists at $VENV_PATH"
fi

# Activate venv in this script's context
# shellcheck disable=SC1091
source "$VENV_PATH/bin/activate"

echo "Upgrading pip..."
pip install --upgrade pip

echo "Installing Python dependencies..."
if [[ -f "$INSTALL_DIR/requirements.txt" ]]; then
    pip install -r "$INSTALL_DIR/requirements.txt" \
        --extra-index-url https://www.piwheels.org/simple
    echo "Python dependencies installed from requirements.txt"
else
    echo "ERROR: requirements.txt not found at $INSTALL_DIR/requirements.txt"
    exit 1
fi
echo ""

##
## Make CLI scripts executable (Phases 6, 8, 9 added new ones)
##
echo "Making scripts executable..."
for script in bench_dual_cam.py bench_e2e.py bench_accuracy.py tune_threshold.py chaos_offline.py; do
    if [[ -f "$INSTALL_DIR/scripts/$script" ]]; then
        chmod +x "$INSTALL_DIR/scripts/$script"
    fi
done
echo ""

##
## Seed .env from .env.example (idempotent — never overwrites existing .env)
##
ENV_FILE="$INSTALL_DIR/.env"
ENV_EXAMPLE="$INSTALL_DIR/.env.example"
if [[ ! -f "$ENV_FILE" ]]; then
    if [[ -f "$ENV_EXAMPLE" ]]; then
        cp "$ENV_EXAMPLE" "$ENV_FILE"
        echo "Seeded $ENV_FILE from .env.example"
        echo "  EDIT $ENV_FILE BEFORE STARTING THE SERVICE."
    else
        echo "WARNING: $ENV_EXAMPLE missing — cannot seed .env"
    fi
else
    echo "Existing $ENV_FILE preserved (not overwritten)"
fi
echo ""

##
## Phase 8: ensure offline-queue directory exists with right ownership
##
QUEUE_DIR="/home/$CURRENT_USER/.pharmguard"
if [[ ! -d "$QUEUE_DIR" ]]; then
    mkdir -p "$QUEUE_DIR"
    chown "$CURRENT_USER:$CURRENT_USER" "$QUEUE_DIR" 2>/dev/null || true
    echo "Created $QUEUE_DIR for offline queue"
else
    echo "Queue directory already exists at $QUEUE_DIR"
fi
echo ""

##
## Install or refresh systemd service (only if template changed)
##
SERVICE_FILE="/etc/systemd/system/pharmguard.service"

# Read the service template and substitute placeholders
SERVICE_CONTENT=$(cat "$INSTALL_DIR/scripts/pharmguard.service")
SERVICE_CONTENT="${SERVICE_CONTENT//__INSTALL_DIR__/$INSTALL_DIR}"
SERVICE_CONTENT="${SERVICE_CONTENT//__USER__/$CURRENT_USER}"

NEW_HASH=$(echo "$SERVICE_CONTENT" | sha256sum | cut -d' ' -f1)
OLD_HASH=""
if [[ -f "$SERVICE_FILE" ]]; then
    OLD_HASH=$(sudo sha256sum "$SERVICE_FILE" | cut -d' ' -f1)
fi

if [[ "$NEW_HASH" != "$OLD_HASH" ]]; then
    echo "$SERVICE_CONTENT" | sudo tee "$SERVICE_FILE" > /dev/null
    sudo chmod 644 "$SERVICE_FILE"
    sudo systemctl daemon-reload
    echo "systemd unit refreshed at $SERVICE_FILE"
else
    echo "systemd unit unchanged ($SERVICE_FILE) — skipping daemon-reload"
fi
echo ""

##
## Install or refresh ngrok systemd service (only if template changed).
## ngrok itself must already be on the PATH (`apt install -y ngrok` after
## adding the ngrok apt repo, or download the static binary). Authtoken
## must be configured separately:
##     ngrok config add-authtoken <YOUR_TOKEN>
##
NGROK_SERVICE_FILE="/etc/systemd/system/ngrok.service"
NGROK_SERVICE_SRC="$INSTALL_DIR/scripts/ngrok.service"
if [[ -f "$NGROK_SERVICE_SRC" ]]; then
    if ! command -v ngrok >/dev/null 2>&1; then
        echo "WARNING: ngrok binary not on PATH — skipping ngrok.service install."
        echo "         Install ngrok then re-run this script:"
        echo "           https://ngrok.com/docs/agent/linux/"
    else
        NGROK_CONTENT=$(cat "$NGROK_SERVICE_SRC")
        NGROK_CONTENT="${NGROK_CONTENT//__INSTALL_DIR__/$INSTALL_DIR}"
        NGROK_CONTENT="${NGROK_CONTENT//__USER__/$CURRENT_USER}"
        NGROK_NEW_HASH=$(echo "$NGROK_CONTENT" | sha256sum | cut -d' ' -f1)
        NGROK_OLD_HASH=""
        if [[ -f "$NGROK_SERVICE_FILE" ]]; then
            NGROK_OLD_HASH=$(sudo sha256sum "$NGROK_SERVICE_FILE" | cut -d' ' -f1)
        fi
        if [[ "$NGROK_NEW_HASH" != "$NGROK_OLD_HASH" ]]; then
            echo "$NGROK_CONTENT" | sudo tee "$NGROK_SERVICE_FILE" > /dev/null
            sudo chmod 644 "$NGROK_SERVICE_FILE"
            sudo systemctl daemon-reload
            echo "ngrok unit refreshed at $NGROK_SERVICE_FILE"
        else
            echo "ngrok unit unchanged ($NGROK_SERVICE_FILE) — skipping daemon-reload"
        fi
        # Auth token must be configured at least once before the unit can run.
        if ! sudo -u "$CURRENT_USER" ngrok config check >/dev/null 2>&1; then
            echo ""
            echo "NOTE: ngrok authtoken not configured for user '$CURRENT_USER'."
            echo "      Run (as that user):  ngrok config add-authtoken <YOUR_TOKEN>"
            echo "      Then:                 sudo systemctl enable --now ngrok"
        fi
    fi
fi
echo ""

##
## Install journald rotation drop-in (caps system journal at 100 MB)
##
JOURNALD_DROPIN="/etc/systemd/journald.conf.d/pharmguard.conf"
JOURNALD_SRC="$INSTALL_DIR/scripts/journald.conf.d-pharmguard.conf"
if [[ -f "$JOURNALD_SRC" ]]; then
    sudo mkdir -p /etc/systemd/journald.conf.d
    if ! sudo cmp -s "$JOURNALD_SRC" "$JOURNALD_DROPIN" 2>/dev/null; then
        sudo cp "$JOURNALD_SRC" "$JOURNALD_DROPIN"
        sudo chmod 644 "$JOURNALD_DROPIN"
        sudo systemctl restart systemd-journald
        echo "journald drop-in installed at $JOURNALD_DROPIN (system-wide log cap = 100 MB)"
    else
        echo "journald drop-in unchanged"
    fi
else
    echo "WARNING: $JOURNALD_SRC missing — skipping journald drop-in"
fi
echo ""

##
## Final instructions
##
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. Edit $ENV_FILE with your real configuration:"
echo "       BACKEND_URL=https://your-backend-url"
echo "       DEVICE_TOKEN=<32+ chars from \`python3 -c 'import secrets;print(secrets.token_urlsafe(32))'\`>"
echo "       DISPENSER_ID=<unique-per-Pi>"
echo "       POLL_INTERVAL_S=30"
echo ""
echo "  2. Enable and start the service:"
echo "       sudo systemctl enable --now pharmguard"
echo ""
echo "  3. Monitor logs:"
echo "       journalctl -u pharmguard -f"
echo ""
echo "To run manually for testing:"
echo "  $VENV_PATH/bin/python $INSTALL_DIR/main.py"
echo ""
echo "Note: The service runs as root. RPi.GPIO + picamera2 + lgpio require it."
echo "      Hardening (NoNewPrivileges + ProtectSystem=strict) mitigates the"
echo "      blast radius — see scripts/pharmguard.service for the full unit."
echo ""
