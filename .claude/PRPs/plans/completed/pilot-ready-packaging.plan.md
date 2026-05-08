# Plan: Pilot-Ready Packaging (PRD Phase 10)

## Summary
Make a fresh Pi bootable in <30 min from a flashed Raspberry Pi OS Bookworm image to a running `pharmguard` service. Harden `scripts/install.sh` for idempotent re-runs, tighten the systemd unit (restart limits, journald rotation, security flags), add a top-level `make pi-bootstrap HOST=pi@<host>` umbrella that rsyncs + remote-installs + restarts in one command, ship a `BOM.md` skeleton for the operator to lock procurement against the PRD's <RM 1,000 target, and audit the three `.env.example` files for completeness against everything Phases 1–9 actually consume. Service stays as `User=root` (RPi.GPIO + picamera2 + lgpio work trivially under root; non-root would need brittle udev rules).

## User Story
As an **operator deploying a new dispenser**, I want **one command on my dev machine that takes a freshly-flashed Pi from blank to running pharmguard.service** in under 30 min, so that **scaling from one prototype to N pilot units is rsync + ssh + wait, not a 12-step manual checklist**.

## Problem → Solution
**Today**:
- `install.sh` is mostly idempotent but overwrites the systemd unit on every run, has stale references (`DEVICE_ID` instead of `DEVICE_TOKEN`), and doesn't seed `.env`. It also doesn't `chmod +x` the new bench / chaos / accuracy scripts added in Phases 6, 8, 9.
- `pharmguard.service` runs as root with `Restart=on-failure RestartSec=5s` and no security hardening, no log rotation, no resource limits. A crash loop would burn through restarts forever; `journald` would fill the SD card on a long deployment.
- `make pi-sync HOST=...` only rsyncs — operator must SSH and run install + restart manually.
- No BOM in repo. The PRD's <RM 1,000 target is a forecast, not a tracked artefact.
- `.env.example` files have grown organically through Phases 1–9; no audit confirms every consumed env var is documented.

**After**:
- `install.sh` is fully idempotent (re-runs are safe), seeds `.env` from `.env.example` if missing, chmods every executable script, creates `~/.pharmguard/` for the offline queue (Phase 8), and refreshes the systemd unit only when the template hash changed.
- `pharmguard.service` adds restart-rate limits, journald per-service `LogRateLimit*` rotation, security flags (`NoNewPrivileges`, `ProtectSystem=strict` with explicit `ReadWritePaths`, `PrivateTmp`), and resource ceilings (`MemoryHigh`, `MemoryMax`, `CPUQuota`) so a crash loop or memory leak can't take the Pi down.
- New `make pi-bootstrap HOST=pi@<host>` umbrella: rsync → ssh → `bash scripts/install.sh` → `systemctl enable pharmguard`. One command, fresh-Pi-to-enabled.
- New `BOM.md` skeleton at repo root: markdown table of every component named across Phases 1–9 (NEMA 17 stepper + driver, servo for ejector, servo for diverter, solenoid for drawer-lock, 2× CSI cams, DS18B20 temp sensor, Pi 5 + active cooling, USB-C power supply, etc.). Cost columns left as TBD for operator.
- `.env.example` audit: confirm all 10 settings consumed by `edge_pi/config.py`, the 10 by `backend/app/core/config.py`, and the 3 by `frontend/.env.local.example` are documented; fix any gaps.

## Metadata
- **Complexity**: Medium
- **Source PRD**: `.claude/PRPs/prds/pharmguard.prd.md`
- **PRD Phase**: 10 — Pilot-ready packaging
- **Estimated Files**: 9 (5 polished + 1 new Makefile target + 1 new journald drop-in + 1 new BOM + READMEs)
- **Estimated Lines**: ~250 LOC

---

## UX Design

### Before
```
$ make pi-sync HOST=pi@host
... rsync ...
$ ssh pi@host
pi$ cd ~/IDP_PharmGuard/edge_pi
pi$ bash scripts/install.sh
pi$ cp .env.example .env && nano .env
pi$ sudo systemctl enable --now pharmguard
pi$ journalctl -u pharmguard -f
```
6 manual steps. Easy to skip the `.env` step → service crashes silently.

