from fastapi import APIRouter, Depends
from dependencies import get_current_user
from database import supabase
from models.schemas import TeamInvite, TeamMemberUpdate

router = APIRouter(prefix="/team", tags=["Team"])


@router.get("")
async def list_members(user=Depends(get_current_user)):
    result = (
        supabase.table("team_members")
        .select("*")
        .eq("owner_id", user["user_id"])
        .order("created_at", desc=True)
        .execute()
    )
    return {"data": result.data, "error": None}


@router.post("/invite")
async def invite_member(body: TeamInvite, user=Depends(get_current_user)):
    row = {
        "owner_id": user["user_id"],
        "member_email": body.member_email,
        "role": body.role,
    }
    result = supabase.table("team_members").insert(row).execute()
    return {"data": result.data[0] if result.data else None, "error": None}


@router.patch("/{member_id}")
async def update_member_role(member_id: str, body: TeamMemberUpdate, user=Depends(get_current_user)):
    updates = body.model_dump(exclude_none=True)
    if not updates:
        return {"data": None, "error": "No fields to update"}
    result = (
        supabase.table("team_members")
        .update(updates)
        .eq("id", member_id)
        .eq("owner_id", user["user_id"])
        .execute()
    )
    return {"data": result.data[0] if result.data else None, "error": None}


@router.delete("/{member_id}")
async def remove_member(member_id: str, user=Depends(get_current_user)):
    supabase.table("team_members").delete().eq("id", member_id).eq("owner_id", user["user_id"]).execute()
    return {"data": None, "error": None}
