"""
Calendar business logic on top of services/google_calendar.py.

One Google calendar per NEXUS account (`calendar_connections`). Agents use two tools:
  * check_availability -> free slots inside the owner's working hours
  * book_slot          -> re-checks the slot, creates the event, records it in
                          `calendar_bookings` (idempotent per VAPI tool call)
Both return plain sentences meant to be read out by the voice agent.
"""

import logging
import re
import time
from datetime import date, datetime, time as dtime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from database import supabase
from services import google_calendar as gc
from services.encryption import decrypt_config, encrypt_config

logger = logging.getLogger(__name__)

DEFAULT_SETTINGS = {
    "timezone": "UTC",
    "work_days": [0, 1, 2, 3, 4],        # Monday=0 ... Sunday=6
    "start_time": "09:00",
    "end_time": "17:00",
    "slot_minutes": 30,
    "buffer_minutes": 0,
    "min_notice_hours": 2,
    "max_days_ahead": 30,
}
SLOTS_PER_DAY = 4          # how many times the agent is offered per day
MAX_DAYS_PER_CHECK = 7
_HHMM = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class SettingsError(ValueError):
    pass


# ── settings ────────────────────────────────────────────────────────────────

# Short names people type or expect (EST, PST...). They are mapped to a real region so daylight
# saving is handled: the bare "EST" zone is a FIXED UTC-5 all year and would be an hour off in summer.
# Only unambiguous abbreviations are listed (no "IST", which means India, Ireland and Israel).
TIMEZONE_ALIASES = {
    "EST": "America/New_York", "EDT": "America/New_York", "ET": "America/New_York",
    "CST": "America/Chicago", "CDT": "America/Chicago", "CT": "America/Chicago",
    "MST": "America/Denver", "MDT": "America/Denver", "MT": "America/Denver",
    "PST": "America/Los_Angeles", "PDT": "America/Los_Angeles", "PT": "America/Los_Angeles",
    "AKST": "America/Anchorage", "AKDT": "America/Anchorage",
    "HST": "Pacific/Honolulu", "PKT": "Asia/Karachi",
}


def normalize_timezone(name):
    """'est' / ' EST ' -> 'America/New_York'. Anything else is returned unchanged for validation."""
    if isinstance(name, str):
        return TIMEZONE_ALIASES.get(name.strip().upper(), name)
    return name


def valid_timezone(name) -> bool:
    if not isinstance(name, str) or not name.strip():
        return False
    try:
        ZoneInfo(name)
        return True
    except (ZoneInfoNotFoundError, ValueError, OSError):
        return False


def _hhmm(value, label) -> dtime:
    m = _HHMM.match(value) if isinstance(value, str) else None
    if not m:
        raise SettingsError(f"{label} must look like 09:30.")
    return dtime(int(m.group(1)), int(m.group(2)))


def _int_in(value, lo, hi, label) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not lo <= value <= hi:
        raise SettingsError(f"{label} must be a whole number from {lo} to {hi}.")
    return value


def validate_settings(current: dict, changes: dict) -> dict:
    """Merge `changes` over `current` and validate the result; raises SettingsError."""
    s = {**DEFAULT_SETTINGS, **(current or {}), **{k: v for k, v in (changes or {}).items() if k in DEFAULT_SETTINGS}}
    s["timezone"] = normalize_timezone(s["timezone"])
    if not valid_timezone(s["timezone"]):
        raise SettingsError("That timezone isn't recognised.")
    days = s["work_days"]
    if (not isinstance(days, list) or not days or len(set(days)) != len(days)
            or any(isinstance(d, bool) or not isinstance(d, int) or not 0 <= d <= 6 for d in days)):
        raise SettingsError("Pick at least one working day.")
    s["work_days"] = sorted(days)
    if _hhmm(s["start_time"], "Start time") >= _hhmm(s["end_time"], "End time"):
        raise SettingsError("End time must be after start time.")
    s["slot_minutes"] = _int_in(s["slot_minutes"], 10, 240, "Meeting length")
    s["buffer_minutes"] = _int_in(s["buffer_minutes"], 0, 120, "Buffer")
    s["min_notice_hours"] = _int_in(s["min_notice_hours"], 0, 168, "Minimum notice")
    s["max_days_ahead"] = _int_in(s["max_days_ahead"], 1, 90, "Booking window")
    return s


# ── pure slot maths (no I/O) ────────────────────────────────────────────────

