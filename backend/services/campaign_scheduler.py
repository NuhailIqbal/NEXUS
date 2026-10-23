"""
Continues outbound campaigns that the calling hours stopped, by themselves, the next time the hours
open: no one has to press Start.

A run that is still going when a campaign's hours end stops between batches and parks the campaign as
Paused with `dial_cursor` (the last contact handled) and `stopped_by_hours_at` (the marker that says
"continue automatically", see routers/telephony.start_campaign). Every sweep looks for exactly those
campaigns whose hours are open now and starts them again from the cursor, through the same code as the
Start button, so the next contact is the one after where the previous run ended and nobody is called
twice. If that run is cut off again by the hours, it is parked again and continues the next day, and
so on until the list is finished.

Only campaigns carrying the marker are touched. Anything a person does to a campaign (Pause, a different
status, another list, hours switched off) clears it, so a deliberate pause is never overridden. The marker
is claimed atomically before the run, so two sweeps can never start the same campaign twice. If the
automatic start is refused (empty wallet, agent no longer set up, ...) the user is notified once and the
campaign stays Paused for them to fix and Start.

The same sweep also places the REDIALS of numbers that did not pick up (services/call_retry.py): every due
number of a campaign that is Active, has retrying on and is inside its calling hours is called again, in
batches like the campaign's own run. A paused/stopped campaign keeps its due redials and places them when it
is Active again; a redial that falls outside the hours is moved to the next opening.
"""
import asyncio
import logging
from datetime import datetime, timezone

from fastapi import HTTPException

from config import settings
from database import supabase
from services import call_hours, call_retry

logger = logging.getLogger(__name__)


def _claim(campaign_id: str) -> bool:
    """Atomically take the "continue automatically" marker off one campaign. Only the sweep that wins
    the update gets True, so two overlapping sweeps (or workers) cannot both start the campaign."""
    won = (
        supabase.table("outbound_campaigns")
        .update({"stopped_by_hours_at": None})
        .eq("id", campaign_id)
        .not_.is_("stopped_by_hours_at", "null")
        .execute()
        .data
    )
    return bool(won)


