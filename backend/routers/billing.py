import logging
import stripe
from fastapi import APIRouter, Depends, HTTPException, Query
from dependencies import get_current_user
from database import supabase
from config import settings
from pydantic import BaseModel
from typing import Optional
from datetime import datetime, timezone

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/billing", tags=["Billing"])


def _app_base() -> str:
    """Frontend base URL for Stripe redirects — the deployed app URL, or localhost in dev.
    The frontend also passes its own window.location.origin, so this is a fallback."""
    return (settings.public_app_url or "http://localhost:8080").rstrip("/")

stripe.api_key = settings.stripe_secret_key

PLANS = [
    {
        "id": "payg",
        "name": "Pay As You Go",
        "price": 0,
        "price_display": "$0.10/min",
        "description": "Only pay for what you use",
        "outbound_limit": 999999,
        "inbound_limit": 999999,
        "agents_limit": 10,
        "rate_per_minute": 0.10,
        "features": [
            "Unlimited calls",
            "$0.10 per minute",
            "Up to 10 AI Agents",
            "Pay only for usage",
            "No monthly commitment",
        ],
    },
    {
        "id": "starter",
        "name": "Starter",
        "price": 2500,
        "price_display": "$25/mo",
        "description": "For small teams getting started",
        "outbound_limit": 100,
        "inbound_limit": 200,
        "agents_limit": 25,
        "rate_per_minute": 0.10,
        "features": [
            "100 outbound calls/mo",
            "200 inbound calls/mo",
            "Up to 25 AI Agents",
            "$0.10 per minute",
            "Email support",
        ],
    },
    {
        "id": "growth",
        "name": "Growth",
        "price": 5000,
        "price_display": "$50/mo",
        "description": "For growing businesses",
        "outbound_limit": 300,
        "inbound_limit": 500,
        "agents_limit": 50,
        "rate_per_minute": 0.10,
        "features": [
            "300 outbound calls/mo",
            "500 inbound calls/mo",
            "Up to 50 AI Agents",
            "$0.10 per minute",
            "Priority support",
        ],
        "popular": True,
    },
    {
        "id": "business",
        "name": "Business",
        "price": 10000,
        "price_display": "$100/mo",
        "description": "For large-scale operations",
        "outbound_limit": 500,
        "inbound_limit": 700,
        "agents_limit": 100,
        "rate_per_minute": 0.10,
        "features": [
            "500 outbound calls/mo",
            "700 inbound calls/mo",
            "Up to 100 AI Agents",
            "$0.10 per minute",
            "Dedicated account manager",
        ],
    },
]

DEFAULT_RATE_PER_MINUTE = 0.10

# Monthly cost charged to the client for each Twilio phone number they provision.
PHONE_NUMBER_MONTHLY_COST = 3.00

FREE_TIER = {
    "agents_limit": 10,
    "outbound_limit": 5,
    "inbound_limit": 5,
}


def get_plan_by_id(plan_id: str) -> dict | None:
    return next((p for p in PLANS if p["id"] == plan_id), None)


def get_or_create_billing(user_id: str) -> dict:
    result = supabase.table("billing").select("*").eq("user_id", user_id).execute()
    if result.data:
        return result.data[0]

    row = {
        "user_id": user_id,
        "plan": "free",
        "status": "trial",
        "agents_limit": FREE_TIER["agents_limit"],
        "outbound_limit": FREE_TIER["outbound_limit"],
        "inbound_limit": FREE_TIER["inbound_limit"],
        "outbound_used": 0,
        "inbound_used": 0,
        "credits": 0,
        "rate_per_minute": DEFAULT_RATE_PER_MINUTE,
        "is_active": True,
    }
    insert = supabase.table("billing").insert(row).execute()
    return insert.data[0] if insert.data else row


