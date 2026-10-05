"""
Outbound SMS through Twilio's REST API.

Entry point: send_sms(). Called by the SMS node of the automation engine
(services/automation_engine.py) and by the agent's mid-call "send SMS" tool callback
(routers/agent_tool_callbacks.py). It reads `phone_numbers` and `integrations` to choose
which Twilio account to send from, then POSTs to Twilio; it writes nothing to the database.
"""
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
    # No explicit sender to match against, or the server has no platform Twilio account:
    # return None so the caller falls back to the user's own Twilio integration.
    if not from_number or not settings.twilio_account_sid or not settings.twilio_auth_token:
        return None
    # provider="twilio" is the platform-purchased kind. BYOT numbers ("twilio_byot") live on
    # the user's own Twilio account and VAPI-native numbers have no Twilio account at all,
    # so neither belongs to the platform credentials.
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
    """The decrypted config of the user's Twilio integration (from Integrations), or None.

    Scans the user's Active integrations and returns the first whose config has both 'sid'
    and 'token'. Twilio is recognised by that config shape, not by name or category, and
    there is no explicit ordering if several rows match.
    """
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
                # Undecryptable or corrupt blob — skip it and try the next row.
                continue
    return None


async def send_sms(user_id: str, to: str, message: str, from_number: str = "") -> bool:
    """Send one SMS from `user_id`'s Twilio setup. Returns True on success.

    Args:
        user_id: owner of the Twilio setup used to send.
        to: destination phone number.
        message: SMS body.
        from_number: optional sender. If it is one of the user's platform-purchased numbers,
            the platform Twilio account sends it. Otherwise the user's Twilio integration
            is used, and its saved default sender fills in when this is empty.

    Raises ValueError (with a user-facing message) when there is no recipient, no usable
    Twilio credentials, no sender number, or Twilio answers with an error; network errors
    from httpx propagate unchanged. Side effect: one HTTP POST to Twilio's Messages API.
    """
    if not to:
        raise ValueError("No phone number to send SMS to.")

    # Credentials are chosen by who owns the sender number: a platform-purchased number must
    # be sent through the platform account; anything else uses the user's own integration.
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
        # An explicit sender wins; otherwise use the integration's default sender, which may
        # be stored under either key spelling.
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
        # Twilio answers 201 Created for a queued message (200 is accepted too). The error body
        # is truncated because callers may surface str(e) (the agent tool callback returns it
        # to the agent verbatim).
        if resp.status_code not in (200, 201):
            raise ValueError(f"Twilio API error {resp.status_code}: {resp.text[:200]}")

    logger.info(f"SMS sent to {to} via Twilio")
    return True
