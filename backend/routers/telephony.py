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
import threading
import weakref
import uuid
from datetime import datetime, timedelta, timezone
import httpx
import stripe
from pydantic import BaseModel, StrictBool
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
from services import vapi_client, twilio_service, twilio_byot_service, carriers, whitelist_service, caller_verification, call_hours, call_retry, dial_settings, dial_limits, dialer, followup_rounds
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

# Most calls the dialing engine (services/dialer.py) starts together in one group: they are screened and
# placed side by side (staggered), the next group follows once these have taken their attempts.
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

    # Never two calls to one number at the same time: refuse while it is on a campaign call (this single call is not
    # counted toward a campaign's concurrency limit).
    if call_retry.number_is_busy(owner_id, body.phone_number):
        raise HTTPException(status_code=409, detail="That number is on another call right now. Try again when that call has ended.")

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
        waiting = bool(camp.get("stopped_by_hours_at") and (camp.get("dial_running") or camp.get("dial_cursor"))
                       and call_hours.enabled(camp, call_hours.CAMPAIGN) and camp.get("status") == "Paused")
        camp["auto_resume"] = {"pending": waiting, "next_at": st["next_open_at"] if waiting else None}


def _attach_retry_stats(owner_id: str, campaigns: list[dict]) -> None:
    """Give each campaign a `retry_stats` (services/call_retry.stats): total attempts, retries placed, numbers
    answered on a retry, numbers that hit the maximum and redials waiting. A failure here must never break
    the campaign list, so the counts are zeros then."""
    try:
        found = call_retry.stats(owner_id, [c["id"] for c in campaigns])
    except Exception:  # noqa: BLE001
        logger.warning("could not read the retry stats", exc_info=True)
        found = {}
    empty = {"total_attempts": 0, "retries_placed": 0, "answered_on_retry": 0, "max_attempts_reached": 0,
             "pending_retries": 0, "numbers": 0, "unreached_count": 0}
    for camp in campaigns:
        camp["retry_stats"] = found.get(camp["id"], dict(empty))


# The dialing engine's own bookkeeping: it only means something to the server, so no response carries it.
# (followup_done / followup_next_at are shown as the campaign's `followup` object instead, see _attach_followup.)
_ENGINE_COLUMNS = ("run_token", "dial_legacy_cursor", "dial_counters", "dial_batch_seq", "followup_done", "followup_next_at")


def _strip_engine(campaigns: list[dict]) -> None:
    """Remove the engine-only columns (_ENGINE_COLUMNS) from each campaign before it is returned."""
    for camp in campaigns:
        for col in _ENGINE_COLUMNS:
            camp.pop(col, None)


def _attach_followup(campaigns: list[dict]) -> None:
    """Give each campaign a `followup`: {rounds, gap_hours, done, next_at, waiting} (services/followup_rounds.describe),
    its second-chance round settings and where it is (`waiting` is true while a round is scheduled)."""
    for camp in campaigns:
        camp["followup"] = followup_rounds.describe(camp)


def _attach_dialing_state(owner_id: str, campaigns: list[dict]) -> None:
    """Give each campaign a `dialing`: its settings, what the account / platform cap lets it really do
    (`effective`), the `warnings` that follow from a cap, whether a pass is open (`running`) and why it is
    stalled, if it is (`stall_reason`). A failure to read the limits must never break the campaign list, so
    it reads as "no cap"."""
    if not campaigns:
        return
    try:
        limits = (dial_limits.limits_for([owner_id]) or {}).get(owner_id)
    except Exception:  # noqa: BLE001
        logger.warning("could not read the dialing limits", exc_info=True)
        limits = None
    cap, source = dial_limits.cap_of(limits)
    for camp in campaigns:
        camp["dialing"] = {
            "settings": dial_settings.describe(camp),
            "effective": dial_settings.effective(camp, cap, source),
            "warnings": dial_limits.warnings_for(camp, limits),
            "running": bool(camp.get("dial_running")),
            "stall_reason": camp.get("dial_stall"),
        }


