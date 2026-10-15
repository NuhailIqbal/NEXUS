"""
Inbound caller verification: the lookup client, the per-call routing decision, the webhook that
carries it, the per-number toggle and every code path that re-routes a number.

The provider responses used below are the REAL bodies observed from the live lookup endpoint
(only identifiers shortened), so the parsing is tested against what it really returns:
`found` means "the line is mobile", and failures (bad key, 502 from the upstream) ALSO say
found:false, which must never be mistaken for a verdict.

Run from the backend folder:  python -m unittest discover -s tests -v
"""
import asyncio
import gc
import hashlib
import hmac
import json
import logging
import time
import unittest
import uuid
from unittest.mock import AsyncMock, patch

import httpx

import byot_harness as H
from config import Settings, settings
from database import supabase
from routers import telephony, webhooks
from services import caller_lookup, caller_verification as cv, vapi_client

# ── Real provider bodies ──


def _raw(message, code, phone, results):
    """The upstream's own response, which the provider embeds as a JSON *string* in `raw`."""
    return json.dumps({"sid": "0a9e111c", "status": "success", "message": message, "code": code,
                       "offset": 1791580355003937, "wireless": 0, "phone": phone,
                       "results": results, "time": 0, "scrubs": True})


NO_LINE_TYPE = "Line type not present in BLA response"
MOBILE = (200, json.dumps({"found": True, "lineType": "mobile"}))
VOIP = (200, json.dumps({"found": False, "lineType": "voip"}))                 # Google's real main line
LANDLINE = (200, json.dumps({"found": False, "lineType": "landline"}))
NO_DEBUG_FALSE = (200, json.dumps({"found": False}))                           # without debug=true
INVALID_NUMBER = (502, json.dumps({"found": False, "error": NO_LINE_TYPE, "raw": _raw("Good", "none", "", 0)}))
DNC_LISTED = (502, json.dumps({"found": False, "error": NO_LINE_TYPE,
                               "raw": _raw("FederalDNC", "federal-dnc", "8005551212", 1)}))
BAD_KEY = (400, json.dumps({"found": False, "error": "Invalid Api Key"}))      # found:false but NOT a verdict
BAD_PHONE = (400, json.dumps({"found": False, "error": "Please provide a valid 10 digit phoneNumber"}))
BAD_CODE = (401, "")

CODE, API_KEY = "test-function-code==", "11111111-2222-3333-4444-555555555555"


def run(coro):
    return asyncio.run(coro)


def patch_settings(case: unittest.TestCase, **values):
    """Set attributes on the live settings object for one test and restore them afterwards."""
    for name, value in values.items():
        p = patch.object(settings, name, value)
        p.start()
        case.addCleanup(p.stop)


class LookupFake:
    """Stands in for caller_lookup._fetch. `by_number` maps a 10-digit number to a (status, body)
    tuple, an Exception to raise, or a number of seconds to sleep; `default` covers the rest.
    `calls` records every number that was looked up."""

    def __init__(self, default=MOBILE):
        self.default = default
        self.by_number: dict = {}
        self.calls: list[str] = []

    async def __call__(self, national):
        self.calls.append(national)
        r = self.by_number.get(national, self.default)
        if isinstance(r, Exception):
            raise r
        if isinstance(r, (int, float)):
            await asyncio.sleep(r)
            return self.default
        return r

    def install(self, case: unittest.TestCase):
        p = patch.object(caller_lookup, "_fetch", self)
        p.start()
        case.addCleanup(p.stop)
        return self


def make_agent(user, name="Sara", assistant="auto"):
    row = {"user_id": user, "name": name,
           "vapi_assistant_id": f"asst-{uuid.uuid4().hex[:8]}" if assistant == "auto" else assistant}
    return supabase.table("ai_agents").insert(row).execute().data[0]


def make_number(user, *, agent=None, verify=False, vapi_phone_id="auto", suspended=False, number=None):
    row = {"user_id": user, "status": "Active", "provider": "vapi",
           "number": number or f"+1555{uuid.uuid4().int % 10**7:07d}",
           "caller_verification_enabled": verify, "suspended_for_balance": suspended}
    if vapi_phone_id == "auto":
        row["vapi_phone_id"] = f"vpn-{uuid.uuid4().hex[:10]}"
    elif vapi_phone_id:
        row["vapi_phone_id"] = vapi_phone_id
    if agent:
        row["agent_id"] = agent["id"]
    return supabase.table("phone_numbers").insert(row).execute().data[0]


def number_row(number_id):
    return supabase.table("phone_numbers").select("*").eq("id", number_id).execute().data[0]


def request_body(vapi_phone_id, caller="+15551230001", call_id=None, **call_extra):
    """A VAPI `assistant-request` as it arrives for an inbound call. phoneNumber.number is OUR
    number on purpose: it must never be mistaken for the caller."""
    call = {"id": call_id or f"call-{uuid.uuid4().hex[:8]}", "type": "inboundPhoneCall",
            "phoneNumberId": vapi_phone_id, "customer": {"number": caller}, **call_extra}
    return {"message": {"type": "assistant-request", "call": call,
                        "phoneNumber": {"id": vapi_phone_id, "number": "+15559990000"}}}


def screenings(user, **where):
    q = supabase.table("inbound_call_screenings").select("*").eq("user_id", user)
    for k, v in where.items():
        q = q.eq(k, v)
    return q.order("created_at", desc=False).execute().data


class Base(unittest.TestCase):
    """A fresh account, VAPI phone mock, configured lookup credentials and a lookup fake."""

    def setUp(self):
        H.reset_rate_limits()
        webhooks.limiter.reset()
        webhooks.reset_inbound_rate_limit()
        # The rate-limit test exhausts the webhook buckets on purpose; never leave that behind
        # for whichever test module runs next.
        self.addCleanup(webhooks.limiter.reset)
        self.user = H.make_user()
        self.vapi = H.VapiPhoneMock().start()
        self.addCleanup(self.vapi.stop)
        patch_settings(self, caller_lookup_code=CODE, caller_lookup_api_key=API_KEY)
        self.lookup = LookupFake().install(self)
        # Switching ON checks that VAPI could reach this server (a real HTTP request to the public
        # URL); here it succeeds without any network. test_caller_verification_ops tests the probe.
        self.reachable = AsyncMock(return_value=(True, None))
        p = patch.object(cv, "check_reachable", self.reachable)
        p.start()
        self.addCleanup(p.stop)

    def post_request(self, vapi_phone_id, caller="+15551230001", path="/webhooks/vapi/inbound", **kw):
        return H.client.post(path, json=request_body(vapi_phone_id, caller, **kw))

    def answer(self, vapi_phone_id, caller="+15551230001", **kw) -> dict:
        r = self.post_request(vapi_phone_id, caller, **kw)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def patch_number(self, number_id, body, user=None):
        return H.client.patch(f"/telephony/phone-numbers/{number_id}", json=body,
                              headers=H.auth(user or self.user))


# ═══════════════════════════════════════════════════════════════════════════
# Pure logic: what to do with a caller id, how to read a provider response
# ═══════════════════════════════════════════════════════════════════════════


class ParseCallerNumberTests(unittest.TestCase):
    def test_us_numbers_in_every_spelling_become_ten_digits(self):
        for raw in ("+15551234567", "15551234567", "5551234567", "(555) 123-4567", "+1 (555) 123-4567",
                    "+1-555-123-4567", "  +15551234567  ", "555.123.4567", 15551234567):
            with self.subTest(raw=raw):
                p = caller_lookup.parse_caller_number(raw)
                self.assertEqual((p.kind, p.national), ("us", "5551234567"))

    def test_plus_one_with_the_wrong_number_of_digits_is_not_a_real_number(self):
        for raw in ("+1555123456", "+155512345678", "+1", "+15", "+1555123456789012"):
            with self.subTest(raw=raw):
                self.assertEqual(caller_lookup.parse_caller_number(raw).kind, "invalid_us")

    def test_other_countries_cannot_be_looked_up(self):
        # The provider would silently evaluate the LAST 10 digits as a US number.
        for raw in ("+442079304832", "+33142685300", "+4915123456789", "+266696687", "+81312345678"):
            with self.subTest(raw=raw):
                self.assertEqual(caller_lookup.parse_caller_number(raw).kind, "foreign")

    def test_extensions_short_codes_and_sip_addresses_cannot_be_verified(self):
        for raw in ("1001", "911", "86767", "123456789", "sip:1001@pbx.example.com",
                    "+15551234567x12", "555-123-4567 ext 12", "12345678901234"):
            with self.subTest(raw=raw):
                self.assertEqual(caller_lookup.parse_caller_number(raw).kind, "other")

    def test_no_number_at_all(self):
        for raw in (None, "", "   ", "+", "anonymous", "Restricted", "unknown", "Unavailable", "-"):
            with self.subTest(raw=raw):
                self.assertEqual(caller_lookup.parse_caller_number(raw).kind, "none")

    def test_garbage_never_raises(self):
        for raw in ({"a": 1}, ["+15551234567"], 3.14, True, "x" * 10000, "\x00\x01", "+" + "9" * 5000):
            with self.subTest(raw=str(raw)[:20]):
                caller_lookup.parse_caller_number(raw)


