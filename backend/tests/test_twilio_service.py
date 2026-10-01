"""
Low-level unit tests for services/twilio_service.py — specifically the parts BYOT's
higher-level mocks never exercise (they replace buy_us_number/validate_credentials
wholesale), like the real AreaCode search param and the no-match fallback retry.
Mocks httpx.AsyncClient directly; no database/app dependency.

Run from the backend folder:  python -m unittest tests.test_twilio_service -v
"""
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from config import settings  # noqa: E402
settings.twilio_account_sid = "ACplatform"
settings.twilio_auth_token = "platform-token"

from services import twilio_service  # noqa: E402


def _resp(status_code=200, json_body=None):
    r = AsyncMock()
    r.status_code = status_code
    r.json = lambda: json_body or {}
    r.text = ""
    return r


class BuyUsNumberAreaCode(unittest.IsolatedAsyncioTestCase):
    async def test_area_code_is_sent_as_a_search_param(self):
        search = _resp(200, {"available_phone_numbers": [{"phone_number": "+14155550000"}]})
        purchase = _resp(200, {"phone_number": "+14155550000", "sid": "PN1"})
        with patch("httpx.AsyncClient") as MockClient:
            client = MockClient.return_value.__aenter__.return_value
            client.get = AsyncMock(return_value=search)
            client.post = AsyncMock(return_value=purchase)
            result = await twilio_service.buy_us_number(area_code="415", account_sid="ACuser", auth_token="tok")
            self.assertEqual(result, {"number": "+14155550000", "sid": "PN1"})
            params = client.get.call_args.kwargs["params"]
            self.assertEqual(params.get("AreaCode"), "415")

    async def test_no_area_code_omits_the_param(self):
        search = _resp(200, {"available_phone_numbers": [{"phone_number": "+14155550000"}]})
        purchase = _resp(200, {"phone_number": "+14155550000", "sid": "PN1"})
        with patch("httpx.AsyncClient") as MockClient:
            client = MockClient.return_value.__aenter__.return_value
            client.get = AsyncMock(return_value=search)
            client.post = AsyncMock(return_value=purchase)
            await twilio_service.buy_us_number(account_sid="ACuser", auth_token="tok")
            params = client.get.call_args.kwargs["params"]
            self.assertNotIn("AreaCode", params)

    async def test_falls_back_to_any_area_code_when_requested_one_has_none(self):
        empty = _resp(200, {"available_phone_numbers": []})
        fallback_hit = _resp(200, {"available_phone_numbers": [{"phone_number": "+12125550000"}]})
        purchase = _resp(200, {"phone_number": "+12125550000", "sid": "PN2"})
        with patch("httpx.AsyncClient") as MockClient:
            client = MockClient.return_value.__aenter__.return_value
            client.get = AsyncMock(side_effect=[empty, fallback_hit])
            client.post = AsyncMock(return_value=purchase)
            result = await twilio_service.buy_us_number(area_code="000", account_sid="ACuser", auth_token="tok")
            self.assertEqual(result["number"], "+12125550000")
            self.assertEqual(client.get.call_count, 2)
            first_params = client.get.call_args_list[0].kwargs["params"]
            second_params = client.get.call_args_list[1].kwargs["params"]
            self.assertEqual(first_params.get("AreaCode"), "000")
            self.assertNotIn("AreaCode", second_params)

    async def test_raises_when_nothing_available_even_after_fallback(self):
        empty = _resp(200, {"available_phone_numbers": []})
        with patch("httpx.AsyncClient") as MockClient:
            client = MockClient.return_value.__aenter__.return_value
            client.get = AsyncMock(return_value=empty)
            with self.assertRaises(RuntimeError):
                await twilio_service.buy_us_number(area_code="000", account_sid="ACuser", auth_token="tok")

    async def test_missing_credentials_raises_before_any_network_call(self):
        old_sid, old_token = settings.twilio_account_sid, settings.twilio_auth_token
        settings.twilio_account_sid, settings.twilio_auth_token = "", ""
        try:
            with patch("httpx.AsyncClient") as MockClient:
                with self.assertRaises(RuntimeError):
                    await twilio_service.buy_us_number(account_sid=None, auth_token=None)
                MockClient.assert_not_called()
        finally:
            settings.twilio_account_sid, settings.twilio_auth_token = old_sid, old_token

    async def test_byot_credentials_override_the_platform_fallback(self):
        """account_sid/auth_token passed explicitly (BYOT) must be used verbatim, never
        silently replaced by the platform's own configured credentials."""
        search = _resp(200, {"available_phone_numbers": [{"phone_number": "+14155550000"}]})
        purchase = _resp(200, {"phone_number": "+14155550000", "sid": "PN1"})
        with patch("httpx.AsyncClient") as MockClient:
            client = MockClient.return_value.__aenter__.return_value
            client.get = AsyncMock(return_value=search)
            client.post = AsyncMock(return_value=purchase)
            await twilio_service.buy_us_number(account_sid="ACuseraccount", auth_token="user-token")
            url = client.get.call_args.args[0]
            self.assertIn("ACuseraccount", url)
            self.assertEqual(client.get.call_args.kwargs["auth"], ("ACuseraccount", "user-token"))


class ValidateCredentials(unittest.IsolatedAsyncioTestCase):
    async def test_active_account_is_valid(self):
        resp = _resp(200, {"status": "active"})
        with patch("httpx.AsyncClient") as MockClient:
            client = MockClient.return_value.__aenter__.return_value
            client.get = AsyncMock(return_value=resp)
            self.assertTrue(await twilio_service.validate_credentials("ACx", "tok"))

    async def test_suspended_account_is_invalid(self):
        resp = _resp(200, {"status": "suspended"})
        with patch("httpx.AsyncClient") as MockClient:
            client = MockClient.return_value.__aenter__.return_value
            client.get = AsyncMock(return_value=resp)
            self.assertFalse(await twilio_service.validate_credentials("ACx", "tok"))

    async def test_wrong_credentials_401_is_invalid(self):
        resp = _resp(401, {})
        with patch("httpx.AsyncClient") as MockClient:
            client = MockClient.return_value.__aenter__.return_value
            client.get = AsyncMock(return_value=resp)
            self.assertFalse(await twilio_service.validate_credentials("ACx", "wrong"))

    async def test_network_error_propagates_as_exception(self):
        """Confirms the exception actually propagates out of this function — the
        try/except that turns it into a clean user-facing error lives one layer up,
        in twilio_byot_service.save_credentials (see test_byot.py)."""
        with patch("httpx.AsyncClient") as MockClient:
            client = MockClient.return_value.__aenter__.return_value
            client.get = AsyncMock(side_effect=TimeoutError("simulated"))
            with self.assertRaises(TimeoutError):
                await twilio_service.validate_credentials("ACx", "tok")


if __name__ == "__main__":
    unittest.main()
