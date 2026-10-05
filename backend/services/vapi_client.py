"""Async client for the VAPI REST API (https://api.vapi.ai) and the payload builders NEXUS uses with it.

Two halves:
  1. One thin function per VAPI endpoint we use (assistants, calls, tools, files, phone
     numbers). Each opens a short-lived httpx client, authenticates with
     settings.vapi_api_key and raises VapiAPIError on any non-2xx response. Functions
     that do not pass a timeout get httpx's default (5 seconds).
  2. Pure helpers that build request bodies: voice / language / transcriber resolution,
     per-language prompt directives, and the assistant, transfer-tool and fallback-assistant
     payloads.

Used by routers (agents, telephony, tools, conversations, admin) and services (agent_tools,
call_events, agent_events_sync, automation_engine, callback_scheduler, vapi_sync).
This module touches no database tables; it only talks to VAPI over HTTP.
"""
import httpx
from config import settings

BASE_URL = "https://api.vapi.ai"


def _headers():
    """Bearer-token and JSON content-type headers for a VAPI request (key read from settings at call time)."""
    return {
        "Authorization": f"Bearer {settings.vapi_api_key}",
        "Content-Type": "application/json",
    }


class VapiAPIError(Exception):
    """Raised when VAPI returns a non-2xx response, with the body included."""
    pass


def _check(response: httpx.Response) -> None:
    """Raise VapiAPIError for any non-2xx response.

    The message is "<status> <reason> — <body>" with the body cut to its first 500
    characters. Routers (e.g. routers/agents.py) log this text and return a generic
    error to the client instead of passing it through.
    """
    if 200 <= response.status_code < 300:
        return
    body = response.text[:500] if response.text else ""
    raise VapiAPIError(f"{response.status_code} {response.reason_phrase} — {body}")


async def create_assistant(payload: dict) -> dict:
    """POST /assistant: create an assistant and return VAPI's JSON (its "id" is what
    NEXUS stores as ai_agents.vapi_assistant_id). Build the payload with
    build_assistant_payload()."""
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.post(f"{BASE_URL}/assistant", headers=_headers(), json=payload)
        _check(r)
        return r.json()


async def update_assistant(assistant_id: str, payload: dict) -> dict:
    """PATCH /assistant/{id}: change only the top-level keys present in `payload`.
    Callers that touch the model send a complete "model" block (messages and toolIds
    together), see update_agent in routers/agents.py."""
    async with httpx.AsyncClient() as client:
        r = await client.patch(f"{BASE_URL}/assistant/{assistant_id}", headers=_headers(), json=payload)
        _check(r)
        return r.json()


async def delete_assistant(assistant_id: str) -> None:
    """DELETE /assistant/{id}. Returns nothing; raises VapiAPIError on failure (including an unknown id)."""
    async with httpx.AsyncClient() as client:
        r = await client.delete(f"{BASE_URL}/assistant/{assistant_id}", headers=_headers())
        _check(r)


async def get_assistant(assistant_id: str) -> dict:
    """GET /assistant/{id}: fetch an assistant's current configuration as VAPI stores it."""
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
    """POST /tool: create a standalone tool (for example a function tool or a transferCall tool).
    Attach it to an assistant by putting the returned "id" in the assistant's model.toolIds."""
    async with httpx.AsyncClient() as client:
        r = await client.post(f"{BASE_URL}/tool", headers=_headers(), json=payload)
        _check(r)
        return r.json()


async def update_tool(tool_id: str, payload: dict) -> dict:
    """PATCH /tool/{id}. VAPI rejects a "type" key on updates, so callers drop it from
    the create payload first (see sync_events_tool in services/call_events.py)."""
    async with httpx.AsyncClient() as client:
        r = await client.patch(f"{BASE_URL}/tool/{tool_id}", headers=_headers(), json=payload)
        _check(r)
        return r.json()


async def delete_tool(tool_id: str) -> None:
    """DELETE /tool/{id}. Returns nothing; raises VapiAPIError on failure."""
    async with httpx.AsyncClient() as client:
        r = await client.delete(f"{BASE_URL}/tool/{tool_id}", headers=_headers())
        _check(r)


