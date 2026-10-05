"""
Authentication dependencies for FastAPI routes.

`get_current_user` validates the user's JWT (Authorization: Bearer ...), `get_admin_user`
validates the admin-portal JWT (X-Admin-Auth header), and `require_owner` additionally
restricts a route to team-account owners. `_decode_token` is also used directly by the
TeamRoleGuard middleware in main.py. Tokens are HS256 JWTs signed with
`settings.active_jwt_secret`; they are issued by routers/auth.py (users) and
routers/admin.py (admins). No database access happens here except via
`routers.team.is_owner` in `require_owner`.
"""
import logging

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import jwt, JWTError

from config import settings

logger = logging.getLogger(__name__)
# Extracts the Bearer token from the Authorization header; FastAPI itself rejects the
# request if the header is missing or not a Bearer scheme, before get_current_user runs.
bearer_scheme = HTTPBearer()


def _decode_token(token: str) -> dict:
    """Verify a JWT's signature and expiry and return its claims.

    Returns None (despite the annotation) when the token's `alg` header is anything
    other than HS256. Raises `jose.JWTError` for a malformed, badly signed or expired token.
    """
    # The header is read unverified only to choose the algorithm; the signature is still
    # checked by jwt.decode below, which is pinned to HS256 only.
    header = jwt.get_unverified_header(token)
    alg = header.get("alg", "HS256")

    if alg == "HS256":
        # Audience is not checked: tokens may or may not carry an `aud` claim.
        return jwt.decode(
            token,
            settings.active_jwt_secret,
            algorithms=["HS256"],
            options={"verify_aud": False},
        )


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
) -> dict:
    """FastAPI dependency: authenticate the caller from the Bearer JWT.

    Returns `{"user_id", "email", "role"}` taken from the token's `sub`, `email` and
    `role` claims. `role` is the JWT role claim ("authenticated" by default), not the
    team role (owner/member/viewer) — see routers.team.get_user_role for that.
    Raises 401 if the token is invalid, expired or has no `sub`.
    """
    token = credentials.credentials
    try:
        payload = _decode_token(token)
        user_id: str = payload.get("sub")
        if not user_id:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
        return {"user_id": user_id, "email": payload.get("email", ""), "role": payload.get("role", "authenticated")}
    except JWTError as e:
        logger.error(f"JWT decode failed: {e}")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")


async def get_admin_user(request: Request) -> dict:
    """Authenticate an admin via a short-lived admin JWT (obtained from POST /admin/login).

    The token is sent in the X-Admin-Auth header. The admin password is never shipped
    to the browser — only this server-issued token is, so it cannot be read from the bundle.
    """
    token = request.headers.get("X-Admin-Auth", "").strip()
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Admin login required")
    # Tolerate a "Bearer " prefix if a client adds one.
    if token.lower().startswith("bearer "):
        token = token[7:].strip()
    try:
        payload = _decode_token(token)
    except JWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired admin session")
    # User and admin tokens share one signing secret, so the `adm` claim (set only by
    # POST /admin/login) is what distinguishes them: a valid user token gets 403, not access.
    if not payload or payload.get("adm") is not True:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not an admin session")
    return {"admin": True, "username": payload.get("sub", "admin")}


def require_owner(user=Depends(get_current_user)) -> dict:
    """FastAPI dependency: allow only account owners (not Member/Viewer sub-users).

    Returns the authenticated user dict from `get_current_user`; raises 403 for
    team sub-users. Costs one team_members lookup per request.
    """
    # Imported lazily: routers.team imports get_current_user from this module, so a
    # top-level import would be circular.
    from routers.team import is_owner
    if not is_owner(user["user_id"]):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only account owners can perform this action")
    return user
