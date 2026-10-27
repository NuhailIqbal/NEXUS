"""
"Retry unreached numbers" (POST /telephony/campaigns/{id}/retry-unreached, services/call_retry.requeue_unreached, the
first-call-of-a-round rule in services/dialer._pick_redials and services/campaign_scheduler.run_retries, and
`unreached_count` in retry_stats).

A campaign is run for real (concurrent dialing, a mocked call placer, calls ended through call_retry.finish_attempt)
until some numbers are settled "Max attempts reached" next to numbers that answered, were invalid, asked not to be
called or were not retried. Then the unreached ones are requeued and the dialing engine is driven with a frozen clock.

Run from the backend folder:  python -m unittest discover -s tests -p "test_retry_unreached.py" -v
"""
import asyncio
import unittest
from datetime import timedelta

import byot_harness as H
from database import supabase
from routers import telephony
from services import call_retry, campaign_scheduler

from test_dial_engine import ALL_DAYS, DialBase, MIN, SEC, T0
from test_timezones import FakeDateTime, local


class UnreachedBase(DialBase):
    def build(self, unreached=3, answered=0, invalid=0, dnc=0, not_retried=0, after=None, **extra):
        """A campaign that has run: `unreached` numbers never picked up (max attempts reached, with 1 call per number),
        and the other groups ended in the way their name says. `after` are settings patched in afterwards (the
        settled numbers stay as they are). Returns (campaign, {group: [contacts]})."""
        n = unreached + answered + invalid + dnc + not_retried
        cs = self.contacts(n)
        groups, i = {}, 0
        for name, count in (("unreached", unreached), ("answered", answered), ("invalid", invalid), ("dnc", dnc),
                            ("not_retried", not_retried)):
            groups[name], i = cs[i:i + count], i + count
        c = self.campaign("concurrent", dial_concurrent_calls=20, retry_enabled=True, retry_max_attempts=1,
                          retry_interval_minutes=10, retry_on=["no_answer"], **extra)
        self.start(c["id"])
        how = {"unreached": ("no_answer", "customer-did-not-answer"), "answered": ("answered", "customer-ended-call"),
               "invalid": ("invalid_number", "twilio-invalid-number"), "dnc": ("do_not_call", "customer-ended-call"),
               "not_retried": ("busy", "customer-busy")}       # busy is not ticked in retry_on: never retried
        for name, people in groups.items():
            for p in people:
                self.end_phone(c["id"], p, *how[name], at=T0 + SEC)
        self.assertEqual(self.active(c["id"]), 0)
        self.tick(c["id"], T0 + 2 * SEC)
        self.assertFalse(self.row(c["id"])["dial_running"], "the pass is over")
        if after:
            r = self.api("patch", f"/telephony/campaigns/{c['id']}", json=after)
            self.assertEqual(r.status_code, 200, r.text)
        self.at(T0 + 5 * MIN)
        return c, groups

    def end_phone(self, cid, contact, outcome, reason, at=None):
        key = call_retry.phone_key(contact["phone"])
        a = next(a for a in self.open_attempts(cid) if a["phone_key"] == key)
        self.assertTrue(call_retry.finish_attempt(a, outcome, reason, at or FakeDateTime.instant))

    def end_all(self, cid, at, outcome="no_answer", reason="customer-did-not-answer"):
        return self.end(cid, at=at, outcome=outcome, reason=reason)

    def requeue(self, cid, expect=200, headers=None, **body):
        kw = {"json": body} if body else {}
        if headers is not None:
            r = H.client.post(f"/telephony/campaigns/{cid}/retry-unreached", headers=headers, **kw)
        else:
            r = self.api("post", f"/telephony/campaigns/{cid}/retry-unreached", **kw)
        self.assertEqual(r.status_code, expect, r.text)
        return r.json()["data"] if expect == 200 else r.json()

    def lead(self, cid, contact):
        rows = supabase.table("campaign_leads").select("*").eq("campaign_id", cid).eq("contact_id", contact["id"]).execute().data
        self.assertEqual(len(rows), 1)
        return rows[0]

    def state(self, cid, contacts):
        return {c["id"]: {k: v for k, v in self.lead(cid, c).items() if k not in ("updated_at",)} for c in contacts}

    def stats(self, cid):
        return self.api("get", f"/telephony/campaigns/{cid}").json()["data"]["retry_stats"]

    def placed_keys(self, cid, since_round=2):
        return sorted(a["phone_key"] for a in self.attempts(cid) if a["round"] >= since_round)


