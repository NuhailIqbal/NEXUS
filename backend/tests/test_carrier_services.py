"""
Low-level unit tests for services/vonage_service.py, services/telnyx_service.py and the
services/carriers.py dispatcher — the parts the higher-level BYOT tests never reach (they
replace these functions wholesale). Mocks httpx.AsyncClient directly; no database/app.

Run from the backend folder:  python -m unittest discover -s tests -p "test_carrier_services.py" -v
"""
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from services import carriers, telnyx_service, vonage_service  # noqa: E402


def _resp(status_code=200, json_body=None):
    r = AsyncMock()
    r.status_code = status_code
    r.json = lambda: json_body if json_body is not None else {}
    r.content = b"x" if json_body is not None else b""
    r.text = ""
    return r


def _client(MockClient):
    return MockClient.return_value.__aenter__.return_value


class VonageService(unittest.IsolatedAsyncioTestCase):
    async def test_validate_accepts_200_and_rejects_401(self):
        with patch("httpx.AsyncClient") as MockClient:
            c = _client(MockClient)
            c.get = AsyncMock(return_value=_resp(200, {"value": 3.2}))
            self.assertTrue(await vonage_service.validate_credentials("key", "secret"))
            c.get = AsyncMock(return_value=_resp(401, {}))
            self.assertFalse(await vonage_service.validate_credentials("key", "bad"))

    async def test_validate_treats_an_outage_as_an_error_not_as_bad_credentials(self):
        for status in (429, 500, 503):
            with patch("httpx.AsyncClient") as MockClient:
                _client(MockClient).get = AsyncMock(return_value=_resp(status, {}))
                with self.assertRaises(RuntimeError):
                    await vonage_service.validate_credentials("key", "secret")

    async def test_find_number_matches_the_exact_msisdn_and_strips_the_plus(self):
        body = {"count": 2, "numbers": [{"msisdn": "15550101111"}, {"msisdn": "15550102222"}]}
        with patch("httpx.AsyncClient") as MockClient:
            c = _client(MockClient)
            c.get = AsyncMock(return_value=_resp(200, body))
            self.assertEqual(await vonage_service.find_number("+1 (555) 010-2222", "k", "s"), "15550102222")
            self.assertEqual(c.get.call_args.kwargs["params"]["pattern"], "15550102222")
            self.assertIsNone(await vonage_service.find_number("+15559999999", "k", "s"))

    async def test_find_number_api_error_reads_as_not_found(self):
        with patch("httpx.AsyncClient") as MockClient:
            _client(MockClient).get = AsyncMock(return_value=_resp(500, {}))
            self.assertIsNone(await vonage_service.find_number("+15550101111", "k", "s"))

    async def test_buy_searches_then_buys_and_returns_e164_with_ref(self):
        search = _resp(200, {"count": 1, "numbers": [{"msisdn": "15550103333", "country": "US"}]})
        bought = _resp(200, {"error-code": "200", "error-code-label": "success"})
        with patch("httpx.AsyncClient") as MockClient:
            c = _client(MockClient)
            c.get = AsyncMock(return_value=search)
            c.post = AsyncMock(return_value=bought)
            result = await vonage_service.buy_us_number("k", "s")
            self.assertEqual(result, {"number": "+15550103333", "ref": "15550103333"})
            params = c.get.call_args.kwargs["params"]
            self.assertEqual((params["country"], params["features"]), ("US", "VOICE"))
            self.assertEqual(c.post.call_args.kwargs["data"]["msisdn"], "15550103333")

    async def test_buy_with_area_code_searches_that_prefix_then_falls_back(self):
        empty = _resp(200, {"count": 0})
        hit = _resp(200, {"numbers": [{"msisdn": "12125550000", "country": "US"}]})
        with patch("httpx.AsyncClient") as MockClient:
            c = _client(MockClient)
            c.get = AsyncMock(side_effect=[empty, hit])
            c.post = AsyncMock(return_value=_resp(200, {"error-code": "200"}))
            result = await vonage_service.buy_us_number("k", "s", area_code="415")
            self.assertEqual(result["number"], "+12125550000")
            first, second = c.get.call_args_list[0].kwargs["params"], c.get.call_args_list[1].kwargs["params"]
            self.assertEqual(first["pattern"], "1415")
            self.assertNotIn("pattern", second)

    async def test_buy_failure_cases_raise(self):
        with patch("httpx.AsyncClient") as MockClient:
            c = _client(MockClient)
            c.get = AsyncMock(return_value=_resp(200, {"count": 0}))
            with self.assertRaises(RuntimeError):
                await vonage_service.buy_us_number("k", "s")
            c.get = AsyncMock(return_value=_resp(200, {"numbers": [{"msisdn": "1555", "country": "US"}]}))
            c.post = AsyncMock(return_value=_resp(200, {"error-code": "401", "error-code-label": "Insufficient funds"}))
            with self.assertRaisesRegex(RuntimeError, "Insufficient funds"):
                await vonage_service.buy_us_number("k", "s")

    async def test_release_posts_cancel_and_raises_on_failure(self):
        with patch("httpx.AsyncClient") as MockClient:
            c = _client(MockClient)
            c.post = AsyncMock(return_value=_resp(200, {"error-code": "200"}))
            await vonage_service.release_number("+15550101111", "k", "s")
            data = c.post.call_args.kwargs["data"]
            self.assertEqual((data["msisdn"], data["country"]), ("15550101111", "US"))
            c.post = AsyncMock(return_value=_resp(200, {"error-code": "420", "error-code-label": "not owned"}))
            with self.assertRaises(RuntimeError):
                await vonage_service.release_number("+15550101111", "k", "s")


