import logging
from pathlib import Path
from pydantic import model_validator
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
    # Background auto-sync: pull recent VAPI calls (recording + transcript) into
    # conversations on a timer, so new calls appear without the manual button.
    # Set interval to 0 to disable. Requires vapi_api_key.
    vapi_sync_interval_seconds: int = 90
    vapi_sync_limit: int = 50

    # Gemini
    gemini_api_key: str = ""

    # OpenAI (used for the agent "Test" feature)
    openai_api_key: str = ""

    # Stripe
    stripe_secret_key: str = ""
    stripe_webhook_secret: str = ""
    # Publishable key, served to the frontend via GET /billing/config so it always
    # matches the secret key's mode (test vs live) without a frontend rebuild.
    # Accepts either STRIPE_PUBLISHABLE_KEY or the legacy VITE_STRIPE_PUBLIC_KEY name.
    stripe_publishable_key: str = ""
    vite_stripe_public_key: str = ""

    @property
    def active_stripe_publishable_key(self) -> str:
        return self.stripe_publishable_key or self.vite_stripe_public_key

    # Twilio (platform account) — one-time server config; used to auto-purchase numbers
    twilio_account_sid: str = ""
    twilio_auth_token: str = ""
    # Estimated Twilio carrier cost per minute (numbers are Twilio-bought / VAPI-imported,
    # so the PSTN leg is billed by Twilio and NOT included in VAPI's per-call cost).
    twilio_cost_per_minute_outbound: float = 0.014
    twilio_cost_per_minute_inbound: float = 0.0085

    # Admin
    admin_emails: str = ""  # comma-separated admin emails
    # Admin-portal login. Defaults keep local dev working; PRODUCTION MUST override
    # ADMIN_PASSWORD (and ideally ADMIN_USERNAME) with a strong secret via env.
    admin_username: str = "qarib"
    admin_password: str = "test123"
    # Optional second admin account — both vars must be set to enable.
    admin_username_2: str = ""
    admin_password_2: str = ""
    # Optional third admin account — both vars must be set to enable.
    admin_username_3: str = ""
    admin_password_3: str = ""

    # Server
    cors_origins: str = "http://localhost:5173,http://localhost:3000"
    public_api_url: str = ""  # publicly reachable URL of this backend; used in VAPI tool callbacks
    # Public URL of the FRONTEND app, used to build Stripe redirect (success/cancel) URLs
    # so users return to the deployed site, not localhost. e.g. https://app.edmnexus.ai
    public_app_url: str = ""
    # One-time welcome bonus (wallet dollars) granted to every NEW user on signup, so they
    # can set up + test an agent before reloading. Set to 0 to disable the promo.
    # (Admin platform_settings, when present, overrides these at runtime.)
    signup_bonus_credits: float = 20.0
    signup_bonus_expiry_days: int = 60  # promo credit expires this many days after signup

    # System (transactional) email — sent directly via Python's smtplib (NOT a per-user
    # integration), used for signup/verification emails. If no username/password is set,
    # verification links are logged/returned for dev instead of emailed.
    system_smtp_host: str = "smtp.gmail.com"
    system_smtp_port: int = 587
    system_smtp_username: str = ""
    system_smtp_password: str = ""  # must be a Gmail App Password, not the account password
    # Gmail rejects a From header that isn't the authenticated account (or a configured
    # "Send As" alias) — keep this equal to system_smtp_username unless you've set one up.
    system_email_from: str = "noreply@edmnexus.ai"
    system_email_from_name: str = "EDM Nexus"

    @model_validator(mode="after")
    def _normalize_smtp_from(self) -> "Settings":
        # Gmail rejects a From address that doesn't match the authenticated account.
        if self.system_smtp_username and (
            not self.system_email_from or self.system_email_from == "noreply@edmnexus.ai"
        ):
            self.system_email_from = self.system_smtp_username
        return self

    @property
    def system_smtp_configured(self) -> bool:
        return bool(self.system_smtp_username and self.system_smtp_password)

    @property
    def admin_email_list(self) -> list[str]:
        return [e.strip().lower() for e in self.admin_emails.split(",") if e.strip()]

    def verify_admin_login(self, username: str, password: str) -> bool:
        """Return True if username/password match any configured platform admin."""
        pairs = [(self.admin_username, self.admin_password)]
        if self.admin_username_2 and self.admin_password_2:
            pairs.append((self.admin_username_2, self.admin_password_2))
        if self.admin_username_3 and self.admin_password_3:
            pairs.append((self.admin_username_3, self.admin_password_3))
        return any(username == u and password == p for u, p in pairs)

    @property
    def allowed_origins(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def is_production(self) -> bool:
        return self.environment.lower() == "production"


settings = Settings()

_log = logging.getLogger(__name__)
if settings.system_smtp_configured:
    _log.info(
        "System SMTP ready (%s via %s:%s)",
        settings.system_email_from,
        settings.system_smtp_host,
        settings.system_smtp_port,
    )
else:
    _log.warning(
        "System SMTP not configured — verification emails will return dev links instead of sending"
    )

# Startup checks — warn but don't block if optional services aren't configured yet.
if settings.is_production:
    if not settings.vapi_webhook_secret:
        _log.warning("VAPI_WEBHOOK_SECRET not set — VAPI webhook signature verification is disabled")
    if not settings.cors_origins or "localhost" in settings.cors_origins:
        _log.warning("CORS_ORIGINS is not set to a production domain")
    if settings.admin_password == "test123":
        _log.warning("ADMIN_PASSWORD is still the default — set a strong ADMIN_PASSWORD in production")
    if settings.admin_password_2 == "test123":
        _log.warning("ADMIN_PASSWORD_2 is still the default — set a strong ADMIN_PASSWORD_2 in production")
    if settings.admin_password_3 == "test123":
        _log.warning("ADMIN_PASSWORD_3 is still the default — set a strong ADMIN_PASSWORD_3 in production")
