"""
Follow-up rounds: a campaign calls its unreached numbers again by itself (services/followup_rounds.py, the engine
`run_followups` in services/campaign_scheduler.py, the settings on create / PATCH, the `followup` object of the
campaign API, Start resetting the rounds, and the manual "Retry unreached numbers" button staying independent).

A campaign is run for real (a mocked call placer, calls ended through call_retry.finish_attempt, a frozen clock) until
some numbers are settled "Max attempts reached"; then the sweep is driven at chosen instants. Helpers come from
test_retry_unreached.py (which builds those campaigns) and test_dial_engine.py.

Run from the backend folder:  python -m unittest discover -s tests -p "test_followup_rounds.py" -v
"""
import asyncio
import unittest
from unittest.mock import AsyncMock, patch

import byot_harness as H
from database import supabase
from services import call_retry, campaign_scheduler, followup_rounds

from test_dial_engine import ALL_DAYS, MIN, SEC, T0
from test_dial_migration import MigrationBase
from test_retry_unreached import UnreachedBase
from test_timezones import local

HOUR = 60 * MIN
DAY = 24 * HOUR


class FollowBase(UnreachedBase):
    def setUp(self):
        super().setUp()
        # other tests' campaigns must not be swept (or counted) here
        H.sql("UPDATE public.outbound_campaigns SET followup_rounds = 0, followup_next_at = NULL, followup_done = 0")
        self.addCleanup(lambda: H.sql("UPDATE public.outbound_campaigns SET followup_rounds = 0, followup_next_at = NULL, followup_done = 0"))

    def sweep(self, at):
        self.at(at)
        return asyncio.run(campaign_scheduler.run_followups(at))

    def notes(self):
        return supabase.table("notifications").select("*").eq("user_id", self.user).eq("kind", "campaign_followup").execute().data

    def next_at(self, cid):
        return call_retry.parse_time(self.row(cid)["followup_next_at"])

    def follow(self, cid):
        return self.api("get", f"/telephony/campaigns/{cid}").json()["data"]["followup"]

    def scheduled(self, c, at=None):
        """Sweep once at `at` (default 5 minutes after the pass): the round is scheduled. Returns its due time."""
        at = at or T0 + 5 * MIN
        self.assertEqual(self.sweep(at)["scheduled"], 1)
        return self.next_at(c["id"])

    def patch(self, cid, expect=200, **body):
        r = self.api("patch", f"/telephony/campaigns/{cid}", json=body)
        self.assertEqual(r.status_code, expect, r.text)
        return r

    def statuses(self, cid, contacts):
        return [self.lead(cid, p)["final_status"] for p in contacts]


