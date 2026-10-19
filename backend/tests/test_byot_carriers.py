"""
BYOT tests for the Vonage and Telnyx carriers: connecting an account (and the VAPI
credential it creates), importing/buying numbers, rollback, delete safety, and billing.
The Twilio equivalents live in test_byot.py; these mirror them per carrier.

Real database and real HTTP endpoints via the shared qa_harness; only the carrier APIs
(CarrierMock) and VAPI (VapiPhoneMock) are replaced.

Run from the backend folder:  python -m unittest discover -s tests -p "test_byot_carriers.py" -v
"""
import asyncio
import unittest
import uuid
from datetime import datetime, timedelta, timezone

import byot_harness as H
from database import supabase
from routers import billing as billing_mod

# carrier -> (account_sid sent, secret sent, what the mocked carrier returns from find_number)
ACCOUNTS = {
    "vonage": {"account_sid": "vonagekey01", "auth_token": "vonage-secret", "owned_ref": "15550101234"},
    "telnyx": {"account_sid": None, "auth_token": "KEYtelnyxfakekey1234", "owned_ref": "tnx-owned-1"},
}


class _Base(unittest.TestCase):
    def setUp(self):
        H.reset_rate_limits()
        self.user = H.make_user()
        self.carrier = H.CarrierMock().start()
        self.vapi = H.VapiPhoneMock().start()
        self.addCleanup(self.carrier.stop)
        self.addCleanup(self.vapi.stop)

    def connect(self, carrier: str, label=None) -> dict:
        a = ACCOUNTS[carrier]
        return H.connect_carrier(self.user, carrier, a["account_sid"], a["auth_token"], label)

    def vapi_credential_id(self, cred_id: str):
        return H.sql("SELECT vapi_credential_id FROM twilio_byot_credentials WHERE id = %s", (cred_id,))[0][0]

    def post_number(self, cred_id: str, mode="import", number="+15550105555"):
        body = {"mode": mode, "credential_id": cred_id}
        if mode == "import":
            body["number"] = number
        return H.client.post("/telephony/phone-numbers/byot", json=body, headers=H.auth(self.user))


