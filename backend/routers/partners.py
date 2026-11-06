"""Referral partner program: the admin side (/admin/partners) and the partner's own side (/partner).

A partner is an admin-created affiliate with a unique code (their link is /register?ref=CODE) and a commission rule.
Accounts that register with the code are attributed to the partner (routers/auth.py); the numbers (billed vs platform
cost vs profit vs commission) and the live activity feed are computed in services/partners.py.

Admin (X-Admin-Auth, like the rest of /admin):
  GET    /admin/partners                list every partner with signups, billed, platform cost, profit, commission, net
  POST   /admin/partners                create a partner (+ their login, or link an existing account) and its unique code
  GET    /admin/partners/activity       live feed across all partners (?partner_id= narrows it)
  GET    /admin/partners/{id}           one partner: totals + every referred account with its cost/billing/profit
  PATCH  /admin/partners/{id}           edit name / notes / status (active|paused) / commission rule
  GET    /admin/partners/{id}/payouts   the payment ledger (void payments included)
  POST   /admin/partners/{id}/payouts   record a payment (refused when it is more than what is still owed)
  PATCH  /admin/partners/{id}/payouts/{pid}        edit a payment's method / reference / note (amount and date are fixed)
  POST   /admin/partners/{id}/payouts/{pid}/void   undo a payment with a reason (the row stays for the audit trail)

Partner (a normal user login linked to a partner row; everything is scoped to THEIR partner row):
  GET    /partner/me                    is this account a partner? (the dashboard shows the Partner menu only if so)
  GET    /partner/overview              their stats, paid / still owed, payment history and every referred account
                                        (never the platform's cost or profit, nor the admin's notes on a payment)
  GET    /partner/activity              live feed of their referred users
  POST   /partner/users/{id}/impersonate   a 2h "view as" token for one of THEIR referred accounts (same flow as admins)

Plain `def` endpoints (blocking SQL runs in FastAPI's threadpool); `create_partner` is async because it awaits the admin
user-creation helper it reuses.
"""
import logging
import math
import re
import uuid
from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from database import supabase
from dependencies import get_admin_user, get_current_user
from services import partners as ps

logger = logging.getLogger(__name__)

admin_router = APIRouter(prefix="/admin/partners", tags=["Referral Partners (admin)"])
router = APIRouter(prefix="/partner", tags=["Referral Partners"])

CODE_RE = re.compile(r"^[A-Z0-9]{4,20}$")
STATUSES = ("active", "paused")
MAX_PERCENT = 100.0
MAX_FIXED = 10000.0
# Fields of a referred account a partner may see; platform cost and profit are admin-only.
_PARTNER_HIDDEN = ("platform_cost", "profit")
# Fields of a payment a partner may see: the admin's note, who recorded it and void details stay private.
_PARTNER_PAYOUT_FIELDS = ("id", "amount", "paid_on", "method", "reference")
MAX_PAYOUT = 1_000_000.0


def _ok(data):
    return {"data": data, "error": None}


def _referral_path(code: str) -> str:
    return f"/register?ref={code}"


def _clean_commission(ctype, value) -> tuple[str, float]:
    if ctype not in ps.COMMISSION_TYPES:
        raise HTTPException(400, "Commission type must be 'percent' or 'fixed'.")
    try:
        v = float(value)
    except (TypeError, ValueError):
        raise HTTPException(400, "Commission value must be a number.")
    if v < 0:
        raise HTTPException(400, "Commission value cannot be negative.")
    if ctype == "percent" and v > MAX_PERCENT:
        raise HTTPException(400, "A percentage commission cannot be more than 100.")
    if ctype == "fixed" and v > MAX_FIXED:
        raise HTTPException(400, f"A fixed commission cannot be more than ${MAX_FIXED:,.0f} per signup.")
    return ctype, round(v, 2)


def _code_taken(code: str) -> bool:
    """A code must be unique across partners AND users' own referral codes (both are read from ?ref=)."""
    if supabase.table("referral_partners").select("id").eq("code", code).maybe_single().execute().data:
        return True
    return bool(supabase.table("profiles").select("id").eq("referral_code", code).maybe_single().execute().data)


def _fresh_code() -> str:
    from routers.auth import _generate_referral_code
    for _ in range(10):
        code = _generate_referral_code()
        if not _code_taken(code):
            return code
    raise HTTPException(500, "Could not generate a unique referral code. Try again.")


