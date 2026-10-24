"""
Account / platform caps on calls open at the same time, the warnings they cause, the detector for the
provider's "no room" rejection and the wallet reserve check (services/dial_limits.py), plus the admin
endpoints that set the caps (routers/admin.py).

Run from the backend folder:  python -m unittest discover -s tests -v
"""
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import byot_harness as H
from database import supabase
from services import dial_limits as dl
from services import vapi_client

UTC = timezone.utc
NOW = datetime(2026, 10, 14, 12, 0, tzinfo=UTC)
PLATFORM_COLS = ("dial_account_default", "dial_platform_max", "dial_learned_cap", "dial_learned_until")


def err(status=None, body="", text=None):
    """A provider error as vapi_client raises it."""
    return vapi_client.VapiAPIError(text if text is not None else f"{status} — {body}", status, body)


class CapacityErrorTests(unittest.TestCase):
    def test_http_429_is_a_capacity_error(self):
        self.assertTrue(dl.is_capacity_error(err(429, "Too Many Requests")))
        self.assertTrue(dl.is_capacity_error(err(429, "")))

    def test_concurrency_wording_is_a_capacity_error(self):
        for text in ("Concurrency limit reached", "You have exceeded your concurrent call limit", "too many calls in progress",
                     "Too Many Calls", "max concurrent calls exceeded"):
            with self.subTest(text=text):
                self.assertTrue(dl.is_capacity_error(err(400, text)), text)
                self.assertTrue(dl.is_capacity_error(Exception(text)), "a plain exception with the text counts too")
                self.assertTrue(dl.is_capacity_error(text), "so does the bare text")

    def test_a_daily_limit_is_not_a_capacity_error_even_with_a_429(self):
        for text in ("Daily outbound call limit reached", "daily call limit exceeded", "Daily limit reached for this number"):
            with self.subTest(text=text):
                self.assertFalse(dl.is_capacity_error(err(429, text)))
                self.assertTrue(dl.is_daily_limit_error(err(400, text)))

    def test_the_bare_word_limit_is_not_enough(self):
        for text in ("Spending limit reached", "rate limit", "limit", "Over the limit", "character limit exceeded"):
            with self.subTest(text=text):
                self.assertFalse(dl.is_capacity_error(err(400, text)))

    def test_other_errors_are_not_capacity_errors(self):
        for e in (err(401, "Invalid key"), err(400, "invalid phone number"), err(500, "boom"), err(404, "assistant not found"),
                  Exception("connection reset"), "timeout"):
            with self.subTest(error=str(e)):
                self.assertFalse(dl.is_capacity_error(e))

    def test_the_body_is_read_as_well_as_the_message(self):
        e = vapi_client.VapiAPIError("400 Bad Request", 400, "Too many calls right now")
        self.assertTrue(dl.is_capacity_error(e))

    def test_an_error_without_a_status_code_attribute_is_handled(self):
        self.assertFalse(dl.is_capacity_error(ValueError("x")))
        self.assertFalse(dl.is_capacity_error(None))


class VapiErrorTests(unittest.TestCase):
    def test_the_error_carries_status_and_body(self):
        class R:
            status_code, reason_phrase, text = 429, "Too Many Requests", "x" * 900
        with self.assertRaises(vapi_client.VapiAPIError) as cm:
            vapi_client._check(R())
        self.assertEqual(cm.exception.status_code, 429)
        self.assertEqual(cm.exception.body, "x" * 500, "the body is cut like the message")
        self.assertTrue(str(cm.exception).startswith("429 Too Many Requests — "))

    def test_a_2xx_response_raises_nothing(self):
        class R:
            status_code, reason_phrase, text = 201, "Created", ""
        vapi_client._check(R())

    def test_an_error_built_by_hand_has_no_status(self):
        e = vapi_client.VapiAPIError("boom")
        self.assertEqual((str(e), e.status_code, e.body), ("boom", None, ""))

    def test_create_call_waits_20_seconds_not_httpx_default(self):
        import asyncio
        captured = {}

        class FakeClient:
            def __init__(self, *a, **kw):
                captured.update(kw)

            async def __aenter__(self):
                return self

            async def __aexit__(self, *a):
                return False

            async def post(self, *a, **kw):
                class R:
                    status_code, reason_phrase, text = 200, "OK", ""

                    def json(self):
                        return {"id": "c1"}
                return R()

        with patch.object(vapi_client.httpx, "AsyncClient", FakeClient):
            self.assertEqual(asyncio.run(vapi_client.create_call({})), {"id": "c1"})
        self.assertEqual(captured.get("timeout"), 20.0)


