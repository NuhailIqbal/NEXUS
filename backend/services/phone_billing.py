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
    y = dt.year + (1 if dt.month == 12 else 0)
    m = 1 if dt.month == 12 else dt.month + 1
    last_day = calendar.monthrange(y, m)[1]
    return dt.replace(year=y, month=m, day=min(dt.day, last_day))


def _parse_dt(value) -> datetime | None:
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
    return (
        supabase.table("phone_numbers")
        .select("id, user_id, number, monthly_cost, next_billing_at")
        .eq("provider", "twilio")
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
    interval = settings.phone_billing_sweep_interval_seconds
    logger.info(f"phone-billing: background sweep started (every {interval}s)")
    while True:
        try:
            await run_billing_sweep()
        except Exception as e:
            logger.warning(f"phone-billing: pass failed: {e}")
        await asyncio.sleep(interval)
