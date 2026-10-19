"""
Property-style tests for the calling-hours engine (services/call_hours.py) with breaks and per-day schedules.

Three independent checks, all with a seeded random generator so a failure is reproducible:
  1. no regression: with no breaks the new engine says exactly what the old window maths
     (services/callback_service.in_calling_window / next_window_start) say, for campaigns AND phone
     numbers, across zones and across the days clocks change;
  2. brute force: for random schedules (breaks, custom days) it is open at exactly the minutes a plain
     minute-by-minute reading of the schedule says, and the next opening is the first such minute;
  3. garbage in, no crash out: anything sent as a schedule either becomes a valid stored value (which
     validates again to itself) or is refused with HoursError; anything stored never raises when read.

No database: pure functions only.  Run from the backend folder:  python -m unittest discover -s tests -v
"""
import logging
import random
import unittest
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from services import call_hours
from services.callback_service import in_calling_window, next_window_start

C, N = call_hours.CAMPAIGN, call_hours.NUMBER
UTC = timezone.utc
ZONES = ["UTC", "Asia/Karachi", "America/New_York", "Europe/London", "Australia/Sydney", "Asia/Kolkata", "Pacific/Auckland",
         "America/Los_Angeles", "Asia/Kathmandu", "America/St_Johns", "Pacific/Kiritimati", "America/Sao_Paulo"]