class ScheduleTests(FollowBase):
    def test_a_complete_campaign_gets_its_first_round_scheduled_one_gap_after_it_completes(self):
        c, g = self.build(unreached=3, answered=1, followup_rounds=2, followup_gap_hours=24)
        now = T0 + 5 * MIN
        out = self.sweep(now)
        self.assertEqual((out["scheduled"], out["started"]), (1, 0))
        row = self.row(c["id"])
        self.assertEqual((row["followup_done"], self.next_at(c["id"])), (0, now + 24 * HOUR))
        f = self.follow(c["id"])
        self.assertEqual((f["rounds"], f["gap_hours"], f["done"], f["waiting"]), (2, 24, 0, True))
        self.assertEqual(call_retry.parse_time(f["next_at"]), now + 24 * HOUR)
        # nobody was called and nobody was touched
        self.assertEqual(self.statuses(c["id"], g["unreached"]), ["max_attempts"] * 3)
        self.assertEqual(len(self.attempts(c["id"])), 4)

    def test_a_second_sweep_does_not_move_the_scheduled_time(self):
        c, g = self.build(unreached=2, followup_rounds=1, followup_gap_hours=6)
        due = self.scheduled(c)
        out = self.sweep(T0 + 30 * MIN)
        self.assertEqual((out["scheduled"], out["waiting"]), (0, 1))
        self.assertEqual(self.next_at(c["id"]), due)

    def test_nothing_is_scheduled_when_the_rounds_are_off(self):
        c, g = self.build(unreached=2)                       # followup_rounds 0 (the default)
        self.assertEqual(self.sweep(T0 + 5 * MIN)["scheduled"], 0)
        self.assertIsNone(self.row(c["id"])["followup_next_at"])

    def test_nothing_is_scheduled_when_no_number_is_unreached(self):
        c, g = self.build(unreached=0, answered=2, not_retried=1, followup_rounds=2)
        self.assertEqual(self.sweep(T0 + 5 * MIN)["scheduled"], 0)
        self.assertIsNone(self.row(c["id"])["followup_next_at"])
        self.assertEqual(self.follow(c["id"])["waiting"], False)

    def test_not_before_the_pass_over_the_list_has_finished(self):
        cs = self.contacts(2)
        c = self.campaign("sequential", retry_enabled=True, retry_max_attempts=1,
                          retry_interval_minutes=10, retry_on=["no_answer"], followup_rounds=1)
        self.start(c["id"])                                     # one line: the second number has not been dialed yet
        self.end_phone(c["id"], cs[0], "no_answer", "customer-did-not-answer", at=T0 + SEC)
        self.assertEqual(self.active(c["id"]), 0)
        self.assertTrue(self.row(c["id"])["dial_running"], "the list is not finished")
        self.assertEqual(self.sweep(T0 + MIN)["scheduled"], 0, "one number is unreached already, but the list is not done")
        self.assertIsNone(self.row(c["id"])["followup_next_at"])
        self.tick(c["id"], T0 + MIN)                            # the second number is dialed: the list is done
        self.assertFalse(self.row(c["id"])["dial_running"])
        self.assertEqual(self.sweep(T0 + MIN)["scheduled"], 0, "its call is still open")
        self.end_phone(c["id"], cs[1], "no_answer", "customer-did-not-answer", at=T0 + 2 * MIN)
        self.assertEqual(self.sweep(T0 + 2 * MIN)["scheduled"], 1)

    def test_not_while_a_call_is_still_open(self):
        cs = self.contacts(2)
        c = self.campaign("concurrent", dial_concurrent_calls=20, retry_enabled=True, retry_max_attempts=1,
                          retry_interval_minutes=10, retry_on=["no_answer"], followup_rounds=1)
        self.start(c["id"])
        self.end_phone(c["id"], cs[0], "no_answer", "customer-did-not-answer", at=T0 + SEC)
        self.tick(c["id"], T0 + 2 * SEC)
        self.assertFalse(self.row(c["id"])["dial_running"])
        self.assertEqual(self.active(c["id"]), 1)
        self.assertEqual(self.sweep(T0 + MIN)["scheduled"], 0)
        self.end_phone(c["id"], cs[1], "no_answer", "customer-did-not-answer", at=T0 + 2 * MIN)
        self.assertEqual(self.sweep(T0 + 2 * MIN)["scheduled"], 1)

    def test_not_while_any_call_of_the_campaign_is_open_even_if_its_number_is_settled(self):
        # (an end report that has not arrived for a number settled by hand: the open call alone blocks the round)
        c, g = self.build(unreached=2, followup_rounds=1)
        H.sql("UPDATE public.campaign_attempts SET ended_at = NULL WHERE campaign_id = %s::uuid AND phone_key = %s",
              (c["id"], call_retry.phone_key(g["unreached"][0]["phone"])))
        self.assertEqual(self.sweep(T0 + 5 * MIN)["scheduled"], 0)
        H.sql("UPDATE public.campaign_attempts SET ended_at = now() WHERE campaign_id = %s::uuid AND ended_at IS NULL", (c["id"],))
        self.assertEqual(self.sweep(T0 + 5 * MIN)["scheduled"], 1)

    def test_not_while_a_number_still_waits_for_a_redial(self):
        c, g = self.build(unreached=2, answered=1, followup_rounds=1)
        waiting = g["answered"][0]
        H.sql("UPDATE public.campaign_leads SET final_status = NULL, last_outcome = 'no_answer', attempts = 1, "
              "next_attempt_at = %s::timestamptz WHERE campaign_id = %s::uuid AND contact_id = %s::uuid",
              (call_retry.iso(T0 + 30 * MIN), c["id"], waiting["id"]))
        self.assertEqual(self.sweep(T0 + 5 * MIN)["scheduled"], 0)
        H.sql("UPDATE public.campaign_leads SET final_status = 'answered', next_attempt_at = NULL "
              "WHERE campaign_id = %s::uuid AND contact_id = %s::uuid", (c["id"], waiting["id"]))
        self.assertEqual(self.sweep(T0 + 5 * MIN)["scheduled"], 1)

    def test_not_when_the_campaign_is_not_active_and_not_with_a_place_left_by_the_old_engine(self):
        c, g = self.build(unreached=2, followup_rounds=1)
        self.api("post", f"/telephony/campaigns/{c['id']}/pause")
        self.assertEqual(self.sweep(T0 + 5 * MIN)["scheduled"], 0, "paused")
        self.api("post", f"/telephony/campaigns/{c['id']}/resume")
        H.sql("UPDATE public.outbound_campaigns SET dial_cursor = %s::uuid WHERE id = %s::uuid", (g["unreached"][0]["id"], c["id"]))
        self.assertEqual(self.sweep(T0 + 5 * MIN)["scheduled"], 0, "an open pass (a cursor) is not a finished list")
        H.sql("UPDATE public.outbound_campaigns SET dial_cursor = NULL WHERE id = %s::uuid", (c["id"],))
        self.assertEqual(self.sweep(T0 + 5 * MIN)["scheduled"], 1)

    def test_not_when_auto_redial_is_off(self):
        c, g = self.build(unreached=2, followup_rounds=1)
        # the API refuses this state, so it is forced: a schedule that can no longer happen is dropped, nothing is scheduled
        self.scheduled(c)
        H.sql("UPDATE public.outbound_campaigns SET retry_enabled = false WHERE id = %s::uuid", (c["id"],))
        self.sweep(T0 + 6 * MIN)
        self.assertIsNone(self.row(c["id"])["followup_next_at"])
        self.assertEqual(self.sweep(T0 + 7 * MIN)["scheduled"], 0)