class RequeueSelectionTests(UnreachedBase):
    def test_only_the_unreached_numbers_are_requeued_and_dialed(self):
        c, g = self.build(unreached=3, answered=1, invalid=1, dnc=1, not_retried=1)
        others = g["answered"] + g["invalid"] + g["dnc"] + g["not_retried"]
        self.assertEqual({self.lead(c["id"], p)["final_status"] for p in g["unreached"]}, {"max_attempts"})
        self.assertEqual([self.lead(c["id"], p)["final_status"] for p in others],
                         ["answered", "invalid_number", "do_not_call", "not_retried"])
        before_others = self.state(c["id"], others)
        calls_before = len(self.attempts(c["id"]))
        self.assertEqual(calls_before, 7)

        data = self.requeue(c["id"])
        self.assertEqual((data["requeued"], data["skipped_busy"], data["campaign_status"]), (3, 0, "Active"))
        self.assertIn("3 numbers queued", data["message"])
        self.assertEqual(self.state(c["id"], others), before_others, "nobody else is touched")
        for p in g["unreached"]:
            lead = self.lead(c["id"], p)
            self.assertEqual((lead["round"], lead["attempts"], lead["final_status"]), (2, 0, None))
            self.assertEqual(call_retry.parse_time(lead["next_attempt_at"]), T0 + 5 * MIN, "due now")
            self.assertEqual(lead["last_outcome"], "no_answer", "how the number last ended is kept")

        res = self.tick(c["id"], T0 + 5 * MIN)
        self.assertEqual(res.redials_placed, 3)
        new = [a for a in self.attempts(c["id"]) if a["round"] == 2]
        self.assertEqual(sorted(a["phone_key"] for a in new), sorted(self.keys(g["unreached"])))
        self.assertEqual({(a["attempt_number"], a["dial_source"]) for a in new}, {(1, "redial")})
        self.assertEqual(len(self.attempts(c["id"])), calls_before + 3, "the other four were never dialed again")
        self.assertEqual(self.state(c["id"], others), before_others)

    def test_the_round_one_history_stays_and_the_numbers_view_shows_round_two(self):
        c, g = self.build(unreached=2, answered=1)
        self.requeue(c["id"])
        view = self.api("get", f"/telephony/campaigns/{c['id']}/numbers").json()["data"]
        rows = {r["phone"]: r for r in view["rows"]}
        waiting = rows[g["unreached"][0]["phone"]]
        self.assertEqual((waiting["round"], waiting["attempts"], waiting["status"]), (2, 0, "retry_scheduled"))
        self.assertEqual([(h["round"], h["attempt_number"]) for h in waiting["history"]], [(1, 1)])
        self.assertEqual(rows[g["answered"][0]["phone"]]["status"], "answered")
        self.tick(c["id"], T0 + 5 * MIN)
        view = self.api("get", f"/telephony/campaigns/{c['id']}/numbers").json()["data"]
        rows = {r["phone"]: r for r in view["rows"]}
        for p in g["unreached"]:
            row = rows[p["phone"]]
            self.assertEqual((row["round"], row["attempts"], row["status"]), (2, 1, "calling"))
            self.assertEqual([(h["round"], h["attempt_number"]) for h in row["history"]], [(1, 1), (2, 1)])
        self.assertEqual(len(rows[g["answered"][0]["phone"]]["history"]), 1)

    def test_the_stats_count_the_unreached_and_reset_when_they_are_requeued(self):
        c, g = self.build(unreached=3, answered=2, not_retried=1)
        st = self.stats(c["id"])
        self.assertEqual((st["unreached_count"], st["max_attempts_reached"]), (3, 3))
        listing = self.api("get", "/telephony/campaigns").json()["data"]
        self.assertEqual(next(x for x in listing if x["id"] == c["id"])["retry_stats"]["unreached_count"], 3)
        self.requeue(c["id"])
        st = self.stats(c["id"])
        self.assertEqual((st["unreached_count"], st["pending_retries"]), (0, 3))
        self.tick(c["id"], T0 + 5 * MIN)
        self.end_all(c["id"], T0 + 6 * MIN)
        self.assertEqual(self.stats(c["id"])["unreached_count"], 3, "they never picked up again: reachable by another click")

    def test_nothing_to_retry_is_a_friendly_answer_not_an_error(self):
        c, g = self.build(unreached=0, answered=2, not_retried=1)
        data = self.requeue(c["id"])
        self.assertEqual((data["requeued"], data["skipped_busy"]), (0, 0))
        self.assertEqual(data["message"], "There are no unreached numbers to call again.")
        self.assertEqual(self.stats(c["id"])["unreached_count"], 0)
        self.assertEqual(len(self.attempts(c["id"])), 3)

    def test_a_second_click_while_they_are_queued_or_calling_requeues_nothing_more(self):
        c, g = self.build(unreached=3)
        self.assertEqual(self.requeue(c["id"])["requeued"], 3)
        again = self.requeue(c["id"])
        self.assertEqual((again["requeued"], again["skipped_busy"]), (0, 0))
        self.assertEqual({self.lead(c["id"], p)["round"] for p in g["unreached"]}, {2}, "one new round, not two")
        self.tick(c["id"], T0 + 5 * MIN)
        self.assertEqual(self.requeue(c["id"])["requeued"], 0, "calling now")
        self.assertEqual(self.placed_keys(c["id"]), sorted(self.keys(g["unreached"])), "each was dialed once")