def add_charge(user_id: str, amount: float, note: str | None = None) -> float:
    """Add a one-off charge (e.g. a phone-number monthly fee) to the user's running total."""
    if not amount or amount <= 0:
        return 0.0
    billing = get_or_create_billing(user_id)
    current_charges = float(billing.get("total_charges") or 0)
    new_total = round(current_charges + float(amount), 2)
    supabase.table("billing").update({"total_charges": new_total}).eq("user_id", user_id).execute()
    return new_total


# ── Wallet / prepaid balance ──

def get_balance(user_id: str) -> float:
    billing = get_or_create_billing(user_id)
    return float(billing.get("balance") or 0)


def has_balance(user_id: str, min_amount: float) -> bool:
    return get_balance(user_id) >= float(min_amount)


def _record_wallet_txn(user_id, kind, amount, balance_after, description,
                       stripe_session_id=None, ref_id=None):
    try:
        supabase.table("wallet_transactions").insert({
            "user_id": user_id,
            "kind": kind,
            "amount": round(float(amount), 2),
            "balance_after": round(float(balance_after), 2),
            "description": description,
            "stripe_session_id": stripe_session_id,
            "ref_id": ref_id,
        }).execute()
    except Exception:
        pass


def credit_balance(user_id, amount, kind, description,
                   stripe_session_id=None, ref_id=None) -> float:
    """Add funds to the wallet. Idempotent on stripe_session_id (no double-credit)."""
    amount = float(amount or 0)
    if amount <= 0:
        return get_balance(user_id)
    if stripe_session_id:
        existing = (
            supabase.table("wallet_transactions")
            .select("id").eq("stripe_session_id", stripe_session_id).execute()
        )
        if existing.data:
            return get_balance(user_id)
    billing = get_or_create_billing(user_id)
    new_balance = round(float(billing.get("balance") or 0) + amount, 2)
    supabase.table("billing").update({"balance": new_balance}).eq("user_id", user_id).execute()
    _record_wallet_txn(user_id, kind, amount, new_balance, description, stripe_session_id, ref_id)
    return new_balance


def debit_balance(user_id, amount, kind, description, ref_id=None) -> float:
    """Deduct from the wallet (records a negative-amount ledger entry)."""
    amount = round(float(amount or 0), 2)  # charge whole cents so ledger == balance delta
    if amount <= 0:
        return get_balance(user_id)
    billing = get_or_create_billing(user_id)
    new_balance = round(float(billing.get("balance") or 0) - amount, 2)
    supabase.table("billing").update({"balance": new_balance}).eq("user_id", user_id).execute()
    _record_wallet_txn(user_id, kind, -amount, new_balance, description, None, ref_id)
    return new_balance


def check_call_quota(user_id: str, direction: str) -> bool:
    billing = get_or_create_billing(user_id)
    if not billing.get("is_active", True):
        return False

    # Prepaid wallet: placing an outbound call requires a positive balance
    # (the exact per-minute cost is metered and debited when the call ends).
    if direction == "outbound" and float(billing.get("balance") or 0) <= 0:
        return False

    if direction == "outbound":
        limit = (billing.get("outbound_limit") or 0) + (billing.get("credits") or 0)
        used = billing.get("outbound_used") or 0
    else:
        limit = (billing.get("inbound_limit") or 0) + (billing.get("credits") or 0)
        used = billing.get("inbound_used") or 0

    return used < limit


def check_agent_quota(user_id: str) -> bool:
    billing = get_or_create_billing(user_id)
    if not billing.get("is_active", True):
        return False

    agents_limit = billing.get("agents_limit") or FREE_TIER["agents_limit"]
    agent_count = (
        supabase.table("ai_agents")
        .select("id", count="exact")
        .eq("user_id", user_id)
        .execute()
    )
    return (agent_count.count or 0) < agents_limit


def increment_usage(user_id: str, direction: str):
    billing = get_or_create_billing(user_id)
    field = "outbound_used" if direction == "outbound" else "inbound_used"
    current = billing.get(field) or 0
    supabase.table("billing").update({field: current + 1}).eq("user_id", user_id).execute()


