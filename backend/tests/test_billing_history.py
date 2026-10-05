"""
Billing history endpoints must return the account's WHOLE history.

Regression: /billing/call-costs and /billing/transactions were hard-capped at the
latest 50 rows, so the Call Costs table showed 5 pages max and its totals (and the
Overview "Total Call Time") only covered those 50 calls.

Run from the backend folder:  python -m unittest discover -s tests -p "test_billing_history.py" -v
"""
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import qa_harness as h
from qa_harness import client, auth
from database import supabase
from routers import billing

N = 120  # comfortably past the old 50-row cap


class BillingHistoryBase(unittest.TestCase):
    def setUp(self):
        h.reset_rate_limits()
        self.user = h.make_user("bill")

    def seed_calls(self, user=None, n=N, **extra):
        """n calls; call i is i minutes old, costs 0.01*i and lasts 6*i seconds
        (so the OLDEST calls are the most expensive and the old cap would drop them)."""
        now = datetime.now(timezone.utc)
        rows = [{
            "user_id": user or self.user, "channel": "Phone", "status": "Completed",
            "direction": "outbound", "phone": f"+1555000{i:04d}", "contact_name": f"Contact {i}",
            "duration_seconds": 6 * i, "call_cost": round(0.01 * i, 4),
            "call_time": (now - timedelta(minutes=i)).isoformat(), **extra,
        } for i in range(1, n + 1)]
        supabase.table("conversations").insert(rows).execute()

    def call_costs(self, user=None):
        r = client.get("/billing/call-costs", headers=auth(user or self.user))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["data"]

    def seed_ledger(self, kind, n, user=None, start=0):
        now = datetime.now(timezone.utc)
        supabase.table("wallet_transactions").insert([{
            "user_id": user or self.user, "kind": kind, "amount": 20 if kind != "call" else -0.5,
            "description": f"{kind} {i}", "created_at": (now - timedelta(minutes=i)).isoformat(),
        } for i in range(start, start + n)]).execute()


