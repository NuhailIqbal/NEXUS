import stripe
from fastapi import APIRouter, Depends, HTTPException
from dependencies import get_current_user
from database import supabase
from config import settings
from pydantic import BaseModel
from typing import Optional
from datetime import datetime, timezone

router = APIRouter(prefix="/billing", tags=["Billing"])

stripe.api_key = settings.stripe_secret_key

PLANS = [
    {
        "id": "starter",
        "name": "Starter",
        "price": 2500,
        "price_display": "$25/mo",
        "description": "For small teams getting started",
        "outbound_limit": 100,
        "inbound_limit": 200,
        "agents_limit": 25,
        "features": [
            "100 outbound calls/mo",
            "200 inbound calls/mo",
            "Up to 25 AI Agents",
            "Basic automation",
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
        "features": [
            "300 outbound calls/mo",
            "500 inbound calls/mo",
            "Up to 50 AI Agents",
            "Advanced automation",
            "15+ integrations",
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
        "features": [
            "500 outbound calls/mo",
            "700 inbound calls/mo",
            "Up to 100 AI Agents",
            "Custom automation flows",
            "Dedicated account manager",
            "SLA & custom integrations",
        ],
    },
]

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
        "is_active": True,
    }
    insert = supabase.table("billing").insert(row).execute()
    return insert.data[0] if insert.data else row


def check_call_quota(user_id: str, direction: str) -> bool:
    billing = get_or_create_billing(user_id)
    if not billing.get("is_active", True):
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

    success_url = body.success_url or "http://localhost:8082/dashboard/billing?success=true"
    cancel_url = body.cancel_url or "http://localhost:8082/dashboard/billing?canceled=true"

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
