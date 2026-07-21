import hashlib
import hmac
import logging
import asyncio
from fastapi import APIRouter, Request, HTTPException, Header
from slowapi import Limiter
from slowapi.util import get_remote_address
from config import settings
from database import supabase
from services.gemini import summarize_transcript, analyze_sentiment
from services.automation_engine import run_post_call_automations
from routers.billing import increment_usage, check_call_quota, record_call_cost

logger = logging.getLogger(__name__)
limiter = Limiter(key_func=get_remote_address)

router = APIRouter(prefix="/webhooks", tags=["Webhooks"])


def _verify_signature(body: bytes, signature: str) -> bool:
    if not settings.vapi_webhook_secret:
        # In production, config.py refuses to start without the secret, so this
        # branch only fires in development. We still log a loud warning.
        logger.warning("VAPI_WEBHOOK_SECRET is empty — webhook signature is NOT being verified.")
        return True
    expected = hmac.new(
        settings.vapi_webhook_secret.encode(),
        body,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(expected, signature or "")


def _find_user_for_assistant(vapi_assistant_id: str) -> str | None:
    if not vapi_assistant_id:
        return None
    result = (
        supabase.table("ai_agents")
        .select("user_id")
        .eq("vapi_assistant_id", vapi_assistant_id)
        .limit(1)
        .execute()
    )
    if result.data:
        return result.data[0]["user_id"]
    return None


def _extract_assistant_id(payload: dict) -> str | None:
    msg = payload.get("message", {})
    call_obj = msg.get("call", {})
    return call_obj.get("assistantId") or msg.get("assistantId")


def _extract_call_id(payload: dict) -> str | None:
    msg = payload.get("message", {})
    call_obj = msg.get("call", {})
    return call_obj.get("id") or msg.get("callId")


def _extract_phone_number(payload: dict) -> str | None:
    msg = payload.get("message", {})
    call_obj = msg.get("call", {})
    customer = call_obj.get("customer", {})
    return customer.get("number")


# A call counts as "qualified" when the AI handed it off to a human — VAPI
# reports this via endedReason (e.g. "assistant-forwarded-call", "transfer").
def _is_qualified(ended_reason: str) -> bool:
    r = (ended_reason or "").lower()
    return "transfer" in r or "forwarded" in r


def _extract_transfer_destination(payload: dict) -> str | None:
    """Best-effort: pull the number the call was transferred to, if VAPI reports it.

    The transfer target is configured on the VAPI assistant, so it may or may not
    appear in the webhook. We check the common shapes and return None otherwise.
    """
    msg = payload.get("message", {})
    call_obj = msg.get("call", {})
    for src in (msg, call_obj):
        dest = src.get("destination") or src.get("transferDestination")
        if isinstance(dest, dict):
            num = dest.get("number") or dest.get("sipUri") or dest.get("extension")
            if num:
                return str(num)
        elif isinstance(dest, str) and dest.strip():
            return dest.strip()
    return None


def _norm_role(role: str) -> str:
    """VAPI uses 'bot' for the assistant in artifact.messages, plus tool_* roles.
    Normalize to a small canonical set the UI understands."""
    r = (role or "").lower()
    if r in ("assistant", "bot"):
        return "assistant"
    if r == "user":
        return "user"
    if r in ("tool_calls", "tool_call_result", "tool", "function"):
        return "tool"
    return "system"


def _extract_recording_urls(payload: dict) -> tuple[str | None, str | None]:
    """Return (mono_url, stereo_url). Prefer the structured artifact.recording object,
    then fall back through the deprecated flat mirrors VAPI still sends."""
    msg = payload.get("message", {})
    call_obj = msg.get("call", {})
    artifact = msg.get("artifact") or call_obj.get("artifact") or {}
    rec = artifact.get("recording") or {}
    mono = rec.get("mono") or {}
    mono_url = (
        mono.get("combinedUrl")
        or artifact.get("recordingUrl")
        or msg.get("recordingUrl")
        or call_obj.get("recordingUrl")
    )
    stereo_url = (
        rec.get("stereoUrl")
        or artifact.get("stereoRecordingUrl")
        or msg.get("stereoRecordingUrl")
        or call_obj.get("stereoRecordingUrl")
    )
    return mono_url, stereo_url


def _extract_transcript(payload: dict) -> str:
    msg = payload.get("message", {})
    call_obj = msg.get("call", {})
    artifact = msg.get("artifact") or {}
    return artifact.get("transcript") or msg.get("transcript") or call_obj.get("transcript") or ""


def _extract_transcript_messages(payload: dict) -> list[dict]:
    """Normalize VAPI's structured messages into [{role, text, at, dur}] for the UI.
    Skips the system prompt (never shown to users); maps bot->assistant, tool_* -> tool.
    `at` is seconds-from-call-start (for click-to-seek); `dur` is seconds."""
    msg = payload.get("message", {})
    artifact = msg.get("artifact") or {}
    raw = artifact.get("messages") or msg.get("messages") or []
    out: list[dict] = []
    for m in raw:
        if not isinstance(m, dict):
            continue
        role = _norm_role(m.get("role"))
        if role == "system":
            continue
        text = m.get("message")
        if isinstance(text, list):
            text = " ".join(str(x) for x in text)
        text = (text or "").strip()
        if not text:
            continue
        entry: dict = {"role": role, "text": text}
        at = m.get("secondsFromStart")
        if at is not None:
            try:
                entry["at"] = round(float(at), 2)
            except (TypeError, ValueError):
                pass
        dur = m.get("duration")
        if dur is not None:
            try:
                entry["dur"] = round(float(dur) / 1000.0, 2)  # VAPI reports ms
            except (TypeError, ValueError):
                pass
        out.append(entry)
    return out


def _extract_duration_seconds(payload: dict) -> int | None:
    msg = payload.get("message", {})
    call_obj = msg.get("call", {})
    val = msg.get("durationSeconds") or call_obj.get("duration")
    if val:
        try:
            return int(float(val))
        except (TypeError, ValueError):
            pass
    # Fallback for REST call objects: compute from startedAt/endedAt ISO timestamps.
    started = msg.get("startedAt") or call_obj.get("startedAt")
    ended = msg.get("endedAt") or call_obj.get("endedAt")
    if started and ended:
        try:
            from datetime import datetime
            def _p(s: str):
                return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
            return max(0, int((_p(ended) - _p(started)).total_seconds()))
        except Exception:
            return None
    return None


def _extract_summary(payload: dict) -> str:
    """VAPI's own call analysis summary (used when backfilling from the REST API)."""
    msg = payload.get("message", {})
    analysis = msg.get("analysis") or (msg.get("call", {}) or {}).get("analysis") or {}
    return (analysis.get("summary") if isinstance(analysis, dict) else None) or msg.get("summary") or ""


def _call_to_payload(call: dict) -> dict:
    """Wrap a VAPI REST call object into the {message:{...}} shape the extractors expect."""
    return {"message": {**call, "call": call, "artifact": call.get("artifact") or {}}}


def _status_from_reason(ended_reason: str) -> str:
    low = (ended_reason or "").lower()
    if "error" in low or "failed" in low:
        return "Failed"
    if any(t in low for t in ("did-not-answer", "no-answer", "customer-busy", "voicemail")):
        return "No Answer"
    return "Completed"


def import_vapi_call(call: dict, user_id: str) -> str:
    """Import one VAPI call (from the REST API) into conversations, upserting by
    vapi_call_id. Mirrors recording + transcript + summary, and charges the call's
    cost to the user's wallet exactly once (via record_call_cost, idempotent by the
    ledger). Does not touch the call-count quota (that's for live outbound gating)."""
    vapi_call_id = call.get("id")
    if not vapi_call_id:
        return "skipped"
    payload = _call_to_payload(call)
    transcript = _extract_transcript(payload)
    recording_url, stereo_recording_url = _extract_recording_urls(payload)
    messages = _extract_transcript_messages(payload)
    dur = _extract_duration_seconds(payload)
    summary = _extract_summary(payload)
    ended_reason = call.get("endedReason") or ""

    row: dict = {
        "status": _status_from_reason(ended_reason),
        "transcript": transcript,
        "recording_url": recording_url,
    }
    if stereo_recording_url:
        row["stereo_recording_url"] = stereo_recording_url
    if messages:
        row["transcript_messages"] = messages
    if summary:
        row["ai_summary"] = summary
    if dur:
        row["duration_seconds"] = dur
        row["duration"] = f"{dur // 60}:{dur % 60:02d}"
    if _is_qualified(ended_reason):
        row["qualified"] = True
        dest = _extract_transfer_destination(payload)
        if dest:
            row["transferred_to"] = dest

    if _conversation_id_for(vapi_call_id):
        supabase.table("conversations").update(row).eq("vapi_call_id", vapi_call_id).execute()
        result = "updated"
    else:
        base = _new_conversation_base(payload, user_id)
        base.update(row)
        base.update({"user_id": user_id, "vapi_call_id": vapi_call_id})
        started = call.get("startedAt") or call.get("createdAt")
        if started:
            base["call_time"] = started  # preserve the original call time, not now()
        supabase.table("conversations").insert(base).execute()
        result = "imported"

    # Set the displayed call_cost and charge the wallet once (idempotent).
    if dur:
        record_call_cost(user_id, vapi_call_id, dur)
    return result


def _conversation_id_for(vapi_call_id: str) -> str | None:
    if not vapi_call_id:
        return None
    r = (
        supabase.table("conversations")
        .select("id")
        .eq("vapi_call_id", vapi_call_id)
        .limit(1)
        .execute()
    )
    return r.data[0]["id"] if r.data else None


def _new_conversation_base(payload: dict, user_id: str) -> dict:
    """Base row for a brand-new conversation: direction, phone, and resolved
    agent_id / contact_id / contact_name. Shared by call-start, the status-update
    row-creation path, and the end-of-call insert fallback so every row is linked
    to its agent and contact regardless of which event created it."""
    msg = payload.get("message", {})
    call_obj = msg.get("call", {})
    assistant_id = _extract_assistant_id(payload)
    phone = _extract_phone_number(payload)
    dir_label = "inbound" if "inbound" in (call_obj.get("type") or "").lower() else "outbound"

    row: dict = {
        "channel": "Phone",
        "direction": dir_label,
        "phone": phone,
        "contact_name": phone,
    }
    if assistant_id:
        agent_row = (
            supabase.table("ai_agents").select("id").eq("vapi_assistant_id", assistant_id).limit(1).execute()
        )
        if agent_row.data:
            row["agent_id"] = agent_row.data[0]["id"]
    if phone:
        contact = (
            supabase.table("contacts").select("id, name").eq("user_id", user_id).eq("phone", phone).limit(1).execute()
        )
        if contact.data:
            row["contact_name"] = contact.data[0]["name"]
            row["contact_id"] = contact.data[0]["id"]
    return row


def _create_conversation(payload: dict, user_id: str, vapi_call_id: str, status: str) -> str | None:
    """Insert a new conversation row (linked to agent/contact) and meter usage
    exactly once. Returns the new row id, or None if insert failed."""
    row = _new_conversation_base(payload, user_id)
    row.update({"user_id": user_id, "vapi_call_id": vapi_call_id, "status": status})
    result = supabase.table("conversations").insert(row).execute()
    increment_usage(user_id, row["direction"])
    return result.data[0]["id"] if result.data else None


async def _handle_call_started(payload: dict):
    vapi_call_id = _extract_call_id(payload)
    user_id = _find_user_for_assistant(_extract_assistant_id(payload))
    if not user_id or not vapi_call_id:
        logger.warning("call-started: missing user_id or call_id, skipping")
        return
    if _conversation_id_for(vapi_call_id):
        return  # already created (e.g. by a prior status-update)
    _create_conversation(payload, user_id, vapi_call_id, "In Progress")
    logger.info(f"call-started logged: {vapi_call_id}")


async def _handle_call_ended(payload: dict):
    msg = payload.get("message", {})
    call_obj = msg.get("call", {})
    vapi_call_id = _extract_call_id(payload)

    if not vapi_call_id:
        logger.warning("call-ended: no call_id, skipping")
        return

    transcript = _extract_transcript(payload)
    recording_url, stereo_recording_url = _extract_recording_urls(payload)
    transcript_messages = _extract_transcript_messages(payload)
    duration_seconds = _extract_duration_seconds(payload)
    status = call_obj.get("status", "completed")
    ended_reason = msg.get("endedReason") or call_obj.get("endedReason", "")

    duration_str = None
    if duration_seconds:
        mins = int(duration_seconds) // 60
        secs = int(duration_seconds) % 60
        duration_str = f"{mins}:{secs:02d}"

    # Map VAPI's real endedReason tokens (e.g. "customer-did-not-answer",
    # "customer-busy", "assistant-error", "pipeline-error-*") to a status.
    low = (ended_reason or "").lower()
    call_status = "Completed"
    if "error" in low or "failed" in low or "failed" in status.lower():
        call_status = "Failed"
    elif any(t in low for t in ("did-not-answer", "no-answer", "customer-busy", "voicemail")):
        call_status = "No Answer"

    updates = {
        "status": call_status,
        "transcript": transcript,
        "recording_url": recording_url,
        "duration": duration_str,
    }
    if stereo_recording_url:
        updates["stereo_recording_url"] = stereo_recording_url
    if transcript_messages:
        updates["transcript_messages"] = transcript_messages
    if duration_seconds:
        updates["duration_seconds"] = duration_seconds

    # Qualified = call was transferred/forwarded to a human (mirrors the "pings"
    # service, which marks IsQualified when endedReason is transfer/forwarded).
    if _is_qualified(ended_reason):
        updates["qualified"] = True
        dest = _extract_transfer_destination(payload)
        if dest:
            updates["transferred_to"] = dest
        logger.info(f"call-ended qualified (transferred): {vapi_call_id} -> {dest or 'unknown'}")

    existing = (
        supabase.table("conversations")
        .select("id")
        .eq("vapi_call_id", vapi_call_id)
        .limit(1)
        .execute()
    )

    user_id = _find_user_for_assistant(_extract_assistant_id(payload))

    if existing.data:
        supabase.table("conversations").update(updates).eq("vapi_call_id", vapi_call_id).execute()
        logger.info(f"call-ended updated: {vapi_call_id}")
        conv_id = existing.data[0]["id"]
    elif user_id:
        # No row yet (call-started/status-update never arrived) — create a fully
        # linked row here and meter usage exactly once.
        base = _new_conversation_base(payload, user_id)
        base.update(updates)
        base.update({"user_id": user_id, "vapi_call_id": vapi_call_id})
        insert_result = supabase.table("conversations").insert(base).execute()
        conv_id = insert_result.data[0]["id"] if insert_result.data else None
        increment_usage(user_id, base["direction"])
        logger.info(f"call-ended inserted: {vapi_call_id}")
    else:
        return

    if user_id and duration_seconds:
        dur_int = int(float(duration_seconds))
        if dur_int > 0:
            cost = record_call_cost(user_id, vapi_call_id, dur_int)
            logger.info(f"Call cost recorded: {vapi_call_id} — {dur_int}s, ${cost}")

    asyncio.create_task(_post_call_ai(vapi_call_id, transcript, conv_id))


async def _post_call_ai(vapi_call_id: str, transcript: str, conv_id: str):
    try:
        conv = (
            supabase.table("conversations")
            .select("*")
            .eq("id", conv_id)
            .maybe_single()
            .execute()
        )
        conversation = conv.data if conv.data else {}
        user_id = conversation.get("user_id")

        if transcript:
            summary, sentiment = await asyncio.gather(
                summarize_transcript(transcript, conversation.get("contact_name")),
                analyze_sentiment(transcript),
            )
            ai_updates = {}
            if summary:
                ai_updates["ai_summary"] = summary
            if sentiment:
                ai_updates["conversion"] = sentiment
            if ai_updates:
                supabase.table("conversations").update(ai_updates).eq("id", conv_id).execute()
                logger.info(f"AI summary written for {vapi_call_id}")

        if user_id:
            await run_post_call_automations(user_id, conversation)

    except Exception as e:
        logger.error(f"Post-call AI processing failed for {vapi_call_id}: {e}")


async def _handle_status_update(payload: dict):
    msg = payload.get("message", {})
    vapi_call_id = _extract_call_id(payload)
    status = msg.get("status", "")
    if not (vapi_call_id and status):
        return

    status_map = {
        "ringing": "Ringing",
        "in-progress": "In Progress",
        "forwarding": "Forwarding",
        "ended": "Completed",
    }
    mapped = status_map.get(status, status.title())

    conv_id = _conversation_id_for(vapi_call_id)
    if conv_id:
        supabase.table("conversations").update({"status": mapped}).eq("vapi_call_id", vapi_call_id).execute()
        return

    # First signal we've seen for this call (VAPI doesn't send a "call-started"
    # event) — create the live row now and meter usage exactly once. The
    # end-of-call-report will later fill in transcript/recording/cost.
    if status in ("ringing", "in-progress", "forwarding"):
        user_id = _find_user_for_assistant(_extract_assistant_id(payload))
        if user_id:
            _create_conversation(payload, user_id, vapi_call_id, mapped)
            logger.info(f"status-update created live row: {vapi_call_id} ({mapped})")


@router.post("/vapi")
@limiter.limit("120/minute")
async def vapi_webhook(
    request: Request,
    x_vapi_signature: str = Header(None),
):
    body = await request.body()

    if not _verify_signature(body, x_vapi_signature):
        raise HTTPException(status_code=401, detail="Invalid webhook signature")

    payload = await request.json()
    msg = payload.get("message", {})
    event_type = msg.get("type", "")

    logger.info(f"VAPI webhook: {event_type}")

    # VAPI's real post-call event is "end-of-call-report" (rich data under
    # message.artifact). "call-started"/"call-ended" are kept as aliases for any
    # legacy/custom senders.
    if event_type in ("call-started",):
        await _handle_call_started(payload)
    elif event_type in ("end-of-call-report", "call-ended"):
        await _handle_call_ended(payload)
    elif event_type == "status-update":
        await _handle_status_update(payload)
    elif event_type == "transcript":
        pass
    elif event_type == "tool-calls":
        pass

    return {"received": True, "type": event_type}
