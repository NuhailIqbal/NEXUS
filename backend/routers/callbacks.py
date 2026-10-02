"""
Callbacks: the calls customers asked for ("call me back at 5"), recorded when an event that
schedules a callback is raised during a call. Anyone on the account can see and manage them;
only the OWNER can change the settings (they decide whether callbacks are placed automatically,
which spends wallet money).
"""

from fastapi import APIRouter, Depends, HTTPException, Query

from dependencies import get_current_user, require_owner
from models.schemas import CallbackSettingsUpdate, CallbackUpdate
from routers.team import resolve_owner_id
from services import callback_service as cbs

router = APIRouter(prefix="/callbacks", tags=["Callbacks"])


def _fail(e: cbs.CallbackError):
    raise HTTPException(status_code=e.status, detail=str(e))


@router.get("/settings")
async def get_settings(user=Depends(get_current_user)):
    return {"data": cbs.get_settings(resolve_owner_id(user["user_id"])), "error": None}


@router.patch("/settings")
async def update_settings(body: CallbackSettingsUpdate, user=Depends(require_owner)):
    try:
        return {"data": cbs.save_settings(user["user_id"], body.model_dump(exclude_none=True)), "error": None}
    except cbs.CallbackError as e:
        _fail(e)


@router.get("")
async def list_callbacks(status: str | None = Query(None), user=Depends(get_current_user)):
    owner_id = resolve_owner_id(user["user_id"])
    if status and status not in cbs.STATUSES:
        raise HTTPException(status_code=400, detail="Unknown status.")
    return {"data": cbs.list_callbacks(owner_id, status), "error": None,
            "meta": {"counts": cbs.status_counts(owner_id)}}


@router.patch("/{callback_id}")
async def update_callback(callback_id: str, body: CallbackUpdate, user=Depends(get_current_user)):
    owner_id = resolve_owner_id(user["user_id"])
    if (body.due_local is None) == (body.status is None):
        raise HTTPException(status_code=400, detail="Send either due_local or status.")
    try:
        row = cbs.reschedule(owner_id, callback_id, body.due_local) if body.due_local is not None \
            else cbs.set_status(owner_id, callback_id, body.status)
    except cbs.CallbackError as e:
        _fail(e)
    return {"data": row, "error": None}
