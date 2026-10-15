"""
Calling hours: the days and time-of-day window during which something may run, in a timezone.

Two features share this:
  * an outbound campaign only places calls inside its hours (columns `call_hours_*` on
    outbound_campaigns), and
  * a phone number's AI receptionist only answers inside its hours (columns `answer_hours_*` on
    phone_numbers).

Each owner stores the same five values under its own prefix: `<prefix>enabled` (off = no limit,
the behaviour before this feature), `<prefix>timezone` (an IANA name chosen by the user; NULL until
they choose, and REQUIRED once the hours are on: there is deliberately no default zone anywhere),
`<prefix>days` (weekday numbers, Monday = 0),
`<prefix>start` and `<prefix>end` ("HH:MM", end exclusive, "00:00" as an end means midnight). A
window cannot cross midnight: the end must be after the start, the same rule as the Callbacks
calling hours, whose window maths (services/callback_service.py) this module reuses.
"""
import logging
from datetime import datetime, timezone

from services.callback_service import in_calling_window, next_window_start, parse_hhmm
from services.calendar_service import normalize_timezone, valid_timezone

logger = logging.getLogger(__name__)

CAMPAIGN = "call_hours_"
NUMBER = "answer_hours_"

# What an owner that never set hours has (and the column defaults): off, no time zone, Mon-Fri, 9 to 5.
DEFAULTS = {"enabled": False, "timezone": None, "days": [0, 1, 2, 3, 4], "start": "09:00", "end": "17:00"}
KEYS = tuple(DEFAULTS)
DAY_NAMES = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")


class HoursError(ValueError):
    """A user-fixable problem with submitted hours; the message is shown to the customer."""


def fields(prefix: str) -> list[str]:
    """The five column names for `prefix`."""
    return [prefix + k for k in KEYS]


def touched(prefix: str, updates: dict) -> bool:
    """Whether `updates` carries any of the hours fields for `prefix`."""
    return any(prefix + k in updates for k in KEYS)


def read(row: dict | None, prefix: str) -> dict:
    """The hours stored on `row` as a plain dict (no prefix), with DEFAULTS for anything missing or
    null. Nothing is validated here; see validate()."""
    row = row or {}
    out = {}
    for k, default in DEFAULTS.items():
        v = row.get(prefix + k)
        out[k] = default if v is None else v
    return out


def _minutes(t, *, closing: bool = False) -> int:
    """Minutes since midnight; a closing time of 00:00 means the end of the day."""
    m = t.hour * 60 + t.minute
    return 24 * 60 if closing and m == 0 else m


def validate(prefix: str, row: dict | None, updates: dict) -> dict:
    """Merge the hours fields in `updates` over those on `row`, validate the result and return
    ALL five fields under their prefixed names with normalised values (zero-padded times, sorted
    days, canonical timezone), ready to store. Raises HoursError with a customer-facing message.

    The whole merged set is checked even when hours are switched off, so a stored row is always
    valid and can be switched on later without surprises."""
    s = read(row, prefix)
    for k in KEYS:
        if prefix + k in updates and updates[prefix + k] is not None:
            s[k] = updates[prefix + k]
    # Strict bool: "yes" or 1 must not switch a limit on or off by accident.
    if not isinstance(s["enabled"], bool):
        raise HoursError("Calling hours must be switched on or off.")
    # The time zone is the user's choice and has no default: it may stay unset while the hours are
    # off, but switching them on without one is refused. A zone that IS given must always be valid.
    tz = s["timezone"]
    if isinstance(tz, str) and not tz.strip():
        tz = None
    if tz is None:
        if s["enabled"]:
            raise HoursError("Select a time zone.")
    else:
        tz = normalize_timezone(tz)
        if not valid_timezone(tz):
            raise HoursError("That time zone isn't recognised.")
    s["timezone"] = tz
    days = s["days"]
    # bool is a subclass of int, so it is rejected explicitly.
    if (not isinstance(days, list) or not days or len(set(days)) != len(days)
            or any(isinstance(d, bool) or not isinstance(d, int) or not 0 <= d <= 6 for d in days)):
        raise HoursError("Pick at least one day.")
    s["days"] = sorted(days)
    times = {}
    for key, label in (("start", "Start time"), ("end", "End time")):
        t = parse_hhmm(s[key])
        if t is None:
            raise HoursError(f"{label} must look like 09:30.")
        s[key] = f"{t.hour:02d}:{t.minute:02d}"
        times[key] = t
    if _minutes(times["start"]) >= _minutes(times["end"], closing=True):
        raise HoursError("End time must be after start time.")
    return {prefix + k: s[k] for k in KEYS}


def _window(row: dict | None, prefix: str) -> dict:
    """The stored hours in the shape services.callback_service's window helpers read."""
    s = read(row, prefix)
    return {"timezone": s["timezone"], "work_days": s["days"], "start_time": s["start"], "end_time": s["end"]}


