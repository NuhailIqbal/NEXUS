import asyncio
import re
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from zoneinfo import ZoneInfo

import qa_harness as h
from qa_harness import client, auth
from database import supabase
from config import settings
from services import calendar_service as cal
from fake_google import FakeGoogle

TZ = "Asia/Karachi"
ZONE = ZoneInfo(TZ)


def workday(days_ahead=4, hour=10, minute=0):
    """A local time on a weekday at least `days_ahead` days from now, in the account timezone."""
    d = datetime.now(ZONE).date() + timedelta(days=days_ahead)
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return datetime(d.year, d.month, d.day, hour, minute, tzinfo=ZONE)


def weekend(days_ahead=4):
    d = datetime.now(ZONE).date() + timedelta(days=days_ahead)
    while d.weekday() != 5:
        d += timedelta(days=1)
    return datetime(d.year, d.month, d.day, 10, 0, tzinfo=ZONE)


def iso(dt):
    return dt.isoformat(timespec="seconds")


def zulu(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Base(unittest.TestCase):
    def setUp(self):
        h.reset_rate_limits()
        self.g = FakeGoogle().start()
        self.vapi = h.VapiMock().start()
        cal._token_cache.clear()
        self.user = h.make_user()
        self.patches = [patch.object(settings, "google_client_id", "cid"), patch.object(settings, "google_client_secret", "sec")]
        for p in self.patches:
            p.start()
        self.agent = h.create_agent_via_api(self.user, name="Cal Agent", selected_tool_keys=["check_availability", "book_slot"])
        self.asst = self.agent["vapi_assistant_id"]
        self.call = f"call-{h.uuid.uuid4().hex[:8]}"
        self._tc = 0

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.vapi.stop()
        self.g.stop()

    def connect(self, user=None, **settings_changes):
        uid = user or self.user
        cal.save_connection(uid, "rt-good", "owner@gmail.com", TZ)
        if settings_changes:
            cal.update_settings(uid, settings_changes)

    def post(self, path, args, asst=None, call=None, tcid=None):
        self._tc += 1
        body = h.tool_call_body(asst or self.asst, call or self.call, [(tcid or f"tc-{self._tc}", args)])
        r = client.post(f"/tools/internal/{path}", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["results"][0]["result"]

    def check(self, **args):
        return self.post("check-availability", args)

    def book(self, **args):
        return self.post("book-slot", args)

    def bookings(self):
        return supabase.table("calendar_bookings").select("*").eq("user_id", self.user).execute().data


class CheckAvailability(Base):
    def test_T01_not_connected(self):
        self.assertIn("No calendar is connected", self.check())

    def test_T02_needs_reconnect_short_circuits_without_calling_google(self):
        self.connect()
        supabase.table("calendar_connections").update({"status": "reauth_required"}).eq("user_id", self.user).execute()
        self.assertIn("needs to be reconnected", self.check())
        self.assertEqual(self.g.requests, [])

    def test_T03_lists_free_times_with_the_iso_the_agent_must_book(self):
        self.connect()
        day = workday()
        text = self.check(date=day.date().isoformat(), days=1)
        self.assertIn(TZ, text)
        self.assertRegex(text, r"start_iso \d{4}-\d\d-\d\dT09:00:00\+05:00")
        self.assertEqual(len(re.findall(r"-> start_iso", text)), cal.SLOTS_PER_DAY)

    def test_T04_busy_times_are_left_out(self):
        self.connect()
        day = workday()
        self.g.busy = [(zulu(day.replace(hour=9)), zulu(day.replace(hour=11)))]
        text = self.check(date=day.date().isoformat(), days=1)
        self.assertNotIn("T09:00:00", text)
        self.assertNotIn("T10:30:00", text)
        self.assertIn("T11:00:00+05:00", text)

    def test_T05_fully_booked_day_says_so(self):
        self.connect()
        day = workday()
        self.g.busy = [(zulu(day.replace(hour=0)), zulu(day.replace(hour=0) + timedelta(days=1)))]
        self.assertIn("no free", self.check(date=day.date().isoformat(), days=1))

    def test_T06_past_date_starts_from_today(self):
        self.connect(min_notice_hours=0)
        text = self.check(date="2001-01-01", days=2)
        years = set(re.findall(r"start_iso (\d{4})", text))
        self.assertTrue(years <= {str(datetime.now(ZONE).year), str(datetime.now(ZONE).year + 1)})

    def test_T07_bad_inputs_get_a_spoken_error_not_a_crash(self):
        self.connect()
        self.assertIn("couldn't understand that date", self.check(date="next tuesday-ish"))
        self.assertIn("number of days", self.check(days="many"))
        self.assertIn("between 10 and 240", self.check(duration_minutes=5))
        self.assertIn("between 10 and 240", self.check(duration_minutes=9999))

    def test_T08_days_are_clamped_to_a_week(self):
        self.connect(max_days_ahead=90)
        dates = set(re.findall(r"start_iso (\d{4}-\d\d-\d\d)", self.check(days=500)))
        self.assertLessEqual(len(dates), 7)

    def test_T09_google_outage_is_handled(self):
        self.connect()
        self.g.fail_freebusy = 500
        self.assertIn("couldn't reach the calendar", self.check())

    def test_T10_revoked_access_flags_the_connection(self):
        self.connect()
        supabase.table("calendar_connections").update({"refresh_token_encrypted": cal.encrypt_config({"refresh_token": "rt-revoked"})}).eq("user_id", self.user).execute()
        self.assertIn("needs to be reconnected", self.check())
        self.assertEqual(cal.get_connection(self.user)["status"], "reauth_required")
        before = len(self.g.requests)
        self.assertIn("needs to be reconnected", self.check())
        self.assertEqual(len(self.g.requests), before)

    def test_T11_google_401_on_freebusy_is_a_reauth(self):
        self.connect()
        self.g.fail_freebusy = 401
        self.assertIn("needs to be reconnected", self.check())

    def test_T12_access_token_is_cached_between_calls(self):
        self.connect()
        self.check()
        self.check()
        self.assertEqual(self.g.refresh_calls, 1)

    def test_T13_calendar_errors_from_google_body_are_handled(self):
        self.connect()
        self.g.freebusy_errors = [{"domain": "global", "reason": "notFound"}]
        self.assertIn("couldn't reach the calendar", self.check())

    def test_T14_one_accounts_agent_never_reads_anothers_calendar(self):
        other = h.make_user()
        self.connect(user=other)                      # only the OTHER account has a calendar
        self.assertIn("No calendar is connected", self.check())
        self.assertEqual(self.g.requests, [])

    def test_T15_unknown_assistant(self):
        self.connect()
        self.assertIn("could not identify", self.post("check-availability", {}, asst="asst-nope"))

    def test_T16_uses_account_working_hours(self):
        self.connect(start_time="13:00", end_time="15:00")
        text = self.check(date=workday().date().isoformat(), days=1)
        times = re.findall(r"T(\d\d):\d\d:00\+05:00", text)
        self.assertTrue(times and all("13" <= t <= "14" for t in times))

    def test_T17_duration_changes_which_slots_fit(self):
        self.connect(start_time="09:00", end_time="10:00")
        text = self.check(date=workday().date().isoformat(), days=1, duration_minutes=60)
        self.assertEqual(len(re.findall("-> start_iso", text)), 1)


class BookSlot(Base):
    def setUp(self):
        super().setUp()
        self.connect()
        self.start = workday()

    def args(self, **kw):
        return {"contact_name": "Ali Khan", "contact_email": "ali@example.com", "start_iso": iso(self.start), **kw}

    def test_T20_books_the_event_and_records_it(self):
        text = self.book(**self.args(notes="Wants a demo"))
        self.assertIn("Booked for", text)
        self.assertIn("ali@example.com", text)
        ev = self.g.events[0]
        self.assertEqual(ev["summary"], "Meeting with Ali Khan")
        self.assertEqual(ev["start"], {"dateTime": iso(self.start), "timeZone": TZ})
        self.assertEqual(ev["end"]["dateTime"], iso(self.start + timedelta(minutes=30)))
        self.assertEqual(ev["attendees"], [{"email": "ali@example.com"}])
        self.assertIn("Wants a demo", ev["description"])
        self.assertIn("Cal Agent", ev["description"])
        self.assertEqual(self.g.event_params[0]["sendUpdates"], "all")
        row = self.bookings()[0]
        self.assertEqual((row["agent_id"], row["vapi_call_id"], row["attendee_email"], row["event_id"]),
                         (self.agent["id"], self.call, "ali@example.com", "evt1"))

    def test_T21_without_an_email_no_invite_is_sent(self):
        text = self.book(**self.args(contact_email=None))
        self.assertIn("No email was given", text)
        self.assertNotIn("attendees", self.g.events[0])
        self.assertEqual(self.g.event_params[0]["sendUpdates"], "none")

    def test_T22_a_malformed_email_is_ignored_not_fatal(self):
        text = self.book(**self.args(contact_email="not-an-email"))
        self.assertIn("Booked for", text)
        self.assertNotIn("attendees", self.g.events[0])

    def test_T23_unparseable_time(self):
        for bad in ("tomorrow at 3", "", None, "2026-13-45T99:00"):
            self.assertIn("couldn't understand that start time", self.book(**self.args(start_iso=bad)), repr(bad))
        self.assertEqual(self.g.events, [])

    def test_T24_a_time_without_an_offset_means_the_account_timezone(self):
        self.book(**self.args(start_iso=self.start.replace(tzinfo=None).isoformat(timespec="seconds")))
        self.assertTrue(self.g.events[0]["start"]["dateTime"].endswith("+05:00"))

    def test_T25_zulu_time_is_converted_to_the_account_timezone(self):
        self.book(**self.args(start_iso=zulu(self.start)))
        self.assertEqual(self.g.events[0]["start"]["dateTime"], iso(self.start))

    def test_T26_too_soon_too_far_past(self):
        soon = datetime.now(ZONE) + timedelta(minutes=30)
        self.assertIn("too soon", self.book(**self.args(start_iso=iso(soon))))
        self.assertIn("too soon", self.book(**self.args(start_iso="2001-01-01T10:00:00+05:00")))
        far = datetime.now(ZONE) + timedelta(days=200)
        self.assertIn("too far ahead", self.book(**self.args(start_iso=iso(far))))
        self.assertEqual(self.g.events, [])

    def test_T27_outside_working_hours_and_weekends(self):
        for t in (self.start.replace(hour=8, minute=59), self.start.replace(hour=16, minute=45), self.start.replace(hour=22), weekend()):
            self.assertIn("outside working hours", self.book(**self.args(start_iso=iso(t))), iso(t))
        self.assertEqual(self.g.events, [])

    def test_T28_the_last_fitting_slot_is_bookable(self):
        self.assertIn("Booked for", self.book(**self.args(start_iso=iso(self.start.replace(hour=16, minute=30)))))

    def test_T29_a_taken_slot_is_refused_with_alternatives(self):
        self.g.busy = [(zulu(self.start), zulu(self.start + timedelta(minutes=30)))]
        text = self.book(**self.args())
        self.assertIn("just taken", text)
        self.assertIn("start_iso", text)
        self.assertEqual(self.g.events, [])
        self.assertEqual(self.bookings(), [])

    def test_T30_overlap_by_one_minute_is_a_conflict(self):
        self.g.busy = [(zulu(self.start - timedelta(minutes=30)), zulu(self.start + timedelta(minutes=1)))]
        self.assertIn("just taken", self.book(**self.args()))

    def test_T31_a_retry_of_the_same_tool_call_books_once(self):
        first = self.book_with_id("same-id")
        again = self.book_with_id("same-id")
        self.assertEqual(first, again)
        self.assertEqual(len(self.g.events), 1)
        self.assertEqual(len(self.bookings()), 1)

    def book_with_id(self, tcid):
        return self.post("book-slot", self.args(), tcid=tcid)

    def test_T32_distinct_tool_calls_make_distinct_events(self):
        self.book(**self.args())
        self.book(**self.args(start_iso=iso(self.start.replace(hour=14))))
        self.assertEqual(len(self.g.events), 2)

    def test_T33_same_tool_call_id_on_another_call_is_a_new_booking(self):
        self.post("book-slot", self.args(), call="call-A", tcid="t1")
        self.post("book-slot", self.args(start_iso=iso(self.start.replace(hour=14))), call="call-B", tcid="t1")
        self.assertEqual(len(self.g.events), 2)

    def test_T34_google_failure_books_nothing(self):
        self.g.fail_create = 500
        self.assertIn("couldn't reach the calendar", self.book(**self.args()))
        self.assertEqual(self.bookings(), [])

    def test_T35_google_rejecting_the_grant_flags_the_connection(self):
        self.g.fail_create = 403
        self.assertIn("needs to be reconnected", self.book(**self.args()))

    def test_T36_not_connected_and_reconnect_states(self):
        supabase.table("calendar_connections").delete().eq("user_id", self.user).execute()
        self.assertIn("No calendar is connected", self.book(**self.args()))
        self.connect()
        supabase.table("calendar_connections").update({"status": "reauth_required"}).eq("user_id", self.user).execute()
        self.assertIn("needs to be reconnected", self.book(**self.args()))
        self.assertEqual(self.g.events, [])

    def test_T37_meeting_length_override_and_bounds(self):
        self.book(**self.args(duration_minutes=60))
        self.assertEqual(self.g.events[0]["end"]["dateTime"], iso(self.start + timedelta(minutes=60)))
        for bad in (5, 500, "long"):
            self.assertIn("meeting length" if bad == "long" else "between 10 and 240", self.book(**self.args(duration_minutes=bad)))

    def test_T38_default_length_comes_from_settings(self):
        cal.update_settings(self.user, {"slot_minutes": 45})
        self.book(**self.args(duration_minutes=None))
        self.assertEqual(self.g.events[0]["end"]["dateTime"], iso(self.start + timedelta(minutes=45)))

    def test_T39_buffer_blocks_an_adjacent_booking(self):
        cal.update_settings(self.user, {"buffer_minutes": 15})
        self.g.busy = [(zulu(self.start - timedelta(minutes=60)), zulu(self.start - timedelta(minutes=10)))]
        self.assertIn("just taken", self.book(**self.args()))

    def test_T40_long_text_is_trimmed_and_odd_characters_survive(self):
        self.book(**self.args(contact_name="علی خان" + "x" * 300, notes="<script>1</script> 'q' \"d\" " + "n" * 900))
        ev = self.g.events[0]
        self.assertLessEqual(len(ev["summary"]), len("Meeting with ") + 100)
        self.assertIn("علی خان", ev["summary"])
        self.assertLessEqual(len(self.bookings()[0]["notes"]), 500)

    def test_T41_missing_name_is_handled(self):
        self.book(**self.args(contact_name=None))
        self.assertEqual(self.g.events[0]["summary"], "Meeting with the caller")

    def test_T42_second_booking_of_the_same_slot_is_refused_once_google_shows_it_busy(self):
        self.book(**self.args())
        self.g.busy = [(zulu(self.start), zulu(self.start + timedelta(minutes=30)))]       # Google now shows the first event
        self.assertIn("just taken", self.book(**self.args()))
        self.assertEqual(len(self.g.events), 1)

    def test_T43_bookkeeping_failure_does_not_lose_the_confirmation(self):
        real = cal.supabase

        class Flaky:
            def table(self, name):
                t = real.table(name)
                if name != "calendar_bookings":
                    return t

                class Proxy:
                    def __getattr__(self, attr):
                        return getattr(t, attr)

                    def insert(self, *a, **k):
                        raise RuntimeError("db down")
                return Proxy()

        with patch.object(cal, "supabase", Flaky()):
            text = asyncio.run(cal.book_slot(self.user, self.args(), agent_id=self.agent["id"], call_id=self.call, tool_call_id="flaky"))
        self.assertIn("Booked for", text)           # the event exists, so the caller is still told
        self.assertEqual(len(self.g.events), 1)


class ToolWiring(Base):
    def test_P01_tool_presets_endpoint(self):
        r = client.get("/agents/tool-presets", headers=auth(self.user))
        data = {p["key"]: p for p in r.json()["data"]}
        self.assertEqual(set(data), {"send_email", "send_sms", "check_availability", "book_slot", "update_crm", "webhook"})
        self.assertIn("Google Calendar", data["book_slot"]["requires"])
        self.assertTrue(all(p["label"] and p["description"] for p in data.values()))

    def test_P02_presets_endpoint_needs_login(self):
        self.assertIn(client.get("/agents/tool-presets").status_code, (401, 403))

    def test_P03_selecting_the_calendar_tools_creates_and_attaches_them(self):
        names = [c.args[0]["function"]["name"] for c in self.vapi.create_tool.await_args_list]
        self.assertEqual(sorted(names), ["book_calendar_slot", "check_availability"])
        urls = {c.args[0]["server"]["url"] for c in self.vapi.create_tool.await_args_list}
        self.assertEqual(urls, {"https://qa.example.test/tools/internal/check-availability", "https://qa.example.test/tools/internal/book-slot"})
        self.assertEqual(len(self.vapi.create_assistant.await_args.args[0]["model"]["toolIds"]), 2)
        row = supabase.table("ai_agents").select("selected_tool_keys").eq("id", self.agent["id"]).single().execute().data
        self.assertEqual(sorted(row["selected_tool_keys"]), ["book_slot", "check_availability"])

    def test_P04_a_second_agent_reuses_the_same_tools(self):
        self.vapi.create_tool.reset_mock()
        h.create_agent_via_api(self.user, name="Second", selected_tool_keys=["check_availability", "book_slot"])
        self.vapi.create_tool.assert_not_awaited()

    def test_P05_adding_a_tool_later_pushes_it_to_the_assistant(self):
        a = h.create_agent_via_api(self.user, name="Plain")
        r = client.patch(f"/agents/{a['id']}", json={"selected_tool_keys": ["book_slot"]}, headers=auth(self.user))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(len(self.vapi.update_assistant.await_args.args[1]["model"]["toolIds"]), 1)

    def test_P06_unticking_every_tool_really_removes_them(self):
        r = client.patch(f"/agents/{self.agent['id']}", json={"selected_tool_keys": []}, headers=auth(self.user))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertNotIn("toolIds", self.vapi.update_assistant.await_args.args[1]["model"])
        row = supabase.table("ai_agents").select("selected_tool_keys").eq("id", self.agent["id"]).single().execute().data
        self.assertEqual(row["selected_tool_keys"], [])

    def test_P07_tools_events_and_transfer_coexist(self):
        ev = client.post("/call-events", json={"label": "Interested"}, headers=auth(self.user)).json()["data"]
        a = h.create_agent_via_api(self.user, name="Everything", selected_tool_keys=["book_slot"],
                                   transfer_number="+15551234567", call_events=[{"event_id": ev["id"]}])
        self.assertEqual(len(self.vapi.create_assistant.await_args.args[0]["model"]["toolIds"]), 3)
        client.patch(f"/agents/{a['id']}", json={"selected_tool_keys": ["book_slot", "check_availability"]}, headers=auth(self.user))
        self.assertEqual(len(self.vapi.update_assistant.await_args.args[1]["model"]["toolIds"]), 4)

    def test_P08_unknown_tool_keys_are_ignored(self):
        a = h.create_agent_via_api(self.user, name="Odd", selected_tool_keys=["book_slot", "teleport"])
        self.assertEqual(len(self.vapi.create_assistant.await_args.args[0]["model"]["toolIds"]), 1)
        self.assertTrue(a["id"])

    def test_P09_without_a_public_url_creation_still_works(self):
        with patch.object(settings, "public_api_url", ""):
            a = h.create_agent_via_api(self.user, name="Local", selected_tool_keys=["book_slot"])
        self.assertTrue(a["id"])

    def test_P10_tool_descriptions_tell_the_model_to_check_before_booking(self):
        from services.agent_tools import PRESETS
        self.assertIn("check_availability", PRESETS["book_slot"]["description"])
        self.assertIn("Always call this before", PRESETS["check_availability"]["description"])
        self.assertEqual(PRESETS["book_slot"]["parameters"]["required"], ["contact_name", "start_iso"])


if __name__ == "__main__":
    unittest.main()
