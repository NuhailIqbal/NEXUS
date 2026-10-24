"""
Continues outbound campaigns that the calling hours stopped, by themselves, the next time the hours
open: no one has to press Start.

A pass that is still going when a campaign's hours end stops at the next call and parks the campaign as
Paused with its place (`dial_seq` / `dial_cursor`, the last contact handled) and `stopped_by_hours_at` (the
marker that says "continue automatically", see services/dialer._handle_closed). Every sweep looks for exactly
those campaigns whose hours are open now and starts them again from their place, through the same code as the
Start button, so the next contact is the one after where the previous run ended and nobody is called
twice. If that run is cut off again by the hours, it is parked again and continues the next day, and
so on until the list is finished.

Only campaigns carrying the marker are touched. Anything a person does to a campaign (Pause, a different
status, another list, hours switched off) clears it, so a deliberate pause is never overridden. The marker
is claimed atomically before the run, so two sweeps can never start the same campaign twice. If the
automatic start is refused (empty wallet, agent no longer set up, ...) the user is notified once and the
campaign stays Paused for them to fix and Start.

The same sweep is also the safety net of the dialing engine (services/dialer.py), which normally wakes itself
every couple of seconds: it places the REDIALS of numbers that did not pick up (services/call_retry.py) and, when
asked, dispatches the campaigns' fresh numbers too (the only way campaigns advance when the engine's own loop is
switched off with DIALER_TICK_SECONDS=0, a degraded mode: one step a minute). Redials follow the campaign's dialing
strategy like every other call. A paused/stopped campaign keeps its due redials and places them when it is Active
again; a redial that falls outside the hours is moved to the next opening.
"""
import asyncio
import logging
from datetime import datetime, timezone

from fastapi import HTTPException

