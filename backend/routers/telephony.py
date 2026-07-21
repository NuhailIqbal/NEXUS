import asyncio
import stripe
from pydantic import BaseModel
from fastapi import APIRouter, Depends, HTTPException
from dependencies import get_current_user
from database import supabase
from models.schemas import (
    CampaignCreate, CampaignUpdate,
    InboundQueueCreate, InboundQueueUpdate,
    PhoneNumberCreate, PhoneNumberUpdate,
    OutboundCallCreate,
)
from services import vapi_client, twilio_service
from config import settings
from routers.billing import (
    check_call_quota,
    get_or_create_billing,
    has_balance,
    debit_balance,
    get_balance,
    PHONE_NUMBER_MONTHLY_COST,
)

CAMPAIGN_BATCH_SIZE = 20

router = APIRouter(prefix="/telephony", tags=["Telephony"])


# ── Phone Numbers ──

@router.get("/phone-numbers")
async def list_phone_numbers(user=Depends(get_current_user)):
    result = (
        supabase.table("phone_numbers")
        .select("*")
        .eq("user_id", user["user_id"])
        .order("created_at", desc=True)
        .execute()
    )
    return {"data": result.data, "error": None}


async def _resolve_assistant_id(user_id: str, agent_id: str | None) -> str | None:
    if not agent_id:
        return None
    agent = (
        supabase.table("ai_agents")
        .select("vapi_assistant_id")
        .eq("id", agent_id)
        .eq("user_id", user_id)
        .maybe_single()
        .execute()
    )
    return agent.data.get("vapi_assistant_id") if (agent and agent.data) else None


async def _provision_phone_number(*, user_id: str, provider: str, number: str | None = None,
                                  area_code: str | None = None, agent_id: str | None = None,
                                  status: str = "Active", monthly_cost: float = 0.0,
                                  stripe_session_id: str | None = None) -> dict:
    """Provision a phone number (VAPI-native or Twilio→VAPI import) and store the row.

    Shared by the direct create endpoint (VAPI) and the post-payment confirm endpoint (Twilio).
    """
    provider = (provider or "vapi").lower()
    row: dict = {
        "user_id": user_id,
        "number": number or "",
        "status": status or "Active",
        "provider": provider,
    }
    if agent_id:
        row["agent_id"] = agent_id
    if stripe_session_id:
        row["stripe_session_id"] = stripe_session_id

    assistant_id = await _resolve_assistant_id(user_id, agent_id)

    if provider == "vapi" and settings.vapi_api_key:
        try:
            vapi_payload: dict = {"provider": "vapi"}
            if area_code:
                vapi_payload["numberDesiredAreaCode"] = area_code
            if assistant_id:
                vapi_payload["assistantId"] = assistant_id
            vapi_result = await vapi_client.create_phone_number(vapi_payload)
            row["vapi_phone_id"] = vapi_result.get("id")
            row["number"] = vapi_result.get("number", number or "")
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"VAPI error: {str(e)}")

    elif provider == "twilio":
        if not settings.twilio_account_sid or not settings.twilio_auth_token:
            raise HTTPException(status_code=400, detail="Twilio account is not configured on the server.")
        try:
            purchased = await twilio_service.buy_us_number(sms=True, voice=True)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Twilio purchase failed: {str(e)}")
        row["number"] = purchased["number"]

        if settings.vapi_api_key:
            try:
                vapi_payload = {
                    "provider": "twilio",
                    "number": purchased["number"],
                    "twilioAccountSid": settings.twilio_account_sid,
                    "twilioAuthToken": settings.twilio_auth_token,
                }
                if assistant_id:
                    vapi_payload["assistantId"] = assistant_id
                vapi_result = await vapi_client.create_phone_number(vapi_payload)
                row["vapi_phone_id"] = vapi_result.get("id")
            except Exception as e:
                raise HTTPException(status_code=502, detail=f"Purchased {purchased['number']} but VAPI import failed: {str(e)}")

        row["monthly_cost"] = monthly_cost or PHONE_NUMBER_MONTHLY_COST

    result = supabase.table("phone_numbers").insert(row).execute()
    return result.data[0] if result.data else row


