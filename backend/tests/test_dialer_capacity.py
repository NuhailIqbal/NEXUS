"""
The pure parts of the dialing engine (services/dialer.py): how many calls fit (capacity), how many start together
(group_size), the Paced grid (paced_next), the back-off after a capacity rejection, the duplicate rule and cursor
of the fresh-number queue, and the live state names. No database, no clock, no network: everything is passed in.

Run from the backend folder:  python -m unittest discover -s tests -p "test_dialer_capacity.py" -v
"""
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from config import settings
from services import dialer

UTC = timezone.utc
T = datetime(2026, 10, 14, 12, 0, 0, tzinfo=UTC)


def row(strategy="concurrent", n=5, per_minute=10, delay=0, next_at=None):
    return {"dial_strategy": strategy, "dial_concurrent_calls": n, "dial_calls_per_minute": per_minute,
            "dial_delay_seconds": delay, "dial_next_at": next_at}


def counts(camp=0, owner=None, platform=None):
    owner = camp if owner is None else owner
    platform = owner if platform is None else platform
    return {"campaign": camp, "owner": owner, "platform": platform}


class CapacityTable(unittest.TestCase):
    """(label, row, counts, limits, last_end) -> (n, reason). Every strategy against open / cap / next_at / last_end."""

    CASES = [
        # ── Sequential: one at a time ──
        ("sequential idle", row("sequential"), counts(0), None, None, (1, None)),
        ("sequential one open", row("sequential"), counts(1), None, None, (0, "open")),
        ("sequential ignores N", row("sequential", n=20), counts(0), None, None, (1, None)),
        ("sequential cap of 1 is no limit", row("sequential"), counts(0, owner=0), {"account_limit": 1}, None, (1, None)),
        ("sequential account full by other campaigns", row("sequential"), counts(0, owner=3), {"account_limit": 3}, None, (0, "account")),
        # Sequential delay: the gap after the previous call ENDS
        ("sequential delay: before", row("sequential", delay=10), counts(0), None, T - timedelta(seconds=9), (0, "spacing")),
        ("sequential delay: exactly", row("sequential", delay=10), counts(0), None, T - timedelta(seconds=10), (1, None)),
        ("sequential delay: long ago", row("sequential", delay=10), counts(0), None, T - timedelta(hours=3), (1, None)),
        ("sequential delay: never called", row("sequential", delay=10), counts(0), None, None, (1, None)),
        ("sequential delay: still open", row("sequential", delay=10), counts(1), None, T - timedelta(seconds=99), (0, "open")),
        # ── Concurrent: keep N open ──
        ("concurrent fills N", row("concurrent", 5), counts(0), None, None, (5, None)),
        ("concurrent refills the gap", row("concurrent", 5), counts(3), None, None, (2, None)),
        ("concurrent full", row("concurrent", 5), counts(5), None, None, (0, "open")),
        ("concurrent over N (N was lowered): a drain", row("concurrent", 3), counts(5), None, None, (0, "open")),
        ("concurrent N=1", row("concurrent", 1), counts(0), None, None, (1, None)),
        ("concurrent N=20", row("concurrent", 20), counts(0), None, None, (20, None)),
        ("concurrent account cap 3", row("concurrent", 5), counts(0), {"account_limit": 3}, None, (3, None)),
        ("concurrent account cap shared with other campaigns", row("concurrent", 5), counts(1, owner=3), {"account_limit": 4}, None, (1, None)),
        ("concurrent account cap reached", row("concurrent", 5), counts(1, owner=3), {"account_limit": 3}, None, (0, "account")),
        ("concurrent platform cap", row("concurrent", 5), counts(0, owner=0, platform=18), {"platform_limit": 20}, None, (2, None)),
        ("concurrent platform full", row("concurrent", 5), counts(0, owner=0, platform=20), {"platform_limit": 20}, None, (0, "platform")),
        ("concurrent both caps: the lower wins", row("concurrent", 10), counts(0, owner=0, platform=0),
         {"account_limit": 4, "platform_limit": 2}, None, (2, None)),
        ("concurrent no cap = N", row("concurrent", 7), counts(0), {"account_limit": None, "platform_limit": None}, None, (7, None)),
        # back-off / spacing held in dial_next_at holds back every strategy
        ("concurrent waiting for dial_next_at", row("concurrent", 5, next_at=(T + timedelta(seconds=3)).isoformat()), counts(0), None, None, (0, "spacing")),
        ("concurrent dial_next_at reached", row("concurrent", 5, next_at=T.isoformat()), counts(0), None, None, (5, None)),
        ("concurrent dial_next_at long past", row("concurrent", 5, next_at=(T - timedelta(hours=1)).isoformat()), counts(0), None, None, (5, None)),
        # ── Paced: one per group, the grid is dial_next_at ──
        ("paced ready", row("paced"), counts(0), None, None, (1, None)),
        ("paced ready with 40 open", row("paced"), counts(40), None, None, (1, None)),
        ("paced safety limit", row("paced"), counts(60), None, None, (0, "open")),
        ("paced waiting for the grid", row("paced", next_at=(T + timedelta(seconds=2.5)).isoformat()), counts(0), None, None, (0, "spacing")),
        ("paced grid reached", row("paced", next_at=T.isoformat()), counts(0), None, None, (1, None)),
        ("paced account cap full", row("paced"), counts(3, owner=3), {"account_limit": 3}, None, (0, "account")),
        ("paced account cap has room", row("paced"), counts(2, owner=2), {"account_limit": 3}, None, (1, None)),
        ("paced platform cap full", row("paced"), counts(0, owner=0, platform=5), {"platform_limit": 5}, None, (0, "platform")),
        # garbage in the row reads as the defaults (never raises)
        ("unknown strategy reads as sequential", row("zigzag"), counts(0), None, None, (1, None)),
    ]

    def test_table(self):
        for label, r, c, limits, last_end, expected in self.CASES:
            with self.subTest(label):
                n, reason, _ = dialer.capacity(r, c, limits, T, last_end)
                self.assertEqual((n, reason), expected)

    def test_the_wake_time_of_a_wait(self):
        nxt = T + timedelta(seconds=3)
        self.assertEqual(dialer.capacity(row("paced", next_at=nxt.isoformat()), counts(0), None, T)[2], nxt)
        ended = T - timedelta(seconds=4)
        self.assertEqual(dialer.capacity(row("sequential", delay=10), counts(0), None, T, ended)[2], ended + timedelta(seconds=10))
        self.assertIsNone(dialer.capacity(row("concurrent", 5), counts(0), None, T)[2])
        self.assertIsNone(dialer.capacity(row("concurrent", 5), counts(5), None, T)[2])

    def test_a_last_end_given_as_text_is_understood(self):
        n, reason, _ = dialer.capacity(row("sequential", delay=10), counts(0), None, T, (T - timedelta(seconds=3)).isoformat())
        self.assertEqual((n, reason), (0, "spacing"))

    def test_the_paced_safety_limit_comes_from_the_settings(self):
        with patch.object(settings, "dialer_paced_max_open", 2):
            self.assertEqual(dialer.capacity(row("paced"), counts(2), None, T)[:2], (0, "open"))
            self.assertEqual(dialer.capacity(row("paced"), counts(1), None, T)[:2], (1, None))


