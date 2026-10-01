"""
BYOT (Bring Your Own Twilio) test suite — credentials CRUD, phone-number provisioning
(import + purchase), failure/rollback paths, delete-safety, and billing (per-minute
Twilio-leg exclusion + the $1/month sweep).

Run from the backend folder:  python -m unittest discover -s tests -v
"""
import unittest
import uuid
from datetime import datetime, timedelta, timezone

import byot_harness as H
from database import supabase
from routers import billing as billing_mod


class ByotCredentialsTests(unittest.TestCase):
    def setUp(self):
        H.reset_rate_limits()
        self.user = H.make_user()
        self.twilio = H.TwilioMock().start()
        self.vapi = H.VapiPhoneMock().start()
        self.addCleanup(self.twilio.stop)
        self.addCleanup(self.vapi.stop)

    def test_connect_valid_credentials(self):
        data = H.connect_twilio(self.user)
        self.assertEqual(data["account_sid"], "ACuserfakesid00000000000000000000")
        self.assertNotIn("config_encrypted", data)
        self.assertIn("auth_token_masked", data)
        self.assertNotEqual(data["auth_token_masked"], "user-fake-auth-token")

    def test_connect_invalid_credentials_rejected(self):
        self.twilio.valid_credentials = False
        r = H.client.post("/telephony/twilio-credentials",
                          json={"account_sid": "ACbad", "auth_token": "bad"},
                          headers=H.auth(self.user))
        self.assertEqual(r.status_code, 400)
        self.assertIn("rejected", r.json()["detail"].lower())

    def test_connect_missing_fields_rejected(self):
        r = H.client.post("/telephony/twilio-credentials",
                          json={"account_sid": "", "auth_token": ""},
                          headers=H.auth(self.user))
        self.assertEqual(r.status_code, 400)

    def test_connect_network_error_returns_clean_4xx_not_500(self):
        async def boom(account_sid, auth_token):
            raise TimeoutError("simulated network failure")
        self.twilio.validate_credentials.side_effect = boom
        r = H.client.post("/telephony/twilio-credentials",
                          json={"account_sid": "ACx", "auth_token": "y"},
                          headers=H.auth(self.user))
        self.assertEqual(r.status_code, 400)
        self.assertIn("try again", r.json()["detail"].lower())

    def test_list_credentials_masked(self):
        H.connect_twilio(self.user)
        r = H.client.get("/telephony/twilio-credentials", headers=H.auth(self.user))
        self.assertEqual(r.status_code, 200)
        rows = r.json()["data"]
        self.assertEqual(len(rows), 1)
        self.assertNotIn("config_encrypted", rows[0])

    def test_credentials_are_user_scoped(self):
        H.connect_twilio(self.user)
        other = H.make_user()
        r = H.client.get("/telephony/twilio-credentials", headers=H.auth(other))
        self.assertEqual(r.json()["data"], [])

    def test_delete_credential(self):
        cred = H.connect_twilio(self.user)
        r = H.client.delete(f"/telephony/twilio-credentials/{cred['id']}", headers=H.auth(self.user))
        self.assertEqual(r.status_code, 200)
        r2 = H.client.get("/telephony/twilio-credentials", headers=H.auth(self.user))
        self.assertEqual(r2.json()["data"], [])

    def test_delete_nonexistent_credential_is_a_noop(self):
        r = H.client.delete(f"/telephony/twilio-credentials/{uuid.uuid4()}", headers=H.auth(self.user))
        self.assertEqual(r.status_code, 200)

    def test_update_label_only_does_not_call_twilio(self):
        cred = H.connect_twilio(self.user)
        self.twilio.validate_credentials.reset_mock()
        r = H.client.patch(f"/telephony/twilio-credentials/{cred['id']}",
                           json={"label": "Renamed"}, headers=H.auth(self.user))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["data"]["label"], "Renamed")
        self.assertEqual(r.json()["data"]["account_sid"], cred["account_sid"])
        self.twilio.validate_credentials.assert_not_called()

    def test_rotating_only_the_auth_token_revalidates_with_the_existing_sid(self):
        cred = H.connect_twilio(self.user)
        r = H.client.patch(f"/telephony/twilio-credentials/{cred['id']}",
                           json={"auth_token": "new-rotated-token"}, headers=H.auth(self.user))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["data"]["account_sid"], cred["account_sid"])
        last_call = self.twilio.validate_credentials.call_args
        self.assertEqual(last_call.args, (cred["account_sid"], "new-rotated-token"))

    def test_update_rejected_when_new_credentials_are_invalid(self):
        cred = H.connect_twilio(self.user)
        self.twilio.valid_credentials = False
        r = H.client.patch(f"/telephony/twilio-credentials/{cred['id']}",
                           json={"auth_token": "bad-token"}, headers=H.auth(self.user))
        self.assertEqual(r.status_code, 400)
        # the old credential must be untouched
        row = H.sql("SELECT account_sid FROM twilio_byot_credentials WHERE id = %s", (cred["id"],))[0]
        self.assertEqual(row[0], cred["account_sid"])

    def test_update_nonexistent_credential_is_404(self):
        r = H.client.patch(f"/telephony/twilio-credentials/{uuid.uuid4()}",
                           json={"label": "x"}, headers=H.auth(self.user))
        self.assertEqual(r.status_code, 404)

    def test_update_another_users_credential_is_404(self):
        cred = H.connect_twilio(self.user)
        other = H.make_user()
        r = H.client.patch(f"/telephony/twilio-credentials/{cred['id']}",
                           json={"label": "hijacked"}, headers=H.auth(other))
        self.assertEqual(r.status_code, 404)

    def test_can_connect_more_than_one_twilio_account(self):
        first = H.connect_twilio(self.user, account_sid="ACfirstaccount0000000000000000000", label="First")
        second = H.connect_twilio(self.user, account_sid="ACsecondaccount000000000000000000", label="Second")
        self.assertNotEqual(first["id"], second["id"])

        r = H.client.get("/telephony/twilio-credentials", headers=H.auth(self.user))
        rows = r.json()["data"]
        self.assertEqual(len(rows), 2)
        self.assertEqual({row["account_sid"] for row in rows},
                         {"ACfirstaccount0000000000000000000", "ACsecondaccount000000000000000000"})


