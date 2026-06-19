import httpx
from config import settings

BASE_URL = "https://api.vapi.ai"


def _headers():
    return {
        "Authorization": f"Bearer {settings.vapi_api_key}",
        "Content-Type": "application/json",
    }


async def create_assistant(payload: dict) -> dict:
    async with httpx.AsyncClient() as client:
        r = await client.post(f"{BASE_URL}/assistant", headers=_headers(), json=payload)
        r.raise_for_status()
        return r.json()


async def update_assistant(assistant_id: str, payload: dict) -> dict:
    async with httpx.AsyncClient() as client:
        r = await client.patch(f"{BASE_URL}/assistant/{assistant_id}", headers=_headers(), json=payload)
        r.raise_for_status()
        return r.json()


async def delete_assistant(assistant_id: str) -> None:
    async with httpx.AsyncClient() as client:
        r = await client.delete(f"{BASE_URL}/assistant/{assistant_id}", headers=_headers())
        r.raise_for_status()


async def get_assistant(assistant_id: str) -> dict:
    async with httpx.AsyncClient() as client:
        r = await client.get(f"{BASE_URL}/assistant/{assistant_id}", headers=_headers())
        r.raise_for_status()
        return r.json()


async def create_tool(payload: dict) -> dict:
    async with httpx.AsyncClient() as client:
        r = await client.post(f"{BASE_URL}/tool", headers=_headers(), json=payload)
        r.raise_for_status()
        return r.json()


async def update_tool(tool_id: str, payload: dict) -> dict:
    async with httpx.AsyncClient() as client:
        r = await client.patch(f"{BASE_URL}/tool/{tool_id}", headers=_headers(), json=payload)
        r.raise_for_status()
        return r.json()


async def delete_tool(tool_id: str) -> None:
    async with httpx.AsyncClient() as client:
        r = await client.delete(f"{BASE_URL}/tool/{tool_id}", headers=_headers())
        r.raise_for_status()


async def upload_file(file_bytes: bytes, filename: str) -> dict:
    async with httpx.AsyncClient() as client:
        r = await client.post(
            f"{BASE_URL}/file",
            headers={"Authorization": f"Bearer {settings.vapi_api_key}"},
            files={"file": (filename, file_bytes)},
        )
        r.raise_for_status()
        return r.json()


async def delete_file(file_id: str) -> None:
    async with httpx.AsyncClient() as client:
        r = await client.delete(f"{BASE_URL}/file/{file_id}", headers=_headers())
        r.raise_for_status()


async def create_call(payload: dict) -> dict:
    async with httpx.AsyncClient() as client:
        r = await client.post(f"{BASE_URL}/call", headers=_headers(), json=payload)
        r.raise_for_status()
        return r.json()


async def get_call(call_id: str) -> dict:
    async with httpx.AsyncClient() as client:
        r = await client.get(f"{BASE_URL}/call/{call_id}", headers=_headers())
        r.raise_for_status()
        return r.json()


async def list_phone_numbers() -> list:
    async with httpx.AsyncClient() as client:
        r = await client.get(f"{BASE_URL}/phone-number", headers=_headers())
        r.raise_for_status()
        return r.json()


async def get_phone_number(phone_id: str) -> dict:
    async with httpx.AsyncClient() as client:
        r = await client.get(f"{BASE_URL}/phone-number/{phone_id}", headers=_headers())
        r.raise_for_status()
        return r.json()


async def create_phone_number(payload: dict) -> dict:
    async with httpx.AsyncClient() as client:
        r = await client.post(f"{BASE_URL}/phone-number", headers=_headers(), json=payload)
        r.raise_for_status()
        return r.json()


async def delete_phone_number(phone_id: str) -> None:
    async with httpx.AsyncClient() as client:
        r = await client.delete(f"{BASE_URL}/phone-number/{phone_id}", headers=_headers())
        r.raise_for_status()


def build_assistant_payload(name: str, voice: str = None, language: str = "en",
                             system_prompt: str = None, first_message: str = None) -> dict:
    payload = {
        "name": name,
        "transcriber": {
            "provider": "deepgram",
            "language": language or "en",
        },
        "model": {
            "provider": "openai",
            "model": "gpt-4o-mini",
            "messages": [
                {"role": "system", "content": system_prompt or f"You are {name}, a helpful AI assistant."}
            ],
        },
    }
    if first_message:
        payload["firstMessage"] = first_message
    if voice:
        payload["voice"] = {"provider": "11labs", "voiceId": voice}
    return payload