class CapOfTests(unittest.TestCase):
    def lim(self, a=None, p=None):
        return {"account_limit": a, "account_source": "account" if a else None, "platform_limit": p, "platform_source": "max" if p else None}

    def test_no_limits_is_no_cap(self):
        self.assertEqual(dl.cap_of(None), (None, None))
        self.assertEqual(dl.cap_of({}), (None, None))
        self.assertEqual(dl.cap_of(self.lim()), (None, None))

    def test_the_lowest_applies_and_a_tie_goes_to_the_account(self):
        self.assertEqual(dl.cap_of(self.lim(a=5)), (5, "account"))
        self.assertEqual(dl.cap_of(self.lim(p=8)), (8, "platform"))
        self.assertEqual(dl.cap_of(self.lim(a=5, p=8)), (5, "account"))
        self.assertEqual(dl.cap_of(self.lim(a=9, p=8)), (8, "platform"))
        self.assertEqual(dl.cap_of(self.lim(a=8, p=8)), (8, "account"))


class WarningTests(unittest.TestCase):
    def row(self, strategy, n=5, cpm=10, delay=0):
        return {"dial_strategy": strategy, "dial_concurrent_calls": n, "dial_calls_per_minute": cpm, "dial_delay_seconds": delay}

    def lim(self, a=None, p=None):
        return {"account_limit": a, "account_source": "account" if a else None, "platform_limit": p, "platform_source": "max" if p else None}

    def test_the_exact_texts(self):
        self.assertEqual(dl.warnings_for(self.row("concurrent", 5), self.lim(a=3)),
                         ["Concurrent Calls is set to 5, but your account allows 3 calls at the same time. Calls will run 3 at a time."])
        self.assertEqual(dl.warnings_for(self.row("paced", cpm=10), self.lim(a=3)),
                         ["Your account allows 3 calls at the same time, so this campaign may place fewer than 10 calls per minute."])

    def test_a_platform_cap_is_worded_as_the_platforms(self):
        self.assertEqual(dl.warnings_for(self.row("concurrent", 6), self.lim(p=4)),
                         ["Concurrent Calls is set to 6, but the platform currently allows 4 calls at the same time. Calls will run 4 at a time."])
        self.assertEqual(dl.warnings_for(self.row("paced", cpm=20), self.lim(p=4)),
                         ["The platform currently allows 4 calls at the same time, so this campaign may place fewer than 20 calls per minute."])

    def test_one_call_is_singular(self):
        self.assertEqual(dl.warnings_for(self.row("concurrent", 2), self.lim(a=1)),
                         ["Concurrent Calls is set to 2, but your account allows 1 call at the same time. Calls will run 1 at a time."])

    def test_no_warning_when_nothing_is_capped(self):
        for strategy in ("sequential", "concurrent", "paced"):
            with self.subTest(strategy=strategy):
                self.assertEqual(dl.warnings_for(self.row(strategy), None), [])
                self.assertEqual(dl.warnings_for(self.row(strategy), self.lim()), [])
        self.assertEqual(dl.warnings_for(self.row("concurrent", 5), self.lim(a=5)), [])
        self.assertEqual(dl.warnings_for(self.row("concurrent", 5), self.lim(a=50)), [])
        self.assertEqual(dl.warnings_for(self.row("paced", cpm=10), self.lim(a=10)), [])

    def test_sequential_is_never_warned_about(self):
        self.assertEqual(dl.warnings_for(self.row("sequential"), self.lim(a=1)), [])

    def test_a_row_without_dial_columns_is_sequential_and_quiet(self):
        self.assertEqual(dl.warnings_for({"name": "old"}, self.lim(a=1)), [])

    def test_the_texts_never_name_the_provider(self):
        for strategy in ("concurrent", "paced"):
            for w in dl.warnings_for(self.row(strategy, 9, 30), self.lim(a=2)) + dl.warnings_for(self.row(strategy, 9, 30), self.lim(p=2)):
                self.assertNotRegex(w, r"(?i)vapi|twilio|vonage|telnyx")