class CallCostsTests(BillingHistoryBase):
    def test_returns_every_call_past_the_old_50_cap(self):
        self.seed_calls()
        d = self.call_costs()
        self.assertEqual(len(d["calls"]), N)
        self.assertEqual(d["total_calls"], N)
        self.assertFalse(d["truncated"])

    def test_newest_first_and_oldest_call_present(self):
        self.seed_calls()
        calls = self.call_costs()["calls"]
        self.assertEqual(calls[0]["contact_name"], "Contact 1")
        self.assertEqual(calls[-1]["contact_name"], f"Contact {N}")  # would have been dropped at 50
        times = [c["created_at"] for c in calls]
        self.assertEqual(times, sorted(times, reverse=True))

    def test_totals_cover_all_calls_not_just_the_first_50(self):
        self.seed_calls()
        d = self.call_costs()
        self.assertAlmostEqual(d["total_cost"], round(0.01 * sum(range(1, N + 1)), 2))        # 72.60
        self.assertAlmostEqual(d["total_minutes"], round(6 * sum(range(1, N + 1)) / 60.0, 1))  # 726.0
        # sanity: the buggy "latest 50" totals were very different
        self.assertNotAlmostEqual(d["total_cost"], round(0.01 * sum(range(1, 51)), 2))

    def test_ui_fields_are_present(self):
        self.seed_calls(n=3)
        c = self.call_costs()["calls"][0]
        for k in ("id", "direction", "phone", "contact_name", "duration_seconds", "call_cost", "status", "created_at"):
            self.assertIn(k, c)
        self.assertEqual(c["created_at"], c["call_time"])

    def test_sample_rows_excluded_from_list_and_totals_but_null_names_kept(self):
        self.seed_calls(n=5)
        supabase.table("conversations").insert([
            {"user_id": self.user, "channel": "Phone", "contact_name": "[SAMPLE] Demo", "duration_seconds": 600, "call_cost": 9.0},
            {"user_id": self.user, "channel": "Phone", "contact_name": None, "duration_seconds": 60, "call_cost": 1.0},
        ]).execute()
        d = self.call_costs()
        names = [c["contact_name"] for c in d["calls"]]
        self.assertNotIn("[SAMPLE] Demo", names)
        self.assertIn(None, names)
        self.assertEqual(d["total_calls"], 6)
        self.assertAlmostEqual(d["total_cost"], round(0.01 * 15 + 1.0, 2))
        self.assertAlmostEqual(d["total_minutes"], round((6 * 15 + 60) / 60.0, 1))

    def test_other_accounts_calls_are_not_included(self):
        self.seed_calls(n=4)
        other = h.make_user("other")
        self.seed_calls(user=other, n=7)
        self.assertEqual(self.call_costs()["total_calls"], 4)
        self.assertEqual(self.call_costs(other)["total_calls"], 7)

    def test_team_member_sees_the_owners_full_history(self):
        self.seed_calls()
        member = h.make_user("member")
        supabase.table("team_members").insert({
            "owner_id": self.user, "member_user_id": member, "member_email": f"m-{h.uuid.uuid4().hex[:8]}@qa.test",
            "role": "member", "status": "Active",
        }).execute()
        self.assertEqual(len(self.call_costs(member)["calls"]), N)

    def test_summary_only_returns_full_totals_without_rows(self):
        self.seed_calls()
        supabase.table("conversations").insert({
            "user_id": self.user, "channel": "Phone", "contact_name": "[SAMPLE] Demo", "duration_seconds": 600, "call_cost": 9.0,
        }).execute()
        r = client.get("/billing/call-costs", params={"summary_only": "true"}, headers=auth(self.user))
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()["data"]
        full = self.call_costs()
        self.assertEqual(d["calls"], [])
        self.assertFalse(d["truncated"])
        for k in ("total_calls", "total_cost", "total_minutes"):
            self.assertEqual(d[k], full[k], k)  # same numbers the table footer / Overview show
        self.assertEqual(d["total_calls"], N)  # [SAMPLE] row excluded here too

    def test_empty_account(self):
        d = self.call_costs()
        self.assertEqual((d["calls"], d["total_calls"], d["total_cost"], d["total_minutes"], d["truncated"]), ([], 0, 0, 0, False))

    def test_safety_ceiling_truncates_the_list_but_never_the_totals(self):
        self.seed_calls()
        with patch.object(billing, "BILLING_LIST_MAX_ROWS", 10):
            d = self.call_costs()
        self.assertEqual(len(d["calls"]), 10)
        self.assertEqual(d["calls"][0]["contact_name"], "Contact 1")  # the newest are the ones kept
        self.assertTrue(d["truncated"])
        self.assertEqual(d["total_calls"], N)
        self.assertAlmostEqual(d["total_cost"], round(0.01 * sum(range(1, N + 1)), 2))

    def test_exactly_at_the_ceiling_is_not_truncated(self):
        self.seed_calls(n=10)
        with patch.object(billing, "BILLING_LIST_MAX_ROWS", 10):
            d = self.call_costs()
        self.assertEqual(len(d["calls"]), 10)
        self.assertFalse(d["truncated"])


class TransactionsTests(BillingHistoryBase):
    def get(self, **params):
        r = client.get("/billing/transactions", params=params, headers=auth(self.user))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["data"]

    def test_purchase_history_returns_everything_and_keeps_the_oldest_entry(self):
        # The welcome-credit row is the OLDEST ledger entry; the Overview checks for it
        # to show the "Welcome credit included" badge, so it must survive past 50 rows.
        self.seed_ledger("topup", N)
        self.seed_ledger("promo", 1, start=N + 5)
        rows = self.get()
        self.assertEqual(len(rows), N + 1)
        self.assertEqual(rows[-1]["kind"], "promo")

    def test_call_charges_are_excluded_unless_requested(self):
        self.seed_ledger("topup", 60)
        self.seed_ledger("call", 70, start=100)
        self.assertEqual(len(self.get()), 60)
        self.assertEqual(len(self.get(include_calls="true")), 130)


if __name__ == "__main__":
    unittest.main()
