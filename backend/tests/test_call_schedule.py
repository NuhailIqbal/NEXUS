"""
Per-day schedules and breaks for outbound campaigns (services/call_hours.py, `call_hours_schedule`).

A campaign can run the same window every day, or a window of its own per day, and either way can have
breaks inside the window: during a break nothing new starts, and the campaign carries on by itself
when the break ends. Covered: validation (every rule and its message), the open/closed maths with an
explicit clock (including break edges, end-of-day, touching breaks, several zones and DST), the words
describing a schedule, the API, and real runs with a frozen clock (a run that reaches a break stops
and resumes at its end; a day that is off is skipped; a call already placed is never cut).

Run from the backend folder:  python -m unittest discover -s tests -v
"""
import asyncio
import unittest
from datetime import datetime, timezone

import byot_harness as H
from database import supabase
from services import call_hours
from services.campaign_scheduler import run_auto_resumes

from test_campaign_scheduler import ALL_DAYS, DAY, SchedulerBase, day
from test_timezones import E2E_ZONES, ZoneBase, local

C = call_hours.CAMPAIGN
UTC = timezone.utc


def brk(start, end):
    return {"start": start, "end": end}


def same(breaks=(), **kw):
    """A stored campaign row: hours on, Mon-Fri 09:00-18:00, the same every day, with `breaks`."""
    row = {"call_hours_enabled": True, "call_hours_timezone": "UTC", "call_hours_days": [0, 1, 2, 3, 4],
           "call_hours_start": "09:00", "call_hours_end": "18:00",
           "call_hours_schedule": {"mode": "same", "breaks": [dict(b) for b in breaks]}}
    row.update(kw)
    return row


def per_day(days, **kw):
    """A stored campaign row with a schedule of its own per day: {weekday: (start, end, breaks)}."""
    cfg = {str(d): {"on": False} for d in range(7)}
    for d, (start, end, breaks) in days.items():
        cfg[str(d)] = {"on": True, "start": start, "end": end, "breaks": [dict(b) for b in breaks]}
    row = {"call_hours_enabled": True, "call_hours_timezone": "UTC", "call_hours_days": sorted(days),
           "call_hours_start": min(v[0] for v in days.values()), "call_hours_end": max(v[1] for v in days.values()),
           "call_hours_schedule": {"mode": "per_day", "days": cfg}}
    row.update(kw)
    return row


def at(weekday_offset, hh, mm=0, zone="UTC"):
    """An instant on the Monday 2026-10-12 + offset days at hh:mm local time in `zone`."""
    return local(zone, *day(weekday_offset, 2026, 10, 12), hh, mm)


def is_open(row, instant):
    return call_hours.is_open(row, C, instant, if_unreadable=False)


def validate(updates, current=None):
    return call_hours.validate(C, current, {"call_hours_enabled": True, "call_hours_timezone": "UTC", **updates})


def problem(updates, current=None):
    with unittest.TestCase().assertRaises(call_hours.HoursError) as ctx:
        validate(updates, current)
    return str(ctx.exception)


# ═══════════════════════════════════════════════════════════════════════════
# Validation
# ═══════════════════════════════════════════════════════════════════════════


class ValidateBreaks(unittest.TestCase):
    def sched(self, *breaks, **kw):
        return {"call_hours_schedule": {"mode": "same", "breaks": list(breaks)}, "call_hours_start": "09:00",
                "call_hours_end": "18:00", **kw}

    def test_a_break_inside_the_window_is_stored_normalised_and_sorted(self):
        out = validate(self.sched(brk("15:00", "15:30"), brk("1:00", "14:00") | {"start": "13:00"}))
        self.assertEqual(out["call_hours_schedule"], {"mode": "same", "breaks": [brk("13:00", "14:00"), brk("15:00", "15:30")]})

    def test_no_breaks_is_fine(self):
        self.assertEqual(validate(self.sched())["call_hours_schedule"], {"mode": "same", "breaks": []})
        self.assertEqual(validate({"call_hours_schedule": {}})["call_hours_schedule"], {"mode": "same", "breaks": []})

    def test_a_break_must_end_after_it_starts(self):
        for b in (brk("14:00", "13:00"), brk("13:00", "13:00")):
            self.assertEqual(problem(self.sched(b)), "A break must end after it starts.", b)

    def test_a_break_must_fall_inside_the_running_hours(self):
        for b in (brk("08:00", "10:00"), brk("17:00", "19:00"), brk("08:00", "08:30"), brk("18:00", "19:00")):
            self.assertEqual(problem(self.sched(b)), "A break must fall inside the running hours (9:00 AM–6:00 PM).", b)

    def test_a_break_may_touch_the_edges_of_the_window(self):
        self.assertEqual(len(validate(self.sched(brk("09:00", "10:00")))["call_hours_schedule"]["breaks"]), 1)
        self.assertEqual(len(validate(self.sched(brk("17:00", "18:00")))["call_hours_schedule"]["breaks"]), 1)

    def test_breaks_must_not_overlap(self):
        self.assertEqual(problem(self.sched(brk("12:00", "14:00"), brk("13:00", "15:00"))), "Breaks can't overlap.")
        self.assertEqual(problem(self.sched(brk("12:00", "15:00"), brk("13:00", "14:00"))), "Breaks can't overlap.")
        self.assertEqual(problem(self.sched(brk("12:00", "13:00"), brk("12:00", "13:00"))), "Breaks can't overlap.")

    def test_breaks_may_touch_each_other(self):
        out = validate(self.sched(brk("12:00", "13:00"), brk("13:00", "14:00")))
        self.assertEqual(len(out["call_hours_schedule"]["breaks"]), 2)

    def test_breaks_cannot_leave_no_time_to_run(self):
        self.assertEqual(problem(self.sched(brk("09:00", "18:00"))), "The breaks leave no time to run.")
        self.assertEqual(problem(self.sched(brk("09:00", "12:00"), brk("12:00", "18:00"))), "The breaks leave no time to run.")

    def test_a_break_ending_at_midnight_means_the_end_of_the_day(self):
        out = validate(self.sched(brk("22:00", "00:00"), call_hours_end="00:00"))
        self.assertEqual(out["call_hours_schedule"]["breaks"], [brk("22:00", "00:00")])
        # ... but a midnight end cannot be inside a window ending at 18:00
        self.assertIn("inside the running hours", problem(self.sched(brk("22:00", "00:00"))))

    def test_bad_break_values(self):
        for bad in ("lunch", 5, [1], {"start": "13:00"}, {"start": "x", "end": "14:00"}, {"start": None, "end": "14:00"}):
            self.assertIn("A break needs a start and an end time", problem(self.sched(bad)), bad)
        self.assertEqual(problem({"call_hours_schedule": {"mode": "same", "breaks": "lunch"}}), "Breaks must be a list.")

    def test_at_most_ten_breaks(self):
        ten = [brk(f"{9 + i:02d}:00", f"{9 + i:02d}:10") for i in range(9)] + [brk("17:30", "17:40")]
        self.assertEqual(len(validate(self.sched(*ten))["call_hours_schedule"]["breaks"]), 10)
        self.assertIn("at most 10 breaks", problem(self.sched(*ten, brk("17:45", "17:50"))))

    def test_the_end_still_has_to_follow_the_start(self):
        self.assertEqual(problem(self.sched(call_hours_start="18:00", call_hours_end="09:00")), "End time must be after start time.")

    def test_breaks_are_checked_against_the_window_as_it_will_be(self):
        # the stored window is 09:00-18:00; the request narrows it to 09:00-12:00 while a break stays at 13:00
        current = same([brk("13:00", "14:00")])
        self.assertIn("inside the running hours", problem({"call_hours_end": "12:00"}, current))

    def test_unknown_mode(self):
        self.assertEqual(problem({"call_hours_schedule": {"mode": "weekly"}}),
                         "Choose the same schedule every day or a custom schedule per day.")