def _phone_checkout_session(user, body) -> dict:
    """Create a Stripe Checkout session to pay for a Twilio number (low-balance fallback)."""
    stripe.api_key = settings.stripe_secret_key
    billing = get_or_create_billing(user["user_id"])
    customer_id = billing.get("stripe_customer_id")
    if not customer_id:
        customer = stripe.Customer.create(email=user.get("email"), metadata={"user_id": user["user_id"]})
        customer_id = customer.id
        supabase.table("billing").update({"stripe_customer_id": customer_id}).eq("user_id", user["user_id"]).execute()

    base = "http://localhost:8080/dashboard/telephony/phone-numbers"
    session = stripe.checkout.Session.create(
        customer=customer_id,
        payment_method_types=["card"],
        mode="payment",
        line_items=[{
            "price_data": {
                "currency": "usd",
                "product_data": {"name": "EDM Nexus — Phone Number", "description": "Twilio phone number"},
                "unit_amount": int(round(PHONE_NUMBER_MONTHLY_COST * 100)),
            },
            "quantity": 1,
        }],
        success_url=f"{base}?purchase=success&session_id={{CHECKOUT_SESSION_ID}}",
        cancel_url=f"{base}?purchase=canceled",
        metadata={
            "type": "phone_number",
            "user_id": user["user_id"],
            "provider": "twilio",
            "area_code": body.area_code or "",
            "agent_id": body.agent_id or "",
            "status": body.status or "Active",
        },
    )
    return {"checkout_url": session.url, "session_id": session.id}


@router.post("/phone-numbers")
async def create_phone_number(body: PhoneNumberCreate, user=Depends(get_current_user)):
    provider = (body.provider or "vapi").lower()

    if provider == "twilio":
        # Enough balance → pay from the wallet and provision immediately.
        if has_balance(user["user_id"], PHONE_NUMBER_MONTHLY_COST):
            row = await _provision_phone_number(
                user_id=user["user_id"],
                provider="twilio",
                agent_id=body.agent_id,
                status=body.status or "Active",
                monthly_cost=PHONE_NUMBER_MONTHLY_COST,
            )
            debit_balance(
                user["user_id"], PHONE_NUMBER_MONTHLY_COST, "phone",
                f"Phone number {row.get('number')}", ref_id=row.get("id"),
            )
            return {"data": row, "error": None}

        # Low balance → send the user to Stripe checkout to pay for this number.
        # (The number is provisioned in /phone-numbers/confirm after payment.)
        if not settings.stripe_secret_key:
            raise HTTPException(status_code=402, detail="Insufficient balance and Stripe is not configured.")
        checkout = _phone_checkout_session(user, body)
        return {"data": {"needs_payment": True, **checkout}, "error": None}

    # VAPI numbers are free to provision.
    row = await _provision_phone_number(
        user_id=user["user_id"],
        provider=provider,
        number=body.number,
        area_code=body.area_code,
        agent_id=body.agent_id,
        status=body.status or "Active",
    )
    return {"data": row, "error": None}


class PhoneConfirm(BaseModel):
    session_id: str


