"""
Call events: per-agent signals the AI can raise mid-call (e.g. "callback_requested"),
each bound to an outcome value. The agent gets one VAPI function tool,
`trigger_event`, whose `event` argument is an enum of that agent's event keys.
Hits are stored in `call_event_hits` keyed by the VAPI call id (the conversation
row may not exist yet mid-call) and folded into `conversations.call_outcome` at
hangup — the last event raised wins.

Events are defined once per account in `call_event_library` and attached to agents
(`call_events` rows link back via `library_event_id`, and carry a snapshot of the
definition so the tool/hit logic never needs a join). Each event has an `applies_to`
scope — inbound / outbound / both — enforced when the event fires.
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
LIBRARY_MAX = 100
APPLIES_TO = ("both", "inbound", "outbound")


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
            "applies_to": e.get("applies_to") if e.get("applies_to") in APPLIES_TO else "both",
            "schedules_callback": bool(e.get("schedules_callback")),
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
        fields = {
            "label": e["label"],
            "description": e.get("description", ""),
            "outcome": e.get("outcome"),
            "position": e["position"],
            "applies_to": e.get("applies_to") if e.get("applies_to") in APPLIES_TO else "both",
            "schedules_callback": bool(e.get("schedules_callback")),
        }
        if e.get("library_event_id"):
            fields["library_event_id"] = e["library_event_id"]
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
            supabase.table("call_events").update(fields) \
                .eq("agent_id", agent_id).eq("event_key", e["event_key"]).execute()
    return get_events(agent_id)


# -- Event library (account-level definitions) ---------------------------------

class LibraryError(Exception):
    """Raised for user-fixable library problems; `.status` is the HTTP status to use."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _library_row_fields(label, description, outcome, applies_to, schedules_callback=False) -> dict:
    label = str(label or "").strip()[:LABEL_MAX]
    if not label:
        raise LibraryError("Event name is required.")
    if applies_to not in APPLIES_TO:
        raise LibraryError(f"applies_to must be one of {', '.join(APPLIES_TO)}.", 422)
    return {
        "label": label,
        "description": str(description or "").strip()[:DESCRIPTION_MAX],
        "outcome": (str(outcome or "").strip() or label)[:OUTCOME_MAX],
        "applies_to": applies_to,
        "schedules_callback": bool(schedules_callback),
    }


def list_library(user_id: str) -> list[dict]:
    res = (
        supabase.table("call_event_library")
        .select("*")
        .eq("user_id", user_id)
        .order("created_at")
        .execute()
    )
    return res.data or []


def get_library_event(user_id: str, event_id) -> dict | None:
    if not event_id or not isinstance(event_id, str):
        return None
    try:
        res = (
            supabase.table("call_event_library")
            .select("*")
            .eq("id", event_id)
            .eq("user_id", user_id)
            .limit(1)
            .execute()
        )
    except Exception:  # e.g. a malformed uuid
        return None
    return res.data[0] if res.data else None


def _unique_key(label: str, taken: set) -> str:
    key = _slug(label)
    if key:
        return key
    n = len(taken) + 1
    while f"event_{n}" in taken:
        n += 1
    return f"event_{n}"


def create_library_event(user_id: str, label, description=None, outcome=None,
                         applies_to: str = "both", schedules_callback: bool = False) -> dict:
    fields = _library_row_fields(label, description, outcome, applies_to, schedules_callback)
    existing = list_library(user_id)
    if len(existing) >= LIBRARY_MAX:
        raise LibraryError(f"You can keep at most {LIBRARY_MAX} events in the library.")
    taken = {e["event_key"] for e in existing}
    key = _unique_key(fields["label"], taken)
    if key in taken:
        raise LibraryError(f"An event named '{fields['label']}' already exists.", 409)
    try:
        res = supabase.table("call_event_library").insert(
            {**fields, "event_key": key, "user_id": user_id}
        ).execute()
    except Exception as e:  # lost a race against the same name
        raise LibraryError(f"An event named '{fields['label']}' already exists.", 409) from e
    return res.data[0]


def update_library_event(user_id: str, event_id: str, changes: dict) -> dict:
    """Edit a library event. Its key never changes, so existing hits and agent tools
    stay valid. The edit is copied onto every agent row that uses it."""
    row = get_library_event(user_id, event_id)
    if not row:
        raise LibraryError("Event not found.", 404)
    fields = _library_row_fields(
        changes.get("label", row["label"]),
        changes.get("description", row.get("description")),
        changes.get("outcome", row.get("outcome")),
        changes.get("applies_to", row.get("applies_to") or "both"),
        changes.get("schedules_callback", row.get("schedules_callback", False)),
    )
    supabase.table("call_event_library").update({**fields, "updated_at": "now()"}) \
        .eq("id", event_id).execute()
    supabase.table("call_events").update(fields).eq("library_event_id", event_id).execute()
    return {**row, **fields}


def agents_using_event(event_id: str) -> list[str]:
    res = supabase.table("call_events").select("agent_id").eq("library_event_id", event_id).execute()
    return sorted({r["agent_id"] for r in (res.data or [])})


