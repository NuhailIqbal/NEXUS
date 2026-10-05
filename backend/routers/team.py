"""
Team management — account owners, sub-users and email invitations.

Mounted at /team. An owner invites people by email (rows in `team_members`); an invitee
becomes a sub-user whose data access resolves to the owner's account via resolve_owner_id().
Besides the endpoints, this module exports helpers used across the backend: resolve_owner_id
(account scoping in most routers), get_user_role (TeamRoleGuard in main.py), is_owner
(dependencies.require_owner) and the permission helpers.
Talks to: `team_members`, `users`, `profiles`; invitation emails go out through
services.email_service.send_system_email.
"""
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

# Permission keys a sub-user can hold. Account owners implicitly have all of them.
VALID_PERMISSIONS = [
    "create_agents",
    "create_campaigns",
    "create_contacts",
    "view_conversations",
    "view_analytics",
    "manage_integrations",
]

# Fallback for a member row whose stored permissions list is NULL/empty
# (see get_user_permissions). Currently the full list, i.e. no restriction.
DEFAULT_MEMBER_PERMISSIONS = VALID_PERMISSIONS

# Roles that can be assigned to a sub-user (also enforced by a CHECK constraint on
# team_members.role). 'owner' is never stored: an account owner is simply a user with no
# Active team_members row (see get_user_role). Viewers are read-only — TeamRoleGuard in
# main.py rejects their non-GET requests.
VALID_ROLES = ["member", "viewer"]


def resolve_owner_id(user_id: str) -> str:
    """If user is a sub-user, return their parent's ID. Otherwise return their own."""
    # Only 'Active' rows grant access to the owner's data; Pending invites and 'Removed'
    # members fall through to the user's own id.
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
    """Returns 'owner' for a parent account, or the sub-user's stored role ('member'/'viewer')."""
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
    # A NULL or empty stored list falls back to the defaults, so a member can never end up
    # with zero permissions.
    return membership.data.get("permissions") or DEFAULT_MEMBER_PERMISSIONS


def check_permission(user_id: str, permission: str):
    """Raise HTTP 403 unless the user holds `permission` (owners always do).

    Helper for gating a route on one permission key from VALID_PERMISSIONS. Read-only /
    delete limits for sub-users are currently enforced by role in TeamRoleGuard (main.py).
    """
    perms = get_user_permissions(user_id)
    if permission not in perms:
        raise HTTPException(status_code=403, detail=f"You don't have permission: {permission}")


def is_owner(user_id: str) -> bool:
    """True if the user is an account owner, i.e. not an Active sub-user of someone else."""
    return get_user_role(user_id) == "owner"


@router.get("")
async def list_members(user=Depends(get_current_user)):
    """List the account's team (Pending invites and Active members), newest first.

    Any signed-in user may call it: a sub-user sees the same team as the owner they belong
    to. Returns the raw team_members rows (all columns).
    """
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
    """Return the caller's team role ('owner', 'member' or 'viewer'), permission list,
    resolved owner id and an `is_owner` flag.

    The frontend uses this to adapt the UI (e.g. the viewer banner and owner-only controls).
    """
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
    """Owner's profile full_name for use in invite emails and the invite page; 'Someone' if unset."""
    profile = supabase.table("profiles").select("full_name").eq("id", owner_id).maybe_single().execute().data
    return (profile or {}).get("full_name") or "Someone"


