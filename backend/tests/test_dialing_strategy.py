"""
Dialing Strategy: the ACCEPTANCE suite. Each acceptance criterion of the original request has at least one test
here, named `test_ACn_...` so the mapping is obvious; the criteria are:

  AC1   Sequential: one call is ever active over 6+ numbers; the next starts only after the previous ENDS; a delay
        of 10 s places nothing at end + 9 and one call at end + 10
  AC2   Concurrent = 5 with 12 numbers: exactly 5 active at a time while numbers remain, a new call starts when one
        ends, slots 1-5 in wave 1, draining ends with the pass finished
  AC3   Calls per Minute = 10: about 10 placed each minute, evenly spread (6 s gaps) over 5 simulated minutes; a delay
        of 20 s gives 3 a minute; no catch-up burst after a pause
  AC4   Existing campaigns keep working: a legacy (migrated) campaign is Concurrent / 20 and dials a list the way it
        used to (many at once, capped at 20); a new one defaults to Sequential
  AC5   Retries follow the campaign's strategy: a due redial goes before fresh numbers and counts in the same cap;
        Sequential redial waits for the open call; Concurrent redial uses a free slot; Paced redial keeps the rate
  AC6   Two campaigns with different strategies run correctly at the same time (one account, and different accounts
        in one dispatch): each obeys its own limit and both count against the account cap
  AC7   Never the same number twice at the same time, in any strategy (duplicate rows in a list; the same number in two
        campaigns; a callback, an automation and a single call to a number that is on a campaign call)
  AC8   Hours and control: outside the hours no new calls in any strategy and active calls finish; pause stops new
        calls at once, active calls finish, resume continues from the cursor; a strategy change mid-run applies to new
        calls only
  AC9   Account cap: billing.max_concurrent_calls = 3 with Concurrent 5 gives at most 3 active, `effective.capped` and
        `warnings` on create / edit / start; raising the cap applies on the next tick; two campaigns of one account
        share the pool; the platform maximum
  AC10  Logging: every call stores dial_strategy, dial_slot, dial_batch and dial_source, per strategy
  AC11  The live payload has exactly the documented keys

and the robustness the engine rests on (stage D): the reconciler (REC), reap_stale asking the provider (REAP), the
webhook rate-limit exemption (WH), number_is_busy (BUSY), the health endpoint (HEALTH) and the startup wiring (WIRE).

Deterministic: an injected clock (every tick is `dispatch_once(now, ...)`), a mocked call placer and a mocked provider;
no sleeps and no real loops. Calls "end" through call_retry.finish_attempt at chosen instants. Pure strategy tests use
retry_enabled=False (the campaign default).

Run from the backend folder:  python -m unittest discover -s tests -p "test_dialing_strategy.py" -v
"""
import asyncio
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import byot_harness as H
import qa_harness as Q
from config import settings
from database import supabase
from routers import telephony, webhooks
from services import (automation_engine, call_retry, callback_scheduler, callback_service as cbs, campaign_scheduler,
                      dialer, vapi_client, vapi_sync)

from test_caller_verification import make_agent, make_number
from test_dial_engine import ALL_DAYS, DialBase, MIN, SEC, T0
from test_timezones import FakeDateTime, local

UTC = timezone.utc
HOURS = dict(call_hours_enabled=True, call_hours_timezone="UTC", call_hours_days=ALL_DAYS,
             call_hours_start="09:00", call_hours_end="18:00")


def t_of(value):
    return call_retry.parse_time(value)


class StrategyBase(DialBase):
    """DialBase (one funded account, an agent, a number, a list, the clock frozen at T0) plus what the acceptance
    tests share."""

    def new_list(self, name="L"):
        return supabase.table("lists").insert({"user_id": self.user, "name": name}).execute().data[0]

    def set_cap(self, n, user=None):
        user = user or self.user
        telephony.get_or_create_billing(user)
        supabase.table("billing").update({"max_concurrent_calls": n}).eq("user_id", user).execute()

    def mark_running(self, *ids):
        """The campaigns are Active with a pass open (what Start does), without Start's own first tick, so one
        dispatch can serve several of them together."""
        supabase.table("outbound_campaigns").update(
            {"status": "Active", "dial_running": True, "dial_pass_started_at": call_retry.iso(T0)}).in_("id", list(ids)).execute()

    def dispatch(self, instant):
        """One whole dispatch (every campaign that has room), not limited to one campaign."""
        self.at(instant)
        return asyncio.run(dialer.dispatch_once(instant, wait=True))

    def open_total(self):
        return len(supabase.table("campaign_attempts").select("id").eq("user_id", self.user).is_("ended_at", "null").execute().data)

    def run_to_end(self, cid, step=7 * SEC, limit=80):
        """Every step: all open calls end, then the engine looks. Until the pass is over and nothing is open."""
        t = FakeDateTime.instant
        for _ in range(limit):
            t += step
            self.end(cid, at=t)
            self.tick(cid, t)
            if not self.row(cid)["dial_running"] and self.active(cid) == 0:
                return t
        raise AssertionError("the campaign never finished")

    def second_account(self):
        user = H.make_user("acct2")
        H.fund_wallet(user, 100)
        agent = make_agent(user)
        number = make_number(user, agent=agent)
        lst = supabase.table("lists").insert({"user_id": user, "name": "Other account"}).execute().data[0]
        return SimpleNamespace(user=user, agent=agent, number=number, list=lst, n=0)

    def contacts_of(self, acct, n):
        out = []
        for _ in range(n):
            acct.n += 1
            out += supabase.table("contacts").insert({"user_id": acct.user, "list_id": acct.list["id"], "name": f"Q{acct.n}",
                                                      "phone": f"+1555888{acct.n:04d}"}).execute().data
        return out

    def campaign_of(self, acct, strategy, **extra):
        body = {"name": "Theirs", "agent_id": acct.agent["id"], "list_id": acct.list["id"], "phone_number_id": acct.number["id"],
                "dnc_screening_enabled": False, "dial_strategy": strategy, **extra}
        r = H.client.post("/telephony/campaigns", json=body, headers=H.auth(acct.user))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["data"]

    def placed_times(self, cid):
        return [t_of(a["placed_at"]) for a in self.attempts(cid)]


# ═══════════════════════════════════════════════════════════════════════════
# AC1  Sequential
# ═══════════════════════════════════════════════════════════════════════════


class AC1SequentialTests(StrategyBase):
    def test_AC1_only_one_call_is_ever_active_over_seven_numbers_and_the_next_starts_only_after_the_previous_ends(self):
        cs = self.contacts(7)
        c = self.campaign("sequential")
        cid = c["id"]
        self.start(cid)
        peak = self.active(cid)
        for i in range(1, 7):
            t = T0 + i * 20 * SEC
            for k in range(3):                      # however often the engine looks, the one line is taken
                self.tick(cid, t - (3 - k) * SEC)
                peak = max(peak, self.active(cid))
            self.assertEqual(len(self.attempts(cid)), i, f"call {i} is still on the line: nothing new")
            self.end(cid, at=t)
            self.tick(cid, t)
            peak = max(peak, self.active(cid))
            self.assertEqual(len(self.attempts(cid)), i + 1, "the previous call ended: the next one goes")
        self.assertEqual(peak, 1, "peak_active")
        attempts = self.attempts(cid)
        for prev, nxt in zip(attempts, attempts[1:]):
            self.assertGreaterEqual(t_of(nxt["placed_at"]), t_of(prev["ended_at"]), "started only after the previous ENDED")
        self.assertEqual(self.phones(cid), self.keys(cs), "upload order, once each")
        # the last call ends: the pass is over
        self.end(cid, at=T0 + 3 * MIN)
        self.tick(cid, T0 + 3 * MIN)
        row = self.row(cid)
        self.assertEqual((row["dial_running"], row["status"]), (False, "Active"))

    def test_AC1_a_delay_of_10_seconds_places_nothing_at_end_plus_9_and_one_call_at_end_plus_10(self):
        self.contacts(3)
        c = self.campaign("sequential", dial_delay_seconds=10)
        cid = c["id"]
        self.start(cid)
        end_at = T0 + 30 * SEC
        self.end(cid, at=end_at)
        self.tick(cid, end_at + 9 * SEC)
        self.assertEqual(len(self.attempts(cid)), 1, "end + 9 s: nothing")
        self.tick(cid, end_at + 10 * SEC)
        a = self.attempts(cid)
        self.assertEqual(len(a), 2, "end + 10 s: the next call")
        self.assertEqual(t_of(a[1]["placed_at"]), end_at + 10 * SEC)
        # and the gap counts from the END of that call, not from when it was placed
        self.end(cid, at=end_at + 25 * SEC)
        self.tick(cid, end_at + 34 * SEC)
        self.assertEqual(len(self.attempts(cid)), 2)
        self.tick(cid, end_at + 35 * SEC)
        self.assertEqual(len(self.attempts(cid)), 3)


# ═══════════════════════════════════════════════════════════════════════════
# AC2  Concurrent
# ═══════════════════════════════════════════════════════════════════════════


