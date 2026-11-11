"""EN-103 and EN-104 on the agents API.

EN-103: an agent's call timeout (ai_agents.call_timeout_minutes) is validated (whole minutes, 1-60),
saved, and sent to the voice service as maxDurationSeconds on create, edit and sync; an agent
with none keeps the 10-minute default and its payload says so.
EN-104: GET /agents puts the phone numbers connected to each agent on it, only the caller's own.

The voice service is mocked (qa_harness.VapiMock) and the database is the scratch one.

Run from the backend folder:  python -m unittest discover -s tests -p test_agent_timeout_phone.py -v
"""
import unittest

import qa_harness as h
from qa_harness import client, auth
from database import supabase
from services import vapi_client as vc

PROMPT = "You are a receptionist."


class Base(unittest.TestCase):
    def setUp(self):
        h.reset_rate_limits()
        self.vapi = h.VapiMock().start()
        self.user = h.make_user()

    def tearDown(self):
        self.vapi.stop()

    def create(self, user=None, expect=200, **body):
        body = {"name": "Timeout Agent", "system_prompt": PROMPT, "first_message": "Hi", **body}
        r = client.post("/agents", json=body, headers=auth(user or self.user))
        self.assertEqual(r.status_code, expect, r.text)
        return r.json()["data"] if expect == 200 else r

    def edit(self, agent, expect=200, **body):
        r = client.patch(f"/agents/{agent['id']}", json=body, headers=auth(self.user))
        self.assertEqual(r.status_code, expect, r.text)
        return r

    def row(self, agent):
        return supabase.table("ai_agents").select("*").eq("id", agent["id"]).single().execute().data

    def created(self):
        return self.vapi.create_assistant.await_args.args[0]

    def patched(self):
        return self.vapi.update_assistant.await_args.args[1]


class CallTimeout(Base):
    def test_default_agent_is_sent_ten_minutes_and_stores_nothing(self):
        a = self.create()
        self.assertEqual(self.created()["maxDurationSeconds"], 600)
        self.assertIsNone(self.row(a)["call_timeout_minutes"])

    def test_a_chosen_timeout_is_saved_and_sent_in_seconds(self):
        a = self.create(call_timeout_minutes=25)
        self.assertEqual(self.row(a)["call_timeout_minutes"], 25)
        self.assertEqual(self.created()["maxDurationSeconds"], 1500)

    def test_the_ends_of_the_range_are_allowed(self):
        self.assertEqual(self.row(self.create(call_timeout_minutes=1))["call_timeout_minutes"], 1)
        self.assertEqual(self.created()["maxDurationSeconds"], 60)
        self.assertEqual(self.row(self.create(call_timeout_minutes=60))["call_timeout_minutes"], 60)
        self.assertEqual(self.created()["maxDurationSeconds"], 3600)

    def test_out_of_range_values_are_refused_and_nothing_is_created(self):
        for bad in (0, -5, 61, 500):
            before = self.vapi.create_assistant.await_count
            r = self.create(expect=400, call_timeout_minutes=bad)
            self.assertIn("between 1 and 60", r.json()["detail"], bad)
            self.assertEqual(self.vapi.create_assistant.await_count, before, bad)

    def test_edit_changes_the_stored_value_and_pushes_it_to_the_assistant(self):
        a = self.create(call_timeout_minutes=5)
        self.edit(a, call_timeout_minutes=30)
        self.assertEqual(self.row(a)["call_timeout_minutes"], 30)
        self.assertEqual(self.patched()["maxDurationSeconds"], 1800)

    def test_edit_to_an_invalid_value_is_refused_and_changes_nothing(self):
        a = self.create(call_timeout_minutes=5)
        self.vapi.update_assistant.reset_mock()
        for bad in (0, 61):
            r = self.edit(a, expect=400, call_timeout_minutes=bad)
            self.assertIn("between 1 and 60", r.json()["detail"])
        self.assertEqual(self.row(a)["call_timeout_minutes"], 5)
        self.vapi.update_assistant.assert_not_awaited()

    def test_an_edit_of_something_else_leaves_the_timeout_alone(self):
        a = self.create(call_timeout_minutes=20)
        self.edit(a, name="Renamed")
        self.assertEqual(self.row(a)["call_timeout_minutes"], 20)
        self.assertNotIn("maxDurationSeconds", self.patched())

    def test_an_agent_without_an_assistant_saves_the_value_and_sync_uses_it(self):
        # Created while the voice service is "not configured": no assistant yet.
        a = self.create(call_timeout_minutes=15)
        supabase.table("ai_agents").update({"vapi_assistant_id": None}).eq("id", a["id"]).execute()
        self.edit(a, call_timeout_minutes=45)
        self.assertEqual(self.row(a)["call_timeout_minutes"], 45)
        r = client.post(f"/agents/{a['id']}/sync-vapi", headers=auth(self.user))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.created()["maxDurationSeconds"], 2700)

    def test_sync_of_an_old_agent_with_no_value_uses_the_default(self):
        a = self.create()
        supabase.table("ai_agents").update({"vapi_assistant_id": None}).eq("id", a["id"]).execute()
        client.post(f"/agents/{a['id']}/sync-vapi", headers=auth(self.user))
        self.assertEqual(self.created()["maxDurationSeconds"], 600)

    def test_get_agent_returns_the_value(self):
        a = self.create(call_timeout_minutes=12)
        r = client.get(f"/agents/{a['id']}", headers=auth(self.user))
        self.assertEqual(r.json()["data"]["call_timeout_minutes"], 12)

    def test_the_helper_maps_minutes_to_seconds(self):
        self.assertEqual(vc.max_duration_seconds(None), 600)
        self.assertEqual(vc.max_duration_seconds(2), 120)


