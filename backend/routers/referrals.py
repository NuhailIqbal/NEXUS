"""Referral tracking (tracking-only — no credit/payout).

Every user has their own auto-generated referral_code (see routers/auth.py). A
referral is recorded when someone registers with ?ref=CODE, and flips from 'pending'
to 'verified' when that referee verifies their email (routers/auth.py's verify_email).
"""
import logging
from fastapi import APIRouter, Depends
from dependencies import get_current_user
from database import supabase

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/referrals", tags=["Referrals"])


def _mask_email(email: str) -> str:
    """j***@example.com — referrer sees who they invited without a bare email dump."""
    if not email or "@" not in email:
        return email
    local, domain = email.split("@", 1)
    return f"{local[0]}***@{domain}" if local else f"***@{domain}"


@router.get("/me")
async def my_referrals(user=Depends(get_current_user)):
    """Return the caller's own referral code and the people they have referred.

    Each referral shows a masked email, its status ('pending' until the referee verifies
    their email, then 'verified') and timestamps, newest first, plus invited/verified
    counts. Scoped to the caller's own user id (not the team owner's). `code` is an empty
    string if no code has been generated for the user yet. Read-only; no credit is involved.
    """
    uid = user["user_id"]
    profile = supabase.table("profiles").select("referral_code").eq("id", uid).maybe_single().execute().data
    code = (profile or {}).get("referral_code") or ""

    rows = (
        supabase.table("referrals")
        .select("id, referee_id, status, created_at, verified_at")
        .eq("referrer_id", uid)
        .order("created_at", desc=True)
        .execute().data or []
    )

    # Resolve all referee emails in one query (avoids a lookup per referral row).
    referee_ids = [r["referee_id"] for r in rows]
    email_map: dict[str, str] = {}
    if referee_ids:
        users = supabase.table("users").select("id, email").in_("id", referee_ids).execute().data or []
        email_map = {u["id"]: u["email"] for u in users}

    # Only the masked email is returned; the referrer never receives the raw address.
    items = [{
        "id": r["id"],
        "referee_email": _mask_email(email_map.get(r["referee_id"], "")),
        "status": r["status"],
        "created_at": r["created_at"],
        "verified_at": r.get("verified_at"),
    } for r in rows]

    return {
        "data": {
            "code": code,
            "invited_count": len(items),
            "verified_count": sum(1 for i in items if i["status"] == "verified"),
            "referrals": items,
        },
        "error": None,
    }
