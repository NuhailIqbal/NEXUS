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
"""
import asyncio
import logging
from datetime import datetime, timezone

from fastapi import HTTPException

from config import settings
from database import supabase
from services import call_hours

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


async def campaign_loop() -> None:
    """Background task that sweeps for waiting campaigns forever, every
    `campaign_sweep_interval_seconds`. Started from main.py at app startup when that setting is
    greater than 0. A failing sweep is logged and never stops the loop."""
    interval = settings.campaign_sweep_interval_seconds
    await asyncio.sleep(30)     # let startup settle
    while True:
        try:
            await run_auto_resumes(wait=False)
        except Exception as e:  # noqa: BLE001
            logger.exception("campaign sweep failed: %s", e)
        await asyncio.sleep(interval)
