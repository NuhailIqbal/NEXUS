"""
Twilio number provisioning.

By default, uses the one-time server-configured platform Twilio credentials
(TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN) to search for and purchase an
available US phone number. The purchased number is then imported into VAPI
by the telephony router so an AI agent can use it.

BYOT (Bring Your Own Twilio): every function also accepts an optional
account_sid/auth_token pair — when given, that Twilio account is used instead
of the platform's, so the purchase/release is billed directly to the user's
own Twilio account rather than ours.
"""
import httpx

from config import settings

# Twilio REST API root (dated API version). Every resource used here lives under
# /Accounts/{AccountSid}/..., authenticated with HTTP Basic auth (account SID + auth token).
TWILIO_BASE = "https://api.twilio.com/2010-04-01"


def _resolve_creds(account_sid: str | None, auth_token: str | None) -> tuple[str, str]:
    """Pick the (account_sid, auth_token) pair to call Twilio with: explicit BYOT values
    win, otherwise the platform credentials from settings.

    Each value falls back independently, so callers must pass both or neither (every
    caller does) — passing only one would pair it with the platform's other half.
    Raises RuntimeError if either value is still empty after the fallback.
    """
    sid = account_sid or settings.twilio_account_sid
    token = auth_token or settings.twilio_auth_token
    if not sid or not token:
        raise RuntimeError("Twilio account is not configured.")
    return sid, token


async def buy_us_number(sms: bool = True, voice: bool = True, area_code: str | None = None,
                        account_sid: str | None = None, auth_token: str | None = None) -> dict:
    """Search for and purchase an available US local number on the given Twilio
    account (the platform account by default, or a user's own BYOT account when
    account_sid/auth_token are passed).

    Returns {"number": "+1...", "sid": "PN..."}.
    Raises RuntimeError on any failure (no creds, none available, purchase error).
    """
    sid, token = _resolve_creds(account_sid, auth_token)

    auth = (sid, token)
    async with httpx.AsyncClient(timeout=30) as client:
        # 1) Find an available US local number with the required capabilities.
        # PageSize=1: only the first candidate is ever used, so don't fetch a longer list.
        params: dict = {"PageSize": 1}
        if voice:
            params["VoiceEnabled"] = "true"
        if sms:
            params["SmsEnabled"] = "true"
        area_code = (area_code or "").strip()
        if area_code:
            params["AreaCode"] = area_code
        r = await client.get(
            f"{TWILIO_BASE}/Accounts/{sid}/AvailablePhoneNumbers/US/Local.json",
            params=params,
            auth=auth,
        )
        # Twilio error bodies are truncated to 200 chars in the RuntimeErrors raised here: the
        # telephony router puts str(e) into its HTTP error detail, so a long body must not leak through.
        if r.status_code >= 400:
            raise RuntimeError(f"Twilio search failed ({r.status_code}): {r.text[:200]}")
        available = r.json().get("available_phone_numbers", [])
        if not available and area_code:
            # Fall back to any area code rather than failing outright — matches the
            # "best effort" tone of the rest of this module (e.g. find_sid_by_number).
            # A separate dict (not params.pop(...) on the one already sent above) so the
            # first request's own param set is never mutated out from under it.
            fallback_params = {k: v for k, v in params.items() if k != "AreaCode"}
            r = await client.get(
                f"{TWILIO_BASE}/Accounts/{sid}/AvailablePhoneNumbers/US/Local.json",
                params=fallback_params,
                auth=auth,
            )
            if r.status_code < 400:
                available = r.json().get("available_phone_numbers", [])
        if not available:
            raise RuntimeError("No available US numbers found on the Twilio account.")
        number = available[0]["phone_number"]

        # 2) Purchase the number.
        # This is the step that actually creates a billable Twilio resource; nothing here
        # rolls it back, so a caller whose later steps fail must call release_number itself.
        r2 = await client.post(
            f"{TWILIO_BASE}/Accounts/{sid}/IncomingPhoneNumbers.json",
            data={"PhoneNumber": number},
            auth=auth,
        )
        if r2.status_code >= 400:
            raise RuntimeError(f"Twilio purchase failed ({r2.status_code}): {r2.text[:200]}")
        body = r2.json()
        # Prefer the number Twilio echoes back; fall back to the one we asked for.
        return {"number": body.get("phone_number", number), "sid": body.get("sid")}


async def release_number(sid: str, account_sid: str | None = None, auth_token: str | None = None) -> None:
    """Release (cancel) a purchased number — without this, a Twilio number keeps being
    billed monthly forever even after it's removed from our own database, since
    deleting our record never told Twilio itself.
    Raises RuntimeError on failure; a 404 (already released) is treated as success."""
    account, token = _resolve_creds(account_sid, auth_token)

    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.delete(
            f"{TWILIO_BASE}/Accounts/{account}/IncomingPhoneNumbers/{sid}.json",
            auth=(account, token),
        )
        # 204 = released now, 404 = already gone — both leave the desired end state, which
        # keeps release idempotent for retries and for numbers someone already removed.
        if r.status_code not in (204, 404):
            raise RuntimeError(f"Twilio release failed ({r.status_code}): {r.text[:200]}")


async def find_sid_by_number(number: str, account_sid: str | None = None, auth_token: str | None = None) -> str | None:
    """Best-effort lookup for numbers purchased before twilio_sid was saved locally."""
    # Missing credentials mean "can't look it up", not an error. Network failures from
    # httpx below are NOT caught here; callers must handle them.
    try:
        account, token = _resolve_creds(account_sid, auth_token)
    except RuntimeError:
        return None
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.get(
            f"{TWILIO_BASE}/Accounts/{account}/IncomingPhoneNumbers.json",
            params={"PhoneNumber": number},
            auth=(account, token),
        )
        if r.status_code >= 400:
            return None
        found = r.json().get("incoming_phone_numbers", [])
        return found[0]["sid"] if found else None


async def validate_credentials(account_sid: str, auth_token: str) -> bool:
    """True if these Twilio credentials are valid and the account is active —
    used to reject bad input immediately when a user connects their own Twilio
    account, rather than failing later on first use."""
    # Fetching the Account resource itself is the cheapest authenticated call: it returns
    # 200 only when the SID/token pair is right. Unlike the other helpers this does not use
    # _resolve_creds (the pair must be the caller's, never the platform fallback), and
    # transport errors propagate so twilio_byot_service can tell "Twilio unreachable"
    # apart from "credentials rejected".
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(
            f"{TWILIO_BASE}/Accounts/{account_sid}.json",
            auth=(account_sid, auth_token),
        )
        if r.status_code != 200:
            return False
        # A 200 alone isn't enough: only an account whose status is "active" is accepted, so
        # a suspended or closed account is rejected even though the login itself worked.
        return (r.json().get("status") or "").lower() == "active"
