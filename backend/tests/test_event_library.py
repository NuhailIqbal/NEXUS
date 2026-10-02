import unittest
from unittest.mock import patch

import psycopg

import qa_harness as h
from qa_harness import client, auth
from database import supabase
from services import call_events as ce


class Base(unittest.TestCase):
    def setUp(self):
        h.reset_rate_limits()
        self.vapi = h.VapiMock().start()
        self.user = h.make_user()

    def tearDown(self):
        self.vapi.stop()

    def new_event(self, label="Interested", user=None, **kw):
        r = client.post("/call-events", json={"label": label, **kw}, headers=auth(user or self.user))
        return r

    def make(self, label="Interested", **kw):
        r = self.new_event(label, **kw)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["data"]

    def agent_with(self, event_ids, name="Lib Agent"):
        body = {"name": name, "system_prompt": "You are a bot.", "call_events": [{"event_id": i} for i in event_ids]}
        r = client.post("/agents", json=body, headers=auth(self.user))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["data"]

    def last_model(self):
        return self.vapi.update_assistant.await_args.args[1]["model"]


class LibraryCrud(Base):
    def test_L01_create_defaults_and_key(self):
        e = self.make("Callback Requested", description="asks later", outcome="Callback")
        self.assertEqual((e["event_key"], e["applies_to"], e["outcome"], e["agent_count"]),
                         ("callback_requested", "both", "Callback", 0))

    def test_L02_outcome_defaults_to_label(self):
        self.assertEqual(self.make("Interested")["outcome"], "Interested")

    def test_L03_applies_to_values_accepted(self):
        for v in ("inbound", "outbound", "both"):
            self.assertEqual(self.make(f"Evt {v}", applies_to=v)["applies_to"], v)

    def test_L04_invalid_applies_to_is_422(self):
        self.assertEqual(self.new_event("X", applies_to="sideways").status_code, 422)

    def test_L05_blank_or_missing_name_rejected(self):
        self.assertEqual(self.new_event("   ").status_code, 400)
        self.assertEqual(client.post("/call-events", json={}, headers=auth(self.user)).status_code, 422)

    def test_L06_duplicate_name_is_409(self):
        self.make("Do Not Call")
        r = self.new_event("do not call")
        self.assertEqual(r.status_code, 409)
        self.assertIn("already exists", r.json()["detail"])

    def test_L07_same_name_allowed_for_different_users(self):
        self.make("Do Not Call")
        other = h.make_user()
        self.assertEqual(self.new_event("Do Not Call", user=other).status_code, 200)

    def test_L08_urdu_name_gets_fallback_key(self):
        a, b = self.make("کال بیک"), self.make("نمبر غلط")
        self.assertRegex(a["event_key"], r"^event_\d+$")
        self.assertNotEqual(a["event_key"], b["event_key"])

    def test_L09_length_limits(self):
        e = self.make("L" * 300, description="d" * 900, outcome="o" * 300)
        self.assertLessEqual(len(e["label"]), 60)
        self.assertLessEqual(len(e["description"]), 200)
        self.assertLessEqual(len(e["outcome"]), 60)

    def test_L10_library_cap(self):
        rows = [{"user_id": self.user, "event_key": f"k{i}", "label": f"K{i}"} for i in range(ce.LIBRARY_MAX)]
        supabase.table("call_event_library").insert(rows).execute()
        r = self.new_event("One too many")
        self.assertEqual(r.status_code, 400)

    def test_L11_list_shows_usage_and_is_tenant_scoped(self):
        e1, e2 = self.make("Interested"), self.make("Do Not Call")
        a = self.agent_with([e1["id"]], "Sara")
        self.agent_with([e1["id"], e2["id"]], "Omar")
        data = {e["event_key"]: e for e in client.get("/call-events", headers=auth(self.user)).json()["data"]}
        self.assertEqual(data["interested"]["agent_count"], 2)
        self.assertEqual(sorted(x["name"] for x in data["interested"]["agents"]), ["Omar", "Sara"])
        self.assertEqual(data["do_not_call"]["agent_count"], 1)
        other = h.make_user()
        self.assertEqual(client.get("/call-events", headers=auth(other)).json()["data"], [])
        self.assertTrue(a["id"])

    def test_L12_requires_auth(self):
        self.assertIn(client.get("/call-events").status_code, (401, 403))
        self.assertIn(client.post("/call-events", json={"label": "x"}).status_code, (401, 403))

    def test_L13_other_users_event_is_404_for_edit_and_delete(self):
        e = self.make("Mine")
        other = h.make_user()
        self.assertEqual(client.patch(f"/call-events/{e['id']}", json={"label": "Hacked"}, headers=auth(other)).status_code, 404)
        self.assertEqual(client.delete(f"/call-events/{e['id']}", headers=auth(other)).status_code, 404)
        self.assertEqual(self.make("Still there")["label"], "Still there")
        self.assertEqual(ce.get_library_event(self.user, e["id"])["label"], "Mine")

    def test_L14_unknown_and_malformed_ids_are_404(self):
        for bad in (str(h.uuid.uuid4()), "not-a-uuid"):
            self.assertEqual(client.patch(f"/call-events/{bad}", json={"label": "x"}, headers=auth(self.user)).status_code, 404)
            self.assertEqual(client.delete(f"/call-events/{bad}", headers=auth(self.user)).status_code, 404)

    def test_L15_injection_in_fields_stored_literally(self):
        e = self.make("x'); DROP TABLE call_event_library;--", description="<script>1</script>")
        self.assertEqual(h.sql("select to_regclass('public.call_event_library') is not null")[0][0], True)
        self.assertEqual(e["description"], "<script>1</script>")


