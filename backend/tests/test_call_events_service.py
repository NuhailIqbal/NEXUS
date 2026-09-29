import asyncio
import json
import time
import unittest
from unittest.mock import patch

import qa_harness as h
from database import supabase
from services import call_events as ce
from services import vapi_client


def run(coro):
    return asyncio.run(coro)


def seed_agent(user_id, events=None, assistant_id=None):
    row = supabase.table("ai_agents").insert({
        "user_id": user_id, "name": "Svc Agent",
        "vapi_assistant_id": assistant_id or f"asst-{h.uuid.uuid4().hex[:8]}",
    }).execute().data[0]
    if events:
        ce.replace_events(user_id, row["id"], ce.normalize_events(events))
    return row


class NormalizeEvents(unittest.TestCase):
    def test_U01_slug_and_outcome_default(self):
        out = ce.normalize_events([{"label": " Callback Requested ", "description": " asks later "}])
        self.assertEqual(out[0]["event_key"], "callback_requested")
        self.assertEqual(out[0]["label"], "Callback Requested")
        self.assertEqual(out[0]["description"], "asks later")
        self.assertEqual(out[0]["outcome"], "Callback Requested")  # defaults to the label

    def test_U02_dedupe_including_slug_collisions(self):
        out = ce.normalize_events([{"label": "Do Not Call"}, {"label": "do-not-call"},
                                   {"label": "DO NOT CALL!!"}])
        self.assertEqual([e["event_key"] for e in out], ["do_not_call"])

    def test_U03_blank_and_none_inputs(self):
        self.assertEqual(ce.normalize_events(None), [])
        self.assertEqual(ce.normalize_events([]), [])
        self.assertEqual(ce.normalize_events([{"label": "   "}, {"label": ""}, {}]), [])

    def test_U04_non_latin_label_is_kept_with_fallback_key(self):
        # The product supports Urdu agents — an Urdu event name must not vanish silently.
        out = ce.normalize_events([{"label": "کال بیک"}, {"label": "!!!"}])
        self.assertEqual(len(out), 2)
        for e in out:
            self.assertRegex(e["event_key"], r"^[a-z0-9_]+$")
        self.assertEqual(len({e["event_key"] for e in out}), 2)

    def test_U05_cap_at_20(self):
        out = ce.normalize_events([{"label": f"Event {i}"} for i in range(35)])
        self.assertEqual(len(out), ce.MAX_EVENTS_PER_AGENT)

    def test_U06_field_length_limits(self):
        out = ce.normalize_events([{"label": "L" * 500, "description": "d" * 5000, "outcome": "o" * 500}])
        self.assertLessEqual(len(out[0]["label"]), 60)
        self.assertLessEqual(len(out[0]["description"]), 200)
        self.assertLessEqual(len(out[0]["outcome"]), 60)
        self.assertLessEqual(len(out[0]["event_key"]), 60)

    def test_U07_positions_are_sequential_after_drops(self):
        out = ce.normalize_events([{"label": "A"}, {"label": ""}, {"label": "B"}])
        self.assertEqual([e["position"] for e in out], [0, 1])


class ToolPayloadAndPrompt(unittest.TestCase):
    def setUp(self):
        self.events = ce.normalize_events([
            {"label": "Callback Requested", "description": "asks to be called back"},
            {"label": "Do Not Call", "description": "asks not to be contacted"},
        ])

    def test_U10_payload_shape(self):
        p = ce.tool_payload("Sara", self.events)
        self.assertEqual(p["type"], "function")
        self.assertEqual(p["function"]["name"], "trigger_event")
        prop = p["function"]["parameters"]["properties"]["event"]
        self.assertEqual(prop["enum"], ["callback_requested", "do_not_call"])
        self.assertEqual(p["function"]["parameters"]["required"], ["event"])
        self.assertEqual(p["server"]["url"], "https://qa.example.test/tools/internal/trigger-event")

    def test_U11_payload_descriptions_stay_small_with_20_max_events(self):
        big = ce.normalize_events([{"label": f"Event number {i}", "description": "x" * 999} for i in range(25)])
        p = ce.tool_payload("Sara", big)
        self.assertLess(len(p["function"]["description"]), 500)
        self.assertLess(len(json.dumps(p["function"]["parameters"])), 2500)

    def test_U12_prompt_directive(self):
        self.assertEqual(ce.prompt_directive([]), "")
        d = ce.prompt_directive(self.events)
        self.assertIn("trigger_event", d)
        self.assertIn("callback_requested", d)
        self.assertIn("asks not to be contacted", d)


