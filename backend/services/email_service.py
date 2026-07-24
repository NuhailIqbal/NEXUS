import asyncio
import smtplib
import httpx
import logging
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from database import supabase
from services.encryption import decrypt_config
from config import settings

logger = logging.getLogger(__name__)


def _send_sync(msg: MIMEMultipart, to: str) -> None:
    with smtplib.SMTP(settings.system_smtp_host, settings.system_smtp_port, timeout=15) as server:
        server.starttls()
        server.login(settings.system_smtp_username, settings.system_smtp_password)
        server.send_message(msg)


async def send_system_email(to: str, subject: str, html: str, text: str = "") -> bool:
    """Send a transactional email from the PLATFORM (e.g. email verification) directly via
    smtplib (Gmail SMTP) — not a per-user integration. Returns True if actually sent; False
    (dev fallback) if no SMTP credentials are configured (caller should surface the link)."""
    if not to or "@" not in to:
        raise ValueError(f"Invalid email address: '{to}'")
    if not settings.system_smtp_configured:
        logger.warning("system SMTP credentials not set — email to %s NOT sent (dev fallback).", to)
        return False

    msg = MIMEMultipart("alternative")
    msg["From"] = f"{settings.system_email_from_name} <{settings.system_email_from}>"
    msg["To"] = to
    msg["Subject"] = subject
    msg.attach(MIMEText(text or " ", "plain"))
    msg.attach(MIMEText(html, "html"))

    try:
        await asyncio.to_thread(_send_sync, msg, to)
    except (smtplib.SMTPException, OSError) as e:
        raise ValueError(f"SMTP send to {to} failed: {e}") from e

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