class ClassifyResponseTests(unittest.TestCase):
    def check(self, response, outcome, line_type=None, detail=None):
        r = caller_lookup.classify_response(*response)
        self.assertEqual((r.outcome, r.line_type, r.detail), (outcome, line_type, detail), response)
        return r

    # ── verdicts ──
    def test_found_true_is_mobile(self):
        self.check(MOBILE, "mobile", "mobile")

    def test_found_true_without_a_line_type_is_still_mobile(self):
        self.check((200, '{"found": true}'), "mobile", "mobile")

    def test_found_false_is_not_mobile_whatever_the_line_type(self):
        self.check(VOIP, "not_mobile", "voip", "found_false")
        self.check(LANDLINE, "not_mobile", "landline", "found_false")
        self.check(NO_DEBUG_FALSE, "not_mobile", None, "found_false")

    def test_line_type_is_normalised(self):
        self.check((200, '{"found": false, "lineType": " VoIP "}'), "not_mobile", "voip", "found_false")

    def test_the_502_with_no_line_type_is_a_verdict_for_invalid_and_dnc_listed_numbers(self):
        self.check(INVALID_NUMBER, "not_mobile", None, "no_line_type")
        self.check(DNC_LISTED, "not_mobile", None, "no_line_type")

    def test_the_502_raw_may_also_arrive_as_an_object(self):
        body = json.dumps({"found": False, "error": NO_LINE_TYPE, "raw": json.loads(_raw("Good", "none", "", 0))})
        self.check((502, body), "not_mobile", None, "no_line_type")

    # ── failures that say found:false but are NOT verdicts ──
    def test_bad_api_key_is_a_failure_not_a_refusal(self):
        with self.assertLogs(caller_lookup.logger, "ERROR"):
            self.check(BAD_KEY, "unavailable", None, "credentials_rejected")

    def test_bad_or_missing_function_code_is_a_failure(self):
        with self.assertLogs(caller_lookup.logger, "ERROR"):
            self.check(BAD_CODE, "unavailable", None, "credentials_rejected")
        with self.assertLogs(caller_lookup.logger, "ERROR"):
            self.check((403, ""), "unavailable", None, "credentials_rejected")

    def test_a_rejected_phone_number_is_a_failure(self):
        self.check(BAD_PHONE, "unavailable", None, "http_400")

    def test_rate_limit_and_server_errors_are_failures(self):
        self.check((429, "slow down"), "unavailable", None, "rate_limited")
        for status in (500, 503, 504, 404, 302, 201, 204):
            with self.subTest(status=status):
                self.check((status, '{"found": false}'), "unavailable", None, f"http_{status}")

    def test_a_502_that_is_not_the_no_line_type_verdict_is_an_outage(self):
        self.check((502, ""), "unavailable", None, "http_502")
        self.check((502, "<html>Bad Gateway</html>"), "unavailable", None, "http_502")
        self.check((502, json.dumps({"found": False, "error": "BLA request failed"})), "unavailable", None, "http_502")
        # Right message but no upstream success report: indistinguishable from an upstream outage.
        self.check((502, json.dumps({"found": False, "error": NO_LINE_TYPE})), "unavailable", None, "http_502")
        for raw in ("not json", json.dumps({"status": "error"}), json.dumps({"results": 0}), "", None, 7):
            body = json.dumps({"found": False, "error": NO_LINE_TYPE, "raw": raw})
            with self.subTest(raw=raw):
                self.check((502, body), "unavailable", None, "http_502")
        # found must be exactly False for the verdict.
        body = json.dumps({"found": True, "error": NO_LINE_TYPE, "raw": _raw("Good", "none", "", 0)})
        self.check((502, body), "unavailable", None, "http_502")

    def test_unreadable_200_bodies_are_failures(self):
        for body in ("", "<html>ok</html>", "null", "[]", "{}", '{"found": null}', '{"found": "true"}',
                     '{"found": 1}', '{"lineType": "mobile"}', '"found"', "[true]"):
            with self.subTest(body=body):
                self.check((200, body), "unavailable", None, "bad_response")


# ═══════════════════════════════════════════════════════════════════════════
# The HTTP client
# ═══════════════════════════════════════════════════════════════════════════


class LookupMobileTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        patch_settings(self, caller_lookup_code=CODE, caller_lookup_api_key=API_KEY,
                       caller_lookup_url="https://lookup.example.test/api/LineTypeLookup",
                       caller_lookup_timeout_seconds=1.0)
        self.requests: list[httpx.Request] = []

    def use_transport(self, handler):
        def recording(request):
            self.requests.append(request)
            return handler(request)
        p = patch.object(caller_lookup, "_TRANSPORT", httpx.MockTransport(recording))
        p.start()
        self.addCleanup(p.stop)

    async def test_request_carries_exactly_the_documented_parameters(self):
        self.use_transport(lambda req: httpx.Response(200, json={"found": True, "lineType": "mobile"}))
        result = await caller_lookup.lookup_mobile("5551234567")
        self.assertEqual(result.outcome, "mobile")
        (req,) = self.requests
        self.assertEqual(req.method, "GET")
        self.assertEqual((req.url.host, req.url.path), ("lookup.example.test", "/api/LineTypeLookup"))
        self.assertEqual(dict(req.url.params), {"code": CODE, "phoneNumber": "5551234567", "type": "mobile",
                                                "debug": "true", "apiKey": API_KEY})

    async def test_not_configured_makes_no_request(self):
        patch_settings(self, caller_lookup_api_key="")
        self.use_transport(lambda req: httpx.Response(200, json={"found": True}))
        result = await caller_lookup.lookup_mobile("5551234567")
        self.assertEqual((result.outcome, result.detail), ("unavailable", "not_configured"))
        self.assertEqual(self.requests, [])

    async def test_network_error_is_unavailable_and_never_raises(self):
        def boom(request):
            raise httpx.ConnectError("name resolution failed for https://lookup.example.test/?apiKey=SECRET")
        self.use_transport(boom)
        with self.assertLogs(caller_lookup.logger, "WARNING") as logs:
            result = await caller_lookup.lookup_mobile("5551234567")
        self.assertEqual((result.outcome, result.detail), ("unavailable", "network_error"))
        # Only the exception TYPE is logged: its message can embed the URL and so the credentials.
        self.assertNotIn("SECRET", "\n".join(logs.output))
        self.assertNotIn("apiKey", "\n".join(logs.output))

    async def test_unexpected_exception_type_is_unavailable(self):
        def boom(request):
            raise RuntimeError("anything")
        self.use_transport(boom)
        result = await caller_lookup.lookup_mobile("5551234567")
        self.assertEqual((result.outcome, result.detail), ("unavailable", "network_error"))

    async def test_connection_timeout_is_unavailable_timeout(self):
        def slow(request):
            raise httpx.ReadTimeout("read timed out")
        self.use_transport(slow)
        result = await caller_lookup.lookup_mobile("5551234567")
        self.assertEqual((result.outcome, result.detail), ("unavailable", "timeout"))

    async def test_deadline_is_hard_even_when_the_request_never_finishes(self):
        patch_settings(self, caller_lookup_timeout_seconds=0.3)

        async def never(request):
            await asyncio.sleep(30)
            return httpx.Response(200, json={"found": True})
        self.use_transport(never)
        t0 = time.perf_counter()
        result = await caller_lookup.lookup_mobile("5551234567")
        elapsed = time.perf_counter() - t0
        self.assertEqual((result.outcome, result.detail), ("unavailable", "timeout"))
        # A deadline that waited for the cancelled request to tear down would overrun this badly.
        self.assertLess(elapsed, 0.6)

    async def test_abandoned_request_that_fails_afterwards_is_not_reported_as_unretrieved(self):
        patch_settings(self, caller_lookup_timeout_seconds=0.1)

        async def fails_while_being_abandoned(request):
            try:
                await asyncio.sleep(30)
            except asyncio.CancelledError:
                raise httpx.ConnectError("failed while being abandoned")
            return httpx.Response(200, json={"found": True})
        self.use_transport(fails_while_being_abandoned)

        async def run_once():
            result = await caller_lookup.lookup_mobile("5551234567")
            await asyncio.sleep(0.2)  # the abandoned request ends with an exception nobody awaits
            gc.collect()
            return result

        with self.assertNoLogs("asyncio", "ERROR"):
            result = await run_once()
        self.assertEqual(result.detail, "timeout")

        # Sensitivity check: without the done-callback asyncio WOULD log it, so the assertion
        # above is really testing something.
        with patch.object(caller_lookup, "_discard_outcome", lambda task: None):
            with self.assertLogs("asyncio", "ERROR") as logs:
                await run_once()
        self.assertIn("never retrieved", "\n".join(logs.output))

    async def test_cancelling_the_caller_cancels_the_request(self):
        started = asyncio.Event()
        finished = []

        async def slow(request):
            started.set()
            try:
                await asyncio.sleep(30)
            finally:
                finished.append(True)
            return httpx.Response(200, json={"found": True})
        self.use_transport(slow)
        task = asyncio.create_task(caller_lookup.lookup_mobile("5551234567"))
        await started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        await asyncio.sleep(0.05)
        self.assertEqual(finished, [True])

    async def test_each_provider_response_maps_end_to_end(self):
        for response, outcome in ((MOBILE, "mobile"), (VOIP, "not_mobile"), (LANDLINE, "not_mobile"),
                                  (INVALID_NUMBER, "not_mobile"), (DNC_LISTED, "not_mobile"),
                                  (BAD_KEY, "unavailable"), (BAD_CODE, "unavailable"),
                                  ((503, "down"), "unavailable")):
            with self.subTest(status=response[0], body=response[1][:30]):
                self.use_transport(lambda req, r=response: httpx.Response(r[0], text=r[1]))
                with patch.object(caller_lookup.logger, "error"):
                    result = await caller_lookup.lookup_mobile("5551234567")
                self.assertEqual(result.outcome, outcome)


