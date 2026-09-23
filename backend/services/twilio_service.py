"""
Twilio number provisioning (platform account).

Uses the one-time server-configured Twilio credentials
(TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN) to search for and purchase an
available US phone number. The purchased number is then imported into VAPI
by the telephony router so an AI agent can use it.
"""
import httpx

from config import settings

TWILIO_BASE = "https://api.twilio.com/2010-04-01"


async def buy_us_number(sms: bool = True, voice: bool = True) -> dict:
    """Search for and purchase an available US local number on the platform Twilio account.

    Returns {"number": "+1...", "sid": "PN..."}.
    Raises RuntimeError on any failure (no creds, none available, purchase error).
    """
    sid = settings.twilio_account_sid
    token = settings.twilio_auth_token
    if not sid or not token:
        raise RuntimeError("Twilio account is not configured on the server.")

    auth = (sid, token)
    async with httpx.AsyncClient(timeout=30) as client:
        # 1) Find an available US local number with the required capabilities.
        params: dict = {"PageSize": 1}
        if voice:
            params["VoiceEnabled"] = "true"
        if sms:
            params["SmsEnabled"] = "true"
        r = await client.get(
            f"{TWILIO_BASE}/Accounts/{sid}/AvailablePhoneNumbers/US/Local.json",
            params=params,
            auth=auth,
        )
        if r.status_code >= 400:
            raise RuntimeError(f"Twilio search failed ({r.status_code}): {r.text[:200]}")
        available = r.json().get("available_phone_numbers", [])
        if not available:
            raise RuntimeError("No available US numbers found on the Twilio account.")
        number = available[0]["phone_number"]

        # 2) Purchase the number.
        r2 = await client.post(
            f"{TWILIO_BASE}/Accounts/{sid}/IncomingPhoneNumbers.json",
            data={"PhoneNumber": number},
            auth=auth,
        )
        if r2.status_code >= 400:
            raise RuntimeError(f"Twilio purchase failed ({r2.status_code}): {r2.text[:200]}")
        body = r2.json()
        return {"number": body.get("phone_number", number), "sid": body.get("sid")}


async def release_number(sid: str) -> None:
    """Release (cancel) a purchased number from the platform Twilio account — without
    this, a Twilio number keeps being billed monthly forever even after it's removed
    from our own database, since deleting our record never told Twilio itself.
    Raises RuntimeError on failure; a 404 (already released) is treated as success."""
    account_sid = settings.twilio_account_sid
    token = settings.twilio_auth_token
    if not account_sid or not token:
        raise RuntimeError("Twilio account is not configured on the server.")

    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.delete(
            f"{TWILIO_BASE}/Accounts/{account_sid}/IncomingPhoneNumbers/{sid}.json",
            auth=(account_sid, token),
        )
        if r.status_code not in (204, 404):
            raise RuntimeError(f"Twilio release failed ({r.status_code}): {r.text[:200]}")


async def find_sid_by_number(number: str) -> str | None:
    """Best-effort lookup for numbers purchased before twilio_sid was saved locally."""
    account_sid = settings.twilio_account_sid
    token = settings.twilio_auth_token
    if not account_sid or not token:
        return None
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.get(
            f"{TWILIO_BASE}/Accounts/{account_sid}/IncomingPhoneNumbers.json",
            params={"PhoneNumber": number},
            auth=(account_sid, token),
        )
        if r.status_code >= 400:
            return None
        found = r.json().get("incoming_phone_numbers", [])
        return found[0]["sid"] if found else None