async def upload_file(file_bytes: bytes, filename: str) -> dict:
    """POST /file: multipart upload of a document (agent knowledge files). Returns VAPI's
    file object, whose "id" identifies the file in later calls."""
    async with httpx.AsyncClient() as client:
        r = await client.post(
            f"{BASE_URL}/file",
            # Authorization only, deliberately not _headers(): its JSON Content-Type
            # would override the multipart boundary httpx generates for `files=`.
            headers={"Authorization": f"Bearer {settings.vapi_api_key}"},
            files={"file": (filename, file_bytes)},
        )
        _check(r)
        return r.json()


async def delete_file(file_id: str) -> None:
    """DELETE /file/{id}: remove a file uploaded with upload_file(). Raises VapiAPIError on failure."""
    async with httpx.AsyncClient() as client:
        r = await client.delete(f"{BASE_URL}/file/{file_id}", headers=_headers())
        _check(r)


async def create_call(payload: dict) -> dict:
    """POST /call: start an outbound call. The payload is assembled by the callers
    (routers/telephony.py, services/automation_engine.py, services/callback_scheduler.py);
    the returned JSON's "id" is the VAPI call id, which get_call() accepts."""
    async with httpx.AsyncClient() as client:
        r = await client.post(f"{BASE_URL}/call", headers=_headers(), json=payload)
        _check(r)
        return r.json()


async def list_phone_numbers() -> list:
    """GET /phone-number: every number on the VAPI account behind settings.vapi_api_key
    (not filtered per NEXUS user)."""
    async with httpx.AsyncClient() as client:
        r = await client.get(f"{BASE_URL}/phone-number", headers=_headers())
        _check(r)
        return r.json()


async def get_phone_number(phone_id: str) -> dict:
    """GET /phone-number/{id}: one VAPI phone number (phone_id is phone_numbers.vapi_phone_id)."""
    async with httpx.AsyncClient() as client:
        r = await client.get(f"{BASE_URL}/phone-number/{phone_id}", headers=_headers())
        _check(r)
        return r.json()


async def create_phone_number(payload: dict) -> dict:
    """POST /phone-number: register a number with VAPI, optionally pointing it at an
    assistant via "assistantId". The provider-specific payload ("vapi" or "twilio") is
    built in routers/telephony.py."""
    async with httpx.AsyncClient() as client:
        r = await client.post(f"{BASE_URL}/phone-number", headers=_headers(), json=payload)
        _check(r)
        return r.json()


async def update_phone_number(phone_id: str, payload: dict) -> dict:
    """PATCH /phone-number/{id}. Mainly used to re-route inbound calls by changing
    "assistantId" (a real agent, the shared balance-fallback assistant, or None to detach)."""
    async with httpx.AsyncClient() as client:
        r = await client.patch(f"{BASE_URL}/phone-number/{phone_id}", headers=_headers(), json=payload)
        _check(r)
        return r.json()


async def delete_phone_number(phone_id: str) -> None:
    """DELETE /phone-number/{id}: remove the number from VAPI. Raises VapiAPIError on failure."""
    async with httpx.AsyncClient() as client:
        r = await client.delete(f"{BASE_URL}/phone-number/{phone_id}", headers=_headers())
        _check(r)


# Vapi's own built-in voice provider (provider="vapi") — real voices available on
# every Vapi account with no third-party provider key required. voiceIds are exact
# (case-sensitive on Vapi's side); we accept any casing from the wizard and map to
# the canonical form. Verified directly against Vapi's live assistant-creation API
# (POST /assistant), which validates voiceId strictly and rejects unknown values with
# a 400 listing every currently-valid id — these 13 bare names all confirmed valid.
# Do NOT add a " New" suffix or a "version" field speculatively based on Vapi's docs
# site: the docs page previously seen for this project did not match the live API and
# caused a real regression (see git history) — trust a live create_assistant() +
# get_assistant() round trip over the docs if the two ever disagree again.
_VAPI_VOICE_IDS = [
    "Elliot", "Savannah", "Rohan", "Emma", "Clara", "Nico", "Kai",
    "Sagar", "Godfrey", "Neil", "Layla", "Sid", "Naina",
]
# Lower-cased name -> canonical casing. Not referenced elsewhere at the moment;
# _VOICE_REGISTRY below is what _resolve_voice actually looks names up in.
_VAPI_VOICE_CANONICAL = {v.lower(): v for v in _VAPI_VOICE_IDS}
# Fallback for English agents whose voice is blank or unrecognized (see _resolve_voice).
_DEFAULT_VAPI_VOICE = "Elliot"

