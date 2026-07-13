from fastapi import APIRouter, Depends, HTTPException, Query
from dependencies import get_current_user
from database import supabase
from typing import Optional

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
        .select("id, transcript, recording_url, ai_summary")
        .eq("id", conversation_id)
        .eq("user_id", user["user_id"])
        .maybe_single()
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return {"data": result.data, "error": None}


@router.delete("/{conversation_id}")
async def delete_conversation(conversation_id: str, user=Depends(get_current_user)):
    supabase.table("conversations").delete().eq("id", conversation_id).eq("user_id", user["user_id"]).execute()
    return {"data": None, "error": None}
