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
from services.call_events import record_hit
from services import calendar_service

logger = logging.getLogger(__name__)
limiter = Limiter(key_func=get_remote_address)
# These endpoints are called by VAPI mid-call, not by logged-in dashboard users: there is no
# user JWT, and the /tools/internal/ prefix is exempt from TeamRoleGuard (main.py). The owning
# account is derived from the assistant id in the payload. Failures are returned as result
# text in a normal 200 response, so the model receives them as the tool's output and can
# react on the live call. Rate limits are keyed by remote address.
router = APIRouter(prefix="/tools/internal", tags=["Agent Tool Callbacks"])


def _user_id_from_assistant(assistant_id: str) -> str | None:
    """Map a VAPI assistant id to the owning account's user id via `ai_agents.vapi_assistant_id`.
    Returns None when the id is empty or matches no agent."""
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

    # The payload is usually nested under a top-level `message` key; fall back to the body itself.
    msg = body.get("message") or body
    call = msg.get("call") or {}
    assistant_id = call.get("assistantId") or msg.get("assistantId")
    tool_calls = msg.get("toolCalls") or msg.get("tool_calls") or []
    if not tool_calls:
        return None, {}, assistant_id

    # Only the first tool call is handled, and its id is the one the reply must echo back.
    tc = tool_calls[0]
    tc_id = tc.get("id") or tc.get("toolCallId")
    fn = tc.get("function") or {}
    args = fn.get("arguments") or {}
    # `arguments` may arrive as a JSON string instead of an object; unparseable JSON
    # degrades to "no arguments" so each handler reports its own missing-field error.
    if isinstance(args, str):
        import json
        try:
            args = json.loads(args)
        except Exception:
            args = {}
    return tc_id, args, assistant_id


def _result(tc_id: str | None, result: str) -> dict:
    """Wrap `result` in the response envelope VAPI expects for a single tool call."""
    return {"results": [{"toolCallId": tc_id, "result": result}]}


@router.post("/trigger-event")
@limiter.limit("120/minute")
async def cb_trigger_event(request: Request):
    """Records call events raised by the agent's `trigger_event` tool. Unlike the other
    callbacks this handles every tool call in the request, since the model may raise
    several events in one turn. Tolerant of both VAPI payload shapes (`toolCalls` with a
    nested `function`, and `toolCallList` with flat name/arguments) and of junk arguments."""
    import json
    try:
        body = await request.json()
    except Exception:
        return {"results": []}
    if not isinstance(body, dict):
        return {"results": []}

    msg = body.get("message") if isinstance(body.get("message"), dict) else body
    call = msg.get("call") if isinstance(msg.get("call"), dict) else {}
    vapi_call_id = call.get("id")
    assistant_id = call.get("assistantId") or msg.get("assistantId")
    tool_calls = msg.get("toolCalls") or msg.get("tool_calls") or msg.get("toolCallList") or []
    if not isinstance(tool_calls, list):
        return {"results": []}

    # Resolve the agent once; every tool call in this request belongs to the same call.
    agent = None
    if assistant_id and isinstance(assistant_id, str):
        res = (
            supabase.table("ai_agents")
            .select("id, user_id")
            .eq("vapi_assistant_id", assistant_id)
            .limit(1)
            .execute()
        )
        agent = res.data[0] if res.data else None

    results = []
    for tc in tool_calls:
        if not isinstance(tc, dict):
            continue
        tc_id = tc.get("id") or tc.get("toolCallId")
        fn = tc.get("function") if isinstance(tc.get("function"), dict) else tc
        args = fn.get("arguments") or {}
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except Exception:
                args = {}
        if not isinstance(args, dict):
            args = {}
        # An event cannot be attributed without both the agent and the VAPI call id, so each
        # tool call gets an error result instead of the whole request failing.
        if not agent or not vapi_call_id:
            results.append({"toolCallId": tc_id, "result": "Error: could not identify the call."})
            continue
        event = args.get("event")
        note = args.get("note")
        # record_hit validates the event key against the agent's events (None if unknown),
        # applies the inbound/outbound scope (returns skipped=True), de-duplicates retried tool
        # calls, and schedules a callback when the event asks for one. The customer number
        # is passed along for that callback.
        try:
            customer = call.get("customer") if isinstance(call.get("customer"), dict) else {}
            hit = record_hit(agent["user_id"], agent["id"], vapi_call_id, event,
                             note if isinstance(note, str) else None, tc_id, call.get("type"),
                             customer.get("number") if isinstance(customer.get("number"), str) else None, args)
        except Exception as e:
            logger.warning("trigger_event failed for call %s: %s", vapi_call_id, e)
            # A storage error is logged and then reported to the model like an unknown event,
            # so it never breaks the live call.
            hit = None
        label = event if isinstance(event, str) else ""
        if hit and hit.get("skipped"):
            text = f"Event '{label}' is not enabled for this type of call, so it was ignored."
        elif hit:
            text = f"Event '{label}' recorded."
        else:
            text = f"Unknown event '{label}'."
        results.append({"toolCallId": tc_id, "result": text})
    return {"results": results}


