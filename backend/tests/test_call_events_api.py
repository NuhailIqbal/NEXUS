import unittest
from unittest.mock import patch

import qa_harness as h
from qa_harness import client, auth
from database import supabase
from services import call_events as ce

EVENTS = [
    {"label": "Callback Requested", "description": "asks to be called back", "outcome": "Callback"},
    {"label": "Do Not Call", "description": "asks not to be contacted", "outcome": "Do Not Call"},
]


class Base(unittest.TestCase):
    def setUp(self):
        h.reset_rate_limits()
        self.vapi = h.VapiMock().start()
        self.user = h.make_user()

    def tearDown(self):
        self.vapi.stop()

    def agent(self, events=None, **kw):
        return h.create_agent_via_api(self.user, events, **kw)

    def assistant_payload(self, idx=-1):
        return self.vapi.create_assistant.await_args_list[idx].args[0]

    def events_of(self, agent_id):
        return [(e["event_key"], e["outcome"]) for e in ce.get_events(agent_id)]


class AgentCreate(Base):
    def test_G01_create_with_events(self):
        a = self.agent(EVENTS)
        self.assertEqual(self.events_of(a["id"]), [("callback_requested", "Callback"), ("do_not_call", "Do Not Call")])
        self.assertTrue(a["events_tool_id"])
        self.vapi.create_tool.assert_awaited_once()
        tool = self.vapi.create_tool.await_args.args[0]
        self.assertEqual(tool["function"]["parameters"]["properties"]["event"]["enum"],
                         ["callback_requested", "do_not_call"])
        payload = self.assistant_payload()
        self.assertIn(a["events_tool_id"], payload["model"]["toolIds"])
        sysmsg = payload["model"]["messages"][0]["content"]
        self.assertIn("trigger_event", sysmsg)
        self.assertIn("callback_requested", sysmsg)
        # The stored prompt must NOT contain the directive (it is added at sync time only).
        self.assertNotIn("trigger_event", a["system_prompt"])

    def test_G02_create_without_events_touches_nothing(self):
        a = self.agent(None)
        self.vapi.create_tool.assert_not_awaited()
        self.assertIsNone(a.get("events_tool_id"))
        self.assertNotIn("toolIds", self.assistant_payload()["model"])
        self.assertEqual(self.events_of(a["id"]), [])

    def test_G03_create_with_empty_list_touches_nothing(self):
        a = self.agent([])
        self.vapi.create_tool.assert_not_awaited()
        self.assertEqual(self.events_of(a["id"]), [])

    def test_G04_create_normalizes_and_dedupes(self):
        a = self.agent([{"label": "Interested"}, {"label": "interested "}])
        self.assertEqual(self.events_of(a["id"]), [("interested", "Interested")])

    def test_G04b_blank_event_name_is_rejected(self):
        r = client.post("/agents", json={"name": "Blank", "call_events": [{"label": "  "}]}, headers=auth(self.user))
        self.assertEqual(r.status_code, 422)

    def test_G05_events_tool_failure_returns_502_and_creates_no_agent(self):
        self.vapi.create_tool.side_effect = RuntimeError("vapi down")
        r = client.post("/agents", json={"name": "Fail Agent", "call_events": EVENTS}, headers=auth(self.user))
        self.assertEqual(r.status_code, 502)
        self.assertEqual(h.sql("select count(*) from ai_agents where user_id=%s", (self.user,))[0][0], 0)

    def test_G06_assistant_failure_cleans_up_events_tool(self):
        self.vapi.create_assistant.side_effect = RuntimeError("assistant boom")
        r = client.post("/agents", json={"name": "Fail Agent 2", "call_events": EVENTS}, headers=auth(self.user))
        self.assertEqual(r.status_code, 502)
        self.assertEqual(h.sql("select count(*) from ai_agents where user_id=%s", (self.user,))[0][0], 0)
        self.vapi.delete_tool.assert_awaited()  # no orphan tool left in VAPI

    def test_G07_invalid_payloads_rejected_with_422(self):
        for bad in ([{"description": "no label"}], "not-a-list", [123], {"label": "x"}):
            r = client.post("/agents", json={"name": "Bad", "call_events": bad}, headers=auth(self.user))
            self.assertEqual(r.status_code, 422, bad)

    def test_G08_create_without_public_url_saves_events_but_no_tool_or_directive(self):
        with patch.object(ce.settings, "public_api_url", ""), \
             patch("config.settings.public_api_url", ""):
            a = self.agent(EVENTS)
        self.assertEqual(len(self.events_of(a["id"])), 2)
        self.vapi.create_tool.assert_not_awaited()
        self.assertIsNone(a.get("events_tool_id"))
        payload = self.assistant_payload()
        self.assertNotIn("toolIds", payload["model"])
        self.assertNotIn("trigger_event", payload["model"]["messages"][0]["content"])

    def test_G09_requires_auth(self):
        r = client.post("/agents", json={"name": "x", "call_events": EVENTS})
        self.assertIn(r.status_code, (401, 403))


