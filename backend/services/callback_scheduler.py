"""
Places due callbacks. SAFE BY DEFAULT: it only touches accounts that explicitly turned on
`callback_settings.auto_call`; every other account's callbacks stay plain records.

Per callback, in order: needs a phone number -> inside the calling window (else postponed to the
next opening, not counted as an attempt) -> wallet/plan allows an outbound call -> number is not on a
DNC/litigator list -> agent is set up for calls -> place the call through the same VAPI path as
campaigns. A callback is claimed atomically (pending -> calling) so two workers can never both call.
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from config import settings
from database import supabase
from routers.billing import check_call_quota, get_or_create_billing, outbound_call_block_reason
from services import callback_service as cbs
from services import vapi_client, whitelist_service

logger = logging.getLogger(__name__)
# Most callbacks picked up in a single sweep; a larger backlog is drained over several sweeps.
BATCH = 50


def _iso(dt: datetime) -> str:
    """Format a datetime as a UTC timestamp string ending in Z, the form written to and compared
    against `callbacks.due_at`."""
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _claim(cb_id: str) -> bool:
    """Atomically move one callback pending -> calling. Only the caller that wins the update gets
    True, so two workers (or two overlapping sweeps) can never both place the same call."""
    # The `status = pending` filter is the guard: the update matches no row if another worker
    # already moved it, and the returned list of updated rows is then empty.
    won = supabase.table("callbacks").update({"status": "calling", "updated_at": "now()"}) \
        .eq("id", cb_id).eq("status", "pending").execute().data
    return bool(won)


def _finish(cb_id: str, **fields) -> None:
    """Write the given columns (status, attempts, last_error, due_at, ...) to a callback row and
    bump its `updated_at`. Used to record the outcome of every dispatch."""
    supabase.table("callbacks").update({**fields, "updated_at": "now()"}).eq("id", cb_id).execute()


async def _place_call(user_id: str, agent_id: str, phone: str) -> str | None:
    """Create the VAPI call; returns its id. Tries the account's active numbers in turn, since a
    stored number can go stale if it was removed on VAPI's side."""
    # Scoped to the account so a callback can only use one of its own agents.
    agent = (supabase.table("ai_agents").select("vapi_assistant_id").eq("id", agent_id)
             .eq("user_id", user_id).limit(1).execute().data)
    # LookupError is final for the callback: _dispatch does not retry it, since a missing or
    # unprovisioned agent will not fix itself between attempts.
    if not agent or not agent[0].get("vapi_assistant_id"):
        raise LookupError("The agent for this callback is missing or not set up for calls.")
    # Caller-ID candidates: the account's most recently updated active numbers that are synced
    # to VAPI (at most 5).
    numbers = (supabase.table("phone_numbers").select("vapi_phone_id").eq("user_id", user_id)
               .eq("status", "Active").not_.is_("vapi_phone_id", "null")
               .order("updated_at", desc=True).limit(5).execute().data or [])
    last: Exception | None = None
    # With no usable number, make a single attempt without `phoneNumberId` in the payload.
    for vapi_phone_id in [n["vapi_phone_id"] for n in numbers] or [None]:
        payload = {"assistantId": agent[0]["vapi_assistant_id"], "customer": {"number": phone}}
        if vapi_phone_id:
            payload["phoneNumberId"] = vapi_phone_id
        try:
            return (await vapi_client.create_call(payload)).get("id")
        except Exception as e:  # noqa: BLE001
            last = e
            # Only a "does not exist" error (a stale phone number id) moves on to the next
            # number; any other error is raised immediately.
            if "does not exist" not in str(e):
                raise
    # Every number was rejected as stale: surface the last error.
    if last:
        raise last
    return None


