"""
Telnyx number operations for BYOT.

Only ever used with a user's own Telnyx account (the platform has none). Authenticated
with the account's API v2 key as a Bearer token. Same shape as twilio_service: small async
functions that raise RuntimeError on failure.
"""
import asyncio

import httpx

TELNYX_BASE = "https://api.telnyx.com/v2"

# Number orders can complete asynchronously. Poll briefly, then give up with a clear message.
ORDER_POLL_ATTEMPTS = 10
ORDER_POLL_SECONDS = 1.5


def _headers(api_key: str) -> dict:
    return {"Authorization": f"Bearer {api_key}"}


async def validate_credentials(api_key: str) -> bool:
    """True if Telnyx accepts this API key (balance lookup is the cheapest call), False if
    it rejects it. Any other answer (rate limit, outage) raises RuntimeError so the caller
    can say "try again" instead of wrongly blaming the key."""
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(f"{TELNYX_BASE}/balance", headers=_headers(api_key))
        if r.status_code == 200:
            return True
        if r.status_code in (401, 403):
            return False
        raise RuntimeError(f"Telnyx credential check failed ({r.status_code})")


async def find_number(number: str, api_key: str) -> str | None:
    """Telnyx's id for this exact number if the account owns it, else None. Best effort:
    any API error reads as "not found"."""
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.get(
            f"{TELNYX_BASE}/phone_numbers",
            params={"filter[phone_number]": number, "page[size]": 1},
            headers=_headers(api_key),
        )
        if r.status_code >= 400:
            return None
        found = r.json().get("data") or []
        return found[0].get("id") if found else None


async def buy_us_number(api_key: str, area_code: str | None = None) -> dict:
    """Search for and order an available US voice number on the account.

    Returns {"number": "+1...", "ref": "<telnyx phone number id>"}. Raises RuntimeError on
    any failure, or if the (asynchronous) order has not completed after a short wait — the
    number may still appear in the user's Telnyx account afterwards.
    With an area code that has nothing available, falls back to any area code.
    """
    headers = _headers(api_key)
    async with httpx.AsyncClient(timeout=30) as client:
        params: dict = {"filter[country_code]": "US", "filter[features][]": "voice", "filter[limit]": 1}
        area_code = (area_code or "").strip()
        if area_code:
            params["filter[national_destination_code]"] = area_code
        r = await client.get(f"{TELNYX_BASE}/available_phone_numbers", params=params, headers=headers)
        if r.status_code >= 400:
            raise RuntimeError(f"Telnyx search failed ({r.status_code}): {r.text[:200]}")
        available = r.json().get("data") or []
        if not available and area_code:
            fallback = {k: v for k, v in params.items() if k != "filter[national_destination_code]"}
            r = await client.get(f"{TELNYX_BASE}/available_phone_numbers", params=fallback, headers=headers)
            if r.status_code < 400:
                available = r.json().get("data") or []
        if not available:
            raise RuntimeError("No available US numbers found on the Telnyx account.")
        number = available[0]["phone_number"]

        r2 = await client.post(
            f"{TELNYX_BASE}/number_orders",
            json={"phone_numbers": [{"phone_number": number}]},
            headers=headers,
        )
        if r2.status_code >= 400:
            raise RuntimeError(f"Telnyx purchase failed ({r2.status_code}): {r2.text[:200]}")
        order = r2.json().get("data") or {}

        for attempt in range(ORDER_POLL_ATTEMPTS):
            status = (order.get("status") or "").lower()
            if status == "success":
                break
            if status in ("failure", "canceled", "cancelled"):
                raise RuntimeError(f"Telnyx order for {number} failed ({status}).")
            if attempt == ORDER_POLL_ATTEMPTS - 1:
                raise RuntimeError(
                    f"Telnyx is still processing the order for {number}. It should appear in your "
                    "Telnyx account shortly; import it with \"I already own a number\" once it's active."
                )
            await asyncio.sleep(ORDER_POLL_SECONDS)
            polled = await client.get(f"{TELNYX_BASE}/number_orders/{order.get('id')}", headers=headers)
            if polled.status_code < 400:
                order = polled.json().get("data") or order

    # The number can take a moment to show up in the account listing after the order succeeds.
    ref = None
    for attempt in range(3):
        ref = await find_number(number, api_key)
        if ref:
            break
        await asyncio.sleep(ORDER_POLL_SECONDS)
    return {"number": number, "ref": ref}


async def release_number(ref: str, api_key: str) -> None:
    """Delete a number from the account so it stops being billed by Telnyx. A 404 (already
    gone) counts as success. Raises RuntimeError on failure."""
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.delete(f"{TELNYX_BASE}/phone_numbers/{ref}", headers=_headers(api_key))
        if r.status_code not in (200, 202, 204, 404):
            raise RuntimeError(f"Telnyx release failed ({r.status_code}): {r.text[:200]}")