class AC2ConcurrentTests(StrategyBase):
    def test_AC2_concurrent_5_with_12_numbers_keeps_exactly_5_active_and_starts_a_new_call_when_one_ends(self):
        cs = self.contacts(12)
        c = self.campaign("concurrent", dial_concurrent_calls=5)
        cid = c["id"]
        d = self.start(cid)
        self.assertEqual((d["dialed"], d["active_now"], d["queued"]), (5, 5, 7), "exactly 5 at once")
        wave1 = self.attempts(cid)
        self.assertEqual(sorted(a["dial_slot"] for a in wave1), [1, 2, 3, 4, 5], "slots 1-5 in wave 1")
        self.assertEqual({a["dial_batch"] for a in wave1}, {1}, "wave 1")
        for step in range(1, 8):                    # the 7 numbers still queued
            t = T0 + step * 10 * SEC
            self.end(cid, 1, at=t)
            self.assertEqual(self.active(cid), 4)
            self.tick(cid, t)
            self.assertEqual(self.active(cid), 5, "a call ended: a new one started, back to 5")
            self.assertEqual(sorted(a["dial_slot"] for a in self.open_attempts(cid)), [1, 2, 3, 4, 5], "slots 1-5 again")
        self.assertEqual(self.phones(cid), self.keys(cs), "all 12, in order, each once")
        self.assertEqual(self.row(cid)["dial_running"], False, "the last number was handed out: the pass is finished")

    def test_AC2_draining_ends_with_no_active_call_and_the_pass_finished(self):
        self.contacts(12)
        c = self.campaign("concurrent", dial_concurrent_calls=5)
        cid = c["id"]
        self.start(cid)
        peak = 5
        for step in range(1, 30):
            t = T0 + step * 10 * SEC
            self.end(cid, 1, at=t)
            self.tick(cid, t)
            peak = max(peak, self.active(cid))
            self.assertLessEqual(self.active(cid), 5)
            if self.active(cid) == 0:
                break
        self.assertEqual((peak, self.active(cid)), (5, 0))
        row = self.row(cid)
        self.assertEqual((row["dial_running"], row["status"], row["dial_seq"], row["dial_cursor"]), (False, "Active", None, None))
        self.assertEqual(len(self.attempts(cid)), 12)


# ═══════════════════════════════════════════════════════════════════════════
# AC3  Paced (Calls per Minute)
# ═══════════════════════════════════════════════════════════════════════════


class AC3PacedTests(StrategyBase):
    def drive(self, cid, seconds):
        for s in range(1, seconds):
            self.tick(cid, T0 + s * SEC)

    def test_AC3_ten_calls_a_minute_for_five_minutes_is_about_50_calls_evenly_spread_six_seconds_apart(self):
        self.contacts(70)
        c = self.campaign("paced", dial_calls_per_minute=10)
        cid = c["id"]
        self.start(cid)
        self.drive(cid, 300)                        # one tick a second for 5 simulated minutes
        times = self.placed_times(cid)
        offsets = [(x - T0).total_seconds() for x in times]
        self.assertTrue(49 <= len(times) <= 51, f"about 50 calls, got {len(times)}")
        self.assertEqual({round(b - a, 3) for a, b in zip(offsets, offsets[1:])}, {6.0}, "a call every 6.000 s")
        for minute in range(5):
            n = sum(1 for o in offsets if minute * 60 <= o < (minute + 1) * 60)
            self.assertEqual(n, 10, f"minute {minute + 1}")
        for w in range(0, 240, 7):                  # and every sliding 60 s window
            n = sum(1 for o in offsets if w <= o < w + 60)
            self.assertTrue(9 <= n <= 11, f"window from {w} s holds {n}")
        self.assertEqual({a["dial_slot"] for a in self.attempts(cid)}, {None}, "paced calls hold no slot")

    def test_AC3_the_rate_holds_when_the_engine_looks_between_the_grid_times(self):
        self.contacts(70)
        c = self.campaign("paced", dial_calls_per_minute=10)
        cid = c["id"]
        self.start(cid)
        for s in range(4, 300, 4):                  # the engine looks every 4 s: never exactly on the 6 s grid
            self.tick(cid, T0 + s * SEC)
        offsets = [(x - T0).total_seconds() for x in self.placed_times(cid)]
        self.assertTrue(48 <= len(offsets) <= 51, f"about 50 calls, got {len(offsets)}: the grid must not drift")
        for minute in range(5):
            n = sum(1 for o in offsets if minute * 60 <= o < (minute + 1) * 60)
            self.assertTrue(9 <= n <= 11, f"minute {minute + 1} holds {n}")

    def test_AC3_a_delay_of_20_seconds_gives_three_calls_a_minute(self):
        self.contacts(30)
        c = self.campaign("paced", dial_calls_per_minute=10, dial_delay_seconds=20)
        cid = c["id"]
        self.start(cid)
        self.drive(cid, 300)
        offsets = [(x - T0).total_seconds() for x in self.placed_times(cid)]
        self.assertEqual({round(b - a, 3) for a, b in zip(offsets, offsets[1:])}, {20.0})
        for minute in range(5):
            self.assertEqual(sum(1 for o in offsets if minute * 60 <= o < (minute + 1) * 60), 3, f"minute {minute + 1}")

    def test_AC3_there_is_no_catch_up_burst_after_a_pause(self):
        self.contacts(40)
        c = self.campaign("paced", dial_calls_per_minute=10)
        cid = c["id"]
        self.start(cid)
        self.drive(cid, 20)
        before = len(self.attempts(cid))
        back = T0 + 10 * MIN                         # nobody looked for ten minutes (a pause, an outage, the hours)
        self.tick(cid, back)
        self.assertEqual(len(self.attempts(cid)), before + 1, "one call, not the sixty that were 'owed'")
        for s in range(1, 6):
            self.tick(cid, back + s * SEC)
        self.assertEqual(len(self.attempts(cid)), before + 1, "and the next one is 6 s later, not at once")
        self.tick(cid, back + 6 * SEC)
        self.assertEqual(len(self.attempts(cid)), before + 2)


# ═══════════════════════════════════════════════════════════════════════════
# AC4  Existing campaigns keep working
# ═══════════════════════════════════════════════════════════════════════════


class AC4ExistingCampaignsTests(StrategyBase):
    def legacy(self, **extra):
        """A campaign as the migration leaves an existing one: Concurrent / 20 (the old engine dialed a list in
        batches of up to 20 and never waited for a call to end)."""
        row = {"user_id": self.user, "name": "Old campaign", "agent_id": self.agent["id"], "list_id": self.list["id"],
               "phone_number_id": self.out_number["id"], "dnc_screening_enabled": False, "status": "Inactive",
               "dial_strategy": "concurrent", "dial_concurrent_calls": 20, "dial_calls_per_minute": 10, "dial_delay_seconds": 0, **extra}
        return supabase.table("outbound_campaigns").insert(row).execute().data[0]

    def test_AC4_a_new_campaign_defaults_to_sequential_5_10_0_and_a_migrated_one_is_concurrent_20(self):
        r = self.api("post", "/telephony/campaigns", json={"name": "New", "agent_id": self.agent["id"], "list_id": self.list["id"],
                                                          "phone_number_id": self.out_number["id"], "dnc_screening_enabled": False})
        self.assertEqual(r.status_code, 200, r.text)
        new = self.row(r.json()["data"]["id"])
        self.assertEqual((new["dial_strategy"], new["dial_concurrent_calls"], new["dial_calls_per_minute"], new["dial_delay_seconds"]),
                         ("sequential", 5, 10, 0))
        old = self.legacy()
        got = self.api("get", f"/telephony/campaigns/{old['id']}").json()["data"]["dialing"]
        self.assertEqual(got["settings"], {"strategy": "concurrent", "concurrent_calls": 20, "calls_per_minute": 10, "delay_seconds": 0})

    def test_AC4_a_legacy_campaign_dials_a_short_list_the_way_it_used_to_everyone_at_once_in_order(self):
        cs = self.contacts(12)
        old = self.legacy()
        d = self.start(old["id"])
        self.assertEqual((d["dialed"], d["active_now"], d["strategy"]), (12, 12, "concurrent"), "Start dials the whole list")
        self.assertEqual(self.phones(old["id"]), self.keys(cs))
        self.assertEqual(self.row(old["id"])["dial_running"], False, "and the pass is over")

    def test_AC4_a_legacy_campaign_dials_many_at_once_but_never_more_than_20(self):
        cs = self.contacts(30)
        old = self.legacy()
        d = self.start(old["id"])
        self.assertEqual((d["dialed"], d["active_now"], d["queued"]), (20, 20, 10))
        self.end(old["id"], 3, at=T0 + 5 * SEC)
        self.tick(old["id"], T0 + 5 * SEC)
        self.assertEqual(self.active(old["id"]), 20, "refilled to 20, no more")
        self.tick(old["id"], T0 + 6 * SEC)
        self.assertEqual(self.active(old["id"]), 20)
        self.assertEqual(self.phones(old["id"]), self.keys(cs[:23]))


# ═══════════════════════════════════════════════════════════════════════════
# AC5  Retries follow the campaign's strategy
# ═══════════════════════════════════════════════════════════════════════════