class LimitsForTests(unittest.TestCase):
    """The limits as read from the database (billing and the platform_settings row)."""

    def setUp(self):
        rows = supabase.table("platform_settings").select("*").limit(1).execute().data
        if not rows:
            supabase.table("platform_settings").insert({"id": 1}).execute()
            rows = supabase.table("platform_settings").select("*").limit(1).execute().data
        saved = {c: rows[0].get(c) for c in PLATFORM_COLS}
        self.addCleanup(lambda: supabase.table("platform_settings").update(saved).eq("id", 1).execute())
        self.set_platform(None, None, None, None)
        self.u1, self.u2 = H.make_user("lim"), H.make_user("lim")

    def set_platform(self, default, mx, learned, until):
        supabase.table("platform_settings").update({
            "dial_account_default": default, "dial_platform_max": mx, "dial_learned_cap": learned,
            "dial_learned_until": until.isoformat() if until else None}).eq("id", 1).execute()

    def set_account(self, user, cap):
        H.sql("INSERT INTO public.billing (user_id, max_concurrent_calls) VALUES (%s, %s) "
              "ON CONFLICT (user_id) DO UPDATE SET max_concurrent_calls = EXCLUDED.max_concurrent_calls", (user, cap))

    def test_nothing_set_means_no_cap_at_all(self):
        out = dl.limits_for([self.u1, self.u2], NOW)
        for u in (self.u1, self.u2):
            self.assertEqual(out[u], {"account_limit": None, "account_source": None, "platform_limit": None, "platform_source": None})

    def test_an_accounts_own_cap(self):
        self.set_account(self.u1, 3)
        out = dl.limits_for([self.u1, self.u2], NOW)
        self.assertEqual((out[self.u1]["account_limit"], out[self.u1]["account_source"]), (3, "account"))
        self.assertIsNone(out[self.u2]["account_limit"])

    def test_the_platform_default_applies_to_accounts_without_their_own(self):
        self.set_platform(6, None, None, None)
        self.set_account(self.u1, 3)
        out = dl.limits_for([self.u1, self.u2], NOW)
        self.assertEqual((out[self.u1]["account_limit"], out[self.u1]["account_source"]), (3, "account"), "an own cap wins over the default")
        self.assertEqual((out[self.u2]["account_limit"], out[self.u2]["account_source"]), (6, "default"))

    def test_an_own_cap_may_be_higher_than_the_default(self):
        self.set_platform(2, None, None, None)
        self.set_account(self.u1, 9)
        self.assertEqual(dl.limits_for([self.u1], NOW)[self.u1]["account_limit"], 9)

    def test_the_platform_max(self):
        self.set_platform(None, 12, None, None)
        out = dl.limits_for([self.u1], NOW)[self.u1]
        self.assertEqual((out["platform_limit"], out["platform_source"]), (12, "max"))

    def test_a_learned_cap_counts_until_it_expires(self):
        self.set_platform(None, None, 4, NOW + timedelta(minutes=5))
        out = dl.limits_for([self.u1], NOW)[self.u1]
        self.assertEqual((out["platform_limit"], out["platform_source"]), (4, "learned"))
        out = dl.limits_for([self.u1], NOW + timedelta(minutes=5))[self.u1]
        self.assertIsNone(out["platform_limit"], "expired exactly at dial_learned_until")
        out = dl.limits_for([self.u1], NOW + timedelta(hours=1))[self.u1]
        self.assertIsNone(out["platform_limit"])

    def test_the_lower_of_max_and_learned_wins(self):
        self.set_platform(None, 12, 4, NOW + timedelta(minutes=5))
        out = dl.limits_for([self.u1], NOW)[self.u1]
        self.assertEqual((out["platform_limit"], out["platform_source"]), (4, "learned"))
        self.set_platform(None, 3, 8, NOW + timedelta(minutes=5))
        out = dl.limits_for([self.u1], NOW)[self.u1]
        self.assertEqual((out["platform_limit"], out["platform_source"]), (3, "max"))

    def test_zero_and_garbage_caps_mean_no_cap(self):
        self.set_platform(0, 0, None, None)
        self.set_account(self.u1, 0)
        out = dl.limits_for([self.u1], NOW)[self.u1]
        self.assertEqual((out["account_limit"], out["platform_limit"]), (None, None))

    def test_the_account_and_platform_caps_combine_through_cap_of(self):
        self.set_platform(None, 5, None, None)
        self.set_account(self.u1, 8)
        self.assertEqual(dl.cap_of(dl.limits_for([self.u1], NOW)[self.u1]), (5, "platform"))
        self.set_account(self.u1, 2)
        self.assertEqual(dl.cap_of(dl.limits_for([self.u1], NOW)[self.u1]), (2, "account"))

    def test_duplicates_and_blanks_in_the_owner_list_are_tolerated(self):
        out = dl.limits_for([self.u1, self.u1, "", None], NOW)
        self.assertEqual(list(out), [self.u1])
        self.assertEqual(dl.limits_for([], NOW), {})

    def test_a_failing_read_means_no_cap_not_an_error(self):
        with patch.object(dl, "supabase") as sb, self.assertLogs(dl.logger, "WARNING"):
            sb.table.side_effect = RuntimeError("db down")
            out = dl.limits_for([self.u1], NOW)
        self.assertEqual(out[self.u1]["account_limit"], None)
        self.assertEqual(out[self.u1]["platform_limit"], None)


