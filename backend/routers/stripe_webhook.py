import stripe
from fastapi import APIRouter, Request, HTTPException
from database import supabase
from config import settings
from routers.billing import get_plan_by_id, FREE_TIER
import logging

logger = logging.getLogger(__name__)
router = APIRouter(tags=["Stripe Webhook"])

stripe.api_key = settings.stripe_secret_key


@router.post("/webhooks/stripe")
async def stripe_webhook(request: Request):
    payload = await request.body()
    sig_header = request.headers.get("stripe-signature", "")

    if settings.stripe_webhook_secret:
        try:
            event = stripe.Webhook.construct_event(
                payload, sig_header, settings.stripe_webhook_secret
            )
        except stripe.error.SignatureVerificationError:
            raise HTTPException(status_code=400, detail="Invalid signature")
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))
    else:
        import json
        event = json.loads(payload)

    event_type = event.get("type") if isinstance(event, dict) else event["type"]
    data_object = event.get("data", {}).get("object", {}) if isinstance(event, dict) else event["data"]["object"]

    if event_type == "checkout.session.completed":
        _handle_checkout_completed(data_object)
    elif event_type == "invoice.paid":
        _handle_invoice_paid(data_object)
    elif event_type == "customer.subscription.updated":
        _handle_subscription_updated(data_object)
    elif event_type == "customer.subscription.deleted":
        _handle_subscription_deleted(data_object)

    return {"received": True}


def _handle_checkout_completed(session: dict):
    user_id = session.get("metadata", {}).get("user_id")
    plan_id = session.get("metadata", {}).get("plan_id")
    customer_id = session.get("customer")
    subscription_id = session.get("subscription")

    if not user_id:
        logger.warning("checkout.session.completed without user_id in metadata")
        return

    plan = get_plan_by_id(plan_id) if plan_id else None

    billing_data = {
        "plan": plan_id or "starter",
        "status": "active",
        "stripe_customer_id": customer_id,
        "stripe_subscription_id": subscription_id,
        "outbound_used": 0,
        "inbound_used": 0,
    }

    if plan:
        billing_data["outbound_limit"] = plan["outbound_limit"]
        billing_data["inbound_limit"] = plan["inbound_limit"]
        billing_data["agents_limit"] = plan["agents_limit"]
        billing_data["rate_per_minute"] = plan.get("rate_per_minute", 0.05)
        billing_data["total_charges"] = 0

    existing = supabase.table("billing").select("id").eq("user_id", user_id).execute()

    if existing.data:
        supabase.table("billing").update(billing_data).eq("user_id", user_id).execute()
    else:
        billing_data["user_id"] = user_id
        supabase.table("billing").insert(billing_data).execute()

    logger.info(f"Billing activated for user {user_id}, plan={plan_id}")


def _handle_invoice_paid(invoice: dict):
    customer_id = invoice.get("customer")
    if not customer_id:
        return

    billing = supabase.table("billing").select("user_id").eq("stripe_customer_id", customer_id).execute()
    if billing.data:
        supabase.table("billing").update({
            "status": "active",
            "outbound_used": 0,
            "inbound_used": 0,
        }).eq("stripe_customer_id", customer_id).execute()


def _handle_subscription_updated(subscription: dict):
    customer_id = subscription.get("customer")
    status = subscription.get("status")
    current_period_end = subscription.get("current_period_end")

    if not customer_id:
        return

    updates = {}
    if status:
        updates["status"] = status
    if current_period_end:
        from datetime import datetime
        updates["current_period_end"] = datetime.utcfromtimestamp(current_period_end).isoformat()

    if updates:
        supabase.table("billing").update(updates).eq("stripe_customer_id", customer_id).execute()


def _handle_subscription_deleted(subscription: dict):
    customer_id = subscription.get("customer")
    if not customer_id:
        return

    supabase.table("billing").update({
        "status": "canceled",
        "plan": "free",
        "outbound_limit": FREE_TIER["outbound_limit"],
        "inbound_limit": FREE_TIER["inbound_limit"],
        "agents_limit": FREE_TIER["agents_limit"],
        "outbound_used": 0,
        "inbound_used": 0,
        "credits": 0,
    }).eq("stripe_customer_id", customer_id).execute()
