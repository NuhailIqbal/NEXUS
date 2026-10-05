"""
Preset tool wiring for the Create AI Agent wizard.

When the wizard sends `selected_tool_keys: ["send_email", "send_sms", ...]`,
this module ensures each preset exists as a VAPI tool for the user and
returns the VAPI tool IDs to attach to the new assistant.

Each preset's `server.url` points back to our backend, where the matching
callback handler (see backend/routers/agent_tool_callbacks.py) executes the
action against the user's stored integrations.
"""

import logging
from database import supabase
from services import vapi_client
from config import settings

logger = logging.getLogger(__name__)


# Catalogue of built-in tools, keyed by the string the wizard stores in the agent's
# `selected_tool_keys`. Per preset:
#   label          shown in the UI; also the `tools.name` used to find an existing row, and the
#                  base of the VAPI function name ("Send Email" -> "send_email")
#   description    shown in the UI and sent to VAPI, where the model reads it to decide when to
#                  call the tool (so the wording is part of the agent's behaviour)
#   callback_path  route in routers/agent_tool_callbacks.py that VAPI POSTs to
#   requires       optional UI hint shown as "Needs <requires>"; not enforced here
#   parameters     JSON Schema of the arguments the model must supply
PRESETS: dict[str, dict] = {
    "send_email": {
        "label": "Send Email",
        "description": "Send a transactional email to a contact.",
        "callback_path": "/tools/internal/send-email",
        "requires": "an email integration (Integrations page)",
        "parameters": {
            "type": "object",
            "properties": {
                "to":      {"type": "string", "description": "Recipient email address."},
                "subject": {"type": "string", "description": "Subject line."},
                "body":    {"type": "string", "description": "Plain-text body."},
            },
            "required": ["to", "subject", "body"],
        },
    },
    "send_sms": {
        "label": "Send SMS",
        "description": "Send a text message to a phone number via Twilio.",
        "callback_path": "/tools/internal/send-sms",
        "requires": "a Twilio number (Phone Numbers page)",
        "parameters": {
            "type": "object",
            "properties": {
                "to":      {"type": "string", "description": "Recipient phone number in E.164 format (e.g. +15551234567)."},
                "message": {"type": "string", "description": "Message body."},
            },
            "required": ["to", "message"],
        },
    },
    "check_availability": {
        "label": "Check Availability",
        "description": (
            "Look up free meeting times on the business's calendar. Always call this before offering "
            "or booking a time — never guess availability."
        ),
        "callback_path": "/tools/internal/check-availability",
        "requires": "a connected Google Calendar",
        "parameters": {
            "type": "object",
            "properties": {
                "date": {"type": "string", "description": "First day to check as YYYY-MM-DD. Leave out to start from today."},
                "days": {"type": "integer", "description": "How many days to look at, 1 to 7. Defaults to 3."},
                "duration_minutes": {"type": "integer", "description": "Meeting length in minutes. Leave out for the default."},
            },
        },
    },
    "book_slot": {
        "label": "Book Calendar Slot",
        "description": (
            "Book a meeting on the business's calendar. Use ONLY a start_iso returned by check_availability, "
            "and confirm the time with the caller first."
        ),
        "callback_path": "/tools/internal/book-slot",
        "requires": "a connected Google Calendar",
        "parameters": {
            "type": "object",
            "properties": {
                "contact_name": {"type": "string", "description": "The caller's name."},
                "contact_email": {"type": "string", "description": "The caller's email, so they receive a calendar invite. Ask for it."},
                "start_iso": {"type": "string", "description": "Exact start_iso value returned by check_availability."},
                "duration_minutes": {"type": "integer", "description": "Meeting length in minutes. Leave out for the default."},
                "notes": {"type": "string", "description": "Anything useful to know before the meeting."},
            },
            "required": ["contact_name", "start_iso"],
        },
    },
    "update_crm": {
        "label": "Update CRM",
        "description": "Update a contact record (status, notes, custom fields) in the CRM.",
        "callback_path": "/tools/internal/update-crm",
        "parameters": {
            "type": "object",
            "properties": {
                "contact_phone": {"type": "string", "description": "Phone number used to look up the contact."},
                "updates": {
                    "type": "object",
                    "description": "Fields to update, e.g. {\"status\": \"Qualified\", \"notes\": \"...\"}.",
                },
            },
            "required": ["contact_phone", "updates"],
        },
    },
    "webhook": {
        "label": "Webhook Trigger",
        "description": "POST a custom JSON payload to a URL configured by the user.",
        "callback_path": "/tools/internal/webhook",
        "requires": "a webhook URL (Integrations page)",
        "parameters": {
            "type": "object",
            "properties": {
                "event_name": {"type": "string"},
                "payload": {"type": "object"},
            },
            "required": ["event_name"],
        },
    },
}