class StartRoundTests(FollowBase):
    def test_the_round_starts_when_the_wait_is_over_and_not_before(self):
        c, g = self.build(unreached=3, answered=1, followup_rounds=2, followup_gap_hours=24)
        due = self.scheduled(c)
        out = self.sweep(due - SEC)
        self.assertEqual((out["started"], out["waiting"]), (0, 1))
        self.assertEqual(self.statuses(c["id"], g["unreached"]), ["max_attempts"] * 3)
        self.assertEqual(self.notes(), [])

        out = self.sweep(due)
        self.assertEqual(out["started"], 1)
        row = self.row(c["id"])
        self.assertEqual((row["followup_done"], row["followup_next_at"]), (1, None))
        for p in g["unreached"]:
            lead = self.lead(c["id"], p)
            self.assertEqual((lead["round"], lead["attempts"], lead["final_status"]), (2, 0, None))
            self.assertEqual(call_retry.parse_time(lead["next_attempt_at"]), due)
        self.assertEqual(self.lead(c["id"], g["answered"][0])["final_status"], "answered", "the others are never called again")
        f = self.follow(c["id"])
        self.assertEqual((f["done"], f["waiting"], f["next_at"]), (1, False, None))
        res = self.tick(c["id"], due)
        self.assertEqual(res.redials_placed, 3)
        self.assertEqual(sorted(a["phone_key"] for a in self.attempts(c["id"]) if a["round"] == 2), sorted(self.keys(g["unreached"])))
        self.assertEqual(len(self.attempts(c["id"])), 7, "four in the first pass, three in the round")

    def test_one_notification_says_which_round_and_how_many_numbers(self):
        c, g = self.build(unreached=3, followup_rounds=2, followup_gap_hours=1)
        due = self.scheduled(c)
        self.sweep(due)
        notes = self.notes()
        self.assertEqual(len(notes), 1)
        self.assertIn("round 1 of 2", notes[0]["title"])
        self.assertIn("Follow-up round 1 of 2 started: 3 numbers", notes[0]["body"])
        self.sweep(due + MIN)
        self.sweep(due + 2 * MIN)
        self.assertEqual(len(self.notes()), 1, "no second notification for the same round")
        for text in (notes[0]["title"], notes[0]["body"]):
            self.assertNotIn("VAPI", text.upper())

    def test_a_single_number_reads_in_the_singular(self):
        c, g = self.build(unreached=1, followup_rounds=1, followup_gap_hours=1)
        self.sweep(self.scheduled(c))
        self.assertIn("1 number that never picked up is being called again", self.notes()[0]["body"])

    def test_two_sweeps_at_the_same_instant_start_the_round_once(self):
        c, g = self.build(unreached=3, followup_rounds=3, followup_gap_hours=2)
        due = self.scheduled(c)
        self.at(due)

        async def both():
            return await asyncio.gather(campaign_scheduler.run_followups(due), campaign_scheduler.run_followups(due))
        outs = asyncio.run(both())
        self.assertEqual(sum(o["started"] for o in outs), 1)
        self.assertEqual(self.row(c["id"])["followup_done"], 1)
        self.assertEqual({self.lead(c["id"], p)["round"] for p in g["unreached"]}, {2}, "requeued once, not twice")
        self.assertEqual(len(self.notes()), 1)
        out = self.sweep(due)                                   # and a third, later sweep finds nothing to start
        self.assertEqual(out["started"], 0)
        self.assertEqual(self.row(c["id"])["followup_done"], 1)

    def test_two_sweeps_schedule_the_round_once(self):
        c, g = self.build(unreached=2, followup_rounds=1)
        now = T0 + 5 * MIN
        self.at(now)

        async def both():
            return await asyncio.gather(campaign_scheduler.run_followups(now), campaign_scheduler.run_followups(now))
        outs = asyncio.run(both())
        self.assertEqual(sum(o["scheduled"] for o in outs), 1)
        self.assertEqual(self.next_at(c["id"]), now + 24 * HOUR)

    def test_a_failed_requeue_gives_the_round_back(self):
        c, g = self.build(unreached=2, followup_rounds=2, followup_gap_hours=1)
        due = self.scheduled(c)
        with patch.object(call_retry, "requeue_unreached", side_effect=RuntimeError("database went away")):
            out = self.sweep(due)
        self.assertEqual(out["started"], 0)
        row = self.row(c["id"])
        self.assertEqual((row["followup_done"], call_retry.parse_time(row["followup_next_at"])), (0, due), "not consumed, due again")
        self.assertEqual(self.notes(), [])
        self.assertEqual(self.sweep(due + MIN)["started"], 1, "the next sweep starts it")


class RoundsEndTests(FollowBase):
    def test_three_rounds_then_it_stops(self):
        c, g = self.build(unreached=2, followup_rounds=3, followup_gap_hours=1)
        t = T0 + 5 * MIN
        for n in range(1, 4):
            self.assertEqual(self.sweep(t)["scheduled"], 1, f"round {n} scheduled once the list is complete again")
            t += HOUR
            self.assertEqual(self.sweep(t)["started"], 1)
            self.assertEqual(self.row(c["id"])["followup_done"], n)
            self.assertEqual(self.tick(c["id"], t).redials_placed, 2)
            self.end_all(c["id"], t + MIN)                      # they never pick up again
            t += 2 * MIN
        self.assertEqual(self.statuses(c["id"], g["unreached"]), ["max_attempts"] * 2)
        for later in (t, t + 3 * DAY, t + 30 * DAY):
            out = self.sweep(later)
            self.assertEqual((out["scheduled"], out["started"]), (0, 0), "never more than the rounds asked for")
        row = self.row(c["id"])
        self.assertEqual((row["followup_done"], row["followup_next_at"]), (3, None))
        self.assertEqual(len(self.attempts(c["id"])), 2 + 3 * 2)
        self.assertEqual(len(self.notes()), 3)
        f = self.follow(c["id"])
        self.assertEqual((f["rounds"], f["done"], f["waiting"]), (3, 3, False))

    def test_a_number_that_answers_in_a_round_is_not_called_in_the_next(self):
        c, g = self.build(unreached=3, followup_rounds=2, followup_gap_hours=1)
        due = self.scheduled(c)
        self.sweep(due)
        self.tick(c["id"], due)
        self.end_phone(c["id"], g["unreached"][0], "answered", "customer-ended-call", at=due + MIN)
        self.end_phone(c["id"], g["unreached"][1], "no_answer", "customer-did-not-answer", at=due + MIN)
        self.end_phone(c["id"], g["unreached"][2], "no_answer", "customer-did-not-answer", at=due + MIN)
        due2 = self.scheduled(c, due + 2 * MIN)
        self.sweep(due2)
        self.assertEqual(self.lead(c["id"], g["unreached"][0])["final_status"], "answered")
        self.assertEqual(self.tick(c["id"], due2).redials_placed, 2)
        self.assertEqual(self.row(c["id"])["followup_done"], 2)

    def test_nothing_unreached_when_the_time_comes_drops_the_schedule_and_uses_no_round(self):
        c, g = self.build(unreached=2, followup_rounds=2, followup_gap_hours=3)
        due = self.scheduled(c)
        H.sql("UPDATE public.campaign_leads SET final_status = 'answered' WHERE campaign_id = %s::uuid", (c["id"],))
        before = len(self.attempts(c["id"]))
        out = self.sweep(due)
        self.assertEqual((out["cleared"], out["started"]), (1, 0))
        row = self.row(c["id"])
        self.assertEqual((row["followup_done"], row["followup_next_at"]), (0, None))
        self.assertEqual(self.notes(), [])
        self.assertEqual(len(self.attempts(c["id"])), before)
        self.assertEqual(self.sweep(due + MIN)["scheduled"], 0, "and it stays unscheduled while nothing is unreached")