def _warnings_for(owner_id: str, camp: dict | None) -> list[str]:
    """The cap warnings (dial_limits.warnings_for) of one campaign row, for the top-level `warnings` of create /
    update / start responses; [] when there is nothing to say or the limits cannot be read."""
    if not camp:
        return []
    try:
        return dial_limits.warnings_for(camp, (dial_limits.limits_for([owner_id]) or {}).get(owner_id))
    except Exception:  # noqa: BLE001
        logger.warning("could not work out the dialing warnings", exc_info=True)
        return []


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
    _attach_retry_stats(owner_id, campaigns)
    _attach_dialing_state(owner_id, campaigns)
    _attach_followup(campaigns)
    _strip_engine(campaigns)
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
        row.update(call_retry.validate(None, row))
        row.update(dial_settings.validate(None, row))
        row.update(followup_rounds.validate(None, row))
    except (call_hours.HoursError, call_retry.RetryError, dial_settings.DialError, followup_rounds.FollowupError) as e:
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
    created = result.data[0] if result.data else None
    warnings = _warnings_for(owner_id, created)
    if created:
        _strip_engine([created])
    return {"data": created, "warnings": warnings, "error": None}


@router.get("/campaigns/live")
async def campaigns_live(user=Depends(get_current_user)):
    """The live dialing state of the account's campaigns that are Active, running or have calls open, keyed by
    campaign id: state (dialing / finishing / waiting_hours / paused / stalled / waiting_redials / idle), the
    strategy and its effective settings, calls open now, numbers queued, calls placed in this pass and in the last
    minute, the pass counters, why it is stalled, when the next call is due and whether the dispatcher is alive. Cheap
    on purpose (no list progress), so a page can poll it every few seconds. Declared before
    /campaigns/{campaign_id}, which would otherwise take "live" for an id."""
    # Many small queries: off the event loop.
    return {"data": await asyncio.to_thread(dialer.live_states, resolve_owner_id(user["user_id"])), "error": None}


@router.get("/dialing/limits")
async def dialing_limits(user=Depends(get_current_user)):
    """What limits this account's dialing: the calls allowed at the same time on the account (and whose limit that is,
    null = none), the platform's current limit, and the ranges the dialing settings accept."""
    owner_id = resolve_owner_id(user["user_id"])
    try:
        limits = (dial_limits.limits_for([owner_id]) or {}).get(owner_id) or {}
    except Exception:  # noqa: BLE001
        logger.warning("could not read the dialing limits", exc_info=True)
        limits = {}
    return {"data": {
        "account_limit": limits.get("account_limit"), "source": limits.get("account_source"),
        "platform_limit": limits.get("platform_limit"),
        "max_concurrent_calls": dial_limits.MAX_CONCURRENT_CALLS,
        "max_calls_per_minute": dial_limits.MAX_CALLS_PER_MINUTE,
        "max_delay_seconds": dial_limits.MAX_DELAY_SECONDS,
    }, "error": None}


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
    _attach_retry_stats(owner_id, [camp])
    _attach_dialing_state(owner_id, [camp])
    _attach_followup([camp])
    _strip_engine([camp])
    return {"data": camp, "error": None}


@router.get("/campaigns/{campaign_id}/numbers")
async def campaign_numbers(campaign_id: str, status: str = "all", limit: int = 100, offset: int = 0,
                           user=Depends(get_current_user)):
    """The lead/number view of one campaign (services/call_retry.numbers): every number with its attempt
    count, last outcome, next retry time, status and the history of its calls. `status` filters: all,
    pending (still going), finished, or one final status (e.g. max_attempts); 404 if the campaign isn't
    this account's."""
    owner_id = resolve_owner_id(user["user_id"])
    camp = (
        supabase.table("outbound_campaigns").select("*")
        .eq("id", campaign_id).eq("user_id", owner_id).maybe_single().execute()
    ).data
    if not camp:
        raise HTTPException(status_code=404, detail="Campaign not found")
    try:
        data = call_retry.numbers(camp, status, limit, offset)
    except call_retry.RetryError as e:
        raise HTTPException(status_code=400, detail=str(e))
    data["retry"] = call_retry.settings_of(camp)
    return {"data": data, "error": None}


