"""
Vonage (Nexmo) number operations for BYOT.

Only ever used with a user's own Vonage account (the platform has none). The account is
identified by its API key + API secret, sent as query/form parameters on rest.nexmo.com.
Same shape as twilio_service: small async functions that raise RuntimeError on failure.
"""
import httpx

VONAGE_BASE = "https://rest.nexmo.com"


def _digits(number: str) -> str:
    """Vonage numbers (msisdn) are digits only, no leading '+'."""
    return "".join(ch for ch in (number or "") if ch.isdigit())


def _auth(api_key: str, api_secret: str) -> dict:
    return {"api_key": api_key, "api_secret": api_secret}


async def validate_credentials(api_key: str, api_secret: str) -> bool:
    """True if Vonage accepts this key/secret pair (balance lookup is the cheapest call),
    False if it rejects them. Any other answer (rate limit, outage) raises RuntimeError so
    the caller can say "try again" instead of wrongly blaming the credentials."""
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(f"{VONAGE_BASE}/account/get-balance", params=_auth(api_key, api_secret))
        if r.status_code == 200:
            return True
        if r.status_code in (401, 403):
            return False
        raise RuntimeError(f"Vonage credential check failed ({r.status_code})")


async def find_number(number: str, api_key: str, api_secret: str) -> str | None:
    """The msisdn if this exact number is owned by the account, else None. Best effort:
    any API error reads as "not found"."""
    digits = _digits(number)
    if not digits:
        return None
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.get(
            f"{VONAGE_BASE}/account/numbers",
            params={**_auth(api_key, api_secret), "pattern": digits, "search_pattern": 1},
        )
        if r.status_code >= 400:
            return None
        for owned in r.json().get("numbers") or []:
            if owned.get("msisdn") == digits:
                return digits
    return None


async def buy_us_number(api_key: str, api_secret: str, area_code: str | None = None) -> dict:
    """Search for and buy an available US voice number on the account.

    Returns {"number": "+1...", "ref": "<msisdn>"}. Raises RuntimeError on any failure.
    With an area code that has nothing available, falls back to any area code.
    """
    async with httpx.AsyncClient(timeout=30) as client:
        params: dict = {**_auth(api_key, api_secret), "country": "US", "features": "VOICE", "size": 1}
        area_code = (area_code or "").strip()
        if area_code:
            params["pattern"] = f"1{area_code}"
            params["search_pattern"] = 0  # starts with
        r = await client.get(f"{VONAGE_BASE}/number/search", params=params)
        if r.status_code >= 400:
            raise RuntimeError(f"Vonage search failed ({r.status_code}): {r.text[:200]}")
        available = r.json().get("numbers") or []
        if not available and area_code:
            fallback = {k: v for k, v in params.items() if k not in ("pattern", "search_pattern")}
            r = await client.get(f"{VONAGE_BASE}/number/search", params=fallback)
            if r.status_code < 400:
                available = r.json().get("numbers") or []
        if not available:
            raise RuntimeError("No available US numbers found on the Vonage account.")
        msisdn = available[0]["msisdn"]
        country = available[0].get("country") or "US"

        r2 = await client.post(
            f"{VONAGE_BASE}/number/buy",
            data={**_auth(api_key, api_secret), "country": country, "msisdn": msisdn},
        )
        body = r2.json() if r2.content else {}
        # Vonage answers 200 even for failures; success is error-code "200".
        if r2.status_code >= 400 or str(body.get("error-code")) != "200":
            raise RuntimeError(f"Vonage purchase failed: {body.get('error-code-label') or r2.text[:200]}")
        return {"number": f"+{msisdn}", "ref": msisdn}


async def release_number(number: str, api_key: str, api_secret: str, country: str = "US") -> None:
    """Cancel (release) a number from the account so it stops being billed by Vonage.
    Raises RuntimeError on failure."""
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(
            f"{VONAGE_BASE}/number/cancel",
            data={**_auth(api_key, api_secret), "country": country, "msisdn": _digits(number)},
        )
        body = r.json() if r.content else {}
        if r.status_code >= 400 or str(body.get("error-code")) != "200":
            raise RuntimeError(f"Vonage release failed: {body.get('error-code-label') or r.text[:200]}")
