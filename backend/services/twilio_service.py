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
