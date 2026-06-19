from fastapi import APIRouter, Depends
from dependencies import get_current_user
from database import supabase

router = APIRouter(prefix="/analytics", tags=["Analytics"])


@router.get("/channel")
async def channel_analytics(user=Depends(get_current_user)):
    convos = (
        supabase.table("conversations")
        .select("channel, status, duration")
        .eq("user_id", user["user_id"])
        .execute()
    )
    data = convos.data or []
    channels = {}
    for c in data:
        ch = c.get("channel", "Unknown")
        if ch not in channels:
            channels[ch] = {"total": 0, "completed": 0, "failed": 0}
        channels[ch]["total"] += 1
        if c.get("status") == "Completed":
            channels[ch]["completed"] += 1
        elif c.get("status") == "Failed":
            channels[ch]["failed"] += 1

    return {"data": channels, "error": None}


@router.get("/campaign")
async def campaign_analytics(user=Depends(get_current_user)):
    campaigns = (
        supabase.table("outbound_campaigns")
        .select("id, name, status, contacts_count, completed_count")
        .eq("user_id", user["user_id"])
        .execute()
    )
    return {"data": campaigns.data or [], "error": None}


@router.get("/agent")
async def agent_analytics(user=Depends(get_current_user)):
    agents = (
        supabase.table("ai_agents")
        .select("id, name, status")
        .eq("user_id", user["user_id"])
        .execute()
    )
    agent_list = agents.data or []

    result = []
    for agent in agent_list:
        convos = (
            supabase.table("conversations")
            .select("status")
            .eq("user_id", user["user_id"])
            .eq("agent_id", agent["id"])
            .execute()
        )
        calls = convos.data or []
        result.append({
            "id": agent["id"],
            "name": agent["name"],
            "status": agent["status"],
            "total_calls": len(calls),
            "completed": sum(1 for c in calls if c.get("status") == "Completed"),
            "failed": sum(1 for c in calls if c.get("status") == "Failed"),
        })

    return {"data": result, "error": None}


@router.get("/overview")
async def overview_analytics(user=Depends(get_current_user)):
    convos = (
        supabase.table("conversations")
        .select("status, direction, duration, call_time")
        .eq("user_id", user["user_id"])
        .execute()
    )
    data = convos.data or []

    agents = supabase.table("ai_agents").select("id", count="exact").eq("user_id", user["user_id"]).execute()
    campaigns = supabase.table("outbound_campaigns").select("id", count="exact").eq("user_id", user["user_id"]).execute()
    contacts = supabase.table("contacts").select("id", count="exact").eq("user_id", user["user_id"]).execute()

    return {
        "data": {
            "total_calls": len(data),
            "completed_calls": sum(1 for c in data if c.get("status") == "Completed"),
            "active_agents": agents.count or 0,
            "total_campaigns": campaigns.count or 0,
            "total_contacts": contacts.count or 0,
            "inbound_calls": sum(1 for c in data if c.get("direction") == "inbound"),
            "outbound_calls": sum(1 for c in data if c.get("direction") == "outbound"),
        },
        "error": None,
    }
