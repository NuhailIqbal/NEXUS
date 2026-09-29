"""
Call events: per-agent signals the AI can raise mid-call (e.g. "callback_requested"),
each bound to an outcome value. The agent gets one VAPI function tool,
`trigger_event`, whose `event` argument is an enum of that agent's event keys.
Hits are stored in `call_event_hits` keyed by the VAPI call id (the conversation
row may not exist yet mid-call) and folded into `conversations.call_outcome` at
hangup — the last event raised wins.
"""

import logging
import re
from database import supabase
from services import vapi_client
from config import settings

logger = logging.getLogger(__name__)

TOOL_CALLBACK_PATH = "/tools/internal/trigger-event"
MAX_EVENTS_PER_AGENT = 20
LABEL_MAX = 60
OUTCOME_MAX = 60
DESCRIPTION_MAX = 200


def _slug(text) -> str:
    if not isinstance(text, str):
        return ""
    return re.sub(r"[^a-z0-9]+", "_", text.strip().lower()).strip("_")[:LABEL_MAX]


def normalize_events(events: list[dict] | None) -> list[dict]:
    """Clean user input: trim + cap lengths, slug keys, drop blanks/dupes, default the
    outcome to the label. A name with no latin letters/digits (e.g. Urdu) gets a
    generated `event_<n>` key so it isn't silently dropped."""
    out: list[dict] = []
    seen: set[str] = set()
    for e in events or []:
        label = str(e.get("label") or "").strip()[:LABEL_MAX]
        if not label:
            continue
        key = _slug(e.get("event_key") or label)
        if not key:
            n = len(out) + 1
            key = f"event_{n}"
            while key in seen:
                n += 1
                key = f"event_{n}"
        if key in seen:
            continue
        seen.add(key)
        out.append({
            "event_key": key,
            "label": label,
            "description": str(e.get("description") or "").strip()[:DESCRIPTION_MAX],
            "outcome": (str(e.get("outcome") or "").strip() or label)[:OUTCOME_MAX],
            "position": len(out),
        })
        if len(out) >= MAX_EVENTS_PER_AGENT:
            break
    return out


def get_events(agent_id: str) -> list[dict]:
    res = (
        supabase.table("call_events")
        .select("*")
        .eq("agent_id", agent_id)
        .order("position")
        .execute()
    )
    return res.data or []


def replace_events(user_id: str, agent_id: str, events: list[dict]) -> list[dict]:
    """Make the agent's event list equal `events` (the wizard always sends the full list).

    Applied as a diff — update matching keys in place, insert new ones, delete removed
    ones — rather than delete-all + reinsert, so an event that survives the edit is never
    briefly missing while a live call fires it, and old hits keep pointing at it."""
    existing = {e["event_key"]: e for e in get_events(agent_id)}
    wanted = {e["event_key"] for e in events}

    for key, row in existing.items():
        if key not in wanted:
            supabase.table("call_events").delete().eq("id", row["id"]).execute()

    for e in events:
        fields = {k: e[k] for k in ("label", "description", "outcome", "position")}
        row = existing.get(e["event_key"])
        if row:
            supabase.table("call_events").update(fields).eq("id", row["id"]).execute()
            continue
        try:
            supabase.table("call_events").insert(
                {**fields, "event_key": e["event_key"], "user_id": user_id, "agent_id": agent_id}
            ).execute()
        except Exception:
            # A concurrent save inserted the same key first — fall back to updating it.
            supabase.table("call_events").update(fields)                 .eq("agent_id", agent_id).eq("event_key", e["event_key"]).execute()
    return get_events(agent_id)


def tool_payload(agent_name: str | None, events: list[dict]) -> dict:
    base = settings.public_api_url.rstrip("/")
    return {
        "type": "function",
        "function": {
            "name": "trigger_event",
            "description": (
                "Report that something notable just happened on this call. Call it as soon as "
                "it happens, using exactly one of the allowed event values."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "event": {
                        "type": "string",
                        "enum": [e["event_key"] for e in events],
                        "description": "Which event occurred.",
                    },
                    "note": {
                        "type": "string",
                        "description": "Optional short detail, e.g. what the caller said.",
                    },
                },
                "required": ["event"],
            },
        },
        "server": {"url": f"{base}{TOOL_CALLBACK_PATH}"},
    }