class ValidatePerDay(unittest.TestCase):
    def days(self, **over):
        base = {"0": {"on": True, "start": "09:00", "end": "18:00", "breaks": [brk("13:00", "14:00")]},
                "5": {"on": True, "start": "10:00", "end": "14:00"}}
        base.update(over)
        return {"call_hours_schedule": {"mode": "per_day", "days": base}}

    def test_it_stores_all_seven_days_and_derives_the_summary_fields(self):
        out = validate(self.days())
        sched = out["call_hours_schedule"]
        self.assertEqual(sched["mode"], "per_day")
        self.assertEqual({d: sched["days"][d]["on"] for d in sched["days"]},
                         {"0": True, "1": False, "2": False, "3": False, "4": False, "5": True, "6": False})
        self.assertEqual(sched["days"]["5"]["breaks"], [], "a missing breaks list becomes empty")
        self.assertEqual(sched["days"]["1"], {"on": False}, "an off day keeps nothing")
        self.assertEqual((out["call_hours_days"], out["call_hours_start"], out["call_hours_end"]), ([0, 5], "09:00", "18:00"),
                         "days that are on, earliest start, latest end")

    def test_the_summary_fields_sent_with_it_are_ignored(self):
        out = validate({**self.days(), "call_hours_days": [1, 2], "call_hours_start": "23:00", "call_hours_end": "23:30"})
        self.assertEqual((out["call_hours_days"], out["call_hours_start"], out["call_hours_end"]), ([0, 5], "09:00", "18:00"))

    def test_a_latest_end_of_midnight_is_kept_as_midnight(self):
        out = validate(self.days(**{"6": {"on": True, "start": "20:00", "end": "00:00"}}))
        self.assertEqual(out["call_hours_end"], "00:00")

    def test_each_problem_names_its_day(self):
        cases = {
            "end before start": ({"on": True, "start": "10:00", "end": "09:00"}, "Wednesday: End time must be after start time."),
            "bad time": ({"on": True, "start": "soon", "end": "09:00"}, "Wednesday: Start time must look like 09:30."),
            "break outside": ({"on": True, "start": "09:00", "end": "12:00", "breaks": [brk("12:00", "13:00")]},
                              "Wednesday: A break must fall inside the running hours (9:00 AM–12:00 PM)."),
            "break backwards": ({"on": True, "start": "09:00", "end": "12:00", "breaks": [brk("11:00", "10:00")]},
                                "Wednesday: A break must end after it starts."),
            "overlap": ({"on": True, "start": "09:00", "end": "17:00", "breaks": [brk("12:00", "14:00"), brk("13:00", "15:00")]},
                        "Wednesday: Breaks can't overlap."),
            "no time left": ({"on": True, "start": "09:00", "end": "10:00", "breaks": [brk("09:00", "10:00")]},
                             "Wednesday: The breaks leave no time to run."),
        }
        for label, (cfg, message) in cases.items():
            self.assertEqual(problem(self.days(**{"2": cfg})), message, label)

    def test_at_least_one_day_must_be_on(self):
        self.assertEqual(problem({"call_hours_schedule": {"mode": "per_day", "days": {}}}), "Pick at least one day.")
        off = {str(d): {"on": False} for d in range(7)}
        self.assertEqual(problem({"call_hours_schedule": {"mode": "per_day", "days": off}}), "Pick at least one day.")

    def test_an_unclear_on_value_is_refused_not_guessed(self):
        for on in ("yes", 1, None):
            self.assertEqual(problem(self.days(**{"2": {"on": on, "start": "09:00", "end": "10:00"}})),
                             "Wednesday: switch the day on or off.", on)
        self.assertEqual(problem(self.days(**{"2": "open"})), "Wednesday: switch the day on or off.")

    def test_a_day_that_does_not_exist(self):
        self.assertEqual(problem(self.days(**{"7": {"on": True, "start": "09:00", "end": "10:00"}})),
                         "The schedule has a day that does not exist.")

    def test_days_must_be_an_object(self):
        self.assertEqual(problem({"call_hours_schedule": {"mode": "per_day", "days": [1, 2]}}), "Set the hours for each day.")
        self.assertEqual(problem({"call_hours_schedule": {"mode": "per_day"}}), "Set the hours for each day.")

    def test_integer_day_keys_are_accepted(self):
        out = validate({"call_hours_schedule": {"mode": "per_day", "days": {2: {"on": True, "start": "09:00", "end": "10:00"}}}})
        self.assertEqual(out["call_hours_days"], [2])

    def test_a_per_day_schedule_still_needs_a_time_zone_once_on(self):
        with self.assertRaises(call_hours.HoursError) as ctx:
            call_hours.validate(C, None, {"call_hours_enabled": True, **self.days()})
        self.assertEqual(str(ctx.exception), "Select a time zone.")

    def test_switching_back_to_the_same_schedule_drops_the_per_day_one(self):
        stored = validate(self.days())
        out = call_hours.validate(C, stored, {"call_hours_schedule": {"mode": "same", "breaks": [brk("12:00", "13:00")]},
                                              "call_hours_days": [0, 1, 2], "call_hours_start": "08:00", "call_hours_end": "16:00"})
        self.assertEqual(out["call_hours_schedule"], {"mode": "same", "breaks": [brk("12:00", "13:00")]})
        self.assertEqual((out["call_hours_days"], out["call_hours_start"]), ([0, 1, 2], "08:00"))


