import httpx
import logging
from database import supabase
from services.encryption import decrypt_config

logger = logging.getLogger(__name__)


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