def _rearm(campaign_id: str) -> None:
    """Put the marker back on a campaign that was claimed but could not start only because the hours
    closed in the meantime (the sweep saw them open, the start a moment later did not), so it still
    continues at the next opening instead of being forgotten. Skipped if a person changed the campaign
    since: it must still be the Paused one we claimed."""
    supabase.table("outbound_campaigns").update(
        {"stopped_by_hours_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    ).eq("id", campaign_id).eq("status", "Paused").is_("stopped_by_hours_at", "null").execute()


def _notify(user_id: str, title: str, body: str) -> None:
    """Best-effort in-app notification; it must never affect the campaign."""
    from routers.billing import _insert_notification

    _insert_notification(user_id, "campaign_auto_resume", title, body)


# The runs a background sweep started and has not awaited (kept so they are not garbage collected).
_background_runs: set = set()


async def run_auto_resumes(now: datetime | None = None, wait: bool = True) -> dict:
    """One sweep: continue every waiting campaign whose calling hours are open. Returns counts:
    resumed (started again), waiting (hours still closed, or another run already has the campaign),
    refused (the start was refused and the owner told).

    With wait=True (the default, used by tests and one-off calls) the runs are awaited and the counts
    are complete. The background loop passes wait=False: each run goes on in its own task and the sweep
    returns at once, so a long run (minutes for a big list) never delays the next sweep, which must
    still notice a campaign in another zone whose hours have just opened; resumed/refused then only
    count what finished before the sweep returned."""
    # Imported here: routers/telephony imports services that import this package, so a top-level
    # import would be circular.
    from routers import telephony

    now = now or datetime.now(timezone.utc)
    rows = (
        supabase.table("outbound_campaigns")
        .select("*")
        .eq("status", "Paused")
        .eq("call_hours_enabled", True)
        .not_.is_("dial_cursor", "null")
        .not_.is_("stopped_by_hours_at", "null")
        .execute()
        .data
        or []
    )
    result = {"resumed": 0, "waiting": 0, "refused": 0}

    async def resume_one(camp: dict) -> None:
        # An unreadable setting counts as closed: the safe side for a dialer.
        if not call_hours.is_open(camp, call_hours.CAMPAIGN, now, if_unreadable=False):
            result["waiting"] += 1
            return
        if not _claim(camp["id"]):
            return    # a person or another sweep got there first
        name = camp.get("name") or "Campaign"
        try:
            # The owner's own id resolves to itself, so this is the Start button's code path.
            res = await telephony.start_campaign(camp["id"], {"user_id": camp["user_id"]})
        except HTTPException as e:
            if e.status_code == 409:
                # Someone else (a person pressing Start, another worker) is running the campaign: it
                # is theirs now, and it re-marks itself if the hours stop it. Nothing to report.
                result["waiting"] += 1
                return
            if not call_hours.is_open(camp, call_hours.CAMPAIGN, if_unreadable=False):
                # The hours closed between the check above and the start: not a problem to report,
                # just wait for the next opening.
                _rearm(camp["id"])
                result["waiting"] += 1
                return
            result["refused"] += 1
            logger.warning("auto-resume of campaign %s refused: %s", camp["id"], e.detail)
            _notify(camp["user_id"], f"{name} could not continue automatically",
                    f"It was due to continue now but was not started: {e.detail} Fix that, then press Start "
                    f"to carry on from where it stopped.")
            return
        except Exception as e:  # noqa: BLE001 - one campaign must not stop the others
            result["refused"] += 1
            logger.exception("auto-resume of campaign %s failed: %s", camp["id"], e)
            _notify(camp["user_id"], f"{name} could not continue automatically",
                    "Something went wrong starting it again. Press Start to carry on from where it stopped.")
            return
        result["resumed"] += 1
        data = (res or {}).get("data") or {}
        logger.info("auto-resumed campaign %s: %s", camp["id"], {k: data.get(k) for k in ("dialed", "remaining", "stopped_by_hours")})
        left = data.get("remaining")
        _notify(camp["user_id"], f"{name} continued automatically",
                f"The calling hours opened and the campaign carried on from where it stopped: "
                f"{data.get('dialed', 0)} contact{'s' if data.get('dialed', 0) != 1 else ''} called"
                + (f", {left} left for the next opening." if data.get("stopped_by_hours") and left else "."))

    # Campaigns run side by side: one long list must not hold up the others' continuing.
    async def guarded(camp: dict) -> None:
        try:
            await resume_one(camp)
        except Exception:  # noqa: BLE001 - e.g. a database error; one campaign must not stop the others
            logger.exception("auto-resume of campaign %s failed unexpectedly", camp.get("id"))

    tasks = [asyncio.ensure_future(guarded(c)) for c in rows]
    if wait:
        await asyncio.gather(*tasks)
    else:
        for t in tasks:
            _background_runs.add(t)
            t.add_done_callback(_background_runs.discard)
    return result


# Campaigns whose redials a sweep is placing right now (a slow batch must not be started a second time by
# the next sweep; the unique open-attempt index would stop the duplicate calls anyway).
_retrying: set = set()


def _iso(moment: datetime) -> str:
    return call_retry.iso(moment)


def _dial_setup(camp: dict) -> tuple[str | None, str | None, str | None]:
    """(VAPI assistant id, VAPI phone id, why the campaign cannot dial now or None) for placing redials: the
    same things start_campaign checks, minus the calling hours."""
    from routers import telephony

    owner = camp["user_id"]
    assistant = None
    if camp.get("agent_id"):
        row = supabase.table("ai_agents").select("vapi_assistant_id").eq("id", camp["agent_id"]).maybe_single().execute().data
        assistant = (row or {}).get("vapi_assistant_id")
    if not assistant:
        return None, None, "the campaign's agent is not set up for calls"
    phone = None
    if camp.get("phone_number_id"):
        row = supabase.table("phone_numbers").select("vapi_phone_id").eq("id", camp["phone_number_id"]).maybe_single().execute().data
        phone = (row or {}).get("vapi_phone_id")
    if not phone:
        return assistant, None, "the campaign's phone number is not active"
    reason = telephony.outbound_call_block_reason(telephony.get_or_create_billing(owner))
    if reason:
        return assistant, phone, reason
    if not telephony.check_call_quota(owner, "outbound"):
        return assistant, phone, "the balance is empty"
    return assistant, phone, None


async def _redial(camp: dict, lead: dict, contact: dict | None, assistant: str, phone_id: str) -> str:
    """Place (or settle without placing) the due redial of one number. Returns what happened: placed,
    busy (the number is on another call: it stays due), failed (the provider could not place it: that
    counts as a failed attempt), suppressed, max_attempts, cancelled."""
    from routers import telephony

    # The number must still be in the campaign's list with a phone, or there is nobody to call.
    if not contact or not (contact.get("phone") or "").strip() or contact.get("list_id") != camp.get("list_id"):
        call_retry.settle(lead, call_retry.NOT_RETRIED)
        return "cancelled"
    # The maximum in force NOW: lowering it settles numbers that already have that many calls.
    if lead["attempts"] >= int(camp.get("retry_max_attempts") or 1):
        call_retry.settle(lead, call_retry.MAX_ATTEMPTS)
        return "max_attempts"
    r = await telephony._place_call(camp, camp["user_id"], contact, assistant, phone_id, new_round=False, lead=lead)
    if r["success"]:
        return "placed"
    if r.get("suppressed"):
        return "suppressed"
    if r.get("unscreened"):
        return "waiting"       # the DNC screening could not run: the redial stays due for a later sweep
    return "busy" if r.get("busy") else "failed"


async def _retry_campaign(camp: dict, leads: list[dict], clock, result: dict) -> None:
    """Place the due redials of one campaign (see run_retries). `clock()` is the current time, asked again before
    every batch so a long sweep never dials past the closing time."""
    from routers import telephony

    cid = camp["id"]
    if cid in _retrying:
        return
    _retrying.add(cid)
    try:
        if camp.get("status") != "Active":
            result["paused"] += len(leads)       # paused/stopped: they wait, and carry on when it is Active
            return
        if not camp.get("retry_enabled"):
            for lead in leads:
                call_retry.settle(lead, call_retry.NOT_RETRIED)
            result["cancelled"] += len(leads)
            return

        def closed_until():
            """False when the hours are open, else the next opening (None when it cannot be worked out)."""
            moment = clock()
            if call_hours.is_open(camp, call_hours.CAMPAIGN, moment, if_unreadable=False):
                return False
            return call_hours.next_opening(camp, call_hours.CAMPAIGN, moment)

        def push_to(nxt, rest: list[dict]) -> None:
            # Outside the hours: the redial moves to the next allowed window instead of staying "due".
            if nxt:
                supabase.table("campaign_leads").update({"next_attempt_at": _iso(nxt)}) \
                    .in_("id", [l["id"] for l in rest]).is_("final_status", "null").execute()
            result["waiting"] += len(rest)

        closed = closed_until()
        if closed is not False:
            push_to(closed, leads)
            return
        assistant, phone_id, blocked = _dial_setup(camp)
        if blocked:
            logger.warning("redials of campaign %s are waiting: %s", cid, blocked)
            result["waiting"] += len(leads)
            return
        contacts = {c["id"]: c for c in (supabase.table("contacts").select("id, name, phone, list_id")
                                         .in_("id", [l["contact_id"] for l in leads]).execute().data or [])}
        size = telephony.CAMPAIGN_BATCH_SIZE
        for i in range(0, len(leads), size):
            # Before every batch the campaign is read again: a Pause, a new list, switched-off retrying or
            # narrower hours are obeyed from this batch on.
            fresh = supabase.table("outbound_campaigns").select("*").eq("id", cid).maybe_single().execute().data
            if not fresh or fresh.get("status") != "Active" or not fresh.get("retry_enabled"):
                result["paused" if fresh and fresh.get("status") != "Active" else "cancelled"] += len(leads) - i
                return
            camp.update(fresh)
            closed = closed_until()
            if closed is not False:
                push_to(closed, leads[i:])
                return
            batch = leads[i:i + size]
            for outcome in await asyncio.gather(*[_redial(camp, l, contacts.get(l["contact_id"]), assistant, phone_id) for l in batch]):
                result[outcome] = result.get(outcome, 0) + 1
    finally:
        _retrying.discard(cid)


async def run_retries(now: datetime | None = None, wait: bool = True) -> dict:
    """One sweep of the redials: place every number whose next attempt is due. Returns counts: placed,
    busy, failed, suppressed, max_attempts, cancelled (settled without a call), paused (campaign not Active)
    and waiting (outside the calling hours, or the campaign cannot dial now).

    With wait=True (tests, one-off calls) the batches are awaited and the counts are complete; the
    background loop passes wait=False, so a long batch never delays the next sweep (the counts then only
    include what finished before it returned). A `now` given by the caller fixes the clock (tests); otherwise the
    real time is read again before every batch."""
    clock = (lambda: now) if now is not None else (lambda: datetime.now(timezone.utc))
    now = clock()
    try:
        call_retry.reap_stale()      # calls whose end report never came free their numbers
    except Exception:  # noqa: BLE001
        logger.exception("could not close stale attempts")
    due = (
        supabase.table("campaign_leads").select("*")
        .is_("final_status", "null").not_.is_("next_attempt_at", "null").lte("next_attempt_at", _iso(now))
        .order("next_attempt_at").execute().data or []
    )
    result = {"placed": 0, "busy": 0, "failed": 0, "suppressed": 0, "max_attempts": 0, "cancelled": 0, "paused": 0, "waiting": 0}
    if not due:
        return result
    by_campaign: dict[str, list[dict]] = {}
    for lead in due:
        by_campaign.setdefault(lead["campaign_id"], []).append(lead)
    camps = {c["id"]: c for c in (supabase.table("outbound_campaigns").select("*").in_("id", list(by_campaign)).execute().data or [])}

    async def guarded(cid: str) -> None:
        try:
            await _retry_campaign(camps[cid], by_campaign[cid], clock, result)
        except Exception:  # noqa: BLE001 - one campaign must not stop the others
            logger.exception("redials of campaign %s failed unexpectedly", cid)

    tasks = [asyncio.ensure_future(guarded(cid)) for cid in by_campaign if cid in camps]
    if wait:
        await asyncio.gather(*tasks)
    else:
        for t in tasks:
            _background_runs.add(t)
            t.add_done_callback(_background_runs.discard)
    return result


async def campaign_loop() -> None:
    """Background task that sweeps for waiting campaigns and due redials forever, every
    `campaign_sweep_interval_seconds`. Started from main.py at app startup when that setting is
    greater than 0. A failing sweep is logged and never stops the loop."""
    interval = settings.campaign_sweep_interval_seconds
    await asyncio.sleep(30)     # let startup settle
    while True:
        try:
            await run_auto_resumes(wait=False)
        except Exception as e:  # noqa: BLE001
            logger.exception("campaign sweep failed: %s", e)
        try:
            await run_retries(wait=False)
        except Exception as e:  # noqa: BLE001
            logger.exception("redial sweep failed: %s", e)
        await asyncio.sleep(interval)