class LibraryEditPropagation(Base):
    def test_L20_edit_updates_library_and_agent_rows(self):
        e = self.make("Interested", description="old", outcome="Old")
        a = self.agent_with([e["id"]])
        r = client.patch(f"/call-events/{e['id']}", json={"outcome": "Hot Lead", "description": "new text"}, headers=auth(self.user))
        self.assertEqual(r.status_code, 200, r.text)
        row = ce.get_events(a["id"])[0]
        self.assertEqual((row["outcome"], row["description"], row["event_key"]), ("Hot Lead", "new text", "interested"))
        self.assertEqual(ce.get_library_event(self.user, e["id"])["outcome"], "Hot Lead")

    def test_L21_edit_resyncs_every_agent_prompt_in_vapi(self):
        e = self.make("Interested", description="old")
        a1, a2 = self.agent_with([e["id"]], "A1"), self.agent_with([e["id"]], "A2")
        self.vapi.update_assistant.reset_mock()
        r = client.patch(f"/call-events/{e['id']}", json={"description": "brand new wording"}, headers=auth(self.user))
        self.assertEqual(r.json()["warnings"], [])
        self.assertEqual(self.vapi.update_assistant.await_count, 2)
        called = {c.args[0] for c in self.vapi.update_assistant.await_args_list}
        self.assertEqual(called, {a1["vapi_assistant_id"], a2["vapi_assistant_id"]})
        self.assertIn("brand new wording", self.last_model()["messages"][0]["content"])

    def test_L22_key_is_immutable_when_renaming(self):
        e = self.make("Interested")
        client.patch(f"/call-events/{e['id']}", json={"label": "Very Interested"}, headers=auth(self.user))
        self.assertEqual(ce.get_library_event(self.user, e["id"])["event_key"], "interested")

    def test_L23_vapi_failure_is_a_warning_not_an_error(self):
        e = self.make("Interested")
        a = self.agent_with([e["id"]], "Fragile")
        self.vapi.update_assistant.side_effect = RuntimeError("vapi down")
        r = client.patch(f"/call-events/{e['id']}", json={"outcome": "Changed"}, headers=auth(self.user))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.json()["warnings"]), 1)
        self.assertIn("Fragile", r.json()["warnings"][0])
        self.assertEqual(ce.get_events(a["id"])[0]["outcome"], "Changed")  # DB still updated

    def test_L24_edit_with_no_fields_is_harmless(self):
        e = self.make("Interested")
        r = client.patch(f"/call-events/{e['id']}", json={}, headers=auth(self.user))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(ce.get_library_event(self.user, e["id"])["label"], "Interested")

    def test_L25_edit_blank_name_rejected(self):
        e = self.make("Interested")
        self.assertEqual(client.patch(f"/call-events/{e['id']}", json={"label": "  "}, headers=auth(self.user)).status_code, 400)

    def test_L26_edit_to_invalid_scope_rejected(self):
        e = self.make("Interested")
        self.assertEqual(client.patch(f"/call-events/{e['id']}", json={"applies_to": "nope"}, headers=auth(self.user)).status_code, 422)

    def test_L27_edit_unused_event_makes_no_vapi_calls(self):
        e = self.make("Interested")
        client.patch(f"/call-events/{e['id']}", json={"outcome": "X"}, headers=auth(self.user))
        self.vapi.update_assistant.assert_not_awaited()