from config import settings
from database import supabase
from services import call_hours, call_retry, dialer

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
    resumed (started again), waiting (hours still closed, or the campaign is already running again),
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
    # A pass is open when it is running or still has a place (an old engine's cursor); raw SQL, as the query
    # shim has no OR.
    rows = dialer._q(
        "SELECT * FROM public.outbound_campaigns WHERE status = 'Paused' AND call_hours_enabled = true "
        "AND (dial_running OR dial_cursor IS NOT NULL) AND stopped_by_hours_at IS NOT NULL"
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
                # Someone changed the campaign while it was starting (a person pressing Start got there
                # first): it is theirs now, and it re-marks itself if the hours stop it. Nothing to report.
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
        data = (res or {}).get("data") or {}
        if data.get("already_running"):
            # A person (or a faster sweep) started it between the claim and now: it is going, nothing to report.
            result["waiting"] += 1
            return
        result["resumed"] += 1
        logger.info("auto-resumed campaign %s: %s", camp["id"], {k: data.get(k) for k in ("dialed", "remaining", "stopped_by_hours")})
        left = data.get("remaining")
        dialed = data.get("dialed", 0)
        if data.get("stopped_by_hours"):
            body = (f"The calling hours opened and the campaign carried on from where it stopped: "
                    f"{dialed} contact{'s' if dialed != 1 else ''} called"
                    + (f", {left} left for the next opening." if left else "."))
        else:
            queued = data.get("queued", 0)
            body = (f"The calling hours opened and the campaign carried on from where it stopped "
                    f"({queued} number{'s' if queued != 1 else ''} queued).")
        _notify(camp["user_id"], f"{name} continued automatically", body)

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


def _iso(moment: datetime) -> str:
    return call_retry.iso(moment)


async def run_retries(now: datetime | None = None, wait: bool = True, *, fresh: bool = False) -> dict:
    """One sweep of the redials: place every number whose next attempt is due. Returns counts: placed,
    busy, failed, suppressed, max_attempts, cancelled (settled without a call), paused (campaign not Active)
    and waiting (outside the calling hours, or the campaign cannot dial now).

    A thin wrapper over the dialing engine (services/dialer.dispatch_once): it keeps its guards (a campaign that
    is not Active keeps its redials, retrying switched off cancels them, calling hours closed move them to the next
    opening) and lets the engine place the rest, under each campaign's dialing strategy and limits. `fresh=True`
    also dispatches the campaigns' fresh numbers (the 60 s sweep does, as the safety net and the degraded mode of
    the engine's own loop); the counts are only the redials'.

    With wait=True (tests, one-off calls) the ticks are awaited and the counts are complete; the background loop
    passes wait=False, so a long tick never delays the next sweep (the counts then only include what finished
    before it returned). A `now` given by the caller fixes the clock (tests); otherwise the real time is read
    at every step."""
    moment = now if now is not None else datetime.now(timezone.utc)
    try:
        # calls whose end report never came free their numbers (reap_stale may ask the provider about a call, so it
        # runs off the event loop)
        await asyncio.to_thread(call_retry.reap_stale)
        await asyncio.to_thread(call_retry.reap_unplaced, moment, int(settings.dialer_unplaced_reap_seconds))
    except Exception:  # noqa: BLE001
        logger.exception("could not close stale attempts")
    result = {"placed": 0, "busy": 0, "failed": 0, "suppressed": 0, "max_attempts": 0, "cancelled": 0, "paused": 0, "waiting": 0}
    due = (
        supabase.table("campaign_leads").select("*")
        .is_("final_status", "null").not_.is_("next_attempt_at", "null").lte("next_attempt_at", _iso(moment))
        .order("next_attempt_at").execute().data or []
    )
    by_campaign: dict[str, list[dict]] = {}
    for lead in due:
        by_campaign.setdefault(lead["campaign_id"], []).append(lead)
    camps = {}
    if by_campaign:
        camps = {c["id"]: c for c in (supabase.table("outbound_campaigns").select("*").in_("id", list(by_campaign)).execute().data or [])}
    serve = False
    for cid, leads in by_campaign.items():
        camp = camps.get(cid)
        if not camp:
            continue
        if camp.get("status") != "Active":
            result["paused"] += len(leads)       # paused/stopped: they wait, and carry on when it is Active
        elif not camp.get("retry_enabled"):
            for lead in leads:
                call_retry.settle(lead, call_retry.NOT_RETRIED)
            result["cancelled"] += len(leads)
        elif not call_hours.is_open(camp, call_hours.CAMPAIGN, moment, if_unreadable=False):
            # Outside the hours: the redial moves to the next allowed window instead of staying "due".
            nxt = call_hours.next_opening(camp, call_hours.CAMPAIGN, moment)
            if nxt:
                supabase.table("campaign_leads").update({"next_attempt_at": _iso(nxt)}) \
                    .in_("id", [l["id"] for l in leads]).is_("final_status", "null").execute()
            result["waiting"] += len(leads)
        else:
            serve = True
    if not serve and not fresh:
        return result
    try:
        out = await dialer.dispatch_once(now, fresh=fresh, redials=True, wait=wait)
    except Exception:  # noqa: BLE001
        logger.exception("redial sweep failed")
        return result
    for cid, r in out["results"].items():
        result["placed"] += r.redials_placed
        if r.stall in ("agent", "number", "blocked", "balance"):
            # The campaign cannot dial now (agent, number, account, wallet): its due redials wait, none is lost.
            result["waiting"] += len(by_campaign.get(cid, []))
        for key in ("busy", "failed", "suppressed", "max_attempts", "cancelled", "waiting"):
            result[key] += r.redials[key]
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
            # The redials, and (fresh=True) the fresh numbers of every running campaign: the safety net of the
            # dialing engine's own loop, and the only thing that advances campaigns when that loop is off.
            await run_retries(wait=False, fresh=True)
        except Exception as e:  # noqa: BLE001
            logger.exception("redial sweep failed: %s", e)
        await asyncio.sleep(interval)
