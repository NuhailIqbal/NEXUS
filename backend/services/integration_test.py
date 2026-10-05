"""
Test-connection probes for third-party integrations.

Each prober calls the provider's lightest "who am I" endpoint with the
user-supplied credentials and reports whether they work.

Provider detection: integration.name is matched case-insensitively against
the keywords below. Add a row to PROVIDERS to support a new provider.
"""

import asyncio
import smtplib
import time
import httpx
from urllib.parse import quote

from services import whitelist_service


async def _http_test(method: str, url: str, *, headers: dict | None = None,
                     auth: tuple[str, str] | None = None,
                     params: dict | None = None,
                     timeout: float = 10.0) -> dict:
    """Shared prober: send one HTTP request and translate the outcome into a result dict. Never raises.

    Returns `{"ok", "latency_ms", "message"}`. Any 2xx is healthy; 401/403 means the credentials
    were rejected; other statuses include the first 200 characters of the response body in the
    message; timeouts and other network errors are reported as failures. `auth` is HTTP Basic.
    """
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


# Despite the test_ prefix, the functions below are runtime connection probes (dispatched through
# PROVIDERS / run_test), not pytest tests. Each takes the saved integration config and returns
# {"ok", "message", optionally "latency_ms"}; run_test adds `provider` and a default `latency_ms`.
# Several probes accept alternate spellings of a credential key (e.g. apiKey or api_key).

# ── Email providers ──

async def test_brevo(config: dict) -> dict:
    """Probe Brevo (formerly Sendinblue) via GET /v3/account using the `apiKey`."""
    api_key = (config.get("apiKey") or config.get("api_key") or "").strip()
    if not api_key:
        return {"ok": False, "message": "Missing apiKey"}
    return await _http_test(
        "GET", "https://api.brevo.com/v3/account",
        headers={"api-key": api_key, "Accept": "application/json"},
    )


async def test_sendgrid(config: dict) -> dict:
    """Probe SendGrid via GET /v3/user/account using the `apiKey` as a bearer token."""
    api_key = (config.get("apiKey") or config.get("api_key") or "").strip()
    if not api_key:
        return {"ok": False, "message": "Missing apiKey"}
    return await _http_test(
        "GET", "https://api.sendgrid.com/v3/user/account",
        headers={"Authorization": f"Bearer {api_key}"},
    )


def _smtp_probe_sync(host: str, port: int, username: str, password: str) -> None:
    """Blocking SMTP check: connect, upgrade with STARTTLS, then log in.

    Raises the smtplib exception on failure. STARTTLS only: servers that need implicit TLS
    (e.g. port 465) are not supported by this probe.
    """
    with smtplib.SMTP(host, port, timeout=10) as server:
        server.starttls()
        server.login(username, password)


async def test_smtp(config: dict) -> dict:
    """Probe an SMTP server by logging in with `host`, `username`, `password` and an optional `port` (default 587).

    Distinguishes a rejected login from other connection errors. Sends no email.
    """
    host = (config.get("host") or "").strip()
    username = (config.get("username") or "").strip()
    password = (config.get("password") or "").strip()
    try:
        port = int(config.get("port") or 587)
    except (TypeError, ValueError):
        port = 587
    missing = [n for n, v in (("host", host), ("username", username), ("password", password)) if not v]
    if missing:
        return {"ok": False, "message": f"Missing {', '.join(missing)}"}
    started = time.perf_counter()
    try:
        # smtplib is synchronous; run it in a worker thread so it doesn't block the event loop.
        await asyncio.to_thread(_smtp_probe_sync, host, port, username, password)
        return {"ok": True, "latency_ms": int((time.perf_counter() - started) * 1000), "message": "Connection healthy"}
    except smtplib.SMTPAuthenticationError:
        return {"ok": False, "latency_ms": int((time.perf_counter() - started) * 1000),
                "message": "Authentication failed — credentials rejected"}
    except Exception as e:
        return {"ok": False, "latency_ms": int((time.perf_counter() - started) * 1000), "message": f"SMTP error: {e}"}


async def test_mailgun(config: dict) -> dict:
    """Probe Mailgun with HTTP Basic auth (user "api"). `region` "eu" selects the EU API host; `domain` is optional."""
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
    """Probe Twilio by fetching the account resource, authenticating with account `sid` and auth `token`."""
    sid = (config.get("sid") or config.get("accountSid") or "").strip()
    token = (config.get("token") or config.get("authToken") or "").strip()
    if not sid or not token:
        return {"ok": False, "message": "Missing sid or token"}
    return await _http_test(
        "GET", f"https://api.twilio.com/2010-04-01/Accounts/{quote(sid)}.json",
        auth=(sid, token),
    )


