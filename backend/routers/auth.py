"""
Authentication — own JWT (replaces Supabase Auth).

Flow: user registers/logs in -> backend verifies against the local `users`
table (bcrypt) -> returns an HS256 JWT -> frontend sends it as
`Authorization: Bearer <token>` on every request (verified by get_current_user).
"""
import time
import logging
import secrets
from datetime import datetime, timezone, timedelta

import bcrypt
from fastapi import APIRouter, Depends, HTTPException, status
from jose import jwt
from pydantic import BaseModel

from config import settings
from database import supabase
from dependencies import get_current_user
from routers.billing import get_or_create_billing, credit_balance, _has_promo_credit, get_promo_config
from services.email_service import send_system_email

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/auth", tags=["Auth"])

TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7  # 7 days
VERIFY_TTL_HOURS = 48


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
    app_url: str | None = None  # frontend origin, for building the verification link


class LoginBody(BaseModel):
    email: str
    password: str


class VerifyBody(BaseModel):
    token: str


class ResendBody(BaseModel):
    email: str
    app_url: str | None = None


def _grant_signup_promo(user_id: str) -> None:
    """One-time welcome bonus, granted on email verification. Guarded so it can never
    be granted twice. Promo is a 'promo'-type grant (spent first) that expires."""
    cfg = get_promo_config()
    bonus = cfg["amount"]
    if cfg["enabled"] and bonus > 0 and not _has_promo_credit(user_id):
        days = cfg["expiry_days"]
        expires = (datetime.now(timezone.utc) + timedelta(days=days)).isoformat() if days > 0 else None
        credit_balance(user_id, bonus, "promo", f"Welcome bonus — ${bonus:.0f} free credits",
                       grant_type="promo", expires_at=expires)


async def _issue_verification(user_id: str, email: str, app_url: str | None):
    """Create a verification token and email the link. Returns (url, sent)."""
    token = secrets.token_urlsafe(32)
    expires = (datetime.now(timezone.utc) + timedelta(hours=VERIFY_TTL_HOURS)).isoformat()
    supabase.table("email_verification_tokens").insert(
        {"user_id": user_id, "token": token, "expires_at": expires}
    ).execute()
    base = (app_url or settings.public_app_url or "http://localhost:8080").rstrip("/")
    url = f"{base}/verify-email?token={token}"
    html = (
        "<p>Welcome to EDM Nexus!</p>"
        "<p>Please verify your email to activate your account and unlock your welcome credit:</p>"
        f'<p><a href="{url}">Verify my email</a></p>'
        f"<p>Or paste this link into your browser:<br>{url}</p>"
        f"<p>This link expires in {VERIFY_TTL_HOURS} hours.</p>"
    )
    sent = False
    try:
        sent = await send_system_email(email, "Verify your EDM Nexus email", html, f"Verify your email: {url}")
    except Exception as e:  # noqa: BLE001
        logger.warning("verification email to %s failed: %s", email, e)
    return url, sent


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

    # New accounts start UNVERIFIED (email_confirmed_at NULL). Login is blocked and the
    # welcome promo is withheld until the email is verified.
    row = {
        "email": email,
        "encrypted_password": _hash_password(body.password),
        "raw_user_meta_data": {"full_name": body.full_name or ""},
    }
    result = supabase.table("users").insert(row).execute()
    user = result.data[0]
    _provision_user_rows(user["id"], body.full_name)  # profile + billing (no promo yet)

    url, sent = await _issue_verification(user["id"], email, body.app_url)
    data = {"pending_verification": True, "email": email}
    if not sent:
        data["dev_verify_url"] = url  # dev fallback when no system email key is configured
    return {"data": data, "error": None}


@router.post("/login")
async def login(body: LoginBody):
    email = body.email.strip().lower()
    res = supabase.table("users").select("id, email, encrypted_password, email_confirmed_at").eq("email", email).maybe_single().execute()
    user = res.data
    if not user or not _verify_password(body.password, user.get("encrypted_password", "")):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password")

    if not user.get("email_confirmed_at"):
        raise HTTPException(
            status_code=403,
            detail="Please verify your email before logging in — check your inbox for the verification link.",
        )

    # Ensure profile/billing exist (covers migrated users created before this flow).
    _provision_user_rows(user["id"], None)

    token = _issue_token(user["id"], email)
    return {"data": {"access_token": token, "token_type": "bearer",
                     "user": {"id": user["id"], "email": email}}, "error": None}


@router.post("/verify-email")
async def verify_email(body: VerifyBody):
    row = (
        supabase.table("email_verification_tokens").select("*")
        .eq("token", body.token).maybe_single().execute().data
    )
    if not row or row.get("used"):
        raise HTTPException(status_code=400, detail="Invalid or already-used verification link.")
    try:
        exp = datetime.fromisoformat(str(row["expires_at"]).replace("Z", "+00:00"))
    except Exception:
        exp = datetime.now(timezone.utc)
    if exp <= datetime.now(timezone.utc):
        raise HTTPException(status_code=400, detail="This verification link has expired. Request a new one.")

    uid = row["user_id"]
    supabase.table("users").update({"email_confirmed_at": datetime.now(timezone.utc).isoformat()}).eq("id", uid).execute()
    supabase.table("email_verification_tokens").update({"used": True}).eq("id", row["id"]).execute()

    u = supabase.table("users").select("email").eq("id", uid).maybe_single().execute().data
    email = (u or {}).get("email", "")
    _grant_signup_promo(uid)  # grant the welcome credit now that the email is verified

    token = _issue_token(uid, email)
    return {"data": {"access_token": token, "token_type": "bearer",
                     "user": {"id": uid, "email": email}, "verified": True}, "error": None}


@router.post("/resend-verification")
async def resend_verification(body: ResendBody):
    email = body.email.strip().lower()
    u = supabase.table("users").select("id, email, email_confirmed_at").eq("email", email).maybe_single().execute().data
    # Always respond OK (don't reveal whether the email exists / its state).
    data = {"ok": True}
    if u and not u.get("email_confirmed_at"):
        url, sent = await _issue_verification(u["id"], email, body.app_url)
        if not sent:
            data["dev_verify_url"] = url
    return {"data": data, "error": None}


@router.get("/me")
async def me(user=Depends(get_current_user)):
    profile = supabase.table("profiles").select("*").eq("id", user["user_id"]).maybe_single().execute()
    return {"data": {"id": user["user_id"], "email": user.get("email", ""),
                     "profile": profile.data}, "error": None}


@router.post("/logout")
async def logout():
    # Stateless JWT — the client just drops the token.
    return {"data": {"success": True}, "error": None}
