"""Background auto-sync of VAPI calls into the conversations table.

VAPI can't reach a localhost backend to push webhooks, so instead of relying on
real-time delivery we poll VAPI on a timer and pull in any new (or not-yet-complete)
calls. This mirrors the manual `POST /conversations/sync-from-vapi` endpoint but runs
org-wide for every user, dispatching each call to its owner via the assistant id.

The DB client (`db_pg.supabase`) is synchronous, so all DB work is offloaded with
`asyncio.to_thread` to avoid blocking the event loop.
"""
import asyncio
import logging
from datetime import datetime, timezone

from config import settings
from database import supabase
from services import vapi_client
from routers.webhooks import import_vapi_call

logger = logging.getLogger(__name__)

# A just-ended call's recording/transcript artifact can lag a little; retry a
# stored-but-recording-less call only if it ended within this window. Beyond it,
# assume it simply has no recording (No Answer / very short call) and stop
# re-fetching it every cycle.
_RETRY_WINDOW_SECONDS = 20 * 60


def _assistant_user_map() -> dict[str, str]:
    """{ vapi_assistant_id -> user_id } for every VAPI-linked agent (one query)."""
    rows = supabase.table("ai_agents").select("user_id, vapi_assistant_id").execute().data or []
    return {r["vapi_assistant_id"]: r["user_id"] for r in rows if r.get("vapi_assistant_id")}


def _existing_by_call_id(call_ids: list[str]) -> dict[str, dict]:
    """{ vapi_call_id -> {id, recording_url} } for call ids already stored."""
    if not call_ids:
        return {}
    rows = (
        supabase.table("conversations")
        .select("vapi_call_id, recording_url")
        .in_("vapi_call_id", call_ids)
        .execute()
        .data
        or []
    )
    return {r["vapi_call_id"]: r for r in rows if r.get("vapi_call_id")}


def _is_ended(call: dict) -> bool:
    status = (call.get("status") or "").lower()
    return status == "ended" or bool(call.get("endedAt")) or bool(call.get("endedReason"))


def _ended_recently(call: dict) -> bool:
    """True if the call ended within the retry window (artifact may still be arriving)."""
    ts = call.get("endedAt") or call.get("updatedAt") or call.get("createdAt")
    if not ts:
        return False
    try:
        ended = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        return (datetime.now(timezone.utc) - ended).total_seconds() <= _RETRY_WINDOW_SECONDS
    except Exception:
        return False


async def run_global_sync() -> dict:
    """One sync pass: pull recent VAPI calls and import new/incomplete ones."""
    if not settings.vapi_api_key:
        return {"skipped": "no vapi_api_key"}

    calls = await vapi_client.list_calls(limit=settings.vapi_sync_limit)
    if not calls:
        return {"scanned": 0, "imported": 0, "updated": 0}

    assistant_map = await asyncio.to_thread(_assistant_user_map)

    # Keep only ended calls that belong to one of our agents.
    candidates = [
        c for c in calls
        if c.get("assistantId") in assistant_map and c.get("id") and _is_ended(c)
    ]

    existing = await asyncio.to_thread(_existing_by_call_id, [c["id"] for c in candidates])

    # Process a call if it isn't stored yet, or is stored but still has no recording
    # AND ended recently (its artifact may not have been ready the first time we saw
    # it). Old recording-less calls are left alone so we don't re-fetch them forever.
    to_process = [
        c for c in candidates
        if c["id"] not in existing
        or (not existing[c["id"]].get("recording_url") and _ended_recently(c))
    ]

    imported = updated = failed = 0
    for c in to_process:
        try:
            full = await vapi_client.get_call(c["id"])
            res = await asyncio.to_thread(import_vapi_call, full, assistant_map[c["assistantId"]])
            if res == "imported":
                imported += 1
            elif res == "updated":
                updated += 1
        except Exception as e:  # never let one bad call abort the whole pass
            failed += 1
            logger.warning(f"vapi-sync: failed to import call {c.get('id')}: {e}")

    result = {"scanned": len(calls), "candidates": len(candidates), "imported": imported, "updated": updated, "failed": failed}
    if imported or updated or failed:
        logger.info(f"vapi-sync: {result}")
    return result


async def sync_loop() -> None:
    """Run `run_global_sync` forever on the configured interval.

    NOTE: this is an in-process loop and assumes a single worker/replica (true for
    the current Dockerfile + dev `--reload`). If the backend is ever scaled to
    multiple workers/replicas, guard this with a distributed lock / leader election
    so the sync doesn't run concurrently in every process.
    """
    interval = settings.vapi_sync_interval_seconds
    logger.info(f"vapi-sync: background loop started (every {interval}s, limit {settings.vapi_sync_limit})")
    while True:
        try:
            await run_global_sync()
        except Exception as e:
            logger.warning(f"vapi-sync: pass failed: {e}")
        await asyncio.sleep(interval)
