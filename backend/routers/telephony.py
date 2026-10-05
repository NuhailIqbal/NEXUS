"""Telephony API mounted at /telephony: phone numbers, BYOT Twilio credentials,
single outbound calls, outbound campaigns and inbound (AI receptionist) queues.

Every route requires an authenticated user and is scoped to the account owner
(team sub-users resolve to their owner via resolve_owner_id). Talks to Supabase
tables (phone_numbers, outbound_campaigns, inbound_queues, contacts,
conversations, ai_agents, billing, notifications, platform_settings), VAPI
(assistants, phone numbers, calls), Twilio (number purchase/release), Stripe
Checkout (low-balance number purchases) and the DNC screening service.
Also exports sync_inbound_routing_for_balance, called from routers/billing.py.
"""
import asyncio
import logging
from datetime import datetime, timezone
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
    TwilioCredentialCreate, TwilioCredentialUpdate, PhoneNumberByotCreate,
)
from services import vapi_client, twilio_service, twilio_byot_service, whitelist_service
from config import settings
from routers.billing import (
    outbound_call_block_reason,
    check_call_quota,
    get_or_create_billing,
    has_balance,
    debit_balance,
    PHONE_NUMBER_MONTHLY_COST,
    BYOT_PHONE_NUMBER_MONTHLY_COST,
)
from routers.team import resolve_owner_id

# Number of contacts screened and dialed concurrently per batch in start_campaign;
# batches themselves run one after another to cap simultaneous provider requests.
CAMPAIGN_BATCH_SIZE = 20

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/telephony", tags=["Telephony"])


def _notify_suppressed(user_id: str, campaign_id: str, campaign_name: str, count: int) -> None:
    """Tell the user numbers were skipped by DNC screening — once per campaign, not per
    number. Best-effort: a notification must never affect the campaign's outcome."""
    from routers.billing import _insert_notification

    # The campaign id is part of the kind, so the dedup lookup below is per campaign.
    kind = f"dnc_suppressed_{campaign_id}"
    try:
        already = (
            supabase.table("notifications").select("id")
            .eq("user_id", user_id).eq("kind", kind).limit(1).execute().data
        )
        if already:
            return
    except Exception:
        pass  # dedup check is an optimization, not a correctness requirement

    _insert_notification(
        user_id, kind,
        f"{count} number{'s' if count != 1 else ''} skipped in {campaign_name}",
        f"DNC/litigation screening blocked {count} number"
        f"{'s' if count != 1 else ''} in this campaign, so no call was placed to "
        f"{'them' if count != 1 else 'it'}.",
    )


# ── Inbound-call suspension on empty balance ──
# When a user's wallet balance crosses to $0, their phone numbers get temporarily
# repointed at a shared "insufficient balance" assistant, so inbound callers hear a
# short message instead of reaching the real agent. Restored automatically once the
# balance recovers. Triggered from routers/billing.py's debit_balance/credit_balance.

async def _get_or_create_fallback_assistant_id() -> str | None:
    """Lazily create (once) the shared VAPI assistant used for balance suspension,
    cached in platform_settings so every account reuses the same one."""
    if not settings.vapi_api_key:
        return None
    rows = supabase.table("platform_settings").select("fallback_assistant_id").limit(1).execute().data
    existing = rows[0].get("fallback_assistant_id") if rows else None
    if existing:
        return existing
    try:
        assistant = await vapi_client.create_assistant(vapi_client.build_fallback_assistant_payload())
    except Exception:
        logger.exception("Failed to create the shared fallback assistant")
        return None
    assistant_id = assistant.get("id")
    if not assistant_id:
        return None
    # platform_settings is a single-row table keyed id=1: update the existing row if
    # there is one, otherwise create it.
    if rows:
        supabase.table("platform_settings").update({"fallback_assistant_id": assistant_id}).eq("id", 1).execute()
    else:
        supabase.table("platform_settings").insert({"id": 1, "fallback_assistant_id": assistant_id}).execute()
    return assistant_id


async def sync_inbound_routing_for_balance(user_id: str, block: bool) -> None:
    """Repoint (block=True) or restore (block=False) every one of this user's
    VAPI-synced phone numbers between the real agent's assistant and the shared
    fallback assistant. Best-effort — a VAPI failure here must never break the
    balance update that triggered it (callers run this fire-and-forget)."""
    if not settings.vapi_api_key:
        return
    numbers = (
        supabase.table("phone_numbers")
        .select("id, vapi_phone_id, agent_id, suspended_for_balance")
        .eq("user_id", user_id)
        .execute().data or []
    )
    if not numbers:
        return

    # The fallback assistant is only needed when suspending; restoring uses each
    # number's own agent.
    fallback_id = await _get_or_create_fallback_assistant_id() if block else None

    # suspended_for_balance marks numbers this routine repointed, so that a restore
    # only touches those and a repeated suspend is a no-op.
    for n in numbers:
        vapi_phone_id = n.get("vapi_phone_id")
        if not vapi_phone_id:
            continue  # not yet synced to VAPI — nothing to repoint

        if block:
            # Already suspended, or no fallback assistant available (VAPI not configured
            # or its creation failed) — nothing to repoint to.
            if n.get("suspended_for_balance") or not fallback_id:
                continue
            try:
                await vapi_client.update_phone_number(vapi_phone_id, {"assistantId": fallback_id})
                supabase.table("phone_numbers").update({"suspended_for_balance": True}).eq("id", n["id"]).execute()
            except Exception:
                logger.exception("Failed to suspend inbound routing for phone number %s", n["id"])
        else:
            if not n.get("suspended_for_balance"):
                continue
            agent_id = n.get("agent_id")
            real_assistant_id = None
            if agent_id:
                agent = (
                    supabase.table("ai_agents").select("vapi_assistant_id")
                    .eq("id", agent_id).maybe_single().execute().data
                )
                real_assistant_id = agent.get("vapi_assistant_id") if agent else None
            if not real_assistant_id:
                continue  # no (synced) agent to restore to — leave suspended for now
            try:
                await vapi_client.update_phone_number(vapi_phone_id, {"assistantId": real_assistant_id})
                supabase.table("phone_numbers").update({"suspended_for_balance": False}).eq("id", n["id"]).execute()
            except Exception:
                logger.exception("Failed to restore inbound routing for phone number %s", n["id"])


