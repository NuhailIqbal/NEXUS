"""
Google Calendar connection for an account: OAuth connect/callback, status, settings, disconnect.

Only the account OWNER can connect, change settings or disconnect (members/viewers can read
status). The OAuth `state` is a short-lived signed token carrying the owner's id, so the
public callback can only ever attach a calendar to the account that started the flow.
"""

import logging
import time

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse
from jose import JWTError, jwt

from config import settings
from dependencies import get_current_user, require_owner
from models.schemas import CalendarSettingsUpdate
from routers.team import resolve_owner_id
from services import calendar_service as cal
from services import google_calendar as gc

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/calendar", tags=["Calendar"])

# How long the user has to finish Google's consent screen before the `state` token expires.
STATE_TTL_SECONDS = 600


def _make_state(user_id: str, tz: str) -> str:
    """Sign the OAuth `state` value: a short-lived JWT carrying the owner's id and browser timezone.

    The `typ` claim marks it as a calendar-OAuth token so it can't be confused with other JWTs
    signed with the same secret (see `_read_state`).
    """
    return jwt.encode({"sub": user_id, "tz": tz, "typ": "gcal_oauth", "exp": int(time.time()) + STATE_TTL_SECONDS},
                      settings.active_jwt_secret, algorithm="HS256")


def _read_state(state: str) -> dict | None:
    """Verify an OAuth `state` token and return its claims, or None if it is invalid.

    None is returned for a bad signature, an expired token, the wrong `typ`, or a missing `sub`.
    """
    try:
        data = jwt.decode(state, settings.active_jwt_secret, algorithms=["HS256"])
    except JWTError:
        return None
    return data if data.get("typ") == "gcal_oauth" and data.get("sub") else None


def _back(result: str, reason: str | None = None) -> RedirectResponse:
    """Redirect the browser back to the dashboard Integrations page after the OAuth round trip.

    `result` ("connected", "denied" or "error") and the optional `reason` (a short error code)
    are passed as query parameters for the frontend to turn into a message.
    """
    # PUBLIC_APP_URL lets a deployed API send users back to the deployed site, not localhost.
    base = (settings.public_app_url or "http://localhost:8080").rstrip("/")
    url = f"{base}/dashboard/integrations?calendar={result}"
    if reason:
        url += f"&reason={reason}"
    return RedirectResponse(url, status_code=302)


@router.get("/status")
async def status(user=Depends(get_current_user)):
    """Return the account's Google Calendar connection state (connected, email, settings, server config).

    Any signed-in team member may call this; members and viewers see the owner's calendar.
    No secrets are returned.
    """
    return {"data": cal.public_status(resolve_owner_id(user["user_id"])), "error": None}


@router.get("/google/connect-url")
async def connect_url(tz: str = Query("UTC", max_length=64), user=Depends(require_owner)):
    """Return the Google consent-screen URL that starts the calendar connect flow (owner only).

    `tz` is the browser's IANA timezone; it becomes the default timezone of a new connection
    (falls back to UTC if unrecognised). Responds 503 if the server has no Google OAuth client configured.
    """
    if not settings.google_calendar_configured:
        raise HTTPException(status_code=503, detail="Google Calendar isn't set up on this server yet.")
    zone = tz if cal.valid_timezone(tz) else "UTC"
    return {"data": {"url": gc.build_auth_url(_make_state(user["user_id"], zone))}, "error": None}


@router.get("/google/callback")
async def callback(code: str | None = None, state: str | None = None, error: str | None = None):
    """OAuth redirect target that Google calls after consent: exchanges the code and stores the connection.

    Unauthenticated by design (it is a browser redirect from Google); the signed `state` is the only
    proof of which account started the flow. Always answers with a 302 back to the dashboard, with
    `calendar=connected|denied|error` in the query string. Writes `calendar_connections`.
    """
    # The state is validated first so a forged or expired callback never reaches Google or the DB.
    claims = _read_state(state or "")
    if not claims:
        return _back("error", "state")
    if error or not code:
        return _back("denied")
    try:
        tokens = await gc.exchange_code(code)
        # The email is only a display label and is best-effort (None if the lookup fails).
        email = await gc.get_email(tokens.get("access_token", ""))
        cal.save_connection(claims["sub"], tokens["refresh_token"], email, claims.get("tz") or "UTC")
    except gc.CalendarError as e:
        logger.warning("Google Calendar connect failed for %s: %s", claims["sub"], e)
        return _back("error", e.code)
    return _back("connected")


@router.patch("/settings")
async def update_settings(body: CalendarSettingsUpdate, user=Depends(require_owner)):
    """Partially update the calendar booking settings (working hours, meeting length, buffer, notice...). Owner only.

    Only the fields sent are changed; the merged result is validated and returned in full.
    Responds 400 with a readable message if validation fails or no calendar is connected.
    """
    try:
        merged = cal.update_settings(user["user_id"], body.model_dump(exclude_none=True))
    except cal.SettingsError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"data": merged, "error": None}


@router.delete("/google")
async def disconnect(user=Depends(require_owner)):
    """Disconnect the account's Google Calendar (owner only).

    Revokes the Google grant (best effort) and deletes the stored connection; past
    `calendar_bookings` rows are kept. Responds 404 if no calendar was connected.
    """
    removed = await cal.disconnect(user["user_id"])
    if not removed:
        raise HTTPException(status_code=404, detail="No calendar is connected.")
    return {"data": {"disconnected": True}, "error": None}
