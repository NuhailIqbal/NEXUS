"""
Time zones: whatever zone the user picks must drive everything time-related, for inbound and outbound.

* every zone the browser's picker can offer (tests/fixtures/browser_zones.json is a snapshot of
  `Intl.supportedValuesOf("timeZone")`, 418 names) and every zone Python knows is accepted, and the
  calling/answering hours are evaluated in THAT zone: opening and closing instants, the weekday (a
  far-east zone is already "tomorrow" in UTC), half-hour and 45-minute offsets, daylight-saving dates;
* end to end in a spread of awkward zones, with a frozen clock: an outbound campaign starts or is
  refused, the receptionist answers or says it is closed, the "opens again" wording is in the zone,
  and every logged call carries the zone its times must be shown in (`display_timezone`) while its
  stored instant is untouched;
* no default: nothing falls back to UTC / the server's / the browser's zone.

Run from the backend folder:  python -m unittest discover -s tests -v
"""
import json
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch
from zoneinfo import ZoneInfo, available_timezones

import byot_harness as H
from database import supabase
from routers import telephony
from routers.webhooks import import_vapi_call
from services import call_hours, vapi_client

from test_caller_verification import Base, make_agent, make_number, screenings
from services import caller_verification as cv

C, N = call_hours.CAMPAIGN, call_hours.NUMBER
UTC = timezone.utc

BROWSER_ZONES = json.loads((Path(__file__).parent / "fixtures" / "browser_zones.json").read_text(encoding="utf-8"))
# Everything the server could be handed: the browser's list plus every canonical region Python knows.
ALL_ZONES = sorted(set(BROWSER_ZONES) | {z for z in available_timezones() if "/" in z or z == "UTC"})

# Wednesdays (weekday 2) in the zone's own calendar: autumn, spring and winter dates around the
# northern and southern daylight-saving changes.
WEDNESDAYS = [(2026, 10, 14), (2026, 3, 11), (2026, 11, 4), (2027, 1, 13)]


def local(zone, y, m, d, hh=0, mm=0):
    """The UTC instant at which the wall clock in `zone` reads y-m-d hh:mm."""
    return datetime(y, m, d, hh, mm, tzinfo=ZoneInfo(zone)).astimezone(UTC)


def wed_row(zone, start="09:00", end="17:00", prefix=C):
    """Hours switched on for Wednesdays only, in `zone`."""
    return {prefix + "enabled": True, prefix + "timezone": zone, prefix + "days": [2],
            prefix + "start": start, prefix + "end": end}


# ═══════════════════════════════════════════════════════════════════════════
# Every zone: the window is evaluated in the zone the user picked
# ═══════════════════════════════════════════════════════════════════════════


