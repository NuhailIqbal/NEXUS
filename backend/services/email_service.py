import asyncio
import smtplib
import httpx
import logging
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from database import supabase
from services.encryption import decrypt_config
from services.integration_test import detect_provider
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


async def _get_email_config(user_id: str, integration_id: str | None = None) -> dict | None:
    query = (
        supabase.table("integrations")
        .select("id, config_encrypted, name")
        .eq("user_id", user_id)
        .eq("category", "email")
        .eq("status", "Active")
    )
    # A specific integration was picked on the node — that one or nothing (falling through
    # to whatever comes first would silently send from the wrong provider).
    if integration_id:
        query = query.eq("id", integration_id)
    result = query.execute()
    for row in (result.data or []):
        if row.get("config_encrypted"):
            try:
                config = decrypt_config(row["config_encrypted"])
                if config.get("apiKey") or config.get("host"):
                    config["_integration_name"] = row.get("name", "")
                    return config
            except Exception:
                continue
    return None


async def _send_via_brevo(config: dict, to: str, subject: str, body: str) -> None:
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


async def _send_via_sendgrid(config: dict, to: str, subject: str, body: str) -> None:
    api_key = config["apiKey"]
    from_email = config.get("fromEmail") or "noreply@edmnexus.ai"

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            "https://api.sendgrid.com/v3/mail/send",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={
                "personalizations": [{"to": [{"email": to}]}],
                "from": {"email": from_email, "name": "EDM Nexus"},
                "subject": subject,
                "content": [{"type": "text/plain", "value": body or " "}],
            },
        )
        if resp.status_code not in (200, 201, 202):
            raise ValueError(f"SendGrid API error {resp.status_code}: {resp.text[:200]}")
    logger.info(f"Email sent to {to} via SendGrid (subject: {subject})")


def _smtp_send_sync(host: str, port: int, username: str, password: str, from_email: str, to: str, subject: str, body: str) -> None:
    msg = MIMEMultipart("alternative")
    msg["From"] = from_email
    msg["To"] = to
    msg["Subject"] = subject
    msg.attach(MIMEText(body or " ", "plain"))
    with smtplib.SMTP(host, port, timeout=15) as server:
        server.starttls()
        server.login(username, password)
        server.send_message(msg)


async def _send_via_smtp(config: dict, to: str, subject: str, body: str) -> None:
    host = (config.get("host") or "").strip()
    username = (config.get("username") or "").strip()
    password = (config.get("password") or "").strip()
    from_email = config.get("fromEmail") or username
    try:
        port = int(config.get("port") or 587)
    except (TypeError, ValueError):
        port = 587
    if not host or not username or not password:
        raise ValueError("SMTP integration is missing host, username or password")

    try:
        await asyncio.to_thread(_smtp_send_sync, host, port, username, password, from_email, to, subject, body)
    except (smtplib.SMTPException, OSError) as e:
        raise ValueError(f"SMTP send to {to} failed: {e}") from e
    logger.info(f"Email sent to {to} via SMTP (subject: {subject})")


async def send_email(user_id: str, to: str, subject: str, body: str, integration_id: str | None = None) -> bool:
    if not to or "@" not in to:
        raise ValueError(f"Invalid email address: '{to}'")

    config = await _get_email_config(user_id, integration_id)
    if not config:
        raise ValueError(
            "No matching email integration found. "
            "Go to Integrations and add a Brevo, SendGrid or SMTP integration."
            if integration_id else
            "No email integration configured. "
            "Go to Integrations and add a Brevo, SendGrid or SMTP integration."
        )

    match = detect_provider(config.get("_integration_name", ""), "email", config)
    label = match[0] if match else "Brevo"

    if label == "SendGrid":
        await _send_via_sendgrid(config, to, subject, body)
    elif label == "SMTP":
        await _send_via_smtp(config, to, subject, body)
    else:
        await _send_via_brevo(config, to, subject, body)
    return True