class LibraryDelete(Base):
    def test_L30_delete_removes_from_agents_and_resyncs(self):
        keep, drop = self.make("Interested"), self.make("Do Not Call")
        a = self.agent_with([keep["id"], drop["id"]])
        self.vapi.update_tool.reset_mock()
        r = client.delete(f"/call-events/{drop['id']}", headers=auth(self.user))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["data"]["removed_from_agents"], 1)
        self.assertEqual([e["event_key"] for e in ce.get_events(a["id"])], ["interested"])
        sent = self.vapi.update_tool.await_args.args[1]
        self.assertEqual(sent["function"]["parameters"]["properties"]["event"]["enum"], ["interested"])
        self.assertIsNone(ce.get_library_event(self.user, drop["id"]))

    def test_L31_deleting_last_event_removes_the_vapi_tool(self):
        e = self.make("Interested")
        a = self.agent_with([e["id"]])
        tool = a["events_tool_id"]
        client.delete(f"/call-events/{e['id']}", headers=auth(self.user))
        self.vapi.delete_tool.assert_awaited_with(tool)
        self.assertNotIn("toolIds", self.last_model())
        row = supabase.table("ai_agents").select("events_tool_id").eq("id", a["id"]).single().execute().data
        self.assertIsNone(row["events_tool_id"])

    def test_L32_delete_keeps_call_history(self):
        e = self.make("Do Not Call", outcome="DNC")
        a = self.agent_with([e["id"]])
        call = f"call-{h.uuid.uuid4().hex[:8]}"
        ce.record_hit(self.user, a["id"], call, "do_not_call", None)
        client.delete(f"/call-events/{e['id']}", headers=auth(self.user))
        hit = ce.get_hits(call)[0]
        self.assertEqual((hit["outcome"], hit["label"]), ("DNC", "Do Not Call"))
        self.assertIsNone(hit["event_id"])

    def test_L33_delete_unused_event(self):
        e = self.make("Lonely")
        r = client.delete(f"/call-events/{e['id']}", headers=auth(self.user))
        self.assertEqual(r.json()["data"]["removed_from_agents"], 0)
        self.vapi.delete_tool.assert_not_awaited()

    def test_L34_vapi_failure_on_delete_is_a_warning(self):
        e = self.make("Interested")
        self.agent_with([e["id"]], "Fragile")
        self.vapi.update_assistant.side_effect = RuntimeError("vapi down")
        self.vapi.delete_tool.side_effect = RuntimeError("vapi down")
        r = client.delete(f"/call-events/{e['id']}", headers=auth(self.user))
        self.assertEqual(r.status_code, 200)
        self.assertIsNone(ce.get_library_event(self.user, e["id"]))

    def test_L35_deleted_event_can_be_recreated(self):
        e = self.make("Interested")
        client.delete(f"/call-events/{e['id']}", headers=auth(self.user))
        self.assertEqual(self.new_event("Interested").status_code, 200)


