"""
Review fixes for the dialing engine. Each test fails without its fix.

  F1  a tick schedules its own wake: Paced above 30 a minute and delays under 2 s are delivered (not half of them)
  F2  the database work of a tick, of a placement and of GET /campaigns/live runs in worker threads; begin_attempt
      never asks the provider
  F3  the wallet is checked only for a campaign that would place a call; a stall notification is not repeated when
      the stall flips on and off around its boundary
  F4  a stale provider_error / provider_limit / screening stall is cleared by Start / Resume and by a placement
  F5  the reconciler settles ended calls concurrently, runs their automations in the background, waits for an
      incomplete record (no cost yet) and rotates its by-id lookups
  F6  a boot after the first runs none of the contacts.seq / NOT NULL / DEFAULT / trigger statements, a half-applied
      migration is reported, and a table lock that cannot be had is skipped (not waited for)

Deterministic like the rest of the engine's tests: an injected clock, mocked provider, no real loops.

Run from the backend folder:  python -m unittest discover -s tests -p "test_dialer_fixes.py" -v
"""
import asyncio
import threading
import time
import unittest
from datetime import timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import psycopg

import migrate
import test_dial_migration as TM
import test_dialing_strategy as TS
from database import supabase
from services import call_retry, dial_limits, dialer, vapi_client, vapi_sync
from test_dial_engine import DialBase, SEC, T0, MIN
from test_timezones import FakeDateTime


class FakeLoop:
    """Stands in for the dispatcher's event loop: records the wakes a tick arms."""

    def __init__(self):
        self.delays = []

    def is_closed(self):
        return False

    def call_soon_threadsafe(self, fn, *args):
        fn(*args)

    def call_later(self, delay, fn):
        self.delays.append(delay)


class WakeBase(DialBase):
    def setUp(self):
        super().setUp()
        self.loop = FakeLoop()
        for name, value in (("_loop", self.loop), ("_wake", MagicMock())):
            p = patch.object(dialer, name, value)
            p.start()
            self.addCleanup(p.stop)

    def simulate(self, cid, seconds, interval=2.0):
        """The dispatcher loop on the injected clock: dispatch, then sleep until the earliest of the loop's interval,
        the wake it planned BEFORE the ticks ran, and the wakes the ticks armed themselves. Returns the placed times."""
        clock = T0
        end = T0 + seconds * SEC
        while clock < end:
            self.at(clock)
            self.loop.delays.clear()
            res = asyncio.run(dialer.dispatch_once(clock, campaign_id=cid, wait=True))
            sleep = interval
            if res.get("wake"):
                sleep = min(sleep, max(0.05, (res["wake"] - clock).total_seconds()))
            for d in self.loop.delays:
                sleep = min(sleep, d)
            clock = clock + timedelta(seconds=sleep)
        return [call_retry.parse_time(a["placed_at"]) for a in self.attempts(cid)]


