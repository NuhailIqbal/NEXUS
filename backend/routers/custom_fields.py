from fastapi import APIRouter, Depends
from dependencies import get_current_user
from database import supabase
from models.schemas import CustomFieldCreate, CustomFieldUpdate

router = APIRouter(prefix="/custom-fields", tags=["Custom Fields"])


@router.get("")
async def list_custom_fields(user=Depends(get_current_user)):
    result = (
        supabase.table("custom_fields")
        .select("*")
        .eq("user_id", user["user_id"])
        .order("created_at", desc=True)
        .execute()
    )
    return {"data": result.data, "error": None}


@router.post("")
async def create_custom_field(body: CustomFieldCreate, user=Depends(get_current_user)):
    row = body.model_dump()
    row["user_id"] = user["user_id"]
    result = supabase.table("custom_fields").insert(row).execute()
    return {"data": result.data[0] if result.data else None, "error": None}


@router.patch("/{field_id}")
async def update_custom_field(field_id: str, body: CustomFieldUpdate, user=Depends(get_current_user)):
    updates = body.model_dump(exclude_none=True)
    if not updates:
        return {"data": None, "error": "No fields to update"}
    result = (
        supabase.table("custom_fields")
        .update(updates)
        .eq("id", field_id)
        .eq("user_id", user["user_id"])
        .execute()
    )
    return {"data": result.data[0] if result.data else None, "error": None}


@router.delete("/{field_id}")
async def delete_custom_field(field_id: str, user=Depends(get_current_user)):
    supabase.table("custom_fields").delete().eq("id", field_id).eq("user_id", user["user_id"]).execute()
    return {"data": None, "error": None}
