"""Split fan-out and long-Delay scheduling in services/automation_engine.py.
DB-free: supabase is replaced with an in-memory fake."""
import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from services import automation_engine as eng


class FakeResp:
    def __init__(self, data):
        self.data = data


class FakeQuery:
    def __init__(self, db, table):
        self.db, self.table, self.op, self.payload, self.filters = db, table, "select", None, []

    def select(self, *_): return self
    def insert(self, row): self.op, self.payload = "insert", row; return self
    def update(self, vals): self.op, self.payload = "update", vals; return self
    def eq(self, c, v): self.filters.append(lambda r: r.get(c) == v); return self
    def lte(self, c, v): self.filters.append(lambda r: r.get(c) <= v); return self
    def order(self, *_, **__): return self
    def limit(self, *_): return self

    def execute(self):
        rows = self.db.setdefault(self.table, [])
        if self.op == "insert":
            row = {"id": f"id{len(rows)}", **self.payload}
            rows.append(row)
            return FakeResp([row])
        hit = [r for r in rows if all(f(r) for f in self.filters)]
        if self.op == "update":
            for r in hit:
                r.update(self.payload)
        return FakeResp(hit)


class FakeSupabase:
    def __init__(self):
        self.db = {}

    def table(self, name): return FakeQuery(self.db, name)


def node(nid, kind, type_="action", config=None):
    return {"id": nid, "type": type_, "data": {"kind": kind, "config": config or {}}}


def edge(a, b, handle=None):
    return {"source": a, "target": b, "sourceHandle": handle}


class SplitDelayTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakeSupabase()
        p = patch.object(eng, "supabase", self.fake)
        p.start()
        self.addCleanup(p.stop)

    def test_split_runs_branches_concurrently_and_isolates_failures(self):
        nodes = [node("t", "now", "trigger"), node("s", "split", "operator"),
                 node("a", "sms"), node("b", "email"), node("c", "webhook")]
        edges = [edge("t", "s"), edge("s", "a"), edge("s", "b"), edge("s", "c")]
        ran, in_flight, peak = [], 0, 0

        async def fake_exec(user_id, n, conv):
            nonlocal in_flight, peak
            kind = n["data"]["kind"]
            if kind in ("sms", "email", "webhook"):
                in_flight += 1
                peak = max(peak, in_flight)
                await asyncio.sleep(0.05)
                in_flight -= 1
                ran.append(kind)
                if kind == "sms":
                    raise RuntimeError("sms down")

        with patch.object(eng, "_execute_node", fake_exec):
            with self.assertRaises(RuntimeError):
                asyncio.run(eng._execute_flow("u", nodes, edges, {}))
        self.assertEqual(sorted(ran), ["email", "sms", "webhook"])  # failure didn't stop the rest
        self.assertEqual(peak, 3)  # truly concurrent

    def test_long_delay_is_scheduled_not_skipped(self):
        nodes = [node("t", "now", "trigger"), node("d", "delay", "operator", {"duration": "2", "unit": "hours"}),
                 node("a", "sms")]
        edges = [edge("t", "d"), edge("d", "a")]
        ran = []

        async def fake_exec(user_id, n, conv): ran.append(n["data"]["kind"])

        with patch.object(eng, "_execute_node", fake_exec):
            scheduled = asyncio.run(eng._execute_flow("u", nodes, edges, {"phone": "+1"}, flow_id="f1", run_id="r1"))
        self.assertEqual(scheduled, 1)
        self.assertNotIn("sms", ran)  # must NOT fire immediately
        row = self.fake.db["automation_pending_steps"][0]
        self.assertEqual((row["node_id"], row["status"]), ("d", "pending"))

    def test_due_step_resumes_downstream_only(self):
        definition = {"nodes": [node("t", "now", "trigger"), node("d", "delay", "operator", {"duration": "1", "unit": "days"}),
                                node("a", "sms")],
                      "edges": [edge("t", "d"), edge("d", "a")]}
        self.fake.db["automation_flows"] = [{"id": "f1", "user_id": "u", "status": "Active", "definition": definition}]
        self.fake.db["automation_pending_steps"] = [
            {"id": "p1", "user_id": "u", "flow_id": "f1", "run_id": None, "node_id": "d",
             "conversation": {"phone": "+1"}, "resume_at": "2000-01-01T00:00:00+00:00", "status": "pending"},
            {"id": "p2", "user_id": "u", "flow_id": "f1", "run_id": None, "node_id": "d",
             "conversation": {}, "resume_at": "2999-01-01T00:00:00+00:00", "status": "pending"},
        ]
        ran = []

        async def fake_exec(user_id, n, conv): ran.append(n["data"]["kind"])

        with patch.object(eng, "_execute_node", fake_exec):
            count = asyncio.run(eng.run_due_delayed_steps())
        self.assertEqual((count, ran), (1, ["sms"]))  # only the trigger + delay were skipped
        statuses = {r["id"]: r["status"] for r in self.fake.db["automation_pending_steps"]}
        self.assertEqual(statuses, {"p1": "done", "p2": "pending"})

    def test_short_delay_still_sleeps_inline(self):
        nodes = [node("t", "now", "trigger"), node("d", "delay", "operator", {"duration": "0.001", "unit": "minutes"}),
                 node("a", "sms")]
        edges = [edge("t", "d"), edge("d", "a")]
        ran = []

        async def fake_exec(user_id, n, conv): ran.append(n["data"]["kind"])

        with patch.object(eng, "_execute_node", fake_exec):
            scheduled = asyncio.run(eng._execute_flow("u", nodes, edges, {}, flow_id="f1"))
        self.assertEqual((scheduled, "sms" in ran), (0, True))


if __name__ == "__main__":
    unittest.main()
