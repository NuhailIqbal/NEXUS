"""
Thin Google Calendar / OAuth client over Google's REST APIs (no SDK).

Every network call goes through `_request`, so tests replace that one function with a
fake Google. Errors are raised as `CalendarError` with a `code`:

    reauth    the stored grant is revoked/expired or lacks permission -> user must reconnect
    no_refresh Google did not return a refresh token during connect
    api       any other Google/network failure
"""

import logging
from urllib.parse import urlencode

import httpx

from config import settings

logger = logging.getLogger(__name__)

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
REVOKE_URL = "https://oauth2.googleapis.com/revoke"
USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
CAL_API = "https://www.googleapis.com/calendar/v3"

# events: create the booking. freebusy: read busy times only (never event titles/details).
SCOPES = [
    "openid",
    "email",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.freebusy",
]


class CalendarError(Exception):
    def __init__(self, message: str, code: str = "api"):
        super().__init__(message)
        self.code = code


async def _request(method: str, url: str, **kwargs) -> httpx.Response:
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            return await client.request(method, url, **kwargs)
    except httpx.HTTPError as e:
        raise CalendarError(f"Could not reach Google: {e}", "api") from e


def _json(resp: httpx.Response) -> dict:
    try:
        data = resp.json()
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _raise_for(resp: httpx.Response, what: str) -> None:
    if resp.status_code < 400:
        return
    body = _json(resp)
    err = body.get("error")
    reason = err.get("message") if isinstance(err, dict) else (body.get("error_description") or err)
    if resp.status_code in (401, 403) or err == "invalid_grant":
        raise CalendarError(f"Google rejected the calendar credentials ({what}): {reason}", "reauth")
    raise CalendarError(f"Google Calendar error while {what} ({resp.status_code}): {reason}", "api")


def build_auth_url(state: str) -> str:
    params = {
        "client_id": settings.google_client_id,
        "redirect_uri": settings.active_google_redirect_uri,
        "response_type": "code",
        "scope": " ".join(SCOPES),
        "access_type": "offline",     # we need a refresh token to book while nobody is logged in
        "prompt": "consent",          # force one, even if the user connected before
        "include_granted_scopes": "true",
        "state": state,
    }
    return f"{AUTH_URL}?{urlencode(params)}"


async def exchange_code(code: str) -> dict:
    resp = await _request("POST", TOKEN_URL, data={
        "code": code,
        "client_id": settings.google_client_id,
        "client_secret": settings.google_client_secret,
        "redirect_uri": settings.active_google_redirect_uri,
        "grant_type": "authorization_code",
    })
    _raise_for(resp, "connecting your account")
    data = _json(resp)
    if not data.get("refresh_token"):
        raise CalendarError("Google did not return a refresh token. Remove NEXUS from your Google "
                            "account's connected apps and connect again.", "no_refresh")
    return data


async def refresh_access_token(refresh_token: str) -> tuple[str, int]:
    resp = await _request("POST", TOKEN_URL, data={
        "refresh_token": refresh_token,
        "client_id": settings.google_client_id,
        "client_secret": settings.google_client_secret,
        "grant_type": "refresh_token",
    })
    _raise_for(resp, "refreshing access")
    data = _json(resp)
    if not data.get("access_token"):
        raise CalendarError("Google returned no access token.", "api")
    return data["access_token"], int(data.get("expires_in") or 3600)


async def get_email(access_token: str) -> str | None:
    try:
        resp = await _request("GET", USERINFO_URL, headers={"Authorization": f"Bearer {access_token}"})
    except CalendarError:
        return None
    return _json(resp).get("email") if resp.status_code < 400 else None


async def freebusy(access_token: str, time_min_iso: str, time_max_iso: str,
                   calendar_id: str = "primary") -> list[tuple[str, str]]:
    """Busy intervals (ISO strings, as Google returns them) in the window."""
    resp = await _request(
        "POST", f"{CAL_API}/freeBusy",
        headers={"Authorization": f"Bearer {access_token}"},
        json={"timeMin": time_min_iso, "timeMax": time_max_iso, "items": [{"id": calendar_id}]},
    )
    _raise_for(resp, "checking availability")
    cal = (_json(resp).get("calendars") or {}).get(calendar_id) or {}
    if cal.get("errors"):
        raise CalendarError(f"Google could not read this calendar: {cal['errors']}", "api")
    return [(b["start"], b["end"]) for b in (cal.get("busy") or []) if b.get("start") and b.get("end")]


async def create_event(access_token: str, *, summary: str, description: str, start_iso: str,
                       end_iso: str, timezone: str, attendee_email: str | None,
                       calendar_id: str = "primary") -> dict:
    body: dict = {
        "summary": summary,
        "description": description,
        "start": {"dateTime": start_iso, "timeZone": timezone},
        "end": {"dateTime": end_iso, "timeZone": timezone},
    }
    if attendee_email:
        body["attendees"] = [{"email": attendee_email}]
    resp = await _request(
        "POST", f"{CAL_API}/calendars/{calendar_id}/events",
        params={"sendUpdates": "all" if attendee_email else "none"},
        headers={"Authorization": f"Bearer {access_token}"},
        json=body,
    )
    _raise_for(resp, "creating the event")
    return _json(resp)


async def revoke(token: str) -> None:
    """Best effort — disconnecting must work even if Google is unreachable."""
    try:
        await _request("POST", REVOKE_URL, data={"token": token})
    except CalendarError as e:
        logger.warning("Google token revoke failed: %s", e)