def _partner_view(p: dict, totals: dict | None = None, *, admin: bool = True) -> dict:
    """The partner row as the API returns it (plus its totals when given). `notes` are the admin's private notes
    about the partner, so they are only included in admin responses (admin=False for everything a partner can call)."""
    out = {
        "id": str(p["id"]), "name": p["name"], "email": p["email"], "code": p["code"], "status": p["status"],
        "user_id": str(p["user_id"]) if p.get("user_id") else None,
        "commission_type": p["commission_type"], "commission_value": float(p["commission_value"]),
        "commission_label": ps.commission_label(p["commission_type"], p["commission_value"]),
        "referral_path": _referral_path(p["code"]), "created_at": p.get("created_at"),
    }
    if admin:
        out["notes"] = p.get("notes") or ""
    if totals is not None:
        out["totals"] = totals
    return out


# ───────────────────────────── admin ─────────────────────────────

class PartnerCreate(BaseModel):
    """POST /admin/partners. `password` is required only when no account with `email` exists yet."""
    name: str
    email: str
    password: Optional[str] = None
    code: Optional[str] = None
    commission_type: str = "percent"
    commission_value: float = 0
    notes: Optional[str] = None


class PartnerUpdate(BaseModel):
    """PATCH /admin/partners/{id}: only the fields sent are changed. The code never changes (links are already out)."""
    name: Optional[str] = None
    notes: Optional[str] = None
    status: Optional[str] = None
    commission_type: Optional[str] = None
    commission_value: Optional[float] = None


@admin_router.get("")
def list_partners(admin=Depends(get_admin_user)):
    rows = supabase.table("referral_partners").select("*").order("created_at", desc=True).execute().data or []
    totals = ps.partner_totals(rows)
    data = [_partner_view(p, totals[str(p["id"])]) for p in rows]
    keys = ("signups", "verified", "calls", "billed", "platform_cost", "profit", "commission", "net_profit", "paid", "owed")
    grand = {k: round(sum(d["totals"][k] for d in data), 2) if k not in ("signups", "verified", "calls")
             else sum(d["totals"][k] for d in data) for k in keys}
    return _ok({"partners": data, "totals": grand})


@admin_router.post("")
async def create_partner(body: PartnerCreate, admin=Depends(get_admin_user)):
    name = body.name.strip()
    email = body.email.strip().lower()
    if not name or not email or "@" not in email:
        raise HTTPException(400, "A name and a valid email are required.")
    ctype, cvalue = _clean_commission(body.commission_type, body.commission_value)

    code = (body.code or "").strip().upper()
    if code:
        if not CODE_RE.match(code):
            raise HTTPException(400, "A custom code must be 4 to 20 letters or digits.")
        if _code_taken(code):
            raise HTTPException(409, "That referral code is already in use.")
    else:
        code = _fresh_code()

    # The partner's login: an existing account with this email is linked; otherwise one is created
    # (pre-verified, exactly like Admin > Users > Create) from the password given.
    existing = supabase.table("users").select("id").eq("email", email).maybe_single().execute().data
    if existing:
        user_id = existing["id"]
        if supabase.table("referral_partners").select("id").eq("user_id", user_id).maybe_single().execute().data:
            raise HTTPException(409, "That account is already a referral partner.")
    else:
        if not body.password:
            raise HTTPException(400, "A password is required to create the partner's login.")
        from routers.admin import AdminUserCreate, create_user
        created = await create_user(AdminUserCreate(email=email, password=body.password, full_name=name), admin)
        user_id = created["data"]["id"]

    row = supabase.table("referral_partners").insert({
        "user_id": user_id, "name": name, "email": email, "code": code,
        "commission_type": ctype, "commission_value": cvalue, "notes": (body.notes or "").strip() or None,
    }).execute().data[0]
    logger.warning("REFERRAL PARTNER created: admin=%s partner=%s code=%s", admin.get("username"), row["id"], code)
    return _ok(_partner_view(row, ps.partner_totals([row])[str(row["id"])]))


@admin_router.get("/activity")
def admin_activity(partner_id: Optional[str] = None, admin=Depends(get_admin_user)):
    return _ok(ps.activity_feed(partner_id or None))


def _get_partner_or_404(partner_id: str) -> dict:
    try:
        row = supabase.table("referral_partners").select("*").eq("id", partner_id).maybe_single().execute().data
    except Exception:  # a malformed uuid makes Postgres raise
        row = None
    if not row:
        raise HTTPException(404, "Partner not found.")
    return row


@admin_router.get("/{partner_id}")
def get_partner(partner_id: str, admin=Depends(get_admin_user)):
    p = _get_partner_or_404(partner_id)
    data = _partner_view(p, ps.partner_totals([p])[str(p["id"])])
    data["signups"] = ps.partner_signups(str(p["id"]))
    data["payouts"] = ps.list_payouts(str(p["id"]))
    return _ok(data)