class ByotPhoneNumberTests(unittest.TestCase):
    def setUp(self):
        H.reset_rate_limits()
        self.user = H.make_user()
        self.twilio = H.TwilioMock().start()
        self.vapi = H.VapiPhoneMock().start()
        self.addCleanup(self.twilio.stop)
        self.addCleanup(self.vapi.stop)
        self.cred = H.connect_twilio(self.user)

    def test_choosing_between_two_connected_accounts_uses_the_one_picked(self):
        """With more than one Twilio account connected, the credential_id actually
        picked must be the one whose account_sid reaches Twilio — not always the
        first, not a mix-up between the two."""
        second = H.connect_twilio(self.user, account_sid="ACsecondaccount000000000000000000", label="Second")
        r = H.client.post("/telephony/phone-numbers/byot",
                          json={"mode": "purchase", "credential_id": second["id"]},
                          headers=H.auth(self.user))
        self.assertEqual(r.status_code, 200, r.text)
        row = r.json()["data"]
        self.assertEqual(row["twilio_credential_id"], second["id"])
        self.assertEqual(self.twilio.buy_calls[-1]["account_sid"], "ACsecondaccount000000000000000000")
        self.assertNotEqual(self.twilio.buy_calls[-1]["account_sid"], self.cred["account_sid"])

    def test_import_mode_creates_number(self):
        r = H.client.post("/telephony/phone-numbers/byot",
                          json={"mode": "import", "credential_id": self.cred["id"], "number": "+15551234567"},
                          headers=H.auth(self.user))
        self.assertEqual(r.status_code, 200, r.text)
        row = r.json()["data"]
        self.assertEqual(row["number"], "+15551234567")
        self.assertEqual(row["provider"], "twilio_byot")
        self.assertEqual(float(row["monthly_cost"]), 1.00)
        self.assertIsNotNone(row["next_billing_at"])
        self.assertEqual(row["twilio_credential_id"], self.cred["id"])
        self.assertTrue(row["vapi_phone_id"])
        self.assertEqual(row["twilio_sid"], "PNimported000001")  # resolved via find_sid_by_number
        self.twilio.buy_us_number.assert_not_called()

    def test_import_mode_number_not_on_the_connected_account_is_rejected(self):
        self.twilio.find_sid_by_number.return_value = None
        r = H.client.post("/telephony/phone-numbers/byot",
                          json={"mode": "import", "credential_id": self.cred["id"], "number": "+15559999999"},
                          headers=H.auth(self.user))
        self.assertEqual(r.status_code, 400)
        self.assertIn("wasn't found", r.json()["detail"])
        rows = H.sql("SELECT id FROM phone_numbers WHERE user_id = %s", (self.user,))
        self.assertEqual(rows, [])  # nothing created, no VAPI call attempted either
        self.vapi.create_phone_number.assert_not_called()

    def test_import_mode_trims_whitespace_before_checking_ownership(self):
        r = H.client.post("/telephony/phone-numbers/byot",
                          json={"mode": "import", "credential_id": self.cred["id"], "number": "  +15551234567  "},
                          headers=H.auth(self.user))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["data"]["number"], "+15551234567")
        self.assertEqual(self.twilio.find_sid_by_number.call_args.args[0], "+15551234567")

    def test_import_mode_requires_number(self):
        r = H.client.post("/telephony/phone-numbers/byot",
                          json={"mode": "import", "credential_id": self.cred["id"]},
                          headers=H.auth(self.user))
        self.assertEqual(r.status_code, 400)

    def test_purchase_mode_buys_and_imports(self):
        r = H.client.post("/telephony/phone-numbers/byot",
                          json={"mode": "purchase", "credential_id": self.cred["id"]},
                          headers=H.auth(self.user))
        self.assertEqual(r.status_code, 200, r.text)
        row = r.json()["data"]
        self.assertTrue(row["number"].startswith("+1555000"))
        self.assertEqual(len(self.twilio.buy_calls), 1)
        self.assertEqual(self.twilio.buy_calls[0]["account_sid"], self.cred["account_sid"])

    def test_purchase_mode_passes_area_code(self):
        r = H.client.post("/telephony/phone-numbers/byot",
                          json={"mode": "purchase", "credential_id": self.cred["id"], "area_code": "415"},
                          headers=H.auth(self.user))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.twilio.buy_calls[0]["area_code"], "415")

    def test_invalid_mode_rejected(self):
        r = H.client.post("/telephony/phone-numbers/byot",
                          json={"mode": "bogus", "credential_id": self.cred["id"], "number": "+1"},
                          headers=H.auth(self.user))
        self.assertEqual(r.status_code, 400)

    def test_credential_not_owned_rejected(self):
        other = H.make_user()
        r = H.client.post("/telephony/phone-numbers/byot",
                          json={"mode": "import", "credential_id": self.cred["id"], "number": "+15551234567"},
                          headers=H.auth(other))
        self.assertEqual(r.status_code, 404)

    def test_nonexistent_credential_rejected(self):
        r = H.client.post("/telephony/phone-numbers/byot",
                          json={"mode": "import", "credential_id": str(uuid.uuid4()), "number": "+15551234567"},
                          headers=H.auth(self.user))
        self.assertEqual(r.status_code, 404)

    def test_purchase_rollback_on_vapi_import_failure(self):
        self.vapi.create_phone_number.side_effect = Exception("VAPI down (simulated)")
        r = H.client.post("/telephony/phone-numbers/byot",
                          json={"mode": "purchase", "credential_id": self.cred["id"]},
                          headers=H.auth(self.user))
        self.assertEqual(r.status_code, 502)
        # the purchased number must have been released, not left orphaned on the
        # user's own Twilio account with no record of it anywhere on our side
        self.assertEqual(len(self.twilio.release_calls), 1)
        rows = H.sql("SELECT id FROM phone_numbers WHERE user_id = %s", (self.user,))
        self.assertEqual(rows, [])

    def test_purchase_rollback_failure_still_surfaces_original_error(self):
        self.vapi.create_phone_number.side_effect = Exception("VAPI down (simulated)")
        self.twilio.fail_release = True
        r = H.client.post("/telephony/phone-numbers/byot",
                          json={"mode": "purchase", "credential_id": self.cred["id"]},
                          headers=H.auth(self.user))
        self.assertEqual(r.status_code, 502)  # original VAPI error, not a crash from the failed rollback

    def test_import_no_rollback_attempted_on_vapi_failure(self):
        self.vapi.create_phone_number.side_effect = Exception("VAPI down (simulated)")
        r = H.client.post("/telephony/phone-numbers/byot",
                          json={"mode": "import", "credential_id": self.cred["id"], "number": "+15551234567"},
                          headers=H.auth(self.user))
        self.assertEqual(r.status_code, 502)
        self.assertEqual(len(self.twilio.release_calls), 0)  # nothing was purchased to roll back

    def test_delete_credential_blocked_while_number_exists(self):
        H.client.post("/telephony/phone-numbers/byot",
                      json={"mode": "import", "credential_id": self.cred["id"], "number": "+15551234567"},
                      headers=H.auth(self.user))
        r = H.client.delete(f"/telephony/twilio-credentials/{self.cred['id']}", headers=H.auth(self.user))
        self.assertEqual(r.status_code, 400)
        self.assertIn("still used", r.json()["detail"].lower())

    def test_delete_credential_allowed_after_number_removed(self):
        create = H.client.post("/telephony/phone-numbers/byot",
                               json={"mode": "import", "credential_id": self.cred["id"], "number": "+15551234567"},
                               headers=H.auth(self.user))
        number_id = create.json()["data"]["id"]
        H.client.delete(f"/telephony/phone-numbers/{number_id}", headers=H.auth(self.user))
        r = H.client.delete(f"/telephony/twilio-credentials/{self.cred['id']}", headers=H.auth(self.user))
        self.assertEqual(r.status_code, 200)

    def test_delete_byot_number_does_not_release_from_platform_twilio(self):
        create = H.client.post("/telephony/phone-numbers/byot",
                               json={"mode": "import", "credential_id": self.cred["id"], "number": "+15551234567"},
                               headers=H.auth(self.user))
        number_id = create.json()["data"]["id"]
        r = H.client.delete(f"/telephony/phone-numbers/{number_id}", headers=H.auth(self.user))
        self.assertEqual(r.status_code, 200)
        # BYOT: we must never call release on a number we don't own
        self.assertEqual(len(self.twilio.release_calls), 0)
        self.vapi.delete_phone_number.assert_called_once()


