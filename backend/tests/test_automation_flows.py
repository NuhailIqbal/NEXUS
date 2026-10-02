"""Automation feature: flow CRUD/versions/runs API, "Run now" (Now trigger), call-ended
triggers, and every node kind in the engine. Runs against the throw-away QA database
(see qa_harness.py). Run from backend/:  python -m unittest tests.test_automation_flows -v
"""
import asyncio
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import AsyncMock, patch

import qa_harness as h
from qa_harness import client, auth
from database import supabase
from routers import automation as automation_router
from services import automation_engine as eng


def node(nid, kind, config=None, ntype=None):
    ntype = ntype or {
        "now": "trigger", "inbound-call": "trigger", "internet-call": "trigger", "event": "trigger",
        "delay": "operator", "split": "operator", "condition": "condition",
    }.get(kind, "action")
    return {"id": nid, "type": ntype, "data": {"kind": kind, "label": kind, "config": config or {}}}


def edge(src, dst, handle=None):
    e = {"source": src, "target": dst}
    if handle:
        e["sourceHandle"] = handle
    return e


class Hook:
    """Local HTTP server that records webhook hits."""

    def __init__(self, status=200):
        self.hits = []
        hits, code = self.hits, status

        class H(BaseHTTPRequestHandler):
            def _h(self):
                n = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(n) if n else b""
                hits.append((self.command, self.path, json.loads(body) if body else None))
                self.send_response(code)
                self.end_headers()

            do_POST = do_PUT = do_PATCH = do_DELETE = _h

            def log_message(self, *a):
                pass

        self.srv = HTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.srv.server_port}"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()

    def paths(self):
        return [p for _, p, _ in self.hits]


class Base(unittest.TestCase):
    def setUp(self):
        h.reset_rate_limits()
        self.user = h.make_user("auto")
        self.hook = Hook()
        self.addCleanup(self.hook.close)

    def url(self, path):
        return f"{self.hook.url}{path}"

    def wh(self, nid, path):
        return node(nid, "webhook", {"url": self.url(path), "method": "POST"})

    def make_flow(self, nodes, edges, status="Active", trigger="manual", user=None):
        return supabase.table("automation_flows").insert({
            "user_id": user or self.user, "name": "QA flow", "status": status,
            "definition": {"nodes": nodes, "edges": edges, "trigger": {"event": trigger}},
        }).execute().data[0]

    def run_manual(self, flow):
        conv, run_id = eng.create_manual_run(self.user, flow)
        asyncio.run(eng.execute_manual_run(self.user, flow, conv, run_id))
        return self.run_row(run_id)

    def run_row(self, run_id):
        return supabase.table("automation_runs").select("*").eq("id", run_id).execute().data[0]

    def call_ended(self, **conv):
        conversation = {"id": None, "phone": "+15550001111", "contact_name": "Ali", "status": "Completed", **conv}
        asyncio.run(eng.run_post_call_automations(self.user, conversation))
        return conversation

    def runs_for(self, flow):
        return supabase.table("automation_runs").select("*").eq("flow_id", flow["id"]).execute().data


# ─────────────────────────────── API ───────────────────────────────

