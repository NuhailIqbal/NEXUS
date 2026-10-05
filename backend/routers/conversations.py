"""Conversations API: the call log, mounted under /conversations.

Lists and filters rows of the `conversations` table, serves per-call detail (transcript,
playable recording, agent-raised call events), returns aggregate stats, and offers a
manual pull-sync of recent VAPI calls (POST /sync-from-vapi). The sync reuses
routers.webhooks.import_vapi_call, the same upsert the background poller
(services.vapi_sync) uses. Talks to the VAPI REST API through services.vapi_client and
to the tables conversations, ai_agents and call_event_hits. All data is scoped to the
account owner's id (see routers.team.resolve_owner_id).
"""
import logging
from fastapi import APIRouter, Depends, HTTPException, Query
from dependencies import get_current_user
from database import supabase
from typing import Optional
from services import vapi_client
from routers.webhooks import import_vapi_call
from routers.team import resolve_owner_id
from services.call_events import get_hits

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/conversations", tags=["Conversations"])


@router.get("")
async def list_conversations(
    user=Depends(get_current_user),
    status: Optional[str] = None,
    channel: Optional[str] = None,
    agent_id: Optional[str] = None,
    agent_name: Optional[str] = None,
    campaign_id: Optional[str] = None,
    direction: Optional[str] = None,
    contact_name: Optional[str] = None,
    phone: Optional[str] = None,
    duration: Optional[str] = None,
    qualified: Optional[str] = None,
    call_outcome: Optional[str] = None,
    call_date: Optional[str] = None,
    limit: int = Query(50, le=1000),
    offset: int = 0,
):
    """List the account's conversations, newest call first, with limit/offset paging.

    Exact-match filters: status, agent_id, campaign_id, direction. Case-insensitive
    substring filters: channel, agent_name, contact_name, phone, duration, call_outcome.
    `qualified` accepts "yes" or "no" (any other value is ignored) and `call_date` a
    YYYY-MM-DD day. Each row is returned with a derived `agent_name`, and meta.count is
    the total number of matches before paging.
    """
    owner_id = resolve_owner_id(user["user_id"])
    query = (
        supabase.table("conversations")
        .select("*", count="exact")
        .eq("user_id", owner_id)
    )
    if status:
        query = query.eq("status", status)
    if channel:
        query = query.ilike("channel", f"%{channel}%")
    if agent_id:
        query = query.eq("agent_id", agent_id)
    if agent_name:
        # conversations has no name column to filter on directly (no join support
        # in the query builder) — resolve matching agent ids first, then filter by
        # those. No matches means no conversations can match, so short-circuit.
        matches = (
            supabase.table("ai_agents")
            .select("id")
            .eq("user_id", owner_id)
            .ilike("name", f"%{agent_name}%")
            .execute()
        )
        matched_ids = [r["id"] for r in (matches.data or [])]
        if not matched_ids:
            return {"data": [], "error": None, "meta": {"count": 0}}
        query = query.in_("agent_id", matched_ids)
    if campaign_id:
        query = query.eq("campaign_id", campaign_id)
    if direction:
        query = query.eq("direction", direction)
    if contact_name:
        query = query.ilike("contact_name", f"%{contact_name}%")
    if phone:
        query = query.ilike("phone", f"%{phone}%")
    if duration:
        query = query.ilike("duration", f"%{duration}%")
    if qualified in ("yes", "no"):
        query = query.eq("qualified", qualified == "yes")
    if call_outcome:
        query = query.ilike("call_outcome", f"%{call_outcome}%")
    if call_date:
        # Matches the whole calendar day. The bounds carry no UTC offset, so PostgreSQL
        # resolves them in the database session's timezone.
        query = query.gte("call_time", f"{call_date}T00:00:00").lte("call_time", f"{call_date}T23:59:59.999999")

    result = query.order("call_time", desc=True).range(offset, offset + limit - 1).execute()
    rows = result.data or []

    # Look up display names only for the agents on this page of results. Conversations
    # whose agent was deleted (agent_id is NULL) get an empty agent_name.
    agent_ids = {r["agent_id"] for r in rows if r.get("agent_id")}
    agent_names: dict[str, str] = {}
    if agent_ids:
        agents = (
            supabase.table("ai_agents")
            .select("id, name")
            .in_("id", list(agent_ids))
            .execute()
        )
        agent_names = {a["id"]: a["name"] for a in (agents.data or [])}
    for r in rows:
        r["agent_name"] = agent_names.get(r.get("agent_id"), "")

    return {"data": rows, "error": None, "meta": {"count": result.count}}