@router.post("/phone-numbers/confirm")
async def confirm_phone_checkout(body: PhoneConfirm, user=Depends(get_current_user)):
    """After Stripe payment (low-balance path): verify payment, then provision the number.

    No wallet debit here — the number was paid for directly via Stripe.
    """
    if not settings.stripe_secret_key:
        raise HTTPException(status_code=503, detail="Stripe not configured")
    stripe.api_key = settings.stripe_secret_key

    # Idempotency: a given Stripe session provisions exactly one number.
    existing = (
        supabase.table("phone_numbers")
        .select("*")
        .eq("stripe_session_id", body.session_id)
        .eq("user_id", user["user_id"])
        .execute()
    )
    if existing.data:
        return {"data": existing.data[0], "error": None}

    try:
        session = stripe.checkout.Session.retrieve(body.session_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Stripe error: {str(e)}")

    # Stripe SDK objects: attribute access + .to_dict() (dict() / .get() don't work).
    meta = session.metadata.to_dict() if session.metadata is not None else {}
    if meta.get("user_id") != user["user_id"]:
        raise HTTPException(status_code=403, detail="This checkout session does not belong to you")
    if session.payment_status != "paid":
        raise HTTPException(status_code=402, detail="Payment not completed")

    row = await _provision_phone_number(
        user_id=user["user_id"],
        provider="twilio",
        area_code=meta.get("area_code") or None,
        agent_id=meta.get("agent_id") or None,
        status=meta.get("status") or "Active",
        monthly_cost=PHONE_NUMBER_MONTHLY_COST,
        stripe_session_id=body.session_id,
    )
    return {"data": row, "error": None}


@router.patch("/phone-numbers/{number_id}")
async def update_phone_number(number_id: str, body: PhoneNumberUpdate, user=Depends(get_current_user)):
    updates = body.model_dump(exclude_none=True)
    if not updates:
        return {"data": None, "error": "No fields to update"}

    if "agent_id" in updates and settings.vapi_api_key:
        existing = (
            supabase.table("phone_numbers")
            .select("vapi_phone_id")
            .eq("id", number_id)
            .eq("user_id", user["user_id"])
            .maybe_single()
            .execute()
        )
        vapi_phone_id = existing.data.get("vapi_phone_id") if existing.data else None
        if vapi_phone_id:
            vapi_update: dict = {}
            if updates["agent_id"]:
                agent = (
                    supabase.table("ai_agents")
                    .select("vapi_assistant_id")
                    .eq("id", updates["agent_id"])
                    .eq("user_id", user["user_id"])
                    .maybe_single()
                    .execute()
                )
                if agent.data and agent.data.get("vapi_assistant_id"):
                    vapi_update["assistantId"] = agent.data["vapi_assistant_id"]
            else:
                vapi_update["assistantId"] = None
            try:
                await vapi_client.update_phone_number(vapi_phone_id, vapi_update)
            except Exception as e:
                raise HTTPException(status_code=502, detail=f"VAPI sync error: {str(e)}")

    result = (
        supabase.table("phone_numbers")
        .update(updates)
        .eq("id", number_id)
        .eq("user_id", user["user_id"])
        .execute()
    )
    return {"data": result.data[0] if result.data else None, "error": None}


@router.delete("/phone-numbers/{number_id}")
async def release_phone_number(number_id: str, user=Depends(get_current_user)):
    existing = (
        supabase.table("phone_numbers")
        .select("vapi_phone_id")
        .eq("id", number_id)
        .eq("user_id", user["user_id"])
        .maybe_single()
        .execute()
    )
    if existing.data and existing.data.get("vapi_phone_id") and settings.vapi_api_key:
        try:
            await vapi_client.delete_phone_number(existing.data["vapi_phone_id"])
        except Exception:
            pass
    supabase.table("phone_numbers").delete().eq("id", number_id).eq("user_id", user["user_id"]).execute()
    return {"data": None, "error": None}


# ── Outbound Call (single) ──

@router.post("/call")
async def make_outbound_call(body: OutboundCallCreate, user=Depends(get_current_user)):
    if not settings.vapi_api_key:
        raise HTTPException(status_code=503, detail="VAPI not configured")

    billing = get_or_create_billing(user["user_id"])
    if not billing.get("is_active", True):
        raise HTTPException(status_code=403, detail="Your account has been deactivated. Contact support.")
    if not check_call_quota(user["user_id"], "outbound"):
        raise HTTPException(status_code=403, detail="Outbound call limit reached. Upgrade your plan for more calls.")

    agent = (
        supabase.table("ai_agents")
        .select("vapi_assistant_id")
        .eq("id", body.agent_id)
        .eq("user_id", user["user_id"])
        .maybe_single()
        .execute()
    )
    if not agent.data or not agent.data.get("vapi_assistant_id"):
        raise HTTPException(status_code=404, detail="Agent not found or missing VAPI ID")

    call_payload = {
        "assistantId": agent.data["vapi_assistant_id"],
        "customer": {"number": body.phone_number},
    }

    if body.phone_number_id:
        phone = (
            supabase.table("phone_numbers")
            .select("vapi_phone_id")
            .eq("id", body.phone_number_id)
            .eq("user_id", user["user_id"])
            .maybe_single()
            .execute()
        )
        if phone.data and phone.data.get("vapi_phone_id"):
            call_payload["phoneNumberId"] = phone.data["vapi_phone_id"]

    try:
        vapi_result = await vapi_client.create_call(call_payload)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"VAPI call error: {str(e)}")

    return {"data": {"vapi_call_id": vapi_result.get("id"), "status": vapi_result.get("status", "queued")}, "error": None}


# ── Outbound Campaigns ──

def _phone_key(phone: str) -> str:
    """Last 10 digits — tolerant phone matching across formats (+1..., spaces, dashes)."""
    d = "".join(ch for ch in (phone or "") if ch.isdigit())
    return d[-10:] if len(d) >= 10 else d