async def _send_invite_email(email: str, token: str, owner_name: str, role: str, app_url: str | None) -> bool:
    """Email a new-user invitation containing the /accept-invite?token=... link.

    Sent through the platform's system SMTP (not a per-user integration). Returns True if
    sent; False if SMTP isn't configured or sending failed. Failures are logged, never
    raised, so the already-created invite row is unaffected.
    """
    # Link origin: the frontend origin the caller sent, else PUBLIC_APP_URL, else local dev.
    base = (app_url or settings.public_app_url or "http://localhost:8080").rstrip("/")
    url = f"{base}/accept-invite?token={token}"
    html = (
        f"<p>{owner_name} has invited you to join their EDM Nexus team as a <b>{role}</b>.</p>"
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


async def _send_added_to_team_email(email: str, owner_name: str, role: str, app_url: str | None) -> bool:
    """Notify an EXISTING user that they were added to a team; the link just points to /login.

    No invite token is involved because the account already exists and was linked
    immediately. Same return/failure semantics as _send_invite_email.
    """
    # Link origin: the frontend origin the caller sent, else PUBLIC_APP_URL, else local dev.
    base = (app_url or settings.public_app_url or "http://localhost:8080").rstrip("/")
    url = f"{base}/login"
    html = (
        f"<p>{owner_name} has added you to their EDM Nexus team as a <b>{role}</b>.</p>"
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
    """Invite an email address to the caller's team as a 'member' or 'viewer' (owners only).

    If an account already exists for the email, it is linked immediately as Active and
    notified by email. Otherwise a Pending row with a single-use invite token (valid 7 days)
    is created and the invite link is emailed. Rejects an email this owner already invited.
    Returns the team_members row plus `email_sent` (whether the email was delivered).
    """
    if not is_owner(user["user_id"]):
        raise HTTPException(status_code=403, detail="Only account owners can invite team members")

    member_email = body.member_email.strip().lower()
    role = (body.role or "member").strip().lower()
    if role not in VALID_ROLES:
        raise HTTPException(status_code=400, detail=f"Invalid role — must be one of {VALID_ROLES}")

    # One invite per (owner, email); team_members also has a UNIQUE constraint on that pair.
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

    # An email that already has an account is linked right away (Active, no token). An unknown
    # email gets a Pending row plus a one-time token that is redeemed via /team/accept-invite.
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
        "role": role,
        # Every invite starts with the full permission list (Json() sends it to psycopg as
        # jsonb); TeamMemberUpdate has no permissions field, so effective limits come from the role.
        "permissions": Json(VALID_PERMISSIONS),
        "status": "Active" if invited_user else "Pending",
        "invite_token": invite_token,
        "invite_token_expires_at": invite_expires,
    }

    result = supabase.table("team_members").insert(row).execute()

    owner_name = _owner_display_name(user["user_id"])
    if invited_user:
        email_sent = await _send_added_to_team_email(member_email, owner_name, role, body.app_url)
    else:
        email_sent = await _send_invite_email(member_email, invite_token, owner_name, role, body.app_url)

    data = result.data[0] if result.data else None
    if data:
        # Lets the UI warn the owner when delivery failed (e.g. SMTP not configured); the
        # invite row exists either way.
        data["email_sent"] = email_sent
    return {"data": data, "error": None}


@router.get("/invite/{token}")
async def get_invite(token: str):
    """Public — no auth: lets the accept-invite page show who's inviting before signup."""
    row = supabase.table("team_members").select("*").eq("invite_token", token).maybe_single().execute().data
    if not row or row["status"] != "Pending":
        raise HTTPException(status_code=404, detail="This invite link is invalid or has already been used.")
    # Expiry is checked at read time: expired invites stay 'Pending' in the table. A missing
    # or unparseable expiry is treated as expired.
    expires = _parse_dt(row.get("invite_token_expires_at"))
    if not expires or expires <= datetime.now(timezone.utc):
        raise HTTPException(status_code=400, detail="This invite link has expired. Ask for a new one.")

    return {
        "data": {
            "email": row["member_email"],
            "role": row["role"],
            "owner_name": _owner_display_name(row["owner_id"]),
        },
        "error": None,
    }


def _parse_dt(value) -> datetime | None:
    """Parse an ISO-8601 timestamp into a datetime; None if empty or unparseable."""
    if not value:
        return None
    try:
        # Older Python versions' fromisoformat() rejects a trailing 'Z'; use an explicit UTC offset.
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except Exception:
        return None


@router.post("/accept-invite")
async def accept_invite(body: TeamInviteAccept):
    """Public — no auth: redeems an invite token, creates the account, and links it."""
    # Imported here, not at module level, to avoid a circular import (see note at top of file).
    from routers.auth import _hash_password, _provision_user_rows, _issue_token

    # Re-validate the token here with the same rules as get_invite; don't assume the page
    # called get_invite first.
    row = supabase.table("team_members").select("*").eq("invite_token", body.token).maybe_single().execute().data
    if not row or row["status"] != "Pending":
        raise HTTPException(status_code=404, detail="This invite link is invalid or has already been used.")
    expires = _parse_dt(row.get("invite_token_expires_at"))
    if not expires or expires <= datetime.now(timezone.utc):
        raise HTTPException(status_code=400, detail="This invite link has expired. Ask for a new one.")

    email = row["member_email"]
    # Invites for emails that already had an account are linked at invite time, so a match
    # here means the person registered separately after being invited.
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
    # Creates the new user's own profile + billing rows (the welcome promo is not granted
    # on this path); their data access later resolves to the owner's account.
    _provision_user_rows(new_user["id"], body.full_name)

    # Link the invite row to the new user and clear the token so the invite is single-use.
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
    """Change a team member's role and/or status (owners only).

    Only fields present in the body are updated; `role` is normalised and must be 'member'
    or 'viewer'. `status` is not validated here (a DB CHECK limits it to Pending/Active/Removed);
    any value other than 'Active' revokes the member's access, since role/owner lookups only
    consider Active rows. Restricted to the caller's own team. Returns the updated row, or
    null data if no row matched.
    """
    if not is_owner(user["user_id"]):
        raise HTTPException(status_code=403, detail="Only account owners can update team members")

    updates = body.model_dump(exclude_none=True)
    if not updates:
        return {"data": None, "error": "No fields to update"}

    if "role" in updates:
        role = updates["role"].strip().lower()
        if role not in VALID_ROLES:
            raise HTTPException(status_code=400, detail=f"Invalid role — must be one of {VALID_ROLES}")
        updates["role"] = role

    # Ownership check: filtering on owner_id stops an owner from editing another owner's members.
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
    """Delete a team_members row — a pending invite or an active member (owners only).

    The removed person's own user account is untouched, but they lose access to the owner's
    data at once because that access is resolved through this row. Scoped to the caller's own
    team; an unknown id is a silent no-op that still returns success.
    """
    if not is_owner(user["user_id"]):
        raise HTTPException(status_code=403, detail="Only account owners can remove team members")

    # owner_id filter = ownership check, so only the caller's own members can be deleted.
    supabase.table("team_members").delete().eq("id", member_id).eq("owner_id", user["user_id"]).execute()
    return {"data": None, "error": None}