# ── Phone Numbers ──

@router.get("/phone-numbers")
async def list_phone_numbers(user=Depends(get_current_user)):
    """List the account's phone numbers, newest first."""
    result = (
        supabase.table("phone_numbers")
        .select("*")
        .eq("user_id", resolve_owner_id(user["user_id"]))
        .order("created_at", desc=True)
        .execute()
    )
    return {"data": result.data, "error": None}


async def _resolve_assistant_id(user_id: str, agent_id: str | None) -> str | None:
    """Return the VAPI assistant id for an agent owned by user_id, or None when no agent
    was given, it isn't found/owned, or it hasn't been synced to VAPI yet."""
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
                                  stripe_session_id: str | None = None,
                                  credential_id: str | None = None, mode: str | None = None,
                                  label: str | None = None) -> dict:
    """Provision a phone number (VAPI-native, Twilio→VAPI import, or BYOT) and store the row.

    Shared by the direct create endpoint (VAPI), the post-payment confirm endpoint
    (Twilio), and the BYOT endpoint (twilio_byot).
    """
    provider = (provider or "vapi").lower()
    # Base phone_numbers row; each provider branch below adds its own fields
    # (vapi_phone_id, twilio_sid, monthly_cost, next_billing_at, ...) before inserting it.
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
    if label:
        row["label"] = label

    # Resolved up front so the number can be created in VAPI already routed to the
    # agent for inbound calls; None when no agent is given or it isn't synced yet.
    assistant_id = await _resolve_assistant_id(user_id, agent_id)

    if provider == "twilio_byot":
        # Bring-your-own-Twilio: the number lives on the user's own Twilio account.
        # get_credentials returns None for a credential that doesn't exist or belongs
        # to someone else, which doubles as the ownership check.
        creds = twilio_byot_service.get_credentials(credential_id, user_id)
        if not creds:
            raise HTTPException(status_code=404, detail="Twilio credential not found")
        account_sid, auth_token = creds

        if mode == "purchase":
            # Buys a new US number on the user's own Twilio account (not the platform's).
            try:
                purchased = await twilio_service.buy_us_number(
                    sms=True, voice=True, area_code=area_code,
                    account_sid=account_sid, auth_token=auth_token,
                )
            except Exception as e:
                raise HTTPException(status_code=502, detail=f"Twilio purchase failed: {str(e)}")
            row["number"] = purchased["number"]
            row["twilio_sid"] = purchased.get("sid")
        else:  # mode == "import": the user already owns this number
            number = (number or "").strip()
            if not number:
                raise HTTPException(status_code=400, detail="A phone number is required to import.")
            # Verify it's really on their Twilio account before attempting the VAPI import —
            # a typo (missing '+', wrong country code, extra whitespace) would otherwise only
            # surface as VAPI's generic import failure further down, with no hint of why.
            sid = await twilio_service.find_sid_by_number(number, account_sid=account_sid, auth_token=auth_token)
            if not sid:
                raise HTTPException(
                    status_code=400,
                    detail=f"{number} wasn't found on your connected Twilio account. "
                           "Check it's typed correctly, e.g. +15551234567.",
                )
            row["number"] = number
            row["twilio_sid"] = sid

        # Register the Twilio number in VAPI (using the user's own Twilio credentials) so
        # it can place and receive calls. Skipped when VAPI isn't configured, in which
        # case the row is stored without a vapi_phone_id.
        if settings.vapi_api_key:
            try:
                vapi_payload: dict = {
                    "provider": "twilio",
                    "number": row["number"],
                    "twilioAccountSid": account_sid,
                    "twilioAuthToken": auth_token,
                }
                if assistant_id:
                    vapi_payload["assistantId"] = assistant_id
                vapi_result = await vapi_client.create_phone_number(vapi_payload)
                row["vapi_phone_id"] = vapi_result.get("id")
            except Exception as e:
                logger.error("Imported %s but VAPI import failed: %s", row["number"], e)
                # mode="purchase" just spent the user's own money on a Twilio number that
                # would otherwise be left live (and billed by Twilio) with zero record of
                # it anywhere on our side — best-effort release it so they aren't stuck
                # paying for a number they can't see or manage. mode="import" never
                # purchased anything, so there's nothing to roll back.
                if mode == "purchase" and row.get("twilio_sid"):
                    try:
                        await twilio_service.release_number(
                            row["twilio_sid"], account_sid=account_sid, auth_token=auth_token,
                        )
                    except Exception:
                        logger.exception(
                            "Failed to roll back Twilio number %s (sid=%s) after a failed VAPI "
                            "import — it is still live on the user's own Twilio account",
                            row["number"], row.get("twilio_sid"),
                        )
                raise HTTPException(status_code=502, detail="Voice service error. Please try again.")

        # No charge now: the hosting fee is billed monthly by the recurring phone-billing
        # sweep, starting one month from provisioning.
        row["twilio_credential_id"] = credential_id
        row["monthly_cost"] = monthly_cost or BYOT_PHONE_NUMBER_MONTHLY_COST
        from services.phone_billing import _add_one_month
        row["next_billing_at"] = _add_one_month(datetime.now(timezone.utc)).isoformat()

        result = supabase.table("phone_numbers").insert(row).execute()
        return result.data[0] if result.data else row

    # VAPI-native number: VAPI picks and owns the number (area_code is only a preference).
    # With no VAPI key configured, a "vapi" number skips provisioning and is stored as-is.
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
            logger.error("VAPI error: %s", e)
            raise HTTPException(status_code=502, detail="Voice service error. Please try again.")

    elif provider == "twilio":
        # Platform-owned Twilio account (server credentials): buy a number, then import it
        # into VAPI. Unlike the BYOT branch, a failed VAPI import here does not release
        # the purchased Twilio number.
        if not settings.twilio_account_sid or not settings.twilio_auth_token:
            raise HTTPException(status_code=400, detail="Twilio account is not configured on the server.")
        try:
            purchased = await twilio_service.buy_us_number(sms=True, voice=True)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Twilio purchase failed: {str(e)}")
        row["number"] = purchased["number"]
        row["twilio_sid"] = purchased.get("sid")

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
                logger.error("Purchased {purchased['number']} but VAPI import failed: %s", e)
                raise HTTPException(status_code=502, detail="Voice service error. Please try again.")

        row["monthly_cost"] = monthly_cost or PHONE_NUMBER_MONTHLY_COST
        from services.phone_billing import _add_one_month
        row["next_billing_at"] = _add_one_month(datetime.now(timezone.utc)).isoformat()

    result = supabase.table("phone_numbers").insert(row).execute()
    return result.data[0] if result.data else row