class NumbersDoNotGetSchedules(unittest.TestCase):
    def test_phone_numbers_keep_their_five_fields(self):
        out = call_hours.validate(call_hours.NUMBER, None, {"answer_hours_schedule": {"mode": "per_day"}})
        self.assertEqual(set(out), set(call_hours.fields(call_hours.NUMBER)))
        self.assertNotIn("answer_hours_schedule", out)
        self.assertFalse(call_hours.touched(call_hours.NUMBER, {"answer_hours_schedule": {}}))
        self.assertTrue(call_hours.touched(C, {"call_hours_schedule": {}}))


# ═══════════════════════════════════════════════════════════════════════════
# Open or closed, and when it opens next
# ═══════════════════════════════════════════════════════════════════════════


class BreakTiming(unittest.TestCase):
    row = same([brk("13:00", "14:00")])

    def test_open_before_the_break_closed_during_open_after(self):
        for hh, mm, want in ((9, 0, True), (12, 59, True), (13, 0, False), (13, 30, False), (13, 59, False),
                             (14, 0, True), (17, 59, True), (18, 0, False), (8, 59, False)):
            self.assertEqual(is_open(self.row, at(0, hh, mm)), want, f"{hh}:{mm:02d}")

    def test_the_break_opens_again_when_it_ends_not_the_next_day(self):
        self.assertEqual(call_hours.next_opening(self.row, C, at(0, 13, 20)), at(0, 14, 0))
        self.assertEqual(call_hours.next_opening(self.row, C, at(0, 13, 0)), at(0, 14, 0))
        self.assertEqual(call_hours.next_opening(self.row, C, at(0, 13, 59)), at(0, 14, 0))

    def test_open_means_now(self):
        self.assertEqual(call_hours.next_opening(self.row, C, at(0, 11)), at(0, 11))

    def test_after_closing_it_is_the_next_morning(self):
        self.assertEqual(call_hours.next_opening(self.row, C, at(0, 18, 1)), at(1, 9, 0))
        self.assertEqual(call_hours.next_opening(self.row, C, at(4, 18, 1)), at(7, 9, 0), "Friday evening -> Monday")

    def test_the_break_applies_on_every_working_day_and_not_on_days_off(self):
        for offset in range(5):
            self.assertFalse(is_open(self.row, at(offset, 13, 30)))
            self.assertTrue(is_open(self.row, at(offset, 14, 30)))
        for offset in (5, 6):
            self.assertFalse(is_open(self.row, at(offset, 14, 30)), "the weekend is closed all day")

    def test_several_breaks(self):
        row = same([brk("10:30", "10:45"), brk("13:00", "14:00"), brk("16:00", "16:15")])
        want = {(9, 0): True, (10, 29): True, (10, 30): False, (10, 44): False, (10, 45): True, (12, 59): True,
                (13, 0): False, (14, 0): True, (15, 59): True, (16, 0): False, (16, 14): False, (16, 15): True, (17, 59): True}
        for (hh, mm), expected in want.items():
            self.assertEqual(is_open(row, at(0, hh, mm)), expected, f"{hh}:{mm:02d}")
        self.assertEqual(call_hours.next_opening(row, C, at(0, 10, 40)), at(0, 10, 45))
        self.assertEqual(call_hours.next_opening(row, C, at(0, 16, 5)), at(0, 16, 15))

    def test_touching_breaks_are_one_long_break(self):
        row = same([brk("12:00", "13:00"), brk("13:00", "14:00")])
        self.assertFalse(is_open(row, at(0, 13, 0)))
        self.assertEqual(call_hours.next_opening(row, C, at(0, 12, 30)), at(0, 14, 0), "not at 13:00, where the next break starts")

    def test_a_break_at_the_very_start_moves_the_opening(self):
        row = same([brk("09:00", "10:00")])
        self.assertFalse(is_open(row, at(0, 9, 30)))
        self.assertEqual(call_hours.next_opening(row, C, at(0, 8, 0)), at(0, 10, 0))
        self.assertEqual(call_hours.next_opening(row, C, at(0, 9, 30)), at(0, 10, 0))

    def test_a_break_at_the_very_end_closes_early(self):
        row = same([brk("17:00", "18:00")])
        self.assertTrue(is_open(row, at(0, 16, 59)))
        self.assertFalse(is_open(row, at(0, 17, 0)))
        self.assertEqual(call_hours.next_opening(row, C, at(0, 17, 30)), at(1, 9, 0), "no opening after it: the next day")

    def test_a_break_up_to_midnight(self):
        row = same([brk("22:00", "00:00")], call_hours_start="08:00", call_hours_end="00:00", call_hours_days=[0])
        self.assertTrue(is_open(row, at(0, 21, 59)))
        self.assertFalse(is_open(row, at(0, 22, 0)))
        self.assertFalse(is_open(row, at(0, 23, 59)))
        self.assertEqual(call_hours.next_opening(row, C, at(0, 22, 30)), at(7, 8, 0), "the following Monday")

    def test_hours_off_ignore_breaks(self):
        row = same([brk("00:00", "23:00")], call_hours_enabled=False)
        self.assertTrue(is_open(row, at(0, 13, 30)))
        self.assertIsNone(call_hours.next_opening(row, C, at(0, 13, 30)))

    def test_seconds_do_not_matter_only_the_minute(self):
        base = at(0, 14, 0)
        self.assertTrue(is_open(self.row, base.replace(second=0)))
        self.assertFalse(is_open(self.row, at(0, 13, 59).replace(second=59)))

    def test_state_shows_the_end_of_the_break_as_the_next_opening(self):
        st = call_hours.state(self.row, C, at(0, 13, 10), if_unreadable=False)
        self.assertEqual((st["enabled"], st["open"], st["next_open_at"]), (True, False, "2026-10-12T14:00:00Z"))
        st = call_hours.state(self.row, C, at(0, 15), if_unreadable=False)
        self.assertEqual((st["open"], st["next_open_at"]), (True, None))

    def test_unreadable_stored_breaks_fail_closed_for_campaigns(self):
        row = same([{"start": "soon", "end": "later"}])
        self.assertFalse(is_open(row, at(0, 11)))
        self.assertIsNone(call_hours.next_opening(row, C, at(0, 11)))
        row = same([], call_hours_schedule={"mode": "per_day", "days": {"0": {"on": True, "start": "x", "end": "y"}}})
        self.assertFalse(is_open(row, at(0, 11)))


