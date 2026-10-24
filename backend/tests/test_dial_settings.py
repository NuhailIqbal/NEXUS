"""
Dialing strategy settings (services/dial_settings.py) and the campaign API that carries them
(routers/telephony.py create / update / read, models/schemas.py).

Pure functions first (validation, describe, effective), then the HTTP behaviour: defaults for a new
campaign, a bad value answers 400 with a message, a partial update merges over what is stored, a list
change ends the open pass, and the engine's own columns never reach a response.

Run from the backend folder:  python -m unittest discover -s tests -v
"""
import unittest

import byot_harness as H
from database import supabase
from services import dial_settings as ds

DE = ds.DialError


class ValidateTests(unittest.TestCase):
    def test_defaults_are_sequential_5_10_0(self):
        self.assertEqual(ds.validate(None, {}), {"dial_strategy": "sequential", "dial_concurrent_calls": 5,
                                                 "dial_calls_per_minute": 10, "dial_delay_seconds": 0})

    def test_all_four_fields_are_always_returned_in_a_fixed_order(self):
        self.assertEqual(tuple(ds.validate(None, {"dial_strategy": "paced"})), ds.FIELDS)

    def test_every_strategy_is_accepted_and_normalised(self):
        for given, stored in (("sequential", "sequential"), ("concurrent", "concurrent"), ("paced", "paced"),
                              ("Concurrent", "concurrent"), (" PACED ", "paced")):
            with self.subTest(given=given):
                self.assertEqual(ds.validate(None, {"dial_strategy": given})["dial_strategy"], stored)

    def test_unknown_or_non_text_strategies_are_refused(self):
        for bad in ("parallel", "", "   ", 3, True, ["paced"], {"a": 1}):
            with self.subTest(strategy=bad), self.assertRaises(DE) as cm:
                ds.validate(None, {"dial_strategy": bad})
            self.assertIn("Sequential, Concurrent or Paced", str(cm.exception))

    def test_concurrent_calls_range_is_1_to_20(self):
        for ok in (1, 2, 19, 20):
            self.assertEqual(ds.validate(None, {"dial_concurrent_calls": ok})["dial_concurrent_calls"], ok)
        for bad in (0, 21, -1, 100, True, False, 5.0, 2.5, "5", [5]):
            with self.subTest(value=bad), self.assertRaises(DE) as cm:
                ds.validate(None, {"dial_concurrent_calls": bad})
            self.assertEqual(str(cm.exception), "Concurrent calls must be a whole number from 1 to 20.")

    def test_calls_per_minute_range_is_1_to_60(self):
        for ok in (1, 10, 59, 60):
            self.assertEqual(ds.validate(None, {"dial_calls_per_minute": ok})["dial_calls_per_minute"], ok)
        for bad in (0, 61, -5, True, 10.5, "10"):
            with self.subTest(value=bad), self.assertRaises(DE) as cm:
                ds.validate(None, {"dial_calls_per_minute": bad})
            self.assertEqual(str(cm.exception), "Calls per minute must be a whole number from 1 to 60.")

    def test_delay_range_is_0_to_60_seconds(self):
        for ok in (0, 1, 30, 60):
            self.assertEqual(ds.validate(None, {"dial_delay_seconds": ok})["dial_delay_seconds"], ok)
        for bad in (-1, 61, True, 1.5, "5"):
            with self.subTest(value=bad), self.assertRaises(DE) as cm:
                ds.validate(None, {"dial_delay_seconds": bad})
            self.assertIn("from 0 to 60", str(cm.exception))

    def test_the_error_is_a_value_error_so_callers_can_catch_either(self):
        self.assertTrue(issubclass(DE, ValueError))

    def test_updates_merge_over_the_stored_values(self):
        stored = {"dial_strategy": "concurrent", "dial_concurrent_calls": 8, "dial_calls_per_minute": 30, "dial_delay_seconds": 4}
        self.assertEqual(ds.validate(stored, {"dial_delay_seconds": 9}), {**stored, "dial_delay_seconds": 9})
        self.assertEqual(ds.validate(stored, {"dial_strategy": "paced"}), {**stored, "dial_strategy": "paced"})

    def test_a_none_update_keeps_the_stored_value(self):
        stored = {"dial_strategy": "paced", "dial_concurrent_calls": 8, "dial_calls_per_minute": 30, "dial_delay_seconds": 4}
        self.assertEqual(ds.validate(stored, {"dial_strategy": None, "dial_concurrent_calls": None}), stored)

    def test_a_stored_value_missing_from_the_row_falls_back_to_the_default(self):
        self.assertEqual(ds.validate({"dial_strategy": "paced"}, {}),
                         {"dial_strategy": "paced", "dial_concurrent_calls": 5, "dial_calls_per_minute": 10, "dial_delay_seconds": 0})

    def test_a_bad_value_in_one_field_is_not_hidden_by_valid_ones(self):
        with self.assertRaises(DE):
            ds.validate(None, {"dial_strategy": "paced", "dial_calls_per_minute": 99})

    def test_values_of_other_fields_in_the_body_are_ignored(self):
        out = ds.validate(None, {"name": "x", "retry_enabled": True, "dial_strategy": "paced"})
        self.assertEqual(set(out), set(ds.FIELDS))