def calculate_call_cost(user_id: str, duration_seconds: int) -> float:
    billing = get_or_create_billing(user_id)
    rate = billing.get("rate_per_minute") or DEFAULT_RATE_PER_MINUTE
    duration_minutes = duration_seconds / 60.0
    # Bill in whole cents so the per-call cost, the breakdown total, the wallet
    # debit and the balance all reconcile exactly (no sub-cent drift).
    cost = round(duration_minutes * float(rate), 2)
    return cost


def _call_already_charged(vapi_call_id: str) -> bool:
    """A call is charged at most once — guard against re-billing on re-sync/re-import.
    The wallet ledger (kind='call', ref_id=vapi_call_id) is the source of truth."""
    if not vapi_call_id:
        return True
    existing = (
        supabase.table("wallet_transactions")
        .select("id")
        .eq("ref_id", vapi_call_id)
        .eq("kind", "call")
        .limit(1)
        .execute()
        .data
    )
    return bool(existing)


def record_call_cost(user_id: str, vapi_call_id: str, duration_seconds: int) -> float:
    """Compute the call's cost, store it on the conversation (for the Cost Breakdown),
    and debit the wallet — the debit happens exactly once per call (idempotent by the
    ledger), so both the webhook and the background sync can call this freely."""
    cost = calculate_call_cost(user_id, duration_seconds)

    # Always keep the row's displayed cost + duration in sync (even on re-import).
    supabase.table("conversations").update({
        "duration_seconds": duration_seconds,
        "call_cost": cost,
    }).eq("vapi_call_id", vapi_call_id).execute()

    # Charge the wallet once per call.
    if cost > 0 and not _call_already_charged(vapi_call_id):
        billing = get_or_create_billing(user_id)
        current_charges = float(billing.get("total_charges") or 0)
        supabase.table("billing").update({
            "total_charges": round(current_charges + cost, 2),
        }).eq("user_id", user_id).execute()
        debit_balance(user_id, cost, "call", "Call charge", ref_id=vapi_call_id)
    return cost


class CheckoutRequest(BaseModel):
    plan_id: str
    success_url: Optional[str] = None
    cancel_url: Optional[str] = None


@router.get("/plans")
async def get_plans():
    public_plans = []
    for p in PLANS:
        public_plans.append({
            "id": p["id"],
            "name": p["name"],
            "price": p["price"],
            "price_display": p["price_display"],
            "description": p["description"],
            "features": p["features"],
            "popular": p.get("popular", False),
            "outbound_limit": p["outbound_limit"],
            "inbound_limit": p["inbound_limit"],
            "agents_limit": p["agents_limit"],
            "rate_per_minute": p.get("rate_per_minute", DEFAULT_RATE_PER_MINUTE),
        })
    return {"data": public_plans, "error": None}


@router.get("/status")
async def get_billing_status(user=Depends(get_current_user)):
    billing = get_or_create_billing(user["user_id"])

    agent_count = (
        supabase.table("ai_agents")
        .select("id", count="exact")
        .eq("user_id", user["user_id"])
        .execute()
    )

    return {
        "data": {
            **billing,
            "agents_used": agent_count.count or 0,
        },
        "error": None,
    }


@router.get("/usage")
async def get_usage(user=Depends(get_current_user)):
    billing = get_or_create_billing(user["user_id"])
    agent_count = (
        supabase.table("ai_agents")
        .select("id", count="exact")
        .eq("user_id", user["user_id"])
        .execute()
    )
    return {
        "data": {
            "outbound_used": billing.get("outbound_used", 0),
            "outbound_limit": billing.get("outbound_limit", 0),
            "inbound_used": billing.get("inbound_used", 0),
            "inbound_limit": billing.get("inbound_limit", 0),
            "agents_used": agent_count.count or 0,
            "agents_limit": billing.get("agents_limit", FREE_TIER["agents_limit"]),
            "credits": billing.get("credits", 0),
            "plan": billing.get("plan", "free"),
            "is_active": billing.get("is_active", True),
            "rate_per_minute": float(billing.get("rate_per_minute") or DEFAULT_RATE_PER_MINUTE),
            "total_charges": float(billing.get("total_charges") or 0),
            "balance": float(billing.get("balance") or 0),
        },
        "error": None,
    }