def hhmm(minutes: int) -> str:
    minutes %= 1440
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def random_window(rng, grid=15):
    """(start, end) minutes on the grid, end after start; end may be 1440 (shown 00:00)."""
    a = rng.randrange(0, 1440 // grid) * grid
    b = rng.randrange(a // grid + 1, 1440 // grid + 1) * grid
    return a, b


def random_breaks(rng, start, end, grid=15):
    """Non-overlapping breaks inside the window that leave some time to run (maybe none at all)."""
    cuts, cursor = [], start
    for _ in range(rng.randrange(0, 4)):
        if end - cursor < 3 * grid:
            break
        a = rng.randrange(cursor // grid, (end - grid) // grid) * grid
        b = rng.randrange(a // grid + 1, end // grid + 1) * grid
        if a < cursor or (a == start and b == end):
            continue
        cuts.append((a, b))
        cursor = b
    return [{"start": hhmm(a), "end": hhmm(b)} for a, b in cuts]


def instants(rng, n, zone):
    """n instants spread over 14 months, always including days around the clock changes of `zone`."""
    base = datetime(2026, 1, 1, tzinfo=UTC)
    out = [base + timedelta(minutes=rng.randrange(0, 14 * 30 * 1440)) for _ in range(n)]
    for month, day in ((3, 8), (3, 29), (10, 4), (10, 25), (11, 1), (4, 5)):
        local_midnight = datetime(2026, month, day, tzinfo=ZoneInfo(zone)).astimezone(UTC)
        out += [local_midnight + timedelta(minutes=rng.randrange(0, 2 * 1440)) for _ in range(6)]
    return out


class NoRegression(unittest.TestCase):
    """Without breaks the engine answers exactly as the window maths it replaced."""

    def test_random_windows_agree_with_the_old_maths_in_every_zone(self):
        rng = random.Random(20261020)
        checked = 0
        for zone in ZONES:
            for _ in range(12):
                start, end = random_window(rng)
                days = sorted(rng.sample(range(7), rng.randrange(1, 8)))
                old = {"timezone": zone, "work_days": days, "start_time": hhmm(start), "end_time": hhmm(end)}
                stored = {"enabled": True, "timezone": zone, "days": days, "start": hhmm(start), "end": hhmm(end)}
                rows = {
                    "campaign, nothing stored": {f"{C}{k}": v for k, v in stored.items()},
                    "campaign, same + no breaks": {f"{C}{k}": v for k, v in stored.items()} | {f"{C}schedule": {"mode": "same", "breaks": []}},
                    "number": {f"{N}{k}": v for k, v in stored.items()},
                }
                prefixes = {"campaign, nothing stored": C, "campaign, same + no breaks": C, "number": N}
                for now in instants(rng, 40, zone):
                    for label, row in rows.items():
                        prefix = prefixes[label]
                        want_open = in_calling_window(now, old)
                        self.assertEqual(call_hours.is_open(row, prefix, now), want_open, f"{label} {zone} {stored} {now}")
                        want_next = next_window_start(now, old)
                        got_next = call_hours.next_opening(row, prefix, now)
                        self.assertEqual(got_next, want_next, f"{label} {zone} {stored} {now}")
                        checked += 1
        self.assertGreater(checked, 20000)


def reference_open_minutes(zone, row_days, start, end, breaks):
    """An independent reading of a same-every-day schedule: whether local (weekday, minute) is open."""
    def is_open_at(weekday, minute):
        if weekday not in row_days or not (start <= minute < end):
            return False
        return not any(a <= minute < b for a, b in breaks)
    return is_open_at


class BruteForce(unittest.TestCase):
    """The engine against a minute-by-minute reading of the schedule."""

    def minute_scan(self, row, zone, first_utc, open_at):
        """Open-ness of each UTC minute from `first_utc`, for 8 days, according to `open_at(weekday, minute)`."""
        tz = ZoneInfo(zone)
        t = first_utc
        for i in range(8 * 1440):
            local = t.astimezone(tz)
            yield t, open_at(local.weekday(), local.hour * 60 + local.minute)
            t += timedelta(minutes=1)

    def check(self, row, zone, open_at, label, rng, samples=12):
        tz = ZoneInfo(zone)
        for _ in range(samples):
            now = datetime(2026, rng.choice([1, 3, 6, 10, 11]), rng.randrange(1, 28), tzinfo=tz).astimezone(UTC) + timedelta(minutes=rng.randrange(0, 1440))
            scan = list(self.minute_scan(row, zone, now.replace(second=0, microsecond=0), open_at))
            self.assertEqual(call_hours.is_open(row, C, now), scan[0][1], f"{label} is_open {zone} {now}")
            first_open = next((t for t, o in scan if o), None)
            got = call_hours.next_opening(row, C, now.replace(second=0, microsecond=0))
            self.assertEqual(got, first_open, f"{label} next_opening {zone} {now}")

    def test_same_every_day_with_breaks(self):
        rng = random.Random(7)
        for zone in ZONES:
            for _ in range(6):
                start, end = random_window(rng)
                breaks = random_breaks(rng, start, end)
                days = sorted(rng.sample(range(7), rng.randrange(1, 8)))
                row = {f"{C}enabled": True, f"{C}timezone": zone, f"{C}days": days, f"{C}start": hhmm(start), f"{C}end": hhmm(end),
                       f"{C}schedule": {"mode": "same", "breaks": breaks}}
                spans = [(call_hours._minutes(call_hours.parse_hhmm(b["start"])), call_hours._minutes(call_hours.parse_hhmm(b["end"]), closing=True)) for b in breaks]
                self.check(row, zone, reference_open_minutes(zone, days, start, end, spans), f"same {days} {hhmm(start)}-{hhmm(end)} {breaks}", rng)

    def test_a_custom_schedule_per_day(self):
        rng = random.Random(11)
        for zone in ZONES:
            for _ in range(5):
                per_day, windows = {}, {}
                for d in range(7):
                    if rng.random() < 0.35:
                        per_day[str(d)] = {"on": False}
                        continue
                    start, end = random_window(rng)
                    breaks = random_breaks(rng, start, end)
                    per_day[str(d)] = {"on": True, "start": hhmm(start), "end": hhmm(end), "breaks": breaks}
                    windows[d] = (start, end, [(call_hours._minutes(call_hours.parse_hhmm(b["start"])),
                                                call_hours._minutes(call_hours.parse_hhmm(b["end"]), closing=True)) for b in breaks])
                if not windows:
                    continue
                stored = call_hours.validate(C, None, {f"{C}enabled": True, f"{C}timezone": zone,
                                                       f"{C}schedule": {"mode": "per_day", "days": per_day}})

                def open_at(weekday, minute, windows=windows):
                    w = windows.get(weekday)
                    return bool(w) and w[0] <= minute < w[1] and not any(a <= minute < b for a, b in w[2])
                self.check(stored, zone, open_at, f"per_day {per_day}", rng, samples=8)


GARBAGE = [None, True, False, 0, 1, -1, 7, 1.5, "", "x", "09:00", "same", "per_day", [], [None], [1, 2], ["a"], {}, {"a": 1},
           {"start": "09:00"}, {"start": "09:00", "end": "10:00"}, {"start": 9, "end": 10}, {"on": True}, {"on": "yes", "start": "09:00", "end": "10:00"},
           {"on": True, "start": "09:00", "end": "10:00", "breaks": "x"}, {"on": True, "start": "09:00", "end": "10:00", "breaks": [None]},
           {"on": True, "start": "09:00", "end": "10:00", "breaks": [{"start": "09:10", "end": "09:20"}]},
           {"on": False}, {"on": True, "start": None, "end": None}, {"on": True, "start": ["09:00"], "end": {"a": 1}}]


def random_garbage(rng, depth=0):
    r = rng.random()
    if depth > 2 or r < 0.45:
        return rng.choice(GARBAGE)
    if r < 0.7:
        return [random_garbage(rng, depth + 1) for _ in range(rng.randrange(0, 4))]
    keys = ["mode", "breaks", "days", "on", "start", "end", "0", "1", "6", "7", "x", 3, None]
    return {rng.choice(keys): random_garbage(rng, depth + 1) for _ in range(rng.randrange(0, 5))}


class GarbageInNoCrashOut(unittest.TestCase):
    def setUp(self):
        logging.disable(logging.WARNING)      # unreadable hours are logged on purpose; thousands of lines help nobody
        self.addCleanup(logging.disable, logging.NOTSET)

    def test_a_sent_schedule_is_refused_cleanly_or_stored_valid(self):
        rng = random.Random(99)
        accepted = refused = 0
        for _ in range(6000):
            schedule = random_garbage(rng)
            if not isinstance(schedule, dict):
                schedule = {"mode": rng.choice(["same", "per_day", schedule]), "breaks": schedule, "days": schedule}
            updates = {f"{C}enabled": True, f"{C}timezone": "UTC", f"{C}schedule": schedule}
            try:
                stored = call_hours.validate(C, None, updates)
            except call_hours.HoursError as e:
                refused += 1
                self.assertTrue(str(e), "a refusal always says why")
                continue
            accepted += 1
            # what is stored validates again to itself, and can be read, described and asked about
            self.assertEqual(call_hours.validate(C, stored, {}), stored, schedule)
            call_hours.describe(stored, C)
            call_hours.state(stored, C, datetime(2026, 10, 14, 12, tzinfo=UTC), if_unreadable=False)
            nxt = call_hours.next_opening(stored, C, datetime(2026, 10, 14, 12, tzinfo=UTC))
            self.assertIsNotNone(nxt, f"valid hours always open some time: {stored}")
        self.assertGreater(accepted, 100)
        self.assertGreater(refused, 1000)

    def test_stored_garbage_is_read_without_raising(self):
        rng = random.Random(5)
        now = datetime(2026, 10, 14, 12, tzinfo=UTC)
        for _ in range(4000):
            row = {f"{C}enabled": rng.choice([True, True, False, None, "yes"]), f"{C}timezone": rng.choice(["UTC", "Asia/Karachi", "Nope/Zone", None, 5]),
                   f"{C}days": rng.choice([[0, 1, 2], [], None, "x", [9], [0, 0]]), f"{C}start": rng.choice(["09:00", "x", None, 9, "25:00"]),
                   f"{C}end": rng.choice(["17:00", "00:00", "x", None]), f"{C}schedule": random_garbage(rng)}
            for fail_open in (True, False):
                call_hours.is_open(row, C, now, if_unreadable=fail_open)
                call_hours.state(row, C, now, if_unreadable=fail_open)
            call_hours.next_opening(row, C, now)
            call_hours.describe(row, C)
            call_hours.chosen_timezone(row, C)

    def test_garbage_that_cannot_be_read_counts_as_closed_for_a_campaign_and_open_for_a_call(self):
        row = {f"{C}enabled": True, f"{C}timezone": "UTC", f"{C}days": [0, 1, 2, 3, 4, 5, 6], f"{C}start": "00:00", f"{C}end": "00:00",
               f"{C}schedule": {"mode": "per_day", "days": {"0": {"on": True, "start": "x", "end": "y"}}}}
        now = datetime(2026, 10, 12, 12, tzinfo=UTC)
        self.assertFalse(call_hours.is_open(row, C, now, if_unreadable=False))
        self.assertTrue(call_hours.is_open(row, C, now, if_unreadable=True))


if __name__ == "__main__":
    unittest.main()
