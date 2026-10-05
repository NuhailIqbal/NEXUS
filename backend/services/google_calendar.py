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

# Google endpoints used directly over HTTP: OAuth consent, token exchange/refresh, revoke, userinfo, Calendar v3.
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
    """Any failure talking to Google (OAuth or Calendar API).

    `code` is "reauth", "no_refresh" or "api" (see the module docstring). Callers branch on it
    rather than parsing the message, which is meant for logs.
    """
    def __init__(self, message: str, code: str = "api"):
        super().__init__(message)
        self.code = code


async def _request(method: str, url: str, **kwargs) -> httpx.Response:
    """Send one HTTP request to Google with a 10 s timeout. Every outbound call goes through here (the test seam).

    Only transport failures (timeout, DNS, connection) raise CalendarError("api"); HTTP error
    statuses are returned as-is for `_raise_for` to interpret.
    """
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            return await client.request(method, url, **kwargs)
    except httpx.HTTPError as e:
        raise CalendarError(f"Could not reach Google: {e}", "api") from e


def _json(resp: httpx.Response) -> dict:
    """Parse the response body as a JSON object; returns {} for empty, non-JSON or non-object bodies so callers can use `.get` safely."""
    try:
        data = resp.json()
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _raise_for(resp: httpx.Response, what: str) -> None:
    """Do nothing for a successful response; otherwise raise CalendarError.

    `what` is a short gerund phrase ("checking availability") used in the message. Credential
    problems raise code "reauth"; every other error status raises code "api".
    """
    if resp.status_code < 400:
        return
    body = _json(resp)
    err = body.get("error")
    # Error bodies come in two shapes: the Calendar API sends {"error": {"message": ...}}, the OAuth
    # token endpoint sends {"error": "<code>", "error_description": ...}.
    reason = err.get("message") if isinstance(err, dict) else (body.get("error_description") or err)
    # 401/403: the grant can't be used (revoked, expired or missing scope). A dead refresh token is
    # reported by the token endpoint as "invalid_grant" with HTTP 400, hence the separate check.
    if resp.status_code in (401, 403) or err == "invalid_grant":
        raise CalendarError(f"Google rejected the calendar credentials ({what}): {reason}", "reauth")
    raise CalendarError(f"Google Calendar error while {what} ({resp.status_code}): {reason}", "api")


def build_auth_url(state: str) -> str:
    """Build the Google consent-screen URL. `state` is the signed token from routers/calendar.py, echoed back on the callback."""
    params = {
        "client_id": settings.google_client_id,
        "redirect_uri": settings.active_google_redirect_uri,
        "response_type": "code",
        "scope": " ".join(SCOPES),
        "access_type": "offline",     # we need a refresh token to book while nobody is logged in
        "prompt": "consent",          # force one, even if the user connected before
        # Incremental authorization: scopes this user already granted NEXUS stay in the new grant.
        "include_granted_scopes": "true",
        "state": state,
    }
    return f"{AUTH_URL}?{urlencode(params)}"


async def exchange_code(code: str) -> dict:
    """Exchange the OAuth authorization `code` for tokens (server-side, using the client secret).

    Returns Google's token response (access_token, refresh_token, expires_in...). Raises
    CalendarError: "reauth"/"api" from the HTTP status, or "no_refresh" if no refresh token came back.
    """
    resp = await _request("POST", TOKEN_URL, data={
        "code": code,
        "client_id": settings.google_client_id,
        "client_secret": settings.google_client_secret,
        "redirect_uri": settings.active_google_redirect_uri,
        "grant_type": "authorization_code",
    })
    _raise_for(resp, "connecting your account")
    data = _json(resp)
    # Without a refresh token NEXUS can't reach the calendar later while nobody is logged in,
    # so the connect is treated as failed instead of storing a grant that expires in an hour.
    if not data.get("refresh_token"):
        raise CalendarError("Google did not return a refresh token. Remove NEXUS from your Google "
                            "account's connected apps and connect again.", "no_refresh")
    return data


async def refresh_access_token(refresh_token: str) -> tuple[str, int]:
    """Trade a stored refresh token for a fresh access token.

    Returns (access_token, lifetime_in_seconds); the lifetime defaults to 3600 if Google omits it.
    Raises CalendarError; code "reauth" means the refresh token was revoked or expired.
    """
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
    """Email of the Google account behind `access_token` (needs the "email" scope), or None on any failure.

    Best effort on purpose: the address is only a display label, so a failed lookup must not fail the connect.
    """
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
    # Per-calendar failures (e.g. calendar not found) come back inside an HTTP 200, so check them here.
    if cal.get("errors"):
        raise CalendarError(f"Google could not read this calendar: {cal['errors']}", "api")
    return [(b["start"], b["end"]) for b in (cal.get("busy") or []) if b.get("start") and b.get("end")]


async def create_event(access_token: str, *, summary: str, description: str, start_iso: str,
                       end_iso: str, timezone: str, attendee_email: str | None,
                       calendar_id: str = "primary") -> dict:
    """Create a calendar event and return Google's event resource (it includes `id` and `htmlLink`).

    `start_iso` / `end_iso` are local wall-clock ISO strings interpreted in `timezone` (an IANA name).
    If `attendee_email` is given, Google emails that person an invite.
    """
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
        # sendUpdates controls whether Google emails the attendee; with no attendee there is nobody to notify.
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
