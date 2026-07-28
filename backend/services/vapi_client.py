import httpx
from config import settings

BASE_URL = "https://api.vapi.ai"


def _headers():
    return {
        "Authorization": f"Bearer {settings.vapi_api_key}",
        "Content-Type": "application/json",
    }


class VapiAPIError(Exception):
    """Raised when VAPI returns a non-2xx response, with the body included."""
    pass


def _check(response: httpx.Response) -> None:
    if 200 <= response.status_code < 300:
        return
    body = response.text[:500] if response.text else ""
    raise VapiAPIError(f"{response.status_code} {response.reason_phrase} — {body}")


async def create_assistant(payload: dict) -> dict:
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.post(f"{BASE_URL}/assistant", headers=_headers(), json=payload)
        _check(r)
        return r.json()


async def update_assistant(assistant_id: str, payload: dict) -> dict:
    async with httpx.AsyncClient() as client:
        r = await client.patch(f"{BASE_URL}/assistant/{assistant_id}", headers=_headers(), json=payload)
        _check(r)
        return r.json()


async def delete_assistant(assistant_id: str) -> None:
    async with httpx.AsyncClient() as client:
        r = await client.delete(f"{BASE_URL}/assistant/{assistant_id}", headers=_headers())
        _check(r)


async def get_assistant(assistant_id: str) -> dict:
    async with httpx.AsyncClient() as client:
        r = await client.get(f"{BASE_URL}/assistant/{assistant_id}", headers=_headers())
        _check(r)
        return r.json()


async def list_calls(limit: int = 100) -> list[dict]:
    """List recent calls for the org (most recent first)."""
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.get(f"{BASE_URL}/call", headers=_headers(), params={"limit": limit})
        _check(r)
        data = r.json()
        return data if isinstance(data, list) else data.get("results", [])


async def get_call(call_id: str) -> dict:
    """Fetch a single call with its full artifact (messages, recording, transcript)."""
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.get(f"{BASE_URL}/call/{call_id}", headers=_headers())
        _check(r)
        return r.json()


async def create_tool(payload: dict) -> dict:
    async with httpx.AsyncClient() as client:
        r = await client.post(f"{BASE_URL}/tool", headers=_headers(), json=payload)
        _check(r)
        return r.json()


async def update_tool(tool_id: str, payload: dict) -> dict:
    async with httpx.AsyncClient() as client:
        r = await client.patch(f"{BASE_URL}/tool/{tool_id}", headers=_headers(), json=payload)
        _check(r)
        return r.json()


async def delete_tool(tool_id: str) -> None:
    async with httpx.AsyncClient() as client:
        r = await client.delete(f"{BASE_URL}/tool/{tool_id}", headers=_headers())
        _check(r)


async def upload_file(file_bytes: bytes, filename: str) -> dict:
    async with httpx.AsyncClient() as client:
        r = await client.post(
            f"{BASE_URL}/file",
            headers={"Authorization": f"Bearer {settings.vapi_api_key}"},
            files={"file": (filename, file_bytes)},
        )
        _check(r)
        return r.json()


async def delete_file(file_id: str) -> None:
    async with httpx.AsyncClient() as client:
        r = await client.delete(f"{BASE_URL}/file/{file_id}", headers=_headers())
        _check(r)


async def create_call(payload: dict) -> dict:
    async with httpx.AsyncClient() as client:
        r = await client.post(f"{BASE_URL}/call", headers=_headers(), json=payload)
        _check(r)
        return r.json()


async def list_phone_numbers() -> list:
    async with httpx.AsyncClient() as client:
        r = await client.get(f"{BASE_URL}/phone-number", headers=_headers())
        _check(r)
        return r.json()


async def get_phone_number(phone_id: str) -> dict:
    async with httpx.AsyncClient() as client:
        r = await client.get(f"{BASE_URL}/phone-number/{phone_id}", headers=_headers())
        _check(r)
        return r.json()


async def create_phone_number(payload: dict) -> dict:
    async with httpx.AsyncClient() as client:
        r = await client.post(f"{BASE_URL}/phone-number", headers=_headers(), json=payload)
        _check(r)
        return r.json()


async def update_phone_number(phone_id: str, payload: dict) -> dict:
    async with httpx.AsyncClient() as client:
        r = await client.patch(f"{BASE_URL}/phone-number/{phone_id}", headers=_headers(), json=payload)
        _check(r)
        return r.json()


async def delete_phone_number(phone_id: str) -> None:
    async with httpx.AsyncClient() as client:
        r = await client.delete(f"{BASE_URL}/phone-number/{phone_id}", headers=_headers())
        _check(r)