def _vapi_tool_payload(preset: dict) -> dict:
    """Build the VAPI tool-create body for a preset: a `function` tool whose `server.url` is
    this backend's public URL plus the preset's callback path. The server block carries no
    headers or secret; the callback identifies the owner from the assistant id in the payload."""
    base = settings.public_api_url.rstrip("/")
    return {
        "type": "function",
        "function": {
            "name": preset["label"].lower().replace(" ", "_"),
            "description": preset["description"],
            "parameters": preset["parameters"],
        },
        "server": {
            "url": f"{base}{preset['callback_path']}",
        },
    }


async def provision_tools_for_agent(user_id: str, selected_keys: list[str]) -> list[str]:
    """
    For each preset key the user selected:
      - reuse the user's existing VAPI tool with that name if present,
      - otherwise create a new VAPI tool (and persist it in our tools table).

    Returns the list of VAPI tool IDs ready to attach to an assistant.
    Silently skips any preset whose provisioning fails so agent creation
    is not blocked.
    """
    # Nothing to do without selected tools, a VAPI key, or a public URL for VAPI to call
    # back (the callbacks are unreachable without public_api_url).
    if not selected_keys or not settings.vapi_api_key or not settings.public_api_url:
        return []

    tool_ids: list[str] = []
    for key in selected_keys:
        # Unknown keys are ignored silently.
        preset = PRESETS.get(key)
        if not preset:
            continue

        # Presets are matched per account by the `tools.name` equal to the preset label, so
        # any row of that user with the same name is picked up, not only rows made here.
        existing = (
            supabase.table("tools")
            .select("id, vapi_tool_id")
            .eq("user_id", user_id)
            .eq("name", preset["label"])
            .execute()
        )
        row = (existing.data or [None])[0]
        # An already-provisioned tool is reused as-is: edits to PRESETS (description,
        # parameters) are not pushed to VAPI tools that already exist.
        if row and row.get("vapi_tool_id"):
            tool_ids.append(row["vapi_tool_id"])
            continue

        # A failure here skips only this preset, so agent creation is never blocked.
        try:
            vapi_tool = await vapi_client.create_tool(_vapi_tool_payload(preset))
            vapi_tool_id = vapi_tool.get("id")
        except Exception as e:
            logger.warning("Failed to create VAPI tool %s for user %s: %s", key, user_id, e)
            continue

        if not vapi_tool_id:
            continue

        # A local row without a VAPI id (never linked) is completed in place; otherwise a new
        # row is inserted with the preset's label and description.
        if row:
            supabase.table("tools").update({"vapi_tool_id": vapi_tool_id, "status": "Active"}) \
                .eq("id", row["id"]).execute()
        else:
            supabase.table("tools").insert({
                "user_id": user_id,
                "name": preset["label"],
                "description": preset["description"],
                "status": "Active",
                "vapi_tool_id": vapi_tool_id,
            }).execute()

        tool_ids.append(vapi_tool_id)

    return tool_ids
