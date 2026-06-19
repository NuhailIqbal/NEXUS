import httpx
import logging
from config import settings

logger = logging.getLogger(__name__)

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent"


async def summarize_transcript(transcript: str, contact_name: str = None) -> str | None:
    if not settings.gemini_api_key or not transcript:
        return None

    context = f"Call with {contact_name}. " if contact_name else ""
    prompt = (
        f"{context}Summarize this phone call transcript in 2-3 concise bullet points. "
        f"Include: key topics discussed, any commitments or next steps, and the caller's sentiment. "
        f"Keep it professional and brief.\n\n"
        f"Transcript:\n{transcript}"
    )

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(
                f"{GEMINI_URL}?key={settings.gemini_api_key}",
                json={
                    "contents": [{"parts": [{"text": prompt}]}],
                    "generationConfig": {
                        "temperature": 0.3,
                        "maxOutputTokens": 300,
                    },
                },
            )
            r.raise_for_status()
            data = r.json()
            candidates = data.get("candidates", [])
            if candidates:
                parts = candidates[0].get("content", {}).get("parts", [])
                if parts:
                    return parts[0].get("text", "")
    except Exception as e:
        logger.error(f"Gemini summarization failed: {e}")

    return None


async def analyze_sentiment(transcript: str) -> str | None:
    if not settings.gemini_api_key or not transcript:
        return None

    prompt = (
        "Analyze the sentiment of this phone call transcript. "
        "Respond with exactly one word: Positive, Negative, or Neutral.\n\n"
        f"Transcript:\n{transcript}"
    )

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.post(
                f"{GEMINI_URL}?key={settings.gemini_api_key}",
                json={
                    "contents": [{"parts": [{"text": prompt}]}],
                    "generationConfig": {"temperature": 0.0, "maxOutputTokens": 10},
                },
            )
            r.raise_for_status()
            data = r.json()
            candidates = data.get("candidates", [])
            if candidates:
                parts = candidates[0].get("content", {}).get("parts", [])
                if parts:
                    text = parts[0].get("text", "").strip()
                    for s in ["Positive", "Negative", "Neutral"]:
                        if s.lower() in text.lower():
                            return s
                    return text
    except Exception as e:
        logger.error(f"Gemini sentiment analysis failed: {e}")

    return None
