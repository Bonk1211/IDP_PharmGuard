"""Unified PharmGuard runtime configuration.

Replaces the old split between backend/app/core/config.py (pydantic-settings,
lower_snake) and edge_pi/config.py (frozen dataclass + lazy proxy + UPPER_SNAKE).
The pydantic-settings shape wins — every key has a safe default so import-time
is side-effect-free; production invariants are enforced via validate_runtime()
called from main.py:lifespan.

Migration crib (old name -> new name):
    BACKEND_URL              -> dropped (Pi IS the backend after merge)
    DEVICE_TOKEN             -> dropped (cycle bypasses HTTP)
    POLL_INTERVAL_S          -> poll_interval_s
    PHARMGUARD_STUB / STUB_MODE -> pharmguard_stub
    DISPENSER_ID             -> dispenser_id
    BENCH_MODE               -> bench_mode
    BENCH_LOG_PATH           -> bench_log_path
    OFFLINE_QUEUE_PATH       -> offline_queue_path
    OFFLINE_MAX_AGE_SECONDS  -> offline_max_age_seconds
    OFFLINE_REPLAY_INTERVAL_S-> offline_replay_interval_s
"""

from __future__ import annotations

import logging
from pathlib import Path

from pydantic_settings import BaseSettings

log = logging.getLogger(__name__)


