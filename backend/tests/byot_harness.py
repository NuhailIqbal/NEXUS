"""
BYOT (Bring Your Own Twilio) test harness.

Reuses `qa_harness`'s already-bootstrapped throwaway database and TestClient (same
pattern every other test file in this suite uses) instead of standing up a second
database — two harness modules each pointing `config.settings.database_url` at a
different throwaway DB would race at test-discovery time (whichever is imported
last "wins" and silently redirects every other file's app-level DB traffic to its
own database), breaking unrelated test files. Adds BYOT-specific mocks for VAPI
phone-number functions and outbound Twilio calls on top of that shared harness.

Run from the backend folder:  python -m unittest discover -s tests -v
"""
import uuid
from unittest.mock import AsyncMock, patch

import qa_harness as h
from qa_harness import client, sql, make_user, token_for, auth, reset_rate_limits  # noqa: F401
from database import supabase  # noqa: F401
from services import vapi_client, twilio_service, twilio_byot_service
from routers import billing as billing_router


class VapiPhoneMock:
    """Replaces every VAPI phone-number (and assistant, for the fallback-assistant
    lazy-create path) network function used by telephony.py."""

    def __init__(self):
        self.n = 0
        self.create_phone_number = AsyncMock(side_effect=self._create_phone_number)
        self.update_phone_number = AsyncMock(return_value={})
        self.delete_phone_number = AsyncMock(return_value=None)
        self.create_assistant = AsyncMock(side_effect=self._create_assistant)

    async def _create_phone_number(self, payload):
        self.n += 1
        return {"id": f"vapi-phone-{self.n}-{uuid.uuid4().hex[:6]}"}

    async def _create_assistant(self, payload):
        self.n += 1
        return {"id": f"asst-{self.n}-{uuid.uuid4().hex[:6]}"}

    def start(self):
        self._patches = [
            patch.object(vapi_client, name, getattr(self, name))
            for name in ("create_phone_number", "update_phone_number",
                         "delete_phone_number", "create_assistant")
        ]
        for p in self._patches:
            p.start()
        return self

    def stop(self):
        for p in self._patches:
            p.stop()


class TwilioMock:
    """Replaces every outbound Twilio network function used by telephony.py and
    twilio_byot_service.py. `valid_credentials` controls validate_credentials' result
    (settable per-test); `fail_purchase`/`fail_release` force a RuntimeError to
    exercise the error/rollback paths."""

    def __init__(self):
        self.n = 0
        self.valid_credentials = True
        self.fail_purchase = False
        self.fail_release = False
        self.buy_calls: list[dict] = []
        self.release_calls: list[dict] = []
        self.buy_us_number = AsyncMock(side_effect=self._buy_us_number)
        self.release_number = AsyncMock(side_effect=self._release_number)
        # Defaults to "found" (a fake sid) so existing import-mode tests don't all have to
        # configure it — set to None in a specific test to exercise the "not found" path.
        self.find_sid_by_number = AsyncMock(return_value="PNimported000001")
        self.validate_credentials = AsyncMock(side_effect=self._validate_credentials)

    async def _buy_us_number(self, sms=True, voice=True, area_code=None,
                             account_sid=None, auth_token=None):
        self.buy_calls.append({"area_code": area_code, "account_sid": account_sid})
        if self.fail_purchase:
            raise RuntimeError("Twilio purchase failed (simulated)")
        self.n += 1
        return {"number": f"+1555000{self.n:04d}", "sid": f"PNfake{self.n:06d}"}

    async def _release_number(self, sid, account_sid=None, auth_token=None):
        self.release_calls.append({"sid": sid, "account_sid": account_sid})
        if self.fail_release:
            raise RuntimeError("Twilio release failed (simulated)")
        return None

    async def _validate_credentials(self, account_sid, auth_token):
        if callable(self.valid_credentials):
            return self.valid_credentials(account_sid, auth_token)
        return self.valid_credentials

    def start(self):
        self._patches = [
            patch.object(twilio_service, "buy_us_number", self.buy_us_number),
            patch.object(twilio_service, "release_number", self.release_number),
            patch.object(twilio_service, "find_sid_by_number", self.find_sid_by_number),
            # twilio_byot_service imported validate_credentials by name (`from
            # services.twilio_service import validate_credentials`), so patching the
            # defining module's attribute would NOT be seen there — patch the
            # consuming module's own reference instead.
            patch.object(twilio_byot_service, "validate_credentials", self.validate_credentials),
        ]
        for p in self._patches:
            p.start()
        return self

    def stop(self):
        for p in self._patches:
            p.stop()


def connect_twilio(user_id: str, account_sid="ACuserfakesid00000000000000000000",
                   auth_token="user-fake-auth-token", label=None) -> dict:
    r = client.post("/telephony/twilio-credentials",
                    json={"account_sid": account_sid, "auth_token": auth_token, "label": label},
                    headers=auth(user_id))
    assert r.status_code == 200, r.text
    return r.json()["data"]


def fund_wallet(user_id: str, amount: float) -> None:
    billing_router.credit_balance(user_id, amount, "admin", "QA test funding")
