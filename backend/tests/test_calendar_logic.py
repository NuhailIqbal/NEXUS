import unittest
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from services import calendar_service as cal

UTC = timezone.utc


def settings(**kw):
    return cal.validate_settings({}, kw)


def at(tz, y, m, d, hh, mm=0):
    return datetime(y, m, d, hh, mm, tzinfo=ZoneInfo(tz))


class ValidateSettings(unittest.TestCase):
    def test_C01_defaults(self):
        s = settings()
        self.assertEqual((s["timezone"], s["work_days"], s["start_time"], s["end_time"], s["slot_minutes"]),
                         ("UTC", [0, 1, 2, 3, 4], "09:00", "17:00", 30))

    def test_C02_partial_change_keeps_the_rest(self):
        s = cal.validate_settings({"timezone": "Asia/Karachi", "slot_minutes": 45}, {"end_time": "18:30"})
        self.assertEqual((s["timezone"], s["slot_minutes"], s["end_time"]), ("Asia/Karachi", 45, "18:30"))

    def test_C03_unknown_keys_are_ignored(self):
        self.assertNotIn("evil", cal.validate_settings({}, {"evil": 1}))

    def test_C04_bad_timezone(self):
        for bad in ("Mars/Olympus", "", None, 5, "../../etc/passwd"):
            with self.assertRaises(cal.SettingsError, msg=repr(bad)):
                settings(timezone=bad)

    def test_C05_work_days(self):
        self.assertEqual(settings(work_days=[4, 0, 2])["work_days"], [0, 2, 4])
        for bad in ([], [7], [-1], [1, 1], "mon", [True], [1.5], None):
            with self.assertRaises(cal.SettingsError, msg=repr(bad)):
                settings(work_days=bad)

    def test_C06_times(self):
        for bad in ("9:00", "24:00", "09:60", "abc", "", None, 900):
            with self.assertRaises(cal.SettingsError, msg=repr(bad)):
                settings(start_time=bad)
        with self.assertRaises(cal.SettingsError):
            settings(start_time="17:00", end_time="09:00")
        with self.assertRaises(cal.SettingsError):
            settings(start_time="09:00", end_time="09:00")

    def test_C07_numeric_bounds(self):
        for key, lo, hi in (("slot_minutes", 10, 240), ("buffer_minutes", 0, 120),
                            ("min_notice_hours", 0, 168), ("max_days_ahead", 1, 90)):
            self.assertEqual(settings(**{key: lo})[key], lo)
            self.assertEqual(settings(**{key: hi})[key], hi)
            for bad in (lo - 1, hi + 1, "30", 30.5, True, None):
                with self.assertRaises(cal.SettingsError, msg=f"{key}={bad!r}"):
                    settings(**{key: bad})