# ElevenLabs premade voices — used for Urdu (and any other non-English language) via
# the eleven_multilingual_v2 model, since that model speaks many languages through any
# of its voice ids (the voice itself isn't language-locked; ElevenLabs' own catalog has
# no Urdu-specific voice). Both ids confirmed live against Vapi's POST /assistant.
# Display names ("Zara"/"Ali") are ours, not ElevenLabs' own voice names — matches the
# style of _VAPI_VOICE_IDS above. This is also the same catalog the AI Voices browsing
# page (src/pages/dashboard/AIVoices.tsx) offers, so both stay in sync.
_URDU_VOICE_IDS = {
    "zara": "21m00Tcm4TlvDq8ikWAM",  # female (ElevenLabs "Rachel")
    "ali": "pNInz6obpgDQGcFmaJgB",   # male (ElevenLabs "Adam")
}
# Fallback for non-English agents whose voice is blank or unrecognized (see _resolve_voice).
_DEFAULT_URDU_VOICE = _URDU_VOICE_IDS["zara"]

# Every voice name the app recognizes, regardless of which language an agent is set
# to — lets an agent's voice be picked independently from the full catalog (matching
# the AI Voices page) rather than only from whichever short list matched its language.
# Keys are lower-cased voice names; values are ready-to-send VAPI "voice" blocks.
_VOICE_REGISTRY: dict[str, dict] = {
    name.lower(): {"provider": "vapi", "voiceId": name} for name in _VAPI_VOICE_IDS
}
_VOICE_REGISTRY.update({
    name: {"provider": "11labs", "voiceId": voice_id, "model": "eleven_multilingual_v2"}
    for name, voice_id in _URDU_VOICE_IDS.items()
})


def _resolve_voice(voice: str | None, language: str | None = None) -> dict:
    """Return a VAPI-compatible voice block by looking up 'voice' in the full catalog
    (Vapi's own English voices + the ElevenLabs multilingual ones) — independent of
    'language', so any voice can be paired with any language the UI offers.

    If 'voice' is blank/unrecognized, fall back to a sensible default for the
    language: Vapi's 'Elliot' for English, the ElevenLabs 'Zara' for anything else
    (Vapi's own voices can't speak non-English languages). Requires an ElevenLabs
    provider key configured on the VAPI account/dashboard for the ElevenLabs voices."""
    raw = (voice or "").strip().lower()
    if raw in _VOICE_REGISTRY:
        # Copy so a caller that edits the block cannot mutate the shared registry entry.
        return dict(_VOICE_REGISTRY[raw])
    # Unknown voice: only English falls back to a built-in Vapi voice; every other
    # language gets the ElevenLabs multilingual default below.
    if _resolve_language(language) in ("en", "en-US", "en-GB"):
        return {"provider": "vapi", "voiceId": _DEFAULT_VAPI_VOICE}
    return {"provider": "11labs", "voiceId": _DEFAULT_URDU_VOICE, "model": "eleven_multilingual_v2"}


def _resolve_language(language: str | None) -> str:
    """Accept 'English (US)' / 'en-US' / 'en' — emit a Deepgram-compatible language code."""
    if not language:
        return "en"
    raw = language.strip()
    # 'English (US)' -> 'en-US' (Deepgram accepts en, en-US, etc.)
    lookup = {
        "english": "en",
        # Kept for agents saved before the language list was simplified to just "English".
        "english (us)": "en-US",
        "english (uk)": "en-GB",
        "spanish (es)": "es",
        "spanish (mx)": "es",
        "french (fr)":  "fr",
        "italian (it)": "it",
        "german (de)":  "de",
        "urdu": "ur",
        "urdu (pk)": "ur",
        "multilingual": "multi",
    }
    # Anything not in the table is passed through unchanged when it is short enough to
    # be a language code already (e.g. "fr", "pt-BR"); longer free text falls back to "en".
    return lookup.get(raw.lower(), raw if len(raw) <= 5 else "en")