@admin_router.patch("/{partner_id}")
def update_partner(partner_id: str, body: PartnerUpdate, admin=Depends(get_admin_user)):
    p = _get_partner_or_404(partner_id)
    updates: dict = {}
    if body.name is not None:
        if not body.name.strip():
            raise HTTPException(400, "The name cannot be empty.")
        updates["name"] = body.name.strip()
    if body.notes is not None:
        updates["notes"] = body.notes.strip() or None
    if body.status is not None:
        if body.status not in STATUSES:
            raise HTTPException(400, "Status must be 'active' or 'paused'.")
        updates["status"] = body.status
    if body.commission_type is not None or body.commission_value is not None:
        ctype, cvalue = _clean_commission(
            body.commission_type if body.commission_type is not None else p["commission_type"],
            body.commission_value if body.commission_value is not None else p["commission_value"])
        updates["commission_type"], updates["commission_value"] = ctype, cvalue
    if updates:
        p = supabase.table("referral_partners").update(updates).eq("id", partner_id).execute().data[0]
        logger.warning("REFERRAL PARTNER updated: admin=%s partner=%s %s", admin.get("username"), partner_id, sorted(updates))
    return _ok(_partner_view(p, ps.partner_totals([p])[str(p["id"])]))


# ── payments to a partner (the ledger behind "paid" and "still owed") ──

class PayoutCreate(BaseModel):
    """POST /admin/partners/{id}/payouts. `paid_on` defaults to today."""
    amount: float
    paid_on: Optional[date] = None
    method: Optional[str] = None
    reference: Optional[str] = None
    note: Optional[str] = None


class PayoutUpdate(BaseModel):
    """PATCH: only the descriptive fields sent are changed (the amount and date are fixed once recorded)."""
    method: Optional[str] = None
    reference: Optional[str] = None
    note: Optional[str] = None


class PayoutVoid(BaseModel):
    reason: str


_TEXT_LIMITS = {"method": 40, "reference": 120, "note": 500}


def _admin_name(admin: dict) -> str:
    return str(admin.get("username") or admin.get("sub") or "admin")[:80]


def _clean_text(field: str, value: Optional[str]) -> Optional[str]:
    v = (value or "").strip()
    if len(v) > _TEXT_LIMITS[field]:
        raise HTTPException(400, f"The {field} can be at most {_TEXT_LIMITS[field]} characters.")
    return v or None


def _payout_id_or_404(payout_id: str) -> str:
    try:
        return str(uuid.UUID(payout_id))
    except ValueError:
        raise HTTPException(404, "Payment not found.")


def _payout_call(fn, *args):
    """Runs a ledger operation and maps its refusals to HTTP errors (400 for a refused payment, 404 for a missing one)."""
    try:
        return fn(*args)
    except ps.PayoutNotFound as e:
        raise HTTPException(404, str(e))
    except ps.PayoutError as e:
        raise HTTPException(400, str(e))


@admin_router.get("/{partner_id}/payouts")
def list_partner_payouts(partner_id: str, admin=Depends(get_admin_user)):
    p = _get_partner_or_404(partner_id)
    return _ok({"payouts": ps.list_payouts(str(p["id"])), "totals": ps.partner_totals([p])[str(p["id"])]})


@admin_router.post("/{partner_id}/payouts")
def record_partner_payout(partner_id: str, body: PayoutCreate, admin=Depends(get_admin_user)):
    p = _get_partner_or_404(partner_id)
    if not math.isfinite(body.amount) or body.amount <= 0:
        raise HTTPException(400, "The payment amount must be more than 0.")
    if body.amount > MAX_PAYOUT:
        raise HTTPException(400, f"A single payment cannot be more than ${MAX_PAYOUT:,.0f}.")
    paid_on = body.paid_on or date.today()
    if paid_on > date.today() + timedelta(days=1):  # a day of slack for an admin ahead of the server's timezone
        raise HTTPException(400, "The payment date cannot be in the future.")
    payout = _payout_call(
        ps.record_payout, p, round(body.amount, 2), paid_on, _clean_text("method", body.method),
        _clean_text("reference", body.reference), _clean_text("note", body.note), _admin_name(admin))
    logger.warning("REFERRAL PARTNER payout: admin=%s partner=%s amount=%.2f payout=%s",
                   _admin_name(admin), p["id"], payout["amount"], payout["id"])
    return _ok({"payout": payout, "totals": ps.partner_totals([p])[str(p["id"])]})


