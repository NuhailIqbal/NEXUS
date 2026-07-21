import logging
from fastapi import APIRouter, Depends, HTTPException, Query
from dependencies import get_current_user
from database import supabase
from typing import Optional
from services import vapi_client
from routers.webhooks import import_vapi_call

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/conversations", tags=["Conversations"])


@router.get("")
async def list_conversations(
    user=Depends(get_current_user),
    status: Optional[str] = None,
    channel: Optional[str] = None,
    agent_id: Optional[str] = None,
    campaign_id: Optional[str] = None,
    direction: Optional[str] = None,
    limit: int = Query(50, le=200),
    offset: int = 0,
):
    query = (
        supabase.table("conversations")
        .select("*")
        .eq("user_id", user["user_id"])
    )
    if status:
        query = query.eq("status", status)
    if channel:
        query = query.eq("channel", channel)
    if agent_id:
        query = query.eq("agent_id", agent_id)
    if campaign_id:
        query = query.eq("campaign_id", campaign_id)
    if direction:
        query = query.eq("direction", direction)

    result = query.order("call_time", desc=True).range(offset, offset + limit - 1).execute()
    return {"data": result.data, "error": None, "meta": {"count": len(result.data)}}


@router.get("/stats")
async def conversation_stats(user=Depends(get_current_user)):
    all_convos = (
        supabase.table("conversations")
        .select("status, duration, direction, qualified")
        .eq("user_id", user["user_id"])
        .execute()
    )
    data = all_convos.data or []
    total = len(data)
    completed = sum(1 for c in data if c.get("status") == "Completed")
    failed = sum(1 for c in data if c.get("status") == "Failed")
    in_progress = sum(1 for c in data if c.get("status") == "In Progress")
    inbound = sum(1 for c in data if c.get("direction") == "inbound")
    outbound = sum(1 for c in data if c.get("direction") == "outbound")
    qualified = sum(1 for c in data if c.get("qualified"))

    return {
        "data": {
            "total": total,
            "completed": completed,
            "failed": failed,
            "in_progress": in_progress,
            "inbound": inbound,
            "outbound": outbound,
            "qualified": qualified,
        },
        "error": None,
    }


@router.post("/sync-from-vapi")
async def sync_from_vapi(user=Depends(get_current_user), limit: int = Query(100, le=200)):
    """Pull recent VAPI calls (recording + transcript) for this user's agents into
    the conversations table. Idempotent: existing rows are updated, new ones inserted."""
    agents = (
        supabase.table("ai_agents")
        .select("id, vapi_assistant_id")
        .eq("user_id", user["user_id"])
        .execute()
        .data
        or []
    )
    assistant_ids = {a["vapi_assistant_id"] for a in agents if a.get("vapi_assistant_id")}
    if not assistant_ids:
        return {"data": {"imported": 0, "updated": 0, "note": "No VAPI-linked agents found for this account."}, "error": None}

    try:
        calls = await vapi_client.list_calls(limit=limit)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Could not reach VAPI: {e}")

    mine = [c for c in calls if c.get("assistantId") in assistant_ids][:100]
    imported = updated = failed = 0
    for c in mine:
        try:
            # fetch the full call so the artifact (messages/recording/transcript) is present
            full = await vapi_client.get_call(c["id"])
            res = import_vapi_call(full, user["user_id"])
            if res == "imported":
                imported += 1
            elif res == "updated":
                updated += 1
        except Exception as e:
            failed += 1
            logger.warning(f"sync-from-vapi: failed to import call {c.get('id')}: {e}")

    return {
        "data": {"imported": imported, "updated": updated, "failed": failed, "matched": len(mine), "scanned": len(calls)},
        "error": None,
    }


@router.get("/{conversation_id}")
async def get_conversation(conversation_id: str, user=Depends(get_current_user)):
    result = (
        supabase.table("conversations")
        .select("*")
        .eq("id", conversation_id)
        .eq("user_id", user["user_id"])
        .maybe_single()
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return {"data": result.data, "error": None}


@router.get("/{conversation_id}/transcript")
async def get_transcript(conversation_id: str, user=Depends(get_current_user)):
    result = (
        supabase.table("conversations")
        .select("id, transcript, transcript_messages, recording_url, stereo_recording_url, ai_summary")
        .eq("id", conversation_id)
        .eq("user_id", user["user_id"])
        .maybe_single()
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return {"data": result.data, "error": None}


@router.get("/{conversation_id}/recording-url")
async def get_recording_url(conversation_id: str, user=Depends(get_current_user)):
    """Return a *playable* recording URL. VAPI's stored recordingUrl is a raw,
    private R2 path (not streamable); VAPI exposes short-lived presigned URLs that
    expire, so we fetch a fresh one on demand each time the call is opened."""
    row = (
        supabase.table("conversations")
        .select("vapi_call_id, recording_url, stereo_recording_url")
        .eq("id", conversation_id)
        .eq("user_id", user["user_id"])
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
    supabase.table("conversations").delete().eq("id", conversation_id).eq("user_id", user["user_id"]).execute()
    return {"data": None, "error": None}
