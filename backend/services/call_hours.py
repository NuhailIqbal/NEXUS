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

Campaigns (only) can go further, in one extra column `call_hours_schedule` (a JSON object):
  * mode "same" (the default, and what an empty object means): the five values above apply every
    day, plus `breaks` ([{"start","end"}, ...]) inside the window during which nothing starts;
  * mode "per_day": `days` maps "0".."6" (Monday = 0) to {"on", "start", "end", "breaks"}, each day
    with its own window and breaks. The plain `days`/`start`/`end` columns are then DERIVED (the days
    that are on, the earliest start and the latest end) so they stay a valid summary.
Breaks lie inside their window, never overlap and never cover all of it. The window of a day minus its
breaks is a list of open segments; the owner is open while the local time is inside one of them.
"""
import logging
from datetime import datetime, time as dtime, timedelta, timezone
from zoneinfo import ZoneInfo

from services.callback_service import _at, parse_hhmm
from services.calendar_service import normalize_timezone, valid_timezone

logger = logging.getLogger(__name__)

CAMPAIGN = "call_hours_"
NUMBER = "answer_hours_"

# What an owner that never set hours has (and the column defaults): off, no time zone, Mon-Fri, 9 to 5.
DEFAULTS = {"enabled": False, "timezone": None, "days": [0, 1, 2, 3, 4], "start": "09:00", "end": "17:00"}
KEYS = tuple(DEFAULTS)
DAY_NAMES = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
FULL_DAY_NAMES = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")

# Owners that also have the `schedule` field (per-day windows and breaks); phone numbers do not.
SCHEDULED = (CAMPAIGN,)
SAME, PER_DAY = "same", "per_day"
MAX_BREAKS = 10          # per day (or for the shared schedule)


class HoursError(ValueError):
    """A user-fixable problem with submitted hours; the message is shown to the customer."""


def keys(prefix: str) -> tuple[str, ...]:
    """The unprefixed field names an owner of `prefix` has: five, plus `schedule` for campaigns."""
    return KEYS + ("schedule",) if prefix in SCHEDULED else KEYS


def fields(prefix: str) -> list[str]:
    """The column names for `prefix`."""
    return [prefix + k for k in keys(prefix)]


def touched(prefix: str, updates: dict) -> bool:
    """Whether `updates` carries any of the hours fields for `prefix`."""
    return any(prefix + k in updates for k in keys(prefix))


def read(row: dict | None, prefix: str) -> dict:
    """The hours stored on `row` as a plain dict (no prefix), with DEFAULTS for anything missing or
    null. Nothing is validated here; see validate()."""
    row = row or {}
    out = {}
    for k, default in DEFAULTS.items():
        v = row.get(prefix + k)
        out[k] = default if v is None else v
    if prefix in SCHEDULED:
        v = row.get(prefix + "schedule")
        out["schedule"] = v if isinstance(v, dict) else {}
    return out


def _minutes(t, *, closing: bool = False) -> int:
    """Minutes since midnight; a closing time of 00:00 means the end of the day."""
    m = t.hour * 60 + t.minute
    return 24 * 60 if closing and m == 0 else m


def _hhmm(minutes: int) -> str:
    """Minutes since midnight as "HH:MM"; the end of the day (1440) is written "00:00"."""
    minutes %= 24 * 60
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def _clean_window(start_raw, end_raw, where: str = "") -> tuple[int, int]:
    """Validate one start/end pair and return it in minutes (an end of 00:00 is the end of the day).
    `where` prefixes the message ("Monday: ") when the hours differ per day."""
    times = []
    for raw, label in ((start_raw, "Start time"), (end_raw, "End time")):
        t = parse_hhmm(raw)
        if t is None:
            raise HoursError(f"{where}{label} must look like 09:30.")
        times.append(t)
    start, end = _minutes(times[0]), _minutes(times[1], closing=True)
    if start >= end:
        raise HoursError(f"{where}End time must be after start time.")
    return start, end


def _clean_breaks(raw, start: int, end: int, where: str = "") -> list[dict]:
    """Validate the breaks inside a window of `start`..`end` minutes and return them normalised and
    sorted. Each must end after it starts and lie inside the window; they must not overlap, and together
    they must leave some time to run."""
    if raw is None:
        raw = []
    if not isinstance(raw, list):
        raise HoursError(f"{where}Breaks must be a list.")
    if len(raw) > MAX_BREAKS:
        raise HoursError(f"{where}Add at most {MAX_BREAKS} breaks.")
    spans = []
    for b in raw:
        t0 = parse_hhmm(b.get("start")) if isinstance(b, dict) else None
        t1 = parse_hhmm(b.get("end")) if isinstance(b, dict) else None
        if t0 is None or t1 is None:
            raise HoursError(f"{where}A break needs a start and an end time that look like 13:00.")
        m0, m1 = _minutes(t0), _minutes(t1, closing=True)
        if m0 >= m1:
            raise HoursError(f"{where}A break must end after it starts.")
        if m0 < start or m1 > end:
            raise HoursError(f"{where}A break must fall inside the running hours ({_span(_hhmm(start), _hhmm(end))}).")
        spans.append((m0, m1))
    spans.sort()
    for (_, a1), (b0, _) in zip(spans, spans[1:]):
        if b0 < a1:
            raise HoursError(f"{where}Breaks can't overlap.")
    if spans and sum(b - a for a, b in spans) >= end - start:
        raise HoursError(f"{where}The breaks leave no time to run.")
    return [{"start": _hhmm(a), "end": _hhmm(b)} for a, b in spans]


def _clean_per_day(raw) -> tuple[dict, list[int], str, str]:
    """Validate a per-day schedule ({"0": {"on", "start", "end", "breaks"}, ...}, Monday = 0). Returns
    (normalised schedule of all seven days, the days that are on, earliest start, latest end). A day
    that is off or missing is stored as just {"on": false}."""
    if not isinstance(raw, dict):
        raise HoursError("Set the hours for each day.")
    known = {str(d) for d in range(7)}
    if any(str(k) not in known for k in raw):
        raise HoursError("The schedule has a day that does not exist.")
    out, on_days, starts, ends = {}, [], [], []
    for d in range(7):
        cfg = raw.get(str(d), raw.get(d))
        name = FULL_DAY_NAMES[d]
        if cfg is None or (isinstance(cfg, dict) and cfg.get("on") is False):
            out[str(d)] = {"on": False}
            continue
        # Strict: only a real true counts as on (an unclear value must not switch a day on).
        if not isinstance(cfg, dict) or cfg.get("on") is not True:
            raise HoursError(f"{name}: switch the day on or off.")
        start, end = _clean_window(cfg.get("start"), cfg.get("end"), f"{name}: ")
        out[str(d)] = {"on": True, "start": _hhmm(start), "end": _hhmm(end),
                       "breaks": _clean_breaks(cfg.get("breaks"), start, end, f"{name}: ")}
        on_days.append(d)
        starts.append(start)
        ends.append(end)
    if not on_days:
        raise HoursError("Pick at least one day.")
    return out, on_days, _hhmm(min(starts)), _hhmm(max(ends))


def validate(prefix: str, row: dict | None, updates: dict) -> dict:
    """Merge the hours fields in `updates` over those on `row`, validate the result and return
    ALL fields of `prefix` under their prefixed names with normalised values (zero-padded times, sorted
    days, canonical timezone, tidy schedule), ready to store. Raises HoursError with a customer-facing
    message.

    The whole merged set is checked even when hours are switched off, so a stored row is always
    valid and can be switched on later without surprises."""
    s = read(row, prefix)
    for k in keys(prefix):
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

    schedule = s.get("schedule") if prefix in SCHEDULED else None
    if schedule is not None and not isinstance(schedule, dict):
        raise HoursError("The schedule isn't readable.")
    mode = (schedule or {}).get("mode", SAME)
    if mode not in (SAME, PER_DAY):
        raise HoursError("Choose the same schedule every day or a custom schedule per day.")

    if mode == PER_DAY:
        # Each day carries its own window; the plain days/start/end fields become their summary.
        days_cfg, s["days"], s["start"], s["end"] = _clean_per_day(schedule.get("days"))
        s["schedule"] = {"mode": PER_DAY, "days": days_cfg}
    else:
        days = s["days"]
        # bool is a subclass of int, so it is rejected explicitly.
        if (not isinstance(days, list) or not days or len(set(days)) != len(days)
                or any(isinstance(d, bool) or not isinstance(d, int) or not 0 <= d <= 6 for d in days)):
            raise HoursError("Pick at least one day.")
        s["days"] = sorted(days)
        start, end = _clean_window(s["start"], s["end"])
        s["start"], s["end"] = _hhmm(start), _hhmm(end)
        if prefix in SCHEDULED:
            s["schedule"] = {"mode": SAME, "breaks": _clean_breaks((schedule or {}).get("breaks"), start, end)}
    return {prefix + k: s[k] for k in keys(prefix)}


def chosen_timezone(row: dict | None, prefix: str) -> str | None:
    """The time zone the user chose for this row, or None while they have not chosen one (whether or
    not the hours are on: a zone saved earlier still counts)."""
    tz = (row or {}).get(prefix + "timezone")
    return tz if isinstance(tz, str) and tz.strip() and valid_timezone(tz) else None


def enabled(row: dict | None, prefix: str) -> bool:
    """Whether hours are switched on for this row (anything but a real True counts as off)."""
    return (row or {}).get(prefix + "enabled") is True


def _segments(start, end, breaks) -> list[tuple[int, int]]:
    """The open stretches (start, end minutes) of a window with its breaks cut out. Reads stored values
    leniently (breaks outside the window are clipped); damaged times raise, which callers treat as
    "unreadable"."""
    w0, w1 = _minutes(parse_hhmm(start)), _minutes(parse_hhmm(end), closing=True)
    cuts = sorted((_minutes(parse_hhmm(b["start"])), _minutes(parse_hhmm(b["end"]), closing=True)) for b in breaks or [])
    segments, cursor = [], w0
    for b0, b1 in cuts:
        b0, b1 = max(b0, w0), min(b1, w1)
        if b1 <= b0:
            continue
        if b0 > cursor:
            segments.append((cursor, b0))
        cursor = max(cursor, b1)
    if cursor < w1:
        segments.append((cursor, w1))
    return segments


def _day_segments(s: dict, weekday: int) -> list[tuple[int, int]]:
    """The open stretches of one weekday (Monday = 0) for hours read() returned; none on a day that is off."""
    schedule = s.get("schedule") or {}
    if schedule.get("mode") == PER_DAY:
        cfg = (schedule.get("days") or {}).get(str(weekday))
        if not isinstance(cfg, dict) or cfg.get("on") is not True:
            return []
        return _segments(cfg["start"], cfg["end"], cfg.get("breaks"))
    if weekday not in s["days"]:
        return []
    return _segments(s["start"], s["end"], schedule.get("breaks"))


def _inside(s: dict, local: datetime) -> bool:
    """Whether the zone-local time `local` lies in an open stretch of its day (minute precision)."""
    minute = local.hour * 60 + local.minute
    return any(a <= minute < b for a, b in _day_segments(s, local.weekday()))


def is_open(row: dict | None, prefix: str, now: datetime | None = None, *, if_unreadable: bool = True) -> bool:
    """True when the owner may run right now: hours are off, or `now` falls inside them (on a day that
    is on, inside its window and outside its breaks). Stored values that cannot be read (never written
    by validate(), so this means a damaged row) give `if_unreadable`: callers choose fail-open
    (answering a call) or fail-closed (placing one)."""
    if not enabled(row, prefix):
        return True
    try:
        s = read(row, prefix)
        return _inside(s, (now or datetime.now(timezone.utc)).astimezone(ZoneInfo(s["timezone"])))
    except Exception:  # noqa: BLE001 - damaged settings must not break the caller
        logger.warning("Unreadable calling hours under %r; treating as %s", prefix, "open" if if_unreadable else "closed")
        return if_unreadable


def next_opening(row: dict | None, prefix: str, now: datetime | None = None) -> datetime | None:
    """The next moment (UTC) the owner is open: `now` itself when open already, None when hours are
    off or unreadable. The end of a break counts as an opening."""
    if not enabled(row, prefix):
        return None
    try:
        s = read(row, prefix)
        moment = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
        tz = ZoneInfo(s["timezone"])
        local = moment.astimezone(tz)
        if _inside(s, local):
            return moment
        # Today and the next 8 local days: the first open stretch that starts after `moment`.
        for i in range(9):
            day = local.date() + timedelta(days=i)
            for begin, _ in _day_segments(s, day.weekday()):
                opening = _at(day, dtime(begin // 60, begin % 60), tz).astimezone(timezone.utc)
                if opening > moment:
                    return opening
        return None
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


def _breaks_text(breaks) -> str:
    """"1:00 PM–2:00 PM" or "1:00 PM–2:00 PM and 3:30 PM–3:45 PM"."""
    return " and ".join(_span(b["start"], b["end"]) for b in breaks or [])


def describe(row: dict | None, prefix: str) -> str:
    """Hours in words, for messages: "Mon–Fri, 9:00 AM–5:00 PM (America/New_York)". Breaks follow the
    window ("..., break 1:00 PM–2:00 PM"); a per-day schedule groups the days that share hours
    ("Mon–Fri 9:00 AM–6:00 PM; Sat 10:00 AM–2:00 PM (zone)")."""
    s = read(row, prefix)
    try:
        zone = f" ({s['timezone']})" if s["timezone"] else ""
        schedule = s.get("schedule") or {}
        if schedule.get("mode") == PER_DAY:
            groups: dict[tuple, list[int]] = {}
            for d in range(7):
                cfg = (schedule.get("days") or {}).get(str(d))
                if isinstance(cfg, dict) and cfg.get("on") is True:
                    key = (cfg["start"], cfg["end"], tuple((b["start"], b["end"]) for b in cfg.get("breaks") or []))
                    groups.setdefault(key, []).append(d)
            parts = []
            for (start, end, breaks), days in groups.items():
                extra = f" (break {_breaks_text([{'start': a, 'end': b} for a, b in breaks])})" if breaks else ""
                parts.append(f"{_days_text(days)} {_span(start, end)}{extra}")
            return "; ".join(parts) + zone
        breaks = schedule.get("breaks")
        extra = f", break {_breaks_text(breaks)}" if breaks else ""
        return f"{_days_text(s['days'])}, {_span(s['start'], s['end'])}{extra}{zone}"
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
