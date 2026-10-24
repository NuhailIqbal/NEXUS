"""
Calling hours: the shared window logic, the outbound-campaign rule (a campaign only places calls
inside its hours, and a run the hours stop carries on where it left off) and the inbound rule (a
number's AI receptionist only answers inside its hours; outside them the caller is told we are
closed).

Windows are "always open" (every day, 00:00 to midnight) or "always closed" (one weekday that is
not today), so the API tests need no clock control; the pure logic takes an explicit `now`.

Run from the backend folder:  python -m unittest discover -s tests -v
"""
import unittest
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import byot_harness as H
from database import supabase
from routers import telephony
from services import call_hours, call_retry, caller_verification as cv, campaign_scheduler, dialer, vapi_client

from test_timezones import FakeDateTime
from test_caller_verification import (
    Base, make_agent, make_number, number_row, patch_settings, request_body, run, screenings,
)

C, N = call_hours.CAMPAIGN, call_hours.NUMBER


def utc(y, mo, d, h=0, mi=0):
    return datetime(y, mo, d, h, mi, tzinfo=timezone.utc)


def row(prefix=C, **kw):
    """A stored row with hours on (Mon-Fri 09:00-17:00 UTC) unless overridden by suffix keywords."""
    base = {"enabled": True, "timezone": "UTC", "days": [0, 1, 2, 3, 4], "start": "09:00", "end": "17:00"}
    base.update(kw)
    return {prefix + k: v for k, v in base.items()}


def hours_body(prefix, open_now: bool, **extra):
    """A request body that switches hours on, always open or closed for the whole test."""
    if open_now:
        days, start, end = [0, 1, 2, 3, 4, 5, 6], "00:00", "00:00"
    else:
        days, start, end = [(datetime.now(timezone.utc).weekday() + 3) % 7], "00:00", "00:00"
    return {prefix + "enabled": True, prefix + "timezone": "UTC", prefix + "days": days,
            prefix + "start": start, prefix + "end": end, **extra}


# 2026-10-12 is a Monday (asserted below), so the days after it are Tue 13 ... Sun 18.
MON = utc(2026, 10, 12)


class FixtureSanity(unittest.TestCase):
    def test_the_reference_date_is_a_monday(self):
        self.assertEqual(MON.weekday(), 0)


# ═══════════════════════════════════════════════════════════════════════════
# Pure logic
# ═══════════════════════════════════════════════════════════════════════════


class ValidateTests(unittest.TestCase):
    def v(self, updates=None, current=None, prefix=C):
        return call_hours.validate(prefix, current, updates or {})

    def test_nothing_sent_gives_the_defaults_off(self):
        self.assertEqual(self.v(), {"call_hours_enabled": False, "call_hours_timezone": None,
                                    "call_hours_days": [0, 1, 2, 3, 4], "call_hours_start": "09:00",
                                    "call_hours_end": "17:00", "call_hours_schedule": {"mode": "same", "breaks": []}})

    def test_the_result_uses_the_prefix_it_was_given(self):
        self.assertEqual(set(self.v(prefix=N)), set(call_hours.fields(N)))
        self.assertTrue(all(k.startswith("answer_hours_") for k in self.v(prefix=N)))

    def test_updates_are_merged_over_the_stored_values(self):
        got = self.v({"call_hours_start": "08:30"}, current=row(timezone="Europe/London", end="18:00"))
        self.assertEqual((got["call_hours_start"], got["call_hours_end"], got["call_hours_timezone"]),
                         ("08:30", "18:00", "Europe/London"))
        self.assertIs(got["call_hours_enabled"], True)

    def test_values_are_normalised(self):
        got = self.v({"call_hours_start": "9:05", "call_hours_days": [4, 0, 2], "call_hours_timezone": "est"})
        self.assertEqual((got["call_hours_start"], got["call_hours_days"], got["call_hours_timezone"]),
                         ("09:05", [0, 2, 4], "America/New_York"))

    def test_none_means_not_sent(self):
        got = self.v({"call_hours_start": None}, current=row(start="10:00"))
        self.assertEqual(got["call_hours_start"], "10:00")

    def test_midnight_as_the_end_means_the_end_of_the_day(self):
        self.assertEqual(self.v({"call_hours_start": "00:00", "call_hours_end": "00:00"})["call_hours_end"], "00:00")

    def test_every_invalid_value_is_refused_with_a_message(self):
        bad = [
            {"call_hours_enabled": "yes"}, {"call_hours_enabled": 1},
            {"call_hours_timezone": "Mars/Olympus"},
            {"call_hours_days": []}, {"call_hours_days": [7]}, {"call_hours_days": [-1]},
            {"call_hours_days": [1, 1]}, {"call_hours_days": [True]}, {"call_hours_days": "mon"},
            {"call_hours_days": [1.5]},
            {"call_hours_start": "25:00"}, {"call_hours_start": "nine"}, {"call_hours_end": "17:60"},
            {"call_hours_start": "17:00", "call_hours_end": "09:00"},     # would cross midnight
            {"call_hours_start": "09:00", "call_hours_end": "09:00"},
            {"call_hours_start": "08:00", "call_hours_end": "08:00"},
        ]
        for updates in bad:
            with self.subTest(updates=updates), self.assertRaises(call_hours.HoursError) as cm:
                self.v(updates)
            self.assertTrue(str(cm.exception))

    def test_there_is_no_default_time_zone(self):
        got = self.v()
        self.assertIsNone(got["call_hours_timezone"])
        self.assertIsNone(self.v(prefix=N)["answer_hours_timezone"])

    def test_switching_on_needs_a_time_zone_the_user_chose(self):
        for updates in ({"call_hours_enabled": True}, {"call_hours_enabled": True, "call_hours_timezone": ""},
                        {"call_hours_enabled": True, "call_hours_timezone": "   "}):
            with self.subTest(updates=updates), self.assertRaises(call_hours.HoursError) as cm:
                self.v(updates)
            self.assertEqual(str(cm.exception), "Select a time zone.")

    def test_a_stored_zone_still_counts_when_the_hours_are_switched_on_later(self):
        got = self.v({"call_hours_enabled": True}, current=row(enabled=False, timezone="Asia/Karachi"))
        self.assertEqual(got["call_hours_timezone"], "Asia/Karachi")

    def test_off_with_no_zone_is_fine_and_stays_unset(self):
        for tz in (None, "", "  "):
            with self.subTest(tz=tz):
                got = self.v({"call_hours_timezone": tz, "call_hours_start": "08:00"})
                self.assertIsNone(got["call_hours_timezone"])
                self.assertEqual(got["call_hours_start"], "08:00")

    def test_a_zone_that_is_given_must_be_real_even_while_off(self):
        with self.assertRaises(call_hours.HoursError):
            self.v({"call_hours_timezone": "Mars/Olympus"})

    def test_chosen_timezone_reports_only_what_the_user_picked(self):
        self.assertIsNone(call_hours.chosen_timezone({}, C))
        self.assertIsNone(call_hours.chosen_timezone(None, C))
        self.assertIsNone(call_hours.chosen_timezone({"call_hours_timezone": None}, C))
        self.assertIsNone(call_hours.chosen_timezone({"call_hours_timezone": "Mars/Olympus"}, C))
        self.assertEqual(call_hours.chosen_timezone({"call_hours_timezone": "Asia/Karachi"}, C), "Asia/Karachi")
        # a zone chosen earlier counts whether or not the hours are on right now
        self.assertEqual(call_hours.chosen_timezone(row(enabled=False, timezone="Asia/Tokyo"), C), "Asia/Tokyo")

    def test_a_merge_that_only_becomes_invalid_together_is_refused(self):
        # Valid alone, invalid with what is stored: start moved past the stored end.
        with self.assertRaises(call_hours.HoursError):
            self.v({"call_hours_start": "18:00"}, current=row(end="17:00"))

    def test_the_whole_set_is_checked_even_while_switched_off(self):
        with self.assertRaises(call_hours.HoursError):
            self.v({"call_hours_enabled": False, "call_hours_days": []})

    def test_touched_sees_any_of_the_fields(self):
        self.assertTrue(call_hours.touched(C, {"call_hours_end": "10:00"}))
        self.assertFalse(call_hours.touched(C, {"name": "x", "answer_hours_end": "10:00"}))


