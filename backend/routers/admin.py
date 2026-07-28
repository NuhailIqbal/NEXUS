import calendar
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException
from dependencies import get_admin_user
from database import supabase
from pydantic import BaseModel
from typing import Optional
from routers.billing import (
    DEFAULT_RATE_PER_MINUTE, DEFAULT_COST_MULTIPLIER, PHONE_NUMBER_MONTHLY_COST,
    credit_balance, debit_balance, get_balance,
)
from services import vapi_client
from config import settings

router = APIRouter(prefix="/admin", tags=["Admin"])


def _admin_email_map():
    auth_users = supabase.auth.admin.list_users()
    return {str(u.id): u.email for u in auth_users}


def _parse_dt(value):
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except Exception:
        return None


def _day_buckets(days: int):
    """Return (ordered day keys, dict initialised to 0) for the last `days` days."""
    now = datetime.now(timezone.utc)
    start = (now - timedelta(days=days - 1)).replace(hour=0, minute=0, second=0, microsecond=0)
    keys = [(start + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(days)]
    return keys, {k: 0 for k in keys}


class AdminLogin(BaseModel):
    username: str
    password: str


@router.post("/login")
async def admin_login(body: AdminLogin):
    """Verify admin credentials (from server env) and return a short-lived admin token.

    The password is checked server-side only — it is never sent to or stored in the
    browser, so it cannot be extracted from the client bundle.
    """
    import time
    from jose import jwt
    if not settings.verify_admin_login(body.username, body.password):
        raise HTTPException(status_code=401, detail="Invalid admin credentials")
    now = int(time.time())
    token = jwt.encode(
        {"sub": body.username, "adm": True, "iat": now, "exp": now + 60 * 60 * 12},
        settings.active_jwt_secret,
        algorithm="HS256",
    )
    return {"data": {"admin_token": token, "username": body.username}, "error": None}


class UserUpdate(BaseModel):
    status: Optional[str] = None
    is_active: Optional[bool] = None
    rate_per_minute: Optional[float] = None
    cost_multiplier: Optional[float] = None
    total_charges: Optional[float] = None
    balance: Optional[float] = None


@router.get("/users")
async def list_users(admin=Depends(get_admin_user)):
    auth_users = supabase.auth.admin.list_users()
    email_map = {str(u.id): u.email for u in auth_users}
    user_ids = list(email_map.keys())

    if not user_ids:
        return {"data": [], "error": None}

    profiles = (
        supabase.table("profiles")
        .select("id, full_name, company_name, created_at")
        .in_("id", user_ids)
        .execute()
    )
    profile_map = {p["id"]: p for p in (profiles.data or [])}

    billing_rows = supabase.table("billing").select("*").in_("user_id", user_ids).execute()
    billing_map = {b["user_id"]: b for b in (billing_rows.data or [])}

    conversation_counts = {}
    for uid in user_ids:
        result = (
            supabase.table("conversations")
            .select("id", count="exact")
            .eq("user_id", uid)
            .execute()
        )
        conversation_counts[uid] = result.count or 0

    # How many phone numbers each user owns (single bulk fetch).
    phone_counts: dict[str, int] = {}
    phone_rows = supabase.table("phone_numbers").select("user_id").in_("user_id", user_ids).execute()
    for r in (phone_rows.data or []):
        phone_counts[r["user_id"]] = phone_counts.get(r["user_id"], 0) + 1

    users = []
    for uid in user_ids:
        p = profile_map.get(uid, {})
        b = billing_map.get(uid, {})
        users.append({
            "id": uid,
            "email": email_map.get(uid, ""),
            "full_name": p.get("full_name", ""),
            "company_name": p.get("company_name", ""),
            "created_at": p.get("created_at", ""),
            "status": b.get("status", "trial"),
            "is_active": b.get("is_active", True),
            "rate_per_minute": float(b.get("rate_per_minute") or DEFAULT_RATE_PER_MINUTE),
            "cost_multiplier": float(b.get("cost_multiplier") or DEFAULT_COST_MULTIPLIER),
            "total_charges": float(b.get("total_charges") or 0),
            "balance": float(b.get("balance") or 0),
            "total_conversations": conversation_counts.get(uid, 0),
            "phone_numbers": phone_counts.get(uid, 0),
            "stripe_customer_id": b.get("stripe_customer_id"),
        })

    users.sort(key=lambda u: u.get("created_at", ""), reverse=True)
    return {"data": users, "error": None}


@router.get("/users/{user_id}")
async def get_user_detail(user_id: str, admin=Depends(get_admin_user)):
    profile_res = supabase.table("profiles").select("*").eq("id", user_id).execute()
    profile_data = profile_res.data[0] if profile_res.data else {}

    try:
        auth_user = supabase.auth.admin.get_user_by_id(user_id)
        profile_data["email"] = auth_user.user.email if auth_user.user else ""
    except Exception:
        profile_data["email"] = ""

    if not profile_data.get("id"):
        profile_data["id"] = user_id

    billing_res = supabase.table("billing").select("*").eq("user_id", user_id).execute()

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
            "profile": profile_data,
            "billing": billing_res.data[0] if billing_res.data else {},
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

    existing = supabase.table("billing").select("id").eq("user_id", user_id).execute()
    has_row = bool(existing.data)

    if has_row:
        supabase.table("billing").update(updates).eq("user_id", user_id).execute()
    else:
        updates["user_id"] = user_id
        supabase.table("billing").insert(updates).execute()

    result = supabase.table("billing").select("*").eq("user_id", user_id).execute()
    return {"data": result.data[0] if result.data else None, "error": None}


@router.delete("/users/{user_id}")
async def delete_user(user_id: str, admin=Depends(get_admin_user)):
    """Permanently delete a user and all their data.

    Best-effort cleanup of the user's VAPI resources first, then the auth user
    row — every user-owned table cascades via ON DELETE CASCADE.
    """
    # Best-effort: remove the user's VAPI assistants, transfer tools and phone numbers.
    if settings.vapi_api_key:
        try:
            agents = supabase.table("ai_agents").select("vapi_assistant_id, transfer_tool_id").eq("user_id", user_id).execute()
            for a in (agents.data or []):
                if a.get("vapi_assistant_id"):
                    try:
                        await vapi_client.delete_assistant(a["vapi_assistant_id"])
                    except Exception:
                        pass
                if a.get("transfer_tool_id"):
                    try:
                        await vapi_client.delete_tool(a["transfer_tool_id"])
                    except Exception:
                        pass
            phones = supabase.table("phone_numbers").select("vapi_phone_id").eq("user_id", user_id).execute()
            for p in (phones.data or []):
                if p.get("vapi_phone_id"):
                    try:
                        await vapi_client.delete_phone_number(p["vapi_phone_id"])
                    except Exception:
                        pass
            # Standalone tools the user registered in VAPI (the local rows cascade,
            # but the VAPI-side tool objects must be removed explicitly).
            try:
                tools = supabase.table("tools").select("vapi_tool_id").eq("user_id", user_id).execute()
                for t in (tools.data or []):
                    if t.get("vapi_tool_id"):
                        try:
                            await vapi_client.delete_tool(t["vapi_tool_id"])
                        except Exception:
                            pass
            except Exception:
                pass
        except Exception:
            pass

    # Delete the auth user — all user-owned tables cascade.
    try:
        supabase.auth.admin.delete_user(user_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete user: {e}")

    return {"data": {"deleted": user_id}, "error": None}


@router.post("/users/{user_id}/impersonate")
async def impersonate_user(user_id: str, admin=Depends(get_admin_user)):
    """Issue a real login token for the target user so an admin can view the app as them.

    The admin is already authenticated via the X-Admin-Auth gate, so no password is
    needed. Every impersonation is written to the server log as an audit trail.
    """
    from routers.auth import _issue_token  # local import avoids any import cycle

    auth_user = supabase.auth.admin.get_user_by_id(user_id)
    if not auth_user or not getattr(auth_user, "user", None):
        raise HTTPException(status_code=404, detail="User not found")
    email = auth_user.user.email or ""

    # Short-lived (2h) token, tagged as an impersonation for auditability, rather
    # than a full 7-day login token equivalent to the user's own password login.
    token = _issue_token(
        user_id, email,
        ttl_seconds=60 * 60 * 2,
        extra_claims={"imp": True, "imp_by": admin.get("username")},
    )

    import logging
    logging.getLogger("uvicorn.error").warning(
        "ADMIN IMPERSONATION: admin=%s issued a session for user=%s (%s)",
        admin.get("username"), user_id, email,
    )

    return {
        "data": {"access_token": token, "token_type": "bearer",
                 "user": {"id": user_id, "email": email}},
        "error": None,
    }


class BalanceAdjust(BaseModel):
    amount: float
    reason: Optional[str] = None


@router.post("/users/{user_id}/balance")
async def adjust_balance(user_id: str, body: BalanceAdjust, admin=Depends(get_admin_user)):
    """Admin manually adds (or removes, if negative) wallet balance for a user.

    Recorded in the wallet_transactions ledger as an `admin` entry. This is
    real, spendable balance — the user can use it for numbers, calls and plans.
    """
    amount = round(float(body.amount or 0), 2)
    if amount == 0:
        raise HTTPException(status_code=400, detail="Amount must be non-zero")
    note = body.reason or "Admin balance adjustment"
    if amount > 0:
        new_balance = credit_balance(user_id, amount, "admin", note)
    else:
        new_balance = debit_balance(user_id, -amount, "admin", note)
    return {"data": {"balance": new_balance, "added": amount}, "error": None}


@router.post("/users/{user_id}/toggle-access")
async def toggle_access(user_id: str, admin=Depends(get_admin_user)):
    existing = supabase.table("billing").select("is_active").eq("user_id", user_id).execute()
    has_row = bool(existing.data)

    current = existing.data[0].get("is_active", True) if has_row else True
    new_val = not current

    if has_row:
        supabase.table("billing").update({"is_active": new_val}).eq("user_id", user_id).execute()
    else:
        supabase.table("billing").insert({
            "user_id": user_id,
            "is_active": new_val,
        }).execute()

    return {
        "data": {"is_active": new_val},
        "error": None,
    }


@router.get("/agents")
async def list_all_agents(admin=Depends(get_admin_user)):
    """All AI agents across every user (with the owner's email)."""
    agents = (
        supabase.table("ai_agents")
        .select("id, name, status, category, voice, language, created_at, user_id, vapi_assistant_id, transfer_number")
        .order("created_at", desc=True)
        .execute()
    )
    rows = agents.data or []

    auth_users = supabase.auth.admin.list_users()
    email_map = {str(u.id): u.email for u in auth_users}

    profiles = supabase.table("profiles").select("id, full_name").execute()
    name_map = {p["id"]: p.get("full_name", "") for p in (profiles.data or [])}

    for a in rows:
        uid = a.get("user_id")
        a["owner_email"] = email_map.get(uid, "")
        a["owner_name"] = name_map.get(uid, "")
        a["synced"] = bool(a.get("vapi_assistant_id"))

    return {"data": rows, "error": None}


def _add_one_month(dt):
    """Same calendar day next month, clamped to that month's last day."""
    y = dt.year + (1 if dt.month == 12 else 0)
    m = 1 if dt.month == 12 else dt.month + 1
    last_day = calendar.monthrange(y, m)[1]
    return dt.replace(year=y, month=m, day=min(dt.day, last_day))


@router.get("/phone-numbers")
async def list_all_phone_numbers(admin=Depends(get_admin_user)):
    """Every phone number across all users, with owner, purchase date and monthly expiry.

    Expiry = purchase date + 1 month (the number's paid month runs out then).
    """
    nums = (
        supabase.table("phone_numbers")
        .select("id, number, provider, status, agent_id, monthly_cost, created_at, user_id")
        .order("created_at", desc=True)
        .execute()
    )
    rows = nums.data or []

    email_map = _admin_email_map()
    profiles = supabase.table("profiles").select("id, full_name").execute()
    name_map = {p["id"]: p.get("full_name", "") for p in (profiles.data or [])}

    # How many numbers each user owns (shown alongside every row).
    counts: dict[str, int] = {}
    for n in rows:
        uid = n.get("user_id")
        counts[uid] = counts.get(uid, 0) + 1

    now = datetime.now(timezone.utc)
    for n in rows:
        uid = n.get("user_id")
        n["owner_email"] = email_map.get(uid, "")
        n["owner_name"] = name_map.get(uid, "")
        n["owner_number_count"] = counts.get(uid, 0)
        # Effective monthly fee: Twilio is billed $3/mo; VAPI numbers are free.
        n["monthly_cost"] = PHONE_NUMBER_MONTHLY_COST if (n.get("provider") or "").lower() == "twilio" else 0.0
        created = _parse_dt(n.get("created_at"))
        if created:
            expires = _add_one_month(created)
            n["expires_at"] = expires.isoformat()
            n["days_left"] = (expires - now).days
        else:
            n["expires_at"] = None
            n["days_left"] = None

    return {"data": rows, "error": None}


@router.get("/payments")
async def admin_payments(admin=Depends(get_admin_user)):
    """Per-user charges, and recent billed calls."""
    billing_rows = supabase.table("billing").select("*").execute().data or []
    email_map = _admin_email_map()
    profiles = supabase.table("profiles").select("id, full_name").execute().data or []
    name_map = {p["id"]: p.get("full_name", "") for p in profiles}

    per_user, total_charges = [], 0.0
    for b in billing_rows:
        uid = b.get("user_id")
        charges = float(b.get("total_charges") or 0)
        total_charges += charges
        per_user.append({
            "email": email_map.get(uid, ""),
            "name": name_map.get(uid, ""),
            "status": b.get("status", "trial"),
            "total_charges": round(charges, 2),
            "balance": float(b.get("balance") or 0),
            "stripe_customer_id": b.get("stripe_customer_id"),
        })
    per_user.sort(key=lambda x: x["total_charges"], reverse=True)

    calls = (
        supabase.table("conversations")
        .select("user_id, phone, contact_name, direction, duration, call_cost, call_time")
        .gt("call_cost", 0)
        .order("call_time", desc=True)
        .limit(30)
        .execute()
    )
    recent = calls.data or []
    for c in recent:
        c["email"] = email_map.get(c.get("user_id"), "")

    return {"data": {
        "summary": {"total_charges": round(total_charges, 2)},
        "per_user": per_user,
        "recent_calls": recent,
    }, "error": None}


@router.get("/revenue")
async def admin_revenue(admin=Depends(get_admin_user)):
    """Usage revenue + a 30-day usage-revenue trend."""
    convos = supabase.table("conversations").select("call_cost, call_time").execute().data or []
    billing_rows = supabase.table("billing").select("total_charges").execute().data or []

    usage_revenue = sum(float(c.get("call_cost") or 0) for c in convos)
    total_charges = sum(float(b.get("total_charges") or 0) for b in billing_rows)

    keys, buckets = _day_buckets(30)
    daily = {k: 0.0 for k in keys}
    for c in convos:
        dt = _parse_dt(c.get("call_time"))
        if dt:
            key = dt.strftime("%Y-%m-%d")
            if key in daily:
                daily[key] += float(c.get("call_cost") or 0)
    series = [{"day": k, "label": datetime.strptime(k, "%Y-%m-%d").strftime("%b %d"), "revenue": round(daily[k], 2)} for k in keys]

    return {"data": {
        "totals": {
            "usage_revenue": round(usage_revenue, 2),
            "total_charges": round(total_charges, 2),
        },
        "timeseries": series,
    }, "error": None}


@router.get("/agents-report")
async def admin_agents_report(admin=Depends(get_admin_user)):
    """Per-agent performance across the whole platform."""
    agents = supabase.table("ai_agents").select("id, name, user_id").execute().data or []
    convos = supabase.table("conversations").select("agent_id, status, qualified").execute().data or []
    email_map = _admin_email_map()

    by_agent = {}
    for c in convos:
        aid = c.get("agent_id")
        if not aid:
            continue
        d = by_agent.setdefault(aid, {"total": 0, "completed": 0, "qualified": 0})
        d["total"] += 1
        if c.get("status") == "Completed":
            d["completed"] += 1
        if c.get("qualified"):
            d["qualified"] += 1

    rows = []
    for a in agents:
        s = by_agent.get(a["id"], {"total": 0, "completed": 0, "qualified": 0})
        rows.append({
            "id": a["id"],
            "name": a["name"],
            "owner_email": email_map.get(a.get("user_id"), ""),
            "total_calls": s["total"],
            "completed": s["completed"],
            "qualified": s["qualified"],
        })
    rows.sort(key=lambda x: x["total_calls"], reverse=True)
    return {"data": rows, "error": None}


@router.get("/users-report")
async def admin_users_report(admin=Depends(get_admin_user)):
    """Signups trend, active/disabled counts, and top users by activity."""
    profiles = supabase.table("profiles").select("id, full_name, created_at").execute().data or []
    billing_rows = supabase.table("billing").select("user_id, is_active").execute().data or []
    convos = supabase.table("conversations").select("user_id").execute().data or []
    agents = supabase.table("ai_agents").select("user_id").execute().data or []
    email_map = _admin_email_map()

    billing_map = {b["user_id"]: b for b in billing_rows}
    convo_count, agent_count = {}, {}
    for c in convos:
        convo_count[c.get("user_id")] = convo_count.get(c.get("user_id"), 0) + 1
    for a in agents:
        agent_count[a.get("user_id")] = agent_count.get(a.get("user_id"), 0) + 1

    active_users = sum(1 for b in billing_rows if b.get("is_active", True))
    disabled_users = sum(1 for b in billing_rows if not b.get("is_active", True))

    keys, _ = _day_buckets(30)
    daily = {k: 0 for k in keys}
    for p in profiles:
        dt = _parse_dt(p.get("created_at"))
        if dt:
            key = dt.strftime("%Y-%m-%d")
            if key in daily:
                daily[key] += 1
    series = [{"day": k, "label": datetime.strptime(k, "%Y-%m-%d").strftime("%b %d"), "signups": daily[k]} for k in keys]

    top = []
    for p in profiles:
        uid = p["id"]
        top.append({
            "email": email_map.get(uid, ""),
            "name": p.get("full_name", ""),
            "conversations": convo_count.get(uid, 0),
            "agents": agent_count.get(uid, 0),
        })
    top.sort(key=lambda x: x["conversations"], reverse=True)

    return {"data": {
        "totals": {"total_users": len(profiles), "active_users": active_users, "disabled_users": disabled_users},
        "signups": series,
        "top_users": top[:20],
    }, "error": None}


@router.get("/stats")
async def admin_stats(admin=Depends(get_admin_user)):
    users = supabase.table("profiles").select("id", count="exact").execute()
    conversations = supabase.table("conversations").select("id", count="exact").execute()
    agents = supabase.table("ai_agents").select("id", count="exact").execute()

    return {
        "data": {
            "total_users": users.count or 0,
            "total_conversations": conversations.count or 0,
            "total_agents": agents.count or 0,
        },
        "error": None,
    }


# ── Platform settings (promo controls) ──

class PromoSettingsUpdate(BaseModel):
    promo_enabled: Optional[bool] = None
    promo_amount: Optional[float] = None
    promo_expiry_days: Optional[int] = None


def _get_settings_row() -> dict:
    rows = supabase.table("platform_settings").select("*").limit(1).execute().data or []
    if rows:
        return rows[0]
    supabase.table("platform_settings").insert({"id": 1}).execute()
    return (supabase.table("platform_settings").select("*").limit(1).execute().data or [{}])[0]


@router.get("/settings")
async def get_platform_settings(admin=Depends(get_admin_user)):
    return {"data": _get_settings_row(), "error": None}


@router.patch("/settings")
async def update_platform_settings(body: PromoSettingsUpdate, admin=Depends(get_admin_user)):
    _get_settings_row()  # ensure the singleton row exists
    updates = body.model_dump(exclude_none=True)
    if updates:
        updates["updated_at"] = datetime.now(timezone.utc).isoformat()
        supabase.table("platform_settings").update(updates).eq("id", 1).execute()
    return {"data": _get_settings_row(), "error": None}


# ── Promo codes (redeemable by users) ──

class PromoCodeCreate(BaseModel):
    code: str
    amount: float
    expiry_days: Optional[int] = None      # credit lifetime after redemption
    max_redemptions: Optional[int] = None  # None = unlimited
    valid_until: Optional[str] = None      # ISO date; None = code never expires


class PromoCodeUpdate(BaseModel):
    active: Optional[bool] = None
    amount: Optional[float] = None
    expiry_days: Optional[int] = None
    max_redemptions: Optional[int] = None
    valid_until: Optional[str] = None


@router.get("/promo-codes")
async def list_promo_codes(admin=Depends(get_admin_user)):
    rows = (
        supabase.table("promo_codes").select("*")
        .order("created_at", desc=True).execute().data or []
    )
    return {"data": rows, "error": None}


@router.post("/promo-codes")
async def create_promo_code(body: PromoCodeCreate, admin=Depends(get_admin_user)):
    code = (body.code or "").strip().upper()
    if not code:
        raise HTTPException(status_code=400, detail="Code is required")
    if len(code) < 3:
        raise HTTPException(status_code=400, detail="Code must be at least 3 characters")
    amount = round(float(body.amount or 0), 2)
    if amount <= 0:
        raise HTTPException(status_code=400, detail="Amount must be greater than 0")

    existing = supabase.table("promo_codes").select("id").eq("code", code).limit(1).execute().data
    if existing:
        raise HTTPException(status_code=409, detail="That code already exists")

    row = {
        "code": code,
        "amount": amount,
        "expiry_days": body.expiry_days,
        "max_redemptions": body.max_redemptions,
        "valid_until": body.valid_until,
        "active": True,
    }
    result = supabase.table("promo_codes").insert(row).execute()
    return {"data": result.data[0] if result.data else row, "error": None}


@router.patch("/promo-codes/{code_id}")
async def update_promo_code(code_id: str, body: PromoCodeUpdate, admin=Depends(get_admin_user)):
    updates = body.model_dump(exclude_none=True)
    if not updates:
        return {"data": None, "error": "No fields to update"}
    if "amount" in updates:
        updates["amount"] = round(float(updates["amount"]), 2)
        if updates["amount"] <= 0:
            raise HTTPException(status_code=400, detail="Amount must be greater than 0")
    supabase.table("promo_codes").update(updates).eq("id", code_id).execute()
    fresh = supabase.table("promo_codes").select("*").eq("id", code_id).maybe_single().execute().data
    return {"data": fresh, "error": None}


@router.delete("/promo-codes/{code_id}")
async def delete_promo_code(code_id: str, admin=Depends(get_admin_user)):
    """Deletes the code. Redemption rows cascade, but credit already granted is untouched."""
    supabase.table("promo_codes").delete().eq("id", code_id).execute()
    return {"data": {"deleted": code_id}, "error": None}


@router.get("/promo-kpis")
async def promo_kpis(admin=Depends(get_admin_user)):
    """Free-credit funnel: issued/consumed + Free->Paid conversion, LTV, time-to-first-purchase."""
    profiles = supabase.table("profiles").select("id, created_at").execute().data or []
    total_users = len(profiles)
    created_by_user = {p["id"]: p.get("created_at") for p in profiles}

    # Promo credits issued vs consumed (from the promo grants).
    grants = (
        supabase.table("credit_grants").select("amount, remaining")
        .eq("type", "promo").execute().data or []
    )
    issued = round(sum(float(g["amount"]) for g in grants), 2)
    consumed = round(sum(float(g["amount"]) - float(g["remaining"]) for g in grants), 2)

    # Real money paid = wallet top-ups (Stripe). Drives conversion / LTV / time-to-first.
    topups = (
        supabase.table("wallet_transactions").select("user_id, amount, created_at")
        .eq("kind", "topup").execute().data or []
    )
    paid = {}  # user_id -> {"total": $, "first": ts}
    for t in topups:
        amt = float(t.get("amount") or 0)
        if amt <= 0:
            continue
        rec = paid.setdefault(t["user_id"], {"total": 0.0, "first": None})
        rec["total"] += amt
        ts = t.get("created_at")
        if ts and (rec["first"] is None or str(ts) < str(rec["first"])):
            rec["first"] = ts

    converted = len(paid)
    conversion_rate = round(100 * converted / total_users, 1) if total_users else 0.0
    ltv = round(sum(r["total"] for r in paid.values()) / converted, 2) if converted else 0.0

    diffs = []
    for uid, rec in paid.items():
        c, f = created_by_user.get(uid), rec["first"]
        if c and f:
            try:
                cd = datetime.fromisoformat(str(c).replace("Z", "+00:00"))
                fd = datetime.fromisoformat(str(f).replace("Z", "+00:00"))
                diffs.append(max(0.0, (fd - cd).total_seconds() / 86400.0))
            except Exception:
                pass
    avg_ttfp = round(sum(diffs) / len(diffs), 1) if diffs else None

    return {
        "data": {
            "total_users": total_users,
            "credits_issued": issued,
            "credits_consumed": consumed,
            "converted_users": converted,
            "conversion_rate": conversion_rate,
            "ltv": ltv,
            "avg_time_to_first_purchase_days": avg_ttfp,
            "cac": None,  # manual — no ad-spend data in-app
        },
        "error": None,
    }