class PerDayTiming(unittest.TestCase):
    # Mon 9-18 with a lunch break, Wed 12-20, Sat 10-14, the rest of the week off
    row = per_day({0: ("09:00", "18:00", [brk("13:00", "14:00")]), 2: ("12:00", "20:00", []), 5: ("10:00", "14:00", [])})

    def test_every_day_follows_its_own_window(self):
        want = {
            (0, 8, 59): False, (0, 9, 0): True, (0, 13, 30): False, (0, 14, 0): True, (0, 18, 0): False,
            (1, 12, 0): False, (1, 15, 0): False,                                   # Tuesday: off
            (2, 11, 59): False, (2, 12, 0): True, (2, 19, 59): True, (2, 20, 0): False,
            (3, 10, 0): False, (4, 10, 0): False,                                   # Thursday, Friday: off
            (5, 9, 59): False, (5, 10, 0): True, (5, 13, 59): True, (5, 14, 0): False,
            (6, 12, 0): False,                                                      # Sunday: off
        }
        for (offset, hh, mm), expected in want.items():
            self.assertEqual(is_open(self.row, at(offset, hh, mm)), expected, f"day {offset} {hh}:{mm:02d}")

    def test_the_next_opening_skips_the_days_that_are_off(self):
        self.assertEqual(call_hours.next_opening(self.row, C, at(0, 18, 30)), at(2, 12, 0), "Monday evening -> Wednesday noon")
        self.assertEqual(call_hours.next_opening(self.row, C, at(2, 20, 30)), at(5, 10, 0), "Wednesday evening -> Saturday")
        self.assertEqual(call_hours.next_opening(self.row, C, at(5, 14, 30)), at(7, 9, 0), "Saturday -> the next Monday 9:00")
        self.assertEqual(call_hours.next_opening(self.row, C, at(0, 13, 10)), at(0, 14, 0), "Monday's break ends at 14:00")
        self.assertEqual(call_hours.next_opening(self.row, C, at(0, 7, 0)), at(0, 9, 0))

    def test_a_single_day_a_week(self):
        row = per_day({3: ("09:00", "10:00", [])})
        self.assertEqual(call_hours.next_opening(row, C, at(3, 10, 0)), at(10, 9, 0), "a week later")
        self.assertEqual(call_hours.next_opening(row, C, at(4, 9, 30)), at(10, 9, 0))

    def test_a_day_stored_as_off_stays_off_even_with_times_left_in_it(self):
        cfg = {str(d): {"on": False, "start": "00:00", "end": "00:00"} for d in range(7)}
        cfg["1"] = {"on": True, "start": "09:00", "end": "10:00", "breaks": []}
        row = per_day({1: ("09:00", "10:00", [])}, call_hours_schedule={"mode": "per_day", "days": cfg})
        self.assertFalse(is_open(row, at(0, 9, 30)))
        self.assertTrue(is_open(row, at(1, 9, 30)))

    def test_describe_groups_the_days_that_share_hours(self):
        row = per_day({0: ("09:00", "18:00", [brk("13:00", "14:00")]), 1: ("09:00", "18:00", [brk("13:00", "14:00")]),
                       2: ("09:00", "18:00", [brk("13:00", "14:00")]), 5: ("10:00", "14:00", [])}, call_hours_timezone="Asia/Karachi")
        self.assertEqual(call_hours.describe(row, C),
                         "Mon–Wed 9:00 AM–6:00 PM (break 1:00 PM–2:00 PM); Sat 10:00 AM–2:00 PM (Asia/Karachi)")

    def test_describe_for_the_same_schedule(self):
        self.assertEqual(call_hours.describe(same([brk("13:00", "14:00")], call_hours_timezone="Asia/Karachi"), C),
                         "Mon–Fri, 9:00 AM–6:00 PM, break 1:00 PM–2:00 PM (Asia/Karachi)")
        self.assertEqual(call_hours.describe(same([brk("12:00", "12:30"), brk("15:00", "15:15")]), C),
                         "Mon–Fri, 9:00 AM–6:00 PM, break 12:00 PM–12:30 PM and 3:00 PM–3:15 PM (UTC)")
        self.assertEqual(call_hours.describe(same(), C), "Mon–Fri, 9:00 AM–6:00 PM (UTC)", "no breaks: exactly as before")


