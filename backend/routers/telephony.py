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
import uuid
from datetime import datetime, timedelta, timezone
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
from services import vapi_client, twilio_service, twilio_byot_service, carriers, whitelist_service, caller_verification, call_hours
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
        .select("id, vapi_phone_id, agent_id, suspended_for_balance, caller_verification_enabled, answer_hours_enabled")
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
    for listed in numbers:
        # Each number is handled under its routing lock and re-read inside it: the list above can
        # be seconds old (the fallback assistant may just have been created, and every push below
        # is a round trip), and a toggle or settings save running at the same moment must not
        # interleave with this and leave VAPI and the database disagreeing.
        async with caller_verification.routing_lock(listed["id"]):
            n = (
                supabase.table("phone_numbers")
                .select("id, vapi_phone_id, agent_id, suspended_for_balance, caller_verification_enabled, answer_hours_enabled")
                .eq("id", listed["id"]).maybe_single().execute().data
            )
            if not n:
                continue  # released meanwhile
            vapi_phone_id = n.get("vapi_phone_id")
            if not vapi_phone_id:
                continue  # not yet synced to VAPI — nothing to repoint

            if caller_verification.server_routed(n):
                # A server-routed number (caller verification or answering hours on) has no assistant
                # in VAPI to swap: our server picks one per call and serves the fallback assistant
                # while this flag is set (see services/caller_verification.py). Only the flag needs
                # to follow the balance.
                if bool(n.get("suspended_for_balance")) != block:
                    supabase.table("phone_numbers").update({"suspended_for_balance": block}).eq("id", n["id"]).execute()
                continue

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
    """List the account's phone numbers, newest first. Each row also carries `answer_hours_state`
    (see services/call_hours.state): whether its answering hours are on, open right now, and when
    they next open."""
    result = (
        supabase.table("phone_numbers")
        .select("*")
        .eq("user_id", resolve_owner_id(user["user_id"]))
        .order("created_at", desc=True)
        .execute()
    )
    rows = result.data or []
    now = datetime.now(timezone.utc)
    for row in rows:
        row["answer_hours_state"] = call_hours.state(row, call_hours.NUMBER, now, if_unreadable=True)
    return {"data": rows, "error": None}


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
    (Twilio), and the BYOT endpoint (twilio_byot / vonage_byot / telnyx_byot).
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

    if provider.endswith("_byot"):
        # Bring-your-own-carrier (twilio_byot / vonage_byot / telnyx_byot): the number lives
        # on the user's own carrier account. get_credential_record returns None for a
        # credential that doesn't exist or belongs to someone else, which doubles as the
        # ownership check; it must also belong to the carrier this provider names.
        carrier = provider[: -len("_byot")]
        record = twilio_byot_service.get_credential_record(credential_id, user_id)
        if not record or record["carrier"] != carrier:
            raise HTTPException(status_code=404, detail="Carrier account not found")
        label_name = carriers.spec(carrier).label
        identifier, secret = record["identifier"], record["secret"]

        if mode == "purchase":
            # Buys a new US number on the user's own carrier account (not the platform's).
            try:
                purchased = await carriers.buy_number(carrier, identifier, secret, area_code=area_code)
            except Exception as e:
                raise HTTPException(status_code=502, detail=f"{label_name} purchase failed: {str(e)}")
            row["number"] = purchased["number"]
            row["twilio_sid"] = purchased.get("ref")
        else:  # mode == "import": the user already owns this number
            number = (number or "").strip()
            if not number:
                raise HTTPException(status_code=400, detail="A phone number is required to import.")
            number = carriers.normalize_number(carrier, number)
            # Verify it's really on their carrier account before attempting the VAPI import —
            # a typo (missing '+', wrong country code, extra whitespace) would otherwise only
            # surface as VAPI's generic import failure further down, with no hint of why.
            ref = await carriers.find_number(carrier, number, identifier, secret)
            if not ref:
                raise HTTPException(
                    status_code=400,
                    detail=f"{number} wasn't found on your connected {label_name} account. "
                           "Check it's typed correctly, e.g. +15551234567.",
                )
            row["number"] = number
            row["twilio_sid"] = ref

        # Register the number in VAPI (Twilio inline with the user's own keys; Vonage/Telnyx
        # via the VAPI credential created when the account was connected) so it can place
        # and receive calls. Skipped when VAPI isn't configured, in which case the row is
        # stored without a vapi_phone_id.
        if settings.vapi_api_key:
            try:
                vapi_payload: dict = carriers.vapi_phone_payload(
                    carrier, row["number"], identifier, secret, record["vapi_credential_id"],
                )
                if assistant_id:
                    vapi_payload["assistantId"] = assistant_id
                vapi_result = await vapi_client.create_phone_number(vapi_payload)
                row["vapi_phone_id"] = vapi_result.get("id")
            except Exception as e:
                logger.error("Imported %s but VAPI import failed: %s", row["number"], e)
                # mode="purchase" just spent the user's own money on a number that would
                # otherwise be left live (and billed by the carrier) with zero record of
                # it anywhere on our side — best-effort release it so they aren't stuck
                # paying for a number they can't see or manage. mode="import" never
                # purchased anything, so there's nothing to roll back.
                if mode == "purchase":
                    try:
                        await carriers.release_number(
                            carrier, row["number"], row["twilio_sid"], identifier, secret,
                        )
                    except Exception:
                        logger.exception(
                            "Failed to roll back %s number %s (ref=%s) after a failed VAPI "
                            "import — it is still live on the user's own %s account",
                            label_name, row["number"], row.get("twilio_sid"), label_name,
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
    if provider.endswith("_byot"):
        # Bring-your-own-carrier numbers have their own endpoint (credential + mode required).
        raise HTTPException(status_code=400, detail="Use the bring-your-own-account endpoint for this provider.")

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
    """List the account's saved carrier (Twilio / Vonage / Telnyx BYOT) credentials. The
    secret is never returned; each entry carries only a masked version."""
    owner_id = resolve_owner_id(user["user_id"])
    return {"data": twilio_byot_service.list_credentials(owner_id), "error": None}


@router.post("/twilio-credentials")
async def create_twilio_credential(body: TwilioCredentialCreate, user=Depends(get_current_user)):
    """Save the user's own carrier account (body.carrier: twilio, vonage or telnyx).
    The credentials are validated against the carrier first and stored encrypted;
    responds 400 if they are rejected or can't be verified."""
    owner_id = resolve_owner_id(user["user_id"])
    try:
        row = await twilio_byot_service.save_credentials(
            owner_id, body.account_sid, body.auth_token, body.label, carrier=body.carrier,
        )
    except twilio_byot_service.InvalidTwilioCredentials as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"data": row, "error": None}