class GroupSize(unittest.TestCase):
    def test_table(self):
        cases = [
            (row("concurrent", 20), 20, 20, 20),
            (row("concurrent", 20), 20, 5, 5),        # CAMPAIGN_BATCH_SIZE patched small: groups of 5
            (row("concurrent", 5), 3, 20, 3),
            (row("concurrent", 5, delay=2), 5, 20, 1),     # a delay: one call per group, each honours its own gap
            (row("sequential"), 1, 20, 1),
            (row("sequential", delay=9), 1, 20, 1),
            (row("paced"), 1, 20, 1),
            (row("paced"), 7, 20, 1),
            (row("concurrent", 5), 0, 20, 0),
            (row("concurrent", 5), -2, 20, 0),
            (row("concurrent", 5), 4, 0, 1),            # a nonsense batch size never yields 0 for a call that fits
        ]
        for r, n, batch, expected in cases:
            with self.subTest(strategy=r["dial_strategy"], n=n, batch=batch):
                self.assertEqual(dialer.group_size(r, n, batch), expected)


class PacedGrid(unittest.TestCase):
    """paced_next: 10/min is EXACTLY 6.000 s apart, with no catch-up burst after a wait."""

    def simulate(self, spacing, ticks, step=1.0, start=T):
        """Run a campaign whose tick fires every `step` seconds; returns the times of the calls placed."""
        nxt, placed, t = None, [], start
        for _ in range(int(ticks / step)):
            if nxt is None or t >= nxt:
                placed.append(t)
                nxt = dialer.paced_next(nxt, t, spacing)
            t += timedelta(seconds=step)
        return placed

    def test_ten_per_minute_is_exactly_six_seconds_for_five_minutes(self):
        placed = self.simulate(6.0, 300)
        self.assertEqual(len(placed), 50)
        gaps = {(b - a).total_seconds() for a, b in zip(placed, placed[1:])}
        self.assertEqual(gaps, {6.0})
        for k in range(0, 241, 60):         # every 60 s window holds 10
            window = [p for p in placed if T + timedelta(seconds=k) <= p < T + timedelta(seconds=k + 60)]
            self.assertEqual(len(window), 10, k)

    def test_a_late_tick_keeps_the_grid_it_is_anchored_on(self):
        # calls due at 0, 6, 12 ...; the tick for the second is 1.7 s late, the next is still due at 12.000
        first = dialer.paced_next(None, T, 6.0)
        self.assertEqual(first, T + timedelta(seconds=6))
        second = dialer.paced_next(first, T + timedelta(seconds=7.7), 6.0)
        self.assertEqual(second, T + timedelta(seconds=12))

    def test_no_drift_over_a_noisy_loop(self):
        # ticks every 2 s with jitter: the calls are late by up to 2 s but the grid never moves
        nxt, t, due = None, T, []
        for i in range(100):
            if nxt is None or t >= nxt:
                due.append(nxt or t)
                nxt = dialer.paced_next(nxt, t, 6.0)
            t += timedelta(seconds=2 + (0.3 if i % 3 == 0 else -0.2))
        steps = {(b - a).total_seconds() for a, b in zip(due, due[1:])}
        self.assertEqual(steps, {6.0})

    def test_a_pause_does_not_cause_a_burst(self):
        nxt = dialer.paced_next(None, T, 6.0)                 # a call at T, the next due at T+6
        later = T + timedelta(minutes=10)                     # the campaign was paused for ten minutes
        after = dialer.paced_next(nxt, later, 6.0)            # the first call after the pause re-anchors...
        self.assertEqual(after, later + timedelta(seconds=6))     # ...so the following one is a full spacing away
        # and exactly one call is due at `later`, not 100
        n, _, _ = dialer.capacity(row("paced", next_at=nxt.isoformat()), counts(0), None, later)
        self.assertEqual(n, 1)
        n, reason, _ = dialer.capacity(row("paced", next_at=after.isoformat()), counts(0), None, later)
        self.assertEqual((n, reason), (0, "spacing"))

    def test_exactly_one_spacing_late_re_anchors(self):
        prev = T
        self.assertEqual(dialer.paced_next(prev, prev + timedelta(seconds=6), 6.0), prev + timedelta(seconds=12))
        self.assertEqual(dialer.paced_next(prev, prev + timedelta(seconds=5.999), 6.0), prev + timedelta(seconds=6))

    def test_other_rates(self):
        for per_minute in (1, 7, 30, 60):
            spacing = 60.0 / per_minute
            with self.subTest(per_minute=per_minute):
                placed = self.simulate(spacing, 600, step=0.25)
                self.assertAlmostEqual(len(placed), per_minute * 10, delta=1)

    def test_a_delay_longer_than_the_rate_wins(self):
        from services import dial_settings
        self.assertEqual(dial_settings.spacing_seconds(row("paced", per_minute=10, delay=20)), 20.0)
        placed = self.simulate(20.0, 600)
        self.assertEqual(len(placed), 30)                         # 3 per minute, not 10
        self.assertEqual(dial_settings.spacing_seconds(row("paced", per_minute=10, delay=2)), 6.0)

    def test_the_first_call_goes_out_at_once(self):
        self.assertEqual(dialer.capacity(row("paced"), counts(0), None, T)[0], 1)


