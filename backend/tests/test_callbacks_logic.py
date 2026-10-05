import unittest
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from services import callback_service as cbs

UTC = timezone.utc
KHI = "Asia/Karachi"                         # UTC+5, no DST


def S(**kw):
    return cbs.validate_settings({}, kw)


def due(days, t, now, **kw):
    d, src, note = cbs.resolve_due(days, t, S(**kw), now)
    return d, src, note


class Settings(unittest.TestCase):
    def test_B01_defaults_are_safe(self):
        s = S()
        self.assertIs(s["auto_call"], False)            # never calls on its own until switched on
        self.assertEqual((s["start_time"], s["end_time"], s["default_time"], s["max_attempts"]), ("09:00", "18:00", "10:00", 2))

    def test_B02_partial_changes_keep_the_rest(self):
        s = cbs.validate_settings({"timezone": KHI, "retry_minutes": 45}, {"end_time": "20:00"})
        self.assertEqual((s["timezone"], s["retry_minutes"], s["end_time"]), (KHI, 45, "20:00"))

    def test_B03_times_are_normalised(self):
        self.assertEqual(S(start_time="9:00")["start_time"], "09:00")

    def test_B04_bad_values_rejected(self):
        for bad in ({"auto_call": "yes"}, {"auto_call": 1}, {"timezone": "Mars/X"}, {"timezone": None},
                    {"work_days": []}, {"work_days": [7]}, {"work_days": [1, 1]}, {"work_days": "mon"},
                    {"start_time": "25:00"}, {"end_time": "nope"}, {"default_time": ""},
                    {"start_time": "18:00", "end_time": "09:00"}, {"start_time": "09:00", "end_time": "09:00"},
                    {"default_time": "08:00"}, {"default_time": "18:00"},       # outside the calling hours
                    {"retry_minutes": 4}, {"retry_minutes": 1441}, {"retry_minutes": "30"}, {"retry_minutes": True},
                    {"max_attempts": 0}, {"max_attempts": 6}, {"max_attempts": 1.5}):
            with self.assertRaises(cbs.CallbackError, msg=repr(bad)):
                S(**bad)

    def test_B04b_midnight_close_means_end_of_day(self):
        s = S(start_time="21:00", end_time="00:00", default_time="22:00", timezone=KHI)
        self.assertEqual(s["end_time"], "00:00")
        for bad in ({"default_time": "08:00"}, {"start_time": "00:00"}):       # 00:00 start..00:00 end is not a window
            with self.assertRaises(cbs.CallbackError, msg=repr(bad)):
                S(**{**dict(start_time="21:00", end_time="00:00", default_time="22:00"), **bad})
        mk = lambda h, m=0: datetime(2026, 10, 5, h, m, tzinfo=ZoneInfo(KHI))
        self.assertTrue(cbs.in_calling_window(mk(23, 59), s))
        self.assertFalse(cbs.in_calling_window(mk(20, 59), s))
        self.assertFalse(cbs.in_calling_window(mk(0, 0) + timedelta(days=1), s))   # Tue 00:00 is closed

    def test_B05_limits_are_inclusive(self):
        self.assertEqual(S(retry_minutes=5, max_attempts=1)["max_attempts"], 1)
        self.assertEqual(S(retry_minutes=1440, max_attempts=5)["retry_minutes"], 1440)
        self.assertEqual(S(default_time="09:00")["default_time"], "09:00")      # opening time itself is fine

    def test_B06_unknown_keys_ignored(self):
        self.assertNotIn("evil", cbs.validate_settings({}, {"evil": 1}))