class TelnyxService(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._no_wait = patch.object(telnyx_service, "ORDER_POLL_SECONDS", 0)
        self._no_wait.start()
        self.addCleanup(self._no_wait.stop)

    async def test_validate_uses_bearer_auth(self):
        with patch("httpx.AsyncClient") as MockClient:
            c = _client(MockClient)
            c.get = AsyncMock(return_value=_resp(200, {}))
            self.assertTrue(await telnyx_service.validate_credentials("KEY123"))
            self.assertEqual(c.get.call_args.kwargs["headers"], {"Authorization": "Bearer KEY123"})
            c.get = AsyncMock(return_value=_resp(401, {}))
            self.assertFalse(await telnyx_service.validate_credentials("bad"))

    async def test_validate_treats_an_outage_as_an_error_not_as_a_bad_key(self):
        for status in (429, 500, 503):
            with patch("httpx.AsyncClient") as MockClient:
                _client(MockClient).get = AsyncMock(return_value=_resp(status, {}))
                with self.assertRaises(RuntimeError):
                    await telnyx_service.validate_credentials("KEY123")

    async def test_find_number_returns_telnyx_id(self):
        with patch("httpx.AsyncClient") as MockClient:
            c = _client(MockClient)
            c.get = AsyncMock(return_value=_resp(200, {"data": [{"id": "9001", "phone_number": "+15550101111"}]}))
            self.assertEqual(await telnyx_service.find_number("+15550101111", "k"), "9001")
            self.assertEqual(c.get.call_args.kwargs["params"]["filter[phone_number]"], "+15550101111")
            c.get = AsyncMock(return_value=_resp(200, {"data": []}))
            self.assertIsNone(await telnyx_service.find_number("+15559999999", "k"))

    def _search_and_order(self, c, order_statuses, owned_id="9001"):
        """Wire c.get/c.post for: available-number search, find_number, then polling."""
        available = _resp(200, {"data": [{"phone_number": "+15550104444"}]})
        owned = _resp(200, {"data": [{"id": owned_id}]})
        polls = [_resp(200, {"data": {"id": "ord1", "status": s}}) for s in order_statuses[1:]]
        c.get = AsyncMock(side_effect=[available, *polls, owned])
        c.post = AsyncMock(return_value=_resp(200, {"data": {"id": "ord1", "status": order_statuses[0]}}))

    async def test_buy_returns_number_and_telnyx_id_when_order_succeeds_immediately(self):
        with patch("httpx.AsyncClient") as MockClient:
            c = _client(MockClient)
            self._search_and_order(c, ["success"])
            result = await telnyx_service.buy_us_number("k")
            self.assertEqual(result, {"number": "+15550104444", "ref": "9001"})
            self.assertEqual(c.post.call_args.kwargs["json"], {"phone_numbers": [{"phone_number": "+15550104444"}]})

    async def test_buy_polls_a_pending_order_until_it_succeeds(self):
        with patch("httpx.AsyncClient") as MockClient:
            c = _client(MockClient)
            self._search_and_order(c, ["pending", "pending", "success"])
            result = await telnyx_service.buy_us_number("k")
            self.assertEqual(result["ref"], "9001")

    async def test_buy_failed_order_raises(self):
        with patch("httpx.AsyncClient") as MockClient:
            c = _client(MockClient)
            self._search_and_order(c, ["pending", "failure"])
            with self.assertRaisesRegex(RuntimeError, "failed"):
                await telnyx_service.buy_us_number("k")

    async def test_buy_order_that_never_completes_raises_a_clear_message(self):
        with patch("httpx.AsyncClient") as MockClient, patch.object(telnyx_service, "ORDER_POLL_ATTEMPTS", 3):
            c = _client(MockClient)
            self._search_and_order(c, ["pending", "pending", "pending"])
            with self.assertRaisesRegex(RuntimeError, "still processing"):
                await telnyx_service.buy_us_number("k")

    async def test_buy_area_code_filter_and_fallback(self):
        empty = _resp(200, {"data": []})
        hit = _resp(200, {"data": [{"phone_number": "+12125550000"}]})
        with patch("httpx.AsyncClient") as MockClient:
            c = _client(MockClient)
            c.get = AsyncMock(side_effect=[empty, hit, _resp(200, {"data": [{"id": "77"}]})])
            c.post = AsyncMock(return_value=_resp(200, {"data": {"id": "o", "status": "success"}}))
            result = await telnyx_service.buy_us_number("k", area_code="415")
            self.assertEqual(result["number"], "+12125550000")
            first, second = c.get.call_args_list[0].kwargs["params"], c.get.call_args_list[1].kwargs["params"]
            self.assertEqual(first["filter[national_destination_code]"], "415")
            self.assertNotIn("filter[national_destination_code]", second)

    async def test_buy_with_nothing_available_raises(self):
        with patch("httpx.AsyncClient") as MockClient:
            _client(MockClient).get = AsyncMock(return_value=_resp(200, {"data": []}))
            with self.assertRaises(RuntimeError):
                await telnyx_service.buy_us_number("k")

    async def test_release_treats_404_as_success_and_raises_on_other_errors(self):
        with patch("httpx.AsyncClient") as MockClient:
            c = _client(MockClient)
            for status in (200, 204, 404):
                c.delete = AsyncMock(return_value=_resp(status, {}))
                await telnyx_service.release_number("9001", "k")
            c.delete = AsyncMock(return_value=_resp(500, {}))
            with self.assertRaises(RuntimeError):
                await telnyx_service.release_number("9001", "k")


class CarrierDispatcher(unittest.TestCase):
    def test_unknown_carrier_is_rejected(self):
        with self.assertRaises(ValueError):
            carriers.spec("plivo")

    def test_vapi_credential_payloads(self):
        self.assertIsNone(carriers.vapi_credential_payload("twilio", "AC1", "tok", "n"))
        self.assertEqual(
            carriers.vapi_credential_payload("vonage", "key1", "sec1", "nexus-vonage-ab"),
            {"provider": "vonage", "name": "nexus-vonage-ab", "apiKey": "key1", "apiSecret": "sec1"},
        )
        self.assertEqual(
            carriers.vapi_credential_payload("telnyx", None, "KEYabc", "nexus-telnyx-ab"),
            {"provider": "telnyx", "name": "nexus-telnyx-ab", "apiKey": "KEYabc"},
        )

    def test_vapi_credential_update_payloads(self):
        self.assertEqual(carriers.vapi_credential_update_payload("vonage", "k2", "s2"), {"provider": "vonage", "apiKey": "k2", "apiSecret": "s2"})
        self.assertEqual(carriers.vapi_credential_update_payload("telnyx", None, "KEY2"), {"provider": "telnyx", "apiKey": "KEY2"})

    def test_vapi_phone_payloads(self):
        self.assertEqual(
            carriers.vapi_phone_payload("twilio", "+1555", "AC1", "tok", None),
            {"provider": "twilio", "number": "+1555", "twilioAccountSid": "AC1", "twilioAuthToken": "tok"},
        )
        self.assertEqual(
            carriers.vapi_phone_payload("vonage", "+1555", "k", "s", "cred-v"),
            {"provider": "vonage", "number": "+1555", "credentialId": "cred-v"},
        )
        self.assertEqual(
            carriers.vapi_phone_payload("telnyx", "+1555", None, "K", "cred-t"),
            {"provider": "telnyx", "number": "+1555", "credentialId": "cred-t"},
        )

    def test_vonage_and_telnyx_need_a_stored_voice_credential(self):
        for carrier in ("vonage", "telnyx"):
            with self.assertRaises(RuntimeError):
                carriers.vapi_phone_payload(carrier, "+1555", "k", "s", None)



class CarrierNormalizeNumber(unittest.TestCase):
    def test_vonage_and_telnyx_get_e164(self):
        for carrier in ("vonage", "telnyx"):
            for typed, expected in [
                ("+15551234567", "+15551234567"),
                ("15551234567", "+15551234567"),
                ("5551234567", "+15551234567"),
                (" +1 (555) 123-4567 ", "+15551234567"),
                ("+44 20 7946 0958", "+442079460958"),
                ("abc", "abc"),
                ("", ""),
            ]:
                self.assertEqual(carriers.normalize_number(carrier, typed), expected, (carrier, typed))

    def test_twilio_input_is_left_exactly_as_typed(self):
        self.assertEqual(carriers.normalize_number("twilio", "5551234567"), "5551234567")


if __name__ == "__main__":
    unittest.main()
