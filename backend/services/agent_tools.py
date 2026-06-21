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


PRESETS: dict[str, dict] = {
    "send_email": {
        "label": "Send Email",
        "description": "Send a transactional email to a contact.",
        "callback_path": "/tools/internal/send-email",
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
        "parameters": {
            "type": "object",
            "properties": {
                "to":      {"type": "string", "description": "Recipient phone number in E.164 format (e.g. +15551234567)."},
                "message": {"type": "string", "description": "Message body."},
            },
            "required": ["to", "message"],
        },
    },
    "book_slot": {
        "label": "Book Calendar Slot",
        "description": "Schedule a meeting at a requested date and time.",
        "callback_path": "/tools/internal/book-slot",
        "parameters": {
            "type": "object",
            "properties": {
                "contact_name": {"type": "string"},
                "contact_email": {"type": "string"},
                "start_iso": {"type": "string", "description": "ISO 8601 start time, e.g. 2026-07-01T15:00:00Z."},
                "duration_minutes": {"type": "integer", "default": 30},
                "notes": {"type": "string"},
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
            "method": "POST",
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
    if not selected_keys or not settings.vapi_api_key or not settings.public_api_url:
        return []

    tool_ids: list[str] = []
    for key in selected_keys:
        preset = PRESETS.get(key)
        if not preset:
            continue

        existing = (
            supabase.table("tools")
            .select("id, vapi_tool_id")
            .eq("user_id", user_id)
            .eq("name", preset["label"])
            .execute()
        )
        row = (existing.data or [None])[0]
        if row and row.get("vapi_tool_id"):
            tool_ids.append(row["vapi_tool_id"])
            continue

        try:
            vapi_tool = await vapi_client.create_tool(_vapi_tool_payload(preset))
            vapi_tool_id = vapi_tool.get("id")
        except Exception as e:
            logger.warning("Failed to create VAPI tool %s for user %s: %s", key, user_id, e)
            continue

        if not vapi_tool_id:
            continue

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