class AC5RetryTests(StrategyBase):
    RETRY = dict(retry_enabled=True, retry_max_attempts=3, retry_interval_minutes=5)

    def no_answer(self, cid, n, at):
        return self.end(cid, n, at=at, outcome="no_answer", reason="customer-did-not-answer")

    def test_AC5_a_due_redial_is_placed_before_fresh_numbers_and_counts_in_the_same_cap(self):
        cs = self.contacts(6)
        c = self.campaign("concurrent", dial_concurrent_calls=2, **self.RETRY)
        cid = c["id"]
        self.start(cid)                                           # P1, P2 on the line
        self.no_answer(cid, 2, T0 + 10 * SEC)
        self.tick(cid, T0 + 11 * SEC)                             # their redials are not due: P3, P4 go
        self.assertEqual(self.phones(cid)[2:], self.keys(cs[2:4]))
        self.end(cid, 2, at=T0 + 20 * SEC)
        due = T0 + 10 * SEC + 5 * MIN
        res = self.tick(cid, due)
        self.assertEqual((res.redials_placed, res.placed), (2, 0), "the redials went first; the cap (2) was then used up")
        self.assertEqual(self.active(cid), 2, "redials and fresh numbers count in the same cap")
        redials = [a for a in self.attempts(cid) if a["dial_source"] == "redial"]
        self.assertEqual(sorted(a["phone_key"] for a in redials), sorted(self.keys(cs[:2])))
        self.assertEqual(sorted(self.phones(cid)[-2:]), sorted(self.keys(cs[:2])))

    def test_AC5_a_sequential_redial_waits_for_the_open_call(self):
        cs = self.contacts(3)
        c = self.campaign("sequential", **self.RETRY)
        cid = c["id"]
        self.start(cid)
        self.no_answer(cid, 1, T0 + 5 * SEC)
        self.tick(cid, T0 + 6 * SEC)                              # P2 is on the line
        self.assertEqual(self.phones(cid), self.keys(cs[:2]))
        self.assertIsNone(self.tick(cid, T0 + 6 * MIN), "P1's redial is due but the single line is taken")
        self.assertEqual(self.active(cid), 1)
        self.end(cid, at=T0 + 7 * MIN)
        res = self.tick(cid, T0 + 7 * MIN)
        self.assertEqual((res.redials_placed, res.placed), (1, 0), "the line is free: the redial goes before P3")
        self.assertEqual(self.phones(cid)[-1], self.keys(cs[:1])[0])

    def test_AC5_a_concurrent_redial_uses_a_free_slot(self):
        cs = self.contacts(3)
        c = self.campaign("concurrent", dial_concurrent_calls=3, **self.RETRY)
        cid = c["id"]
        self.start(cid)                                           # slots 1, 2, 3
        first = self.open_attempts(cid)[0]
        self.assertEqual((first["phone_key"], first["dial_slot"]), (self.keys(cs)[0], 1))
        self.no_answer(cid, 1, T0 + 10 * SEC)                     # P1 ends: slot 1 is free
        self.assertIsNone(self.tick(cid, T0 + 20 * SEC), "its redial is not due yet and nothing else is queued")
        self.assertEqual(self.active(cid), 2)
        res = self.tick(cid, T0 + 10 * SEC + 5 * MIN)
        self.assertEqual(res.redials_placed, 1)
        redial = [a for a in self.attempts(cid) if a["dial_source"] == "redial"][0]
        self.assertEqual((redial["phone_key"], redial["dial_slot"], redial["attempt_number"]), (self.keys(cs)[0], 1, 2))
        self.assertEqual(self.active(cid), 3)

    def test_AC5_a_paced_redial_keeps_the_rate(self):
        cs = self.contacts(3)
        c = self.campaign("paced", dial_calls_per_minute=10, **self.RETRY)
        cid = c["id"]
        self.start(cid)
        for s in range(1, 13):
            self.tick(cid, T0 + s * SEC)                          # P1 at 0, P2 at 6, P3 at 12
        self.assertEqual(self.phones(cid), self.keys(cs))
        self.no_answer(cid, 3, T0 + 20 * SEC)                     # all three come due together, 5 minutes later
        base = T0 + 20 * SEC + 5 * MIN
        for s in range(0, 40):
            self.tick(cid, base + s * SEC)
        redial_times = [t_of(a["placed_at"]) for a in self.attempts(cid) if a["dial_source"] == "redial"]
        self.assertEqual(len(redial_times), 3)
        self.assertEqual({(b - a).total_seconds() for a, b in zip(redial_times, redial_times[1:])}, {6.0},
                         "redials are spread at the campaign's rate, not sent together")


# ═══════════════════════════════════════════════════════════════════════════
# AC6  Two campaigns at the same time
# ═══════════════════════════════════════════════════════════════════════════


class AC6TwoCampaignsTests(StrategyBase):
    def test_AC6_two_campaigns_of_one_account_with_different_strategies_each_obey_their_own_limit(self):
        self.contacts(10)
        other = self.new_list()
        self.contacts(10, other["id"])
        a = self.campaign("concurrent", dial_concurrent_calls=3)
        b = self.campaign("sequential", list_id=other["id"])
        self.mark_running(a["id"], b["id"])
        res = self.dispatch(T0)
        self.assertEqual(res["served"], 2)
        self.assertEqual((self.active(a["id"]), self.active(b["id"])), (3, 1))
        # one at a time on B, three at a time on A, through a whole run
        for i in range(1, 6):
            t = T0 + i * 10 * SEC
            self.end(a["id"], 1, at=t)
            self.end(b["id"], at=t)
            self.dispatch(t)
            self.assertEqual((self.active(a["id"]), self.active(b["id"])), (3, 1))

    def test_AC6_both_campaigns_count_against_the_account_cap(self):
        self.contacts(10)
        other = self.new_list()
        self.contacts(10, other["id"])
        self.set_cap(4)
        a = self.campaign("concurrent", dial_concurrent_calls=3)
        b = self.campaign("concurrent", dial_concurrent_calls=3, list_id=other["id"])
        self.mark_running(a["id"], b["id"])
        self.dispatch(T0)
        self.assertEqual(self.open_total(), 4, "3 + 3 wanted, the account allows 4")
        for i in range(1, 8):
            t = T0 + i * 10 * SEC
            self.end(a["id"], 1, at=t)
            self.end(b["id"], 1, at=t)
            self.dispatch(t)
            self.assertLessEqual(self.open_total(), 4)
        self.assertGreater(len(self.attempts(a["id"])), 3)
        self.assertGreater(len(self.attempts(b["id"])), 3, "and neither campaign was starved")

    def test_AC6_campaigns_of_different_accounts_are_served_in_one_dispatch_each_with_its_own_limits(self):
        self.contacts(10)
        acct = self.second_account()
        self.contacts_of(acct, 10)
        self.set_cap(2)                                           # account 1 is capped, account 2 is not
        a = self.campaign("concurrent", dial_concurrent_calls=5)
        b = self.campaign_of(acct, "concurrent", dial_concurrent_calls=4)
        self.mark_running(a["id"], b["id"])
        res = self.dispatch(T0)
        self.assertEqual(res["served"], 2)
        self.assertEqual(self.active(a["id"]), 2, "account 1: its cap of 2")
        self.assertEqual(self.active(b["id"]), 4, "account 2: its own campaign limit of 4, untouched by account 1's cap")
        for i in range(1, 4):
            t = T0 + i * 10 * SEC
            self.end(a["id"], at=t)
            self.end(b["id"], 1, at=t)
            self.dispatch(t)
            self.assertEqual((self.active(a["id"]), self.active(b["id"])), (2, 4))


# ═══════════════════════════════════════════════════════════════════════════
# AC7  Never the same number twice at the same time
# ═══════════════════════════════════════════════════════════════════════════

STRATEGIES = (("sequential", {}), ("concurrent", {"dial_concurrent_calls": 4}), ("paced", {"dial_calls_per_minute": 60}))