class TouchedTests(unittest.TestCase):
    def test_touched_is_true_for_any_dial_field(self):
        for f in ds.FIELDS:
            self.assertTrue(ds.touched({f: 1}), f)

    def test_touched_is_false_otherwise(self):
        self.assertFalse(ds.touched({}))
        self.assertFalse(ds.touched({"name": "x", "retry_enabled": True, "status": "Active"}))


class DescribeTests(unittest.TestCase):
    def test_describe_of_a_full_row(self):
        row = {"dial_strategy": "paced", "dial_concurrent_calls": 7, "dial_calls_per_minute": 12, "dial_delay_seconds": 3, "name": "x"}
        self.assertEqual(ds.describe(row), {"strategy": "paced", "concurrent_calls": 7, "calls_per_minute": 12, "delay_seconds": 3})

    def test_a_row_from_before_the_feature_reads_as_the_defaults(self):
        for row in (None, {}, {"name": "old"}):
            self.assertEqual(ds.describe(row), {"strategy": "sequential", "concurrent_calls": 5, "calls_per_minute": 10, "delay_seconds": 0})

    def test_unreadable_values_read_as_defaults_and_never_raise(self):
        got = ds.describe({"dial_strategy": "warp", "dial_concurrent_calls": 99, "dial_calls_per_minute": "x",
                           "dial_delay_seconds": True})
        self.assertEqual(got, {"strategy": "sequential", "concurrent_calls": 5, "calls_per_minute": 10, "delay_seconds": 0})

    def test_label(self):
        self.assertEqual(ds.label({"dial_strategy": "concurrent"}), "Concurrent")
        self.assertEqual(ds.label(None), "Sequential")