def prompt_directive(events: list[dict]) -> str:
    """Appended to the system prompt sent to VAPI (never stored in ai_agents)."""
    if not events:
        return ""
    lines = "\n".join(
        f"- {e['event_key']}: {e.get('description') or e['label']}" for e in events
    )
    return (
        "\n\nCALL EVENTS: Use the trigger_event tool to report these moments the instant "
        "they happen during the call. Do not mention the tool to the caller, and keep "
        "talking normally afterwards.\n" + lines
    )


async def sync_events_tool(agent_name: str | None, events: list[dict],
                           existing_tool_id: str | None) -> str | None:
    """Create/update/delete the agent's trigger_event tool. Returns the tool id to
    store (None when there are no events or VAPI isn't configured)."""
    if not settings.vapi_api_key or not settings.public_api_url:
        return existing_tool_id if events else None
    if not events:
        if existing_tool_id:
            try:
                await vapi_client.delete_tool(existing_tool_id)
            except Exception as e:  # noqa: BLE001
                logger.warning("Failed to delete events tool %s: %s", existing_tool_id, e)
        return None
    payload = tool_payload(agent_name, events)
    if existing_tool_id:
        # VAPI rejects `type` on tool updates.
        await vapi_client.update_tool(existing_tool_id, {k: v for k, v in payload.items() if k != "type"})
        return existing_tool_id
    created = await vapi_client.create_tool(payload)
    return created.get("id")


def record_hit(user_id: str, agent_id: str, vapi_call_id: str, event_key,
               note: str | None, tool_call_id: str | None = None) -> dict | None:
    """Store one event occurrence. Returns the event definition, or None if the key
    isn't one of the agent's events. The key is matched leniently (case/punctuation),
    and a repeat of the same VAPI tool call id (a retry) is recorded only once."""
    key = _slug(event_key)
    if not key:
        return None
    defs = (
        supabase.table("call_events")
        .select("id, event_key, label, outcome")
        .eq("agent_id", agent_id)
        .eq("event_key", key)
        .limit(1)
        .execute()
    )
    if not defs.data:
        return None
    d = defs.data[0]
    if tool_call_id:
        seen = (
            supabase.table("call_event_hits")
            .select("id")
            .eq("vapi_call_id", vapi_call_id)
            .eq("tool_call_id", tool_call_id)
            .limit(1)
            .execute()
        )
        if seen.data:
            return d
    try:
        supabase.table("call_event_hits").insert({
            "user_id": user_id,
            "agent_id": agent_id,
            "vapi_call_id": vapi_call_id,
            "event_id": d["id"],
            "event_key": d["event_key"],
            "label": d["label"],
            "outcome": d["outcome"],
            "note": (note or "").strip()[:500] or None,
            "tool_call_id": tool_call_id,
        }).execute()
    except Exception:
        if not tool_call_id:
            raise
        # Lost a race against a concurrent retry of the same tool call — already stored.
        logger.info("call event %s for %s already recorded (tool call %s)", key, vapi_call_id, tool_call_id)
    return d


def get_hits(vapi_call_id: str) -> list[dict]:
    res = (
        supabase.table("call_event_hits")
        .select("*")
        .eq("vapi_call_id", vapi_call_id)
        .order("created_at")
        .execute()
    )
    return res.data or []


def finalize_call_events(vapi_call_id: str, conversation_id: str | None) -> list[dict]:
    """At hangup: link hits to the conversation and write the final outcome (last hit
    wins). Idempotent — safe to run from both the webhook and the sync loop."""
    if not vapi_call_id or not conversation_id:
        return []
    try:
        hits = get_hits(vapi_call_id)
        if not hits:
            return []
        supabase.table("call_event_hits").update({"conversation_id": conversation_id}) \
            .eq("vapi_call_id", vapi_call_id).execute()
        supabase.table("conversations").update({"call_outcome": hits[-1].get("outcome")}) \
            .eq("id", conversation_id).execute()
        return hits
    except Exception as e:  # noqa: BLE001 — never break call-end processing
        logger.warning("finalize_call_events failed for %s: %s", vapi_call_id, e)
        return []