class Slots(unittest.TestCase):
    NOW = datetime(2026, 10, 5, 6, 0, tzinfo=UTC)          # Monday 06:00 UTC

    def slots(self, busy=(), tz="UTC", **kw):
        s = settings(timezone=tz, min_notice_hours=0, **{k: v for k, v in kw.items() if k in cal.DEFAULT_SETTINGS})
        opts = {k: v for k, v in kw.items() if k not in cal.DEFAULT_SETTINGS}
        return cal.compute_slots(list(busy), s, start_date=opts.get("start_date", date(2026, 10, 5)),
                                 days=opts.get("days", 1), duration_minutes=opts.get("duration", s["slot_minutes"]),
                                 now=opts.get("now", self.NOW), per_day=opts.get("per_day", 100))

    def test_S01_full_day_grid(self):
        out = self.slots()
        self.assertEqual(len(out), 16)                         # 09:00..16:30 every 30 min
        self.assertEqual((out[0].hour, out[0].minute, out[-1].hour, out[-1].minute), (9, 0, 16, 30))

    def test_S02_last_slot_must_finish_by_close(self):
        out = self.slots(duration=60)
        self.assertEqual((out[-1].hour, out[-1].minute), (16, 0))   # 16:30 + 60 would overrun 17:00

    def test_S03_weekend_skipped(self):
        self.assertEqual(self.slots(start_date=date(2026, 10, 10), days=2), [])   # Sat + Sun

    def test_S04_custom_work_days(self):
        out = self.slots(start_date=date(2026, 10, 10), days=2, work_days=[5])    # Saturday only
        self.assertTrue(out and all(d.weekday() == 5 for d in out))

    def test_S05_busy_blocks_overlapping_slots_only(self):
        busy = [(at("UTC", 2026, 10, 5, 10, 0), at("UTC", 2026, 10, 5, 11, 0))]
        out = [(d.hour, d.minute) for d in self.slots(busy)]
        self.assertNotIn((10, 0), out)
        self.assertNotIn((10, 30), out)
        self.assertIn((9, 30), out)        # ends exactly when busy starts -> allowed
        self.assertIn((11, 0), out)        # starts exactly when busy ends -> allowed

    def test_S06_partial_overlap_blocks(self):
        busy = [(at("UTC", 2026, 10, 5, 9, 45), at("UTC", 2026, 10, 5, 10, 15))]
        out = [(d.hour, d.minute) for d in self.slots(busy)]
        self.assertNotIn((9, 30), out)
        self.assertNotIn((10, 0), out)

    def test_S07_buffer_pads_both_sides(self):
        busy = [(at("UTC", 2026, 10, 5, 10, 0), at("UTC", 2026, 10, 5, 11, 0))]
        out = [(d.hour, d.minute) for d in self.slots(busy, buffer_minutes=15)]
        self.assertNotIn((9, 30), out)
        self.assertNotIn((11, 0), out)
        self.assertIn((9, 0), out)
        self.assertIn((11, 30), out)

    def test_S08_all_day_busy_means_no_slots(self):
        busy = [(at("UTC", 2026, 10, 5, 0, 0), at("UTC", 2026, 10, 6, 0, 0))]
        self.assertEqual(self.slots(busy), [])

    def test_S09_min_notice(self):
        s = settings(min_notice_hours=3)
        out = cal.compute_slots([], s, start_date=date(2026, 10, 5), days=1, duration_minutes=30,
                                now=datetime(2026, 10, 5, 9, 15, tzinfo=UTC), per_day=100)
        self.assertEqual((out[0].hour, out[0].minute), (12, 30))   # 09:15 + 3h = 12:15 -> next grid slot

    def test_S10_past_is_never_offered(self):
        s = settings(min_notice_hours=0)
        out = cal.compute_slots([], s, start_date=date(2026, 10, 5), days=1, duration_minutes=30,
                                now=datetime(2026, 10, 5, 16, 45, tzinfo=UTC), per_day=100)
        self.assertEqual(out, [])

    def test_S11_max_days_ahead(self):
        s = settings(min_notice_hours=0, max_days_ahead=2)
        out = cal.compute_slots([], s, start_date=date(2026, 10, 5), days=7, duration_minutes=30,
                                now=datetime(2026, 10, 5, 8, 0, tzinfo=UTC), per_day=100)
        self.assertTrue(max(d.date() for d in out) <= date(2026, 10, 7))

    def test_S12_per_day_cap_spreads_over_days(self):
        out = self.slots(days=3, per_day=4)
        self.assertEqual(len(out), 12)
        self.assertEqual([d.day for d in out], [5] * 4 + [6] * 4 + [7] * 4)

    def test_S13_timezone_offsets(self):
        out = self.slots(tz="Asia/Karachi", now=datetime(2026, 10, 4, 0, 0, tzinfo=UTC))
        self.assertEqual(out[0].isoformat(), "2026-10-05T09:00:00+05:00")

    def test_S14_busy_given_in_other_timezone_still_matches(self):
        busy = [(at("America/New_York", 2026, 10, 5, 1, 0), at("America/New_York", 2026, 10, 5, 2, 0))]  # 05:00-06:00Z
        out = self.slots(busy, tz="Asia/Karachi", now=datetime(2026, 10, 4, 0, 0, tzinfo=UTC))            # 10:00-11:00 PKT
        self.assertNotIn((10, 0), [(d.hour, d.minute) for d in out])
        self.assertIn((9, 30), [(d.hour, d.minute) for d in out])

    def test_S15_dst_spring_forward_day_is_still_a_clean_grid(self):
        out = self.slots(tz="America/New_York", start_date=date(2026, 3, 9), now=datetime(2026, 3, 1, tzinfo=UTC))
        self.assertEqual(len(out), 16)
        self.assertEqual(out[0].isoformat(), "2026-03-09T09:00:00-04:00")
        gaps = {(b - a) for a, b in zip(out, out[1:])}
        self.assertEqual(gaps, {timedelta(minutes=30)})

    def test_S16_dst_change_between_two_days_does_not_shift_local_times(self):
        out = self.slots(tz="America/New_York", start_date=date(2026, 11, 2), days=1, now=datetime(2026, 10, 25, tzinfo=UTC))
        self.assertEqual(out[0].isoformat(), "2026-11-02T09:00:00-05:00")     # after fall-back

    def test_S17_dst_fall_back_working_window_on_the_transition_day(self):
        # 2026-11-01 (Sunday) is the 25-hour day in New York; open Sundays to exercise it.
        out = self.slots(tz="America/New_York", start_date=date(2026, 11, 1), work_days=[6],
                         start_time="00:00", end_time="23:30", now=datetime(2026, 10, 25, tzinfo=UTC))
        starts_utc = [d.astimezone(UTC) for d in out]
        self.assertEqual(len(starts_utc), len(set(starts_utc)))               # no slot duplicated
        self.assertTrue(all(b > a for a, b in zip(starts_utc, starts_utc[1:])))

    def test_S18_huge_duration_yields_nothing(self):
        self.assertEqual(self.slots(duration=240), self.slots(duration=240))   # deterministic
        self.assertEqual(self.slots(duration=600, slot_minutes=30), [])

    def test_S19_unparseable_busy_bounds_are_not_needed_because_google_strings_parse(self):
        self.assertEqual(cal.parse_google_time("2026-10-05T10:00:00Z"), datetime(2026, 10, 5, 10, 0, tzinfo=UTC))
        self.assertEqual(cal.parse_google_time("2026-10-05T10:00:00+05:00").utcoffset(), timedelta(hours=5))