class Settings(BaseSettings):
    # ── from old backend/core/config.py ───────────────────────────────────
    supabase_url: str = ""
    supabase_key: str = ""                          # service_role for backend
    secret_key: str = "dev-secret-change-in-production"
    gemini_api_key: str = ""
    device_tokens: str = ""                         # legacy bearer tokens, comma-sep
    default_dispenser_id: str = "dispenser-001"
    expiry_warn_days: int = 14
    low_stock_threshold: int = 3

    # ── from old edge_pi/config.py ────────────────────────────────────────
    poll_interval_s: float = 30.0
    pharmguard_stub: bool = False                   # was STUB_MODE
    dispenser_id: str = ""                          # the LIVE dispenser id, distinct
                                                    # from default_dispenser_id which is
                                                    # the fallback used by the inventory API
    bench_mode: bool = False
    bench_log_path: str = "/tmp/bench_e2e.csv"
    offline_queue_path: str = ""                    # default resolved in model_post_init
    offline_max_age_seconds: float = 3600.0
    offline_replay_interval_s: float = 30.0

    # ── new (Pi-hosted refactor) ──────────────────────────────────────────
    device_api_key: str = ""                        # frontend -> ngrok -> Pi auth header
    backend_headless: bool = False                  # 1 = skip hardware lifespan (dev-mac)
    # Dev-mac single-webcam path: when 1, the cycle opens ONE local cv2
    # webcam as the intake camera (cam_b) even in stub mode, so the
    # dashboard live stream + swallow FSM work without Pi hardware. The
    # tray camera (cam_a / YOLO) stays unavailable — a Mac has one camera.
    dev_camera_enabled: bool = False
    dev_camera_index: int = 0                        # macOS built-in FaceTime cam = 0
    # 1 = cycle loop stays idle until /api/device/dispense_now (or another
    # manual-trigger endpoint) fires. 0 = auto-polls medications every
    # poll_interval_s. Default ON so a freshly-started Pi doesn't drain
    # the magazine before an operator is at the dashboard.
    manual_dispense_only: bool = True
    # In manual mode, how often to wake and check for a scheduled dispense
    # (medications.schedule_at == current minute). 60 s = at-most one-minute
    # latency on schedule firing. Lower = tighter, higher = more idle.
    schedule_check_interval_s: float = 60.0

    # ── Clinician assistant (read-only DeepSeek agent) ────────────────────
    # DeepSeek's API is OpenAI chat-completions compatible; we use the openai
    # SDK pointed at the DeepSeek base URL. Use deepseek-chat (supports tool
    # calling); deepseek-reasoner does NOT support tools.
    deepseek_api_key: str = ""
    deepseek_base_url: str = "https://api.deepseek.com"
    deepseek_model: str = "deepseek-chat"
    # CSV of LOCAL hours (24h) when the brief scheduler fires.
    # Empty string -> scheduler still runs but never fires (manual-only briefs).
    agent_brief_local_hours: str = "7,19"

    # ── Flag detection thresholds ────────────────────────────────────────
    agent_flag_missed_streak_threshold: int = 3
    agent_flag_low_confidence_threshold: float = 0.55
    # Flip off the LLM soft-pattern pass without unsetting DEEPSEEK_API_KEY
    # (which would also disable chat + brief).
    agent_flag_llm_enabled: bool = True

    # ── AWS Rekognition (face verify + intake label detection) ───────────
    # Shared by services/face_verify.py and services/label_detector.py.
    # Defaults are empty/safe so import-time stays side-effect-free; the
    # services surface 503 / soft-fail at call time when keys are missing.
    aws_region: str = "ap-southeast-1"
    aws_access_key_id: str = ""
    aws_secret_access_key: str = ""

    # ── Layer-1 face verify (AWS Rekognition CompareFaces) ──────────────
    # Similarity 0-100; 80 is the AWS default and a reasonable demo
    # threshold. Tighten (90+) for stricter ID, loosen if lighting on the
    # demo cabinet is poor.
    face_similarity_threshold: float = 80.0

    # ── Layer-2 intake object detection (AWS Rekognition DetectLabels) ──
    # Hard gate on top of MediaPipe FSM: intake passes only when MediaPipe
    # completes AND at least one required label is seen during the window.
    # Setting intake_label_enabled=False restores MediaPipe-only behavior.
    intake_label_enabled: bool = True
    intake_label_required: str = "Bottle,Cup,Mug,Drink,Drinking,Pill"
    intake_label_min_confidence: float = 70.0
    intake_label_poll_interval_s: float = 1.5

    # ── ElevenLabs nurse-voice TTS (guided-demo greeting) ────────────────
    # Real billable secret — NEVER expose to the browser. Empty = feature off
    # (the /api/device/tts endpoint soft-fails / the frontend stays silent).
    elevenlabs_api_key: str = ""
    # Account-owned premade voice id (no cloning needed). Default = "Sarah"
    # (mature, reassuring — fits a nurse). NOTE: free-tier API keys cannot use
    # *library* voices (e.g. Rachel 21m00...) — they 402. Premade voices in the
    # account's own list work; list yours via GET /v1/voices.
    elevenlabs_voice_id: str = "EXAVITQu4vr4xnSDxMaL"
    # Low-latency multilingual model so non-English patient names speak well.
    elevenlabs_model_id: str = "eleven_turbo_v2_5"
    elevenlabs_output_format: str = "mp3_44100_128"

    # ── Telegram caregiver alerts ────────────────────────────────────────
    # Send-only bot. Both empty = feature off everywhere (notifier soft-fails,
    # /api/device/notify returns 503, cycle/flag hooks no-op). Get a token from
    # @BotFather; find chat_id via GET /bot<token>/getUpdates after messaging
    # the bot once.
    telegram_bot_token: str = ""
    telegram_chat_id: str = ""
    # Fire on every failed (non-stub) dispense cycle.
    telegram_notify_on_failed_cycle: bool = True
    # Fire one batched message per flag-detector run with new warning/critical flags.
    telegram_notify_on_flags: bool = True

    model_config = {"env_file": ".env", "extra": "ignore"}

    @property
    def device_tokens_set(self) -> set[str]:
        return {t.strip() for t in self.device_tokens.split(",") if t.strip()}

    @property
    def intake_label_required_set(self) -> set[str]:
        """Lowercased set of required labels for Layer-2 intake hard gate.
        Compared (case-insensitive) against label names from DetectLabels.
        """
        return {
            x.strip().lower()
            for x in self.intake_label_required.split(",")
            if x.strip()
        }

    def model_post_init(self, _ctx) -> None:
        # Resolve the queue path default at instance time so Path.home() works
        # regardless of import-time cwd (mattered on the Pi where root vs `pi`
        # vs `user` HOME differ — see edge_pi/config.py:96-103 history).
        if not self.offline_queue_path:
            object.__setattr__(
                self,
                "offline_queue_path",
                str(Path.home() / ".pharmguard" / "queue.db"),
            )

    def validate_runtime(self) -> None:
        """Production invariants. Raises RuntimeError on misconfig.

        NOT named ``validate()`` to avoid shadowing pydantic's internal
        validate. Call from main.py:lifespan AFTER instance load. The
        lifespan is the right place because BACKEND_HEADLESS=1 (dev mac)
        legitimately skips most checks — at import time we don't yet know
        which mode we're in.
        """
        if not self.supabase_url or not self.supabase_key:
            raise RuntimeError("SUPABASE_URL and SUPABASE_KEY are required")
        # In stub or headless mode we skip the device-key length check —
        # those modes are explicitly for dev / test and don't expose ngrok.
        if not self.backend_headless and not self.pharmguard_stub:
            if len(self.device_api_key) < 16:
                raise RuntimeError(
                    "DEVICE_API_KEY must be >=16 chars in non-stub mode "
                    "(generate via `python -c 'import secrets;print(secrets.token_urlsafe(32))'`)"
                )


settings = Settings()