def _phone_checkout_session(user, body) -> dict:
    """Create a Stripe Checkout session to pay for a Twilio number (low-balance fallback)."""
    owner_id = resolve_owner_id(user["user_id"])
    stripe.api_key = settings.stripe_secret_key
    billing = get_or_create_billing(owner_id)
    customer_id = billing.get("stripe_customer_id")
    # Lazily create the Stripe customer and cache its id on the billing row so later
    # checkouts (and the ownership check in confirm_phone_checkout) reuse it.
    if not customer_id:
        customer = stripe.Customer.create(email=user.get("email"), metadata={"user_id": owner_id})
        customer_id = customer.id
        supabase.table("billing").update({"stripe_customer_id": customer_id}).eq("user_id", owner_id).execute()

    app_base = (settings.public_app_url or "http://localhost:8080").rstrip("/")
    base = getattr(body, "success_url", None) or f"{app_base}/dashboard/telephony/phone-numbers"
    # Everything confirm_phone_checkout needs to provision the number after payment is
    # carried in the session metadata. Stripe metadata values are strings, so missing
    # values are stored as "" and turned back into None on the confirm side.
    metadata = {
        "type": "phone_number",
        "user_id": owner_id,
        "provider": "twilio",
        "area_code": body.area_code or "",
        "agent_id": body.agent_id or "",
        "status": getattr(body, "status", None) or "Active",
    }
    # AI Receptionist checkouts (InboundQueueCreate has `name`, PhoneNumberCreate doesn't)
    # also need their inbound_queues row recreated once payment completes.
    receptionist_name = getattr(body, "name", None)
    if receptionist_name:
        metadata["inbound_name"] = receptionist_name
        metadata["inbound_max_wait_seconds"] = str(getattr(body, "max_wait_seconds", None) or 120)
        metadata["inbound_overflow_action"] = getattr(body, "overflow_action", None) or "voicemail"
    # One-time payment for the first month, in cents. In the URLs below, the doubled
    # braces in the f-string produce a literal {CHECKOUT_SESSION_ID}, which Stripe
    # replaces with the real session id on redirect.
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
        metadata=metadata,
    )
    return {"checkout_url": session.url, "session_id": session.id}


@router.post("/phone-numbers")
async def create_phone_number(body: PhoneNumberCreate, user=Depends(get_current_user)):
    """Add a phone number to the account. provider "vapi" (default) creates a free
    VAPI-native number; "twilio" buys a Twilio number, paid from the wallet when the
    balance covers it, otherwise the response is {needs_payment: true, checkout_url,
    session_id} for a Stripe Checkout that is completed via /phone-numbers/confirm."""
    owner_id = resolve_owner_id(user["user_id"])
    provider = (body.provider or "vapi").lower()

    if provider == "twilio":
        # Enough balance → pay from the wallet and provision immediately.
        if has_balance(owner_id, PHONE_NUMBER_MONTHLY_COST):
            # Provision first, debit second: if the purchase fails (it raises), the
            # wallet is never charged.
            row = await _provision_phone_number(
                user_id=owner_id,
                provider="twilio",
                agent_id=body.agent_id,
                status=body.status or "Active",
                monthly_cost=PHONE_NUMBER_MONTHLY_COST,
            )
            debit_balance(
                owner_id, PHONE_NUMBER_MONTHLY_COST, "phone",
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
        user_id=owner_id,
        provider=provider,
        number=body.number,
        area_code=body.area_code,
        agent_id=body.agent_id,
        status=body.status or "Active",
    )
    return {"data": row, "error": None}


class PhoneConfirm(BaseModel):
    """Request body for /phone-numbers/confirm: the Stripe Checkout session id."""
    session_id: str