class SyncEventsTool(unittest.TestCase):
    def setUp(self):
        self.vapi = h.VapiMock().start()
        self.events = ce.normalize_events([{"label": "Interested"}])

    def tearDown(self):
        self.vapi.stop()

    def test_U20_create_returns_id(self):
        tid = run(ce.sync_events_tool("A", self.events, None))
        self.assertTrue(tid.startswith("tool-"))
        self.vapi.create_tool.assert_awaited_once()

    def test_U21_update_strips_type_and_keeps_id(self):
        tid = run(ce.sync_events_tool("A", self.events, "tool-existing"))
        self.assertEqual(tid, "tool-existing")
        sent = self.vapi.update_tool.await_args.args[1]
        self.assertNotIn("type", sent)
        self.vapi.create_tool.assert_not_awaited()

    def test_U22_empty_events_deletes_existing_tool(self):
        self.assertIsNone(run(ce.sync_events_tool("A", [], "tool-existing")))
        self.vapi.delete_tool.assert_awaited_once_with("tool-existing")

    def test_U23_empty_events_no_tool_is_noop(self):
        self.assertIsNone(run(ce.sync_events_tool("A", [], None)))
        self.vapi.delete_tool.assert_not_awaited()

    def test_U24_delete_failure_is_swallowed(self):
        self.vapi.delete_tool.side_effect = RuntimeError("vapi down")
        self.assertIsNone(run(ce.sync_events_tool("A", [], "tool-existing")))

    def test_U25_create_failure_propagates(self):
        self.vapi.create_tool.side_effect = RuntimeError("vapi 500")
        with self.assertRaises(RuntimeError):
            run(ce.sync_events_tool("A", self.events, None))

    def test_U26_update_failure_propagates(self):
        self.vapi.update_tool.side_effect = RuntimeError("vapi 500")
        with self.assertRaises(RuntimeError):
            run(ce.sync_events_tool("A", self.events, "tool-existing"))

    def test_U27_without_public_url_no_vapi_calls_and_no_tool(self):
        with patch.object(ce.settings, "public_api_url", ""):
            self.assertIsNone(run(ce.sync_events_tool("A", self.events, None)))
            self.assertEqual(run(ce.sync_events_tool("A", self.events, "tool-keep")), "tool-keep")
        self.vapi.create_tool.assert_not_awaited()
        self.vapi.update_tool.assert_not_awaited()


class RecordAndFinalize(unittest.TestCase):
    def setUp(self):
        self.user = h.make_user()
        self.agent = seed_agent(self.user, [{"label": "Interested", "outcome": "Interested"},
                                            {"label": "Callback Requested", "outcome": "Callback"},
                                            {"label": "Do Not Call", "outcome": "Do Not Call"}])
        self.call = f"call-{h.uuid.uuid4().hex[:8]}"

    def hit(self, key, note=None, tool_call_id=None):
        return ce.record_hit(self.user, self.agent["id"], self.call, key, note, tool_call_id)

    def test_U30_unknown_key_returns_none_and_writes_nothing(self):
        self.assertIsNone(self.hit("nope"))
        self.assertEqual(ce.get_hits(self.call), [])

    def test_U31_known_key_copies_label_and_outcome(self):
        d = self.hit("callback_requested", "tomorrow")
        self.assertEqual(d["event_key"], "callback_requested")
        row = ce.get_hits(self.call)[0]
        self.assertEqual((row["label"], row["outcome"], row["note"]), ("Callback Requested", "Callback", "tomorrow"))
        self.assertEqual(row["user_id"], self.user)

    def test_U32_note_truncated_to_500(self):
        self.hit("interested", "n" * 900)
        self.assertEqual(len(ce.get_hits(self.call)[0]["note"]), 500)

    def test_U33_empty_note_stored_as_null(self):
        self.hit("interested", "   ")
        self.assertIsNone(ce.get_hits(self.call)[0]["note"] or None)

    def test_U34_retry_with_same_tool_call_id_is_deduped(self):
        self.hit("interested", None, "tc-1")
        self.hit("interested", None, "tc-1")
        self.assertEqual(len(ce.get_hits(self.call)), 1)

    def test_U35_same_event_different_tool_call_ids_both_recorded(self):
        self.hit("interested", None, "tc-1")
        self.hit("interested", None, "tc-2")
        self.assertEqual(len(ce.get_hits(self.call)), 2)

    def test_U36_key_matching_is_forgiving(self):
        self.assertIsNotNone(self.hit("Callback Requested"))
        self.assertIsNotNone(self.hit("CALLBACK_REQUESTED"))
        self.assertIsNotNone(self.hit(" do-not-call "))
        self.assertEqual(len(ce.get_hits(self.call)), 3)

    def test_U40_finalize_no_hits_leaves_outcome_untouched(self):
        conv = h.make_conversation(self.user, self.call, call_outcome="Preset")
        self.assertEqual(ce.finalize_call_events(self.call, conv["id"]), [])
        self.assertEqual(h.sql("select call_outcome from conversations where id=%s", (conv["id"],))[0][0], "Preset")

    def test_U41_finalize_last_hit_wins_and_links_hits(self):
        conv = h.make_conversation(self.user, self.call)
        self.hit("interested", None, "a")
        time.sleep(0.02)
        self.hit("callback_requested", None, "b")
        hits = ce.finalize_call_events(self.call, conv["id"])
        self.assertEqual(len(hits), 2)
        self.assertEqual(h.sql("select call_outcome from conversations where id=%s", (conv["id"],))[0][0], "Callback")
        self.assertEqual(h.sql("select count(*) from call_event_hits where conversation_id=%s", (conv["id"],))[0][0], 2)

    def test_U42_finalize_is_idempotent(self):
        conv = h.make_conversation(self.user, self.call)
        self.hit("interested")
        ce.finalize_call_events(self.call, conv["id"])
        ce.finalize_call_events(self.call, conv["id"])
        self.assertEqual(h.sql("select call_outcome from conversations where id=%s", (conv["id"],))[0][0], "Interested")
        self.assertEqual(len(ce.get_hits(self.call)), 1)

    def test_U43_finalize_without_ids_is_safe(self):
        self.assertEqual(ce.finalize_call_events("", "x"), [])
        self.assertEqual(ce.finalize_call_events(self.call, None), [])

    def test_U44_finalize_swallows_db_errors(self):
        with patch.object(ce, "get_hits", side_effect=RuntimeError("db down")):
            self.assertEqual(ce.finalize_call_events(self.call, "some-id"), [])

    def test_U45_ties_on_identical_timestamps_still_pick_a_deterministic_last(self):
        conv = h.make_conversation(self.user, self.call)
        self.hit("interested", None, "a")
        self.hit("do_not_call", None, "b")
        h.sql("update call_event_hits set created_at = now() where vapi_call_id=%s", (self.call,))
        ce.finalize_call_events(self.call, conv["id"])
        first = h.sql("select call_outcome from conversations where id=%s", (conv["id"],))[0][0]
        ce.finalize_call_events(self.call, conv["id"])
        second = h.sql("select call_outcome from conversations where id=%s", (conv["id"],))[0][0]
        self.assertEqual(first, second)


