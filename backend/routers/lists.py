"""Contact lists API: CRUD over the `lists` table, mounted under /lists.

A list is a named group of contacts (contacts.list_id points at it) and is what an
outbound campaign dials. Used by the dashboard Lists and Contacts pages and by the
campaign dialog. All queries are scoped to the account owner's id (see
routers.team.resolve_owner_id) and responses use the {"data": ..., "error": ...} envelope.
"""
from fastapi import APIRouter, Depends
from dependencies import get_current_user
from database import supabase
from models.schemas import ListCreate, ListUpdate
from routers.team import resolve_owner_id

router = APIRouter(prefix="/lists", tags=["Lists"])


@router.get("")
async def list_lists(user=Depends(get_current_user)):
    """List the account's contact lists, newest first, each with a live `contact_count`
    (the number of contacts currently assigned to it)."""
    owner_id = resolve_owner_id(user["user_id"])
    result = (
        supabase.table("lists")
        .select("*")
        .eq("user_id", owner_id)
        .order("created_at", desc=True)
        .execute()
    )
    lists = result.data or []

    if lists:
        # Count members with one contacts query for all lists (not one per list) and
        # tally in memory. The result overwrites the stored lists.contact_count column
        # in the response; nothing in the backend maintains that column, so this live
        # count is the only accurate figure.
        list_ids = [l["id"] for l in lists]
        contacts_result = (
            supabase.table("contacts")
            .select("list_id")
            .eq("user_id", owner_id)
            .in_("list_id", list_ids)
            .execute()
        )
        counts: dict = {}
        for c in (contacts_result.data or []):
            lid = c.get("list_id")
            if lid:
                counts[lid] = counts.get(lid, 0) + 1
        for l in lists:
            l["contact_count"] = counts.get(l["id"], 0)

    return {"data": lists, "error": None}


@router.post("")
async def create_list(body: ListCreate, user=Depends(get_current_user)):
    """Create an empty contact list owned by the caller's account and return the stored row."""
    row = body.model_dump()
    row["user_id"] = resolve_owner_id(user["user_id"])
    result = supabase.table("lists").insert(row).execute()
    return {"data": result.data[0] if result.data else None, "error": None}


@router.get("/{list_id}")
async def get_list(list_id: str, user=Depends(get_current_user)):
    """Fetch one list by id. Returns data null (not a 404) when it does not exist or
    belongs to another account. Unlike list_lists, contact_count here is the stored
    column, not a live count."""
    result = (
        supabase.table("lists")
        .select("*")
        .eq("id", list_id)
        .eq("user_id", resolve_owner_id(user["user_id"]))
        .maybe_single()
        .execute()
    )
    return {"data": result.data, "error": None}


@router.patch("/{list_id}")
async def update_list(list_id: str, body: ListUpdate, user=Depends(get_current_user)):
    """Rename a list. Returns the updated row, or data null if no name was sent or the
    list is not this account's."""
    updates = body.model_dump(exclude_none=True)
    if not updates:
        return {"data": None, "error": "No fields to update"}
    result = (
        supabase.table("lists")
        .update(updates)
        .eq("id", list_id)
        .eq("user_id", resolve_owner_id(user["user_id"]))
        .execute()
    )
    return {"data": result.data[0] if result.data else None, "error": None}


@router.delete("/{list_id}")
async def delete_list(list_id: str, user=Depends(get_current_user)):
    """Delete a list; succeeds even if the id does not exist. Its contacts are kept
    (contacts.list_id becomes NULL) and campaigns using it lose their list (also set to
    NULL by the foreign key). The TeamRoleGuard middleware (main.py) rejects DELETE for
    team sub-users."""
    supabase.table("lists").delete().eq("id", list_id).eq("user_id", resolve_owner_id(user["user_id"])).execute()
    return {"data": None, "error": None}
