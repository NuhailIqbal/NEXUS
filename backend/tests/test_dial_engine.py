"""
The dialing engine end to end (services/dialer.py, routers/telephony.py Start / Pause / Resume / live): every
strategy, the redial queue, pause and calling hours per placement, the account cap, the provider's capacity
rejection, fail-closed bookkeeping and the claim. Real code, a frozen clock and a mocked call placer; calls
"end" through call_retry.finish_attempt at chosen instants. No sleeps and no real loops: a tick is
`dispatch_once(now, campaign_id=...)`.

This is the engine's own test file (stage B); the strategy-by-strategy acceptance suite builds on it.

Run from the backend folder:  python -m unittest discover -s tests -p "test_dial_engine.py" -v
"""
import asyncio
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import httpx

import byot_harness as H
from database import supabase
from routers import telephony
from services import call_hours, call_retry, campaign_scheduler, dial_limits, dialer, vapi_client

from test_timezones import FakeDateTime, ZoneBase, local

UTC = timezone.utc
T0 = datetime(2026, 10, 14, 12, 0, tzinfo=UTC)          # a Wednesday, noon UTC
SEC = timedelta(seconds=1)
MIN = timedelta(minutes=1)
ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]


class DialBase(ZoneBase):
    """One account (funded wallet), one agent and number, one list. The clock is frozen at T0 in every module the
    engine reads it in."""

    def setUp(self):
        super().setUp()
        for target in (dialer, call_retry, campaign_scheduler):
            p = patch.object(target, "datetime", FakeDateTime)
            p.start()
            self.addCleanup(p.stop)
        # a clean slate: other tests' leftovers must not be dispatched or counted
        H.sql("UPDATE public.outbound_campaigns SET dial_running = false, dial_stall = NULL, dial_next_at = NULL, "
              "run_token = NULL, run_heartbeat_at = NULL, stopped_by_hours_at = NULL")
        H.sql("DELETE FROM public.campaign_leads")
        self.addCleanup(lambda: H.sql("DELETE FROM public.campaign_leads"))
        self.addCleanup(lambda: H.sql("UPDATE public.outbound_campaigns SET dial_running = false, run_token = NULL, "
                                      "stopped_by_hours_at = NULL"))
        supabase.table("contacts").delete().eq("list_id", self.list["id"]).execute()
        self.next_phone = 0
        self.at(T0)
        self.by_phone: dict[str, list[str]] = {}
        inner = self.create_call.side_effect

        async def recording(payload):
            out = await inner(payload)
            self.by_phone.setdefault(payload["customer"]["number"], []).append(out["id"])
            return out
        self.create_call.side_effect = recording

    # ── building blocks ──
    def contacts(self, n, list_id=None):
        """n new contacts at the end of the list (their seq follows the order they are inserted in)."""
        out = []
        for _ in range(n):
            self.next_phone += 1
            out += supabase.table("contacts").insert(
                {"user_id": self.user, "list_id": list_id or self.list["id"], "name": f"P{self.next_phone}",
                 "phone": f"+1555777{self.next_phone:04d}"}).execute().data
        return out

    def campaign(self, strategy="sequential", **extra):
        body = {"name": "Dial", "agent_id": self.agent["id"], "list_id": self.list["id"], "phone_number_id": self.out_number["id"],
                "dnc_screening_enabled": False, "dial_strategy": strategy, **extra}
        r = self.api("post", "/telephony/campaigns", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["data"]

    def start(self, cid, expect=200):
        r = self.api("post", f"/telephony/campaigns/{cid}/start")
        self.assertEqual(r.status_code, expect, r.text)
        return r.json()["data"] if expect == 200 else r.json()

    def row(self, cid):
        return supabase.table("outbound_campaigns").select("*").eq("id", cid).execute().data[0]

    def tick(self, cid, instant=None, **kw):
        """One dispatch of the campaign at `instant` (default: now on the frozen clock)."""
        if instant is not None:
            self.at(instant)
        res = asyncio.run(dialer.dispatch_once(instant or FakeDateTime.instant, campaign_id=cid, wait=True, **kw))
        return res["results"].get(cid)

    def attempts(self, cid):
        return sorted(supabase.table("campaign_attempts").select("*").eq("campaign_id", cid).execute().data,
                      key=lambda a: (a["placed_at"], a["dial_slot"] or 0))

    def open_attempts(self, cid):
        return [a for a in self.attempts(cid) if a["ended_at"] is None]

    def active(self, cid):
        return len(self.open_attempts(cid))

    def end(self, cid, n=None, at=None, outcome="answered", reason="customer-ended-call"):
        """The oldest `n` open calls of the campaign end (all of them when n is None)."""
        at = at or FakeDateTime.instant
        closed = 0
        for a in self.open_attempts(cid)[:n]:
            if call_retry.finish_attempt(a, outcome, reason, at):
                closed += 1
        return closed

    def phones(self, cid):
        """The numbers called, in the order the calls were placed."""
        return [a["phone_key"] for a in self.attempts(cid)]

    def keys(self, contacts):
        return [call_retry.phone_key(c["phone"]) for c in contacts]


class SequentialTests(DialBase):
    def test_one_call_at_a_time_and_the_next_only_after_it_ends(self):
        cs = self.contacts(4)
        c = self.campaign("sequential")
        d = self.start(c["id"])
        self.assertEqual((d["dialed"], d["active_now"], d["strategy"], d["queued"]), (1, 1, "sequential", 3))
        self.assertEqual(self.row(c["id"])["dial_running"], True)
        peak = 1
        for i in range(1, 4):
            self.tick(c["id"], T0 + i * 10 * SEC)                       # a tick with a call open places nothing
            self.assertEqual(self.active(c["id"]), 1)
            self.end(c["id"], at=T0 + i * 10 * SEC)
            self.tick(c["id"], T0 + i * 10 * SEC)
            peak = max(peak, self.active(c["id"]))
        self.assertEqual(peak, 1)
        self.assertEqual(self.phones(c["id"]), self.keys(cs), "in upload order, once each")
        self.assertEqual({a["dial_slot"] for a in self.attempts(c["id"])}, {1})
        self.assertEqual({a["dial_strategy"] for a in self.attempts(c["id"])}, {"sequential"})
        self.assertEqual({a["dial_source"] for a in self.attempts(c["id"])}, {"fresh"})
        # the last call ends: the pass is over, the campaign stays Active
        self.end(c["id"])
        self.tick(c["id"], T0 + MIN)
        row = self.row(c["id"])
        self.assertEqual((row["dial_running"], row["status"], row["dial_seq"], row["dial_cursor"]), (False, "Active", None, None))

    def test_the_delay_is_the_gap_after_the_previous_call_ends(self):
        self.contacts(3)
        c = self.campaign("sequential", dial_delay_seconds=10)
        self.start(c["id"])
        end_at = T0 + 30 * SEC
        self.end(c["id"], at=end_at)
        self.at(end_at + 9 * SEC)
        res = asyncio.run(dialer.dispatch_once(end_at + 9 * SEC, campaign_id=c["id"], wait=True))
        self.assertEqual(len(self.attempts(c["id"])), 1, "9 s after the end: nothing")
        self.assertEqual(res["wake"], end_at + 10 * SEC, "the loop is told when to look again")
        res = asyncio.run(dialer.tick(c["id"], end_at + 9 * SEC))
        self.assertEqual(res.stopped, "spacing")
        self.assertEqual(call_retry.parse_time(self.row(c["id"])["dial_next_at"]), end_at + 10 * SEC, "a wake hint is stored")
        self.tick(c["id"], end_at + 10 * SEC)
        self.assertEqual(len(self.attempts(c["id"])), 2, "10 s after the end: the next call")

    def test_a_second_start_changes_nothing(self):
        self.contacts(3)
        c = self.campaign("sequential")
        self.start(c["id"])
        d = self.start(c["id"])
        self.assertEqual((d["already_running"], d["started"]), (True, False))
        self.assertEqual(len(self.attempts(c["id"])), 1)
        self.assertEqual(self.create_call.await_count, 1)

    def test_a_finished_campaign_started_again_dials_the_whole_list_again(self):
        cs = self.contacts(2)
        c = self.campaign("sequential")
        self.start(c["id"])
        for i in range(1, 4):
            self.end(c["id"], at=T0 + i * SEC)
            self.tick(c["id"], T0 + i * SEC)
        self.end(c["id"], at=T0 + 5 * SEC)
        self.tick(c["id"], T0 + 6 * SEC)
        self.assertEqual(self.row(c["id"])["dial_running"], False)
        self.at(T0 + MIN)
        d = self.start(c["id"])
        self.assertEqual((d["resumed"], d["dialed"]), (False, 1))
        self.assertEqual(self.phones(c["id"])[-1], self.keys(cs)[0], "a new pass starts at the top")


class ConcurrentTests(DialBase):
    def test_fills_n_then_refills_exactly_what_ended(self):
        cs = self.contacts(12)
        c = self.campaign("concurrent", dial_concurrent_calls=5)
        d = self.start(c["id"])
        self.assertEqual((d["dialed"], d["active_now"], d["queued"]), (5, 5, 7))
        first = self.attempts(c["id"])
        self.assertEqual(sorted(a["dial_slot"] for a in first), [1, 2, 3, 4, 5], "lowest free slots")
        self.assertEqual({a["dial_batch"] for a in first}, {1}, "the first group is wave 1")
        self.assertEqual(self.phones(c["id"]), self.keys(cs[:5]))
        # two end: one tick places exactly two, in the freed slots
        freed = sorted(a["dial_slot"] for a in first[:2])
        self.end(c["id"], 2, at=T0 + 10 * SEC)
        self.tick(c["id"], T0 + 10 * SEC)
        self.assertEqual(self.active(c["id"]), 5)
        new = [a for a in self.attempts(c["id"]) if call_retry.parse_time(a["placed_at"]) >= T0 + 10 * SEC]
        self.assertEqual(sorted(a["dial_slot"] for a in new), freed, "the freed slots are reused")
        self.assertEqual(len(self.attempts(c["id"])), 7)
        self.assertGreater(min(a["dial_batch"] for a in new), 1, "a later wave")

    def test_it_keeps_n_active_while_numbers_remain_and_drains_at_the_end(self):
        cs = self.contacts(9)
        c = self.campaign("concurrent", dial_concurrent_calls=3)
        self.start(c["id"])
        peak, t = 3, T0
        for step in range(1, 30):
            t = T0 + step * 10 * SEC
            self.end(c["id"], 1, at=t)
            self.tick(c["id"], t)
            peak = max(peak, self.active(c["id"]))
            self.assertLessEqual(self.active(c["id"]), 3)
            if self.row(c["id"])["dial_running"] is False and self.active(c["id"]) == 0:
                break
        self.assertEqual(peak, 3)
        self.assertEqual(self.phones(c["id"]), self.keys(cs))
        row = self.row(c["id"])
        self.assertEqual((row["dial_running"], row["status"]), (False, "Active"))

    def test_suppressed_and_busy_numbers_refill_at_once(self):
        cs = self.contacts(8)
        c = self.campaign("concurrent", dial_concurrent_calls=3, dnc_screening_enabled=True)
        bad = {call_retry.phone_key(cs[1]["phone"]), call_retry.phone_key(cs[2]["phone"])}

        async def check(user_id, phone, cached=None):
            suppressed = call_retry.phone_key(phone) in bad
            return {"allowed": not suppressed, "reason": "DNC" if suppressed else None, "source": "api", "suppressed": suppressed}
        with patch("services.whitelist_service.check_number", AsyncMock(side_effect=check)):
            d = self.start(c["id"])
        self.assertEqual((d["dialed"], d["suppressed"], d["active_now"]), (3, 2, 3), "two skipped, and still 3 on the line")
        self.assertEqual(self.phones(c["id"]), self.keys([cs[0], cs[3], cs[4]]))

    def test_a_delay_places_one_call_per_gap(self):
        self.contacts(6)
        c = self.campaign("concurrent", dial_concurrent_calls=5, dial_delay_seconds=3)
        d = self.start(c["id"])
        self.assertEqual(d["dialed"], 1, "the ramp honours the gap too")
        self.tick(c["id"], T0 + 2 * SEC)
        self.assertEqual(self.active(c["id"]), 1)
        self.tick(c["id"], T0 + 3 * SEC)
        self.assertEqual(self.active(c["id"]), 2)
        self.tick(c["id"], T0 + 6 * SEC)
        self.assertEqual(self.active(c["id"]), 3)

    def test_lowering_n_drains_and_raising_n_fills(self):
        self.contacts(10)
        c = self.campaign("concurrent", dial_concurrent_calls=5)
        self.start(c["id"])
        self.assertEqual(self.api("patch", f"/telephony/campaigns/{c['id']}", json={"dial_concurrent_calls": 2}).status_code, 200)
        self.end(c["id"], 2, at=T0 + 5 * SEC)
        self.tick(c["id"], T0 + 5 * SEC)
        self.assertEqual(self.active(c["id"]), 3, "still above 2: nothing new is placed")
        self.end(c["id"], 1, at=T0 + 6 * SEC)
        self.tick(c["id"], T0 + 6 * SEC)
        self.assertEqual(self.active(c["id"]), 2, "down to 2, so nothing new either")
        self.api("patch", f"/telephony/campaigns/{c['id']}", json={"dial_concurrent_calls": 4})
        self.tick(c["id"], T0 + 7 * SEC)
        self.assertEqual(self.active(c["id"]), 4)

    def test_sequential_to_concurrent_places_the_rest_and_keeps_snapshots(self):
        self.contacts(6)
        c = self.campaign("sequential")
        self.start(c["id"])
        self.api("patch", f"/telephony/campaigns/{c['id']}", json={"dial_strategy": "concurrent", "dial_concurrent_calls": 3})
        self.tick(c["id"], T0 + SEC)
        self.assertEqual(self.active(c["id"]), 3)
        snaps = [a["settings"]["dial"]["strategy"] for a in self.attempts(c["id"])]
        self.assertEqual(snaps, ["sequential", "concurrent", "concurrent"], "each call keeps the settings it was placed under")


class PacedTests(DialBase):
    def test_ten_per_minute_is_six_seconds_apart(self):
        self.contacts(30)
        c = self.campaign("paced", dial_calls_per_minute=10)
        self.start(c["id"])
        for s in range(1, 61):
            self.tick(c["id"], T0 + s * SEC)
        times = [call_retry.parse_time(a["placed_at"]) for a in self.attempts(c["id"])]
        self.assertEqual(len(times), 11, "t = 0, 6, ... 60")
        self.assertEqual({(b - a).total_seconds() for a, b in zip(times, times[1:])}, {6.0})
        self.assertEqual({a["dial_slot"] for a in self.attempts(c["id"])}, {None})
        self.assertEqual({a["dial_strategy"] for a in self.attempts(c["id"])}, {"paced"})
        self.assertEqual(len({a["dial_batch"] for a in self.attempts(c["id"])}), 2, "the minute window is the batch")

    def test_a_long_pause_does_not_cause_a_burst(self):
        self.contacts(30)
        c = self.campaign("paced", dial_calls_per_minute=10)
        self.start(c["id"])
        before = len(self.attempts(c["id"]))
        self.api("post", f"/telephony/campaigns/{c['id']}/pause")
        self.api("post", f"/telephony/campaigns/{c['id']}/resume")
        self.tick(c["id"], T0 + 10 * MIN)
        self.assertEqual(len(self.attempts(c["id"])), before + 1, "exactly one call after ten idle minutes")
        self.tick(c["id"], T0 + 10 * MIN + 5 * SEC)
        self.assertEqual(len(self.attempts(c["id"])), before + 1)
        self.tick(c["id"], T0 + 10 * MIN + 6 * SEC)
        self.assertEqual(len(self.attempts(c["id"])), before + 2)

    def test_a_delay_longer_than_the_rate_wins(self):
        self.contacts(10)
        c = self.campaign("paced", dial_calls_per_minute=10, dial_delay_seconds=20)
        self.start(c["id"])
        for s in range(1, 61):
            self.tick(c["id"], T0 + s * SEC)
        self.assertEqual(len(self.attempts(c["id"])), 4, "calls at 0, 20, 40, 60: three a minute")


class QueueTests(DialBase):
    def test_a_duplicate_number_is_called_once_per_pass(self):
        cs = self.contacts(3)
        supabase.table("contacts").insert({"user_id": self.user, "list_id": self.list["id"], "name": "again", "phone": cs[0]["phone"]}).execute()
        c = self.campaign("concurrent", dial_concurrent_calls=5)
        d = self.start(c["id"])
        self.assertEqual((d["dialed"], d["already_on_call"]), (3, 1))
        self.assertEqual(sorted(self.phones(c["id"])), sorted(self.keys(cs)))
        self.assertEqual(self.row(c["id"])["dial_running"], False, "the pass is over")

    def test_a_duplicate_is_skipped_even_after_its_first_call_ended(self):
        cs = self.contacts(2)
        extra = supabase.table("contacts").insert({"user_id": self.user, "list_id": self.list["id"], "name": "again", "phone": cs[0]["phone"]}).execute().data
        c = self.campaign("sequential")
        self.start(c["id"])
        for i in range(1, 8):
            self.end(c["id"], at=T0 + i * SEC)
            self.tick(c["id"], T0 + i * SEC)
        self.assertEqual(sorted(self.phones(c["id"])), sorted(self.keys(cs)), "the repeat of the first number is not called")

    def test_the_cursor_and_seq_move_together(self):
        cs = self.contacts(5)
        c = self.campaign("concurrent", dial_concurrent_calls=2)
        self.start(c["id"])
        row = self.row(c["id"])
        self.assertEqual(row["dial_cursor"], cs[1]["id"])
        self.assertEqual(row["dial_seq"], supabase.table("contacts").select("seq").eq("id", cs[1]["id"]).execute().data[0]["seq"])

    def test_contacts_appended_mid_pass_are_dialed(self):
        cs = self.contacts(2)
        c = self.campaign("concurrent", dial_concurrent_calls=1)
        self.start(c["id"])
        late = self.contacts(1)
        for i in range(1, 6):
            self.end(c["id"], at=T0 + i * SEC)
            self.tick(c["id"], T0 + i * SEC)
        self.assertEqual(self.phones(c["id"]), self.keys(cs + late))

    def test_a_due_redial_goes_before_a_fresh_number_and_shares_the_slots(self):
        cs = self.contacts(4)
        c = self.campaign("concurrent", dial_concurrent_calls=2, retry_enabled=True, retry_max_attempts=3, retry_interval_minutes=10)
        self.start(c["id"])                                    # P1, P2 on the line
        self.end(c["id"], 2, at=T0 + 20 * SEC, outcome="no_answer", reason="customer-did-not-answer")
        self.tick(c["id"], T0 + 21 * SEC)                      # P3, P4 are fresh and go first (the redials are not due)
        self.end(c["id"], 2, at=T0 + 30 * SEC)
        self.tick(c["id"], T0 + 31 * SEC)
        self.assertEqual(self.row(c["id"])["dial_running"], False)
        # ten minutes after P1 / P2 ended, their redials are due
        later = T0 + 20 * SEC + 10 * MIN
        res = self.tick(c["id"], later)
        self.assertEqual(res.redials_placed, 2)
        redials = [a for a in self.attempts(c["id"]) if a["dial_source"] == "redial"]
        self.assertEqual(sorted(a["phone_key"] for a in redials), sorted(self.keys(cs[:2])))
        self.assertEqual(sorted(a["dial_slot"] for a in redials), [1, 2], "a redial takes a slot like any call")
        self.assertEqual({a["attempt_number"] for a in redials}, {2})

    def test_with_room_for_one_the_due_redial_beats_the_next_fresh_number(self):
        cs = self.contacts(3)
        c = self.campaign("sequential", retry_enabled=True, retry_max_attempts=3, retry_interval_minutes=5)
        self.start(c["id"])                                                         # P1 is on the line
        self.end(c["id"], at=T0 + SEC, outcome="no_answer", reason="customer-did-not-answer")
        res = self.tick(c["id"], T0 + 10 * MIN)                                     # P1's redial is due AND P2 is next in the list
        self.assertEqual((res.redials_placed, res.placed), (1, 0))
        a = self.attempts(c["id"])
        self.assertEqual([(x["phone_key"], x["dial_source"]) for x in a],
                         [(call_retry.phone_key(cs[0]["phone"]), "fresh"), (call_retry.phone_key(cs[0]["phone"]), "redial")])
        self.end(c["id"], at=T0 + 11 * MIN)
        self.tick(c["id"], T0 + 11 * MIN)
        self.assertEqual(self.attempts(c["id"])[-1]["phone_key"], call_retry.phone_key(cs[1]["phone"]), "then the list goes on")

    def test_a_redial_waits_for_a_sequential_campaign_with_a_call_open(self):
        cs = self.contacts(2)
        c = self.campaign("sequential", retry_enabled=True, retry_max_attempts=3, retry_interval_minutes=10)
        self.start(c["id"])
        self.end(c["id"], at=T0 + 5 * SEC, outcome="no_answer", reason="customer-did-not-answer")
        self.tick(c["id"], T0 + 6 * SEC)                       # P2 is on the line now
        res = self.tick(c["id"], T0 + 11 * MIN)                # P1's redial is due but the single line is taken
        self.assertIsNone(res, "nothing to serve: the campaign has no room")
        self.assertEqual(self.active(c["id"]), 1)
        self.end(c["id"], at=T0 + 12 * MIN)
        res = self.tick(c["id"], T0 + 12 * MIN)
        self.assertEqual((res.redials_placed, res.placed), (1, 0))

    def test_a_redial_that_cannot_be_screened_is_tried_once_per_tick_and_stays_due(self):
        self.contacts(1)
        c = self.campaign("sequential", dnc_screening_enabled=True, retry_enabled=True, retry_interval_minutes=5)
        ok = AsyncMock(return_value={"allowed": True, "reason": None, "source": "api", "suppressed": False})
        with patch("services.whitelist_service.check_number", ok):
            self.start(c["id"])
        self.end(c["id"], at=T0 + SEC, outcome="no_answer", reason="customer-did-not-answer")
        for extra in ({"unavailable": True}, {}):          # a provider outage, then a number that cannot be read
            down = AsyncMock(return_value={"allowed": False, "reason": "cannot screen", "source": "api", "suppressed": False, **extra})
            with patch("services.whitelist_service.check_number", down):
                res = self.tick(c["id"], T0 + 10 * MIN)
            self.assertEqual(down.await_count, 1, "tried once, not in a loop")
            self.assertEqual(res.redials["waiting"], 1)
            lead = supabase.table("campaign_leads").select("*").eq("campaign_id", c["id"]).execute().data[0]
            self.assertIsNone(lead["final_status"], "the redial is still due")
            H.sql("UPDATE public.outbound_campaigns SET dial_next_at = NULL, dial_stall = NULL WHERE id = %s", (c["id"],))

    def test_retry_off_settles_waiting_redials_without_a_call(self):
        self.contacts(1)
        c = self.campaign("sequential", retry_enabled=True)
        self.start(c["id"])
        self.end(c["id"], at=T0 + 5 * SEC, outcome="no_answer", reason="customer-did-not-answer")
        lead = supabase.table("campaign_leads").select("*").eq("campaign_id", c["id"]).execute().data[0]
        self.assertIsNotNone(lead["next_attempt_at"])
        supabase.table("outbound_campaigns").update({"retry_enabled": False}).eq("id", c["id"]).execute()
        res = asyncio.run(campaign_scheduler.run_retries(T0 + 11 * MIN))
        self.assertEqual(res["cancelled"], 1)
        self.assertEqual(len(self.attempts(c["id"])), 1)


class PauseAndHoursTests(DialBase):
    def pause_after(self, cid, calls):
        """The campaign is paused (by a person) once `calls` calls have been placed."""
        inner = self.create_call.side_effect
        seen = {"n": 0}

        async def placing(payload):
            out = await inner(payload)
            seen["n"] += 1
            if seen["n"] == calls:
                self.api("post", f"/telephony/campaigns/{cid}/pause")
            return out
        self.create_call.side_effect = placing

    def test_pause_bites_on_the_next_placement_not_the_next_batch(self):
        cs = self.contacts(10)
        c = self.campaign("concurrent", dial_concurrent_calls=8)
        self.pause_after(c["id"], 3)
        d = self.start(c["id"])
        self.assertEqual(d["dialed"], 3, "5 more were in the same group and did not go out")
        self.assertTrue(d["stopped_by_person"])
        row = self.row(c["id"])
        self.assertEqual((row["status"], row["dial_running"]), ("Paused", True), "the pass stays open")
        self.assertEqual(row["dial_cursor"], cs[2]["id"], "the place is right after the last call placed")
        self.assertEqual(self.tick(c["id"], T0 + SEC), None, "a paused campaign is not served")
        # the open calls settle normally while paused
        self.assertEqual(self.end(c["id"], at=T0 + 2 * SEC), 3)

    def test_resume_carries_on_from_the_place_and_calls_nobody_twice(self):
        cs = self.contacts(10)
        c = self.campaign("concurrent", dial_concurrent_calls=4)
        self.pause_after(c["id"], 2)
        self.start(c["id"])
        self.create_call.side_effect = self.create_call.side_effect       # (still pausing once only)
        r = self.api("post", f"/telephony/campaigns/{c['id']}/resume")
        self.assertEqual(r.status_code, 200, r.text)
        data = r.json()["data"]
        self.assertEqual((data["resumed"], data["dialed"]), (True, 2), "4 at once: 2 were open, 2 more now")
        self.assertEqual(self.phones(c["id"]), self.keys(cs[:4]), "in order, nobody twice")

    def test_resume_of_a_campaign_with_no_open_pass_only_flips_the_status(self):
        c = self.campaign("sequential")
        r = self.api("post", f"/telephony/campaigns/{c['id']}/resume")
        self.assertEqual(r.json(), {"data": {"status": "Active"}, "error": None})
        self.assertEqual(self.create_call.await_count, 0)

    def test_hours_that_close_stop_the_next_call_and_park_the_campaign(self):
        zone = "Asia/Karachi"
        cs = self.contacts(6)
        c = self.campaign("concurrent", dial_concurrent_calls=6, call_hours_enabled=True, call_hours_timezone=zone,
                          call_hours_days=ALL_DAYS, call_hours_start="09:00", call_hours_end="18:00")
        y, m, d_ = 2026, 10, 14
        self.at(local(zone, y, m, d_, 9))
        inner = self.create_call.side_effect
        seen = {"n": 0}

        async def closing(payload):
            out = await inner(payload)
            seen["n"] += 1
            if seen["n"] == 2:
                self.at(local(zone, y, m, d_, 18))
            return out
        self.create_call.side_effect = closing
        d = self.start(c["id"])
        self.assertEqual(d["dialed"], 2)
        self.assertEqual((d["stopped_by_hours"], d["remaining"]), (True, 4))
        row = self.row(c["id"])
        self.assertEqual((row["status"], row["dial_running"]), ("Paused", True))
        self.assertIsNotNone(row["stopped_by_hours_at"])
        self.assertEqual(row["dial_cursor"], cs[1]["id"])
        # next morning the sweep carries on from the third number
        self.create_call.side_effect = inner
        self.end(c["id"], at=local(zone, y, m, d_, 18))
        res = asyncio.run(campaign_scheduler.run_auto_resumes(local(zone, y, m, d_ + 1, 9)))
        self.assertEqual(res["resumed"], 0, "the clock is still the frozen evening one: closed")
        self.at(local(zone, y, m, d_ + 1, 9))
        res = asyncio.run(campaign_scheduler.run_auto_resumes(local(zone, y, m, d_ + 1, 9)))
        self.assertEqual(res, {"resumed": 1, "waiting": 0, "refused": 0})
        self.assertEqual(self.phones(c["id"]), self.keys(cs), "the rest, in order, nobody twice")

    def test_hours_that_close_before_the_first_call_leave_the_campaign_as_it_was(self):
        self.contacts(3)
        c = self.campaign("sequential", call_hours_enabled=True, call_hours_timezone="UTC", call_hours_days=ALL_DAYS,
                          call_hours_start="09:00", call_hours_end="18:00")
        self.at(local("UTC", 2026, 10, 14, 10))
        real = call_hours.is_open
        calls = {"n": 0}

        def closes_after_the_start_check(*a, **kw):
            calls["n"] += 1
            return True if calls["n"] == 1 else False
        with patch.object(call_hours, "is_open", side_effect=closes_after_the_start_check):
            d = self.start(c["id"])
        self.assertEqual((d["dialed"], d["stopped_by_hours"]), (0, True))
        row = self.row(c["id"])
        self.assertEqual((row["status"], row["dial_running"], row["stopped_by_hours_at"]), ("Inactive", False, None))
        self.assertEqual(len(self.attempts(c["id"])), 0)

    def test_already_running_auto_resume_sends_no_notification(self):
        self.contacts(3)
        c = self.campaign("sequential", call_hours_enabled=True, call_hours_timezone="UTC", call_hours_days=ALL_DAYS,
                          call_hours_start="09:00", call_hours_end="18:00")
        self.at(local("UTC", 2026, 10, 14, 10))
        supabase.table("outbound_campaigns").update({"status": "Paused", "dial_running": True, "dial_seq": 1,
                                                     "stopped_by_hours_at": call_retry.iso(T0)}).eq("id", c["id"]).execute()
        real = telephony.start_campaign

        async def already(*a, **kw):
            return {"data": {"already_running": True}, "error": None}
        before = len(supabase.table("notifications").select("id").eq("user_id", self.user).execute().data)
        with patch.object(telephony, "start_campaign", already):
            res = asyncio.run(campaign_scheduler.run_auto_resumes(local("UTC", 2026, 10, 14, 10)))
        self.assertEqual(res, {"resumed": 0, "waiting": 1, "refused": 0})
        self.assertEqual(len(supabase.table("notifications").select("id").eq("user_id", self.user).execute().data), before)


class LimitTests(DialBase):
    def set_cap(self, n):
        telephony.get_or_create_billing(self.user)
        supabase.table("billing").update({"max_concurrent_calls": n}).eq("user_id", self.user).execute()

    def test_an_account_cap_bounds_the_active_calls_and_is_reported(self):
        self.contacts(10)
        self.set_cap(3)
        r = self.api("post", "/telephony/campaigns", json={
            "name": "Cap", "agent_id": self.agent["id"], "list_id": self.list["id"], "phone_number_id": self.out_number["id"],
            "dnc_screening_enabled": False, "dial_strategy": "concurrent", "dial_concurrent_calls": 5})
        self.assertEqual(len(r.json()["warnings"]), 1)
        c = r.json()["data"]
        d = self.start(c["id"])
        self.assertEqual((d["dialed"], d["active_now"]), (3, 3))
        self.assertEqual(d["capped"], {"requested": 5, "effective": 3, "reason": "account"})
        got = self.api("get", f"/telephony/campaigns/{c['id']}").json()["data"]["dialing"]
        self.assertTrue(got["effective"]["capped"])
        self.set_cap(5)
        self.tick(c["id"], T0 + SEC)
        self.assertEqual(self.active(c["id"]), 5, "raising the cap applies on the next tick")

    def test_two_campaigns_of_one_account_share_the_cap(self):
        self.contacts(10)
        other_list = supabase.table("lists").insert({"user_id": self.user, "name": "Other"}).execute().data[0]
        self.contacts(10, other_list["id"])
        self.set_cap(4)
        a = self.campaign("concurrent", dial_concurrent_calls=4)
        b = self.campaign("concurrent", dial_concurrent_calls=4, list_id=other_list["id"])
        supabase.table("outbound_campaigns").update({"status": "Active", "dial_running": True, "dial_pass_started_at": call_retry.iso(T0)}) \
            .in_("id", [a["id"], b["id"]]).execute()
        res = asyncio.run(dialer.dispatch_once(T0, wait=True))
        self.assertLessEqual(len(self.open_attempts(a["id"])) + len(self.open_attempts(b["id"])), 4)
        self.assertEqual(len(self.open_attempts(a["id"])) + len(self.open_attempts(b["id"])), 4)

    def test_the_platform_cap_bounds_too(self):
        self.contacts(10)
        supabase.table("platform_settings").update({"dial_platform_max": 2}).eq("id", 1).execute()
        self.addCleanup(lambda: supabase.table("platform_settings").update({"dial_platform_max": None}).eq("id", 1).execute())
        c = self.campaign("concurrent", dial_concurrent_calls=5)
        d = self.start(c["id"])
        self.assertEqual(d["active_now"], 2)

    def test_dialing_limits_endpoint(self):
        self.set_cap(3)
        got = self.api("get", "/telephony/dialing/limits").json()["data"]
        self.assertEqual((got["account_limit"], got["source"], got["max_concurrent_calls"], got["max_calls_per_minute"], got["max_delay_seconds"]),
                         (3, "account", 20, 60, 60))


class ProviderTests(DialBase):
    def test_a_capacity_rejection_takes_the_attempt_back_and_backs_off(self):
        cs = self.contacts(5)
        c = self.campaign("concurrent", dial_concurrent_calls=5, retry_enabled=True)
        inner = self.create_call.side_effect
        state = {"n": 0}

        async def full(payload):
            state["n"] += 1
            if state["n"] > 2:
                raise vapi_client.VapiAPIError("429 Too Many Requests", 429, "concurrency limit")
            return await inner(payload)
        self.create_call.side_effect = full
        d = self.start(c["id"])
        self.assertEqual((d["dialed"], d["errors"], d["active_now"]), (2, 0, 2), "a refusal is not an error")
        self.assertEqual(len(self.attempts(c["id"])), 2, "the refused attempts are gone")
        self.assertEqual(self.phones(c["id"]), self.keys(cs[:2]))
        row = self.row(c["id"])
        self.assertEqual(row["dial_stall"], "provider_limit")
        self.assertEqual(call_retry.parse_time(row["dial_next_at"]), T0 + 30 * SEC)
        self.assertEqual(row["dial_cursor"], cs[1]["id"], "the refused numbers were not passed over")
        learned = supabase.table("platform_settings").select("dial_learned_cap, dial_learned_until").eq("id", 1).execute().data[0]
        self.assertEqual(learned["dial_learned_cap"], 2)
        self.addCleanup(lambda: supabase.table("platform_settings").update({"dial_learned_cap": None, "dial_learned_until": None}).eq("id", 1).execute())
        leads = supabase.table("campaign_leads").select("*").eq("campaign_id", c["id"]).execute().data
        self.assertEqual(sorted(l["phone"] for l in leads), sorted(x["phone"] for x in cs[:2]), "no lead is left for a refused number")
        # nothing before the back-off is over; then the numbers go out
        self.create_call.side_effect = inner
        self.assertIsNone(self.tick(c["id"], T0 + 29 * SEC))
        self.addCleanup(lambda: H.sql("UPDATE public.platform_settings SET dial_learned_cap = NULL, dial_learned_until = NULL"))
        H.sql("UPDATE public.platform_settings SET dial_learned_cap = NULL, dial_learned_until = NULL")
        self.tick(c["id"], T0 + 30 * SEC)
        self.assertEqual(self.active(c["id"]), 5)
        self.assertIsNone(self.row(c["id"])["dial_stall"])

    def test_a_timeout_leaves_the_attempt_open_until_the_reaper_closes_it(self):
        cs = self.contacts(2)
        c = self.campaign("sequential")
        inner = self.create_call.side_effect

        async def slow(payload):
            raise httpx.ReadTimeout("no answer")
        self.create_call.side_effect = slow
        d = self.start(c["id"])
        self.assertEqual(d["dialed"], 0)
        a = self.attempts(c["id"])
        self.assertEqual((len(a), a[0]["ended_at"], a[0]["vapi_call_id"]), (1, None, None), "open: the call may be on the line")
        self.assertEqual(self.row(c["id"])["dial_cursor"], cs[0]["id"], "the number is not called again")
        self.create_call.side_effect = inner
        self.tick(c["id"], T0 + 60 * SEC)
        self.assertEqual(len(self.attempts(c["id"])), 1, "the single line is still taken")
        self.assertEqual(call_retry.reap_unplaced(T0 + 119 * SEC, 120), 0)
        self.assertEqual(call_retry.reap_unplaced(T0 + 121 * SEC, 120), 1)
        self.assertEqual(self.attempts(c["id"])[0]["outcome"], "failed")
        self.tick(c["id"], T0 + 122 * SEC)
        self.assertEqual(len(self.attempts(c["id"])), 2, "the line is free again")

    def test_a_provider_error_is_a_failed_attempt(self):
        self.contacts(2)
        c = self.campaign("concurrent", dial_concurrent_calls=2)

        async def bad(payload):
            raise vapi_client.VapiAPIError("400 Bad Request - bad assistant", 400, "bad assistant")
        self.create_call.side_effect = bad
        d = self.start(c["id"])
        self.assertEqual((d["dialed"], d["errors"]), (0, 2))
        self.assertIn("bad assistant", d["error_details"][0]["error"])
        self.assertEqual({a["outcome"] for a in self.attempts(c["id"])}, {"failed"})

    def test_five_failures_in_a_row_park_the_campaign(self):
        self.contacts(8)
        c = self.campaign("concurrent", dial_concurrent_calls=8)

        async def bad(payload):
            raise vapi_client.VapiAPIError("401 Unauthorized - bad key", 401, "bad key")
        self.create_call.side_effect = bad
        d = self.start(c["id"])
        row = self.row(c["id"])
        self.assertEqual((row["status"], row["dial_stall"]), ("Paused", "provider_error"))
        notes = supabase.table("notifications").select("*").eq("user_id", self.user).eq("kind", "campaign_stalled").execute().data
        self.assertEqual(len(notes), 1)
        self.assertNotIn("vapi", (notes[0]["title"] + notes[0]["body"]).lower())

    def test_a_broken_attempt_record_places_no_call(self):
        cs = self.contacts(2)
        c = self.campaign("sequential")
        with patch.object(call_retry, "begin_attempt", side_effect=RuntimeError("db hiccup")):
            d = self.start(c["id"])
        self.assertEqual((d["dialed"], self.create_call.await_count), (0, 0), "no call without a record")
        row = self.row(c["id"])
        self.assertIsNone(row["dial_cursor"], "the number was not passed over")
        self.assertEqual(call_retry.parse_time(row["dial_next_at"]), T0 + 15 * SEC)
        self.tick(c["id"], T0 + 15 * SEC)
        self.assertEqual(self.phones(c["id"]), self.keys(cs[:1]))

    def test_a_dnc_outage_holds_a_fresh_number_back(self):
        cs = self.contacts(2)
        c = self.campaign("sequential", dnc_screening_enabled=True)
        down = AsyncMock(return_value={"allowed": False, "reason": "DNC screening is unavailable, so the call was not placed.",
                                       "source": "api", "suppressed": False, "unavailable": True})
        with patch("services.whitelist_service.check_number", down):
            d = self.start(c["id"])
        self.assertEqual((d["dialed"], d["suppressed"]), (0, 0))
        row = self.row(c["id"])
        self.assertEqual((row["dial_stall"], row["dial_cursor"]), ("screening", None))
        self.assertEqual(call_retry.parse_time(row["dial_next_at"]), T0 + 30 * SEC)
        ok = AsyncMock(return_value={"allowed": True, "reason": None, "source": "api", "suppressed": False})
        with patch("services.whitelist_service.check_number", ok):
            self.tick(c["id"], T0 + 30 * SEC)
        self.assertEqual(self.phones(c["id"]), self.keys(cs[:1]))
        self.assertIsNone(self.row(c["id"])["dial_stall"])

    def test_an_unreadable_number_is_skipped_as_suppressed(self):
        self.contacts(2)
        c = self.campaign("sequential", dnc_screening_enabled=True)
        bad = AsyncMock(return_value={"allowed": False, "reason": "Number could not be read for DNC screening.",
                                      "source": "api", "suppressed": False})
        with patch("services.whitelist_service.check_number", bad):
            d = self.start(c["id"])
        self.assertEqual((d["dialed"], d["suppressed"]), (0, 2))
        self.assertEqual(self.row(c["id"])["dial_running"], False)


class StallTests(DialBase):
    def notes(self):
        return supabase.table("notifications").select("*").eq("user_id", self.user).eq("kind", "campaign_stalled").execute().data

    def test_a_wallet_that_cannot_carry_another_call_stalls_once_and_recovers(self):
        self.contacts(4)
        c = self.campaign("concurrent", dial_concurrent_calls=2)
        with patch.object(dial_limits, "wallet_covers", return_value=(False, 0.1, 0.35)):
            d = self.start(c["id"])
            self.assertEqual(d["dialed"], 0)
            row = self.row(c["id"])
            self.assertEqual((row["dial_stall"], row["status"], row["dial_running"]), ("balance", "Active", True))
            self.assertEqual(call_retry.parse_time(row["dial_next_at"]), T0 + 15 * SEC)
            self.assertEqual(len(self.notes()), 1)
            self.tick(c["id"], T0 + 15 * SEC)
            self.assertEqual(len(self.notes()), 1, "one notification per stall episode")
            live = self.api("get", "/telephony/campaigns/live").json()["data"][c["id"]]
            self.assertEqual((live["state"], live["stall_reason"]), ("stalled", "balance"))
        # topped up: it carries on by itself
        self.tick(c["id"], T0 + 30 * SEC)
        self.assertEqual(self.active(c["id"]), 2)
        self.assertIsNone(self.row(c["id"])["dial_stall"])
        self.assertNotIn("vapi", (self.notes()[0]["title"] + self.notes()[0]["body"]).lower())

    def test_the_wallet_reserve_limits_how_many_calls_go_out(self):
        self.contacts(6)
        c = self.campaign("concurrent", dial_concurrent_calls=5)
        # enough for exactly three calls' reserve
        def covers(owner, open_, now=None, memo=None):
            needed = round((open_ + 1) * 0.35, 4)
            return 1.05 >= needed, 1.05, needed
        with patch.object(dial_limits, "wallet_covers", side_effect=covers):
            d = self.start(c["id"])
        self.assertEqual(d["active_now"], 3)
        self.assertEqual(self.row(c["id"])["dial_stall"], "balance", "and it says why it stopped at three")

    def test_an_account_that_may_not_call_stalls_as_blocked(self):
        self.contacts(2)
        c = self.campaign("sequential")
        self.start(c["id"])
        self.end(c["id"], at=T0 + SEC)
        with patch.object(telephony, "outbound_call_block_reason", return_value="Your account is suspended."):
            self.tick(c["id"], T0 + 2 * SEC)
        row = self.row(c["id"])
        self.assertEqual(row["dial_stall"], "blocked")
        self.assertEqual(len(self.attempts(c["id"])), 1)
        self.assertIn("suspended", self.notes()[0]["body"])

    def test_concurrent_to_sequential_waits_for_every_open_call_to_end(self):
        self.contacts(8)
        c = self.campaign("concurrent", dial_concurrent_calls=5)
        self.start(c["id"])
        self.api("patch", f"/telephony/campaigns/{c['id']}", json={"dial_strategy": "sequential"})
        for i in range(1, 5):
            self.end(c["id"], 1, at=T0 + i * SEC)
            self.tick(c["id"], T0 + i * SEC)
            self.assertEqual(self.active(c["id"]), 5 - i, "nothing is placed while calls are still open")
        self.end(c["id"], 1, at=T0 + 5 * SEC)
        self.tick(c["id"], T0 + 5 * SEC)
        self.assertEqual(self.active(c["id"]), 1)


class ClaimTests(DialBase):
    def test_two_ticks_at_once_place_each_number_once(self):
        cs = self.contacts(6)
        c = self.campaign("concurrent", dial_concurrent_calls=6)
        supabase.table("outbound_campaigns").update({"status": "Active", "dial_running": True, "dial_pass_started_at": call_retry.iso(T0)}) \
            .eq("id", c["id"]).execute()

        async def two():
            return await asyncio.gather(dialer.tick(c["id"], T0), dialer.tick(c["id"], T0))
        a, b = asyncio.run(two())
        self.assertEqual(sorted(self.phones(c["id"])), sorted(self.keys(cs)))
        self.assertEqual(len(self.attempts(c["id"])), 6)
        self.assertEqual(sorted([a.claimed, b.claimed]), [False, True])

    def claim_it(self, cid, age_s):
        H.sql("UPDATE public.outbound_campaigns SET run_token = gen_random_uuid(), run_heartbeat_at = %s WHERE id = %s",
              (T0 - age_s * SEC, cid))

    def test_a_claim_59_seconds_old_is_respected_and_61_is_taken_over(self):
        self.contacts(3)
        c = self.campaign("sequential")
        supabase.table("outbound_campaigns").update({"status": "Active", "dial_running": True, "dial_pass_started_at": call_retry.iso(T0)}) \
            .eq("id", c["id"]).execute()
        self.claim_it(c["id"], 59)
        res = asyncio.run(dialer.tick(c["id"], T0))
        self.assertFalse(res.claimed)
        self.assertEqual(len(self.attempts(c["id"])), 0)
        self.claim_it(c["id"], 61)
        res = asyncio.run(dialer.tick(c["id"], T0))
        self.assertTrue(res.claimed)
        self.assertEqual(len(self.attempts(c["id"])), 1)
        self.assertIsNone(self.row(c["id"])["run_token"], "the claim is given back")

    def test_a_tick_that_fails_midway_gives_the_claim_back(self):
        self.contacts(3)
        c = self.campaign("sequential")
        supabase.table("outbound_campaigns").update({"status": "Active", "dial_running": True, "dial_pass_started_at": call_retry.iso(T0)}) \
            .eq("id", c["id"]).execute()
        with patch.object(dialer, "_open_counts", side_effect=RuntimeError("db is down")):
            with self.assertRaises(RuntimeError):
                asyncio.run(dialer.tick(c["id"], T0))
        self.assertIsNone(self.row(c["id"])["run_token"])

    def test_a_hanging_tick_for_one_campaign_does_not_block_another(self):
        self.contacts(2)
        other = supabase.table("lists").insert({"user_id": self.user, "name": "B"}).execute().data[0]
        self.contacts(2, other["id"])
        a = self.campaign("sequential")
        b = self.campaign("sequential", list_id=other["id"])
        for x in (a, b):
            supabase.table("outbound_campaigns").update({"status": "Active", "dial_running": True, "dial_pass_started_at": call_retry.iso(T0)}) \
                .eq("id", x["id"]).execute()
        self.claim_it(a["id"], 5)          # a is being served by someone else (a fresh claim)
        res = asyncio.run(dialer.dispatch_once(T0, wait=True))
        self.assertEqual(len(self.attempts(b["id"])), 1)
        self.assertEqual(len(self.attempts(a["id"])), 0)


class LiveTests(DialBase):
    KEYS = {"campaign_id", "state", "strategy", "settings", "effective", "warnings", "active_now", "queued", "queued_fresh",
            "queued_redials", "redials_due_now", "placed", "placed_last_minute", "counters", "stall_reason", "next_call_at",
            "pass_started_at", "dispatcher_ok", "as_of"}

    def test_the_live_payload(self):
        self.contacts(6)
        c = self.campaign("concurrent", dial_concurrent_calls=2)
        self.start(c["id"])
        live = self.api("get", "/telephony/campaigns/live").json()["data"]
        self.assertEqual(set(live), {c["id"]})
        s = live[c["id"]]
        self.assertEqual(set(s), self.KEYS)
        self.assertEqual((s["state"], s["active_now"], s["queued"], s["queued_fresh"], s["placed"], s["strategy"]),
                         ("dialing", 2, 4, 4, 2, "concurrent"))
        self.assertEqual(set(s["counters"]), {"suppressed", "busy", "duplicate", "errors", "last_error", "last_error_at"})
        self.assertEqual(s["settings"]["concurrent_calls"], 2)
        self.assertEqual(s["as_of"], "2026-10-14T12:00:00Z")

    def test_live_is_not_taken_for_a_campaign_id_and_does_not_enrich_progress(self):
        with patch.object(telephony, "_enrich_campaign_progress", side_effect=AssertionError("must not be called")):
            r = self.api("get", "/telephony/campaigns/live")
        self.assertEqual(r.status_code, 200, r.text)

    def test_start_answers_with_every_legacy_key(self):
        self.contacts(3)
        c = self.campaign("concurrent", dial_concurrent_calls=5)
        d = self.start(c["id"])
        for key in ("dialed", "errors", "error_details", "suppressed", "suppressed_details", "already_on_call"):
            self.assertIn(key, d)
        for key in ("started", "resumed", "already_running", "strategy", "redials_placed", "queued", "active_now", "placed", "capped"):
            self.assertIn(key, d)


class WiringTests(unittest.TestCase):
    def test_the_app_starts_the_dialer(self):
        import main
        self.assertTrue(any(getattr(h, "__name__", "") == "_start_dialer" for h in main.app.router.on_startup))

    def test_the_old_run_machinery_is_gone(self):
        for name in ("_run_campaign", "_claim_run", "_release_run", "RUN_LEASE_STALE_SECONDS"):
            self.assertFalse(hasattr(telephony, name), name)

    def test_the_routes_for_live_and_limits_are_declared_before_the_id_route(self):
        paths = [r.path for r in telephony.router.routes]
        i = paths.index("/telephony/campaigns/{campaign_id}")
        self.assertLess(paths.index("/telephony/campaigns/live"), i)
        self.assertIn("/telephony/dialing/limits", paths)


if __name__ == "__main__":
    unittest.main()