@router.post("/phone-numbers/confirm")
async def confirm_phone_checkout(body: PhoneConfirm, user=Depends(get_current_user)):
    """After Stripe payment (low-balance path): verify payment, then provision the number.

    No wallet debit here — the number was paid for directly via Stripe.
    """
    owner_id = resolve_owner_id(user["user_id"])
    if not settings.stripe_secret_key:
        raise HTTPException(status_code=503, detail="Stripe not configured")
    stripe.api_key = settings.stripe_secret_key

    # Idempotency: a given Stripe session provisions exactly one number.
    existing = (
        supabase.table("phone_numbers")
        .select("*")
        .eq("stripe_session_id", body.session_id)
        .eq("user_id", owner_id)
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
    # Ownership: metadata user_id match OR the session's Stripe customer is this user's
    # own customer (robust proof; metadata is the fallback).
    billing = get_or_create_billing(owner_id)
    session_customer = getattr(session, "customer", None)
    owns = (
        meta.get("user_id") == owner_id
        or (session_customer and session_customer == billing.get("stripe_customer_id"))
    )
    if not owns:
        logger.warning(
            "confirm_phone_checkout ownership mismatch: session=%s meta_user=%s current_owner=%s "
            "session_customer=%s billing_customer=%s",
            body.session_id, meta.get("user_id"), owner_id,
            session_customer, billing.get("stripe_customer_id"),
        )
        raise HTTPException(status_code=403, detail="This checkout session does not belong to you")
    if session.payment_status != "paid":
        raise HTTPException(status_code=402, detail="Payment not completed")

    row = await _provision_phone_number(
        user_id=owner_id,
        provider="twilio",
        area_code=meta.get("area_code") or None,
        agent_id=meta.get("agent_id") or None,
        status=meta.get("status") or "Active",
        monthly_cost=PHONE_NUMBER_MONTHLY_COST,
        stripe_session_id=body.session_id,
    )
    # AI Receptionist checkout (low-balance path) — recreate the receptionist row now
    # that the number is actually provisioned; see _phone_checkout_session.
    if meta.get("inbound_name"):
        supabase.table("inbound_queues").insert({
            "user_id": owner_id,
            "name": meta["inbound_name"],
            "agent_id": meta.get("agent_id") or None,
            "phone_number_id": row.get("id"),
            "max_wait_seconds": int(meta.get("inbound_max_wait_seconds") or 120),
            "overflow_action": meta.get("inbound_overflow_action") or "voicemail",
            "status": "Active",
        }).execute()
    return {"data": row, "error": None}


# ── BYOT (Bring Your Own Twilio) ──

@router.get("/twilio-credentials")
async def list_twilio_credentials(user=Depends(get_current_user)):
    """List the account's saved Twilio (BYOT) credentials. The auth token is never
    returned; each entry carries only a masked version."""
    owner_id = resolve_owner_id(user["user_id"])
    return {"data": twilio_byot_service.list_credentials(owner_id), "error": None}


@router.post("/twilio-credentials")
async def create_twilio_credential(body: TwilioCredentialCreate, user=Depends(get_current_user)):
    """Save the user's own Twilio Account SID and Auth Token. The pair is validated
    against Twilio first and stored encrypted; responds 400 if it is rejected or
    can't be verified."""
    owner_id = resolve_owner_id(user["user_id"])
    try:
        row = await twilio_byot_service.save_credentials(
            owner_id, body.account_sid, body.auth_token, body.label,
        )
    except twilio_byot_service.InvalidTwilioCredentials as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"data": row, "error": None}


@router.patch("/twilio-credentials/{credential_id}")
async def update_twilio_credential(credential_id: str, body: TwilioCredentialUpdate, user=Depends(get_current_user)):
    """Partially update a saved Twilio credential (SID, token and/or label). Changing
    the SID or token re-validates against Twilio; 400 if invalid, 404 if the
    credential doesn't exist or isn't owned by this account."""
    owner_id = resolve_owner_id(user["user_id"])
    try:
        row = await twilio_byot_service.update_credentials(
            credential_id, owner_id,
            account_sid=body.account_sid, auth_token=body.auth_token, label=body.label,
        )
    except twilio_byot_service.InvalidTwilioCredentials as e:
        raise HTTPException(status_code=400, detail=str(e))
    if row is None:
        raise HTTPException(status_code=404, detail="Twilio credential not found")
    return {"data": row, "error": None}


@router.delete("/twilio-credentials/{credential_id}")
async def delete_twilio_credential(credential_id: str, user=Depends(get_current_user)):
    """Delete a saved Twilio credential. Responds 400 if a phone number still uses it."""
    owner_id = resolve_owner_id(user["user_id"])
    try:
        twilio_byot_service.delete_credentials(credential_id, owner_id)
    except twilio_byot_service.CredentialInUse as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"data": None, "error": None}


@router.post("/phone-numbers/byot")
async def create_byot_phone_number(body: PhoneNumberByotCreate, user=Depends(get_current_user)):
    """BYOT numbers skip the wallet-debit/Stripe-checkout path entirely — there's no
    upfront charge. The $1/month hosting fee is billed by the same recurring sweep
    that bills platform Twilio numbers (services/phone_billing.py), just at the lower
    BYOT rate, since the user already pays Twilio directly for the number itself."""
    owner_id = resolve_owner_id(user["user_id"])
    mode = (body.mode or "").lower()
    if mode not in ("import", "purchase"):
        raise HTTPException(status_code=400, detail="mode must be 'import' or 'purchase'")
    if mode == "import" and not body.number:
        raise HTTPException(status_code=400, detail="number is required for mode='import'")

    row = await _provision_phone_number(
        user_id=owner_id,
        provider="twilio_byot",
        number=body.number,
        area_code=body.area_code,
        agent_id=body.agent_id,
        status=body.status or "Active",
        monthly_cost=BYOT_PHONE_NUMBER_MONTHLY_COST,
        credential_id=body.credential_id,
        mode=mode,
        label=body.label,
    )
    return {"data": row, "error": None}


@router.patch("/phone-numbers/{number_id}")
async def update_phone_number(number_id: str, body: PhoneNumberUpdate, user=Depends(get_current_user)):
    """Update a phone number's agent assignment and/or status. When the agent changes
    (including unassigning it), the number's VAPI routing is updated first, so inbound
    calls reach the new agent; a VAPI failure aborts the update with a 502."""
    owner_id = resolve_owner_id(user["user_id"])
    # model_fields_set tells an explicit agent_id of null (unassign) apart from the
    # field being omitted; exclude_none below cannot.
    agent_cleared = "agent_id" in body.model_fields_set and not body.agent_id
    updates = body.model_dump(exclude_none=True)
    if agent_cleared:
        # Unassigning an agent (clearing inbound routing) is a legitimate update, but
        # exclude_none=True above would otherwise drop it entirely — and agent_id is a
        # uuid column, so it must become a real NULL here, never "" (Postgres rejects
        # an empty string for uuid).
        updates["agent_id"] = None
    if not updates:
        return {"data": None, "error": "No fields to update"}

    # Mirror the agent change onto the VAPI phone number (only if it was ever synced to
    # VAPI). An agent without a vapi_assistant_id leaves the payload empty: there is no
    # assistantId to push.
    if "agent_id" in updates and settings.vapi_api_key:
        existing = (
            supabase.table("phone_numbers")
            .select("vapi_phone_id")
            .eq("id", number_id)
            .eq("user_id", owner_id)
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
                    .eq("user_id", owner_id)
                    .maybe_single()
                    .execute()
                )
                if agent.data and agent.data.get("vapi_assistant_id"):
                    vapi_update["assistantId"] = agent.data["vapi_assistant_id"]
            else:
                # Unassigned: clear the assistant on VAPI so the number stops answering
                # with the old agent.
                vapi_update["assistantId"] = None
            try:
                await vapi_client.update_phone_number(vapi_phone_id, vapi_update)
            except Exception as e:
                logger.error("VAPI sync error: %s", e)
                raise HTTPException(status_code=502, detail="Voice service error. Please try again.")

    result = (
        supabase.table("phone_numbers")
        .update(updates)
        .eq("id", number_id)
        .eq("user_id", owner_id)
        .execute()
    )
    return {"data": result.data[0] if result.data else None, "error": None}