class TimezoneAliases(unittest.TestCase):
    def test_A01_us_abbreviations_map_to_real_regions(self):
        for typed, zone in (("EST", "America/New_York"), ("edt", "America/New_York"), (" ET ", "America/New_York"),
                            ("CST", "America/Chicago"), ("MDT", "America/Denver"), ("pst", "America/Los_Angeles"),
                            ("AKST", "America/Anchorage"), ("HST", "Pacific/Honolulu"), ("PKT", "Asia/Karachi")):
            self.assertEqual(S(timezone=typed)["timezone"], zone, typed)

    def test_A02_real_names_are_left_alone(self):
        for tz in ("America/New_York", "Asia/Karachi", "UTC", "Europe/London"):
            self.assertEqual(S(timezone=tz)["timezone"], tz)

    def test_A03_ambiguous_or_unknown_short_names_are_refused_not_guessed(self):
        for bad in ("IST", "BST", "XYZ", "EST5", "E S T"):
            with self.assertRaises(cbs.CallbackError, msg=bad):
                S(timezone=bad)

    def test_A04_est_follows_daylight_saving(self):
        # "5 pm EST" means 5 pm New York wall-clock time: UTC-5 in winter, UTC-4 in summer.
        winter = cbs.resolve_due(0, "17:00", S(timezone="EST"), datetime(2026, 1, 15, 12, 0, tzinfo=UTC))[0]
        summer = cbs.resolve_due(0, "17:00", S(timezone="EST"), datetime(2026, 7, 15, 12, 0, tzinfo=UTC))[0]
        self.assertEqual(winter.strftime("%H:%M"), "22:00")
        self.assertEqual(summer.strftime("%H:%M"), "21:00")

    def test_A05_non_text_is_still_rejected(self):
        for bad in (None, 5, ["EST"], True):
            with self.assertRaises(cbs.CallbackError, msg=repr(bad)):
                S(timezone=bad)