class WaitingTests(FollowBase):
    def test_the_due_time_outside_the_calling_hours_moves_to_the_next_opening(self):
        hours = dict(call_hours_enabled=True, call_hours_timezone="UTC", call_hours_days=ALL_DAYS,
                     call_hours_start="09:00", call_hours_end="18:00")
        c, g = self.build(unreached=2, followup_rounds=2, followup_gap_hours=24, **hours)
        night = local("UTC", 2026, 10, 14, 20)
        due = self.scheduled(c, night)
        self.assertEqual(due, local("UTC", 2026, 10, 16, 9), "Oct 15 20:00 is closed: the next opening is Oct 16 09:00")
        self.assertEqual(self.sweep(local("UTC", 2026, 10, 16, 8, 59))["started"], 0)
        self.assertEqual(self.sweep(local("UTC", 2026, 10, 16, 9))["started"], 1)
        self.assertEqual(self.tick(c["id"], local("UTC", 2026, 10, 16, 9)).redials_placed, 2)

    def test_a_due_time_inside_the_hours_is_kept_and_a_short_gap_still_waits_for_the_opening(self):
        hours = dict(call_hours_enabled=True, call_hours_timezone="UTC", call_hours_days=ALL_DAYS,
                     call_hours_start="09:00", call_hours_end="18:00")
        c, g = self.build(unreached=2, followup_rounds=2, followup_gap_hours=24, **hours)
        noon = T0 + 5 * MIN
        self.assertEqual(self.scheduled(c, noon), noon + 24 * HOUR, "Oct 15 12:05 is open: unchanged")
        H.sql("UPDATE public.outbound_campaigns SET followup_next_at = NULL WHERE id = %s::uuid", (c["id"],))
        self.patch(c["id"], followup_gap_hours=12)
        night = local("UTC", 2026, 10, 14, 20)
        self.assertEqual(self.scheduled(c, night), local("UTC", 2026, 10, 15, 9), "Oct 15 08:00 is closed: 09:00")

    def test_hours_that_close_before_the_round_starts_make_its_numbers_wait_like_any_redial(self):
        c, g = self.build(unreached=2, followup_rounds=1, followup_gap_hours=1)
        due = self.scheduled(c)
        self.patch(c["id"], call_hours_enabled=True, call_hours_timezone="UTC", call_hours_days=ALL_DAYS,
                   call_hours_start="09:00", call_hours_end="12:30")
        self.assertEqual(self.sweep(due)["started"], 1, "the round is started (it is queued)")
        before = len(self.attempts(c["id"]))
        self.tick(c["id"], due)
        self.assertEqual(len(self.attempts(c["id"])), before, "no call outside the hours")
        for p in g["unreached"]:
            self.assertEqual(call_retry.parse_time(self.lead(c["id"], p)["next_attempt_at"]), local("UTC", 2026, 10, 15, 9))

    def test_a_paused_campaign_waits_and_carries_on_when_resumed(self):
        c, g = self.build(unreached=3, followup_rounds=2, followup_gap_hours=2)
        due = self.scheduled(c)
        self.api("post", f"/telephony/campaigns/{c['id']}/pause")
        out = self.sweep(due + HOUR)
        self.assertEqual(out["started"], 0)
        self.assertEqual(self.statuses(c["id"], g["unreached"]), ["max_attempts"] * 3)
        row = self.row(c["id"])
        self.assertEqual((row["followup_done"], call_retry.parse_time(row["followup_next_at"])), (0, due), "still scheduled")
        self.assertEqual(self.notes(), [])
        self.api("post", f"/telephony/campaigns/{c['id']}/resume")
        self.assertEqual(self.sweep(due + 2 * HOUR)["started"], 1)
        self.assertEqual(self.tick(c["id"], due + 2 * HOUR).redials_placed, 3)

    def test_an_inactive_campaign_waits_and_carries_on_when_it_is_active_again(self):
        c, g = self.build(unreached=2, followup_rounds=1, followup_gap_hours=2)
        due = self.scheduled(c)
        self.patch(c["id"], status="Inactive")
        self.assertEqual(self.sweep(due + HOUR)["started"], 0)
        self.assertEqual(self.row(c["id"])["followup_done"], 0)
        self.assertIsNotNone(self.row(c["id"])["followup_next_at"])
        self.patch(c["id"], status="Active")
        self.assertEqual(self.sweep(due + 2 * HOUR)["started"], 1)

    def test_a_scheduled_round_waits_while_calls_are_open_or_redials_are_pending(self):
        c, g = self.build(unreached=3, answered=1, followup_rounds=1, followup_gap_hours=2)
        due = self.scheduled(c)
        waiting = g["answered"][0]
        H.sql("UPDATE public.campaign_leads SET final_status = NULL, attempts = 1, next_attempt_at = %s::timestamptz "
              "WHERE campaign_id = %s::uuid AND contact_id = %s::uuid", (call_retry.iso(due + 5 * HOUR), c["id"], waiting["id"]))
        out = self.sweep(due)
        self.assertEqual((out["started"], out["cleared"], out["waiting"]), (0, 0, 1))
        self.assertEqual(self.row(c["id"])["followup_done"], 0)
        self.assertIsNotNone(self.row(c["id"])["followup_next_at"])
        H.sql("UPDATE public.campaign_leads SET final_status = 'answered', next_attempt_at = NULL "
              "WHERE campaign_id = %s::uuid AND contact_id = %s::uuid", (c["id"], waiting["id"]))
        self.assertEqual(self.sweep(due + MIN)["started"], 1, "a round that was due goes as soon as the campaign is complete")