### After
```
$ make pi-bootstrap HOST=pi@host
=== Sync → Install → Enable ===
... rsync ...
... installing apt deps + venv + pip + systemd unit ...
... seeding .env from .env.example (operator must edit before service restart) ...
... systemctl enabled pharmguard.service
=== Done. Edit ~/IDP_PharmGuard/edge_pi/.env on the Pi then `sudo systemctl restart pharmguard`. ===
```
1 command. Service is *enabled but won't start cleanly until operator fills `.env`* — that's a feature: stub config = fail-loud (HI-012).

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| `make pi-sync HOST=...` | rsync only | unchanged (kept for incremental dev sync) | additive |
| `make pi-bootstrap HOST=...` | did not exist | one-shot fresh-Pi setup | new |
| `scripts/install.sh` | overwrites unit + service file every run | idempotent: hash-checked unit refresh, .env seeding, chmod +x scripts, mkdir queue dir | hardened |
| `pharmguard.service` | basic | restart limits + journald rotation + security flags + resource ceilings | hardened |
| `BOM.md` | did not exist | repo-tracked procurement table | new |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `edge_pi/scripts/install.sh` | full file (129) | Idempotency target; stale `DEVICE_ID` reference; missing `chmod +x` for new scripts |
| P0 | `edge_pi/scripts/pharmguard.service` | full file | Hardening target — current unit lacks restart limits, log rotation, security flags |
| P0 | `edge_pi/scripts/sync_from_dev.sh` | full file | rsync invocation `make pi-bootstrap` will reuse |
| P0 | `Makefile` | full file (~30 lines) | Add `pi-bootstrap` target alongside existing `pi-sync` |
| P0 | `edge_pi/config.py` | 38–123 | Source-of-truth for every Pi env var — drives the `.env.example` audit |
| P0 | `backend/app/core/config.py` | 1–25 | Source-of-truth for backend env — drives `backend/.env.example` audit |
| P0 | `frontend/src/lib/api.ts` | 1–200 | `NEXT_PUBLIC_API_BASE_URL` consumer (Phase 3) — confirm it's in `frontend/.env.local.example` |
| P0 | `edge_pi/storage/queue.py` | full file | Phase 8 needs `~/.pharmguard/` to exist with right permissions; install.sh creates it |
| P1 | `.claude/PRPs/plans/completed/dual-camera-refactor.plan.md` | "Patterns to Mirror" | NAMING / LOGGING / BENCH_SCRIPT_PATTERN reference |
| P1 | `.claude/PRPs/plans/completed/end-to-end-bench-loop.plan.md` | full file | Operator-step pattern (Pi-hardware attestation) |
| P1 | `CLAUDE.md` | full file | Tier boundaries; `__INSTALL_DIR__` / `__USER__` placeholders are sentinel strings |
| P2 | `README.md` | full file | Top-level operator entry — may need a `pi-bootstrap` mention |
| P2 | All 9 archived plans under `.claude/PRPs/plans/completed/` | "Files to Change" sections | Hardware components mentioned across phases — source for `BOM.md` row list |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| systemd `RestartSec` + `StartLimitBurst` | https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html | Combine with `StartLimitIntervalSec` to bound restart storms; want 5 starts in 60 s. |
| systemd journald per-service rotation | https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html | For Pi 5 / Bookworm (systemd 252), use `LogRateLimitIntervalSec` + `LogRateLimitBurst`. SD-card rotation is governed by `/etc/systemd/journald.conf` `SystemMaxUse=` — set 100 MB system-wide via a drop-in. |
| systemd hardening primer | https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html | Safe-for-root hardening: `NoNewPrivileges=yes`, `ProtectSystem=strict` + `ReadWritePaths=`, `PrivateTmp=yes`, `ProtectKernelModules=yes`. Don't use `ProtectHome=` (we read `~/.pharmguard/`). |
| systemd resource limits | https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html | `MemoryHigh` warns; `MemoryMax` kills. Pi 5 has 4–8 GB; YOLO + MediaPipe + dlib peak ~1.5 GB → `MemoryHigh=2G` + `MemoryMax=3G` is sane. |
| `rsync` exclude best practices | https://download.samba.org/pub/rsync/rsync.1 | `--delete-after` (not `--delete`) avoids pruning before a successful transfer. |

---

## Patterns to Mirror

### IDEMPOTENT_INSTALL_PATTERN (current; to be hardened)
```bash
# SOURCE: edge_pi/scripts/install.sh:39-45
sudo apt-get update
sudo apt-get install -y \
    python3-venv \
    python3-pip \
    libatlas-base-dev \
    ...
```
Rule: every step uses an idempotent primitive. Bracket the systemd-unit overwrite with a hash check so re-runs don't spam `daemon-reload`.

### SCRIPT_HEADER_PATTERN
```bash
# SOURCE: edge_pi/scripts/install.sh:1-5
#!/usr/bin/env bash
set -euo pipefail

##
## PharmGuard Edge — Raspberry Pi one-shot setup script.
```
Rule: `#!/usr/bin/env bash`, `set -euo pipefail`, `##` comment header, no `set -x`.

### SYSTEMD_UNIT_PATTERN (current; to be hardened)
```ini
# SOURCE: edge_pi/scripts/pharmguard.service:1-19
[Unit]
Description=PharmGuard Edge - Raspberry Pi Pill Dispenser
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=__INSTALL_DIR__
ExecStart=__INSTALL_DIR__/.venv/bin/python -u __INSTALL_DIR__/main.py
EnvironmentFile=-__INSTALL_DIR__/.env
Restart=on-failure
RestartSec=5s
```
Rule: `__INSTALL_DIR__` and `__USER__` are sentinel strings substituted by `install.sh`. Do NOT replace them with literal paths. The leading `-` on `EnvironmentFile=-` means "tolerate missing" — preserve.

### MAKEFILE_PATTERN
```makefile
# SOURCE: Makefile:1-10
.PHONY: backend frontend dev setup pi-sync pi-models clean-ml

backend:
	cd backend && source .venv/bin/activate && uvicorn app.main:app --reload --port 8000
```
Rule: declare in `.PHONY`; one-line description above the rule; tab indent (not spaces).

### CONFIG_PATTERN_PI (audit reference)
```python
# SOURCE: edge_pi/config.py:48-60
BACKEND_URL: str
DEVICE_TOKEN: str
POLL_INTERVAL_S: float
STUB_MODE: bool
DISPENSER_ID: str
BENCH_MODE: bool
BENCH_LOG_PATH: str
OFFLINE_QUEUE_PATH: str
OFFLINE_MAX_AGE_SECONDS: float
OFFLINE_REPLAY_INTERVAL_S: float
```
Rule: `_Settings` is the source of truth. The audit checks every field is documented in `edge_pi/.env.example`.

