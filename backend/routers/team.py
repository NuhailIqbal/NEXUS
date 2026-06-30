from fastapi import APIRouter, Depends, HTTPException
from dependencies import get_current_user
from database import supabase
from models.schemas import TeamInvite, TeamMemberUpdate

router = APIRouter(prefix="/team", tags=["Team"])

VALID_PERMISSIONS = [
    "create_agents",
    "create_campaigns",
    "create_contacts",
    "view_conversations",
    "view_analytics",
    "manage_integrations",
]

DEFAULT_MEMBER_PERMISSIONS = [
    "create_agents",
    "create_campaigns",
    "create_contacts",
    "view_conversations",
    "view_analytics",
]


def resolve_owner_id(user_id: str) -> str:
    """If user is a sub-user, return their parent's ID. Otherwise return their own."""
    membership = (
        supabase.table("team_members")
        .select("owner_id")
        .eq("member_user_id", user_id)
        .eq("status", "Active")
        .maybe_single()
        .execute()
    )
    if membership.data:
        return membership.data["owner_id"]
    return user_id


def get_user_role(user_id: str) -> str:
    """Returns 'owner' if this is a parent account, 'member' if sub-user."""
    membership = (
        supabase.table("team_members")
        .select("role")
        .eq("member_user_id", user_id)
        .eq("status", "Active")
        .maybe_single()
        .execute()
    )
    if membership.data:
        return membership.data.get("role", "member")
    return "owner"


def get_user_permissions(user_id: str) -> list[str]:
    """Owner gets all permissions. Members get their assigned list."""
    membership = (
        supabase.table("team_members")
        .select("permissions")
        .eq("member_user_id", user_id)
        .eq("status", "Active")
        .maybe_single()
        .execute()
    )
    if not membership.data:
        return VALID_PERMISSIONS
    return membership.data.get("permissions") or DEFAULT_MEMBER_PERMISSIONS


def check_permission(user_id: str, permission: str):
    perms = get_user_permissions(user_id)
    if permission not in perms:
        raise HTTPException(status_code=403, detail=f"You don't have permission: {permission}")


def is_owner(user_id: str) -> bool:
    return get_user_role(user_id) == "owner"


@router.get("")
async def list_members(user=Depends(get_current_user)):
    owner_id = resolve_owner_id(user["user_id"])

    result = (
        supabase.table("team_members")
        .select("*")
        .eq("owner_id", owner_id)
        .order("created_at", desc=True)
        .execute()
    )
    return {"data": result.data, "error": None}


@router.get("/me")
async def my_role(user=Depends(get_current_user)):
    role = get_user_role(user["user_id"])
    permissions = get_user_permissions(user["user_id"])
    owner_id = resolve_owner_id(user["user_id"])
    return {
        "data": {
            "role": role,
            "permissions": permissions,
            "owner_id": owner_id,
            "is_owner": role == "owner",
        },
        "error": None,
    }


@router.post("/invite")
async def invite_member(body: TeamInvite, user=Depends(get_current_user)):
    if not is_owner(user["user_id"]):
        raise HTTPException(status_code=403, detail="Only account owners can invite team members")

    existing = (
        supabase.table("team_members")
        .select("id")
        .eq("owner_id", user["user_id"])
        .eq("member_email", body.member_email)
        .maybe_single()
        .execute()
    )
    if existing.data:
        raise HTTPException(status_code=400, detail="This email has already been invited")

    invited_user = None
    try:
        auth_users = supabase.auth.admin.list_users()
        for u in auth_users:
            if u.email and u.email.lower() == body.member_email.lower():
                invited_user = u
                break
    except Exception:
        pass

    row = {
        "owner_id": user["user_id"],
        "member_email": body.member_email,
        "member_user_id": str(invited_user.id) if invited_user else None,
        "role": body.role or "member",
        "permissions": body.permissions or DEFAULT_MEMBER_PERMISSIONS,
        "status": "Active" if invited_user else "Pending",
    }

    result = supabase.table("team_members").insert(row).execute()
    return {"data": result.data[0] if result.data else None, "error": None}


@router.patch("/{member_id}")
async def update_member(member_id: str, body: TeamMemberUpdate, user=Depends(get_current_user)):
    if not is_owner(user["user_id"]):
        raise HTTPException(status_code=403, detail="Only account owners can update team members")

    updates = body.model_dump(exclude_none=True)
    if not updates:
        return {"data": None, "error": "No fields to update"}

    if "permissions" in updates:
        invalid = [p for p in updates["permissions"] if p not in VALID_PERMISSIONS]
        if invalid:
            raise HTTPException(status_code=400, detail=f"Invalid permissions: {invalid}")

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
    if not is_owner(user["user_id"]):
        raise HTTPException(status_code=403, detail="Only account owners can remove team members")

    supabase.table("team_members").delete().eq("id", member_id).eq("owner_id", user["user_id"]).execute()
    return {"data": None, "error": None}
