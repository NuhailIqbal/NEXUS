import logging
import stripe
from fastapi import APIRouter, Depends, HTTPException, Query
from dependencies import get_current_user
from database import supabase
from config import settings
from pydantic import BaseModel
from typing import Optional
from datetime import datetime, timezone, timedelta

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/billing", tags=["Billing"])


def _app_base() -> str:
    """Frontend base URL for Stripe redirects — the deployed app URL, or localhost in dev.
    The frontend also passes its own window.location.origin, so this is a fallback."""
    return (settings.public_app_url or "http://localhost:8080").rstrip("/")

stripe.api_key = settings.stripe_secret_key

# Cost-plus pricing, flat for every account: each call is charged at (VAPI cost + est.
# Twilio carrier leg) × DEFAULT_COST_MULTIPLIER. DEFAULT_RATE_PER_MINUTE is the
# advertised/estimated per-minute rate and the fallback when a call is missing
# provider-cost data. An admin can still override an individual account's rate/
# multiplier directly on its billing row for negotiated custom pricing.
DEFAULT_RATE_PER_MINUTE = 0.35
DEFAULT_COST_MULTIPLIER = 3.00

# Monthly cost charged to the client for each Twilio phone number they provision.
PHONE_NUMBER_MONTHLY_COST = 3.00