class OpenTests(unittest.TestCase):
    def test_off_is_always_open(self):
        for r in ({}, None, row(enabled=False), {"call_hours_enabled": None}, {"call_hours_enabled": "yes"}):
            with self.subTest(row=r):
                self.assertTrue(call_hours.is_open(r, C, MON))
                self.assertIsNone(call_hours.next_opening(r, C, MON))

    def test_inside_and_outside_the_day(self):
        r = row()
        for h, mi, expected in ((9, 0, True), (12, 30, True), (16, 59, True), (17, 0, False), (8, 59, False), (0, 0, False), (23, 59, False)):
            with self.subTest(at=f"{h}:{mi:02d}"):
                self.assertIs(call_hours.is_open(r, C, utc(2026, 10, 12, h, mi)), expected)

    def test_days_outside_the_selection_are_closed(self):
        r = row(days=[0, 2])        # Mon, Wed
        self.assertTrue(call_hours.is_open(r, C, utc(2026, 10, 12, 10)))     # Mon
        self.assertFalse(call_hours.is_open(r, C, utc(2026, 10, 13, 10)))    # Tue
        self.assertTrue(call_hours.is_open(r, C, utc(2026, 10, 14, 10)))     # Wed
        self.assertFalse(call_hours.is_open(r, C, utc(2026, 10, 17, 10)))    # Sat

    def test_the_window_is_read_in_the_rows_timezone(self):
        r = row(timezone="America/New_York")                   # EDT (UTC-4) in October
        self.assertTrue(call_hours.is_open(r, C, utc(2026, 10, 12, 14, 0)))   # 10:00 in New York
        self.assertFalse(call_hours.is_open(r, C, utc(2026, 10, 12, 12, 59)))  # 08:59 there
        self.assertFalse(call_hours.is_open(r, C, utc(2026, 10, 12, 21, 0)))   # 17:00 there
        # 02:00 UTC Tuesday is still Monday evening in New York: not a Tuesday morning.
        self.assertFalse(call_hours.is_open(r, C, utc(2026, 10, 13, 2, 0)))

    def test_a_midnight_end_keeps_the_last_minute_of_the_day_open(self):
        r = row(start="09:00", end="00:00")
        self.assertTrue(call_hours.is_open(r, C, utc(2026, 10, 12, 23, 59)))
        self.assertFalse(call_hours.is_open(r, C, utc(2026, 10, 12, 8, 59)))

    def test_unreadable_settings_follow_the_callers_choice(self):
        damaged = row(start=None)
        damaged["call_hours_start"] = "garbage"
        self.assertTrue(call_hours.is_open(damaged, C, MON, if_unreadable=True))
        self.assertFalse(call_hours.is_open(damaged, C, MON, if_unreadable=False))
        self.assertIsNone(call_hours.next_opening(damaged, C, MON))

    def test_next_opening(self):
        r = row()
        self.assertEqual(call_hours.next_opening(r, C, utc(2026, 10, 12, 8, 0)), utc(2026, 10, 12, 9, 0))    # before opening
        self.assertEqual(call_hours.next_opening(r, C, utc(2026, 10, 12, 12, 0)), utc(2026, 10, 12, 12, 0))  # open: now
        self.assertEqual(call_hours.next_opening(r, C, utc(2026, 10, 12, 18, 0)), utc(2026, 10, 13, 9, 0))   # after closing
        self.assertEqual(call_hours.next_opening(r, C, utc(2026, 10, 16, 18, 0)), utc(2026, 10, 19, 9, 0))   # Fri evening -> Mon

    def test_state(self):
        off = call_hours.state(row(enabled=False), C, MON)
        self.assertEqual(off, {"enabled": False, "open": True, "next_open_at": None, "summary": None})
        closed = call_hours.state(row(), C, utc(2026, 10, 12, 18, 0))
        self.assertEqual((closed["enabled"], closed["open"], closed["next_open_at"]), (True, False, "2026-10-13T09:00:00Z"))
        self.assertEqual(closed["summary"], "Mon–Fri, 9:00 AM–5:00 PM (UTC)")
        opened = call_hours.state(row(), C, utc(2026, 10, 12, 10, 0))
        self.assertEqual((opened["open"], opened["next_open_at"]), (True, None))


class DescribeTests(unittest.TestCase):
    def d(self, **kw):
        return call_hours.describe(row(**kw), C)

    def test_day_ranges(self):
        self.assertEqual(self.d(days=[0, 1, 2, 3, 4]), "Mon–Fri, 9:00 AM–5:00 PM (UTC)")
        self.assertEqual(self.d(days=[0, 1, 2, 3, 4, 5, 6]), "Every day, 9:00 AM–5:00 PM (UTC)")
        self.assertEqual(self.d(days=[5, 6]), "Sat, Sun, 9:00 AM–5:00 PM (UTC)")
        self.assertEqual(self.d(days=[0, 1, 2, 5]), "Mon–Wed, Sat, 9:00 AM–5:00 PM (UTC)")
        self.assertEqual(self.d(days=[0, 2, 4]), "Mon, Wed, Fri, 9:00 AM–5:00 PM (UTC)")
        self.assertEqual(self.d(days=[3]), "Thu, 9:00 AM–5:00 PM (UTC)")

    def test_clock_labels(self):
        self.assertIn("12:00 AM–12:00 PM", self.d(start="00:00", end="12:00"))
        self.assertIn("12:30 PM–11:45 PM", self.d(start="12:30", end="23:45"))

    def test_midnight_and_all_day_are_said_in_words(self):
        self.assertIn(", 8:00 AM–midnight (", self.d(start="08:00", end="00:00"))
        self.assertEqual(self.d(days=[0, 1, 2, 3, 4, 5, 6], start="00:00", end="00:00"), "Every day, all day (UTC)")
        self.assertIn(", 12:00 AM–5:00 PM (", self.d(start="00:00", end="17:00"))

    def test_a_moment_is_described_in_the_rows_own_timezone(self):
        r = row(timezone="America/New_York")
        self.assertEqual(call_hours.describe_moment(utc(2026, 10, 13, 13, 0), r, C), "Tue 9:00 AM (America/New_York)")