def _utc(dt: datetime) -> datetime:
    return dt.astimezone(timezone.utc)


def parse_google_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def conflicts(start: datetime, end: datetime, busy: list, buffer_minutes: int) -> bool:
    pad = timedelta(minutes=buffer_minutes)
    return any(_utc(b0) - pad < _utc(end) and _utc(b1) + pad > _utc(start) for b0, b1 in busy)


def within_working_hours(start: datetime, end: datetime, s: dict) -> bool:
    """The whole meeting must sit inside one working day's hours (in the account timezone)."""
    tz = ZoneInfo(s["timezone"])
    local = start.astimezone(tz)
    if local.weekday() not in s["work_days"]:
        return False
    day_open = datetime.combine(local.date(), _hhmm(s["start_time"], ""), tzinfo=tz)
    day_close = datetime.combine(local.date(), _hhmm(s["end_time"], ""), tzinfo=tz)
    return _utc(day_open) <= _utc(start) and _utc(end) <= _utc(day_close)


def compute_slots(busy: list, s: dict, *, start_date: date, days: int, duration_minutes: int,
                  now: datetime, per_day: int = SLOTS_PER_DAY) -> list:
    """Free meeting starts (tz-aware, in the account timezone), at most `per_day` per day.

    Arithmetic is done in UTC so DST changes can't shift or duplicate a slot."""
    tz = ZoneInfo(s["timezone"])
    step = timedelta(minutes=s["slot_minutes"])
    dur = timedelta(minutes=duration_minutes)
    earliest = _utc(now) + timedelta(hours=s["min_notice_hours"])
    latest = _utc(now) + timedelta(days=s["max_days_ahead"])
    t0, t1 = _hhmm(s["start_time"], ""), _hhmm(s["end_time"], "")
    out = []
    for i in range(days):
        day = start_date + timedelta(days=i)
        if day.weekday() not in s["work_days"]:
            continue
        cur = _utc(datetime.combine(day, t0, tzinfo=tz))
        end_of_day = _utc(datetime.combine(day, t1, tzinfo=tz))
        taken = 0
        while cur + dur <= end_of_day and taken < per_day:
            if earliest <= cur <= latest and not conflicts(cur, cur + dur, busy, s["buffer_minutes"]):
                out.append(cur.astimezone(tz))
                taken += 1
            cur += step
    return out


def describe_slot(dt: datetime) -> str:
    return dt.strftime("%a %b %d, %I:%M %p").replace(" 0", " ")


# ── storage ─────────────────────────────────────────────────────────────────

_token_cache: dict = {}    # user_id -> (access_token, expires_at_epoch)


def get_connection(user_id: str) -> dict | None:
    res = supabase.table("calendar_connections").select("*").eq("user_id", user_id).limit(1).execute()
    return res.data[0] if res.data else None


def public_status(user_id: str) -> dict:
    from config import settings as app_settings
    row = get_connection(user_id)
    return {
        "configured": app_settings.google_calendar_configured,
        # Shown in the setup steps so whoever runs the server can paste it into Google Cloud Console.
        # (Not a secret. The client secret is never sent to the browser.)
        "redirect_uri": app_settings.active_google_redirect_uri,
        "connected": bool(row),
        "status": row["status"] if row else None,
        "email": row.get("email") if row else None,
        "settings": {**DEFAULT_SETTINGS, **(row.get("settings") or {})} if row else DEFAULT_SETTINGS,
    }


def save_connection(user_id: str, refresh_token: str, email: str | None, tz: str) -> None:
    settings_json = {**DEFAULT_SETTINGS, "timezone": tz if valid_timezone(tz) else "UTC"}
    fields = {
        "email": email, "refresh_token_encrypted": encrypt_config({"refresh_token": refresh_token}),
        "status": "connected", "updated_at": "now()",
    }
    existing = get_connection(user_id)
    _token_cache.pop(user_id, None)
    if existing:   # reconnecting keeps the owner's settings
        supabase.table("calendar_connections").update(fields).eq("user_id", user_id).execute()
    else:
        supabase.table("calendar_connections").insert(
            {**fields, "user_id": user_id, "settings": settings_json}).execute()


def update_settings(user_id: str, changes: dict) -> dict:
    row = get_connection(user_id)
    if not row:
        raise SettingsError("Connect a calendar first.")
    merged = validate_settings(row.get("settings") or {}, changes)
    supabase.table("calendar_connections").update({"settings": merged, "updated_at": "now()"}) \
        .eq("user_id", user_id).execute()
    return merged