class RetrySettingsTests(UnreachedBase):
    def test_with_auto_redial_off_the_first_call_is_placed_and_nothing_follows(self):
        c, g = self.build(unreached=3, after={"retry_enabled": False})
        self.assertFalse(self.row(c["id"])["retry_enabled"])
        self.requeue(c["id"])
        res = self.tick(c["id"], T0 + 5 * MIN)
        self.assertEqual((res.redials_placed, res.redials["cancelled"]), (3, 0))
        self.end_all(c["id"], T0 + 6 * MIN)
        for p in g["unreached"]:
            lead = self.lead(c["id"], p)
            self.assertEqual((lead["round"], lead["attempts"], lead["final_status"], lead["next_attempt_at"]),
                             (2, 1, "not_retried", None))
        before = len(self.attempts(c["id"]))
        self.tick(c["id"], T0 + 3 * 24 * 60 * MIN)
        self.assertEqual(len(self.attempts(c["id"])), before, "no redial after the requeued call")
        self.assertEqual(self.stats(c["id"])["unreached_count"], 0)

    def test_the_redial_sweep_places_them_with_auto_redial_off_too(self):
        c, g = self.build(unreached=2, after={"retry_enabled": False})
        self.requeue(c["id"])
        res = asyncio.run(campaign_scheduler.run_retries(T0 + 5 * MIN))
        self.assertEqual((res["placed"], res["cancelled"]), (2, 0))
        self.assertEqual(len([a for a in self.attempts(c["id"]) if a["round"] == 2]), 2)

    def test_switching_auto_redial_off_after_requeueing_still_lets_the_first_call_go_out(self):
        c, g = self.build(unreached=2)
        self.requeue(c["id"])
        r = self.api("patch", f"/telephony/campaigns/{c['id']}", json={"retry_enabled": False})
        self.assertEqual(r.status_code, 200, r.text)
        for p in g["unreached"]:
            self.assertIsNone(self.lead(c["id"], p)["final_status"], "not cancelled: it is not a redial yet")
        res = self.tick(c["id"], T0 + 5 * MIN)
        self.assertEqual(res.redials_placed, 2)

    def test_an_ordinary_redial_is_still_cancelled_when_auto_redial_is_off(self):
        c, g = self.build(unreached=1, answered=1, after={"retry_enabled": False})
        self.requeue(c["id"])
        # a real redial (it already had a call in this round) waits next to the requeued number
        waiting = g["answered"][0]
        H.sql("UPDATE public.campaign_leads SET final_status = NULL, last_outcome = 'no_answer', attempts = 1, "
              "next_attempt_at = %s::timestamptz WHERE campaign_id = %s::uuid AND contact_id = %s::uuid",
              (call_retry.iso(T0 + 4 * MIN), c["id"], waiting["id"]))
        res = asyncio.run(campaign_scheduler.run_retries(T0 + 5 * MIN))
        self.assertEqual((res["placed"], res["cancelled"]), (1, 1))
        self.assertEqual(self.lead(c["id"], waiting)["final_status"], "not_retried")
        self.assertEqual(self.lead(c["id"], g["unreached"][0])["attempts"], 1)

    def test_with_auto_redial_on_they_are_redialed_up_to_the_maximum(self):
        c, g = self.build(unreached=3, after={"retry_max_attempts": 3})
        self.requeue(c["id"])
        self.assertEqual(self.tick(c["id"], T0 + 5 * MIN).redials_placed, 3)
        self.end_all(c["id"], T0 + 6 * MIN)
        for p in g["unreached"]:
            lead = self.lead(c["id"], p)
            self.assertEqual((lead["attempts"], lead["final_status"]), (1, None))
            self.assertEqual(call_retry.parse_time(lead["next_attempt_at"]), T0 + 16 * MIN, "end + the 10 minute interval")
        self.assertEqual(self.tick(c["id"], T0 + 15 * MIN), None, "not due yet")
        self.assertEqual(self.tick(c["id"], T0 + 16 * MIN).redials_placed, 3)
        self.end_all(c["id"], T0 + 17 * MIN)
        self.assertEqual(self.tick(c["id"], T0 + 27 * MIN).redials_placed, 3)
        self.end_all(c["id"], T0 + 28 * MIN)
        for p in g["unreached"]:
            lead = self.lead(c["id"], p)
            self.assertEqual((lead["round"], lead["attempts"], lead["final_status"]), (2, 3, "max_attempts"))
        self.assertEqual(self.tick(c["id"], T0 + 3 * 24 * 60 * MIN), None, "no fourth call")
        rounds = sorted((a["round"], a["attempt_number"]) for a in self.attempts(c["id"]) if a["phone_key"] == call_retry.phone_key(g["unreached"][0]["phone"]))
        self.assertEqual(rounds, [(1, 1), (2, 1), (2, 2), (2, 3)])
        self.assertEqual(self.stats(c["id"])["unreached_count"], 3)

    def test_the_settings_of_the_requeued_call_are_the_ones_in_force_when_it_is_placed(self):
        c, g = self.build(unreached=1, after={"retry_enabled": False})
        self.requeue(c["id"])
        self.api("patch", f"/telephony/campaigns/{c['id']}", json={"retry_enabled": True, "retry_max_attempts": 2})
        self.tick(c["id"], T0 + 5 * MIN)
        a = [x for x in self.attempts(c["id"]) if x["round"] == 2][0]
        self.assertTrue(a["settings"]["enabled"])
        self.end_all(c["id"], T0 + 6 * MIN)
        lead = self.lead(c["id"], g["unreached"][0])
        self.assertEqual((lead["attempts"], lead["final_status"]), (1, None))
        self.assertIsNotNone(lead["next_attempt_at"])