class ManualButtonTests(FollowBase):
    def test_the_manual_button_does_not_use_up_a_round_and_clears_a_schedule_with_nothing_left(self):
        c, g = self.build(unreached=3, followup_rounds=2, followup_gap_hours=24)
        self.scheduled(c)
        self.assertIsNotNone(self.row(c["id"])["followup_next_at"])
        data = self.requeue(c["id"])
        self.assertEqual(data["requeued"], 3)
        row = self.row(c["id"])
        self.assertEqual((row["followup_done"], row["followup_next_at"]), (0, None), "no round used, nothing left to schedule")
        self.assertEqual(self.notes(), [])
        # the numbers never pick up again: the campaign is complete again and the rounds are still all there
        self.tick(c["id"], T0 + 6 * MIN)
        self.end_all(c["id"], T0 + 7 * MIN)
        self.assertEqual(self.sweep(T0 + 8 * MIN)["scheduled"], 1)
        self.assertEqual(self.row(c["id"])["followup_done"], 0)
        self.assertEqual(self.follow(c["id"])["rounds"], 2)

    def test_the_manual_button_is_unlimited_and_leaves_the_rounds_already_used_alone(self):
        c, g = self.build(unreached=2, followup_rounds=1, followup_gap_hours=1)
        due = self.scheduled(c)
        self.sweep(due)
        self.tick(c["id"], due)
        self.end_all(c["id"], due + MIN)
        self.assertEqual(self.row(c["id"])["followup_done"], 1)
        for i in range(3):                                      # more than the one automatic round, again and again
            at = due + (2 + 3 * i) * MIN
            self.at(at)
            self.assertEqual(self.requeue(c["id"])["requeued"], 2)
            self.tick(c["id"], at)
            self.end_all(c["id"], at + MIN)
        row = self.row(c["id"])
        self.assertEqual((row["followup_done"], row["followup_next_at"]), (1, None))
        self.assertEqual(self.sweep(due + 20 * MIN)["scheduled"], 0, "the automatic rounds are used up")

    def test_a_schedule_stays_while_some_numbers_are_still_unreached(self):
        c, g = self.build(unreached=3, followup_rounds=1)
        due = self.scheduled(c)
        H.sql("UPDATE public.campaign_leads SET final_status = 'answered' WHERE campaign_id = %s::uuid AND contact_id = %s::uuid",
              (c["id"], g["unreached"][0]["id"]))
        self.assertFalse(campaign_scheduler.release_followup_if_none_unreached(c["id"]))
        self.assertEqual(self.next_at(c["id"]), due)
        H.sql("UPDATE public.campaign_leads SET final_status = 'answered' WHERE campaign_id = %s::uuid", (c["id"],))
        self.assertTrue(campaign_scheduler.release_followup_if_none_unreached(c["id"]))
        self.assertIsNone(self.row(c["id"])["followup_next_at"])
        self.assertFalse(campaign_scheduler.release_followup_if_none_unreached(c["id"]), "nothing scheduled: nothing to release")


class StartResetsTests(FollowBase):
    def test_pressing_start_begins_a_new_pass_and_resets_the_rounds(self):
        c, g = self.build(unreached=2, followup_rounds=2, followup_gap_hours=24)
        self.scheduled(c)
        H.sql("UPDATE public.outbound_campaigns SET followup_done = 1 WHERE id = %s::uuid", (c["id"],))
        self.at(T0 + 10 * MIN)
        self.start(c["id"])
        row = self.row(c["id"])
        self.assertEqual((row["followup_done"], row["followup_next_at"], row["status"]), (0, None, "Active"))
        self.assertEqual(len([a for a in self.attempts(c["id"]) if call_retry.parse_time(a["placed_at"]) >= T0 + 10 * MIN]), 2, "the new pass dialed the list")
        f = self.follow(c["id"])
        self.assertEqual((f["done"], f["waiting"]), (0, False))

    def test_pause_and_resume_in_the_middle_of_a_pass_keep_the_rounds(self):
        self.contacts(3)
        c = self.campaign("sequential", retry_enabled=True, followup_rounds=2)
        self.start(c["id"])
        H.sql("UPDATE public.outbound_campaigns SET followup_done = 1 WHERE id = %s::uuid", (c["id"],))
        self.api("post", f"/telephony/campaigns/{c['id']}/pause")
        self.api("post", f"/telephony/campaigns/{c['id']}/resume")
        self.assertEqual(self.row(c["id"])["followup_done"], 1)
        self.assertTrue(self.row(c["id"])["dial_running"])

    def test_changing_the_list_begins_the_rounds_again(self):
        c, g = self.build(unreached=2, followup_rounds=2)
        self.scheduled(c)
        other = supabase.table("lists").insert({"user_id": self.user, "name": "Other"}).execute().data[0]
        self.patch(c["id"], list_id=other["id"])
        row = self.row(c["id"])
        self.assertEqual((row["followup_done"], row["followup_next_at"]), (0, None))


