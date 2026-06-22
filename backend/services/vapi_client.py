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


async def get_call(call_id: str) -> dict:
    async with httpx.AsyncClient() as client:
        r = await client.get(f"{BASE_URL}/call/{call_id}", headers=_headers())
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


async def delete_phone_number(phone_id: str) -> None:
    async with httpx.AsyncClient() as client:
        r = await client.delete(f"{BASE_URL}/phone-number/{phone_id}", headers=_headers())
        _check(r)


# Map our wizard display names to OpenAI TTS voices (always available, no
# voice-ID provisioning required). Keys are lowercased; unknown names fall back
# to "alloy" so VAPI never rejects an unknown voice.
_VOICE_MAP = {
    "aria":  "nova",
    "eva":   "shimmer",
    "nora":  "alloy",
    "lia":   "fable",
    "marco": "onyx",
    "tom":   "echo",
    "kai":   "onyx",
    "diego": "onyx",
}
_OPENAI_VOICES = {"alloy", "echo", "fable", "onyx", "nova", "shimmer"}


def _resolve_voice(voice: str | None) -> dict:
    """Return a VAPI-compatible voice block. Defaults to OpenAI 'alloy' if input is unknown."""
    raw = (voice or "").strip().lower()
    voice_id = _VOICE_MAP.get(raw, raw if raw in _OPENAI_VOICES else "alloy")
    return {"provider": "openai", "voiceId": voice_id}


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
    }
    if first_message:
        payload["firstMessage"] = first_message
    return payload
