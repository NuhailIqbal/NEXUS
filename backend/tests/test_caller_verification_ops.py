"""
Caller verification, operational hardening (added after an independent review).

* the reachability preflight (never switch a line to depend on a server the voice service cannot
  reach: the apex nginx host routes unknown paths to the frontend, which answers 405);
* the startup re-sync (VAPI keeps the URL/secret it was given when verification was switched on);
* attribution of ANSWERED calls on a verified number even when VAPI leaves `assistantId` empty,
  in the webhook and in both pull-sync paths, and never for calls VAPI refused at routing;
* small fixes: non-ASCII HMAC header (was a 500), suspended accounts on the error path, and the
  balance-sync race with a toggle.

Run from the backend folder:  python -m unittest discover -s tests -v
"""
import asyncio
import hashlib
import hmac
import json
import logging
import ssl
import threading
import time
import unittest
import uuid
from unittest.mock import AsyncMock, patch

import httpx

import byot_harness as H
import main
from database import supabase
from routers import billing as billing_router, telephony, webhooks
from models.schemas import PhoneNumberUpdate
from services import caller_lookup, caller_verification as cv, vapi_client, vapi_sync

# Shared fixtures and helpers live with the main suite.
from test_caller_verification import (  # noqa: F401
    CODE, MOBILE, VOIP, Base, make_agent, make_number, number_row, patch_settings, request_body, run, screenings,
)

REFUSAL_REASONS = (
    "assistant-request-failed", "assistant-request-returned-error", "assistant-request-returned-unspeakable-error",
    "assistant-request-returned-invalid-assistant", "assistant-request-returned-no-assistant",
    "assistant-request-returned-forwarding-phone-number",
)


# ═══════════════════════════════════════════════════════════════════════════
# Reachability preflight
# ═══════════════════════════════════════════════════════════════════════════


class ReachabilityProbeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        webhooks.limiter.reset()
        patch_settings(self, public_api_url="https://qa.example.test", vapi_webhook_secret="",
                       caller_verification_skip_reachability_check=False)
        self.requests: list[httpx.Request] = []

    def use(self, handler):
        def recording(request):
            self.requests.append(request)
            return handler(request)
        p = patch.object(cv, "_PROBE_TRANSPORT", httpx.MockTransport(recording))
        p.start()
        self.addCleanup(p.stop)

    ACK = staticmethod(lambda req: httpx.Response(200, json={"received": True, "type": "ping"}))

    async def test_a_server_that_acknowledges_the_ping_is_reachable(self):
        self.use(self.ACK)
        self.assertEqual(await cv.check_reachable(), (True, None))

    async def test_it_posts_a_harmless_ping_to_exactly_the_url_a_number_will_be_given(self):
        patch_settings(self, vapi_webhook_secret="s3cret")
        self.use(self.ACK)
        await cv.check_reachable()
        (req,) = self.requests
        block = cv.routing_server_block()
        self.assertEqual((req.method, str(req.url)), ("POST", block["url"]))
        self.assertEqual(str(req.url), "https://qa.example.test/webhooks/vapi/inbound")
        self.assertEqual(json.loads(req.content), {"message": {"type": "ping"}})
        # the same credential VAPI will be told to send
        self.assertEqual(req.headers["x-vapi-secret"], "s3cret")

    async def test_without_a_secret_no_credential_is_sent(self):
        self.use(self.ACK)
        await cv.check_reachable()
        self.assertNotIn("x-vapi-secret", self.requests[0].headers)

    async def test_everything_but_our_own_acknowledgement_is_unreachable(self):
        cases = [
            (httpx.Response(405, text="<html>Method Not Allowed</html>"), "http_405"),   # the frontend answering
            (httpx.Response(200, text="<html>index.html</html>"), "http_200"),             # an SPA catch-all
            (httpx.Response(200, json={"ok": True}), "http_200"),
            (httpx.Response(200, json={"received": False}), "http_200"),
            (httpx.Response(200, json={"received": "true"}), "http_200"),
            (httpx.Response(200, json=[{"received": True}]), "http_200"),
            (httpx.Response(200, text=""), "http_200"),
            (httpx.Response(401, json={"detail": "Invalid webhook signature"}), "http_401"),
            (httpx.Response(404, text="not found"), "http_404"),
            (httpx.Response(429, text="slow down"), "http_429"),
            (httpx.Response(500, text="boom"), "http_500"),
            (httpx.Response(502, text="bad gateway"), "http_502"),
            (httpx.Response(301, headers={"location": "https://qa.example.test/x"}), "http_301"),
        ]
        for response, reason in cases:
            with self.subTest(status=response.status_code, body=response.text[:20]):
                self.use(lambda req, r=response: r)
                with self.assertLogs(cv.logger, "ERROR"):
                    self.assertEqual(await cv.check_reachable(), (False, reason))

    async def test_the_log_says_where_to_look_when_a_proxy_misroutes_it(self):
        self.use(lambda req: httpx.Response(405, text="<html>405</html>"))
        with self.assertLogs(cv.logger, "ERROR") as logs:
            await cv.check_reachable()
        text = "\n".join(logs.output)
        self.assertIn("HTTP 405", text)
        self.assertIn("nginx", text)
        self.assertIn("https://qa.example.test/webhooks/vapi/inbound", text)

    async def test_network_failures_are_unreachable_not_exceptions(self):
        for exc in (httpx.ConnectError("name resolution failed"), httpx.ReadTimeout("slow"), httpx.ConnectTimeout("t"),
                    RuntimeError("anything")):
            with self.subTest(exc=type(exc).__name__):
                def boom(request, exc=exc):
                    raise exc
                self.use(boom)
                with self.assertLogs(cv.logger, "ERROR"):
                    self.assertEqual(await cv.check_reachable(), (False, "unreachable"))

    async def test_the_secret_never_appears_in_the_log(self):
        patch_settings(self, vapi_webhook_secret="super-secret-value")
        for handler in (lambda req: httpx.Response(401, text="no"), lambda req: (_ for _ in ()).throw(httpx.ConnectError("x"))):
            self.use(handler)
            with self.assertLogs(cv.logger, "ERROR") as logs:
                await cv.check_reachable()
            self.assertNotIn("super-secret-value", "\n".join(logs.output))

    async def test_without_a_public_url_it_cannot_run(self):
        patch_settings(self, public_api_url="")
        self.use(self.ACK)
        self.assertEqual(await cv.check_reachable(), (False, "no_public_url"))
        self.assertEqual(self.requests, [])

    async def test_the_documented_escape_hatch_skips_the_check(self):
        patch_settings(self, caller_verification_skip_reachability_check=True)
        self.use(lambda req: httpx.Response(405, text="nope"))
        self.assertEqual(await cv.check_reachable(), (True, None))
        self.assertEqual(self.requests, [])

    async def test_a_hung_server_cannot_hold_the_request_up_for_long(self):
        patch_settings(self, caller_verification_skip_reachability_check=False)
        p = patch.object(cv, "_PROBE_TIMEOUT_SECONDS", 0.2)
        p.start()
        self.addCleanup(p.stop)

        async def hang(request):
            await asyncio.sleep(30)
            return httpx.Response(200, json={"received": True})
        self.use(hang)
        loop = asyncio.get_running_loop()
        t0 = loop.time()
        with self.assertLogs(cv.logger, "ERROR"):
            ok, why = await cv.check_reachable()
        self.assertEqual((ok, why), (False, "unreachable"))
        self.assertLess(loop.time() - t0, 2.0)

    # ── against this application's real webhook ──
    def use_real_app(self):
        p = patch.object(cv, "_PROBE_TRANSPORT", httpx.ASGITransport(app=main.app))
        p.start()
        self.addCleanup(p.stop)

    async def test_the_real_webhook_acknowledges_the_probe_without_a_secret(self):
        self.use_real_app()
        self.assertEqual(await cv.check_reachable(), (True, None))

    async def test_the_real_webhook_accepts_the_probe_with_the_configured_secret(self):
        patch_settings(self, vapi_webhook_secret="s3cret-for-real-app")
        self.use_real_app()
        self.assertEqual(await cv.check_reachable(), (True, None))

    async def test_a_secret_the_real_webhook_would_reject_is_caught(self):
        patch_settings(self, vapi_webhook_secret="s3cret-for-real-app")
        self.use_real_app()
        with patch.object(webhooks, "_verify_request", return_value=False):
            with self.assertLogs(cv.logger, "ERROR"):
                self.assertEqual(await cv.check_reachable(), (False, "http_401"))