### LOGGING_PATTERN (operator-facing)
```bash
echo "=== PharmGuard Edge Setup ==="
echo "Install directory: $INSTALL_DIR"
```
Rule: `echo "=== Section ==="` for headers, `echo "key: value"` for key/value, plain `echo ""` for blank lines. No emoji. No colour codes.

### TEST_STRUCTURE
N/A — no test framework. Validation = `bash -n` (syntax) + structural inspection + `make -n` dry-run + operator attestation.

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `edge_pi/scripts/install.sh` | UPDATE | Idempotency: hash-check service unit, seed `.env`, chmod +x scripts, mkdir `~/.pharmguard/`, install journald drop-in, fix stale `DEVICE_ID` → `DEVICE_TOKEN` |
| `edge_pi/scripts/pharmguard.service` | UPDATE | Restart-rate limits, log-rate limits, security flags, resource ceilings |
| `edge_pi/scripts/journald.conf.d-pharmguard.conf` | CREATE | Drop-in for `/etc/systemd/journald.conf.d/` setting `SystemMaxUse=100M` |
| `edge_pi/scripts/sync_from_dev.sh` | UPDATE | `--delete-after`, exclude `.env`, exclude `*.csv` |
| `Makefile` | UPDATE | New `pi-bootstrap HOST=...` target |
| `BOM.md` | CREATE | Procurement table at repo root |
| `edge_pi/.env.example` | UPDATE (audit) | Confirm all 10 `_Settings` fields documented |
| `backend/.env.example` | UPDATE (audit) | Confirm all `Settings` fields documented |
| `frontend/.env.local.example` | UPDATE (audit) | Confirm all `NEXT_PUBLIC_*` keys documented |
| `README.md` | UPDATE | Add `make pi-bootstrap` mention; link `BOM.md` |
| `edge_pi/README.md` | UPDATE (or CREATE) | Per-Pi setup procedure aligned with `pi-bootstrap` |

## NOT Building

- **Switch service `User=root` to a dedicated user** — operator chose to keep root.
- **`apt-get upgrade`** in install.sh — destructive; out-of-band.
- **Ansible / Salt / Puppet automation** — `make pi-bootstrap` is the right scope for the pilot.
- **Auto-rollback on failed restart** — `RestartSec=5s` + `StartLimitBurst=5` already gives the right shape.
- **Pre-flight network/cam check** in install.sh — operator runs `rpicam-hello --list-cameras` per Phase 2 + 3 reports.
- **Frontend pilot packaging (Vercel deploy script)** — frontend cloud-hosted.
- **Backend deployment script** — production hosting deferred per `CLAUDE.md`.
- **BOM cost figures** — operator owns procurement; ships as `TBD`.
- **`uninstall.sh`** — out of scope.
- **Multi-dispenser fleet management** — Phase 1's `dispenser_id` enables it; tooling is post-pilot.

---

## Step-by-Step Tasks

### Task 1: Harden `pharmguard.service`
- **ACTION**: Edit `edge_pi/scripts/pharmguard.service`.
- **IMPLEMENT**:
  ```ini
  [Unit]
  Description=PharmGuard Edge - Raspberry Pi Pill Dispenser
  After=network-online.target
  Wants=network-online.target

  [Service]
  Type=simple
  User=root
  WorkingDirectory=__INSTALL_DIR__
  ExecStart=__INSTALL_DIR__/.venv/bin/python -u __INSTALL_DIR__/main.py
  EnvironmentFile=-__INSTALL_DIR__/.env

  # Restart policy: bound the restart storm so a wedged service doesn't burn
  # the SD card or hide a real misconfig. After 5 failed starts in 60 s the
  # unit stays in failed state until operator runs `systemctl reset-failed`.
  Restart=on-failure
  RestartSec=5s
  StartLimitIntervalSec=60s
  StartLimitBurst=5

  # Log rate-limit (per-service). Pairs with the journald drop-in shipped in
  # journald.conf.d-pharmguard.conf which sets SystemMaxUse=100M.
  LogRateLimitIntervalSec=10s
  LogRateLimitBurst=2000

  # Security hardening — safe under User=root because Pi 5 + rpi-lgpio +
  # picamera2 already require root for GPIO + render-group access.
  NoNewPrivileges=yes
  ProtectSystem=strict
  ReadWritePaths=__INSTALL_DIR__ /home /tmp /var/log /run
  PrivateTmp=yes
  ProtectKernelModules=yes
  ProtectControlGroups=yes
  RestrictNamespaces=yes
  LockPersonality=yes

  # Resource ceilings. Pi 5 has 4–8 GB RAM; YOLO + MediaPipe + dlib peak
  # ~1.5 GB. MemoryHigh warns, MemoryMax kills.
  MemoryHigh=2G
  MemoryMax=3G
  CPUQuota=380%
  TasksMax=128

  StandardOutput=journal
  StandardError=journal
  SyslogIdentifier=pharmguard

  [Install]
  WantedBy=multi-user.target
  ```
