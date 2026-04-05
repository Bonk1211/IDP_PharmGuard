"""Application configuration loaded from environment variables."""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    supabase_url: str = ""
    supabase_key: str = ""  # service_role key for backend
    secret_key: str = "dev-secret-change-in-production"
    gemini_api_key: str = ""

    model_config = {"env_file": ".env"}


settings = Settings()
