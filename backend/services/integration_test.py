"""
Test-connection probes for third-party integrations.

Each prober calls the provider's lightest "who am I" endpoint with the
user-supplied credentials and reports whether they work.

Provider detection: integration.name is matched case-insensitively against
the keywords below. Add a row to PROVIDERS to support a new provider.
"""

import time
import httpx
from urllib.parse import quote


async def _http_test(method: str, url: str, *, headers: dict | None = None,
                     auth: tuple[str, str] | None = None,
                     params: dict | None = None,
                     timeout: float = 10.0) -> dict:
    started = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.request(method, url, headers=headers or {}, auth=auth, params=params)
        latency_ms = int((time.perf_counter() - started) * 1000)
        if 200 <= resp.status_code < 300:
            return {"ok": True, "latency_ms": latency_ms, "message": "Connection healthy"}
        body_snippet = resp.text[:200] if resp.text else ""
        if resp.status_code in (401, 403):
            return {"ok": False, "latency_ms": latency_ms,
                    "message": "Authentication failed — credentials rejected"}
        return {"ok": False, "latency_ms": latency_ms,
                "message": f"Provider returned HTTP {resp.status_code}: {body_snippet}"}
    except httpx.TimeoutException:
        return {"ok": False, "latency_ms": int((time.perf_counter() - started) * 1000),
                "message": f"Timed out after {timeout}s"}
    except Exception as e:
        return {"ok": False, "latency_ms": int((time.perf_counter() - started) * 1000),
                "message": f"Network error: {e}"}


# ── Email providers ──

async def test_brevo(config: dict) -> dict:
    api_key = (config.get("apiKey") or config.get("api_key") or "").strip()
    if not api_key:
        return {"ok": False, "message": "Missing apiKey"}
    return await _http_test(
        "GET", "https://api.brevo.com/v3/account",
        headers={"api-key": api_key, "Accept": "application/json"},
    )


async def test_sendgrid(config: dict) -> dict:
    api_key = (config.get("apiKey") or config.get("api_key") or "").strip()
    if not api_key:
        return {"ok": False, "message": "Missing apiKey"}
    return await _http_test(
        "GET", "https://api.sendgrid.com/v3/user/account",
        headers={"Authorization": f"Bearer {api_key}"},
    )


async def test_mailgun(config: dict) -> dict:
    api_key = (config.get("apiKey") or config.get("api_key") or "").strip()
    domain = (config.get("domain") or "").strip()
    region = (config.get("region") or "us").strip().lower()
    if not api_key:
        return {"ok": False, "message": "Missing apiKey"}
    base = "https://api.eu.mailgun.net" if region == "eu" else "https://api.mailgun.net"
    # If they gave us a domain, verify it; else hit the generic domains list.
    url = f"{base}/v4/domains/{quote(domain)}" if domain else f"{base}/v4/domains"
    return await _http_test("GET", url, auth=("api", api_key))


# ── Voice / SMS providers ──

async def test_twilio(config: dict) -> dict:
    sid = (config.get("sid") or config.get("accountSid") or "").strip()
    token = (config.get("token") or config.get("authToken") or "").strip()
    if not sid or not token:
        return {"ok": False, "message": "Missing sid or token"}
    return await _http_test(
        "GET", f"https://api.twilio.com/2010-04-01/Accounts/{quote(sid)}.json",
        auth=(sid, token),
    )


async def test_telnyx(config: dict) -> dict:
    api_key = (config.get("apiKey") or config.get("api_key") or "").strip()
    if not api_key:
        return {"ok": False, "message": "Missing apiKey"}
    # /v2/phone_numbers is small, requires auth, no side effects.
    return await _http_test(
        "GET", "https://api.telnyx.com/v2/phone_numbers",
        headers={"Authorization": f"Bearer {api_key}"},
        params={"page[size]": 1},
    )


async def test_vonage(config: dict) -> dict:
    api_key = (config.get("apiKey") or config.get("api_key") or "").strip()
    api_secret = (config.get("apiSecret") or config.get("api_secret") or "").strip()
    if not api_key or not api_secret:
        return {"ok": False, "message": "Missing apiKey or apiSecret"}
    return await _http_test(
        "GET", "https://rest.nexmo.com/account/get-balance",
        params={"api_key": api_key, "api_secret": api_secret},
    )


# ── Provider registry & dispatcher ──

PROVIDERS = [
    # (keyword matched against integration.name, lowercased), prober, friendly label
    ("brevo",     test_brevo,    "Brevo"),
    ("sendinblue", test_brevo,   "Brevo"),  # legacy name
    ("sendgrid",  test_sendgrid, "SendGrid"),
    ("mailgun",   test_mailgun,  "Mailgun"),
    ("twilio",    test_twilio,   "Twilio"),
    ("telnyx",    test_telnyx,   "Telnyx"),
    ("vonage",    test_vonage,   "Vonage"),
    ("nexmo",     test_vonage,   "Vonage"),  # legacy name
]


def detect_provider(integration_name: str) -> tuple[str, callable] | None:
    name = (integration_name or "").lower()
    for keyword, prober, label in PROVIDERS:
        if keyword in name:
            return label, prober
    return None


async def run_test(integration_name: str, config: dict) -> dict:
    """
    Returns:
        { ok: bool, message: str, latency_ms: int | None, provider: str | None }
    """
    match = detect_provider(integration_name)
    if not match:
        return {
            "ok": False,
            "message": (
                "Test Connection is not yet supported for this provider. "
                "Currently supported: Brevo, SendGrid, Mailgun, Twilio, Telnyx, Vonage."
            ),
            "latency_ms": None,
            "provider": None,
        }
    label, prober = match
    result = await prober(config or {})
    result["provider"] = label
    result.setdefault("latency_ms", None)
    return result