def _resolve_transcriber(language: str | None) -> dict:
    """Deepgram transcriber block. Urdu (added Feb 2026) is only available on Nova-3,
    so that language pins the model explicitly; other languages keep Vapi's default.
    "multi" (Multilingual — auto-detects/code-switches between languages within a call)
    is also pinned to Nova-3 for its broader per-language coverage — confirmed live
    against Vapi's POST /assistant that "multi" is accepted on both Nova-2 and Nova-3."""
    lang_code = _resolve_language(language)
    transcriber = {"provider": "deepgram", "language": lang_code}
    if lang_code in ("ur", "multi"):
        transcriber["model"] = "nova-3"
    return transcriber


# GPT tends to reply in native Nastaliq script even when the agent's own prompt is
# written in Roman Urdu, unless told not to — and the TTS voice needs the reply in
# whatever script the prompt uses, so an unwanted script switch reads oddly out loud.
# This is prepended (never stored in the agent's own system_prompt) so the prompt shown
# in the UI stays exactly what the user wrote.
_URDU_SCRIPT_DIRECTIVE = (
    "ZAROORI HUKAM — SCRIPT (MUST FOLLOW): Aap hamesha apne HAR jawab sirf ROMAN URDU "
    "(Latin/English alphabet) mein likhein — jaise \"Aap kaisay hain\", \"Shukriya\". "
    "Urdu script (Nastaliq/Arabic letters) KABHI istemal na karein, chahe user Urdu script "
    "mein type/bole. Ye rule sab se zyada zaroori hai aur har jawab par apply hota hai.\n\n---\n\n"
)


# Multilingual agents must follow the caller's language rather than a single fixed
# one — without this, GPT tends to default to English regardless of what the caller
# actually speaks. For Urdu specifically, this must match _URDU_SCRIPT_DIRECTIVE's
# proven convention (Roman Urdu, never Nastaliq) — a caller shouldn't get different
# script behavior depending on whether the agent's language is set to "Urdu" or
# "Multilingual".
#
# Deepgram's "multi" transcriber (see _resolve_transcriber) has no dedicated Urdu
# detector — spoken Urdu and spoken Hindi are phonetically identical (Hindustani), so
# it transcribes Urdu speech using Hindi's Devanagari script. Without the second
# paragraph below, GPT reads that mislabeled Devanagari input and, per "reply in the
# same script," replies in Devanagari too — which the voice engine then actually
# speaks aloud as Hindi. This platform has no Hindi language option anywhere, so any
# Devanagari input is always this exact transcription mismatch, never a real Hindi
# caller.
_MULTILINGUAL_DIRECTIVE = (
    "IMPORTANT — LANGUAGE (MUST FOLLOW): Detect the language the caller is speaking "
    "and always reply in that same language — do not switch languages on your own. "
    "If the caller's language isn't clear yet, default to English until they make it "
    "clear, then continue in their language for the rest of the call.\n\n"
    "SPECIAL CASE — DEVANAGARI/HINDI SCRIPT INPUT: If the caller's transcribed text "
    "appears in Devanagari (Hindi) script, this is a transcription limitation, not a "
    "real Hindi speaker — always treat it as Urdu, never Hindi.\n\n"
    "SCRIPT RULE FOR URDU (MUST FOLLOW): Whenever you reply in Urdu — whether the "
    "caller's speech came through as Urdu directly or as the Devanagari mislabeling "
    "above — always write your reply in ROMAN URDU (Latin/English alphabet), e.g. "
    "\"Aap kaisay hain\", \"Shukriya\". NEVER use Urdu script (Nastaliq/Arabic letters) "
    "or Devanagari (Hindi) script, no matter what script the caller's own speech came "
    "through as.\n\n---\n\n"
)