@router.post("/send-email")
@limiter.limit("60/minute")
async def cb_send_email(request: Request):
    """VAPI callback for the `send_email` tool. Sends an email (to, subject, body) on behalf of
    the agent's owner through their active email integration (Brevo, SendGrid or SMTP).
    Called by VAPI, not by dashboard users; the subject defaults to "Follow-up" and any
    failure is returned to the model as result text."""
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
    """VAPI callback for the `send_sms` tool. Sends a text message (to, message) through
    Twilio on behalf of the agent's owner. Called by VAPI, not by dashboard users; any
    failure (for example no Twilio integration configured) is returned to the model as
    result text."""
    tc_id, args, assistant_id = await _parse_tool_call(request)
    user_id = _user_id_from_assistant(assistant_id)
    if not user_id:
        return _result(tc_id, "Error: could not identify the owning user.")

    to = (args.get("to") or "").strip()
    message = args.get("message") or ""
    if not to:
        return _result(tc_id, "Error: missing recipient phone number.")

    # No From number is passed, so sms_service sends through the owner's Twilio integration
    # (SID, token and From number from its config). Platform-purchased numbers are only used
    # when a From number is supplied, which this callback never does.
    try:
        await send_sms(user_id, to, message)
        return _result(tc_id, f"SMS sent to {to}.")
    except Exception as e:
        logger.warning("Tool send_sms failed: %s", e)
        return _result(tc_id, f"Failed to send SMS: {e}")


@router.post("/update-crm")
@limiter.limit("60/minute")
async def cb_update_crm(request: Request):
    """VAPI callback for the `update_crm` tool. Updates the owner's contact(s) whose phone
    exactly matches `contact_phone`, applying only the whitelisted fields (status, notes,
    name, email) from `updates`. Writes the `contacts` table; called by VAPI, not by
    dashboard users."""
    tc_id, args, assistant_id = await _parse_tool_call(request)
    user_id = _user_id_from_assistant(assistant_id)
    if not user_id:
        return _result(tc_id, "Error: could not identify the owning user.")

    phone = (args.get("contact_phone") or "").strip()
    updates = args.get("updates") or {}
    if not phone or not isinstance(updates, dict) or not updates:
        return _result(tc_id, "Error: contact_phone and a non-empty updates object are required.")

    # Whitelist: the model may only touch these columns, never arbitrary ones.
    allowed = {"status", "notes", "name", "email"}
    safe_updates = {k: v for k, v in updates.items() if k in allowed}
    if not safe_updates:
        return _result(tc_id, f"Error: only these fields are updatable: {sorted(allowed)}.")

    # Scoped to the owner's contacts and matched on the phone string as stored (no
    # normalisation), so every contact of that owner with this exact number is updated.
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


async def _agent_context(request: Request, assistant_id: str | None):
    """(agent row, VAPI call id) for the call that invoked a tool."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    # The body was already parsed by _parse_tool_call; Starlette caches it, so re-reading
    # is cheap. Unlike _parse_tool_call, this tolerates non-dict payloads.
    msg = body.get("message") if isinstance(body, dict) and isinstance(body.get("message"), dict) else (body if isinstance(body, dict) else {})
    call = msg.get("call") if isinstance(msg.get("call"), dict) else {}
    agent = None
    if assistant_id:
        res = (
            supabase.table("ai_agents")
            .select("id, name, user_id")
            .eq("vapi_assistant_id", assistant_id)
            .limit(1)
            .execute()
        )
        agent = res.data[0] if res.data else None
    return agent, call.get("id")


@router.post("/check-availability")
@limiter.limit("60/minute")
async def cb_check_availability(request: Request):
    """VAPI callback for the `check_availability` tool. Returns text listing free meeting
    slots (each with an exact `start_iso`) on the owner's connected Google Calendar for the
    model to offer; the logic lives in calendar_service.check_availability. Called by VAPI,
    not by dashboard users."""
    tc_id, args, assistant_id = await _parse_tool_call(request)
    agent, _call_id = await _agent_context(request, assistant_id)
    if not agent:
        return _result(tc_id, "Error: could not identify the owning user.")
    try:
        text = await calendar_service.check_availability(
            agent["user_id"], args.get("date"), args.get("days"), args.get("duration_minutes"))
    except Exception as e:  # never let a bug surface as a dead line on a live call
        logger.exception("check_availability failed: %s", e)
        text = calendar_service.UNAVAILABLE
    return _result(tc_id, text)


@router.post("/book-slot")
@limiter.limit("60/minute")
async def cb_book_slot(request: Request):
    """VAPI callback for the `book_slot` tool. Books a meeting on the owner's Google Calendar
    and records it in `calendar_bookings` (see calendar_service.book_slot). The VAPI call id
    and tool call id are passed so a retried tool call confirms the existing booking instead
    of double-booking. Called by VAPI, not by dashboard users."""
    tc_id, args, assistant_id = await _parse_tool_call(request)
    agent, call_id = await _agent_context(request, assistant_id)
    if not agent:
        return _result(tc_id, "Error: could not identify the owning user.")
    try:
        text = await calendar_service.book_slot(
            agent["user_id"], args, agent_id=agent["id"], agent_name=agent.get("name"),
            call_id=call_id, tool_call_id=tc_id)
    except Exception as e:
        logger.exception("book_slot failed: %s", e)
        text = calendar_service.UNAVAILABLE
    return _result(tc_id, text)


@router.post("/webhook")
@limiter.limit("60/minute")
async def cb_webhook(request: Request):
    """VAPI callback for the `webhook` tool. POSTs `{"event": event_name, "payload": payload}`
    as JSON to a webhook URL taken from the owner's Active integrations. Only transport
    errors are reported back; the target's HTTP status is not checked. Called by VAPI, not
    by dashboard users."""
    tc_id, args, assistant_id = await _parse_tool_call(request)
    user_id = _user_id_from_assistant(assistant_id)
    if not user_id:
        return _result(tc_id, "Error: could not identify the owning user.")

    event_name = args.get("event_name") or "agent_event"
    payload = args.get("payload") or {}

    # Find the user's first active webhook integration with a 'url' field.
    # The integration type is not checked: any Active integration whose decrypted config has
    # `webhookUrl` or `url` qualifies, and rows are not ordered, so if several match the
    # one chosen is not deterministic. Rows that fail to decrypt are skipped.
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