@router.get("/invoices")
async def get_invoices(user=Depends(get_current_user)):
    if not settings.stripe_secret_key:
        return {"data": [], "error": None}

    billing_res = supabase.table("billing").select("stripe_customer_id").eq("user_id", user["user_id"]).execute()
    billing_row = billing_res.data[0] if billing_res.data else None
    if not billing_row or not billing_row.get("stripe_customer_id"):
        return {"data": [], "error": None}

    try:
        invoices = stripe.Invoice.list(
            customer=billing_row["stripe_customer_id"],
            limit=20,
        )
        items = [
            {
                "id": inv.id,
                "amount": inv.amount_paid,
                "currency": inv.currency,
                "status": inv.status,
                "created": inv.created,
                "invoice_url": inv.hosted_invoice_url,
                "pdf": inv.invoice_pdf,
            }
            for inv in invoices.data
        ]
        return {"data": items, "error": None}
    except Exception as e:
        return {"data": [], "error": str(e)}


@router.post("/checkout")
async def create_checkout(body: CheckoutRequest, user=Depends(get_current_user)):
    if not settings.stripe_secret_key:
        raise HTTPException(status_code=503, detail="Stripe not configured")

    plan = get_plan_by_id(body.plan_id)
    if not plan:
        raise HTTPException(status_code=400, detail="Invalid plan")

    billing = get_or_create_billing(user["user_id"])
    customer_id = billing.get("stripe_customer_id")

    if not customer_id:
        profile_res = supabase.table("profiles").select("full_name").eq("id", user["user_id"]).execute()
        profile_row = profile_res.data[0] if profile_res.data else None
        email = user.get("email")
        name = profile_row.get("full_name") if profile_row else None

        try:
            customer = stripe.Customer.create(
                email=email,
                name=name,
                metadata={"user_id": user["user_id"]},
            )
            customer_id = customer.id
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Stripe error: {str(e)}")

        supabase.table("billing").update(
            {"stripe_customer_id": customer_id}
        ).eq("user_id", user["user_id"]).execute()

    success_url = body.success_url or f"{_app_base()}/dashboard/billing?success=true"
    cancel_url = body.cancel_url or f"{_app_base()}/dashboard/billing?canceled=true"

    try:
        session = stripe.checkout.Session.create(
            customer=customer_id,
            payment_method_types=["card"],
            line_items=[{
                "price_data": {
                    "currency": "usd",
                    "product_data": {
                        "name": f"EDM Nexus — {plan['name']} Plan",
                        "description": plan["description"],
                    },
                    "unit_amount": plan["price"],
                    "recurring": {"interval": "month"},
                },
                "quantity": 1,
            }],
            mode="subscription",
            success_url=success_url,
            cancel_url=cancel_url,
            metadata={
                "user_id": user["user_id"],
                "plan_id": plan["id"],
            },
        )
        return {"data": {"checkout_url": session.url, "session_id": session.id}, "error": None}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Stripe checkout error: {str(e)}")


@router.post("/portal")
async def create_portal_session(user=Depends(get_current_user)):
    if not settings.stripe_secret_key:
        raise HTTPException(status_code=503, detail="Stripe not configured")

    billing_res = supabase.table("billing").select("stripe_customer_id").eq("user_id", user["user_id"]).execute()
    billing_row = billing_res.data[0] if billing_res.data else None
    if not billing_row or not billing_row.get("stripe_customer_id"):
        raise HTTPException(status_code=400, detail="No billing account found. Subscribe to a plan first.")

    try:
        session = stripe.billing_portal.Session.create(
            customer=billing_row["stripe_customer_id"],
            return_url="http://localhost:8082/dashboard/billing",
        )
        return {"data": {"portal_url": session.url}, "error": None}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Stripe portal error: {str(e)}")