def apply_language_directive(system_prompt: str | None, language: str | None) -> str:
    """Prepend any language-specific behavioral instruction the model needs beyond what
    the agent's own prompt says (Urdu needs a script directive; Multilingual needs a
    caller-language-matching directive)."""
    prompt = system_prompt or ""
    lang_code = _resolve_language(language)
    if lang_code == "ur":
        return _URDU_SCRIPT_DIRECTIVE + prompt
    if lang_code == "multi":
        return _MULTILINGUAL_DIRECTIVE + prompt
    return prompt


import re


def _tool_name_slug(agent_name: str | None) -> str:
    """Turn an agent name into a token safe to embed in a tool function name: runs of
    non-alphanumeric characters become a single "_", ends are trimmed, and an empty
    result (or a missing name) becomes "agent"."""
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
            # E.164 format is validated when the agent is saved (see
            # _validate_transfer_number in routers/agents.py); only whitespace is trimmed here.
            "number": number.strip(),
            # VAPI template variable, filled in at call time with the customer's own
            # phone number; used as the caller ID of the transferred leg.
            "callerId": "{{customer.number}}",
            # Spoken to the caller just before the transfer starts.
            "message": "Please hold while I connect you.",
            "description": "Transfer to this destination",
        }],
    }


def build_fallback_assistant_payload() -> dict:
    """A minimal, shared assistant used to answer inbound calls for accounts whose
    wallet balance is empty. Plays a short message and hangs up — `maxDurationSeconds`
    ends the call reliably without depending on the model invoking an end-call tool."""
    # Created once by routers/telephony.py (_get_or_create_fallback_assistant_id); its id
    # is cached in platform_settings.fallback_assistant_id and shared by every account.
    return {
        "name": "NEXUS — Balance Unavailable",
        "firstMessage": (
            "We're sorry, this line is temporarily unavailable because the account "
            "balance is empty. Please contact the account owner. Goodbye."
        ),
        # Minimal model config; the system message keeps it quiet after the firstMessage.
        "model": {
            "provider": "openai",
            "model": "gpt-4o-mini",
            "messages": [
                {"role": "system", "content": "Say only the first message, then stay silent."}
            ],
        },
        "transcriber": {"provider": "deepgram", "language": "en"},
        "voice": _resolve_voice(None),
        # Hard limits so the call always ends: 15 s total, or 5 s of silence.
        "maxDurationSeconds": 15,
        "silenceTimeoutSeconds": 5,
    }


def build_assistant_payload(name: str, voice: str = None, language: str = "en",
                             system_prompt: str = None, first_message: str = None,
                             tool_ids: list[str] | None = None) -> dict:
    """Build the POST /assistant body for one NEXUS agent.

    Args:
        name: assistant name shown in VAPI.
        voice: voice name from the catalog (any casing); blank/unknown falls back per language.
        language: UI label or language code; drives the transcriber, voice fallback and
            any language directive prepended to the prompt.
        system_prompt: the system message; defaults to a generic "You are {name}" prompt.
        first_message: what the assistant says first; the key is omitted when empty.
        tool_ids: VAPI tool ids to attach through model.toolIds.

    Always uses OpenAI gpt-4o-mini, a Deepgram transcriber, and call recording plus
    transcripts. Adds the webhook "server" block only when settings.public_api_url is set.
    """
    content = system_prompt or f"You are {name}, a helpful AI assistant."
    model: dict = {
        "provider": "openai",
        "model": "gpt-4o-mini",
        "messages": [
            # The language directive is applied here, to the copy sent to VAPI only;
            # the prompt stored on the agent row never contains it.
            {"role": "system", "content": apply_language_directive(content, language)}
        ],
    }
    if tool_ids:
        model["toolIds"] = tool_ids

    payload: dict = {
        "name": name,
        "transcriber": _resolve_transcriber(language),
        "model": model,
        "voice": _resolve_voice(voice, language),
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
        # Sent only when configured; routers/webhooks.py verifies requests against the
        # same secret (HMAC-SHA256 signature header), and skips the check when it is empty.
        if settings.vapi_webhook_secret:
            server["secret"] = settings.vapi_webhook_secret
        payload["server"] = server
        payload["serverMessages"] = ["end-of-call-report", "status-update"]

    return payload
