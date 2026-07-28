import stripe
from fastapi import APIRouter, Request, HTTPException
from config import settings
import logging

logger = logging.getLogger(__name__)
router = APIRouter(tags=["Stripe Webhook"])

stripe.api_key = settings.stripe_secret_key


@router.post("/webhooks/stripe")
async def stripe_webhook(request: Request):
    """Handles auto-recharge PaymentIntents. There are no subscriptions here — billing is
    a prepaid wallet, and interactive top-ups are confirmed client-side via
    /billing/topup/confirm. This webhook is the safety net for OFF-SESSION auto-recharge
    charges, whose result we may not see synchronously (network loss, SCA, async decline)."""
    payload = await request.body()
    sig_header = request.headers.get("stripe-signature", "")

    if settings.stripe_webhook_secret:
        try:
            event = stripe.Webhook.construct_event(payload, sig_header, settings.stripe_webhook_secret)
        except stripe.error.SignatureVerificationError:
            raise HTTPException(status_code=400, detail="Invalid signature")
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))
    else:
        # No signing secret configured (local dev) — parse without verification.
        import json
        try:
            event = json.loads(payload)
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid payload")

    event_type = event.get("type") if isinstance(event, dict) else event["type"]
    obj = (event.get("data", {}) or {}).get("object", {}) if isinstance(event, dict) else event["data"]["object"]

    try:
        if event_type == "payment_intent.succeeded":
            _handle_pi_succeeded(obj)
        elif event_type in ("payment_intent.payment_failed", "payment_intent.canceled"):
            _handle_pi_failed(obj)
    except Exception:
        # Never 500 back at Stripe — that just triggers pointless retries.
        logger.exception("Error handling Stripe webhook %s", event_type)

    return {"received": True}


def _meta(obj: dict) -> dict:
    return (obj.get("metadata") or {}) if isinstance(obj, dict) else {}


def _handle_pi_succeeded(intent: dict) -> None:
    """Credit an auto-recharge that succeeded. Safe to run even if the synchronous path
    already credited it — credit_balance dedupes on the PaymentIntent id."""
    meta = _meta(intent)
    if meta.get("type") != "auto_recharge":
        return
    user_id = meta.get("user_id")
    if not user_id:
        return
    amount = float(meta.get("amount") or 0) or (int(intent.get("amount") or 0) / 100.0)
    if amount <= 0:
        return
    from routers.billing import credit_auto_recharge
    credit_auto_recharge(user_id, intent.get("id"), round(amount, 2))
    logger.info("Auto-recharge credited via webhook for user %s (%s)", user_id, intent.get("id"))


def _handle_pi_failed(intent: dict) -> None:
    """Clear the in-flight marker so the next low balance can retry, and tell the user."""
    meta = _meta(intent)
    if meta.get("type") != "auto_recharge":
        return
    user_id = meta.get("user_id")
    if not user_id:
        return
    from database import supabase
    from routers.billing import _insert_notification
    supabase.table("billing").update(
        {"auto_recharge_pending_at": None}
    ).eq("user_id", user_id).execute()
    reason = ((intent.get("last_payment_error") or {}).get("message")
              or "Your card was declined.")
    _insert_notification(
        user_id, "auto_recharge_failed", "Auto recharge failed",
        f"{reason} Add funds manually or update your card under Billing → Payment methods.",
    )