class RedactionTests(unittest.IsolatedAsyncioTestCase):
    """httpx logs every request URL at INFO, query string included; the credentials must not
    survive that, whatever level the deployment logs at."""

    def setUp(self):
        patch_settings(self, caller_lookup_code=CODE, caller_lookup_api_key=API_KEY,
                       caller_lookup_url="https://lookup.example.test/api/LineTypeLookup")

    async def test_credentials_are_masked_in_httpx_request_logs(self):
        transport = httpx.MockTransport(lambda req: httpx.Response(200, json={"found": True}))
        with patch.object(caller_lookup, "_TRANSPORT", transport):
            with self.assertLogs("httpx", "INFO") as logs:
                await caller_lookup.lookup_mobile("5551234567")
        text = "\n".join(logs.output)
        self.assertIn("HTTP Request", text)
        self.assertNotIn(API_KEY, text)
        self.assertNotIn(CODE, text)
        self.assertNotIn("test-function-code", text)  # also in its URL-encoded form
        self.assertIn("apiKey=***", text)
        self.assertIn("phoneNumber=5551234567", text)  # only the secrets are masked

    def test_filter_masks_every_credential_parameter_and_keeps_other_text(self):
        f = caller_lookup._RedactLookupSecrets()
        rec = logging.LogRecord("httpx", logging.INFO, __file__, 1,
                                'HTTP Request: %s %s "%s"', ("GET", "https://h/x?code=AbC==&secret=S3&apiKey=K&p=1", "ok"), None)
        self.assertTrue(f.filter(rec))
        out = rec.getMessage()
        self.assertNotRegex(out, r"AbC|S3|=K")
        self.assertIn("p=1", out)
        self.assertIn("GET", out)

    def test_filter_never_breaks_odd_records(self):
        f = caller_lookup._RedactLookupSecrets()
        for args in (None, (), (1, 2), ({"a": 1},), (object(),)):
            rec = logging.LogRecord("httpx", logging.INFO, __file__, 1, "msg %s", args, None)
            self.assertTrue(f.filter(rec))


class SettingsTests(unittest.TestCase):
    def test_configured_needs_both_credentials(self):
        blank = dict(_env_file=None, caller_lookup_code="", caller_lookup_api_key="")
        self.assertFalse(Settings(**blank).caller_lookup_configured)
        self.assertFalse(Settings(**{**blank, "caller_lookup_code": "c"}).caller_lookup_configured)
        self.assertFalse(Settings(**{**blank, "caller_lookup_api_key": "k"}).caller_lookup_configured)
        self.assertTrue(Settings(**{**blank, "caller_lookup_code": "c", "caller_lookup_api_key": "k"}).caller_lookup_configured)

    def test_defaults(self):
        s = Settings(_env_file=None)
        self.assertEqual(s.caller_lookup_url, "https://hooks.whitelistdata.com/api/LineTypeLookup")
        # Well under VAPI's ~7.5 s end-to-end limit, above the provider's measured 1.4-3.2 s.
        self.assertTrue(3.0 <= s.caller_lookup_timeout_seconds <= 6.0)


# ═══════════════════════════════════════════════════════════════════════════
# The webhook: authentication and dispatch
# ═══════════════════════════════════════════════════════════════════════════

ROUTES = ("/webhooks/vapi", "/webhooks/vapi/inbound")


class WebhookAuthTests(Base):
    SECRET = "s3cret-value"

    def post(self, path, body=None, headers=None):
        raw = json.dumps(body if body is not None else {"message": {"type": "status-update"}}).encode()
        return H.client.post(path, content=raw, headers={"Content-Type": "application/json", **(headers or {})})

    def sig(self, body: dict, key=None):
        raw = json.dumps(body).encode()
        return hmac.new((key or self.SECRET).encode(), raw, hashlib.sha256).hexdigest()

    def test_without_a_configured_secret_requests_are_accepted(self):
        for path in ROUTES:
            self.assertEqual(self.post(path).status_code, 200)

    def test_with_a_secret_a_request_without_credentials_is_rejected(self):
        patch_settings(self, vapi_webhook_secret=self.SECRET)
        for path in ROUTES:
            self.assertEqual(self.post(path).status_code, 401, path)

    def test_x_vapi_secret_header_is_accepted_exactly_as_vapi_sends_it(self):
        patch_settings(self, vapi_webhook_secret=self.SECRET)
        for path in ROUTES:
            self.assertEqual(self.post(path, headers={"X-Vapi-Secret": self.SECRET}).status_code, 200, path)
            # header names are case-insensitive
            self.assertEqual(self.post(path, headers={"x-vapi-secret": self.SECRET}).status_code, 200, path)

    def test_bearer_token_is_accepted(self):
        patch_settings(self, vapi_webhook_secret=self.SECRET)
        for path in ROUTES:
            self.assertEqual(self.post(path, headers={"Authorization": f"Bearer {self.SECRET}"}).status_code, 200)
            self.assertEqual(self.post(path, headers={"Authorization": f"bearer  {self.SECRET} "}).status_code, 200)

    def test_hmac_signature_still_works(self):
        patch_settings(self, vapi_webhook_secret=self.SECRET)
        body = {"message": {"type": "status-update"}}
        for path in ROUTES:
            self.assertEqual(self.post(path, body, {"x-vapi-signature": self.sig(body)}).status_code, 200, path)

    def test_wrong_credentials_are_rejected(self):
        patch_settings(self, vapi_webhook_secret=self.SECRET)
        body = {"message": {"type": "status-update"}}
        bad = [{"X-Vapi-Secret": "wrong"}, {"X-Vapi-Secret": self.SECRET[:-1]}, {"X-Vapi-Secret": self.SECRET + "x"},
               {"X-Vapi-Secret": ""}, {"Authorization": "Bearer wrong"}, {"Authorization": "Bearer "},
               {"Authorization": self.SECRET}, {"Authorization": f"Basic {self.SECRET}"},
               {"x-vapi-signature": "nope"}, {"x-vapi-signature": self.sig(body, key="other-secret")},
               {"x-vapi-signature": self.sig({"message": {"type": "different"}})}]
        for path in ROUTES:
            for headers in bad:
                with self.subTest(path=path, headers=headers):
                    self.assertEqual(self.post(path, body, headers).status_code, 401)

    def test_non_ascii_credentials_are_rejected_not_a_server_error(self):
        patch_settings(self, vapi_webhook_secret=self.SECRET)
        # A raw 0xE9 byte (latin-1 "é"), which httpx only lets us send as bytes.
        r = H.client.post("/webhooks/vapi/inbound", content=b'{"message": {}}',
                          headers={"X-Vapi-Secret": b"caf\xe9", "Authorization": b"Bearer caf\xe9"})
        self.assertEqual(r.status_code, 401)

    def test_a_rejected_assistant_request_reveals_nothing(self):
        patch_settings(self, vapi_webhook_secret=self.SECRET)
        agent = make_agent(self.user)
        num = make_number(self.user, agent=agent, verify=True)
        r = self.post_request(num["vapi_phone_id"])
        self.assertEqual(r.status_code, 401)
        self.assertNotIn(agent["vapi_assistant_id"], r.text)
        self.assertEqual(self.lookup.calls, [])

    def test_malformed_bodies(self):
        for path in ROUTES:
            self.assertEqual(H.client.post(path, content=b"not json").status_code, 400)
            self.assertEqual(H.client.post(path, content=b"").status_code, 400)
            self.assertEqual(H.client.post(path, content=b"[1, 2]").status_code, 400)
            self.assertEqual(H.client.post(path, json={"message": "text"}).status_code, 400)
            self.assertEqual(H.client.post(path, json={"message": None}).status_code, 400)
            # Acknowledged as before: a body without a message is not an error.
            r = H.client.post(path, json={})
            self.assertEqual((r.status_code, r.json()), (200, {"received": True, "type": ""}))

    def test_other_events_behave_identically_on_both_routes(self):
        for path in ROUTES:
            r = H.client.post(path, json={"message": {"type": "transcript"}})
            self.assertEqual((r.status_code, r.json()), (200, {"received": True, "type": "transcript"}), path)

    def test_the_inbound_route_has_a_higher_rate_limit_than_the_event_route(self):
        # 130 requests inside a minute: the events route throttles at 120, the inbound one must
        # not, because a 429 there would drop a live call.
        inbound = [self.post("/webhooks/vapi/inbound").status_code for _ in range(130)]
        self.assertEqual(set(inbound), {200})
        events = [self.post("/webhooks/vapi").status_code for _ in range(130)]
        self.assertEqual(events[:120], [200] * 120)
        self.assertEqual(set(events[120:]), {429})


# ═══════════════════════════════════════════════════════════════════════════
# The per-call decision
# ═══════════════════════════════════════════════════════════════════════════