class TopupRequest(BaseModel):
    amount: float
    success_url: Optional[str] = None
    cancel_url: Optional[str] = None


TOPUP_MIN = 10.0
TOPUP_MAX = 1000.0
_BILLING_BASE_URL = f"{_app_base()}/dashboard/billing"


def _get_or_create_stripe_customer(user) -> str:
    billing = get_or_create_billing(user["user_id"])
    customer_id = billing.get("stripe_customer_id")
    if customer_id:
        return customer_id
    customer = stripe.Customer.create(email=user.get("email"), metadata={"user_id": user["user_id"]})
    supabase.table("billing").update({"stripe_customer_id": customer.id}).eq("user_id", user["user_id"]).execute()
    return customer.id


@router.post("/topup/checkout")
async def topup_checkout(body: TopupRequest, user=Depends(get_current_user)):
    """Create a Stripe Checkout session to load funds into the wallet balance."""
    if not settings.stripe_secret_key:
        raise HTTPException(status_code=503, detail="Stripe not configured")
    amount = round(float(body.amount or 0), 2)
    if amount < TOPUP_MIN or amount > TOPUP_MAX:
        raise HTTPException(status_code=400, detail=f"Amount must be between ${TOPUP_MIN:.0f} and ${TOPUP_MAX:.0f}")

    try:
        customer_id = _get_or_create_stripe_customer(user)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Stripe error: {str(e)}")

    base = body.success_url or _BILLING_BASE_URL
    success_url = f"{base}?topup=success&session_id={{CHECKOUT_SESSION_ID}}"
    cancel_url = (body.cancel_url or _BILLING_BASE_URL) + "?topup=canceled"
    try:
        session = stripe.checkout.Session.create(
            customer=customer_id,
            payment_method_types=["card"],
            mode="payment",
            line_items=[{
                "price_data": {
                    "currency": "usd",
                    "product_data": {"name": "EDM Nexus — Account Balance", "description": "Add funds to your wallet"},
                    "unit_amount": int(round(amount * 100)),
                },
                "quantity": 1,
            }],
            success_url=success_url,
            cancel_url=cancel_url,
            metadata={"type": "wallet_topup", "user_id": user["user_id"], "amount": f"{amount:.2f}"},
        )
        return {"data": {"checkout_url": session.url, "session_id": session.id}, "error": None}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Stripe checkout error: {str(e)}")


class TopupConfirm(BaseModel):
    session_id: str


