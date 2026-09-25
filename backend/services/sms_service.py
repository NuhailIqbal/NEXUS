import httpx
import logging
from config import settings
from database import supabase
from services.encryption import decrypt_config

logger = logging.getLogger(__name__)


async def _platform_number_credentials(user_id: str, from_number: str) -> tuple[str, str] | None:
    """If `from_number` is one of this user's own platform-purchased numbers, SMS
    through it must use the platform's own Twilio account (the one that actually
    owns the number) — the user's separate Integrations Twilio account has no
    authority over a number it didn't purchase, and Twilio would reject the send."""
    if not from_number or not settings.twilio_account_sid or not settings.twilio_auth_token:
        return None
    owned = (
        supabase.table("phone_numbers")
        .select("id")
        .eq("user_id", user_id)
        .eq("number", from_number)
        .eq("provider", "twilio")
        .limit(1)
        .execute()
    )
    if owned.data:
        return settings.twilio_account_sid, settings.twilio_auth_token
    return None


async def _get_twilio_config(user_id: str) -> dict | None:
    # Twilio is categorised as "voice" by the frontend categorize() function
    result = (
        supabase.table("integrations")
        .select("config_encrypted, name, category")
        .eq("user_id", user_id)
        .eq("status", "Active")
        .execute()
    )
    for row in (result.data or []):
        if row.get("config_encrypted"):
            try:
                config = decrypt_config(row["config_encrypted"])
                # Twilio configs have both 'sid' and 'token' keys
                if config.get("sid") and config.get("token"):
                    return config
            except Exception:
                continue
    return None


async def send_sms(user_id: str, to: str, message: str, from_number: str = "") -> bool:
    if not to:
        raise ValueError("No phone number to send SMS to.")

    platform_creds = await _platform_number_credentials(user_id, from_number)
    from_num = from_number

    if platform_creds:
        sid, token = platform_creds
    else:
        config = await _get_twilio_config(user_id)
        if not config:
            raise ValueError(
                "No Twilio integration configured. "
                "Go to Integrations and add your Twilio SID and Token."
            )
        sid = config["sid"]
        token = config["token"]
        from_num = from_number or config.get("fromNumber") or config.get("from_number") or ""

    if not from_num:
        raise ValueError(
            "No 'From' phone number set for SMS. "
            "Add it in the SMS node config or your Twilio integration."
        )

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json",
            auth=(sid, token),
            data={"From": from_num, "To": to, "Body": message},
        )
        if resp.status_code not in (200, 201):
            raise ValueError(f"Twilio API error {resp.status_code}: {resp.text[:200]}")

    logger.info(f"SMS sent to {to} via Twilio")
    return True
