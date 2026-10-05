"""
Callbacks: when a caller says "call me back at 5", the event that carries
`callback_in_minutes` (or `callback_in_days` + `callback_time`) becomes a row in `callbacks`.

The AI never has to know today's date or the time: for "in 30 minutes" it sends the number of
minutes, for a day/clock time it sends how many days from today (0 = today) and a 24-hour clock
time in the caller's local time, and the server turns that into a real moment using the
account's timezone. A callback is only a RECORD until the account turns on
`callback_settings.auto_call` (off by default) — see services/callback_scheduler.py.
"""

import logging
import re
from datetime import date, datetime, time as dtime, timedelta, timezone
from zoneinfo import ZoneInfo

from database import supabase
from services.calendar_service import normalize_timezone, valid_timezone

logger = logging.getLogger(__name__)

DEFAULT_SETTINGS = {
    "auto_call": False,
    "timezone": "UTC",
    "work_days": [0, 1, 2, 3, 4],       # Monday = 0
    "start_time": "09:00",
    "end_time": "18:00",
    "default_time": "10:00",            # used when the caller gave no usable time
    "retry_minutes": 30,
    "max_attempts": 2,
}
MIN_NOTICE_MINUTES = 5       # "today at 17:00" said at 16:58 means tomorrow, not "right now"
MAX_DAYS_AHEAD = 60
MAX_MINUTES_AHEAD = 7 * 24 * 60    # "in N minutes" is for short waits; longer ones use a day + time
STATUSES = ("pending", "calling", "called", "failed", "cancelled", "skipped")
_HHMM = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")


class CallbackError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


# ── settings ────────────────────────────────────────────────────────────────

def parse_hhmm(value) -> dtime | None:
    m = _HHMM.match(value.strip()) if isinstance(value, str) else None
    return dtime(int(m.group(1)), int(m.group(2))) if m else None


def _minutes(t: dtime, *, closing: bool = False) -> int:
    """Minutes since midnight. A closing time of 00:00 (12:00 AM) means the end of the day, not its start."""
    m = t.hour * 60 + t.minute
    return 24 * 60 if closing and m == 0 else m


def validate_settings(current: dict, changes: dict) -> dict:
    s = {**DEFAULT_SETTINGS, **(current or {}),
         **{k: v for k, v in (changes or {}).items() if k in DEFAULT_SETTINGS}}
    if not isinstance(s["auto_call"], bool):
        raise CallbackError("auto_call must be true or false.")
    s["timezone"] = normalize_timezone(s["timezone"])
    if not valid_timezone(s["timezone"]):
        raise CallbackError("That timezone isn't recognised.")
    days = s["work_days"]
    if (not isinstance(days, list) or not days or len(set(days)) != len(days)
            or any(isinstance(d, bool) or not isinstance(d, int) or not 0 <= d <= 6 for d in days)):
        raise CallbackError("Pick at least one calling day.")
    s["work_days"] = sorted(days)
    times = {}
    for key, label in (("start_time", "Start time"), ("end_time", "End time"), ("default_time", "Default callback time")):
        t = parse_hhmm(s[key])
        if t is None:
            raise CallbackError(f"{label} must look like 09:30.")
        s[key] = f"{t.hour:02d}:{t.minute:02d}"
        times[key] = t
    start, end, default = _minutes(times["start_time"]), _minutes(times["end_time"], closing=True), _minutes(times["default_time"])
    if start >= end:
        raise CallbackError("End time must be after start time.")
    if not start <= default < end:
        raise CallbackError("The default callback time must fall inside your calling hours.")
    for key, lo, hi, label in (("retry_minutes", 5, 1440, "Retry delay"), ("max_attempts", 1, 5, "Attempts")):
        v = s[key]
        if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
            raise CallbackError(f"{label} must be a whole number from {lo} to {hi}.")
    return s


