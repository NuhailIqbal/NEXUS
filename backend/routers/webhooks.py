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


async def _handle_call_started(payload: dict):
    msg = payload.get("message", {})
    call_obj = msg.get("call", {})
    vapi_call_id = _extract_call_id(payload)
    assistant_id = _extract_assistant_id(payload)
    user_id = _find_user_for_assistant(assistant_id)
    phone = _extract_phone_number(payload)

    if not user_id or not vapi_call_id:
        logger.warning("call-started: missing user_id or call_id, skipping")
        return

    direction = call_obj.get("type", "outboundPhoneCall")
    dir_label = "inbound" if "inbound" in direction.lower() else "outbound"

    row = {
        "user_id": user_id,
        "vapi_call_id": vapi_call_id,
        "channel": "Phone",
        "status": "In Progress",
        "direction": dir_label,
        "phone": phone,
        "contact_name": phone,
    }

    agent_row = (
        supabase.table("ai_agents")
        .select("id")
        .eq("vapi_assistant_id", assistant_id)
        .limit(1)
        .execute()
    )
    if agent_row.data:
        row["agent_id"] = agent_row.data[0]["id"]

    if phone:
        contact = (
            supabase.table("contacts")
            .select("id, name")
            .eq("user_id", user_id)
            .eq("phone", phone)
            .limit(1)
            .execute()
        )
        if contact.data:
            row["contact_name"] = contact.data[0]["name"]
            row["contact_id"] = contact.data[0]["id"]

    supabase.table("conversations").insert(row).execute()
    if user_id:
        increment_usage(user_id, dir_label)
    logger.info(f"call-started logged: {vapi_call_id}")


async def _handle_call_ended(payload: dict):
    msg = payload.get("message", {})
    call_obj = msg.get("call", {})
    vapi_call_id = _extract_call_id(payload)

    if not vapi_call_id:
        logger.warning("call-ended: no call_id, skipping")
        return

    transcript = msg.get("transcript", "")
    recording_url = msg.get("recordingUrl") or call_obj.get("recordingUrl")
    duration_seconds = msg.get("durationSeconds") or call_obj.get("duration")
    status = call_obj.get("status", "completed")
    ended_reason = call_obj.get("endedReason", "")

    duration_str = None
    if duration_seconds:
        mins = int(float(duration_seconds)) // 60
        secs = int(float(duration_seconds)) % 60
        duration_str = f"{mins}:{secs:02d}"

    call_status = "Completed"
    if "failed" in status.lower() or "error" in ended_reason.lower():
        call_status = "Failed"
    elif "no-answer" in ended_reason.lower():
        call_status = "No Answer"

    updates = {
        "status": call_status,
        "transcript": transcript,
        "recording_url": recording_url,
        "duration": duration_str,
    }

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

    if existing.data:
        supabase.table("conversations").update(updates).eq("vapi_call_id", vapi_call_id).execute()
        logger.info(f"call-ended updated: {vapi_call_id}")
        conv_id = existing.data[0]["id"]
        assistant_id = _extract_assistant_id(payload)
        user_id = _find_user_for_assistant(assistant_id)
    else:
        assistant_id = _extract_assistant_id(payload)
        user_id = _find_user_for_assistant(assistant_id)
        if user_id:
            updates["user_id"] = user_id
            updates["vapi_call_id"] = vapi_call_id
            updates["channel"] = "Phone"
            updates["phone"] = _extract_phone_number(payload)
            insert_result = supabase.table("conversations").insert(updates).execute()
            conv_id = insert_result.data[0]["id"] if insert_result.data else None
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
    if vapi_call_id and status:
        status_map = {
            "ringing": "Ringing",
            "in-progress": "In Progress",
            "forwarding": "Forwarding",
            "ended": "Completed",
        }
        mapped = status_map.get(status, status.title())
        supabase.table("conversations").update({"status": mapped}).eq("vapi_call_id", vapi_call_id).execute()


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

    if event_type == "call-started":
        await _handle_call_started(payload)
    elif event_type == "call-ended":
        await _handle_call_ended(payload)
    elif event_type == "status-update":
        await _handle_status_update(payload)
    elif event_type == "transcript":
        pass
    elif event_type == "tool-calls":
        pass

    return {"received": True, "type": event_type}