class EffectiveTests(unittest.TestCase):
    """What a cap does to a campaign's settings (cap None = no cap)."""

    def row(self, strategy="concurrent", n=5, cpm=10, delay=0):
        return {"dial_strategy": strategy, "dial_concurrent_calls": n, "dial_calls_per_minute": cpm, "dial_delay_seconds": delay}

    CASES = [
        # (strategy, n, cpm, delay, cap) -> (concurrent_calls, calls_per_minute, capped)
        ("sequential", 5, 10, 0, None, (1, 10, False)),
        ("sequential", 5, 10, 0, 1, (1, 10, False)),
        ("sequential", 5, 10, 0, 3, (1, 10, False)),
        ("concurrent", 5, 10, 0, None, (5, 10, False)),
        ("concurrent", 5, 10, 0, 5, (5, 10, False)),
        ("concurrent", 5, 10, 0, 6, (5, 10, False)),
        ("concurrent", 5, 10, 0, 4, (4, 10, True)),
        ("concurrent", 5, 10, 0, 1, (1, 10, True)),
        ("concurrent", 20, 10, 0, 3, (3, 10, True)),
        ("concurrent", 1, 10, 0, 1, (1, 10, False)),
        ("paced", 5, 10, 0, None, (60, 10, False)),
        ("paced", 5, 10, 0, 10, (10, 10, False)),
        ("paced", 5, 10, 0, 9, (9, 10, True)),
        ("paced", 5, 10, 0, 3, (3, 10, True)),
        ("paced", 5, 10, 0, 100, (60, 10, False)),
        # a delay longer than 60 / calls-per-minute lowers the real rate to 60 / delay
        ("paced", 5, 10, 6, None, (60, 10, False)),
        ("paced", 5, 10, 20, None, (60, 3, False)),
        ("paced", 5, 60, 4, None, (60, 15, False)),
        ("paced", 5, 7, 60, None, (60, 1, False)),
        ("paced", 5, 30, 7, None, (60, 8.6, False)),
        # the delay never changes a Concurrent or Sequential campaign's own numbers
        ("concurrent", 5, 10, 30, None, (5, 10, False)),
        ("sequential", 5, 10, 30, None, (1, 10, False)),
    ]

    def test_table(self):
        for strategy, n, cpm, delay, cap, (conc, rate, capped) in self.CASES:
            with self.subTest(strategy=strategy, n=n, cpm=cpm, delay=delay, cap=cap):
                got = ds.effective(self.row(strategy, n, cpm, delay), cap, "account" if cap else None)
                self.assertEqual((got["concurrent_calls"], got["calls_per_minute"], got["capped"]), (conc, rate, capped))
                self.assertEqual(got["cap"], cap)
                self.assertEqual(got["cap_source"], "account" if cap else None)

    def test_the_keys_are_exactly_the_documented_ones(self):
        self.assertEqual(set(ds.effective(self.row(), 3, "account")),
                         {"concurrent_calls", "calls_per_minute", "capped", "cap", "cap_source"})

    def test_cap_source_is_dropped_when_there_is_no_cap(self):
        self.assertIsNone(ds.effective(self.row(), None, "account")["cap_source"])

    def test_a_row_without_dial_columns_is_sequential(self):
        got = ds.effective({"name": "old"}, 4, "platform")
        self.assertEqual((got["concurrent_calls"], got["capped"], got["cap_source"]), (1, False, "platform"))

    def test_the_paced_safety_limit_comes_from_the_settings(self):
        from unittest.mock import patch
        from config import settings
        with patch.object(settings, "dialer_paced_max_open", 25):
            self.assertEqual(ds.effective(self.row("paced"), None)["concurrent_calls"], 25)
            self.assertEqual(ds.effective(self.row("paced"), 40)["concurrent_calls"], 25)
            self.assertEqual(ds.effective(self.row("paced"), 12)["concurrent_calls"], 12)


class SpacingTests(unittest.TestCase):
    def test_spacing_is_the_slower_of_60_over_rate_and_the_delay(self):
        for cpm, delay, expected in ((10, 0, 6.0), (10, 3, 6.0), (10, 6, 6.0), (10, 20, 20.0), (60, 0, 1.0),
                                     (1, 0, 60.0), (60, 60, 60.0), (7, 0, 60 / 7)):
            with self.subTest(cpm=cpm, delay=delay):
                self.assertAlmostEqual(ds.spacing_seconds({"dial_calls_per_minute": cpm, "dial_delay_seconds": delay}), expected)


# ═══════════════════════════════════════════════════════════════════════════
# The campaign API
# ═══════════════════════════════════════════════════════════════════════════


class ApiBase(unittest.TestCase):
    def setUp(self):
        H.reset_rate_limits()
        self.user = H.make_user("dial")
        self.list = supabase.table("lists").insert({"user_id": self.user, "name": "L"}).execute().data[0]

    def api(self, method, path, **kw):
        return getattr(H.client, method)(path, headers=H.auth(self.user), **kw)

    def create(self, **extra):
        r = self.api("post", "/telephony/campaigns", json={"name": "C", "list_id": self.list["id"], **extra})
        return r

    def row(self, cid):
        return supabase.table("outbound_campaigns").select("*").eq("id", cid).execute().data[0]


