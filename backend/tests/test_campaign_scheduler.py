"""
Automatic continuing of campaigns that the calling hours stopped (services/campaign_scheduler.py).

A run still going when the hours end stops and remembers where; the next time the hours open the campaign
carries on by itself from the next contact, day after day, until the list is finished. Covered here with
a frozen clock: a multi-day run, several time zones, every way a person can take the campaign over
(which must stop the automatic continuing), double sweeps, refusals and notifications.

Run from the backend folder:  python -m unittest discover -s tests -v
"""
import asyncio
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import byot_harness as H
from config import settings
from database import supabase
from fastapi import HTTPException
from routers import telephony
from services import call_hours
from services.campaign_scheduler import campaign_loop, run_auto_resumes

from test_caller_verification import make_agent
from test_timezones import E2E_ZONES, FakeDateTime, ZoneBase, local

UTC = timezone.utc
ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]
DAY = (2026, 10, 14)        # a Wednesday


def day(offset, y=DAY[0], m=DAY[1], d=DAY[2]):
    """(y, m, d) `offset` days after the reference day."""
    t = datetime(y, m, d) + timedelta(days=offset)
    return t.year, t.month, t.day


class SchedulerBase(ZoneBase):
    """Ten contacts, two per batch; the clock reaches closing time after a chosen number of calls."""

    def setUp(self):
        super().setUp()
        # A sweep looks at EVERY account's campaigns, so campaigns left waiting by other tests would be
        # started too: start each test with none waiting, and leave none behind.
        H.sql("UPDATE public.outbound_campaigns SET stopped_by_hours_at = NULL")
        self.addCleanup(lambda: H.sql("UPDATE public.outbound_campaigns SET stopped_by_hours_at = NULL"))
        supabase.table("contacts").insert([
            {"user_id": self.user, "list_id": self.list["id"], "name": f"X{i}", "phone": f"+15550001{i:03d}"} for i in range(7)
        ]).execute()
        p = patch.object(telephony, "CAMPAIGN_BATCH_SIZE", 2)
        p.start()
        self.addCleanup(p.stop)
        self.expected_order = [c["phone"] for c in sorted(
            supabase.table("contacts").select("id, phone").eq("list_id", self.list["id"]).execute().data, key=lambda c: c["id"])]
        self.assertEqual(len(self.expected_order), 10)
        # the clock moves to closing time once `_left` more calls have been placed
        self._left = None
        self._close_at = None
        inner = self.create_call.side_effect

        async def placing(payload):
            result = await inner(payload)
            if self._left is not None:
                self._left -= 1
                if self._left == 0:
                    self.at(self._close_at)
            return result
        self.create_call.side_effect = placing

    def expected_ids(self):
        return sorted(r["id"] for r in supabase.table("contacts").select("id").eq("list_id", self.list["id"]).execute().data)

    def closing_after(self, calls, instant):
        """After `calls` more calls the (frozen) clock jumps to `instant`, as if the hours ended mid-run."""
        self._left, self._close_at = calls, instant

    def dialed(self):
        return [c.args[0]["customer"]["number"] for c in self.create_call.await_args_list]

    def sweep(self, instant):
        self.at(instant)
        return asyncio.run(run_auto_resumes(instant))

    def campaign(self, zone, **extra):
        return self.make_campaign(zone, call_hours_days=extra.pop("call_hours_days", ALL_DAYS), call_hours_end="18:00", **extra)

    def row(self, cid):
        return supabase.table("outbound_campaigns").select("*").eq("id", cid).execute().data[0]

    def start(self, cid):
        return self.api("post", f"/telephony/campaigns/{cid}/start")

    def notifications(self):
        return supabase.table("notifications").select("*").eq("user_id", self.user).eq("kind", "campaign_auto_resume").execute().data

    def stopped_first_day(self, zone, calls=4, **extra):
        """A campaign whose first run (09:00) was cut off by the closing time after `calls` calls."""
        c = self.campaign(zone, **extra)
        y, m, d = DAY
        self.at(local(zone, y, m, d, 9))
        self.closing_after(calls, local(zone, y, m, d, 18))
        r = self.start(c["id"])
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["data"]["stopped_by_hours"], r.text)
        return c


