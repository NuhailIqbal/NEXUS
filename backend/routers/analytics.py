from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, Query
from dependencies import get_current_user
from database import supabase

router = APIRouter(prefix="/analytics", tags=["Analytics"])


def _parse_dt(value) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        s = str(value).replace("Z", "+00:00")
        return datetime.fromisoformat(s)
    except Exception:
        return None


def _duration_seconds(value) -> int:
    """Conversations.duration is stored as 'M:SS' or similar; parse to seconds, return 0 on failure."""
    if value is None:
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    s = str(value).strip()
    if ":" in s:
        try:
            parts = [int(p) for p in s.split(":")]
            if len(parts) == 2:
                return parts[0] * 60 + parts[1]
            if len(parts) == 3:
                return parts[0] * 3600 + parts[1] * 60 + parts[2]
        except Exception:
            return 0
    try:
        return int(float(s))
    except Exception:
        return 0


@router.get("/timeseries")
async def timeseries(
    user=Depends(get_current_user),
    days: int = Query(14, ge=1, le=90),
):
    """Per-day calls / completed / total duration for the last `days` days."""
    now = datetime.now(timezone.utc)
    start = (now - timedelta(days=days - 1)).replace(hour=0, minute=0, second=0, microsecond=0)

    convos = (
        supabase.table("conversations")
        .select("status, duration, call_time")
        .eq("user_id", user["user_id"])
        .gte("call_time", start.isoformat())
        .execute()
    )
    rows = convos.data or []

    buckets: dict[str, dict[str, int]] = {}
    for i in range(days):
        d = (start + timedelta(days=i)).strftime("%Y-%m-%d")
        buckets[d] = {"calls": 0, "completed": 0, "duration_sec": 0}

    for r in rows:
        dt = _parse_dt(r.get("call_time")) or _parse_dt(r.get("created_at"))
        if not dt:
            continue
        key = dt.strftime("%Y-%m-%d")
        if key not in buckets:
            continue
        buckets[key]["calls"] += 1
        if (r.get("status") or "").lower() == "completed":
            buckets[key]["completed"] += 1
        buckets[key]["duration_sec"] += _duration_seconds(r.get("duration"))

    series = [
        {
            "day": k,
            "label": datetime.strptime(k, "%Y-%m-%d").strftime("%b %d"),
            "calls": v["calls"],
            "completed": v["completed"],
            "duration_min": round(v["duration_sec"] / 60, 1),
        }
        for k, v in buckets.items()
    ]
    return {"data": series, "error": None}


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
    rows = campaigns.data or []

    # Qualified (transferred) count per campaign, aggregated from conversations.
    convos = (
        supabase.table("conversations")
        .select("campaign_id, qualified")
        .eq("user_id", user["user_id"])
        .execute()
    )
    qualified_by_campaign: dict[str, int] = {}
    for c in convos.data or []:
        if c.get("qualified") and c.get("campaign_id"):
            qualified_by_campaign[c["campaign_id"]] = qualified_by_campaign.get(c["campaign_id"], 0) + 1

    for r in rows:
        r["qualified_count"] = qualified_by_campaign.get(r["id"], 0)

    return {"data": rows, "error": None}


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
            .select("status, qualified")
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
            "qualified": sum(1 for c in calls if c.get("qualified")),
        })

    return {"data": result, "error": None}


@router.get("/overview")
async def overview_analytics(user=Depends(get_current_user)):
    convos = (
        supabase.table("conversations")
        .select("status, direction, duration, call_time, qualified")
        .eq("user_id", user["user_id"])
        .execute()
    )
    data = convos.data or []

    agents = supabase.table("ai_agents").select("id", count="exact").eq("user_id", user["user_id"]).execute()
    campaigns = supabase.table("outbound_campaigns").select("id", count="exact").eq("user_id", user["user_id"]).execute()
    contacts = supabase.table("contacts").select("id", count="exact").eq("user_id", user["user_id"]).execute()

    total = len(data)
    qualified = sum(1 for c in data if c.get("qualified"))

    return {
        "data": {
            "total_calls": total,
            "completed_calls": sum(1 for c in data if c.get("status") == "Completed"),
            "qualified_calls": qualified,
            "qualified_rate": round(qualified / total * 100, 1) if total else 0,
            "active_agents": agents.count or 0,
            "total_campaigns": campaigns.count or 0,
            "total_contacts": contacts.count or 0,
            "inbound_calls": sum(1 for c in data if c.get("direction") == "inbound"),
            "outbound_calls": sum(1 for c in data if c.get("direction") == "outbound"),
        },
        "error": None,
    }
