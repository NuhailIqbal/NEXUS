"""
Auth router — register, login, refresh, change-password, forgot-password.
Issues our own JWTs signed with JWT_SECRET (HS256).
"""
from datetime import datetime, timedelta, timezone
from typing import Optional
import secrets
import uuid

from fastapi import APIRouter, HTTPException, status, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import jwt, JWTError
from passlib.context import CryptContext
from pydantic import BaseModel, EmailStr

from config import settings
from database import supabase

router = APIRouter(prefix="/auth", tags=["Auth"])
bearer_scheme = HTTPBearer(auto_error=False)
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24        # 1 day
REFRESH_TOKEN_EXPIRE_DAYS = 30


# ── helpers ──────────────────────────────────────────────────────────────────

def _hash_password(password: str) -> str:
    return pwd_context.hash(password)


def _verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def _create_access_token(user_id: str, email: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    return jwt.encode(
        {"sub": user_id, "email": email, "role": "authenticated", "exp": expire},
        settings.active_jwt_secret,
        algorithm="HS256",
    )


def _create_refresh_token() -> str:
    return secrets.token_urlsafe(48)


def _store_refresh_token(user_id: str, token: str) -> None:
    expire = datetime.now(timezone.utc) + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)
    supabase.table("refresh_tokens").insert({
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        "token": token,
        "expires_at": expire.isoformat(),
    }).execute()


def _consume_refresh_token(token: str) -> Optional[dict]:
    """Return the row if valid and not expired, then delete it (rotation)."""
    result = supabase.table("refresh_tokens").select("*").eq("token", token).maybe_single().execute()
    if not result.data:
        return None
    row = result.data
    expires_at = datetime.fromisoformat(row["expires_at"].replace("Z", "+00:00"))
    if expires_at < datetime.now(timezone.utc):
        supabase.table("refresh_tokens").delete().eq("token", token).execute()
        return None
    supabase.table("refresh_tokens").delete().eq("token", token).execute()
    return row


# ── schemas ───────────────────────────────────────────────────────────────────

class RegisterRequest(BaseModel):
    email: EmailStr
    password: str
    full_name: str = ""
    company_name: str = ""


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class RefreshRequest(BaseModel):
    refresh_token: str


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str


# ── endpoints ─────────────────────────────────────────────────────────────────

@router.post("/register", status_code=201)
def register(body: RegisterRequest):
    existing = supabase.table("users").select("id").eq("email", body.email.lower()).maybe_single().execute()
    if existing.data:
        raise HTTPException(status_code=400, detail="An account with this email already exists.")

    if len(body.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters.")

    user_id = str(uuid.uuid4())
    supabase.table("users").insert({
        "id": user_id,
        "email": body.email.lower(),
        "encrypted_password": _hash_password(body.password),
        "raw_user_meta_data": {"full_name": body.full_name, "company_name": body.company_name},
        "email_confirmed_at": datetime.now(timezone.utc).isoformat(),
    }).execute()

    # Create profile row
    supabase.table("profiles").insert({
        "id": user_id,
        "full_name": body.full_name,
        "company_name": body.company_name,
    }).execute()

    access_token = _create_access_token(user_id, body.email.lower())
    refresh_token = _create_refresh_token()
    _store_refresh_token(user_id, refresh_token)

    return {
        "data": {
            "access_token": access_token,
            "refresh_token": refresh_token,
            "token_type": "bearer",
            "user": {"id": user_id, "email": body.email.lower(), "user_metadata": {"full_name": body.full_name}},
        }
    }


@router.post("/login")
def login(body: LoginRequest):
    result = supabase.table("users").select("*").eq("email", body.email.lower()).maybe_single().execute()
    user = result.data
    if not user or not user.get("encrypted_password"):
        raise HTTPException(status_code=401, detail="Invalid email or password.")
    if not _verify_password(body.password, user["encrypted_password"]):
        raise HTTPException(status_code=401, detail="Invalid email or password.")

    access_token = _create_access_token(user["id"], user["email"])
    refresh_token = _create_refresh_token()
    _store_refresh_token(user["id"], refresh_token)

    meta = user.get("raw_user_meta_data") or {}
    return {
        "data": {
            "access_token": access_token,
            "refresh_token": refresh_token,
            "token_type": "bearer",
            "user": {"id": user["id"], "email": user["email"], "user_metadata": meta},
        }
    }


@router.post("/refresh")
def refresh(body: RefreshRequest):
    row = _consume_refresh_token(body.refresh_token)
    if not row:
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token.")

    user_result = supabase.table("users").select("id, email, raw_user_meta_data").eq("id", row["user_id"]).maybe_single().execute()
    user = user_result.data
    if not user:
        raise HTTPException(status_code=401, detail="User not found.")

    access_token = _create_access_token(user["id"], user["email"])
    new_refresh = _create_refresh_token()
    _store_refresh_token(user["id"], new_refresh)

    return {
        "data": {
            "access_token": access_token,
            "refresh_token": new_refresh,
            "token_type": "bearer",
            "user": {"id": user["id"], "email": user["email"], "user_metadata": user.get("raw_user_meta_data") or {}},
        }
    }


@router.post("/change-password")
def change_password(
    body: ChangePasswordRequest,
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
):
    if not credentials:
        raise HTTPException(status_code=401, detail="Not authenticated.")
    try:
        payload = jwt.decode(credentials.credentials, settings.active_jwt_secret, algorithms=["HS256"], options={"verify_aud": False})
        user_id = payload.get("sub")
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token.")

    result = supabase.table("users").select("encrypted_password").eq("id", user_id).maybe_single().execute()
    user = result.data
    if not user or not _verify_password(body.current_password, user["encrypted_password"]):
        raise HTTPException(status_code=400, detail="Current password is incorrect.")

    if len(body.new_password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters.")

    supabase.table("users").update({"encrypted_password": _hash_password(body.new_password)}).eq("id", user_id).execute()
    return {"data": {"message": "Password updated successfully."}}


@router.post("/forgot-password")
def forgot_password(body: ForgotPasswordRequest):
    result = supabase.table("users").select("id").eq("email", body.email.lower()).maybe_single().execute()
    if not result.data:
        # Don't reveal whether the email exists
        return {"data": {"message": "If that email exists, a reset link has been sent."}}

    user_id = result.data["id"]
    token = secrets.token_urlsafe(32)
    expire = datetime.now(timezone.utc) + timedelta(hours=1)
    supabase.table("password_reset_tokens").insert({
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        "token": token,
        "expires_at": expire.isoformat(),
    }).execute()

    # TODO: send email with reset link containing the token
    # For now the token is returned so you can build the reset URL manually
    return {"data": {"message": "If that email exists, a reset link has been sent.", "debug_token": token}}


@router.post("/reset-password")
def reset_password(body: ResetPasswordRequest):
    result = supabase.table("password_reset_tokens").select("*").eq("token", body.token).maybe_single().execute()
    if not result.data:
        raise HTTPException(status_code=400, detail="Invalid or expired reset token.")

    row = result.data
    expires_at = datetime.fromisoformat(row["expires_at"].replace("Z", "+00:00"))
    if expires_at < datetime.now(timezone.utc):
        supabase.table("password_reset_tokens").delete().eq("token", body.token).execute()
        raise HTTPException(status_code=400, detail="Reset token has expired.")

    if len(body.new_password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters.")

    supabase.table("users").update({"encrypted_password": _hash_password(body.new_password)}).eq("id", row["user_id"]).execute()
    supabase.table("password_reset_tokens").delete().eq("token", body.token).execute()
    return {"data": {"message": "Password reset successfully. You can now sign in."}}