class MultiDayTests(SchedulerBase):
    def test_it_carries_on_every_morning_until_the_list_is_finished(self):
        zone = "Asia/Karachi"
        c = self.campaign(zone)

        # ---- day 1: started by hand at 9:00, the hours end after 4 contacts
        y, m, d = DAY
        self.at(local(zone, y, m, d, 9))
        self.closing_after(4, local(zone, y, m, d, 18))
        r = self.start(c["id"])
        self.assertEqual((r.json()["data"]["dialed"], r.json()["data"]["remaining"], r.json()["data"]["stopped_by_hours"]), (4, 6, True))
        row = self.row(c["id"])
        self.assertEqual((row["status"], str(row["dial_cursor"]) is not None, row["stopped_by_hours_at"] is not None), ("Paused", True, True))
        self.assertEqual(self.dialed(), self.expected_order[:4])

        # ---- the evening and the night: nothing happens
        for label, instant in (("18:01", local(zone, y, m, d, 18, 1)), ("23:59", local(zone, y, m, d, 23, 59)),
                               ("next day 08:59", local(zone, *day(1), 8, 59))):
            self.assertEqual(self.sweep(instant), {"resumed": 0, "waiting": 1, "refused": 0}, label)
        self.assertEqual(self.dialed(), self.expected_order[:4])

        # ---- day 2 at 9:00: continues by itself, from the 5th contact; cut off again after 4
        self.closing_after(4, local(zone, *day(1), 18))
        self.assertEqual(self.sweep(local(zone, *day(1), 9, 0)), {"resumed": 1, "waiting": 0, "refused": 0})
        self.assertEqual(self.dialed(), self.expected_order[:8], "contacts 5-8, in order, nobody twice")
        row = self.row(c["id"])
        self.assertEqual(row["status"], "Paused")
        self.assertIsNotNone(row["stopped_by_hours_at"], "still waiting for the next opening")

        # ---- day 3 at 9:00: the last two, and it is finished
        self.closing_after(None, None)
        self.assertEqual(self.sweep(local(zone, *day(2), 9, 0)), {"resumed": 1, "waiting": 0, "refused": 0})
        self.assertEqual(self.dialed(), self.expected_order, "all 10, each exactly once, in order across the three days")
        row = self.row(c["id"])
        self.assertEqual((row["status"], row["dial_cursor"], row["stopped_by_hours_at"]), ("Active", None, None))

        # ---- and it does not start over
        self.assertEqual(self.sweep(local(zone, *day(3), 9, 0)), {"resumed": 0, "waiting": 0, "refused": 0})
        self.assertEqual(len(self.dialed()), 10)

    def test_the_user_can_see_it_is_waiting_and_when(self):
        zone = "Asia/Karachi"
        c = self.stopped_first_day(zone)
        self.at(local(zone, *DAY, 18, 5))
        listed = {x["id"]: x for x in self.api("get", "/telephony/campaigns").json()["data"]}[c["id"]]
        self.assertEqual(listed["auto_resume"], {"pending": True, "next_at": local(zone, *day(1), 9, 0).strftime("%Y-%m-%dT%H:%M:%SZ")})
        # once finished, nothing is pending
        self.closing_after(None, None)
        self.sweep(local(zone, *day(1), 9, 0))
        listed = {x["id"]: x for x in self.api("get", "/telephony/campaigns").json()["data"]}[c["id"]]
        self.assertEqual(listed["auto_resume"], {"pending": False, "next_at": None})

    def test_it_only_continues_on_the_days_the_hours_allow(self):
        zone = "Asia/Tokyo"
        # Wednesdays only
        c = self.stopped_first_day(zone, call_hours_days=[2])
        for label, instant in (("Thursday", local(zone, *day(1), 10)), ("Tuesday", local(zone, *day(6), 10)), ("next Wed 08:59", local(zone, *day(7), 8, 59))):
            self.assertEqual(self.sweep(instant)["resumed"], 0, label)
        self.closing_after(None, None)
        self.assertEqual(self.sweep(local(zone, *day(7), 9, 0))["resumed"], 1)
        self.assertEqual(self.dialed(), self.expected_order)
        self.assertEqual(self.row(c["id"])["status"], "Active")

    def test_in_every_awkward_zone_it_continues_at_that_zones_nine_oclock(self):
        for zone in E2E_ZONES:
            with self.subTest(zone=zone):
                self.create_call.reset_mock()
                before = len(self.dialed())
                c = self.stopped_first_day(zone)
                self.assertEqual(len(self.dialed()), 4)
                self.assertEqual(self.sweep(local(zone, *day(1), 8, 59)), {"resumed": 0, "waiting": 1, "refused": 0}, zone)
                self.closing_after(None, None)
                self.assertEqual(self.sweep(local(zone, *day(1), 9, 0)), {"resumed": 1, "waiting": 0, "refused": 0}, zone)
                self.assertEqual(self.dialed(), self.expected_order, zone)
                self.assertEqual(self.row(c["id"])["status"], "Active")
                # keep the shared account tidy for the next zone
                supabase.table("outbound_campaigns").delete().eq("id", c["id"]).execute()

    def test_a_sweep_in_the_middle_of_the_window_picks_it_up_too(self):
        zone = "America/New_York"
        c = self.stopped_first_day(zone)
        self.closing_after(None, None)
        # the server was down at 9:00 and is back at 14:20 the next day: still inside the hours
        self.assertEqual(self.sweep(local(zone, *day(1), 14, 20))["resumed"], 1)
        self.assertEqual(self.dialed(), self.expected_order)