class EditTests(FollowBase):
    def test_turning_the_rounds_off_cancels_a_scheduled_round(self):
        c, g = self.build(unreached=2, followup_rounds=2)
        self.scheduled(c)
        self.patch(c["id"], followup_rounds=0)
        row = self.row(c["id"])
        self.assertEqual((row["followup_rounds"], row["followup_next_at"]), (0, None))
        self.assertEqual(self.sweep(T0 + 10 * MIN)["scheduled"], 0)
        self.patch(c["id"], followup_rounds=1)                   # and turning them on again works from the next sweep
        self.assertEqual(self.sweep(T0 + 10 * MIN)["scheduled"], 1)

    def test_lowering_the_rounds_to_the_ones_already_done_cancels_a_scheduled_round(self):
        c, g = self.build(unreached=2, followup_rounds=3)
        self.scheduled(c)
        H.sql("UPDATE public.outbound_campaigns SET followup_done = 2 WHERE id = %s::uuid", (c["id"],))
        self.patch(c["id"], followup_rounds=3)                   # same number: the schedule stays
        self.assertIsNotNone(self.row(c["id"])["followup_next_at"])
        self.patch(c["id"], followup_rounds=2)
        self.assertIsNone(self.row(c["id"])["followup_next_at"])
        self.assertEqual(self.row(c["id"])["followup_done"], 2, "what was done stays done")

    def test_the_gap_and_a_higher_number_of_rounds_never_move_a_scheduled_time(self):
        c, g = self.build(unreached=2, followup_rounds=2, followup_gap_hours=24)
        due = self.scheduled(c)
        self.patch(c["id"], followup_gap_hours=48)
        self.assertEqual(self.next_at(c["id"]), due)
        self.patch(c["id"], followup_rounds=3)
        self.assertEqual(self.next_at(c["id"]), due)
        f = self.follow(c["id"])
        self.assertEqual((f["rounds"], f["gap_hours"], f["waiting"]), (3, 48, True))
        self.sweep(due)                                         # the round that was scheduled starts at its old time
        self.assertEqual(self.row(c["id"])["followup_done"], 1)
        self.tick(c["id"], due)
        self.end_all(c["id"], due + MIN)
        nxt = self.scheduled(c, due + 2 * MIN)
        self.assertEqual(nxt, due + 2 * MIN + 48 * HOUR, "the new gap applies to the next scheduling")

    def test_turning_auto_redial_off_needs_the_rounds_off_too(self):
        c, g = self.build(unreached=2, followup_rounds=2)
        r = self.patch(c["id"], expect=400, retry_enabled=False)
        self.assertEqual(r.json()["detail"], "Follow-up rounds need Auto Redial to be on.")
        self.assertTrue(self.row(c["id"])["retry_enabled"], "nothing was saved")
        self.patch(c["id"], retry_enabled=False, followup_rounds=0)
        row = self.row(c["id"])
        self.assertEqual((row["retry_enabled"], row["followup_rounds"]), (False, 0))

    def test_the_other_settings_can_be_saved_without_touching_the_rounds(self):
        c, g = self.build(unreached=2, followup_rounds=2, followup_gap_hours=12)
        due = self.scheduled(c)
        self.patch(c["id"], name="Renamed", dial_delay_seconds=3, retry_max_attempts=2)
        row = self.row(c["id"])
        self.assertEqual((row["followup_rounds"], row["followup_gap_hours"], self.next_at(c["id"])), (2, 12, due))


class ApiTests(FollowBase):
    def create(self, expect=200, **extra):
        body = {"name": "F", "agent_id": self.agent["id"], "list_id": self.list["id"], "phone_number_id": self.out_number["id"],
                "dnc_screening_enabled": False, **extra}
        r = self.api("post", "/telephony/campaigns", json=body)
        self.assertEqual(r.status_code, expect, r.text)
        return r

    def test_a_new_campaign_has_the_rounds_off_and_a_24_hour_gap(self):
        d = self.create().json()["data"]
        self.assertEqual((d["followup_rounds"], d["followup_gap_hours"]), (0, 24))
        f = self.follow(d["id"])
        self.assertEqual(f, {"rounds": 0, "gap_hours": 24, "done": 0, "next_at": None, "waiting": False})

    def test_the_settings_are_saved_on_create_and_the_engine_columns_are_not_in_any_response(self):
        d = self.create(retry_enabled=True, followup_rounds=2, followup_gap_hours=6).json()["data"]
        self.assertEqual((d["followup_rounds"], d["followup_gap_hours"]), (2, 6))
        self.assertNotIn("followup_done", d)
        self.assertNotIn("followup_next_at", d)
        one = self.api("get", f"/telephony/campaigns/{d['id']}").json()["data"]
        many = [x for x in self.api("get", "/telephony/campaigns").json()["data"] if x["id"] == d["id"]][0]
        for got in (one, many):
            self.assertEqual(got["followup"], {"rounds": 2, "gap_hours": 6, "done": 0, "next_at": None, "waiting": False})
            self.assertNotIn("followup_done", got)
            self.assertNotIn("followup_next_at", got)
        patched = self.patch(d["id"], followup_gap_hours=7).json()["data"]
        self.assertEqual(patched["followup_gap_hours"], 7)
        self.assertNotIn("followup_done", patched)
        self.assertNotIn("followup_next_at", patched)

    def test_a_client_cannot_set_the_engine_state(self):
        d = self.create(retry_enabled=True, followup_rounds=2, followup_done=2, followup_next_at="2030-01-01T00:00:00Z").json()["data"]
        row = self.row(d["id"])
        self.assertEqual((row["followup_done"], row["followup_next_at"]), (0, None))
        self.patch(d["id"], followup_done=3, followup_next_at="2030-01-01T00:00:00Z")
        row = self.row(d["id"])
        self.assertEqual((row["followup_done"], row["followup_next_at"]), (0, None))

    def test_rounds_need_auto_redial(self):
        r = self.create(expect=400, retry_enabled=False, followup_rounds=1)
        self.assertEqual(r.json()["detail"], "Follow-up rounds need Auto Redial to be on.")
        r = self.create(expect=400, followup_rounds=2)           # the default is off
        self.assertEqual(r.json()["detail"], "Follow-up rounds need Auto Redial to be on.")
        d = self.create(retry_enabled=False, followup_rounds=0).json()["data"]
        r = self.patch(d["id"], expect=400, followup_rounds=1)
        self.assertEqual(r.json()["detail"], "Follow-up rounds need Auto Redial to be on.")
        self.assertEqual(self.row(d["id"])["followup_rounds"], 0)
        self.patch(d["id"], retry_enabled=True, followup_rounds=1)       # both in one request is fine
        self.assertEqual(self.row(d["id"])["followup_rounds"], 1)

    def test_the_ranges(self):
        for rounds in (-1, 4, 100):
            with self.subTest(rounds=rounds):
                r = self.create(expect=400, retry_enabled=True, followup_rounds=rounds)
                self.assertEqual(r.json()["detail"], "Follow-up rounds must be a whole number from 0 to 3.")
        for gap in (0, -5, 49, 1000):
            with self.subTest(gap=gap):
                r = self.create(expect=400, retry_enabled=True, followup_rounds=1, followup_gap_hours=gap)
                self.assertEqual(r.json()["detail"], "Wait between rounds must be a whole number of hours from 1 to 48.")
        for rounds, gap in ((0, 1), (1, 1), (3, 48), (2, 24)):
            with self.subTest(ok=(rounds, gap)):
                d = self.create(retry_enabled=True, followup_rounds=rounds, followup_gap_hours=gap).json()["data"]
                self.assertEqual((d["followup_rounds"], d["followup_gap_hours"]), (rounds, gap))
        d = self.create(retry_enabled=True, followup_rounds=1).json()["data"]
        self.patch(d["id"], expect=400, followup_gap_hours=0)
        self.patch(d["id"], expect=400, followup_rounds=4)
        self.assertEqual((self.row(d["id"])["followup_rounds"], self.row(d["id"])["followup_gap_hours"]), (1, 24))

    def test_values_that_are_not_whole_numbers_are_refused(self):
        for bad in (1.5, "two", [1], {"a": 1}):
            with self.subTest(bad=bad):
                r = self.api("post", "/telephony/campaigns", json={
                    "name": "F", "agent_id": self.agent["id"], "list_id": self.list["id"],
                    "phone_number_id": self.out_number["id"], "retry_enabled": True, "followup_rounds": bad})
                self.assertIn(r.status_code, (400, 422), r.text)

    def test_a_campaign_from_before_the_feature_reads_as_off(self):
        d = self.create().json()["data"]
        H.sql("UPDATE public.outbound_campaigns SET followup_rounds = 0, followup_gap_hours = 24, followup_done = 0, "
              "followup_next_at = NULL WHERE id = %s::uuid", (d["id"],))
        self.assertEqual(self.follow(d["id"]), {"rounds": 0, "gap_hours": 24, "done": 0, "next_at": None, "waiting": False})


