import asyncio
import hashlib
import hmac
import json
import time
import unittest
from unittest.mock import AsyncMock, patch

import psycopg

import qa_harness as h
from qa_harness import client, auth
from database import supabase
from routers import webhooks
from services import call_events as ce
from services import automation_engine

EVENTS = [
    {"label": "Interested", "outcome": "Interested"},
    {"label": "Callback Requested", "outcome": "Callback"},
    {"label": "Do Not Call", "outcome": "Do Not Call"},
]


class Base(unittest.TestCase):
    def setUp(self):
        h.reset_rate_limits()
        self.vapi = h.VapiMock().start()
        self.user = h.make_user()
        self.agent = h.create_agent_via_api(self.user, EVENTS)
        self.asst = self.agent["vapi_assistant_id"]
        self.call = f"call-{h.uuid.uuid4().hex[:8]}"
        # Isolate from billing / AI summary / automations — not what is under test here.
        self.patches = [
            patch.object(webhooks, "record_call_cost", return_value=0),
            patch.object(webhooks, "_post_call_ai", new=AsyncMock()),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.vapi.stop()

    def fire(self, key, tcid=None):
        body = h.tool_call_body(self.asst, self.call, [(tcid or f"tc-{h.uuid.uuid4().hex[:6]}", {"event": key})])
        r = client.post("/tools/internal/trigger-event", json=body)
        self.assertIn("recorded", r.json()["results"][0]["result"])

    def end_call(self, **kw):
        return client.post("/webhooks/vapi", json=h.end_of_call_body(self.asst, self.call, **kw))

    def outcome(self, conv_id):
        return h.sql("select call_outcome from conversations where id=%s", (conv_id,))[0][0]


class Hangup(Base):
    def test_W01_events_folded_into_existing_conversation(self):
        conv = h.make_conversation(self.user, self.call, self.agent["id"])
        self.fire("interested")
        self.fire("callback_requested")
        r = self.end_call()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.outcome(conv["id"]), "Callback")
        self.assertEqual(h.sql("select count(*) from call_event_hits where conversation_id=%s", (conv["id"],))[0][0], 2)
        self.assertEqual(h.sql("select status from conversations where id=%s", (conv["id"],))[0][0], "Completed")

    def test_W02_conversation_missing_at_hangup_is_created_then_linked(self):
        self.fire("do_not_call")
        self.assertEqual(self.end_call().status_code, 200)
        row = supabase.table("conversations").select("id, call_outcome, agent_id").eq("vapi_call_id", self.call).single().execute().data
        self.assertEqual(row["call_outcome"], "Do Not Call")
        self.assertEqual(row["agent_id"], self.agent["id"])

    def test_W03_call_without_events_has_no_outcome(self):
        conv = h.make_conversation(self.user, self.call, self.agent["id"])
        self.end_call()
        self.assertIsNone(self.outcome(conv["id"]))

    def test_W04_last_event_wins(self):
        conv = h.make_conversation(self.user, self.call, self.agent["id"])
        self.fire("do_not_call")
        time.sleep(0.02)
        self.fire("interested")
        self.end_call()
        self.assertEqual(self.outcome(conv["id"]), "Interested")

    def test_W05_duplicate_end_of_call_delivery_is_idempotent(self):
        conv = h.make_conversation(self.user, self.call, self.agent["id"])
        self.fire("callback_requested")
        self.end_call()
        self.end_call()
        self.assertEqual(self.outcome(conv["id"]), "Callback")
        self.assertEqual(h.sql("select count(*) from call_event_hits where vapi_call_id=%s", (self.call,))[0][0], 1)

    def test_W06_events_from_one_call_do_not_leak_into_another(self):
        conv1 = h.make_conversation(self.user, self.call, self.agent["id"])
        other_call = f"call-{h.uuid.uuid4().hex[:8]}"
        conv2 = h.make_conversation(self.user, other_call, self.agent["id"])
        self.fire("do_not_call")
        client.post("/webhooks/vapi", json=h.end_of_call_body(self.asst, other_call))
        self.assertIsNone(self.outcome(conv2["id"]))
        self.end_call()
        self.assertEqual(self.outcome(conv1["id"]), "Do Not Call")

    def test_W07_finalize_failure_does_not_break_call_end(self):
        conv = h.make_conversation(self.user, self.call, self.agent["id"])
        self.fire("interested")
        with patch.object(ce, "get_hits", side_effect=RuntimeError("db hiccup")):
            r = self.end_call()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(h.sql("select status from conversations where id=%s", (conv["id"],))[0][0], "Completed")

    def test_W08_import_vapi_call_new_row(self):
        self.fire("callback_requested")
        call = {"id": self.call, "assistantId": self.asst, "type": "outboundPhoneCall",
                "endedReason": "customer-ended-call", "startedAt": "2026-01-01T10:00:00Z",
                "artifact": {"transcript": "hi"}, "durationSeconds": 30}
        with patch.object(webhooks, "record_call_cost", return_value=0):
            self.assertEqual(webhooks.import_vapi_call(call, self.user), "imported")
        row = supabase.table("conversations").select("id, call_outcome").eq("vapi_call_id", self.call).single().execute().data
        self.assertEqual(row["call_outcome"], "Callback")

    def test_W09_import_vapi_call_existing_row_and_reimport(self):
        conv = h.make_conversation(self.user, self.call, self.agent["id"])
        self.fire("do_not_call")
        call = {"id": self.call, "assistantId": self.asst, "type": "outboundPhoneCall",
                "endedReason": "customer-ended-call", "artifact": {"transcript": "hi"}, "durationSeconds": 30}
        with patch.object(webhooks, "record_call_cost", return_value=0):
            self.assertEqual(webhooks.import_vapi_call(call, self.user), "updated")
            self.assertEqual(webhooks.import_vapi_call(call, self.user), "updated")
        self.assertEqual(self.outcome(conv["id"]), "Do Not Call")

    def test_W10_tool_calls_message_on_main_webhook_is_still_a_noop(self):
        r = client.post("/webhooks/vapi", json={"message": {"type": "tool-calls", "call": {"id": self.call}}})
        self.assertEqual((r.status_code, r.json()["type"]), (200, "tool-calls"))

    def test_W11_bad_signature_rejected_when_secret_configured(self):
        body = json.dumps(h.end_of_call_body(self.asst, self.call)).encode()
        with patch.object(webhooks.settings, "vapi_webhook_secret", "s3cret"):
            bad = client.post("/webhooks/vapi", content=body, headers={"x-vapi-signature": "nope", "Content-Type": "application/json"})
            good_sig = hmac.new(b"s3cret", body, hashlib.sha256).hexdigest()
            ok = client.post("/webhooks/vapi", content=body, headers={"x-vapi-signature": good_sig, "Content-Type": "application/json"})
        self.assertEqual(bad.status_code, 401)
        self.assertEqual(ok.status_code, 200)

    def test_W12_failed_call_with_events_still_records_outcome(self):
        conv = h.make_conversation(self.user, self.call, self.agent["id"])
        self.fire("interested")
        self.end_call(ended_reason="pipeline-error-openai-llm-failed")
        self.assertEqual(h.sql("select status from conversations where id=%s", (conv["id"],))[0][0], "Failed")
        self.assertEqual(self.outcome(conv["id"]), "Interested")

    def test_W13_deleting_conversation_removes_its_hits(self):
        conv = h.make_conversation(self.user, self.call, self.agent["id"])
        self.fire("interested")
        self.end_call()
        r = client.delete(f"/conversations/{conv['id']}", headers=auth(self.user))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(h.sql("select count(*) from call_event_hits where vapi_call_id=%s", (self.call,))[0][0], 0)


