"""Background recurring billing for Twilio phone numbers.

Each Twilio-provisioned number has a `next_billing_at` renewal date. On a timer, this
sweep charges the wallet (via `debit_balance`, so auto-recharge and inbound-suspension
already fire correctly) for every number whose renewal date has arrived, then advances
that date by one month regardless of whether the charge fully succeeded — a partial or
failed charge drains the wallet to $0, which the existing suspension mechanism (see
routers/billing.py's `debit_balance` -> `_sync_inbound_routing`) already handles, and the
number un-suspends automatically the moment the balance recovers.

VAPI-provisioned numbers are free and are structurally excluded: they never get a
next_billing_at set, so they never match the sweep's query.

The DB client (`database.supabase`) is synchronous, so all DB work is offloaded with
`asyncio.to_thread` to avoid blocking the event loop — mirrors services/vapi_sync.py.
"""
import asyncio
import calendar
import logging
from datetime import datetime, timezone

from config import settings
from database import supabase
from routers.billing import PHONE_NUMBER_MONTHLY_COST, debit_balance

logger = logging.getLogger(__name__)


def _add_one_month(dt: datetime) -> datetime:
    """Same calendar day next month, clamped to that month's last day."""
    # The clamp is never undone: applying this repeatedly to an already-clamped date keeps
    # the lower day (Jan 31 -> Feb 28 -> Mar 28). The datetime's tzinfo is preserved.
    y = dt.year + (1 if dt.month == 12 else 0)
    m = 1 if dt.month == 12 else dt.month + 1
    last_day = calendar.monthrange(y, m)[1]
    return dt.replace(year=y, month=m, day=min(dt.day, last_day))


def _parse_dt(value) -> datetime | None:
    """Coerce a datetime or ISO-8601 string (a trailing "Z" is accepted) to a timezone-aware
    datetime, treating naive values as UTC. Returns None for empty or unparseable input."""
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        d = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except Exception:
        return None


def _next_future_billing_date(created_at: datetime, now: datetime) -> datetime:
    """The next renewal date strictly after `now`, stepping forward a month at a time
    from `created_at`. Used both for new-number provisioning and backfilling existing
    numbers — never bills a backlog of missed months, only ever the next one due."""
    due = _add_one_month(created_at)
    while due <= now:
        due = _add_one_month(due)
    return due


def _fetch_due_numbers(now_iso: str) -> list[dict]:
    """Return Twilio-backed (platform or BYOT) phone_numbers rows whose `next_billing_at`
    is at or before `now_iso`. Synchronous DB call; invoked via asyncio.to_thread."""
    # Ordered by user, then by due date, so each user's numbers are charged consecutively
    # and oldest-due first.
    return (
        supabase.table("phone_numbers")
        .select("id, user_id, number, monthly_cost, next_billing_at")
        .in_("provider", ["twilio", "twilio_byot"])
        .not_.is_("next_billing_at", "null")
        .lte("next_billing_at", now_iso)
        .order("user_id")
        .order("next_billing_at")
        .execute()
        .data
        or []
    )


async def run_billing_sweep() -> dict:
    """One pass: charge every Twilio number whose renewal date has arrived."""
    # Each due number is debited at its own `monthly_cost` (falling back to the platform
    # default), then its `next_billing_at` is moved to the next future month. The returned
    # {"due", "billed", "failed"} counts treat only raised exceptions as "failed": an
    # insufficient wallet is not a failure here, because `debit_balance` floors at $0
    # without raising, so that number still counts as billed.
    now = datetime.now(timezone.utc)
    due = await asyncio.to_thread(_fetch_due_numbers, now.isoformat())
    if not due:
        return {"due": 0, "billed": 0, "failed": 0}

    billed = failed = 0
    for n in due:
        try:
            amount = float(n.get("monthly_cost") or PHONE_NUMBER_MONTHLY_COST)
            # Called directly on the event loop (not via asyncio.to_thread): debit_balance
            # schedules inbound-routing suspension with asyncio.create_task internally,
            # which requires a running loop on the calling thread — the same reason every
            # other call site (billing.py, telephony.py, admin.py) calls it directly too.
            debit_balance(
                n["user_id"], amount, "phone",
                f"Monthly renewal — {n['number']}", n["id"],
            )
            # Step forward from the stored due date (not from `now`) so the billing day is
            # kept, and keep stepping until it is in the future so a long outage never
            # results in several months being charged in one pass.
            # The debit above and this date update are not atomic: if the update fails,
            # `next_billing_at` stays in the past and the number is charged again on the
            # next sweep.
            current = _parse_dt(n["next_billing_at"]) or now
            next_due = _add_one_month(current)
            while next_due <= now:
                next_due = _add_one_month(next_due)
            await asyncio.to_thread(
                lambda pid=n["id"], nd=next_due: supabase.table("phone_numbers")
                .update({"next_billing_at": nd.isoformat()})
                .eq("id", pid)
                .execute()
            )
            billed += 1
        except Exception:
            # One bad number must not stop the rest of the sweep; it is retried next pass.
            failed += 1
            logger.exception("phone-billing: failed to charge number %s", n.get("id"))

    result = {"due": len(due), "billed": billed, "failed": failed}
    if billed or failed:
        logger.info("phone-billing: %s", result)
    return result


async def billing_sweep_loop() -> None:
    """Run `run_billing_sweep` forever on the configured interval.

    NOTE: this is an in-process loop and assumes a single worker/replica (true for the
    current Dockerfile + dev `--reload`), mirroring services/vapi_sync.py's sync_loop.
    """
    # Defaults to 3600s; main.py only starts this loop when the setting is > 0.
    interval = settings.phone_billing_sweep_interval_seconds
    logger.info(f"phone-billing: background sweep started (every {interval}s)")
    while True:
        # A failed pass is logged and retried after the next sleep; it must not end the loop.
        try:
            await run_billing_sweep()
        except Exception as e:
            logger.warning(f"phone-billing: pass failed: {e}")
        await asyncio.sleep(interval)