class ByotCarrierCredentials(_Base):
    def test_connect_registers_a_voice_credential_and_keeps_it_internal(self):
        vonage = self.connect("vonage", label="Main Vonage")
        telnyx = self.connect("telnyx")
        self.assertEqual((vonage["carrier"], telnyx["carrier"]), ("vonage", "telnyx"))
        self.assertEqual(vonage["account_sid"], "vonagekey01")
        self.assertIsNone(telnyx["account_sid"])
        for row in (vonage, telnyx):
            self.assertNotIn("config_encrypted", row)
            self.assertNotIn("vapi_credential_id", row)
            self.assertIn("auth_token_masked", row)
        payloads = [c.args[0] for c in self.vapi.create_credential.call_args_list]
        self.assertEqual(payloads[0], {"provider": "vonage", "name": payloads[0]["name"],
                                       "apiKey": "vonagekey01", "apiSecret": "vonage-secret"})
        self.assertEqual(payloads[1], {"provider": "telnyx", "name": payloads[1]["name"],
                                       "apiKey": "KEYtelnyxfakekey1234"})
        self.assertTrue(self.vapi_credential_id(vonage["id"]))
        self.assertTrue(self.vapi_credential_id(telnyx["id"]))

    def test_list_shows_the_carrier_of_every_account(self):
        self.connect("vonage")
        self.connect("telnyx")
        rows = H.client.get("/telephony/twilio-credentials", headers=H.auth(self.user)).json()["data"]
        self.assertEqual({r["carrier"] for r in rows}, {"vonage", "telnyx"})

    def test_vonage_needs_both_the_key_and_the_secret(self):
        r = H.client.post("/telephony/twilio-credentials",
                          json={"carrier": "vonage", "account_sid": "", "auth_token": "s"},
                          headers=H.auth(self.user))
        self.assertEqual(r.status_code, 400)
        self.assertIn("required", r.json()["detail"])

    def test_telnyx_needs_its_api_key(self):
        r = H.client.post("/telephony/twilio-credentials",
                          json={"carrier": "telnyx", "auth_token": ""}, headers=H.auth(self.user))
        self.assertEqual(r.status_code, 400)

    def test_unsupported_carrier_is_rejected(self):
        r = H.client.post("/telephony/twilio-credentials",
                          json={"carrier": "plivo", "auth_token": "x"}, headers=H.auth(self.user))
        self.assertEqual(r.status_code, 422)

    def test_carrier_rejection_saves_nothing_and_registers_nothing(self):
        self.carrier.valid = False
        for carrier in ACCOUNTS:
            a = ACCOUNTS[carrier]
            r = H.client.post("/telephony/twilio-credentials",
                              json={"carrier": carrier, **{k: a[k] for k in ("account_sid", "auth_token")}},
                              headers=H.auth(self.user))
            self.assertEqual(r.status_code, 400, carrier)
            self.assertIn("rejected", r.json()["detail"])
        self.vapi.create_credential.assert_not_called()
        self.assertEqual(H.sql("SELECT count(*) FROM twilio_byot_credentials WHERE user_id = %s", (self.user,))[0][0], 0)

    def test_voice_service_failure_saves_nothing(self):
        self.vapi.create_credential.side_effect = Exception("voice service down (simulated)")
        a = ACCOUNTS["vonage"]
        r = H.client.post("/telephony/twilio-credentials",
                          json={"carrier": "vonage", "account_sid": a["account_sid"], "auth_token": a["auth_token"]},
                          headers=H.auth(self.user))
        self.assertEqual(r.status_code, 400)
        self.assertIn("voice calls", r.json()["detail"])
        self.assertEqual(H.sql("SELECT count(*) FROM twilio_byot_credentials WHERE user_id = %s", (self.user,))[0][0], 0)

    def test_changing_the_secret_updates_the_voice_credential_in_place(self):
        for carrier, expected in (("vonage", {"provider": "vonage", "apiKey": "vonagekey01", "apiSecret": "rotated"}),
                                  ("telnyx", {"provider": "telnyx", "apiKey": "rotated"})):
            cred = self.connect(carrier)
            vapi_id = self.vapi_credential_id(cred["id"])
            self.vapi.update_credential.reset_mock()
            r = H.client.patch(f"/telephony/twilio-credentials/{cred['id']}",
                               json={"auth_token": "rotated"}, headers=H.auth(self.user))
            self.assertEqual(r.status_code, 200, r.text)
            self.vapi.update_credential.assert_awaited_once_with(vapi_id, expected)

    def test_label_only_edit_touches_neither_the_carrier_nor_the_voice_credential(self):
        cred = self.connect("vonage")
        self.carrier.vonage_validate.reset_mock()
        r = H.client.patch(f"/telephony/twilio-credentials/{cred['id']}",
                           json={"label": "Renamed"}, headers=H.auth(self.user))
        self.assertEqual(r.json()["data"]["label"], "Renamed")
        self.carrier.vonage_validate.assert_not_called()
        self.vapi.update_credential.assert_not_called()

    def test_rejected_new_keys_change_nothing(self):
        cred = self.connect("telnyx")
        self.carrier.valid = False
        r = H.client.patch(f"/telephony/twilio-credentials/{cred['id']}",
                           json={"auth_token": "bad"}, headers=H.auth(self.user))
        self.assertEqual(r.status_code, 400)
        self.vapi.update_credential.assert_not_called()

    def test_delete_removes_the_voice_credential_too(self):
        cred = self.connect("vonage")
        vapi_id = self.vapi_credential_id(cred["id"])
        r = H.client.delete(f"/telephony/twilio-credentials/{cred['id']}", headers=H.auth(self.user))
        self.assertEqual(r.status_code, 200)
        self.vapi.delete_credential.assert_awaited_once_with(vapi_id)

    def test_delete_is_blocked_while_a_number_uses_the_account(self):
        cred = self.connect("telnyx")
        self.assertEqual(self.post_number(cred["id"]).status_code, 200)
        r = H.client.delete(f"/telephony/twilio-credentials/{cred['id']}", headers=H.auth(self.user))
        self.assertEqual(r.status_code, 400)
        self.vapi.delete_credential.assert_not_called()


