from fastapi import APIRouter, Depends, HTTPException
from dependencies import get_admin_user
from database import supabase
from pydantic import BaseModel
from typing import Optional

router = APIRouter(prefix="/admin", tags=["Admin"])


class UserUpdate(BaseModel):
    plan: Optional[str] = None
    status: Optional[str] = None
    is_active: Optional[bool] = None
    outbound_limit: Optional[int] = None
    inbound_limit: Optional[int] = None
    agents_limit: Optional[int] = None
    credits: Optional[int] = None


class CreditAdjust(BaseModel):
    amount: int
    reason: Optional[str] = None


@router.get("/users")
async def list_users(admin=Depends(get_admin_user)):
    profiles = (
        supabase.table("profiles")
        .select("id, email, full_name, company_name, created_at")
        .order("created_at", desc=True)
        .execute()
    )
    if not profiles.data:
        return {"data": [], "error": None}

    user_ids = [p["id"] for p in profiles.data]
    billing_rows = supabase.table("billing").select("*").in_("user_id", user_ids).execute()
    billing_map = {b["user_id"]: b for b in (billing_rows.data or [])}

    agent_counts = {}
    for uid in user_ids:
        result = (
            supabase.table("ai_agents")
            .select("id", count="exact")
            .eq("user_id", uid)
            .execute()
        )
        agent_counts[uid] = result.count or 0

    conversation_counts = {}
    for uid in user_ids:
        result = (
            supabase.table("conversations")
            .select("id", count="exact")
            .eq("user_id", uid)
            .execute()
        )
        conversation_counts[uid] = result.count or 0

    users = []
    for p in profiles.data:
        uid = p["id"]
        b = billing_map.get(uid, {})
        users.append({
            "id": uid,
            "email": p.get("email", ""),
            "full_name": p.get("full_name", ""),
            "company_name": p.get("company_name", ""),
            "created_at": p.get("created_at", ""),
            "plan": b.get("plan", "free"),
            "status": b.get("status", "trial"),
            "is_active": b.get("is_active", True),
            "outbound_limit": b.get("outbound_limit", 0),
            "outbound_used": b.get("outbound_used", 0),
            "inbound_limit": b.get("inbound_limit", 0),
            "inbound_used": b.get("inbound_used", 0),
            "agents_limit": b.get("agents_limit", 10),
            "agents_used": agent_counts.get(uid, 0),
            "credits": b.get("credits", 0),
            "total_conversations": conversation_counts.get(uid, 0),
            "stripe_customer_id": b.get("stripe_customer_id"),
            "stripe_subscription_id": b.get("stripe_subscription_id"),
            "current_period_end": b.get("current_period_end"),
        })

    return {"data": users, "error": None}


@router.get("/users/{user_id}")
async def get_user_detail(user_id: str, admin=Depends(get_admin_user)):
    profile = (
        supabase.table("profiles")
        .select("*")
        .eq("id", user_id)
        .maybe_single()
        .execute()
    )
    if not profile.data:
        raise HTTPException(status_code=404, detail="User not found")

    billing = (
        supabase.table("billing")
        .select("*")
        .eq("user_id", user_id)
        .maybe_single()
        .execute()
    )

    agents = (
        supabase.table("ai_agents")
        .select("id, name, created_at")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .execute()
    )

    conversations = (
        supabase.table("conversations")
        .select("id, direction, status, duration, created_at", count="exact")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .limit(20)
        .execute()
    )

    outbound_count = (
        supabase.table("conversations")
        .select("id", count="exact")
        .eq("user_id", user_id)
        .eq("direction", "outbound")
        .execute()
    )

    inbound_count = (
        supabase.table("conversations")
        .select("id", count="exact")
        .eq("user_id", user_id)
        .eq("direction", "inbound")
        .execute()
    )

    return {
        "data": {
            "profile": profile.data,
            "billing": billing.data or {},
            "agents": agents.data or [],
            "recent_conversations": conversations.data or [],
            "total_conversations": conversations.count or 0,
            "total_outbound": outbound_count.count or 0,
            "total_inbound": inbound_count.count or 0,
        },
        "error": None,
    }


@router.patch("/users/{user_id}")
async def update_user(user_id: str, body: UserUpdate, admin=Depends(get_admin_user)):
    updates = body.model_dump(exclude_none=True)
    if not updates:
        return {"data": None, "error": "No fields to update"}

    existing = (
        supabase.table("billing")
        .select("id")
        .eq("user_id", user_id)
        .maybe_single()
        .execute()
    )

    if existing.data:
        supabase.table("billing").update(updates).eq("user_id", user_id).execute()
    else:
        updates["user_id"] = user_id
        supabase.table("billing").insert(updates).execute()

    result = (
        supabase.table("billing")
        .select("*")
        .eq("user_id", user_id)
        .maybe_single()
        .execute()
    )
    return {"data": result.data, "error": None}


@router.post("/users/{user_id}/credits")
async def adjust_credits(user_id: str, body: CreditAdjust, admin=Depends(get_admin_user)):
    existing = (
        supabase.table("billing")
        .select("credits")
        .eq("user_id", user_id)
        .maybe_single()
        .execute()
    )

    current = existing.data.get("credits", 0) if existing.data else 0
    new_credits = max(0, current + body.amount)

    if existing.data:
        supabase.table("billing").update({"credits": new_credits}).eq("user_id", user_id).execute()
    else:
        supabase.table("billing").insert({
            "user_id": user_id,
            "credits": new_credits,
            "plan": "free",
            "status": "trial",
        }).execute()

    return {
        "data": {"credits": new_credits, "adjustment": body.amount, "reason": body.reason},
        "error": None,
    }


@router.post("/users/{user_id}/toggle-access")
async def toggle_access(user_id: str, admin=Depends(get_admin_user)):
    existing = (
        supabase.table("billing")
        .select("is_active")
        .eq("user_id", user_id)
        .maybe_single()
        .execute()
    )

    current = existing.data.get("is_active", True) if existing.data else True
    new_val = not current

    if existing.data:
        supabase.table("billing").update({"is_active": new_val}).eq("user_id", user_id).execute()
    else:
        supabase.table("billing").insert({
            "user_id": user_id,
            "is_active": new_val,
            "plan": "free",
            "status": "trial",
        }).execute()

    return {
        "data": {"is_active": new_val},
        "error": None,
    }


@router.post("/users/{user_id}/reset-usage")
async def reset_usage(user_id: str, admin=Depends(get_admin_user)):
    existing = (
        supabase.table("billing")
        .select("id")
        .eq("user_id", user_id)
        .maybe_single()
        .execute()
    )

    if existing.data:
        supabase.table("billing").update({
            "outbound_used": 0,
            "inbound_used": 0,
        }).eq("user_id", user_id).execute()

    return {"data": {"outbound_used": 0, "inbound_used": 0}, "error": None}


@router.get("/stats")
async def admin_stats(admin=Depends(get_admin_user)):
    users = supabase.table("profiles").select("id", count="exact").execute()
    conversations = supabase.table("conversations").select("id", count="exact").execute()
    agents = supabase.table("ai_agents").select("id", count="exact").execute()
    active_billing = (
        supabase.table("billing")
        .select("id", count="exact")
        .eq("status", "active")
        .execute()
    )

    return {
        "data": {
            "total_users": users.count or 0,
            "total_conversations": conversations.count or 0,
            "total_agents": agents.count or 0,
            "active_subscriptions": active_billing.count or 0,
        },
        "error": None,
    }