class AssistantRequestTests(Base):
    def setUp(self):
        super().setUp()
        self.agent = make_agent(self.user)
        self.num = make_number(self.user, agent=self.agent, verify=True)
        self.vid = self.num["vapi_phone_id"]
        self.asst = self.agent["vapi_assistant_id"]

    # ── the rule you asked for ──
    def test_a_mobile_caller_is_answered_by_the_agent(self):
        self.assertEqual(self.answer(self.vid), {"assistantId": self.asst})
        self.assertEqual(self.lookup.calls, ["5551230001"])

    def test_a_caller_the_lookup_says_is_not_found_is_refused_and_the_agent_never_starts(self):
        self.lookup.default = VOIP
        out = self.answer(self.vid)
        self.assertEqual(out, {"error": cv.REFUSAL_MESSAGE})
        self.assertNotIn("assistantId", out)

    def test_every_not_mobile_answer_is_refused(self):
        for response in (VOIP, LANDLINE, NO_DEBUG_FALSE, INVALID_NUMBER, DNC_LISTED):
            with self.subTest(body=response[1][:40]):
                self.lookup.default = response
                self.assertEqual(self.answer(self.vid), {"error": cv.REFUSAL_MESSAGE})

    def test_the_refusal_is_one_short_sentence(self):
        self.assertLess(len(cv.REFUSAL_MESSAGE), 60)
        self.assertNotIn("VAPI", cv.REFUSAL_MESSAGE + cv.UNAVAILABLE_MESSAGE + cv.UNAVAILABLE_REASON)

    def test_each_call_is_looked_up_with_the_callers_number_not_ours(self):
        self.answer(self.vid, caller="+14155550123")
        self.assertEqual(self.lookup.calls, ["4155550123"])  # phoneNumber.number was +15559990000

    def test_the_callers_number_is_found_wherever_vapi_puts_it(self):
        body = request_body(self.vid)
        del body["message"]["call"]["customer"]
        body["message"]["customer"] = {"number": "+14155550199"}
        self.assertEqual(H.client.post("/webhooks/vapi/inbound", json=body).json(), {"assistantId": self.asst})
        body["message"].pop("customer")
        body["message"]["call"]["from"] = {"phoneNumber": "+14155550198"}
        H.client.post("/webhooks/vapi/inbound", json=body)
        self.assertEqual(self.lookup.calls, ["4155550199", "4155550198"])

    def test_the_dialed_number_is_found_wherever_vapi_puts_it(self):
        body = request_body("ignored")
        body["message"]["call"].pop("phoneNumberId")
        body["message"]["phoneNumber"]["id"] = self.vid
        self.assertEqual(H.client.post("/webhooks/vapi/inbound", json=body).json(), {"assistantId": self.asst})
        body["message"]["phoneNumber"].pop("id")
        body["message"]["phoneNumberId"] = self.vid
        self.assertEqual(H.client.post("/webhooks/vapi/inbound", json=body).json(), {"assistantId": self.asst})

    def test_the_main_webhook_route_answers_assistant_requests_too(self):
        self.assertEqual(self.answer(self.vid, path="/webhooks/vapi"), {"assistantId": self.asst})
        self.lookup.default = LANDLINE
        self.assertEqual(self.answer(self.vid, path="/webhooks/vapi"), {"error": cv.REFUSAL_MESSAGE})

    # ── verification off ──
    def test_with_verification_off_the_call_goes_straight_to_the_agent_without_a_lookup(self):
        supabase.table("phone_numbers").update({"caller_verification_enabled": False}).eq("id", self.num["id"]).execute()
        self.lookup.default = VOIP  # would be refused if anyone asked
        self.assertEqual(self.answer(self.vid), {"assistantId": self.asst})
        self.assertEqual(self.lookup.calls, [])
        self.assertEqual(screenings(self.user), [])

    # ── failures are not verdicts: the call goes through ──
    def test_provider_failures_let_the_call_through_and_say_so_in_the_log(self):
        cases = {"bad key": BAD_KEY, "bad code": BAD_CODE, "rate limited": (429, ""), "outage": (503, "down"),
                 "502 outage": (502, "<html>"), "garbage": (200, "<html>"), "empty": (200, "")}
        for name, response in cases.items():
            with self.subTest(name):
                self.lookup.default = response
                with patch.object(caller_lookup.logger, "error"):
                    self.assertEqual(self.answer(self.vid), {"assistantId": self.asst})
        rows = screenings(self.user)
        self.assertEqual({r["reason"] for r in rows}, {"lookup_unavailable"})
        self.assertEqual({r["decision"] for r in rows}, {"answered"})
        self.assertTrue(all(r["detail"] for r in rows))

    def test_a_network_error_lets_the_call_through(self):
        self.lookup.default = httpx.ConnectError("down")
        self.assertEqual(self.answer(self.vid), {"assistantId": self.asst})
        self.assertEqual(screenings(self.user)[-1]["detail"], "network_error")

    def test_a_slow_provider_cannot_make_vapi_time_out(self):
        patch_settings(self, caller_lookup_timeout_seconds=0.3)
        self.lookup.default = 10  # seconds the lookup would take
        t0 = time.perf_counter()
        out = self.answer(self.vid)
        self.assertEqual(out, {"assistantId": self.asst})
        self.assertLess(time.perf_counter() - t0, 1.5)
        self.assertEqual(screenings(self.user)[-1]["detail"], "timeout")

    def test_missing_lookup_credentials_let_the_call_through(self):
        patch_settings(self, caller_lookup_api_key="")
        self.assertEqual(self.answer(self.vid), {"assistantId": self.asst})
        self.assertEqual(self.lookup.calls, [])
        self.assertEqual(screenings(self.user)[-1]["detail"], "not_configured")

    # ── caller ids that cannot be looked up ──
    def test_callers_with_nothing_to_verify_are_let_through_without_a_lookup(self):
        for caller in (None, "", "anonymous", "Restricted", "+442079304832", "+266696687", "1001", "sip:a@b.c"):
            with self.subTest(caller=caller):
                body = request_body(self.vid, caller)
                if caller is None:
                    body["message"]["call"].pop("customer")
                self.assertEqual(H.client.post("/webhooks/vapi/inbound", json=body).json(), {"assistantId": self.asst})
        self.assertEqual(self.lookup.calls, [])
        reasons = {r["reason"] for r in screenings(self.user)}
        self.assertEqual(reasons, {"no_caller_number", "unverifiable_number"})

    def test_a_request_with_no_caller_number_is_logged_with_its_shape_but_never_its_values(self):
        body = request_body(self.vid, "+15551230001", call_id="secret-call-id")
        del body["message"]["call"]["customer"]
        with self.assertLogs(cv.logger, "WARNING") as logs:
            r = H.client.post("/webhooks/vapi/inbound", json=body)
        self.assertEqual(r.json(), {"assistantId": self.asst})
        text = "\n".join(logs.output)
        self.assertIn("no caller number", text)
        for key in ("phoneNumberId", "id", "type"):
            self.assertIn(key, text)            # which fields arrived...
        for value in ("secret-call-id", self.vid, "+15559990000"):
            self.assertNotIn(value, text)       # ...never what they contained

    def test_a_request_with_a_caller_number_logs_no_warning(self):
        with self.assertNoLogs(cv.logger, "WARNING"):
            self.answer(self.vid)

    def test_a_plus_one_number_with_the_wrong_length_is_refused_without_a_lookup(self):
        for caller in ("+1555123", "+155512345678", "+1"):
            with self.subTest(caller=caller):
                self.assertEqual(self.answer(self.vid, caller), {"error": cv.REFUSAL_MESSAGE})
        self.assertEqual(self.lookup.calls, [])
        self.assertEqual({r["reason"] for r in screenings(self.user)}, {"invalid_number"})

    def test_odd_caller_fields_are_treated_as_absent_not_as_errors(self):
        for customer in ("a string", 5, ["+15551230001"], {"number": {"x": 1}}, {"number": ["+1"]}):
            with self.subTest(customer=customer):
                body = request_body(self.vid)
                body["message"]["call"]["customer"] = customer
                r = H.client.post("/webhooks/vapi/inbound", json=body)
                self.assertEqual(r.status_code, 200)
                self.assertIn("assistantId", r.json())

    # ── routing around verification ──
    def test_a_number_vapi_sends_us_that_we_do_not_know_gets_an_error(self):
        out = self.answer("vpn-does-not-exist")
        self.assertEqual(out, {"error": cv.UNAVAILABLE_MESSAGE})
        self.assertEqual(self.lookup.calls, [])
        for body in ({"message": {"type": "assistant-request"}},
                     {"message": {"type": "assistant-request", "call": "x"}},
                     {"message": {"type": "assistant-request", "call": {"phoneNumberId": 123}}},
                     {"message": {"type": "assistant-request", "call": {"phoneNumberId": ["a"]}}}):
            r = H.client.post("/webhooks/vapi/inbound", json=body)
            self.assertEqual((r.status_code, r.json()), (200, {"error": cv.UNAVAILABLE_MESSAGE}), body)

    def test_no_agent_assigned_means_an_error_and_no_lookup(self):
        supabase.table("phone_numbers").update({"agent_id": None}).eq("id", self.num["id"]).execute()
        self.assertEqual(self.answer(self.vid), {"error": cv.UNAVAILABLE_MESSAGE})
        self.assertEqual(self.lookup.calls, [])

    def test_an_agent_that_is_not_set_up_in_vapi_means_an_error(self):
        supabase.table("ai_agents").update({"vapi_assistant_id": None}).eq("id", self.agent["id"]).execute()
        self.assertEqual(self.answer(self.vid), {"error": cv.UNAVAILABLE_MESSAGE})

    def test_an_agent_that_belongs_to_someone_else_is_never_used(self):
        other = H.make_user()
        theirs = make_agent(other, "Theirs", "asst-theirs")
        supabase.table("phone_numbers").update({"agent_id": theirs["id"]}).eq("id", self.num["id"]).execute()
        out = self.answer(self.vid)
        self.assertEqual(out, {"error": cv.UNAVAILABLE_MESSAGE})
        self.assertNotIn("asst-theirs", json.dumps(out))

    def test_the_current_agent_is_used_so_reassigning_needs_no_vapi_change(self):
        second = make_agent(self.user, "Second")
        supabase.table("phone_numbers").update({"agent_id": second["id"]}).eq("id", self.num["id"]).execute()
        self.assertEqual(self.answer(self.vid), {"assistantId": second["vapi_assistant_id"]})

    def test_a_balance_suspended_number_is_served_by_the_fallback_assistant_without_a_lookup(self):
        supabase.table("phone_numbers").update({"suspended_for_balance": True}).eq("id", self.num["id"]).execute()
        self.lookup.default = VOIP
        out = self.answer(self.vid)
        fallback = supabase.table("platform_settings").select("fallback_assistant_id").execute().data[0]["fallback_assistant_id"]
        self.assertTrue(fallback)
        self.assertEqual(out, {"assistantId": fallback})
        self.assertNotEqual(out["assistantId"], self.asst)
        self.assertEqual(self.lookup.calls, [])

    def test_suspension_wins_even_when_no_agent_is_assigned(self):
        supabase.table("phone_numbers").update({"suspended_for_balance": True, "agent_id": None}).eq("id", self.num["id"]).execute()
        self.assertIn("assistantId", self.answer(self.vid))

    def test_a_suspended_number_with_no_fallback_available_gets_an_error(self):
        supabase.table("phone_numbers").update({"suspended_for_balance": True}).eq("id", self.num["id"]).execute()
        with patch.object(cv, "_fallback_assistant_id", AsyncMock(return_value=None)):
            self.assertEqual(self.answer(self.vid), {"error": cv.UNAVAILABLE_MESSAGE})

    # ── the audit log ──
    def test_every_verified_call_is_logged_with_what_was_decided_and_why(self):
        self.lookup.by_number = {"5551230001": MOBILE, "5551230002": VOIP, "5551230003": INVALID_NUMBER}
        self.answer(self.vid, "+15551230001", call_id="c-1")
        self.answer(self.vid, "+15551230002", call_id="c-2")
        self.answer(self.vid, "+15551230003", call_id="c-3")
        rows = {r["vapi_call_id"]: r for r in screenings(self.user)}
        self.assertEqual(rows["c-1"]["decision"], "answered")
        self.assertEqual((rows["c-1"]["reason"], rows["c-1"]["line_type"]), ("mobile_verified", "mobile"))
        self.assertEqual(rows["c-2"]["decision"], "refused")
        self.assertEqual((rows["c-2"]["reason"], rows["c-2"]["line_type"], rows["c-2"]["detail"]), ("not_mobile", "voip", "found_false"))
        self.assertEqual((rows["c-3"]["reason"], rows["c-3"]["detail"]), ("not_mobile", "no_line_type"))
        self.assertEqual(rows["c-2"]["caller_number"], "+15551230002")
        self.assertEqual(rows["c-2"]["phone_number_id"], self.num["id"])
        self.assertEqual(rows["c-2"]["user_id"], self.user)

    def test_a_failure_to_write_the_log_never_changes_the_decision(self):
        self.lookup.default = VOIP
        # Drive the real decision with only the log insert broken.
        real_table = supabase.table

        def table(name):
            if name == "inbound_call_screenings":
                raise RuntimeError("db down")
            return real_table(name)
        with patch.object(cv.supabase, "table", side_effect=table):
            self.assertEqual(self.answer(self.vid), {"error": cv.REFUSAL_MESSAGE})
        self.lookup.default = MOBILE
        with patch.object(cv.supabase, "table", side_effect=table):
            self.assertEqual(self.answer(self.vid), {"assistantId": self.asst})

    def test_over_long_values_are_truncated_not_rejected(self):
        self.lookup.default = MOBILE
        self.answer(self.vid, "+1" + "5" * 5000, call_id="c" * 500)  # invalid_us: refused, still logged
        row = screenings(self.user)[-1]
        self.assertLessEqual(len(row["caller_number"]), 64)
        self.assertLessEqual(len(row["vapi_call_id"]), 128)

    def test_non_string_call_ids_are_stored(self):
        body = request_body(self.vid)
        body["message"]["call"]["id"] = 12345
        H.client.post("/webhooks/vapi/inbound", json=body)
        self.assertEqual(screenings(self.user)[-1]["vapi_call_id"], "12345")

    # ── never raises ──
    def test_an_unexpected_error_connects_the_call_to_the_agent_instead_of_dropping_it(self):
        with patch.object(cv, "_screen", AsyncMock(side_effect=RuntimeError("boom"))):
            self.assertEqual(self.answer(self.vid), {"assistantId": self.asst})

    def test_an_unexpected_error_with_a_broken_database_still_answers_with_an_error_not_a_500(self):
        with patch.object(cv, "_find_phone", side_effect=RuntimeError("db down")):
            r = self.post_request(self.vid)
        self.assertEqual((r.status_code, r.json()), (200, {"error": cv.UNAVAILABLE_MESSAGE}))

    def test_concurrent_calls_are_decided_independently(self):
        self.lookup.by_number = {f"555123{i:04d}": (MOBILE if i % 2 == 0 else VOIP) for i in range(20)}

        async def go():
            results = await asyncio.gather(*[
                cv.handle_assistant_request(request_body(self.vid, f"+1555123{i:04d}")) for i in range(20)])
            return results
        results = run(go())
        for i, out in enumerate(results):
            expected = {"assistantId": self.asst} if i % 2 == 0 else {"error": cv.REFUSAL_MESSAGE}
            self.assertEqual(out, expected, i)

    def test_calls_on_one_account_never_touch_anothers_numbers_or_log(self):
        other = H.make_user()
        other_agent = make_agent(other, "Other")
        other_num = make_number(other, agent=other_agent, verify=True)
        self.lookup.default = VOIP
        self.assertEqual(self.answer(other_num["vapi_phone_id"]), {"error": cv.REFUSAL_MESSAGE})
        self.assertEqual(len(screenings(other)), 1)
        self.assertEqual(screenings(self.user), [])

    def test_what_happens_to_the_refused_calls_own_end_of_call_report(self):
        # VAPI reports the refused call afterwards with no assistant. It must be acknowledged and
        # leave nothing behind (no phantom conversation, no charge, no crash).
        self.lookup.default = VOIP
        call_id = f"refused-{uuid.uuid4().hex[:6]}"
        self.answer(self.vid, call_id=call_id)
        body = {"message": {"type": "end-of-call-report", "endedReason": "assistant-request-returned-error",
                            "call": {"id": call_id, "type": "inboundPhoneCall", "phoneNumberId": self.vid,
                                     "customer": {"number": "+15551230001"}},
                            "artifact": {}, "durationSeconds": 3}}
        r = H.client.post("/webhooks/vapi/inbound", json=body)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(supabase.table("conversations").select("id").eq("vapi_call_id", call_id).execute().data, [])

    def test_an_answered_call_is_then_recorded_like_any_other(self):
        # After connecting the call, VAPI's events carry the chosen assistant, so the normal
        # call logging works unchanged.
        call_id = f"answered-{uuid.uuid4().hex[:6]}"
        out = self.answer(self.vid, call_id=call_id)
        status = {"message": {"type": "status-update", "status": "in-progress",
                              "call": {"id": call_id, "type": "inboundPhoneCall", "assistantId": out["assistantId"],
                                       "phoneNumberId": self.vid, "customer": {"number": "+15551230001"}}}}
        self.assertEqual(H.client.post("/webhooks/vapi/inbound", json=status).status_code, 200)
        row = supabase.table("conversations").select("*").eq("vapi_call_id", call_id).execute().data[0]
        self.assertEqual((row["user_id"], row["direction"], row["agent_id"]), (self.user, "inbound", self.agent["id"]))