class F1WakeTests(WakeBase):
    def test_F1_a_tick_arms_a_wake_for_the_next_paced_call(self):
        self.contacts(5)
        c = self.campaign("paced", dial_calls_per_minute=60)
        self.mark_running(c["id"])
        asyncio.run(dialer.tick(c["id"], T0))
        self.assertEqual(len(self.attempts(c["id"])), 1)
        self.assertEqual(len(self.loop.delays), 1, "the tick scheduled the wake itself")
        self.assertAlmostEqual(self.loop.delays[0], 1.0 + dialer.WAKE_SLACK_S, places=3)

    def mark_running(self, cid):
        supabase.table("outbound_campaigns").update(
            {"status": "Active", "dial_running": True, "dial_pass_started_at": call_retry.iso(T0)}).eq("id", cid).execute()

    def test_F1_paced_60_a_minute_places_one_call_a_second(self):
        self.contacts(70)
        c = self.campaign("paced", dial_calls_per_minute=60)
        self.mark_running(c["id"])
        placed = self.simulate(c["id"], 45)
        self.assertGreaterEqual(len(placed), 44, "one a second, not one every two")
        gaps = [(b - a).total_seconds() for a, b in zip(placed, placed[1:])]
        self.assertLess(max(gaps), 1.2)

    def test_F1_paced_40_a_minute_places_one_every_one_and_a_half_seconds(self):
        self.contacts(70)
        c = self.campaign("paced", dial_calls_per_minute=40)
        self.mark_running(c["id"])
        placed = self.simulate(c["id"], 60)
        self.assertIn(len(placed), (40, 41))
        gaps = [(b - a).total_seconds() for a, b in zip(placed, placed[1:])]
        self.assertLess(max(gaps), 1.7)

    def test_F1_a_concurrent_delay_of_one_second_places_one_call_a_second(self):
        self.contacts(30)
        c = self.campaign("concurrent", dial_concurrent_calls=20, dial_delay_seconds=1)
        self.mark_running(c["id"])
        placed = self.simulate(c["id"], 20)
        self.assertGreaterEqual(len(placed), 19, "one a second, not one every two")

    def test_F1_without_the_wake_the_loop_would_deliver_about_half(self):
        """The control: with the ticks' own wakes switched off, the same simulation gives half the calls."""
        self.contacts(70)
        c = self.campaign("paced", dial_calls_per_minute=60)
        self.mark_running(c["id"])
        with patch.object(dialer, "schedule_wake", lambda *a, **k: False):
            placed = self.simulate(c["id"], 45)
        self.assertLessEqual(len(placed), 26)

    def test_F1_no_loop_means_no_wake_and_no_error(self):
        with patch.object(dialer, "_loop", None):
            self.assertFalse(dialer.schedule_wake(T0 + MIN, T0))
        self.assertFalse(dialer.schedule_wake(None, T0))


class F2ThreadTests(DialBase):
    def test_F2_the_gate_and_the_attempt_run_together_off_the_event_loop(self):
        self.contacts(3)
        c = self.campaign("concurrent", dial_concurrent_calls=3)
        seen = {}
        gate, begin = dialer.gate, call_retry.begin_attempt

        def spy_gate(*a, **kw):
            seen["gate"] = threading.current_thread()
            return gate(*a, **kw)

        def spy_begin(*a, **kw):
            seen["begin"] = threading.current_thread()
            seen.setdefault("order", []).append("begin")
            return begin(*a, **kw)
        with patch.object(dialer, "gate", spy_gate), patch.object(call_retry, "begin_attempt", spy_begin):
            self.start(c["id"])
        self.assertIsNot(seen["gate"], threading.main_thread())
        self.assertIs(seen["gate"], seen["begin"], "one unit: the gate and the attempt on the same worker thread")

    def test_F2_the_database_steps_of_a_tick_run_in_worker_threads(self):
        self.contacts(3)
        c = self.campaign("concurrent", dial_concurrent_calls=3)
        threads = {}
        names = ("_setup", "_open_counts", "_pick_fresh", "_save", "_read", "_settle_results")
        originals = {n: getattr(dialer, n) for n in names}

        def spy(name):
            def run(*a, **kw):
                threads.setdefault(name, set()).add(threading.current_thread())
                return originals[name](*a, **kw)
            return run
        patches = [patch.object(dialer, n, spy(n)) for n in names]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.start(c["id"])
        for n in names:
            self.assertIn(n, threads)
            self.assertNotIn(threading.main_thread(), threads[n], f"{n} ran on the event loop")

    def test_F2_begin_attempt_never_asks_the_provider(self):
        self.contacts(1)
        c = self.campaign("sequential")
        with patch.object(call_retry, "reap_stale", wraps=call_retry.reap_stale) as reap:
            self.start(c["id"])
        self.assertTrue(reap.called)
        for call in reap.call_args_list:
            self.assertIs(call.kwargs.get("check_provider"), False)

    def test_F2_the_live_endpoint_runs_in_a_worker_thread(self):
        self.contacts(1)
        c = self.campaign("sequential")
        self.start(c["id"])
        seen = []
        inner = dialer.live_states

        def spy(*a, **kw):
            seen.append(threading.current_thread().name)
            return inner(*a, **kw)
        with patch.object(dialer, "live_states", spy):
            r = self.api("get", "/telephony/campaigns/live")
        self.assertEqual(r.status_code, 200)
        self.assertIn(c["id"], r.json()["data"])
        self.assertTrue(seen and all(n.startswith("asyncio_") for n in seen), f"ran on {seen}")

    def test_F2_a_burst_still_places_the_group_in_order_and_each_number_once(self):
        cs = self.contacts(12)
        c = self.campaign("concurrent", dial_concurrent_calls=12)
        self.start(c["id"])
        self.assertEqual(self.phones(c["id"]), self.keys(cs), "taken in the order the group lists them")
        self.assertEqual(sorted(a["dial_slot"] for a in self.attempts(c["id"])), list(range(1, 13)))


