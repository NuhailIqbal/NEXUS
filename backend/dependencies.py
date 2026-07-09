import base64
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


ADMIN_USERNAME = "qarib"
ADMIN_PASSWORD = "test123"


async def get_admin_user(request: Request) -> dict:
    auth_header = request.headers.get("X-Admin-Auth", "")
    if not auth_header:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Admin credentials required")
    try:
        decoded = base64.b64decode(auth_header).decode("utf-8")
        uname, pwd = decoded.split(":", 1)
    except Exception:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid admin credentials")
    if uname != ADMIN_USERNAME or pwd != ADMIN_PASSWORD:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid admin credentials")
    return {"admin": True, "username": uname}


def require_owner(user=Depends(get_current_user)) -> dict:
    from routers.team import is_owner
    if not is_owner(user["user_id"]):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only account owners can perform this action")
    return user