async def _dispatch(cb: dict, s: dict, now: datetime) -> str:
    """Handle one claimed callback. Returns 'called' | 'deferred' | 'skipped' | 'failed' | 'retry'."""
    user_id, phone = cb["user_id"], cb.get("phone")
    if not phone:
        _finish(cb["id"], status="skipped", last_error="No phone number is known for this caller.")
        return "skipped"

    # Outside calling hours the callback goes back to pending at the next opening time. This does
    # not count as an attempt.
    if not cbs.in_calling_window(now, s):
        _finish(cb["id"], status="pending", due_at=_iso(cbs.next_window_start(now, s)),
                last_error="Outside your calling hours, moved to the next opening.")
        return "deferred"

    # Billing gate: first the account-level block (e.g. a trial account may not place calls),
    # then a positive wallet balance. Either way the callback fails outright and the reason is
    # stored for the user; it is not retried.
    reason = outbound_call_block_reason(get_or_create_billing(user_id))
    if not reason and not check_call_quota(user_id, "outbound"):
        reason = "Your wallet balance is empty."
    if reason:
        _finish(cb["id"], status="failed", last_error=reason)
        return "failed"

    # Number of this attempt. Deferrals, billing blocks and do-not-call skips leave the stored
    # count unchanged; it is written only when the dial succeeds or raises an error.
    attempts = cb["attempts"] + 1
    try:
        screen = await whitelist_service.check_number(user_id, phone)
        # A do-not-call hit is a skip, not a failure, and keeps the old attempt count.
        if not screen["allowed"]:
            _finish(cb["id"], status="skipped", attempts=cb["attempts"],
                    last_error=f"On a do-not-call list ({screen.get('reason') or 'suppressed'}).")
            return "skipped"
        # _no_agent() raises, so a callback whose agent was deleted takes the same failure path.
        call_id = await _place_call(user_id, cb["agent_id"], phone) if cb.get("agent_id") else _no_agent()
    except Exception as e:  # noqa: BLE001
        logger.warning("callback %s attempt %s failed: %s", cb["id"], attempts, e)
        error = str(e)[:300]
        # Final failure: a LookupError (no agent / agent not set up) or the attempt limit reached.
        # Otherwise the callback returns to pending and is retried after `retry_minutes`.
        if isinstance(e, LookupError) or attempts >= s["max_attempts"]:
            _finish(cb["id"], status="failed", attempts=attempts, last_attempt_at="now()", last_error=error)
            return "failed"
        _finish(cb["id"], status="pending", attempts=attempts, last_attempt_at="now()", last_error=error,
                due_at=_iso(now + timedelta(minutes=s["retry_minutes"])))
        return "retry"

    # Success: keep the VAPI id of the call that was created and clear any error left by an
    # earlier attempt.
    _finish(cb["id"], status="called", attempts=attempts, last_attempt_at="now()", placed_call_id=call_id, last_error=None)
    return "called"


def _no_agent():
    """Raise LookupError for a callback whose agent no longer exists. A function (rather than an
    inline raise) so _dispatch can use it inside a conditional expression."""
    raise LookupError("The agent for this callback no longer exists.")


async def run_due_callbacks(now: datetime | None = None) -> dict:
    """Run one sweep: place the callbacks that are due for accounts with auto-calling on, earliest
    due first, at most BATCH per sweep. Returns how many ended in each outcome (called, deferred,
    skipped, failed, retry). Called periodically by callback_loop; `now` can be injected."""
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    summary = {"called": 0, "deferred": 0, "skipped": 0, "failed": 0, "retry": 0}
    # Opt-in gate: only accounts with auto_call switched on are ever touched.
    enabled = [r["user_id"] for r in (supabase.table("callback_settings").select("user_id").eq("auto_call", True).execute().data or [])]
    if not enabled:
        return summary
    due = (supabase.table("callbacks").select("*").eq("status", "pending").in_("user_id", enabled)
           .lte("due_at", _iso(now)).order("due_at").limit(BATCH).execute().data or [])
    for cb in due:
        if not _claim(cb["id"]):
            continue            # another worker got it
        try:
            # Settings are looked up per callback because each belongs to a different account.
            outcome = await _dispatch(cb, cbs.get_settings(cb["user_id"]), now)
        except Exception as e:  # noqa: BLE001 — never leave a callback stuck in "calling"
            logger.exception("callback %s crashed: %s", cb["id"], e)
            _finish(cb["id"], status="failed", last_error=f"Unexpected error: {str(e)[:200]}")
            outcome = "failed"
        summary[outcome] += 1
    return summary


async def callback_loop() -> None:
    """Background task that sweeps for due callbacks forever, every
    `callback_sweep_interval_seconds`. Started from main.py at app startup when that setting is
    greater than 0. A failing sweep is logged and never stops the loop."""
    interval = settings.callback_sweep_interval_seconds
    await asyncio.sleep(30)     # let startup settle
    while True:
        try:
            result = await run_due_callbacks()
            # Log only sweeps that did something, to keep the idle log quiet.
            if any(result.values()):
                logger.info("callbacks: %s", result)
        except Exception as e:  # noqa: BLE001
            logger.exception("callback sweep failed: %s", e)
        await asyncio.sleep(interval)