class AC7NeverTwiceTests(StrategyBase):
    def no_double_calls(self, phones):
        """No number is on two calls at once: at most one open attempt per number key, ever (checked by the caller at
        every step) and `phones` is the list of numbers placed in all."""
        self.assertEqual(len(phones), len(set(phones)), "a number was called twice")

    def test_AC7_duplicate_rows_in_a_list_are_called_once_in_every_strategy(self):
        for strategy, extra in STRATEGIES:
            with self.subTest(strategy=strategy):
                lst = self.new_list(strategy)
                cs = self.contacts(3, lst["id"])
                for dup in (cs[0]["phone"], "+1 (555) 777-" + cs[1]["phone"][-4:]):      # the same number, written two ways
                    supabase.table("contacts").insert({"user_id": self.user, "list_id": lst["id"], "name": "again", "phone": dup}).execute()
                c = self.campaign(strategy, list_id=lst["id"], **extra)
                cid = c["id"]
                self.start(cid)
                t = T0
                for step in range(1, 40):
                    t = T0 + step * 7 * SEC
                    keys = [a["phone_key"] for a in self.open_attempts(cid)]
                    self.assertEqual(len(keys), len(set(keys)), "two open calls to one number")
                    self.end(cid, at=t)
                    self.tick(cid, t)
                    if not self.row(cid)["dial_running"] and not self.active(cid):
                        break
                phones = self.phones(cid)
                self.assertEqual(sorted(phones), sorted(self.keys(cs)), "each number once; the repeats were skipped")
                self.no_double_calls(phones)
                self.end(cid, at=t + MIN)                      # leave nothing open for the next strategy
                self.at(T0)

    def test_AC7_the_same_number_in_two_campaigns_is_never_on_two_calls_at_once_in_any_strategy(self):
        for strategy, extra in STRATEGIES:
            with self.subTest(strategy=strategy):
                shared = f"+1555666{abs(hash(strategy)) % 9000 + 1000}"
                la, lb = self.new_list("A"), self.new_list("B")
                for lst in (la, lb):
                    for phone in (shared, f"+1555667{uuid.uuid4().int % 9000 + 1000}"):
                        supabase.table("contacts").insert({"user_id": self.user, "list_id": lst["id"], "name": "n", "phone": phone}).execute()
                a = self.campaign(strategy, list_id=la["id"], **extra)
                b = self.campaign(strategy, list_id=lb["id"], **extra)
                self.mark_running(a["id"], b["id"])
                t = T0
                for step in range(0, 30):
                    t = T0 + step * 7 * SEC
                    self.dispatch(t)
                    keys = [x["phone_key"] for x in self.open_attempts(a["id"]) + self.open_attempts(b["id"])]
                    self.assertEqual(len(keys), len(set(keys)), "the same number is on two calls at once")
                    self.end(a["id"], at=t + 3 * SEC)
                    self.end(b["id"], at=t + 3 * SEC)
                key = call_retry.phone_key(shared)
                placed_to_shared = [x for x in self.attempts(a["id"]) + self.attempts(b["id"]) if x["phone_key"] == key]
                self.assertEqual(len(placed_to_shared), 1, "the shared number was called once, by whichever campaign got there first")
                self.assertEqual(len(self.by_phone[shared]), 1)
                self.at(T0)

    def test_AC7_two_ticks_at_once_never_place_a_number_twice(self):
        cs = self.contacts(6)
        c = self.campaign("concurrent", dial_concurrent_calls=6)
        self.mark_running(c["id"])

        async def two():
            return await asyncio.gather(dialer.tick(c["id"], T0), dialer.tick(c["id"], T0))
        asyncio.run(two())
        self.assertEqual(sorted(self.phones(c["id"])), sorted(self.keys(cs)))
        self.assertEqual(self.create_call.await_count, 6)


# ═══════════════════════════════════════════════════════════════════════════
# AC8  Hours, pause / resume, a strategy change mid-run
# ═══════════════════════════════════════════════════════════════════════════


class AC8HoursPauseChangeTests(StrategyBase):
    def test_AC8_outside_the_hours_no_new_call_is_placed_in_any_strategy_and_active_calls_finish(self):
        for strategy, extra in STRATEGIES:
            with self.subTest(strategy=strategy):
                lst = self.new_list(strategy)
                self.contacts(8, lst["id"])
                self.at(local("UTC", 2026, 10, 14, 12))
                c = self.campaign(strategy, list_id=lst["id"], **HOURS, **extra)
                cid = c["id"]
                self.start(cid)
                opened = self.active(cid)
                placed = len(self.attempts(cid))
                self.assertGreaterEqual(opened, 1)
                closed = local("UTC", 2026, 10, 14, 18)
                self.tick(cid, closed)                                   # the hours are over
                for s in (1, 60, 600):
                    self.tick(cid, closed + s * SEC)
                self.assertEqual(len(self.attempts(cid)), placed, "no new call after closing time")
                self.assertEqual(self.active(cid), opened, "the calls in progress are never cut")
                row = self.row(cid)
                self.assertEqual(row["status"], "Paused")
                self.assertIsNotNone(row["stopped_by_hours_at"], "parked, marked to carry on at the next opening")
                self.assertEqual(self.end(cid, at=closed + 20 * MIN), opened, "and they finish normally")
                self.tick(cid, closed + 21 * MIN)
                self.assertEqual(len(self.attempts(cid)), placed)
                self.assertTrue(all(a["outcome"] == "answered" for a in self.attempts(cid) if a["ended_at"]))

    def test_AC8_hours_that_close_in_the_middle_of_a_group_stop_the_next_placement_not_the_next_batch(self):
        cs = self.contacts(8)
        self.at(local("UTC", 2026, 10, 14, 12))
        c = self.campaign("concurrent", dial_concurrent_calls=6, **HOURS)
        cid = c["id"]
        inner = dialer.gate
        seen = {"n": 0}

        def closing(*a, **kw):
            out = inner(*a, **kw)
            if "stop" not in out:
                seen["n"] += 1
                if seen["n"] == 2:
                    self.at(local("UTC", 2026, 10, 14, 18))      # the hours end right after the second placement
            return out
        # (placements go through the gate off the event loop now, so the second call's own answer no longer lands
        # before the third call's gate: the hours are closed from the second GATE instead of the second answer)
        with patch.object(dialer, "gate", closing):
            d = self.start(cid)
        self.assertEqual((d["dialed"], d["stopped_by_hours"], d["remaining"]), (2, True, 6), "4 of the group's 6 did not go out")
        self.assertEqual(self.phones(cid), self.keys(cs[:2]))
        row = self.row(cid)
        self.assertEqual((row["status"], row["dial_running"]), ("Paused", True))
        self.assertEqual(self.active(cid), 2, "the two calls already placed are never cut")

    def test_AC8_the_campaign_carries_on_at_the_next_opening_from_where_it_stopped(self):
        cs = self.contacts(6)
        self.at(local("UTC", 2026, 10, 14, 12))
        c = self.campaign("concurrent", dial_concurrent_calls=2, **HOURS)
        cid = c["id"]
        self.start(cid)
        closed = local("UTC", 2026, 10, 14, 18)
        self.tick(cid, closed)
        self.end(cid, at=closed + MIN)
        nxt = local("UTC", 2026, 10, 15, 9)
        self.at(nxt)
        res = asyncio.run(campaign_scheduler.run_auto_resumes(nxt))
        self.assertEqual(res["resumed"], 1)
        self.run_to_end(cid)
        self.assertEqual(self.phones(cid), self.keys(cs), "the rest in order, nobody twice")

    def pause_then(self, strategy, extra):
        lst = self.new_list(strategy)
        cs = self.contacts(8, lst["id"])
        c = self.campaign(strategy, list_id=lst["id"], **extra)
        return lst, cs, c

    def test_AC8_pause_stops_new_calls_at_once_active_calls_finish_and_resume_continues_from_the_cursor(self):
        for strategy, extra in STRATEGIES:
            with self.subTest(strategy=strategy):
                lst, cs, c = self.pause_then(strategy, extra)
                cid = c["id"]
                self.at(T0)
                self.start(cid)
                opened = self.active(cid)
                self.assertEqual(self.api("post", f"/telephony/campaigns/{cid}/pause").status_code, 200)
                placed = self.phones(cid)
                for s in (1, 7, 30, 120):
                    self.assertIsNone(self.tick(cid, T0 + s * SEC), "a paused campaign is not served")
                self.assertEqual(self.phones(cid), placed, "paused: nothing new")
                self.assertEqual(self.active(cid), opened)
                self.assertEqual(self.end(cid, at=T0 + 3 * MIN), opened, "active calls finish while paused")
                row = self.row(cid)
                self.assertEqual((row["status"], row["dial_running"]), ("Paused", True), "the pass stays open")
                late = self.contacts(1, lst["id"])                      # added while paused: reached after the others
                self.at(T0 + 4 * MIN)
                r = self.api("post", f"/telephony/campaigns/{cid}/resume")
                self.assertEqual((r.status_code, r.json()["data"]["resumed"]), (200, True))
                self.run_to_end(cid)
                self.assertEqual(self.phones(cid), self.keys(cs + late), "continued from the cursor: in order, nobody twice")
                self.end(cid, at=T0 + 20 * MIN)
                self.at(T0)

    def test_AC8_changing_sequential_to_concurrent_mid_run_places_two_more_and_keeps_each_calls_snapshot(self):
        self.contacts(8)
        c = self.campaign("sequential")
        cid = c["id"]
        self.start(cid)
        self.assertEqual(self.active(cid), 1)
        r = self.api("patch", f"/telephony/campaigns/{cid}", json={"dial_strategy": "concurrent", "dial_concurrent_calls": 3})
        self.assertEqual(r.status_code, 200, r.text)
        self.tick(cid, T0 + SEC)
        self.assertEqual(self.active(cid), 3, "1 open + 2 more")
        self.assertEqual([a["settings"]["dial"]["strategy"] for a in self.attempts(cid)], ["sequential", "concurrent", "concurrent"])

    def test_AC8_changing_concurrent_5_to_sequential_places_nothing_until_all_five_end(self):
        self.contacts(10)
        c = self.campaign("concurrent", dial_concurrent_calls=5)
        cid = c["id"]
        self.start(cid)
        self.assertEqual(self.active(cid), 5)
        self.api("patch", f"/telephony/campaigns/{cid}", json={"dial_strategy": "sequential"})
        for i in range(1, 5):
            self.end(cid, 1, at=T0 + i * SEC)
            self.tick(cid, T0 + i * SEC)
            self.assertEqual(self.active(cid), 5 - i)
            self.assertEqual(len(self.attempts(cid)), 5, "nothing new while any of the 5 is still open")
        self.end(cid, 1, at=T0 + 5 * SEC)
        self.tick(cid, T0 + 5 * SEC)
        self.assertEqual((self.active(cid), len(self.attempts(cid))), (1, 6))
        self.tick(cid, T0 + 6 * SEC)
        self.assertEqual(len(self.attempts(cid)), 6, "and now one at a time")


