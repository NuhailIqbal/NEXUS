from fastapi import APIRouter, Depends
from dependencies import get_current_user
from database import supabase
from models.schemas import ProfileUpdate

router = APIRouter(prefix="/profile", tags=["Profile"])


@router.get("")
async def get_profile(user=Depends(get_current_user)):
    result = supabase.table("profiles").select("*").eq("id", user["user_id"]).maybe_single().execute()
    return {"data": result.data, "error": None}


@router.patch("")
async def update_profile(body: ProfileUpdate, user=Depends(get_current_user)):
    updates = body.model_dump(exclude_none=True)
    if not updates:
        return {"data": None, "error": "No fields to update"}
    result = supabase.table("profiles").update(updates).eq("id", user["user_id"]).execute()
    return {"data": result.data[0] if result.data else None, "error": None}
