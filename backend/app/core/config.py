"""Application configuration loaded from environment variables."""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    supabase_url: str = ""
    supabase_key: str = ""  # service_role key for backend
    secret_key: str = "dev-secret-change-in-production"
    gemini_api_key: str = ""
    device_tokens: str = ""
    default_dispenser_id: str = "dispenser-001"
    face_match_tolerance: float = 0.6
    # Phase 5 — alerts thresholds
    expiry_warn_days: int = 14
    low_stock_threshold: int = 3
    over_temp_celsius: float = 30.0

    model_config = {"env_file": ".env"}

    @property
    def device_tokens_set(self) -> set[str]:
        return {t.strip() for t in self.device_tokens.split(",") if t.strip()}


settings = Settings()