# ═══════════════════════════════════════════════════════════════════════════
# AC9  Account cap and platform maximum
# ═══════════════════════════════════════════════════════════════════════════


class AC9CapTests(StrategyBase):
    def test_AC9_an_account_cap_of_3_with_concurrent_5_gives_at_most_3_active_and_says_so_everywhere(self):
        cs = self.contacts(10)
        self.set_cap(3)
        body = {"name": "Cap", "agent_id": self.agent["id"], "list_id": self.list["id"], "phone_number_id": self.out_number["id"],
                "dnc_screening_enabled": False, "dial_strategy": "concurrent", "dial_concurrent_calls": 5}
        created = self.api("post", "/telephony/campaigns", json=body)
        self.assertEqual(created.status_code, 200, created.text)
        self.assertEqual(len(created.json()["warnings"]), 1, "warnings on create")
        cid = created.json()["data"]["id"]
        patched = self.api("patch", f"/telephony/campaigns/{cid}", json={"dial_concurrent_calls": 5, "name": "Cap 2"})
        self.assertEqual(len(patched.json()["warnings"]), 1, "warnings on edit")
        r = self.api("post", f"/telephony/campaigns/{cid}/start")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(len(r.json()["warnings"]), 1, "warnings on start")
        d = r.json()["data"]
        self.assertEqual((d["dialed"], d["active_now"]), (3, 3))
        self.assertEqual(d["capped"], {"requested": 5, "effective": 3, "reason": "account"})
        dialing = self.api("get", f"/telephony/campaigns/{cid}").json()["data"]["dialing"]
        self.assertTrue(dialing["effective"]["capped"])
        self.assertEqual((dialing["effective"]["cap"], dialing["effective"]["cap_source"], dialing["effective"]["concurrent_calls"]), (3, "account", 3))
        self.assertEqual(len(dialing["warnings"]), 1)
        self.assertNotIn("vapi", " ".join(dialing["warnings"]).lower())
        for i in range(1, 8):                                     # never above 3, through a whole run
            self.end(cid, 1, at=T0 + i * SEC)
            self.tick(cid, T0 + i * SEC)
            self.assertLessEqual(self.active(cid), 3)

    def test_AC9_raising_the_cap_applies_on_the_next_tick(self):
        self.contacts(10)
        self.set_cap(3)
        c = self.campaign("concurrent", dial_concurrent_calls=5)
        self.start(c["id"])
        self.assertEqual(self.active(c["id"]), 3)
        self.set_cap(5)
        self.tick(c["id"], T0 + SEC)
        self.assertEqual(self.active(c["id"]), 5)
        self.set_cap(2)                                           # lowering it never cuts a call, it just stops new ones
        self.end(c["id"], 1, at=T0 + 2 * SEC)
        self.tick(c["id"], T0 + 2 * SEC)
        self.assertEqual(self.active(c["id"]), 4)

    def test_AC9_two_campaigns_of_one_account_share_the_pool(self):
        self.contacts(10)
        other = self.new_list()
        self.contacts(10, other["id"])
        self.set_cap(4)
        a = self.campaign("concurrent", dial_concurrent_calls=4)
        b = self.campaign("concurrent", dial_concurrent_calls=4, list_id=other["id"])
        self.mark_running(a["id"], b["id"])
        self.dispatch(T0)
        self.assertEqual(self.active(a["id"]) + self.active(b["id"]), 4, "one pool of 4, not 4 each")

    def test_AC9_the_platform_maximum_bounds_every_account(self):
        self.contacts(10)
        supabase.table("platform_settings").update({"dial_platform_max": 2}).eq("id", 1).execute()
        self.addCleanup(lambda: supabase.table("platform_settings").update({"dial_platform_max": None}).eq("id", 1).execute())
        c = self.campaign("concurrent", dial_concurrent_calls=5)
        d = self.start(c["id"])
        self.assertEqual(d["active_now"], 2)
        self.assertEqual(d["capped"]["reason"], "platform")


# ═══════════════════════════════════════════════════════════════════════════
# AC10  Per-call logging
# ═══════════════════════════════════════════════════════════════════════════


