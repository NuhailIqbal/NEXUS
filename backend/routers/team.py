import logging
import secrets
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Depends, HTTPException
from psycopg.types.json import Json

from config import settings
from dependencies import get_current_user
from database import supabase
from models.schemas import TeamInvite, TeamMemberUpdate, TeamInviteAccept
from services.email_service import send_system_email
# NOTE: routers.auth is imported lazily inside accept_invite(), not at module level —
# auth.py imports from routers.billing, and other routers import resolve_owner_id from
# here, so a top-level import here would create routers.team <-> routers.auth <->
# routers.billing import cycle at process startup.

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/team", tags=["Team"])

INVITE_TTL_HOURS = 24 * 7  # 7 days

VALID_PERMISSIONS = [
    "create_agents",
    "create_campaigns",
    "create_contacts",
    "view_conversations",
    "view_analytics",
    "manage_integrations",
]

DEFAULT_MEMBER_PERMISSIONS = VALID_PERMISSIONS


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


def _owner_display_name(owner_id: str) -> str:
    profile = supabase.table("profiles").select("full_name").eq("id", owner_id).maybe_single().execute().data
    return (profile or {}).get("full_name") or "Someone"


async def _send_invite_email(email: str, token: str, owner_name: str, app_url: str | None) -> bool:
    base = (app_url or settings.public_app_url or "http://localhost:8080").rstrip("/")
    url = f"{base}/accept-invite?token={token}"
    html = (
        f"<p>{owner_name} has invited you to join their EDM Nexus team.</p>"
        f'<p><a href="{url}">Accept invite &amp; set up your account</a></p>'
        f"<p>Or paste this link into your browser:<br>{url}</p>"
        f"<p>This link expires in {INVITE_TTL_HOURS // 24} days.</p>"
    )
    try:
        return await send_system_email(email, f"{owner_name} invited you to EDM Nexus", html,
                                        f"Accept your invite: {url}")
    except Exception as e:  # noqa: BLE001
        logger.warning("invite email to %s failed: %s", email, e)
        return False


async def _send_added_to_team_email(email: str, owner_name: str, app_url: str | None) -> bool:
    base = (app_url or settings.public_app_url or "http://localhost:8080").rstrip("/")
    url = f"{base}/login"
    html = (
        f"<p>{owner_name} has added you to their EDM Nexus team.</p>"
        f'<p><a href="{url}">Log in with your existing account</a></p>'
    )
    try:
        return await send_system_email(email, f"{owner_name} added you to their EDM Nexus team", html,
                                        f"Log in: {url}")
    except Exception as e:  # noqa: BLE001
        logger.warning("team-added notice to %s failed: %s", email, e)
        return False


@router.post("/invite")
async def invite_member(body: TeamInvite, user=Depends(get_current_user)):
    if not is_owner(user["user_id"]):
        raise HTTPException(status_code=403, detail="Only account owners can invite team members")

    member_email = body.member_email.strip().lower()

    existing = (
        supabase.table("team_members")
        .select("id")
        .eq("owner_id", user["user_id"])
        .eq("member_email", member_email)
        .maybe_single()
        .execute()
    )
    if existing.data:
        raise HTTPException(status_code=400, detail="This email has already been invited")

    invited_user = (
        supabase.table("users").select("id").eq("email", member_email).maybe_single().execute().data
    )

    invite_token = None
    invite_expires = None
    if not invited_user:
        invite_token = secrets.token_urlsafe(32)
        invite_expires = (datetime.now(timezone.utc) + timedelta(hours=INVITE_TTL_HOURS)).isoformat()

    row = {
        "owner_id": user["user_id"],
        "member_email": member_email,
        "member_user_id": invited_user["id"] if invited_user else None,
        "role": "member",
        "permissions": Json(VALID_PERMISSIONS),
        "status": "Active" if invited_user else "Pending",
        "invite_token": invite_token,
        "invite_token_expires_at": invite_expires,
    }

    result = supabase.table("team_members").insert(row).execute()

    owner_name = _owner_display_name(user["user_id"])
    if invited_user:
        email_sent = await _send_added_to_team_email(member_email, owner_name, body.app_url)
    else:
        email_sent = await _send_invite_email(member_email, invite_token, owner_name, body.app_url)

    data = result.data[0] if result.data else None
    if data:
        data["email_sent"] = email_sent
    return {"data": data, "error": None}


@router.get("/invite/{token}")
async def get_invite(token: str):
    """Public — no auth: lets the accept-invite page show who's inviting before signup."""
    row = supabase.table("team_members").select("*").eq("invite_token", token).maybe_single().execute().data
    if not row or row["status"] != "Pending":
        raise HTTPException(status_code=404, detail="This invite link is invalid or has already been used.")
    expires = _parse_dt(row.get("invite_token_expires_at"))
    if not expires or expires <= datetime.now(timezone.utc):
        raise HTTPException(status_code=400, detail="This invite link has expired. Ask for a new one.")

    return {
        "data": {
            "email": row["member_email"],
            "owner_name": _owner_display_name(row["owner_id"]),
        },
        "error": None,
    }


def _parse_dt(value) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except Exception:
        return None


@router.post("/accept-invite")
async def accept_invite(body: TeamInviteAccept):
    """Public — no auth: redeems an invite token, creates the account, and links it."""
    from routers.auth import _hash_password, _provision_user_rows, _issue_token

    row = supabase.table("team_members").select("*").eq("invite_token", body.token).maybe_single().execute().data
    if not row or row["status"] != "Pending":
        raise HTTPException(status_code=404, detail="This invite link is invalid or has already been used.")
    expires = _parse_dt(row.get("invite_token_expires_at"))
    if not expires or expires <= datetime.now(timezone.utc):
        raise HTTPException(status_code=400, detail="This invite link has expired. Ask for a new one.")

    email = row["member_email"]
    if supabase.table("users").select("id").eq("email", email).maybe_single().execute().data:
        raise HTTPException(status_code=400, detail="An account with this email already exists — please log in instead.")

    if not body.password or len(body.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")

    user_row = {
        "email": email,
        "encrypted_password": _hash_password(body.password),
        "raw_user_meta_data": {"full_name": body.full_name or ""},
        # The invite email itself is the verification channel — no separate email-verify step.
        "email_confirmed_at": datetime.now(timezone.utc).isoformat(),
    }
    new_user = supabase.table("users").insert(user_row).execute().data[0]
    _provision_user_rows(new_user["id"], body.full_name)

    supabase.table("team_members").update({
        "member_user_id": new_user["id"],
        "status": "Active",
        "invite_token": None,
        "invite_token_expires_at": None,
    }).eq("id", row["id"]).execute()

    token = _issue_token(new_user["id"], email)
    return {
        "data": {"access_token": token, "token_type": "bearer", "user": {"id": new_user["id"], "email": email}},
        "error": None,
    }


@router.patch("/{member_id}")
async def update_member(member_id: str, body: TeamMemberUpdate, user=Depends(get_current_user)):
    if not is_owner(user["user_id"]):
        raise HTTPException(status_code=403, detail="Only account owners can update team members")

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
    if not is_owner(user["user_id"]):
        raise HTTPException(status_code=403, detail="Only account owners can remove team members")

    supabase.table("team_members").delete().eq("id", member_id).eq("owner_id", user["user_id"]).execute()
    return {"data": None, "error": None}