# Must stay above the /{conversation_id} routes: FastAPI matches routes in declaration
# order, so otherwise "stats" would be captured as a conversation id.
@router.get("/stats")
async def conversation_stats(user=Depends(get_current_user), direction: Optional[str] = None):
    """Aggregate call counts for the account, optionally for one direction (inbound or
    outbound): total, completed, failed, in progress, inbound/outbound split, qualified
    calls and total talk time in seconds. Tallied in Python over every matching row."""
    query = (
        supabase.table("conversations")
        .select("status, duration_seconds, direction, qualified")
        .eq("user_id", resolve_owner_id(user["user_id"]))
    )
    if direction:
        query = query.eq("direction", direction)
    all_convos = query.execute()
    data = all_convos.data or []
    total = len(data)
    completed = sum(1 for c in data if c.get("status") == "Completed")
    failed = sum(1 for c in data if c.get("status") == "Failed")
    in_progress = sum(1 for c in data if c.get("status") == "In Progress")
    inbound = sum(1 for c in data if c.get("direction") == "inbound")
    outbound = sum(1 for c in data if c.get("direction") == "outbound")
    qualified = sum(1 for c in data if c.get("qualified"))
    total_duration_seconds = sum(c.get("duration_seconds") or 0 for c in data)

    return {
        "data": {
            "total": total,
            "completed": completed,
            "failed": failed,
            "in_progress": in_progress,
            "inbound": inbound,
            "outbound": outbound,
            "qualified": qualified,
            "total_duration_seconds": total_duration_seconds,
        },
        "error": None,
    }


@router.post("/sync-from-vapi")
async def sync_from_vapi(user=Depends(get_current_user), limit: int = Query(100, le=200)):
    """Pull recent VAPI calls (recording + transcript) for this user's agents into
    the conversations table. Idempotent: existing rows are updated, new ones inserted."""
    owner_id = resolve_owner_id(user["user_id"])
    # VAPI's call list is org-wide, shared by every NEXUS account, so ownership is
    # decided by matching each call's assistantId against this account's agents.
    agents = (
        supabase.table("ai_agents")
        .select("id, vapi_assistant_id")
        .eq("user_id", owner_id)
        .execute()
        .data
        or []
    )
    assistant_ids = {a["vapi_assistant_id"] for a in agents if a.get("vapi_assistant_id")}
    if not assistant_ids:
        return {"data": {"imported": 0, "updated": 0, "note": "No synced agents found for this account."}, "error": None}

    try:
        calls = await vapi_client.list_calls(limit=limit)
    except Exception as e:
        # The raw error goes to the log only; the client gets a generic 502.
        logger.error("Could not reach VAPI: %s", e)
        raise HTTPException(status_code=502, detail="Could not reach the voice service. Please try again.")

    # At most 100 of this account's calls are imported per request, whatever `limit`
    # was, which bounds the number of follow-up get_call requests below.
    mine = [c for c in calls if c.get("assistantId") in assistant_ids][:100]
    imported = updated = failed = 0
    for c in mine:
        try:
            # fetch the full call so the artifact (messages/recording/transcript) is present
            full = await vapi_client.get_call(c["id"])
            res = import_vapi_call(full, owner_id)
            if res == "imported":
                imported += 1
            elif res == "updated":
                updated += 1
        except Exception as e:
            # One bad call must not abort the whole sync; it is counted in `failed`.
            failed += 1
            logger.warning(f"sync-from-vapi: failed to import call {c.get('id')}: {e}")

    return {
        "data": {"imported": imported, "updated": updated, "failed": failed, "matched": len(mine), "scanned": len(calls)},
        "error": None,
    }