def _enrich_campaign_progress(user_id: str, campaigns: list[dict]) -> None:
    """Fill each campaign's `contacts_count` (size of its list) and `completed_count`
    (distinct contacts in that list who have a Completed call). Computed live from
    conversations so the progress bar reflects actual call results, not a stale counter."""
    if not campaigns:
        return
    from collections import defaultdict

    contacts = (
        supabase.table("contacts").select("id, list_id, phone").eq("user_id", user_id).execute().data or []
    )
    by_list: dict = defaultdict(list)
    for c in contacts:
        if c.get("list_id"):
            by_list[c["list_id"]].append(c)

    convos = (
        supabase.table("conversations").select("contact_id, phone, status").eq("user_id", user_id).execute().data or []
    )
    contacted_ids: set = set()
    contacted_phones: set = set()
    for cv in convos:
        if cv.get("status") == "Completed":
            if cv.get("contact_id"):
                contacted_ids.add(cv["contact_id"])
            if cv.get("phone"):
                contacted_phones.add(_phone_key(cv["phone"]))

    for camp in campaigns:
        lc = by_list.get(camp.get("list_id"), [])
        camp["contacts_count"] = len(lc)
        camp["completed_count"] = sum(
            1 for c in lc
            if c["id"] in contacted_ids or (c.get("phone") and _phone_key(c["phone"]) in contacted_phones)
        )


@router.get("/campaigns")
async def list_campaigns(user=Depends(get_current_user)):
    result = (
        supabase.table("outbound_campaigns")
        .select("*")
        .eq("user_id", user["user_id"])
        .order("created_at", desc=True)
        .execute()
    )
    campaigns = result.data or []
    _enrich_campaign_progress(user["user_id"], campaigns)
    return {"data": campaigns, "error": None}


@router.post("/campaigns")
async def create_campaign(body: CampaignCreate, user=Depends(get_current_user)):
    row = body.model_dump()
    row["user_id"] = user["user_id"]

    if body.list_id:
        contacts = (
            supabase.table("contacts")
            .select("id", count="exact")
            .eq("user_id", user["user_id"])
            .eq("list_id", body.list_id)
            .execute()
        )
        row["contacts_count"] = contacts.count or 0

    result = supabase.table("outbound_campaigns").insert(row).execute()
    return {"data": result.data[0] if result.data else None, "error": None}