def get_settings(user_id: str) -> dict:
    res = supabase.table("callback_settings").select("*").eq("user_id", user_id).limit(1).execute()
    row = res.data[0] if res.data else {}
    return {**DEFAULT_SETTINGS, **{k: row[k] for k in DEFAULT_SETTINGS if k in row}}


def save_settings(user_id: str, changes: dict) -> dict:
    merged = validate_settings(get_settings(user_id), changes)
    exists = supabase.table("callback_settings").select("user_id").eq("user_id", user_id).limit(1).execute().data
    if exists:
        supabase.table("callback_settings").update({**merged, "updated_at": "now()"}).eq("user_id", user_id).execute()
    else:
        supabase.table("callback_settings").insert({**merged, "user_id": user_id}).execute()
    return merged


# ── turning "5 baje" into a moment ──────────────────────────────────────────

def _int_days(value) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, str) and value.strip().lstrip("-").isdigit():
        value = int(value.strip())
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return value if isinstance(value, int) and 0 <= value <= MAX_DAYS_AHEAD else None


def _int_minutes(value) -> int | None:
    """A whole number of minutes (1..MAX_MINUTES_AHEAD). Anything else is treated as not given."""
    if isinstance(value, bool):
        return None
    if isinstance(value, str) and value.strip().isdigit():
        value = int(value.strip())
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return value if isinstance(value, int) and 1 <= value <= MAX_MINUTES_AHEAD else None


def _at(day: date, t: dtime, tz: ZoneInfo) -> datetime:
    return datetime.combine(day, t, tzinfo=tz)


def _next_work_day(day: date, work_days: list) -> date:
    for _ in range(8):
        if day.weekday() in work_days:
            return day
        day += timedelta(days=1)
    return day


def resolve_due(days, time_str, s: dict, now: datetime | None = None, *,
                minutes=None) -> tuple[datetime, str, str | None]:
    """-> (due moment in UTC, source 'caller' | 'default', note about any adjustment).

    caller said how long to wait ("in 30 minutes") -> now + that many minutes (never sooner than
                          MIN_NOTICE_MINUTES); it wins over days/time, which the AI could only guess at
    caller gave a time  -> that clock time (today if still ahead, else tomorrow; `days` shifts the date)
    caller gave only days -> that day at the default time
    nothing usable       -> the next calling day at the default time"""
    tz = ZoneInfo(s["timezone"])
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    local_now = now.astimezone(tz)
    today = local_now.date()
    earliest = now + timedelta(minutes=MIN_NOTICE_MINUTES)
    t = parse_hhmm(time_str)
    d = _int_days(days)
    default_t = parse_hhmm(s["default_time"])
    note = None

    m = _int_minutes(minutes)
    if m is not None:
        due = now + timedelta(minutes=m)
        if due < earliest:
            due = earliest
            note = f"Moved to the {MIN_NOTICE_MINUTES}-minute minimum."
        return due, "caller", note

    if t is not None:
        day = today + timedelta(days=d if d is not None else 0)
        due = _at(day, t, tz)
        if due.astimezone(timezone.utc) < earliest:
            due = _at(day + timedelta(days=1), t, tz)
            note = "That time had already passed today, so it was moved to tomorrow."
        return due.astimezone(timezone.utc), "caller", note

    if d is not None:
        due = _at(_next_work_day(today + timedelta(days=d), s["work_days"]), default_t, tz)
        if due.astimezone(timezone.utc) < earliest:
            due = _at(_next_work_day(today + timedelta(days=d + 1), s["work_days"]), default_t, tz)
        return due.astimezone(timezone.utc), "default", "The caller gave a day but no time, so the default time was used."

    due = _at(_next_work_day(today + timedelta(days=1), s["work_days"]), default_t, tz)
    return due.astimezone(timezone.utc), "default", "The caller gave no time, so the next calling day at the default time was used."