class F3WalletTests(DialBase):
    def notes(self):
        return supabase.table("notifications").select("*").eq("user_id", self.user).eq("kind", "campaign_stalled").execute().data

    def test_F3_a_campaign_at_its_limit_is_never_stalled_over_the_wallet(self):
        self.contacts(6)
        c = self.campaign("concurrent", dial_concurrent_calls=2)
        self.start(c["id"])
        self.assertEqual(self.active(c["id"]), 2)
        poor = MagicMock(return_value=(False, 0.1, 0.35))
        self.at(T0 + 15 * SEC)
        with patch.object(dial_limits, "wallet_covers", poor):
            res = asyncio.run(dialer.tick(c["id"], T0 + 15 * SEC))      # a tick of its own (Start, the 60 s sweep): the dispatcher itself would not serve a full campaign
        poor.assert_not_called()
        row = self.row(c["id"])
        self.assertIsNone(row["dial_stall"])
        self.assertIsNone(row["dial_next_at"], "no 15 s hold")
        self.assertEqual(self.notes(), [])
        self.assertEqual(res.stopped, "open")

    def test_F3_the_wallet_is_still_checked_when_a_call_would_be_placed(self):
        self.contacts(4)
        c = self.campaign("concurrent", dial_concurrent_calls=2)
        with patch.object(dial_limits, "wallet_covers", return_value=(False, 0.1, 0.35)):
            d = self.start(c["id"])
        self.assertEqual(d["dialed"], 0)
        self.assertEqual(self.row(c["id"])["dial_stall"], "balance")

    def test_F3_a_stall_that_flips_around_its_boundary_notifies_once(self):
        self.contacts(12)
        c = self.campaign("concurrent", dial_concurrent_calls=2)
        cid = c["id"]
        poor = patch.object(dial_limits, "wallet_covers", return_value=(False, 0.1, 0.35))
        with poor:
            self.start(cid)
        self.assertEqual(len(self.notes()), 1)
        self.tick(cid, T0 + 20 * SEC)                       # topped up: two calls go out, the stall is gone
        self.assertEqual((self.active(cid), self.row(cid)["dial_stall"]), (2, None))
        self.end(cid, at=T0 + 30 * SEC)
        with poor:
            self.tick(cid, T0 + 31 * SEC)                   # empty again a moment later: the same episode, no second notice
        self.assertEqual(self.row(cid)["dial_stall"], "balance")
        self.assertEqual(len(self.notes()), 1, "not told again within the window")
        self.tick(cid, T0 + 60 * SEC)
        self.end(cid, at=T0 + 700 * SEC)
        with poor:
            self.tick(cid, T0 + 700 * SEC)                  # a new episode long after: told again
        self.assertEqual(len(self.notes()), 2)