# Vapi's own built-in voice provider (provider="vapi") — real voices available on
# every Vapi account with no third-party provider key required. voiceIds are exact
# (case-sensitive on Vapi's side); we accept any casing from the wizard and map to
# the canonical form. Verified live against the Vapi API (each accepted on assistant
# creation). Source: https://docs.vapi.ai/providers/voice/vapi-voices
_VAPI_VOICE_IDS = [
    "Elliot", "Savannah", "Rohan", "Emma", "Clara", "Nico", "Kai",
    "Sagar", "Godfrey", "Neil", "Layla", "Sid", "Naina",
]
_VAPI_VOICE_CANONICAL = {v.lower(): v for v in _VAPI_VOICE_IDS}
_DEFAULT_VAPI_VOICE = "Elliot"


def _resolve_voice(voice: str | None) -> dict:
    """Return a VAPI-compatible voice block using Vapi's own built-in voices.
    Defaults to 'Elliot' if input is unknown (e.g. a legacy/retired name)."""
    raw = (voice or "").strip().lower()
    voice_id = _VAPI_VOICE_CANONICAL.get(raw, _DEFAULT_VAPI_VOICE)
    return {"provider": "vapi", "voiceId": voice_id}


def _resolve_language(language: str | None) -> str:
    """Accept 'English (US)' / 'en-US' / 'en' — emit a Deepgram-compatible language code."""
    if not language:
        return "en"
    raw = language.strip()
    # 'English (US)' -> 'en-US' (Deepgram accepts en, en-US, etc.)
    lookup = {
        "english (us)": "en-US",
        "english (uk)": "en-GB",
        "spanish (es)": "es",
        "spanish (mx)": "es",
        "french (fr)":  "fr",
        "italian (it)": "it",
        "german (de)":  "de",
    }
    return lookup.get(raw.lower(), raw if len(raw) <= 5 else "en")


import re


def _tool_name_slug(agent_name: str | None) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "_", (agent_name or "agent").strip()).strip("_")
    return slug or "agent"


def build_transfer_tool_payload(agent_name: str | None, number: str) -> dict:
    """A standalone VAPI transferCall tool that forwards a qualified call to `number`.

    Created via POST /tool and attached to the assistant by toolId — so it shows up
    as its own entry in the VAPI Tools library (e.g. transfer_call_tool_<agent>).
    """
    return {
        "type": "transferCall",
        "function": {"name": f"transfer_call_tool_{_tool_name_slug(agent_name)}"},
        "destinations": [{
            "type": "number",
            "number": number.strip(),
            "callerId": "{{customer.number}}",
            "message": "Please hold while I connect you.",
            "description": "Transfer to this destination",
        }],
    }


def build_fallback_assistant_payload() -> dict:
    """A minimal, shared assistant used to answer inbound calls for accounts whose
    wallet balance is empty. Plays a short message and hangs up — `maxDurationSeconds`
    ends the call reliably without depending on the model invoking an end-call tool."""
    return {
        "name": "NEXUS — Balance Unavailable",
        "firstMessage": (
            "We're sorry, this line is temporarily unavailable because the account "
            "balance is empty. Please contact the account owner. Goodbye."
        ),
        "model": {
            "provider": "openai",
            "model": "gpt-4o-mini",
            "messages": [
                {"role": "system", "content": "Say only the first message, then stay silent."}
            ],
        },
        "transcriber": {"provider": "deepgram", "language": "en"},
        "voice": _resolve_voice(None),
        "maxDurationSeconds": 15,
        "silenceTimeoutSeconds": 5,
    }


def build_assistant_payload(name: str, voice: str = None, language: str = "en",
                             system_prompt: str = None, first_message: str = None,
                             tool_ids: list[str] | None = None) -> dict:
    model: dict = {
        "provider": "openai",
        "model": "gpt-4o-mini",
        "messages": [
            {"role": "system", "content": system_prompt or f"You are {name}, a helpful AI assistant."}
        ],
    }
    if tool_ids:
        model["toolIds"] = tool_ids

    payload: dict = {
        "name": name,
        "transcriber": {
            "provider": "deepgram",
            "language": _resolve_language(language),
        },
        "model": model,
        "voice": _resolve_voice(voice),
        # Record every call and keep the structured transcript so the dashboard can
        # play the recording and render a speaker-attributed transcript.
        "artifactPlan": {
            "recordingEnabled": True,
            "transcriptPlan": {"enabled": True},
        },
    }
    if first_message:
        payload["firstMessage"] = first_message

    # Point VAPI at our webhook so end-of-call-report / status-update events are
    # delivered here. Requires a publicly reachable backend URL (settings.public_api_url).
    if settings.public_api_url:
        base = settings.public_api_url.rstrip("/")
        server: dict = {"url": f"{base}/webhooks/vapi"}
        if settings.vapi_webhook_secret:
            server["secret"] = settings.vapi_webhook_secret
        payload["server"] = server
        payload["serverMessages"] = ["end-of-call-report", "status-update"]

    return payload
