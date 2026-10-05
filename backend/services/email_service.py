"""Outbound email for the platform, in two independent paths.

1. send_system_email: platform transactional mail (email verification in routers/auth.py,
   team invites in routers/team.py), sent over the platform's own SMTP account from
   settings.system_smtp_*. Not tied to any user's integrations.
2. send_email: mail sent on behalf of a user (the agent "send_email" tool in
   routers/agent_tool_callbacks.py and the email node in services/automation_engine.py),
   using that user's Active email row in the `integrations` table (Brevo, SendGrid or SMTP).
   Credentials are stored encrypted in integrations.config_encrypted.

Failures are raised, mostly as ValueError with a readable message (low-level httpx errors from
the Brevo/SendGrid HTTP calls are not wrapped); callers decide how to surface them.
"""
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
    """Blocking SMTP delivery of an already-built message through the platform's SMTP
    account (STARTTLS, then login). Run in a worker thread by send_system_email. The `to`
    argument is not used; the recipient comes from msg["To"]."""
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
    # Without platform SMTP credentials nothing is sent and no error is raised; the False
    # return lets callers (e.g. email verification) fall back to showing the link directly.
    if not settings.system_smtp_configured:
        logger.warning("system SMTP credentials not set — email to %s NOT sent (dev fallback).", to)
        return False

    msg = MIMEMultipart("alternative")
    msg["From"] = f"{settings.system_email_from_name} <{settings.system_email_from}>"
    msg["To"] = to
    msg["Subject"] = subject
    # Plain-text part first and HTML last: in multipart/alternative, clients show the last
    # part they support. The plain part falls back to a space so it is never empty.
    msg.attach(MIMEText(text or " ", "plain"))
    msg.attach(MIMEText(html, "html"))

    try:
        # smtplib is blocking, so it runs in a thread to keep the event loop free.
        await asyncio.to_thread(_send_sync, msg, to)
    except (smtplib.SMTPException, OSError) as e:
        raise ValueError(f"SMTP send to {to} failed: {e}") from e

    logger.info("System email sent to %s (subject: %s)", to, subject)
    return True


async def _get_email_config(user_id: str, integration_id: str | None = None) -> dict | None:
    """Load and decrypt the user's email integration config from the `integrations` table.

    Considers only rows owned by `user_id` with category "email" and status "Active"; if
    `integration_id` is given, only that row. Returns the first row whose config decrypts and
    has an `apiKey` (Brevo/SendGrid) or `host` (SMTP), with the row's name added under
    "_integration_name" (used to detect the provider). Returns None if nothing usable is found.
    """
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
                # Skip a row whose config cannot be decrypted (e.g. encrypted under a
                # different key) and try the next one.
                continue
    return None


async def _send_via_brevo(config: dict, to: str, subject: str, body: str) -> None:
    """Send a plain-text email through Brevo's transactional API (POST /v3/smtp/email).
    Uses config["apiKey"] and config["fromEmail"] (default sender address if unset).
    Raises ValueError if Brevo responds with a non-2xx status."""
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
    """Send a plain-text email through SendGrid's v3 Mail Send API.
    Uses config["apiKey"] and config["fromEmail"] (default sender address if unset).
    Raises ValueError if SendGrid responds with a non-2xx status."""
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
                # A single space stands in for an empty body so the content value is never empty.
                "content": [{"type": "text/plain", "value": body or " "}],
            },
        )
        if resp.status_code not in (200, 201, 202):
            raise ValueError(f"SendGrid API error {resp.status_code}: {resp.text[:200]}")
    logger.info(f"Email sent to {to} via SendGrid (subject: {subject})")


def _smtp_send_sync(host: str, port: int, username: str, password: str, from_email: str, to: str, subject: str, body: str) -> None:
    """Blocking plain-text SMTP delivery using a user's own SMTP credentials (STARTTLS,
    then login). Run in a worker thread by _send_via_smtp."""
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
    """Send a plain-text email through the user's own SMTP server, taken from config
    (host, port, username, password, optional fromEmail). Raises ValueError if host,
    username or password is missing, or if the SMTP send fails."""
    host = (config.get("host") or "").strip()
    username = (config.get("username") or "").strip()
    password = (config.get("password") or "").strip()
    # With no fromEmail configured, the sender defaults to the SMTP login username.
    from_email = config.get("fromEmail") or username
    try:
        # 587 is the standard STARTTLS submission port; used when the port is absent or not numeric.
        port = int(config.get("port") or 587)
    except (TypeError, ValueError):
        port = 587
    if not host or not username or not password:
        raise ValueError("SMTP integration is missing host, username or password")

    try:
        # smtplib is blocking, so it runs in a thread to keep the event loop free.
        await asyncio.to_thread(_smtp_send_sync, host, port, username, password, from_email, to, subject, body)
    except (smtplib.SMTPException, OSError) as e:
        raise ValueError(f"SMTP send to {to} failed: {e}") from e
    logger.info(f"Email sent to {to} via SMTP (subject: {subject})")


async def send_email(user_id: str, to: str, subject: str, body: str, integration_id: str | None = None) -> bool:
    """Send a plain-text email on behalf of a user through one of their email integrations.

    Args:
        user_id: Owner whose Active email integration is used.
        to: Recipient address (only a basic "@" check is done).
        subject: Subject line.
        body: Plain-text body.
        integration_id: Optional specific integration (the automation email node can pick
            one). If set, only that integration is used; if it is not found or not usable
            the call fails instead of falling back to another provider.

    Returns True on success. Raises ValueError for an invalid recipient, a missing
    integration, or a provider/SMTP failure. Callers: the agent send_email tool callback and
    the automation engine's email node.
    """
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

    # The provider comes from config["provider"] if present, otherwise from keywords in the
    # integration's name. If it cannot be determined, Brevo is assumed (the final else below).
    match = detect_provider(config.get("_integration_name", ""), "email", config)
    label = match[0] if match else "Brevo"

    if label == "SendGrid":
        await _send_via_sendgrid(config, to, subject, body)
    elif label == "SMTP":
        await _send_via_smtp(config, to, subject, body)
    else:
        await _send_via_brevo(config, to, subject, body)
    return True
