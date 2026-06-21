import os
from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


# Resolve .env to an absolute path so the backend works from any cwd (including Docker).
# Search order: backend/.env, project-root/.env, ../.env relative to this file.
_HERE = Path(__file__).resolve().parent
_ENV_CANDIDATES = [
    _HERE / ".env",
    _HERE.parent / ".env",
]
_ENV_FILE = next((str(p) for p in _ENV_CANDIDATES if p.exists()), None)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=_ENV_FILE,
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Environment
    environment: str = "development"  # "development" | "production"

    # Supabase
    supabase_url: str
    supabase_service_role_key: str
    supabase_jwt_secret: str

    # VAPI
    vapi_api_key: str = ""
    vapi_webhook_secret: str = ""
    vapi_public_key: str = ""  # used by the @vapi-ai/web SDK on embedded voice widgets

    # Gemini
    gemini_api_key: str = ""

    # Server
    cors_origins: str = "http://localhost:5173,http://localhost:3000"
    public_api_url: str = ""  # publicly reachable URL of this backend; used in VAPI tool callbacks

    @property
    def allowed_origins(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def is_production(self) -> bool:
        return self.environment.lower() == "production"


settings = Settings()


# Loud startup checks — fail fast if production is misconfigured.
if settings.is_production:
    missing: list[str] = []
    if not settings.vapi_webhook_secret:
        missing.append("VAPI_WEBHOOK_SECRET (required to verify VAPI webhook signatures)")
    if not settings.cors_origins or "localhost" in settings.cors_origins:
        missing.append("CORS_ORIGINS (must be set to your production frontend origin(s))")
    if missing:
        raise RuntimeError(
            "Refusing to start in production with missing/insecure config:\n  - "
            + "\n  - ".join(missing)
        )