class F4StallTests(DialBase):
    def test_F4_resume_clears_a_stale_provider_error_even_when_nothing_is_placed(self):
        self.contacts(3)
        c = self.campaign("sequential")
        cid = c["id"]
        self.start(cid)
        self.assertEqual(self.active(cid), 1)                # the one open call keeps the campaign at its limit
        supabase.table("outbound_campaigns").update({"status": "Paused", "dial_stall": "provider_error"}).eq("id", cid).execute()
        r = self.api("post", f"/telephony/campaigns/{cid}/resume")
        self.assertEqual(r.status_code, 200, r.text)
        row = self.row(cid)
        self.assertEqual(row["status"], "Active")
        self.assertIsNone(row["dial_stall"])

    def test_F4_start_clears_a_stale_provider_error(self):
        self.contacts(3)
        c = self.campaign("concurrent", dial_concurrent_calls=2)
        cid = c["id"]
        supabase.table("outbound_campaigns").update(
            {"status": "Paused", "dial_running": True, "dial_stall": "provider_error",
             "dial_pass_started_at": call_retry.iso(T0)}).eq("id", cid).execute()
        self.start(cid)
        self.assertEqual(self.active(cid), 2)
        self.assertIsNone(self.row(cid)["dial_stall"])

    def stale_then_tick(self, stall):
        self.contacts(2)
        c = self.campaign("sequential")
        cid = c["id"]
        supabase.table("outbound_campaigns").update(
            {"status": "Active", "dial_running": True, "dial_stall": stall,
             "dial_pass_started_at": call_retry.iso(T0)}).eq("id", cid).execute()
        self.tick(cid, T0 + 5 * SEC)
        self.assertEqual(self.active(cid), 1)
        self.assertIsNone(self.row(cid)["dial_stall"])
        live = self.api("get", "/telephony/campaigns/live").json()["data"][cid]
        self.assertNotEqual(live["state"], "stalled")

    def test_F4_a_placed_call_clears_a_stale_provider_limit_stall(self):
        self.stale_then_tick("provider_limit")

    def test_F4_a_placed_call_clears_a_stale_screening_stall(self):
        self.stale_then_tick("screening")


