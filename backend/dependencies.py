import logging

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import jwt, JWTError

from config import settings

logger = logging.getLogger(__name__)
bearer_scheme = HTTPBearer()


def _decode_token(token: str) -> dict:
    header = jwt.get_unverified_header(token)
    alg = header.get("alg", "HS256")

    if alg == "HS256":
        return jwt.decode(
            token,
            settings.active_jwt_secret,
            algorithms=["HS256"],
            options={"verify_aud": False},
        )


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
) -> dict:
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
    if not payload or payload.get("adm") is not True:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not an admin session")
    return {"admin": True, "username": payload.get("sub", "admin")}


def require_owner(user=Depends(get_current_user)) -> dict:
    from routers.team import is_owner
    if not is_owner(user["user_id"]):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only account owners can perform this action")
    return user