async def disconnect(user_id: str) -> bool:
    row = get_connection(user_id)
    if not row:
        return False
    try:
        await gc.revoke(decrypt_config(row["refresh_token_encrypted"])["refresh_token"])
    except Exception as e:  # noqa: BLE001 — disconnect must always succeed locally
        logger.warning("calendar revoke skipped: %s", e)
    supabase.table("calendar_connections").delete().eq("user_id", user_id).execute()
    _token_cache.pop(user_id, None)
    return True


async def _access_token(user_id: str, row: dict) -> str:
    cached = _token_cache.get(user_id)
    if cached and cached[1] > time.time() + 60:
        return cached[0]
    try:
        token, ttl = await gc.refresh_access_token(decrypt_config(row["refresh_token_encrypted"])["refresh_token"])
    except gc.CalendarError as e:
        _token_cache.pop(user_id, None)
        if e.code == "reauth":
            supabase.table("calendar_connections").update({"status": "reauth_required"}).eq("user_id", user_id).execute()
        raise
    _token_cache[user_id] = (token, time.time() + ttl)
    return token


# ── agent-facing operations (return sentences for the voice agent) ──────────

NOT_CONNECTED = ("No calendar is connected to this account, so I can't check or book times. "
                 "Offer to have someone follow up to arrange a time.")
NEEDS_RECONNECT = ("The calendar connection has expired and needs to be reconnected by the account owner, "
                   "so I can't check or book times right now. Take the caller's details so someone can follow up.")
UNAVAILABLE = "I couldn't reach the calendar just now. Offer to have someone follow up, or try again in a moment."


def _failure_text(e: gc.CalendarError) -> str:
    return NEEDS_RECONNECT if e.code == "reauth" else UNAVAILABLE


def _usable(user_id: str):
    row = get_connection(user_id)
    if not row:
        return None, NOT_CONNECTED
    if row["status"] == "reauth_required":
        return None, NEEDS_RECONNECT
    return row, None


def _utc_z(dt: datetime) -> str:
    return _utc(dt).strftime("%Y-%m-%dT%H:%M:%SZ")


async def check_availability(user_id: str, date_str: str | None, days, duration, *, now: datetime | None = None) -> str:
    row, problem = _usable(user_id)
    if problem:
        return problem
    s = validate_settings(row.get("settings") or {}, {})
    tz = ZoneInfo(s["timezone"])
    now = now or datetime.now(timezone.utc)
    today = now.astimezone(tz).date()

    start_date = today
    if date_str:
        try:
            start_date = max(date.fromisoformat(str(date_str)[:10]), today)
        except ValueError:
            return "I couldn't understand that date. Ask for a specific day, e.g. 2026-10-06."
    try:
        days = min(max(int(days or 3), 1), MAX_DAYS_PER_CHECK)
        duration = int(duration or s["slot_minutes"])
    except (TypeError, ValueError):
        return "I couldn't understand the number of days or the meeting length."
    if not 10 <= duration <= 240:
        return "Meetings can be between 10 and 240 minutes long."

    window_start = datetime.combine(start_date, dtime(0, 0), tzinfo=tz)
    window_end = window_start + timedelta(days=days)
    try:
        token = await _access_token(user_id, row)
        busy_raw = await gc.freebusy(token, _utc_z(window_start), _utc_z(window_end), row.get("calendar_id") or "primary")
    except gc.CalendarError as e:
        return _failure_text(e)
    busy = [(parse_google_time(a), parse_google_time(b)) for a, b in busy_raw]

    slots = compute_slots(busy, s, start_date=start_date, days=days, duration_minutes=duration, now=now)
    if not slots:
        return (f"There are no free {duration}-minute times in that period ({s['timezone']}). "
                "Try asking for a later date.")
    lines = [f"- {describe_slot(d)} -> start_iso {d.isoformat(timespec='seconds')}" for d in slots]
    return (f"Free {duration}-minute times in {s['timezone']}. Offer a few of these, and when the caller picks "
            "one, confirm it and book with that exact start_iso:\n" + "\n".join(lines))


def _existing_booking(user_id: str, call_id, tool_call_id) -> dict | None:
    if not (call_id and tool_call_id):
        return None
    res = (supabase.table("calendar_bookings").select("*").eq("user_id", user_id)
           .eq("vapi_call_id", call_id).eq("tool_call_id", tool_call_id).limit(1).execute())
    return res.data[0] if res.data else None