@router.delete("/phone-numbers/{number_id}")
async def release_phone_number(number_id: str, user=Depends(get_current_user)):
    """Delete a phone number: remove its VAPI import (best-effort), release a
    platform-purchased Twilio number on Twilio so it stops billing, then delete the
    row. BYOT numbers are never released on the user's Twilio account. Returns
    success even if the number doesn't exist or isn't owned by this account."""
    owner_id = resolve_owner_id(user["user_id"])
    existing = (
        supabase.table("phone_numbers")
        .select("provider, number, twilio_sid, vapi_phone_id")
        .eq("id", number_id)
        .eq("user_id", owner_id)
        .maybe_single()
        .execute()
    )
    if existing.data and existing.data.get("vapi_phone_id") and settings.vapi_api_key:
        # Best-effort: a VAPI failure must not block deleting our own record.
        try:
            await vapi_client.delete_phone_number(existing.data["vapi_phone_id"])
        except Exception:
            pass
    # BYOT: the Twilio number belongs to the user's own account, not ours — we only
    # ever remove our own VAPI import + database row, never touch their Twilio account.
    if existing.data and (existing.data.get("provider") or "").lower() == "twilio":
        # Deleting our record must not silently leave a real Twilio number live —
        # Twilio bills it monthly forever otherwise, regardless of whether it's used
        # for inbound or outbound. twilio_sid may be missing on numbers purchased
        # before this was tracked, so fall back to a lookup by the number itself.
        sid = existing.data.get("twilio_sid")
        if not sid and existing.data.get("number"):
            try:
                sid = await twilio_service.find_sid_by_number(existing.data["number"])
            except Exception:
                logger.exception(
                    "Twilio sid lookup failed for number %s (%s) on delete — release skipped, "
                    "it will keep billing on Twilio until released manually",
                    number_id, existing.data["number"],
                )
                sid = None
            if not sid:
                logger.warning(
                    "No Twilio sid found for number %s (%s) on delete — release skipped, "
                    "it will keep billing on Twilio until released manually",
                    number_id, existing.data["number"],
                )
        if sid:
            try:
                await twilio_service.release_number(sid)
            except Exception:
                logger.exception("Failed to release Twilio number %s (sid=%s) on delete", number_id, sid)
    supabase.table("phone_numbers").delete().eq("id", number_id).eq("user_id", owner_id).execute()
    return {"data": None, "error": None}


# ── Outbound Call (single) ──

@router.post("/call")
async def make_outbound_call(body: OutboundCallCreate, user=Depends(get_current_user)):
    """Place one outbound call to a phone number with the given agent, optionally from
    one of the account's own phone numbers. Rejected if the account is blocked
    (including trial accounts), the wallet balance is empty, or the number fails DNC
    screening. Returns the VAPI call id and initial status; the call is billed when it
    ends, not here."""
    owner_id = resolve_owner_id(user["user_id"])
    if not settings.vapi_api_key:
        raise HTTPException(status_code=503, detail="Voice service not configured")

    billing = get_or_create_billing(owner_id)
    block_reason = outbound_call_block_reason(billing)
    if block_reason:
        raise HTTPException(status_code=403, detail=block_reason)
    # Outbound calls require a positive wallet balance (checked before dialing).
    if not check_call_quota(owner_id, "outbound"):
        raise HTTPException(status_code=402, detail="Your balance is empty. Add funds to keep making calls.")

    # DNC/litigation screening. No-op unless the user has an Active WhitelistData
    # integration; when they do, an unavailable check blocks the call rather than
    # risking a call to a suppressed number.
    screen = await whitelist_service.check_number(owner_id, body.phone_number)
    if not screen["allowed"]:
        raise HTTPException(status_code=403, detail=screen["reason"] or "This number is suppressed.")

    agent = (
        supabase.table("ai_agents")
        .select("vapi_assistant_id")
        .eq("id", body.agent_id)
        .eq("user_id", owner_id)
        .maybe_single()
        .execute()
    )
    if not agent.data or not agent.data.get("vapi_assistant_id"):
        raise HTTPException(status_code=404, detail="Agent not found or not set up for calls")

    call_payload = {
        "assistantId": agent.data["vapi_assistant_id"],
        "customer": {"number": body.phone_number},
    }

    # Caller-ID number: only attached when it belongs to this account and is synced to
    # VAPI; otherwise phoneNumberId is simply left out of the payload.
    if body.phone_number_id:
        phone = (
            supabase.table("phone_numbers")
            .select("vapi_phone_id")
            .eq("id", body.phone_number_id)
            .eq("user_id", owner_id)
            .maybe_single()
            .execute()
        )
        if phone.data and phone.data.get("vapi_phone_id"):
            call_payload["phoneNumberId"] = phone.data["vapi_phone_id"]

    try:
        vapi_result = await vapi_client.create_call(call_payload)
    except Exception as e:
        logger.error("VAPI call error: %s", e)
        raise HTTPException(status_code=502, detail="Voice service error. Please try again.")

    return {"data": {"vapi_call_id": vapi_result.get("id"), "status": vapi_result.get("status", "queued")}, "error": None}