@router.patch("/campaigns/{campaign_id}")
async def update_campaign(campaign_id: str, body: CampaignUpdate, user=Depends(get_current_user)):
    """Partially update a campaign (only the fields sent). Returns data null when
    nothing was sent or the campaign isn't this account's."""
    updates = body.model_dump(exclude_none=True)
    if not updates:
        return {"data": None, "warnings": [], "error": "No fields to update"}
    owner_id = resolve_owner_id(user["user_id"])
    hours_touched = call_hours.touched(call_hours.CAMPAIGN, updates)
    retry_touched = call_retry.touched(updates)
    dial_touched = dial_settings.touched(updates)
    followup_touched = followup_rounds.touched(updates)
    if hours_touched or retry_touched or dial_touched or followup_touched or "list_id" in updates or "status" in updates:
        existing = (
            supabase.table("outbound_campaigns").select("*")
            .eq("id", campaign_id).eq("user_id", owner_id).maybe_single().execute()
        ).data
        if not existing:
            return {"data": None, "warnings": [], "error": None}
        if hours_touched:
            # Validate the hours as they will be once stored (the request merged over what is
            # stored) and store them normalised.
            try:
                updates.update(call_hours.validate(call_hours.CAMPAIGN, existing, updates))
            except call_hours.HoursError as e:
                raise HTTPException(status_code=400, detail=str(e))
        if retry_touched:
            # Same for the retry settings. They govern calls from now on: a call already in progress is
            # settled with the settings it was placed under (see services/call_retry.py).
            try:
                updates.update(call_retry.validate(existing, updates))
            except call_retry.RetryError as e:
                raise HTTPException(status_code=400, detail=str(e))
        if dial_touched:
            # And the dialing settings. They govern calls placed from now on; a call in progress keeps the
            # slot and the settings snapshot it was placed under. A change also clears the engine's wait
            # and its stall reason, so the next placement is worked out afresh.
            try:
                dial = dial_settings.validate(existing, updates)
            except dial_settings.DialError as e:
                raise HTTPException(status_code=400, detail=str(e))
            updates.update(dial)
            if any(dial[k] != existing.get(k) for k in dial_settings.FIELDS):
                updates["dial_next_at"] = None
                updates["dial_stall"] = None
        if followup_touched or retry_touched:
            # The second-chance rounds, checked with the retry switch as it will be stored (they need Auto Redial).
            # Turning them off, or lowering them to the rounds already done, cancels a round that is scheduled; a new
            # gap never moves a time that is already scheduled (it applies from the next scheduling).
            try:
                follow = followup_rounds.validate(existing, updates)
            except followup_rounds.FollowupError as e:
                raise HTTPException(status_code=400, detail=str(e))
            updates.update(follow)
            if follow["followup_rounds"] <= int(existing.get("followup_done") or 0):
                updates["followup_next_at"] = None
        # dial_cursor (where a run stopped when the hours closed) only means something for the
        # same list; with another list the next start begins at the top, so the pass the old list
        # had open is over (dial_seq / dial_legacy_cursor are the dialing engine's own places in it).
        if "list_id" in updates and updates["list_id"] != existing.get("list_id"):
            updates.update({"dial_cursor": None, "dial_seq": None, "dial_legacy_cursor": None, "dial_running": False,
                            "followup_done": 0, "followup_next_at": None})     # another list: second chances begin again
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
    if retry_touched and result.data and not updates["retry_enabled"]:
        # Switching retries off cancels the redials still waiting (they are future attempts).
        call_retry.cancel_pending(campaign_id)
    updated = result.data[0] if result.data else None
    warnings = _warnings_for(owner_id, updated)
    if updated:
        _strip_engine([updated])
        dialer.nudge()      # a new status, strategy or retry setting is acted on now, not at the next tick
    return {"data": updated, "warnings": warnings, "error": None}


@router.delete("/campaigns/{campaign_id}")
async def delete_campaign(campaign_id: str, user=Depends(get_current_user)):
    """Delete one of the account's campaigns. Returns success even if it doesn't exist."""
    supabase.table("outbound_campaigns").delete().eq("id", campaign_id).eq("user_id", resolve_owner_id(user["user_id"])).execute()
    return {"data": None, "error": None}


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


# The gate + begin_attempt unit (see _take_attempt) runs under this lock: placements of different campaigns come
# from different worker threads, and the per-campaign / per-account caps are only exact if no other placement can
# slip between one placement's gate and its attempt.
_PLACEMENT_LOCK = threading.Lock()
# Placements also queue in FIFO order on an asyncio lock (one per event loop) before they take a worker thread, so a
# group of calls takes its gate + attempt in the order the group lists them and a burst of 20 does not occupy 20
# worker threads waiting for the thread lock.
_placement_queues: "weakref.WeakKeyDictionary" = weakref.WeakKeyDictionary()


def _placement_queue() -> asyncio.Lock:
    loop = asyncio.get_running_loop()
    lock = _placement_queues.get(loop)
    if lock is None:
        lock = _placement_queues[loop] = asyncio.Lock()
    return lock