class ToggleReachabilityTests(Base):
    def setUp(self):
        super().setUp()
        self.agent = make_agent(self.user)
        self.num = make_number(self.user, agent=self.agent)

    def sent(self):
        return [c.args for c in self.vapi.update_phone_number.await_args_list]

    def test_enabling_is_refused_when_the_server_cannot_be_reached_and_nothing_changes(self):
        self.reachable.return_value = (False, "http_405")
        r = self.patch_number(self.num["id"], {"caller_verification_enabled": True})
        self.assertEqual(r.status_code, 503)
        self.assertEqual(r.json()["detail"], cv.UNAVAILABLE_REASON)
        self.assertIs(number_row(self.num["id"])["caller_verification_enabled"], False)
        self.assertEqual(self.sent(), [])

    def test_the_customer_is_not_told_why(self):
        self.reachable.return_value = (False, "http_405")
        detail = self.patch_number(self.num["id"], {"caller_verification_enabled": True}).json()["detail"]
        for word in ("405", "nginx", "proxy", "PUBLIC_API_URL", "http"):
            self.assertNotIn(word, detail)

    def test_the_check_runs_once_and_before_the_voice_service_is_touched(self):
        order = []
        self.reachable.side_effect = lambda: order.append("probe") or (True, None)
        self.vapi.update_phone_number.side_effect = lambda *a, **k: order.append("vapi") or {}
        r = self.patch_number(self.num["id"], {"caller_verification_enabled": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(order, ["probe", "vapi"])

    def test_a_server_that_passes_the_check_lets_it_switch_on(self):
        self.assertEqual(self.patch_number(self.num["id"], {"caller_verification_enabled": True}).status_code, 200)
        self.assertIs(number_row(self.num["id"])["caller_verification_enabled"], True)

    def test_switching_on_without_a_webhook_secret_is_allowed_but_warned_about(self):
        patch_settings(self, vapi_webhook_secret="")
        with self.assertLogs(telephony.logger, "WARNING") as logs:
            r = self.patch_number(self.num["id"], {"caller_verification_enabled": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn("VAPI_WEBHOOK_SECRET", "\n".join(logs.output))
        self.assertIn("unauthenticated", "\n".join(logs.output))

    def test_with_a_secret_there_is_no_such_warning(self):
        patch_settings(self, vapi_webhook_secret="s3cret")
        with self.assertNoLogs(telephony.logger, "WARNING"):
            self.assertEqual(self.patch_number(self.num["id"], {"caller_verification_enabled": True}).status_code, 200)

    def test_switching_off_never_runs_the_check(self):
        verified = make_number(self.user, agent=self.agent, verify=True)
        self.reachable.return_value = (False, "unreachable")  # would block an ON
        self.assertEqual(self.patch_number(verified["id"], {"caller_verification_enabled": False}).status_code, 200)
        self.reachable.assert_not_awaited()

    def test_other_updates_never_run_the_check(self):
        second = make_agent(self.user, "Second")
        for body in ({"agent_id": second["id"]}, {"status": "Inactive"}, {"agent_id": None}):
            self.assertEqual(self.patch_number(self.num["id"], body).status_code, 200)
        self.reachable.assert_not_awaited()

    def test_requests_refused_for_other_reasons_do_not_waste_a_probe(self):
        patch_settings(self, caller_lookup_code="")
        self.assertEqual(self.patch_number(self.num["id"], {"caller_verification_enabled": True}).status_code, 503)
        unsynced = make_number(self.user, vapi_phone_id=None)
        patch_settings(self, caller_lookup_code="code")
        self.assertEqual(self.patch_number(unsynced["id"], {"caller_verification_enabled": True}).status_code, 400)
        self.assertEqual(self.patch_number(str(uuid.uuid4()), {"caller_verification_enabled": True}).status_code, 404)
        self.reachable.assert_not_awaited()


class AvailabilityUrlTests(Base):
    def available(self, url):
        patch_settings(self, public_api_url=url)
        return cv.availability()[0]

    def test_addresses_nobody_outside_can_reach_are_not_available(self):
        for url in ("http://localhost:8000", "http://LOCALHOST", "http://127.0.0.1:8000", "http://127.0.0.2/x",
                    "https://app.localhost", "http://0.0.0.0:8000", "http://[::1]:8000", "edmnexus.ai", "://x", "  "):
            with self.subTest(url=url):
                self.assertFalse(self.available(url))

    def test_real_addresses_are_available(self):
        for url in ("https://edmnexus.ai", "https://api.edmnexus.ai/", "https://edmnexus.ai/api", "http://203.0.113.9:8000",
                    "https://qa.example.test"):
            with self.subTest(url=url):
                self.assertTrue(self.available(url))

    def test_the_toggle_refuses_a_loopback_url(self):
        agent = make_agent(self.user)
        num = make_number(self.user, agent=agent)
        patch_settings(self, public_api_url="http://localhost:8000")
        r = self.patch_number(num["id"], {"caller_verification_enabled": True})
        self.assertEqual(r.status_code, 503)
        self.assertEqual(self.vapi.update_phone_number.await_count, 0)

    def test_status_reports_it_as_unavailable(self):
        patch_settings(self, public_api_url="http://localhost:8000")
        data = H.client.get("/telephony/caller-verification/status", headers=H.auth(self.user)).json()["data"]
        self.assertEqual(data, {"available": False, "reason": cv.UNAVAILABLE_REASON})


# ═══════════════════════════════════════════════════════════════════════════
# Startup re-sync
# ═══════════════════════════════════════════════════════════════════════════


class ReconcileTests(Base):
    def setUp(self):
        super().setUp()
        # Other tests' leftovers would be re-pointed too: this sweeps every account.
        H.sql("UPDATE public.phone_numbers SET caller_verification_enabled = false, answer_hours_enabled = false")
        self.agent = make_agent(self.user)
        self.a = make_number(self.user, agent=self.agent, verify=True)
        self.b = make_number(self.user, agent=self.agent, verify=True)
        self.static = make_number(self.user, agent=self.agent)

    def sweep(self, retry_delays=(0, 0)):
        return run(cv.reconcile_verified_routing(retry_delays=retry_delays))

    def pushed(self):
        return {c.args[0]: c.args[1] for c in self.vapi.update_phone_number.await_args_list}

    def test_every_verified_number_is_pointed_at_the_current_server(self):
        self.assertEqual(self.sweep(), {"repointed": 2, "failed": 0, "unchanged": 0})
        expected = {"assistantId": None, "server": {"url": "https://qa.example.test/webhooks/vapi/inbound"}}
        self.assertEqual(self.pushed(), {self.a["vapi_phone_id"]: expected, self.b["vapi_phone_id"]: expected})

    def test_other_numbers_are_left_alone(self):
        self.sweep()
        self.assertNotIn(self.static["vapi_phone_id"], self.pushed())

    def test_a_changed_secret_reaches_the_numbers(self):
        patch_settings(self, vapi_webhook_secret="rotated-secret")
        self.sweep()
        for payload in self.pushed().values():
            self.assertEqual(payload["server"]["headers"], {"X-Vapi-Secret": "rotated-secret"})

    def test_a_changed_address_reaches_the_numbers(self):
        patch_settings(self, public_api_url="https://new-domain.example.test/")
        self.sweep()
        for payload in self.pushed().values():
            self.assertEqual(payload["server"]["url"], "https://new-domain.example.test/webhooks/vapi/inbound")

    def test_it_is_idempotent(self):
        self.sweep()
        first = self.pushed()
        self.vapi.update_phone_number.reset_mock()
        self.sweep()
        self.assertEqual(self.pushed(), first)

    def test_nothing_happens_when_there_are_no_verified_numbers_and_it_does_not_even_wait(self):
        H.sql("UPDATE public.phone_numbers SET caller_verification_enabled = false, answer_hours_enabled = false")
        with patch.object(asyncio, "sleep", AsyncMock()) as sleep:
            result = run(cv.reconcile_verified_routing(retry_delays=(30, 30)))
        self.assertEqual(result, {"skipped": "no verified numbers"})
        sleep.assert_not_awaited()
        self.reachable.assert_not_awaited()
        self.assertEqual(self.vapi.update_phone_number.await_count, 0)

    def test_without_the_voice_service_key_or_a_public_url_it_cannot_re_point_and_says_so(self):
        for name, value in (("public_api_url", ""), ("vapi_api_key", ""), ("public_api_url", "http://localhost:8000")):
            with self.subTest(name=name, value=value):
                p = patch.object(__import__("config").settings, name, value)
                p.start()
                try:
                    with self.assertLogs(cv.logger, "WARNING") as logs:
                        self.assertEqual(self.sweep(), {"skipped": "not configured"})
                finally:
                    p.stop()
                self.assertIn("2 number(s)", "\n".join(logs.output))
        self.assertEqual(self.vapi.update_phone_number.await_count, 0)

    def test_missing_lookup_credentials_do_not_stop_the_re_sync(self):
        # Without them calls are answered unchecked, but still routed through this server, so the
        # numbers must still follow a changed address/secret.
        patch_settings(self, caller_lookup_code="", caller_lookup_api_key="")
        self.assertEqual(self.sweep(), {"repointed": 2, "failed": 0, "unchanged": 0})

    def test_numbers_without_a_voice_service_id_are_skipped(self):
        H.sql("UPDATE public.phone_numbers SET vapi_phone_id = NULL WHERE id = %s", (self.b["id"],))
        self.assertEqual(self.sweep(), {"repointed": 1, "failed": 0, "unchanged": 1})

    def test_the_first_probe_runs_at_once_then_it_backs_off(self):
        delays = []

        async def record(seconds):
            delays.append(seconds)
        self.reachable.side_effect = [(False, "unreachable"), (False, "http_502"), (True, None)]
        with patch.object(asyncio, "sleep", record):
            result = run(cv.reconcile_verified_routing(retry_delays=(2, 5, 10)))
        self.assertEqual(result["repointed"], 2)
        self.assertEqual(delays, [2, 5])  # no wait before the first probe; stopped once it passed
        self.assertEqual(self.reachable.await_count, 3)

    def test_the_default_backoff_keeps_trying_for_minutes_not_seconds(self):
        self.assertEqual(cv.RESYNC_RETRY_DELAYS[0], 2)
        self.assertGreaterEqual(sum(cv.RESYNC_RETRY_DELAYS), 300)

    def test_it_never_points_numbers_at_an_address_that_does_not_answer(self):
        self.reachable.return_value = (False, "http_405")
        with self.assertLogs(cv.logger, "ERROR") as logs:
            result = self.sweep(retry_delays=(0, 0))
        self.assertEqual(result, {"skipped": "unreachable (http_405)"})
        self.assertEqual(self.reachable.await_count, 3)
        self.assertEqual(self.vapi.update_phone_number.await_count, 0)
        self.assertIn("left as they are", "\n".join(logs.output))

    def test_a_number_switched_off_while_it_waited_is_left_alone(self):
        # The flag is read again, under the number's lock, right before each push.
        def switch_a_off():
            supabase.table("phone_numbers").update({"caller_verification_enabled": False}).eq("id", self.a["id"]).execute()
            return (True, None)
        self.reachable.side_effect = switch_a_off
        self.assertEqual(self.sweep(), {"repointed": 1, "failed": 0, "unchanged": 1})
        self.assertNotIn(self.a["vapi_phone_id"], self.pushed())

    def test_a_number_released_while_it_waited_is_left_alone(self):
        def release_b():
            supabase.table("phone_numbers").delete().eq("id", self.b["id"]).execute()
            return (True, None)
        self.reachable.side_effect = release_b
        self.assertEqual(self.sweep(), {"repointed": 1, "failed": 0, "unchanged": 1})

    def test_one_failing_number_does_not_stop_the_others(self):
        calls = []

        async def flaky(phone_id, payload):
            calls.append(phone_id)
            if len(calls) == 1:
                raise RuntimeError("vapi hiccup")
            return {}
        self.vapi.update_phone_number.side_effect = flaky
        with self.assertLogs(cv.logger, "ERROR"):
            self.assertEqual(self.sweep(), {"repointed": 1, "failed": 1, "unchanged": 0})
        self.assertEqual(len(calls), 2)

    def test_suspended_numbers_are_re_pointed_too(self):
        H.sql("UPDATE public.phone_numbers SET suspended_for_balance = true WHERE id = %s", (self.a["id"],))
        self.assertEqual(self.sweep()["repointed"], 2)


class StartupHookTests(unittest.IsolatedAsyncioTestCase):
    async def test_the_hook_runs_the_re_sync_in_the_background(self):
        fake = AsyncMock(return_value={"skipped": "no verified numbers"})
        with patch.object(cv, "reconcile_verified_routing", fake):
            await main._reconcile_caller_verification()
            await asyncio.sleep(0.05)
        fake.assert_awaited_once()

    async def test_a_failing_re_sync_is_logged_and_never_escapes(self):
        fake = AsyncMock(side_effect=RuntimeError("db down"))
        with patch.object(cv, "reconcile_verified_routing", fake):
            with self.assertLogs("uvicorn.error", "ERROR") as logs:
                await main._reconcile_caller_verification()
                await asyncio.sleep(0.05)
        self.assertIn("re-sync failed", "\n".join(logs.output))

    def test_the_hook_is_registered_after_the_schema_migration(self):
        names = [h.__name__ for h in main.app.router.on_startup]
        self.assertIn("_reconcile_caller_verification", names)
        self.assertLess(names.index("_auto_migrate"), names.index("_reconcile_caller_verification"))


# ═══════════════════════════════════════════════════════════════════════════
# Answered calls must still be logged and billed when VAPI names no assistant
# ═══════════════════════════════════════════════════════════════════════════


def report(call_id, phone_id, *, assistant=None, message_assistant=None, ended="customer-ended-call", seconds=60,
           cost=0.10, call_type="inboundPhoneCall", phone_in_message=False):
    """An end-of-call-report. `assistant` is call.assistantId; `message_assistant` is message.assistant.id."""
    call = {"id": call_id, "type": call_type, "customer": {"number": "+15551230001"}}
    if phone_id and not phone_in_message:
        call["phoneNumberId"] = phone_id
    if assistant:
        call["assistantId"] = assistant
    msg = {"type": "end-of-call-report", "endedReason": ended, "call": call, "cost": cost, "durationSeconds": seconds,
           "artifact": {"transcript": "AI: hello", "messages": []}}
    if phone_in_message:
        msg["phoneNumber"] = {"id": phone_id}
    if message_assistant:
        msg["assistant"] = {"id": message_assistant}
    return {"message": msg}


def conversation(call_id):
    rows = supabase.table("conversations").select("*").eq("vapi_call_id", call_id).execute().data
    return rows[0] if rows else None


def charges(call_id):
    return supabase.table("wallet_transactions").select("*").eq("ref_id", call_id).eq("kind", "call").execute().data


def route(case, vapi_phone_id, call_id, caller="+15551230001"):
    """Send the call's assistant-request through the real handler (what VAPI does when it arrives)."""
    return case.answer(vapi_phone_id, caller, call_id=call_id)


class AttributionTests(Base):
    def setUp(self):
        super().setUp()
        H.fund_wallet(self.user, 50.0)
        self.agent = make_agent(self.user)
        self.asst = self.agent["vapi_assistant_id"]
        self.verified = make_number(self.user, agent=self.agent, verify=True)
        self.static = make_number(self.user, agent=self.agent)
        self.vid = self.verified["vapi_phone_id"]

    def post(self, body, path="/webhooks/vapi"):
        r = H.client.post(path, json=body)
        self.assertEqual(r.status_code, 200, r.text)
        return r

    def new_call(self):
        return f"call-{uuid.uuid4().hex[:8]}"

    def answered_call(self):
        cid = self.new_call()
        self.assertEqual(route(self, self.vid, cid), {"assistantId": self.asst})
        return cid

    # ── the case being protected ──
    def test_a_call_we_answered_is_logged_for_the_owner_even_with_no_assistant_id(self):
        cid = self.answered_call()
        self.post(report(cid, self.vid))
        row = conversation(cid)
        self.assertIsNotNone(row, "an answered call went unlogged")
        self.assertEqual((row["user_id"], row["agent_id"], row["direction"], row["status"]),
                         (self.user, self.agent["id"], "inbound", "Completed"))
        self.assertEqual(row["phone"], "+15551230001")
        self.assertEqual(row["transcript"], "AI: hello")

    def test_and_it_is_billed_exactly_once(self):
        cid = self.answered_call()
        self.post(report(cid, self.vid))
        expected, _ = billing_router.calculate_call_cost(self.user, 60, 0.10, "inbound")
        self.assertGreater(expected, 0)
        self.assertAlmostEqual(float(conversation(cid)["call_cost"]), expected, places=2)
        self.assertEqual(len(charges(cid)), 1)
        self.post(report(cid, self.vid))  # a retry, or the poller: still one row, one charge
        self.assertEqual(len(charges(cid)), 1)
        self.assertEqual(len(supabase.table("conversations").select("id").eq("vapi_call_id", cid).execute().data), 1)

    def test_the_audit_row_records_the_agent_that_answered(self):
        cid = self.answered_call()
        row = supabase.table("inbound_call_screenings").select("*").eq("vapi_call_id", cid).execute().data[0]
        self.assertEqual((row["decision"], row["agent_id"]), ("answered", self.agent["id"]))

    def test_only_the_call_id_is_needed_not_the_number(self):
        cid = self.answered_call()
        self.post(report(cid, None))
        self.assertEqual(conversation(cid)["user_id"], self.user)

    def test_the_same_works_on_the_inbound_route(self):
        cid = self.answered_call()
        self.post(report(cid, self.vid), path="/webhooks/vapi/inbound")
        self.assertEqual(conversation(cid)["user_id"], self.user)

    def test_an_existing_live_row_is_completed_and_billed(self):
        cid = self.answered_call()
        supabase.table("conversations").insert({"user_id": self.user, "channel": "Phone", "status": "In Progress",
                                                "vapi_call_id": cid}).execute()
        self.post(report(cid, self.vid))
        self.assertEqual(conversation(cid)["status"], "Completed")
        self.assertEqual(len(charges(cid)), 1)

    def test_switching_verification_off_mid_call_does_not_make_the_call_free(self):
        cid = self.answered_call()
        self.assertEqual(self.patch_number(self.verified["id"], {"caller_verification_enabled": False}).status_code, 200)
        self.post(report(cid, self.vid))
        self.assertEqual(conversation(cid)["user_id"], self.user)
        self.assertEqual(len(charges(cid)), 1)

    # ── the assistant object carried by the event ──
    def test_the_assistant_object_on_the_event_attributes_the_call(self):
        cid = self.new_call()
        self.post(report(cid, None, message_assistant=self.asst))
        row = conversation(cid)
        self.assertEqual((row["user_id"], row["agent_id"]), (self.user, self.agent["id"]))
        self.assertEqual(len(charges(cid)), 1)

    def test_the_calls_own_assistant_id_still_wins(self):
        other = make_agent(self.user, "Other")
        cid = self.new_call()
        self.post(report(cid, self.vid, assistant=other["vapi_assistant_id"], message_assistant=self.asst))
        self.assertEqual(conversation(cid)["agent_id"], other["id"])

    def test_extractor_precedence(self):
        ex = webhooks._extract_assistant_id
        self.assertEqual(ex({"message": {"call": {"assistantId": "a"}, "assistantId": "b", "assistant": {"id": "c"}}}), "a")
        self.assertEqual(ex({"message": {"call": {}, "assistantId": "b", "assistant": {"id": "c"}}}), "b")
        self.assertEqual(ex({"message": {"call": {}, "assistant": {"id": "c"}}}), "c")
        for message in ({"call": {}}, {"call": {}, "assistant": None}, {"call": {}, "assistant": "x"},
                        {"call": {}, "assistant": {}}, {"call": {}, "assistant": []}):
            self.assertIsNone(ex({"message": message}), message)
        px = webhooks._extract_phone_number_id
        self.assertEqual(px({"message": {"call": {"phoneNumberId": "p1"}, "phoneNumber": {"id": "p2"}}}), "p1")
        self.assertEqual(px({"message": {"call": {}, "phoneNumber": {"id": "p2"}}}), "p2")
        self.assertIsNone(px({"message": {"call": {}, "phoneNumber": "x"}}))

    # ── calls we did not answer with the agent must never be logged or billed ──
    def test_a_call_refused_at_routing_leaves_nothing_behind_whatever_the_reason(self):
        for reason in REFUSAL_REASONS:
            with self.subTest(reason=reason):
                cid = self.new_call()
                self.post(report(cid, self.vid, ended=reason, seconds=4, cost=0.01))
                self.assertIsNone(conversation(cid))
                self.assertEqual(charges(cid), [])

    def test_an_answered_call_that_vapi_then_failed_to_start_is_not_billed(self):
        # We answered with the agent, but VAPI could not use that assistant (e.g. deleted on its side):
        # the caller never reached anyone.
        cid = self.answered_call()
        self.post(report(cid, self.vid, ended="assistant-request-returned-invalid-assistant", seconds=1))
        self.assertIsNone(conversation(cid))
        self.assertEqual(charges(cid), [])

    def test_a_refused_caller_who_hangs_up_during_the_sentence_is_not_logged(self):
        self.lookup.default = VOIP
        cid = self.new_call()
        self.assertEqual(route(self, self.vid, cid), {"error": cv.REFUSAL_MESSAGE})
        self.post(report(cid, self.vid, ended="customer-ended-call", seconds=3))
        self.assertIsNone(conversation(cid))
        self.assertEqual(charges(cid), [])

    def test_a_call_served_by_the_shared_unavailable_assistant_is_not_attributed(self):
        supabase.table("phone_numbers").update({"suspended_for_balance": True}).eq("id", self.verified["id"]).execute()
        cid = self.new_call()
        fallback = route(self, self.vid, cid)["assistantId"]
        self.assertNotEqual(fallback, self.asst)
        for kwargs in ({}, {"assistant": fallback}, {"message_assistant": fallback}):
            with self.subTest(kwargs=kwargs):
                self.post(report(cid, self.vid, **kwargs))
                self.assertIsNone(conversation(cid))
                self.assertEqual(charges(cid), [])

    def test_any_assistant_that_is_not_ours_blocks_attribution(self):
        cid = self.answered_call()
        self.post(report(cid, self.vid, assistant="asst-someone-elses"))
        self.assertIsNone(conversation(cid))

    def test_a_call_on_a_number_with_no_agent_is_not_attributed(self):
        bare = make_number(self.user, verify=True)
        cid = self.new_call()
        self.assertEqual(route(self, bare["vapi_phone_id"], cid), {"error": cv.UNAVAILABLE_MESSAGE})
        self.post(report(cid, bare["vapi_phone_id"]))
        self.assertIsNone(conversation(cid))

    def test_a_call_we_never_routed_is_ignored_even_on_a_verified_number(self):
        cid = self.new_call()
        self.post(report(cid, self.vid))
        self.assertIsNone(conversation(cid))

    def test_the_refusal_test_matches_case_insensitively_and_only_at_the_start(self):
        for reason in REFUSAL_REASONS:
            self.assertTrue(webhooks.is_routing_refusal(reason))
            self.assertTrue(webhooks.is_routing_refusal(reason.upper()))
        for reason in ("customer-ended-call", "assistant-ended-call", "pipeline-error-openai-llm-failed",
                       "customer-did-not-answer", "voicemail", "", None, "x-assistant-request-failed"):
            self.assertFalse(webhooks.is_routing_refusal(reason), reason)

    # ── nothing else changes ──
    def test_a_call_with_no_assistant_on_a_normal_number_is_still_ignored(self):
        cid = self.new_call()
        self.post(report(cid, self.static["vapi_phone_id"]))
        self.assertIsNone(conversation(cid))
        self.assertEqual(charges(cid), [])

    def test_a_call_is_attributed_to_the_account_whose_number_answered_it_only(self):
        other = H.make_user()
        other_agent = make_agent(other, "Theirs")
        theirs = make_number(other, agent=other_agent, verify=True)
        cid = self.new_call()
        self.assertEqual(route(self, theirs["vapi_phone_id"], cid), {"assistantId": other_agent["vapi_assistant_id"]})
        self.post(report(cid, theirs["vapi_phone_id"]))
        row = conversation(cid)
        self.assertEqual((row["user_id"], row["agent_id"]), (other, other_agent["id"]))
        self.assertTrue(all(t["user_id"] == other for t in charges(cid)))
        self.assertAlmostEqual(billing_router.get_balance(self.user), 50.0, places=2)

    def test_status_updates_without_an_assistant_still_create_no_row(self):
        cid = self.answered_call()
        self.post({"message": {"type": "status-update", "status": "in-progress",
                               "call": {"id": cid, "type": "inboundPhoneCall", "phoneNumberId": self.vid}}})
        self.assertIsNone(conversation(cid))

    def test_a_report_without_a_call_id_is_ignored(self):
        for bad in (None, ""):
            body = report(self.new_call(), self.vid)
            body["message"]["call"]["id"] = bad
            self.assertEqual(H.client.post("/webhooks/vapi", json=body).status_code, 200, bad)

    def test_answered_calls_ignores_odd_ids(self):
        self.assertEqual(cv.answered_calls([None, 5, "", ["x"]]), {})
        self.assertEqual(webhooks._answered_by_us({"message": {"call": {"id": 123}}}), None)

    def test_a_call_whose_agent_was_deleted_afterwards_is_still_logged_and_billed(self):
        cid = self.answered_call()
        supabase.table("ai_agents").delete().eq("id", self.agent["id"]).execute()
        self.post(report(cid, self.vid))
        row = conversation(cid)
        self.assertEqual((row["user_id"], row["agent_id"]), (self.user, None))
        self.assertEqual(len(charges(cid)), 1)


# ═══════════════════════════════════════════════════════════════════════════
# The same, through the two pull-sync paths
# ═══════════════════════════════════════════════════════════════════════════


def rest_call(call_id, phone_id, *, assistant=None, ended="customer-ended-call", with_reason=True):
    """A call as VAPI's REST API returns it."""
    c = {"id": call_id, "type": "inboundPhoneCall", "status": "ended", "phoneNumberId": phone_id,
         "customer": {"number": "+15551230001"}, "startedAt": "2026-10-10T10:00:00Z", "endedAt": "2026-10-10T10:01:00Z",
         "cost": 0.10, "artifact": {"transcript": "AI: hello", "messages": []}}
    if assistant:
        c["assistantId"] = assistant
    if with_reason:
        c["endedReason"] = ended
    return c


class _SyncBase(Base):
    def setUp(self):
        super().setUp()
        H.fund_wallet(self.user, 50.0)
        self.agent = make_agent(self.user)
        self.asst = self.agent["vapi_assistant_id"]
        self.verified = make_number(self.user, agent=self.agent, verify=True)
        self.static = make_number(self.user, agent=self.agent)
        self.vid, self.sid = self.verified["vapi_phone_id"], self.static["vapi_phone_id"]
        self.full: dict[str, dict] = {}
        self.listed: list[dict] = []
        self.list_calls = AsyncMock(side_effect=lambda limit=100: list(self.listed))
        self.get_call = AsyncMock(side_effect=lambda cid: self.full[cid])
        for name, mock in (("list_calls", self.list_calls), ("get_call", self.get_call)):
            p = patch.object(vapi_client, name, mock)
            p.start()
            self.addCleanup(p.stop)
        p = patch.object(vapi_sync, "run_post_call_automations", AsyncMock())
        p.start()
        self.addCleanup(p.stop)

    def add(self, call, listed=None):
        """Register a call: the list shows `listed` (default: the same), get_call returns the full record."""
        self.full[call["id"]] = call
        self.listed.append(listed if listed is not None else call)
        return call["id"]

    def cid(self):
        return f"call-{uuid.uuid4().hex[:8]}"

    def answered(self, vapi_phone_id=None):
        """A call id this server answered (routed through the real handler)."""
        cid = self.cid()
        out = route(self, vapi_phone_id or self.vid, cid)
        self.assertIn("assistantId", out)
        return cid


class BackgroundSyncAttributionTests(_SyncBase):
    def sync(self):
        return run(vapi_sync.run_global_sync())

    def test_an_assistantless_call_we_answered_is_imported_billed_and_linked(self):
        cid = self.add(rest_call(self.answered(), self.vid))
        result = self.sync()
        self.assertEqual(result["imported"], 1)
        row = conversation(cid)
        self.assertEqual((row["user_id"], row["agent_id"], row["direction"]), (self.user, self.agent["id"], "inbound"))
        self.assertEqual(len(charges(cid)), 1)

    def test_a_call_with_an_assistant_is_imported_as_before(self):
        cid = self.add(rest_call(self.cid(), self.sid, assistant=self.asst))
        self.assertEqual(self.sync()["imported"], 1)
        self.assertEqual(conversation(cid)["agent_id"], self.agent["id"])

    def test_assistantless_calls_we_did_not_answer_are_never_imported_or_fetched(self):
        self.lookup.default = VOIP
        refused = self.cid()
        self.assertEqual(route(self, self.vid, refused), {"error": cv.REFUSAL_MESSAGE})
        ids = [self.add(rest_call(refused, self.vid))]                       # we refused it
        ids += [self.add(rest_call(self.cid(), self.vid, ended=r)) for r in REFUSAL_REASONS]  # never answered
        ids.append(self.add(rest_call(self.cid(), self.sid)))                # a normal number
        ids.append(self.add(rest_call(self.cid(), "vpn-unknown")))
        ids.append(self.add(rest_call(self.cid(), None)))
        self.assertEqual(self.sync()["imported"], 0)
        for cid in ids:
            self.assertIsNone(conversation(cid))
            self.assertEqual(charges(cid), [])
        self.get_call.assert_not_awaited()

    def test_an_answered_call_that_vapi_then_failed_to_start_is_neither_imported_nor_fetched(self):
        cid = self.add(rest_call(self.answered(), self.vid, ended="assistant-request-returned-invalid-assistant"))
        self.assertEqual(self.sync()["imported"], 0)
        self.assertIsNone(conversation(cid))
        self.get_call.assert_not_awaited()

    def test_a_refusal_visible_only_in_the_full_record_is_skipped_after_the_fetch(self):
        cid = self.answered()
        call = rest_call(cid, self.vid, ended="assistant-request-returned-error")
        self.add(call, listed={k: v for k, v in call.items() if k != "endedReason"})
        self.assertEqual(self.sync()["imported"], 0)
        self.get_call.assert_awaited()
        self.assertIsNone(conversation(cid))

    def test_calls_served_by_an_assistant_that_is_not_ours_are_left_alone(self):
        fallback = run(telephony._get_or_create_fallback_assistant_id())
        listed = self.add(rest_call(self.answered(), self.vid, assistant=fallback))
        call = rest_call(self.answered(), self.vid, assistant="asst-someone-elses")
        hidden = self.add(call, listed={k: v for k, v in call.items() if k != "assistantId"})
        self.assertEqual(self.sync()["imported"], 0)
        for cid in (listed, hidden):
            self.assertIsNone(conversation(cid))
            self.assertEqual(charges(cid), [])
        fetched = [c.args[0] for c in self.get_call.await_args_list]
        self.assertNotIn(listed, fetched)
        self.assertIn(hidden, fetched)

    def test_a_full_record_that_names_one_of_our_assistants_is_imported_to_it(self):
        other = make_agent(self.user, "Other")
        call = rest_call(self.answered(), self.vid, assistant=other["vapi_assistant_id"])
        cid = self.add(call, listed={k: v for k, v in call.items() if k != "assistantId"})
        self.assertEqual(self.sync()["imported"], 1)
        row = conversation(cid)
        self.assertEqual((row["user_id"], row["agent_id"]), (self.user, other["id"]))
        self.assertEqual(len(charges(cid)), 1)

    def test_unfinished_calls_are_left_for_later(self):
        call = rest_call(self.answered(), self.vid, with_reason=False)
        call["status"] = "in-progress"
        call.pop("endedAt")
        cid = self.add(call)
        self.assertEqual(self.sync()["imported"], 0)
        self.assertIsNone(conversation(cid))

    def test_a_second_pass_does_not_import_or_charge_again(self):
        cid = self.add(rest_call(self.answered(), self.vid))
        self.sync()
        self.assertEqual(self.sync()["imported"], 0)
        self.assertEqual(len(charges(cid)), 1)

    def test_each_call_goes_to_the_account_that_answered_it(self):
        other = H.make_user()
        theirs = make_number(other, agent=make_agent(other, "Theirs"), verify=True)
        mine = self.add(rest_call(self.answered(), self.vid))
        theirs_id = self.add(rest_call(self.answered(theirs["vapi_phone_id"]), theirs["vapi_phone_id"]))
        self.sync()
        self.assertEqual(conversation(mine)["user_id"], self.user)
        self.assertEqual(conversation(theirs_id)["user_id"], other)

    def test_switching_verification_off_before_the_sync_does_not_make_the_call_free(self):
        cid = self.add(rest_call(self.answered(), self.vid))
        self.patch_number(self.verified["id"], {"caller_verification_enabled": False})
        self.assertEqual(self.sync()["imported"], 1)
        self.assertEqual(len(charges(cid)), 1)

    def test_one_bad_call_does_not_stop_the_rest(self):
        bad = self.add(rest_call(self.answered(), self.vid))
        good = self.add(rest_call(self.answered(), self.vid))
        original = self.get_call.side_effect

        async def flaky(cid):
            if cid == bad:
                raise RuntimeError("vapi hiccup")
            return original(cid)
        self.get_call.side_effect = flaky
        result = self.sync()
        self.assertEqual((result["imported"], result["failed"]), (1, 1))
        self.assertIsNotNone(conversation(good))

    def test_automations_run_for_a_newly_imported_call(self):
        self.add(rest_call(self.answered(), self.vid))
        self.sync()
        vapi_sync.run_post_call_automations.assert_awaited_once()
        self.assertEqual(vapi_sync.run_post_call_automations.await_args.args[0], self.user)


class ManualSyncAttributionTests(_SyncBase):
    def sync(self, user=None):
        r = H.client.post("/conversations/sync-from-vapi", headers=H.auth(user or self.user))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["data"]

    def test_an_assistantless_call_we_answered_is_imported(self):
        cid = self.add(rest_call(self.answered(), self.vid))
        self.assertEqual(self.sync()["imported"], 1)
        row = conversation(cid)
        self.assertEqual((row["user_id"], row["agent_id"]), (self.user, self.agent["id"]))
        self.assertEqual(len(charges(cid)), 1)

    def test_calls_with_the_accounts_assistants_are_imported_as_before(self):
        cid = self.add(rest_call(self.cid(), self.sid, assistant=self.asst))
        self.assertEqual(self.sync()["imported"], 1)
        self.assertEqual(conversation(cid)["user_id"], self.user)

    def test_a_call_still_being_screened_is_not_imported(self):
        # A sync during the assistant-request: VAPI lists the call as ringing, with no assistant.
        call = rest_call(self.cid(), self.vid, with_reason=False)
        call["status"] = "ringing"
        call.pop("endedAt")
        cid = self.add(call)
        self.assertEqual(self.sync()["imported"], 0)
        self.assertIsNone(conversation(cid))
        # ...and not even once it has been answered, until it has ended.
        route(self, self.vid, cid)
        self.assertEqual(self.sync()["imported"], 0)
        self.assertIsNone(conversation(cid))

    def test_refused_calls_are_skipped_before_and_after_the_fetch(self):
        self.lookup.default = VOIP
        refused = self.cid()
        route(self, self.vid, refused)
        self.add(rest_call(refused, self.vid))
        self.lookup.default = MOBILE
        hidden_cid = self.answered()
        call = rest_call(hidden_cid, self.vid, ended="assistant-request-failed")
        self.add(call, listed={k: v for k, v in call.items() if k != "endedReason"})
        self.assertEqual(self.sync()["imported"], 0)
        for cid in (refused, hidden_cid):
            self.assertIsNone(conversation(cid))
            self.assertEqual(charges(cid), [])
        fetched = [c.args[0] for c in self.get_call.await_args_list]
        self.assertNotIn(refused, fetched)
        self.assertIn(hidden_cid, fetched)

    def test_an_answered_call_that_vapi_then_failed_to_start_is_neither_imported_nor_fetched(self):
        cid = self.add(rest_call(self.answered(), self.vid, ended="assistant-request-returned-invalid-assistant"))
        self.assertEqual(self.sync()["imported"], 0)
        self.assertIsNone(conversation(cid))
        self.get_call.assert_not_awaited()

    def test_calls_served_by_an_assistant_that_is_not_ours_are_left_alone(self):
        fallback = run(telephony._get_or_create_fallback_assistant_id())
        listed = self.add(rest_call(self.answered(), self.vid, assistant=fallback))
        call = rest_call(self.answered(), self.vid, assistant="asst-someone-elses")
        hidden = self.add(call, listed={k: v for k, v in call.items() if k != "assistantId"})
        self.assertEqual(self.sync()["imported"], 0)
        for cid in (listed, hidden):
            self.assertIsNone(conversation(cid))
        fetched = [c.args[0] for c in self.get_call.await_args_list]
        self.assertNotIn(listed, fetched)
        self.assertIn(hidden, fetched)

    def test_a_full_record_that_names_one_of_the_accounts_assistants_is_imported(self):
        call = rest_call(self.answered(), self.vid, assistant=self.asst)
        cid = self.add(call, listed={k: v for k, v in call.items() if k != "assistantId"})
        self.assertEqual(self.sync()["imported"], 1)
        self.assertEqual(conversation(cid)["agent_id"], self.agent["id"])

    def test_another_accounts_calls_are_never_imported(self):
        other = H.make_user()
        theirs = make_number(other, agent=make_agent(other, "Theirs"), verify=True)
        cid = self.add(rest_call(self.answered(theirs["vapi_phone_id"]), theirs["vapi_phone_id"]))
        self.assertEqual(self.sync()["imported"], 0)
        self.assertIsNone(conversation(cid))

    def test_an_account_whose_agent_was_deleted_still_gets_the_calls_it_answered(self):
        loner = H.make_user()
        H.fund_wallet(loner, 10.0)
        agent = make_agent(loner, "Gone")
        number = make_number(loner, agent=agent, verify=True)
        cid = self.add(rest_call(self.answered(number["vapi_phone_id"]), number["vapi_phone_id"]))
        supabase.table("ai_agents").delete().eq("id", agent["id"]).execute()
        data = self.sync(user=loner)
        self.assertEqual(data["imported"], 1)
        self.assertEqual(conversation(cid)["user_id"], loner)

    def test_an_account_with_nothing_to_sync_gets_the_note_and_makes_no_request(self):
        nobody = H.make_user()
        data = self.sync(user=nobody)
        self.assertEqual(data["imported"], 0)
        self.assertIn("No synced agents", data["note"])
        self.list_calls.assert_not_awaited()

    def test_team_members_sync_the_owners_calls(self):
        member = H.make_user("member")
        supabase.table("team_members").insert({"owner_id": self.user, "member_user_id": member, "member_email": "m@qa.test",
                                               "role": "member", "status": "Active"}).execute()
        cid = self.add(rest_call(self.answered(), self.vid))
        self.assertEqual(self.sync(user=member)["imported"], 1)
        self.assertEqual(conversation(cid)["user_id"], self.user)


# ═══════════════════════════════════════════════════════════════════════════
# Small fixes
# ═══════════════════════════════════════════════════════════════════════════


class SignatureHeaderTests(Base):
    """A non-ASCII x-vapi-signature used to raise TypeError in hmac.compare_digest: a 500."""

    def test_a_non_ascii_signature_is_rejected_not_a_server_error(self):
        patch_settings(self, vapi_webhook_secret="s3cret")
        for path in ("/webhooks/vapi", "/webhooks/vapi/inbound"):
            for value in (b"caf\xe9", "café".encode("utf-8"), b"\xff\xfe", "☃".encode("utf-8")):
                with self.subTest(path=path, value=value):
                    r = H.client.post(path, content=b'{"message": {}}', headers={"x-vapi-signature": value})
                    self.assertEqual(r.status_code, 401)

    def test_the_helper_itself_never_raises(self):
        patch_settings(self, vapi_webhook_secret="s3cret")
        for sig in ("café", "☃", "", None, "x" * 5000, "\x00"):
            self.assertFalse(webhooks._verify_signature(b"{}", sig))

    def test_a_correct_signature_still_passes(self):
        patch_settings(self, vapi_webhook_secret="s3cret")
        body = b'{"message": {"type": "transcript"}}'
        sig = hmac.new(b"s3cret", body, hashlib.sha256).hexdigest()
        self.assertTrue(webhooks._verify_signature(body, sig))
        self.assertFalse(webhooks._verify_signature(body, sig[:-1] + ("0" if sig[-1] != "0" else "1")))
        r = H.client.post("/webhooks/vapi", content=body, headers={"x-vapi-signature": sig, "Content-Type": "application/json"})
        self.assertEqual(r.status_code, 200)


class ErrorPathForSuspendedAccountsTests(Base):
    def setUp(self):
        super().setUp()
        self.agent = make_agent(self.user)
        self.num = make_number(self.user, agent=self.agent, verify=True, suspended=True)

    def test_an_error_while_serving_a_suspended_account_never_hands_the_caller_to_its_real_agent(self):
        # e.g. creating the shared fallback assistant failed
        with patch.object(cv, "_fallback_assistant_id", AsyncMock(side_effect=RuntimeError("vapi down"))):
            out = self.answer(self.num["vapi_phone_id"])
        self.assertEqual(out, {"error": cv.UNAVAILABLE_MESSAGE})

    def test_an_error_for_an_account_in_good_standing_still_reaches_its_agent(self):
        supabase.table("phone_numbers").update({"suspended_for_balance": False}).eq("id", self.num["id"]).execute()
        with patch.object(cv, "_screen", AsyncMock(side_effect=RuntimeError("boom"))):
            out = self.answer(self.num["vapi_phone_id"])
        self.assertEqual(out, {"assistantId": self.agent["vapi_assistant_id"]})


class BalanceSyncRaceTests(Base):
    """The balance sync reads its numbers once, then pushes to VAPI one at a time; a toggle can land
    in between. It must act on each number's CURRENT state."""

    def setUp(self):
        super().setUp()
        self.agent = make_agent(self.user)
        self.num = make_number(self.user, agent=self.agent)

    def pushes(self):
        return [(c.args[0], c.args[1]) for c in self.vapi.update_phone_number.await_args_list]

    def flip_during_fallback_creation(self, to):
        """Switch the flag in the database after the sync took its snapshot (the fallback assistant is created next)."""
        original = telephony._get_or_create_fallback_assistant_id

        async def flipping():
            supabase.table("phone_numbers").update({"caller_verification_enabled": to}).eq("id", self.num["id"]).execute()
            return await original()
        p = patch.object(telephony, "_get_or_create_fallback_assistant_id", flipping)
        p.start()
        self.addCleanup(p.stop)

    def test_a_number_switched_to_verification_during_the_sync_is_not_given_the_fallback_assistant(self):
        self.flip_during_fallback_creation(True)
        run(telephony.sync_inbound_routing_for_balance(self.user, True))
        self.assertEqual(self.pushes(), [])
        row = number_row(self.num["id"])
        self.assertEqual((row["caller_verification_enabled"], row["suspended_for_balance"]), (True, True))

    def test_a_number_switched_off_during_the_sync_is_suspended_like_any_static_number(self):
        supabase.table("phone_numbers").update({"caller_verification_enabled": True}).eq("id", self.num["id"]).execute()
        self.flip_during_fallback_creation(False)
        run(telephony.sync_inbound_routing_for_balance(self.user, True))
        fallback = supabase.table("platform_settings").select("fallback_assistant_id").execute().data[0]["fallback_assistant_id"]
        self.assertEqual(self.pushes(), [(self.num["vapi_phone_id"], {"assistantId": fallback})])
        self.assertIs(number_row(self.num["id"])["suspended_for_balance"], True)

    def test_a_number_deleted_during_the_sync_does_not_break_it(self):
        other = make_number(self.user, agent=self.agent)
        original = telephony._get_or_create_fallback_assistant_id

        async def deleting():
            supabase.table("phone_numbers").delete().eq("id", self.num["id"]).execute()
            return await original()
        with patch.object(telephony, "_get_or_create_fallback_assistant_id", deleting):
            run(telephony.sync_inbound_routing_for_balance(self.user, True))
        self.assertIs(number_row(other["id"])["suspended_for_balance"], True)

    def test_without_a_race_both_kinds_of_number_behave_as_before(self):
        verified = make_number(self.user, agent=self.agent, verify=True)
        run(telephony.sync_inbound_routing_for_balance(self.user, True))
        self.assertIs(number_row(verified["id"])["suspended_for_balance"], True)
        self.assertIs(number_row(self.num["id"])["suspended_for_balance"], True)
        self.assertEqual([p[0] for p in self.pushes()], [self.num["vapi_phone_id"]])  # only the static number was pushed


# ═══════════════════════════════════════════════════════════════════════════
# Fixes from the second review
# ═══════════════════════════════════════════════════════════════════════════


class InboundRateLimitTests(Base):
    """Only requests that fail authentication are throttled on the inbound route: a flood of forged
    or probing requests must never use up the allowance VAPI's real assistant-requests rely on."""

    SECRET = "inbound-secret"

    def setUp(self):
        super().setUp()
        patch_settings(self, vapi_webhook_secret=self.SECRET)
        self.agent = make_agent(self.user)
        self.num = make_number(self.user, agent=self.agent, verify=True)

    def send(self, secret=None):
        headers = {"X-Vapi-Secret": secret} if secret else {}
        return H.client.post("/webhooks/vapi/inbound", json=request_body(self.num["vapi_phone_id"]), headers=headers)

    def test_unauthenticated_requests_are_throttled_after_sixty_a_minute(self):
        codes = [self.send("wrong").status_code for _ in range(65)]
        self.assertEqual(set(codes[:60]), {401})
        self.assertEqual(set(codes[60:]), {429})

    def test_real_calls_still_get_through_while_forged_ones_are_throttled(self):
        for _ in range(70):
            self.send()
        r = self.send(self.SECRET)
        self.assertEqual((r.status_code, r.json()), (200, {"assistantId": self.agent["vapi_assistant_id"]}))

    def test_authenticated_requests_are_never_throttled(self):
        codes = {self.send(self.SECRET).status_code for _ in range(200)}
        self.assertEqual(codes, {200})

    def test_the_events_route_throttles_only_unauthenticated_requests(self):
        # Re-pinned (dialing stage D): end-of-call reports at campaign concurrency 10-20 outran a blanket 120/minute,
        # so a request that carries a valid credential is never counted; failed ones keep the 120/minute allowance.
        good = [H.client.post("/webhooks/vapi", json={"message": {"type": "transcript"}},
                              headers={"X-Vapi-Secret": self.SECRET}).status_code for _ in range(130)]
        self.assertEqual(set(good), {200})
        bad = [H.client.post("/webhooks/vapi", json={"message": {"type": "transcript"}},
                             headers={"X-Vapi-Secret": "wrong"}).status_code for _ in range(125)]
        self.assertEqual(set(bad[:120]), {401})
        self.assertEqual(set(bad[120:]), {429})
        # a real report still gets through while forged ones are throttled, and the inbound route has its own allowance
        self.assertEqual(H.client.post("/webhooks/vapi", json={"message": {"type": "transcript"}},
                                       headers={"X-Vapi-Secret": self.SECRET}).status_code, 200)
        self.assertEqual(self.send(self.SECRET).status_code, 200)

    def test_the_inbound_route_carries_no_blanket_limit(self):
        route = next(r for r in main.app.routes if getattr(r, "path", "") == "/webhooks/vapi/inbound")
        name = f"{route.endpoint.__module__}.{route.endpoint.__name__}"
        self.assertNotIn(name, webhooks.limiter._route_limits)


class LookupTlsContextTests(unittest.TestCase):
    """Building a TLS context loads the CA bundle (tens of ms): it is built once and shared."""

    def test_every_lookup_reuses_one_verifying_context(self):
        seen = []
        real = httpx.AsyncClient

        def capturing(*args, **kwargs):
            seen.append(kwargs.get("verify"))
            return real(*args, **kwargs)
        transport = httpx.MockTransport(lambda request: httpx.Response(200, json={"found": True, "lineType": "mobile"}))
        with patch.object(caller_lookup, "_TRANSPORT", transport), patch.object(caller_lookup.httpx, "AsyncClient", capturing):
            run(caller_lookup._fetch("5551230001"))
            run(caller_lookup._fetch("5551230002"))
        self.assertEqual(len(seen), 2)
        self.assertIsInstance(seen[0], ssl.SSLContext)
        self.assertIs(seen[0], seen[1])
        self.assertEqual((seen[0].verify_mode, seen[0].check_hostname), (ssl.CERT_REQUIRED, True))


class FallbackBudgetTests(Base):
    """A suspended account's caller is served the shared fallback assistant; creating it (first use
    only) is a VAPI round trip that must not eat the call's whole time allowance."""

    def setUp(self):
        super().setUp()
        self.agent = make_agent(self.user)
        self.num = make_number(self.user, agent=self.agent, verify=True, suspended=True)
        supabase.table("platform_settings").update({"fallback_assistant_id": None}).eq("id", 1).execute()
        cv._fallback_task = None
        self.addCleanup(setattr, cv, "_fallback_task", None)

    def slow_creation(self, seconds, assistant_id="asst-fallback-slow"):
        async def create(payload):
            await asyncio.sleep(seconds)
            return {"id": assistant_id}
        self.vapi.create_assistant.side_effect = create

    def request(self):
        return cv.handle_assistant_request(request_body(self.num["vapi_phone_id"]))

    def test_the_budget_leaves_room_inside_vapis_limit(self):
        self.assertLessEqual(cv.FALLBACK_BUDGET_SECONDS, 2.5)

    def test_a_slow_creation_refuses_politely_on_time(self):
        self.slow_creation(5)

        async def scenario():
            started = time.monotonic()
            out = await self.request()
            return out, time.monotonic() - started
        with patch.object(cv, "FALLBACK_BUDGET_SECONDS", 0.2), self.assertLogs(cv.logger, "WARNING"):
            out, elapsed = run(scenario())
        self.assertEqual(out, {"error": cv.UNAVAILABLE_MESSAGE})
        self.assertLess(elapsed, 1.5)

    def test_the_overrunning_creation_finishes_and_serves_the_next_caller(self):
        self.slow_creation(0.3)

        async def scenario():
            first = await self.request()
            await asyncio.sleep(0.5)
            second = await self.request()
            return first, second
        with patch.object(cv, "FALLBACK_BUDGET_SECONDS", 0.1), self.assertLogs(cv.logger, "WARNING"):
            first, second = run(scenario())
        self.assertEqual(first, {"error": cv.UNAVAILABLE_MESSAGE})
        self.assertEqual(second, {"assistantId": "asst-fallback-slow"})
        self.assertEqual(self.vapi.create_assistant.await_count, 1)

    def test_concurrent_callers_share_one_creation(self):
        self.slow_creation(0.2)

        async def scenario():
            return await asyncio.gather(*(self.request() for _ in range(4)))
        outs = run(scenario())
        self.assertEqual(outs, [{"assistantId": "asst-fallback-slow"}] * 4)
        self.assertEqual(self.vapi.create_assistant.await_count, 1)

    def test_a_failed_creation_refuses_politely(self):
        self.vapi.create_assistant.side_effect = RuntimeError("vapi down")
        self.assertEqual(run(self.request()), {"error": cv.UNAVAILABLE_MESSAGE})

    def test_an_existing_fallback_is_served_without_any_creation(self):
        supabase.table("platform_settings").update({"fallback_assistant_id": "asst-cached"}).eq("id", 1).execute()
        self.assertEqual(run(self.request()), {"assistantId": "asst-cached"})
        self.vapi.create_assistant.assert_not_awaited()


class ToggleVsBalanceSyncTests(Base):
    """A settings save and a balance sync on the same number are serialized by its routing lock.
    Without it a toggle could land between the sync's read and its VAPI push, leaving VAPI with a
    fixed fallback assistant while the database says the number is verified (calls never checked)."""

    def setUp(self):
        super().setUp()
        self.agent = make_agent(self.user)
        self.num = make_number(self.user, agent=self.agent)
        self.vid = self.num["vapi_phone_id"]

    def toggle(self, on):
        return telephony.update_phone_number(self.num["id"], PhoneNumberUpdate(caller_verification_enabled=on),
                                             user={"user_id": self.user})

    def race(self, make_second, *, hold):
        """Start the balance sync, hold its VAPI push for the payload `hold` matches, start the
        second operation while it is held, then release. Returns the pushes in the order VAPI saw them."""
        landed = []

        async def scenario():
            gate, held = asyncio.Event(), asyncio.Event()

            async def push(phone_id, payload):
                if hold(payload) and not gate.is_set():
                    held.set()
                    await gate.wait()
                landed.append(payload)
                return {}
            self.vapi.update_phone_number.side_effect = push
            sync = asyncio.create_task(telephony.sync_inbound_routing_for_balance(self.user, self.block))
            await asyncio.wait_for(held.wait(), 5)
            second = asyncio.create_task(make_second())
            await asyncio.sleep(0.1)
            waited = not second.done()
            gate.set()
            await sync
            await second
            return waited
        waited = run(scenario())
        return waited, landed

    def test_switching_on_during_a_suspension_waits_and_wins(self):
        self.block = True
        waited, landed = self.race(lambda: self.toggle(True), hold=lambda p: "server" not in p)
        self.assertTrue(waited, "the toggle did not wait for the balance sync")
        self.assertEqual(landed[-1], cv.verified_routing_payload())  # VAPI ends up asking this server
        row = number_row(self.num["id"])
        self.assertEqual((row["caller_verification_enabled"], row["suspended_for_balance"]), (True, True))
        fallback = supabase.table("platform_settings").select("fallback_assistant_id").execute().data[0]["fallback_assistant_id"]
        self.assertEqual(self.answer(self.vid), {"assistantId": fallback})  # still suspended: fallback, not the agent

    def test_switching_off_during_a_restore_waits_and_installs_the_agent(self):
        supabase.table("phone_numbers").update({"caller_verification_enabled": True, "suspended_for_balance": True}) \
            .eq("id", self.num["id"]).execute()
        other = make_number(self.user, agent=self.agent, suspended=True)  # a static number the restore pushes
        self.block = False
        waited, landed = self.race(lambda: self.toggle(False), hold=lambda p: True)
        self.assertTrue(waited)
        row = number_row(self.num["id"])
        self.assertEqual((row["caller_verification_enabled"], row["suspended_for_balance"]), (False, False))
        self.assertEqual(landed[-1], {"assistantId": self.agent["vapi_assistant_id"]})
        self.assertIs(number_row(other["id"])["suspended_for_balance"], False)

    def test_different_numbers_do_not_wait_for_each_other(self):
        async def scenario():
            a, b = cv.routing_lock(self.num["id"]), cv.routing_lock(str(uuid.uuid4()))
            async with a:
                await asyncio.wait_for(b.acquire(), 0.5)
                b.release()
            return a is cv.routing_lock(self.num["id"]) and a is cv.routing_lock(uuid.UUID(self.num["id"]))
        self.assertTrue(run(scenario()))


class SuspendedStaticNumberTests(Base):
    """While the balance suspends a number with no verification, VAPI holds the shared fallback
    assistant. Agent changes must not replace it (callers would reach an agent the account cannot pay
    for); the restore installs whatever agent is assigned then."""

    def setUp(self):
        super().setUp()
        self.agent = make_agent(self.user)
        self.second = make_agent(self.user, "Second")
        self.num = make_number(self.user, agent=self.agent, suspended=True)
        self.vid = self.num["vapi_phone_id"]

    def pushes(self):
        return [(c.args[0], c.args[1]) for c in self.vapi.update_phone_number.await_args_list]

    def restore(self):
        run(telephony.sync_inbound_routing_for_balance(self.user, False))

    def queue(self, number_id, agent):
        r = H.client.post("/telephony/inbound", json={"name": "Front desk", "agent_id": agent["id"],
                                                      "phone_number_id": number_id}, headers=H.auth(self.user))
        return r

    def test_changing_the_agent_changes_only_the_database_and_the_restore_installs_it(self):
        r = self.patch_number(self.num["id"], {"agent_id": self.second["id"]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.pushes(), [])
        self.assertEqual(number_row(self.num["id"])["agent_id"], self.second["id"])
        self.restore()
        self.assertEqual(self.pushes(), [(self.vid, {"assistantId": self.second["vapi_assistant_id"]})])
        self.assertIs(number_row(self.num["id"])["suspended_for_balance"], False)

    def test_a_receptionist_attached_while_suspended_waits_for_the_restore(self):
        self.assertEqual(self.queue(self.num["id"], self.second).status_code, 200)
        self.assertEqual(self.pushes(), [])
        self.restore()
        self.assertEqual(self.pushes(), [(self.vid, {"assistantId": self.second["vapi_assistant_id"]})])

    def test_a_receptionist_changed_or_deleted_while_suspended_touches_nothing_in_vapi(self):
        supabase.table("phone_numbers").update({"suspended_for_balance": False}).eq("id", self.num["id"]).execute()
        q = self.queue(self.num["id"], self.agent).json()["data"]
        supabase.table("phone_numbers").update({"suspended_for_balance": True}).eq("id", self.num["id"]).execute()
        self.vapi.update_phone_number.reset_mock()
        r = H.client.patch(f"/telephony/inbound/{q['id']}", json={"agent_id": self.second["id"]}, headers=H.auth(self.user))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(number_row(self.num["id"])["agent_id"], self.second["id"])
        r = H.client.delete(f"/telephony/inbound/{q['id']}", headers=H.auth(self.user))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.pushes(), [])
        row = number_row(self.num["id"])
        self.assertEqual((row["agent_id"], row["suspended_for_balance"]), (None, True))

    def test_switching_verification_on_while_suspended_keeps_serving_the_fallback_until_the_restore(self):
        r = self.patch_number(self.num["id"], {"caller_verification_enabled": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.pushes(), [(self.vid, cv.verified_routing_payload())])
        self.assertNotEqual(self.answer(self.vid), {"assistantId": self.agent["vapi_assistant_id"]})
        self.vapi.update_phone_number.reset_mock()
        self.restore()
        self.assertEqual(self.pushes(), [])  # a verified number has nothing to swap in VAPI
        self.assertIs(number_row(self.num["id"])["suspended_for_balance"], False)
        self.assertEqual(self.answer(self.vid), {"assistantId": self.agent["vapi_assistant_id"]})

    def test_a_number_in_good_standing_still_gets_its_agent_pushed(self):
        supabase.table("phone_numbers").update({"suspended_for_balance": False}).eq("id", self.num["id"]).execute()
        self.patch_number(self.num["id"], {"agent_id": self.second["id"]})
        self.assertEqual(self.pushes(), [(self.vid, {"assistantId": self.second["vapi_assistant_id"]})])


class MalformedIdTests(Base):
    def test_a_malformed_number_id_is_not_found_not_a_server_error(self):
        for bad in ("not-a-uuid", "123", "' OR 1=1 --", "%00"):
            with self.subTest(bad=bad):
                r = self.patch_number(bad, {"caller_verification_enabled": True})
                self.assertEqual(r.status_code, 404, r.text)

    def test_a_malformed_number_on_a_receptionist_is_rejected(self):
        agent = make_agent(self.user)
        r = H.client.post("/telephony/inbound", json={"name": "Front desk", "agent_id": agent["id"],
                                                      "phone_number_id": "not-a-uuid"}, headers=H.auth(self.user))
        self.assertEqual(r.status_code, 400, r.text)


class MissingSettingLogTests(Base):
    def test_the_operator_is_told_which_setting_is_missing_and_the_customer_is_not(self):
        number = make_number(self.user, agent=make_agent(self.user))
        patch_settings(self, public_api_url="")
        with self.assertLogs(telephony.logger, "WARNING") as logs:
            r = self.patch_number(number["id"], {"caller_verification_enabled": True})
        self.assertEqual(r.status_code, 503)
        self.assertIn("PUBLIC_API_URL", "\n".join(logs.output))
        detail = r.json()["detail"]
        for word in ("PUBLIC_API_URL", "VAPI", "CALLER_LOOKUP"):
            self.assertNotIn(word, detail)

    def test_missing_settings_names_each_gap(self):
        patch_settings(self, vapi_api_key="", caller_lookup_code="")
        names = cv.missing_settings()
        self.assertEqual(len(names), 2)
        self.assertTrue(any("VAPI_API_KEY" in n for n in names) and any("CALLER_LOOKUP" in n for n in names))
        patch_settings(self, vapi_api_key="k", caller_lookup_code=CODE)
        self.assertEqual(cv.missing_settings(), [])


class WorkerThreadRestoreTests(unittest.TestCase):
    """The auto-recharge charges the card in a worker thread; its credit is what un-suspends the
    numbers, so the routing restore it triggers must run on the app's loop, not be dropped."""

    def setUp(self):
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, daemon=True)
        self.thread.start()

        def stop():
            self.loop.call_soon_threadsafe(self.loop.stop)
            self.thread.join(2)
            self.loop.close()
        self.addCleanup(stop)
        self.sync = AsyncMock()
        p = patch.object(telephony, "sync_inbound_routing_for_balance", self.sync)
        p.start()
        self.addCleanup(p.stop)

    def from_worker(self, *args):
        worker = threading.Thread(target=billing_router._sync_inbound_routing, args=args)
        worker.start()
        worker.join(2)

    def test_a_restore_from_a_worker_thread_runs_on_the_app_loop(self):
        with patch.object(billing_router, "_app_loop", self.loop):
            self.from_worker("user-1", False)
            deadline = time.monotonic() + 2
            while not self.sync.await_count and time.monotonic() < deadline:
                time.sleep(0.01)
        self.sync.assert_awaited_once_with("user-1", False)

    def test_without_an_app_loop_it_is_skipped_quietly(self):
        with patch.object(billing_router, "_app_loop", None), self.assertLogs(billing_router.logger, "DEBUG"):
            self.from_worker("user-1", False)
        self.sync.assert_not_awaited()

    def test_running_on_the_loop_remembers_it(self):
        async def scenario():
            billing_router._sync_inbound_routing("user-1", True)
            await asyncio.sleep(0.05)
            return asyncio.get_running_loop()
        with patch.object(billing_router, "_app_loop", None):
            loop = asyncio.run(scenario())
            self.assertIs(billing_router._app_loop, loop)
        self.sync.assert_awaited_once_with("user-1", True)


class HostileLookupBodyTests(Base):
    def setUp(self):
        super().setUp()
        self.agent = make_agent(self.user)
        self.num = make_number(self.user, agent=self.agent, verify=True)

    def test_a_deeply_nested_body_cannot_crash_the_parser(self):
        self.assertIsNone(caller_lookup._json_or_none("[" * 200_000))
        self.assertIsNone(caller_lookup._json_or_none("{\"a\":" * 200_000))

    def test_a_deeply_nested_body_is_an_outage_and_the_caller_is_answered(self):
        self.lookup.default = (200, "[" * 200_000)
        self.assertEqual(self.answer(self.num["vapi_phone_id"]), {"assistantId": self.agent["vapi_assistant_id"]})
        self.assertEqual(screenings(self.user)[-1]["decision"], "answered")

    def test_an_unexpected_classifier_error_is_an_outage_not_a_crash(self):
        with patch.object(caller_lookup, "classify_response", side_effect=RuntimeError("bug")):
            result = run(caller_lookup.lookup_mobile("5551230001"))
            self.assertEqual((result.outcome, result.detail), ("unavailable", "bad_response"))
            self.assertEqual(self.answer(self.num["vapi_phone_id"]), {"assistantId": self.agent["vapi_assistant_id"]})


class CallerHangsUpDuringRefusalTests(Base):
    def test_a_refused_caller_hanging_up_mid_sentence_leaves_no_conversation_or_charge(self):
        H.fund_wallet(self.user, 20.0)
        agent = make_agent(self.user)
        num = make_number(self.user, agent=agent, verify=True)
        self.lookup.default = VOIP
        cid = f"call-{uuid.uuid4().hex[:8]}"
        self.assertEqual(self.answer(num["vapi_phone_id"], call_id=cid), {"error": cv.REFUSAL_MESSAGE})
        for event in ({"message": {"type": "status-update", "status": "ended", "endedReason": "customer-ended-call",
                                   "call": {"id": cid, "type": "inboundPhoneCall", "phoneNumberId": num["vapi_phone_id"]}}},
                      report(cid, num["vapi_phone_id"], ended="customer-ended-call", seconds=2)):
            self.assertEqual(H.client.post("/webhooks/vapi", json=event).status_code, 200)
        self.assertIsNone(conversation(cid))
        self.assertEqual(charges(cid), [])
        self.assertAlmostEqual(billing_router.get_balance(self.user), 20.0, places=2)


if __name__ == "__main__":
    unittest.main()