@router.get("/{conversation_id}")
async def get_conversation(conversation_id: str, user=Depends(get_current_user)):
    """Fetch one full conversation row by id. Responds 404 if it does not exist or
    belongs to another account."""
    result = (
        supabase.table("conversations")
        .select("*")
        .eq("id", conversation_id)
        .eq("user_id", resolve_owner_id(user["user_id"]))
        .maybe_single()
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return {"data": result.data, "error": None}


@router.get("/{conversation_id}/transcript")
async def get_transcript(conversation_id: str, user=Depends(get_current_user)):
    """Return only the transcript-related fields of a conversation: plain-text
    transcript, per-message transcript, stored recording URLs and the AI summary.
    The stored recording URLs may not be directly playable; see get_recording_url.
    Responds 404 if the conversation is not this account's."""
    result = (
        supabase.table("conversations")
        .select("id, transcript, transcript_messages, recording_url, stereo_recording_url, ai_summary")
        .eq("id", conversation_id)
        .eq("user_id", resolve_owner_id(user["user_id"]))
        .maybe_single()
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return {"data": result.data, "error": None}


@router.get("/{conversation_id}/events")
async def get_conversation_events(conversation_id: str, user=Depends(get_current_user)):
    """Call events the agent raised during this call, oldest first."""
    conv = (
        supabase.table("conversations")
        .select("id, vapi_call_id")
        .eq("id", conversation_id)
        .eq("user_id", resolve_owner_id(user["user_id"]))
        .maybe_single()
        .execute()
    )
    if not conv.data:
        raise HTTPException(status_code=404, detail="Conversation not found")
    vapi_call_id = conv.data.get("vapi_call_id")
    # Event hits are keyed by VAPI call id, so a conversation without one has none.
    return {"data": get_hits(vapi_call_id) if vapi_call_id else [], "error": None}


@router.get("/{conversation_id}/recording-url")
async def get_recording_url(conversation_id: str, user=Depends(get_current_user)):
    """Return a *playable* recording URL. VAPI's stored recordingUrl is a raw,
    private R2 path (not streamable); VAPI exposes short-lived presigned URLs that
    expire, so we fetch a fresh one on demand each time the call is opened."""
    row = (
        supabase.table("conversations")
        .select("vapi_call_id, recording_url, stereo_recording_url")
        .eq("id", conversation_id)
        .eq("user_id", resolve_owner_id(user["user_id"]))
        .maybe_single()
        .execute()
        .data
    )
    if not row:
        raise HTTPException(status_code=404, detail="Conversation not found")

    if row.get("vapi_call_id"):
        try:
            call = await vapi_client.get_call(row["vapi_call_id"])
            art = call.get("artifact", {}) or {}
            url = art.get("presignedMonoUrl") or art.get("presignedStereoUrl") or art.get("presignedCustomerUrl")
            if url:
                return {"data": {"url": url}, "error": None}
        except Exception as e:
            logger.warning(f"recording-url: VAPI fetch failed for {row['vapi_call_id']}: {e}")

    # Fallback: a directly-playable URL (e.g. non-VAPI recordings)
    return {"data": {"url": row.get("recording_url") or row.get("stereo_recording_url")}, "error": None}


@router.delete("/{conversation_id}")
async def delete_conversation(conversation_id: str, user=Depends(get_current_user)):
    """Delete one conversation (call log row) from the account; succeeds even if the id
    does not exist. The TeamRoleGuard middleware (main.py) rejects DELETE for team
    sub-users."""
    supabase.table("conversations").delete().eq("id", conversation_id).eq("user_id", resolve_owner_id(user["user_id"])).execute()
    return {"data": None, "error": None}