class ValidateTests(unittest.TestCase):
    def test_defaults_and_merging(self):
        self.assertEqual(followup_rounds.validate(None, {}), {"followup_rounds": 0, "followup_gap_hours": 24})
        existing = {"followup_rounds": 2, "followup_gap_hours": 12, "retry_enabled": True}
        self.assertEqual(followup_rounds.validate(existing, {}), {"followup_rounds": 2, "followup_gap_hours": 12})
        self.assertEqual(followup_rounds.validate(existing, {"followup_gap_hours": 5}), {"followup_rounds": 2, "followup_gap_hours": 5})
        self.assertEqual(followup_rounds.validate(existing, {"followup_rounds": None}), {"followup_rounds": 2, "followup_gap_hours": 12})
        self.assertEqual(followup_rounds.validate(existing, {"followup_rounds": 0, "retry_enabled": False}),
                         {"followup_rounds": 0, "followup_gap_hours": 12})

    def test_bad_values(self):
        ok = {"retry_enabled": True}
        for key, bad in (("followup_rounds", True), ("followup_rounds", 1.0), ("followup_rounds", "1"), ("followup_rounds", -1),
                         ("followup_rounds", 4), ("followup_gap_hours", False), ("followup_gap_hours", 0), ("followup_gap_hours", 49),
                         ("followup_gap_hours", 2.5), ("followup_gap_hours", "24")):
            with self.subTest(key=key, bad=bad), self.assertRaises(followup_rounds.FollowupError):
                followup_rounds.validate(None, {**ok, key: bad})

    def test_rounds_need_retry_from_either_the_update_or_the_stored_row(self):
        with self.assertRaises(followup_rounds.FollowupError):
            followup_rounds.validate(None, {"followup_rounds": 1})
        with self.assertRaises(followup_rounds.FollowupError):
            followup_rounds.validate({"retry_enabled": False}, {"followup_rounds": 1})
        with self.assertRaises(followup_rounds.FollowupError):
            followup_rounds.validate({"retry_enabled": True, "followup_rounds": 1}, {"retry_enabled": False})
        self.assertEqual(followup_rounds.validate({"retry_enabled": False}, {"followup_rounds": 1, "retry_enabled": True})["followup_rounds"], 1)
        self.assertEqual(followup_rounds.validate({"retry_enabled": False}, {"followup_gap_hours": 3}),
                         {"followup_rounds": 0, "followup_gap_hours": 3}, "with the rounds off Auto Redial is not needed")

    def test_touched_and_describe(self):
        self.assertTrue(followup_rounds.touched({"followup_gap_hours": 3}))
        self.assertFalse(followup_rounds.touched({"retry_enabled": True, "followup_done": 1}))
        self.assertEqual(followup_rounds.describe(None), {"rounds": 0, "gap_hours": 24, "done": 0, "next_at": None, "waiting": False})
        got = followup_rounds.describe({"followup_rounds": 2, "followup_gap_hours": 6, "followup_done": 1,
                                        "followup_next_at": "2026-10-15T10:00:00Z"})
        self.assertEqual(got, {"rounds": 2, "gap_hours": 6, "done": 1, "next_at": "2026-10-15T10:00:00Z", "waiting": True})
        self.assertEqual(followup_rounds.describe({"followup_rounds": 99, "followup_gap_hours": "x"})["rounds"], 0, "unreadable reads as off")