@router.get("/call/{vapi_call_id}/status")
async def get_call_status(vapi_call_id: str, user=Depends(get_current_user)):
    """Poll VAPI directly for a call's live status (queued/ringing/in-progress/ended…),
    used by the test-call dialer to reflect real progress instead of a static 'queued'."""
    if not settings.vapi_api_key:
        raise HTTPException(status_code=503, detail="Voice service not configured")
    try:
        call = await vapi_client.get_call(vapi_call_id)
    except Exception as e:
        logger.error("VAPI call error: %s", e)
        raise HTTPException(status_code=502, detail="Voice service error. Please try again.")

    return {
        "data": {
            "status": call.get("status"),
            "ended_reason": call.get("endedReason"),
            "started_at": call.get("startedAt"),
            "ended_at": call.get("endedAt"),
        },
        "error": None,
    }


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

    # Two queries load all of the account's contacts and conversations once, instead of
    # querying per campaign; campaigns are then matched in memory by list_id.
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
    # A Completed conversation counts toward a contact either by contact_id or, for
    # calls logged without one, by phone number (compared via _phone_key).
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
    """List the account's outbound campaigns, newest first, each with live
    contacts_count and completed_count progress figures."""
    owner_id = resolve_owner_id(user["user_id"])
    result = (
        supabase.table("outbound_campaigns")
        .select("*")
        .eq("user_id", owner_id)
        .order("created_at", desc=True)
        .execute()
    )
    campaigns = result.data or []
    _enrich_campaign_progress(owner_id, campaigns)
    return {"data": campaigns, "error": None}


@router.post("/campaigns")
async def create_campaign(body: CampaignCreate, user=Depends(get_current_user)):
    """Create an outbound campaign (it does not start dialing until /start is called).
    If a contact list is assigned, the current contact count is stored on the row."""
    owner_id = resolve_owner_id(user["user_id"])
    row = body.model_dump()
    row["user_id"] = owner_id

    if body.list_id:
        contacts = (
            supabase.table("contacts")
            .select("id", count="exact")
            .eq("user_id", owner_id)
            .eq("list_id", body.list_id)
            .execute()
        )
        row["contacts_count"] = contacts.count or 0

    result = supabase.table("outbound_campaigns").insert(row).execute()
    return {"data": result.data[0] if result.data else None, "error": None}