class CreateTests(ApiBase):
    def test_a_new_campaign_is_sequential_5_10_0(self):
        r = self.create()
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()["data"]
        self.assertEqual((d["dial_strategy"], d["dial_concurrent_calls"], d["dial_calls_per_minute"], d["dial_delay_seconds"]),
                         ("sequential", 5, 10, 0))
        self.assertEqual(r.json()["warnings"], [])
        self.assertFalse(self.row(d["id"])["dial_running"])

    def test_the_four_fields_are_stored_as_sent(self):
        r = self.create(dial_strategy="paced", dial_concurrent_calls=3, dial_calls_per_minute=30, dial_delay_seconds=7)
        self.assertEqual(r.status_code, 200, r.text)
        row = self.row(r.json()["data"]["id"])
        self.assertEqual((row["dial_strategy"], row["dial_concurrent_calls"], row["dial_calls_per_minute"], row["dial_delay_seconds"]),
                         ("paced", 3, 30, 7))

    def test_a_strategy_is_normalised_when_stored(self):
        r = self.create(dial_strategy="Concurrent")
        self.assertEqual(self.row(r.json()["data"]["id"])["dial_strategy"], "concurrent")

    def test_bad_values_answer_400_with_the_message_and_store_nothing(self):
        for body, message in (
            ({"dial_strategy": "parallel"}, "Sequential, Concurrent or Paced"),
            ({"dial_concurrent_calls": 0}, "Concurrent calls must be a whole number from 1 to 20."),
            ({"dial_concurrent_calls": 21}, "Concurrent calls must be a whole number from 1 to 20."),
            ({"dial_calls_per_minute": 61}, "Calls per minute must be a whole number from 1 to 60."),
            ({"dial_calls_per_minute": 0}, "Calls per minute must be a whole number from 1 to 60."),
            ({"dial_delay_seconds": 61}, "from 0 to 60"),
            ({"dial_delay_seconds": -1}, "from 0 to 60"),
        ):
            with self.subTest(body=body):
                before = supabase.table("outbound_campaigns").select("id").eq("user_id", self.user).execute().data
                r = self.create(**body)
                self.assertEqual(r.status_code, 400, r.text)
                self.assertIn(message, r.json()["detail"])
                self.assertEqual(supabase.table("outbound_campaigns").select("id").eq("user_id", self.user).execute().data, before)

    def test_the_database_itself_refuses_values_out_of_range(self):
        import psycopg
        cid = self.create().json()["data"]["id"]
        for column, bad in (("dial_concurrent_calls", 21), ("dial_calls_per_minute", 0), ("dial_delay_seconds", 61),
                            ("dial_strategy", "'warp'")):
            with self.subTest(column=column), self.assertRaises(psycopg.errors.CheckViolation):
                H.sql(f"UPDATE public.outbound_campaigns SET {column} = {bad} WHERE id = %s", (cid,))

    def test_engine_columns_are_not_in_the_create_response(self):
        d = self.create().json()["data"]
        for col in ("run_token", "dial_legacy_cursor", "dial_counters", "dial_batch_seq"):
            self.assertNotIn(col, d)
        # the ones the card shows stay
        for col in ("dial_running", "dial_stall", "dial_next_at", "dial_cursor", "dial_strategy"):
            self.assertIn(col, d)


