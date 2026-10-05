"""Thin client for Google's Gemini REST API (gemini-2.0-flash), used for post-call AI work
on call transcripts.

Entry points: summarize_transcript (called from routers/webhooks.py after a call ends, result
stored in conversations.ai_summary) and analyze_sentiment. Both use the server-wide
GEMINI_API_KEY from settings and never raise: any failure is logged and None is returned,
so a Gemini outage cannot break call processing.
"""
import httpx
import logging
from config import settings

logger = logging.getLogger(__name__)

# Single fixed model endpoint; the API key is appended as a query parameter per request.
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent"


async def summarize_transcript(transcript: str, contact_name: str = None) -> str | None:
    """Summarize a call transcript into 2-3 short bullet points (topics, next steps, sentiment).

    Args:
        transcript: Full call transcript text.
        contact_name: Optional contact name, added to the prompt for context.

    Returns:
        The summary text, or None if no Gemini key is configured, the transcript is empty,
        the response has no content, or the request fails (errors are logged, not raised).
    """
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
                        # Low temperature keeps summaries factual; 300 tokens is enough
                        # for the requested 2-3 bullets.
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
    """Classify the overall sentiment of a call transcript as Positive, Negative or Neutral.

    Returns one of those three labels, or the model's raw (stripped) text if it matches
    none of them. Returns None if no Gemini key is configured, the transcript is empty,
    the response has no content, or the request fails (errors are logged, not raised).
    Currently has no caller elsewhere in backend/.
    """
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
                    # Deterministic output and a tiny token cap: the answer is a single word.
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
                    # Normalize to a canonical label in case the model adds punctuation
                    # or extra words despite the "exactly one word" instruction.
                    for s in ["Positive", "Negative", "Neutral"]:
                        if s.lower() in text.lower():
                            return s
                    return text
    except Exception as e:
        logger.error(f"Gemini sentiment analysis failed: {e}")

    return None