# ═══════════════════════════════════════════════════════════════════════════
# Turning it on and off
# ═══════════════════════════════════════════════════════════════════════════


class ToggleApiTests(Base):
    def setUp(self):
        super().setUp()
        self.agent = make_agent(self.user)
        self.num = make_number(self.user, agent=self.agent)

    def sent(self):
        """Every (vapi_phone_id, payload) pair pushed to VAPI so far."""
        return [(c.args[0], c.args[1]) for c in self.vapi.update_phone_number.await_args_list]

    # ── on ──
    def test_enabling_takes_the_assistant_off_the_number_and_points_vapi_at_this_server(self):
        r = self.patch_number(self.num["id"], {"caller_verification_enabled": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIs(r.json()["data"]["caller_verification_enabled"], True)
        self.assertIs(number_row(self.num["id"])["caller_verification_enabled"], True)
        self.assertEqual(self.sent(), [(self.num["vapi_phone_id"], {
            "assistantId": None,
            "server": {"url": "https://qa.example.test/webhooks/vapi/inbound"},
        })])

    def test_the_shared_secret_travels_in_the_header_vapi_documents(self):
        patch_settings(self, vapi_webhook_secret="s3cret")
        self.patch_number(self.num["id"], {"caller_verification_enabled": True})
        (_, payload), = self.sent()
        self.assertEqual(payload["server"]["headers"], {"X-Vapi-Secret": "s3cret"})
        self.assertNotIn("secret", payload["server"])  # a phone number's `server` has no inline secret field

    def test_a_trailing_slash_in_the_public_url_does_not_double_up(self):
        patch_settings(self, public_api_url="https://api.example.test/")
        self.patch_number(self.num["id"], {"caller_verification_enabled": True})
        self.assertEqual(self.sent()[0][1]["server"]["url"], "https://api.example.test/webhooks/vapi/inbound")

    def test_enabling_works_with_no_agent_assigned_yet(self):
        bare = make_number(self.user)
        self.assertEqual(self.patch_number(bare["id"], {"caller_verification_enabled": True}).status_code, 200)

    def test_enabling_twice_is_fine_and_re_sends_the_routing(self):
        for _ in range(2):
            self.assertEqual(self.patch_number(self.num["id"], {"caller_verification_enabled": True}).status_code, 200)
        self.assertEqual(len(self.sent()), 2)

    def test_the_whole_flow_end_to_end(self):
        self.patch_number(self.num["id"], {"caller_verification_enabled": True})
        self.lookup.default = VOIP
        self.assertEqual(self.answer(self.num["vapi_phone_id"]), {"error": cv.REFUSAL_MESSAGE})
        self.lookup.default = MOBILE
        self.assertEqual(self.answer(self.num["vapi_phone_id"]), {"assistantId": self.agent["vapi_assistant_id"]})
        self.patch_number(self.num["id"], {"caller_verification_enabled": False})
        self.lookup.calls.clear()
        self.lookup.default = VOIP
        self.assertEqual(self.answer(self.num["vapi_phone_id"]), {"assistantId": self.agent["vapi_assistant_id"]})
        self.assertEqual(self.lookup.calls, [])

    # ── cannot be enabled ──
    def assert_refused_without_side_effects(self, expected_status, number=None):
        number = number or self.num
        r = self.patch_number(number["id"], {"caller_verification_enabled": True})
        self.assertEqual(r.status_code, expected_status, r.text)
        self.assertIs(number_row(number["id"])["caller_verification_enabled"], False)
        self.assertEqual(self.sent(), [])
        return r

    def test_cannot_be_enabled_without_lookup_credentials(self):
        patch_settings(self, caller_lookup_code="")
        r = self.assert_refused_without_side_effects(503)
        self.assertEqual(r.json()["detail"], cv.UNAVAILABLE_REASON)

    def test_cannot_be_enabled_without_the_second_credential(self):
        patch_settings(self, caller_lookup_api_key="")
        self.assert_refused_without_side_effects(503)

    def test_cannot_be_enabled_without_a_public_url(self):
        patch_settings(self, public_api_url="")
        self.assert_refused_without_side_effects(503)

    def test_cannot_be_enabled_without_the_voice_service_key(self):
        patch_settings(self, vapi_api_key="")
        self.assert_refused_without_side_effects(503)

    def test_the_customer_message_does_not_leak_server_configuration(self):
        patch_settings(self, caller_lookup_code="")
        detail = self.patch_number(self.num["id"], {"caller_verification_enabled": True}).json()["detail"]
        for word in ("CALLER_LOOKUP", "PUBLIC_API_URL", "VAPI", ".env", "key"):
            self.assertNotIn(word, detail)

    def test_a_number_never_connected_to_the_voice_service_cannot_be_enabled(self):
        unsynced = make_number(self.user, vapi_phone_id=None)
        r = self.assert_refused_without_side_effects(400, unsynced)
        self.assertIn("isn't connected", r.json()["detail"])

    def test_someone_elses_number_is_not_found_and_untouched(self):
        other = H.make_user()
        theirs = make_number(other, agent=make_agent(other))
        r = self.patch_number(theirs["id"], {"caller_verification_enabled": True})
        self.assertEqual(r.status_code, 404)
        self.assertIs(number_row(theirs["id"])["caller_verification_enabled"], False)
        self.assertEqual(self.sent(), [])

    def test_an_unknown_number_is_404_for_both_directions(self):
        for value in (True, False):
            r = self.patch_number(str(uuid.uuid4()), {"caller_verification_enabled": value})
            self.assertEqual(r.status_code, 404)

    def test_team_members_toggle_the_owners_numbers(self):
        member = H.make_user("member")
        supabase.table("team_members").insert({"owner_id": self.user, "member_user_id": member, "member_email": "m@qa.test",
                                               "role": "member", "status": "Active"}).execute()
        r = self.patch_number(self.num["id"], {"caller_verification_enabled": True}, user=member)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIs(number_row(self.num["id"])["caller_verification_enabled"], True)

    def test_read_only_team_members_cannot_toggle(self):
        viewer = H.make_user("viewer")
        supabase.table("team_members").insert({"owner_id": self.user, "member_user_id": viewer, "member_email": "v@qa.test",
                                               "role": "viewer", "status": "Active"}).execute()
        r = self.patch_number(self.num["id"], {"caller_verification_enabled": True}, user=viewer)
        self.assertEqual(r.status_code, 403)
        self.assertIs(number_row(self.num["id"])["caller_verification_enabled"], False)

    # ── voice service failures keep the two sides consistent ──
    def test_a_voice_service_failure_when_enabling_changes_nothing(self):
        self.vapi.update_phone_number.side_effect = RuntimeError("vapi down")
        r = self.patch_number(self.num["id"], {"caller_verification_enabled": True})
        self.assertEqual(r.status_code, 502)
        self.assertIs(number_row(self.num["id"])["caller_verification_enabled"], False)

    def test_a_voice_service_failure_when_disabling_keeps_it_on(self):
        self.patch_number(self.num["id"], {"caller_verification_enabled": True})
        self.vapi.update_phone_number.side_effect = RuntimeError("vapi down")
        r = self.patch_number(self.num["id"], {"caller_verification_enabled": False})
        self.assertEqual(r.status_code, 502)
        self.assertIs(number_row(self.num["id"])["caller_verification_enabled"], True)

    def test_a_voice_service_failure_does_not_leak_details(self):
        self.vapi.update_phone_number.side_effect = RuntimeError("secret-internal-detail")
        r = self.patch_number(self.num["id"], {"caller_verification_enabled": True})
        self.assertNotIn("secret-internal-detail", r.text)

    # ── off ──
    def test_disabling_puts_the_agent_back_as_the_numbers_assistant(self):
        self.patch_number(self.num["id"], {"caller_verification_enabled": True})
        self.vapi.update_phone_number.reset_mock()
        r = self.patch_number(self.num["id"], {"caller_verification_enabled": False})
        self.assertEqual(r.status_code, 200)
        self.assertIs(number_row(self.num["id"])["caller_verification_enabled"], False)
        self.assertEqual(self.sent(), [(self.num["vapi_phone_id"], {"assistantId": self.agent["vapi_assistant_id"]})])

    def test_disabling_with_no_agent_leaves_the_number_without_an_assistant(self):
        bare = make_number(self.user, verify=True)
        self.patch_number(bare["id"], {"caller_verification_enabled": False})
        self.assertEqual(self.sent(), [(bare["vapi_phone_id"], {"assistantId": None})])

    def test_disabling_while_suspended_for_balance_installs_the_fallback_not_the_agent(self):
        susp = make_number(self.user, agent=self.agent, verify=True, suspended=True)
        r = self.patch_number(susp["id"], {"caller_verification_enabled": False})
        self.assertEqual(r.status_code, 200, r.text)
        fallback = supabase.table("platform_settings").select("fallback_assistant_id").execute().data[0]["fallback_assistant_id"]
        self.assertEqual(self.sent(), [(susp["vapi_phone_id"], {"assistantId": fallback})])
        self.assertNotEqual(fallback, self.agent["vapi_assistant_id"])
        # ...and the number stays marked as suspended so it is restored when the balance is.
        self.assertIs(number_row(susp["id"])["suspended_for_balance"], True)

    def test_disabling_while_suspended_with_no_fallback_possible_fails_cleanly(self):
        susp = make_number(self.user, agent=self.agent, verify=True, suspended=True)
        with patch.object(telephony, "_get_or_create_fallback_assistant_id", AsyncMock(return_value=None)):
            r = self.patch_number(susp["id"], {"caller_verification_enabled": False})
        self.assertEqual(r.status_code, 502)
        self.assertIs(number_row(susp["id"])["caller_verification_enabled"], True)

    def test_disabling_without_the_voice_service_configured_only_updates_the_row(self):
        verified = make_number(self.user, agent=self.agent, verify=True)
        patch_settings(self, vapi_api_key="")
        r = self.patch_number(verified["id"], {"caller_verification_enabled": False})
        self.assertEqual(r.status_code, 200)
        self.assertIs(number_row(verified["id"])["caller_verification_enabled"], False)
        self.assertEqual(self.sent(), [])

    def test_disabling_a_number_that_was_never_synced_only_updates_the_row(self):
        unsynced = make_number(self.user, vapi_phone_id=None, verify=True)
        self.assertEqual(self.patch_number(unsynced["id"], {"caller_verification_enabled": False}).status_code, 200)
        self.assertEqual(self.sent(), [])

    def test_disabling_can_change_the_agent_in_the_same_request(self):
        verified = make_number(self.user, agent=self.agent, verify=True)
        second = make_agent(self.user, "Second")
        r = self.patch_number(verified["id"], {"caller_verification_enabled": False, "agent_id": second["id"]})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.sent(), [(verified["vapi_phone_id"], {"assistantId": second["vapi_assistant_id"]})])
        self.assertEqual(number_row(verified["id"])["agent_id"], second["id"])

    def test_enabling_can_change_the_agent_in_the_same_request(self):
        second = make_agent(self.user, "Second")
        r = self.patch_number(self.num["id"], {"caller_verification_enabled": True, "agent_id": second["id"]})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.sent()[0][1]["assistantId"], None)
        self.assertEqual(number_row(self.num["id"])["agent_id"], second["id"])
        self.assertEqual(self.answer(self.num["vapi_phone_id"]), {"assistantId": second["vapi_assistant_id"]})

    # ── other fields are unaffected ──
    def test_a_null_value_means_unchanged(self):
        r = self.patch_number(self.num["id"], {"caller_verification_enabled": None})
        self.assertEqual(r.json(), {"data": None, "error": "No fields to update"})
        self.assertEqual(self.sent(), [])

    def test_changing_only_the_status_does_not_touch_the_flag_or_voice_service(self):
        verified = make_number(self.user, agent=self.agent, verify=True)
        r = self.patch_number(verified["id"], {"status": "Inactive"})
        self.assertEqual(r.status_code, 200)
        row = number_row(verified["id"])
        self.assertEqual((row["status"], row["caller_verification_enabled"]), ("Inactive", True))
        self.assertEqual(self.sent(), [])

    def test_extra_fields_the_dashboard_sends_are_ignored(self):
        # The Number Settings dialog also sends `provider`; it must not break or be saved.
        r = self.patch_number(self.num["id"], {"caller_verification_enabled": True, "status": "Active", "provider": "x"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(number_row(self.num["id"])["provider"], "vapi")

    def test_new_numbers_start_with_verification_off(self):
        r = H.client.post("/telephony/phone-numbers", json={"provider": "vapi", "number": "+15550009999"},
                          headers=H.auth(self.user))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIs(r.json()["data"]["caller_verification_enabled"], False)
        # ...and the number was created with the agent wired in directly, as before.
        self.assertNotIn("server", self.vapi.create_phone_number.await_args.args[0])

    def test_the_numbers_list_exposes_the_flag(self):
        verified = make_number(self.user, agent=self.agent, verify=True)
        rows = {r["id"]: r for r in H.client.get("/telephony/phone-numbers", headers=H.auth(self.user)).json()["data"]}
        self.assertIs(rows[verified["id"]]["caller_verification_enabled"], True)
        self.assertIs(rows[self.num["id"]]["caller_verification_enabled"], False)


# ═══════════════════════════════════════════════════════════════════════════
# Every other path that writes a number's routing must keep it verified
# ═══════════════════════════════════════════════════════════════════════════


class RoutingStaysVerifiedTests(Base):
    def setUp(self):
        super().setUp()
        self.agent = make_agent(self.user, "First")
        self.second = make_agent(self.user, "Second")
        self.verified = make_number(self.user, agent=self.agent, verify=True)
        self.static = make_number(self.user, agent=self.agent)

    def pushes(self):
        return [(c.args[0], c.args[1]) for c in self.vapi.update_phone_number.await_args_list]

    # ── agent changes on the number ──
    def test_reassigning_the_agent_of_a_verified_number_pushes_nothing_to_vapi(self):
        r = self.patch_number(self.verified["id"], {"agent_id": self.second["id"]})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.pushes(), [])  # a pushed assistantId would silently switch verification off
        self.assertEqual(number_row(self.verified["id"])["agent_id"], self.second["id"])
        self.assertEqual(self.answer(self.verified["vapi_phone_id"]), {"assistantId": self.second["vapi_assistant_id"]})

    def test_unassigning_the_agent_of_a_verified_number_pushes_nothing_and_calls_get_an_error(self):
        r = self.patch_number(self.verified["id"], {"agent_id": None})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.pushes(), [])
        self.assertIsNone(number_row(self.verified["id"])["agent_id"])
        self.assertEqual(self.answer(self.verified["vapi_phone_id"]), {"error": cv.UNAVAILABLE_MESSAGE})

    def test_static_numbers_still_get_their_assistant_pushed(self):
        self.patch_number(self.static["id"], {"agent_id": self.second["id"]})
        self.assertEqual(self.pushes(), [(self.static["vapi_phone_id"], {"assistantId": self.second["vapi_assistant_id"]})])

    def test_unassigning_a_static_number_still_clears_its_assistant(self):
        self.patch_number(self.static["id"], {"agent_id": None})
        self.assertEqual(self.pushes(), [(self.static["vapi_phone_id"], {"assistantId": None})])

    def test_a_static_agent_without_a_vapi_assistant_still_sends_an_empty_update(self):
        bare = make_agent(self.user, "Bare", assistant=None)
        self.patch_number(self.static["id"], {"agent_id": bare["id"]})
        self.assertEqual(self.pushes(), [(self.static["vapi_phone_id"], {})])

    def test_a_voice_service_failure_still_aborts_a_static_agent_change(self):
        self.vapi.update_phone_number.side_effect = RuntimeError("down")
        r = self.patch_number(self.static["id"], {"agent_id": self.second["id"]})
        self.assertEqual(r.status_code, 502)
        self.assertEqual(number_row(self.static["id"])["agent_id"], self.agent["id"])

    def test_changing_the_agent_of_a_number_that_does_not_exist_is_still_a_quiet_no_op(self):
        r = self.patch_number(str(uuid.uuid4()), {"agent_id": self.second["id"]})
        self.assertEqual((r.status_code, r.json()), (200, {"data": None, "error": None}))

    # ── AI receptionist (inbound queue) paths ──
    def queue(self, number, agent=None):
        r = H.client.post("/telephony/inbound", json={"name": "Front desk", "agent_id": (agent or self.agent)["id"],
                                                      "phone_number_id": number["id"]}, headers=H.auth(self.user))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["data"]

    def test_attaching_a_receptionist_to_a_verified_number_keeps_it_verified(self):
        spare = make_number(self.user, verify=True)
        self.queue(spare)
        self.assertEqual(self.pushes(), [])
        self.assertEqual(number_row(spare["id"])["agent_id"], self.agent["id"])
        self.assertEqual(self.answer(spare["vapi_phone_id"]), {"assistantId": self.agent["vapi_assistant_id"]})

    def test_attaching_a_receptionist_to_a_static_number_still_pushes_the_assistant(self):
        spare = make_number(self.user)
        self.queue(spare)
        self.assertEqual(self.pushes(), [(spare["vapi_phone_id"], {"assistantId": self.agent["vapi_assistant_id"]})])

    def test_changing_a_receptionists_agent_on_a_verified_number_pushes_nothing(self):
        spare = make_number(self.user, verify=True)
        q = self.queue(spare)
        r = H.client.patch(f"/telephony/inbound/{q['id']}", json={"agent_id": self.second["id"]}, headers=H.auth(self.user))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.pushes(), [])
        self.assertEqual(number_row(spare["id"])["agent_id"], self.second["id"])

    def test_changing_a_receptionists_agent_on_a_static_number_still_pushes(self):
        spare = make_number(self.user)
        q = self.queue(spare)
        self.vapi.update_phone_number.reset_mock()
        H.client.patch(f"/telephony/inbound/{q['id']}", json={"agent_id": self.second["id"]}, headers=H.auth(self.user))
        self.assertEqual(self.pushes(), [(spare["vapi_phone_id"], {"assistantId": self.second["vapi_assistant_id"]})])

    def test_deleting_a_receptionist_on_a_verified_number_unassigns_it_without_touching_vapi(self):
        spare = make_number(self.user, verify=True)
        q = self.queue(spare)
        r = H.client.delete(f"/telephony/inbound/{q['id']}", headers=H.auth(self.user))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.pushes(), [])
        row = number_row(spare["id"])
        self.assertIsNone(row["agent_id"])
        self.assertIs(row["caller_verification_enabled"], True)  # the setting survives

    def test_deleting_a_receptionist_on_a_static_number_still_clears_the_assistant(self):
        spare = make_number(self.user)
        q = self.queue(spare)
        self.vapi.update_phone_number.reset_mock()
        H.client.delete(f"/telephony/inbound/{q['id']}", headers=H.auth(self.user))
        self.assertEqual(self.pushes(), [(spare["vapi_phone_id"], {"assistantId": None})])

    # ── balance suspension ──
    def test_running_out_of_balance_marks_a_verified_number_without_touching_vapi(self):
        run(telephony.sync_inbound_routing_for_balance(self.user, True))
        self.assertIs(number_row(self.verified["id"])["suspended_for_balance"], True)
        fallback = supabase.table("platform_settings").select("fallback_assistant_id").execute().data[0]["fallback_assistant_id"]
        # only the STATIC number was repointed at the fallback assistant
        self.assertEqual(self.pushes(), [(self.static["vapi_phone_id"], {"assistantId": fallback})])
        self.assertIs(number_row(self.static["id"])["suspended_for_balance"], True)

    def test_a_suspended_verified_number_serves_the_fallback_and_recovers_when_funded(self):
        run(telephony.sync_inbound_routing_for_balance(self.user, True))
        out = self.answer(self.verified["vapi_phone_id"])
        self.assertNotEqual(out["assistantId"], self.agent["vapi_assistant_id"])
        self.vapi.update_phone_number.reset_mock()
        run(telephony.sync_inbound_routing_for_balance(self.user, False))
        self.assertIs(number_row(self.verified["id"])["suspended_for_balance"], False)
        self.assertEqual(self.pushes(), [(self.static["vapi_phone_id"], {"assistantId": self.agent["vapi_assistant_id"]})])
        self.assertEqual(self.answer(self.verified["vapi_phone_id"]), {"assistantId": self.agent["vapi_assistant_id"]})

    def test_suspending_twice_and_restoring_twice_is_idempotent(self):
        for _ in range(2):
            run(telephony.sync_inbound_routing_for_balance(self.user, True))
        self.assertIs(number_row(self.verified["id"])["suspended_for_balance"], True)
        for _ in range(2):
            run(telephony.sync_inbound_routing_for_balance(self.user, False))
        self.assertIs(number_row(self.verified["id"])["suspended_for_balance"], False)

    def test_a_verified_number_is_restored_even_when_it_has_no_agent(self):
        bare = make_number(self.user, verify=True, suspended=True)
        run(telephony.sync_inbound_routing_for_balance(self.user, False))
        self.assertIs(number_row(bare["id"])["suspended_for_balance"], False)

    def test_other_accounts_numbers_are_not_suspended(self):
        other = H.make_user()
        theirs = make_number(other, agent=make_agent(other), verify=True)
        run(telephony.sync_inbound_routing_for_balance(self.user, True))
        self.assertIs(number_row(theirs["id"])["suspended_for_balance"], False)

    def test_a_static_number_that_is_suspended_and_restored_behaves_as_before(self):
        run(telephony.sync_inbound_routing_for_balance(self.user, True))
        run(telephony.sync_inbound_routing_for_balance(self.user, False))
        self.assertIs(number_row(self.static["id"])["suspended_for_balance"], False)
        self.assertEqual(self.pushes()[-1], (self.static["vapi_phone_id"], {"assistantId": self.agent["vapi_assistant_id"]}))