- **MIRROR**: SYSTEMD_UNIT_PATTERN — preserve `__INSTALL_DIR__` + `__USER__` sentinels, preserve leading `-` on `EnvironmentFile`.
- **IMPORTS**: N/A.
- **GOTCHA**:
  - `ProtectSystem=strict` makes `/usr`, `/boot`, `/efi`, `/etc` read-only. Phase 8's queue at `/home/pi/.pharmguard/queue.db` covered by `ReadWritePaths=/home`. Phase 6's CSV at `/tmp/bench_e2e.csv` covered by `PrivateTmp=yes` (per-service /tmp).
  - DO NOT add `ProtectHome=` — Phase 8's queue lives in `/home/pi/.pharmguard/`.
  - Keep `User=root` — non-root + GPIO is brittle.
- **VALIDATE**: structural inspection (every key in `[Unit]` / `[Service]` / `[Install]` section; sentinels intact).

### Task 2: Create `journald.conf.d-pharmguard.conf` drop-in
- **ACTION**: New file `edge_pi/scripts/journald.conf.d-pharmguard.conf`.
- **IMPLEMENT**:
  ```ini
  # PharmGuard Edge — drop-in for /etc/systemd/journald.conf.d/.
  # Caps the persistent journal at 100 MB so pharmguard.service running for
  # weeks doesn't fill the SD card. install.sh copies this into
  # /etc/systemd/journald.conf.d/pharmguard.conf and runs `systemctl restart
  # systemd-journald`.

  [Journal]
  Storage=persistent
  SystemMaxUse=100M
  SystemKeepFree=100M
  RuntimeMaxUse=50M
  ```
- **MIRROR**: existing systemd dot-conf style.
- **IMPORTS**: N/A.
- **GOTCHA**: drop-in changes **system-wide** journald limits, not just pharmguard's. Document clearly in install.sh output.
- **VALIDATE**: structural inspection.

### Task 3: Harden `install.sh`
- **ACTION**: Edit `edge_pi/scripts/install.sh` (incremental edits, not full rewrite).
- **IMPLEMENT**:
  - Fix the stale env hint (line ~118): `DEVICE_ID=pi-01` → `DEVICE_TOKEN=<32+ chars from secrets.token_urlsafe(32)>`.
  - After `pip install -r requirements.txt`, add a chmod block:
    ```bash
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
    ```
  - After the venv is created, add a `.env` seed step (do NOT overwrite):
    ```bash
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
    ```
  - Before the systemd-install block, add Phase 8 prep:
    ```bash
    ##
    ## Phase 8: ensure offline-queue directory exists with right ownership
    ##
    QUEUE_DIR="/home/$CURRENT_USER/.pharmguard"
    if [[ ! -d "$QUEUE_DIR" ]]; then
        mkdir -p "$QUEUE_DIR"
        chown "$CURRENT_USER:$CURRENT_USER" "$QUEUE_DIR" 2>/dev/null || true
        echo "Created $QUEUE_DIR for offline queue"
    fi
    echo ""
    ```
  - Replace the unconditional systemd-unit overwrite with a hash-checked refresh:
    ```bash
    ##
    ## Install or refresh systemd service (only if template changed)
    ##
    SERVICE_FILE="/etc/systemd/system/pharmguard.service"
    SERVICE_CONTENT=$(cat "$INSTALL_DIR/scripts/pharmguard.service")
    SERVICE_CONTENT="${SERVICE_CONTENT//__INSTALL_DIR__/$INSTALL_DIR}"
    SERVICE_CONTENT="${SERVICE_CONTENT//__USER__/$CURRENT_USER}"

    NEW_HASH=$(echo "$SERVICE_CONTENT" | sha256sum | cut -d' ' -f1)
    OLD_HASH=""
    if [[ -f "$SERVICE_FILE" ]]; then
        OLD_HASH=$(sha256sum "$SERVICE_FILE" | cut -d' ' -f1)
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
    ```
  - After systemd unit, install the journald drop-in:
    ```bash
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
    fi
    echo ""
    ```
  - Replace the bottom "next steps" block with corrected env hints (drop stale `DEVICE_ID`).
- **MIRROR**: IDEMPOTENT_INSTALL_PATTERN, SCRIPT_HEADER_PATTERN, LOGGING_PATTERN.
- **IMPORTS**: bash builtins + `sha256sum`, `cmp` (coreutils — present on Bookworm).
- **GOTCHA**:
  - `chown` may fail; `|| true` swallows. Acceptable.
  - `cp` for `.env` seed is **never** overwriting — outer `if [[ ! -f $ENV_FILE ]]` prevents it.
  - `systemctl restart systemd-journald` is OK — short interruption, journald buffers logs.
  - `sudo cmp -s` returns non-zero on diff (which `set -e` would catch) — use `if !` not `if`.
- **VALIDATE**:
  ```bash
  cd /Users/limjiale/IDP_PharmGuard/edge_pi
  bash -n scripts/install.sh
  ```

### Task 4: Polish `sync_from_dev.sh` excludes
- **ACTION**: Edit `edge_pi/scripts/sync_from_dev.sh`.
- **IMPLEMENT**: Update the rsync invocation:
  ```bash
  rsync -avz --delete-after \
      --exclude '.venv' \
      --exclude '__pycache__' \
      --exclude '*.log' \
      --exclude '*.csv' \
      --exclude '.env' \
      --exclude '.pytest_cache' \
      --exclude '.eggs' \
      "$EDGE_PI_DIR/" \
      "$PI_HOST:~/IDP_PharmGuard/edge_pi/"
  ```
  And after the rsync, add a hint:
  ```bash
  echo "(For a fresh Pi, prefer: make pi-bootstrap HOST=$PI_HOST)"
  ```
- **MIRROR**: SCRIPT_HEADER_PATTERN.
- **IMPORTS**: N/A.
- **GOTCHA**:
  - `--delete-after` removes Pi-side files not in source — preserves the operator's `.env` (excluded above) and `.venv` (excluded above) and SQLite queue (lives in `~/.pharmguard/`, outside `edge_pi/`).
  - `--exclude '.env'` is critical: operator's tokens must NEVER be overwritten by sync.
- **VALIDATE**: `bash -n scripts/sync_from_dev.sh`.

### Task 5: Add `make pi-bootstrap HOST=...` umbrella
- **ACTION**: Edit `Makefile`.
- **IMPLEMENT**: Add to `.PHONY`:
  ```makefile
  .PHONY: backend frontend dev setup pi-sync pi-bootstrap pi-models clean-ml
  ```
  Then after `pi-sync`:
  ```makefile
  # Fresh-Pi bootstrap: rsync → ssh → install.sh → enable service.
  # Idempotent (re-running on a configured Pi is safe).
  # Usage: make pi-bootstrap HOST=pi@raspberrypi.local
  pi-bootstrap:
  	@if [ -z "$(HOST)" ]; then echo "ERROR: HOST=pi@<host> required"; exit 1; fi
  	bash edge_pi/scripts/sync_from_dev.sh $(HOST)
  	@echo ""
  	@echo "=== Running install.sh on $(HOST) ==="
  	ssh $(HOST) "cd ~/IDP_PharmGuard/edge_pi && bash scripts/install.sh"
  	@echo ""
  	@echo "=== Enabling pharmguard.service on $(HOST) ==="
  	ssh $(HOST) "sudo systemctl enable pharmguard.service"
  	@echo ""
  	@echo "=== Done. ==="
  	@echo "Edit ~/IDP_PharmGuard/edge_pi/.env on the Pi, then:"
  	@echo "  ssh $(HOST) 'sudo systemctl restart pharmguard'"
  ```
- **MIRROR**: MAKEFILE_PATTERN.
- **IMPORTS**: N/A.
- **GOTCHA**:
  - `enable` (not `enable --now`): we DON'T want to start the service immediately because `.env` likely needs editing.
  - Tab indent (Makefile-strict).
  - `$(HOST)` (Make var), not `$HOST`.
  - Operator must have ssh-key auth set up.
- **VALIDATE**:
  ```bash
  cd /Users/limjiale/IDP_PharmGuard
  make -n pi-bootstrap HOST=pi@stub.local 2>&1 | head -10
  ```

### Task 6: Create `BOM.md` skeleton
- **ACTION**: New `BOM.md` at repo root.
- **IMPLEMENT**:
  ```markdown
  # PharmGuard Bill of Materials

  Procurement-tracking artefact for the Phase 10 pilot build.

  PRD target: total prototype BOM **< RM 1,000** (~RM 950 forecast).
  Operator owns SKU + price columns; this file is the canonical row list.

  | Component | Qty | Phase | Detail | SKU / link | Unit price (RM) | Subtotal (RM) | Notes |
  |---|---|---|---|---|---|---|---|
  | Raspberry Pi 5 (4 GB or 8 GB) | 1 | core | aarch64 + 2 CSI lanes | TBD | TBD | TBD | 8 GB recommended for headroom |
  | Active cooling case | 1 | core | thermal throttling mitigation (Phase 2 risk) | TBD | TBD | TBD | required for sustained dual-cam YOLO |
  | USB-C 5 V / 5 A power supply | 1 | core | Pi 5 official PSU | TBD | TBD | TBD | undersized PSU = brownout under load |
  | microSD card (32 GB+, A2) | 1 | core | Pi OS Bookworm | TBD | TBD | TBD | A2 class for journald + queue.db throughput |
  | NEMA 17 stepper motor | 1 | Phase 2 mech | magazine rotation | TBD | TBD | TBD | 1.8°/step, 200 steps/rev |
  | A4988 or DRV8825 driver | 1 | Phase 2 mech | NEMA 17 driver | TBD | TBD | TBD | DRV8825 preferred (more headroom) |
  | Servo (ejector — slider-crank) | 1 | Phase 2 mech | SG90 / MG996R class | TBD | TBD | TBD | torque sized for slider-crank load |
  | Servo (diverter flap) | 1 | Phase 4 | reject-bin gate | TBD | TBD | TBD | SG90 sufficient |
  | Solenoid (drawer lock) | 1 | Phase 4 | 12 V latch solenoid | TBD | TBD | TBD | needs flyback diode + dedicated 12 V rail |
  | Pi Camera Module 3 (or v2) — cam 0 | 1 | Phase 2 | tray top-down (pill ID) | TBD | TBD | TBD | NoIR not required |
  | Pi Camera Module 3 (or v2) — cam 1 | 1 | Phase 2 | patient-facing (swallow / liveness) | TBD | TBD | TBD | wide-angle helps Step-1 hand detection |
  | DS18B20 1-wire temperature sensor | 1 | Phase 5 | tray temperature | TBD | TBD | TBD | + 4.7 kΩ pull-up |
  | 10-slot magazine (3D-printed, PLA / PETG) | 1 | Phase 2 mech | rotates over ejector | TBD (in-house) | TBD | TBD | injection-molded for hygiene compliance is V2+ |
  | Slider-crank linkage + push-rod | 1 | Phase 2 mech | actuated by ejector servo | TBD (in-house) | TBD | TBD | |
  | Diverter flap + reject bin | 1 | Phase 4 | servo-actuated flap | TBD (in-house) | TBD | TBD | |
  | Lockable drawer + face plate | 1 | Phase 4 | solenoid-released | TBD | TBD | TBD | |
  | Power distribution (12 V buck for solenoid + 5 V for Pi) | 1 | core | dual-rail | TBD | TBD | TBD | |
  | Wiring + connectors | lot | core | DuPont / JST / 18 AWG for solenoid | TBD | TBD | TBD | |
  | Enclosure | 1 | core | bedside footprint < 600 cm² | TBD (in-house) | TBD | TBD | |
  | **TOTAL** | | | | | | **TBD** | target: < RM 1,000 |

  ## Notes

  - Components marked **in-house** are 3D-printed or fabricated in lab — material cost only.
  - Phase 9 may ship a Hailo-8L or Coral USB accelerator if YOLO p95 misses the <200 ms target on Pi 5 CPU. **Adding either would push BOM past RM 1,000** — track in PRD risk register.
  - Phase 4 risk callout: solenoid + dedicated 12 V rail + flyback diode is the trickiest electrical item; double-check before procurement.

  ## Out of scope

  - Frontend / cloud hosting — billed separately.
  - Spare parts inventory — not in V1 BOM.
  - Tooling (3D printer filament, soldering iron, etc.) — assumed available.
  ```
- **MIRROR**: existing markdown style.
- **IMPORTS**: N/A.
- **GOTCHA**: don't invent prices — leave them `TBD`.
- **VALIDATE**: file renders as markdown table on GitHub.

### Task 7: `.env.example` audit
- **ACTION**: Compare `_Settings` source-of-truth against `.env.example` files; add missing keys.
- **IMPLEMENT**:
  - **Pi (`edge_pi/.env.example`)**: should document all 10 fields. Verify via:
    ```bash
    diff <(grep -oE '^[A-Z_]+=' edge_pi/.env.example | sort -u) \
         <(python3 -c "
    import re, pathlib
    src = pathlib.Path('edge_pi/config.py').read_text()
    keys = set(re.findall(r'os\.environ\.get\(\"([A-Z_]+)\"', src))
    keys |= set(re.findall(r'_require\(\"([A-Z_]+)\"\)', src))
    for k in sorted(keys): print(k+'=')
    ")
    ```
  - **Backend (`backend/.env.example`)**: should document all `Settings` fields: `SUPABASE_URL`, `SUPABASE_KEY`, `SECRET_KEY`, `GEMINI_API_KEY`, `DEVICE_TOKENS`, `DEFAULT_DISPENSER_ID`, `FACE_MATCH_TOLERANCE`, plus Phase 5's `EXPIRY_WARN_DAYS`, `LOW_STOCK_THRESHOLD`, `OVER_TEMP_CELSIUS`. Confirm + fix any gaps.
  - **Frontend (`frontend/.env.local.example`)**: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_API_BASE_URL`. Confirm.
- **MIRROR**: existing `.env.example` style — comment line above each new key.
- **IMPORTS**: N/A.
- **GOTCHA**:
  - Pi env names are **uppercase**; backend names are **lowercase** at the Pydantic level but **uppercase** in the env file (pydantic-settings lowercases on read).
  - Don't ship real secrets — placeholder values only.
- **VALIDATE**: For each env file, run the diff snippet above and confirm zero unaccounted env keys.

### Task 8: README updates
- **ACTION**: Edit `README.md` and `edge_pi/README.md`.
- **IMPLEMENT**:
  - In top-level `README.md`, in the "Edge Pi" section, replace the existing line with:
    > **Fresh Pi**: `make pi-bootstrap HOST=pi@<host>` (one-shot rsync + install + enable). See `edge_pi/README.md` for the per-step breakdown and `BOM.md` for hardware procurement.
    >
    > **Incremental sync** (after an edit): `make pi-sync HOST=pi@<host>` — rsync only; service is already enabled.
  - In `edge_pi/README.md` (read first; if missing, create), document:
    - Prerequisites (Pi 5 with Bookworm 64-bit; cameras attached; ssh-key auth from dev machine)
    - Single-command path: `make pi-bootstrap HOST=pi@host`
    - Manual fallback (3 steps)
    - Editing `.env` (the seeded copy is a placeholder; fill in real `BACKEND_URL`, `DEVICE_TOKEN`, etc.)
    - Operator attestations from Phases 2/3/4/5/6/8/9 (link the bench scripts)
- **MIRROR**: existing markdown style.
- **IMPORTS**: N/A.
- **GOTCHA**: don't duplicate `CLAUDE.md` content.
- **VALIDATE**: render on GitHub.

### Task 9: Local validation suite
- **ACTION**: Run all static checks.
- **IMPLEMENT**:
  ```bash
  cd /Users/limjiale/IDP_PharmGuard

  # 1. bash syntax
  bash -n edge_pi/scripts/install.sh
  bash -n edge_pi/scripts/sync_from_dev.sh

  # 2. Makefile dry-run
  make -n pi-bootstrap HOST=pi@stub.local | head -20

  # 3. systemd unit structural check
  python3 -c "
  import pathlib
  src = pathlib.Path('edge_pi/scripts/pharmguard.service').read_text()
  for needle in ['__INSTALL_DIR__', '__USER__', 'NoNewPrivileges=yes',
                 'ProtectSystem=strict', 'ReadWritePaths=', 'PrivateTmp=yes',
                 'StartLimitIntervalSec=60s', 'StartLimitBurst=5',
                 'MemoryHigh=', 'MemoryMax=', 'CPUQuota=']:
      assert needle in src, f'missing: {needle}'
  print('systemd unit hardening intact')
  "

  # 4. .env.example coverage audit (Pi)
  python3 -c "
  import re, pathlib
  cfg = pathlib.Path('edge_pi/config.py').read_text()
  consumed = set(re.findall(r'os\.environ\.get\(\"([A-Z_]+)\"', cfg))
  consumed |= set(re.findall(r'_require\(\"([A-Z_]+)\"\)', cfg))
  envex = pathlib.Path('edge_pi/.env.example').read_text()
  documented = set(re.findall(r'^([A-Z_]+)=', envex, re.MULTILINE))
  missing = consumed - documented
  assert not missing, f'Pi env undocumented: {missing}'
  print(f'Pi env audit OK ({len(consumed)} keys all documented)')
  "

  # 5. .env.example coverage audit (backend)
  python3 -c "
  import re, pathlib
  cfg = pathlib.Path('backend/app/core/config.py').read_text()
  consumed = {m for m in re.findall(r'^\s+([a-z_]+):', cfg, re.MULTILINE)
              if m not in ('model_config',)}
  envex = pathlib.Path('backend/.env.example').read_text()
  documented = {m.lower() for m in re.findall(r'^([A-Z_]+)=', envex, re.MULTILINE)}
  missing = consumed - documented
  print(f'Backend env: consumed={len(consumed)}, documented={len(documented)}, missing={missing or \"none\"}')
  "

  # 6. Pi compile (sanity — touched no .py)
  cd edge_pi && python3 -m py_compile config.py main.py
  ```
- **MIRROR**: Phase 6 + Phase 8 validation patterns.
- **IMPORTS**: stdlib.
- **GOTCHA**:
  - The backend env audit is heuristic — greps Pydantic field names. Manual confirmation of the printed missing-set is acceptable.
  - `make -n` doesn't actually ssh; just prints commands.
- **VALIDATE**: every step prints OK / its expected output.

### Task 10: Operator-attested fresh-Pi bootstrap
- **ACTION**: Operator drives `make pi-bootstrap` against a freshly-flashed Pi 5.
- **IMPLEMENT** (operator-side):
  ```bash
  # On a clean Pi 5:
  #   1. Flash Raspberry Pi OS Bookworm 64-bit, enable ssh, attach cam 0 + cam 1.
  #   2. Generate or copy ssh public key from dev machine.
  #
  # On the dev machine:
  cd /path/to/IDP_PharmGuard
  make pi-bootstrap HOST=pi@<host>

  # Edit .env on the Pi:
  ssh pi@<host> "nano ~/IDP_PharmGuard/edge_pi/.env"
  #   Fill BACKEND_URL=https://...
  #   Generate DEVICE_TOKEN: python3 -c 'import secrets;print(secrets.token_urlsafe(32))'
  #   Set DISPENSER_ID=<unique-per-Pi>

  # Start the service:
  ssh pi@<host> "sudo systemctl restart pharmguard"

  # Watch logs:
  ssh pi@<host> "journalctl -u pharmguard -f"
  ```
- **MIRROR**: Phase 2/4/8 operator-step pattern.
- **IMPORTS**: N/A.
- **GOTCHA**:
  - Time the run from `make pi-bootstrap` start to first successful schedule poll. PRD success signal: <30 min.
  - Confirm `~/.pharmguard/queue.db` was created with right ownership.
  - Confirm `journalctl --disk-usage` plateaus at ~100 MB after a long soak.
  - Try a deliberate misconfig (blank `DEVICE_TOKEN`) and confirm `StartLimitBurst=5` halts the restart storm.
- **VALIDATE**: stopwatch < 30 min; `systemctl status pharmguard` shows `active (running)` after `.env` edit + restart.

---

## Testing Strategy

Repo has no test framework. Validation = bash syntax + structural inspection + dev-machine `make -n` dry-run + Pi-hardware operator attestation.

### Manual / Smoke Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| `bash -n install.sh` | syntax check | exit 0 | normal |
| `make -n pi-bootstrap HOST=stub` | dry-run | prints rsync + ssh + ssh commands | normal |
| systemd unit hardening (textual) | grep for security flags | all 5+ flags present | regression |
| Pi env audit | regex consumed vs documented | empty missing-set | regression |
| Backend env audit | same | empty missing-set | regression |
| install.sh idempotent re-run | run twice | second run logs "unit unchanged" + "preserved" + "drop-in unchanged" | yes |
| `.env` preserved across re-run | seed `.env` with operator value, re-run install.sh | `.env` byte-identical | yes |
| Fresh-Pi bootstrap | `make pi-bootstrap` on clean Pi | < 30 min to running service | yes |
| systemd journal disk cap | 14-day soak | `journalctl --disk-usage < 200 MB` | yes |
| Restart-storm bound | misconfigured `.env` | `failed (start-limit-hit)` after 5 restarts in 60 s | yes |

### Edge Cases Checklist
- [x] Empty input — `make pi-bootstrap` without `HOST=` errors out cleanly.
- [x] Maximum size — journald drop-in caps system journal at 100 MB.
- [x] Invalid types — N/A (shell scripts; `bash -n` is the gate).
- [x] Concurrent access — install.sh is single-shot; document "don't run twice in parallel".
- [x] Network failure — rsync over ssh propagates exit code; install.sh aborts via `set -e`.
- [x] Permission denied — `sudo` calls inside install.sh prompt the operator.

---

## Validation Commands

### Static Analysis
```bash
bash -n edge_pi/scripts/install.sh
bash -n edge_pi/scripts/sync_from_dev.sh
make -n pi-bootstrap HOST=pi@stub.local | head -20
python3 -m py_compile edge_pi/config.py edge_pi/main.py
```
EXPECT: zero output / no errors.

### Hardening Regression
See Task 9 step 3. EXPECT: `systemd unit hardening intact`.

### Env Audit
See Task 9 steps 4-5. EXPECT: zero undocumented Pi env keys; backend missing-set empty.

### Frontend Build
N/A.

### Pi Hardware Bootstrap
See Task 10. EXPECT: <30 min to running service; idempotent re-run logs no-op messages.

### Manual Validation Checklist
- [ ] `pharmguard.service` has restart limits, journald rate-limits, security flags, resource ceilings.
- [ ] `journald.conf.d-pharmguard.conf` exists and is installed by `install.sh`.
- [ ] `install.sh` is idempotent — second run logs "unit unchanged" and preserves `.env`.
- [ ] `install.sh` mkdir's `~/.pharmguard/` for the Phase 8 queue.
- [ ] `install.sh` chmods bench/chaos/accuracy scripts.
- [ ] `make pi-bootstrap HOST=...` runs sync + install + enable.
- [ ] `BOM.md` exists at repo root.
- [ ] `.env.example` audit: every env consumed by code is documented.
- [ ] Top-level `README.md` mentions `make pi-bootstrap`.
- [ ] PRD Phase 10 row updated.

---

## Acceptance Criteria
- [ ] All 10 tasks completed.
- [ ] systemd unit passes structural regression check (5+ hardening flags present).
- [ ] Idempotency: re-running `install.sh` on a configured Pi produces no destructive changes.
- [ ] `make pi-bootstrap HOST=...` completes < 30 min on a freshly-flashed Pi 5 (operator-attested).
- [ ] HI-012 invariant unaffected — service still refuses to run on stubbed hardware without `PHARMGUARD_STUB=1`.
- [ ] PRD Phase 10 row updated.

## Completion Checklist
- [ ] Shell scripts follow SCRIPT_HEADER_PATTERN.
- [ ] systemd unit preserves `__INSTALL_DIR__` / `__USER__` sentinels.
- [ ] No new Pi or backend dependencies.
- [ ] No code changes inside `edge_pi/`, `backend/`, or `frontend/` source trees (Phase 10 is packaging only).
- [ ] `BOM.md` ships costs as `TBD`.
- [ ] Phase 4 + Phase 5 + Phase 6 + Phase 8 + Phase 9 sentinels in `main.py` byte-identical.

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `ProtectSystem=strict` blocks a path the service needs | M | M | `ReadWritePaths=__INSTALL_DIR__ /home /tmp /var/log /run` covers four observed write surfaces. If service errors with EROFS, add the path. |
| `MemoryMax=3G` kills the service under YOLO + dlib peak | L | M | Profiled estimate is ~1.5 GB; 3 GB is 2× headroom. |
| `make pi-bootstrap` fails on Pi without ssh-key auth | M | L | Document prereq in `edge_pi/README.md`. |
| `apt-get install` fails behind firewall | L | M | install.sh aborts on `set -e`; operator retries. |
| BOM.md goes stale immediately | H | L | Operator edits as they procure. The skeleton is the value. |
| Restart-storm guard hides a real-but-fixable bug | L | L | `StartLimitBurst=5 / 60s` is loose enough for transient outages. Operator runs `systemctl reset-failed` to recover. |
| journald drop-in clobbers operator's existing config | L | M | Drop-in path is `journald.conf.d/pharmguard.conf` (additive only). |
| `.env` seed surprises operator | L | L | install.sh prints "EDIT $ENV_FILE BEFORE STARTING THE SERVICE". |

## Notes
- **Phase 10 is operator tooling**, not Pi runtime. No `edge_pi/main.py` changes; HI-012 + Phase 4/5/6/8/9 invariants stay byte-identical.
- **`BOM.md` lives at repo root**, not under `docs/` (which doesn't exist).
- **`make pi-bootstrap` is the headline UX**.
- **Service stays as User=root** by operator's choice. `NoNewPrivileges=yes` + `ProtectSystem=strict` mitigate.
- **Stub-mode safety preserved** — install.sh seeds `.env` from `.env.example` which has `PHARMGUARD_STUB=0` by default. The service refuses to boot until operator fills `BACKEND_URL` + `DEVICE_TOKEN` (the `_require()` helpers raise on empty). HI-012 by construction.
- After this plan ships, update `pharmguard.prd.md` Phase 10 row to:
  ```
  | 10 | Pilot-ready packaging | ... | in-progress | - | 8, 9 | .claude/PRPs/plans/pilot-ready-packaging.plan.md |
  ```
  Then `complete` once Task 10 (fresh-Pi bootstrap < 30 min) passes.

Sources:
- [systemd.service man page](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)
- [systemd.exec man page (security flags)](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)
- [systemd.resource-control man page](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html)
- [rsync man page](https://download.samba.org/pub/rsync/rsync.1)