class StrategyTests(UnreachedBase):
    def test_sequential_places_one_at_a_time(self):
        c, g = self.build(unreached=3, after={"dial_strategy": "sequential"})
        self.requeue(c["id"])
        for i in range(3):
            at = T0 + 5 * MIN + i * MIN
            res = self.tick(c["id"], at)
            self.assertEqual(res.redials_placed, 1)
            self.assertEqual(self.active(c["id"]), 1)
            self.assertIsNone(self.tick(c["id"], at + 10 * SEC), "the single line is taken")
            self.assertEqual(self.active(c["id"]), 1)
            self.end_all(c["id"], at + 20 * SEC)
        self.assertEqual(self.placed_keys(c["id"]), sorted(self.keys(g["unreached"])))
        self.assertEqual(len([a for a in self.attempts(c["id"]) if a["round"] == 2]), 3)

    def test_concurrent_places_n_at_once_and_refills_what_ended(self):
        c, g = self.build(unreached=5, after={"dial_strategy": "concurrent", "dial_concurrent_calls": 2})
        self.requeue(c["id"])
        self.assertEqual(self.tick(c["id"], T0 + 5 * MIN).redials_placed, 2)
        self.assertEqual(self.active(c["id"]), 2)
        self.end(c["id"], 1, at=T0 + 6 * MIN)
        self.assertEqual(self.tick(c["id"], T0 + 6 * MIN).redials_placed, 1)
        self.assertEqual(self.active(c["id"]), 2)

    def test_paced_spaces_them(self):
        c, g = self.build(unreached=3, after={"dial_strategy": "paced", "dial_calls_per_minute": 10})
        self.requeue(c["id"])
        start = T0 + 5 * MIN
        for s in range(0, 13):
            self.tick(c["id"], start + s * SEC)
        times = sorted(call_retry.parse_time(a["placed_at"]) for a in self.attempts(c["id"]) if a["round"] == 2)
        self.assertEqual(times, [start, start + 6 * SEC, start + 12 * SEC])

    def test_the_account_cap_bounds_them(self):
        c, g = self.build(unreached=5)
        telephony.get_or_create_billing(self.user)
        supabase.table("billing").update({"max_concurrent_calls": 2}).eq("user_id", self.user).execute()
        self.requeue(c["id"])
        self.assertEqual(self.tick(c["id"], T0 + 5 * MIN).redials_placed, 2)
        self.assertEqual(self.active(c["id"]), 2)
        self.end(c["id"], 1, at=T0 + 6 * MIN)
        self.assertEqual(self.tick(c["id"], T0 + 6 * MIN).redials_placed, 1)
        self.assertEqual(self.active(c["id"]), 2)

    def test_paced_spaces_them(self):
        c, g = self.build(unreached=3, after={"dial_strategy": "paced", "dial_calls_per_minute": 10})
        self.requeue(c["id"])
        start = T0 + 5 * MIN
        for s in range(0, 13):
            self.tick(c["id"], start + s * SEC)
        times = sorted(call_retry.parse_time(a["placed_at"]) for a in self.attempts(c["id"]) if a["round"] == 2)
        self.assertEqual(times, [start, start + 6 * SEC, start + 12 * SEC])

    def test_the_account_cap_bounds_them(self):
        c, g = self.build(unreached=5)
        supabase.table("billing").upsert({"user_id": self.user, "max_concurrent_calls": 2}, on_conflict="user_id").execute() \
            if False else H.sql("UPDATE public.billing SET max_concurrent_calls = 2 WHERE user_id = %s::uuid", (self.user,))
        self.requeue(c["id"])
        self.assertEqual(self.tick(c["id"], T0 + 5 * MIN).redials_placed, 2)
        self.assertEqual(self.active(c["id"]), 2)