@router.get("/campaigns/{campaign_id}")
async def get_campaign(campaign_id: str, user=Depends(get_current_user)):
    """Fetch one campaign with live progress figures; 404 if it isn't this account's."""
    owner_id = resolve_owner_id(user["user_id"])
    result = (
        supabase.table("outbound_campaigns")
        .select("*")
        .eq("id", campaign_id)
        .eq("user_id", owner_id)
        .maybe_single()
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Campaign not found")
    camp = result.data
    _enrich_campaign_progress(owner_id, [camp])
    return {"data": camp, "error": None}


@router.patch("/campaigns/{campaign_id}")
async def update_campaign(campaign_id: str, body: CampaignUpdate, user=Depends(get_current_user)):
    """Partially update a campaign (only the fields sent). Returns data null when
    nothing was sent or the campaign isn't this account's."""
    updates = body.model_dump(exclude_none=True)
    if not updates:
        return {"data": None, "error": "No fields to update"}
    result = (
        supabase.table("outbound_campaigns")
        .update(updates)
        .eq("id", campaign_id)
        .eq("user_id", resolve_owner_id(user["user_id"]))
        .execute()
    )
    return {"data": result.data[0] if result.data else None, "error": None}


@router.delete("/campaigns/{campaign_id}")
async def delete_campaign(campaign_id: str, user=Depends(get_current_user)):
    """Delete one of the account's campaigns. Returns success even if it doesn't exist."""
    supabase.table("outbound_campaigns").delete().eq("id", campaign_id).eq("user_id", resolve_owner_id(user["user_id"])).execute()
    return {"data": None, "error": None}


@router.post("/campaigns/{campaign_id}/start")
async def start_campaign(campaign_id: str, user=Depends(get_current_user)):
    """Start a campaign by placing a VAPI call to every contact with a phone number in
    its list, using the campaign's agent and phone number.

    Fails with 4xx if the campaign is missing, its agent/list/phone number isn't set up,
    the account is blocked, the balance is empty or the list has no dialable contacts.
    Contacts are dialed in concurrent batches within this single request; a failed dial
    or a DNC-suppressed number is recorded and skipped, never aborting the run.

    Side effects: sets the campaign to Active (and refreshes contacts_count), and sends
    one DNC-suppression notification if any numbers were skipped. Returns dialed/error/
    suppressed counts plus up to 5 sample errors and suppressed numbers.
    """
    owner_id = resolve_owner_id(user["user_id"])
    campaign = (
        supabase.table("outbound_campaigns")
        .select("*")
        .eq("id", campaign_id)
        .eq("user_id", owner_id)
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
        raise HTTPException(status_code=400, detail="Campaign agent is not set up for calls")

    billing = get_or_create_billing(owner_id)
    block_reason = outbound_call_block_reason(billing)
    if block_reason:
        raise HTTPException(status_code=403, detail=block_reason)
    # The balance is checked once here, before any dialing; it is not re-checked
    # per call while the batches run.
    if not check_call_quota(owner_id, "outbound"):
        raise HTTPException(status_code=402, detail="Your balance is empty. Add funds to keep making calls.")

    if not camp.get("list_id"):
        raise HTTPException(status_code=400, detail="Campaign has no contact list assigned. Edit the campaign and select a list.")

    if not camp.get("phone_number_id"):
        raise HTTPException(status_code=400, detail="Campaign has no phone number assigned. Edit the campaign and select a phone number to call from.")

    contacts = (
        supabase.table("contacts")
        .select("name, phone")
        .eq("user_id", owner_id)
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
        raise HTTPException(status_code=400, detail="The campaign's phone number is not active yet. Wait for activation or re-provision the number.")

    # Per-campaign opt-out: the account-wide WhitelistData status (Integrations page) still
    # gates whether screening is even possible, but a campaign can additionally choose not
    # to apply it — e.g. a list the user has already manually vetted.
    campaign_dnc_enabled = camp.get("dnc_screening_enabled", True)

    async def dial_contact(contact, cached_verdict=None):
        """Screen (when enabled) and dial one contact, returning a result dict instead
        of raising for dial failures: {"success": True, "phone"} on success;
        {"success": False, "suppressed": True, "phone", "error"} when DNC screening
        blocked it; {"success": False, "phone", "error"} when the VAPI call failed.

        `cached_verdict` is a suppression verdict pre-fetched for the batch (or None to
        let check_number look it up itself).
        """
        # Screen before dialing. A suppressed (or unverifiable) number is skipped, and the
        # loop below carries on with the rest of the list — matching how a failed dial is
        # already handled, rather than aborting the whole campaign.
        if campaign_dnc_enabled:
            screen = await whitelist_service.check_number(
                owner_id, contact["phone"], cached=cached_verdict
            )
            if not screen["allowed"]:
                return {
                    "success": False,
                    "suppressed": True,
                    "phone": contact["phone"],
                    "error": screen["reason"] or "Suppressed",
                }

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
    suppressed = []
    errors = []
    all_contacts = contacts.data
    for i in range(0, len(all_contacts), CAMPAIGN_BATCH_SIZE):
        batch = all_contacts[i:i + CAMPAIGN_BATCH_SIZE]
        # One cache read for the whole batch, so only unscreened numbers reach the provider.
        # Skipped entirely when this campaign has opted out of DNC screening.
        if campaign_dnc_enabled:
            keys = [whitelist_service.normalize_phone(c["phone"]) for c in batch]
            cached = whitelist_service.cache_get_many(owner_id, [k for k in keys if k])
        else:
            keys = [None] * len(batch)
            cached = {}
        # keys stays index-aligned with batch (entries may be None for unreadable
        # numbers), so zip pairs each contact with its own cached verdict. Contacts in a
        # batch run concurrently; the next batch starts only after this one finishes.
        results = await asyncio.gather(*[
            dial_contact(c, cached.get(k)) for c, k in zip(batch, keys)
        ])
        for r in results:
            if r["success"]:
                dialed += 1
            elif r.get("suppressed"):
                suppressed.append({"phone": r["phone"], "reason": r.get("error", "Suppressed")})
            else:
                errors.append({"phone": r["phone"], "error": r.get("error", "unknown")})

    # contacts_count is reset to the number of dialable contacts (those with a phone),
    # which can be lower than the list size stored when the campaign was created.
    supabase.table("outbound_campaigns").update({
        "status": "Active",
        "contacts_count": len(contacts.data),
    }).eq("id", campaign_id).execute()

    if suppressed:
        _notify_suppressed(owner_id, campaign_id, camp.get("name") or "Campaign", len(suppressed))

    return {
        "data": {
            "dialed": dialed,
            "errors": len(errors),
            "error_details": errors[:5],
            "suppressed": len(suppressed),
            "suppressed_details": suppressed[:5],
        },
        "error": None,
    }


@router.post("/campaigns/{campaign_id}/pause")
async def pause_campaign(campaign_id: str, user=Depends(get_current_user)):
    """Mark the campaign Paused. Only updates the stored status; calls already placed
    by /start are not interrupted. Succeeds even if the campaign isn't found."""
    supabase.table("outbound_campaigns").update({"status": "Paused"}).eq("id", campaign_id).eq("user_id", resolve_owner_id(user["user_id"])).execute()
    return {"data": {"status": "Paused"}, "error": None}


@router.post("/campaigns/{campaign_id}/resume")
async def resume_campaign(campaign_id: str, user=Depends(get_current_user)):
    """Mark the campaign Active again. Only updates the stored status; it does not
    place any calls (use /start for that). Succeeds even if the campaign isn't found."""
    supabase.table("outbound_campaigns").update({"status": "Active"}).eq("id", campaign_id).eq("user_id", resolve_owner_id(user["user_id"])).execute()
    return {"data": {"status": "Active"}, "error": None}


# ── Inbound Queues ──

@router.get("/inbound")
async def list_inbound_queues(user=Depends(get_current_user)):
    """List the account's inbound queues (AI receptionists), newest first."""
    result = (
        supabase.table("inbound_queues")
        .select("*")
        .eq("user_id", resolve_owner_id(user["user_id"]))
        .order("created_at", desc=True)
        .execute()
    )
    return {"data": result.data, "error": None}


@router.post("/inbound")
async def create_inbound_queue(body: InboundQueueCreate, user=Depends(get_current_user)):
    """Create an inbound queue (AI receptionist) that answers a phone number with an
    agent. Requires VAPI and an agent already synced to VAPI. With phone_number_id, that
    existing number is pointed at the agent; otherwise a new Twilio number is bought
    (from the wallet, or via Stripe Checkout when the balance is too low, in which case
    no queue row is created until /phone-numbers/confirm)."""
    owner_id = resolve_owner_id(user["user_id"])
    if not settings.vapi_api_key:
        raise HTTPException(status_code=503, detail="Voice service not configured")
    if not body.agent_id:
        raise HTTPException(status_code=400, detail="agent_id is required")

    agent = (
        supabase.table("ai_agents")
        .select("vapi_assistant_id")
        .eq("id", body.agent_id)
        .eq("user_id", owner_id)
        .maybe_single()
        .execute()
    )
    if not agent.data or not agent.data.get("vapi_assistant_id"):
        raise HTTPException(status_code=400, detail="Agent not found or not synced")
    vapi_assistant_id = agent.data["vapi_assistant_id"]

    phone_number_id = body.phone_number_id

    if phone_number_id:
        phone = (
            supabase.table("phone_numbers")
            .select("vapi_phone_id")
            .eq("id", phone_number_id)
            .eq("user_id", owner_id)
            .maybe_single()
            .execute()
        )
        if not phone.data or not phone.data.get("vapi_phone_id"):
            raise HTTPException(status_code=400, detail="Phone number not found or not provisioned")
        try:
            await vapi_client.update_phone_number(phone.data["vapi_phone_id"], {"assistantId": vapi_assistant_id})
        except Exception as e:
            logger.error("VAPI error assigning agent: %s", e)
            raise HTTPException(status_code=502, detail="Voice service error. Please try again.")
        supabase.table("phone_numbers").update({"agent_id": body.agent_id}).eq("id", phone_number_id).eq("user_id", owner_id).execute()
    else:
        # A brand-new receptionist number is always a paid Twilio number — matches the
        # platform's outbound convention (Twilio, never a free VAPI-native number).
        if not settings.twilio_account_sid or not settings.twilio_auth_token:
            raise HTTPException(status_code=400, detail="Twilio account is not configured on the server.")
        if has_balance(owner_id, PHONE_NUMBER_MONTHLY_COST):
            # Provision first, debit second, so a failed purchase never charges the wallet.
            pn_row = await _provision_phone_number(
                user_id=owner_id, provider="twilio", agent_id=body.agent_id,
                status="Active", monthly_cost=PHONE_NUMBER_MONTHLY_COST,
            )
            debit_balance(
                owner_id, PHONE_NUMBER_MONTHLY_COST, "phone",
                f"Phone number {pn_row.get('number')}", ref_id=pn_row.get("id"),
            )
            phone_number_id = pn_row["id"]
        else:
            # Low balance → send the user to Stripe checkout, same as the Phone Numbers
            # page. The receptionist row itself is created after payment confirms
            # (see confirm_phone_checkout), since there's no number yet to attach it to.
            if not settings.stripe_secret_key:
                raise HTTPException(status_code=402, detail="Insufficient balance and Stripe is not configured.")
            checkout = _phone_checkout_session(user, body)
            return {"data": {"needs_payment": True, **checkout}, "error": None}

    # area_code and success_url only drive number purchase / Stripe checkout; they are
    # not inbound_queues columns, so they are left out of the inserted row.
    row = body.model_dump(exclude={"area_code", "success_url"})
    row["user_id"] = owner_id
    row["phone_number_id"] = phone_number_id

    result = supabase.table("inbound_queues").insert(row).execute()
    return {"data": result.data[0] if result.data else None, "error": None}


@router.get("/inbound/{queue_id}")
async def get_inbound_queue(queue_id: str, user=Depends(get_current_user)):
    """Fetch one inbound queue; 404 if it isn't this account's."""
    result = (
        supabase.table("inbound_queues")
        .select("*")
        .eq("id", queue_id)
        .eq("user_id", resolve_owner_id(user["user_id"]))
        .maybe_single()
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Queue not found")
    return {"data": result.data, "error": None}


@router.patch("/inbound/{queue_id}")
async def update_inbound_queue(queue_id: str, body: InboundQueueUpdate, user=Depends(get_current_user)):
    """Partially update an inbound queue. When its agent or phone number changes, the
    number's VAPI routing and its phone_numbers.agent_id are updated to match; a VAPI
    failure aborts with a 502. Returns data null when nothing was sent."""
    owner_id = resolve_owner_id(user["user_id"])
    updates = body.model_dump(exclude_none=True)
    if not updates:
        return {"data": None, "error": "No fields to update"}

    if ("agent_id" in updates or "phone_number_id" in updates) and settings.vapi_api_key:
        existing = (
            supabase.table("inbound_queues")
            .select("agent_id, phone_number_id")
            .eq("id", queue_id)
            .eq("user_id", owner_id)
            .maybe_single()
            .execute()
        )
        # Use the new value when one was sent, else fall back to what the queue already
        # has, so changing only the agent (or only the number) still re-syncs the pair.
        agent_id = updates.get("agent_id") or (existing.data.get("agent_id") if existing.data else None)
        pn_id = updates.get("phone_number_id") or (existing.data.get("phone_number_id") if existing.data else None)
        if agent_id and pn_id:
            phone = supabase.table("phone_numbers").select("vapi_phone_id").eq("id", pn_id).eq("user_id", owner_id).maybe_single().execute()
            agent = supabase.table("ai_agents").select("vapi_assistant_id").eq("id", agent_id).eq("user_id", owner_id).maybe_single().execute()
            vapi_phone_id = phone.data.get("vapi_phone_id") if phone.data else None
            vapi_assistant_id = agent.data.get("vapi_assistant_id") if agent.data else None
            if vapi_phone_id and vapi_assistant_id:
                try:
                    await vapi_client.update_phone_number(vapi_phone_id, {"assistantId": vapi_assistant_id})
                except Exception as e:
                    logger.error("VAPI sync error: %s", e)
                    raise HTTPException(status_code=502, detail="Voice service error. Please try again.")
            # The local phone_numbers.agent_id is updated even when the VAPI push above
            # was skipped (number or agent not yet synced to VAPI).
            supabase.table("phone_numbers").update({"agent_id": agent_id}).eq("id", pn_id).eq("user_id", owner_id).execute()

    result = (
        supabase.table("inbound_queues")
        .update(updates)
        .eq("id", queue_id)
        .eq("user_id", owner_id)
        .execute()
    )
    return {"data": result.data[0] if result.data else None, "error": None}


@router.delete("/inbound/{queue_id}")
async def delete_inbound_queue(queue_id: str, user=Depends(get_current_user)):
    """Deleting a receptionist must also unassign its number — otherwise the number
    keeps answering calls with the old agent (and the Phone Numbers page keeps
    showing it as "Inbound") even though the receptionist itself is gone."""
    owner_id = resolve_owner_id(user["user_id"])
    queue = (
        supabase.table("inbound_queues")
        .select("phone_number_id")
        .eq("id", queue_id)
        .eq("user_id", owner_id)
        .maybe_single()
        .execute()
    )
    phone_number_id = queue.data.get("phone_number_id") if queue.data else None

    supabase.table("inbound_queues").delete().eq("id", queue_id).eq("user_id", owner_id).execute()

    if phone_number_id:
        phone = (
            supabase.table("phone_numbers")
            .select("vapi_phone_id")
            .eq("id", phone_number_id)
            .eq("user_id", owner_id)
            .maybe_single()
            .execute()
        )
        if phone.data and phone.data.get("vapi_phone_id") and settings.vapi_api_key:
            try:
                await vapi_client.update_phone_number(phone.data["vapi_phone_id"], {"assistantId": None})
            except Exception:
                logger.exception("Failed to clear VAPI assistant for phone number %s on receptionist delete", phone_number_id)
        supabase.table("phone_numbers").update({"agent_id": None}).eq("id", phone_number_id).eq("user_id", owner_id).execute()

    return {"data": None, "error": None}
