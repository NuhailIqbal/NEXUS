from fastapi import APIRouter, Depends
from dependencies import get_current_user
from database import supabase
from models.schemas import ListCreate, ListUpdate

router = APIRouter(prefix="/lists", tags=["Lists"])


@router.get("")
async def list_lists(user=Depends(get_current_user)):
    result = (
        supabase.table("lists")
        .select("*")
        .eq("user_id", user["user_id"])
        .order("created_at", desc=True)
        .execute()
    )
    lists = result.data or []

    if lists:
        list_ids = [l["id"] for l in lists]
        contacts_result = (
            supabase.table("contacts")
            .select("list_id")
            .eq("user_id", user["user_id"])
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
    row = body.model_dump()
    row["user_id"] = user["user_id"]
    result = supabase.table("lists").insert(row).execute()
    return {"data": result.data[0] if result.data else None, "error": None}


@router.get("/{list_id}")
async def get_list(list_id: str, user=Depends(get_current_user)):
    result = (
        supabase.table("lists")
        .select("*")
        .eq("id", list_id)
        .eq("user_id", user["user_id"])
        .maybe_single()
        .execute()
    )
    return {"data": result.data, "error": None}


@router.patch("/{list_id}")
async def update_list(list_id: str, body: ListUpdate, user=Depends(get_current_user)):
    updates = body.model_dump(exclude_none=True)
    if not updates:
        return {"data": None, "error": "No fields to update"}
    result = (
        supabase.table("lists")
        .update(updates)
        .eq("id", list_id)
        .eq("user_id", user["user_id"])
        .execute()
    )
    return {"data": result.data[0] if result.data else None, "error": None}


@router.delete("/{list_id}")
async def delete_list(list_id: str, user=Depends(get_current_user)):
    supabase.table("lists").delete().eq("id", list_id).eq("user_id", user["user_id"]).execute()
    return {"data": None, "error": None}
