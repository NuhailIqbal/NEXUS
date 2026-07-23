from fastapi import APIRouter, Depends
from pydantic import BaseModel
from typing import Optional

from dependencies import get_current_user
from database import supabase

router = APIRouter(prefix="/notifications", tags=["Notifications"])


@router.get("")
async def list_notifications(user=Depends(get_current_user)):
    rows = (
        supabase.table("notifications")
        .select("id, kind, title, body, read, created_at")
        .eq("user_id", user["user_id"])
        .order("created_at", desc=True)
        .limit(30)
        .execute()
        .data
        or []
    )
    unread = sum(1 for r in rows if not r.get("read"))
    return {"data": {"notifications": rows, "unread": unread}, "error": None}


class MarkRead(BaseModel):
    id: Optional[str] = None  # None -> mark all read


@router.post("/read")
async def mark_read(body: MarkRead, user=Depends(get_current_user)):
    q = supabase.table("notifications").update({"read": True}).eq("user_id", user["user_id"])
    if body.id:
        q = q.eq("id", body.id)
    q.execute()
    return {"data": {"ok": True}, "error": None}