class ConversationsApi(Base):
    def setUp(self):
        super().setUp()
        self.conv = h.make_conversation(self.user, self.call, self.agent["id"])

    def test_V01_events_endpoint_returns_hits_in_order(self):
        self.fire("interested", "t1")
        time.sleep(0.02)
        self.fire("callback_requested", "t2")
        r = client.get(f"/conversations/{self.conv['id']}/events", headers=auth(self.user))
        self.assertEqual(r.status_code, 200)
        self.assertEqual([e["event_key"] for e in r.json()["data"]], ["interested", "callback_requested"])

    def test_V02_other_users_conversation_is_404(self):
        other = h.make_user()
        self.assertEqual(client.get(f"/conversations/{self.conv['id']}/events", headers=auth(other)).status_code, 404)

    def test_V03_conversation_without_call_id_returns_empty(self):
        c = h.make_conversation(self.user, None)
        r = client.get(f"/conversations/{c['id']}/events", headers=auth(self.user))
        self.assertEqual(r.json()["data"], [])

    def test_V04_unknown_conversation_is_404(self):
        self.assertEqual(client.get(f"/conversations/{h.uuid.uuid4()}/events", headers=auth(self.user)).status_code, 404)

    def test_V05_requires_auth(self):
        self.assertIn(client.get(f"/conversations/{self.conv['id']}/events").status_code, (401, 403))

    def test_V06_list_exposes_call_outcome_and_filters(self):
        self.fire("callback_requested")
        self.end_call()
        other_call = f"call-{h.uuid.uuid4().hex[:8]}"
        h.make_conversation(self.user, other_call, self.agent["id"], call_outcome="Interested")
        h.make_conversation(self.user, f"call-{h.uuid.uuid4().hex[:8]}", self.agent["id"])
        rows = client.get("/conversations?limit=100", headers=auth(self.user)).json()["data"]
        self.assertEqual(sorted(r.get("call_outcome") or "" for r in rows), ["", "Callback", "Interested"])
        f = client.get("/conversations?call_outcome=callb", headers=auth(self.user)).json()
        self.assertEqual([r["call_outcome"] for r in f["data"]], ["Callback"])
        self.assertEqual(f["meta"]["count"], 1)
        none = client.get("/conversations?call_outcome=zzz", headers=auth(self.user)).json()
        self.assertEqual(none["data"], [])

    def test_V07_filter_is_tenant_scoped(self):
        self.fire("do_not_call")
        self.end_call()
        other = h.make_user()
        rows = client.get("/conversations?call_outcome=Do", headers=auth(other)).json()["data"]
        self.assertEqual(rows, [])

    def test_V08_filter_combines_with_other_filters(self):
        self.fire("do_not_call")
        self.end_call()
        ok = client.get(f"/conversations?call_outcome=Do&agent_id={self.agent['id']}", headers=auth(self.user)).json()
        self.assertEqual(len(ok["data"]), 1)
        miss = client.get(f"/conversations?call_outcome=Do&agent_id={h.uuid.uuid4()}", headers=auth(self.user)).json()
        self.assertEqual(miss["data"], [])

    def test_V09_filter_injection_attempt_is_inert(self):
        r = client.get("/conversations", params={"call_outcome": "x'; DROP TABLE conversations;--"}, headers=auth(self.user))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["data"], [])
        self.assertEqual(h.sql("select to_regclass('public.conversations') is not null")[0][0], True)


