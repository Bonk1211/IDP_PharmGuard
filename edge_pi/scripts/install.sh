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
INSTALL_DIR="$REPO_ROOT/edge_pi"
VENV_PATH="$INSTALL_DIR/.venv"
CURRENT_USER="${SUDO_USER:-$(whoami)}"

echo "=== PharmGuard Edge Setup ==="
echo "Install directory: $INSTALL_DIR"
echo "Virtual environment: $VENV_PATH"
echo "User: $CURRENT_USER"
echo ""

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
# If a wheel build later complains about missing libs on a non-piwheels
# Pi, install on demand with `sudo apt-get install -y libopenblas0`.
sudo apt-get install -y \
    python3-venv \
    python3-pip \
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
    python3 -m venv "$VENV_PATH"
    echo "Created venv at $VENV_PATH"
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
