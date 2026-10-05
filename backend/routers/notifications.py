"""
In-app notifications — the list behind the dashboard's notification bell.

Mounted at /notifications. Reads and updates the `notifications` table, which is written
elsewhere (low-balance alerts in routers/billing.py, DNC-suppression notices in
routers/telephony.py). This module never creates notifications.

Rows are scoped to the account owner (resolve_owner_id), so a team member sees and
clears the same notifications as the owner they belong to.
"""
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from typing import Optional

from dependencies import get_current_user
from database import supabase
from routers.team import resolve_owner_id

router = APIRouter(prefix="/notifications", tags=["Notifications"])


@router.get("")
async def list_notifications(user=Depends(get_current_user)):
    """List the account's 30 most recent notifications (newest first) plus an unread count.

    Team members receive the owner's notifications. The `unread` count is computed over
    the returned page only, so unread items older than the latest 30 are not counted.
    """
    rows = (
        supabase.table("notifications")
        .select("id, kind, title, body, read, created_at")
        .eq("user_id", resolve_owner_id(user["user_id"]))
        .order("created_at", desc=True)
        .limit(30)
        .execute()
        .data
        or []
    )
    unread = sum(1 for r in rows if not r.get("read"))
    return {"data": {"notifications": rows, "unread": unread}, "error": None}


class MarkRead(BaseModel):
    """Request body for POST /notifications/read; omit `id` to mark everything read."""
    id: Optional[str] = None  # None -> mark all read


@router.post("/read")
async def mark_read(body: MarkRead, user=Depends(get_current_user)):
    """Mark one notification (by `id`) or, with no id, all of the account's notifications as read.

    The update is always restricted to the owner's account, so an id belonging to another
    account is silently a no-op. Read state is shared by everyone on the team because the
    rows belong to the owner. Always returns ok, even when no row matched.
    """
    q = supabase.table("notifications").update({"read": True}).eq("user_id", resolve_owner_id(user["user_id"]))
    if body.id:
        q = q.eq("id", body.id)
    q.execute()
    return {"data": {"ok": True}, "error": None}