class EveryZoneTests(unittest.TestCase):
    def test_the_list_is_what_we_think_it_is(self):
        self.assertGreater(len(BROWSER_ZONES), 400)
        self.assertGreater(len(ALL_ZONES), 450)
        for must in ("Asia/Karachi", "Asia/Kolkata", "Asia/Kathmandu", "Pacific/Chatham", "Pacific/Kiritimati",
                     "Australia/Lord_Howe", "America/St_Johns", "Pacific/Pago_Pago", "Africa/Casablanca"):
            self.assertIn(must, ALL_ZONES)

    def test_the_server_accepts_every_zone_the_picker_can_offer_and_stores_it_unchanged(self):
        for zone in ALL_ZONES:
            got = call_hours.validate(C, None, {C + "enabled": True, C + "timezone": zone})
            self.assertEqual(got[C + "timezone"], zone, zone)

    def test_every_zone_opens_and_closes_at_its_own_wall_clock_times(self):
        for zone in ALL_ZONES:
            row = wed_row(zone)
            for y, m, d in WEDNESDAYS:
                with self.subTest(zone=zone, day=f"{y}-{m}-{d}"):
                    self.assertTrue(call_hours.is_open(row, C, local(zone, y, m, d, 9, 0)), "opens at 09:00")
                    self.assertTrue(call_hours.is_open(row, C, local(zone, y, m, d, 12, 30)))
                    self.assertTrue(call_hours.is_open(row, C, local(zone, y, m, d, 16, 59)), "still open at 16:59")
                    self.assertFalse(call_hours.is_open(row, C, local(zone, y, m, d, 8, 59)), "closed at 08:59")
                    self.assertFalse(call_hours.is_open(row, C, local(zone, y, m, d, 17, 0)), "closed at 17:00 (end exclusive)")
                    self.assertFalse(call_hours.is_open(row, C, local(zone, y, m, d, 0, 0)))
                    self.assertFalse(call_hours.is_open(row, C, local(zone, y, m, d, 23, 59)))
                    # the same wall clock on the day before / after is a different weekday here
                    prev, nxt = datetime(y, m, d) - timedelta(days=1), datetime(y, m, d) + timedelta(days=1)
                    self.assertFalse(call_hours.is_open(row, C, local(zone, prev.year, prev.month, prev.day, 10)), "Tuesday")
                    self.assertFalse(call_hours.is_open(row, C, local(zone, nxt.year, nxt.month, nxt.day, 10)), "Thursday")

    def test_half_hour_and_quarter_hour_windows_in_every_zone(self):
        for zone in ALL_ZONES:
            row = wed_row(zone, "09:30", "17:45")
            y, m, d = WEDNESDAYS[0]
            with self.subTest(zone=zone):
                self.assertFalse(call_hours.is_open(row, C, local(zone, y, m, d, 9, 29)))
                self.assertTrue(call_hours.is_open(row, C, local(zone, y, m, d, 9, 30)))
                self.assertTrue(call_hours.is_open(row, C, local(zone, y, m, d, 17, 44)))
                self.assertFalse(call_hours.is_open(row, C, local(zone, y, m, d, 17, 45)))

    def test_an_all_day_window_covers_the_zones_whole_local_day_only(self):
        for zone in ALL_ZONES:
            row = wed_row(zone, "00:00", "00:00")
            y, m, d = WEDNESDAYS[0]
            with self.subTest(zone=zone):
                self.assertTrue(call_hours.is_open(row, C, local(zone, y, m, d, 0, 0)))
                self.assertTrue(call_hours.is_open(row, C, local(zone, y, m, d, 23, 59)))
                self.assertFalse(call_hours.is_open(row, C, local(zone, y, m, d, 0, 0) - timedelta(minutes=1)), "Tuesday 23:59")
                self.assertFalse(call_hours.is_open(row, C, local(zone, y, m, d, 23, 59) + timedelta(minutes=1)), "Thursday 00:00")

    def test_the_next_opening_is_the_next_wall_clock_nine_in_every_zone(self):
        for zone in ALL_ZONES:
            row = wed_row(zone)
            for y, m, d in WEDNESDAYS:
                with self.subTest(zone=zone, day=f"{y}-{m}-{d}"):
                    week_later = datetime(y, m, d) + timedelta(days=7)
                    expected_next_week = local(zone, week_later.year, week_later.month, week_later.day, 9, 0)
                    # after closing: the same wall-clock 09:00, one week on (a daylight-saving change
                    # in between must not move it)
                    self.assertEqual(call_hours.next_opening(row, C, local(zone, y, m, d, 17, 0)), expected_next_week)
                    self.assertEqual(call_hours.next_opening(row, C, local(zone, y, m, d, 23, 59)), expected_next_week)
                    # before opening, the same day
                    self.assertEqual(call_hours.next_opening(row, C, local(zone, y, m, d, 8, 0)), local(zone, y, m, d, 9, 0))
                    # while open: now
                    now = local(zone, y, m, d, 11, 0)
                    self.assertEqual(call_hours.next_opening(row, C, now), now)

    def test_the_wording_names_the_zone_and_the_zones_own_weekday(self):
        for zone in ALL_ZONES:
            row = wed_row(zone)
            y, m, d = WEDNESDAYS[0]
            with self.subTest(zone=zone):
                # 09:00 local on that Wednesday, whatever weekday it is in UTC
                self.assertEqual(call_hours.describe_moment(local(zone, y, m, d, 9, 0), row, C), f"Wed 9:00 AM ({zone})")
                self.assertEqual(call_hours.describe(row, C), f"Wed, 9:00 AM–5:00 PM ({zone})")

    def test_state_reports_the_zones_next_opening_as_utc(self):
        for zone in ALL_ZONES:
            row = wed_row(zone)
            y, m, d = WEDNESDAYS[0]
            with self.subTest(zone=zone):
                st = call_hours.state(row, C, local(zone, y, m, d, 8, 0))
                self.assertEqual((st["open"], st["next_open_at"]),
                                 (False, local(zone, y, m, d, 9, 0).strftime("%Y-%m-%dT%H:%M:%SZ")))
                self.assertTrue(st["summary"].endswith(f"({zone})"))

    def test_the_two_prefixes_behave_identically(self):
        for zone in ("Asia/Kathmandu", "Pacific/Chatham", "America/St_Johns"):
            y, m, d = WEDNESDAYS[0]
            for prefix in (C, N):
                with self.subTest(zone=zone, prefix=prefix):
                    row = wed_row(zone, prefix=prefix)
                    self.assertTrue(call_hours.is_open(row, prefix, local(zone, y, m, d, 9, 0)))
                    self.assertFalse(call_hours.is_open(row, prefix, local(zone, y, m, d, 17, 0)))

    def test_no_zone_is_ever_assumed(self):
        # hours switched on with no zone are refused, never run in UTC or the machine's zone
        with self.assertRaises(call_hours.HoursError):
            call_hours.validate(C, None, {C + "enabled": True})
        # and a damaged row with no zone is treated as unreadable (not as UTC)
        row = {C + "enabled": True, C + "timezone": None, C + "days": [2], C + "start": "09:00", C + "end": "17:00"}
        self.assertFalse(call_hours.is_open(row, C, local("UTC", 2026, 10, 14, 10), if_unreadable=False))
        self.assertTrue(call_hours.is_open(row, C, local("UTC", 2026, 10, 14, 10), if_unreadable=True))