class AgentPhoneNumbers(Base):
    def number(self, user, number, agent=None, **extra):
        row = {"user_id": user, "number": number, **extra}
        if agent:
            row["agent_id"] = agent["id"]
        return supabase.table("phone_numbers").insert(row).execute().data[0]

    def listed(self, user=None):
        r = client.get("/agents", headers=auth(user or self.user))
        self.assertEqual(r.status_code, 200, r.text)
        return {a["id"]: a for a in r.json()["data"]}

    def test_every_agent_has_a_list_even_when_empty(self):
        a = self.create()
        self.assertEqual(self.listed()[a["id"]]["phone_numbers"], [])

    def test_a_connected_number_shows_on_its_agent_only(self):
        a, b = self.create(name="A"), self.create(name="B")
        n = self.number(self.user, "+15551230001", a, label="Main line")
        out = self.listed()
        self.assertEqual(out[a["id"]]["phone_numbers"], [{"id": n["id"], "number": "+15551230001", "label": "Main line"}])
        self.assertEqual(out[b["id"]]["phone_numbers"], [])

    def test_several_numbers_on_one_agent_come_in_number_order(self):
        a = self.create()
        self.number(self.user, "+15551230009", a)
        self.number(self.user, "+15551230002", a)
        self.assertEqual([p["number"] for p in self.listed()[a["id"]]["phone_numbers"]], ["+15551230002", "+15551230009"])

    def test_an_unassigned_number_shows_on_no_agent(self):
        a = self.create()
        self.number(self.user, "+15551230003")
        self.assertEqual(self.listed()[a["id"]]["phone_numbers"], [])

    def test_a_number_that_was_disconnected_disappears_from_the_card(self):
        a = self.create()
        n = self.number(self.user, "+15551230004", a)
        supabase.table("phone_numbers").update({"agent_id": None}).eq("id", n["id"]).execute()
        self.assertEqual(self.listed()[a["id"]]["phone_numbers"], [])

    def test_another_accounts_numbers_never_appear(self):
        other = h.make_user()
        a = self.create()
        theirs = self.create(user=other, name="Theirs")
        self.number(other, "+15551230005", theirs)
        mine = self.listed()
        self.assertEqual(mine[a["id"]]["phone_numbers"], [])
        self.assertNotIn(theirs["id"], mine)
        self.assertEqual([p["number"] for p in self.listed(other)[theirs["id"]]["phone_numbers"]], ["+15551230005"])

    def test_no_agents_means_an_empty_list(self):
        self.assertEqual(client.get("/agents", headers=auth(h.make_user())).json()["data"], [])


if __name__ == "__main__":
    unittest.main()