# ═══════════════════════════════════════════════════════════════════════════
# Status, log and schema
# ═══════════════════════════════════════════════════════════════════════════


class StatusAndLogTests(Base):
    def get(self, path, user=None):
        return H.client.get(f"/telephony/caller-verification/{path}", headers=H.auth(user or self.user))

    def test_status_when_everything_is_configured(self):
        r = self.get("status")
        self.assertEqual((r.status_code, r.json()), (200, {"data": {"available": True, "reason": None}, "error": None}))

    def test_status_when_something_is_missing_gives_one_generic_reason(self):
        for name in ("caller_lookup_code", "caller_lookup_api_key", "public_api_url", "vapi_api_key"):
            with self.subTest(missing=name):
                p = patch.object(settings, name, "")
                p.start()
                try:
                    data = self.get("status").json()["data"]
                finally:
                    p.stop()
                self.assertEqual(data, {"available": False, "reason": cv.UNAVAILABLE_REASON})

    def test_status_requires_a_login(self):
        # (HTTPBearer answers 401 or 403 depending on the FastAPI version; both mean "no access".)
        self.assertIn(H.client.get("/telephony/caller-verification/status").status_code, (401, 403))
        self.assertIn(H.client.get("/telephony/caller-verification/log").status_code, (401, 403))

    def seed(self, user, n=3, number=None):
        number = number or make_number(user, agent=make_agent(user), verify=True)
        for i in range(n):
            supabase.table("inbound_call_screenings").insert({
                "user_id": user, "phone_number_id": number["id"], "vapi_call_id": f"c{i}",
                "caller_number": f"+1555000{i:04d}", "decision": "refused" if i % 2 else "answered",
                "reason": "not_mobile" if i % 2 else "mobile_verified",
                "created_at": f"2026-01-01T00:00:0{i}+00:00"}).execute()
        return number

    def test_log_is_newest_first_and_scoped_to_the_account(self):
        mine = self.seed(self.user)
        other = H.make_user()
        self.seed(other)
        rows = self.get("log").json()["data"]
        self.assertEqual([r["vapi_call_id"] for r in rows], ["c2", "c1", "c0"])
        self.assertTrue(all(r["user_id"] == self.user for r in rows))
        self.assertEqual({r["phone_number_id"] for r in rows}, {mine["id"]})

    def test_log_can_be_narrowed_to_one_number(self):
        a = self.seed(self.user, 2)
        b = self.seed(self.user, 1)
        self.assertEqual(len(self.get(f"log?phone_number_id={a['id']}").json()["data"]), 2)
        self.assertEqual(len(self.get(f"log?phone_number_id={b['id']}").json()["data"]), 1)

    def test_log_for_someone_elses_number_is_empty(self):
        other = H.make_user()
        theirs = self.seed(other)
        self.assertEqual(self.get(f"log?phone_number_id={theirs['id']}").json()["data"], [])

    def test_log_limit_is_clamped(self):
        self.seed(self.user, 5)
        self.assertEqual(len(self.get("log?limit=2").json()["data"]), 2)
        self.assertEqual(len(self.get("log?limit=0").json()["data"]), 1)    # at least one
        self.assertEqual(len(self.get("log?limit=-5").json()["data"]), 1)
        self.assertEqual(len(self.get("log?limit=100000").json()["data"]), 5)  # capped, not an error
        self.assertEqual(self.get("log?limit=abc").status_code, 422)

    def test_log_with_a_malformed_number_id_is_empty_not_a_server_error(self):
        r = self.get("log?phone_number_id=not-a-uuid")
        self.assertEqual((r.status_code, r.json()), (200, {"data": [], "error": None}))

    def test_team_members_see_the_owners_log(self):
        self.seed(self.user, 2)
        member = H.make_user("member")
        supabase.table("team_members").insert({"owner_id": self.user, "member_user_id": member, "member_email": "m@qa.test",
                                               "role": "viewer", "status": "Active"}).execute()
        self.assertEqual(len(self.get("log", user=member).json()["data"]), 2)

    def test_releasing_a_number_keeps_its_log_but_unlinks_it(self):
        number = self.seed(self.user, 2)
        supabase.table("phone_numbers").delete().eq("id", number["id"]).execute()
        rows = self.get("log").json()["data"]
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(r["phone_number_id"] is None for r in rows))


