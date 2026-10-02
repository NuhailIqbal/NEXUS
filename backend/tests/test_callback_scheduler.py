import asyncio
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import qa_harness as h
from database import supabase
from services import callback_scheduler as sched
from services import callback_service as cbs
from services import vapi_client, whitelist_service

UTC = timezone.utc
NOW = datetime(2026, 10, 5, 10, 0, tzinfo=UTC)           # Monday 10:00 UTC, inside 09:00-18:00


def run(coro):
    return asyncio.run(coro)


class Base(unittest.TestCase):
    def setUp(self):
        # A sweep looks at every account, so leftovers from other tests would be swept too.
        h.sql("delete from callbacks")
        h.sql("delete from callback_settings")
        self.user = h.make_user()
        cbs.save_settings(self.user, {"auto_call": True})
        supabase.table("billing").insert({"user_id": self.user, "status": "active", "is_active": True, "balance": 10}).execute()
        self.agent = supabase.table("ai_agents").insert({"user_id": self.user, "name": "Sara", "vapi_assistant_id": "asst-sara"}).execute().data[0]
        self.create_call = AsyncMock(return_value={"id": "call_new_1"})
        self.dnc = AsyncMock(return_value={"allowed": True, "reason": None})
        self.patches = [patch.object(vapi_client, "create_call", self.create_call),
                        patch.object(whitelist_service, "check_number", self.dnc)]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def cb(self, minutes=-5, user=None, **kw):
        row = {"user_id": user or self.user, "agent_id": self.agent["id"], "phone": "+15551230001",
               "due_at": (NOW + timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%SZ"), "timezone": "UTC", **kw}
        return supabase.table("callbacks").insert(row).execute().data[0]

    def get(self, cb_id):
        return supabase.table("callbacks").select("*").eq("id", cb_id).single().execute().data

    def sweep(self, now=NOW):
        return run(sched.run_due_callbacks(now))


class Placing(Base):
    def test_X01_nothing_happens_unless_the_account_turned_auto_calling_on(self):
        cbs.save_settings(self.user, {"auto_call": False})
        c = self.cb()
        self.assertEqual(self.sweep(), {"called": 0, "deferred": 0, "skipped": 0, "failed": 0, "retry": 0})
        self.assertEqual(self.get(c["id"])["status"], "pending")
        self.create_call.assert_not_awaited()

    def test_X02_a_new_account_never_auto_calls(self):
        other = h.make_user()                      # no settings row at all
        c = self.cb(user=other)
        self.sweep()
        self.assertEqual(self.get(c["id"])["status"], "pending")
        self.create_call.assert_not_awaited()

    def test_X03_places_the_call_to_the_caller_with_the_right_agent(self):
        c = self.cb()
        self.assertEqual(self.sweep()["called"], 1)
        self.create_call.assert_awaited_once()
        payload = self.create_call.await_args.args[0]
        self.assertEqual((payload["assistantId"], payload["customer"]["number"]), ("asst-sara", "+15551230001"))
        row = self.get(c["id"])
        self.assertEqual((row["status"], row["attempts"], row["placed_call_id"], row["last_error"]), ("called", 1, "call_new_1", None))

    def test_X04_uses_the_accounts_caller_id_number_and_skips_stale_ones(self):
        # the newest number is tried first, so make the stale one the newest
        for i, vid in enumerate(("good-1", "stale-1")):
            supabase.table("phone_numbers").insert({"user_id": self.user, "number": f"+1555000000{i}", "status": "Active", "vapi_phone_id": vid}).execute()

        async def fake(payload):
            if payload.get("phoneNumberId") == "good-1":
                return {"id": "ok"}
            raise RuntimeError("Phone number does not exist")
        self.create_call.side_effect = fake
        c = self.cb()
        self.assertEqual(self.sweep()["called"], 1)
        self.assertEqual(self.get(c["id"])["placed_call_id"], "ok")
        self.assertGreaterEqual(self.create_call.await_count, 2)

    def test_X05_not_due_yet_is_left_alone(self):
        c = self.cb(minutes=+30)
        self.sweep()
        self.assertEqual(self.get(c["id"])["status"], "pending")
        self.create_call.assert_not_awaited()

    def test_X06_exactly_due_is_placed(self):
        c = self.cb(minutes=0)
        self.assertEqual(self.sweep()["called"], 1)

    def test_X07_running_twice_calls_once(self):
        c = self.cb()
        self.sweep()
        self.sweep()
        self.assertEqual(self.create_call.await_count, 1)

    def test_X08_only_pending_callbacks_are_touched(self):
        rows = [self.cb(status=s, phone=f"+1555000000{i}") for i, s in enumerate(("calling", "called", "cancelled", "failed", "skipped"))]
        self.sweep()
        self.create_call.assert_not_awaited()
        self.assertEqual([self.get(r["id"])["status"] for r in rows], ["calling", "called", "cancelled", "failed", "skipped"])

    def test_X09_only_accounts_with_auto_calling_are_processed(self):
        other = h.make_user()
        supabase.table("ai_agents").insert({"user_id": other, "name": "X", "vapi_assistant_id": "asst-x"})
        theirs = self.cb(user=other)
        mine = self.cb()
        self.sweep()
        self.assertEqual(self.get(theirs["id"])["status"], "pending")
        self.assertEqual(self.get(mine["id"])["status"], "called")

    def test_X10_earliest_due_goes_first(self):
        late = self.cb(minutes=-1, phone="+15550000001")
        early = self.cb(minutes=-90, phone="+15550000002")
        with patch.object(sched, "BATCH", 1):
            self.sweep()
        self.assertEqual(self.get(early["id"])["status"], "called")
        self.assertEqual(self.get(late["id"])["status"], "pending")

    def test_X11_batch_limit_leaves_the_rest_for_the_next_sweep(self):
        rows = [self.cb(phone=f"+1555000100{i}") for i in range(3)]
        with patch.object(sched, "BATCH", 2):
            self.assertEqual(self.sweep()["called"], 2)
            self.assertEqual(self.sweep()["called"], 1)
        self.assertTrue(all(self.get(r["id"])["status"] == "called" for r in rows))


class CallingHours(Base):
    def test_H01_outside_hours_is_postponed_not_called_and_not_counted(self):
        early = datetime(2026, 10, 5, 7, 0, tzinfo=UTC)                           # before 09:00
        c = self.cb(minutes=-200)
        r = self.sweep(early)
        self.assertEqual(r["deferred"], 1)
        row = self.get(c["id"])
        self.assertEqual((row["status"], row["attempts"]), ("pending", 0))
        self.assertEqual(datetime.fromisoformat(row["due_at"]), datetime(2026, 10, 5, 9, 0, tzinfo=UTC))
        self.assertIn("calling hours", row["last_error"])
        self.create_call.assert_not_awaited()

    def test_H02_it_goes_out_once_the_window_opens(self):
        c = self.cb(minutes=-200)
        self.sweep(datetime(2026, 10, 5, 7, 0, tzinfo=UTC))
        self.assertEqual(self.sweep(datetime(2026, 10, 5, 9, 0, tzinfo=UTC))["called"], 1)

    def test_H03_boundaries(self):
        self.cb(minutes=-500)
        self.assertEqual(self.sweep(datetime(2026, 10, 5, 18, 0, tzinfo=UTC))["deferred"], 1)       # closing minute is out
        c2 = self.cb(minutes=-500, phone="+15559990000")
        self.assertEqual(self.sweep(datetime(2026, 10, 5, 17, 59, tzinfo=UTC))["called"], 1)

    def test_H04_evening_and_weekends_move_to_the_next_opening(self):
        c = self.cb(minutes=-1000)
        self.sweep(datetime(2026, 10, 9, 19, 0, tzinfo=UTC))                       # Friday night
        self.assertEqual(datetime.fromisoformat(self.get(c["id"])["due_at"]), datetime(2026, 10, 12, 9, 0, tzinfo=UTC))

    def test_H05_hours_are_in_the_accounts_timezone(self):
        cbs.save_settings(self.user, {"timezone": "Asia/Karachi"})
        c = self.cb(minutes=-1000)
        self.assertEqual(self.sweep(datetime(2026, 10, 5, 10, 0, tzinfo=UTC))["called"], 1)       # 15:00 in Karachi
        c2 = self.cb(minutes=-1000, phone="+15558880000")
        self.assertEqual(self.sweep(datetime(2026, 10, 5, 14, 0, tzinfo=UTC))["deferred"], 1)     # 19:00 in Karachi
        self.assertEqual(datetime.fromisoformat(self.get(c2["id"])["due_at"]), datetime(2026, 10, 6, 4, 0, tzinfo=UTC))   # 09:00 Karachi

    def test_H06_wider_hours_in_settings_are_respected(self):
        cbs.save_settings(self.user, {"start_time": "06:00", "end_time": "22:00", "default_time": "10:00"})
        c = self.cb(minutes=-1000)
        self.assertEqual(self.sweep(datetime(2026, 10, 5, 20, 0, tzinfo=UTC))["called"], 1)


class Safeguards(Base):
    def test_G01_no_phone_number_is_skipped(self):
        c = self.cb(phone=None)
        self.assertEqual(self.sweep()["skipped"], 1)
        row = self.get(c["id"])
        self.assertEqual(row["status"], "skipped")
        self.assertIn("No phone number", row["last_error"])
        self.create_call.assert_not_awaited()

    def test_G02_do_not_call_numbers_are_never_called(self):
        self.dnc.return_value = {"allowed": False, "reason": "dnc"}
        c = self.cb()
        self.assertEqual(self.sweep()["skipped"], 1)
        self.assertIn("do-not-call", self.get(c["id"])["last_error"])
        self.create_call.assert_not_awaited()

    def test_G03_if_the_dnc_check_itself_breaks_no_call_is_placed(self):
        self.dnc.side_effect = RuntimeError("provider down")
        c = self.cb()
        self.assertEqual(self.sweep()["retry"], 1)
        self.create_call.assert_not_awaited()
        self.assertEqual(self.get(c["id"])["status"], "pending")

    def test_G04_an_empty_wallet_blocks_the_call(self):
        supabase.table("billing").update({"balance": 0}).eq("user_id", self.user).execute()
        c = self.cb()
        self.assertEqual(self.sweep()["failed"], 1)
        row = self.get(c["id"])
        self.assertEqual(row["status"], "failed")
        self.assertIn("wallet", row["last_error"].lower())
        self.create_call.assert_not_awaited()

    def test_G05_trial_or_past_due_accounts_are_blocked(self):
        for st in ("trial", "past_due", "canceled"):
            supabase.table("billing").update({"status": st}).eq("user_id", self.user).execute()
            c = self.cb(phone=f"+1555{st[:3].encode().hex()[:6]}")
            self.assertEqual(self.sweep()["failed"], 1, st)
            self.assertEqual(self.get(c["id"])["status"], "failed", st)
        self.create_call.assert_not_awaited()

    def test_G06_a_deactivated_account_is_blocked(self):
        supabase.table("billing").update({"is_active": False}).eq("user_id", self.user).execute()
        c = self.cb()
        self.sweep()
        self.assertEqual(self.get(c["id"])["status"], "failed")
        self.create_call.assert_not_awaited()

    def test_G07_blocked_callbacks_can_be_rescheduled_after_topping_up(self):
        supabase.table("billing").update({"balance": 0}).eq("user_id", self.user).execute()
        c = self.cb()
        self.sweep()
        supabase.table("billing").update({"balance": 10}).eq("user_id", self.user).execute()
        cbs.reschedule(self.user, c["id"], (datetime.now(UTC) + timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M"))
        self.assertEqual(self.get(c["id"])["status"], "pending")

    def test_G08_the_agent_must_still_exist_and_be_callable(self):
        gone = self.cb(agent_id=None, phone="+15550000011")
        no_vapi = supabase.table("ai_agents").insert({"user_id": self.user, "name": "NoVapi"}).execute().data[0]
        bad = self.cb(agent_id=no_vapi["id"], phone="+15550000012")
        r = self.sweep()
        self.assertEqual(r["failed"], 2)
        self.assertEqual((self.get(gone["id"])["status"], self.get(bad["id"])["status"]), ("failed", "failed"))
        self.assertEqual(self.get(bad["id"])["attempts"], 1)          # no pointless retries
        self.create_call.assert_not_awaited()

    def test_G09_another_accounts_agent_cannot_be_used(self):
        other = h.make_user()
        theirs = supabase.table("ai_agents").insert({"user_id": other, "name": "Theirs", "vapi_assistant_id": "asst-theirs"}).execute().data[0]
        c = self.cb(agent_id=theirs["id"])
        self.sweep()
        self.assertEqual(self.get(c["id"])["status"], "failed")
        self.create_call.assert_not_awaited()


class Retries(Base):
    def test_Y01_a_failed_attempt_is_retried_after_the_delay(self):
        self.create_call.side_effect = RuntimeError("VAPI 500")
        c = self.cb()
        self.assertEqual(self.sweep()["retry"], 1)
        row = self.get(c["id"])
        self.assertEqual((row["status"], row["attempts"]), ("pending", 1))
        self.assertEqual(datetime.fromisoformat(row["due_at"]), NOW + timedelta(minutes=30))
        self.assertIn("VAPI 500", row["last_error"])

    def test_Y02_it_gives_up_at_the_attempt_limit(self):
        self.create_call.side_effect = RuntimeError("VAPI 500")
        c = self.cb()
        self.sweep()
        self.assertEqual(self.sweep(NOW + timedelta(minutes=31))["failed"], 1)
        row = self.get(c["id"])
        self.assertEqual((row["status"], row["attempts"]), ("failed", 2))
        before = self.create_call.await_count
        self.sweep(NOW + timedelta(hours=5))
        self.assertEqual(self.create_call.await_count, before)           # a failed callback is not retried again

    def test_Y03_retry_that_succeeds(self):
        self.create_call.side_effect = [RuntimeError("blip"), {"id": "call_2"}]
        c = self.cb()
        self.sweep()
        self.assertEqual(self.sweep(NOW + timedelta(minutes=31))["called"], 1)
        row = self.get(c["id"])
        self.assertEqual((row["status"], row["attempts"], row["placed_call_id"]), ("called", 2, "call_2"))

    def test_Y04_retry_delay_and_limit_come_from_settings(self):
        cbs.save_settings(self.user, {"retry_minutes": 90, "max_attempts": 3})
        self.create_call.side_effect = RuntimeError("down")
        c = self.cb()
        self.sweep()
        self.assertEqual(datetime.fromisoformat(self.get(c["id"])["due_at"]), NOW + timedelta(minutes=90))
        self.sweep(NOW + timedelta(minutes=91))
        self.assertEqual(self.get(c["id"])["status"], "pending")          # attempt 2 of 3 -> still going

    def test_Y05_a_retry_outside_calling_hours_waits_for_the_window(self):
        self.create_call.side_effect = RuntimeError("down")
        c = self.cb()
        self.sweep(datetime(2026, 10, 5, 17, 45, tzinfo=UTC))             # retry lands at 18:15
        self.sweep(datetime(2026, 10, 5, 18, 16, tzinfo=UTC))
        row = self.get(c["id"])
        self.assertEqual((row["status"], row["attempts"]), ("pending", 1))
        self.assertEqual(datetime.fromisoformat(row["due_at"]), datetime(2026, 10, 6, 9, 0, tzinfo=UTC))


class Robustness(Base):
    def test_Z01_a_crash_never_leaves_a_callback_stuck_calling(self):
        c = self.cb()
        with patch.object(sched, "_dispatch", side_effect=RuntimeError("boom")):
            self.assertEqual(self.sweep()["failed"], 1)
        row = self.get(c["id"])
        self.assertEqual(row["status"], "failed")
        self.assertIn("Unexpected error", row["last_error"])

    def test_Z02_one_bad_callback_does_not_stop_the_others(self):
        bad = self.cb(phone="+15550000020", minutes=-30)
        good = self.cb(phone="+15550000021", minutes=-10)
        orig = sched._dispatch

        async def flaky(cb, s, now):
            if cb["id"] == bad["id"]:
                raise RuntimeError("boom")
            return await orig(cb, s, now)
        with patch.object(sched, "_dispatch", flaky):
            r = self.sweep()
        self.assertEqual((r["failed"], r["called"]), (1, 1))

    def test_Z03_two_workers_cannot_both_claim_one_callback(self):
        c = self.cb()
        self.assertEqual((sched._claim(c["id"]), sched._claim(c["id"])), (True, False))
        self.assertEqual(self.get(c["id"])["status"], "calling")

    def test_Z03b_a_callback_that_is_no_longer_pending_cannot_be_claimed(self):
        for i, st in enumerate(("called", "cancelled", "failed", "skipped", "calling")):
            c = self.cb(status=st, phone=f"+1555000990{i}")
            self.assertFalse(sched._claim(c["id"]), st)
            self.assertEqual(self.get(c["id"])["status"], st)

    def test_Z03c_a_sweep_that_lost_the_claim_places_no_call(self):
        self.cb()
        with patch.object(sched, "_claim", return_value=False):
            self.assertEqual(self.sweep(), {"called": 0, "deferred": 0, "skipped": 0, "failed": 0, "retry": 0})
        self.create_call.assert_not_awaited()

    def test_Z04_the_background_loop_runs_a_sweep_and_survives_errors(self):
        calls = {"n": 0}

        async def fake_run():
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("transient")
            return {"called": 0}

        async def fake_sleep(_):
            if calls["n"] >= 2:
                raise asyncio.CancelledError()

        async def go():
            with patch.object(sched, "run_due_callbacks", fake_run), patch.object(sched.asyncio, "sleep", fake_sleep):
                with self.assertRaises(asyncio.CancelledError):
                    await sched.callback_loop()
        run(go())
        self.assertEqual(calls["n"], 2)             # kept going after the first sweep failed

    def test_Z05_empty_database_is_fine(self):
        cbs.save_settings(self.user, {"auto_call": False})
        supabase.table("callback_settings").update({"auto_call": False}).execute()
        self.assertEqual(self.sweep(), {"called": 0, "deferred": 0, "skipped": 0, "failed": 0, "retry": 0})


if __name__ == "__main__":
    unittest.main()
