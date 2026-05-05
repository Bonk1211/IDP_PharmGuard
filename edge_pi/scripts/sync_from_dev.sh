#!/usr/bin/env bash
set -euo pipefail

##
## PharmGuard Edge — rsync helper to push code from dev machine to Pi.
##
## Usage: ./sync_from_dev.sh <pi-host>
## Example: ./sync_from_dev.sh pi@pharmguard-01.local
##

if [[ $# -lt 1 ]]; then
    echo "Usage: $0 <pi-host>"
    echo "Example: $0 pi@pharmguard-01.local"
    exit 1
fi

PI_HOST="$1"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EDGE_PI_DIR="$REPO_ROOT/edge_pi"

echo "=== PharmGuard Edge Sync to Pi ==="
echo "Source: $EDGE_PI_DIR"
echo "Destination: $PI_HOST:~/IDP_PharmGuard/edge_pi/"
echo ""

##
## rsync: exclude venv, cache, logs
##
rsync -avz \
    --exclude '.venv' \
    --exclude '__pycache__' \
    --exclude '*.log' \
    --exclude '.pytest_cache' \
    --exclude '.eggs' \
    "$EDGE_PI_DIR/" \
    "$PI_HOST:~/IDP_PharmGuard/edge_pi/"

echo ""
echo "=== Sync Complete ==="
echo ""
echo "Next steps on the Pi:"
echo "  ssh $PI_HOST"
echo "  sudo systemctl restart pharmguard"
echo ""
echo "To monitor logs:"
echo "  journalctl -u pharmguard -f"
echo ""