class BackOff(unittest.TestCase):
    def test_doubles_from_30_to_120(self):
        seq, cur = [], 0
        for _ in range(6):
            cur = dialer.backoff_next(cur)
            seq.append(cur)
        self.assertEqual(seq, [30, 60, 120, 120, 120, 120])

    def test_garbage_starts_again(self):
        for junk in (None, "", "x", -5, 0):
            self.assertEqual(dialer.backoff_next(junk), 30, junk)


class FreshQueue(unittest.TestCase):
    def contact(self, seq, phone):
        return {"id": f"c{seq}", "name": f"N{seq}", "phone": phone, "seq": seq}

    def test_a_repeated_number_in_the_batch_is_a_duplicate(self):
        rows = [self.contact(1, "+15551230001"), self.contact(2, "(555) 123-0001"), self.contact(3, "+15551230003")]
        items = dialer.split_fresh(rows, set())
        self.assertEqual([i["dup"] for i in items], [False, True, False])
        self.assertEqual([i["final"] for i in items], [False, True, False], "a duplicate is over at once, the rest wait for their call")

    def test_a_number_already_tried_in_this_pass_is_a_duplicate(self):
        rows = [self.contact(1, "+15551230001"), self.contact(2, "+15551230002")]
        items = dialer.split_fresh(rows, {"5551230002"})
        self.assertEqual([i["dup"] for i in items], [False, True])

    def test_seen_keys_carry_over_between_fetches(self):
        seen = set()
        a = dialer.split_fresh([self.contact(1, "+15551230001")], set(), seen)
        b = dialer.split_fresh([self.contact(2, "+15551230001")], set(), seen)
        self.assertEqual((a[0]["dup"], b[0]["dup"]), (False, True))

    def test_formatting_does_not_hide_a_duplicate(self):
        rows = [self.contact(i, p) for i, p in enumerate(("+1 (555) 123-0001", "5551230001", "1-555-123-0001", "555.123.0001"))]
        self.assertEqual([i["dup"] for i in dialer.split_fresh(rows, set())], [False, True, True, True])

    def test_the_cursor_moves_over_the_contiguous_final_prefix(self):
        items = [{"contact": {"seq": s}, "final": f} for s, f in ((1, True), (2, True), (3, False), (4, True))]
        self.assertEqual(dialer.cursor_prefix(items)["contact"]["seq"], 2)
        self.assertIsNone(dialer.cursor_prefix([{"contact": {"seq": 1}, "final": False}]))
        self.assertEqual(dialer.cursor_prefix([{"contact": {"seq": 1}, "final": True}])["contact"]["seq"], 1)
        self.assertIsNone(dialer.cursor_prefix([]))