class ByotCarrierNumbers(_Base):
    def test_import_an_owned_number(self):
        for carrier, a in ACCOUNTS.items():
            with self.subTest(carrier=carrier):
                cred = self.connect(carrier)
                r = self.post_number(cred["id"])
                self.assertEqual(r.status_code, 200, r.text)
                row = r.json()["data"]
                self.assertEqual(row["provider"], f"{carrier}_byot")
                self.assertEqual(float(row["monthly_cost"]), 1.00)
                self.assertIsNotNone(row["next_billing_at"])
                self.assertEqual(row["twilio_credential_id"], cred["id"])
                self.assertEqual(row["twilio_sid"], a["owned_ref"])
                payload = self.vapi.create_phone_number.call_args.args[0]
                self.assertEqual(payload["provider"], carrier)
                self.assertEqual(payload["number"], "+15550105555")
                self.assertEqual(payload["credentialId"], self.vapi_credential_id(cred["id"]))

    def test_import_of_a_number_the_account_does_not_own_is_rejected(self):
        self.carrier.owned = False
        for carrier in ACCOUNTS:
            with self.subTest(carrier=carrier):
                cred = self.connect(carrier)
                self.vapi.create_phone_number.reset_mock()
                r = self.post_number(cred["id"])
                self.assertEqual(r.status_code, 400)
                self.assertIn(carrier.capitalize(), r.json()["detail"])
                self.vapi.create_phone_number.assert_not_called()
        self.assertEqual(H.sql("SELECT count(*) FROM phone_numbers WHERE user_id = %s", (self.user,))[0][0], 0)

    def test_purchase_buys_on_the_users_account_and_imports(self):
        for carrier in ACCOUNTS:
            with self.subTest(carrier=carrier):
                cred = self.connect(carrier)
                r = self.post_number(cred["id"], mode="purchase")
                self.assertEqual(r.status_code, 200, r.text)
                row = r.json()["data"]
                self.assertEqual(row["provider"], f"{carrier}_byot")
                self.assertEqual(self.carrier.buy_calls[-1]["carrier"], carrier)
                payload = self.vapi.create_phone_number.call_args.args[0]
                self.assertEqual((payload["provider"], payload["number"]), (carrier, row["number"]))
                self.assertEqual(payload["credentialId"], self.vapi_credential_id(cred["id"]))

    def test_a_failed_purchase_is_a_502_and_creates_nothing(self):
        self.carrier.fail_purchase = True
        for carrier in ACCOUNTS:
            cred = self.connect(carrier)
            self.assertEqual(self.post_number(cred["id"], mode="purchase").status_code, 502)
        self.vapi.create_phone_number.assert_not_called()

    def test_purchase_is_released_again_if_the_voice_import_fails(self):
        self.vapi.create_phone_number.side_effect = Exception("voice service down (simulated)")
        for carrier in ACCOUNTS:
            with self.subTest(carrier=carrier):
                cred = self.connect(carrier)
                self.carrier.release_calls.clear()
                self.assertEqual(self.post_number(cred["id"], mode="purchase").status_code, 502)
                self.assertEqual(len(self.carrier.release_calls), 1)
                self.assertEqual(self.carrier.release_calls[0]["carrier"], carrier)
        self.assertEqual(H.sql("SELECT count(*) FROM phone_numbers WHERE user_id = %s", (self.user,))[0][0], 0)

    def test_import_failure_does_not_release_anything(self):
        self.vapi.create_phone_number.side_effect = Exception("voice service down (simulated)")
        cred = self.connect("vonage")
        self.assertEqual(self.post_number(cred["id"]).status_code, 502)
        self.assertEqual(self.carrier.release_calls, [])

    def test_the_credential_decides_the_carrier(self):
        cred = self.connect("vonage")
        row = self.post_number(cred["id"]).json()["data"]
        self.assertEqual(row["provider"], "vonage_byot")

    def test_someone_elses_account_is_not_found(self):
        cred = self.connect("telnyx")
        other = H.make_user()
        r = H.client.post("/telephony/phone-numbers/byot",
                          json={"mode": "import", "credential_id": cred["id"], "number": "+15550105555"},
                          headers=H.auth(other))
        self.assertEqual(r.status_code, 404)

    def test_deleting_the_number_never_releases_it_from_the_users_carrier(self):
        for carrier in ACCOUNTS:
            with self.subTest(carrier=carrier):
                cred = self.connect(carrier)
                number_id = self.post_number(cred["id"]).json()["data"]["id"]
                self.vapi.delete_phone_number.reset_mock()
                r = H.client.delete(f"/telephony/phone-numbers/{number_id}", headers=H.auth(self.user))
                self.assertEqual(r.status_code, 200)
                self.assertEqual(self.carrier.release_calls, [])
                self.vapi.delete_phone_number.assert_awaited_once()