class AgentEventsList(Base):
    def test_G20_list_ordered_with_fields(self):
        a = self.agent(EVENTS)
        r = client.get(f"/agents/{a['id']}/events", headers=auth(self.user))
        self.assertEqual(r.status_code, 200)
        data = r.json()["data"]
        self.assertEqual([e["event_key"] for e in data], ["callback_requested", "do_not_call"])
        self.assertEqual(data[0]["description"], "asks to be called back")

    def test_G21_agent_without_events_returns_empty_list(self):
        a = self.agent(None)
        self.assertEqual(client.get(f"/agents/{a['id']}/events", headers=auth(self.user)).json()["data"], [])

    def test_G22_other_users_agent_is_404(self):
        a = self.agent(EVENTS)
        other = h.make_user()
        self.assertEqual(client.get(f"/agents/{a['id']}/events", headers=auth(other)).status_code, 404)

    def test_G23_unknown_agent_is_404(self):
        self.assertEqual(client.get(f"/agents/{h.uuid.uuid4()}/events", headers=auth(self.user)).status_code, 404)

    def test_G24_requires_auth(self):
        a = self.agent(EVENTS)
        self.assertIn(client.get(f"/agents/{a['id']}/events").status_code, (401, 403))

    def test_G25_get_agent_still_works_and_lists_events_tool_id(self):
        a = self.agent(EVENTS)
        r = client.get(f"/agents/{a['id']}", headers=auth(self.user))
        self.assertEqual(r.json()["data"]["events_tool_id"], a["events_tool_id"])