class ReadTests(ApiBase):
    def test_get_and_list_carry_the_dialing_block_and_no_engine_columns(self):
        cid = self.create(dial_strategy="concurrent", dial_concurrent_calls=7, dial_delay_seconds=2).json()["data"]["id"]
        one = self.api("get", f"/telephony/campaigns/{cid}").json()["data"]
        many = [c for c in self.api("get", "/telephony/campaigns").json()["data"] if c["id"] == cid][0]
        for d in (one, many):
            self.assertEqual(d["dialing"], {
                "settings": {"strategy": "concurrent", "concurrent_calls": 7, "calls_per_minute": 10, "delay_seconds": 2},
                "effective": {"concurrent_calls": 7, "calls_per_minute": 10, "capped": False, "cap": None, "cap_source": None},
                "warnings": [], "running": False, "stall_reason": None,
            })
            for col in ("run_token", "dial_legacy_cursor", "dial_counters", "dial_batch_seq"):
                self.assertNotIn(col, d)

    def test_the_existing_blocks_are_not_extended(self):
        cid = self.create().json()["data"]["id"]
        d = self.api("get", f"/telephony/campaigns/{cid}").json()["data"]
        self.assertEqual(set(d["retry_stats"]), {"total_attempts", "retries_placed", "answered_on_retry",
                                                 "max_attempts_reached", "pending_retries", "numbers"})
        self.assertEqual(set(d["auto_resume"]), {"pending", "next_at"})

    def test_running_and_stall_reason_follow_the_row(self):
        cid = self.create().json()["data"]["id"]
        H.sql("UPDATE public.outbound_campaigns SET dial_running = true, dial_stall = 'balance' WHERE id = %s", (cid,))
        d = self.api("get", f"/telephony/campaigns/{cid}").json()["data"]
        self.assertEqual((d["dialing"]["running"], d["dialing"]["stall_reason"]), (True, "balance"))

    def test_a_cap_shows_in_effective_and_warnings(self):
        cid = self.create(dial_strategy="concurrent", dial_concurrent_calls=5).json()["data"]["id"]
        H.sql("INSERT INTO public.billing (user_id, max_concurrent_calls) VALUES (%s, 3) "
              "ON CONFLICT (user_id) DO UPDATE SET max_concurrent_calls = 3", (self.user,))
        d = self.api("get", f"/telephony/campaigns/{cid}").json()["data"]["dialing"]
        self.assertEqual(d["effective"], {"concurrent_calls": 3, "calls_per_minute": 10, "capped": True, "cap": 3, "cap_source": "account"})
        self.assertEqual(d["warnings"], ["Concurrent Calls is set to 5, but your account allows 3 calls at the same time. "
                                         "Calls will run 3 at a time."])
        # and the create / update responses carry the same warning at the top level
        r = self.create(dial_strategy="concurrent", dial_concurrent_calls=9)
        self.assertEqual(r.json()["warnings"], ["Concurrent Calls is set to 9, but your account allows 3 calls at the same time. "
                                                "Calls will run 3 at a time."])
        r = self.api("patch", f"/telephony/campaigns/{cid}", json={"dial_concurrent_calls": 4})
        self.assertEqual(r.json()["warnings"], ["Concurrent Calls is set to 4, but your account allows 3 calls at the same time. "
                                                "Calls will run 3 at a time."])
        r = self.api("patch", f"/telephony/campaigns/{cid}", json={"dial_concurrent_calls": 2})
        self.assertEqual(r.json()["warnings"], [])
        H.sql("UPDATE public.billing SET max_concurrent_calls = NULL WHERE user_id = %s", (self.user,))