class HoursTests(UnreachedBase):
    def test_outside_the_calling_hours_they_wait_for_the_next_opening(self):
        c, g = self.build(unreached=3, call_hours_enabled=True, call_hours_timezone="UTC", call_hours_days=ALL_DAYS,
                          call_hours_start="09:00", call_hours_end="18:00")
        night = local("UTC", 2026, 10, 14, 20)
        self.at(night)
        data = self.requeue(c["id"])
        self.assertEqual(data["requeued"], 3, "queueing is allowed any time")
        before = len(self.attempts(c["id"]))
        self.tick(c["id"], night)
        self.tick(c["id"], night + 30 * MIN)
        self.assertEqual(len(self.attempts(c["id"])), before, "no call outside the hours")
        for p in g["unreached"]:
            lead = self.lead(c["id"], p)
            self.assertIsNone(lead["final_status"])
            self.assertEqual(call_retry.parse_time(lead["next_attempt_at"]), local("UTC", 2026, 10, 15, 9), "moved to the opening")
        self.assertEqual(self.tick(c["id"], local("UTC", 2026, 10, 15, 8, 59)), None)
        self.assertEqual(self.tick(c["id"], local("UTC", 2026, 10, 15, 9)).redials_placed, 3)

    def test_the_sweep_also_waits_with_auto_redial_off(self):
        c, g = self.build(unreached=2, after={"retry_enabled": False}, call_hours_enabled=True, call_hours_timezone="UTC",
                          call_hours_days=ALL_DAYS, call_hours_start="09:00", call_hours_end="18:00")
        night = local("UTC", 2026, 10, 14, 20)
        self.at(night)
        self.requeue(c["id"])
        res = asyncio.run(campaign_scheduler.run_retries(night))
        self.assertEqual(res["placed"], 0)
        for p in g["unreached"]:
            self.assertIsNone(self.lead(c["id"], p)["final_status"], "waiting, not cancelled")
        res = asyncio.run(campaign_scheduler.run_retries(local("UTC", 2026, 10, 15, 9)))
        self.assertEqual(res["placed"], 2)