class AgentUpdate(Base):
    def patch_agent(self, agent_id, body, user=None):
        return client.patch(f"/agents/{agent_id}", json=body, headers=auth(user or self.user))

    def model_of_last_update(self):
        return self.vapi.update_assistant.await_args.args[1]["model"]

    def test_G30_add_events_to_agent_without_any(self):
        a = self.agent(None)
        r = self.patch_agent(a["id"], {"call_events": EVENTS})
        self.assertEqual(r.status_code, 200, r.text)
        self.vapi.create_tool.assert_awaited_once()
        tool_id = r.json()["data"]["events_tool_id"]
        self.assertTrue(tool_id)
        model = self.model_of_last_update()
        self.assertIn(tool_id, model["toolIds"])
        self.assertIn("trigger_event", model["messages"][0]["content"])
        self.assertEqual(len(self.events_of(a["id"])), 2)

    def test_G31_modify_events_updates_tool_in_place(self):
        a = self.agent(EVENTS)
        old_tool = a["events_tool_id"]
        self.vapi.create_tool.reset_mock()
        r = self.patch_agent(a["id"], {"call_events": [{"label": "Interested", "outcome": "Hot"}]})
        self.assertEqual(r.status_code, 200)
        self.vapi.create_tool.assert_not_awaited()
        tool_id, sent = self.vapi.update_tool.await_args.args
        self.assertEqual(tool_id, old_tool)
        self.assertNotIn("type", sent)
        self.assertEqual(sent["function"]["parameters"]["properties"]["event"]["enum"], ["interested"])
        self.assertEqual(self.events_of(a["id"]), [("interested", "Hot")])
        self.assertIn(old_tool, self.model_of_last_update()["toolIds"])

    def test_G32_clear_events_removes_tool_and_directive(self):
        a = self.agent(EVENTS)
        r = self.patch_agent(a["id"], {"call_events": []})
        self.assertEqual(r.status_code, 200)
        self.vapi.delete_tool.assert_awaited_once_with(a["events_tool_id"])
        model = self.model_of_last_update()
        self.assertNotIn("toolIds", model)
        self.assertNotIn("trigger_event", model["messages"][0]["content"])
        self.assertEqual(self.events_of(a["id"]), [])
        row = supabase.table("ai_agents").select("events_tool_id").eq("id", a["id"]).single().execute().data
        self.assertIsNone(row["events_tool_id"])

    def test_G33_clear_when_no_events_exist_is_harmless(self):
        a = self.agent(None)
        r = self.patch_agent(a["id"], {"call_events": []})
        self.assertEqual(r.status_code, 200)
        self.vapi.delete_tool.assert_not_awaited()

    def test_G34_unrelated_patch_leaves_events_and_tool_alone(self):
        a = self.agent(EVENTS)
        self.vapi.create_tool.reset_mock()
        r = self.patch_agent(a["id"], {"name": "Renamed"})
        self.assertEqual(r.status_code, 200)
        self.vapi.create_tool.assert_not_awaited()
        self.vapi.update_tool.assert_not_awaited()
        self.vapi.delete_tool.assert_not_awaited()
        self.assertEqual(len(self.events_of(a["id"])), 2)

    def test_G35_prompt_edit_keeps_events_tool_and_directive(self):
        a = self.agent(EVENTS)
        r = self.patch_agent(a["id"], {"system_prompt": "Brand new prompt"})
        self.assertEqual(r.status_code, 200)
        model = self.model_of_last_update()
        self.assertIn(a["events_tool_id"], model["toolIds"])
        content = model["messages"][0]["content"]
        self.assertIn("Brand new prompt", content)
        self.assertEqual(content.count("CALL EVENTS:"), 1)
        stored = supabase.table("ai_agents").select("system_prompt").eq("id", a["id"]).single().execute().data
        self.assertNotIn("trigger_event", stored["system_prompt"])

    def test_G36_prompt_edit_plus_events_change_in_one_request(self):
        a = self.agent(EVENTS)
        r = self.patch_agent(a["id"], {"system_prompt": "P2", "call_events": [{"label": "Interested"}]})
        self.assertEqual(r.status_code, 200)
        content = self.model_of_last_update()["messages"][0]["content"]
        self.assertIn("interested", content)
        self.assertNotIn("callback_requested", content)

    def test_G37_transfer_number_change_keeps_events_tool(self):
        a = self.agent(EVENTS)
        r = self.patch_agent(a["id"], {"transfer_number": "+15551234567"})
        self.assertEqual(r.status_code, 200, r.text)
        ids = self.model_of_last_update()["toolIds"]
        self.assertIn(a["events_tool_id"], ids)
        self.assertEqual(len(ids), 2)  # events tool + new transfer tool

    def test_G38_other_users_agent_cannot_be_edited(self):
        a = self.agent(EVENTS)
        other = h.make_user()
        r = self.patch_agent(a["id"], {"call_events": []}, user=other)
        self.assertEqual(r.status_code, 404)
        self.assertEqual(len(self.events_of(a["id"])), 2)

    def test_G39_agent_without_vapi_assistant_saves_events_only(self):
        row = supabase.table("ai_agents").insert({"user_id": self.user, "name": "No VAPI"}).execute().data[0]
        r = self.patch_agent(row["id"], {"call_events": EVENTS})
        self.assertEqual(r.status_code, 200, r.text)
        self.vapi.create_tool.assert_not_awaited()
        self.vapi.update_assistant.assert_not_awaited()
        self.assertEqual(len(self.events_of(row["id"])), 2)

    def test_G40_events_tool_error_on_update_returns_502_and_keeps_old_events(self):
        a = self.agent(EVENTS)
        self.vapi.update_tool.side_effect = RuntimeError("vapi down")
        r = self.patch_agent(a["id"], {"call_events": [{"label": "Interested"}]})
        self.assertEqual(r.status_code, 502)
        self.assertEqual(len(self.events_of(a["id"])), 2)  # DB not changed when VAPI failed

    def test_G41_invalid_call_events_rejected(self):
        a = self.agent(None)
        r = self.patch_agent(a["id"], {"call_events": [{"description": "no label"}]})
        self.assertEqual(r.status_code, 422)

    def test_G42_events_saved_before_public_url_heal_on_next_prompt_save(self):
        with patch("config.settings.public_api_url", ""):
            a = self.agent(EVENTS)
        self.assertIsNone(a.get("events_tool_id"))
        r = self.patch_agent(a["id"], {"system_prompt": "After URL configured"})
        self.assertEqual(r.status_code, 200)
        self.vapi.create_tool.assert_awaited_once()
        tool_id = r.json()["data"]["events_tool_id"]
        self.assertTrue(tool_id)
        self.assertIn(tool_id, self.model_of_last_update()["toolIds"])


