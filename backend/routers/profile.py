"""
Profile endpoints — read and edit the signed-in user's own row in `profiles`.

Mounted at /profile. Both routes act on the caller's own profile (keyed by the JWT
user id), never on the team owner's, so team members each keep a separate profile.
The profile row itself is created at signup/login by routers/auth.py.
"""
from fastapi import APIRouter, Depends
from dependencies import get_current_user
from database import supabase
from models.schemas import ProfileUpdate

router = APIRouter(prefix="/profile", tags=["Profile"])


@router.get("")
async def get_profile(user=Depends(get_current_user)):
    """Return the caller's full profile row, or null data if no profile row exists yet."""
    result = supabase.table("profiles").select("*").eq("id", user["user_id"]).maybe_single().execute()
    return {"data": result.data, "error": None}


@router.patch("")
async def update_profile(body: ProfileUpdate, user=Depends(get_current_user)):
    """Partially update the caller's profile (full_name, company_name, phone).

    Only fields that are present and non-null in the body are written, so a field cannot
    be cleared to NULL through this endpoint. Returns the updated row; if the body has no
    fields, nothing is written and the response carries an error string instead.
    """
    # exclude_none: omitted/null fields are left untouched (PATCH semantics).
    updates = body.model_dump(exclude_none=True)
    if not updates:
        return {"data": None, "error": "No fields to update"}
    result = supabase.table("profiles").update(updates).eq("id", user["user_id"]).execute()
    return {"data": result.data[0] if result.data else None, "error": None}