class WhatStopsItTests(SchedulerBase):
    """Anything a person does takes the campaign out of the automatic continuing."""

    def waiting(self, zone="Asia/Karachi"):
        c = self.stopped_first_day(zone)
        self.closing_after(None, None)
        return c, local(zone, *day(1), 9, 0)

    def assertNotResumed(self, instant):
        before = len(self.dialed())
        self.assertEqual(self.sweep(instant)["resumed"], 0)
        self.assertEqual(len(self.dialed()), before)

    def test_pausing_it_stops_the_automatic_continuing_but_keeps_the_place(self):
        c, opens = self.waiting()
        self.assertEqual(self.api("post", f"/telephony/campaigns/{c['id']}/pause").status_code, 200)
        row = self.row(c["id"])
        self.assertIsNone(row["stopped_by_hours_at"])
        self.assertIsNotNone(row["dial_cursor"])
        self.assertNotResumed(opens)
        # a person can still carry on from the same place
        self.at(opens)
        r = self.api("post", f"/telephony/campaigns/{c['id']}/resume")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.dialed(), self.expected_order)

    def test_setting_it_inactive_or_active_by_hand_stops_it(self):
        for new_status in ("Inactive", "Active"):
            with self.subTest(status=new_status):
                self.create_call.reset_mock()
                c, opens = self.waiting()
                self.api("patch", f"/telephony/campaigns/{c['id']}", json={"status": new_status})
                self.assertIsNone(self.row(c["id"])["stopped_by_hours_at"])
                self.assertNotResumed(opens)
                supabase.table("outbound_campaigns").delete().eq("id", c["id"]).execute()

    def test_saving_the_settings_without_changing_anything_keeps_it_waiting(self):
        c, opens = self.waiting()
        # the settings dialog always sends name, agent and status again, unchanged
        r = self.api("patch", f"/telephony/campaigns/{c['id']}", json={"name": "Renamed", "agent_id": self.agent["id"], "status": "Paused"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIsNotNone(self.row(c["id"])["stopped_by_hours_at"])
        self.assertEqual(self.sweep(opens)["resumed"], 1)

    def test_changing_the_hours_keeps_it_waiting_and_uses_the_new_hours(self):
        zone = "Asia/Karachi"
        c, _ = self.waiting(zone)
        r = self.api("patch", f"/telephony/campaigns/{c['id']}", json={"call_hours_start": "10:30"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.sweep(local(zone, *day(1), 10, 29))["resumed"], 0, "the new opening time is respected")
        self.assertEqual(self.sweep(local(zone, *day(1), 10, 30))["resumed"], 1)

    def test_switching_the_hours_off_stops_it(self):
        c, opens = self.waiting()
        self.api("patch", f"/telephony/campaigns/{c['id']}", json={"call_hours_enabled": False})
        self.assertIsNone(self.row(c["id"])["stopped_by_hours_at"])
        self.assertNotResumed(opens)

    def test_changing_the_list_stops_it(self):
        c, opens = self.waiting()
        other = supabase.table("lists").insert({"user_id": self.user, "name": "Other"}).execute().data[0]
        self.api("patch", f"/telephony/campaigns/{c['id']}", json={"list_id": other["id"]})
        row = self.row(c["id"])
        self.assertEqual((row["stopped_by_hours_at"], row["dial_cursor"]), (None, None))
        self.assertNotResumed(opens)

    def test_a_campaign_without_the_marker_is_never_started_by_itself(self):
        # e.g. paused on purpose, or stopped before this existed: it has a place but nobody asked for it to continue
        c, opens = self.waiting()
        supabase.table("outbound_campaigns").update({"stopped_by_hours_at": None}).eq("id", c["id"]).execute()
        self.assertNotResumed(opens)
        # a campaign that never ran is not touched either
        fresh = self.campaign("Asia/Karachi", name="Fresh")
        self.assertNotResumed(opens)
        self.assertEqual(self.row(fresh["id"])["status"], "Inactive")

    def test_a_manual_start_while_it_waits_takes_over(self):
        zone = "Asia/Karachi"
        c, opens = self.waiting(zone)
        self.at(opens)
        r = self.start(c["id"])
        self.assertEqual(r.json()["data"]["dialed"], 6)
        self.assertEqual(self.dialed(), self.expected_order)
        self.assertIsNone(self.row(c["id"])["stopped_by_hours_at"])
        self.assertNotResumed(local(zone, *day(2), 9))

    def test_a_manual_start_while_closed_changes_nothing_and_it_still_waits(self):
        zone = "Asia/Karachi"
        c, opens = self.waiting(zone)
        self.at(local(zone, *DAY, 20))
        self.assertEqual(self.start(c["id"]).status_code, 400)
        self.assertIsNotNone(self.row(c["id"])["stopped_by_hours_at"])
        self.assertEqual(self.sweep(opens)["resumed"], 1)

    def test_unreadable_hours_count_as_closed(self):
        c, opens = self.waiting()
        H.sql("UPDATE public.outbound_campaigns SET call_hours_start = 'garbage' WHERE id = %s", (c["id"],))
        self.assertEqual(self.sweep(opens), {"resumed": 0, "waiting": 1, "refused": 0})

    def test_a_deleted_campaign_is_simply_gone(self):
        c, opens = self.waiting()
        self.api("delete", f"/telephony/campaigns/{c['id']}")
        self.assertEqual(self.sweep(opens), {"resumed": 0, "waiting": 0, "refused": 0})


class SafetyTests(SchedulerBase):
    def test_two_sweeps_at_the_same_moment_start_it_only_once(self):
        zone = "Asia/Karachi"
        c = self.stopped_first_day(zone)
        self.closing_after(None, None)
        opens = local(zone, *day(1), 9, 0)
        self.at(opens)

        async def both():
            return await asyncio.gather(run_auto_resumes(opens), run_auto_resumes(opens))
        results = asyncio.run(both())
        self.assertEqual(sum(r["resumed"] for r in results), 1)
        self.assertEqual(self.dialed(), self.expected_order, "nobody called twice")

    def test_the_marker_can_only_be_claimed_once(self):
        # what keeps two workers (or a sweep racing a person) from both starting the campaign:
        # the second claim finds the marker already taken
        from services.campaign_scheduler import _claim
        c = self.stopped_first_day("Asia/Karachi")
        self.assertTrue(_claim(c["id"]))
        self.assertFalse(_claim(c["id"]))
        self.assertIsNone(self.row(c["id"])["stopped_by_hours_at"])
        # and a campaign with no marker can never be claimed
        self.assertFalse(_claim(self.campaign("Asia/Karachi", name="Never ran")["id"]))

    def test_sweeping_again_after_a_resume_does_nothing(self):
        zone = "Asia/Karachi"
        self.stopped_first_day(zone)
        self.closing_after(None, None)
        opens = local(zone, *day(1), 9, 0)
        self.assertEqual(self.sweep(opens)["resumed"], 1)
        self.assertEqual(self.sweep(opens + timedelta(minutes=1))["resumed"], 0)
        self.assertEqual(len(self.dialed()), 10)

    def test_an_empty_wallet_refuses_it_once_tells_the_owner_and_keeps_the_place(self):
        zone = "Asia/Karachi"
        c = self.stopped_first_day(zone)
        self.closing_after(None, None)
        H.sql("UPDATE public.billing SET balance = 0 WHERE user_id = %s", (self.user,))
        before = len(self.dialed())
        opens = local(zone, *day(1), 9, 0)
        self.assertEqual(self.sweep(opens), {"resumed": 0, "waiting": 0, "refused": 1})
        self.assertEqual(len(self.dialed()), before, "no call without money")
        (note,) = self.notifications()
        self.assertIn("could not continue automatically", note["title"])
        self.assertIn("balance", note["body"].lower())
        row = self.row(c["id"])
        self.assertEqual((row["status"], row["stopped_by_hours_at"] is None, row["dial_cursor"] is not None), ("Paused", True, True))
        # it does not keep retrying and re-notifying every minute
        self.assertEqual(self.sweep(opens + timedelta(minutes=1)), {"resumed": 0, "waiting": 0, "refused": 0})
        self.assertEqual(len(self.notifications()), 1)
        # once funded, Start carries on from the same place
        H.fund_wallet(self.user, 50)
        self.at(opens + timedelta(minutes=5))
        self.assertEqual(self.start(c["id"]).status_code, 200)
        self.assertEqual(self.dialed(), self.expected_order)

    def test_a_campaign_that_cannot_start_does_not_block_the_others(self):
        zone = "Asia/Karachi"
        bad = self.stopped_first_day(zone)
        good = self.stopped_first_day(zone)
        supabase.table("ai_agents").update({"vapi_assistant_id": None}).eq("id", self.agent["id"]).execute()
        # the agent is shared by both, so give the second campaign its own working one
        other_agent = make_agent(self.user, "Max")
        supabase.table("outbound_campaigns").update({"agent_id": other_agent["id"]}).eq("id", good["id"]).execute()
        self.closing_after(None, None)
        result = self.sweep(local(zone, *day(1), 9, 0))
        self.assertEqual((result["resumed"], result["refused"]), (1, 1))
        self.assertEqual(self.row(good["id"])["status"], "Active")
        self.assertEqual(self.row(bad["id"])["status"], "Paused")

    def test_the_owner_is_told_when_it_continued(self):
        zone = "Asia/Karachi"
        self.stopped_first_day(zone)
        self.closing_after(4, local(zone, *day(1), 18))          # cut off again: 2 left
        self.sweep(local(zone, *day(1), 9, 0))
        (note,) = self.notifications()
        self.assertIn("continued automatically", note["title"])
        self.assertIn("4 contacts called", note["body"])
        self.assertIn("2 left for the next opening", note["body"])

    def test_it_never_touches_another_accounts_campaign_settings(self):
        zone = "Asia/Karachi"
        c = self.stopped_first_day(zone)
        self.closing_after(None, None)
        other = H.make_user()
        before = self.row(c["id"])
        # the other account asking to pause THIS campaign changes nothing
        r = H.client.post(f"/telephony/campaigns/{c['id']}/pause", headers=H.auth(other))
        self.assertEqual(r.status_code, 200)
        self.assertIsNotNone(self.row(c["id"])["stopped_by_hours_at"])
        self.assertEqual(self.row(c["id"])["status"], before["status"])


class DuringARunTests(SchedulerBase):
    """What happens to a run that is already going: a person's Pause wins, and a crash never makes anyone
    be called twice."""

    def person_acts_after(self, calls, cid, action="pause"):
        """After `calls` more calls a person pauses (or sets another status on) the campaign, as if they
        clicked it while the run is going."""
        self._person_left = calls
        inner = self.create_call.side_effect

        async def placing(payload):
            result = await inner(payload)
            if self._person_left is not None:
                self._person_left -= 1
                if self._person_left == 0:
                    if action == "pause":
                        self.api("post", f"/telephony/campaigns/{cid}/pause")
                    else:
                        self.api("patch", f"/telephony/campaigns/{cid}", json={"status": action})
            return result
        self.create_call.side_effect = placing

    def test_a_pause_during_an_automatic_run_is_obeyed_and_nothing_continues_by_itself(self):
        zone = "Asia/Karachi"
        c = self.stopped_first_day(zone)                       # day 1: 4 contacts called, waiting for day 2
        self.closing_after(None, None)
        self.person_acts_after(2, c["id"])                     # a person clicks Pause after the first batch of day 2
        self.assertEqual(self.sweep(local(zone, *day(1), 9, 0))["resumed"], 1)
        self.assertEqual(self.dialed(), self.expected_order[:6], "stopped at the next batch: 4 + 2")
        row = self.row(c["id"])
        self.assertEqual((row["status"], row["stopped_by_hours_at"]), ("Paused", None))
        self.assertIsNotNone(row["dial_cursor"])
        # nothing starts it again by itself, that day or later
        self.assertEqual(self.sweep(local(zone, *day(1), 9, 5))["resumed"], 0)
        self.assertEqual(self.sweep(local(zone, *day(2), 9, 0))["resumed"], 0)
        self.assertEqual(len(self.dialed()), 6)
        # a person can still carry on from the same place, and nobody is called twice
        self.person_acts_after(None, c["id"])
        self.at(local(zone, *day(2), 10))
        self.assertEqual(self.api("post", f"/telephony/campaigns/{c['id']}/resume").status_code, 200)
        self.assertEqual(self.dialed(), self.expected_order)

    def test_a_pause_in_the_same_run_the_hours_end_does_not_re_arm_the_continuing(self):
        zone = "Asia/Karachi"
        c = self.campaign(zone)
        y, m, d = DAY
        self.at(local(zone, y, m, d, 9))
        self.person_acts_after(2, c["id"])                     # a person pauses after batch 1 ...
        inner = self.create_call.side_effect

        async def then_closing(payload):
            result = await inner(payload)
            if len(self.placed) == 2:
                self.at(local(zone, y, m, d, 18))              # ... and the hours end right after
            return result
        self.create_call.side_effect = then_closing
        r = self.start(c["id"])
        self.assertEqual(r.status_code, 200, r.text)
        row = self.row(c["id"])
        self.assertEqual((row["status"], row["stopped_by_hours_at"]), ("Paused", None), "the person's Pause wins over the hours")
        self.assertEqual(self.sweep(local(zone, *day(1), 9, 0))["resumed"], 0)

    def test_setting_it_inactive_mid_run_is_obeyed_too(self):
        zone = "Asia/Karachi"
        c = self.campaign(zone)
        self.at(local(zone, *DAY, 9))
        self.person_acts_after(2, c["id"], action="Inactive")
        data = self.start(c["id"]).json()["data"]
        self.assertEqual((data["dialed"], data.get("stopped_by_person"), data["remaining"]), (2, True, 8))
        self.assertNotIn("stopped_by_hours", data)
        self.assertEqual(self.row(c["id"])["status"], "Inactive")
        self.assertEqual(self.dialed(), self.expected_order[:2])

    def test_pausing_a_campaign_with_no_hours_stops_its_run_at_the_next_batch_too(self):
        c = self.make_campaign("UTC", call_hours_enabled=False)
        self.person_acts_after(2, c["id"])
        data = self.start(c["id"]).json()["data"]
        self.assertEqual((data["dialed"], data["stopped_by_person"]), (2, True))
        self.assertEqual(self.row(c["id"])["status"], "Paused")

    def test_deleting_a_campaign_mid_run_stops_the_run(self):
        c = self.make_campaign("UTC", call_hours_enabled=False)
        self._left_to_delete = 2
        inner = self.create_call.side_effect

        async def placing(payload):
            result = await inner(payload)
            self._left_to_delete -= 1
            if self._left_to_delete == 0:
                self.api("delete", f"/telephony/campaigns/{c['id']}")
            return result
        self.create_call.side_effect = placing
        self.assertEqual(self.start(c["id"]).status_code, 200)
        self.assertEqual(len(self.dialed()), 2, "nobody is called for a campaign that no longer exists")

    def test_a_crash_mid_run_never_causes_repeat_calls_at_worst_that_one_batch_is_skipped(self):
        c = self.make_campaign("UTC", call_hours_enabled=False)

        class Crash(BaseException):
            """A process kill: not an Exception, so nothing in the run swallows it."""

        inner = self.create_call.side_effect
        succeeded: list[str] = []          # the numbers whose call was really placed

        async def dies_in_the_third_batch(payload):
            if len(self.placed) >= 4:
                raise Crash()
            result = await inner(payload)
            succeeded.append(payload["customer"]["number"])
            return result
        self.create_call.side_effect = dies_in_the_third_batch
        with self.assertRaises(Crash):
            asyncio.run(telephony.start_campaign(c["id"], {"user_id": self.user}))
        self.assertEqual(succeeded, self.expected_order[:4], "two batches were finished before it died")
        row = self.row(c["id"])
        # the place was saved BEFORE the third batch was dialed: those two contacts are never called again
        self.assertEqual(str(row["dial_cursor"]), self.expected_ids()[5])
        self.assertEqual((row["status"], row["run_token"], row["run_heartbeat_at"]), ("Paused", None, None),
                         "parked, not left looking like it is running")

        async def alive(payload):
            result = await inner(payload)
            succeeded.append(payload["customer"]["number"])
            return result
        self.create_call.side_effect = alive
        self.assertEqual(self.start(c["id"]).status_code, 200)
        self.assertEqual(succeeded, self.expected_order[:4] + self.expected_order[6:], "nobody twice; only the interrupted batch was skipped")

    def test_a_campaign_already_running_cannot_be_started_a_second_time(self):
        c = self.make_campaign("UTC", call_hours_enabled=False)
        token = str(uuid.uuid4())
        # (a real run saves its place before dialing its first batch, so a running campaign has one)
        H.sql("UPDATE public.outbound_campaigns SET run_token = %s, run_heartbeat_at = %s, status = 'Active', dial_cursor = %s WHERE id = %s",
              (token, FakeDateTime.instant.strftime("%Y-%m-%dT%H:%M:%SZ"), self.expected_ids()[1], c["id"]))
        for path in ("start", "resume"):
            r = self.api("post", f"/telephony/campaigns/{c['id']}/{path}")
            self.assertEqual(r.status_code, 409, path)
            self.assertIn("already running", r.json()["detail"])
        self.create_call.assert_not_awaited()
        self.assertEqual(str(self.row(c["id"])["run_token"]), token, "the running run keeps its lease")

    def test_a_lease_nobody_refreshes_goes_stale_after_ten_minutes_and_can_be_taken_over(self):
        c = self.make_campaign("UTC", call_hours_enabled=False)
        for minutes, expected in ((9, 409), (11, 200)):
            H.sql("UPDATE public.outbound_campaigns SET run_token = %s, run_heartbeat_at = %s WHERE id = %s",
                  (str(uuid.uuid4()), (FakeDateTime.instant - timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%SZ"), c["id"]))
            self.assertEqual(self.start(c["id"]).status_code, expected, f"{minutes} minutes old")

    def test_a_finished_campaign_can_still_be_started_again_as_before(self):
        c = self.make_campaign("UTC", call_hours_enabled=False)
        self.assertEqual(self.start(c["id"]).json()["data"]["dialed"], 10)
        self.assertEqual(self.row(c["id"])["status"], "Active")
        self.assertEqual(self.start(c["id"]).status_code, 200)         # Active with no place saved: not running
        self.assertEqual(len(self.dialed()), 20)

    def test_no_place_is_left_behind_when_a_run_finishes(self):
        c = self.make_campaign("UTC", call_hours_enabled=False)
        self.start(c["id"])
        row = self.row(c["id"])
        self.assertEqual((row["status"], row["dial_cursor"], row["stopped_by_hours_at"]), ("Active", None, None))

    def test_a_running_campaign_is_not_reported_as_waiting_to_continue(self):
        c = self.make_campaign("UTC", call_hours_enabled=False)
        H.sql("UPDATE public.outbound_campaigns SET status = 'Active', dial_cursor = %s WHERE id = %s", (self.expected_ids()[0], c["id"]))
        listed = {x["id"]: x for x in self.api("get", "/telephony/campaigns").json()["data"]}[c["id"]]
        self.assertEqual(listed["auto_resume"], {"pending": False, "next_at": None})


class BoundaryTests(SchedulerBase):
    def test_hours_that_close_between_the_sweep_and_the_start_do_not_lose_the_continuing(self):
        zone = "Asia/Karachi"
        c = self.stopped_first_day(zone)
        self.closing_after(None, None)
        open_for_the_sweep = local(zone, *day(1), 17, 59) + timedelta(seconds=30)
        closed_for_the_start = local(zone, *day(1), 18, 0) + timedelta(seconds=1)
        self.at(closed_for_the_start)          # the clock the start uses: just past closing
        result = asyncio.run(run_auto_resumes(open_for_the_sweep))      # ... while the sweep still saw it open
        self.assertEqual(result, {"resumed": 0, "waiting": 1, "refused": 0})
        self.assertEqual(self.notifications(), [], "no false alarm for the owner")
        row = self.row(c["id"])
        self.assertEqual((row["status"], row["stopped_by_hours_at"] is not None), ("Paused", True), "still waiting")
        self.assertEqual(len(self.dialed()), 4)
        # and it continues at the next real opening
        self.assertEqual(self.sweep(local(zone, *day(2), 9, 0))["resumed"], 1)
        self.assertEqual(self.dialed(), self.expected_order)

    def test_a_person_pausing_before_the_sweep_is_never_overridden(self):
        zone = "Asia/Karachi"
        c = self.stopped_first_day(zone)
        self.closing_after(None, None)
        self.api("post", f"/telephony/campaigns/{c['id']}/pause")          # the marker is gone
        self.assertEqual(self.sweep(local(zone, *day(1), 9, 0))["resumed"], 0)
        self.assertEqual(self.sweep(local(zone, *day(1), 17, 59))["resumed"], 0)
        self.assertIsNone(self.row(c["id"])["stopped_by_hours_at"])
        self.assertEqual(len(self.dialed()), 4)

    def test_a_non_hours_refusal_is_still_reported_even_when_the_hours_are_open(self):
        zone = "Asia/Karachi"
        self.stopped_first_day(zone)
        self.closing_after(None, None)
        H.sql("UPDATE public.billing SET balance = 0 WHERE user_id = %s", (self.user,))
        self.assertEqual(self.sweep(local(zone, *day(1), 9, 0))["refused"], 1)
        self.assertEqual(len(self.notifications()), 1)

    def test_several_campaigns_waiting_for_the_same_opening_all_continue_in_one_sweep(self):
        zone = "Asia/Karachi"
        first = self.stopped_first_day(zone)
        second = self.stopped_first_day(zone)
        self.closing_after(None, None)
        before = len(self.dialed())
        self.assertEqual(self.sweep(local(zone, *day(1), 9, 0)), {"resumed": 2, "waiting": 0, "refused": 0})
        self.assertEqual(len(self.dialed()) - before, 12, "6 contacts left in each")
        for c in (first, second):
            self.assertEqual(self.row(c["id"])["status"], "Active")

    def test_campaigns_in_different_zones_continue_at_their_own_openings_in_the_same_sweep(self):
        karachi = self.stopped_first_day("Asia/Karachi")
        la = self.stopped_first_day("America/Los_Angeles")
        self.closing_after(None, None)
        # 9:00 Karachi on day 2 is the evening before in Los Angeles: only Karachi's is open
        self.assertEqual(self.sweep(local("Asia/Karachi", *day(1), 9, 0)), {"resumed": 1, "waiting": 1, "refused": 0})
        self.assertEqual(self.row(karachi["id"])["status"], "Active")
        self.assertEqual(self.row(la["id"])["status"], "Paused")
        self.assertEqual(self.sweep(local("America/Los_Angeles", *day(1), 9, 0))["resumed"], 1)
        self.assertEqual(self.row(la["id"])["status"], "Active")


class LeaseTests(SchedulerBase):
    """Every run holds a lease: one run at a time, and it is always given back."""

    def direct(self, cid):
        """Start the campaign without HTTP (so an exception reaches the test as itself)."""
        return asyncio.run(telephony.start_campaign(cid, {"user_id": self.user}))

    def lease(self, cid):
        row = self.row(cid)
        return row["run_token"], row["run_heartbeat_at"]

    def acts_after(self, calls, action):
        """After `calls` more calls, run `action()` (what a person does in another request)."""
        self._acts_left = calls
        inner = self.create_call.side_effect

        async def placing(payload):
            result = await inner(payload)
            if self._acts_left is not None:
                self._acts_left -= 1
                if self._acts_left == 0:
                    action()
            return result
        self.create_call.side_effect = placing

    def test_two_starts_at_the_same_moment_dial_the_list_once(self):
        # 10 contacts is below one batch of 20 in production: the saved place is not visible yet while
        # the first batch is being dialed, so only the lease can tell the second Start it is too late
        c = self.make_campaign("UTC", call_hours_enabled=False)

        async def both():
            return await asyncio.gather(
                telephony.start_campaign(c["id"], {"user_id": self.user}),
                telephony.start_campaign(c["id"], {"user_id": self.user}),
                return_exceptions=True,
            )
        results = asyncio.run(both())
        ok = [r for r in results if isinstance(r, dict)]
        refused = [r for r in results if isinstance(r, HTTPException)]
        self.assertEqual((len(ok), len(refused)), (1, 1), results)
        self.assertEqual(refused[0].status_code, 409)
        self.assertEqual(self.dialed(), self.expected_order, "every contact exactly once")

    def test_a_pause_followed_by_an_immediate_start_does_not_create_a_second_run(self):
        c = self.make_campaign("UTC", call_hours_enabled=False)
        seen = {}

        def pause_then_start_at_once():
            self.api("post", f"/telephony/campaigns/{c['id']}/pause")
            seen["resume"] = self.api("post", f"/telephony/campaigns/{c['id']}/resume").status_code
            seen["start"] = self.api("post", f"/telephony/campaigns/{c['id']}/start").status_code
        self.acts_after(2, pause_then_start_at_once)
        data = self.start(c["id"]).json()["data"]
        self.assertEqual((seen["resume"], seen["start"]), (409, 409), "the first run has not given its lease back yet")
        self.assertEqual((data["dialed"], data["stopped_by_person"]), (2, True))
        self.assertEqual(self.dialed(), self.expected_order[:2], "nothing was dialed twice, nothing continued")
        # once it has stopped, Start carries on from the saved place
        self.acts_after(None, lambda: None)
        self.assertEqual(self.start(c["id"]).status_code, 200)
        self.assertEqual(self.dialed(), self.expected_order)

    def test_the_lease_is_given_back_whatever_ends_the_run(self):
        none = (None, None)
        # finished
        c = self.make_campaign("UTC", call_hours_enabled=False)
        self.start(c["id"])
        self.assertEqual(self.lease(c["id"]), none, "finished")
        # stopped by the hours
        zone = "Asia/Karachi"
        c2 = self.stopped_first_day(zone)
        self.assertEqual(self.lease(c2["id"]), none, "stopped by the hours")
        # stopped by a person
        c3 = self.make_campaign("UTC", call_hours_enabled=False)
        self.acts_after(2, lambda: self.api("post", f"/telephony/campaigns/{c3['id']}/pause"))
        self.start(c3["id"])
        self.assertEqual(self.lease(c3["id"]), none, "paused by a person")
        # refused before dialing anything (nothing left after the saved place)
        self.acts_after(None, lambda: None)
        c4 = self.make_campaign("UTC", call_hours_enabled=False)
        H.sql("UPDATE public.outbound_campaigns SET dial_cursor = %s, status = 'Paused' WHERE id = %s", (self.expected_ids()[-1], c4["id"]))
        self.assertEqual(self.start(c4["id"]).status_code, 400)
        self.assertEqual(self.lease(c4["id"]), none, "refused")

    def test_an_error_from_a_service_mid_run_parks_the_campaign_instead_of_leaving_it_running(self):
        from services import whitelist_service
        c = self.make_campaign("UTC", call_hours_enabled=False, dnc_screening_enabled=True)
        calls = {"n": 0}

        async def check(owner, phone, cached=None):
            calls["n"] += 1
            if calls["n"] > 4:                                   # the third batch's screening fails
                raise RuntimeError("screening service down")
            return {"allowed": True, "reason": None}
        with patch.object(whitelist_service, "check_number", check), self.assertRaises(RuntimeError):
            self.direct(c["id"])
        row = self.row(c["id"])
        self.assertEqual((row["status"], row["run_token"]), ("Paused", None))
        self.assertEqual(self.dialed(), self.expected_order[:4])
        self.assertEqual(str(row["dial_cursor"]), self.expected_ids()[5], "the failed batch is not retried")
        # a person can start it again at once (the lease is free) and nobody is called twice
        with patch.object(whitelist_service, "check_number", AsyncMock(return_value={"allowed": True, "reason": None})):
            self.assertEqual(self.start(c["id"]).status_code, 200)
        self.assertEqual(self.dialed(), self.expected_order[:4] + self.expected_order[6:])

    def test_changing_the_list_mid_run_stops_it_and_never_stores_the_old_lists_place(self):
        zone = "Asia/Karachi"
        c = self.campaign(zone)
        other = supabase.table("lists").insert({"user_id": self.user, "name": "Other"}).execute().data[0]
        self.at(local(zone, *DAY, 9))
        self.acts_after(2, lambda: self.api("patch", f"/telephony/campaigns/{c['id']}", json={"list_id": other["id"]}))
        # the hours also end right after, so a stale place WOULD be stored with the marker if it were not for the list check
        self.closing_after(2, local(zone, *DAY, 18))
        data = self.start(c["id"]).json()["data"]
        self.assertEqual((data["dialed"], data.get("stopped_by_person")), (2, True))
        row = self.row(c["id"])
        self.assertEqual((row["dial_cursor"], row["stopped_by_hours_at"], row["run_token"]), (None, None, None))
        self.assertEqual(str(row["list_id"]), other["id"])
        self.assertEqual(self.sweep(local(zone, *day(1), 9, 0))["resumed"], 0)

    def test_hours_narrowed_mid_run_stop_it_at_the_next_batch_and_the_new_hours_apply_later(self):
        zone = "Asia/Karachi"
        c = self.campaign(zone)
        self.at(local(zone, *DAY, 9))
        # a person moves the opening to 13:00: it is closed right now, at 09:00
        self.acts_after(2, lambda: self.api("patch", f"/telephony/campaigns/{c['id']}", json={"call_hours_start": "13:00"}))
        data = self.start(c["id"]).json()["data"]
        self.assertEqual((data["dialed"], data["stopped_by_hours"], data["remaining"]), (2, True, 8))
        row = self.row(c["id"])
        self.assertEqual((row["status"], row["stopped_by_hours_at"] is not None), ("Paused", True))
        self.assertEqual(self.sweep(local(zone, *DAY, 12, 59))["resumed"], 0)
        self.acts_after(None, lambda: None)
        self.closing_after(None, None)
        self.assertEqual(self.sweep(local(zone, *DAY, 13, 0))["resumed"], 1, "it continues when the NEW hours open")
        self.assertEqual(self.dialed(), self.expected_order)

    def test_hours_switched_off_mid_run_let_it_finish_without_any_limit(self):
        zone = "Asia/Karachi"
        c = self.campaign(zone)
        self.at(local(zone, *DAY, 9))
        self.acts_after(2, lambda: self.api("patch", f"/telephony/campaigns/{c['id']}", json={"call_hours_enabled": False}))
        self.closing_after(2, local(zone, *DAY, 18))             # the old hours would have ended here
        data = self.start(c["id"]).json()["data"]
        self.assertEqual(data["dialed"], 10)
        self.assertNotIn("stopped_by_hours", data)
        row = self.row(c["id"])
        self.assertEqual((row["status"], row["dial_cursor"], row["stopped_by_hours_at"]), ("Active", None, None))

    def test_setting_a_parked_campaign_to_active_by_hand_does_not_leave_it_stuck(self):
        zone = "Asia/Karachi"
        c = self.stopped_first_day(zone)
        self.closing_after(None, None)
        self.api("patch", f"/telephony/campaigns/{c['id']}", json={"status": "Active"})
        row = self.row(c["id"])
        self.assertEqual((row["status"], row["stopped_by_hours_at"], row["dial_cursor"] is not None), ("Active", None, True))
        self.at(local(zone, *day(1), 9))
        r = self.start(c["id"])
        self.assertEqual(r.status_code, 200, "not mistaken for a running campaign")
        self.assertEqual(self.dialed(), self.expected_order, "it carries on from the saved place")

    def test_nothing_left_after_the_saved_place_clears_the_marker_and_the_lease_too(self):
        zone = "Asia/Karachi"
        c = self.stopped_first_day(zone)
        H.sql("UPDATE public.outbound_campaigns SET dial_cursor = %s WHERE id = %s", (self.expected_ids()[-1], c["id"]))
        self.at(local(zone, *day(1), 9))
        r = self.start(c["id"])
        self.assertEqual(r.status_code, 400)
        self.assertIn("already been dialed", r.json()["detail"])
        row = self.row(c["id"])
        self.assertEqual((row["status"], row["dial_cursor"], row["stopped_by_hours_at"], row["run_token"]), ("Inactive", None, None, None))

    def test_a_start_refused_after_the_lease_was_taken_puts_the_campaign_back_as_it_was(self):
        # the number was never connected: refused only once the run is under way (the lease is taken first)
        c = self.make_campaign("UTC", call_hours_enabled=False)
        H.sql("UPDATE public.phone_numbers SET vapi_phone_id = NULL WHERE id = %s", (self.out_number["id"],))
        r = self.start(c["id"])
        self.assertEqual(r.status_code, 400)
        self.assertIn("not active yet", r.json()["detail"])
        row = self.row(c["id"])
        self.assertEqual((row["status"], row["run_token"], row["run_heartbeat_at"]), ("Inactive", None, None),
                         "not left Active as if it had run")
        self.create_call.assert_not_awaited()

    def test_hours_closing_between_the_first_check_and_the_run_keep_a_waiting_campaign_waiting(self):
        zone = "Asia/Karachi"
        c = self.stopped_first_day(zone)
        before = self.row(c["id"])
        original = call_hours.is_open
        calls = {"n": 0}

        def closes_after_the_first_check(row, prefix, now=None, *, if_unreadable=True):
            calls["n"] += 1
            return calls["n"] == 1 and original(row, prefix, now, if_unreadable=if_unreadable)
        self.at(local(zone, *day(1), 9))
        with patch.object(call_hours, "is_open", side_effect=closes_after_the_first_check):
            r = self.start(c["id"])
        self.assertEqual(r.status_code, 400)
        row = self.row(c["id"])
        self.assertEqual((row["status"], row["stopped_by_hours_at"], row["dial_cursor"]),
                         (before["status"], before["stopped_by_hours_at"], before["dial_cursor"]),
                         "still Paused, still marked to continue, same place")
        self.assertIsNone(row["run_token"])

    def test_a_run_that_lost_its_lease_cannot_overwrite_the_run_that_took_over(self):
        # the last batch of run A is in flight when its lease is taken over (A looked dead for ten
        # minutes); when A's last batch ends, its end-of-run write must find the lease is not its own
        c = self.make_campaign("UTC", call_hours_enabled=False)
        other = str(uuid.uuid4())
        self.acts_after(9, lambda: H.sql(
            "UPDATE public.outbound_campaigns SET run_token = %s, status = 'Paused', dial_cursor = NULL WHERE id = %s", (other, c["id"])))
        self.start(c["id"])
        row = self.row(c["id"])
        self.assertEqual(str(row["run_token"]), other, "the new holder keeps its lease")
        self.assertEqual((row["status"], row["dial_cursor"]), ("Paused", None), "and its state is not overwritten")

    def test_the_sweep_leaves_a_campaign_someone_else_is_already_running_alone(self):
        zone = "Asia/Karachi"
        c = self.stopped_first_day(zone)
        self.closing_after(None, None)
        token = str(uuid.uuid4())
        opens = local(zone, *day(1), 9, 0)
        H.sql("UPDATE public.outbound_campaigns SET run_token = %s, run_heartbeat_at = %s WHERE id = %s",
              (token, opens.strftime("%Y-%m-%dT%H:%M:%SZ"), c["id"]))        # a person's run (or another worker's) is on it
        before = len(self.dialed())
        self.assertEqual(self.sweep(opens), {"resumed": 0, "waiting": 1, "refused": 0})
        self.assertEqual(len(self.dialed()), before, "not dialed a second time")
        self.assertEqual(self.notifications(), [], "and no false alarm")
        self.assertEqual(str(self.row(c["id"])["run_token"]), token, "their lease is untouched")

    def test_a_long_run_does_not_hold_up_the_next_sweep(self):
        karachi = self.stopped_first_day("Asia/Karachi")
        la = self.stopped_first_day("America/Los_Angeles")
        self.closing_after(None, None)
        gate_state = {"first": True}
        inner = self.create_call.side_effect

        async def main():
            gate = asyncio.Event()

            async def slow_first_call(payload):
                if gate_state["first"]:
                    gate_state["first"] = False
                    await gate.wait()                 # the first campaign's first call hangs for a while
                return await inner(payload)
            self.create_call.side_effect = slow_first_call

            opens_karachi = local("Asia/Karachi", *day(1), 9, 0)
            self.at(opens_karachi)
            first = await run_auto_resumes(opens_karachi, wait=False)      # returns at once: Karachi's run is hanging
            self.assertEqual(first["resumed"], 0, "its run is still going, the sweep did not wait for it")
            await asyncio.sleep(0.05)
            self.assertIsNotNone(self.row(karachi["id"])["run_token"], "Karachi's run is holding its lease")

            # ... and the NEXT sweep, while that run is still hanging, starts Los Angeles' campaign
            opens_la = local("America/Los_Angeles", *day(1), 9, 0)
            self.at(opens_la)
            await run_auto_resumes(opens_la, wait=False)
            for _ in range(200):
                if self.row(la["id"])["status"] == "Active" and self.row(la["id"])["run_token"] is None:
                    break
                await asyncio.sleep(0.05)
            self.assertEqual(self.row(la["id"])["status"], "Active", "Los Angeles continued although Karachi's run is still hanging")
            self.assertIsNotNone(self.row(karachi["id"])["run_token"])
            gate.set()
            for _ in range(200):
                if self.row(karachi["id"])["run_token"] is None:
                    break
                await asyncio.sleep(0.05)
        asyncio.run(main())
        self.assertIsNone(self.row(karachi["id"])["run_token"], "and it gave its lease back when it ended")


class WiringTests(unittest.TestCase):
    def test_the_sweep_runs_every_minute_by_default_and_can_be_switched_off(self):
        self.assertEqual(settings.campaign_sweep_interval_seconds, 60)
        self.assertTrue(asyncio.iscoroutinefunction(campaign_loop))

    def test_the_app_starts_the_loop(self):
        import main
        self.assertTrue(any(getattr(h, "__name__", "") == "_start_campaign_scheduler" for h in main.app.router.on_startup))

    def test_the_hours_module_and_the_scheduler_agree_on_what_open_means(self):
        zone = "Pacific/Chatham"
        row = {"call_hours_enabled": True, "call_hours_timezone": zone, "call_hours_days": ALL_DAYS,
               "call_hours_start": "09:00", "call_hours_end": "18:00"}
        self.assertTrue(call_hours.is_open(row, call_hours.CAMPAIGN, local(zone, *DAY, 9, 0), if_unreadable=False))
        self.assertFalse(call_hours.is_open(row, call_hours.CAMPAIGN, local(zone, *DAY, 18, 0), if_unreadable=False))


if __name__ == "__main__":
    unittest.main()