def _confirmation(start: datetime, s: dict, email: str | None, invited: bool) -> str:
    when = f"{describe_slot(start.astimezone(ZoneInfo(s['timezone'])))} ({s['timezone']})"
    tail = f" A calendar invite was sent to {email}." if invited else " No email was given, so no invite was sent."
    return f"Booked for {when}.{tail} Confirm the time with the caller."


async def book_slot(user_id: str, args: dict, *, agent_id=None, agent_name=None, call_id=None,
                    tool_call_id=None, now: datetime | None = None) -> str:
    row, problem = _usable(user_id)
    if problem:
        return problem
    s = validate_settings(row.get("settings") or {}, {})
    tz = ZoneInfo(s["timezone"])
    now = now or datetime.now(timezone.utc)

    raw = str(args.get("start_iso") or "").strip()
    try:
        start = parse_google_time(raw)
    except ValueError:
        return "I couldn't understand that start time. Use check_availability first and book one of the times it returns."
    if start.tzinfo is None:
        start = start.replace(tzinfo=tz)
    try:
        minutes = int(args.get("duration_minutes") or s["slot_minutes"])
    except (TypeError, ValueError):
        return "I couldn't understand the meeting length."
    if not 10 <= minutes <= 240:
        return "Meetings can be between 10 and 240 minutes long."
    end = start + timedelta(minutes=minutes)

    email = str(args.get("contact_email") or "").strip()
    email = email if _EMAIL.match(email) else None
    name = str(args.get("contact_name") or "").strip()[:100] or "the caller"

    prior = _existing_booking(user_id, call_id, tool_call_id)
    if prior:   # VAPI retried the same tool call — confirm the existing booking, never double-book
        return _confirmation(parse_google_time(prior["start_at"]), s, prior.get("attendee_email"), bool(prior.get("attendee_email")))

    if _utc(start) < _utc(now) + timedelta(hours=s["min_notice_hours"]):
        return f"That time is too soon — bookings need at least {s['min_notice_hours']} hours' notice. Offer a later time."
    if _utc(start) > _utc(now) + timedelta(days=s["max_days_ahead"]):
        return f"That's too far ahead — bookings are limited to the next {s['max_days_ahead']} days."
    if not within_working_hours(start, end, s):
        return (f"That time is outside working hours ({s['start_time']}-{s['end_time']}, {s['timezone']}). "
                "Use check_availability and offer one of the free times.")

    pad = timedelta(minutes=s["buffer_minutes"])
    try:
        token = await _access_token(user_id, row)
        busy_raw = await gc.freebusy(token, _utc_z(start - pad), _utc_z(end + pad), row.get("calendar_id") or "primary")
        busy = [(parse_google_time(a), parse_google_time(b)) for a, b in busy_raw]
        if conflicts(start, end, busy, s["buffer_minutes"]):
            alt = await check_availability(user_id, start.astimezone(tz).date().isoformat(), 2, minutes, now=now)
            return "That time was just taken. " + alt
        title = f"Meeting with {name}"
        notes = str(args.get("notes") or "").strip()[:500]
        event = await gc.create_event(
            token, summary=title, timezone=s["timezone"], attendee_email=email,
            description=(notes + "\n\n" if notes else "") + f"Booked by your NEXUS AI agent{f' ({agent_name})' if agent_name else ''}.",
            start_iso=start.astimezone(tz).isoformat(timespec="seconds"),
            end_iso=end.astimezone(tz).isoformat(timespec="seconds"),
            calendar_id=row.get("calendar_id") or "primary",
        )
    except gc.CalendarError as e:
        return _failure_text(e)

    try:
        supabase.table("calendar_bookings").insert({
            "user_id": user_id, "agent_id": agent_id, "vapi_call_id": call_id, "tool_call_id": tool_call_id,
            "event_id": event.get("id"), "html_link": event.get("htmlLink"),
            "start_at": _utc_z(start), "end_at": _utc_z(end),
            "attendee_name": name, "attendee_email": email, "notes": notes or None,
        }).execute()
    except Exception as e:  # noqa: BLE001 — the event exists; don't fail the call over bookkeeping
        logger.warning("calendar booking bookkeeping failed for event %s: %s", event.get("id"), e)
    return _confirmation(start, s, email, bool(email))