class FlowApi(Base):
    def test_crud_roundtrip(self):
        r = client.post("/automation/flows", json={"name": "A", "description": "d"}, headers=auth(self.user))
        self.assertEqual(r.status_code, 200, r.text)
        fid = r.json()["data"]["id"]
        self.assertEqual(r.json()["data"]["status"], "Active")

        self.assertEqual(client.get(f"/automation/flows/{fid}", headers=auth(self.user)).json()["data"]["name"], "A")
        self.assertIn(fid, [f["id"] for f in client.get("/automation/flows", headers=auth(self.user)).json()["data"]])

        r = client.patch(f"/automation/flows/{fid}", json={"name": "B", "status": "Paused"}, headers=auth(self.user))
        self.assertEqual((r.json()["data"]["name"], r.json()["data"]["status"]), ("B", "Paused"))

        client.delete(f"/automation/flows/{fid}", headers=auth(self.user))
        self.assertEqual(client.get(f"/automation/flows/{fid}", headers=auth(self.user)).status_code, 404)

    def test_requires_auth(self):
        for method, path in [("get", "/automation/flows"), ("post", "/automation/flows/x/run"),
                             ("get", "/automation/runs"), ("get", "/automation/runs/stats")]:
            r = getattr(client, method)(path)
            self.assertIn(r.status_code, (401, 403), f"{method} {path} -> {r.status_code}")

    def test_validation_rejects_bad_input(self):
        H = auth(self.user)
        self.assertEqual(client.post("/automation/flows", json={}, headers=H).status_code, 422)
        self.assertEqual(client.post("/automation/flows", json={"name": ""}, headers=H).status_code, 422)
        self.assertEqual(client.post("/automation/flows", json={"name": "x" * 201}, headers=H).status_code, 422)
        self.assertEqual(client.post("/automation/flows", json={"name": "x", "status": "Bogus"}, headers=H).status_code, 422)
        f = self.make_flow([], [])
        self.assertEqual(client.patch(f"/automation/flows/{f['id']}", json={"status": "Bogus"}, headers=H).status_code, 422)
        self.assertEqual(client.patch(f"/automation/flows/{f['id']}", json={"name": ""}, headers=H).status_code, 422)

    def test_patch_with_no_fields(self):
        f = self.make_flow([], [])
        r = client.patch(f"/automation/flows/{f['id']}", json={}, headers=auth(self.user))
        self.assertEqual(r.json()["error"], "No fields to update")

    def test_malformed_ids_are_404_not_500(self):
        H = auth(self.user)
        for method, path in [("get", "/automation/flows/not-a-uuid"), ("patch", "/automation/flows/not-a-uuid"),
                             ("delete", "/automation/flows/not-a-uuid"), ("post", "/automation/flows/not-a-uuid/run"),
                             ("get", "/automation/flows/not-a-uuid/versions"),
                             ("get", "/automation/flows/not-a-uuid/versions/also-bad"),
                             ("post", "/automation/flows/not-a-uuid/versions/also-bad/restore"),
                             ("get", "/automation/runs/not-a-uuid"), ("get", "/automation/runs?flow_id=not-a-uuid")]:
            kw = {"json": {"name": "x"}} if method == "patch" else {}
            r = getattr(client, method)(path, headers=H, **kw)
            self.assertEqual(r.status_code, 404, f"{method} {path} -> {r.status_code}")

    def test_tenant_isolation(self):
        other = h.make_user("other")
        f = self.make_flow([node("n", "now")], [])
        O = auth(other)
        self.assertEqual(client.get(f"/automation/flows/{f['id']}", headers=O).status_code, 404)
        self.assertNotIn(f["id"], [x["id"] for x in client.get("/automation/flows", headers=O).json()["data"]])
        client.patch(f"/automation/flows/{f['id']}", json={"name": "hacked"}, headers=O)
        client.delete(f"/automation/flows/{f['id']}", headers=O)
        still = supabase.table("automation_flows").select("*").eq("id", f["id"]).execute().data
        self.assertEqual(still[0]["name"], "QA flow")
        self.assertEqual(client.post(f"/automation/flows/{f['id']}/run", headers=O).status_code, 404)
        self.assertEqual(client.get(f"/automation/flows/{f['id']}/versions", headers=O).status_code, 404)

    def test_versions_snapshot_restore_and_cap(self):
        H = auth(self.user)
        fid = client.post("/automation/flows", json={"name": "V", "definition": {"nodes": [], "edges": [], "v": 0}}, headers=H).json()["data"]["id"]
        for i in range(1, 13):
            client.patch(f"/automation/flows/{fid}", json={"definition": {"nodes": [], "edges": [], "v": i}}, headers=H)
        versions = client.get(f"/automation/flows/{fid}/versions", headers=H).json()["data"]
        self.assertEqual(len(versions), automation_router.VERSION_HISTORY_LIMIT)
        self.assertEqual(versions[0]["version_number"], 12)
        oldest = versions[-1]
        snap = client.get(f"/automation/flows/{fid}/versions/{oldest['id']}", headers=H).json()["data"]
        r = client.post(f"/automation/flows/{fid}/versions/{oldest['id']}/restore", headers=H)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(client.get(f"/automation/flows/{fid}", headers=H).json()["data"]["definition"], snap["definition"])
        self.assertEqual(client.get(f"/automation/flows/{fid}/versions/{'0' * 8}-0000-0000-0000-{'0' * 12}", headers=H).status_code, 404)

    def test_runs_list_filter_stats_and_get(self):
        f = self.make_flow([node("n", "now")], [])
        for status in ("success", "success", "failed"):
            supabase.table("automation_runs").insert({"user_id": self.user, "flow_id": f["id"], "trigger_event": "manual", "status": status}).execute()
        H = auth(self.user)
        self.assertEqual(len(client.get("/automation/runs", headers=H).json()["data"]), 3)
        self.assertEqual(len(client.get("/automation/runs?status=failed", headers=H).json()["data"]), 1)
        self.assertEqual(len(client.get(f"/automation/runs?flow_id={f['id']}&limit=2", headers=H).json()["data"]), 2)
        self.assertEqual(len(client.get("/automation/runs?limit=2&offset=2", headers=H).json()["data"]), 1)
        self.assertEqual(client.get("/automation/runs?limit=999", headers=H).status_code, 422)
        stats = client.get("/automation/runs/stats", headers=H).json()["data"]
        self.assertEqual((stats["total"], stats["success"], stats["failed"]), (3, 2, 1))
        rid = client.get("/automation/runs", headers=H).json()["data"][0]["id"]
        self.assertEqual(client.get(f"/automation/runs/{rid}", headers=H).status_code, 200)
        O = auth(h.make_user("other"))
        self.assertEqual(client.get(f"/automation/runs/{rid}", headers=O).status_code, 404)
        self.assertEqual(client.get("/automation/runs", headers=O).json()["data"], [])