class Automation(Base):
    """Flow: trigger -> condition(call_events contains do_not_call) -yes-> update-contact(status=Inactive)."""

    def make_flow(self, field="call_events", op="contains", value="do_not_call"):
        definition = {
            "trigger": {"event": "call_ended"},
            "nodes": [
                {"id": "t", "type": "trigger", "data": {"kind": "event"}},
                {"id": "c", "type": "condition", "data": {"kind": "condition", "config": {"field": field, "op": op, "value": value}}},
                {"id": "u", "type": "action", "data": {"kind": "update-contact", "config": {"field": "status", "value": "Inactive"}}},
            ],
            "edges": [{"source": "t", "target": "c"}, {"source": "c", "target": "u", "sourceHandle": "yes"}],
        }
        return supabase.table("automation_flows").insert(
            {"user_id": self.user, "name": "DNC flow", "status": "Active", "definition": definition}).execute().data[0]

    def setup_contact_and_call(self):
        contact = supabase.table("contacts").insert({"user_id": self.user, "name": "Ali", "phone": "+15550001111", "status": "Active"}).execute().data[0]
        conv = h.make_conversation(self.user, self.call, self.agent["id"], contact_id=contact["id"], phone="+15550001111", contact_name="Ali")
        return contact, conv

    def run_flows(self, conv_id):
        conversation = supabase.table("conversations").select("*").eq("id", conv_id).single().execute().data
        asyncio.run(automation_engine.run_post_call_automations(self.user, conversation))
        return conversation

    def contact_status(self, cid):
        return h.sql("select status from contacts where id=%s", (cid,))[0][0]

    def test_X01_condition_on_call_events_true_branch(self):
        self.make_flow()
        contact, conv = self.setup_contact_and_call()
        self.fire("interested")
        self.fire("do_not_call")
        self.end_call()
        self.run_flows(conv["id"])
        self.assertEqual(self.contact_status(contact["id"]), "Inactive")

    def test_X02_condition_false_when_event_absent(self):
        self.make_flow()
        contact, conv = self.setup_contact_and_call()
        self.fire("interested")
        self.end_call()
        self.run_flows(conv["id"])
        self.assertEqual(self.contact_status(contact["id"]), "Active")

    def test_X03_condition_on_call_outcome_equals(self):
        self.make_flow(field="call_outcome", op="equals", value="do not call")
        contact, conv = self.setup_contact_and_call()
        self.fire("do_not_call")
        self.end_call()
        self.run_flows(conv["id"])
        self.assertEqual(self.contact_status(contact["id"]), "Inactive")

    def test_X04_run_input_data_records_outcome_and_events(self):
        flow = self.make_flow()
        _, conv = self.setup_contact_and_call()
        self.fire("callback_requested")
        self.end_call()
        self.run_flows(conv["id"])
        run = supabase.table("automation_runs").select("input_data, status").eq("flow_id", flow["id"]).single().execute().data
        self.assertEqual(run["input_data"]["call_outcome"], "Callback")
        self.assertEqual(run["input_data"]["call_events"], "callback_requested")
        self.assertEqual(run["status"], "success")

    def test_X05_call_without_events_runs_flow_without_error(self):
        flow = self.make_flow()
        contact, conv = self.setup_contact_and_call()
        self.end_call()
        self.run_flows(conv["id"])
        run = supabase.table("automation_runs").select("status").eq("flow_id", flow["id"]).single().execute().data
        self.assertEqual(run["status"], "success")
        self.assertEqual(self.contact_status(contact["id"]), "Active")

    def test_X06_interpolation_variables(self):
        conversation = {"contact_name": "Ali", "call_outcome": "Callback", "call_events": "interested, callback_requested"}
        out = automation_engine._interpolate("Hi {{contact_name}}: {{call_outcome}} / {{call_events}}", conversation)
        self.assertEqual(out, "Hi Ali: Callback / interested, callback_requested")

    def test_X07_event_lookup_failure_does_not_break_automations(self):
        flow = self.make_flow()
        _, conv = self.setup_contact_and_call()
        with patch.object(automation_engine, "get_hits", side_effect=RuntimeError("db down")):
            self.run_flows(conv["id"])
        run = supabase.table("automation_runs").select("status").eq("flow_id", flow["id"]).single().execute().data
        self.assertEqual(run["status"], "success")

    def test_X08_another_users_flow_is_not_triggered(self):
        other = h.make_user()
        supabase.table("automation_flows").insert({"user_id": other, "name": "x", "status": "Active", "definition": {
            "trigger": {"event": "call_ended"}, "nodes": [], "edges": []}}).execute()
        _, conv = self.setup_contact_and_call()
        self.end_call()
        self.run_flows(conv["id"])
        self.assertEqual(h.sql("select count(*) from automation_runs where user_id=%s", (other,))[0][0], 0)