class ReplaceEvents(unittest.TestCase):
    def test_U50_replace_swaps_full_list_and_preserves_history(self):
        user = h.make_user()
        agent = seed_agent(user, [{"label": "Interested"}])
        call = f"call-{h.uuid.uuid4().hex[:8]}"
        ce.record_hit(user, agent["id"], call, "interested", None)
        ce.replace_events(user, agent["id"], ce.normalize_events([{"label": "Callback Requested"}]))
        self.assertEqual([e["event_key"] for e in ce.get_events(agent["id"])], ["callback_requested"])
        # Old hit survives (event_id nulled by FK) with its own copy of label/outcome.
        hit = ce.get_hits(call)[0]
        self.assertIsNone(hit["event_id"])
        self.assertEqual(hit["label"], "Interested")

    def test_U51_replace_with_empty_clears(self):
        user = h.make_user()
        agent = seed_agent(user, [{"label": "Interested"}])
        self.assertEqual(ce.replace_events(user, agent["id"], []), [])
        self.assertEqual(ce.get_events(agent["id"]), [])

    def test_U52_duplicate_key_rejected_by_db(self):
        user = h.make_user()
        agent = seed_agent(user, [{"label": "Interested"}])
        with self.assertRaises(Exception):
            supabase.table("call_events").insert({
                "user_id": user, "agent_id": agent["id"], "event_key": "interested", "label": "Dup",
            }).execute()


class Performance(unittest.TestCase):
    def test_P01_many_hits_finalize_and_read_are_fast(self):
        user = h.make_user()
        agent = seed_agent(user, [{"label": "Interested"}])
        call = f"call-{h.uuid.uuid4().hex[:8]}"
        conv = h.make_conversation(user, call)
        rows = [{"user_id": user, "agent_id": agent["id"], "vapi_call_id": call, "event_key": "interested",
                 "label": "Interested", "outcome": "Interested"} for _ in range(300)]
        supabase.table("call_event_hits").insert(rows).execute()
        t = time.perf_counter()
        ce.finalize_call_events(call, conv["id"])
        self.assertEqual(len(ce.get_hits(call)), 300)
        self.assertLess(time.perf_counter() - t, 3.0)

    def test_P02_normalize_and_payload_for_max_events_fast(self):
        t = time.perf_counter()
        ev = ce.normalize_events([{"label": f"Event {i}", "description": "d" * 200} for i in range(20)])
        ce.tool_payload("A", ev)
        ce.prompt_directive(ev)
        self.assertLess(time.perf_counter() - t, 0.2)


if __name__ == "__main__":
    unittest.main()