class Helpers(unittest.TestCase):
    def test_H01_within_working_hours_edges(self):
        s = settings(timezone="Asia/Karachi")
        mk = lambda h, m: at("Asia/Karachi", 2026, 10, 5, h, m)
        self.assertTrue(cal.within_working_hours(mk(9, 0), mk(9, 30), s))
        self.assertTrue(cal.within_working_hours(mk(16, 30), mk(17, 0), s))         # ends exactly at close
        self.assertFalse(cal.within_working_hours(mk(16, 31), mk(17, 1), s))        # one minute over
        self.assertFalse(cal.within_working_hours(mk(8, 59), mk(9, 29), s))         # starts one minute early
        self.assertFalse(cal.within_working_hours(mk(16, 45), at("Asia/Karachi", 2026, 10, 6, 0, 15), s))   # crosses midnight

    def test_H02_weekend_is_outside_hours(self):
        s = settings()
        self.assertFalse(cal.within_working_hours(at("UTC", 2026, 10, 10, 10), at("UTC", 2026, 10, 10, 11), s))

    def test_H03_working_hours_use_the_account_timezone_not_the_callers(self):
        s = settings(timezone="Asia/Karachi")
        start = at("UTC", 2026, 10, 5, 5, 0)                                        # 10:00 in Karachi
        self.assertTrue(cal.within_working_hours(start, start + timedelta(minutes=30), s))

    def test_H04_conflicts_back_to_back_allowed_unless_buffered(self):
        busy = [(at("UTC", 2026, 10, 5, 10), at("UTC", 2026, 10, 5, 11))]
        self.assertFalse(cal.conflicts(at("UTC", 2026, 10, 5, 9, 30), at("UTC", 2026, 10, 5, 10), busy, 0))
        self.assertTrue(cal.conflicts(at("UTC", 2026, 10, 5, 9, 30), at("UTC", 2026, 10, 5, 10), busy, 5))
        self.assertTrue(cal.conflicts(at("UTC", 2026, 10, 5, 10, 30), at("UTC", 2026, 10, 5, 11, 30), busy, 0))

    def test_H05_describe_slot_format(self):
        self.assertEqual(cal.describe_slot(at("UTC", 2026, 10, 6, 9, 5)), "Tue Oct 6, 9:05 AM")
        self.assertEqual(cal.describe_slot(at("UTC", 2026, 10, 6, 14, 30)), "Tue Oct 6, 2:30 PM")

    def test_H06_valid_timezone(self):
        self.assertTrue(cal.valid_timezone("Asia/Karachi"))
        self.assertFalse(cal.valid_timezone("Nope/Nope"))
        self.assertFalse(cal.valid_timezone(None))


if __name__ == "__main__":
    unittest.main()
