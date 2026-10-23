"""
Call retry / redial (services/call_retry.py, the redial sweep in services/campaign_scheduler.py and the
campaign settings in routers/telephony.py).

Everything runs through the real code with a frozen clock and a mocked call placer: a campaign is started
through the API, calls "end" through the real end-of-call webhook (or the VAPI sync import), and the redial
sweep is run at chosen instants. Covered: the acceptance criteria (3 attempts 10 minutes apart then "Max
Attempts Reached"; an answer on attempt 2 ends it; outcomes that are not ticked never retry; campaigns are
independent), every outcome classification, the calling hours, pause/resume, never two calls to one number
at once, settings changes, validation, stats and the numbers view.

Run from the backend folder:  python -m unittest discover -s tests -v
"""
import asyncio
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import byot_harness as H
import qa_harness as Q
from database import supabase
from routers.webhooks import import_vapi_call
from services import call_retry, whitelist_service
from services.campaign_scheduler import run_retries

from test_timezones import FakeDateTime, ZoneBase, local

UTC = timezone.utc
T0 = datetime(2026, 10, 14, 12, 0, tzinfo=UTC)          # a Wednesday, noon UTC
MIN = timedelta(minutes=1)
ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]


class Classify(unittest.TestCase):
    CASES = [
        # (ended reason, status, seconds, qualified, what the agent recorded) -> outcome
        (("customer-did-not-answer", "No Answer", 0), "no_answer"),
        (("customer-busy", "No Answer", 0), "busy"),
        (("voicemail", "No Answer", 15), "voicemail"),
        (("twilio-failed-to-connect-call", "Failed", 0), "failed"),
        (("pipeline-error-openai-llm-failed", "Failed", 2), "failed"),
        (("vonage-rejected", "Completed", 0), "failed"),
        (("", "No Answer", 0), "no_answer"),
        (("", "Failed", 0), "failed"),
        # a real conversation that broke off is not a failed call
        (("pipeline-error-openai-llm-failed", "Failed", 120), "answered"),
        (("customer-ended-call", "Completed", 60), "answered"),
        (("customer-ended-call", "Completed", 1), "answered"),
        (("assistant-ended-call", "Completed", 45), "answered"),
        (("silence-timed-out", "Completed", 30), "answered"),
        (("", "Completed", 0), "answered"),
        (("assistant-forwarded-call", "Completed", 50), "transferred"),
        (("customer-ended-call", "Completed", 50, True), "transferred"),
        (("twilio-invalid-number", "Failed", 0), "invalid_number"),
        (("number-disconnected", "Failed", 0), "invalid_number"),
        (("unallocated-number", "Failed", 0), "invalid_number"),
        (("customer-ended-call", "Completed", 40, False, "Do Not Call"), "do_not_call"),
        (("customer-ended-call", "Completed", 40, False, "Opted-out"), "do_not_call"),
        (("customer-ended-call", "Completed", 40, False, "stop calling me"), "do_not_call"),
        (("customer-ended-call", "Completed", 40, False, "Disqualified"), "disqualified"),
        (("customer-ended-call", "Completed", 40, False, "Not Qualified"), "disqualified"),
        (("customer-ended-call", "Completed", 40, False, "Wrong number"), "invalid_number"),
        (("customer-ended-call", "Completed", 40, False, "Interested"), "answered"),
    ]

    def test_every_case(self):
        for args, expected in self.CASES:
            with self.subTest(args=args):
                self.assertEqual(call_retry.classify(*args), expected)

    def test_transferred_wins_over_what_the_agent_recorded(self):
        self.assertEqual(call_retry.classify("assistant-forwarded-call", "Completed", 40, True, "Do Not Call"), "transferred")

    def test_only_the_four_listed_outcomes_are_retryable(self):
        self.assertEqual(set(call_retry.RETRYABLE), {"no_answer", "busy", "voicemail", "failed"})
        self.assertEqual(set(call_retry.NEVER_RETRY), {"answered", "transferred", "disqualified", "do_not_call", "invalid_number"})

    def test_phone_key_ignores_formatting(self):
        keys = {call_retry.phone_key(p) for p in ("+1 (555) 123-4567", "5551234567", "+15551234567", "1-555-123-4567")}
        self.assertEqual(keys, {"5551234567"})


class Validation(unittest.TestCase):
    def test_defaults(self):
        v = call_retry.validate(None, {})
        self.assertEqual(v, {"retry_enabled": False, "retry_max_attempts": 3, "retry_interval_minutes": 10,
                             "retry_on": ["no_answer", "busy", "voicemail", "failed"]})

    def test_ranges(self):
        ok = lambda **kw: call_retry.validate(None, {"retry_enabled": True, **kw})
        for attempts in (1, 5, 10):
            ok(retry_max_attempts=attempts)
        for minutes in (5, 10, 60):
            ok(retry_interval_minutes=minutes)
        for bad in (0, 11, -1, True, 2.5, "3"):
            with self.subTest(attempts=bad), self.assertRaises(call_retry.RetryError):
                ok(retry_max_attempts=bad)
        for bad in (4, 61, 0, True, 10.5, "10"):
            with self.subTest(minutes=bad), self.assertRaises(call_retry.RetryError):
                ok(retry_interval_minutes=bad)

    def test_retry_on(self):
        v = call_retry.validate(None, {"retry_enabled": True, "retry_on": ["busy", "no_answer", "busy"]})
        self.assertEqual(v["retry_on"], ["no_answer", "busy"], "de-duplicated, in a fixed order")
        with self.assertRaises(call_retry.RetryError):
            call_retry.validate(None, {"retry_enabled": True, "retry_on": []})
        with self.assertRaises(call_retry.RetryError):
            call_retry.validate(None, {"retry_enabled": True, "retry_on": ["answered"]})
        with self.assertRaises(call_retry.RetryError):
            call_retry.validate(None, {"retry_enabled": True, "retry_on": ["voicemail", "transferred"]})
        # nothing ticked is only a problem while retrying is on
        self.assertEqual(call_retry.validate(None, {"retry_enabled": False, "retry_on": []})["retry_on"], [])

    def test_a_partial_update_keeps_the_rest(self):
        stored = {"retry_enabled": True, "retry_max_attempts": 7, "retry_interval_minutes": 25, "retry_on": ["busy"]}
        v = call_retry.validate(stored, {"retry_interval_minutes": 30})
        self.assertEqual(v, {**stored, "retry_interval_minutes": 30})