def in_calling_window(moment: datetime, s: dict) -> bool:
    local = moment.astimezone(ZoneInfo(s["timezone"]))
    return (local.weekday() in s["work_days"]
            and _minutes(parse_hhmm(s["start_time"])) <= _minutes(local.time())
            < _minutes(parse_hhmm(s["end_time"]), closing=True))


def next_window_start(moment: datetime, s: dict) -> datetime:
    """`moment` itself if it is inside the calling window, otherwise the next opening time (UTC)."""
    moment = moment.astimezone(timezone.utc)
    if in_calling_window(moment, s):
        return moment
    tz = ZoneInfo(s["timezone"])
    start = parse_hhmm(s["start_time"])
    first_day = moment.astimezone(tz).date()
    for i in range(9):
        day = first_day + timedelta(days=i)
        if day.weekday() not in s["work_days"]:
            continue
        opening = _at(day, start, tz).astimezone(timezone.utc)
        if opening > moment:
            return opening
    return moment


# ── creating callbacks from an event ────────────────────────────────────────

def _find_contact(user_id: str, phone: str | None) -> dict | None:
    if not phone:
        return None
    res = supabase.table("contacts").select("id, name").eq("user_id", user_id).eq("phone", phone).limit(1).execute()
    return res.data[0] if res.data else None


def schedule_from_event(user_id: str, agent_id: str, vapi_call_id: str, tool_call_id: str | None,
                        phone: str | None, args: dict, note: str | None, *, now: datetime | None = None) -> dict:
    """Record the callback a caller asked for. A newer request from the same caller replaces
    an older pending one, and a retried tool call never creates a second row."""
    s = get_settings(user_id)
    due, source, adjust = resolve_due(args.get("callback_in_days"), args.get("callback_time"), s, now,
                                      minutes=args.get("callback_in_minutes"))
    said = (note or "").strip()
    text = " ".join(x for x in (said, f"({adjust})" if adjust else "") if x)[:500] or None
    phone = (phone or "").strip() or None
    contact = _find_contact(user_id, phone)

    # one live callback per caller: the newest request wins
    old = supabase.table("callbacks").select("id").eq("user_id", user_id).eq("status", "pending")
    old = (old.eq("phone", phone) if phone else old.eq("vapi_call_id", vapi_call_id)).execute().data or []
    for r in old:
        supabase.table("callbacks").update({"status": "cancelled", "last_error": "Replaced by a newer callback request.",
                                            "updated_at": "now()"}).eq("id", r["id"]).execute()
    try:
        res = supabase.table("callbacks").insert({
            "user_id": user_id, "agent_id": agent_id, "vapi_call_id": vapi_call_id, "tool_call_id": tool_call_id,
            "contact_id": contact["id"] if contact else None, "contact_name": contact["name"] if contact else None,
            "phone": phone, "due_at": due.strftime("%Y-%m-%dT%H:%M:%SZ"), "timezone": s["timezone"],
            "time_source": source, "requested_text": text,
        }).execute()
        return res.data[0]
    except Exception:
        if not tool_call_id:
            raise
        prior = (supabase.table("callbacks").select("*").eq("vapi_call_id", vapi_call_id)
                 .eq("tool_call_id", tool_call_id).limit(1).execute().data)
        if prior:    # lost a race against a retry of the same tool call
            return prior[0]
        raise


def attach_conversation(vapi_call_id: str, conversation_id: str) -> None:
    """At hangup: link callbacks to their conversation and fill in a phone number that was
    not known mid-call (e.g. the web test call had none)."""
    if not vapi_call_id or not conversation_id:
        return
    try:
        rows = supabase.table("callbacks").select("id, phone, user_id").eq("vapi_call_id", vapi_call_id).execute().data or []
        if not rows:
            return
        conv = supabase.table("conversations").select("phone").eq("id", conversation_id).limit(1).execute().data
        conv_phone = (conv[0].get("phone") or "").strip() if conv else ""
        for r in rows:
            fields = {"conversation_id": conversation_id}
            if not r.get("phone") and conv_phone:
                fields["phone"] = conv_phone
                contact = _find_contact(r["user_id"], conv_phone)
                if contact:
                    fields.update(contact_id=contact["id"], contact_name=contact["name"])
            supabase.table("callbacks").update(fields).eq("id", r["id"]).execute()
    except Exception as e:  # noqa: BLE001 — never break call-end processing
        logger.warning("attach_conversation failed for %s: %s", vapi_call_id, e)