def _take_attempt(camp: dict, owner_id: str, contact: dict, new_round: bool, lead: dict | None, gate, dial: dict | None,
                  fail_closed: bool, now: datetime | None) -> dict:
    """Synchronous half of _place_call: run the dialer's gate (when given), then take the number's attempt. Returns
    {"result": dict} when the placement ends here (gated, busy, slot taken, bookkeeping failed), else
    {"camp": the campaign as the gate read it, "attempt": the open attempt row, or None for an untracked call}.
    Runs in a worker thread (asyncio.to_thread); the gate and the attempt are back to back under _PLACEMENT_LOCK."""
    campaign_id = camp["id"]
    phone = contact["phone"]
    dial_info = dict(dial or {})
    with _PLACEMENT_LOCK:
        if gate is not None:
            verdict = gate()
            if verdict.get("stop"):
                return {"result": {"success": False, "gated": verdict["stop"], "phone": phone}}
            camp = {**camp, **(verdict.get("settings") or {})}
            dial_info.update({k: verdict[k] for k in ("strategy", "slot", "batch") if k in verdict})
        attempt = None
        try:
            attempt = call_retry.begin_attempt({**camp, "user_id": owner_id}, contact, new_round=new_round, lead=lead,
                                               now=now, dial=dial_info or None)
            if attempt is None:
                return {"result": {"success": False, "busy": True, "phone": phone}}
        except call_retry.SlotTaken:
            return {"result": {"success": False, "slot_taken": True, "phone": phone, "error": "slot taken"}}
        except Exception as e:  # noqa: BLE001
            if fail_closed:
                # The record of the call could not be made: no call without a record (it could never be tracked,
                # retried or counted against the limits). The number stays queued.
                logger.exception("could not record an attempt for campaign %s; no call is placed", campaign_id)
                return {"result": {"success": False, "bookkeeping": True, "phone": phone, "error": str(e)}}
            # Bookkeeping must never stop a call from being placed: if it breaks, the call goes out untracked.
            logger.exception("could not record an attempt for campaign %s; placing the call untracked", campaign_id)
    return {"camp": camp, "attempt": attempt}


def _record_placed(attempt: dict | None, call_id, campaign_id: str, owner_id: str) -> None:
    """Remember the provider's call id on the attempt and which campaign placed the call (best-effort, run off the
    event loop): neither may turn a placed call into a failure."""
    if attempt:
        try:
            call_retry.mark_placed(attempt, call_id)
        except Exception:  # noqa: BLE001
            logger.warning("could not record the call id of attempt %s", attempt.get("id"), exc_info=True)
    try:
        supabase.table("campaign_calls").upsert(
            {"vapi_call_id": str(call_id), "campaign_id": campaign_id, "user_id": owner_id},
            on_conflict="vapi_call_id",
        ).execute()
    except Exception:  # noqa: BLE001
        logger.warning("could not record the campaign of call %s", call_id, exc_info=True)