class AgentUsesLibrary(Base):
    def test_A01_create_agent_from_library_ids(self):
        e1, e2 = self.make("Interested", outcome="Hot"), self.make("Do Not Call", applies_to="outbound")
        a = self.agent_with([e1["id"], e2["id"]])
        rows = {r["event_key"]: r for r in ce.get_events(a["id"])}
        self.assertEqual(rows["interested"]["library_event_id"], e1["id"])
        self.assertEqual((rows["do_not_call"]["applies_to"], rows["interested"]["outcome"]), ("outbound", "Hot"))
        self.assertTrue(a["events_tool_id"])

    def test_A02_foreign_or_unknown_event_id_is_rejected(self):
        other = h.make_user()
        foreign = self.new_event("Theirs", user=other).json()["data"]
        for bad in (foreign["id"], str(h.uuid.uuid4()), "junk"):
            r = client.post("/agents", json={"name": "Nope", "call_events": [{"event_id": bad}]}, headers=auth(self.user))
            self.assertEqual(r.status_code, 404, bad)
        self.assertEqual(h.sql("select count(*) from ai_agents where user_id=%s", (self.user,))[0][0], 0)

    def test_A03_name_form_reuses_existing_library_event_without_overwriting(self):
        e = self.make("Interested", outcome="Hot Lead", description="keep me")
        a = h.create_agent_via_api(self.user, [{"label": "Interested", "outcome": "SOMETHING ELSE"}])
        row = ce.get_events(a["id"])[0]
        self.assertEqual((row["outcome"], row["description"], row["library_event_id"]), ("Hot Lead", "keep me", e["id"]))
        self.assertEqual(len(client.get("/call-events", headers=auth(self.user)).json()["data"]), 1)

    def test_A04_name_form_creates_library_event_when_missing(self):
        h.create_agent_via_api(self.user, [{"label": "Brand New", "outcome": "BN", "applies_to": "inbound"}])
        lib = client.get("/call-events", headers=auth(self.user)).json()["data"]
        self.assertEqual([(e["event_key"], e["outcome"], e["applies_to"]) for e in lib], [("brand_new", "BN", "inbound")])

    def test_A05_duplicates_and_mixed_forms_collapse(self):
        e = self.make("Interested")
        a = h.create_agent_via_api(self.user, [{"event_id": e["id"]}, {"event_id": e["id"]}, {"label": "Interested"}])
        self.assertEqual(len(ce.get_events(a["id"])), 1)

    def test_A06_update_agent_selection_via_ids(self):
        e1, e2 = self.make("Interested"), self.make("Do Not Call")
        a = self.agent_with([e1["id"]])
        r = client.patch(f"/agents/{a['id']}", json={"call_events": [{"event_id": e2["id"]}]}, headers=auth(self.user))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([x["event_key"] for x in ce.get_events(a["id"])], ["do_not_call"])
        self.assertEqual(client.get("/call-events", headers=auth(self.user)).json()["data"][0]["agent_count"], 0)

    def test_A07_update_agent_with_foreign_id_is_rejected_and_changes_nothing(self):
        e1 = self.make("Interested")
        a = self.agent_with([e1["id"]])
        other = h.make_user()
        foreign = self.new_event("Theirs", user=other).json()["data"]
        r = client.patch(f"/agents/{a['id']}", json={"call_events": [{"event_id": foreign["id"]}]}, headers=auth(self.user))
        self.assertEqual(r.status_code, 404)
        self.assertEqual([x["event_key"] for x in ce.get_events(a["id"])], ["interested"])

    def test_A08_agents_list_events_endpoint_exposes_link_and_scope(self):
        e = self.make("Interested", applies_to="inbound")
        a = self.agent_with([e["id"]])
        row = client.get(f"/agents/{a['id']}/events", headers=auth(self.user)).json()["data"][0]
        self.assertEqual((row["library_event_id"], row["applies_to"]), (e["id"], "inbound"))

    def test_A09_one_event_shared_by_many_agents_and_each_agent_keeps_own_selection(self):
        e1, e2 = self.make("Interested"), self.make("Do Not Call")
        a1, a2 = self.agent_with([e1["id"], e2["id"]], "A1"), self.agent_with([e1["id"]], "A2")
        self.assertEqual(len(ce.get_events(a1["id"])), 2)
        self.assertEqual(len(ce.get_events(a2["id"])), 1)

    def test_A10_directive_mentions_scope(self):
        e = self.make("Do Not Call", applies_to="inbound")
        self.agent_with([e["id"]])
        prompt = self.vapi.create_assistant.await_args.args[0]["model"]["messages"][0]["content"]
        self.assertIn("(inbound calls only)", prompt)

    def test_A11_agent_cap_of_20(self):
        ids = [self.make(f"E{i}")["id"] for i in range(25)]
        a = self.agent_with(ids)
        self.assertEqual(len(ce.get_events(a["id"])), ce.MAX_EVENTS_PER_AGENT)


