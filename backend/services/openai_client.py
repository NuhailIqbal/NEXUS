"""OpenAI chat helper — used by the agent "Test" feature to generate a reply."""
import logging

import httpx

from config import settings

logger = logging.getLogger(__name__)

OPENAI_URL = "https://api.openai.com/v1/chat/completions"


class OpenAIError(Exception):
    """Raised so callers can surface a clear reason (e.g. rate limit / bad key)."""
    pass


async def chat_reply(system_prompt: str | None, user_message: str, first_message: str | None = None) -> str | None:
    """Generate an in-character agent reply to a test message via OpenAI (gpt-4o-mini)."""
    if not settings.openai_api_key or not user_message:
        return None

    sys = (system_prompt or "You are a helpful AI voice agent.").strip()
    if first_message:
        sys += f'\nYour usual opening line is: "{first_message}".'
    sys += (
        "\n\nYou are being tested by your creator. Reply the way you would on a live call — "
        "natural, concise, and in character. Return only your spoken reply, no notes or labels."
    )

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(
                OPENAI_URL,
                headers={
                    "Authorization": f"Bearer {settings.openai_api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": "gpt-4o-mini",
                    "messages": [
                        {"role": "system", "content": sys},
                        {"role": "user", "content": user_message},
                    ],
                    "temperature": 0.6,
                    "max_tokens": 300,
                },
            )
        if r.status_code == 429:
            raise OpenAIError("The AI service is rate-limited (OpenAI quota). Please try again shortly.")
        if r.status_code == 401:
            raise OpenAIError("OpenAI API key is missing or invalid on the server.")
        r.raise_for_status()
        data = r.json()
        choices = data.get("choices", [])
        if choices:
            return (choices[0].get("message", {}).get("content") or "").strip()
        return None
    except OpenAIError:
        raise
    except Exception as e:
        logger.error(f"OpenAI chat reply failed: {e}")
        raise OpenAIError("Couldn't reach the AI service. Please try again.") from e