class LiveStateNames(unittest.TestCase):
    def test_table(self):
        cases = [
            ({"status": "Active", "dial_running": True}, 3, 0, True, "dialing"),
            ({"status": "Active", "dial_running": True}, 0, 0, False, "waiting_hours"),
            ({"status": "Active", "dial_running": True, "dial_stall": "balance"}, 0, 0, True, "stalled"),
            ({"status": "Active", "dial_running": False}, 2, 0, True, "finishing"),
            ({"status": "Active", "dial_running": False}, 0, 4, True, "waiting_redials"),
            ({"status": "Active", "dial_running": False}, 0, 4, False, "waiting_hours"),
            ({"status": "Active", "dial_running": False}, 0, 0, True, "idle"),
            ({"status": "Paused", "dial_running": True}, 1, 0, True, "paused"),
            ({"status": "Paused", "dial_running": True, "stopped_by_hours_at": "2026-10-14T18:00:00Z", "call_hours_enabled": True},
             0, 0, False, "waiting_hours"),
            ({"status": "Inactive"}, 0, 0, True, "paused"),
        ]
        for r, active, queued, hours_open, expected in cases:
            with self.subTest(expected=expected, row=r):
                self.assertEqual(dialer.live_state_name(r, active, queued, hours_open), expected)


class Nudge(unittest.TestCase):
    def test_a_nudge_without_a_loop_does_nothing(self):
        with patch.object(dialer, "_loop", None), patch.object(dialer, "_wake", None):
            dialer.nudge()          # must not raise

    def test_the_hook_is_registered_exactly_once(self):
        from services import call_retry
        hooks = [h for h in call_retry.attempt_finished_hooks if getattr(h, "__name__", "") == "_on_attempt_finished"]
        self.assertEqual(len(hooks), 1)
        hooks[0]({"id": "x"})       # a hook call with no loop is a no-op


if __name__ == "__main__":
    unittest.main()