class UpdateTests(ApiBase):
    def test_a_partial_update_keeps_the_other_fields(self):
        cid = self.create(dial_strategy="paced", dial_calls_per_minute=30, dial_delay_seconds=4).json()["data"]["id"]
        r = self.api("patch", f"/telephony/campaigns/{cid}", json={"dial_delay_seconds": 9})
        self.assertEqual(r.status_code, 200, r.text)
        row = self.row(cid)
        self.assertEqual((row["dial_strategy"], row["dial_calls_per_minute"], row["dial_delay_seconds"], row["dial_concurrent_calls"]),
                         ("paced", 30, 9, 5))

    def test_switching_strategy_is_stored_at_once(self):
        cid = self.create().json()["data"]["id"]
        self.assertEqual(self.api("patch", f"/telephony/campaigns/{cid}", json={"dial_strategy": "concurrent"}).status_code, 200)
        self.assertEqual(self.row(cid)["dial_strategy"], "concurrent")

    def test_bad_values_answer_400_and_change_nothing(self):
        cid = self.create(dial_strategy="paced", dial_calls_per_minute=30).json()["data"]["id"]
        for body in ({"dial_strategy": "x"}, {"dial_concurrent_calls": 30}, {"dial_calls_per_minute": 0}, {"dial_delay_seconds": 99}):
            with self.subTest(body=body):
                r = self.api("patch", f"/telephony/campaigns/{cid}", json=body)
                self.assertEqual(r.status_code, 400, r.text)
        row = self.row(cid)
        self.assertEqual((row["dial_strategy"], row["dial_calls_per_minute"]), ("paced", 30))

    def test_a_change_clears_the_engines_wait_and_stall_reason(self):
        cid = self.create().json()["data"]["id"]
        H.sql("UPDATE public.outbound_campaigns SET dial_next_at = now() + interval '1 hour', dial_stall = 'balance' WHERE id = %s", (cid,))
        self.api("patch", f"/telephony/campaigns/{cid}", json={"dial_delay_seconds": 5})
        row = self.row(cid)
        self.assertEqual((row["dial_next_at"], row["dial_stall"]), (None, None))

    def test_saving_the_same_values_leaves_the_wait_and_stall_alone(self):
        cid = self.create().json()["data"]["id"]
        H.sql("UPDATE public.outbound_campaigns SET dial_next_at = now() + interval '1 hour', dial_stall = 'balance' WHERE id = %s", (cid,))
        self.api("patch", f"/telephony/campaigns/{cid}", json={"dial_strategy": "sequential", "dial_delay_seconds": 0})
        row = self.row(cid)
        self.assertIsNotNone(row["dial_next_at"])
        self.assertEqual(row["dial_stall"], "balance")

    def test_other_edits_do_not_touch_the_dialing_state(self):
        cid = self.create().json()["data"]["id"]
        H.sql("UPDATE public.outbound_campaigns SET dial_running = true, dial_seq = 5, dial_stall = 'balance' WHERE id = %s", (cid,))
        self.api("patch", f"/telephony/campaigns/{cid}", json={"name": "Renamed"})
        row = self.row(cid)
        self.assertEqual((row["dial_running"], row["dial_seq"], row["dial_stall"]), (True, 5, "balance"))

    def test_the_response_has_warnings_and_no_engine_columns(self):
        cid = self.create().json()["data"]["id"]
        body = self.api("patch", f"/telephony/campaigns/{cid}", json={"name": "N"}).json()
        self.assertEqual(body["warnings"], [])
        for col in ("run_token", "dial_legacy_cursor", "dial_counters", "dial_batch_seq"):
            self.assertNotIn(col, body["data"])

    def test_an_unknown_campaign_still_returns_null_data(self):
        r = self.api("patch", "/telephony/campaigns/00000000-0000-0000-0000-000000000000", json={"dial_strategy": "paced"})
        self.assertEqual(r.status_code, 200)
        self.assertIsNone(r.json()["data"])

    def test_changing_the_list_ends_the_open_pass(self):
        cid = self.create().json()["data"]["id"]
        other = supabase.table("lists").insert({"user_id": self.user, "name": "L2"}).execute().data[0]
        H.sql("UPDATE public.outbound_campaigns SET dial_running = true, dial_seq = 9, dial_cursor = gen_random_uuid(), "
              "dial_legacy_cursor = gen_random_uuid(), stopped_by_hours_at = now(), status = 'Paused' WHERE id = %s", (cid,))
        r = self.api("patch", f"/telephony/campaigns/{cid}", json={"list_id": other["id"]})
        self.assertEqual(r.status_code, 200, r.text)
        row = self.row(cid)
        self.assertEqual((row["dial_running"], row["dial_seq"], row["dial_cursor"], row["dial_legacy_cursor"], row["stopped_by_hours_at"]),
                         (False, None, None, None, None))

    def test_saving_the_same_list_keeps_the_pass(self):
        cid = self.create().json()["data"]["id"]
        H.sql("UPDATE public.outbound_campaigns SET dial_running = true, dial_seq = 9 WHERE id = %s", (cid,))
        self.api("patch", f"/telephony/campaigns/{cid}", json={"list_id": self.list["id"]})
        row = self.row(cid)
        self.assertEqual((row["dial_running"], row["dial_seq"]), (True, 9))


class SchemaTests(unittest.TestCase):
    def test_the_models_carry_the_four_fields_with_the_new_campaign_defaults(self):
        from models.schemas import CampaignCreate, CampaignUpdate
        c = CampaignCreate(name="x")
        self.assertEqual((c.dial_strategy, c.dial_concurrent_calls, c.dial_calls_per_minute, c.dial_delay_seconds), ("sequential", 5, 10, 0))
        u = CampaignUpdate()
        self.assertEqual((u.dial_strategy, u.dial_concurrent_calls, u.dial_calls_per_minute, u.dial_delay_seconds), (None,) * 4)
        self.assertEqual(CampaignUpdate(dial_delay_seconds=0).model_dump(exclude_none=True), {"dial_delay_seconds": 0},
                         "a delay of 0 is a value, not 'not sent'")


if __name__ == "__main__":
    unittest.main()