@admin_router.patch("/{partner_id}/payouts/{payout_id}")
def update_partner_payout(partner_id: str, payout_id: str, body: PayoutUpdate, admin=Depends(get_admin_user)):
    p = _get_partner_or_404(partner_id)
    fields = {k: _clean_text(k, getattr(body, k)) for k in _TEXT_LIMITS if getattr(body, k) is not None}
    payout = _payout_call(ps.update_payout, str(p["id"]), _payout_id_or_404(payout_id), fields)
    logger.warning("REFERRAL PARTNER payout edited: admin=%s partner=%s payout=%s %s",
                   _admin_name(admin), p["id"], payout["id"], sorted(fields))
    return _ok(payout)


@admin_router.post("/{partner_id}/payouts/{payout_id}/void")
def void_partner_payout(partner_id: str, payout_id: str, body: PayoutVoid, admin=Depends(get_admin_user)):
    p = _get_partner_or_404(partner_id)
    reason = body.reason.strip()
    if len(reason) < 3 or len(reason) > 300:
        raise HTTPException(400, "Give a reason for voiding the payment (3 to 300 characters).")
    payout = _payout_call(ps.void_payout, str(p["id"]), _payout_id_or_404(payout_id), reason, _admin_name(admin))
    logger.warning("REFERRAL PARTNER payout voided: admin=%s partner=%s payout=%s reason=%r",
                   _admin_name(admin), p["id"], payout["id"], reason)
    return _ok({"payout": payout, "totals": ps.partner_totals([p])[str(p["id"])]})


# ───────────────────────────── the partner's own side ─────────────────────────────

def _my_partner(user: dict) -> dict:
    """The caller's partner row, or 403. Every /partner route (but /me) goes through this, which is what scopes
    a partner to their own referrals."""
    row = supabase.table("referral_partners").select("*").eq("user_id", user["user_id"]).maybe_single().execute().data
    if not row:
        raise HTTPException(403, "This account is not a referral partner.")
    return row


@router.get("/me")
def partner_me(user=Depends(get_current_user)):
    row = supabase.table("referral_partners").select("*").eq("user_id", user["user_id"]).maybe_single().execute().data
    return _ok({"is_partner": bool(row), "partner": _partner_view(row, admin=False) if row else None})


@router.get("/overview")
def partner_overview(user=Depends(get_current_user)):
    p = _my_partner(user)
    t = ps.partner_totals([p])[str(p["id"])]
    signups = [{k: v for k, v in s.items() if k not in _PARTNER_HIDDEN} for s in ps.partner_signups(str(p["id"]))]
    data = _partner_view(p, admin=False)
    # What a partner sees: how many people, what those people were billed, and what they earned. Never the
    # platform's cost, the profit or the platform's net.
    data["totals"] = {k: t[k] for k in ("signups", "verified", "calls", "billed", "commission", "paid", "owed")}
    data["signups"] = signups
    data["payouts"] = [{k: x[k] for k in _PARTNER_PAYOUT_FIELDS} for x in ps.list_payouts(str(p["id"]), include_void=False)]
    return _ok(data)


@router.get("/activity")
def partner_activity(user=Depends(get_current_user)):
    p = _my_partner(user)
    return _ok(ps.activity_feed(str(p["id"])))


@router.post("/users/{user_id}/impersonate")
def partner_impersonate(user_id: str, user=Depends(get_current_user)):
    """A 2h "view as" token for an account the caller referred (same token shape as the admin flow, tagged imp_by =
    the partner). 404 for anyone else's user, 403 while the partner is paused. Every use is logged."""
    p = _my_partner(user)
    if p["status"] != "active":
        raise HTTPException(403, "Your partner account is paused.")
    try:
        link = (supabase.table("partner_referrals").select("user_id").eq("partner_id", p["id"])
                .eq("user_id", user_id).maybe_single().execute().data)
    except Exception:
        link = None
    if not link:
        raise HTTPException(404, "That user did not sign up through your link.")
    target = supabase.table("users").select("id, email").eq("id", user_id).maybe_single().execute().data
    if not target:
        raise HTTPException(404, "User not found.")

    from routers.auth import _issue_token
    token = _issue_token(
        user_id, target["email"], ttl_seconds=60 * 60 * 2,
        extra_claims={"imp": True, "imp_by": p["email"], "imp_partner": str(p["id"])})
    logger.warning("PARTNER IMPERSONATION: partner=%s (%s) issued a session for user=%s (%s)",
                   p["id"], p["email"], user_id, target["email"])
    return _ok({"access_token": token, "token_type": "bearer", "user": {"id": user_id, "email": target["email"]}})