# ─────────────────────────────── Run now ───────────────────────────────

class RunNow(Base):
    def test_endpoint_starts_run_and_records_result(self):
        f = self.make_flow([node("n", "now"), self.wh("a", "/a")], [edge("n", "a")], status="Paused")
        with TestClientLoop() as loop:
            r = loop.post(f"/automation/flows/{f['id']}/run", auth(self.user))
            self.assertEqual(r.status_code, 200, r.text)
            rid = r.json()["data"]["run_id"]
            loop.drain()
        row = self.run_row(rid)
        self.assertEqual((row["trigger_event"], row["status"]), ("manual", "success"))
        self.assertEqual(self.hook.paths(), ["/a"])

    def test_no_now_trigger_is_400(self):
        f = self.make_flow([node("t", "inbound-call")], [], trigger="call_ended")
        r = client.post(f"/automation/flows/{f['id']}/run", headers=auth(self.user))
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.runs_for(f), [])

    def test_empty_or_missing_definition_is_400(self):
        f = supabase.table("automation_flows").insert({"user_id": self.user, "name": "e", "status": "Active"}).execute().data[0]
        self.assertEqual(client.post(f"/automation/flows/{f['id']}/run", headers=auth(self.user)).status_code, 400)

    def test_unknown_flow_404(self):
        r = client.post("/automation/flows/00000000-0000-0000-0000-000000000000/run", headers=auth(self.user))
        self.assertEqual(r.status_code, 404)

    def test_runs_whole_graph_with_condition_branches_and_split(self):
        nodes = [node("n", "now"), node("c", "condition", {"field": "status", "op": "equals", "value": "manual"}),
                 self.wh("yes", "/yes"), self.wh("no", "/no"), node("s", "split"), self.wh("b1", "/b1"), self.wh("b2", "/b2")]
        edges = [edge("n", "c"), edge("c", "yes", "yes"), edge("c", "no", "no"), edge("yes", "s"), edge("s", "b1"), edge("s", "b2")]
        row = self.run_manual(self.make_flow(nodes, edges))
        self.assertEqual(row["status"], "success")
        self.assertEqual(sorted(self.hook.paths()), ["/b1", "/b2", "/yes"])

    def test_only_now_branch_runs_when_flow_has_two_triggers(self):
        nodes = [node("n", "now"), node("t", "inbound-call"), self.wh("a", "/from-now"), self.wh("b", "/from-call")]
        self.run_manual(self.make_flow(nodes, [edge("n", "a"), edge("t", "b")]))
        self.assertEqual(self.hook.paths(), ["/from-now"])

    def test_call_ended_does_not_run_now_branch(self):
        nodes = [node("n", "now"), node("t", "inbound-call"), self.wh("a", "/from-now"), self.wh("b", "/from-call")]
        f = self.make_flow(nodes, [edge("n", "a"), edge("t", "b")], trigger="call_ended")
        self.call_ended()
        self.assertEqual(self.hook.paths(), ["/from-call"])
        self.assertEqual(len(self.runs_for(f)), 1)

    def test_failed_node_marks_run_failed_with_error(self):
        row = self.run_manual(self.make_flow([node("n", "now"), node("c", "connect-agent", {})], [edge("n", "c")]))
        self.assertEqual(row["status"], "failed")
        self.assertIn("no agent selected", row["output_data"]["error"])

    def test_sms_without_recipient_is_skipped_not_failed(self):
        with patch.object(eng, "send_sms", new=AsyncMock()) as sms:
            row = self.run_manual(self.make_flow([node("n", "now"), node("s", "sms", {"message": "hi"})], [edge("n", "s")]))
        self.assertEqual(row["status"], "success")
        sms.assert_not_awaited()

    def test_email_with_explicit_recipient_sends(self):
        with patch.object(eng, "send_email", new=AsyncMock()) as mail:
            row = self.run_manual(self.make_flow(
                [node("n", "now"), node("e", "email", {"to": "a@b.co", "subject": "S", "body": "B"})], [edge("n", "e")]))
        self.assertEqual(row["status"], "success")
        mail.assert_awaited_once()
        self.assertEqual(mail.await_args.args[1:4], ("a@b.co", "S", "B"))

    def test_long_delay_schedules_then_resumes_even_if_flow_paused_afterwards(self):
        f = self.make_flow([node("n", "now"), node("d", "delay", {"duration": 5, "unit": "minutes"}), self.wh("a", "/after")],
                           [edge("n", "d"), edge("d", "a")])
        row = self.run_manual(f)
        self.assertEqual(row["status"], "success")
        self.assertEqual(row["output_data"].get("delayed_steps_scheduled"), 1)
        self.assertEqual(self.hook.paths(), [])
        supabase.table("automation_flows").update({"status": "Paused"}).eq("id", f["id"]).execute()
        h.sql("update automation_pending_steps set resume_at = now() - interval '1 second' where flow_id=%s", (f["id"],))
        self.assertEqual(asyncio.run(eng.run_due_delayed_steps()), 1)
        self.assertEqual(self.hook.paths(), ["/after"])

    def test_paused_flow_cancels_delayed_step_of_automatic_run(self):
        f = self.make_flow([node("t", "inbound-call"), node("d", "delay", {"duration": 5, "unit": "minutes"}), self.wh("a", "/after")],
                           [edge("t", "d"), edge("d", "a")], trigger="call_ended")
        self.call_ended()
        supabase.table("automation_flows").update({"status": "Paused"}).eq("id", f["id"]).execute()
        h.sql("update automation_pending_steps set resume_at = now() - interval '1 second' where flow_id=%s", (f["id"],))
        asyncio.run(eng.run_due_delayed_steps())
        self.assertEqual(self.hook.paths(), [])
        self.assertEqual(h.sql("select status from automation_pending_steps where flow_id=%s", (f["id"],))[0][0], "cancelled")

    def test_deleting_flow_removes_pending_steps(self):
        f = self.make_flow([node("n", "now"), node("d", "delay", {"duration": 5, "unit": "minutes"})], [edge("n", "d")])
        self.run_manual(f)
        self.assertEqual(h.sql("select count(*) from automation_pending_steps where flow_id=%s", (f["id"],))[0][0], 1)
        client.delete(f"/automation/flows/{f['id']}", headers=auth(self.user))
        self.assertEqual(h.sql("select count(*) from automation_pending_steps where flow_id=%s", (f["id"],))[0][0], 0)


