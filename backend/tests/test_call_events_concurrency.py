import unittest
from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient

import qa_harness as h
import main
from database import supabase
from services import call_events as ce

EVENTS = [{"label": "Callback Requested", "outcome": "Callback"}, {"label": "Do Not Call", "outcome": "DNC"}]


class Concurrency(unittest.TestCase):
    def setUp(self):
        h.reset_rate_limits()
        self.vapi = h.VapiMock().start()
        self.user = h.make_user()
        self.agent = h.create_agent_via_api(self.user, EVENTS)
        self.asst = self.agent["vapi_assistant_id"]

    def tearDown(self):
        self.vapi.stop()

    def test_K01_parallel_identical_retries_record_one_hit(self):
        call = f"call-{h.uuid.uuid4().hex[:8]}"
        body = h.tool_call_body(self.asst, call, [("same-tc", {"event": "do_not_call"})])

        def hit(_):
            return TestClient(main.app).post("/tools/internal/trigger-event", json=body).status_code

        with ThreadPoolExecutor(8) as ex:
            codes = list(ex.map(hit, range(8)))
        self.assertEqual(set(codes), {200})
        self.assertEqual(len(ce.get_hits(call)), 1)

    def test_K02_parallel_distinct_events_all_recorded(self):
        call = f"call-{h.uuid.uuid4().hex[:8]}"

        def hit(i):
            body = h.tool_call_body(self.asst, call, [(f"tc-{i}", {"event": "callback_requested"})])
            return TestClient(main.app).post("/tools/internal/trigger-event", json=body).status_code

        with ThreadPoolExecutor(10) as ex:
            codes = list(ex.map(hit, range(10)))
        self.assertEqual(set(codes), {200})
        self.assertEqual(len(ce.get_hits(call)), 10)

    def test_K03_parallel_saves_of_same_events_never_500_or_duplicate(self):
        def save(_):
            return TestClient(main.app).patch(
                f"/agents/{self.agent['id']}", json={"call_events": EVENTS}, headers=h.auth(self.user)).status_code

        with ThreadPoolExecutor(6) as ex:
            codes = list(ex.map(save, range(6)))
        self.assertTrue(all(c < 500 for c in codes), codes)
        keys = [e["event_key"] for e in ce.get_events(self.agent["id"])]
        self.assertEqual(sorted(keys), ["callback_requested", "do_not_call"])

    def test_K04_event_fired_during_edit_is_never_unknown(self):
        """An event that survives the edit must keep working while saves are in flight."""
        call = f"call-{h.uuid.uuid4().hex[:8]}"
        results = []

        def saver():
            for _ in range(15):
                TestClient(main.app).patch(f"/agents/{self.agent['id']}",
                                           json={"call_events": EVENTS + [{"label": "Extra"}]}, headers=h.auth(self.user))
                TestClient(main.app).patch(f"/agents/{self.agent['id']}",
                                           json={"call_events": EVENTS}, headers=h.auth(self.user))

        def firer(i):
            body = h.tool_call_body(self.asst, call, [(f"f-{i}", {"event": "do_not_call"})])
            r = TestClient(main.app).post("/tools/internal/trigger-event", json=body).json()
            results.append(r["results"][0]["result"])

        with ThreadPoolExecutor(6) as ex:
            f = ex.submit(saver)
            list(ex.map(firer, range(30)))
            f.result()
        unknown = [r for r in results if "Unknown" in r]
        self.assertEqual(unknown, [], f"{len(unknown)} of {len(results)} events were reported unknown mid-edit")


class DiffSemantics(unittest.TestCase):
    def setUp(self):
        self.user = h.make_user()
        self.agent = supabase.table("ai_agents").insert({"user_id": self.user, "name": "Diff"}).execute().data[0]

    def test_K10_surviving_event_keeps_id_and_history_link(self):
        ce.replace_events(self.user, self.agent["id"], ce.normalize_events([{"label": "Keep"}, {"label": "Drop"}]))
        keep_id = {e["event_key"]: e["id"] for e in ce.get_events(self.agent["id"])}["keep"]
        call = f"call-{h.uuid.uuid4().hex[:8]}"
        ce.record_hit(self.user, self.agent["id"], call, "keep", None)
        ce.replace_events(self.user, self.agent["id"], ce.normalize_events([{"label": "Keep", "outcome": "New outcome"}]))
        events = ce.get_events(self.agent["id"])
        self.assertEqual([(e["event_key"], e["id"], e["outcome"]) for e in events], [("keep", keep_id, "New outcome")])
        self.assertEqual(ce.get_hits(call)[0]["event_id"], keep_id)

    def test_K11_reorder_updates_positions(self):
        ce.replace_events(self.user, self.agent["id"], ce.normalize_events([{"label": "A"}, {"label": "B"}, {"label": "C"}]))
        ce.replace_events(self.user, self.agent["id"], ce.normalize_events([{"label": "C"}, {"label": "A"}, {"label": "B"}]))
        self.assertEqual([e["event_key"] for e in ce.get_events(self.agent["id"])], ["c", "a", "b"])

    def test_K12_idempotent_when_unchanged(self):
        ev = ce.normalize_events([{"label": "A"}, {"label": "B"}])
        ce.replace_events(self.user, self.agent["id"], ev)
        ids = [e["id"] for e in ce.get_events(self.agent["id"])]
        ce.replace_events(self.user, self.agent["id"], ev)
        self.assertEqual([e["id"] for e in ce.get_events(self.agent["id"])], ids)


if __name__ == "__main__":
    unittest.main()
