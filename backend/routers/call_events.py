"""
Call event library: account-level event definitions that agents pick from.

Editing or deleting an event changes every agent that uses it, so those agents are
re-synced with VAPI afterwards. A VAPI failure never blocks the change — the database
is the source of truth — it is returned as `warnings` so the UI can tell the user.
"""

from fastapi import APIRouter, Depends, HTTPException
from dependencies import get_current_user
from database import supabase
from models.schemas import CallEventCreate, CallEventUpdate
from routers.team import resolve_owner_id
from services import call_events as ce
from services.agent_events_sync import resync_agents

router = APIRouter(prefix="/call-events", tags=["Call Events"])


def _raise(e: ce.LibraryError):
    raise HTTPException(status_code=e.status, detail=str(e))


@router.get("")
async def list_events(user=Depends(get_current_user)):
    owner_id = resolve_owner_id(user["user_id"])
    events = ce.list_library(owner_id)
    usage: dict[str, list[str]] = {}
    if events:
        rows = (
            supabase.table("call_events")
            .select("library_event_id, agent_id")
            .in_("library_event_id", [e["id"] for e in events])
            .execute()
        ).data or []
        agent_ids = sorted({r["agent_id"] for r in rows})
        names = {}
        if agent_ids:
            names = {a["id"]: a["name"] for a in (
                supabase.table("ai_agents").select("id, name").in_("id", agent_ids).execute().data or []
            )}
        for r in rows:
            usage.setdefault(r["library_event_id"], []).append(r["agent_id"])
        for e in events:
            ids = usage.get(e["id"], [])
            e["agents"] = [{"id": i, "name": names.get(i, "")} for i in ids]
            e["agent_count"] = len(ids)
    return {"data": events, "error": None}


@router.post("")
async def create_event(body: CallEventCreate, user=Depends(get_current_user)):
    owner_id = resolve_owner_id(user["user_id"])
    try:
        row = ce.create_library_event(owner_id, body.label, body.description, body.outcome, body.applies_to,
                                      body.schedules_callback)
    except ce.LibraryError as e:
        _raise(e)
    return {"data": {**row, "agents": [], "agent_count": 0}, "error": None}


@router.patch("/{event_id}")
async def update_event(event_id: str, body: CallEventUpdate, user=Depends(get_current_user)):
    owner_id = resolve_owner_id(user["user_id"])
    changes = body.model_dump(exclude_none=True)
    try:
        row = ce.update_library_event(owner_id, event_id, changes)
    except ce.LibraryError as e:
        _raise(e)
    warnings = await resync_agents(ce.agents_using_event(event_id))
    return {"data": row, "error": None, "warnings": warnings}


@router.delete("/{event_id}")
async def delete_event(event_id: str, user=Depends(get_current_user)):
    owner_id = resolve_owner_id(user["user_id"])
    try:
        agent_ids = ce.delete_library_event(owner_id, event_id)
    except ce.LibraryError as e:
        _raise(e)
    warnings = await resync_agents(agent_ids)
    return {"data": {"removed_from_agents": len(agent_ids)}, "error": None, "warnings": warnings}