class SchemaTests(unittest.TestCase):
    def column(self):
        return H.sql("select data_type, is_nullable, column_default from information_schema.columns "
                     "where table_name='phone_numbers' and column_name='caller_verification_enabled'")

    def test_the_flag_defaults_to_off_and_cannot_be_null(self):
        ((data_type, nullable, default),) = self.column()
        self.assertEqual((data_type, nullable, default), ("boolean", "NO", "false"))

    def test_existing_style_inserts_without_the_flag_get_false(self):
        user = H.make_user()
        row = supabase.table("phone_numbers").insert({"user_id": user, "number": "+15550001234"}).execute().data[0]
        self.assertIs(row["caller_verification_enabled"], False)

    def test_migration_adds_the_column_and_table_to_an_older_database_and_is_idempotent(self):
        import migrate
        user = H.make_user()
        row = supabase.table("phone_numbers").insert({"user_id": user, "number": "+15550004321"}).execute().data[0]
        try:
            H.sql("DROP TABLE IF EXISTS public.inbound_call_screenings")
            # The answering-hours columns come after the flag in the table; dropping them too keeps the
            # column order what a fresh database has once the migration has re-added everything
            # (a changed order would invalidate other connections' cached INSERT ... RETURNING * plans).
            H.sql("ALTER TABLE public.phone_numbers DROP COLUMN caller_verification_enabled, "
                  "DROP COLUMN answer_hours_enabled, DROP COLUMN answer_hours_timezone, "
                  "DROP COLUMN answer_hours_days, DROP COLUMN answer_hours_start, DROP COLUMN answer_hours_end")
            self.assertEqual(self.column(), [])
            migrate.bootstrap_schema()
            migrate.bootstrap_schema()  # twice: must be harmless
        finally:
            migrate.bootstrap_schema()  # never leave the shared scratch database damaged
        ((data_type, nullable, default),) = self.column()
        self.assertEqual((data_type, nullable, default), ("boolean", "NO", "false"))
        self.assertIs(supabase.table("phone_numbers").select("*").eq("id", row["id"]).execute().data[0]["caller_verification_enabled"], False)
        self.assertEqual(H.sql("select to_regclass('public.inbound_call_screenings')::text")[0][0], "inbound_call_screenings")

    def test_the_audit_table_cascades_with_the_account(self):
        user = H.make_user()
        supabase.table("inbound_call_screenings").insert({"user_id": user, "decision": "answered", "reason": "x"}).execute()
        H.sql("DELETE FROM public.users WHERE id = %s", (user,))
        self.assertEqual(supabase.table("inbound_call_screenings").select("id").eq("user_id", user).execute().data, [])


if __name__ == "__main__":
    unittest.main()