class TestClientLoop:
    """TestClient tears its event loop down after each request, which would kill the
    background task started by /run. Run the ASGI app on one persistent loop instead."""

    def __enter__(self):
        import httpx
        import main
        self.loop = asyncio.new_event_loop()
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://t")
        return self

    def post(self, path, headers):
        return self.loop.run_until_complete(self.http.post(path, headers=headers))

    def drain(self):
        pending = list(automation_router._manual_runs)
        if pending:
            self.loop.run_until_complete(asyncio.gather(*pending))

    def __exit__(self, *a):
        self.loop.run_until_complete(self.http.aclose())
        self.loop.close()


# ─────────────────────────────── Call-ended triggers ───────────────────────────────

class CallEnded(Base):
    def test_only_active_call_ended_flows_fire(self):
        n = [node("t", "inbound-call"), self.wh("a", "/x")]
        e = [edge("t", "a")]
        active = self.make_flow(n, e, trigger="call_ended")
        paused = self.make_flow(n, e, status="Paused", trigger="call_ended")
        manual = self.make_flow(n, e, trigger="manual")
        self.call_ended()
        self.assertEqual(len(self.runs_for(active)), 1)
        self.assertEqual(self.runs_for(paused), [])
        self.assertEqual(self.runs_for(manual), [])
        self.assertEqual(self.runs_for(active)[0]["trigger_event"], "call_ended")

    def test_other_users_flows_never_fire(self):
        other = h.make_user("other")
        f = self.make_flow([node("t", "inbound-call"), self.wh("a", "/x")], [edge("t", "a")], trigger="call_ended", user=other)
        self.call_ended()
        self.assertEqual(self.runs_for(f), [])
        self.assertEqual(self.hook.paths(), [])

    def test_empty_definition_is_ignored(self):
        supabase.table("automation_flows").insert({"user_id": self.user, "name": "e", "status": "Active"}).execute()
        self.call_ended()  # must not raise

    def test_legacy_internet_call_trigger_still_works(self):
        f = self.make_flow([node("t", "internet-call"), self.wh("a", "/x")], [edge("t", "a")], trigger="call_ended")
        self.call_ended()
        self.assertEqual(self.hook.paths(), ["/x"])
        self.assertEqual(self.runs_for(f)[0]["status"], "success")

    def test_one_failing_flow_does_not_block_others(self):
        bad = self.make_flow([node("t", "inbound-call"), node("c", "connect-agent", {})], [edge("t", "c")], trigger="call_ended")
        good = self.make_flow([node("t", "inbound-call"), self.wh("a", "/ok")], [edge("t", "a")], trigger="call_ended")
        self.call_ended()
        self.assertEqual(self.runs_for(bad)[0]["status"], "failed")
        self.assertEqual(self.runs_for(good)[0]["status"], "success")
        self.assertEqual(self.hook.paths(), ["/ok"])