class WalletReserveTests(unittest.TestCase):
    def setUp(self):
        dl.forget_balance()
        self.addCleanup(dl.forget_balance)
        from routers import billing
        self.billing = billing
        self.balance = 1.0
        self.reads = 0

        def get_balance(user):
            self.reads += 1
            return self.balance
        p1 = patch.object(billing, "get_balance", get_balance)
        p2 = patch.object(billing, "get_or_create_billing", lambda user: {"rate_per_minute": 0.35})
        p1.start()
        p2.start()
        self.addCleanup(p1.stop)
        self.addCleanup(p2.stop)

    def test_one_more_call_needs_one_minute_of_cost_per_open_call_plus_one(self):
        # 0.35 a minute: (open + 1) * 0.35
        self.balance = 0.35
        self.assertEqual(dl.wallet_covers("o", 0, NOW), (True, 0.35, 0.35))
        ok, bal, needed = dl.wallet_covers("o", 1, NOW + timedelta(minutes=1))
        self.assertEqual((ok, round(needed, 2)), (False, 0.7))
        self.balance = 1.75
        self.assertTrue(dl.wallet_covers("o", 4, NOW + timedelta(minutes=2))[0], "5 * 0.35 = 1.75 is exactly enough")
        self.assertFalse(dl.wallet_covers("o", 5, NOW + timedelta(minutes=3))[0])

    def test_the_reserve_follows_the_setting(self):
        from config import settings
        self.balance = 1.0
        with patch.object(settings, "dial_reserve_minutes", 3.0):
            self.assertEqual(dl.wallet_covers("o", 0, NOW)[2], 1.05)
            self.assertFalse(dl.wallet_covers("o", 1, NOW + timedelta(minutes=1))[0])

    def test_the_balance_is_cached_for_15_seconds(self):
        dl.wallet_covers("o", 0, NOW)
        dl.wallet_covers("o", 3, NOW + timedelta(seconds=14))
        self.assertEqual(self.reads, 1)
        dl.wallet_covers("o", 0, NOW + timedelta(seconds=15))
        self.assertEqual(self.reads, 2)

    def test_a_top_up_is_seen_at_once_after_forgetting(self):
        self.balance = 0.1
        self.assertFalse(dl.wallet_covers("o", 0, NOW)[0])
        self.balance = 5.0
        self.assertFalse(dl.wallet_covers("o", 0, NOW + timedelta(seconds=1))[0], "still the cached figure")
        dl.forget_balance("o")
        self.assertTrue(dl.wallet_covers("o", 0, NOW + timedelta(seconds=2))[0])

    def test_accounts_are_cached_separately(self):
        dl.wallet_covers("a", 0, NOW)
        dl.wallet_covers("b", 0, NOW)
        self.assertEqual(self.reads, 2)

    def test_a_memo_pins_the_figure_for_one_tick(self):
        memo = {}
        dl.wallet_covers("o", 0, NOW, memo)
        self.balance = 0.0
        dl.forget_balance()
        self.assertTrue(dl.wallet_covers("o", 0, NOW + timedelta(seconds=60), memo)[0])
        self.assertEqual(self.reads, 1)

    def test_an_unreadable_balance_counts_as_enough(self):
        with patch.object(self.billing, "get_balance", side_effect=RuntimeError("db")), self.assertLogs(dl.logger, "WARNING"):
            self.assertEqual(dl.wallet_covers("zz", 0, NOW), (True, 0.0, 0.0))