class Scope(Base):
    """applies_to is enforced when an event fires, based on VAPI's call type."""

    def setUp(self):
        super().setUp()
        self.inb = self.make("Inbound Only", applies_to="inbound")
        self.out = self.make("Outbound Only", applies_to="outbound")
        self.both = self.make("Either Way", applies_to="both")
        self.agent = self.agent_with([self.inb["id"], self.out["id"], self.both["id"]])
        self.call = f"call-{h.uuid.uuid4().hex[:8]}"

    def fire(self, key, call_type, tcid=None):
        body = h.tool_call_body(self.agent["vapi_assistant_id"], self.call, [(tcid or f"t-{h.uuid.uuid4().hex[:6]}", {"event": key})])
        body["message"]["call"]["type"] = call_type
        return client.post("/tools/internal/trigger-event", json=body).json()["results"][0]["result"]

    def hits(self):
        return [x["event_key"] for x in ce.get_hits(self.call)]

    def test_S01_inbound_event_on_inbound_call_is_recorded(self):
        self.assertIn("recorded", self.fire("inbound_only", "inboundPhoneCall"))
        self.assertEqual(self.hits(), ["inbound_only"])

    def test_S02_inbound_event_on_outbound_call_is_ignored(self):
        res = self.fire("inbound_only", "outboundPhoneCall")
        self.assertIn("not enabled for this type of call", res)
        self.assertEqual(self.hits(), [])

    def test_S03_outbound_event_on_outbound_call_is_recorded(self):
        self.assertIn("recorded", self.fire("outbound_only", "outboundPhoneCall"))

    def test_S04_outbound_event_on_inbound_call_is_ignored(self):
        self.assertIn("not enabled", self.fire("outbound_only", "inboundPhoneCall"))
        self.assertEqual(self.hits(), [])

    def test_S05_both_fires_everywhere(self):
        for t in ("inboundPhoneCall", "outboundPhoneCall", "webCall"):
            self.assertIn("recorded", self.fire("either_way", t, tcid=f"x-{t}"))
        self.assertEqual(len(self.hits()), 3)

    def test_S06_web_calls_and_unknown_types_are_never_blocked(self):
        self.assertIn("recorded", self.fire("inbound_only", "webCall", "w1"))
        self.assertIn("recorded", self.fire("outbound_only", "webCall", "w2"))
        self.assertIn("recorded", self.fire("inbound_only", None, "w3"))
        self.assertIn("recorded", self.fire("outbound_only", "somethingNew", "w4"))

    def test_S07_scope_is_case_insensitive_on_call_type(self):
        self.assertIn("not enabled", self.fire("inbound_only", "OUTBOUNDPHONECALL"))

    def test_S08_changing_scope_in_library_takes_effect_immediately(self):
        self.assertIn("recorded", self.fire("either_way", "inboundPhoneCall", "a"))
        client.patch(f"/call-events/{self.both['id']}", json={"applies_to": "outbound"}, headers=auth(self.user))
        self.assertIn("not enabled", self.fire("either_way", "inboundPhoneCall", "b"))
        self.assertEqual(len(self.hits()), 1)

    def test_S09_skipped_events_do_not_set_the_call_outcome(self):
        conv = h.make_conversation(self.user, self.call, self.agent["id"])
        self.fire("inbound_only", "outboundPhoneCall")
        self.fire("either_way", "outboundPhoneCall")
        ce.finalize_call_events(self.call, conv["id"])
        self.assertEqual(h.sql("select call_outcome from conversations where id=%s", (conv["id"],))[0][0], "Either Way")

    def test_S10_event_applies_unit(self):
        self.assertTrue(ce.event_applies("both", "inboundPhoneCall"))
        self.assertTrue(ce.event_applies(None, "outboundPhoneCall"))
        self.assertFalse(ce.event_applies("inbound", "outboundPhoneCall"))
        self.assertFalse(ce.event_applies("outbound", "inboundPhoneCall"))