async def test_telnyx(config: dict) -> dict:
    """Probe Telnyx by listing one phone number with the `apiKey` as a bearer token."""
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
    """Probe Vonage (formerly Nexmo) by reading the account balance; the key and secret go in the query string."""
    api_key = (config.get("apiKey") or config.get("api_key") or "").strip()
    api_secret = (config.get("apiSecret") or config.get("api_secret") or "").strip()
    if not api_key or not api_secret:
        return {"ok": False, "message": "Missing apiKey or apiSecret"}
    return await _http_test(
        "GET", "https://rest.nexmo.com/account/get-balance",
        params={"api_key": api_key, "api_secret": api_secret},
    )


# ── CRM / SaaS providers ──

async def test_hubspot(config: dict) -> dict:
    """Probe HubSpot by listing one contact with the `accessToken` (or `apiKey`) as a bearer token."""
    token = (config.get("accessToken") or config.get("apiKey") or "").strip()
    if not token:
        return {"ok": False, "message": "Missing accessToken"}
    return await _http_test(
        "GET", "https://api.hubapi.com/crm/v3/objects/contacts?limit=1",
        headers={"Authorization": f"Bearer {token}"},
    )


async def test_salesforce(config: dict) -> dict:
    """Probe Salesforce by reading the REST API `limits` resource (API v59.0) at `instanceUrl` with the `accessToken`.

    `instanceUrl` defaults to https://login.salesforce.com; a trailing slash is stripped.
    """
    token = (config.get("accessToken") or "").strip()
    instance = (config.get("instanceUrl") or "https://login.salesforce.com").strip().rstrip("/")
    if not token:
        return {"ok": False, "message": "Missing accessToken"}
    return await _http_test(
        "GET", f"{instance}/services/data/v59.0/limits",
        headers={"Authorization": f"Bearer {token}"},
    )


async def test_openai(config: dict) -> dict:
    """Probe OpenAI by listing models with the `apiKey` as a bearer token."""
    api_key = (config.get("apiKey") or "").strip()
    if not api_key:
        return {"ok": False, "message": "Missing apiKey"}
    return await _http_test(
        "GET", "https://api.openai.com/v1/models",
        headers={"Authorization": f"Bearer {api_key}"},
    )


async def test_stripe(config: dict) -> dict:
    """Probe Stripe by reading the account balance (read-only) with the `secretKey` as a bearer token."""
    key = (config.get("secretKey") or config.get("apiKey") or "").strip()
    if not key:
        return {"ok": False, "message": "Missing secretKey"}
    return await _http_test(
        "GET", "https://api.stripe.com/v1/balance",
        headers={"Authorization": f"Bearer {key}"},
    )


async def test_slack(config: dict) -> dict:
    """Probe a Slack incoming webhook by posting a test message.

    Side effect: the message "EDM Nexus test ping" appears in the webhook's channel. Healthy only
    on HTTP 200. Does its own request instead of `_http_test`, which can't send a JSON body.
    """
    url = (config.get("webhookUrl") or "").strip()
    if not url:
        return {"ok": False, "message": "Missing webhookUrl"}
    started = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(url, json={"text": "EDM Nexus test ping"})
        latency_ms = int((time.perf_counter() - started) * 1000)
        if resp.status_code == 200:
            return {"ok": True, "latency_ms": latency_ms, "message": "Webhook delivered successfully"}
        return {"ok": False, "latency_ms": latency_ms, "message": f"Slack returned HTTP {resp.status_code}"}
    except Exception as e:
        return {"ok": False, "latency_ms": int((time.perf_counter() - started) * 1000), "message": f"Error: {e}"}


async def test_zapier(config: dict) -> dict:
    """Probe a Zapier webhook by POSTing a small test payload; any 2xx counts as accepted.

    Side effect: the payload is delivered to the user's webhook, so it may trigger their Zap.
    """
    url = (config.get("webhookUrl") or "").strip()
    if not url:
        return {"ok": False, "message": "Missing webhookUrl"}
    started = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(url, json={"test": True, "source": "edm_nexus"})
        latency_ms = int((time.perf_counter() - started) * 1000)
        if 200 <= resp.status_code < 300:
            return {"ok": True, "latency_ms": latency_ms, "message": "Webhook accepted"}
        return {"ok": False, "latency_ms": latency_ms, "message": f"Zapier returned HTTP {resp.status_code}"}
    except Exception as e:
        return {"ok": False, "latency_ms": int((time.perf_counter() - started) * 1000), "message": f"Error: {e}"}


async def test_gemini(config: dict) -> dict:
    """Probe Google Gemini by listing models; the `apiKey` is sent as the `key` query parameter."""
    api_key = (config.get("apiKey") or "").strip()
    if not api_key:
        return {"ok": False, "message": "Missing apiKey"}
    return await _http_test(
        "GET", f"https://generativelanguage.googleapis.com/v1/models?key={api_key}",
    )