class Migration(unittest.TestCase):
    """Upgrade path: an existing database that predates the feature gets it on next start."""

    MIG_DB = "nexus_qa_callevents_mig"

    def test_M01_fresh_database_has_feature_schema(self):
        cols = {r[0] for r in h.sql("select column_name from information_schema.columns where table_name='call_events'")}
        self.assertTrue({"event_key", "label", "description", "outcome", "position", "agent_id", "user_id"} <= cols)
        hits = {r[0] for r in h.sql("select column_name from information_schema.columns where table_name='call_event_hits'")}
        self.assertTrue({"vapi_call_id", "conversation_id", "event_key", "outcome", "note", "tool_call_id"} <= hits)
        self.assertEqual(h.sql("select count(*) from information_schema.columns where column_name='call_outcome' and table_name='conversations'")[0][0], 1)
        self.assertEqual(h.sql("select count(*) from information_schema.columns where column_name='events_tool_id' and table_name='ai_agents'")[0][0], 1)

    def test_M02_upgrade_of_pre_feature_db_is_additive_and_idempotent(self):
        import migrate
        from types import SimpleNamespace
        from urllib.parse import urlparse, urlunparse
        mig_url = urlunparse(urlparse(h.QA_URL)._replace(path=f"/{self.MIG_DB}"))
        with psycopg.connect(h.ADMIN_URL, autocommit=True) as c:
            c.execute(f"DROP DATABASE IF EXISTS {self.MIG_DB} WITH (FORCE)")
            c.execute(f"CREATE DATABASE {self.MIG_DB}")
        try:
            with patch.object(migrate, "settings", SimpleNamespace(database_url=mig_url)):
                migrate.bootstrap_schema()
                with psycopg.connect(mig_url, autocommit=True) as c:
                    # Simulate a database created before this feature, with real rows in it.
                    c.execute("DROP TABLE call_event_hits, call_events, call_event_library CASCADE")
                    c.execute("ALTER TABLE conversations DROP COLUMN call_outcome")
                    c.execute("ALTER TABLE ai_agents DROP COLUMN events_tool_id")
                    uid = c.execute("insert into users(email) values('mig@qa.test') returning id").fetchone()[0]
                    c.execute("insert into ai_agents(user_id,name) values(%s,'Old agent')", (uid,))
                    c.execute("insert into conversations(user_id,channel) values(%s,'Phone')", (uid,))
                migrate.bootstrap_schema()  # the upgrade
                migrate.bootstrap_schema()  # and again — must be a harmless no-op
                with psycopg.connect(mig_url) as c:
                    self.assertEqual(c.execute("select count(*) from ai_agents").fetchone()[0], 1)
                    self.assertEqual(c.execute("select count(*) from conversations").fetchone()[0], 1)
                    self.assertEqual(c.execute("select to_regclass('public.call_events') is not null").fetchone()[0], True)
                    self.assertEqual(c.execute("select to_regclass('public.call_event_library') is not null").fetchone()[0], True)
                    self.assertEqual(c.execute("select to_regclass('public.call_event_hits') is not null").fetchone()[0], True)
                    self.assertEqual(c.execute("select count(*) from information_schema.columns where column_name in ('call_outcome','events_tool_id')").fetchone()[0], 2)
        finally:
            with psycopg.connect(h.ADMIN_URL, autocommit=True) as c:
                c.execute(f"DROP DATABASE IF EXISTS {self.MIG_DB} WITH (FORCE)")

    def test_M03_foreign_key_behaviour(self):
        user = h.make_user()
        agent = h.sql("insert into ai_agents(user_id,name) values(%s,'FK') returning id", (user,))[0][0]
        ev = h.sql("insert into call_events(user_id,agent_id,event_key,label) values(%s,%s,'k','K') returning id", (user, agent))[0][0]
        h.sql("insert into call_event_hits(user_id,agent_id,event_id,vapi_call_id,event_key) values(%s,%s,%s,'c-fk','k')", (user, agent, ev))
        h.sql("delete from call_events where id=%s", (ev,))
        self.assertIsNone(h.sql("select event_id from call_event_hits where vapi_call_id='c-fk'")[0][0])
        h.sql("delete from users where id=%s", (user,))  # cascades everything owned by the user
        self.assertEqual(h.sql("select count(*) from call_event_hits where vapi_call_id='c-fk'")[0][0], 0)
        self.assertEqual(h.sql("select count(*) from call_events where agent_id=%s", (agent,))[0][0], 0)


if __name__ == "__main__":
    unittest.main()