class TeamRolesLibrary(Base):
    def member(self, role):
        m = h.make_user("m")
        supabase.table("team_members").insert({"owner_id": self.user, "member_user_id": m, "member_email": "m@qa.test",
                                               "role": role, "status": "Active"}).execute()
        return m

    def test_T01_viewer_reads_but_cannot_write(self):
        e = self.make("Interested")
        v = self.member("viewer")
        self.assertEqual(len(client.get("/call-events", headers=auth(v)).json()["data"]), 1)
        self.assertEqual(self.new_event("Nope", user=v).status_code, 403)
        self.assertEqual(client.patch(f"/call-events/{e['id']}", json={"label": "x"}, headers=auth(v)).status_code, 403)

    def test_T02_member_can_create_and_edit_but_not_delete(self):
        m = self.member("member")
        r = self.new_event("By Member", user=m)
        self.assertEqual(r.status_code, 200)
        eid = r.json()["data"]["id"]
        self.assertEqual(client.patch(f"/call-events/{eid}", json={"outcome": "Y"}, headers=auth(m)).status_code, 200)
        self.assertEqual(client.delete(f"/call-events/{eid}", headers=auth(m)).status_code, 403)
        self.assertIsNotNone(ce.get_library_event(self.user, eid))  # owned by the account owner


class LibraryMigration(unittest.TestCase):
    DB = "nexus_qa_callevents_lib"

    def test_M10_backfill_links_legacy_events_and_is_idempotent(self):
        import migrate
        from types import SimpleNamespace
        from urllib.parse import urlparse, urlunparse
        url = urlunparse(urlparse(h.QA_URL)._replace(path=f"/{self.DB}"))
        with psycopg.connect(h.ADMIN_URL, autocommit=True) as c:
            c.execute(f"DROP DATABASE IF EXISTS {self.DB} WITH (FORCE)")
            c.execute(f"CREATE DATABASE {self.DB}")
        try:
            with patch.object(migrate, "settings", SimpleNamespace(database_url=url)):
                migrate.bootstrap_schema()
                with psycopg.connect(url, autocommit=True) as c:
                    # Simulate pre-library data: unlinked agent rows, incl. two users with the same key.
                    u1 = c.execute("insert into users(email) values('a@qa.test') returning id").fetchone()[0]
                    u2 = c.execute("insert into users(email) values('b@qa.test') returning id").fetchone()[0]
                    a1 = c.execute("insert into ai_agents(user_id,name) values(%s,'A1') returning id", (u1,)).fetchone()[0]
                    a2 = c.execute("insert into ai_agents(user_id,name) values(%s,'A2') returning id", (u1,)).fetchone()[0]
                    a3 = c.execute("insert into ai_agents(user_id,name) values(%s,'A3') returning id", (u2,)).fetchone()[0]
                    for uid, aid in ((u1, a1), (u1, a2), (u2, a3)):
                        c.execute("insert into call_events(user_id,agent_id,event_key,label,outcome) values(%s,%s,'interested','Interested','Hot')", (uid, aid))
                migrate.bootstrap_schema()
                migrate.bootstrap_schema()  # second run must change nothing
                with psycopg.connect(url) as c:
                    self.assertEqual(c.execute("select count(*) from call_event_library").fetchone()[0], 2)
                    self.assertEqual(c.execute("select count(*) from call_events where library_event_id is null").fetchone()[0], 0)
                    self.assertEqual(c.execute("select count(distinct library_event_id) from call_events where user_id=%s", (u1,)).fetchone()[0], 1)
                    self.assertEqual(c.execute("select applies_to from call_event_library limit 1").fetchone()[0], "both")
        finally:
            with psycopg.connect(h.ADMIN_URL, autocommit=True) as c:
                c.execute(f"DROP DATABASE IF EXISTS {self.DB} WITH (FORCE)")

    def test_M11_scope_check_constraint(self):
        u = h.make_user()
        with self.assertRaises(Exception):
            h.sql("insert into call_event_library(user_id,event_key,label,applies_to) values(%s,'k','K','sideways')", (u,))

    def test_M12_deleting_library_row_cascades_to_agent_rows(self):
        u = h.make_user()
        ev = h.sql("insert into call_event_library(user_id,event_key,label) values(%s,'k','K') returning id", (u,))[0][0]
        ag = h.sql("insert into ai_agents(user_id,name) values(%s,'X') returning id", (u,))[0][0]
        h.sql("insert into call_events(user_id,agent_id,event_key,label,library_event_id) values(%s,%s,'k','K',%s)", (u, ag, ev))
        h.sql("delete from call_event_library where id=%s", (ev,))
        self.assertEqual(h.sql("select count(*) from call_events where agent_id=%s", (ag,))[0][0], 0)


if __name__ == "__main__":
    unittest.main()