class EveryZone(unittest.TestCase):
    """The same schedule means the same wall-clock times in every time zone the user can pick."""

    def test_breaks_and_days_follow_the_chosen_zone(self):
        for zone in E2E_ZONES:
            with self.subTest(zone=zone):
                row = per_day({2: ("09:00", "18:00", [brk("13:00", "14:00")]), 3: ("10:00", "12:00", [])}, call_hours_timezone=zone)
                y, m, d = DAY       # a Wednesday
                for (offset, hh, mm), expected in {
                    (0, 8, 59): False, (0, 9, 0): True, (0, 12, 59): True, (0, 13, 0): False, (0, 13, 59): False,
                    (0, 14, 0): True, (0, 17, 59): True, (0, 18, 0): False, (1, 9, 59): False, (1, 10, 0): True,
                    (1, 11, 59): True, (1, 12, 0): False, (2, 10, 30): False, (-1, 10, 30): False,
                }.items():
                    instant = local(zone, *day(offset), hh, mm)
                    self.assertEqual(is_open(row, instant), expected, f"{zone} day {offset} {hh}:{mm:02d}")
                self.assertEqual(call_hours.next_opening(row, C, local(zone, y, m, d, 13, 30)), local(zone, y, m, d, 14, 0))
                self.assertEqual(call_hours.next_opening(row, C, local(zone, y, m, d, 18, 30)), local(zone, *day(1), 10, 0))

    def test_a_break_on_the_day_clocks_change(self):
        # New York: clocks went forward at 02:00 on Sunday 2026-03-08 and back at 02:00 on Sunday 2026-11-01
        zone = "America/New_York"
        row = same([brk("13:00", "14:00")], call_hours_timezone=zone, call_hours_days=ALL_DAYS)
        for y, m, d in ((2026, 3, 8), (2026, 11, 1), (2026, 3, 9)):
            for hh, mm, want in ((12, 59, True), (13, 0, False), (13, 59, False), (14, 0, True)):
                self.assertEqual(is_open(row, local(zone, y, m, d, hh, mm)), want, f"{y}-{m}-{d} {hh}:{mm:02d}")
            self.assertEqual(call_hours.next_opening(row, C, local(zone, y, m, d, 13, 30)), local(zone, y, m, d, 14, 0))


# ═══════════════════════════════════════════════════════════════════════════
# The API
# ═══════════════════════════════════════════════════════════════════════════