class ByotBillingTests(unittest.TestCase):
    def setUp(self):
        H.reset_rate_limits()
        self.user = H.make_user()
        self.twilio = H.TwilioMock().start()
        self.vapi = H.VapiPhoneMock().start()
        self.addCleanup(self.twilio.stop)
        self.addCleanup(self.vapi.stop)

    def test_calculate_call_cost_excludes_twilio_leg_for_byot(self):
        vapi_cost = 0.10
        charge_byot, provider_cost_byot = billing_mod.calculate_call_cost(
            self.user, 60, vapi_cost=vapi_cost, direction="outbound", is_byot=True)
        charge_normal, provider_cost_normal = billing_mod.calculate_call_cost(
            self.user, 60, vapi_cost=vapi_cost, direction="outbound", is_byot=False)
        self.assertLess(provider_cost_byot, provider_cost_normal)
        self.assertAlmostEqual(provider_cost_byot, vapi_cost, places=4)
        expected_normal = round(vapi_cost + 0.014, 4)  # 60s outbound Twilio leg
        self.assertAlmostEqual(provider_cost_normal, expected_normal, places=4)
        self.assertEqual(charge_byot, round(vapi_cost * 3.0, 2))

    def test_byot_toggle_off_includes_twilio_leg(self):
        H.sql("UPDATE platform_settings SET byot_exclude_twilio_leg = false WHERE id = 1")
        try:
            _, provider_cost = billing_mod.calculate_call_cost(
                self.user, 60, vapi_cost=0.10, direction="outbound", is_byot=True)
            self.assertGreater(provider_cost, 0.10)
        finally:
            H.sql("UPDATE platform_settings SET byot_exclude_twilio_leg = true WHERE id = 1")

    def test_webhook_detects_byot_number_and_excludes_twilio_leg(self):
        supabase.table("ai_agents").insert({
            "user_id": self.user, "name": "QA Agent", "vapi_assistant_id": "asst-byot-test",
        }).execute()

        cred = H.connect_twilio(self.user)
        create = H.client.post("/telephony/phone-numbers/byot",
                               json={"mode": "import", "credential_id": cred["id"], "number": "+15559990000"},
                               headers=H.auth(self.user))
        vapi_phone_id = create.json()["data"]["vapi_phone_id"]

        call_id = f"call-{uuid.uuid4().hex[:8]}"
        payload = {
            "message": {
                "type": "end-of-call-report",
                "endedReason": "customer-ended-call",
                "call": {
                    "id": call_id,
                    "assistantId": "asst-byot-test",
                    "type": "outboundPhoneCall",
                    "phoneNumberId": vapi_phone_id,
                },
                "cost": 0.10,
                "durationSeconds": 60,
                "artifact": {"transcript": "", "messages": []},
            }
        }
        r = H.client.post("/webhooks/vapi", json=payload)
        self.assertEqual(r.status_code, 200)

        conv = (
            supabase.table("conversations").select("*")
            .eq("vapi_call_id", call_id).maybe_single().execute().data
        )
        self.assertIsNotNone(conv)
        self.assertAlmostEqual(float(conv["provider_cost"]), 0.10, places=4)
        self.assertAlmostEqual(float(conv["call_cost"]), round(0.10 * 3.0, 2), places=2)

    def test_webhook_platform_twilio_number_still_includes_leg(self):
        """Regression check: a normal (non-BYOT) number's call must be unaffected by
        the new is_byot plumbing — still bills the estimated Twilio leg as before."""
        supabase.table("ai_agents").insert({
            "user_id": self.user, "name": "QA Agent 2", "vapi_assistant_id": "asst-platform-test",
        }).execute()
        supabase.table("phone_numbers").insert({
            "user_id": self.user, "number": "+15557770000", "provider": "twilio",
            "vapi_phone_id": "vapi-phone-platform-1",
        }).execute()

        call_id = f"call-{uuid.uuid4().hex[:8]}"
        payload = {
            "message": {
                "type": "end-of-call-report",
                "endedReason": "customer-ended-call",
                "call": {
                    "id": call_id,
                    "assistantId": "asst-platform-test",
                    "type": "outboundPhoneCall",
                    "phoneNumberId": "vapi-phone-platform-1",
                },
                "cost": 0.10,
                "durationSeconds": 60,
                "artifact": {"transcript": "", "messages": []},
            }
        }
        r = H.client.post("/webhooks/vapi", json=payload)
        self.assertEqual(r.status_code, 200)
        conv = (
            supabase.table("conversations").select("*")
            .eq("vapi_call_id", call_id).maybe_single().execute().data
        )
        self.assertAlmostEqual(float(conv["provider_cost"]), 0.114, places=3)  # 0.10 + 0.014 leg