def delete_library_event(user_id: str, event_id: str) -> list[str]:
    """Remove the event from every agent and from the library. Returns the ids of the
    agents that used it (the caller re-syncs their VAPI tools). Past hits are kept."""
    if not get_library_event(user_id, event_id):
        raise LibraryError("Event not found.", 404)
    agent_ids = agents_using_event(event_id)
    supabase.table("call_events").delete().eq("library_event_id", event_id).execute()
    supabase.table("call_event_library").delete().eq("id", event_id).eq("user_id", user_id).execute()
    return agent_ids


def resolve_agent_events(user_id: str, items: list | None) -> list[dict]:
    """Turn the wizard's selection into agent event rows.

    Each item is either `{"event_id": <library id>}` (the normal case) or the older
    `{"label": ...}` form, which reuses the library event with that name or creates it.
    Raises LibraryError(404) for an id that isn't in the caller's library."""
    rows: list[dict] = []
    seen: set = set()
    for item in items or []:
        if item.get("event_id"):
            lib = get_library_event(user_id, item["event_id"])
            if not lib:
                raise LibraryError("One of the selected events no longer exists.", 404)
        else:
            norm = normalize_events([item])
            if not norm:
                continue
            n = norm[0]
            lib = next((e for e in list_library(user_id) if e["event_key"] == n["event_key"]), None)
            if not lib:
                lib = create_library_event(user_id, n["label"], n["description"], n["outcome"], n["applies_to"],
                                           n.get("schedules_callback", False))
        if lib["event_key"] in seen:
            continue
        seen.add(lib["event_key"])
        rows.append({
            "event_key": lib["event_key"], "label": lib["label"],
            "description": lib.get("description") or "", "outcome": lib.get("outcome"),
            "applies_to": lib.get("applies_to") or "both",
            "schedules_callback": bool(lib.get("schedules_callback")),
            "library_event_id": lib["id"], "position": len(rows),
        })
        if len(rows) >= MAX_EVENTS_PER_AGENT:
            break
    return rows


SCOPE_NOTE = {"inbound": " (inbound calls only)", "outbound": " (outbound calls only)"}
CALLBACK_NOTE = (" — this schedules a callback: if the caller says how long to wait (\"in 30 minutes\", \"after an hour\"), "
                 "pass callback_in_minutes as a whole number and nothing else (you cannot see the clock, so never work "
                 "out a clock time yourself); if they name a day or time, pass callback_in_days (0 = today, "
                 "1 = tomorrow) and callback_time (24-hour HH:MM in THEIR local time); if they name none, pass nothing")


def event_applies(applies_to, call_type) -> bool:
    """Whether an event with this scope may fire on a call of this VAPI type
    (inboundPhoneCall / outboundPhoneCall / webCall). Unknown types and web calls
    (voice widget, in-app tests) are never blocked."""
    t = (call_type or "").lower()
    if applies_to == "inbound" and "outbound" in t:
        return False
    if applies_to == "outbound" and "inbound" in t:
        return False
    return True


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
                    "callback_in_minutes": {
                        "type": "integer",
                        "description": "Only for events that schedule a callback, when the caller says how long to wait, e.g. 30 for 'in 30 minutes' or 60 for 'after an hour'. Use this instead of working out a clock time.",
                    },
                    "callback_in_days": {
                        "type": "integer",
                        "description": "Only for events that schedule a callback, when the caller names a day: 0 = today, 1 = tomorrow, 2 = the day after...",
                    },
                    "callback_time": {
                        "type": "string",
                        "description": "Only for events that schedule a callback, when the caller names a time: 24-hour HH:MM in the caller's own local time, e.g. 17:00.",
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
        f"- {e['event_key']}: {e.get('description') or e['label']}"
        f"{SCOPE_NOTE.get(e.get('applies_to'), '')}"
        f"{CALLBACK_NOTE if e.get('schedules_callback') else ''}"
        for e in events
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
               note: str | None, tool_call_id: str | None = None,
               call_type: str | None = None, customer_phone: str | None = None,
               tool_args: dict | None = None) -> dict | None:
    """Store one event occurrence. Returns the event definition, or None if the key
    isn't one of the agent's events. The key is matched leniently (case/punctuation),
    and a repeat of the same VAPI tool call id (a retry) is recorded only once. If the
    event's scope excludes this call type it is NOT stored and the definition comes
    back with `skipped=True`."""
    key = _slug(event_key)
    if not key:
        return None
    defs = (
        supabase.table("call_events")
        .select("id, event_key, label, outcome, applies_to, schedules_callback")
        .eq("agent_id", agent_id)
        .eq("event_key", key)
        .limit(1)
        .execute()
    )
    if not defs.data:
        return None
    d = defs.data[0]
    if not event_applies(d.get("applies_to"), call_type):
        return {**d, "skipped": True}
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
    if d.get("schedules_callback"):
        try:
            from services import callback_service
            callback_service.schedule_from_event(user_id, agent_id, vapi_call_id, tool_call_id,
                                                 customer_phone, tool_args or {}, note)
        except Exception as e:  # noqa: BLE001 — recording the event matters more than the callback
            logger.warning("could not schedule callback for call %s: %s", vapi_call_id, e)
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
        from services import callback_service
        callback_service.attach_conversation(vapi_call_id, conversation_id)
        return hits
    except Exception as e:  # noqa: BLE001 — never break call-end processing
        logger.warning("finalize_call_events failed for %s: %s", vapi_call_id, e)
        return []