class ApiTests(ZoneBase):
    def create(self, **extra):
        return self.api("post", "/telephony/campaigns", json={
            "name": "S", "agent_id": self.agent["id"], "list_id": self.list["id"], "phone_number_id": self.out_number["id"],
            "dnc_screening_enabled": False, **H.LEGACY_DIAL, "call_hours_enabled": True, "call_hours_timezone": "Asia/Karachi", **extra})

    def test_a_new_campaign_without_a_schedule_runs_the_same_every_day_with_no_breaks(self):
        r = self.create()
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["data"]["call_hours_schedule"], {"mode": "same", "breaks": []})

    def test_a_campaign_is_created_with_breaks(self):
        r = self.create(call_hours_start="09:00", call_hours_end="18:00",
                        call_hours_schedule={"mode": "same", "breaks": [brk("13:00", "14:00")]})
        self.assertEqual(r.status_code, 200, r.text)
        data = r.json()["data"]
        self.assertEqual(data["call_hours_schedule"]["breaks"], [brk("13:00", "14:00")])
        fetched = self.api("get", f"/telephony/campaigns/{data['id']}").json()["data"]
        self.assertEqual(fetched["call_hours_schedule"], data["call_hours_schedule"])
        self.assertEqual(fetched["call_hours_state"]["summary"], "Mon–Fri, 9:00 AM–6:00 PM, break 1:00 PM–2:00 PM (Asia/Karachi)")

    def test_a_campaign_is_created_with_a_per_day_schedule(self):
        days = {"0": {"on": True, "start": "09:00", "end": "18:00", "breaks": [brk("13:00", "14:00")]},
                "5": {"on": True, "start": "10:00", "end": "14:00", "breaks": []}}
        r = self.create(call_hours_schedule={"mode": "per_day", "days": days})
        self.assertEqual(r.status_code, 200, r.text)
        data = r.json()["data"]
        self.assertEqual((data["call_hours_days"], data["call_hours_start"], data["call_hours_end"]), ([0, 5], "09:00", "18:00"))
        self.assertEqual(data["call_hours_schedule"]["days"]["5"], {"on": True, "start": "10:00", "end": "14:00", "breaks": []})
        self.assertEqual(data["call_hours_schedule"]["days"]["3"], {"on": False})

    def test_bad_schedules_are_refused_with_the_reason_and_nothing_is_saved(self):
        before = len(self.api("get", "/telephony/campaigns").json()["data"])
        for schedule, message in (
            ({"mode": "same", "breaks": [brk("08:00", "10:00")]}, "A break must fall inside the running hours (9:00 AM–5:00 PM)."),
            ({"mode": "same", "breaks": [brk("12:00", "14:00"), brk("13:00", "15:00")]}, "Breaks can't overlap."),
            ({"mode": "per_day", "days": {"2": {"on": True, "start": "10:00", "end": "09:00"}}}, "Wednesday: End time must be after start time."),
            ({"mode": "per_day", "days": {}}, "Pick at least one day."),
            ({"mode": "sometimes"}, "Choose the same schedule every day or a custom schedule per day."),
        ):
            r = self.create(call_hours_schedule=schedule)
            self.assertEqual(r.status_code, 400, r.text)
            self.assertEqual(r.json()["detail"], message)
        self.assertEqual(len(self.api("get", "/telephony/campaigns").json()["data"]), before)

    def test_updating_the_schedule_and_going_back(self):
        c = self.create(call_hours_schedule={"mode": "same", "breaks": [brk("13:00", "14:00")]}).json()["data"]
        patch = lambda body: self.api("patch", f"/telephony/campaigns/{c['id']}", json=body)  # noqa: E731

        r = patch({"call_hours_schedule": {"mode": "per_day", "days": {"1": {"on": True, "start": "08:00", "end": "12:00"}}}})
        self.assertEqual(r.status_code, 200, r.text)
        row = r.json()["data"]
        self.assertEqual((row["call_hours_days"], row["call_hours_start"], row["call_hours_end"]), ([1], "08:00", "12:00"))

        r = patch({"call_hours_schedule": {"mode": "same", "breaks": []}, "call_hours_days": [0, 1, 2, 3, 4],
                   "call_hours_start": "09:00", "call_hours_end": "17:00"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["data"]["call_hours_schedule"], {"mode": "same", "breaks": []})

        r = patch({"call_hours_schedule": {"mode": "same", "breaks": [brk("07:00", "08:00")]}})
        self.assertEqual(r.status_code, 400)
        stored = self.api("get", f"/telephony/campaigns/{c['id']}").json()["data"]
        self.assertEqual(stored["call_hours_schedule"], {"mode": "same", "breaks": []}, "a refused update changed nothing")

    def test_saving_other_settings_keeps_the_schedule(self):
        c = self.create(call_hours_schedule={"mode": "same", "breaks": [brk("13:00", "14:00")]}).json()["data"]
        r = self.api("patch", f"/telephony/campaigns/{c['id']}", json={"name": "Renamed"})
        self.assertEqual(r.json()["data"]["call_hours_schedule"]["breaks"], [brk("13:00", "14:00")])

    def test_the_state_during_a_break_says_when_it_opens(self):
        c = self.create(call_hours_start="09:00", call_hours_end="18:00", call_hours_days=ALL_DAYS,
                        call_hours_schedule={"mode": "same", "breaks": [brk("13:00", "14:00")]}).json()["data"]
        zone = "Asia/Karachi"
        self.at(local(zone, *DAY, 13, 30))
        st = self.campaign_state(c["id"])
        self.assertEqual((st["open"], st["next_open_at"]), (False, local(zone, *DAY, 14, 0).strftime("%Y-%m-%dT%H:%M:%SZ")))
        self.at(local(zone, *DAY, 14, 1))
        self.assertTrue(self.campaign_state(c["id"])["open"])

    def test_starting_during_a_break_is_refused_with_when_it_ends(self):
        c = self.create(call_hours_start="09:00", call_hours_end="18:00", call_hours_days=ALL_DAYS,
                        call_hours_schedule={"mode": "same", "breaks": [brk("13:00", "14:00")]}).json()["data"]
        self.at(local("Asia/Karachi", *DAY, 13, 30))
        r = self.api("post", f"/telephony/campaigns/{c['id']}/start")
        self.assertEqual(r.status_code, 400, r.text)
        self.assertIn("closed right now", r.json()["detail"])
        self.assertIn("break 1:00 PM–2:00 PM", r.json()["detail"])
        self.assertIn("2:00 PM", r.json()["detail"].split("opens again")[1])
        self.create_call.assert_not_awaited()

    def test_a_phone_number_ignores_a_schedule_sent_to_it(self):
        number = self.api("get", "/telephony/phone-numbers").json()["data"][0]
        r = self.api("patch", f"/telephony/phone-numbers/{number['id']}", json={"answer_hours_schedule": {"mode": "per_day"}})
        self.assertNotIn(r.status_code, (500,), r.text)
        self.assertNotIn("answer_hours_schedule", supabase.table("phone_numbers").select("*").eq("id", number["id"]).execute().data[0])


# ═══════════════════════════════════════════════════════════════════════════
# Real runs
# ═══════════════════════════════════════════════════════════════════════════


class RunsWithBreaks(SchedulerBase):
    """Ten contacts, two per batch. The clock is frozen and jumps as calls are placed."""

    ZONE = "Asia/Karachi"

    def lunch_campaign(self, **extra):
        return self.make_campaign(self.ZONE, call_hours_days=ALL_DAYS, call_hours_start="09:00", call_hours_end="18:00",
                                  call_hours_schedule={"mode": "same", "breaks": [brk("13:00", "14:00")]}, **extra)

    def test_a_run_that_reaches_the_break_stops_and_resumes_when_the_break_ends(self):
        c = self.lunch_campaign()
        z = self.ZONE
        self.at(local(z, *DAY, 12, 0))
        self.closing_after(4, local(z, *DAY, 13, 0))            # the break begins after four calls
        r = self.start(c["id"])
        data = r.json()["data"]
        self.assertEqual((r.status_code, data["dialed"], data["remaining"], data["stopped_by_hours"]), (200, 4, 6, True), r.text)
        self.assertEqual(data["next_open_at"], local(z, *DAY, 14, 0).strftime("%Y-%m-%dT%H:%M:%SZ"), "it says the break ends at 14:00")
        row = self.row(c["id"])
        self.assertEqual(row["status"], "Paused")
        self.assertIsNotNone(row["stopped_by_hours_at"])
        self.assertEqual(self.dialed(), self.expected_order[:4])

        # during the break nothing starts, however often the sweep looks
        for minute in (1, 30, 59):
            self.assertEqual(self.sweep(local(z, *DAY, 13, minute)), {"resumed": 0, "waiting": 1, "refused": 0}, f"13:{minute:02d}")
        self.assertEqual(self.dialed(), self.expected_order[:4])
        st = self.api("get", f"/telephony/campaigns/{c['id']}").json()["data"]
        self.assertTrue(st["auto_resume"]["pending"])
        self.assertEqual(st["auto_resume"]["next_at"], local(z, *DAY, 14, 0).strftime("%Y-%m-%dT%H:%M:%SZ"))

        # the break ends: it carries on by itself with the fifth contact, nobody twice
        self.closing_after(None, None)
        self.assertEqual(self.sweep(local(z, *DAY, 14, 0)), {"resumed": 1, "waiting": 0, "refused": 0})
        self.assertEqual(self.dialed(), self.expected_order)
        row = self.row(c["id"])
        self.assertEqual((row["status"], row["stopped_by_hours_at"], row["dial_cursor"]), ("Active", None, None), "finished: nothing left to continue")

    def test_two_breaks_in_one_day_pause_the_run_twice(self):
        c = self.make_campaign(self.ZONE, call_hours_days=ALL_DAYS, call_hours_start="09:00", call_hours_end="18:00",
                               call_hours_schedule={"mode": "same", "breaks": [brk("10:00", "10:30"), brk("13:00", "14:00")]})
        z = self.ZONE
        self.at(local(z, *DAY, 9, 0))
        self.closing_after(2, local(z, *DAY, 10, 0))
        self.assertTrue(self.start(c["id"]).json()["data"]["stopped_by_hours"])
        self.assertEqual(len(self.dialed()), 2)
        self.assertEqual(self.sweep(local(z, *DAY, 10, 15)), {"resumed": 0, "waiting": 1, "refused": 0})
        self.closing_after(4, local(z, *DAY, 13, 0))
        self.assertEqual(self.sweep(local(z, *DAY, 10, 30))["resumed"], 1)
        self.assertEqual(len(self.dialed()), 6)
        self.assertEqual(self.sweep(local(z, *DAY, 13, 30)), {"resumed": 0, "waiting": 1, "refused": 0})
        self.closing_after(None, None)
        self.assertEqual(self.sweep(local(z, *DAY, 14, 0))["resumed"], 1)
        self.assertEqual(self.dialed(), self.expected_order)

    def test_a_break_and_the_end_of_the_day_in_one_run(self):
        c = self.lunch_campaign()
        z = self.ZONE
        self.at(local(z, *DAY, 12, 0))
        self.closing_after(2, local(z, *DAY, 13, 0))
        self.start(c["id"])                                                  # 2 calls, then the break
        self.closing_after(2, local(z, *DAY, 18, 0))
        self.assertEqual(self.sweep(local(z, *DAY, 14, 0))["resumed"], 1)    # 2 more, then the day ends
        self.assertEqual(len(self.dialed()), 4)
        self.assertEqual(self.sweep(local(z, *DAY, 18, 30)), {"resumed": 0, "waiting": 1, "refused": 0})
        self.closing_after(None, None)
        self.assertEqual(self.sweep(local(z, *day(1), 8, 59)), {"resumed": 0, "waiting": 1, "refused": 0})
        self.assertEqual(self.sweep(local(z, *day(1), 9, 0))["resumed"], 1)  # next morning, the rest
        self.assertEqual(self.dialed(), self.expected_order)

    def test_a_manual_start_after_the_break_carries_on_from_where_it_stopped(self):
        c = self.lunch_campaign()
        z = self.ZONE
        self.at(local(z, *DAY, 12, 0))
        self.closing_after(4, local(z, *DAY, 13, 0))
        self.start(c["id"])
        self.closing_after(None, None)
        self.at(local(z, *DAY, 14, 5))
        r = self.start(c["id"])
        self.assertEqual((r.status_code, r.json()["data"]["dialed"]), (200, 6), r.text)
        self.assertEqual(self.dialed(), self.expected_order)

    def test_a_person_pausing_during_the_break_stops_the_automatic_continuing(self):
        c = self.lunch_campaign()
        z = self.ZONE
        self.at(local(z, *DAY, 12, 0))
        self.closing_after(4, local(z, *DAY, 13, 0))
        self.start(c["id"])
        self.assertEqual(self.api("post", f"/telephony/campaigns/{c['id']}/pause").status_code, 200)
        self.closing_after(None, None)
        self.assertEqual(self.sweep(local(z, *DAY, 14, 30)), {"resumed": 0, "waiting": 0, "refused": 0})
        self.assertEqual(len(self.dialed()), 4)

    def test_editing_the_break_while_waiting_moves_the_resume_time(self):
        c = self.lunch_campaign()
        z = self.ZONE
        self.at(local(z, *DAY, 12, 0))
        self.closing_after(4, local(z, *DAY, 13, 0))
        self.start(c["id"])
        # the break is shortened to 13:00-13:30 while the campaign waits
        r = self.api("patch", f"/telephony/campaigns/{c['id']}", json={
            "call_hours_schedule": {"mode": "same", "breaks": [brk("13:00", "13:30")]}})
        self.assertEqual(r.status_code, 200, r.text)
        self.closing_after(None, None)
        self.assertEqual(self.sweep(local(z, *DAY, 13, 29)), {"resumed": 0, "waiting": 1, "refused": 0})
        self.assertEqual(self.sweep(local(z, *DAY, 13, 30))["resumed"], 1)
        self.assertEqual(self.dialed(), self.expected_order)

    def test_a_break_added_while_it_runs_stops_the_run_at_the_next_batch(self):
        c = self.make_campaign(self.ZONE, call_hours_days=ALL_DAYS, call_hours_start="09:00", call_hours_end="18:00")
        z = self.ZONE
        self.at(local(z, *DAY, 13, 30))
        placed = {"n": 0}
        inner = self.create_call.side_effect

        async def add_break_after_two(payload):
            placed["n"] += 1
            if placed["n"] == 2:
                supabase.table("outbound_campaigns").update({
                    "call_hours_schedule": {"mode": "same", "breaks": [brk("13:00", "14:00")]}}).eq("id", c["id"]).execute()
            return await inner(payload)
        self.create_call.side_effect = add_break_after_two
        r = self.start(c["id"])
        data = r.json()["data"]
        self.assertEqual((r.status_code, data["dialed"], data["stopped_by_hours"]), (200, 2, True), r.text)
        self.assertEqual(len(self.dialed()), 2, "the batch already under way finished, no new one started")

    def test_the_break_is_obeyed_on_the_very_next_call_and_the_call_already_placed_is_not_cut(self):
        c = self.lunch_campaign()
        z = self.ZONE
        self.at(local(z, *DAY, 12, 59))
        self.closing_after(1, local(z, *DAY, 13, 0))      # the break begins while the first group is still placing calls
        r = self.start(c["id"])
        data = r.json()["data"]
        # the hours are checked at every call (not once per group of calls): the second call of the group is not placed
        self.assertEqual((data["dialed"], data["remaining"]), (1, 9), "the call placed stays, the very next one is held back")
        self.assertEqual(len(self.dialed()), 1)
        open_calls = supabase.table("campaign_attempts").select("id").eq("campaign_id", c["id"]).is_("ended_at", "null").execute().data
        self.assertEqual(len(open_calls), 1, "the call that was placed is not cut")

    def test_it_never_dials_at_all_inside_a_break(self):
        c = self.lunch_campaign()
        self.at(local(self.ZONE, *DAY, 13, 30))
        r = self.start(c["id"])
        self.assertEqual(r.status_code, 400)
        self.create_call.assert_not_awaited()
        self.assertEqual(self.sweep(local(self.ZONE, *DAY, 13, 45)), {"resumed": 0, "waiting": 0, "refused": 0})
        self.create_call.assert_not_awaited()

    def test_every_zone_resumes_at_the_end_of_its_own_break(self):
        for zone in E2E_ZONES:
            with self.subTest(zone=zone):
                self.create_call.reset_mock()
                H.sql("UPDATE public.outbound_campaigns SET stopped_by_hours_at = NULL")
                c = self.make_campaign(zone, call_hours_days=ALL_DAYS, call_hours_start="09:00", call_hours_end="18:00",
                                       call_hours_schedule={"mode": "same", "breaks": [brk("13:00", "14:00")]})
                self.at(local(zone, *DAY, 12, 0))
                self.closing_after(4, local(zone, *DAY, 13, 0))
                self.assertTrue(self.start(c["id"]).json()["data"]["stopped_by_hours"], zone)
                self.assertEqual(self.sweep(local(zone, *DAY, 13, 59)), {"resumed": 0, "waiting": 1, "refused": 0}, zone)
                self.closing_after(None, None)
                self.assertEqual(self.sweep(local(zone, *DAY, 14, 0))["resumed"], 1, zone)
                self.assertEqual(len(self.dialed()), 10, zone)
                supabase.table("outbound_campaigns").delete().eq("id", c["id"]).execute()


class RunsPerDay(SchedulerBase):
    ZONE = "Asia/Karachi"

    def per_day_campaign(self):
        # Wed 09:00-12:00 (lunch-free), Thu off, Fri 10:00-18:00 with a break 13:00-14:00, Sat/Sun off
        cfg = {str(d): {"on": False} for d in range(7)}
        cfg["2"] = {"on": True, "start": "09:00", "end": "12:00", "breaks": []}
        cfg["4"] = {"on": True, "start": "10:00", "end": "18:00", "breaks": [brk("13:00", "14:00")]}
        return self.make_campaign(self.ZONE, call_hours_schedule={"mode": "per_day", "days": cfg})

    def test_a_day_that_is_off_is_skipped_and_each_day_uses_its_own_hours(self):
        c = self.per_day_campaign()
        z = self.ZONE
        # Wednesday 2026-10-14: runs 09:00-12:00, cut off after four calls
        self.at(local(z, *DAY, 9, 0))
        self.closing_after(4, local(z, *DAY, 12, 0))
        r = self.start(c["id"])
        self.assertTrue(r.json()["data"]["stopped_by_hours"], r.text)
        self.assertEqual(r.json()["data"]["next_open_at"], local(z, *day(2), 10, 0).strftime("%Y-%m-%dT%H:%M:%SZ"), "Friday 10:00, Thursday is off")

        # Wednesday afternoon, Thursday (off), Friday before 10:00: nothing
        for instant in (local(z, *DAY, 15, 0), local(z, *day(1), 10, 0), local(z, *day(1), 15, 0), local(z, *day(2), 9, 59)):
            self.assertEqual(self.sweep(instant), {"resumed": 0, "waiting": 1, "refused": 0}, str(instant))
        self.assertEqual(len(self.dialed()), 4)

        # Friday 10:00: the next four, then the lunch break begins
        self.closing_after(4, local(z, *day(2), 13, 0))
        self.assertEqual(self.sweep(local(z, *day(2), 10, 0))["resumed"], 1)
        self.assertEqual(len(self.dialed()), 8)
        self.assertEqual(self.sweep(local(z, *day(2), 13, 30)), {"resumed": 0, "waiting": 1, "refused": 0})

        # Friday 14:00: the rest
        self.closing_after(None, None)
        self.assertEqual(self.sweep(local(z, *day(2), 14, 0))["resumed"], 1)
        self.assertEqual(self.dialed(), self.expected_order)

    def test_the_weekend_never_dials(self):
        c = self.per_day_campaign()
        for offset in (3, 4):                                  # Saturday 17th, Sunday 18th
            self.at(local(self.ZONE, *day(offset), 11, 0))
            self.assertEqual(self.start(c["id"]).status_code, 400)
        self.create_call.assert_not_awaited()

    def test_starting_on_a_day_that_is_off_says_when_it_opens(self):
        c = self.per_day_campaign()
        self.at(local(self.ZONE, *day(1), 11, 0))              # Thursday
        r = self.start(c["id"])
        self.assertEqual(r.status_code, 400)
        self.assertIn("opens again Fri 10:00 AM", r.json()["detail"])


class ZoneEdit(ZoneBase):
    def test_changing_the_zone_moves_the_breaks_with_it(self):
        c = self.make_campaign("Asia/Karachi", call_hours_days=ALL_DAYS, call_hours_start="09:00", call_hours_end="18:00",
                               call_hours_schedule={"mode": "same", "breaks": [brk("13:00", "14:00")]})
        self.at(local("Asia/Karachi", *DAY, 13, 30))
        self.assertFalse(self.campaign_state(c["id"])["open"], "Karachi lunch")
        self.at(local("Asia/Karachi", *DAY, 14, 30))
        self.assertTrue(self.campaign_state(c["id"])["open"])
        self.api("patch", f"/telephony/campaigns/{c['id']}", json={"call_hours_timezone": "America/New_York"})
        self.assertFalse(self.campaign_state(c["id"])["open"], "14:30 in Karachi is 05:30 in New York: before the day starts")
        self.at(local("America/New_York", *DAY, 13, 30))
        self.assertFalse(self.campaign_state(c["id"])["open"], "New York lunch")
        self.at(local("America/New_York", *DAY, 14, 30))
        self.assertTrue(self.campaign_state(c["id"])["open"])


if __name__ == "__main__":
    unittest.main()