class ByotPhoneBillingSweepTests(unittest.TestCase):
    def setUp(self):
        H.reset_rate_limits()
        self.user = H.make_user()
        self.twilio = H.TwilioMock().start()
        self.vapi = H.VapiPhoneMock().start()
        self.addCleanup(self.twilio.stop)
        self.addCleanup(self.vapi.stop)
        H.fund_wallet(self.user, 50.0)

    def test_monthly_sweep_bills_one_dollar_for_byot(self):
        import asyncio
        from services import phone_billing

        cred = H.connect_twilio(self.user)
        create = H.client.post("/telephony/phone-numbers/byot",
                               json={"mode": "import", "credential_id": cred["id"], "number": "+15558880000"},
                               headers=H.auth(self.user))
        number_id = create.json()["data"]["id"]
        past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
        H.sql("UPDATE phone_numbers SET next_billing_at = %s WHERE id = %s", (past, number_id))

        before = billing_mod.get_balance(self.user)
        asyncio.run(phone_billing.run_billing_sweep())
        after = billing_mod.get_balance(self.user)
        self.assertAlmostEqual(before - after, 1.00, places=2)

    def test_monthly_sweep_advances_next_billing_date(self):
        import asyncio
        from services import phone_billing

        cred = H.connect_twilio(self.user)
        create = H.client.post("/telephony/phone-numbers/byot",
                               json={"mode": "import", "credential_id": cred["id"], "number": "+15558880001"},
                               headers=H.auth(self.user))
        number_id = create.json()["data"]["id"]
        past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
        H.sql("UPDATE phone_numbers SET next_billing_at = %s WHERE id = %s", (past, number_id))

        asyncio.run(phone_billing.run_billing_sweep())
        row = H.sql("SELECT next_billing_at FROM phone_numbers WHERE id = %s", (number_id,))[0]
        self.assertGreater(row[0].replace(tzinfo=timezone.utc) if row[0].tzinfo is None else row[0],
                          datetime.now(timezone.utc))


if __name__ == "__main__":
    unittest.main()
