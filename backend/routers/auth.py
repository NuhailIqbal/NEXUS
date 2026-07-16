"""
Authentication — own JWT (replaces Supabase Auth).

Flow: user registers/logs in -> backend verifies against the local `users`
table (bcrypt) -> returns an HS256 JWT -> frontend sends it as
`Authorization: Bearer <token>` on every request (verified by get_current_user).
"""
import time
from datetime import datetime, timezone

import bcrypt
from fastapi import APIRouter, Depends, HTTPException, status
from jose import jwt
from pydantic import BaseModel

from config import settings
from database import supabase
from dependencies import get_current_user
from routers.billing import get_or_create_billing

router = APIRouter(prefix="/auth", tags=["Auth"])

TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7  # 7 days


def _hash_password(pw: str) -> str:
    # bcrypt has a 72-byte limit; truncate to match (same as Supabase Auth).
    return bcrypt.hashpw(pw.encode("utf-8")[:72], bcrypt.gensalt()).decode("utf-8")


def _verify_password(pw: str, hashed: str) -> bool:
    if not hashed:
        return False
    try:
        return bcrypt.checkpw(pw.encode("utf-8")[:72], hashed.encode("utf-8"))
    except Exception:
        return False


class RegisterBody(BaseModel):
    email: str
    password: str
    full_name: str | None = None


class LoginBody(BaseModel):
    email: str
    password: str


def _issue_token(user_id: str, email: str, *, ttl_seconds: int | None = None,
                 extra_claims: dict | None = None) -> str:
    now = int(time.time())
    payload = {
        "sub": user_id,
        "email": email,
        "role": "authenticated",
        "iat": now,
        "exp": now + (ttl_seconds or TOKEN_TTL_SECONDS),
    }
    if extra_claims:
        payload.update(extra_claims)
    return jwt.encode(payload, settings.active_jwt_secret, algorithm="HS256")


def _provision_user_rows(user_id: str, full_name: str | None) -> None:
    """Create the profile + billing rows that Supabase's signup trigger used to create."""
    existing = supabase.table("profiles").select("id").eq("id", user_id).maybe_single().execute()
    if not existing.data:
        supabase.table("profiles").insert({"id": user_id, "full_name": full_name or ""}).execute()
    get_or_create_billing(user_id)


@router.post("/register")
async def register(body: RegisterBody):
    email = body.email.strip().lower()
    if not email or not body.password:
        raise HTTPException(status_code=400, detail="Email and password are required")

    existing = supabase.table("users").select("id").eq("email", email).maybe_single().execute()
    if existing.data:
        raise HTTPException(status_code=409, detail="An account with this email already exists")

    row = {
        "email": email,
        "encrypted_password": _hash_password(body.password),
        "raw_user_meta_data": {"full_name": body.full_name or ""},
        "email_confirmed_at": datetime.now(timezone.utc).isoformat(),
    }
    result = supabase.table("users").insert(row).execute()
    user = result.data[0]
    _provision_user_rows(user["id"], body.full_name)

    token = _issue_token(user["id"], email)
    return {"data": {"access_token": token, "token_type": "bearer",
                     "user": {"id": user["id"], "email": email}}, "error": None}


@router.post("/login")
async def login(body: LoginBody):
    email = body.email.strip().lower()
    res = supabase.table("users").select("id, email, encrypted_password").eq("email", email).maybe_single().execute()
    user = res.data
    if not user or not _verify_password(body.password, user.get("encrypted_password", "")):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password")

    # Ensure profile/billing exist (covers migrated users created before this flow).
    _provision_user_rows(user["id"], None)

    token = _issue_token(user["id"], email)
    return {"data": {"access_token": token, "token_type": "bearer",
                     "user": {"id": user["id"], "email": email}}, "error": None}


@router.get("/me")
async def me(user=Depends(get_current_user)):
    profile = supabase.table("profiles").select("*").eq("id", user["user_id"]).maybe_single().execute()
    return {"data": {"id": user["user_id"], "email": user.get("email", ""),
                     "profile": profile.data}, "error": None}


@router.post("/logout")
async def logout():
    # Stateless JWT — the client just drops the token.
    return {"data": {"success": True}, "error": None}