class CampaignStatusTests(UnreachedBase):
    def test_a_paused_campaign_keeps_them_queued_and_dials_them_on_resume(self):
        c, g = self.build(unreached=3)
        self.api("post", f"/telephony/campaigns/{c['id']}/pause")
        data = self.requeue(c["id"])
        self.assertEqual((data["requeued"], data["campaign_status"]), (3, "Paused"))
        self.assertIn("when the campaign is Active", data["message"])
        self.assertEqual(self.row(c["id"])["status"], "Paused")
        self.assertIsNone(self.tick(c["id"], T0 + 5 * MIN))
        self.assertEqual(asyncio.run(campaign_scheduler.run_retries(T0 + 3 * 24 * 60 * MIN))["placed"], 0)
        self.assertEqual(len(self.placed_keys(c["id"])), 0)
        self.assertEqual(self.stats(c["id"])["unreached_count"], 0, "queued, not lost")
        self.api("post", f"/telephony/campaigns/{c['id']}/resume")
        self.assertEqual(self.tick(c["id"], T0 + 3 * 24 * 60 * MIN + MIN).redials_placed, 3)

    def test_an_inactive_campaign_stays_inactive_without_activate(self):
        c, g = self.build(unreached=2)
        self.api("patch", f"/telephony/campaigns/{c['id']}", json={"status": "Inactive"})
        data = self.requeue(c["id"])
        self.assertEqual((data["requeued"], data["campaign_status"]), (2, "Inactive"))
        self.assertIn("when the campaign is Active", data["message"])
        self.assertEqual(self.row(c["id"])["status"], "Inactive")
        self.assertIsNone(self.tick(c["id"], T0 + 5 * MIN))
        self.assertEqual(self.active(c["id"]), 0)

    def test_activate_true_sets_it_active_and_the_numbers_go_out(self):
        c, g = self.build(unreached=2)
        self.api("patch", f"/telephony/campaigns/{c['id']}", json={"status": "Inactive"})
        data = self.requeue(c["id"], activate=True)
        self.assertEqual((data["requeued"], data["campaign_status"]), (2, "Active"))
        self.assertEqual(self.row(c["id"])["status"], "Active")
        self.assertEqual(self.tick(c["id"], T0 + 5 * MIN).redials_placed, 2)

    def test_activate_does_not_start_a_campaign_with_nothing_to_retry(self):
        c, g = self.build(unreached=0, answered=1)
        self.api("patch", f"/telephony/campaigns/{c['id']}", json={"status": "Inactive"})
        data = self.requeue(c["id"], activate=True)
        self.assertEqual((data["requeued"], data["campaign_status"]), (0, "Inactive"))
        self.assertEqual(self.row(c["id"])["status"], "Inactive")

    def test_an_active_campaign_ignores_activate(self):
        c, g = self.build(unreached=1)
        data = self.requeue(c["id"], activate=True)
        self.assertEqual((data["requeued"], data["campaign_status"]), (1, "Active"))

    def test_the_body_is_optional_and_activate_must_be_a_boolean(self):
        c, g = self.build(unreached=1)
        r = self.api("post", f"/telephony/campaigns/{c['id']}/retry-unreached", json={"activate": "maybe"})
        self.assertIn(r.status_code, (400, 422))
        self.assertEqual(self.lead(c["id"], g["unreached"][0])["final_status"], "max_attempts", "nothing happened")
        self.assertEqual(self.requeue(c["id"])["requeued"], 1, "no body at all is fine")