class AgentSyncAndDelete(Base):
    def test_G50_sync_vapi_attaches_events_tool(self):
        row = supabase.table("ai_agents").insert({"user_id": self.user, "name": "Late Sync"}).execute().data[0]
        ce.replace_events(self.user, row["id"], ce.normalize_events(EVENTS))
        r = client.post(f"/agents/{row['id']}/sync-vapi", headers=auth(self.user))
        self.assertEqual(r.status_code, 200, r.text)
        payload = self.assistant_payload()
        tool_id = r.json()["data"]["events_tool_id"]
        self.assertTrue(tool_id)
        self.assertIn(tool_id, payload["model"]["toolIds"])
        self.assertIn("trigger_event", payload["model"]["messages"][0]["content"])

    def test_G51_delete_agent_removes_tool_and_events_but_keeps_history(self):
        a = self.agent(EVENTS)
        call = f"call-{h.uuid.uuid4().hex[:8]}"
        ce.record_hit(self.user, a["id"], call, "do_not_call", None)
        r = client.delete(f"/agents/{a['id']}", headers=auth(self.user))
        self.assertEqual(r.status_code, 200)
        self.vapi.delete_tool.assert_any_await(a["events_tool_id"])
        self.assertEqual(self.events_of(a["id"]), [])
        hit = ce.get_hits(call)[0]
        self.assertIsNone(hit["agent_id"])
        self.assertEqual(hit["outcome"], "Do Not Call")


class TeamRoles(Base):
    def make_member(self, role):
        member = h.make_user("member")
        supabase.table("team_members").insert({
            "owner_id": self.user, "member_user_id": member, "member_email": "m@qa.test",
            "role": role, "status": "Active",
        }).execute()
        return member

    def test_G60_viewer_can_read_but_not_change_events(self):
        a = self.agent(EVENTS)
        viewer = self.make_member("viewer")
        self.assertEqual(client.get(f"/agents/{a['id']}/events", headers=auth(viewer)).status_code, 200)
        r = client.patch(f"/agents/{a['id']}", json={"call_events": []}, headers=auth(viewer))
        self.assertEqual(r.status_code, 403)
        self.assertEqual(len(self.events_of(a["id"])), 2)

    def test_G61_member_can_edit_owners_events(self):
        a = self.agent(None)
        member = self.make_member("member")
        r = client.patch(f"/agents/{a['id']}", json={"call_events": EVENTS}, headers=auth(member))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(len(self.events_of(a["id"])), 2)

    def test_G62_member_cannot_delete_agent(self):
        a = self.agent(EVENTS)
        member = self.make_member("member")
        self.assertEqual(client.delete(f"/agents/{a['id']}", headers=auth(member)).status_code, 403)