class F5ReconcilerTests(TS.ProviderBase):
    def test_F5a_ended_calls_are_settled_concurrently_but_at_most_five_at_a_time(self):
        self.contacts(8)
        c = self.campaign("concurrent", dial_concurrent_calls=8)
        cid = c["id"]
        self.start(cid)
        self.assertEqual(self.active(cid), 8)
        for call in self.placed:
            self.provider_has(call)
        flight = {"now": 0, "peak": 0}
        inner = self.get_call.side_effect

        async def slow(call_id):
            flight["now"] += 1
            flight["peak"] = max(flight["peak"], flight["now"])
            await asyncio.sleep(0.05)
            flight["now"] -= 1
            return await inner(call_id)
        self.get_call.side_effect = slow
        out = self.reconcile(T0 + 30 * SEC)
        self.assertEqual((out["settled"], self.active(cid)), (8, 0))
        self.assertGreater(flight["peak"], 1, "in parallel")
        self.assertLessEqual(flight["peak"], dialer.RECONCILE_CONCURRENCY)

    def test_F5a_a_slow_post_call_automation_does_not_hold_the_reconciler_back(self):
        self.contacts(3)
        c = self.campaign("concurrent", dial_concurrent_calls=3)
        cid = c["id"]
        self.start(cid)
        for call in self.placed:
            self.provider_has(call)

        async def slow_flow(*a, **kw):
            await asyncio.sleep(0.6)                      # a Flow delay node
        self.autos.side_effect = slow_flow
        self.at(T0 + 30 * SEC)

        async def go():
            began = time.monotonic()
            out = await dialer.reconcile_once(T0 + 30 * SEC)
            took = time.monotonic() - began
            ran_before = self.autos.await_count
            await vapi_sync.drain_background()
            return out, took, ran_before
        out, took, _ = asyncio.run(go())
        self.assertEqual((out["settled"], self.active(cid)), (3, 0), "the slots are free before the automations finish")
        self.assertLess(took, 0.5)
        self.assertEqual(self.autos.await_count, 3, "and each automation still ran exactly once")

    def test_F5b_a_record_without_a_cost_is_not_billed_until_it_is_20_seconds_old(self):
        self.contacts(2)
        c = self.campaign("sequential")
        cid = c["id"]
        self.start(cid)
        call = self.placed[0]
        self.provider_has(call, seconds=25, cost=None)       # ended at T0 + 25 s, the cost not filled in yet
        out = self.reconcile(T0 + 30 * SEC)
        self.assertEqual((out["settled"], out["waiting"], self.active(cid)), (0, 1, 1))
        self.assertEqual(self.conversations(call), [])
        self.assertEqual(supabase.table("wallet_transactions").select("id").eq("ref_id", call).execute().data, [])
        out = self.reconcile(T0 + 44 * SEC)                  # 19 s after the end
        self.assertEqual((out["settled"], out["waiting"]), (0, 1))
        out = self.reconcile(T0 + 45 * SEC)                  # 20 s
        self.assertEqual((out["settled"], out["waiting"], self.active(cid)), (1, 0, 0))
        self.assertEqual(len(supabase.table("wallet_transactions").select("id").eq("ref_id", call).execute().data), 1)

    def test_F5b_a_record_with_its_cost_is_imported_at_once(self):
        self.contacts(2)
        c = self.campaign("sequential")
        self.start(c["id"])
        self.provider_has(self.placed[0], seconds=29, cost=0.07)
        out = self.reconcile(T0 + 30 * SEC)
        self.assertEqual((out["settled"], out["waiting"]), (1, 0))

    def test_F5c_unlisted_calls_are_looked_up_in_turn(self):
        self.contacts(12)
        c = self.campaign("concurrent", dial_concurrent_calls=12)
        cid = c["id"]
        self.start(cid)
        calls = list(self.placed)
        for call in calls:
            self.full[call] = self.record(call, ended=False)      # known to the provider, still going, not in its list
        looked = []

        def asked():
            got = [x.args[0] for x in self.get_call.await_args_list]
            new = got[len(looked):]
            looked.extend(new)
            return new
        out = self.reconcile(T0 + 60 * SEC)
        first = asked()
        self.assertEqual((out["lookups"], len(first)), (10, 10))
        out = self.reconcile(T0 + 65 * SEC)
        second = asked()
        self.assertEqual(sorted(second), sorted(set(calls) - set(first)), "the two never asked about go next, not the same ten")
        out = self.reconcile(T0 + 70 * SEC)
        self.assertEqual((out["lookups"], asked()), (0, []), "all were asked in the last 30 s")
        out = self.reconcile(T0 + 95 * SEC)
        third = asked()
        self.assertEqual(sorted(third), sorted(first), "later the longest-waiting go first again")