class AC10LoggingTests(StrategyBase):
    def test_AC10_a_sequential_call_stores_strategy_slot_1_no_wave_and_its_source(self):
        self.contacts(2)
        c = self.campaign("sequential")
        self.start(c["id"])
        a = self.attempts(c["id"])[0]
        self.assertEqual((a["dial_strategy"], a["dial_slot"], a["dial_batch"], a["dial_source"]), ("sequential", 1, None, "fresh"))
        self.assertEqual(a["settings"]["dial"]["strategy"], "sequential")

    def test_AC10_concurrent_calls_store_their_slot_and_wave_and_a_redial_says_redial(self):
        self.contacts(6)
        c = self.campaign("concurrent", dial_concurrent_calls=3, retry_enabled=True, retry_max_attempts=2, retry_interval_minutes=5)
        cid = c["id"]
        self.start(cid)
        wave1 = self.attempts(cid)
        self.assertEqual([(a["dial_strategy"], a["dial_slot"], a["dial_batch"], a["dial_source"]) for a in wave1],
                         [("concurrent", 1, 1, "fresh"), ("concurrent", 2, 1, "fresh"), ("concurrent", 3, 1, "fresh")])
        self.end(cid, 1, at=T0 + 10 * SEC, outcome="no_answer", reason="customer-did-not-answer")
        self.tick(cid, T0 + 10 * SEC)
        later = self.attempts(cid)[3]
        self.assertEqual((later["dial_slot"], later["dial_source"], later["dial_batch"] > 1), (1, "fresh", True), "a later wave, the freed slot")
        self.assertIsNone(self.tick(cid, T0 + 10 * SEC + 5 * MIN), "no room (3 open): the redial waits")
        self.end(cid, 3, at=T0 + 6 * MIN)
        self.tick(cid, T0 + 6 * MIN)
        redial = [a for a in self.attempts(cid) if a["dial_source"] == "redial"]
        self.assertEqual(len(redial), 1)
        self.assertEqual((redial[0]["dial_strategy"], redial[0]["attempt_number"]), ("concurrent", 2))

    def test_AC10_paced_calls_store_no_slot_and_the_minute_window_as_their_wave(self):
        self.contacts(30)
        c = self.campaign("paced", dial_calls_per_minute=10)
        cid = c["id"]
        self.start(cid)
        for s in range(1, 130):
            self.tick(cid, T0 + s * SEC)
        attempts = self.attempts(cid)
        self.assertEqual({a["dial_strategy"] for a in attempts}, {"paced"})
        self.assertEqual({a["dial_slot"] for a in attempts}, {None})
        for a in attempts:
            self.assertEqual(a["dial_batch"], int(t_of(a["placed_at"]).timestamp() // 60), "the minute it was placed in")
        per_minute = {}
        for a in attempts:
            per_minute[a["dial_batch"]] = per_minute.get(a["dial_batch"], 0) + 1
        self.assertIn(10, per_minute.values(), "GROUP BY dial_batch gives the calls per minute")
        self.assertEqual({a["dial_source"] for a in attempts}, {"fresh"})

    def test_AC10_the_numbers_view_carries_the_four_fields(self):
        self.contacts(1)
        c = self.campaign("concurrent", dial_concurrent_calls=2)
        self.start(c["id"])
        rows = self.api("get", f"/telephony/campaigns/{c['id']}/numbers").json()["data"]["rows"]
        h = rows[0]["history"][0]
        self.assertEqual((h["dial_strategy"], h["dial_slot"], h["dial_batch"], h["dial_source"]), ("concurrent", 1, 1, "fresh"))


# ═══════════════════════════════════════════════════════════════════════════
# AC11  The live payload
# ═══════════════════════════════════════════════════════════════════════════


class AC11LiveTests(StrategyBase):
    KEYS = {"campaign_id", "state", "strategy", "settings", "effective", "warnings", "active_now", "queued", "queued_fresh",
            "queued_redials", "redials_due_now", "placed", "placed_last_minute", "counters", "stall_reason", "next_call_at",
            "pass_started_at", "dispatcher_ok", "as_of"}

    def live(self):
        return self.api("get", "/telephony/campaigns/live").json()["data"]

    def test_AC11_the_live_payload_has_exactly_the_documented_keys_in_every_state(self):
        self.contacts(8)
        c = self.campaign("concurrent", dial_concurrent_calls=3)
        cid = c["id"]
        self.start(cid)
        s = self.live()[cid]
        self.assertEqual(set(s), self.KEYS)
        self.assertEqual(set(s["counters"]), {"suppressed", "busy", "duplicate", "errors", "last_error", "last_error_at"})
        self.assertEqual(set(s["effective"]), {"concurrent_calls", "calls_per_minute", "capped", "cap", "cap_source"})
        self.assertEqual(set(s["settings"]), {"strategy", "concurrent_calls", "calls_per_minute", "delay_seconds"})
        self.assertEqual((s["state"], s["active_now"], s["queued"], s["queued_fresh"], s["queued_redials"], s["placed"], s["strategy"]),
                         ("dialing", 3, 5, 5, 0, 3, "concurrent"))
        self.assertEqual(s["queued"], s["queued_fresh"] + s["queued_redials"], "queued is the total")
        self.assertEqual(s["placed_last_minute"], 3)
        # paused: still the same keys, the state says so
        self.api("post", f"/telephony/campaigns/{cid}/pause")
        s = self.live()[cid]
        self.assertEqual((set(s), s["state"]), (self.KEYS, "paused"))
        # a finished pass with calls still open
        self.api("post", f"/telephony/campaigns/{cid}/resume")
        for i in range(1, 6):
            self.end(cid, 1, at=T0 + i * SEC)
            self.tick(cid, T0 + i * SEC)
        s = self.live()[cid]
        self.assertEqual((set(s), s["state"], s["queued"], s["placed"]), (self.KEYS, "finishing", 0, 8))
        self.end(cid, at=T0 + 10 * SEC)
        self.assertEqual(self.live()[cid]["state"], "idle")

    def test_AC11_a_paced_campaign_says_when_the_next_call_is(self):
        self.contacts(10)
        c = self.campaign("paced", dial_calls_per_minute=10)
        self.start(c["id"])
        s = self.live()[c["id"]]
        self.assertEqual(set(s), self.KEYS)
        self.assertEqual(s["next_call_at"], "2026-10-14T12:00:06Z")

    def test_AC11_the_live_view_is_not_the_campaign_id_route(self):
        with patch.object(telephony, "_enrich_campaign_progress", side_effect=AssertionError("must not be called")):
            r = self.api("get", "/telephony/campaigns/live")
        self.assertEqual(r.status_code, 200, r.text)


# ═══════════════════════════════════════════════════════════════════════════
# The reconciler
# ═══════════════════════════════════════════════════════════════════════════


class ProviderBase(StrategyBase):
    """A mocked provider: `listed` is what GET /call returns, `full` what GET /call/{id} returns."""

    def setUp(self):
        super().setUp()
        self.listed: list[dict] = []
        self.full: dict[str, dict] = {}
        self.list_calls = AsyncMock(side_effect=lambda limit=100: list(self.listed))

        async def get_call(call_id):
            if call_id in self.full:
                return self.full[call_id]
            raise vapi_client.VapiAPIError("404 Not Found", 404, "no such call")
        self.get_call.side_effect = get_call
        self.autos = AsyncMock()
        for target, name, value in ((vapi_client, "list_calls", self.list_calls), (vapi_sync, "run_post_call_automations", self.autos)):
            p = patch.object(target, name, value)
            p.start()
            self.addCleanup(p.stop)
        dialer._import_failures.clear()
        dialer._last_lookup.clear()

    def record(self, call_id, ended=True, reason="customer-ended-call", seconds=42, cost=0.05, **extra):
        """The provider's record of one of our calls. An ended call carries its cost (as the provider's final record
        does); `cost=None` leaves it out, a record whose cost is not filled in yet."""
        r = {"id": call_id, "type": "outboundPhoneCall", "assistantId": self.agent["vapi_assistant_id"],
             "status": "ended" if ended else "in-progress",
             "startedAt": T0.strftime("%Y-%m-%dT%H:%M:%S.000Z"), **extra}
        if ended:
            r["endedReason"] = reason
            r["endedAt"] = (T0 + seconds * SEC).strftime("%Y-%m-%dT%H:%M:%S.000Z")
            if cost is not None:
                r["cost"] = cost
        return r

    def provider_has(self, call_id, **kw):
        r = self.record(call_id, **kw)
        self.full[call_id] = r
        self.listed.append(r)
        return r

    def reconcile(self, instant):
        self.at(instant)

        async def go():
            out = await dialer.reconcile_once(instant)
            await vapi_sync.drain_background()        # the post-call automations run as background tasks
            return out
        return asyncio.run(go())

    def conversations(self, call_id):
        return supabase.table("conversations").select("*").eq("vapi_call_id", call_id).execute().data


class RECReconcilerTests(ProviderBase):
    def test_REC1_an_ended_call_is_imported_once_frees_the_slot_bills_once_and_runs_the_automations_once(self):
        cs = self.contacts(3)
        c = self.campaign("sequential")
        cid = c["id"]
        self.start(cid)
        call = self.placed[0]
        self.provider_has(call)
        out = self.reconcile(T0 + 30 * SEC)
        self.assertEqual((out["open"], out["settled"], out["errors"]), (1, 1, 0))
        self.list_calls.assert_awaited_once()
        self.assertEqual(self.list_calls.await_args.kwargs["limit"], 22, "min(100, 2 * open + 20)")
        a = self.attempts(cid)[0]
        self.assertIsNotNone(a["ended_at"])
        self.assertEqual(a["outcome"], "answered")
        self.assertEqual(len(self.conversations(call)), 1)
        self.assertEqual(self.autos.await_count, 1, "the post-call automations ran exactly once")
        charged = supabase.table("wallet_transactions").select("id").eq("ref_id", call).execute().data
        self.assertEqual(len(charged), 1, "billed once")
        # the slot is free: the next number goes
        self.tick(cid, T0 + 31 * SEC)
        self.assertEqual(self.phones(cid), self.keys(cs[:2]))
        # a second cycle finds the first call closed: nothing to do, nothing run twice
        self.provider_has(self.placed[1], ended=False)
        out = self.reconcile(T0 + 45 * SEC)
        self.assertEqual((out["settled"], self.autos.await_count), (0, 1))
        self.assertEqual(len(supabase.table("wallet_transactions").select("id").eq("ref_id", call).execute().data), 1)
        # and the import path run again for the same call (the sync's own pass) does not repeat them either
        self.assertEqual(asyncio.run(vapi_sync.import_and_automate(self.full[call], self.user)), "updated")
        self.assertEqual(self.autos.await_count, 1)
        self.assertEqual(len(supabase.table("wallet_transactions").select("id").eq("ref_id", call).execute().data), 1)

    def test_REC2_a_call_the_provider_says_is_still_going_is_left_open(self):
        self.contacts(2)
        c = self.campaign("sequential")
        self.start(c["id"])
        self.provider_has(self.placed[0], ended=False)
        out = self.reconcile(T0 + 30 * SEC)
        self.assertEqual((out["settled"], out["errors"]), (0, 0))
        self.get_call.assert_not_awaited()
        self.assertEqual(self.active(c["id"]), 1)

    def test_REC3_a_call_younger_than_8_seconds_is_left_to_its_own_end_report(self):
        self.contacts(2)
        c = self.campaign("sequential")
        self.start(c["id"])
        self.provider_has(self.placed[0])
        out = self.reconcile(T0 + 7 * SEC)
        self.assertEqual(out["open"], 0)
        self.list_calls.assert_not_awaited()
        self.assertEqual(self.reconcile(T0 + 8 * SEC)["settled"], 1)

    def test_REC4_a_call_missing_from_the_list_is_asked_about_by_id_only_after_60_seconds_and_at_most_10_per_cycle(self):
        self.contacts(12)
        c = self.campaign("concurrent", dial_concurrent_calls=15)
        cid = c["id"]
        self.start(cid)
        self.assertEqual(self.active(cid), 12)
        for call in self.placed:
            self.full[call] = self.record(call)                  # the provider knows them all, but the list shows none
        out = self.reconcile(T0 + 59 * SEC)
        self.assertEqual(self.get_call.await_count, 0, "not before 60 s")
        self.assertEqual(self.list_calls.await_args.kwargs["limit"], 44)
        out = self.reconcile(T0 + 60 * SEC)
        self.assertEqual((out["lookups"], out["settled"], self.get_call.await_count), (10, 10, 10), "at most 10 by id per cycle")
        self.assertEqual(self.active(cid), 2)
        out = self.reconcile(T0 + 65 * SEC)
        self.assertEqual((out["lookups"], out["settled"], self.active(cid)), (2, 2, 0), "the rest on the next cycle")

    def test_REC5_a_poison_call_is_closed_directly_after_three_failed_imports_and_frees_the_slot(self):
        cs = self.contacts(3)
        c = self.campaign("sequential")
        cid = c["id"]
        self.start(cid)
        self.provider_has(self.placed[0], reason="customer-did-not-answer", seconds=0)
        boom = MagicMock(side_effect=RuntimeError("cannot store this call"))
        with patch.object(vapi_sync, "import_vapi_call", boom):
            for i, at in enumerate((30, 40)):
                out = self.reconcile(T0 + at * SEC)
                self.assertEqual((out["errors"], out["poison"], self.active(cid)), (1, 0, 1), f"failed import {i + 1}: the attempt is still open")
            with self.assertLogs(dialer.logger, "WARNING") as logs:
                out = self.reconcile(T0 + 50 * SEC)
        self.assertEqual((out["poison"], self.active(cid)), (1, 0), "the third failure closes it directly")
        self.assertTrue(any("could not be imported" in line for line in logs.output))
        a = self.attempts(cid)[0]
        self.assertEqual((a["outcome"], a["ended_reason"]), ("no_answer", "customer-did-not-answer"), "the classifier's outcome from the record")
        self.assertEqual(self.autos.await_count, 0)
        self.tick(cid, T0 + 51 * SEC)
        self.assertEqual(self.phones(cid), self.keys(cs[:2]), "the slot is free again")

    def test_REC5_a_poison_call_with_no_reason_in_its_record_closes_as_failed(self):
        self.contacts(2)
        c = self.campaign("sequential")
        self.start(c["id"])
        self.provider_has(self.placed[0], reason="", seconds=0)       # an ended call whose record says nothing about why
        with patch.object(vapi_sync, "import_vapi_call", MagicMock(side_effect=RuntimeError("no"))), self.assertLogs(dialer.logger, "WARNING"):
            for at in (30, 40, 50):
                self.reconcile(T0 + at * SEC)
        self.assertEqual(self.attempts(c["id"])[0]["outcome"], "failed")

    def test_REC6_a_provider_outage_changes_nothing_and_does_not_raise(self):
        self.contacts(2)
        c = self.campaign("sequential")
        self.start(c["id"])
        self.list_calls.side_effect = vapi_client.VapiAPIError("503 Service Unavailable", 503, "down")
        with self.assertLogs(dialer.logger, "WARNING"):
            out = self.reconcile(T0 + 30 * SEC)
        self.assertEqual((out["settled"], out["errors"], self.active(c["id"])), (0, 1, 1))
        self.list_calls.side_effect = lambda limit=100: list(self.listed)
        self.provider_has(self.placed[0])
        self.get_call.side_effect = vapi_client.VapiAPIError("502 Bad Gateway", 502, "")
        with self.assertLogs(dialer.logger, "WARNING"):
            out = self.reconcile(T0 + 40 * SEC)
        self.assertEqual((out["settled"], self.active(c["id"])), (0, 1), "a failed lookup is retried next cycle")

    def test_REC7_an_attempt_a_webhook_already_closed_is_not_reconciled(self):
        self.contacts(2)
        c = self.campaign("sequential")
        self.start(c["id"])
        body = Q.end_of_call_body(self.agent["vapi_assistant_id"], self.placed[0], "customer-ended-call", 30)
        body["message"]["endedAt"] = (T0 + 20 * SEC).strftime("%Y-%m-%dT%H:%M:%S.000Z")
        self.assertEqual(H.client.post("/webhooks/vapi", json=body).status_code, 200)
        self.assertEqual(self.active(c["id"]), 0)
        out = self.reconcile(T0 + 30 * SEC)
        self.assertEqual(out["open"], 0)
        self.list_calls.assert_not_awaited()

    def test_REC8_without_a_provider_key_or_with_the_loop_off_there_is_nothing_to_do(self):
        self.contacts(1)
        c = self.campaign("sequential")
        self.start(c["id"])
        with patch.object(settings, "vapi_api_key", ""):
            self.assertEqual(self.reconcile(T0 + 30 * SEC)["open"], 0)
        self.list_calls.assert_not_awaited()
        with patch.object(settings, "dialer_reconcile_seconds", 0):
            asyncio.run(asyncio.wait_for(dialer.reconciler_loop(), 2))       # returns at once: it is off

    def test_REC9_the_reconciler_settles_a_call_only_the_provider_knows_ended_for_a_concurrent_campaign(self):
        cs = self.contacts(6)
        c = self.campaign("concurrent", dial_concurrent_calls=3)
        cid = c["id"]
        self.start(cid)
        for call in self.placed[:2]:
            self.provider_has(call, reason="customer-busy", seconds=0)
        self.provider_has(self.placed[2], ended=False)
        out = self.reconcile(T0 + 30 * SEC)
        self.assertEqual((out["settled"], self.active(cid)), (2, 1))
        self.tick(cid, T0 + 31 * SEC)
        self.assertEqual(self.active(cid), 3, "the two freed slots are refilled")
        self.assertEqual(self.phones(cid), self.keys(cs[:5]))


# ═══════════════════════════════════════════════════════════════════════════
# reap_stale asks the provider first
# ═══════════════════════════════════════════════════════════════════════════


class REAPStaleTests(ProviderBase):
    def stale(self):
        self.contacts(2)
        c = self.campaign("sequential")
        self.start(c["id"])
        return c, self.placed[0], T0 + (call_retry.STALE_ATTEMPT_MINUTES + 1) * MIN

    def test_REAP_a_call_that_has_ended_at_the_provider_is_imported_not_closed_as_failed(self):
        c, call, later = self.stale()
        self.provider_has(call)
        self.assertEqual(call_retry.reap_stale(self.user, now=later), 1)
        a = self.attempts(c["id"])[0]
        self.assertEqual((a["outcome"], a["ended_reason"]), ("answered", "customer-ended-call"))
        self.assertEqual(len(self.conversations(call)), 1, "it was imported")
        self.assertEqual(self.autos.await_count, 1)

    def test_REAP_a_call_the_provider_does_not_know_is_closed_as_failed(self):
        c, call, later = self.stale()
        self.assertEqual(call_retry.reap_stale(self.user, now=later), 1)
        a = self.attempts(c["id"])[0]
        self.assertEqual((a["outcome"], a["ended_reason"]), ("failed", "no end-of-call report received"))

    def test_REAP_a_call_still_going_at_the_provider_is_left_open(self):
        c, call, later = self.stale()
        self.provider_has(call, ended=False)
        self.assertEqual(call_retry.reap_stale(self.user, now=later), 0)
        self.assertEqual(self.active(c["id"]), 1)

    def test_REAP_when_the_provider_cannot_be_asked_the_attempt_is_left_for_the_next_sweep(self):
        c, call, later = self.stale()
        for error in (vapi_client.VapiAPIError("500 Server Error", 500, ""), RuntimeError("network down"), asyncio.TimeoutError()):
            with self.subTest(error=type(error).__name__):
                self.get_call.side_effect = error
                with self.assertLogs(call_retry.logger, "WARNING") if not isinstance(error, vapi_client.VapiAPIError) else _nothing():
                    self.assertEqual(call_retry.reap_stale(self.user, now=later), 0)
                self.assertEqual(self.active(c["id"]), 1, "not closed wrongly")
        async def unknown(call_id):
            raise vapi_client.VapiAPIError("404 Not Found", 404, "")
        self.get_call.side_effect = unknown
        self.assertEqual(call_retry.reap_stale(self.user, now=later), 1, "and closed once the provider says it does not know it")

    def test_REAP_an_attempt_without_a_call_id_is_closed_without_asking_anyone(self):
        camp = {**self.row(self.campaign("sequential")["id"]), "user_id": self.user}
        contact = self.contacts(1)[0]
        self.assertIsNotNone(call_retry.begin_attempt(camp, contact, new_round=True, now=T0))
        self.get_call.reset_mock()
        self.assertEqual(call_retry.reap_stale(self.user, now=T0 + 91 * MIN), 1)
        self.get_call.assert_not_awaited()


class _nothing:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


# ═══════════════════════════════════════════════════════════════════════════
# The webhook rate limit
# ═══════════════════════════════════════════════════════════════════════════


class WHWebhookRateLimitTests(unittest.TestCase):
    SECRET = "dial-secret"
    EVENT = {"message": {"type": "transcript"}}

    def setUp(self):
        webhooks.reset_inbound_rate_limit()
        webhooks.limiter.reset()
        self.addCleanup(webhooks.reset_inbound_rate_limit)
        p = patch.object(settings, "vapi_webhook_secret", self.SECRET)
        p.start()
        self.addCleanup(p.stop)

    def post(self, headers):
        return H.client.post("/webhooks/vapi", json=self.EVENT, headers=headers).status_code

    def test_WH_requests_with_a_valid_credential_are_never_throttled_whichever_credential_they_carry(self):
        import hashlib
        import hmac
        import json
        for headers in ({"X-Vapi-Secret": self.SECRET}, {"Authorization": f"Bearer {self.SECRET}"}):
            with self.subTest(headers=list(headers)):
                self.assertEqual({self.post(headers) for _ in range(150)}, {200}, "150 reports a minute from one address")
        raw = json.dumps(self.EVENT).encode()
        sig = hmac.new(self.SECRET.encode(), raw, hashlib.sha256).hexdigest()
        codes = {H.client.post("/webhooks/vapi", content=raw, headers={"x-vapi-signature": sig, "content-type": "application/json"}).status_code
                 for _ in range(130)}
        self.assertEqual(codes, {200})

    def test_WH_unauthenticated_requests_stay_limited_to_120_a_minute_and_do_not_use_up_the_real_ones(self):
        bad = [self.post({"X-Vapi-Secret": "wrong"}) for _ in range(125)]
        self.assertEqual(set(bad[:120]), {401})
        self.assertEqual(set(bad[120:]), {429})
        self.assertEqual(self.post({}), 429, "no credential at all is limited too")
        self.assertEqual(self.post({"X-Vapi-Secret": self.SECRET}), 200, "a real report still gets through")

    def test_WH_a_real_end_of_call_report_is_processed_while_forged_ones_are_being_throttled(self):
        for _ in range(130):
            self.post({"X-Vapi-Secret": "wrong"})
        agent = make_agent(H.make_user("wh"))
        body = Q.end_of_call_body(agent["vapi_assistant_id"], f"call-{uuid.uuid4().hex[:8]}", "customer-ended-call", 30)
        r = H.client.post("/webhooks/vapi", json=body, headers={"X-Vapi-Secret": self.SECRET})
        self.assertEqual(r.status_code, 200, r.text)

    def test_WH_the_events_route_carries_no_blanket_limit(self):
        import main
        route = next(r for r in main.app.routes if getattr(r, "path", "") == "/webhooks/vapi")
        name = f"{route.endpoint.__module__}.{route.endpoint.__name__}"
        self.assertNotIn(name, webhooks.limiter._route_limits)

    def test_WH_with_no_secret_configured_every_request_is_still_counted(self):
        with patch.object(settings, "vapi_webhook_secret", ""):
            webhooks.reset_inbound_rate_limit()
            codes = [self.post({}) for _ in range(125)]
        self.assertEqual(set(codes[:120]), {200})
        self.assertEqual(set(codes[120:]), {429})


# ═══════════════════════════════════════════════════════════════════════════
# number_is_busy for the other call sources
# ═══════════════════════════════════════════════════════════════════════════

NOW = datetime(2026, 10, 5, 10, 0, tzinfo=UTC)                 # a Monday, inside the default callback window
BUSY_PHONE = "+15551230001"


class BUSYOtherSourcesTests(StrategyBase):
    def setUp(self):
        super().setUp()
        H.sql("DELETE FROM callbacks")
        self.addCleanup(lambda: H.sql("DELETE FROM callbacks"))
        # a number a campaign is calling right now
        supabase.table("contacts").insert({"user_id": self.user, "list_id": self.list["id"], "name": "Busy", "phone": BUSY_PHONE}).execute()
        self.c = self.campaign("sequential")
        self.start(self.c["id"])
        self.assertEqual(self.phones(self.c["id"]), [call_retry.phone_key(BUSY_PHONE)])
        self.calls_before = self.create_call.await_count

    def free_the_number(self):
        self.end(self.c["id"], at=T0 + 30 * SEC)
        supabase.table("outbound_campaigns").update({"status": "Paused", "dial_running": False}).eq("id", self.c["id"]).execute()

    def test_BUSY_number_is_busy_is_read_only_and_follows_the_open_attempt(self):
        self.assertTrue(call_retry.number_is_busy(self.user, BUSY_PHONE))
        self.assertTrue(call_retry.number_is_busy(self.user, "+1 (555) 123-0001"), "written another way")
        self.assertFalse(call_retry.number_is_busy(self.user, "+15559990000"))
        self.assertFalse(call_retry.number_is_busy(H.make_user("other"), BUSY_PHONE), "another account's call is not this account's")
        self.free_the_number()
        self.assertFalse(call_retry.number_is_busy(self.user, BUSY_PHONE))
        self.assertEqual(len(self.attempts(self.c["id"])), 1, "nothing was written")

    def test_BUSY_a_callback_to_a_number_on_a_campaign_call_waits_and_is_not_an_attempt(self):
        cbs.save_settings(self.user, {"auto_call": True})
        self.addCleanup(lambda: H.sql("DELETE FROM callback_settings WHERE user_id = %s", (self.user,)))
        cb = supabase.table("callbacks").insert({
            "user_id": self.user, "agent_id": self.agent["id"], "phone": BUSY_PHONE, "timezone": "UTC",
            "due_at": (NOW - 5 * MIN).strftime("%Y-%m-%dT%H:%M:%SZ")}).execute().data[0]
        res = asyncio.run(callback_scheduler.run_due_callbacks(NOW))
        self.assertEqual((res["deferred"], res["called"]), (1, 0))
        self.assertEqual(self.create_call.await_count, self.calls_before, "not dialed twice")
        row = supabase.table("callbacks").select("*").eq("id", cb["id"]).execute().data[0]
        self.assertEqual((row["status"], row["attempts"]), ("pending", 0))
        self.assertIn("another call", row["last_error"])
        self.assertEqual(t_of(row["due_at"]), NOW + callback_scheduler.BUSY_DEFER_MINUTES * MIN)
        # once the campaign call has ended the callback goes out
        self.free_the_number()
        res = asyncio.run(callback_scheduler.run_due_callbacks(NOW + 3 * MIN))
        self.assertEqual(res["called"], 1)
        self.assertEqual(self.create_call.await_count, self.calls_before + 1)

    def test_BUSY_an_automation_call_node_skips_a_number_on_a_campaign_call(self):
        asyncio.run(automation_engine._connect_call_agent(self.user, {"agent_id": self.agent["id"]}, {"phone": BUSY_PHONE}))
        self.assertEqual(self.create_call.await_count, self.calls_before, "skipped: it is on another call right now")
        self.free_the_number()
        asyncio.run(automation_engine._connect_call_agent(self.user, {"agent_id": self.agent["id"]}, {"phone": BUSY_PHONE}))
        self.assertEqual(self.create_call.await_count, self.calls_before + 1)

    def test_BUSY_a_single_call_to_a_number_on_a_campaign_call_is_refused_with_a_clear_message(self):
        body = {"phone_number": BUSY_PHONE, "agent_id": self.agent["id"]}
        r = self.api("post", "/telephony/call", json=body)
        self.assertEqual(r.status_code, 409, r.text)
        self.assertIn("another call", r.text)
        self.assertNotIn("vapi", r.text.lower())
        self.assertEqual(self.create_call.await_count, self.calls_before)
        self.free_the_number()
        r = self.api("post", "/telephony/call", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.create_call.await_count, self.calls_before + 1)

    def test_BUSY_these_calls_are_still_not_counted_toward_the_concurrency_caps_a_documented_residual_gap(self):
        self.set_cap(1)                                           # the campaign's one call fills the account's cap
        r = self.api("post", "/telephony/call", json={"phone_number": "+15559990001", "agent_id": self.agent["id"]})
        self.assertEqual(r.status_code, 200, "a single call to ANOTHER number still goes: single calls are not capped")


# ═══════════════════════════════════════════════════════════════════════════
# Health endpoint and wiring
# ═══════════════════════════════════════════════════════════════════════════


class HEALTHTests(StrategyBase):
    def headers(self):
        from jose import jwt
        now = int(datetime.now(UTC).timestamp())
        token = jwt.encode({"sub": "qa-admin", "adm": True, "iat": now, "exp": now + 3600}, settings.active_jwt_secret, algorithm="HS256")
        return {"X-Admin-Auth": token}

    def test_HEALTH_it_reports_stalled_campaigns_and_calls_open_for_over_ten_minutes(self):
        self.contacts(3)
        c = self.campaign("sequential")
        self.start(c["id"])
        H.sql("UPDATE public.campaign_attempts SET placed_at = %s WHERE campaign_id = %s", (T0 - 11 * MIN, c["id"]))
        supabase.table("outbound_campaigns").update({"dial_stall": "balance"}).eq("id", c["id"]).execute()
        r = H.client.get("/admin/dialer/health", headers=self.headers())
        self.assertEqual(r.status_code, 200, r.text)
        data = r.json()["data"]
        self.assertEqual(set(data), {"dispatcher_ok", "last_dispatch_seconds_ago", "stalled_campaigns", "open_attempts_older_than_10_min",
                                     "learned_cap", "loop_enabled"})
        self.assertIn(c["id"], [s["id"] for s in data["stalled_campaigns"]])
        self.assertGreaterEqual(data["open_attempts_older_than_10_min"], 1)
        self.assertEqual(H.client.get("/admin/dialer/health").status_code, 401, "admins only")


class WIREStartupTests(unittest.TestCase):
    def run_hook(self, **overrides):
        import main
        started = []

        async def fake_dispatcher():
            started.append("dispatcher")

        async def fake_reconciler():
            started.append("reconciler")

        async def go():
            with patch.object(dialer, "dispatcher_loop", fake_dispatcher), patch.object(dialer, "reconciler_loop", fake_reconciler), \
                    patch.object(dialer, "startup"):
                await main._start_dialer()
                for _ in range(3):
                    await asyncio.sleep(0)
        with patch.multiple(settings, **overrides):
            asyncio.run(go())
        return started

    def test_WIRE_the_startup_hook_starts_the_dispatcher_and_the_reconciler(self):
        self.assertEqual(sorted(self.run_hook(dialer_tick_seconds=2.0)), ["dispatcher", "reconciler"])

    def test_WIRE_the_kill_switch_turns_both_off(self):
        self.assertEqual(self.run_hook(dialer_tick_seconds=0.0), [])


if __name__ == "__main__":
    unittest.main()