# ═══════════════════════════════════════════════════════════════════════════
# End to end, in awkward zones, with a frozen clock
# ═══════════════════════════════════════════════════════════════════════════

# Whole-hour, half-hour, 45-minute, +14, -11, negative-DST (Morocco), southern-hemisphere DST, Lord Howe's
# 30-minute DST, and the common US/EU/Asia zones.
E2E_ZONES = [
    "UTC", "Asia/Karachi", "Asia/Kolkata", "Asia/Kathmandu", "Australia/Lord_Howe", "Pacific/Chatham",
    "Pacific/Kiritimati", "Pacific/Pago_Pago", "America/St_Johns", "America/New_York", "America/Los_Angeles",
    "Europe/London", "Asia/Tokyo", "Australia/Sydney", "Africa/Casablanca", "America/Sao_Paulo",
]
DAY = WEDNESDAYS[0]


class FakeDateTime(datetime):
    """datetime whose now() is `instant` (set per step), so the clock can be put at any moment."""
    instant = datetime(2026, 10, 14, 12, 0, tzinfo=UTC)

    @classmethod
    def now(cls, tz=None):
        return cls.instant.astimezone(tz) if tz else cls.instant.replace(tzinfo=None)


class ZoneBase(Base):
    """An account with a funded wallet, an agent, a list of contacts, a mocked call placer and a clock
    that can be put at any instant."""

    def setUp(self):
        super().setUp()
        H.fund_wallet(self.user, 100)
        self.agent = make_agent(self.user)
        self.out_number = make_number(self.user, agent=self.agent)
        self.list = supabase.table("lists").insert({"user_id": self.user, "name": "Leads"}).execute().data[0]
        supabase.table("contacts").insert([
            {"user_id": self.user, "list_id": self.list["id"], "name": f"C{i}", "phone": f"+1555000{i:04d}"} for i in range(3)
        ]).execute()
        self.placed: list[str] = []

        async def create_call(payload):
            call_id = f"call-{uuid.uuid4().hex[:10]}"
            self.placed.append(call_id)
            return {"id": call_id}
        self.create_call = AsyncMock(side_effect=create_call)
        for target, name, value in ((vapi_client, "create_call", self.create_call),
                                    (call_hours, "datetime", FakeDateTime), (telephony, "datetime", FakeDateTime)):
            p = patch.object(target, name, value)
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(lambda: H.sql("UPDATE public.phone_numbers SET answer_hours_enabled = false"))

    def at(self, instant):
        FakeDateTime.instant = instant

    def api(self, method, path, **kw):
        return getattr(H.client, method)(path, headers=H.auth(self.user), **kw)

    def make_campaign(self, zone, **extra):
        body = {"name": f"C {zone}", "agent_id": self.agent["id"], "list_id": self.list["id"],
                "phone_number_id": self.out_number["id"], "dnc_screening_enabled": False,
                "call_hours_enabled": True, "call_hours_timezone": zone, "call_hours_days": [2],
                "call_hours_start": "09:00", "call_hours_end": "17:00", **extra}
        r = self.api("post", "/telephony/campaigns", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["data"]

    def campaign_state(self, cid):
        return self.api("get", f"/telephony/campaigns/{cid}").json()["data"]["call_hours_state"]

    def conversations(self, **params):
        q = "&".join(f"{k}={v}" for k, v in params.items())
        return self.api("get", f"/conversations?{q}").json()["data"]


class OutboundEveryZoneTests(ZoneBase):
    def test_a_campaign_runs_only_inside_the_hours_of_the_zone_chosen(self):
        y, m, d = DAY
        for zone in E2E_ZONES:
            with self.subTest(zone=zone):
                c = self.make_campaign(zone)
                start = lambda: self.api("post", f"/telephony/campaigns/{c['id']}/start")

                # closed: before opening, at closing time, the next day, the previous day
                for label, instant in (("08:59", local(zone, y, m, d, 8, 59)), ("17:00", local(zone, y, m, d, 17, 0)),
                                       ("Thursday", local(zone, y, m, d + 1, 10)), ("Tuesday", local(zone, y, m, d - 1, 10))):
                    self.at(instant)
                    before = self.create_call.await_count
                    r = start()
                    self.assertEqual(r.status_code, 400, f"{zone} {label}: {r.text}")
                    self.assertIn("closed right now", r.json()["detail"])
                    self.assertIn(f"({zone})", r.json()["detail"], "the message names the zone")
                    self.assertEqual(self.create_call.await_count, before, f"{zone} {label}: no call may be placed")
                    st = self.campaign_state(c["id"])
                    self.assertFalse(st["open"])
                    self.assertTrue(st["next_open_at"])

                # the stated next opening is exactly 09:00 local on that Wednesday
                self.at(local(zone, y, m, d, 8, 0))
                self.assertEqual(self.campaign_state(c["id"])["next_open_at"],
                                 local(zone, y, m, d, 9, 0).strftime("%Y-%m-%dT%H:%M:%SZ"))
                r = start()
                self.assertIn(f"opens again Wed 9:00 AM ({zone})", r.json()["detail"])

                # open: 09:00 sharp, and 16:59
                for label, instant in (("09:00", local(zone, y, m, d, 9, 0)), ("16:59", local(zone, y, m, d, 16, 59))):
                    self.at(instant)
                    self.assertTrue(self.campaign_state(c["id"])["open"], f"{zone} {label}")
                    before = self.create_call.await_count
                    r = start()
                    self.assertEqual(r.status_code, 200, f"{zone} {label}: {r.text}")
                    self.assertEqual(r.json()["data"]["dialed"], 3)
                    self.assertEqual(self.create_call.await_count, before + 3)

    def test_the_hours_of_two_campaigns_in_different_zones_do_not_leak_into_each_other(self):
        y, m, d = DAY
        a, b = self.make_campaign("Asia/Karachi"), self.make_campaign("America/Los_Angeles")
        self.at(local("Asia/Karachi", y, m, d, 10))          # Karachi 10:00 Wed = Tuesday evening in Los Angeles
        self.assertTrue(self.campaign_state(a["id"])["open"])
        self.assertFalse(self.campaign_state(b["id"])["open"])
        self.at(local("America/Los_Angeles", y, m, d, 10))   # LA 10:00 Wed = Wednesday night/Thursday in Karachi
        self.assertFalse(self.campaign_state(a["id"])["open"])
        self.assertTrue(self.campaign_state(b["id"])["open"])

    def test_changing_the_zone_moves_the_window_with_it(self):
        y, m, d = DAY
        c = self.make_campaign("Asia/Karachi")
        # 15:30 in Karachi on the Wednesday is 19:30 in Tokyo: open in one zone, closed in the other
        self.at(local("Asia/Karachi", y, m, d, 15, 30))
        self.assertTrue(self.campaign_state(c["id"])["open"])
        r = self.api("patch", f"/telephony/campaigns/{c['id']}", json={"call_hours_timezone": "Asia/Tokyo"})
        self.assertEqual(r.status_code, 200, r.text)
        st = self.campaign_state(c["id"])
        self.assertFalse(st["open"])
        self.assertEqual(st["next_open_at"], local("Asia/Tokyo", y, m, d + 7, 9, 0).strftime("%Y-%m-%dT%H:%M:%SZ"))
        # and back: the window follows the zone, it does not stay where it was
        self.api("patch", f"/telephony/campaigns/{c['id']}", json={"call_hours_timezone": "Asia/Karachi"})
        self.assertTrue(self.campaign_state(c["id"])["open"])

    def test_every_zone_the_picker_offers_can_be_saved_on_a_campaign(self):
        c = self.make_campaign("UTC")
        for zone in BROWSER_ZONES:
            r = self.api("patch", f"/telephony/campaigns/{c['id']}", json={"call_hours_timezone": zone})
            self.assertEqual(r.status_code, 200, f"{zone}: {r.text}")
            self.assertEqual(r.json()["data"]["call_hours_timezone"], zone)

    def test_a_mid_run_close_uses_the_zone_too(self):
        y, m, d = DAY
        zone = "Asia/Kathmandu"                               # UTC+5:45
        c = self.make_campaign(zone)
        self.at(local(zone, y, m, d, 16, 59))
        placed = self.create_call.side_effect

        async def clock_passes_closing_after_the_first_call(payload):
            result = await placed(payload)
            self.at(local(zone, y, m, d, 17, 0))               # the wall clock in the zone reaches closing time
            return result
        self.create_call.side_effect = clock_passes_closing_after_the_first_call
        with patch.object(telephony, "CAMPAIGN_BATCH_SIZE", 1):
            r = self.api("post", f"/telephony/campaigns/{c['id']}/start")
        data = r.json()["data"]
        self.assertEqual((data["dialed"], data["stopped_by_hours"], data["remaining"]), (1, True, 2))
        self.assertEqual(data["next_open_at"], local(zone, y, m, d + 7, 9, 0).strftime("%Y-%m-%dT%H:%M:%SZ"))
        self.assertEqual(self.campaign_row_status(c["id"]), "Paused")

    def campaign_row_status(self, cid):
        return supabase.table("outbound_campaigns").select("status").eq("id", cid).execute().data[0]["status"]


class InboundEveryZoneTests(ZoneBase):
    def number_with_hours(self, zone, **extra):
        num = make_number(self.user, agent=self.agent)
        r = self.patch_number(num["id"], {"answer_hours_enabled": True, "answer_hours_timezone": zone,
                                          "answer_hours_days": [2], "answer_hours_start": "09:00",
                                          "answer_hours_end": "17:00", **extra})
        self.assertEqual(r.status_code, 200, r.text)
        return num

    def test_the_receptionist_answers_only_inside_the_hours_of_the_zone_chosen(self):
        y, m, d = DAY
        for zone in E2E_ZONES:
            with self.subTest(zone=zone):
                num = self.number_with_hours(zone)
                closed = {"error": cv.CLOSED_MESSAGE}
                answered = {"assistantId": self.agent["vapi_assistant_id"]}
                for label, instant, expected in (
                    ("08:59", local(zone, y, m, d, 8, 59), closed), ("09:00", local(zone, y, m, d, 9, 0), answered),
                    ("16:59", local(zone, y, m, d, 16, 59), answered), ("17:00", local(zone, y, m, d, 17, 0), closed),
                    ("Thursday", local(zone, y, m, d + 1, 10), closed), ("Tuesday", local(zone, y, m, d - 1, 10), closed),
                    ("midnight", local(zone, y, m, d, 0, 0), closed),
                ):
                    self.at(instant)
                    self.assertEqual(self.answer(num["vapi_phone_id"]), expected, f"{zone} {label}")

    def test_the_numbers_state_and_next_opening_are_in_its_zone(self):
        y, m, d = DAY
        for zone in E2E_ZONES:
            with self.subTest(zone=zone):
                num = self.number_with_hours(zone)
                self.at(local(zone, y, m, d, 7, 0))
                row = next(r for r in self.api("get", "/telephony/phone-numbers").json()["data"] if r["id"] == num["id"])
                st = row["answer_hours_state"]
                self.assertEqual((st["open"], st["next_open_at"]), (False, local(zone, y, m, d, 9, 0).strftime("%Y-%m-%dT%H:%M:%SZ")))
                self.assertTrue(st["summary"].endswith(f"({zone})"))
                self.assertEqual(row["answer_hours_timezone"], zone)

    def test_two_numbers_in_different_zones_each_follow_their_own(self):
        y, m, d = DAY
        karachi, la = self.number_with_hours("Asia/Karachi"), self.number_with_hours("America/Los_Angeles")
        self.at(local("Asia/Karachi", y, m, d, 10))
        self.assertIn("assistantId", self.answer(karachi["vapi_phone_id"]))
        self.assertEqual(self.answer(la["vapi_phone_id"]), {"error": cv.CLOSED_MESSAGE})
        self.at(local("America/Los_Angeles", y, m, d, 10))
        self.assertEqual(self.answer(karachi["vapi_phone_id"]), {"error": cv.CLOSED_MESSAGE})
        self.assertIn("assistantId", self.answer(la["vapi_phone_id"]))

    def test_every_zone_the_picker_offers_can_be_saved_on_a_number(self):
        num = make_number(self.user, agent=self.agent)
        self.patch_number(num["id"], {"answer_hours_timezone": "UTC"})
        for zone in BROWSER_ZONES:
            r = self.patch_number(num["id"], {"answer_hours_timezone": zone})
            self.assertEqual(r.status_code, 200, f"{zone}: {r.text}")
            self.assertEqual(r.json()["data"]["answer_hours_timezone"], zone)
        # none of that touched the voice service (settings only, hours off)
        self.vapi.update_phone_number.assert_not_awaited()


# ═══════════════════════════════════════════════════════════════════════════
# Call logs: every logged call knows the zone its times are shown in
# ═══════════════════════════════════════════════════════════════════════════


def vapi_call(call_id, direction, vapi_phone_id, started, assistant_id=None, customer="+15551230001"):
    """A VAPI REST call object, as the pull-sync / webhook import receives it."""
    return {"id": call_id, "type": "inboundPhoneCall" if direction == "inbound" else "outboundPhoneCall",
            "phoneNumberId": vapi_phone_id, "assistantId": assistant_id, "customer": {"number": customer},
            "startedAt": started.strftime("%Y-%m-%dT%H:%M:%SZ"), "endedReason": "customer-ended-call"}


class CallLogZoneTests(ZoneBase):
    def test_outbound_calls_carry_the_zone_of_the_campaign_that_placed_them(self):
        y, m, d = DAY
        for zone in E2E_ZONES:
            with self.subTest(zone=zone):
                c = self.make_campaign(zone)
                self.at(local(zone, y, m, d, 10))
                self.placed.clear()
                r = self.api("post", f"/telephony/campaigns/{c['id']}/start")
                self.assertEqual(r.json()["data"]["dialed"], 3, r.text)
                started = local(zone, y, m, d, 10, 0)
                # the campaign is remembered for every placed call ...
                recorded = supabase.table("campaign_calls").select("vapi_call_id, campaign_id").in_("vapi_call_id", self.placed).execute().data
                self.assertEqual({(x["vapi_call_id"], x["campaign_id"]) for x in recorded}, {(i, c["id"]) for i in self.placed})
                # ... so when the calls are logged, they are tied to it
                for call_id in self.placed:
                    import_vapi_call(vapi_call(call_id, "outbound", self.out_number["vapi_phone_id"], started,
                                               self.agent["vapi_assistant_id"]), self.user)
                rows = [r for r in self.conversations(direction="outbound", limit=200) if r["vapi_call_id"] in self.placed]
                self.assertEqual(len(rows), 3)
                for row in rows:
                    self.assertEqual(row["display_timezone"], zone)
                    self.assertEqual(str(row["campaign_id"]), c["id"])
                    # the stored moment is the real instant, untouched (only the DISPLAY follows the zone)
                    self.assertEqual(datetime.fromisoformat(row["call_time"]).astimezone(UTC), started)

    def test_inbound_calls_carry_the_zone_of_the_number_they_came_in_on(self):
        y, m, d = DAY
        for zone in E2E_ZONES:
            with self.subTest(zone=zone):
                num = make_number(self.user, agent=self.agent)
                self.patch_number(num["id"], {"answer_hours_enabled": True, "answer_hours_timezone": zone,
                                              "answer_hours_days": [2], "answer_hours_start": "09:00", "answer_hours_end": "17:00"})
                started = local(zone, y, m, d, 11, 0)
                self.at(started)
                call_id = f"in-{uuid.uuid4().hex[:8]}"
                self.assertIn("assistantId", self.answer(num["vapi_phone_id"], call_id=call_id))
                import_vapi_call(vapi_call(call_id, "inbound", num["vapi_phone_id"], started, self.agent["vapi_assistant_id"]), self.user)
                (row,) = [r for r in self.conversations(direction="inbound", limit=200) if r["vapi_call_id"] == call_id]
                self.assertEqual(row["display_timezone"], zone)
                self.assertEqual(str(row["phone_number_id"]), num["id"])
                self.assertEqual(datetime.fromisoformat(row["call_time"]).astimezone(UTC), started)

    def test_the_single_conversation_endpoint_carries_it_too(self):
        zone = "Pacific/Chatham"
        num = make_number(self.user, agent=self.agent)
        self.patch_number(num["id"], {"answer_hours_timezone": zone})
        started = local(zone, *DAY, 11, 0)
        import_vapi_call(vapi_call("in-one", "inbound", num["vapi_phone_id"], started, self.agent["vapi_assistant_id"]), self.user)
        conv = supabase.table("conversations").select("id").eq("vapi_call_id", "in-one").execute().data[0]
        data = self.api("get", f"/conversations/{conv['id']}").json()["data"]
        self.assertEqual(data["display_timezone"], zone)

    def test_a_zone_chosen_while_the_hours_are_off_still_decides_the_display(self):
        zone = "Asia/Kathmandu"
        num = make_number(self.user, agent=self.agent)
        self.patch_number(num["id"], {"answer_hours_timezone": zone})            # chosen, hours still off
        import_vapi_call(vapi_call("in-off", "inbound", num["vapi_phone_id"], local(zone, *DAY, 11), self.agent["vapi_assistant_id"]), self.user)
        (row,) = [r for r in self.conversations(direction="inbound") if r["vapi_call_id"] == "in-off"]
        self.assertEqual(row["display_timezone"], zone)

    def test_no_zone_chosen_means_no_display_zone_never_a_default(self):
        num = make_number(self.user, agent=self.agent)                            # no zone ever chosen
        c = supabase.table("outbound_campaigns").insert({"user_id": self.user, "name": "NoZone", "agent_id": self.agent["id"]}).execute().data[0]
        started = local("UTC", *DAY, 11)
        import_vapi_call(vapi_call("in-none", "inbound", num["vapi_phone_id"], started, self.agent["vapi_assistant_id"]), self.user)
        supabase.table("campaign_calls").insert({"vapi_call_id": "out-none", "campaign_id": c["id"], "user_id": self.user}).execute()
        import_vapi_call(vapi_call("out-none", "outbound", num["vapi_phone_id"], started, self.agent["vapi_assistant_id"]), self.user)
        rows = {r["vapi_call_id"]: r for r in self.conversations(limit=200)}
        self.assertIsNone(rows["in-none"]["display_timezone"])
        self.assertIsNone(rows["out-none"]["display_timezone"])

    def test_calls_logged_before_attribution_existed_have_no_zone(self):
        supabase.table("conversations").insert({"user_id": self.user, "channel": "Phone", "direction": "inbound", "vapi_call_id": "legacy-in"}).execute()
        supabase.table("conversations").insert({"user_id": self.user, "channel": "Phone", "direction": "outbound", "vapi_call_id": "legacy-out"}).execute()
        rows = {r["vapi_call_id"]: r for r in self.conversations(limit=200)}
        self.assertIsNone(rows["legacy-in"]["display_timezone"])
        self.assertIsNone(rows["legacy-out"]["display_timezone"])

    def test_a_callback_placed_call_follows_the_zone_the_callback_was_scheduled_in(self):
        zone = "America/St_Johns"
        supabase.table("callbacks").insert({"user_id": self.user, "due_at": "2026-10-14T15:00:00Z", "timezone": zone,
                                            "status": "called", "placed_call_id": "cb-call"}).execute()
        import_vapi_call(vapi_call("cb-call", "outbound", self.out_number["vapi_phone_id"], local(zone, *DAY, 12), self.agent["vapi_assistant_id"]), self.user)
        (row,) = [r for r in self.conversations(direction="outbound") if r["vapi_call_id"] == "cb-call"]
        self.assertEqual(row["display_timezone"], zone)

    def test_a_row_can_never_borrow_another_accounts_zone(self):
        other = H.make_user()
        theirs = supabase.table("outbound_campaigns").insert({
            "user_id": other, "name": "Theirs", "call_hours_enabled": True, "call_hours_timezone": "Asia/Tokyo"}).execute().data[0]
        supabase.table("conversations").insert({"user_id": self.user, "channel": "Phone", "direction": "outbound",
                                                "vapi_call_id": "borrow", "campaign_id": theirs["id"]}).execute()
        (row,) = [r for r in self.conversations(direction="outbound") if r["vapi_call_id"] == "borrow"]
        self.assertIsNone(row["display_timezone"])

    def test_an_end_of_call_event_attributes_a_row_that_was_created_without_it(self):
        zone = "Asia/Karachi"
        c = self.make_campaign(zone)
        supabase.table("campaign_calls").insert({"vapi_call_id": "late", "campaign_id": c["id"], "user_id": self.user}).execute()
        supabase.table("conversations").insert({"user_id": self.user, "channel": "Phone", "direction": "outbound", "vapi_call_id": "late"}).execute()
        import_vapi_call(vapi_call("late", "outbound", self.out_number["vapi_phone_id"], local(zone, *DAY, 10), self.agent["vapi_assistant_id"]), self.user)
        (row,) = [r for r in self.conversations(direction="outbound") if r["vapi_call_id"] == "late"]
        self.assertEqual(row["display_timezone"], zone)

    def test_deleting_a_campaign_leaves_its_calls_logged_without_a_zone_not_broken(self):
        zone = "Asia/Tokyo"
        c = self.make_campaign(zone)
        self.at(local(zone, *DAY, 10))
        self.placed.clear()
        self.api("post", f"/telephony/campaigns/{c['id']}/start")
        call_id = self.placed[0]
        import_vapi_call(vapi_call(call_id, "outbound", self.out_number["vapi_phone_id"], local(zone, *DAY, 10), self.agent["vapi_assistant_id"]), self.user)
        self.api("delete", f"/telephony/campaigns/{c['id']}")
        (row,) = [r for r in self.conversations(direction="outbound") if r["vapi_call_id"] == call_id]
        self.assertIsNone(row["display_timezone"])


if __name__ == "__main__":
    unittest.main()