class RetryBase(ZoneBase):
    """One account, one agent, one list; a campaign with retrying on. The clock is frozen at T0."""

    def setUp(self):
        super().setUp()
        # Sweeps look at EVERY account's due numbers: start with none and leave none behind.
        H.sql("DELETE FROM public.campaign_leads")
        self.addCleanup(lambda: H.sql("DELETE FROM public.campaign_leads"))
        p = patch.object(call_retry, "datetime", FakeDateTime)
        p.start()
        self.addCleanup(p.stop)
        supabase.table("contacts").delete().eq("list_id", self.list["id"]).execute()
        self.contacts = self.add_contacts(1)
        self.at(T0)
        # the VAPI call ids placed to each number, in order (a placement that fails has none)
        self.by_phone: dict[str, list[str]] = {}
        inner = self.create_call.side_effect

        async def recording(payload):
            out = await inner(payload)
            self.by_phone.setdefault(payload["customer"]["number"], []).append(out["id"])
            return out
        self.create_call.side_effect = recording

    # ── building blocks ──
    def add_contacts(self, n, list_id=None, prefix="+1555111"):
        start = len(supabase.table("contacts").select("id").eq("list_id", list_id or self.list["id"]).execute().data)
        rows = [{"user_id": self.user, "list_id": list_id or self.list["id"], "name": f"P{start + i}",
                 "phone": f"{prefix}{start + i:04d}"} for i in range(n)]
        return supabase.table("contacts").insert(rows).execute().data

    def campaign(self, **extra):
        body = {"name": "Retry", "agent_id": self.agent["id"], "list_id": self.list["id"],
                "phone_number_id": self.out_number["id"], "dnc_screening_enabled": False,
                "retry_enabled": True, "retry_max_attempts": 3, "retry_interval_minutes": 10, **extra}
        r = self.api("post", "/telephony/campaigns", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["data"]

    def start(self, cid):
        r = self.api("post", f"/telephony/campaigns/{cid}/start")
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["data"]

    def sweep(self, instant):
        self.at(instant)
        return asyncio.run(run_retries(instant))

    def calls_to(self, phone):
        """The VAPI call ids placed to `phone`, in order."""
        return list(self.by_phone.get(phone, []))

    def end_call(self, call_id, reason="customer-did-not-answer", seconds=0, at=None, outcome=None):
        """The call ends: the real end-of-call webhook, at `at` (default: the frozen clock)."""
        at = at or FakeDateTime.instant
        self.at(at)
        if outcome:
            Q.make_conversation(self.user, vapi_call_id=call_id, agent_id=self.agent["id"], call_outcome=outcome)
        body = Q.end_of_call_body(self.agent["vapi_assistant_id"], call_id, reason, seconds)
        body["message"]["endedAt"] = at.strftime("%Y-%m-%dT%H:%M:%S.000Z")
        r = H.client.post("/webhooks/vapi", json=body)
        self.assertEqual(r.status_code, 200, r.text)

    def lead(self, cid, phone=None):
        phone = phone or self.contacts[0]["phone"]
        rows = supabase.table("campaign_leads").select("*").eq("campaign_id", cid).eq("phone", phone).execute().data
        self.assertEqual(len(rows), 1, f"expected one lead for {phone}")
        return rows[0]

    def attempts(self, cid, phone=None):
        rows = supabase.table("campaign_attempts").select("*").eq("campaign_id", cid).execute().data
        if phone:
            key = call_retry.phone_key(phone)
            rows = [r for r in rows if r["phone_key"] == key]
        return sorted(rows, key=lambda r: (r["round"], r["attempt_number"]))

    def stats(self, cid):
        return self.api("get", f"/telephony/campaigns/{cid}").json()["data"]["retry_stats"]

    def numbers(self, cid, **params):
        q = "&".join(f"{k}={v}" for k, v in params.items())
        r = self.api("get", f"/telephony/campaigns/{cid}/numbers" + (f"?{q}" if q else ""))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["data"]

    def due_at(self, cid, phone=None):
        return call_retry.parse_time(self.lead(cid, phone)["next_attempt_at"])


class AcceptanceTests(RetryBase):
    def test_a_number_that_never_picks_up_gets_exactly_three_calls_ten_minutes_apart(self):
        c = self.campaign(retry_max_attempts=3, retry_interval_minutes=10)
        phone = self.contacts[0]["phone"]
        self.assertEqual(self.start(c["id"])["dialed"], 1)
        self.assertEqual(len(self.calls_to(phone)), 1)

        # attempt 1 rings for 30 s and nobody answers
        self.end_call(self.calls_to(phone)[0], at=T0 + timedelta(seconds=30))
        lead = self.lead(c["id"])
        self.assertEqual((lead["attempts"], lead["last_outcome"], lead["final_status"]), (1, "no_answer", None))
        self.assertEqual(self.due_at(c["id"]), T0 + timedelta(seconds=30) + 10 * MIN, "call end + interval")

        # one second early: nothing; on time: the second call
        self.assertEqual(self.sweep(T0 + timedelta(seconds=30) + 10 * MIN - timedelta(seconds=1))["placed"], 0)
        self.assertEqual(len(self.calls_to(phone)), 1)
        second_at = T0 + timedelta(seconds=30) + 10 * MIN
        self.assertEqual(self.sweep(second_at)["placed"], 1)
        self.assertEqual(len(self.calls_to(phone)), 2)

        # attempt 2 rings for 45 s and nobody answers
        self.end_call(self.calls_to(phone)[1], at=second_at + timedelta(seconds=45))
        self.assertEqual(self.due_at(c["id"]), second_at + timedelta(seconds=45) + 10 * MIN)
        third_at = second_at + timedelta(seconds=45) + 10 * MIN
        self.assertEqual(self.sweep(third_at)["placed"], 1)
        self.assertEqual(len(self.calls_to(phone)), 3)

        # attempt 3 is the last
        self.end_call(self.calls_to(phone)[2], at=third_at + timedelta(seconds=20))
        lead = self.lead(c["id"])
        self.assertEqual((lead["attempts"], lead["final_status"], lead["next_attempt_at"]), (3, "max_attempts", None))

        # nothing more, however long we wait
        for later in (third_at + timedelta(minutes=30), third_at + timedelta(days=3)):
            self.assertEqual(self.sweep(later)["placed"], 0)
        self.assertEqual(len(self.calls_to(phone)), 3, "exactly three calls")

        # ~10 minutes apart: every call was placed at least one interval after the previous one ended
        rows = self.attempts(c["id"])
        self.assertEqual([r["attempt_number"] for r in rows], [1, 2, 3])
        self.assertEqual([r["outcome"] for r in rows], ["no_answer"] * 3)
        for prev, nxt in zip(rows, rows[1:]):
            gap = call_retry.parse_time(nxt["placed_at"]) - call_retry.parse_time(prev["ended_at"])
            self.assertEqual(gap, 10 * MIN)

        # the numbers view and the stats say so
        n = self.numbers(c["id"])["rows"][0]
        self.assertEqual((n["attempts"], n["status"], n["final_status"], n["next_attempt_at"]), (3, "max_attempts", "max_attempts", None))
        self.assertEqual([h["attempt_number"] for h in n["history"]], [1, 2, 3])
        self.assertEqual(self.stats(c["id"]), {"total_attempts": 3, "retries_placed": 2, "answered_on_retry": 0,
                                               "max_attempts_reached": 1, "pending_retries": 0, "numbers": 1})

    def test_a_number_that_answers_on_attempt_two_is_not_called_again(self):
        c = self.campaign()
        phone = self.contacts[0]["phone"]
        self.start(c["id"])
        self.end_call(self.calls_to(phone)[0], "customer-busy", at=T0 + timedelta(seconds=10))
        self.assertEqual(self.sweep(T0 + 11 * MIN)["placed"], 1)
        self.end_call(self.calls_to(phone)[1], "customer-ended-call", 95, at=T0 + 14 * MIN)    # a real conversation
        lead = self.lead(c["id"])
        self.assertEqual((lead["attempts"], lead["last_outcome"], lead["final_status"], lead["next_attempt_at"]),
                         (2, "answered", "answered", None))
        for later in (T0 + 30 * MIN, T0 + 2 * 24 * 60 * MIN):
            self.assertEqual(self.sweep(later)["placed"], 0)
        self.assertEqual(len(self.calls_to(phone)), 2)
        self.assertEqual(self.stats(c["id"]), {"total_attempts": 2, "retries_placed": 1, "answered_on_retry": 1,
                                               "max_attempts_reached": 0, "pending_retries": 0, "numbers": 1})

    def test_an_answer_on_the_first_attempt_is_not_a_retry_answer(self):
        c = self.campaign()
        self.start(c["id"])
        self.end_call(self.placed[0], "customer-ended-call", 60, at=T0 + MIN)
        self.assertEqual(self.stats(c["id"])["answered_on_retry"], 0)
        self.assertEqual(self.lead(c["id"])["final_status"], "answered")

    def test_outcomes_that_are_not_ticked_do_not_retry(self):
        outcomes = {"no_answer": ("customer-did-not-answer", 0), "busy": ("customer-busy", 0),
                    "voicemail": ("voicemail", 12), "failed": ("twilio-failed-to-connect-call", 0)}
        for ticked in outcomes:
            for happened, (reason, seconds) in outcomes.items():
                with self.subTest(ticked=ticked, happened=happened):
                    list_ = supabase.table("lists").insert({"user_id": self.user, "name": f"L-{ticked}-{happened}"}).execute().data[0]
                    contact = self.add_contacts(1, list_["id"], prefix=f"+1555{abs(hash((ticked, happened))) % 900 + 100}")[0]
                    c = self.campaign(list_id=list_["id"], retry_on=[ticked])
                    before = len(self.placed)
                    self.at(T0)
                    self.start(c["id"])
                    self.end_call(self.placed[before], reason, seconds, at=T0 + MIN)
                    lead = self.lead(c["id"], contact["phone"])
                    if happened == ticked:
                        self.assertIsNotNone(lead["next_attempt_at"])
                        self.assertIsNone(lead["final_status"])
                        self.assertEqual(self.sweep(T0 + 12 * MIN)["placed"], 1)
                    else:
                        self.assertEqual((lead["final_status"], lead["next_attempt_at"]), ("not_retried", None))
                        self.assertEqual(self.sweep(T0 + 12 * MIN)["placed"], 0)
                    self.assertEqual(len(self.placed), before + (2 if happened == ticked else 1))
                    # park the campaign so later sweeps leave it alone
                    self.api("patch", f"/telephony/campaigns/{c['id']}", json={"status": "Paused"})

    def test_every_outcome_that_must_not_retry_is_final(self):
        cases = [
            ("answered", "customer-ended-call", 60, None),
            ("transferred", "assistant-forwarded-call", 60, None),
            ("disqualified", "customer-ended-call", 60, "Disqualified"),
            ("do_not_call", "customer-ended-call", 60, "Do Not Call"),
            ("invalid_number", "twilio-invalid-number", 0, None),
        ]
        for expected, reason, seconds, outcome in cases:
            with self.subTest(expected):
                list_ = supabase.table("lists").insert({"user_id": self.user, "name": f"N-{expected}"}).execute().data[0]
                contact = self.add_contacts(1, list_["id"], prefix=f"+1555{abs(hash(expected)) % 900 + 100}")[0]
                # every retryable outcome is ticked: the call still must not be redialed
                c = self.campaign(list_id=list_["id"], retry_on=list(call_retry.RETRYABLE))
                before = len(self.placed)
                self.at(T0)
                self.start(c["id"])
                self.end_call(self.placed[before], reason, seconds, at=T0 + MIN, outcome=outcome)
                lead = self.lead(c["id"], contact["phone"])
                self.assertEqual((lead["final_status"], lead["last_outcome"], lead["next_attempt_at"]), (expected, expected, None))
                self.assertEqual(self.sweep(T0 + 3 * 24 * 60 * MIN)["placed"], 0)
                self.assertEqual(len(self.placed), before + 1)
                self.api("patch", f"/telephony/campaigns/{c['id']}", json={"status": "Paused"})

    def test_campaigns_have_independent_settings(self):
        other_list = supabase.table("lists").insert({"user_id": self.user, "name": "Other"}).execute().data[0]
        other_contact = self.add_contacts(1, other_list["id"], prefix="+1555222")[0]
        a = self.campaign(retry_max_attempts=2, retry_interval_minutes=10, retry_on=["no_answer"])
        b = self.campaign(list_id=other_list["id"], retry_max_attempts=4, retry_interval_minutes=30, retry_on=["busy"])
        off = supabase.table("lists").insert({"user_id": self.user, "name": "Off"}).execute().data[0]
        off_contact = self.add_contacts(1, off["id"], prefix="+1555333")[0]
        c = self.campaign(list_id=off["id"], retry_enabled=False)
        for camp in (a, b, c):
            self.start(camp["id"])
        pa, pb, pc = self.contacts[0]["phone"], other_contact["phone"], off_contact["phone"]
        self.end_call(self.calls_to(pa)[0], "customer-did-not-answer", at=T0 + MIN)
        self.end_call(self.calls_to(pb)[0], "customer-busy", at=T0 + MIN)
        self.end_call(self.calls_to(pc)[0], "customer-did-not-answer", at=T0 + MIN)
        self.assertEqual(self.due_at(a["id"]), T0 + 11 * MIN)
        self.assertEqual(self.due_at(b["id"], pb), T0 + 31 * MIN)
        self.assertEqual(self.lead(c["id"], pc)["final_status"], "not_retried")

        self.assertEqual(self.sweep(T0 + 11 * MIN)["placed"], 1, "only campaign A is due")
        self.assertEqual((len(self.calls_to(pa)), len(self.calls_to(pb)), len(self.calls_to(pc))), (2, 1, 1))
        self.end_call(self.calls_to(pa)[1], "customer-did-not-answer", at=T0 + 12 * MIN)
        self.assertEqual(self.lead(a["id"])["final_status"], "max_attempts", "A allows two calls")
        self.assertEqual(self.sweep(T0 + 31 * MIN)["placed"], 1, "B is due now")
        self.end_call(self.calls_to(pb)[1], "customer-busy", at=T0 + 32 * MIN)
        self.assertIsNone(self.lead(b["id"], pb)["final_status"], "B allows four")
        self.assertEqual(self.due_at(b["id"], pb), T0 + 62 * MIN)


class EndOfCallTests(RetryBase):
    def test_a_webhook_delivered_twice_counts_once(self):
        c = self.campaign()
        self.start(c["id"])
        call = self.placed[0]
        self.end_call(call, at=T0 + MIN)
        first = self.lead(c["id"])
        self.end_call(call, "customer-ended-call", 60, at=T0 + 5 * MIN)     # a late duplicate must change nothing
        self.assertEqual(self.lead(c["id"]), first)
        self.assertEqual(len(self.attempts(c["id"])), 1)

    def test_the_vapi_sync_import_settles_the_number_too(self):
        c = self.campaign()
        self.start(c["id"])
        call = self.placed[0]
        import_vapi_call({"id": call, "type": "outboundPhoneCall", "assistantId": self.agent["vapi_assistant_id"],
                          "endedReason": "customer-busy", "endedAt": (T0 + 2 * MIN).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                          "customer": {"number": self.contacts[0]["phone"]}}, self.user)
        lead = self.lead(c["id"])
        self.assertEqual(lead["last_outcome"], "busy")
        self.assertEqual(self.due_at(c["id"]), T0 + 12 * MIN, "measured from the call's own end time")
        # ... and the webhook arriving afterwards changes nothing
        self.end_call(call, "customer-busy", at=T0 + 3 * MIN)
        self.assertEqual(len(self.attempts(c["id"])), 1)

    def test_a_call_that_is_still_in_progress_does_not_settle(self):
        c = self.campaign()
        self.start(c["id"])
        call = self.placed[0]
        Q.make_conversation(self.user, vapi_call_id=call, agent_id=self.agent["id"], status="In Progress")
        call_retry.on_call_ended(call)
        self.assertIsNone(self.attempts(c["id"])[0]["ended_at"])
        self.assertIsNone(self.lead(c["id"])["next_attempt_at"])

    def test_a_call_no_campaign_placed_is_ignored(self):
        call_retry.on_call_ended("call-from-somewhere-else")
        call_retry.on_call_ended(None)

    def test_a_failed_placement_counts_as_a_failed_attempt(self):
        c = self.campaign(retry_on=["failed"])
        phone = self.contacts[0]["phone"]
        inner = self.create_call.side_effect
        calls = {"n": 0}

        async def flaky(payload):
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("provider unreachable")
            return await inner(payload)
        self.create_call.side_effect = flaky
        data = self.start(c["id"])
        self.assertEqual((data["dialed"], data["errors"]), (0, 1))
        lead = self.lead(c["id"])
        self.assertEqual((lead["attempts"], lead["last_outcome"]), (1, "failed"))
        self.assertEqual(self.due_at(c["id"]), T0 + 10 * MIN)
        self.assertIn("provider unreachable", self.attempts(c["id"])[0]["ended_reason"])
        self.assertEqual(self.sweep(T0 + 10 * MIN)["placed"], 1)
        self.assertEqual(self.lead(c["id"])["attempts"], 2)
        self.assertEqual(len(self.calls_to(phone)), 1, "the first call never reached the provider")


class HoursTests(RetryBase):
    def test_a_redial_that_falls_outside_the_hours_moves_to_the_next_window(self):
        zone = "America/New_York"
        c = self.campaign(call_hours_enabled=True, call_hours_timezone=zone, call_hours_days=ALL_DAYS,
                          call_hours_start="09:00", call_hours_end="17:00", retry_interval_minutes=10)
        phone = self.contacts[0]["phone"]
        self.at(local(zone, 2026, 10, 14, 16, 40))
        self.start(c["id"])
        # the call ends at 16:55; +10 minutes is 17:05, after closing
        self.end_call(self.calls_to(phone)[0], at=local(zone, 2026, 10, 14, 16, 55))
        self.assertEqual(self.due_at(c["id"]), local(zone, 2026, 10, 15, 9, 0), "tomorrow at opening time, in the campaign's zone")

        self.assertEqual(self.sweep(local(zone, 2026, 10, 14, 17, 5))["placed"], 0)
        self.assertEqual(self.sweep(local(zone, 2026, 10, 14, 23, 0))["placed"], 0)
        self.assertEqual(self.sweep(local(zone, 2026, 10, 15, 8, 59))["placed"], 0)
        self.assertEqual(len(self.calls_to(phone)), 1)
        self.assertEqual(self.sweep(local(zone, 2026, 10, 15, 9, 0))["placed"], 1)
        self.assertEqual(len(self.calls_to(phone)), 2)

    def test_a_redial_inside_the_hours_keeps_its_time(self):
        zone = "Asia/Karachi"
        c = self.campaign(call_hours_enabled=True, call_hours_timezone=zone, call_hours_days=ALL_DAYS,
                          call_hours_start="09:00", call_hours_end="17:00")
        self.at(local(zone, 2026, 10, 14, 10, 0))
        self.start(c["id"])
        self.end_call(self.placed[0], at=local(zone, 2026, 10, 14, 10, 1))
        self.assertEqual(self.due_at(c["id"]), local(zone, 2026, 10, 14, 10, 11))

    def test_a_break_inside_the_window_also_delays_the_redial(self):
        zone = "UTC"
        schedule = {"mode": "same", "breaks": [{"start": "12:00", "end": "13:00"}]}
        c = self.campaign(call_hours_enabled=True, call_hours_timezone=zone, call_hours_days=ALL_DAYS,
                          call_hours_start="09:00", call_hours_end="17:00", call_hours_schedule=schedule)
        self.at(local(zone, 2026, 10, 14, 11, 40))
        self.start(c["id"])
        self.end_call(self.placed[0], at=local(zone, 2026, 10, 14, 11, 52))        # +10 = 12:02, in the break
        self.assertEqual(self.due_at(c["id"]), local(zone, 2026, 10, 14, 13, 0), "the break ends")

    def test_hours_that_close_after_the_redial_was_scheduled_hold_it_back(self):
        zone = "UTC"
        c = self.campaign(call_hours_enabled=True, call_hours_timezone=zone, call_hours_days=ALL_DAYS,
                          call_hours_start="09:00", call_hours_end="17:00")
        phone = self.contacts[0]["phone"]
        self.at(local(zone, 2026, 10, 14, 12, 0))
        self.start(c["id"])
        self.end_call(self.placed[0], at=local(zone, 2026, 10, 14, 12, 1))          # due 12:11, hours are open
        # the owner narrows the hours before it is due: the redial must wait for the new window
        r = self.api("patch", f"/telephony/campaigns/{c['id']}", json={"call_hours_end": "12:05"})
        self.assertEqual(r.status_code, 200, r.text)
        res = self.sweep(local(zone, 2026, 10, 14, 12, 11))
        self.assertEqual((res["placed"], res["waiting"]), (0, 1))
        self.assertEqual(self.due_at(c["id"]), local(zone, 2026, 10, 15, 9, 0), "moved to the next window, not left 'due'")
        self.assertEqual(len(self.calls_to(phone)), 1)

    def test_redials_of_many_numbers_all_wait_for_the_window_and_then_go_out(self):
        zone = "UTC"
        self.add_contacts(4)
        c = self.campaign(call_hours_enabled=True, call_hours_timezone=zone, call_hours_days=ALL_DAYS,
                          call_hours_start="09:00", call_hours_end="17:00")
        self.at(local(zone, 2026, 10, 14, 16, 30))
        self.start(c["id"])
        for call in list(self.placed):
            self.end_call(call, at=local(zone, 2026, 10, 14, 16, 58))
        nxt = local(zone, 2026, 10, 15, 9, 0)
        for contact in self.contacts + supabase.table("contacts").select("*").eq("list_id", self.list["id"]).execute().data:
            self.assertEqual(self.due_at(c["id"], contact["phone"]), nxt)
        self.assertEqual(self.sweep(nxt)["placed"], 5)


class PauseTests(RetryBase):
    def _waiting_redial(self, **extra):
        c = self.campaign(**extra)
        self.start(c["id"])
        self.end_call(self.placed[0], at=T0 + MIN)
        return c

    def test_a_paused_campaign_keeps_its_redials_and_places_them_on_resume(self):
        c = self._waiting_redial()
        phone = self.contacts[0]["phone"]
        r = self.api("post", f"/telephony/campaigns/{c['id']}/pause")
        self.assertEqual(r.status_code, 200)
        res = self.sweep(T0 + 11 * MIN)
        self.assertEqual((res["placed"], res["paused"]), (0, 1))
        self.assertEqual(self.sweep(T0 + 3 * 24 * 60 * MIN)["placed"], 0, "paused for days: still nothing")
        lead = self.lead(c["id"])
        self.assertIsNotNone(lead["next_attempt_at"], "still pending, not lost")
        self.assertIsNone(lead["final_status"])
        self.assertEqual(self.numbers(c["id"])["rows"][0]["status"], "retry_paused")

        r = self.api("post", f"/telephony/campaigns/{c['id']}/resume")
        self.assertEqual(r.json()["data"]["status"], "Active")
        self.assertEqual(self.sweep(T0 + 3 * 24 * 60 * MIN + MIN)["placed"], 1)
        self.assertEqual(len(self.calls_to(phone)), 2)
        self.assertEqual(self.numbers(c["id"])["rows"][0]["status"], "calling")

    def test_a_stopped_campaign_does_not_redial_either(self):
        c = self._waiting_redial()
        self.api("patch", f"/telephony/campaigns/{c['id']}", json={"status": "Inactive"})
        self.assertEqual(self.sweep(T0 + 20 * MIN)["placed"], 0)
        self.assertEqual(len(self.placed), 1)
        self.api("patch", f"/telephony/campaigns/{c['id']}", json={"status": "Active"})
        self.assertEqual(self.sweep(T0 + 21 * MIN)["placed"], 1)

    def test_a_pause_between_batches_stops_the_rest(self):
        self.add_contacts(5)
        c = self.campaign()
        self.start(c["id"])
        for call in list(self.placed):
            self.end_call(call, at=T0 + MIN)
        self.assertEqual(len(self.placed), 6)
        with patch("routers.telephony.CAMPAIGN_BATCH_SIZE", 2):
            inner = self.create_call.side_effect

            async def pausing(payload):
                out = await inner(payload)
                self.api("post", f"/telephony/campaigns/{c['id']}/pause")      # the person pauses mid-sweep
                return out
            self.create_call.side_effect = pausing
            res = self.sweep(T0 + 11 * MIN)
        self.assertEqual(res["placed"], 2, "the batch in flight finishes, the rest wait")
        self.assertEqual(res["paused"], 4)
        self.assertEqual(len(self.placed), 8)


class OneCallAtATimeTests(RetryBase):
    def test_the_same_number_twice_in_one_list_is_called_once(self):
        supabase.table("contacts").insert({"user_id": self.user, "list_id": self.list["id"], "name": "Dup",
                                           "phone": self.contacts[0]["phone"]}).execute()
        c = self.campaign()
        data = self.start(c["id"])
        self.assertEqual((data["dialed"], data["already_on_call"]), (1, 1))
        self.assertEqual(len(self.placed), 1)

    def test_the_same_number_formatted_differently_counts_as_the_same_number(self):
        supabase.table("contacts").insert({"user_id": self.user, "list_id": self.list["id"], "name": "Dup",
                                           "phone": "(555) 111-0000"}).execute()
        c = self.campaign()
        self.assertEqual(self.start(c["id"])["already_on_call"], 1)

    def test_two_campaigns_cannot_call_one_number_at_once(self):
        other_list = supabase.table("lists").insert({"user_id": self.user, "name": "Same people"}).execute().data[0]
        supabase.table("contacts").insert({"user_id": self.user, "list_id": other_list["id"], "name": "Same",
                                           "phone": self.contacts[0]["phone"]}).execute()
        a, b = self.campaign(), self.campaign(list_id=other_list["id"])
        self.assertEqual(self.start(a["id"])["dialed"], 1)
        second = self.start(b["id"])
        self.assertEqual((second["dialed"], second["already_on_call"]), (0, 1))
        self.assertEqual(len(self.placed), 1)
        # once the first call has ended the number is free again
        self.end_call(self.placed[0], "customer-ended-call", 30, at=T0 + MIN)
        self.assertEqual(self.start(b["id"])["dialed"], 1)

    def test_a_redial_waits_while_the_number_is_on_another_call(self):
        c = self.campaign()
        phone = self.contacts[0]["phone"]
        self.start(c["id"])
        self.end_call(self.placed[0], at=T0 + MIN)
        # another campaign's call to the same number is open when the redial falls due
        other_list = supabase.table("lists").insert({"user_id": self.user, "name": "Same people"}).execute().data[0]
        supabase.table("contacts").insert({"user_id": self.user, "list_id": other_list["id"], "name": "Same", "phone": phone}).execute()
        b = self.campaign(list_id=other_list["id"])
        self.at(T0 + 5 * MIN)
        self.assertEqual(self.start(b["id"])["dialed"], 1)
        res = self.sweep(T0 + 11 * MIN)
        self.assertEqual((res["placed"], res["busy"]), (0, 1))
        self.assertEqual(self.lead(c["id"])["attempts"], 1, "no attempt was taken")
        self.assertIsNotNone(self.lead(c["id"])["next_attempt_at"], "still due")
        self.end_call(self.calls_to(phone)[1], "customer-ended-call", 5, at=T0 + 12 * MIN)         # the other call ends (hung up)
        self.assertEqual(self.sweep(T0 + 13 * MIN)["placed"], 1)

    def test_two_sweeps_at_once_place_one_call(self):
        c = self.campaign()
        phone = self.contacts[0]["phone"]
        self.start(c["id"])
        self.end_call(self.placed[0], at=T0 + MIN)
        self.at(T0 + 11 * MIN)

        async def both():
            return await asyncio.gather(run_retries(T0 + 11 * MIN), run_retries(T0 + 11 * MIN))
        asyncio.run(both())
        self.assertEqual(len(self.calls_to(phone)), 2, "the first call and exactly one redial")
        self.assertEqual(self.lead(c["id"])["attempts"], 2)

    def test_the_open_attempt_index_is_what_guards_the_number(self):
        c = self.campaign()
        camp = supabase.table("outbound_campaigns").select("*").eq("id", c["id"]).execute().data[0]
        first = call_retry.begin_attempt(camp, self.contacts[0], new_round=True)
        self.assertIsNotNone(first)
        self.assertIsNone(call_retry.begin_attempt(camp, self.contacts[0], new_round=True))
        twin = supabase.table("contacts").insert({"user_id": self.user, "list_id": self.list["id"], "name": "Twin",
                                                  "phone": "+1 (555) 111-0000"}).execute().data[0]
        self.assertIsNone(call_retry.begin_attempt(camp, twin, new_round=True), "same last-10-digits key")
        self.assertEqual(len(self.attempts(c["id"])), 1)
        call_retry.finish_attempt(first, "answered")
        self.assertIsNotNone(call_retry.begin_attempt(camp, twin, new_round=True), "free once the call ended")

    def test_a_call_whose_end_never_arrived_frees_its_number_after_a_while(self):
        c = self.campaign(retry_on=["failed"])
        phone = self.contacts[0]["phone"]
        self.start(c["id"])
        self.assertEqual(self.sweep(T0 + 30 * MIN)["placed"], 0)
        self.assertEqual(call_retry.reap_stale(), 0, "too young")
        self.at(T0 + (call_retry.STALE_ATTEMPT_MINUTES + 1) * MIN)
        self.assertEqual(call_retry.reap_stale(), 1)
        first = self.attempts(c["id"])[0]
        self.assertEqual((first["outcome"], first["ended_reason"]), ("failed", "no end-of-call report received"))
        self.assertEqual(self.due_at(c["id"]), T0 + (call_retry.STALE_ATTEMPT_MINUTES + 1) * MIN + 10 * MIN)
        self.assertEqual(len(self.calls_to(phone)), 1)


class SettingsChangeTests(RetryBase):
    def patch(self, cid, **body):
        r = self.api("patch", f"/telephony/campaigns/{cid}", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["data"]

    def test_a_call_in_progress_is_settled_with_the_settings_it_was_placed_under(self):
        c = self.campaign(retry_max_attempts=3, retry_interval_minutes=10, retry_on=["no_answer"])
        self.start(c["id"])
        # settings change while the call is still ringing
        self.patch(c["id"], retry_interval_minutes=30, retry_on=["busy"])
        self.end_call(self.placed[0], "customer-did-not-answer", at=T0 + MIN)
        self.assertEqual(self.due_at(c["id"]), T0 + 11 * MIN, "the old 10 minutes and the old 'no answer'")
        # the redial placed afterwards runs under the new settings
        self.assertEqual(self.sweep(T0 + 11 * MIN)["placed"], 1)
        self.end_call(self.placed[1], "customer-did-not-answer", at=T0 + 12 * MIN)
        self.assertEqual(self.lead(c["id"])["final_status"], "not_retried", "no answer is no longer ticked")

    def test_a_new_interval_applies_to_the_next_scheduling_not_to_one_already_made(self):
        c = self.campaign(retry_interval_minutes=10)
        self.start(c["id"])
        self.end_call(self.placed[0], at=T0 + MIN)
        self.patch(c["id"], retry_interval_minutes=60)
        self.assertEqual(self.due_at(c["id"]), T0 + 11 * MIN, "already scheduled: unchanged")
        self.assertEqual(self.sweep(T0 + 11 * MIN)["placed"], 1)
        self.end_call(self.placed[1], at=T0 + 12 * MIN)
        self.assertEqual(self.due_at(c["id"]), T0 + 72 * MIN, "the next one uses 60 minutes")

    def test_switching_retry_off_cancels_the_waiting_redials(self):
        c = self.campaign()
        self.start(c["id"])
        self.end_call(self.placed[0], at=T0 + MIN)
        self.patch(c["id"], retry_enabled=False)
        lead = self.lead(c["id"])
        self.assertEqual((lead["final_status"], lead["next_attempt_at"]), ("not_retried", None))
        self.assertEqual(self.sweep(T0 + 20 * MIN)["placed"], 0)

    def test_a_call_ringing_when_retry_is_switched_off_schedules_nothing_that_is_placed(self):
        c = self.campaign()
        self.start(c["id"])
        self.patch(c["id"], retry_enabled=False)                  # while the first call is still ringing
        self.end_call(self.placed[0], at=T0 + MIN)
        self.assertIsNotNone(self.due_at(c["id"]), "decided with the settings it was placed under")
        res = self.sweep(T0 + 11 * MIN)
        self.assertEqual((res["placed"], res["cancelled"]), (0, 1), "but a redial is a new call, and retrying is off")
        self.assertEqual(self.lead(c["id"])["final_status"], "not_retried")
        self.assertEqual(len(self.placed), 1)

    def test_lowering_the_maximum_stops_a_number_that_has_reached_it(self):
        c = self.campaign(retry_max_attempts=5)
        self.start(c["id"])
        self.end_call(self.placed[0], at=T0 + MIN)
        self.assertEqual(self.sweep(T0 + 11 * MIN)["placed"], 1)
        self.end_call(self.placed[1], at=T0 + 12 * MIN)       # 2 calls made, a 3rd is due
        self.patch(c["id"], retry_max_attempts=2)
        res = self.sweep(T0 + 22 * MIN)
        self.assertEqual((res["placed"], res["max_attempts"]), (0, 1))
        self.assertEqual(self.lead(c["id"])["final_status"], "max_attempts")

    def test_raising_the_maximum_lets_a_waiting_number_continue(self):
        c = self.campaign(retry_max_attempts=2)
        self.start(c["id"])
        self.end_call(self.placed[0], at=T0 + MIN)                 # waiting for its second call
        self.patch(c["id"], retry_max_attempts=4)
        self.assertEqual(self.sweep(T0 + 11 * MIN)["placed"], 1)   # placed under the new maximum
        self.end_call(self.placed[1], at=T0 + 12 * MIN)
        self.assertIsNone(self.lead(c["id"])["final_status"], "2 of 4 calls made")
        self.assertEqual(self.due_at(c["id"]), T0 + 22 * MIN)

    def test_a_maximum_raised_while_the_last_call_rings_does_not_change_that_call(self):
        c = self.campaign(retry_max_attempts=2)
        self.start(c["id"])
        self.end_call(self.placed[0], at=T0 + MIN)
        self.assertEqual(self.sweep(T0 + 11 * MIN)["placed"], 1)   # the second (last) call is ringing
        self.patch(c["id"], retry_max_attempts=4)
        self.end_call(self.placed[1], at=T0 + 12 * MIN)
        self.assertEqual(self.lead(c["id"])["final_status"], "max_attempts", "settled with the maximum it was placed under")

    def test_validation_errors_are_400(self):
        c = self.campaign()
        for body in ({"retry_max_attempts": 0}, {"retry_max_attempts": 11}, {"retry_interval_minutes": 4},
                     {"retry_interval_minutes": 61}, {"retry_on": ["teleport"]}, {"retry_enabled": True, "retry_on": []}):
            with self.subTest(body=body):
                r = self.api("patch", f"/telephony/campaigns/{c['id']}", json=body)
                self.assertEqual(r.status_code, 400, r.text)
        bad = self.api("post", "/telephony/campaigns", json={"name": "x", "retry_enabled": True, "retry_on": []})
        self.assertEqual(bad.status_code, 400)
        stored = self.api("get", f"/telephony/campaigns/{c['id']}").json()["data"]
        self.assertEqual((stored["retry_max_attempts"], stored["retry_interval_minutes"]), (3, 10), "nothing half-saved")

    def test_settings_round_trip_and_defaults(self):
        plain = self.api("post", "/telephony/campaigns", json={"name": "Plain"}).json()["data"]
        self.assertEqual((plain["retry_enabled"], plain["retry_max_attempts"], plain["retry_interval_minutes"], plain["retry_on"]),
                         (False, 3, 10, ["no_answer", "busy", "voicemail", "failed"]))
        c = self.campaign(retry_max_attempts=7, retry_interval_minutes=45, retry_on=["voicemail", "busy"])
        got = self.api("get", f"/telephony/campaigns/{c['id']}").json()["data"]
        self.assertEqual((got["retry_enabled"], got["retry_max_attempts"], got["retry_interval_minutes"], got["retry_on"]),
                         (True, 7, 45, ["busy", "voicemail"]))
        self.patch(c["id"], retry_on=["failed"])
        got = self.api("get", f"/telephony/campaigns/{c['id']}").json()["data"]
        self.assertEqual((got["retry_max_attempts"], got["retry_on"]), (7, ["failed"]), "other fields kept")


class RoundTests(RetryBase):
    def test_starting_the_list_again_begins_a_new_round_and_keeps_the_history(self):
        c = self.campaign(retry_max_attempts=2)
        phone = self.contacts[0]["phone"]
        self.start(c["id"])
        self.end_call(self.placed[0], at=T0 + MIN)
        self.assertEqual(self.sweep(T0 + 11 * MIN)["placed"], 1)
        self.end_call(self.placed[1], at=T0 + 12 * MIN)
        self.assertEqual(self.lead(c["id"])["final_status"], "max_attempts")

        self.at(T0 + 3 * 24 * 60 * MIN)
        self.start(c["id"])
        lead = self.lead(c["id"])
        self.assertEqual((lead["round"], lead["attempts"], lead["final_status"]), (2, 1, None))
        self.assertEqual(len(self.calls_to(phone)), 3)
        self.assertEqual([(a["round"], a["attempt_number"]) for a in self.attempts(c["id"])], [(1, 1), (1, 2), (2, 1)])
        self.assertEqual(self.stats(c["id"])["total_attempts"], 1, "the stats are for the current round")
        self.assertEqual(self.stats(c["id"])["max_attempts_reached"], 0, "the number is in a new round")

    def test_a_late_report_of_an_old_round_does_not_touch_the_new_one(self):
        c = self.campaign()
        self.start(c["id"])
        old_call = self.placed[0]
        # the old call's end is lost; its number is freed by the reaper, then the list is dialed again
        self.at(T0 + 3 * 60 * MIN)
        call_retry.reap_stale()
        self.start(c["id"])
        self.assertEqual(self.lead(c["id"])["round"], 2)
        self.end_call(old_call, "customer-ended-call", 60, at=T0 + 4 * 60 * MIN)
        lead = self.lead(c["id"])
        self.assertEqual((lead["round"], lead["attempts"], lead["final_status"]), (2, 1, None))


class StatsAndViewTests(RetryBase):
    def test_the_campaign_stats(self):
        self.add_contacts(3)          # four numbers in all
        c = self.campaign(retry_max_attempts=2)
        self.start(c["id"])
        phones = [x["phone"] for x in supabase.table("contacts").select("phone").eq("list_id", self.list["id"]).order("phone").execute().data]
        a, b, d, e = (self.calls_to(p)[0] for p in phones)
        self.end_call(a, "customer-ended-call", 60, at=T0 + MIN)            # answered first time
        self.end_call(b, at=T0 + MIN)                                         # will be answered on retry
        self.end_call(d, at=T0 + MIN)                                         # never answers
        self.end_call(e, "customer-busy", at=T0 + MIN)                        # never answers
        self.assertEqual(self.stats(c["id"]), {"total_attempts": 4, "retries_placed": 0, "answered_on_retry": 0,
                                               "max_attempts_reached": 0, "pending_retries": 3, "numbers": 4})
        self.assertEqual(self.sweep(T0 + 11 * MIN)["placed"], 3)
        self.end_call(self.calls_to(phones[1])[1], "customer-ended-call", 40, at=T0 + 12 * MIN)
        self.end_call(self.calls_to(phones[2])[1], at=T0 + 12 * MIN)
        self.end_call(self.calls_to(phones[3])[1], "customer-busy", at=T0 + 12 * MIN)
        self.assertEqual(self.stats(c["id"]), {"total_attempts": 7, "retries_placed": 3, "answered_on_retry": 1,
                                               "max_attempts_reached": 2, "pending_retries": 0, "numbers": 4})
        listing = self.api("get", "/telephony/campaigns").json()["data"]
        self.assertEqual(next(x for x in listing if x["id"] == c["id"])["retry_stats"]["retries_placed"], 3)

    def test_the_numbers_view(self):
        self.add_contacts(2)
        c = self.campaign()
        self.start(c["id"])
        phones = [x["phone"] for x in supabase.table("contacts").select("phone").eq("list_id", self.list["id"]).order("phone").execute().data]
        self.end_call(self.calls_to(phones[0])[0], at=T0 + MIN)
        self.end_call(self.calls_to(phones[1])[0], "customer-ended-call", 60, at=T0 + MIN)
        view = self.numbers(c["id"])
        self.assertEqual(view["total"], 3)
        by_phone = {r["phone"]: r for r in view["rows"]}
        waiting = by_phone[phones[0]]
        self.assertEqual((waiting["status"], waiting["attempts"], waiting["max_attempts"], waiting["last_outcome"]),
                         ("retry_scheduled", 1, 3, "no_answer"))
        self.assertEqual(waiting["next_attempt_at"], (T0 + 11 * MIN).strftime("%Y-%m-%dT%H:%M:%SZ"))
        self.assertEqual(by_phone[phones[1]]["status"], "answered")
        self.assertEqual(by_phone[phones[2]]["status"], "calling", "its call has not ended")
        self.assertEqual(view["retry"]["interval_minutes"], 10)
        self.assertEqual([r["phone"] for r in self.numbers(c["id"], status="pending")["rows"]], [phones[0], phones[2]])
        self.assertEqual([r["phone"] for r in self.numbers(c["id"], status="answered")["rows"]], [phones[1]])
        self.assertEqual(self.numbers(c["id"], status="finished")["total"], 1)
        self.assertEqual(self.numbers(c["id"], limit=1)["rows"].__len__(), 1)
        bad = self.api("get", f"/telephony/campaigns/{c['id']}/numbers?status=teleport")
        self.assertEqual(bad.status_code, 400)

    def test_another_account_cannot_read_the_numbers(self):
        c = self.campaign()
        self.start(c["id"])
        other = H.make_user()
        r = H.client.get(f"/telephony/campaigns/{c['id']}/numbers", headers=H.auth(other))
        self.assertEqual(r.status_code, 404)

    def test_deleting_the_campaign_removes_its_numbers_and_attempts(self):
        c = self.campaign()
        self.start(c["id"])
        self.api("delete", f"/telephony/campaigns/{c['id']}")
        self.assertEqual(supabase.table("campaign_leads").select("id").eq("campaign_id", c["id"]).execute().data, [])
        self.assertEqual(supabase.table("campaign_attempts").select("id").eq("campaign_id", c["id"]).execute().data, [])


class SweepEdgeCases(RetryBase):
    def test_a_contact_removed_from_the_list_is_not_redialed(self):
        c = self.campaign()
        self.start(c["id"])
        self.end_call(self.placed[0], at=T0 + MIN)
        supabase.table("contacts").delete().eq("id", self.contacts[0]["id"]).execute()
        self.assertEqual(self.sweep(T0 + 11 * MIN)["placed"], 0)
        self.assertEqual(supabase.table("campaign_leads").select("id").eq("campaign_id", c["id"]).execute().data, [], "its lead went with it")

    def test_a_contact_moved_to_another_list_is_not_redialed(self):
        c = self.campaign()
        self.start(c["id"])
        self.end_call(self.placed[0], at=T0 + MIN)
        other = supabase.table("lists").insert({"user_id": self.user, "name": "Elsewhere"}).execute().data[0]
        supabase.table("contacts").update({"list_id": other["id"]}).eq("id", self.contacts[0]["id"]).execute()
        res = self.sweep(T0 + 11 * MIN)
        self.assertEqual((res["placed"], res["cancelled"]), (0, 1))
        self.assertEqual(self.lead(c["id"])["final_status"], "not_retried")

    def test_a_number_that_is_now_on_the_dnc_list_is_not_redialed(self):
        c = self.campaign(dnc_screening_enabled=True)
        with patch.object(whitelist_service, "check_number", AsyncMock(return_value={"allowed": True, "reason": None})):
            self.start(c["id"])
        self.end_call(self.placed[0], at=T0 + MIN)
        with patch.object(whitelist_service, "check_number", AsyncMock(return_value={"allowed": False, "reason": "On the DNC list", "suppressed": True})):
            res = self.sweep(T0 + 11 * MIN)
        self.assertEqual((res["placed"], res["suppressed"]), (0, 1))
        lead = self.lead(c["id"])
        self.assertEqual((lead["final_status"], lead["attempts"]), ("do_not_call", 1))
        self.assertEqual(len(self.placed), 1)

    def test_an_empty_wallet_holds_the_redials_back_without_losing_them(self):
        c = self.campaign()
        self.start(c["id"])
        self.end_call(self.placed[0], at=T0 + MIN)
        with patch("routers.telephony.check_call_quota", return_value=False):
            res = self.sweep(T0 + 11 * MIN)
        self.assertEqual((res["placed"], res["waiting"]), (0, 1))
        self.assertIsNotNone(self.lead(c["id"])["next_attempt_at"])
        self.assertEqual(self.sweep(T0 + 12 * MIN)["placed"], 1, "funds are back: it goes out")

    def test_a_campaign_without_an_agent_does_not_break_the_sweep(self):
        c = self.campaign()
        self.start(c["id"])
        self.end_call(self.placed[0], at=T0 + MIN)
        supabase.table("ai_agents").update({"vapi_assistant_id": None}).eq("id", self.agent["id"]).execute()
        self.assertEqual(self.sweep(T0 + 11 * MIN)["placed"], 0)

    def test_one_broken_campaign_does_not_stop_the_others(self):
        other_list = supabase.table("lists").insert({"user_id": self.user, "name": "Other"}).execute().data[0]
        contact = self.add_contacts(1, other_list["id"], prefix="+1555444")[0]
        a, b = self.campaign(), self.campaign(list_id=other_list["id"])
        self.start(a["id"])
        self.start(b["id"])
        self.end_call(self.calls_to(self.contacts[0]["phone"])[0], at=T0 + MIN)
        self.end_call(self.calls_to(contact["phone"])[0], at=T0 + MIN)
        real = call_retry.begin_attempt

        def flaky(camp, contact_row, **kw):
            if camp["id"] == a["id"]:
                raise RuntimeError("database hiccup")
            return real(camp, contact_row, **kw)
        with patch.object(call_retry, "begin_attempt", flaky):
            self.sweep(T0 + 11 * MIN)
        # A's bookkeeping broke, so its call went out untracked; B's was tracked normally
        self.assertEqual(len(self.calls_to(contact["phone"])), 2)
        self.assertEqual(self.lead(b["id"], contact["phone"])["attempts"], 2)

    def test_retries_do_not_change_a_campaign_that_has_them_off(self):
        c = self.campaign(retry_enabled=False)
        self.start(c["id"])
        self.end_call(self.placed[0], at=T0 + MIN)
        lead = self.lead(c["id"])
        self.assertEqual((lead["final_status"], lead["attempts"], lead["next_attempt_at"]), ("not_retried", 1, None))
        self.assertEqual(self.sweep(T0 + 30 * MIN)["placed"], 0)
        self.assertEqual(self.stats(c["id"])["total_attempts"], 1, "attempts are still tracked")


class ReviewFixTests(RetryBase):
    """Bugs found by an independent review of the feature, each pinned down."""

    # ── a screening outage is not a do-not-call ──
    def test_a_dnc_outage_leaves_the_redial_due_instead_of_marking_do_not_call(self):
        c = self.campaign(dnc_screening_enabled=True)
        ok = AsyncMock(return_value={"allowed": True, "reason": None, "source": "api", "suppressed": False})
        with patch.object(whitelist_service, "check_number", ok):
            self.start(c["id"])
        self.end_call(self.placed[0], at=T0 + MIN)
        down = AsyncMock(return_value={"allowed": False, "reason": "DNC screening is unavailable, so the call was not placed.",
                                       "source": "api", "suppressed": False})
        with patch.object(whitelist_service, "check_number", down):
            res = self.sweep(T0 + 11 * MIN)
        self.assertEqual((res["placed"], res["suppressed"], res["waiting"]), (0, 0, 1))
        lead = self.lead(c["id"])
        self.assertIsNone(lead["final_status"], "an outage says nothing about the number")
        self.assertIsNotNone(lead["next_attempt_at"])
        # the provider is back: the very same redial goes out
        with patch.object(whitelist_service, "check_number", ok):
            self.assertEqual(self.sweep(T0 + 12 * MIN)["placed"], 1)

    def test_check_number_marks_only_a_real_verdict_as_a_suppression(self):
        from services.whitelist_service import check_number
        with patch("services.whitelist_service._get_whitelist_config", AsyncMock(return_value=None)):
            self.assertFalse((asyncio.run(check_number(self.user, "+15550001111")))["suppressed"])
        cfg = AsyncMock(return_value={"x": 1})
        with patch("services.whitelist_service._get_whitelist_config", cfg):
            self.assertEqual(asyncio.run(check_number(self.user, "+15550001111", cached=True))["suppressed"], True)
            self.assertEqual(asyncio.run(check_number(self.user, "+15550001111", cached=False))["suppressed"], False)
            with patch("services.whitelist_service._lookup", AsyncMock(return_value=(None, None))):
                r = asyncio.run(check_number(self.user, "+15550002222"))
            self.assertEqual((r["allowed"], r["suppressed"]), (False, False), "an outage")
            with patch("services.whitelist_service._lookup", AsyncMock(return_value=(True, {}))):
                r = asyncio.run(check_number(self.user, "+15550003333"))
            self.assertEqual((r["allowed"], r["suppressed"]), (False, True), "a real listing")
            r = asyncio.run(check_number(self.user, "abc"))
            self.assertEqual((r["allowed"], r["suppressed"]), (False, False), "an unreadable number")

    # ── a call still in progress is never settled ──
    def test_the_manual_sync_importing_a_live_call_does_not_settle_its_number(self):
        c = self.campaign()
        self.start(c["id"])
        call = self.placed[0]
        live = {"id": call, "type": "outboundPhoneCall", "assistantId": self.agent["vapi_assistant_id"],
                "status": "in-progress", "customer": {"number": self.contacts[0]["phone"]}}
        import_vapi_call(live, self.user)
        self.assertIsNone(self.attempts(c["id"])[0]["ended_at"], "still open: the call is still going")
        self.assertIsNone(self.lead(c["id"])["next_attempt_at"])
        # a second call to the same number is still refused while it is on the line
        other_list = supabase.table("lists").insert({"user_id": self.user, "name": "Same"}).execute().data[0]
        supabase.table("contacts").insert({"user_id": self.user, "list_id": other_list["id"], "name": "Same",
                                           "phone": self.contacts[0]["phone"]}).execute()
        self.assertEqual(self.start(self.campaign(list_id=other_list["id"])["id"])["already_on_call"], 1)
        # the real end still settles it
        self.end_call(call, "customer-did-not-answer", at=T0 + 2 * MIN)
        self.assertEqual(self.lead(c["id"])["last_outcome"], "no_answer")

    def test_the_end_of_call_webhook_settles_the_number_even_when_billing_fails(self):
        c = self.campaign()
        self.start(c["id"])
        call = self.placed[0]
        self.at(T0 + 2 * MIN)
        body = Q.end_of_call_body(self.agent["vapi_assistant_id"], call, "customer-ended-call", 45)
        body["message"]["endedAt"] = (T0 + 2 * MIN).strftime("%Y-%m-%dT%H:%M:%S.000Z")
        with patch("routers.webhooks.record_call_cost", side_effect=RuntimeError("billing is down")):
            with self.assertRaises(RuntimeError):
                H.client.post("/webhooks/vapi", json=body)
        lead = self.lead(c["id"])
        self.assertEqual((lead["final_status"], lead["last_outcome"]), ("answered", "answered"),
                         "the person talked: they must not be redialed because billing broke")

    # ── the calling hours are checked before every batch of redials ──
    def test_a_long_sweep_stops_dialing_when_the_hours_close_between_batches(self):
        from services import campaign_scheduler
        zone = "UTC"
        self.add_contacts(3)                                    # four numbers
        c = self.campaign(call_hours_enabled=True, call_hours_timezone=zone, call_hours_days=ALL_DAYS,
                          call_hours_start="09:00", call_hours_end="17:00")
        self.at(local(zone, 2026, 10, 14, 16, 30))
        self.start(c["id"])
        for call in list(self.placed):
            self.end_call(call, at=local(zone, 2026, 10, 14, 16, 40))              # due 16:50, inside the hours
        placed_before = len(self.placed)
        self.at(local(zone, 2026, 10, 14, 16, 59))
        inner = self.create_call.side_effect

        async def slow(payload):
            out = await inner(payload)
            self.at(local(zone, 2026, 10, 14, 17, 0) + timedelta(seconds=30))    # the first batch took until closing time
            return out
        self.create_call.side_effect = slow
        p = patch.object(campaign_scheduler, "datetime", FakeDateTime)
        p.start()
        self.addCleanup(p.stop)
        with patch("routers.telephony.CAMPAIGN_BATCH_SIZE", 2):
            res = asyncio.run(run_retries())                    # no fixed `now`: the clock is read before every batch
        self.assertEqual(len(self.placed) - placed_before, 2, "only the first batch went out")
        self.assertEqual((res["placed"], res["waiting"]), (2, 2))
        waiting = supabase.table("campaign_leads").select("next_attempt_at, attempts").eq("campaign_id", c["id"]).execute().data
        nxt = local(zone, 2026, 10, 15, 9, 0)
        self.assertEqual(sorted(call_retry.parse_time(w["next_attempt_at"]) == nxt for w in waiting if w["attempts"] == 1), [True, True],
                         "the two left over wait for tomorrow's opening")

    # ── a rejected number is not redialed ──
    def test_a_provider_rejecting_the_number_itself_is_final(self):
        c = self.campaign(retry_on=list(call_retry.RETRYABLE))

        async def refuse(payload):
            raise RuntimeError("Bad Request: invalid phone number +1555")
        self.create_call.side_effect = refuse
        data = self.start(c["id"])
        self.assertEqual(data["errors"], 1)
        lead = self.lead(c["id"])
        self.assertEqual((lead["final_status"], lead["last_outcome"], lead["next_attempt_at"]), ("invalid_number", "invalid_number", None))
        self.assertEqual(self.sweep(T0 + 3 * 24 * 60 * MIN)["placed"], 0)

    def test_a_provider_problem_that_is_not_about_the_number_is_still_retried(self):
        for message in ("Invalid API key", "Invalid phoneNumberId", "rate limit exceeded", "connection reset by peer"):
            with self.subTest(message=message):
                self.assertEqual(call_retry.placement_outcome(message), "failed")
        for message in ("invalid phone number", "The number is not a valid phone number", "number is disconnected", "Invalid E.164 number"):
            with self.subTest(message=message):
                self.assertEqual(call_retry.placement_outcome(message), "invalid_number")

    # ── small races ──
    def test_a_redial_cannot_take_a_number_that_was_settled_after_it_was_read(self):
        c = self.campaign()
        self.start(c["id"])
        self.end_call(self.placed[0], at=T0 + MIN)
        stale = self.lead(c["id"])                              # read while it is waiting for its redial
        self.api("patch", f"/telephony/campaigns/{c['id']}", json={"retry_enabled": False})     # cancels the waiting redials
        camp = supabase.table("outbound_campaigns").select("*").eq("id", c["id"]).execute().data[0]
        self.assertIsNone(call_retry.begin_attempt(camp, self.contacts[0], new_round=False, lead=stale))
        self.assertEqual(len(self.attempts(c["id"])), 1, "no attempt row was left behind")

    def test_the_campaign_calls_record_is_kept_even_if_the_call_id_could_not_be_saved_on_the_attempt(self):
        c = self.campaign()
        with patch.object(call_retry, "mark_placed", side_effect=RuntimeError("db hiccup")):
            self.start(c["id"])
        rows = supabase.table("campaign_calls").select("vapi_call_id").eq("campaign_id", c["id"]).execute().data
        self.assertEqual([r["vapi_call_id"] for r in rows], self.placed)

    # ── the stats are for the current round, like the number's own figures ──
    def test_the_stats_are_for_the_current_round_only(self):
        c = self.campaign(retry_max_attempts=2)
        self.start(c["id"])
        self.end_call(self.placed[0], at=T0 + MIN)
        self.assertEqual(self.sweep(T0 + 11 * MIN)["placed"], 1)
        self.end_call(self.placed[1], at=T0 + 12 * MIN)
        self.assertEqual(self.stats(c["id"]), {"total_attempts": 2, "retries_placed": 1, "answered_on_retry": 0,
                                               "max_attempts_reached": 1, "pending_retries": 0, "numbers": 1})
        self.at(T0 + 3 * 24 * 60 * MIN)
        self.start(c["id"])                                     # Start again: a new round for the number
        self.assertEqual(self.stats(c["id"]), {"total_attempts": 1, "retries_placed": 0, "answered_on_retry": 0,
                                               "max_attempts_reached": 0, "pending_retries": 0, "numbers": 1})
        self.assertEqual(len(self.numbers(c["id"])["rows"][0]["history"]), 3, "the earlier round stays in the number's history")


if __name__ == "__main__":
    unittest.main()