class TriggerEventCallback(Base):
    def setUp(self):
        super().setUp()
        self.a = self.agent(EVENTS)
        self.call = f"call-{h.uuid.uuid4().hex[:8]}"

    def fire(self, calls, assistant=None, call=None):
        body = h.tool_call_body(assistant or self.a["vapi_assistant_id"], call or self.call, calls)
        return client.post("/tools/internal/trigger-event", json=body)

    def test_C01_valid_event_recorded(self):
        r = self.fire([("tc1", {"event": "callback_requested", "note": "tomorrow evening"})])
        self.assertEqual(r.status_code, 200)
        res = r.json()["results"]
        self.assertEqual(res[0]["toolCallId"], "tc1")
        self.assertIn("recorded", res[0]["result"])
        hit = ce.get_hits(self.call)[0]
        self.assertEqual((hit["event_key"], hit["outcome"], hit["note"], hit["user_id"], hit["agent_id"]),
                         ("callback_requested", "Callback", "tomorrow evening", self.user, self.a["id"]))

    def test_C02_unknown_event_reported_not_stored(self):
        res = self.fire([("tc1", {"event": "made_up"})]).json()["results"]
        self.assertIn("Unknown event", res[0]["result"])
        self.assertEqual(ce.get_hits(self.call), [])

    def test_C03_unknown_assistant_is_rejected(self):
        res = self.fire([("tc1", {"event": "do_not_call"})], assistant="asst-does-not-exist").json()["results"]
        self.assertIn("Error", res[0]["result"])
        self.assertEqual(ce.get_hits(self.call), [])

    def test_C04_missing_call_id_is_rejected(self):
        body = h.tool_call_body(self.a["vapi_assistant_id"], None, [("tc1", {"event": "do_not_call"})])
        del body["message"]["call"]["id"]
        res = client.post("/tools/internal/trigger-event", json=body).json()["results"]
        self.assertIn("Error", res[0]["result"])

    def test_C05_multiple_tool_calls_in_one_request(self):
        res = self.fire([("a", {"event": "callback_requested"}), ("b", {"event": "nope"}),
                         ("c", {"event": "do_not_call"})]).json()["results"]
        self.assertEqual([r["toolCallId"] for r in res], ["a", "b", "c"])
        self.assertEqual(len(ce.get_hits(self.call)), 2)

    def test_C06_arguments_as_json_string(self):
        r = self.fire([("tc1", '{"event": "do_not_call", "note": "x"}')])
        self.assertIn("recorded", r.json()["results"][0]["result"])

    def test_C07_arguments_invalid_json_string(self):
        res = self.fire([("tc1", "{not json")]).json()["results"]
        self.assertIn("Unknown event", res[0]["result"])

    def test_C08_malformed_body_returns_empty_results(self):
        r = client.post("/tools/internal/trigger-event", content=b"not json",
                        headers={"Content-Type": "application/json"})
        self.assertEqual((r.status_code, r.json()), (200, {"results": []}))

    def test_C09_no_tool_calls(self):
        for body in ({"message": {"call": {"id": "c", "assistantId": "a"}}},
                     {"message": {"call": {"id": "c", "assistantId": "a"}, "toolCalls": None}},
                     {"message": {"call": {"id": "c", "assistantId": "a"}, "toolCalls": []}}, {}):
            self.assertEqual(client.post("/tools/internal/trigger-event", json=body).json(), {"results": []})

    def test_C10_lenient_event_key_matching(self):
        res = self.fire([("a", {"event": "Callback Requested"}), ("b", {"event": " DO_NOT_CALL "})]).json()["results"]
        self.assertTrue(all("recorded" in r["result"] for r in res))

    def test_C11_cross_agent_isolation(self):
        other_user = h.make_user()
        other = h.create_agent_via_api(other_user, [{"label": "Secret Event"}], name="Other")
        res = self.fire([("tc", {"event": "secret_event"})]).json()["results"]
        self.assertIn("Unknown event", res[0]["result"])
        res2 = self.fire([("tc", {"event": "secret_event"})], assistant=other["vapi_assistant_id"]).json()["results"]
        self.assertIn("recorded", res2[0]["result"])
        self.assertEqual(ce.get_hits(self.call)[0]["user_id"], other_user)

    def test_C12_retry_same_tool_call_id_deduped(self):
        self.fire([("dup", {"event": "do_not_call"})])
        self.fire([("dup", {"event": "do_not_call"})])
        self.assertEqual(len(ce.get_hits(self.call)), 1)

    def test_C13_same_event_twice_distinct_calls_ids_recorded_twice(self):
        self.fire([("x1", {"event": "do_not_call"})])
        self.fire([("x2", {"event": "do_not_call"})])
        self.assertEqual(len(ce.get_hits(self.call)), 2)

    def test_C14_missing_or_empty_event_argument(self):
        for args in ({}, {"event": ""}, {"event": None}, {"note": "only note"}):
            res = self.fire([("t", args)]).json()["results"]
            self.assertIn("Unknown event", res[0]["result"])
        self.assertEqual(ce.get_hits(self.call), [])

    def test_C15_vapi_toolcalllist_shape(self):
        body = {"message": {"type": "tool-calls", "call": {"id": self.call, "assistantId": self.a["vapi_assistant_id"]},
                            "toolCallList": [{"id": "l1", "name": "trigger_event", "arguments": {"event": "do_not_call"}}]}}
        res = client.post("/tools/internal/trigger-event", json=body).json()["results"]
        self.assertIn("recorded", res[0]["result"])

    def test_C16_note_truncated_and_special_chars_verbatim(self):
        note = "<script>alert(1)</script> \"quoted\" 'single' ; DROP TABLE call_events;--" + "z" * 600
        self.fire([("t", {"event": "do_not_call", "note": note})])
        stored = ce.get_hits(self.call)[0]["note"]
        self.assertEqual(len(stored), 500)
        self.assertTrue(stored.startswith("<script>alert(1)</script>"))
        self.assertEqual(h.sql("select count(*) from call_events")[0][0] > 0, True)  # table still there

    def test_C17_sql_injection_in_event_key_is_inert(self):
        res = self.fire([("t", {"event": "'; DROP TABLE call_event_hits; --"})]).json()["results"]
        self.assertIn("Unknown event", res[0]["result"])
        self.assertEqual(h.sql("select to_regclass('public.call_event_hits') is not null")[0][0], True)

    def test_C18_non_dict_arguments(self):
        for args in (["list"], 5, True):
            res = self.fire([("t", args)]).json()["results"]
            self.assertIn("Unknown event", res[0]["result"])

    def test_C19_non_string_event_value(self):
        for ev in (123, ["a"], {"x": 1}):
            res = self.fire([("t", {"event": ev})]).json()["results"]
            self.assertIn("Unknown event", res[0]["result"])
        self.assertEqual(ce.get_hits(self.call), [])

    def test_C20_hit_uses_current_library_definition_after_edit(self):
        # The library is the source of truth: editing an event's outcome there changes
        # what later hits record (the name-based agent form never overwrites it).
        lib = client.get("/call-events", headers=auth(self.user)).json()["data"]
        dnc = next(e for e in lib if e["event_key"] == "do_not_call")
        r = client.patch(f"/call-events/{dnc['id']}", json={"outcome": "DNC-NEW"}, headers=auth(self.user))
        self.assertEqual(r.status_code, 200, r.text)
        self.fire([("t", {"event": "do_not_call"})])
        self.assertEqual(ce.get_hits(self.call)[0]["outcome"], "DNC-NEW")


if __name__ == "__main__":
    unittest.main()