async def _place_call(camp: dict, owner_id: str, contact: dict, vapi_assistant_id: str, vapi_phone_id: str | None,
                      *, cached_verdict=None, new_round: bool, lead: dict | None = None,
                      gate=None, dial: dict | None = None, fail_closed: bool = False, now: datetime | None = None) -> dict:
    """Place ONE campaign call to `contact` (used by the dialing engine, services/dialer.py), returning a
    result dict instead of raising for dial problems:
      {"success": True, "phone", "took_attempt"}        the call was placed
      {"success": False, "suppressed": True, ...}       DNC screening blocked the number (a redial settles it as do-not-call)
      {"success": False, "busy": True, "phone"}         the number is on another call right now: nothing was placed
      {"success": False, "gated": reason}               the gate refused (paused / hours / capacity): nothing was placed
      {"success": False, "unscreened": True, "outage", ...}  the DNC screening is down ("outage") or the number cannot be
                                                        screened: nothing was placed, the number stays queued
      {"success": False, "slot_taken": True, ...}       another placement took the slot: nothing was placed
      {"success": False, "bookkeeping": True, ...}      the attempt could not be recorded (fail_closed): nothing was placed
      {"success": False, "capacity": True, ...}         the provider has no room: the attempt was taken back (not a failed call)
      {"success": False, "daily_limit": True, ...}      the provider says the number reached its daily call limit
      {"success": False, "ambiguous": True, ...}       the provider did not answer in time: the call may be on the line,
                                                        its attempt stays open until the reaper closes it
      {"success": False, "phone", "error"}              the provider could not place the call (that counts as a failed attempt)
    `took_attempt` is True when an attempt row was taken (it consumes Paced time and a slot).

    Every placed call takes an attempt first (services/call_retry.begin_attempt): its unique index is what keeps
    a number from ever being on two campaign calls at once. `new_round` starts the number again at attempt 1
    (the campaign's own pass); a redial passes the due `lead` and continues at attempts + 1.

    The dialing engine passes `gate` (a function called right before the attempt, with no `await` in between:
    dialer.gate), `dial` (how the call is placed, for the log: {"source"}), `fail_closed=True` (a broken
    bookkeeping step places NO call; without it the call goes out untracked, as it always did) and `now` (the
    placement time; None = the clock).
    """
    campaign_id = camp["id"]
    phone = contact["phone"]
    # Screen before dialing. A suppressed (or unverifiable) number is skipped, and the caller carries on
    # with the rest of the list, rather than aborting the whole campaign. `cached_verdict` is a verdict
    # pre-fetched for the batch (or None to let check_number look it up itself).
    if camp.get("dnc_screening_enabled", True):
        screen = await whitelist_service.check_number(owner_id, phone, cached=cached_verdict)
        if not screen["allowed"]:
            if lead:
                if screen.get("suppressed"):
                    call_retry.settle(lead, "do_not_call")
                else:
                    # The screening could not run (provider outage, unreadable number): that says nothing about the
                    # number, so the redial stays due and is tried again by a later sweep.
                    return {"success": False, "unscreened": True, "outage": bool(screen.get("unavailable")),
                            "phone": phone, "error": screen["reason"]}
            elif screen.get("unavailable"):
                # A provider outage says nothing about a fresh number either: it stays in the queue (an unreadable
                # number, by contrast, is skipped below).
                return {"success": False, "unscreened": True, "outage": True, "phone": phone, "error": screen["reason"]}
            return {"success": False, "suppressed": True, "phone": phone, "error": screen["reason"] or "Suppressed"}

    # The gate and the attempt are ONE unit run off the event loop (they are a handful of database round trips),
    # back to back under a process-wide lock: nothing can slip between them, so the caps stay exact in this process.
    async with _placement_queue():
        taken = await asyncio.to_thread(_take_attempt, camp, owner_id, contact, new_round, lead, gate, dial, fail_closed, now)
    if taken.get("result") is not None:
        return taken["result"]
    camp, attempt = taken["camp"], taken["attempt"]

    call_payload = {"assistantId": vapi_assistant_id, "customer": {"number": phone}}
    if vapi_phone_id:
        call_payload["phoneNumberId"] = vapi_phone_id
    try:
        placed = await vapi_client.create_call(call_payload)
    except Exception as e:
        took = bool(attempt)
        if attempt and gate is not None:
            if isinstance(e, httpx.TimeoutException):
                # The provider did not answer in time: the call may be on the line. The attempt stays open (the
                # number stays busy, the slot taken) until the reaper closes it; placing again could call twice.
                return {"success": False, "ambiguous": True, "took_attempt": True, "phone": phone,
                        "error": "The provider did not answer in time; the call is being checked."}
            if dial_limits.is_daily_limit_error(e) or dial_limits.is_capacity_error(e):
                # No room (or the number's daily limit): the attempt is taken back as if the call had never been
                # tried (no failed attempt, no retry burned) and the engine waits.
                try:
                    call_retry.release_attempt(attempt)
                except Exception:  # noqa: BLE001
                    logger.exception("could not take back the refused attempt %s", attempt.get("id"))
                key = "daily_limit" if dial_limits.is_daily_limit_error(e) else "capacity"
                return {"success": False, key: True, "phone": phone, "error": str(e)}
        if attempt:
            try:
                call_retry.placement_failed(attempt, e)
            except Exception:  # noqa: BLE001
                logger.exception("could not close the failed attempt %s", attempt.get("id"))
        return {"success": False, "phone": phone, "error": str(e), "took_attempt": took}
    # Remember which campaign placed the call: it decides the time zone the call's times are shown
    # in once the call is logged (conversations.campaign_id), and the call's attempt is matched to its end
    # by the call id. Best-effort: it must never turn a placed call into a failure.
    call_id = placed.get("id") if isinstance(placed, dict) else None
    if call_id:
        await asyncio.to_thread(_record_placed, attempt, call_id, campaign_id, owner_id)
    return {"success": True, "phone": phone, "took_attempt": bool(attempt)}


