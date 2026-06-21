"""
VAPI tool callback receiver.

When an assistant invokes one of the preset tools during a call, VAPI POSTs
to /tools/internal/<tool>. We look up the owning user via assistantId,
execute the action against their stored integrations, and return the
result VAPI expects:

    { "results": [ { "toolCallId": "...", "result": "..." } ] }
"""

import logging
import httpx
from fastapi import APIRouter, Request
from slowapi import Limiter
from slowapi.util import get_remote_address
from database import supabase
from services.email_service import send_email
from services.sms_service import send_sms

logger = logging.getLogger(__name__)
limiter = Limiter(key_func=get_remote_address)
router = APIRouter(prefix="/tools/internal", tags=["Agent Tool Callbacks"])


def _user_id_from_assistant(assistant_id: str) -> str | None:
    if not assistant_id:
        return None
    res = (
        supabase.table("ai_agents")
        .select("user_id")
        .eq("vapi_assistant_id", assistant_id)
        .maybe_single()
        .execute()
    )
    return res.data.get("user_id") if res.data else None


async def _parse_tool_call(request: Request) -> tuple[str | None, dict, str | None]:
    """Returns (toolCallId, arguments, assistantId) from VAPI's payload."""
    try:
        body = await request.json()
    except Exception:
        return None, {}, None

    msg = body.get("message") or body
    call = msg.get("call") or {}
    assistant_id = call.get("assistantId") or msg.get("assistantId")
    tool_calls = msg.get("toolCalls") or msg.get("tool_calls") or []
    if not tool_calls:
        return None, {}, assistant_id

    tc = tool_calls[0]
    tc_id = tc.get("id") or tc.get("toolCallId")
    fn = tc.get("function") or {}
    args = fn.get("arguments") or {}
    if isinstance(args, str):
        import json
        try:
            args = json.loads(args)
        except Exception:
            args = {}
    return tc_id, args, assistant_id


def _result(tc_id: str | None, result: str) -> dict:
    return {"results": [{"toolCallId": tc_id, "result": result}]}


@router.post("/send-email")
@limiter.limit("60/minute")
async def cb_send_email(request: Request):
    tc_id, args, assistant_id = await _parse_tool_call(request)
    user_id = _user_id_from_assistant(assistant_id)
    if not user_id:
        return _result(tc_id, "Error: could not identify the owning user.")

    to = (args.get("to") or "").strip()
    subject = (args.get("subject") or "").strip() or "Follow-up"
    body_text = args.get("body") or ""
    if not to:
        return _result(tc_id, "Error: missing recipient email address.")

    try:
        await send_email(user_id, to, subject, body_text)
        return _result(tc_id, f"Email sent to {to}.")
    except Exception as e:
        logger.warning("Tool send_email failed: %s", e)
        return _result(tc_id, f"Failed to send email: {e}")


@router.post("/send-sms")
@limiter.limit("60/minute")
async def cb_send_sms(request: Request):
    tc_id, args, assistant_id = await _parse_tool_call(request)
    user_id = _user_id_from_assistant(assistant_id)
    if not user_id:
        return _result(tc_id, "Error: could not identify the owning user.")

    to = (args.get("to") or "").strip()
    message = args.get("message") or ""
    if not to:
        return _result(tc_id, "Error: missing recipient phone number.")

    try:
        await send_sms(user_id, to, message)
        return _result(tc_id, f"SMS sent to {to}.")
    except Exception as e:
        logger.warning("Tool send_sms failed: %s", e)
        return _result(tc_id, f"Failed to send SMS: {e}")


@router.post("/update-crm")
@limiter.limit("60/minute")
async def cb_update_crm(request: Request):
    tc_id, args, assistant_id = await _parse_tool_call(request)
    user_id = _user_id_from_assistant(assistant_id)
    if not user_id:
        return _result(tc_id, "Error: could not identify the owning user.")

    phone = (args.get("contact_phone") or "").strip()
    updates = args.get("updates") or {}
    if not phone or not isinstance(updates, dict) or not updates:
        return _result(tc_id, "Error: contact_phone and a non-empty updates object are required.")

    allowed = {"status", "notes", "name", "email"}
    safe_updates = {k: v for k, v in updates.items() if k in allowed}
    if not safe_updates:
        return _result(tc_id, f"Error: only these fields are updatable: {sorted(allowed)}.")

    res = (
        supabase.table("contacts")
        .update(safe_updates)
        .eq("user_id", user_id)
        .eq("phone", phone)
        .execute()
    )
    n = len(res.data or [])
    if n == 0:
        return _result(tc_id, f"No contact found with phone {phone}.")
    return _result(tc_id, f"Updated {n} contact(s): {list(safe_updates.keys())}.")


@router.post("/book-slot")
@limiter.limit("60/minute")
async def cb_book_slot(request: Request):
    tc_id, args, assistant_id = await _parse_tool_call(request)
    user_id = _user_id_from_assistant(assistant_id)
    if not user_id:
        return _result(tc_id, "Error: could not identify the owning user.")

    # No calendar integration yet — log the request as a conversation note.
    contact = args.get("contact_name") or "the caller"
    start = args.get("start_iso") or "an unspecified time"
    duration = args.get("duration_minutes", 30)
    logger.info("Book-slot requested by user %s: %s @ %s for %sm", user_id, contact, start, duration)
    return _result(
        tc_id,
        f"Noted: meeting with {contact} at {start} for {duration} minutes. "
        "Calendar integration is not connected yet, so the slot was logged but not booked.",
    )


@router.post("/webhook")
@limiter.limit("60/minute")
async def cb_webhook(request: Request):
    tc_id, args, assistant_id = await _parse_tool_call(request)
    user_id = _user_id_from_assistant(assistant_id)
    if not user_id:
        return _result(tc_id, "Error: could not identify the owning user.")

    event_name = args.get("event_name") or "agent_event"
    payload = args.get("payload") or {}

    # Find the user's first active webhook integration with a 'url' field.
    integrations = (
        supabase.table("integrations")
        .select("config_encrypted, name")
        .eq("user_id", user_id)
        .eq("status", "Active")
        .execute()
    )
    from services.encryption import decrypt_config
    target_url = None
    for row in (integrations.data or []):
        if not row.get("config_encrypted"):
            continue
        try:
            cfg = decrypt_config(row["config_encrypted"])
        except Exception:
            continue
        url = cfg.get("webhookUrl") or cfg.get("url")
        if url:
            target_url = url
            break

    if not target_url:
        return _result(tc_id, "No webhook URL is configured in Integrations.")

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.post(target_url, json={"event": event_name, "payload": payload})
        return _result(tc_id, f"Posted '{event_name}' event to webhook.")
    except Exception as e:
        return _result(tc_id, f"Webhook POST failed: {e}")