# ─────────────────────────────── Engine: nodes ───────────────────────────────

class Nodes(Base):
    def cond(self, field, op, value, **conv):
        """Returns which branch ran for a condition with given conversation fields."""
        self.hook.hits.clear()
        supabase.table("automation_flows").delete().eq("user_id", self.user).execute()
        nodes = [node("t", "inbound-call"), node("c", "condition", {"field": field, "op": op, "value": value}),
                 self.wh("y", "/yes"), self.wh("n", "/no")]
        self.make_flow(nodes, [edge("t", "c"), edge("c", "y", "yes"), edge("c", "n", "no")], trigger="call_ended")
        self.call_ended(**conv)
        return self.hook.paths()

    def test_condition_operators(self):
        self.assertEqual(self.cond("status", "equals", "completed", status="Completed"), ["/yes"])
        self.assertEqual(self.cond("status", "equals", "missed", status="Completed"), ["/no"])
        self.assertEqual(self.cond("status", "not_equals", "missed", status="Completed"), ["/yes"])
        self.assertEqual(self.cond("call_events", "contains", "do_not_call", call_events="interested, do_not_call"), ["/yes"])
        self.assertEqual(self.cond("call_events", "contains", "x", call_events=""), ["/no"])
        self.assertEqual(self.cond("duration", "gt", "30", duration="45"), ["/yes"])
        self.assertEqual(self.cond("duration", "lt", "30", duration="45"), ["/no"])
        self.assertEqual(self.cond("duration", "gt", "30", duration="abc"), ["/no"])      # non-numeric
        self.assertEqual(self.cond("missing_field", "equals", "x"), ["/no"])             # absent field
        self.assertEqual(self.cond("status", "bogus_op", "x", status="x"), ["/no"])      # unknown operator

    def test_webhook_payload_and_methods(self):
        for method in ("POST", "PUT", "PATCH", "DELETE"):
            self.hook.hits.clear()
            supabase.table("automation_flows").delete().eq("user_id", self.user).execute()
            self.make_flow([node("t", "inbound-call"), node("w", "webhook", {"url": self.url("/m"), "method": method})],
                           [edge("t", "w")], trigger="call_ended")
            self.call_ended()
            self.assertEqual(self.hook.hits[0][0], method)
        payload = self.hook.hits[0][2]
        self.assertEqual((payload["event"], payload["phone"], payload["contact_name"]), ("automation_trigger", "+15550001111", "Ali"))

    def test_webhook_unreachable_or_5xx_does_not_fail_run(self):
        bad = Hook(status=500)
        self.addCleanup(bad.close)
        f = self.make_flow([node("t", "inbound-call"),
                            node("w1", "webhook", {"url": "http://127.0.0.1:1/nope"}),
                            node("w2", "webhook", {"url": bad.url + "/x"}), self.wh("ok", "/after")],
                           [edge("t", "w1"), edge("w1", "w2"), edge("w2", "ok")], trigger="call_ended")
        self.call_ended()
        self.assertEqual(self.runs_for(f)[0]["status"], "success")
        self.assertEqual(self.hook.paths(), ["/after"])

    def test_webhook_blank_url_is_noop(self):
        f = self.make_flow([node("t", "inbound-call"), node("w", "webhook", {"url": ""})], [edge("t", "w")], trigger="call_ended")
        self.call_ended()
        self.assertEqual(self.runs_for(f)[0]["status"], "success")

    def test_sms_interpolates_and_passes_from_number(self):
        self.make_flow([node("t", "inbound-call"), node("s", "sms", {"message": "Hi {{contact_name}} ({{phone}}) {{status}}", "from": " +15559990000 "})],
                       [edge("t", "s")], trigger="call_ended")
        with patch.object(eng, "send_sms", new=AsyncMock()) as sms:
            self.call_ended()
        sms.assert_awaited_once_with(self.user, "+15550001111", "Hi Ali (+15550001111) Completed", "+15559990000")

    def test_sms_to_number_overrides_contact_and_works_in_run_now(self):
        with patch.object(eng, "send_sms", new=AsyncMock()) as sms:
            self.make_flow([node("t", "inbound-call"), node("s", "sms", {"message": "hi", "to": " +15558887777 "})],
                           [edge("t", "s")], trigger="call_ended")
            self.call_ended()
            self.assertEqual(sms.await_args.args[1], "+15558887777")   # override beats the call's phone
            sms.reset_mock()
            f = self.make_flow([node("n", "now"), node("s", "sms", {"message": "hi", "to": "+15558887777"})], [edge("n", "s")])
            self.assertEqual(self.run_manual(f)["status"], "success")
            self.assertEqual(sms.await_args.args[1], "+15558887777")   # Run now has no contact, so it needs this

    def test_sms_empty_message_skipped_and_provider_error_fails_run(self):
        f1 = self.make_flow([node("t", "inbound-call"), node("s", "sms", {"message": ""})], [edge("t", "s")], trigger="call_ended")
        with patch.object(eng, "send_sms", new=AsyncMock()) as sms:
            self.call_ended()
        sms.assert_not_awaited()
        self.assertEqual(self.runs_for(f1)[0]["status"], "success")
        f2 = self.make_flow([node("t", "inbound-call"), node("s", "sms", {"message": "x"})], [edge("t", "s")], trigger="call_ended")
        with patch.object(eng, "send_sms", new=AsyncMock(side_effect=RuntimeError("twilio down"))):
            self.call_ended()
        row = [r for r in self.runs_for(f2)][0]
        self.assertEqual((row["status"], row["output_data"]["error"]), ("failed", "twilio down"))

    def test_email_recipient_fallback_subject_default_and_errors(self):
        f = self.make_flow([node("t", "inbound-call"), node("e", "email", {"body": "Hi {{contact_name}}"})], [edge("t", "e")], trigger="call_ended")
        with patch.object(eng, "send_email", new=AsyncMock()) as mail:
            self.call_ended(email="c@x.co")
        self.assertEqual(mail.await_args.args[1:4], ("c@x.co", "Follow-up", "Hi Ali"))
        with patch.object(eng, "send_email", new=AsyncMock()) as mail:
            self.call_ended()  # no recipient anywhere
        mail.assert_not_awaited()
        with patch.object(eng, "send_email", new=AsyncMock(side_effect=RuntimeError("smtp down"))):
            self.call_ended(email="c@x.co")
        self.assertEqual(sorted(r["status"] for r in self.runs_for(f)), ["failed", "success", "success"])

    def test_update_contact(self):
        c = supabase.table("contacts").insert({"user_id": self.user, "name": "Ali", "phone": "+15550001111", "status": "Active"}).execute().data[0]
        other = supabase.table("contacts").insert({"user_id": h.make_user("o"), "name": "Zed", "phone": "+15550002222", "status": "Active"}).execute().data[0]
        self.make_flow([node("t", "inbound-call"), node("u", "update-contact", {"field": "status", "value": "Inactive"})],
                       [edge("t", "u")], trigger="call_ended")
        self.call_ended(contact_id=c["id"])
        self.assertEqual(h.sql("select status from contacts where id=%s", (c["id"],))[0][0], "Inactive")
        self.call_ended(contact_id=other["id"])  # someone else's contact: must not be touched
        self.assertEqual(h.sql("select status from contacts where id=%s", (other["id"],))[0][0], "Active")

    def test_update_contact_rejects_unsafe_fields_and_missing_contact(self):
        c = supabase.table("contacts").insert({"user_id": self.user, "name": "Ali", "phone": "+15550001111", "status": "Active"}).execute().data[0]
        f = self.make_flow([node("t", "inbound-call"), node("u", "update-contact", {"field": "user_id", "value": "x"})], [edge("t", "u")], trigger="call_ended")
        self.call_ended(contact_id=c["id"])
        self.assertEqual(h.sql("select user_id::text from contacts where id=%s", (c["id"],))[0][0], self.user)
        self.assertEqual(self.runs_for(f)[0]["status"], "success")
        self.call_ended()  # no contact linked

    def test_short_delay_runs_inline_and_zero_or_bad_duration(self):
        with patch.object(eng.asyncio, "sleep", new=AsyncMock()) as sleep:
            self.make_flow([node("t", "inbound-call"), node("d", "delay", {"duration": 0.5, "unit": "minutes"}), self.wh("a", "/a")],
                           [edge("t", "d"), edge("d", "a")], trigger="call_ended")
            self.call_ended()
        sleep.assert_awaited_once_with(30.0)
        self.assertEqual(self.hook.paths(), ["/a"])
        self.assertEqual(eng._delay_seconds({"duration": "abc"}), 60)   # falls back to 1 minute
        self.assertEqual(eng._delay_seconds({"duration": 2, "unit": "hours"}), 7200)
        self.assertEqual(eng._delay_seconds({"duration": 1, "unit": "days"}), 86400)

    def test_cycle_in_graph_terminates(self):
        f = self.make_flow([node("t", "inbound-call"), self.wh("a", "/a"), self.wh("b", "/b")],
                           [edge("t", "a"), edge("a", "b"), edge("b", "a")], trigger="call_ended")
        self.call_ended()
        self.assertEqual(self.hook.paths(), ["/a", "/b"])
        self.assertEqual(self.runs_for(f)[0]["status"], "success")

    def test_dangling_edge_and_unknown_node_kind_are_tolerated(self):
        f = self.make_flow([node("t", "inbound-call"), node("x", "teleport")], [edge("t", "x"), edge("x", "ghost")], trigger="call_ended")
        self.call_ended()
        self.assertEqual(self.runs_for(f)[0]["status"], "success")

    def test_split_isolates_failures_but_fails_run(self):
        f = self.make_flow([node("t", "inbound-call"), node("s", "split"), node("c", "connect-agent", {}), self.wh("ok", "/ok")],
                           [edge("t", "s"), edge("s", "c"), edge("s", "ok")], trigger="call_ended")
        self.call_ended()
        self.assertEqual(self.hook.paths(), ["/ok"])
        self.assertEqual(self.runs_for(f)[0]["status"], "failed")

    def test_connect_agent_unknown_agent_fails_and_no_phone_skips(self):
        with patch.object(eng, "outbound_call_block_reason", return_value=None), \
                patch.object(eng, "check_call_quota", return_value=True), \
                patch.object(eng.whitelist_service, "check_number", new=AsyncMock(return_value={"allowed": True})):
            f = self.make_flow([node("t", "inbound-call"), node("c", "connect-agent", {"agent_id": "00000000-0000-0000-0000-000000000000"})],
                               [edge("t", "c")], trigger="call_ended")
            self.call_ended()
            self.assertEqual(self.runs_for(f)[0]["status"], "failed")
            f2 = self.make_flow([node("t", "inbound-call"), node("c", "connect-agent", {"agent_id": "x"})], [edge("t", "c")], trigger="call_ended")
            self.call_ended(phone="")
            self.assertEqual([r for r in self.runs_for(f2)][0]["status"], "success")

    def test_connect_agent_places_call_and_honours_dnc_and_billing(self):
        vapi_mock = h.VapiMock().start()
        self.addCleanup(vapi_mock.stop)
        agent = h.create_agent_via_api(self.user, name="Caller")
        nodes = [node("t", "inbound-call"), node("c", "connect-agent", {"agent_id": agent["id"]})]
        self.make_flow(nodes, [edge("t", "c")], trigger="call_ended")
        vapi = AsyncMock(return_value={"id": "call-1"})
        base = dict(outbound_call_block_reason=patch.object(eng, "outbound_call_block_reason", return_value=None),
                    quota=patch.object(eng, "check_call_quota", return_value=True),
                    dnc=patch.object(eng.whitelist_service, "check_number", new=AsyncMock(return_value={"allowed": True})),
                    call=patch.object(eng.vapi_client, "create_call", new=vapi))
        with base["outbound_call_block_reason"], base["quota"], base["dnc"], base["call"]:
            self.call_ended()
        self.assertEqual(vapi.await_args.args[0]["customer"], {"number": "+15550001111"})
        vapi.reset_mock()
        with patch.object(eng, "outbound_call_block_reason", return_value="trial over"), base["quota"], base["dnc"], base["call"]:
            self.call_ended()
        with patch.object(eng, "outbound_call_block_reason", return_value=None), patch.object(eng, "check_call_quota", return_value=False), base["dnc"], base["call"]:
            self.call_ended()
        with patch.object(eng, "outbound_call_block_reason", return_value=None), base["quota"], \
                patch.object(eng.whitelist_service, "check_number", new=AsyncMock(return_value={"allowed": False, "reason": "DNC"})), base["call"]:
            self.call_ended()
        vapi.assert_not_awaited()

    def test_interpolate_handles_missing_and_none_values(self):
        self.assertEqual(eng._interpolate("a{{contact_name}}b{{duration}}c{{call_outcome}}", {"contact_name": None}), "abc")
        self.assertEqual(eng._interpolate("no vars", {}), "no vars")


if __name__ == "__main__":
    unittest.main()