def _start_data(owner_id: str, campaign_id: str, res, *, resumed: bool, already_running: bool = False) -> dict:
    """The `data` of a Start / Resume answer. The legacy keys (dialed, errors, error_details, suppressed,
    suppressed_details, already_on_call, stopped_by_hours / remaining / next_open_at, stopped_by_person) describe
    the FIRST tick, run inline; the real totals of a running pass come from /campaigns/live."""
    row = dialer._read(campaign_id) or {}
    counts = dialer.live_counts(row) if row else {"active_now": 0, "queued_fresh": 0, "queued_redials": 0, "placed": 0}
    s = dial_settings.describe(row)
    try:
        limits = (dial_limits.limits_for([owner_id]) or {}).get(owner_id)
    except Exception:  # noqa: BLE001
        limits = None
    cap, source = dial_limits.cap_of(limits)
    eff = dial_settings.effective(row, cap, source)
    capped = None
    if eff["capped"]:
        concurrent = s["strategy"] == "concurrent"
        capped = {"requested": s["concurrent_calls"] if concurrent else s["calls_per_minute"],
                  "effective": eff["concurrent_calls"] if concurrent else cap, "reason": eff["cap_source"]}
    data = {
        "started": not already_running,
        "resumed": resumed,
        "already_running": already_running,
        "strategy": s["strategy"],
        "dialed": res.placed if res else 0,
        "redials_placed": res.redials_placed if res else 0,
        "errors": res.errors if res else 0,
        "error_details": res.error_details if res else [],
        "suppressed": res.suppressed if res else 0,
        "suppressed_details": res.suppressed_details if res else [],
        "already_on_call": res.already_on_call if res else 0,
        "queued": counts["queued_fresh"] + counts["queued_redials"],
        "active_now": counts["active_now"],
        "placed": counts["placed"],
        "capped": capped,
    }
    if res and res.stopped == "hours" and (res.parked or res.restored):
        data.update({"stopped_by_hours": True, "remaining": res.remaining,
                     "next_open_at": res.next_open_at.strftime("%Y-%m-%dT%H:%M:%SZ") if res.next_open_at else None})
    elif res and res.stopped == "paused":
        data.update({"stopped_by_person": True, "remaining": res.remaining})
    return data


