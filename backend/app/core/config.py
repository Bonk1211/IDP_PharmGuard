"""Application configuration loaded from environment variables."""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "sqlite:///./pharmguard.db"
    secret_key: str = "dev-secret-change-in-production"
    gemini_api_key: str = ""

    model_config = {"env_file": ".env"}


settings = Settings()