# ── reading and editing (the Callbacks page) ────────────────────────────────

def list_callbacks(user_id: str, status: str | None = None, limit: int = 200) -> list[dict]:
    q = supabase.table("callbacks").select("*").eq("user_id", user_id)
    if status:
        q = q.eq("status", status)
    rows = q.order("due_at", desc=True).limit(limit).execute().data or []
    agent_ids = sorted({r["agent_id"] for r in rows if r.get("agent_id")})
    names = {}
    if agent_ids:
        names = {a["id"]: a["name"] for a in (supabase.table("ai_agents").select("id, name").in_("id", agent_ids).execute().data or [])}
    for r in rows:
        r["agent_name"] = names.get(r.get("agent_id"), "")
    return rows


def status_counts(user_id: str) -> dict:
    rows = supabase.table("callbacks").select("status").eq("user_id", user_id).execute().data or []
    out = {s: 0 for s in STATUSES}
    for r in rows:
        out[r["status"]] = out.get(r["status"], 0) + 1
    return out


def _owned(user_id: str, callback_id: str) -> dict:
    try:
        res = supabase.table("callbacks").select("*").eq("id", callback_id).eq("user_id", user_id).limit(1).execute()
    except Exception:    # malformed id
        res = None
    if not res or not res.data:
        raise CallbackError("Callback not found.", 404)
    return res.data[0]


def reschedule(user_id: str, callback_id: str, due_local: str, *, now: datetime | None = None) -> dict:
    cb = _owned(user_id, callback_id)
    if cb["status"] in ("calling", "called"):
        raise CallbackError("This callback has already been placed.", 409)
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    try:
        when = datetime.fromisoformat(str(due_local).strip())
    except ValueError:
        raise CallbackError("Enter the callback time as a date and time.")
    # A typed date/time is read in the account's CURRENT timezone (what the page shows), not the one
    # the callback happened to be created under.
    tz_name = get_settings(user_id)["timezone"]
    zone = ZoneInfo(tz_name if valid_timezone(tz_name) else "UTC")
    when = (when.replace(tzinfo=zone) if when.tzinfo is None else when).astimezone(timezone.utc)
    if when < now + timedelta(minutes=1):
        raise CallbackError("Pick a time in the future.")
    if when > now + timedelta(days=MAX_DAYS_AHEAD):
        raise CallbackError(f"Callbacks can be scheduled at most {MAX_DAYS_AHEAD} days ahead.")
    fields = {"due_at": when.strftime("%Y-%m-%dT%H:%M:%SZ"), "timezone": zone.key, "status": "pending", "attempts": 0,
              "time_source": "manual", "last_error": None, "updated_at": "now()"}
    supabase.table("callbacks").update(fields).eq("id", callback_id).execute()
    return _owned(user_id, callback_id)


def set_status(user_id: str, callback_id: str, status: str) -> dict:
    if status not in ("cancelled", "called"):
        raise CallbackError("Status can only be set to cancelled or called.")
    cb = _owned(user_id, callback_id)
    if cb["status"] == "calling":
        raise CallbackError("This callback is being placed right now.", 409)
    if cb["status"] == "called" and status == "cancelled":
        raise CallbackError("This callback has already been placed.", 409)
    note = "Cancelled by a person." if status == "cancelled" else "Marked as done by a person."
    supabase.table("callbacks").update({"status": status, "last_error": note, "updated_at": "now()"}).eq("id", callback_id).execute()
    return _owned(user_id, callback_id)
