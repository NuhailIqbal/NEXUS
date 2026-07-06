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

    # Database (plain PostgreSQL) — replaces Supabase Postgres/PostgREST
    database_url: str = ""  # e.g. postgresql://user:pass@localhost:5432/nexus

    # Auth (own JWT) — replaces Supabase Auth. Falls back to supabase_jwt_secret during transition.
    jwt_secret: str = ""

    # Local object storage — replaces Supabase Storage
    storage_dir: str = ""  # absolute path for uploaded files (defaults to backend/_storage)

    # Supabase (unused — kept for backward compatibility during transition)
    supabase_url: str = ""
    supabase_service_role_key: str = ""
    supabase_jwt_secret: str = ""

    @property
    def active_jwt_secret(self) -> str:
        """Secret used to sign/verify our own JWTs (prefers JWT_SECRET, falls back to Supabase's)."""
        return self.jwt_secret or self.supabase_jwt_secret

    # VAPI
    vapi_api_key: str = ""
    vapi_webhook_secret: str = ""
    vapi_public_key: str = ""  # used by the @vapi-ai/web SDK on embedded voice widgets

    # Gemini
    gemini_api_key: str = ""

    # Stripe
    stripe_secret_key: str = ""
    stripe_webhook_secret: str = ""

    # Admin
    admin_emails: str = ""  # comma-separated admin emails

    # Server
    cors_origins: str = "http://localhost:5173,http://localhost:3000"
    public_api_url: str = ""  # publicly reachable URL of this backend; used in VAPI tool callbacks

    @property
    def admin_email_list(self) -> list[str]:
        return [e.strip().lower() for e in self.admin_emails.split(",") if e.strip()]

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