class ByotCarrierBilling(_Base):
    def test_monthly_sweep_bills_one_dollar_per_number(self):
        from services import phone_billing
        H.fund_wallet(self.user, 50.0)
        number_ids = []
        for carrier in ACCOUNTS:
            cred = self.connect(carrier)
            number_ids.append(self.post_number(cred["id"], number=f"+1555010{len(number_ids)}000").json()["data"]["id"])
        past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
        for nid in number_ids:
            H.sql("UPDATE phone_numbers SET next_billing_at = %s WHERE id = %s", (past, nid))
        before = billing_mod.get_balance(self.user)
        asyncio.run(phone_billing.run_billing_sweep())
        self.assertAlmostEqual(before - billing_mod.get_balance(self.user), 2.00, places=2)

    def test_calls_on_these_numbers_leave_out_the_carrier_leg(self):
        for carrier in ACCOUNTS:
            with self.subTest(carrier=carrier):
                assistant = f"asst-{carrier}-{uuid.uuid4().hex[:6]}"
                supabase.table("ai_agents").insert(
                    {"user_id": self.user, "name": f"{carrier} agent", "vapi_assistant_id": assistant}).execute()
                cred = self.connect(carrier)
                vapi_phone_id = self.post_number(cred["id"]).json()["data"]["vapi_phone_id"]
                call_id = f"call-{uuid.uuid4().hex[:8]}"
                payload = {"message": {
                    "type": "end-of-call-report", "endedReason": "customer-ended-call",
                    "call": {"id": call_id, "assistantId": assistant, "type": "outboundPhoneCall",
                             "phoneNumberId": vapi_phone_id},
                    "cost": 0.10, "durationSeconds": 60, "artifact": {"transcript": "", "messages": []},
                }}
                self.assertEqual(H.client.post("/webhooks/vapi", json=payload).status_code, 200)
                conv = (supabase.table("conversations").select("provider_cost, call_cost")
                        .eq("vapi_call_id", call_id).maybe_single().execute().data)
                self.assertAlmostEqual(float(conv["provider_cost"]), 0.10, places=4)
                self.assertAlmostEqual(float(conv["call_cost"]), 0.30, places=2)


class ByotCarrierReviewFixes(_Base):
    """Regressions found while reviewing the feature end to end."""

    def test_import_normalizes_the_typed_number_for_vonage_and_telnyx(self):
        for carrier in ACCOUNTS:
            with self.subTest(carrier=carrier):
                cred = self.connect(carrier)
                r = self.post_number(cred["id"], number=" +1 (555) 010-7777 ")
                self.assertEqual(r.status_code, 200, r.text)
                self.assertEqual(r.json()["data"]["number"], "+15550107777")
                self.assertEqual(self.vapi.create_phone_number.call_args.args[0]["number"], "+15550107777")

    def test_telnyx_rollback_still_releases_when_the_order_gave_no_reference(self):
        # Telnyx's listing can lag behind a successful order, leaving ref=None at purchase time.
        self.carrier.telnyx_buy.side_effect = lambda api_key, area_code=None: {"number": "+15550309999", "ref": None}
        self.vapi.create_phone_number.side_effect = Exception("voice service down (simulated)")
        cred = self.connect("telnyx")
        self.assertEqual(self.post_number(cred["id"], mode="purchase").status_code, 502)
        self.assertEqual(len(self.carrier.release_calls), 1)  # found by number, then released
        self.assertEqual(self.carrier.release_calls[0]["ref"], "tnx-owned-1")

    def test_bring_your_own_providers_cannot_use_the_generic_create_endpoint(self):
        for provider in ("vonage_byot", "telnyx_byot", "twilio_byot"):
            r = H.client.post("/telephony/phone-numbers", json={"provider": provider}, headers=H.auth(self.user))
            self.assertEqual(r.status_code, 400, provider)
        self.vapi.create_phone_number.assert_not_called()

    def test_admin_list_shows_the_real_one_dollar_fee_for_byot_numbers(self):
        from dependencies import get_admin_user
        cred = self.connect("vonage")
        self.post_number(cred["id"])
        H.client.app.dependency_overrides[get_admin_user] = lambda: {"sub": "test-admin"}
        try:
            rows = H.client.get("/admin/phone-numbers").json()["data"]
        finally:
            H.client.app.dependency_overrides.pop(get_admin_user, None)
        mine = [r for r in rows if r["user_id"] == self.user]
        self.assertEqual([r["provider"] for r in mine], ["vonage_byot"])
        self.assertEqual(mine[0]["monthly_cost"], 1.0)


if __name__ == "__main__":
    unittest.main()