class F6MigrationTests(TM.MigrationBase):
    def spy_connect(self, log):
        real = psycopg.connect

        class Spy(psycopg.Cursor):
            def execute(self, query, *a, **kw):
                log.append(str(query))
                return super().execute(query, *a, **kw)
        return lambda url, **kw: real(url, cursor_factory=Spy, **kw)

    def test_F6_a_second_boot_runs_no_dialing_statement_and_no_backfill(self):
        log = []
        backfill = MagicMock()
        with patch.object(migrate, "_backfill_contacts_seq", backfill), \
                patch.object(migrate, "_DIALING_STATEMENTS", [backfill if s is migrate._backfill_contacts_seq else s for s in migrate._DIALING_STATEMENTS]), \
                patch.object(migrate.psycopg, "connect", self.spy_connect(log)):
            migrate.bootstrap_schema()
        backfill.assert_not_called()
        writes = [q for q in log if not q.lstrip().upper().startswith(("SELECT", "SET", "RESET", "SHOW"))]
        noisy = [q for q in writes if ("seq" in q or "dial_" in q) and "dial_cursor" not in q]    # dial_cursor is an older column
        self.assertEqual(noisy, [], "no contacts.seq / SET NOT NULL / SET DEFAULT / trigger / dial_ statement ran")

    def test_F6_the_state_probe_is_one_query_and_says_everything_is_done(self):
        with self.conn() as c:
            state = migrate._dialing_state(c)
        self.assertEqual(state, {"cols": True, "seq": True, "trigger": True, "campaigns": True, "indexes": True, "legacy": False})

    def test_F6_a_half_applied_contacts_seq_is_reported(self):
        with self.conn() as c:
            c.execute("ALTER TABLE public.contacts ALTER COLUMN seq DROP DEFAULT")
            self.assertEqual(migrate.missing_dialing_columns(c), ["contacts.seq (no default)"])
            self.assertFalse(migrate.dialing_ready(c))
            c.execute("ALTER TABLE public.contacts ALTER COLUMN seq DROP NOT NULL")
            self.assertEqual(sorted(migrate.missing_dialing_columns(c)), ["contacts.seq (no default)", "contacts.seq (nullable)"])
            c.execute("ALTER TABLE public.contacts ALTER COLUMN seq SET DEFAULT nextval('public.contacts_seq_seq')")
            self.assertEqual(migrate.missing_dialing_columns(c), ["contacts.seq (nullable)"])

    def test_F6_the_next_boot_repairs_a_half_applied_migration(self):
        with self.conn() as c:
            u = c.execute("INSERT INTO users(email) VALUES ('half@qa.test') RETURNING id").fetchone()[0]
            c.execute("DROP TRIGGER contacts_seq_list_change ON public.contacts")
            c.execute("ALTER TABLE public.contacts ALTER COLUMN seq DROP DEFAULT")
            c.execute("ALTER TABLE public.contacts ALTER COLUMN seq DROP NOT NULL")
            c.execute("INSERT INTO contacts(user_id, name) VALUES (%s, 'no number')", (u,))
            self.assertFalse(migrate._dialing_state(c)["seq"])
        self.upgrade()
        with self.conn() as c:
            self.assertEqual(migrate.missing_dialing_columns(c), [])
            self.assertEqual(c.execute("SELECT count(*) FROM contacts WHERE seq IS NULL").fetchone()[0], 0)
            self.assertEqual(c.execute("SELECT count(*) FROM pg_trigger WHERE tgname = 'contacts_seq_list_change'").fetchone()[0], 1)

    def test_F6_a_table_lock_that_cannot_be_had_is_skipped_with_a_warning_and_retried_next_boot(self):
        with self.conn() as c:
            c.execute("ALTER TABLE public.contacts ALTER COLUMN seq DROP DEFAULT")
        holder = psycopg.connect(self.mig_url)               # a long transaction holding the table
        try:
            holder.execute("LOCK TABLE public.contacts IN ACCESS EXCLUSIVE MODE")
            began = time.monotonic()
            with patch.object(migrate, "_DIALING_LOCK_TIMEOUT", "200ms"), self.assertLogs(migrate.logger, "WARNING") as logs, self.conn() as c:
                migrate._run_dialing_statements(c)
            self.assertLess(time.monotonic() - began, 10, "it did not wait for the lock")
            self.assertTrue(any("skipped" in line and "lock timeout" in line for line in logs.output), logs.output)
            with self.conn() as c:
                self.assertEqual(migrate.missing_dialing_columns(c), ["contacts.seq (no default)"], "still pending")
        finally:
            holder.rollback()
            holder.close()
        self.upgrade()
        with self.conn() as c:
            self.assertEqual(migrate.missing_dialing_columns(c), [])
            self.assertEqual(c.execute("SHOW lock_timeout").fetchone()[0], "0", "a fresh session has no timeout")


if __name__ == "__main__":
    unittest.main()