@router.post("/campaigns/{campaign_id}/start")
async def start_campaign(campaign_id: str, user=Depends(get_current_user)):
    """Start a campaign: its pass over the list is opened and the dialing engine (services/dialer.py) places the
    calls according to the campaign's dialing strategy (Sequential, Concurrent or Paced), using the campaign's
    agent and phone number. The request returns after the FIRST tick, which places what the strategy allows right
    away; the rest of the list is dialed by the engine in the background (watch /campaigns/live).

    Fails with 4xx if the campaign is missing, its agent/list/phone number isn't set up, the account is blocked, the
    balance is empty, the list has no dialable contacts or the calling hours are closed (503 while the database is
    being upgraded). A failed dial or a DNC-suppressed number is recorded and skipped, never aborting the pass.

    Start is idempotent: on a campaign that is already running it changes nothing and answers 200 with
    `already_running: true`. On a campaign with a pass left open (stopped by the calling hours or paused) it carries
    on from where it stopped, so nobody is called twice; on any other campaign it begins a new pass over the whole
    list. If the hours close before the first call of this Start the campaign is left as it was.

    Calling hours: nothing is placed while they are closed, in any strategy. A pass the hours stop leaves the
    campaign Paused with its place kept and the "continue automatically" marker (services/campaign_scheduler.py).

    Returns started / resumed / already_running / strategy / dialed / redials_placed / errors / suppressed /
    already_on_call / queued / active_now / placed / capped for the first tick (plus up to 5 sample errors and
    suppressed numbers) and, when the hours or a person stopped it, `stopped_by_hours` (with `remaining` and
    `next_open_at`) / `stopped_by_person`; and the campaign's cap `warnings`.
    """
    if not dialer.ready():
        raise HTTPException(status_code=503, detail="Dialing is being upgraded. Try again in a few minutes.")
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
    # The balance is checked once here; the engine checks it again (with a reserve per open call) as it goes.
    if not check_call_quota(owner_id, "outbound"):
        raise HTTPException(status_code=402, detail="Your balance is empty. Add funds to keep making calls.")

    if not camp.get("list_id"):
        raise HTTPException(status_code=400, detail="Campaign has no contact list assigned. Edit the campaign and select a list.")

    if not camp.get("phone_number_id"):
        raise HTTPException(status_code=400, detail="Campaign has no phone number assigned. Edit the campaign and select a phone number to call from.")

    # Calling hours: nothing is dialed while they are closed.
    _raise_if_closed(camp)

    running = bool(camp.get("dial_running"))
    if camp.get("status") == "Active" and running:
        # Already going: nothing to start (a double click, the Start button racing the automatic continuing).
        dialer.nudge()
        return {"data": _start_data(owner_id, campaign_id, None, resumed=False, already_running=True),
                "warnings": _warnings_for(owner_id, camp), "error": None}

    # A pass left open (the hours stopped it, a person paused it, or the old engine left its cursor) carries on
    # from its place; otherwise this Start begins a new pass over the whole list.
    open_pass = running or bool(camp.get("dial_cursor"))
    if open_pass:
        probe = camp if running else {**camp, "dial_seq": None, "dial_legacy_cursor": camp.get("dial_cursor")}
        if dialer.fresh_left(probe) == 0:
            # The earlier pass had stopped part-way and nothing is left after it. Forget the place, so the next
            # start dials the whole list again, and say why nothing happened now.
            supabase.table("outbound_campaigns").update(
                {"dial_cursor": None, "dial_seq": None, "dial_legacy_cursor": None, "dial_running": False,
                 "status": "Inactive", "stopped_by_hours_at": None, "dial_next_at": None, "dial_stall": None}
            ).eq("id", campaign_id).execute()
            raise HTTPException(status_code=400, detail="Every contact in this list has already been dialed. Start the campaign again to dial the list from the beginning.")
        dialable = None
    else:
        dialable = dialer.fresh_left({**camp, "dial_seq": None, "dial_legacy_cursor": None})
        if not dialable:
            raise HTTPException(status_code=400, detail="No contacts with phone numbers in the list")

    pn = (
        supabase.table("phone_numbers")
        .select("vapi_phone_id")
        .eq("id", camp["phone_number_id"])
        .maybe_single()
        .execute()
    )
    if not (pn.data.get("vapi_phone_id") if pn.data else None):
        raise HTTPException(status_code=400, detail="The campaign's phone number is not active yet. Wait for activation or re-provision the number.")

    now_iso = call_retry.iso(datetime.now(timezone.utc))
    table = supabase.table("outbound_campaigns")
    if open_pass:
        # (dial_next_at and dial_stall are left alone: a Paced grid or a back-off still holds, so Pause / Resume can
        # never be used to get a call out early)
        updates = {"status": "Active", "stopped_by_hours_at": None, "dial_running": True}
        if not running:
            # converted on the fly: the old engine's cursor becomes the legacy cursor of a pass that now has a place of its own
            updates.update({"dial_legacy_cursor": camp.get("dial_cursor"), "dial_seq": None})
            if not camp.get("dial_pass_started_at"):
                updates["dial_pass_started_at"] = now_iso
        won = table.update(updates).eq("id", campaign_id).eq("status", camp["status"]).eq("dial_running", running).execute().data
    else:
        # A new pass, in ONE atomic update (contacts_count is reset to the number of dialable contacts, which can be
        # lower than the list size stored when the campaign was created).
        won = table.update({
            "status": "Active", "dial_running": True, "dial_seq": None, "dial_cursor": None, "dial_legacy_cursor": None,
            "dial_pass_started_at": now_iso, "dial_next_at": None, "dial_stall": None, "dial_counters": {},
            "dial_batch_seq": 0, "stopped_by_hours_at": None, "contacts_count": dialable,
            "followup_done": 0, "followup_next_at": None,        # a new pass begins the second-chance rounds again too
        }).eq("id", campaign_id).eq("dial_running", False).is_("dial_cursor", "null").execute().data
    if not won:
        # Somebody changed the campaign between the read and the update (a second Start got there first).
        now_row = dialer._read(campaign_id)
        if now_row and now_row.get("status") == "Active" and now_row.get("dial_running"):
            dialer.nudge()
            return {"data": _start_data(owner_id, campaign_id, None, resumed=False, already_running=True),
                    "warnings": _warnings_for(owner_id, now_row), "error": None}
        raise HTTPException(status_code=409, detail="The campaign was changed while it was starting. Try again.")

    # The first tick runs inline: it places what the strategy allows right away. If the hours close before its first
    # call, the campaign goes back to how it was.
    restore = {"status": camp.get("status"), "stopped_by_hours_at": camp.get("stopped_by_hours_at"), "was_running": running}
    res = await dialer.tick(campaign_id, restore=restore)
    dialer.nudge()
    return {"data": _start_data(owner_id, campaign_id, res, resumed=open_pass),
            "warnings": _warnings_for(owner_id, dialer._read(campaign_id)), "error": None}