@router.get("/campaigns/{campaign_id}")
async def get_campaign(campaign_id: str, user=Depends(get_current_user)):
    result = (
        supabase.table("outbound_campaigns")
        .select("*")
        .eq("id", campaign_id)
        .eq("user_id", user["user_id"])
        .maybe_single()
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Campaign not found")
    camp = result.data
    _enrich_campaign_progress(user["user_id"], [camp])
    return {"data": camp, "error": None}


@router.patch("/campaigns/{campaign_id}")
async def update_campaign(campaign_id: str, body: CampaignUpdate, user=Depends(get_current_user)):
    updates = body.model_dump(exclude_none=True)
    if not updates:
        return {"data": None, "error": "No fields to update"}
    result = (
        supabase.table("outbound_campaigns")
        .update(updates)
        .eq("id", campaign_id)
        .eq("user_id", user["user_id"])
        .execute()
    )
    return {"data": result.data[0] if result.data else None, "error": None}


@router.delete("/campaigns/{campaign_id}")
async def delete_campaign(campaign_id: str, user=Depends(get_current_user)):
    supabase.table("outbound_campaigns").delete().eq("id", campaign_id).eq("user_id", user["user_id"]).execute()
    return {"data": None, "error": None}


@router.post("/campaigns/{campaign_id}/start")
async def start_campaign(campaign_id: str, user=Depends(get_current_user)):
    campaign = (
        supabase.table("outbound_campaigns")
        .select("*")
        .eq("id", campaign_id)
        .eq("user_id", user["user_id"])
        .maybe_single()
        .execute()
    )
    if not campaign.data:
        raise HTTPException(status_code=404, detail="Campaign not found")

    camp = campaign.data
    vapi_assistant_id = None
    if camp.get("agent_id"):
        agent_res = (
            supabase.table("ai_agents")
            .select("vapi_assistant_id")
            .eq("id", camp["agent_id"])
            .maybe_single()
            .execute()
        )
        if agent_res.data:
            vapi_assistant_id = agent_res.data.get("vapi_assistant_id")

    if not vapi_assistant_id:
        raise HTTPException(status_code=400, detail="Campaign agent has no VAPI assistant")

    billing = get_or_create_billing(user["user_id"])
    if not billing.get("is_active", True):
        raise HTTPException(status_code=403, detail="Your account has been deactivated. Contact support.")
    if not check_call_quota(user["user_id"], "outbound"):
        raise HTTPException(status_code=403, detail="Outbound call limit reached. Upgrade your plan for more calls.")

    if not camp.get("list_id"):
        raise HTTPException(status_code=400, detail="Campaign has no contact list assigned. Edit the campaign and select a list.")

    if not camp.get("phone_number_id"):
        raise HTTPException(status_code=400, detail="Campaign has no phone number assigned. Edit the campaign and select a phone number to call from.")

    contacts = (
        supabase.table("contacts")
        .select("name, phone")
        .eq("user_id", user["user_id"])
        .eq("list_id", camp["list_id"])
        .not_.is_("phone", "null")
        .execute()
    )

    if not contacts.data:
        raise HTTPException(status_code=400, detail="No contacts with phone numbers in the list")

    pn = (
        supabase.table("phone_numbers")
        .select("vapi_phone_id")
        .eq("id", camp["phone_number_id"])
        .maybe_single()
        .execute()
    )
    phone_number_id = pn.data.get("vapi_phone_id") if pn.data else None
    if not phone_number_id:
        raise HTTPException(status_code=400, detail="The campaign's phone number is not linked to VAPI yet. Wait for activation or re-provision the number.")

    async def dial_contact(contact):
        call_payload = {
            "assistantId": vapi_assistant_id,
            "customer": {"number": contact["phone"]},
        }
        if phone_number_id:
            call_payload["phoneNumberId"] = phone_number_id
        try:
            await vapi_client.create_call(call_payload)
            return {"success": True, "phone": contact["phone"]}
        except Exception as e:
            return {"success": False, "phone": contact["phone"], "error": str(e)}

    dialed = 0
    errors = []
    all_contacts = contacts.data
    for i in range(0, len(all_contacts), CAMPAIGN_BATCH_SIZE):
        batch = all_contacts[i:i + CAMPAIGN_BATCH_SIZE]
        results = await asyncio.gather(*[dial_contact(c) for c in batch])
        for r in results:
            if r["success"]:
                dialed += 1
            else:
                errors.append({"phone": r["phone"], "error": r.get("error", "unknown")})

    supabase.table("outbound_campaigns").update({
        "status": "Active",
        "contacts_count": len(contacts.data),
    }).eq("id", campaign_id).execute()

    return {
        "data": {"dialed": dialed, "errors": len(errors), "error_details": errors[:5]},
        "error": None,
    }


@router.post("/campaigns/{campaign_id}/pause")
async def pause_campaign(campaign_id: str, user=Depends(get_current_user)):
    supabase.table("outbound_campaigns").update({"status": "Paused"}).eq("id", campaign_id).eq("user_id", user["user_id"]).execute()
    return {"data": {"status": "Paused"}, "error": None}


@router.post("/campaigns/{campaign_id}/resume")
async def resume_campaign(campaign_id: str, user=Depends(get_current_user)):
    supabase.table("outbound_campaigns").update({"status": "Active"}).eq("id", campaign_id).eq("user_id", user["user_id"]).execute()
    return {"data": {"status": "Active"}, "error": None}


# ── Inbound Queues ──

@router.get("/inbound")
async def list_inbound_queues(user=Depends(get_current_user)):
    result = (
        supabase.table("inbound_queues")
        .select("*")
        .eq("user_id", user["user_id"])
        .order("created_at", desc=True)
        .execute()
    )
    return {"data": result.data, "error": None}


@router.post("/inbound")
async def create_inbound_queue(body: InboundQueueCreate, user=Depends(get_current_user)):
    if not settings.vapi_api_key:
        raise HTTPException(status_code=503, detail="VAPI not configured")
    if not body.agent_id:
        raise HTTPException(status_code=400, detail="agent_id is required")

    agent = (
        supabase.table("ai_agents")
        .select("vapi_assistant_id")
        .eq("id", body.agent_id)
        .eq("user_id", user["user_id"])
        .maybe_single()
        .execute()
    )
    if not agent.data or not agent.data.get("vapi_assistant_id"):
        raise HTTPException(status_code=400, detail="Agent not found or not synced with VAPI")
    vapi_assistant_id = agent.data["vapi_assistant_id"]

    phone_number_id = body.phone_number_id

    if phone_number_id:
        phone = (
            supabase.table("phone_numbers")
            .select("vapi_phone_id")
            .eq("id", phone_number_id)
            .eq("user_id", user["user_id"])
            .maybe_single()
            .execute()
        )
        if not phone.data or not phone.data.get("vapi_phone_id"):
            raise HTTPException(status_code=400, detail="Phone number not found or not VAPI-provisioned")
        try:
            await vapi_client.update_phone_number(phone.data["vapi_phone_id"], {"assistantId": vapi_assistant_id})
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"VAPI error assigning agent: {str(e)}")
        supabase.table("phone_numbers").update({"agent_id": body.agent_id}).eq("id", phone_number_id).eq("user_id", user["user_id"]).execute()
    else:
        vapi_payload: dict = {"provider": "vapi", "assistantId": vapi_assistant_id}
        if body.area_code:
            vapi_payload["numberDesiredAreaCode"] = body.area_code
        try:
            vapi_result = await vapi_client.create_phone_number(vapi_payload)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"VAPI error provisioning number: {str(e)}")

        pn_row = {
            "user_id": user["user_id"],
            "number": vapi_result.get("number", ""),
            "vapi_phone_id": vapi_result.get("id"),
            "agent_id": body.agent_id,
            "provider": "vapi",
            "status": "Active",
        }
        pn_result = supabase.table("phone_numbers").insert(pn_row).execute()
        if pn_result.data:
            phone_number_id = pn_result.data[0]["id"]

    row = body.model_dump(exclude={"area_code"})
    row["user_id"] = user["user_id"]
    row["phone_number_id"] = phone_number_id

    result = supabase.table("inbound_queues").insert(row).execute()
    return {"data": result.data[0] if result.data else None, "error": None}


