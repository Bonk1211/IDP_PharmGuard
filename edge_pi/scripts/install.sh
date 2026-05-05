#!/usr/bin/env bash
set -euo pipefail

##
## PharmGuard Edge — Raspberry Pi one-shot setup script.
##
## Installs system dependencies, creates a Python venv, installs pip packages,
## and registers the systemd service unit.
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
sudo apt-get install -y \
    python3-venv \
    python3-pip \
    libatlas-base-dev \
    libopenjp2-7 \
    libtiff6 \
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
## Install systemd service
##
echo "Installing systemd service..."
SERVICE_FILE="/etc/systemd/system/pharmguard.service"

# Read the service template and substitute placeholders
SERVICE_CONTENT=$(cat "$INSTALL_DIR/scripts/pharmguard.service")
SERVICE_CONTENT="${SERVICE_CONTENT//__INSTALL_DIR__/$INSTALL_DIR}"
SERVICE_CONTENT="${SERVICE_CONTENT//__USER__/$CURRENT_USER}"

# Write to systemd directory (requires sudo)
echo "$SERVICE_CONTENT" | sudo tee "$SERVICE_FILE" > /dev/null
sudo chmod 644 "$SERVICE_FILE"
echo "Service installed at $SERVICE_FILE"

echo "Reloading systemd daemon..."
sudo systemctl daemon-reload
echo ""

##
## Final instructions
##
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. (Optional) Create a .env file in $INSTALL_DIR/ with custom config:"
echo "       BACKEND_URL=https://your-backend-url"
echo "       DEVICE_ID=pi-01"
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
echo "Note: The service runs as root. Ensure GPIO permissions are correct."
echo "      (RPi.GPIO works with root; regular user may need udev rules.)"
echo ""