@router.post("/campaigns/{campaign_id}/pause")
async def pause_campaign(campaign_id: str, user=Depends(get_current_user)):
    """Mark the campaign Paused. The dialing engine obeys it on the very next call (not the next batch): no new call
    is placed, calls already in progress are not interrupted and settle normally, and the campaign keeps its place in the
    pass (Start / Resume carries on from it). Also stops a run the calling hours stopped from continuing by
    itself (see services/campaign_scheduler.py). Succeeds even if the campaign isn't found."""
    # A person pausing it also cancels the automatic continuing (the place is kept: Start/Resume carries on from it).
    supabase.table("outbound_campaigns").update({"status": "Paused", "stopped_by_hours_at": None}).eq("id", campaign_id).eq("user_id", resolve_owner_id(user["user_id"])).execute()
    dialer.nudge()
    return {"data": {"status": "Paused"}, "error": None}


@router.post("/campaigns/{campaign_id}/resume")
async def resume_campaign(campaign_id: str, user=Depends(get_current_user)):
    """Mark the campaign Active again. A campaign with a pass left open (paused, or stopped by its calling hours)
    carries on with the numbers left, exactly like /start. Any other campaign only becomes Active again (its due
    redials go on); use /start to dial the list. Succeeds even if the campaign isn't found."""
    owner_id = resolve_owner_id(user["user_id"])
    parked = (
        supabase.table("outbound_campaigns").select("dial_cursor, dial_running")
        .eq("id", campaign_id).eq("user_id", owner_id).maybe_single().execute()
    ).data
    if parked and (parked.get("dial_running") or parked.get("dial_cursor")):
        return await start_campaign(campaign_id, user)
    supabase.table("outbound_campaigns").update({"status": "Active"}).eq("id", campaign_id).eq("user_id", owner_id).execute()
    dialer.nudge()
    return {"data": {"status": "Active"}, "error": None}


class RetryUnreachedBody(BaseModel):
    activate: StrictBool = False


@router.post("/campaigns/{campaign_id}/retry-unreached")
async def retry_unreached(campaign_id: str, body: RetryUnreachedBody | None = None, user=Depends(get_current_user)):
    """Call again ONLY the numbers that never picked up even after every redial (final status "Max attempts
    reached"): each goes into a new round (attempts 0, due now) and the dialing engine places it as redials-first
    work, under the campaign's dialing strategy, calling hours, pause/resume and the account caps. It works with Auto
    Redial switched off too: the first call of a requeued number is always placed; what follows it obeys the campaign's
    retry settings. Numbers that answered, were transferred, disqualified, asked not to be called, were invalid or
    were not retried are not touched. Idempotent: a second click while they are queued requeues none.

    An Active campaign dials them right away. A campaign that is not Active keeps them queued, and is only set Active
    when `activate` is true. 404 if the campaign isn't this account's. Returns requeued / skipped_busy (queued numbers
    that are on another call now and are dialed when free) / campaign_status / message."""
    owner_id = resolve_owner_id(user["user_id"])
    camp = (
        supabase.table("outbound_campaigns").select("*")
        .eq("id", campaign_id).eq("user_id", owner_id).maybe_single().execute()
    ).data
    if not camp:
        raise HTTPException(status_code=404, detail="Campaign not found")
    done = await asyncio.to_thread(call_retry.requeue_unreached, camp)
    n, busy = done["requeued"], done["skipped_busy"]
    if n:
        # A second-chance round that was scheduled has nothing left to call once these numbers are queued; the rounds
        # used so far and the campaign's other settings are untouched (the button is independent of them).
        from services import campaign_scheduler
        await asyncio.to_thread(campaign_scheduler.release_followup_if_none_unreached, campaign_id)
    status = camp.get("status")
    activate = bool(body and body.activate)
    if n and status != "Active" and activate:
        supabase.table("outbound_campaigns").update({"status": "Active", "stopped_by_hours_at": None}) \
            .eq("id", campaign_id).eq("user_id", owner_id).execute()
        status = "Active"
    if n:
        dialer.nudge()
    if not n:
        message = "There are no unreached numbers to call again."
    elif status == "Active":
        message = f"{n} number{'s' if n != 1 else ''} queued to be called again."
        if busy:
            message += f" {busy} {'is' if busy == 1 else 'are'} on another call right now and will be dialed as soon as the line is free."
    else:
        message = (f"{n} number{'s' if n != 1 else ''} queued. They will be dialed when the campaign is Active.")
    return {"data": {"requeued": n, "skipped_busy": busy, "campaign_status": status, "message": message}, "error": None}


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