@router.get("/inbound/{queue_id}")
async def get_inbound_queue(queue_id: str, user=Depends(get_current_user)):
    result = (
        supabase.table("inbound_queues")
        .select("*")
        .eq("id", queue_id)
        .eq("user_id", user["user_id"])
        .maybe_single()
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Queue not found")
    return {"data": result.data, "error": None}


@router.patch("/inbound/{queue_id}")
async def update_inbound_queue(queue_id: str, body: InboundQueueUpdate, user=Depends(get_current_user)):
    updates = body.model_dump(exclude_none=True)
    if not updates:
        return {"data": None, "error": "No fields to update"}

    if ("agent_id" in updates or "phone_number_id" in updates) and settings.vapi_api_key:
        existing = (
            supabase.table("inbound_queues")
            .select("agent_id, phone_number_id")
            .eq("id", queue_id)
            .eq("user_id", user["user_id"])
            .maybe_single()
            .execute()
        )
        agent_id = updates.get("agent_id") or (existing.data.get("agent_id") if existing.data else None)
        pn_id = updates.get("phone_number_id") or (existing.data.get("phone_number_id") if existing.data else None)
        if agent_id and pn_id:
            phone = supabase.table("phone_numbers").select("vapi_phone_id").eq("id", pn_id).eq("user_id", user["user_id"]).maybe_single().execute()
            agent = supabase.table("ai_agents").select("vapi_assistant_id").eq("id", agent_id).eq("user_id", user["user_id"]).maybe_single().execute()
            vapi_phone_id = phone.data.get("vapi_phone_id") if phone.data else None
            vapi_assistant_id = agent.data.get("vapi_assistant_id") if agent.data else None
            if vapi_phone_id and vapi_assistant_id:
                try:
                    await vapi_client.update_phone_number(vapi_phone_id, {"assistantId": vapi_assistant_id})
                except Exception as e:
                    raise HTTPException(status_code=502, detail=f"VAPI sync error: {str(e)}")
            supabase.table("phone_numbers").update({"agent_id": agent_id}).eq("id", pn_id).eq("user_id", user["user_id"]).execute()

    result = (
        supabase.table("inbound_queues")
        .update(updates)
        .eq("id", queue_id)
        .eq("user_id", user["user_id"])
        .execute()
    )
    return {"data": result.data[0] if result.data else None, "error": None}


@router.delete("/inbound/{queue_id}")
async def delete_inbound_queue(queue_id: str, user=Depends(get_current_user)):
    supabase.table("inbound_queues").delete().eq("id", queue_id).eq("user_id", user["user_id"]).execute()
    return {"data": None, "error": None}