@router.patch("/twilio-credentials/{credential_id}")
async def update_twilio_credential(credential_id: str, body: TwilioCredentialUpdate, user=Depends(get_current_user)):
    """Partially update a saved carrier credential (identifier, secret and/or label).
    Changing the identifier or secret re-validates against the carrier; 400 if invalid,
    404 if the credential doesn't exist or isn't owned by this account."""
    owner_id = resolve_owner_id(user["user_id"])
    try:
        row = await twilio_byot_service.update_credentials(
            credential_id, owner_id,
            account_sid=body.account_sid, auth_token=body.auth_token, label=body.label,
        )
    except twilio_byot_service.InvalidTwilioCredentials as e:
        raise HTTPException(status_code=400, detail=str(e))
    if row is None:
        raise HTTPException(status_code=404, detail="Carrier account not found")
    return {"data": row, "error": None}


@router.delete("/twilio-credentials/{credential_id}")
async def delete_twilio_credential(credential_id: str, user=Depends(get_current_user)):
    """Delete a saved Twilio credential. Responds 400 if a phone number still uses it."""
    owner_id = resolve_owner_id(user["user_id"])
    try:
        await twilio_byot_service.delete_credentials(credential_id, owner_id)
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

    # The credential decides the carrier (and so the provider value stored on the number);
    # a missing or foreign credential is a 404 here, before anything is bought or imported.
    record = twilio_byot_service.get_credential_record(body.credential_id, owner_id)
    if not record:
        raise HTTPException(status_code=404, detail="Carrier account not found")

    row = await _provision_phone_number(
        user_id=owner_id,
        provider=f"{record['carrier']}_byot",
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
    """Update a phone number's agent assignment, status, inbound caller verification and/or
    answering hours.

    When the agent changes (including unassigning it), the number's VAPI routing is updated
    first, so inbound calls reach the new agent; a VAPI failure aborts the update with a 502.

    caller_verification_enabled=true takes the fixed assistant off the number so VAPI asks this
    server on every call (503 if the server is not set up for it, 400 if the number was never
    connected to VAPI, 404 if it is not this account's); false puts the agent back (or the
    shared "unavailable" assistant while the account's balance suspends the number). While
    verification is on, agent changes are database-only: the agent is looked up per call, and
    while the balance suspends a number they are too (the restore installs the current agent).
    The whole read-decide-write runs under the number's routing lock (see
    caller_verification.routing_lock), so a balance sync cannot interleave with it.

    answer_hours_* (services/call_hours.py) limit when the receptionist answers. Switching
    answer_hours_enabled on routes the number through this server exactly like verification does
    (same 503/400 refusals, needs only the voice service key and a public URL); the other hours
    fields are validated as merged over the stored ones (400 with a message) and, on their own,
    change nothing in the voice service. A number stays server-routed while either setting is on.
    """
    owner_id = resolve_owner_id(user["user_id"])
    try:
        uuid.UUID(number_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Phone number not found")
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

    async with caller_verification.routing_lock(number_id):
        return await _apply_phone_number_update(number_id, owner_id, updates)


def reason_if_unreachable(verification: bool) -> str:
    """The customer-facing reason when the voice service could not reach this server."""
    return caller_verification.UNAVAILABLE_REASON if verification else caller_verification.HOURS_UNAVAILABLE_REASON


async def _apply_phone_number_update(number_id: str, owner_id: str, updates: dict) -> dict:
    """The body of update_phone_number, run under the number's routing lock."""
    # Two settings make a number server-routed (VAPI asks this server on every call): caller
    # verification and answering hours. A flag key in the request is a "toggle" of that routing.
    hours_touched = call_hours.touched(call_hours.NUMBER, updates)
    toggling = "caller_verification_enabled" in updates or "answer_hours_enabled" in updates
    # What the REQUEST asked for (validation below merges the stored hours into `updates`, which
    # would make a settings-only change look like a switch-on for a number that already has hours on).
    verify_turning_on = bool(updates.get("caller_verification_enabled"))
    hours_turning_on = bool(updates.get("answer_hours_enabled"))
    existing = None
    if toggling or hours_touched or ("agent_id" in updates and settings.vapi_api_key):
        existing = (
            supabase.table("phone_numbers")
            .select("*")
            .eq("id", number_id)
            .eq("user_id", owner_id)
            .maybe_single()
            .execute()
        ).data
    if (toggling or hours_touched) and not existing:
        raise HTTPException(status_code=404, detail="Phone number not found")
    if hours_touched:
        # Validate the hours as they will be once stored (the request merged over what is stored)
        # and store them normalised.
        try:
            updates.update(call_hours.validate(call_hours.NUMBER, existing, updates))
        except call_hours.HoursError as e:
            raise HTTPException(status_code=400, detail=str(e))
    # Only numbers that were ever synced to VAPI have anything to re-route there.
    vapi_phone_id = existing.get("vapi_phone_id") if existing else None
    # Whether the number is server-routed once this request is applied, and whether it was before.
    route_after = caller_verification.server_routed({**(existing or {}), **updates})
    route_before = caller_verification.server_routed(existing)

    # What VAPI must be told so the number's routing matches its new state (None = nothing).
    vapi_update: dict | None = None
    if toggling and route_after:
        # Switching a setting off while the other still routes the number needs nothing in VAPI;
        # only a number that starts (or is explicitly re-)routed is pushed.
        if verify_turning_on or hours_turning_on or not route_before:
            if verify_turning_on:
                available, reason = caller_verification.availability()
                missing = caller_verification.missing_settings()
            else:
                available, reason = caller_verification.routing_availability()
                missing = []
            if not available:
                # The customer only sees a generic reason; the operator needs to know which setting.
                logger.warning("Server routing cannot be switched on for number %s: missing %s",
                               number_id, ", ".join(missing) or "VAPI_API_KEY / PUBLIC_API_URL")
                raise HTTPException(status_code=503, detail=reason)
            if not vapi_phone_id:
                raise HTTPException(status_code=400, detail="This number isn't connected to the voice service yet.")
            # Never point a line at a server the voice service cannot reach: it would hang up every
            # call on the number. (The reason is already in the server log.)
            reachable, _why = await caller_verification.check_reachable()
            if not reachable:
                raise HTTPException(status_code=503, detail=reason_if_unreachable(verify_turning_on))
            if not settings.vapi_webhook_secret:
                logger.warning(
                    "Server routing switched on for number %s with no VAPI_WEBHOOK_SECRET set: the routing "
                    "endpoint (/webhooks/vapi/inbound) accepts unauthenticated requests. Set the secret.", number_id)
            vapi_update = caller_verification.verified_routing_payload()
    elif toggling:
        # Turning it off: the number goes back to a fixed assistant. A number the balance has
        # suspended gets the shared fallback assistant, never its real agent.
        if vapi_phone_id and settings.vapi_api_key:
            if existing.get("suspended_for_balance"):
                assistant_id = await _get_or_create_fallback_assistant_id()
                if not assistant_id:
                    raise HTTPException(status_code=502, detail="Voice service error. Please try again.")
            else:
                new_agent = updates["agent_id"] if "agent_id" in updates else existing.get("agent_id")
                assistant_id = await _resolve_assistant_id(owner_id, new_agent)
            vapi_update = {"assistantId": assistant_id}
    elif "agent_id" in updates and vapi_phone_id and not route_after and not existing.get("suspended_for_balance"):
        # Mirror the agent change onto the VAPI phone number. An agent without a
        # vapi_assistant_id leaves the payload empty: there is no assistantId to push.
        # (A balance-suspended number keeps the shared fallback assistant: only the database
        # changes, and the restore installs whatever agent is assigned then.)
        vapi_update = {}
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

    if vapi_update is not None:
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


# ── Inbound caller verification ──

@router.get("/caller-verification/status")
async def caller_verification_status(user=Depends(get_current_user)):
    """Whether this server can run inbound caller verification at all. When `available` is
    false the toggle cannot be turned on and `reason` says so in customer-safe words."""
    available, reason = caller_verification.availability()
    return {"data": {"available": available, "reason": reason}, "error": None}


@router.get("/answer-hours/status")
async def answer_hours_status(user=Depends(get_current_user)):
    """Whether this server can run answering hours at all (they route the number's calls through
    this server, which needs the voice service key and a public URL; the caller-lookup credentials
    are not needed). When `available` is false the setting cannot be switched on and `reason` says
    so in customer-safe words."""
    available, reason = caller_verification.routing_availability()
    return {"data": {"available": available, "reason": reason}, "error": None}


@router.get("/caller-verification/log")
async def caller_verification_log(phone_number_id: str | None = None, limit: int = 50, user=Depends(get_current_user)):
    """Recent caller-verification results for the account, newest first: one row per call on a
    verified number, with the caller, the decision (answered/refused) and the reason. Optionally
    narrowed to one number; `limit` is capped at 200."""
    owner_id = resolve_owner_id(user["user_id"])
    query = supabase.table("inbound_call_screenings").select("*").eq("user_id", owner_id)
    if phone_number_id:
        try:
            uuid.UUID(phone_number_id)
        except ValueError:
            return {"data": [], "error": None}  # not an id: matches nothing (a uuid column would error)
        query = query.eq("phone_number_id", phone_number_id)
    rows = query.order("created_at", desc=True).limit(max(1, min(limit, 200))).execute().data or []
    return {"data": rows, "error": None}


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


def _attach_hours_state(campaigns: list[dict]) -> None:
    """Give each campaign a `call_hours_state` (see services/call_hours.state): whether its calling
    hours are on, open right now, and when they next open. An unreadable setting counts as closed,
    the safe side for a dialer."""
    now = datetime.now(timezone.utc)
    for camp in campaigns:
        st = call_hours.state(camp, call_hours.CAMPAIGN, now, if_unreadable=False)
        camp["call_hours_state"] = st
        # A run the hours stopped continues by itself when they open: `next_at` is when (None = within
        # the next minute, the hours are open already), shown on the card with a way to stop it.
        waiting = bool(camp.get("stopped_by_hours_at") and camp.get("dial_cursor") and call_hours.enabled(camp, call_hours.CAMPAIGN)
                       and camp.get("status") == "Paused")
        camp["auto_resume"] = {"pending": waiting, "next_at": st["next_open_at"] if waiting else None}


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
    _attach_hours_state(campaigns)
    return {"data": campaigns, "error": None}


@router.post("/campaigns")
async def create_campaign(body: CampaignCreate, user=Depends(get_current_user)):
    """Create an outbound campaign (it does not start dialing until /start is called).
    If a contact list is assigned, the current contact count is stored on the row."""
    owner_id = resolve_owner_id(user["user_id"])
    row = body.model_dump()
    row["user_id"] = owner_id
    try:
        row.update(call_hours.validate(call_hours.CAMPAIGN, None, row))
    except call_hours.HoursError as e:
        raise HTTPException(status_code=400, detail=str(e))

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
    _attach_hours_state([camp])
    return {"data": camp, "error": None}


@router.patch("/campaigns/{campaign_id}")
async def update_campaign(campaign_id: str, body: CampaignUpdate, user=Depends(get_current_user)):
    """Partially update a campaign (only the fields sent). Returns data null when
    nothing was sent or the campaign isn't this account's."""
    updates = body.model_dump(exclude_none=True)
    if not updates:
        return {"data": None, "error": "No fields to update"}
    owner_id = resolve_owner_id(user["user_id"])
    hours_touched = call_hours.touched(call_hours.CAMPAIGN, updates)
    if hours_touched or "list_id" in updates or "status" in updates:
        existing = (
            supabase.table("outbound_campaigns").select("*")
            .eq("id", campaign_id).eq("user_id", owner_id).maybe_single().execute()
        ).data
        if not existing:
            return {"data": None, "error": None}
        if hours_touched:
            # Validate the hours as they will be once stored (the request merged over what is
            # stored) and store them normalised.
            try:
                updates.update(call_hours.validate(call_hours.CAMPAIGN, existing, updates))
            except call_hours.HoursError as e:
                raise HTTPException(status_code=400, detail=str(e))
        # dial_cursor (where a run stopped when the hours closed) only means something for the
        # same list; with another list the next start begins at the top.
        if "list_id" in updates and updates["list_id"] != existing.get("list_id"):
            updates["dial_cursor"] = None
        # Anything a person does to the campaign takes it out of the automatic continuing: a different
        # status (they Paused/Activated/Inactivated it on purpose), a different list, or hours switched
        # off. Saving the settings with the same status and hours keeps it waiting.
        took_over = (
            ("status" in updates and updates["status"] != existing.get("status"))
            or ("list_id" in updates and updates["list_id"] != existing.get("list_id"))
            or (hours_touched and not call_hours.enabled({**existing, **updates}, call_hours.CAMPAIGN))
        )
        if took_over:
            updates["stopped_by_hours_at"] = None
    result = (
        supabase.table("outbound_campaigns")
        .update(updates)
        .eq("id", campaign_id)
        .eq("user_id", owner_id)
        .execute()
    )
    return {"data": result.data[0] if result.data else None, "error": None}


@router.delete("/campaigns/{campaign_id}")
async def delete_campaign(campaign_id: str, user=Depends(get_current_user)):
    """Delete one of the account's campaigns. Returns success even if it doesn't exist."""
    supabase.table("outbound_campaigns").delete().eq("id", campaign_id).eq("user_id", resolve_owner_id(user["user_id"])).execute()
    return {"data": None, "error": None}


# How long a run's lease is honoured without a sign of life (every batch refreshes it). A run that
# crashed or was killed leaves its lease behind; after this long a new Start may take it over.
RUN_LEASE_STALE_SECONDS = 600
_HOURS_COLUMNS = ("call_hours_enabled", "call_hours_timezone", "call_hours_days", "call_hours_start", "call_hours_end", "call_hours_schedule")
_RUN_COLUMNS = "status, list_id, run_token, " + ", ".join(_HOURS_COLUMNS)


def _iso_now(offset_seconds: int = 0) -> str:
    """Now (plus `offset_seconds`) as a UTC timestamp string, the form written to the lease columns."""
    return (datetime.now(timezone.utc) + timedelta(seconds=offset_seconds)).strftime("%Y-%m-%dT%H:%M:%SZ")


def _raise_if_closed(camp: dict) -> None:
    """400 saying when it opens if the campaign's calling hours are closed right now. An unreadable
    setting counts as closed (the safe side for a dialer)."""
    if not call_hours.is_open(camp, call_hours.CAMPAIGN, if_unreadable=False):
        nxt = call_hours.next_opening(camp, call_hours.CAMPAIGN)
        when = f" It opens again {call_hours.describe_moment(nxt, camp, call_hours.CAMPAIGN)}." if nxt else ""
        raise HTTPException(
            status_code=400,
            detail=f"This campaign only places calls {call_hours.describe(camp, call_hours.CAMPAIGN)}, "
                   f"and it is closed right now.{when}",
        )


def _claim_run(campaign_id: str) -> str:
    """Take the campaign's run lease and return its token, or raise 409 when another run holds it.

    A run holds it from here until it gives it back, refreshing it before every batch, and only the
    holder may save the place or change the campaign at the end. So two Starts at once (a double
    click, the Start button racing the automatic continuing, two workers) can never both dial, and a
    Pause followed by an immediate Start waits for the first run to finish its current batch instead
    of calling the same people twice. Each of the two steps below is one atomic update: the first
    takes a free lease, the second takes over one whose holder has not been heard from for
    RUN_LEASE_STALE_SECONDS (a crashed run)."""
    token = str(uuid.uuid4())
    fields = {"run_token": token, "run_heartbeat_at": _iso_now(), "status": "Active", "stopped_by_hours_at": None}
    table = supabase.table("outbound_campaigns")
    won = table.update(fields).eq("id", campaign_id).is_("run_token", "null").execute().data
    if not won:
        won = (supabase.table("outbound_campaigns").update(fields).eq("id", campaign_id)
               .lt("run_heartbeat_at", _iso_now(-RUN_LEASE_STALE_SECONDS)).execute().data)
    if not won:
        raise HTTPException(
            status_code=409,
            detail="This campaign is already running (or still finishing its current batch). Try again in a moment.",
        )
    return token


def _release_run(campaign_id: str, token: str) -> None:
    """Give the lease back. Does nothing if it is no longer this run's (already given back, or taken over)."""
    supabase.table("outbound_campaigns").update({"run_token": None, "run_heartbeat_at": None}) \
        .eq("id", campaign_id).eq("run_token", token).execute()


async def _run_campaign(campaign_id: str, owner_id: str, vapi_assistant_id: str, token: str,
                        original_status: str | None, original_marker: str | None) -> dict:
    """The dialing part of start_campaign, run while holding the lease `token`: load the contacts
    after the saved place, dial them in batches, and leave the campaign in the right state. See
    start_campaign for the rules."""
    # The row as it is NOW, after this run took the lease: a run that finished a moment ago left its
    # place in it, and a person may have changed things since the row was first read. That, not the
    # earlier read, is what counts for where to start and for the hours.
    camp = supabase.table("outbound_campaigns").select("*").eq("id", campaign_id).maybe_single().execute().data
    if not camp:
        raise HTTPException(status_code=404, detail="Campaign not found")
    _raise_if_closed(camp)

    # A stable order (by id) is what lets a run that was stopped by the calling hours carry on after
    # the last contact it handled (dial_cursor) instead of starting over.
    cursor = camp.get("dial_cursor")
    contact_query = (
        supabase.table("contacts")
        .select("id, name, phone")
        .eq("user_id", owner_id)
        .eq("list_id", camp["list_id"])
        .not_.is_("phone", "null")
    )
    if cursor:
        contact_query = contact_query.gt("id", cursor)
    contacts = contact_query.order("id").execute()

    if not contacts.data:
        if cursor:
            # The earlier run had stopped part-way and nothing is left after it. Forget the place,
            # so the next start dials the whole list again, and say why nothing happened now.
            supabase.table("outbound_campaigns").update(
                {"dial_cursor": None, "status": "Inactive", "stopped_by_hours_at": None, "run_token": None, "run_heartbeat_at": None}
            ).eq("id", campaign_id).eq("run_token", token).execute()
            raise HTTPException(status_code=400, detail="Every contact in this list has already been dialed. Start the campaign again to dial the list from the beginning.")
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
            placed = await vapi_client.create_call(call_payload)
        except Exception as e:
            return {"success": False, "phone": contact["phone"], "error": str(e)}
        # Remember which campaign placed the call: it decides the time zone the call's times are shown
        # in once the call is logged (conversations.campaign_id). Best-effort: it must never turn a
        # placed call into a failure.
        call_id = placed.get("id") if isinstance(placed, dict) else None
        if call_id:
            try:
                supabase.table("campaign_calls").upsert(
                    {"vapi_call_id": str(call_id), "campaign_id": campaign_id, "user_id": owner_id},
                    on_conflict="vapi_call_id",
                ).execute()
            except Exception:  # noqa: BLE001
                logger.warning("could not record the campaign of call %s", call_id, exc_info=True)
        return {"success": True, "phone": contact["phone"]}

    dialed = 0
    suppressed = []
    errors = []
    all_contacts = contacts.data
    stopped_at = None           # index of the first contact NOT handled when the run stopped early
    stopped_by = None           # why: "hours" (the calling hours closed) or "person" (paused/changed by hand)
    last_handled = cursor       # id of the last contact handled so far (where a stopped run resumes)
    for i in range(0, len(all_contacts), CAMPAIGN_BATCH_SIZE):
        # Before EVERY batch the campaign is read again. A person who paused or otherwise changed it
        # (another status, another list), deleted it, or whose newer run took over this one's lease, is
        # obeyed from this batch on: calls already placed are not interrupted. Their latest calling
        # hours count too (narrowed -> stops at once; switched off -> no limit any more).
        now_row = supabase.table("outbound_campaigns").select(_RUN_COLUMNS).eq("id", campaign_id).maybe_single().execute().data
        if (not now_row or now_row.get("run_token") != token or now_row.get("status") != "Active"
                or now_row.get("list_id") != camp.get("list_id")):
            stopped_at, stopped_by = i, "person"
            break
        camp.update({k: now_row[k] for k in _HOURS_COLUMNS})
        # Checked before every batch, so a run that outlasts the hours stops at the next boundary
        # instead of calling people after closing time.
        if not call_hours.is_open(camp, call_hours.CAMPAIGN, if_unreadable=False):
            stopped_at, stopped_by = i, "hours"
            break
        batch = all_contacts[i:i + CAMPAIGN_BATCH_SIZE]
        # The place is saved BEFORE the batch is dialed (and the lease refreshed in the same step), so
        # a crash or restart mid-batch can never make the next run call these people again: at worst
        # that one batch is skipped. The step only succeeds while this run still holds the lease and
        # the campaign still has the same list; otherwise the run ends here.
        saved = supabase.table("outbound_campaigns").update(
            {"dial_cursor": batch[-1]["id"], "run_heartbeat_at": _iso_now()}
        ).eq("id", campaign_id).eq("run_token", token).eq("list_id", camp.get("list_id")).execute().data
        if not saved:
            stopped_at, stopped_by = i, "person"
            break
        last_handled = batch[-1]["id"]
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

    # Whatever stopped the run, a person may have paused/changed the campaign since the last check:
    # their choice always wins, so the status and the "continue automatically" marker are left alone.
    final_row = supabase.table("outbound_campaigns").select("status, list_id").eq("id", campaign_id).maybe_single().execute().data
    list_changed = final_row is None or final_row.get("list_id") != camp.get("list_id")
    person_took_over = stopped_by == "person" or list_changed or final_row.get("status") != "Active"
    if person_took_over:
        # Only the place is kept (or forgotten, when the list was finished anyway); with another list
        # nothing of this run's place means anything any more.
        campaign_update = {} if list_changed else {"dial_cursor": last_handled if stopped_at is not None else None}
        if stopped_by is None:
            stopped_by = "person"       # for the answer below (it ended, but not by itself)
    elif stopped_at is not None and last_handled:
        # The hours closed part-way (and something was dialed, now or in an earlier run): remember
        # where, and park the campaign as Paused, marked to continue by itself the next time the hours
        # open (services/campaign_scheduler.py); Start/Resume by hand carries on from the same place.
        campaign_update = {"status": "Paused", "dial_cursor": last_handled,
                           "stopped_by_hours_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    elif stopped_at is not None:
        # Closed before a single call was placed: nothing to remember, it is as it was.
        campaign_update = {"status": original_status, "stopped_by_hours_at": original_marker}
    else:
        # Ran to the end of the list. contacts_count is reset to the number of dialable contacts
        # (those with a phone), which can be lower than the list size stored when the campaign
        # was created; after a resume it is left alone, as only the remainder was loaded.
        campaign_update = {"status": "Active", "dial_cursor": None, "stopped_by_hours_at": None}
        if not cursor:
            campaign_update["contacts_count"] = len(contacts.data)
    # Every write of the end of the run needs this run to still hold the lease, and gives it back.
    campaign_update.update({"run_token": None, "run_heartbeat_at": None})
    supabase.table("outbound_campaigns").update(campaign_update).eq("id", campaign_id).eq("run_token", token).execute()

    if suppressed:
        _notify_suppressed(owner_id, campaign_id, camp.get("name") or "Campaign", len(suppressed))

    result_data = {
        "dialed": dialed,
        "errors": len(errors),
        "error_details": errors[:5],
        "suppressed": len(suppressed),
        "suppressed_details": suppressed[:5],
    }
    if stopped_at is not None and stopped_by == "hours" and not person_took_over:
        nxt = call_hours.next_opening(camp, call_hours.CAMPAIGN)
        result_data.update({
            "stopped_by_hours": True,
            "remaining": len(all_contacts) - stopped_at,
            "next_open_at": nxt.strftime("%Y-%m-%dT%H:%M:%SZ") if nxt else None,
        })
    elif person_took_over and stopped_at is not None:
        result_data.update({"stopped_by_person": True, "remaining": len(all_contacts) - stopped_at})
    return {"data": result_data, "error": None}


@router.post("/campaigns/{campaign_id}/start")
async def start_campaign(campaign_id: str, user=Depends(get_current_user)):
    """Start a campaign by placing a VAPI call to every contact with a phone number in
    its list, using the campaign's agent and phone number.

    Fails with 4xx if the campaign is missing, its agent/list/phone number isn't set up,
    the account is blocked, the balance is empty or the list has no dialable contacts.
    Contacts are dialed in concurrent batches within this single request; a failed dial
    or a DNC-suppressed number is recorded and skipped, never aborting the run.

    Calling hours: a campaign with them switched on refuses to start while closed (400, saying
    when it opens) and stops dialing between batches if they close mid-run. A stopped run leaves
    the campaign Paused with `dial_cursor` set to the last contact handled; starting or resuming it
    again carries on with the contacts after that one, so nobody is called twice.

    Side effects: sets the campaign to Active (and refreshes contacts_count), and sends
    one DNC-suppression notification if any numbers were skipped. Returns dialed/error/
    suppressed counts plus up to 5 sample errors and suppressed numbers, and, when the hours
    stopped the run, `stopped_by_hours`, how many contacts are `remaining` and `next_open_at`.
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

    # Calling hours: nothing is dialed while they are closed.
    _raise_if_closed(camp)

    # Taking the lease is what makes this the one run of the campaign (see _claim_run); everything after
    # it happens inside try/finally so the lease is always given back, whatever happens.
    original_status = camp.get("status")
    original_marker = camp.get("stopped_by_hours_at")
    token = _claim_run(campaign_id)
    try:
        return await _run_campaign(campaign_id, owner_id, vapi_assistant_id, token, original_status, original_marker)
    except HTTPException:
        # Refused before dialing anything (nothing left, number not active, ...): it is as it was.
        supabase.table("outbound_campaigns").update(
            {"status": original_status, "stopped_by_hours_at": original_marker, "run_token": None, "run_heartbeat_at": None}
        ).eq("id", campaign_id).eq("run_token", token).execute()
        raise
    except BaseException:
        # Something broke mid-run (a crash, a cancelled request, an error from a service): park the
        # campaign as Paused instead of leaving it looking like it is still running. Its place was saved
        # before the batch that was in flight, so Start carries on without calling anyone twice.
        supabase.table("outbound_campaigns").update(
            {"status": "Paused", "run_token": None, "run_heartbeat_at": None}
        ).eq("id", campaign_id).eq("run_token", token).execute()
        raise
    finally:
        _release_run(campaign_id, token)


@router.post("/campaigns/{campaign_id}/pause")
async def pause_campaign(campaign_id: str, user=Depends(get_current_user)):
    """Mark the campaign Paused. Only updates the stored status; calls already placed
    by /start are not interrupted. Also stops a run the calling hours stopped from continuing by
    itself (see services/campaign_scheduler.py). Succeeds even if the campaign isn't found."""
    # A person pausing it also cancels the automatic continuing (the place is kept: Start/Resume carries on from it).
    supabase.table("outbound_campaigns").update({"status": "Paused", "stopped_by_hours_at": None}).eq("id", campaign_id).eq("user_id", resolve_owner_id(user["user_id"])).execute()
    return {"data": {"status": "Paused"}, "error": None}


@router.post("/campaigns/{campaign_id}/resume")
async def resume_campaign(campaign_id: str, user=Depends(get_current_user)):
    """Mark the campaign Active again. Only updates the stored status; it does not
    place any calls (use /start for that), except for a campaign whose run was stopped by its
    calling hours (it has a `dial_cursor`): that carries on with the contacts left, exactly like
    /start. Succeeds even if the campaign isn't found."""
    owner_id = resolve_owner_id(user["user_id"])
    parked = (
        supabase.table("outbound_campaigns").select("dial_cursor")
        .eq("id", campaign_id).eq("user_id", owner_id).maybe_single().execute()
    ).data
    if parked and parked.get("dial_cursor"):
        return await start_campaign(campaign_id, user)
    supabase.table("outbound_campaigns").update({"status": "Active"}).eq("id", campaign_id).eq("user_id", owner_id).execute()
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
        try:
            uuid.UUID(str(phone_number_id))
        except ValueError:
            raise HTTPException(status_code=400, detail="Phone number not found or not provisioned")
        async with caller_verification.routing_lock(phone_number_id):
            phone = (
                supabase.table("phone_numbers")
                .select("vapi_phone_id, caller_verification_enabled, answer_hours_enabled, suspended_for_balance")
                .eq("id", phone_number_id)
                .eq("user_id", owner_id)
                .maybe_single()
                .execute()
            )
            if not phone.data or not phone.data.get("vapi_phone_id"):
                raise HTTPException(status_code=400, detail="Phone number not found or not provisioned")
            # A server-routed number (caller verification or answering hours on) has no fixed
            # assistant in VAPI (our server picks the agent per call from phone_numbers.agent_id),
            # and a balance-suspended number keeps the shared fallback assistant until the restore
            # installs this agent: in both cases only the local row is updated.
            if not caller_verification.server_routed(phone.data) and not phone.data.get("suspended_for_balance"):
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
            async with caller_verification.routing_lock(pn_id):
                phone = supabase.table("phone_numbers").select("vapi_phone_id, caller_verification_enabled, answer_hours_enabled, suspended_for_balance").eq("id", pn_id).eq("user_id", owner_id).maybe_single().execute()
                agent = supabase.table("ai_agents").select("vapi_assistant_id").eq("id", agent_id).eq("user_id", owner_id).maybe_single().execute()
                vapi_phone_id = phone.data.get("vapi_phone_id") if phone.data else None
                vapi_assistant_id = agent.data.get("vapi_assistant_id") if agent.data else None
                # With caller verification or answering hours on there is no fixed assistant to
                # push: the agent is looked up per call from phone_numbers.agent_id, updated just
                # below. A balance-suspended number keeps the fallback assistant until the restore.
                verified = caller_verification.server_routed(phone.data)
                suspended = bool(phone.data and phone.data.get("suspended_for_balance"))
                if vapi_phone_id and vapi_assistant_id and not verified and not suspended:
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
        async with caller_verification.routing_lock(phone_number_id):
            phone = (
                supabase.table("phone_numbers")
                .select("vapi_phone_id, caller_verification_enabled, answer_hours_enabled, suspended_for_balance")
                .eq("id", phone_number_id)
                .eq("user_id", owner_id)
                .maybe_single()
                .execute()
            )
            # A server-routed number has no assistant in VAPI to clear, and a balance-suspended one
            # keeps the fallback assistant (so callers still hear why); dropping agent_id below is
            # enough.
            if (phone.data and phone.data.get("vapi_phone_id") and settings.vapi_api_key
                    and not caller_verification.server_routed(phone.data)
                    and not phone.data.get("suspended_for_balance")):
                try:
                    await vapi_client.update_phone_number(phone.data["vapi_phone_id"], {"assistantId": None})
                except Exception:
                    logger.exception("Failed to clear VAPI assistant for phone number %s on receptionist delete", phone_number_id)
            supabase.table("phone_numbers").update({"agent_id": None}).eq("id", phone_number_id).eq("user_id", owner_id).execute()

    return {"data": None, "error": None}
