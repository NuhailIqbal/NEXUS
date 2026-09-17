"""OpenAI chat helper — used by the agent "Test" feature to generate a reply."""
import json
import logging

import httpx

from config import settings

logger = logging.getLogger(__name__)

OPENAI_URL = "https://api.openai.com/v1/chat/completions"

# Must match the Industry option ids in src/pages/dashboard/CreateAIAgent.tsx exactly —
# these are what the frontend knows how to render as a selected card.
_VALID_INDUSTRIES = [
    "retail", "health", "finance", "realestate", "education", "travel", "saas", "automotive",
]


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


async def analyze_website(title: str, text: str) -> dict:
    """Given a business website's title + extracted text, suggest a main_goal and an
    industry id for the Create Agent form's "Analyze" button. Returns
    {"main_goal": str, "industry": str | None}."""
    if not settings.openai_api_key:
        raise OpenAIError("AI analysis is not configured — add OPENAI_API_KEY on the server.")

    sys = (
        "You read a business's website and suggest setup for their AI voice agent. "
        "Respond with ONLY a JSON object, no other text: "
        '{"main_goal": "<one or two sentences describing what the agent should accomplish '
        'on calls for this business, written as an instruction, e.g. \'Qualify leads for '
        'solar installation and book a free consultation.\'>", '
        f'"industry": "<one of exactly these ids: {", ".join(_VALID_INDUSTRIES)}, or null if none fit>"}}'
    )
    user_msg = f"Website title: {title}\n\nWebsite content:\n{text}"

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
                        {"role": "user", "content": user_msg},
                    ],
                    "temperature": 0.4,
                    "max_tokens": 300,
                    "response_format": {"type": "json_object"},
                },
            )
        if r.status_code == 429:
            raise OpenAIError("The AI service is rate-limited (OpenAI quota). Please try again shortly.")
        if r.status_code == 401:
            raise OpenAIError("OpenAI API key is missing or invalid on the server.")
        r.raise_for_status()
        data = r.json()
        content = data.get("choices", [{}])[0].get("message", {}).get("content") or "{}"
        parsed = json.loads(content)
    except OpenAIError:
        raise
    except Exception as e:
        logger.error(f"OpenAI website analysis failed: {e}")
        raise OpenAIError("Couldn't analyze this website right now. Please try again.") from e

    main_goal = (parsed.get("main_goal") or "").strip()
    industry = parsed.get("industry")
    if industry not in _VALID_INDUSTRIES:
        industry = None
    return {"main_goal": main_goal, "industry": industry}