class StrategyTests(FollowBase):
    """The numbers of a round go through the same dispatcher as every other call: the campaign's strategy applies."""

    def round(self, c):
        due = self.scheduled(c)
        self.assertEqual(self.sweep(due)["started"], 1)
        return due

    def test_sequential_places_one_at_a_time(self):
        c, g = self.build(unreached=3, after={"dial_strategy": "sequential"}, followup_rounds=1, followup_gap_hours=1)
        due = self.round(c)
        self.assertEqual(self.tick(c["id"], due).redials_placed, 1)
        self.assertEqual(self.active(c["id"]), 1)
        self.assertIsNone(self.tick(c["id"], due + 10 * SEC), "the single line is taken")
        self.end_all(c["id"], due + 20 * SEC)
        self.assertEqual(self.tick(c["id"], due + 20 * SEC).redials_placed, 1)

    def test_concurrent_places_n_at_once(self):
        c, g = self.build(unreached=5, after={"dial_strategy": "concurrent", "dial_concurrent_calls": 2}, followup_rounds=1, followup_gap_hours=1)
        due = self.round(c)
        self.assertEqual(self.tick(c["id"], due).redials_placed, 2)
        self.assertEqual(self.active(c["id"]), 2)

    def test_paced_spaces_the_calls(self):
        c, g = self.build(unreached=3, after={"dial_strategy": "paced", "dial_calls_per_minute": 10}, followup_rounds=1, followup_gap_hours=1)
        due = self.round(c)
        for s in range(0, 13):
            self.tick(c["id"], due + s * SEC)
        times = sorted(call_retry.parse_time(a["placed_at"]) for a in self.attempts(c["id"]) if a["round"] == 2)
        self.assertEqual(times, [due, due + 6 * SEC, due + 12 * SEC])


class LoopTests(unittest.TestCase):
    """campaign_loop runs the follow-up sweep every pass, and a failure in it never stops the loop."""

    def run_loop(self, followups):
        calls = {"sleep": 0}

        async def fake_sleep(_):
            calls["sleep"] += 1
            if calls["sleep"] >= 3:                              # the startup pause, then two passes
                raise asyncio.CancelledError

        async def go():
            try:
                await campaign_scheduler.campaign_loop()
            except asyncio.CancelledError:
                pass

        with patch.object(campaign_scheduler, "run_auto_resumes", AsyncMock()), \
                patch.object(campaign_scheduler, "run_retries", AsyncMock()), \
                patch.object(campaign_scheduler, "run_followups", followups), \
                patch.object(campaign_scheduler.asyncio, "sleep", fake_sleep):
            asyncio.run(go())

    def test_the_loop_runs_the_sweep_every_pass(self):
        mock = AsyncMock(return_value={})
        self.run_loop(mock)
        self.assertEqual(mock.await_count, 2)

    def test_a_failing_sweep_does_not_stop_the_loop(self):
        mock = AsyncMock(side_effect=RuntimeError("boom"))
        self.run_loop(mock)
        self.assertEqual(mock.await_count, 2, "it was called again on the next pass")


class MigrationTests(MigrationBase):
    COLS = ("followup_rounds", "followup_gap_hours", "followup_done", "followup_next_at")

    def info(self):
        return {r[0]: r[1:] for r in self.all(
            "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns "
            "WHERE table_name = 'outbound_campaigns' AND column_name LIKE 'followup_%%'")}

    def test_a_fresh_database_has_the_four_columns_with_their_defaults(self):
        got = self.info()
        self.assertEqual(sorted(got), sorted(self.COLS))
        self.assertEqual(got["followup_rounds"], ("integer", "NO", "0"))
        self.assertEqual(got["followup_gap_hours"], ("integer", "NO", "24"))
        self.assertEqual(got["followup_done"], ("integer", "NO", "0"))
        self.assertEqual(got["followup_next_at"][:2], ("timestamp with time zone", "YES"))

    def test_existing_campaigns_get_the_rounds_off_and_a_second_run_changes_nothing(self):
        with self.conn() as c:
            user = c.execute("INSERT INTO users(email) VALUES ('fu@qa.test') RETURNING id").fetchone()[0]
            ids = [c.execute("INSERT INTO outbound_campaigns(user_id, name, status) VALUES (%s, %s, %s) RETURNING id",
                             (user, n, s)).fetchone()[0] for n, s in (("idle", "Inactive"), ("active", "Active"))]
            c.execute("ALTER TABLE public.outbound_campaigns DROP COLUMN followup_rounds, DROP COLUMN followup_gap_hours, "
                      "DROP COLUMN followup_done, DROP COLUMN followup_next_at")
        self.assertEqual(self.info(), {})
        self.upgrade()
        self.assertEqual(sorted(self.info()), sorted(self.COLS))
        rows = self.all("SELECT followup_rounds, followup_gap_hours, followup_done, followup_next_at FROM outbound_campaigns ORDER BY name")
        self.assertEqual(rows, [(0, 24, 0, None), (0, 24, 0, None)])
        with self.conn() as c:                                   # a person then turns them on for one campaign
            c.execute("UPDATE outbound_campaigns SET followup_rounds = 2, followup_gap_hours = 6, followup_done = 1 WHERE id = %s", (ids[1],))
        before = self.all("SELECT id, followup_rounds, followup_gap_hours, followup_done, followup_next_at FROM outbound_campaigns ORDER BY id")
        self.upgrade()
        self.upgrade()
        self.assertEqual(self.all("SELECT id, followup_rounds, followup_gap_hours, followup_done, followup_next_at FROM outbound_campaigns ORDER BY id"), before)
        self.assertEqual(sorted(self.info()), sorted(self.COLS))

    def test_a_campaign_created_after_the_upgrade_has_them_off_too(self):
        with self.conn() as c:
            user = c.execute("INSERT INTO users(email) VALUES ('fu2@qa.test') RETURNING id").fetchone()[0]
            cid = c.execute("INSERT INTO outbound_campaigns(user_id, name) VALUES (%s, 'n') RETURNING id", (user,)).fetchone()[0]
            row = c.execute("SELECT followup_rounds, followup_gap_hours, followup_done, followup_next_at FROM outbound_campaigns WHERE id = %s", (cid,)).fetchone()
        self.assertEqual(row, (0, 24, 0, None))


if __name__ == "__main__":
    unittest.main()