class AdminCapTests(unittest.TestCase):
    """The admin endpoints that set the caps (header X-Admin-Auth)."""

    def setUp(self):
        from jose import jwt
        from config import settings
        now = int(datetime.now(UTC).timestamp())
        token = jwt.encode({"sub": "qa-admin", "adm": True, "iat": now, "exp": now + 3600}, settings.active_jwt_secret, algorithm="HS256")
        self.headers = {"X-Admin-Auth": token}
        self.user = H.make_user("adm")
        rows = supabase.table("platform_settings").select("*").limit(1).execute().data
        if not rows:
            supabase.table("platform_settings").insert({"id": 1}).execute()
            rows = supabase.table("platform_settings").select("*").limit(1).execute().data
        saved = {c: rows[0].get(c) for c in ("dial_account_default", "dial_platform_max")}
        self.addCleanup(lambda: supabase.table("platform_settings").update(saved).eq("id", 1).execute())

    def patch_user(self, body):
        return H.client.patch(f"/admin/users/{self.user}", json=body, headers=self.headers)

    def patch_settings(self, body):
        return H.client.patch("/admin/settings", json=body, headers=self.headers)

    def cap(self):
        rows = supabase.table("billing").select("max_concurrent_calls").eq("user_id", self.user).execute().data
        return rows[0]["max_concurrent_calls"] if rows else "no row"

    def test_set_change_and_clear_an_accounts_cap(self):
        r = self.patch_user({"max_concurrent_calls": 4})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["data"]["max_concurrent_calls"], 4)
        self.assertEqual(self.cap(), 4)
        self.patch_user({"max_concurrent_calls": 9})
        self.assertEqual(self.cap(), 9)
        r = self.patch_user({"max_concurrent_calls": None})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIsNone(self.cap(), "null clears it")

    def test_an_edit_that_does_not_mention_the_cap_leaves_it(self):
        self.patch_user({"max_concurrent_calls": 4})
        r = self.patch_user({"rate_per_minute": 0.4})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.cap(), 4)

    def test_a_cap_below_one_is_refused(self):
        self.patch_user({"max_concurrent_calls": 4})
        for bad in (0, -3):
            r = self.patch_user({"max_concurrent_calls": bad})
            self.assertEqual(r.status_code, 400, r.text)
        self.assertEqual(self.cap(), 4)
        for bad in (True, 2.5, "x"):
            self.assertEqual(self.patch_user({"max_concurrent_calls": bad}).status_code, 422, bad)
        self.assertEqual(self.cap(), 4)

    def test_only_a_null_cap_alone_is_not_an_empty_update(self):
        r = self.patch_user({"max_concurrent_calls": None})
        self.assertIsNone(r.json()["error"], "setting it to null is a real edit")

    def test_the_users_list_shows_the_cap(self):
        self.patch_user({"max_concurrent_calls": 7})
        rows = H.client.get("/admin/users", headers=self.headers).json()["data"]
        mine = [u for u in rows if u["id"] == self.user][0]
        self.assertEqual(mine["max_concurrent_calls"], 7)

    def test_platform_caps_set_and_clear(self):
        r = self.patch_settings({"dial_account_default": 6, "dial_platform_max": 15})
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()["data"]
        self.assertEqual((d["dial_account_default"], d["dial_platform_max"]), (6, 15))
        r = self.patch_settings({"dial_account_default": None})
        d = r.json()["data"]
        self.assertEqual((d["dial_account_default"], d["dial_platform_max"]), (None, 15))
        self.assertEqual(self.patch_settings({"dial_platform_max": 0}).status_code, 400)
        self.assertEqual(self.patch_settings({"dial_platform_max": -1}).status_code, 400)

    def test_the_promo_controls_still_work_alongside(self):
        before = self.patch_settings({}).json()["data"]
        r = self.patch_settings({"promo_expiry_days": before["promo_expiry_days"]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["data"]["dial_platform_max"], before["dial_platform_max"])


if __name__ == "__main__":
    unittest.main()
