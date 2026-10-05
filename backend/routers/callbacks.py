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
    """Translate a service-level CallbackError into an HTTPException with the error's own
    status code and message. Always raises; callers use it inside `except` blocks."""
    raise HTTPException(status_code=e.status, detail=str(e))


@router.get("/settings")
async def get_settings(user=Depends(get_current_user)):
    """Return the account's callback settings (auto-call switch, timezone, calling days and
    hours, default time, retry delay, max attempts). Defaults are returned for any value the
    owner has not saved yet. Any account member may read them."""
    return {"data": cbs.get_settings(resolve_owner_id(user["user_id"])), "error": None}


@router.patch("/settings")
async def update_settings(body: CallbackSettingsUpdate, user=Depends(require_owner)):
    """Update the account's callback settings (partial update, owner only). Values are
    validated and merged with the saved ones; invalid input returns 400. Turning on
    `auto_call` lets the background scheduler place real outbound calls that are billed to
    the wallet, which is why only the owner may change settings."""
    try:
        # require_owner guarantees this user is the account owner, so their id is the account id
        # and no resolve_owner_id lookup is needed.
        return {"data": cbs.save_settings(user["user_id"], body.model_dump(exclude_none=True)), "error": None}
    except cbs.CallbackError as e:
        _fail(e)


@router.get("")
async def list_callbacks(status: str | None = Query(None), user=Depends(get_current_user)):
    """List the account's callbacks, latest due time first (capped at 200), optionally
    filtered by `status`. `meta.counts` holds the number of callbacks per status across the
    whole account, independent of the filter, so the page's filter tabs can show counts."""
    owner_id = resolve_owner_id(user["user_id"])
    if status and status not in cbs.STATUSES:
        raise HTTPException(status_code=400, detail="Unknown status.")
    return {"data": cbs.list_callbacks(owner_id, status), "error": None,
            "meta": {"counts": cbs.status_counts(owner_id)}}


@router.patch("/{callback_id}")
async def update_callback(callback_id: str, body: CallbackUpdate, user=Depends(get_current_user)):
    """Change one callback in exactly one way: reschedule it (`due_local`, a local date-time
    in the account's timezone, which puts it back to pending) or set its status to
    `cancelled` or `called`. Returns 404 if it is not in the account, 409 if it is already
    placed or being placed right now, and 400 for bad input."""
    owner_id = resolve_owner_id(user["user_id"])
    # Both comparisons are None-checks: equal means both fields were sent or neither was.
    if (body.due_local is None) == (body.status is None):
        raise HTTPException(status_code=400, detail="Send either due_local or status.")
    try:
        row = cbs.reschedule(owner_id, callback_id, body.due_local) if body.due_local is not None \
            else cbs.set_status(owner_id, callback_id, body.status)
    except cbs.CallbackError as e:
        _fail(e)
    return {"data": row, "error": None}