class ResolveDue(unittest.TestCase):
    NOW = datetime(2026, 10, 5, 8, 0, tzinfo=UTC)               # Mon 13:00 in Karachi

    def local(self, d):
        return d.astimezone(ZoneInfo(KHI)).strftime("%Y-%m-%d %H:%M")

    def test_R01_time_later_today(self):
        d, src, note = due(0, "17:00", self.NOW, timezone=KHI)
        self.assertEqual((self.local(d), src, note), ("2026-10-05 17:00", "caller", None))

    def test_R02_time_without_days_means_today_if_still_ahead(self):
        d, src, _ = due(None, "17:00", self.NOW, timezone=KHI)
        self.assertEqual((self.local(d), src), ("2026-10-05 17:00", "caller"))

    def test_R03_time_already_passed_rolls_to_tomorrow_and_says_so(self):
        d, src, note = due(None, "09:00", self.NOW, timezone=KHI)
        self.assertEqual(self.local(d), "2026-10-06 09:00")
        self.assertIn("tomorrow", note)

    def test_R04_days_shifts_the_date(self):
        self.assertEqual(self.local(due(1, "15:30", self.NOW, timezone=KHI)[0]), "2026-10-06 15:30")
        self.assertEqual(self.local(due(3, "10:00", self.NOW, timezone=KHI)[0]), "2026-10-08 10:00")

    def test_R05_today_but_passed_with_explicit_zero_days_moves_to_tomorrow(self):
        d, _, note = due(0, "08:00", self.NOW, timezone=KHI)
        self.assertEqual(self.local(d), "2026-10-06 08:00")
        self.assertTrue(note)

    def test_R06_less_than_five_minutes_ahead_counts_as_passed(self):
        now = datetime(2026, 10, 5, 11, 58, tzinfo=UTC)          # 16:58 Karachi
        self.assertEqual(self.local(due(0, "17:00", now, timezone=KHI)[0]), "2026-10-06 17:00")
        ok = datetime(2026, 10, 5, 11, 50, tzinfo=UTC)           # 16:50 -> 10 minutes ahead is fine
        self.assertEqual(self.local(due(0, "17:00", ok, timezone=KHI)[0]), "2026-10-05 17:00")

    def test_R07_only_days_uses_the_default_time(self):
        d, src, note = due(2, None, self.NOW, timezone=KHI)
        self.assertEqual((self.local(d), src), ("2026-10-07 10:00", "default"))
        self.assertIn("no time", note)

    def test_R08_nothing_given_next_calling_day_at_default_time(self):
        d, src, note = due(None, None, self.NOW, timezone=KHI)
        self.assertEqual((self.local(d), src), ("2026-10-06 10:00", "default"))
        self.assertIn("no time", note)

    def test_R09_default_skips_non_calling_days(self):
        fri = datetime(2026, 10, 9, 8, 0, tzinfo=UTC)
        d, _, _ = due(None, None, fri, timezone=KHI)
        self.assertEqual(self.local(d), "2026-10-12 10:00")      # Saturday and Sunday skipped -> Monday

    def test_R10_days_only_landing_on_a_weekend_moves_to_monday(self):
        d, _, _ = due(1, None, datetime(2026, 10, 9, 8, 0, tzinfo=UTC), timezone=KHI)    # Fri + 1 = Sat
        self.assertEqual(self.local(d), "2026-10-12 10:00")

    def test_R11_a_time_the_caller_named_is_honoured_even_on_a_weekend(self):
        d, src, _ = due(1, "11:00", datetime(2026, 10, 9, 8, 0, tzinfo=UTC), timezone=KHI)   # Saturday
        self.assertEqual((self.local(d), src), ("2026-10-10 11:00", "caller"))

    def test_R12_junk_input_is_ignored_not_fatal(self):
        for t, days in (("5pm", None), ("25:99", 1), ("", 0), (None, "soon"), (17, True), ("17", -1), ("17:00 ", 999)):
            d, src, _ = cbs.resolve_due(days, t, S(timezone=KHI), self.NOW)
            self.assertGreater(d, self.NOW, (t, days))

    def test_R13_string_numbers_from_the_model_are_understood(self):
        self.assertEqual(self.local(due("1", "9:30", self.NOW, timezone=KHI)[0]), "2026-10-06 09:30")
        self.assertEqual(self.local(due(1.0, "09:30", self.NOW, timezone=KHI)[0]), "2026-10-06 09:30")

    def test_R14_time_is_in_the_account_timezone(self):
        d, _, _ = due(0, "17:00", datetime(2026, 10, 5, 8, 0, tzinfo=UTC), timezone="America/New_York")
        self.assertEqual(d.astimezone(ZoneInfo("America/New_York")).strftime("%H:%M"), "17:00")
        self.assertEqual(d.utcoffset(), timedelta(0))                       # always stored as UTC

    def test_R15_dst_gap_and_overlap_do_not_crash(self):
        spring = datetime(2026, 3, 7, 12, 0, tzinfo=UTC)
        d, _, _ = cbs.resolve_due(1, "02:30", S(timezone="America/New_York", start_time="00:00", default_time="00:30"), spring)
        self.assertIsNotNone(d)                                             # 02:30 doesn't exist on 8 Mar
        fall = datetime(2026, 10, 31, 12, 0, tzinfo=UTC)
        d2, _, _ = cbs.resolve_due(1, "01:30", S(timezone="America/New_York", start_time="00:00", default_time="00:30"), fall)
        self.assertIsNotNone(d2)                                            # 01:30 happens twice on 1 Nov

    def test_R16_wall_clock_time_survives_a_dst_change_between_now_and_then(self):
        now = datetime(2026, 10, 30, 12, 0, tzinfo=UTC)
        d, _, _ = cbs.resolve_due(5, "10:00", S(timezone="America/New_York"), now)     # lands after fall-back (4 Nov)
        self.assertEqual(d.astimezone(ZoneInfo("America/New_York")).strftime("%Y-%m-%d %H:%M"), "2026-11-04 10:00")

    def test_R17_max_days(self):
        self.assertIsNotNone(cbs._int_days(60))
        self.assertIsNone(cbs._int_days(61))