# ═══════════════════════════════════════════════════════════════════════════
# Outbound campaigns
# ═══════════════════════════════════════════════════════════════════════════


class CampaignBase(unittest.TestCase):
    """An account with a funded wallet, a synced agent and number, a list of five contacts and a
    mocked call placer."""

    def setUp(self):
        H.reset_rate_limits()
        self.user = H.make_user()
        H.fund_wallet(self.user, 100)
        self.agent = make_agent(self.user)
        self.number = make_number(self.user, agent=self.agent)
        self.list = supabase.table("lists").insert({"user_id": self.user, "name": "Leads"}).execute().data[0]
        self.contacts = self.add_contacts(self.list["id"], 5)
        self.create_call = AsyncMock(side_effect=lambda payload: {"id": f"call-{uuid.uuid4().hex[:6]}"})
        p = patch.object(vapi_client, "create_call", self.create_call)
        p.start()
        self.addCleanup(p.stop)
        # two contacts per batch makes "the hours closed between batches" easy to arrange
        p = patch.object(telephony, "CAMPAIGN_BATCH_SIZE", 2)
        p.start()
        self.addCleanup(p.stop)
        # no other test's campaign is mid-pass, claimed or waiting for a wake-up
        self._reset_dial_state()
        self.addCleanup(self._reset_dial_state)

    @staticmethod
    def _reset_dial_state():
        H.sql("UPDATE public.outbound_campaigns SET dial_running = false, dial_stall = NULL, dial_next_at = NULL, "
              "run_token = NULL, run_heartbeat_at = NULL")

    _phones = 0

    def add_contacts(self, list_id, n):
        """n contacts with phone numbers that are unique across the test (so "dialed once" can be
        read off the numbers), returned in dial (upload, contacts.seq) order."""
        start, self._phones = self._phones, self._phones + n
        rows = [{"user_id": self.user, "list_id": list_id, "name": f"C{i}", "phone": f"+1555000{i:04d}"}
                for i in range(start, start + n)]
        return sorted(supabase.table("contacts").insert(rows).execute().data, key=lambda c: c["seq"])

    def api(self, method, path, user=None, **kw):
        return getattr(H.client, method)(path, headers=H.auth(user or self.user), **kw)

    def make_campaign(self, **extra):
        body = {"name": "Spring", "agent_id": self.agent["id"], "list_id": self.list["id"],
                "phone_number_id": self.number["id"], "dnc_screening_enabled": False, **H.LEGACY_DIAL, **extra}
        r = self.api("post", "/telephony/campaigns", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["data"]

    def make_hours_campaign(self, **extra):
        """A campaign with hours on and (unless given) the time zone UTC chosen."""
        extra.setdefault("call_hours_enabled", True)
        extra.setdefault("call_hours_timezone", "UTC")
        return self.make_campaign(**extra)

    def campaign_row(self, cid):
        return supabase.table("outbound_campaigns").select("*").eq("id", cid).execute().data[0]

    def start(self, cid, user=None):
        return self.api("post", f"/telephony/campaigns/{cid}/start", user=user)

    def dialed_numbers(self):
        return [c.args[0]["customer"]["number"] for c in self.create_call.await_args_list]


class CampaignSettingsTests(CampaignBase):
    def test_a_campaign_created_the_old_way_has_no_limit(self):
        c = self.make_campaign()
        self.assertIs(c["call_hours_enabled"], False)
        self.assertEqual((c["call_hours_timezone"], c["call_hours_days"], c["call_hours_start"], c["call_hours_end"]),
                         (None, [0, 1, 2, 3, 4], "09:00", "17:00"))
        self.assertIsNone(c["dial_cursor"])

    def test_hours_can_be_set_at_creation_and_are_normalised(self):
        c = self.make_campaign(call_hours_enabled=True, call_hours_timezone="est", call_hours_days=[4, 0],
                               call_hours_start="9:30", call_hours_end="18:00")
        self.assertEqual((c["call_hours_enabled"], c["call_hours_timezone"], c["call_hours_days"], c["call_hours_start"]),
                         (True, "America/New_York", [0, 4], "09:30"))

    def test_invalid_hours_are_refused_at_creation_and_nothing_is_created(self):
        for extra in ({"call_hours_start": "17:00", "call_hours_end": "09:00"}, {"call_hours_timezone": "Nope/Nowhere"},
                      {"call_hours_days": []}, {"call_hours_end": "xx"}):
            with self.subTest(extra=extra):
                r = self.api("post", "/telephony/campaigns",
                             json={"name": "Bad", "agent_id": self.agent["id"], "call_hours_enabled": True, **extra})
                self.assertEqual(r.status_code, 400, r.text)
                self.assertTrue(r.json()["detail"])
        self.assertEqual(supabase.table("outbound_campaigns").select("id").eq("user_id", self.user).execute().data, [])

    def test_switching_hours_on_without_a_time_zone_is_refused_when_creating_and_updating(self):
        r = self.api("post", "/telephony/campaigns", json={"name": "X", "call_hours_enabled": True})
        self.assertEqual((r.status_code, r.json()["detail"]), (400, "Select a time zone."))
        c = self.make_campaign()
        r = self.api("patch", f"/telephony/campaigns/{c['id']}", json={"call_hours_enabled": True})
        self.assertEqual((r.status_code, r.json()["detail"]), (400, "Select a time zone."))
        self.assertIs(self.campaign_row(c["id"])["call_hours_enabled"], False)
        r = self.api("patch", f"/telephony/campaigns/{c['id']}", json={"call_hours_enabled": True, "call_hours_timezone": "Asia/Tokyo"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.campaign_row(c["id"])["call_hours_timezone"], "Asia/Tokyo")

    def test_the_stored_zone_is_kept_when_the_hours_are_switched_on_again(self):
        c = self.make_hours_campaign(call_hours_timezone="Asia/Karachi")
        self.api("patch", f"/telephony/campaigns/{c['id']}", json={"call_hours_enabled": False})
        self.assertEqual(self.campaign_row(c["id"])["call_hours_timezone"], "Asia/Karachi")
        r = self.api("patch", f"/telephony/campaigns/{c['id']}", json={"call_hours_enabled": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.campaign_row(c["id"])["call_hours_timezone"], "Asia/Karachi")

    def test_a_non_boolean_switch_is_rejected(self):
        r = self.api("post", "/telephony/campaigns", json={"name": "X", "call_hours_enabled": "yes"})
        self.assertEqual(r.status_code, 422)

    def test_patch_changes_only_what_is_sent(self):
        c = self.make_hours_campaign(call_hours_end="18:00")
        r = self.api("patch", f"/telephony/campaigns/{c['id']}", json={"call_hours_start": "8:15"})
        self.assertEqual(r.status_code, 200, r.text)
        after = self.campaign_row(c["id"])
        self.assertEqual((after["call_hours_start"], after["call_hours_end"], after["call_hours_enabled"]), ("08:15", "18:00", True))

    def test_patch_validates_the_merged_result(self):
        c = self.make_hours_campaign()            # 09:00-17:00
        r = self.api("patch", f"/telephony/campaigns/{c['id']}", json={"call_hours_start": "18:00"})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.campaign_row(c["id"])["call_hours_start"], "09:00")

    def test_switching_off_keeps_the_hours_for_later(self):
        c = self.make_hours_campaign(call_hours_start="10:00")
        self.api("patch", f"/telephony/campaigns/{c['id']}", json={"call_hours_enabled": False})
        after = self.campaign_row(c["id"])
        self.assertEqual((after["call_hours_enabled"], after["call_hours_start"]), (False, "10:00"))

    def test_another_accounts_campaign_is_untouched(self):
        c = self.make_campaign()
        other = H.make_user()
        r = self.api("patch", f"/telephony/campaigns/{c['id']}", user=other, json={"call_hours_enabled": True})
        self.assertEqual(r.status_code, 200)
        self.assertIsNone(r.json()["data"])
        self.assertIs(self.campaign_row(c["id"])["call_hours_enabled"], False)

    def test_the_list_and_the_single_read_carry_the_state(self):
        c = self.make_campaign(**hours_body(C, open_now=False))
        listed = self.api("get", "/telephony/campaigns").json()["data"][0]["call_hours_state"]
        self.assertEqual((listed["enabled"], listed["open"]), (True, False))
        self.assertTrue(listed["next_open_at"].endswith("Z"))
        self.assertTrue(listed["summary"])
        one = self.api("get", f"/telephony/campaigns/{c['id']}").json()["data"]["call_hours_state"]
        self.assertEqual(one["open"], False)
        c2 = self.make_campaign(name="Always", **hours_body(C, open_now=True))
        self.assertTrue(self.api("get", f"/telephony/campaigns/{c2['id']}").json()["data"]["call_hours_state"]["open"])

    def test_a_campaign_without_hours_reports_them_off(self):
        self.make_campaign()
        state = self.api("get", "/telephony/campaigns").json()["data"][0]["call_hours_state"]
        self.assertEqual(state, {"enabled": False, "open": True, "next_open_at": None, "summary": None})


class CampaignStartTests(CampaignBase):
    def test_without_hours_everyone_is_dialed_as_before(self):
        c = self.make_campaign()
        r = self.start(c["id"])
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["data"]["dialed"], 5)
        self.assertNotIn("stopped_by_hours", r.json()["data"])
        self.assertEqual(sorted(self.dialed_numbers()), sorted(c["phone"] for c in self.contacts))
        after = self.campaign_row(c["id"])
        self.assertEqual((after["status"], after["dial_cursor"]), ("Active", None))

    def test_inside_the_hours_it_dials_everyone(self):
        c = self.make_campaign(**hours_body(C, open_now=True))
        r = self.start(c["id"])
        self.assertEqual((r.status_code, r.json()["data"]["dialed"]), (200, 5))

    def test_closed_it_refuses_to_start_and_places_no_call(self):
        c = self.make_campaign(**hours_body(C, open_now=False))
        r = self.start(c["id"])
        self.assertEqual(r.status_code, 400)
        detail = r.json()["detail"]
        self.assertIn("closed right now", detail)
        self.assertIn("opens again", detail)
        self.assertIn("UTC", detail)
        self.create_call.assert_not_awaited()
        self.assertEqual(self.campaign_row(c["id"])["status"], "Inactive")

    def test_switching_the_hours_off_lets_it_start(self):
        c = self.make_campaign(**hours_body(C, open_now=False))
        self.assertEqual(self.start(c["id"]).status_code, 400)
        self.api("patch", f"/telephony/campaigns/{c['id']}", json={"call_hours_enabled": False})
        self.assertEqual(self.start(c["id"]).json()["data"]["dialed"], 5)

    def test_unreadable_stored_hours_count_as_closed(self):
        c = self.make_campaign(**hours_body(C, open_now=True))
        H.sql("UPDATE public.outbound_campaigns SET call_hours_start = 'garbage' WHERE id = %s", (c["id"],))
        self.assertEqual(self.start(c["id"]).status_code, 400)
        self.create_call.assert_not_awaited()


class CampaignStoppedByHoursTests(CampaignBase):
    """The hours close while the run is in progress, then reopen. The clock is frozen at noon UTC on a Wednesday,
    the campaign's hours are 09:00-17:00 every day, and "the hours close mid-run" is the clock jumping to 17:00
    after a chosen number of calls (the dialing engine reads the clock at every call)."""

    NOON = datetime(2026, 10, 14, 12, 0, tzinfo=timezone.utc)
    CLOSING = datetime(2026, 10, 14, 17, 0, tzinfo=timezone.utc)

    def setUp(self):
        super().setUp()
        for target in (call_hours, telephony, dialer, call_retry, campaign_scheduler):
            p = patch.object(target, "datetime", FakeDateTime)
            p.start()
            self.addCleanup(p.stop)
        FakeDateTime.instant = self.NOON
        self._left = None
        inner = self.create_call.side_effect

        async def placing(payload):
            result = inner(payload)
            if self._left is not None:
                self._left -= 1
                if self._left == 0:
                    FakeDateTime.instant = self.CLOSING
            return result
        self.create_call.side_effect = placing

    def window(self, **extra):
        """Hours on, every day 09:00-17:00 UTC."""
        return {C + "enabled": True, C + "timezone": "UTC", C + "days": [0, 1, 2, 3, 4, 5, 6],
                C + "start": "09:00", C + "end": "17:00", **extra}

    def closing_after(self, calls):
        """The clock reaches closing time once `calls` more calls have been placed (it is put back at noon first,
        as if the hours had opened again). None: no jump."""
        FakeDateTime.instant = self.NOON
        self._left = calls

    def test_a_run_that_outlasts_the_hours_stops_and_remembers_where(self):
        c = self.make_campaign(**self.window())
        self.closing_after(4)                  # two groups of two, then it is closing time
        r = self.start(c["id"])
        data = r.json()["data"]
        self.assertEqual((r.status_code, data["dialed"], data["stopped_by_hours"], data["remaining"]), (200, 4, True, 1))
        self.assertEqual(sorted(self.dialed_numbers()), sorted(x["phone"] for x in self.contacts[:4]))
        after = self.campaign_row(c["id"])
        self.assertEqual((after["status"], str(after["dial_cursor"])), ("Paused", self.contacts[3]["id"]))

    def test_starting_again_carries_on_with_the_rest_and_nobody_is_called_twice(self):
        c = self.make_campaign(**self.window())
        self.closing_after(4)
        self.start(c["id"])
        self.closing_after(None)
        r = self.start(c["id"])
        self.assertEqual((r.status_code, r.json()["data"]["dialed"]), (200, 1))
        numbers = self.dialed_numbers()
        self.assertEqual(len(numbers), 5)
        self.assertEqual(len(set(numbers)), 5)                      # exactly once each
        after = self.campaign_row(c["id"])
        self.assertEqual((after["status"], after["dial_cursor"]), ("Active", None))

    def test_resume_does_the_same_as_start_for_a_stopped_run(self):
        c = self.make_campaign(**self.window())
        self.closing_after(4)
        self.start(c["id"])
        self.closing_after(None)
        r = self.api("post", f"/telephony/campaigns/{c['id']}/resume")
        self.assertEqual((r.status_code, r.json()["data"]["dialed"]), (200, 1))
        self.assertEqual(len(set(self.dialed_numbers())), 5)

    def test_resume_without_a_stopped_run_places_no_calls_as_before(self):
        c = self.make_campaign()
        r = self.api("post", f"/telephony/campaigns/{c['id']}/resume")
        self.assertEqual(r.json()["data"], {"status": "Active"})
        self.create_call.assert_not_awaited()

    def test_a_stopped_run_will_not_start_while_still_closed(self):
        c = self.make_campaign(**self.window())
        self.closing_after(4)
        self.start(c["id"])
        self.closing_after(None)               # the clock is back inside the window; the hours are then edited shut
        closed_day = (self.NOON.weekday() + 3) % 7
        self.api("patch", f"/telephony/campaigns/{c['id']}", json=self.window(**{C + "days": [closed_day]}))
        before = self.create_call.await_count
        self.assertEqual(self.start(c["id"]).status_code, 400)
        self.assertEqual(self.api("post", f"/telephony/campaigns/{c['id']}/resume").status_code, 400)
        self.assertEqual(self.create_call.await_count, before)
        self.assertIsNotNone(self.campaign_row(c["id"])["dial_cursor"])        # the place is kept

    def test_closing_before_the_first_call_leaves_the_campaign_as_it_was(self):
        c = self.make_campaign(**self.window())
        self.closing_after(None)
        check = telephony._raise_if_closed

        def closes_right_after_the_check(camp):
            check(camp)                        # Start's own check still sees it open ...
            FakeDateTime.instant = self.CLOSING        # ... and the clock reaches closing time before the first call
        with patch.object(telephony, "_raise_if_closed", closes_right_after_the_check):
            r = self.start(c["id"])
        data = r.json()["data"]
        self.assertEqual((data["dialed"], data["stopped_by_hours"], data["remaining"]), (0, True, 5))
        after = self.campaign_row(c["id"])
        self.assertEqual((after["status"], after["dial_cursor"]), ("Inactive", None))
        self.create_call.assert_not_awaited()

    def test_a_stop_after_a_resume_moves_the_place_forward(self):
        c = self.make_campaign(**self.window())
        self.closing_after(2)                  # one group of two
        self.start(c["id"])
        self.assertEqual(str(self.campaign_row(c["id"])["dial_cursor"]), self.contacts[1]["id"])
        self.closing_after(2)                  # again one group (contacts 2 and 3)
        self.start(c["id"])
        self.assertEqual(str(self.campaign_row(c["id"])["dial_cursor"]), self.contacts[3]["id"])
        self.closing_after(None)
        self.start(c["id"])
        self.assertEqual(len(self.dialed_numbers()), 5)
        self.assertEqual(len(set(self.dialed_numbers())), 5)

    def test_when_nothing_is_left_after_the_place_it_says_so_and_forgets_it(self):
        c = self.make_campaign(**self.window())
        # a pass parked at its last contact (the place is the last contact in dial order, contacts.seq)
        H.sql("UPDATE public.outbound_campaigns SET dial_cursor = %s, dial_seq = %s, dial_running = true, status = 'Paused' WHERE id = %s",
              (self.contacts[-1]["id"], self.contacts[-1]["seq"], c["id"]))
        r = self.start(c["id"])
        self.assertEqual(r.status_code, 400)
        self.assertIn("already been dialed", r.json()["detail"])
        self.create_call.assert_not_awaited()
        after = self.campaign_row(c["id"])
        self.assertEqual((after["status"], after["dial_cursor"]), ("Inactive", None))
        # ...so the next start dials the whole list again
        self.assertEqual(self.start(c["id"]).json()["data"]["dialed"], 5)

    def test_changing_the_list_forgets_the_place(self):
        c = self.make_campaign(**self.window())
        self.closing_after(4)
        self.start(c["id"])
        other = supabase.table("lists").insert({"user_id": self.user, "name": "Other"}).execute().data[0]
        self.add_contacts(other["id"], 1)
        self.api("patch", f"/telephony/campaigns/{c['id']}", json={"list_id": other["id"]})
        self.assertIsNone(self.campaign_row(c["id"])["dial_cursor"])

    def test_resending_the_same_list_keeps_the_place(self):
        c = self.make_campaign(**self.window())
        self.closing_after(4)
        self.start(c["id"])
        self.api("patch", f"/telephony/campaigns/{c['id']}", json={"list_id": self.list["id"], "name": "Renamed"})
        self.assertIsNotNone(self.campaign_row(c["id"])["dial_cursor"])

    def test_contacts_added_after_the_place_are_picked_up_and_earlier_ones_are_not_repeated(self):
        c = self.make_campaign(**self.window())
        self.closing_after(4)
        self.start(c["id"])
        late = self.add_contacts(self.list["id"], 2)
        self.closing_after(None)
        self.start(c["id"])
        numbers = self.dialed_numbers()
        self.assertEqual(len(numbers), len(set(numbers)))            # nobody twice, whatever their id sorts to
        self.assertIn(self.contacts[4]["phone"], numbers)             # the one that was left
        self.assertTrue({x["phone"] for x in late} <= set(numbers), "contacts added after the place are dialed too")


# ═══════════════════════════════════════════════════════════════════════════
# Inbound: a number's answering hours
# ═══════════════════════════════════════════════════════════════════════════


class NumberHoursBase(Base):
    def setUp(self):
        super().setUp()
        self.agent = make_agent(self.user)
        self.num = make_number(self.user, agent=self.agent)
        # Sweeps (startup re-sync) scan every account: never leave hours switched on behind.
        self.addCleanup(lambda: H.sql("UPDATE public.phone_numbers SET answer_hours_enabled = false, "
                                      "caller_verification_enabled = false"))

    def pushed(self, number=None):
        number = number or self.num
        return [c.args[1] for c in self.vapi.update_phone_number.await_args_list if c.args[0] == number["vapi_phone_id"]]

    def set_hours(self, number=None, open_now=True, **extra):
        number = number or self.num
        r = self.patch_number(number["id"], hours_body(N, open_now, **extra))
        self.assertEqual(r.status_code, 200, r.text)
        return r


class NumberHoursSettingsTests(NumberHoursBase):
    def test_a_number_starts_with_no_limit(self):
        row_ = number_row(self.num["id"])
        self.assertEqual((row_["answer_hours_enabled"], row_["answer_hours_timezone"], row_["answer_hours_days"],
                          row_["answer_hours_start"], row_["answer_hours_end"]), (False, None, [0, 1, 2, 3, 4], "09:00", "17:00"))

    def test_switching_on_routes_the_number_through_this_server(self):
        self.set_hours()
        self.assertIs(number_row(self.num["id"])["answer_hours_enabled"], True)
        (payload,) = self.pushed()
        self.assertEqual(payload, {"assistantId": None, "server": cv.routing_server_block()})

    def test_the_lookup_credentials_are_not_needed(self):
        patch_settings(self, caller_lookup_code="", caller_lookup_api_key="")
        self.set_hours()          # asserts 200

    def test_switching_off_gives_the_number_its_agent_back(self):
        self.set_hours()
        self.vapi.update_phone_number.reset_mock()
        r = self.patch_number(self.num["id"], {"answer_hours_enabled": False})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.pushed(), [{"assistantId": self.agent["vapi_assistant_id"]}])
        self.assertIs(number_row(self.num["id"])["answer_hours_enabled"], False)

    def test_changing_only_the_hours_does_not_touch_the_voice_service(self):
        self.set_hours()
        self.vapi.update_phone_number.reset_mock()
        r = self.patch_number(self.num["id"], {"answer_hours_start": "8:00", "answer_hours_end": "18:30"})
        self.assertEqual(r.status_code, 200, r.text)
        self.vapi.update_phone_number.assert_not_awaited()
        row_ = number_row(self.num["id"])
        self.assertEqual((row_["answer_hours_start"], row_["answer_hours_end"]), ("08:00", "18:30"))

    def test_hours_can_be_prepared_while_switched_off_without_any_routing_change(self):
        r = self.patch_number(self.num["id"], {"answer_hours_days": [1, 3], "answer_hours_timezone": "est"})
        self.assertEqual(r.status_code, 200, r.text)
        self.vapi.update_phone_number.assert_not_awaited()
        row_ = number_row(self.num["id"])
        self.assertEqual((row_["answer_hours_enabled"], row_["answer_hours_days"], row_["answer_hours_timezone"]),
                         (False, [1, 3], "America/New_York"))

    def test_switching_on_without_a_time_zone_is_refused_and_nothing_is_pushed(self):
        r = self.patch_number(self.num["id"], {"answer_hours_enabled": True})
        self.assertEqual((r.status_code, r.json()["detail"]), (400, "Select a time zone."))
        self.assertIs(number_row(self.num["id"])["answer_hours_enabled"], False)
        self.vapi.update_phone_number.assert_not_awaited()
        r = self.patch_number(self.num["id"], {"answer_hours_enabled": True, "answer_hours_timezone": "Asia/Tokyo"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(number_row(self.num["id"])["answer_hours_timezone"], "Asia/Tokyo")

    def test_invalid_hours_are_refused_and_nothing_changes(self):
        for body in ({"answer_hours_enabled": True, "answer_hours_start": "18:00", "answer_hours_end": "09:00"},
                     {"answer_hours_enabled": True, "answer_hours_days": []},
                     {"answer_hours_enabled": True, "answer_hours_timezone": "No/Where"},
                     {"answer_hours_start": "ab:cd"}):
            with self.subTest(body=body):
                r = self.patch_number(self.num["id"], body)
                self.assertEqual(r.status_code, 400, r.text)
        self.assertIs(number_row(self.num["id"])["answer_hours_enabled"], False)
        self.vapi.update_phone_number.assert_not_awaited()

    def test_a_non_boolean_switch_is_rejected(self):
        self.assertEqual(self.patch_number(self.num["id"], {"answer_hours_enabled": "yes"}).status_code, 422)

    def test_it_needs_a_number_that_is_connected_to_the_voice_service(self):
        bare = make_number(self.user, agent=self.agent, vapi_phone_id=None)
        r = self.patch_number(bare["id"], hours_body(N, True))
        self.assertEqual(r.status_code, 400)
        self.assertIs(number_row(bare["id"])["answer_hours_enabled"], False)

    def test_it_is_refused_when_the_server_cannot_be_reached_by_the_voice_service(self):
        patch_settings(self, public_api_url="")
        with self.assertLogs(telephony.logger, "WARNING") as logs:
            r = self.patch_number(self.num["id"], hours_body(N, True))
        self.assertEqual(r.status_code, 503)
        self.assertIn("PUBLIC_API_URL", "\n".join(logs.output))
        for word in ("PUBLIC_API_URL", "VAPI"):
            self.assertNotIn(word, r.json()["detail"])
        self.assertIs(number_row(self.num["id"])["answer_hours_enabled"], False)
        self.vapi.update_phone_number.assert_not_awaited()

    def test_it_is_refused_when_the_reachability_check_fails(self):
        self.reachable.return_value = (False, "http_405")
        r = self.patch_number(self.num["id"], hours_body(N, True))
        self.assertEqual(r.status_code, 503)
        self.assertIs(number_row(self.num["id"])["answer_hours_enabled"], False)
        self.vapi.update_phone_number.assert_not_awaited()

    def test_a_voice_service_failure_leaves_the_number_as_it_was(self):
        self.vapi.update_phone_number.side_effect = RuntimeError("boom")
        r = self.patch_number(self.num["id"], hours_body(N, True))
        self.assertEqual(r.status_code, 502)
        self.assertIs(number_row(self.num["id"])["answer_hours_enabled"], False)

    def test_someone_elses_number_is_not_found(self):
        other = H.make_user()
        r = self.patch_number(self.num["id"], hours_body(N, True), user=other)
        self.assertEqual(r.status_code, 404)
        self.assertIs(number_row(self.num["id"])["answer_hours_enabled"], False)

    def test_the_list_carries_each_numbers_state(self):
        self.set_hours(open_now=False)
        rows = {r["id"]: r for r in self.get_numbers()}
        state = rows[self.num["id"]]["answer_hours_state"]
        self.assertEqual((state["enabled"], state["open"]), (True, False))
        self.assertTrue(state["next_open_at"])
        plain = make_number(self.user)
        self.assertEqual(self.get_numbers_by_id()[plain["id"]]["answer_hours_state"]["enabled"], False)

    def get_numbers(self):
        return H.client.get("/telephony/phone-numbers", headers=H.auth(self.user)).json()["data"]

    def get_numbers_by_id(self):
        return {r["id"]: r for r in self.get_numbers()}

    def test_the_status_endpoint_says_whether_the_server_can_do_it(self):
        r = H.client.get("/telephony/answer-hours/status", headers=H.auth(self.user))
        self.assertEqual(r.json()["data"], {"available": True, "reason": None})
        patch_settings(self, public_api_url="")
        data = H.client.get("/telephony/answer-hours/status", headers=H.auth(self.user)).json()["data"]
        self.assertEqual((data["available"], data["reason"]), (False, cv.HOURS_UNAVAILABLE_REASON))
        patch_settings(self, public_api_url="https://qa.example.test", vapi_api_key="")
        self.assertFalse(H.client.get("/telephony/answer-hours/status", headers=H.auth(self.user)).json()["data"]["available"])


class HoursWithVerificationTests(NumberHoursBase):
    def test_switching_hours_off_while_verification_stays_on_leaves_the_routing_alone(self):
        self.patch_number(self.num["id"], {"caller_verification_enabled": True})
        self.set_hours()
        self.vapi.update_phone_number.reset_mock()
        r = self.patch_number(self.num["id"], {"answer_hours_enabled": False})
        self.assertEqual(r.status_code, 200, r.text)
        self.vapi.update_phone_number.assert_not_awaited()
        self.assertIs(number_row(self.num["id"])["caller_verification_enabled"], True)

    def test_switching_verification_off_while_hours_stay_on_leaves_the_routing_alone(self):
        self.patch_number(self.num["id"], {"caller_verification_enabled": True})
        self.set_hours()
        self.vapi.update_phone_number.reset_mock()
        r = self.patch_number(self.num["id"], {"caller_verification_enabled": False})
        self.assertEqual(r.status_code, 200, r.text)
        self.vapi.update_phone_number.assert_not_awaited()
        self.assertIs(number_row(self.num["id"])["answer_hours_enabled"], True)

    def test_an_hours_setting_sent_with_a_verification_switch_is_not_mistaken_for_switching_hours_on(self):
        self.patch_number(self.num["id"], {"caller_verification_enabled": True})
        self.set_hours()
        self.vapi.update_phone_number.reset_mock()
        r = self.patch_number(self.num["id"], {"caller_verification_enabled": False, "answer_hours_start": "08:00"})
        self.assertEqual(r.status_code, 200, r.text)
        self.vapi.update_phone_number.assert_not_awaited()          # still routed by the hours, nothing to push
        row_ = number_row(self.num["id"])
        self.assertEqual((row_["caller_verification_enabled"], row_["answer_hours_enabled"], row_["answer_hours_start"]),
                         (False, True, "08:00"))

    def test_switching_both_off_gives_the_agent_back_only_at_the_end(self):
        self.patch_number(self.num["id"], {"caller_verification_enabled": True})
        self.set_hours()
        self.patch_number(self.num["id"], {"answer_hours_enabled": False})
        self.vapi.update_phone_number.reset_mock()
        self.patch_number(self.num["id"], {"caller_verification_enabled": False})
        self.assertEqual(self.pushed(), [{"assistantId": self.agent["vapi_assistant_id"]}])

    def test_verification_still_needs_its_own_credentials(self):
        self.set_hours()
        patch_settings(self, caller_lookup_code="", caller_lookup_api_key="")
        r = self.patch_number(self.num["id"], {"caller_verification_enabled": True})
        self.assertEqual(r.status_code, 503)


class NumberHoursRoutingTests(NumberHoursBase):
    """Every other path that writes a number's assistant leaves an hours-routed number alone."""

    def test_an_agent_change_on_the_number_is_database_only(self):
        self.set_hours()
        second = make_agent(self.user, "Second")
        self.vapi.update_phone_number.reset_mock()
        r = self.patch_number(self.num["id"], {"agent_id": second["id"]})
        self.assertEqual(r.status_code, 200, r.text)
        self.vapi.update_phone_number.assert_not_awaited()
        self.assertEqual(str(number_row(self.num["id"])["agent_id"]), second["id"])

    def test_a_balance_suspension_only_flips_the_flag(self):
        self.set_hours()
        self.vapi.update_phone_number.reset_mock()
        run(telephony.sync_inbound_routing_for_balance(self.user, True))
        self.vapi.update_phone_number.assert_not_awaited()
        self.assertIs(number_row(self.num["id"])["suspended_for_balance"], True)
        run(telephony.sync_inbound_routing_for_balance(self.user, False))
        self.vapi.update_phone_number.assert_not_awaited()
        self.assertIs(number_row(self.num["id"])["suspended_for_balance"], False)

    def test_creating_a_receptionist_on_the_number_is_database_only(self):
        self.set_hours()
        second = make_agent(self.user, "Front desk")
        self.vapi.update_phone_number.reset_mock()
        r = H.client.post("/telephony/inbound", headers=H.auth(self.user),
                          json={"name": "Desk", "agent_id": second["id"], "phone_number_id": self.num["id"]})
        self.assertEqual(r.status_code, 200, r.text)
        self.vapi.update_phone_number.assert_not_awaited()
        self.assertEqual(str(number_row(self.num["id"])["agent_id"]), second["id"])

    def test_updating_and_deleting_the_receptionist_do_not_touch_the_voice_service(self):
        third = make_agent(self.user, "Third")
        q = H.client.post("/telephony/inbound", headers=H.auth(self.user),
                          json={"name": "Desk", "agent_id": self.agent["id"], "phone_number_id": self.num["id"]}).json()["data"]
        self.set_hours()
        self.vapi.update_phone_number.reset_mock()
        r = H.client.patch(f"/telephony/inbound/{q['id']}", headers=H.auth(self.user), json={"agent_id": third["id"]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(H.client.delete(f"/telephony/inbound/{q['id']}", headers=H.auth(self.user)).status_code, 200)
        self.vapi.update_phone_number.assert_not_awaited()
        self.assertIsNone(number_row(self.num["id"])["agent_id"])

    def test_the_startup_re_sync_repoints_hours_numbers_too(self):
        H.sql("UPDATE public.phone_numbers SET caller_verification_enabled = false, answer_hours_enabled = false")
        a = make_number(self.user, agent=self.agent)
        self.set_hours(a)
        b = make_number(self.user, agent=self.agent, verify=True)
        plain = make_number(self.user, agent=self.agent)
        self.vapi.update_phone_number.reset_mock()
        result = run(cv.reconcile_verified_routing(retry_delays=(0,)))
        self.assertEqual(result, {"repointed": 2, "failed": 0, "unchanged": 0})
        pushed_ids = {c.args[0] for c in self.vapi.update_phone_number.await_args_list}
        self.assertEqual(pushed_ids, {a["vapi_phone_id"], b["vapi_phone_id"]})
        self.assertNotIn(plain["vapi_phone_id"], pushed_ids)


class NumberHoursDecisionTests(NumberHoursBase):
    """What the caller gets, per call."""

    def test_open_the_agent_answers_and_the_call_is_recorded_for_billing(self):
        self.set_hours(open_now=True)
        call_id = f"call-{uuid.uuid4().hex[:8]}"
        answer = self.answer(self.num["vapi_phone_id"], call_id=call_id)
        self.assertEqual(answer, {"assistantId": self.agent["vapi_assistant_id"]})
        (rec,) = screenings(self.user, vapi_call_id=call_id)
        self.assertEqual((rec["decision"], rec["reason"], str(rec["agent_id"])), ("answered", "within_hours", self.agent["id"]))
        self.assertEqual(cv.answered_calls([call_id])[call_id]["agent_id"], self.agent["id"])
        self.assertEqual(self.lookup.calls, [])                 # verification is off: no lookup

    def test_closed_the_caller_is_told_so_and_the_agent_never_starts(self):
        self.set_hours(open_now=False)
        call_id = f"call-{uuid.uuid4().hex[:8]}"
        answer = self.answer(self.num["vapi_phone_id"], call_id=call_id)
        self.assertEqual(answer, {"error": cv.CLOSED_MESSAGE})
        (rec,) = screenings(self.user, vapi_call_id=call_id)
        self.assertEqual((rec["decision"], rec["reason"], rec["agent_id"]), ("refused", "outside_hours", None))
        # a refused call is never attributed (so never logged or billed)
        self.assertEqual(cv.answered_calls([call_id]), {})
        self.assertEqual(self.lookup.calls, [])

    def test_the_message_is_one_short_sentence_and_does_not_blame_the_caller(self):
        self.assertLess(len(cv.CLOSED_MESSAGE), 100)
        self.assertIn("closed", cv.CLOSED_MESSAGE)
        self.assertNotIn("VAPI", cv.CLOSED_MESSAGE)

    def test_switching_hours_off_answers_around_the_clock_again(self):
        self.set_hours(open_now=False)
        self.patch_number(self.num["id"], {"answer_hours_enabled": False})
        self.assertEqual(self.answer(self.num["vapi_phone_id"]), {"assistantId": self.agent["vapi_assistant_id"]})

    def test_a_number_without_hours_is_unchanged_and_writes_no_record(self):
        # VAPI still asks us (e.g. a half-finished toggle): the agent answers, unrecorded, as before.
        call_id = f"call-{uuid.uuid4().hex[:8]}"
        self.assertEqual(self.answer(self.num["vapi_phone_id"], call_id=call_id), {"assistantId": self.agent["vapi_assistant_id"]})
        self.assertEqual(screenings(self.user, vapi_call_id=call_id), [])

    def test_closed_beats_everything_else_including_verification(self):
        self.patch_number(self.num["id"], {"caller_verification_enabled": True})
        self.set_hours(open_now=False)
        self.assertEqual(self.answer(self.num["vapi_phone_id"]), {"error": cv.CLOSED_MESSAGE})
        self.assertEqual(self.lookup.calls, [])                 # nobody is looked up while closed

    def test_open_with_verification_the_caller_is_still_checked(self):
        self.patch_number(self.num["id"], {"caller_verification_enabled": True})
        self.set_hours(open_now=True)
        self.assertEqual(self.answer(self.num["vapi_phone_id"]), {"assistantId": self.agent["vapi_assistant_id"]})
        self.assertEqual(len(self.lookup.calls), 1)

    def test_open_with_verification_a_refused_caller_is_still_refused(self):
        from test_caller_verification import VOIP
        self.lookup.default = VOIP
        self.patch_number(self.num["id"], {"caller_verification_enabled": True})
        self.set_hours(open_now=True)
        self.assertEqual(self.answer(self.num["vapi_phone_id"]), {"error": cv.REFUSAL_MESSAGE})

    def test_open_but_no_agent_assigned(self):
        bare = make_number(self.user)
        self.set_hours(bare)
        self.assertEqual(self.answer(bare["vapi_phone_id"]), {"error": cv.UNAVAILABLE_MESSAGE})

    def test_open_but_balance_suspended_serves_the_fallback_assistant(self):
        self.set_hours(open_now=True)
        run(telephony.sync_inbound_routing_for_balance(self.user, True))
        answer = self.answer(self.num["vapi_phone_id"])
        self.assertIn("assistantId", answer)
        self.assertNotEqual(answer["assistantId"], self.agent["vapi_assistant_id"])

    def test_closed_and_suspended_says_closed(self):
        self.set_hours(open_now=False)
        run(telephony.sync_inbound_routing_for_balance(self.user, True))
        self.assertEqual(self.answer(self.num["vapi_phone_id"]), {"error": cv.CLOSED_MESSAGE})

    def test_the_error_path_does_not_answer_a_closed_line(self):
        self.set_hours(open_now=False)
        with patch.object(cv, "_decide", side_effect=RuntimeError("db blip")), self.assertLogs(cv.logger, "ERROR"):
            answer = self.answer(self.num["vapi_phone_id"])
        self.assertEqual(answer, {"error": cv.CLOSED_MESSAGE})

    def test_the_error_path_still_fails_open_when_the_line_is_open(self):
        self.set_hours(open_now=True)
        with patch.object(cv, "_decide", side_effect=RuntimeError("db blip")), self.assertLogs(cv.logger, "ERROR"):
            answer = self.answer(self.num["vapi_phone_id"])
        self.assertEqual(answer, {"assistantId": self.agent["vapi_assistant_id"]})

    def test_unreadable_stored_hours_leave_the_line_open(self):
        self.set_hours(open_now=True)          # every day, so the damaged time is really read
        H.sql("UPDATE public.phone_numbers SET answer_hours_start = 'garbage' WHERE id = %s", (self.num["id"],))
        self.assertEqual(self.answer(self.num["vapi_phone_id"]), {"assistantId": self.agent["vapi_assistant_id"]})

    def test_an_unknown_number_is_unavailable(self):
        self.assertEqual(self.answer("vpn-unknown"), {"error": cv.UNAVAILABLE_MESSAGE})

    def test_hours_are_read_in_the_numbers_own_timezone(self):
        # Closed because of the DAY in the number's zone, even though it is open in UTC.
        r = self.patch_number(self.num["id"], {
            "answer_hours_enabled": True, "answer_hours_timezone": "Pacific/Kiritimati",     # UTC+14
            "answer_hours_days": [(datetime.now(timezone.utc).astimezone(__import__("zoneinfo").ZoneInfo("Pacific/Kiritimati")).weekday() + 3) % 7],
            "answer_hours_start": "00:00", "answer_hours_end": "00:00"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.answer(self.num["vapi_phone_id"]), {"error": cv.CLOSED_MESSAGE})


if __name__ == "__main__":
    unittest.main()