@router.post("/topup/confirm")
async def topup_confirm(body: TopupConfirm, user=Depends(get_current_user)):
    """Called when the user returns from Stripe. Verify payment, then credit the wallet."""
    if not settings.stripe_secret_key:
        raise HTTPException(status_code=503, detail="Stripe not configured")
    try:
        session = stripe.checkout.Session.retrieve(body.session_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Stripe error: {str(e)}")

    # Stripe SDK objects: attribute access + .to_dict() (dict() / .get() don't work).
    meta = session.metadata.to_dict() if session.metadata is not None else {}
    # Ownership: the session belongs to this user if its metadata user_id matches,
    # OR the session's Stripe customer is this user's own customer (the checkout was
    # created with customer=<their customer>). The customer match is the robust proof;
    # metadata is a fallback. Credit only ever goes to the authenticated user, and is
    # idempotent per session_id, so this can't be abused to credit someone else.
    billing = get_or_create_billing(user["user_id"])
    session_customer = getattr(session, "customer", None)
    owns = (
        meta.get("user_id") == user["user_id"]
        or (session_customer and session_customer == billing.get("stripe_customer_id"))
    )
    if not owns:
        logger.warning(
            "topup_confirm ownership mismatch: session=%s meta_user=%s current_user=%s "
            "session_customer=%s billing_customer=%s",
            body.session_id, meta.get("user_id"), user["user_id"],
            session_customer, billing.get("stripe_customer_id"),
        )
        raise HTTPException(status_code=403, detail="This checkout session does not belong to you")
    if session.payment_status != "paid":
        raise HTTPException(status_code=402, detail="Payment not completed")

    amount = float(meta.get("amount") or 0)
    new_balance = credit_balance(
        user["user_id"], amount, "topup",
        f"Added ${amount:.2f} to balance", stripe_session_id=body.session_id,
    )
    return {"data": {"balance": new_balance, "added": amount}, "error": None}


@router.get("/transactions")
async def list_transactions(user=Depends(get_current_user), include_calls: bool = Query(False)):
    """Wallet ledger for the Purchase History. Excludes per-call charges by default
    (those live in the Call Cost Breakdown); pass ?include_calls=true for the full ledger."""
    query = (
        supabase.table("wallet_transactions")
        .select("id, kind, amount, balance_after, description, created_at")
        .eq("user_id", user["user_id"])
    )
    if not include_calls:
        query = query.neq("kind", "call")
    result = query.order("created_at", desc=True).limit(50).execute()
    return {"data": result.data or [], "error": None}


class SubscribeBalance(BaseModel):
    plan_id: str


@router.post("/subscribe-with-balance")
async def subscribe_with_balance(body: SubscribeBalance, user=Depends(get_current_user)):
    """Activate a plan by paying its monthly price from the wallet balance."""
    plan = get_plan_by_id(body.plan_id)
    if not plan:
        raise HTTPException(status_code=400, detail="Invalid plan")
    price = round(float(plan["price"]) / 100.0, 2)  # plan["price"] is in cents

    # Paid plans are charged to the wallet; $0 plans (e.g. Pay As You Go) activate free.
    if price > 0:
        if not has_balance(user["user_id"], price):
            raise HTTPException(
                status_code=402,
                detail=f"Insufficient balance. This plan costs ${price:.2f}/mo — add funds first.",
            )
        debit_balance(user["user_id"], price, "plan", f"{plan['name']} plan (1 month)")
    supabase.table("billing").update({
        "plan": plan["id"],
        "status": "active",
        "outbound_limit": plan["outbound_limit"],
        "inbound_limit": plan["inbound_limit"],
        "agents_limit": plan["agents_limit"],
        "rate_per_minute": plan.get("rate_per_minute", DEFAULT_RATE_PER_MINUTE),
        "outbound_used": 0,
        "inbound_used": 0,
    }).eq("user_id", user["user_id"]).execute()

    return {"data": {"plan": plan["id"], "balance": get_balance(user["user_id"])}, "error": None}


@router.get("/call-costs")
async def get_call_costs(user=Depends(get_current_user)):
    result = (
        supabase.table("conversations")
        # NB: the conversations table timestamps calls in `call_time`, not `created_at`.
        .select("id, vapi_call_id, direction, phone, contact_name, duration, duration_seconds, call_cost, status, call_time")
        .eq("user_id", user["user_id"])
        .order("call_time", desc=True)
        .limit(50)
        .execute()
    )
    calls = result.data or []
    # Exclude seeded demo/sample rows so the breakdown only reflects real calls.
    calls = [c for c in calls if not str(c.get("contact_name") or "").startswith("[SAMPLE]")]
    for c in calls:
        c["created_at"] = c.get("call_time")  # the UI reads `created_at`
    total_cost = sum(float(c.get("call_cost") or 0) for c in calls)
    total_minutes = sum(int(c.get("duration_seconds") or 0) for c in calls) / 60.0
    return {
        "data": {
            "calls": calls,
            "total_cost": round(total_cost, 2),
            "total_minutes": round(total_minutes, 1),
        },
        "error": None,
    }