class RelativeMinutes(unittest.TestCase):
    """'Call me in 30 minutes': the AI cannot see the clock, so it sends minutes and the server adds them."""
    NOW = datetime(2026, 10, 5, 8, 0, tzinfo=UTC)

    def mins(self, m, days=None, t=None, **kw):
        return cbs.resolve_due(days, t, S(**kw), self.NOW, minutes=m)

    def test_M01_adds_the_minutes_to_now(self):
        d, src, note = self.mins(30)
        self.assertEqual((d, src, note), (self.NOW + timedelta(minutes=30), "caller", None))

    def test_M02_an_hour_and_longer_waits(self):
        self.assertEqual(self.mins(60)[0], self.NOW + timedelta(hours=1))
        self.assertEqual(self.mins(90)[0], self.NOW + timedelta(minutes=90))
        self.assertEqual(self.mins(7 * 24 * 60)[0], self.NOW + timedelta(days=7))

    def test_M03_it_does_not_depend_on_the_account_timezone(self):
        self.assertEqual(self.mins(30, timezone=KHI)[0], self.mins(30, timezone="America/New_York")[0])

    def test_M04_very_short_waits_are_raised_to_the_minimum_notice_and_say_so(self):
        d, _, note = self.mins(1)
        self.assertEqual(d, self.NOW + timedelta(minutes=cbs.MIN_NOTICE_MINUTES))
        self.assertIn("minimum", note)

    def test_M05_minutes_win_over_a_day_and_time_the_ai_may_have_guessed(self):
        d, src, _ = self.mins(30, days=3, t="17:00")
        self.assertEqual((d, src), (self.NOW + timedelta(minutes=30), "caller"))

    def test_M06_whole_numbers_in_other_shapes_are_accepted(self):
        for v in ("30", " 30 ", 30.0):
            self.assertEqual(self.mins(v)[0], self.NOW + timedelta(minutes=30), repr(v))

    def test_M07_unusable_values_are_ignored_not_guessed(self):
        # falls back to the day/time (or the default) exactly as if no minutes were sent
        fallback = cbs.resolve_due(None, None, S(), self.NOW)
        for bad in (0, -5, 1.5, "soon", "", None, True, [30], 7 * 24 * 60 + 1):
            self.assertEqual(self.mins(bad), fallback, repr(bad))

    def test_M08_a_bad_minutes_value_still_lets_a_valid_day_and_time_through(self):
        d, src, _ = self.mins("soon", days=1, t="17:00", timezone=KHI)
        self.assertEqual((d.astimezone(ZoneInfo(KHI)).strftime("%Y-%m-%d %H:%M"), src), ("2026-10-06 17:00", "caller"))


class Window(unittest.TestCase):
    def test_W01_inside_and_outside(self):
        s = S(timezone=KHI)
        mk = lambda y, m, d, h, mi=0: datetime(y, m, d, h, mi, tzinfo=ZoneInfo(KHI))
        self.assertTrue(cbs.in_calling_window(mk(2026, 10, 5, 9), s))             # opening minute is in
        self.assertTrue(cbs.in_calling_window(mk(2026, 10, 5, 17, 59), s))
        self.assertFalse(cbs.in_calling_window(mk(2026, 10, 5, 18), s))           # closing minute is out
        self.assertFalse(cbs.in_calling_window(mk(2026, 10, 5, 8, 59), s))
        self.assertFalse(cbs.in_calling_window(mk(2026, 10, 10, 11), s))          # Saturday

    def test_W02_next_opening_same_day_next_day_and_over_a_weekend(self):
        s = S(timezone=KHI)
        mk = lambda y, m, d, h, mi=0: datetime(y, m, d, h, mi, tzinfo=ZoneInfo(KHI))
        loc = lambda dt: dt.astimezone(ZoneInfo(KHI)).strftime("%a %H:%M")
        self.assertEqual(loc(cbs.next_window_start(mk(2026, 10, 5, 7), s)), "Mon 09:00")
        self.assertEqual(loc(cbs.next_window_start(mk(2026, 10, 5, 19), s)), "Tue 09:00")
        self.assertEqual(loc(cbs.next_window_start(mk(2026, 10, 9, 19), s)), "Mon 09:00")       # Friday night
        inside = mk(2026, 10, 5, 12)
        self.assertEqual(cbs.next_window_start(inside, s), inside.astimezone(UTC))

    def test_W03_no_calling_days_at_all_cannot_loop_forever(self):
        s = {**S(), "work_days": []}
        m = datetime(2026, 10, 5, 7, 0, tzinfo=UTC)
        self.assertEqual(cbs.next_window_start(m, s), m)


if __name__ == "__main__":
    unittest.main()