def chosen_timezone(row: dict | None, prefix: str) -> str | None:
    """The time zone the user chose for this row, or None while they have not chosen one (whether or
    not the hours are on: a zone saved earlier still counts)."""
    tz = (row or {}).get(prefix + "timezone")
    return tz if isinstance(tz, str) and tz.strip() and valid_timezone(tz) else None


def enabled(row: dict | None, prefix: str) -> bool:
    """Whether hours are switched on for this row (anything but a real True counts as off)."""
    return (row or {}).get(prefix + "enabled") is True


def is_open(row: dict | None, prefix: str, now: datetime | None = None, *, if_unreadable: bool = True) -> bool:
    """True when the owner may run right now: hours are off, or `now` falls inside them. Stored
    values that cannot be read (never written by validate(), so this means a damaged row) give
    `if_unreadable`: callers choose fail-open (answering a call) or fail-closed (placing one)."""
    if not enabled(row, prefix):
        return True
    try:
        return in_calling_window((now or datetime.now(timezone.utc)), _window(row, prefix))
    except Exception:  # noqa: BLE001 - damaged settings must not break the caller
        logger.warning("Unreadable calling hours under %r; treating as %s", prefix, "open" if if_unreadable else "closed")
        return if_unreadable


def next_opening(row: dict | None, prefix: str, now: datetime | None = None) -> datetime | None:
    """The next moment (UTC) the owner is open: `now` itself when open already, None when hours are
    off or unreadable."""
    if not enabled(row, prefix):
        return None
    try:
        return next_window_start((now or datetime.now(timezone.utc)), _window(row, prefix))
    except Exception:  # noqa: BLE001
        return None


def _clock(hhmm: str) -> str:
    """"13:05" -> "1:05 PM"; "00:00" -> "12:00 AM"."""
    h, m = int(hhmm[:2]), int(hhmm[3:5])
    return f"{h % 12 or 12}:{m:02d} {'AM' if h < 12 else 'PM'}"


def _days_text(days: list[int]) -> str:
    """[0,1,2,3,4] -> "Mon–Fri", all seven -> "Every day", otherwise runs and single days joined by
    commas ("Mon–Wed, Sat")."""
    days = sorted(set(days))
    if len(days) == 7:
        return "Every day"
    runs, start = [], 0
    for i in range(1, len(days) + 1):
        if i == len(days) or days[i] != days[i - 1] + 1:
            run = days[start:i]
            runs.append(DAY_NAMES[run[0]] if len(run) == 1 else
                        (f"{DAY_NAMES[run[0]]}, {DAY_NAMES[run[1]]}" if len(run) == 2 else f"{DAY_NAMES[run[0]]}–{DAY_NAMES[run[-1]]}"))
            start = i
    return ", ".join(runs)


def _span(start: str, end: str) -> str:
    """The times of day in words: "9:00 AM–5:00 PM", "8:00 AM–midnight" (an end of 00:00 is the end of
    the day) or "all day"."""
    if start == "00:00" and end == "00:00":
        return "all day"
    return f"{_clock(start)}–{'midnight' if end == '00:00' else _clock(end)}"


def describe(row: dict | None, prefix: str) -> str:
    """Hours in words, for messages: "Mon–Fri, 9:00 AM–5:00 PM (America/New_York)"."""
    s = read(row, prefix)
    try:
        zone = f" ({s['timezone']})" if s["timezone"] else ""
        return f"{_days_text(s['days'])}, {_span(s['start'], s['end'])}{zone}"
    except Exception:  # noqa: BLE001
        return "the hours you set"


def describe_moment(moment: datetime, row: dict | None, prefix: str) -> str:
    """A moment in the owner's own timezone for messages: "Tue 9:00 AM (America/New_York)"."""
    from zoneinfo import ZoneInfo

    tz = read(row, prefix)["timezone"]
    local = moment.astimezone(ZoneInfo(tz))
    return f"{DAY_NAMES[local.weekday()]} {_clock(local.strftime('%H:%M'))} ({tz})"


def state(row: dict | None, prefix: str, now: datetime | None = None, *, if_unreadable: bool = True) -> dict:
    """What the dashboard shows: {"enabled", "open", "next_open_at" (ISO UTC, only while closed),
    "summary" (the hours in words, only while enabled)}."""
    now = now or datetime.now(timezone.utc)
    if not enabled(row, prefix):
        return {"enabled": False, "open": True, "next_open_at": None, "summary": None}
    is_now = is_open(row, prefix, now, if_unreadable=if_unreadable)
    nxt = None if is_now else next_opening(row, prefix, now)
    return {"enabled": True, "open": is_now,
            "next_open_at": nxt.strftime("%Y-%m-%dT%H:%M:%SZ") if nxt else None,
            "summary": describe(row, prefix)}