async def test_whitelistdata(config: dict) -> dict:
    """Screen a throwaway number to prove the credentials work. There's no dedicated
    health endpoint, so the lookup itself is the probe — a 2xx means the key is live,
    regardless of whether the number happens to be listed."""
    api_key = (config.get("apiKey") or config.get("api_key") or "").strip()
    if not api_key:
        return {"ok": False, "message": "Missing apiKey"}
    missing = [f for f in ("code", "secret") if not (config.get(f) or "").strip()]
    if missing:
        return {"ok": False, "message": f"Missing {', '.join(missing)}"}
    return await _http_test(
        "GET", whitelist_service.BASE_URL,
        params={
            "code": config["code"],
            "secret": config["secret"],
            "phoneNumber": "5555555555",
            "apiKey": api_key,
            "return_key": "found",
            "type": config.get("type") or whitelist_service.DEFAULT_SUPPRESSION_TYPE,
        },
    )


# ── Provider registry & dispatcher ──

# Order matters: detect_provider returns the first entry whose keyword appears in the lowercased
# "<integration name> <category>" text. Several keywords can map to one prober (brevo/sendinblue,
# vonage/nexmo). Add a row here to support a new provider.
PROVIDERS = [
    # (keyword matched against integration.name, lowercased), prober, friendly label
    ("brevo",      test_brevo,      "Brevo"),
    ("sendinblue", test_brevo,      "Brevo"),
    ("sendgrid",   test_sendgrid,   "SendGrid"),
    ("mailgun",    test_mailgun,    "Mailgun"),
    ("smtp",       test_smtp,       "SMTP"),
    ("twilio",     test_twilio,     "Twilio"),
    ("telnyx",     test_telnyx,     "Telnyx"),
    ("vonage",     test_vonage,     "Vonage"),
    ("nexmo",      test_vonage,     "Vonage"),
    ("hubspot",    test_hubspot,    "HubSpot"),
    ("salesforce", test_salesforce, "Salesforce"),
    ("openai",     test_openai,     "OpenAI"),
    ("stripe",     test_stripe,     "Stripe"),
    ("slack",      test_slack,      "Slack"),
    ("zapier",     test_zapier,     "Zapier"),
    ("gemini",     test_gemini,     "Gemini"),
    ("whitelist",  test_whitelistdata, "WhitelistData"),
]

# Providers that stamp a `provider` marker inside the saved config (see
# AddIntegrationDialog.tsx / whitelist_service.py) are matched on that first — the display
# name is free text the user can change, so name/category keyword matching alone would break
# the moment they rename it away from something containing the keyword.
PROVIDER_KEY_MAP = {
    "whitelistdata": (test_whitelistdata, "WhitelistData"),
    "brevo": (test_brevo, "Brevo"),
    "sendgrid": (test_sendgrid, "SendGrid"),
    "smtp": (test_smtp, "SMTP"),
}


def detect_provider(integration_name: str, category: str = "", config: dict | None = None) -> tuple[str, callable] | None:
    """Identify which provider an integration is; returns `(label, prober)` or None if unrecognised.

    Checked in order: the `provider` marker inside `config` (PROVIDER_KEY_MAP), then a keyword
    search over the integration's name and category (PROVIDERS). Also used by
    services/email_service.py to pick which email provider to send through.
    """
    provider_key = (config or {}).get("provider")
    if provider_key in PROVIDER_KEY_MAP:
        prober, label = PROVIDER_KEY_MAP[provider_key]
        return label, prober
    haystack = f"{integration_name} {category}".lower()
    for keyword, prober, label in PROVIDERS:
        if keyword in haystack:
            return label, prober
    return None


# Human-readable list of supported providers, shown in the "Provider not recognised" message.
SUPPORTED_LABELS = ", ".join(sorted({label for _, _, label in PROVIDERS}))


async def run_test(integration_name: str, config: dict, category: str = "") -> dict:
    """
    Returns:
        { ok: bool, message: str, latency_ms: int | None, provider: str | None }
    """
    match = detect_provider(integration_name, category, config)
    if not match:
        return {
            "ok": False,
            "message": (
                f"Provider not recognised from the integration name or category. "
                f"Include the provider name (e.g. 'Gemini', 'OpenAI', 'Twilio') in the integration name or category. "
                f"Supported: {SUPPORTED_LABELS}."
            ),
            "latency_ms": None,
            "provider": None,
        }
    label, prober = match
    result = await prober(config or {})
    result["provider"] = label
    # Probes that fail validation before any request (e.g. "Missing apiKey") have no timing; keep the response shape stable.
    result.setdefault("latency_ms", None)
    return result