class BusyAndOwnerTests(UnreachedBase):
    def test_a_number_on_another_call_stays_queued_and_is_dialed_when_the_line_is_free(self):
        c, g = self.build(unreached=3)
        busy = g["unreached"][0]
        other_list = supabase.table("lists").insert({"user_id": self.user, "name": "Same person"}).execute().data[0]
        supabase.table("contacts").insert({"user_id": self.user, "list_id": other_list["id"], "name": "Same", "phone": busy["phone"]}).execute()
        b = self.campaign("sequential", list_id=other_list["id"])
        self.start(b["id"])
        self.assertEqual(self.active(b["id"]), 1, "another campaign is calling that number now")

        data = self.requeue(c["id"])
        self.assertEqual((data["requeued"], data["skipped_busy"]), (3, 1))
        self.assertIn("1 is on another call", data["message"])
        res = self.tick(c["id"], T0 + 5 * MIN)
        self.assertEqual(res.redials_placed, 2)
        self.assertEqual(sorted(a["phone_key"] for a in self.attempts(c["id"]) if a["round"] == 2),
                         sorted(self.keys(g["unreached"][1:])))
        lead = self.lead(c["id"], busy)
        self.assertEqual((lead["round"], lead["attempts"], lead["final_status"]), (2, 0, None), "still queued, not lost")
        self.assertIsNotNone(lead["next_attempt_at"])

        self.end(b["id"], at=T0 + 6 * MIN)
        res = self.tick(c["id"], T0 + 6 * MIN)
        self.assertEqual(res.redials_placed, 1)
        self.assertEqual(self.placed_keys(c["id"]), sorted(self.keys(g["unreached"])))

    def test_another_account_gets_a_404_and_changes_nothing(self):
        c, g = self.build(unreached=2)
        other = H.make_user()
        r = self.requeue(c["id"], expect=404, headers=H.auth(other))
        self.assertEqual(r["detail"], "Campaign not found")
        self.assertEqual({self.lead(c["id"], p)["final_status"] for p in g["unreached"]}, {"max_attempts"})
        self.assertEqual(self.stats(c["id"])["unreached_count"], 2)

    def test_a_campaign_that_does_not_exist_is_a_404(self):
        self.requeue("00000000-0000-0000-0000-000000000000", expect=404)


class WiringTests(unittest.TestCase):
    def test_the_route_is_declared_once_as_a_post(self):
        routes = [r for r in telephony.router.routes if getattr(r, "path", "").endswith("/retry-unreached")]
        self.assertEqual([sorted(r.methods) for r in routes], [["POST"]])


if __name__ == "__main__":
    unittest.main()