def get_or_create_billing(user_id: str) -> dict:
    result = supabase.table("billing").select("*").eq("user_id", user_id).execute()
    if result.data:
        return result.data[0]

    # Prepaid wallet, no plans/tiers: outbound calls are gated on a positive balance,
    # so there's no free-usage loophole.
    row = {
        "user_id": user_id,
        "status": "active",
        "rate_per_minute": DEFAULT_RATE_PER_MINUTE,
        "cost_multiplier": DEFAULT_COST_MULTIPLIER,
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


# ── Wallet / prepaid balance (credit-grants ledger) ──
# Money is held as typed "grants" (lots) in `credit_grants`. Spending consumes them
# in priority + soonest-expiry order: promo -> purchased -> subscription, skipping
# expired/exhausted lots. `billing.balance` is a cached live sum of active `remaining`.

_GRANT_PRIORITY = {"promo": 0, "purchased": 1, "subscription": 2}
# Ledger kind -> grant type when a grant type isn't given explicitly.
# NB: `promo_code` (a redeemed code) is deliberately a SEPARATE ledger kind from `promo`
# (the automatic signup welcome bonus) — _has_promo_credit() gates the welcome bonus on
# kind == "promo", so reusing that kind here would permanently block it. Both map to the
# same `promo` GRANT type so they're spent first and can expire.
_KIND_TO_GRANT = {"promo": "promo", "promo_code": "promo", "topup": "purchased",
                  "admin": "purchased", "refund": "purchased", "subscription": "subscription"}


def _parse_ts(s):
    if isinstance(s, datetime):
        return s if s.tzinfo else s.replace(tzinfo=timezone.utc)
    try:
        d = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except Exception:
        return datetime.max.replace(tzinfo=timezone.utc)


def _active_grants(user_id: str) -> list[dict]:
    """Non-expired grants with remaining > 0, ordered for consumption:
    priority (promo->purchased->subscription), then soonest expiry, then oldest."""
    rows = (
        supabase.table("credit_grants")
        .select("id, type, amount, remaining, expires_at, created_at")
        .eq("user_id", user_id)
        .execute().data or []
    )
    now = datetime.now(timezone.utc)
    active = []
    for g in rows:
        if float(g.get("remaining") or 0) <= 0:
            continue
        exp = g.get("expires_at")
        if exp and _parse_ts(exp) <= now:
            continue  # expired
        active.append(g)
    active.sort(key=lambda g: (
        _GRANT_PRIORITY.get(g.get("type"), 9),
        _parse_ts(g["expires_at"]).timestamp() if g.get("expires_at") else float("inf"),
        str(g.get("created_at") or ""),
    ))
    return active


def _sync_cached_balance(user_id: str) -> float:
    """Recompute billing.balance from active grants (updates the cache if changed)."""
    billing = get_or_create_billing(user_id)
    total = round(sum(float(g["remaining"]) for g in _active_grants(user_id)), 2)
    if round(float(billing.get("balance") or 0), 2) != total:
        supabase.table("billing").update({"balance": total}).eq("user_id", user_id).execute()
    return total


def get_balance(user_id: str) -> float:
    return _sync_cached_balance(user_id)


def has_balance(user_id: str, min_amount: float) -> bool:
    return get_balance(user_id) >= float(min_amount)


def _insert_notification(user_id, kind, title, body):
    try:
        supabase.table("notifications").insert(
            {"user_id": user_id, "kind": kind, "title": title, "body": body}
        ).execute()
    except Exception:
        pass


_LOW_BALANCE_MSGS = {
    10: ("Low balance — $10 left",
         "You have about $10 in credit remaining. Add funds to avoid interruption."),
    5:  ("Low balance — $5 left",
         "You have about $5 in credit remaining. Add funds to keep your calls running."),
    1:  ("Low balance — $1 left",
         "You have only $1 remaining. Add a payment method to continue using our services without interruption."),
    0:  ("Balance empty",
         "Your credit is used up. Add funds to keep making calls."),
}


def _notify_low_balance(user_id, old_balance, new_balance):
    """Fire a one-time alert for each $10/$5/$1/$0 threshold crossed downward, deduped
    per funding cycle (no repeat until the balance is topped up again)."""
    crossed = [t for t in (10, 5, 1, 0) if old_balance > t >= new_balance]
    if not crossed:
        return
    last_credit = (
        supabase.table("wallet_transactions").select("created_at")
        .eq("user_id", user_id).gt("amount", 0)
        .order("created_at", desc=True).limit(1).execute().data
    )
    since = last_credit[0]["created_at"] if last_credit else None
    for t in crossed:
        kind = f"low_balance_{t}"
        q = supabase.table("notifications").select("id").eq("user_id", user_id).eq("kind", kind)
        if since:
            q = q.gt("created_at", since)
        if q.limit(1).execute().data:
            continue  # already alerted since the last top-up
        title, body = _LOW_BALANCE_MSGS[t]
        _insert_notification(user_id, kind, title, body)


def _sync_inbound_routing(user_id: str, block: bool) -> None:
    """Fire-and-forget: suspend/restore this user's inbound numbers to/from the
    fallback assistant as their balance crosses to/from $0. Local import avoids a
    circular import (telephony.py already imports from this module)."""
    try:
        import asyncio
        from routers.telephony import sync_inbound_routing_for_balance
        asyncio.create_task(sync_inbound_routing_for_balance(user_id, block))
    except RuntimeError:
        pass  # no running event loop (e.g. called from a script) — skip, non-critical
    except Exception:
        logger.exception("Failed to schedule inbound routing sync for user %s", user_id)


# ── Auto-recharge (off-session top-up from the saved default card) ──
# Charges the customer's default card without them present when the balance falls to or
# below their threshold. Every guard below matters: this moves real money unattended.

AUTO_RECHARGE_PENDING_TTL_MINUTES = 15


def get_default_payment_method(customer_id: str) -> str | None:
    """The customer's default card, per Stripe's invoice_settings (our source of truth)."""
    try:
        customer = stripe.Customer.retrieve(customer_id)
        settings_obj = getattr(customer, "invoice_settings", None)
        pm = getattr(settings_obj, "default_payment_method", None) if settings_obj else None
        if pm:
            return pm if isinstance(pm, str) else getattr(pm, "id", None)
        # No explicit default — fall back to the only saved card, if there is exactly one.
        cards = stripe.Customer.list_payment_methods(customer_id, type="card", limit=2)
        data = getattr(cards, "data", []) or []
        return data[0].id if len(data) == 1 else None
    except Exception:
        logger.exception("Failed to resolve default payment method for %s", customer_id)
        return None


def credit_auto_recharge(user_id: str, payment_intent_id: str, amount: float) -> None:
    """Credit an auto-recharge payment. Idempotent: passing the PaymentIntent id as
    stripe_session_id means the synchronous path and the webhook can't double-credit
    (wallet_transactions has a partial unique index on that column)."""
    credit_balance(
        user_id, amount, "topup",
        f"Auto recharge — added ${amount:.2f}",
        stripe_session_id=payment_intent_id,
    )
    supabase.table("billing").update(
        {"auto_recharge_pending_at": None}
    ).eq("user_id", user_id).execute()


def _run_auto_recharge(user_id: str) -> None:
    """Attempt one off-session charge. Runs in a thread (never blocks call billing) and
    swallows every failure — a Stripe problem must not break the debit that triggered it."""
    try:
        billing = get_or_create_billing(user_id)
        amount = round(float(billing.get("auto_recharge_amount") or 0), 2)
        if amount < TOPUP_MIN:
            logger.warning("auto-recharge for %s skipped: amount %.2f below minimum", user_id, amount)
            return

        customer_id = billing.get("stripe_customer_id")
        pm_id = get_default_payment_method(customer_id) if customer_id else None
        if not pm_id:
            # Nothing we can charge — tell the user instead of silently doing nothing.
            supabase.table("billing").update(
                {"auto_recharge_pending_at": None}
            ).eq("user_id", user_id).execute()
            _insert_notification(
                user_id, "auto_recharge_no_card",
                "Auto recharge needs a card",
                "Your balance is low but no default payment method is saved. "
                "Add a card under Billing → Payment methods to enable auto recharge.",
            )
            return

        intent = stripe.PaymentIntent.create(
            customer=customer_id,
            amount=int(round(amount * 100)),
            currency="usd",
            payment_method=pm_id,
            off_session=True,
            confirm=True,
            description="EDM Nexus — automatic balance top-up",
            metadata={"type": "auto_recharge", "user_id": user_id, "amount": f"{amount:.2f}"},
        )
        if intent.status == "succeeded":
            credit_auto_recharge(user_id, intent.id, amount)
            _insert_notification(
                user_id, "auto_recharge_ok", "Balance topped up automatically",
                f"We added ${amount:.2f} to your balance using your saved card.",
            )
        # Any other status resolves via the Stripe webhook; leave pending_at set so we
        # don't fire a second charge while this one is still in flight.
    except stripe.error.CardError as e:
        supabase.table("billing").update(
            {"auto_recharge_pending_at": None}
        ).eq("user_id", user_id).execute()
        msg = getattr(e, "user_message", None) or "Your card was declined."
        _insert_notification(
            user_id, "auto_recharge_failed", "Auto recharge failed",
            f"{msg} Add funds manually or update your card under Billing → Payment methods.",
        )
    except Exception:
        supabase.table("billing").update(
            {"auto_recharge_pending_at": None}
        ).eq("user_id", user_id).execute()
        logger.exception("Auto-recharge failed for user %s", user_id)


def _maybe_auto_recharge(user_id: str, billing: dict, new_balance: float) -> None:
    """Decide whether to fire an auto-recharge, then run it off the event loop.
    Claims `auto_recharge_pending_at` FIRST so a burst of concurrent calls each crossing
    the threshold can only trigger one charge."""
    if not billing.get("auto_recharge_enabled"):
        return
    threshold = float(billing.get("auto_recharge_threshold") or 0)
    if new_balance > threshold:
        return

    pending = billing.get("auto_recharge_pending_at")
    if pending:
        age = datetime.now(timezone.utc) - _parse_ts(pending)
        if age < timedelta(minutes=AUTO_RECHARGE_PENDING_TTL_MINUTES):
            return  # a charge is already in flight
    supabase.table("billing").update(
        {"auto_recharge_pending_at": datetime.now(timezone.utc).isoformat()}
    ).eq("user_id", user_id).execute()

    try:
        import asyncio
        asyncio.get_running_loop().run_in_executor(None, _run_auto_recharge, user_id)
    except RuntimeError:
        _run_auto_recharge(user_id)  # no event loop (script/CLI) — just run it inline
    except Exception:
        logger.exception("Failed to schedule auto-recharge for user %s", user_id)


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


def credit_balance(user_id, amount, kind, description, stripe_session_id=None,
                   ref_id=None, grant_type=None, expires_at=None) -> float:
    """Add a credit grant to the wallet. Idempotent on stripe_session_id.
    grant_type defaults from `kind` (promo->promo, topup/admin/refund->purchased,
    subscription->subscription). expires_at is an ISO string or None (never expires)."""
    amount = round(float(amount or 0), 2)
    if amount <= 0:
        return get_balance(user_id)
    if stripe_session_id:
        existing = (
            supabase.table("wallet_transactions")
            .select("id").eq("stripe_session_id", stripe_session_id).execute()
        )
        if existing.data:
            return get_balance(user_id)
    old_balance = _sync_cached_balance(user_id)
    gtype = grant_type or _KIND_TO_GRANT.get(kind, "purchased")
    supabase.table("credit_grants").insert({
        "user_id": user_id, "type": gtype, "amount": amount, "remaining": amount,
        "expires_at": expires_at, "source_ref": ref_id or stripe_session_id,
    }).execute()
    new_balance = _sync_cached_balance(user_id)
    _record_wallet_txn(user_id, kind, amount, new_balance, description, stripe_session_id, ref_id)
    if old_balance <= 0 < new_balance:
        _sync_inbound_routing(user_id, block=False)
    return new_balance


def debit_balance(user_id, amount, kind, description, ref_id=None) -> float:
    """Consume `amount` across active grants (promo -> purchased -> subscription).
    Records the ACTUAL amount debited (balance floors at 0 — never goes negative)."""
    amount = round(float(amount or 0), 2)
    if amount <= 0:
        return get_balance(user_id)
    old_balance = _sync_cached_balance(user_id)
    left = amount
    for g in _active_grants(user_id):
        if left <= 0:
            break
        take = round(min(float(g["remaining"]), left), 2)
        if take <= 0:
            continue
        supabase.table("credit_grants").update(
            {"remaining": round(float(g["remaining"]) - take, 2)}
        ).eq("id", g["id"]).execute()
        left = round(left - take, 2)
    actual = round(amount - left, 2)
    new_balance = _sync_cached_balance(user_id)
    _record_wallet_txn(user_id, kind, -actual, new_balance, description, None, ref_id)
    _notify_low_balance(user_id, old_balance, new_balance)
    if old_balance > 0 >= new_balance:
        _sync_inbound_routing(user_id, block=True)
    # Re-read: the row may have changed (e.g. pending_at) since `old_balance` was taken.
    _maybe_auto_recharge(user_id, get_or_create_billing(user_id), new_balance)
    return new_balance


def check_call_quota(user_id: str, direction: str) -> bool:
    """Prepaid wallet, no plans: placing an outbound call requires a positive balance
    (the exact per-minute cost is metered and debited when the call ends). Inbound
    calls aren't gated — they're billed the same way once they complete."""
    billing = get_or_create_billing(user_id)
    if not billing.get("is_active", True):
        return False
    if direction == "outbound":
        return float(billing.get("balance") or 0) > 0
    return True


def _twilio_leg(duration_seconds: int, direction: str) -> float:
    """Estimated Twilio carrier cost for the call. Numbers are Twilio-bought and
    imported into VAPI, so the PSTN leg is billed by Twilio and is NOT part of
    VAPI's reported per-call cost."""
    rate = (
        settings.twilio_cost_per_minute_inbound
        if direction == "inbound"
        else settings.twilio_cost_per_minute_outbound
    )
    return (duration_seconds / 60.0) * float(rate)


def calculate_call_cost(
    user_id: str,
    duration_seconds: int,
    vapi_cost: float | None = None,
    direction: str = "outbound",
) -> tuple[float, float]:
    """Cost-plus pricing. Returns (charge, provider_cost).

    charge = provider_cost × the user's plan cost_multiplier, where provider_cost is
    VAPI's reported call cost plus the estimated Twilio carrier leg. When VAPI cost
    data is missing, falls back to the plan's advertised per-minute rate.
    Charges are rounded to whole cents so per-call cost, breakdown total, wallet
    debit and balance all reconcile exactly."""
    billing = get_or_create_billing(user_id)
    if vapi_cost is not None:
        provider_cost = round(float(vapi_cost) + _twilio_leg(duration_seconds, direction), 4)
        multiplier = float(billing.get("cost_multiplier") or DEFAULT_COST_MULTIPLIER)
        return round(provider_cost * multiplier, 2), provider_cost
    rate = billing.get("rate_per_minute") or DEFAULT_RATE_PER_MINUTE
    return round((duration_seconds / 60.0) * float(rate), 2), 0.0


def get_promo_config() -> dict:
    """Promo settings. An admin-editable `platform_settings` row (Phase 4) overrides the
    env defaults; before that table exists this gracefully falls back to env."""
    cfg = {
        "enabled": True,
        "amount": float(settings.signup_bonus_credits),
        "expiry_days": int(settings.signup_bonus_expiry_days),
    }
    try:
        rows = supabase.table("platform_settings").select("*").limit(1).execute().data
        if rows:
            s = rows[0]
            if s.get("promo_enabled") is not None:
                cfg["enabled"] = bool(s["promo_enabled"])
            if s.get("promo_amount") is not None:
                cfg["amount"] = float(s["promo_amount"])
            if s.get("promo_expiry_days") is not None:
                cfg["expiry_days"] = int(s["promo_expiry_days"])
    except Exception:
        pass  # platform_settings not present yet -> env defaults
    return cfg


def _has_promo_credit(user_id: str) -> bool:
    """True if the user already received a signup/promo credit — guards the one-time
    welcome bonus against being granted twice (e.g. a re-run of provisioning)."""
    existing = (
        supabase.table("wallet_transactions")
        .select("id")
        .eq("user_id", user_id)
        .eq("kind", "promo")
        .limit(1)
        .execute()
        .data
    )
    return bool(existing)


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


def record_call_cost(
    user_id: str,
    vapi_call_id: str,
    duration_seconds: int,
    vapi_cost: float | None = None,
    direction: str = "outbound",
) -> float:
    """Compute the call's cost, store it on the conversation (for the Cost Breakdown),
    and debit the wallet — the debit happens exactly once per call (idempotent by the
    ledger), so both the webhook and the background sync can call this freely."""
    cost, provider_cost = calculate_call_cost(user_id, duration_seconds, vapi_cost, direction)

    # Always keep the row's displayed cost + duration in sync (even on re-import).
    updates: dict = {
        "duration_seconds": duration_seconds,
        "call_cost": cost,
    }
    if vapi_cost is not None:
        updates["vapi_cost"] = round(float(vapi_cost), 4)
        updates["provider_cost"] = provider_cost
    supabase.table("conversations").update(updates).eq("vapi_call_id", vapi_call_id).execute()

    # Charge the wallet once per call.
    if cost > 0 and not _call_already_charged(vapi_call_id):
        billing = get_or_create_billing(user_id)
        current_charges = float(billing.get("total_charges") or 0)
        supabase.table("billing").update({
            "total_charges": round(current_charges + cost, 2),
        }).eq("user_id", user_id).execute()
        debit_balance(user_id, cost, "call", "Call charge", ref_id=vapi_call_id)
    return cost


@router.get("/status")
async def get_billing_status(user=Depends(get_current_user)):
    billing = get_or_create_billing(user["user_id"])
    return {
        "data": {
            "is_active": billing.get("is_active", True),
            "rate_per_minute": float(billing.get("rate_per_minute") or DEFAULT_RATE_PER_MINUTE),
            "cost_multiplier": float(billing.get("cost_multiplier") or DEFAULT_COST_MULTIPLIER),
            "total_charges": float(billing.get("total_charges") or 0),
            "balance": float(billing.get("balance") or 0),
            "auto_recharge_enabled": bool(billing.get("auto_recharge_enabled")),
            "auto_recharge_threshold": float(billing.get("auto_recharge_threshold") or 10.0),
            "auto_recharge_amount": float(billing.get("auto_recharge_amount") or 50.0),
        },
        "error": None,
    }


@router.get("/config")
async def get_stripe_config(user=Depends(get_current_user)):
    """Stripe publishable key for the in-app card form. Served from the backend (rather
    than baked into the bundle) so it always matches the secret key's test/live mode."""
    return {"data": {"publishable_key": settings.active_stripe_publishable_key}, "error": None}


# ── Payment methods (saved cards) ──

def _require_stripe():
    if not settings.stripe_secret_key:
        raise HTTPException(status_code=503, detail="Stripe not configured")


@router.get("/payment-methods")
async def list_payment_methods(user=Depends(get_current_user)):
    """Saved cards for this customer. Returns [] for users who never paid (no customer yet)."""
    if not settings.stripe_secret_key:
        return {"data": [], "error": None}
    billing = get_or_create_billing(user["user_id"])
    customer_id = billing.get("stripe_customer_id")
    if not customer_id:
        return {"data": [], "error": None}
    try:
        default_pm = get_default_payment_method(customer_id)
        cards = stripe.Customer.list_payment_methods(customer_id, type="card", limit=20)
        items = []
        for pm in (getattr(cards, "data", []) or []):
            card = getattr(pm, "card", None)
            items.append({
                "id": pm.id,
                "brand": (getattr(card, "brand", "") or "card").title(),
                "last4": getattr(card, "last4", "") or "",
                "exp_month": getattr(card, "exp_month", 0) or 0,
                "exp_year": getattr(card, "exp_year", 0) or 0,
                "is_default": pm.id == default_pm,
            })
        return {"data": items, "error": None}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Stripe error: {str(e)}")


@router.post("/payment-methods/setup-intent")
async def create_setup_intent(user=Depends(get_current_user)):
    """Client secret for the in-app card form. usage='off_session' so the saved card can
    later be charged unattended by auto-recharge."""
    _require_stripe()
    try:
        customer_id = _get_or_create_stripe_customer(user)
        intent = stripe.SetupIntent.create(
            customer=customer_id,
            usage="off_session",
            payment_method_types=["card"],
            metadata={"user_id": user["user_id"]},
        )
        return {"data": {"client_secret": intent.client_secret}, "error": None}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Stripe error: {str(e)}")


def _assert_pm_belongs_to(customer_id: str, payment_method_id: str) -> None:
    """Never let a user touch a card that isn't attached to their own customer."""
    try:
        pm = stripe.PaymentMethod.retrieve(payment_method_id)
    except Exception:
        raise HTTPException(status_code=404, detail="Payment method not found")
    owner = getattr(pm, "customer", None)
    owner_id = owner if isinstance(owner, str) else getattr(owner, "id", None)
    if owner_id != customer_id:
        raise HTTPException(status_code=403, detail="This payment method does not belong to you")


@router.post("/payment-methods/{payment_method_id}/default")
async def set_default_payment_method(payment_method_id: str, user=Depends(get_current_user)):
    _require_stripe()
    billing = get_or_create_billing(user["user_id"])
    customer_id = billing.get("stripe_customer_id")
    if not customer_id:
        raise HTTPException(status_code=400, detail="No saved payment methods yet")
    _assert_pm_belongs_to(customer_id, payment_method_id)
    try:
        stripe.Customer.modify(
            customer_id,
            invoice_settings={"default_payment_method": payment_method_id},
        )
        return {"data": {"id": payment_method_id, "is_default": True}, "error": None}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Stripe error: {str(e)}")


@router.delete("/payment-methods/{payment_method_id}")
async def delete_payment_method(payment_method_id: str, user=Depends(get_current_user)):
    _require_stripe()
    billing = get_or_create_billing(user["user_id"])
    customer_id = billing.get("stripe_customer_id")
    if not customer_id:
        raise HTTPException(status_code=404, detail="Payment method not found")
    _assert_pm_belongs_to(customer_id, payment_method_id)

    # Removing the last card while auto-recharge is on would silently break it.
    if billing.get("auto_recharge_enabled"):
        try:
            cards = stripe.Customer.list_payment_methods(customer_id, type="card", limit=2)
            if len(getattr(cards, "data", []) or []) <= 1:
                raise HTTPException(
                    status_code=400,
                    detail="This is your only card and auto recharge is on. "
                           "Turn off auto recharge or add another card first.",
                )
        except HTTPException:
            raise
        except Exception:
            pass  # if the count check fails, fall through to the detach attempt

    try:
        stripe.PaymentMethod.detach(payment_method_id)
        return {"data": {"deleted": payment_method_id}, "error": None}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Stripe error: {str(e)}")


# ── Auto-recharge settings ──

class AutoRechargeUpdate(BaseModel):
    enabled: bool
    threshold: Optional[float] = None
    amount: Optional[float] = None


@router.put("/auto-recharge")
async def update_auto_recharge(body: AutoRechargeUpdate, user=Depends(get_current_user)):
    billing = get_or_create_billing(user["user_id"])
    updates: dict = {"auto_recharge_enabled": bool(body.enabled)}

    if body.threshold is not None:
        threshold = round(float(body.threshold), 2)
        if threshold < 0 or threshold > 500:
            raise HTTPException(status_code=400, detail="Threshold must be between $0 and $500")
        updates["auto_recharge_threshold"] = threshold
    if body.amount is not None:
        amount = round(float(body.amount), 2)
        if amount < TOPUP_MIN or amount > TOPUP_MAX:
            raise HTTPException(
                status_code=400,
                detail=f"Recharge amount must be between ${TOPUP_MIN:.0f} and ${TOPUP_MAX:.0f}",
            )
        updates["auto_recharge_amount"] = amount

    # Enabling without a chargeable card would just fail silently later — block it here.
    if body.enabled:
        customer_id = billing.get("stripe_customer_id")
        if not customer_id or not get_default_payment_method(customer_id):
            raise HTTPException(
                status_code=400,
                detail="Add a payment method before enabling auto recharge.",
            )
        updates["auto_recharge_pending_at"] = None  # clear any stale in-flight marker

    supabase.table("billing").update(updates).eq("user_id", user["user_id"]).execute()
    fresh = get_or_create_billing(user["user_id"])
    return {
        "data": {
            "auto_recharge_enabled": bool(fresh.get("auto_recharge_enabled")),
            "auto_recharge_threshold": float(fresh.get("auto_recharge_threshold") or 10.0),
            "auto_recharge_amount": float(fresh.get("auto_recharge_amount") or 50.0),
        },
        "error": None,
    }


# ── Promotions (redeemable codes) ──

class RedeemPromo(BaseModel):
    code: str


@router.get("/promotions")
async def list_promotions(user=Depends(get_current_user)):
    """This user's applied promotions, for the Promotions tab."""
    rows = (
        supabase.table("promo_code_redemptions")
        .select("id, promo_code_id, amount, created_at")
        .eq("user_id", user["user_id"])
        .order("created_at", desc=True)
        .execute().data or []
    )
    # Resolve code labels (small N — one lookup per redemption is fine here).
    items = []
    for r in rows:
        pc = (
            supabase.table("promo_codes").select("code")
            .eq("id", r["promo_code_id"]).maybe_single().execute().data
        )
        items.append({
            "id": r["id"],
            "code": (pc or {}).get("code", "—"),
            "amount": float(r.get("amount") or 0),
            "created_at": r.get("created_at"),
        })
    return {"data": items, "error": None}


@router.post("/promotions/redeem")
async def redeem_promo_code(body: RedeemPromo, user=Depends(get_current_user)):
    code = (body.code or "").strip().upper()
    if not code:
        raise HTTPException(status_code=400, detail="Enter a promotion code")

    promo = supabase.table("promo_codes").select("*").eq("code", code).maybe_single().execute().data
    if not promo or not promo.get("active"):
        raise HTTPException(status_code=404, detail="That promotion code isn't valid")

    valid_until = promo.get("valid_until")
    if valid_until and _parse_ts(valid_until) <= datetime.now(timezone.utc):
        raise HTTPException(status_code=400, detail="That promotion code has expired")

    max_redemptions = promo.get("max_redemptions")
    if max_redemptions is not None and int(promo.get("redemption_count") or 0) >= int(max_redemptions):
        raise HTTPException(status_code=400, detail="That promotion code has been fully claimed")

    already = (
        supabase.table("promo_code_redemptions").select("id")
        .eq("promo_code_id", promo["id"]).eq("user_id", user["user_id"])
        .limit(1).execute().data
    )
    if already:
        raise HTTPException(status_code=400, detail="You've already used that promotion code")

    amount = round(float(promo.get("amount") or 0), 2)
    if amount <= 0:
        raise HTTPException(status_code=400, detail="That promotion code has no credit attached")

    # The UNIQUE(promo_code_id, user_id) constraint is the real race guard — if two
    # requests land at once, the loser's insert fails and we bail out before crediting.
    try:
        supabase.table("promo_code_redemptions").insert({
            "promo_code_id": promo["id"],
            "user_id": user["user_id"],
            "amount": amount,
        }).execute()
    except Exception:
        raise HTTPException(status_code=400, detail="You've already used that promotion code")

    supabase.table("promo_codes").update(
        {"redemption_count": int(promo.get("redemption_count") or 0) + 1}
    ).eq("id", promo["id"]).execute()

    days = promo.get("expiry_days")
    expires = (
        (datetime.now(timezone.utc) + timedelta(days=int(days))).isoformat()
        if days else None
    )
    # kind="promo_code" (NOT "promo") so _has_promo_credit() still gates only the
    # automatic signup welcome bonus. grant_type="promo" keeps it spent-first + expiring.
    new_balance = credit_balance(
        user["user_id"], amount, "promo_code",
        f"Promotion code {code}",
        ref_id=str(promo["id"]), grant_type="promo", expires_at=expires,
    )
    return {
        "data": {"code": code, "amount": amount, "balance": new_balance},
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


class TopupRequest(BaseModel):
    amount: float
    success_url: Optional[str] = None
    cancel_url: Optional[str] = None


TOPUP_MIN = 20.0
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
            # Retain the card on the customer so it shows up under Payment methods and
            # can be charged unattended by auto-recharge.
            payment_intent_data={"setup_future_usage": "off_session"},
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
