import httpx
import logging
from database import supabase
from services.encryption import decrypt_config
from config import settings

logger = logging.getLogger(__name__)


async def send_system_email(to: str, subject: str, html: str, text: str = "") -> bool:
    """Send a transactional email from the PLATFORM (e.g. email verification), using the
    system Brevo key — not a per-user integration. Returns True if actually sent; False
    (dev fallback) if no system key is configured (caller should surface the link)."""
    if not to or "@" not in to:
        raise ValueError(f"Invalid email address: '{to}'")
    api_key = settings.system_email_api_key
    if not api_key:
        logger.warning("system_email_api_key not set — email to %s NOT sent (dev fallback).", to)
        return False
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            "https://api.brevo.com/v3/smtp/email",
            headers={"api-key": api_key, "Content-Type": "application/json"},
            json={
                "sender": {"name": settings.system_email_from_name, "email": settings.system_email_from},
                "to": [{"email": to}],
                "subject": subject,
                "htmlContent": html,
                "textContent": text or " ",
            },
        )
        if resp.status_code not in (200, 201, 202):
            raise ValueError(f"Brevo API error {resp.status_code}: {resp.text[:200]}")
    logger.info("System email sent to %s (subject: %s)", to, subject)
    return True


async def _get_email_config(user_id: str) -> dict | None:
    result = (
        supabase.table("integrations")
        .select("config_encrypted, name")
        .eq("user_id", user_id)
        .eq("category", "email")
        .eq("status", "Active")
        .execute()
    )
    for row in (result.data or []):
        if row.get("config_encrypted"):
            try:
                config = decrypt_config(row["config_encrypted"])
                if config.get("apiKey"):
                    config["_integration_name"] = row.get("name", "")
                    return config
            except Exception:
                continue
    return None


async def send_email(user_id: str, to: str, subject: str, body: str) -> bool:
    if not to or "@" not in to:
        raise ValueError(f"Invalid email address: '{to}'")

    config = await _get_email_config(user_id)
    if not config:
        raise ValueError(
            "No email integration configured. "
            "Go to Integrations and add your Brevo API key."
        )

    api_key = config["apiKey"]
    from_email = config.get("fromEmail") or "noreply@edmnexus.ai"

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            "https://api.brevo.com/v3/smtp/email",
            headers={"api-key": api_key, "Content-Type": "application/json"},
            json={
                "sender": {"name": "EDM Nexus", "email": from_email},
                "to": [{"email": to}],
                "subject": subject,
                "textContent": body,
            },
        )
        if resp.status_code not in (200, 201, 202):
            raise ValueError(f"Brevo API error {resp.status_code}: {resp.text[:200]}")

    logger.info(f"Email sent to {to} via Brevo (subject: {subject})")
    return True
