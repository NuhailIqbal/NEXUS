"""
Call Consumption (services/call_consumption.py, routers/call_consumption.py).

Covered: the consumed/dropped classifier (Python rules, and that the SQL CASE agrees with them), the weighted
percentage rule at every tree level, previous-period deltas, time-zone bucketing, every endpoint and filter,
dense hourly grids, hotspots and the insight rules, CSV exports, input validation, tenant isolation (and a
team member seeing the owner's data), area code -> state, and the webhook storing the end reason the whole
module depends on.

Run from the backend folder:  python -m unittest discover -s tests -p "test_call_consumption.py" -v
"""
import unittest
import uuid
from datetime import date, datetime, timedelta, timezone
from unittest.mock import patch

import qa_harness as h
from qa_harness import client, auth
from database import supabase
from routers import webhooks
from services import call_consumption as cc
from services.us_area_codes import UNKNOWN_STATE, area_code_of, state_for_area_code, state_for_phone

UTC = timezone.utc
CO, NY, UK = "+13035550100", "+12125550100", "+442071234567"


def insert_call(user, when, reason=None, status=None, secs=30, phone=CO, agent=None, campaign=None,
                direction="outbound", cost=0.10, number=None):
    """One conversation row at `when` (UTC). status defaults to what the webhook would derive from `reason`."""
    if status is None:
        status = webhooks._status_from_reason(reason or "")
    h.sql("insert into conversations (user_id, channel, status, call_time, ended_reason, duration_seconds, phone,"
          " agent_id, campaign_id, direction, call_cost, phone_number_id) values (%s,'Phone',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
          (user, status, when, reason, secs, phone, agent, campaign, direction, cost, number))


def at(day, hour, minute=0):
    return datetime(2026, 3, day, hour, minute, tzinfo=UTC)


def q(**kw):
    """Query-string dict for the standard window (Mon 2026-03-02 .. Sun 2026-03-08) plus overrides."""
    params = {"from": "2026-03-02", "to": "2026-03-08", "tz": "UTC"}
    params.update(kw)
    return {k: v for k, v in params.items() if v is not None}


class Base(unittest.TestCase):
    """An owner with two agents (Insurance, Real Estate), two campaigns and a known set of calls.

    Mar 2 10:15  C1/A1 CO : 8 consumed, 2 no-answer           (20% dropped)
    Mar 3 15:05  C2/A2 NY : 1 consumed, 1 voicemail           (50%)
    Mar 4 10:40  C1/A1 CO : 4 failed                          (100%)
    Mar 6 09:00  no campaign, A1, inbound, UK number : 1 consumed (0%)
    => 17 calls, 10 consumed, 7 dropped (no_answer 2, voicemail 1, failed 4).
    Left out on purpose: an Initiated call, a call outside the window, and another account's call."""

    def setUp(self):
        h.reset_rate_limits()
        self.user = h.make_user()
        self.other = h.make_user("other")
        self.a1 = self.agent(self.user, "Sara", "Insurance")
        self.a2 = self.agent(self.user, "Max", "Real Estate")
        self.c1 = self.campaign(self.user, "Spring Push", self.a1)
        self.c2 = self.campaign(self.user, "Listings", self.a2)
        for _ in range(8):
            insert_call(self.user, at(2, 10, 15), "customer-ended-call", agent=self.a1, campaign=self.c1)
        for _ in range(2):
            insert_call(self.user, at(2, 10, 15), "customer-did-not-answer", secs=0, agent=self.a1, campaign=self.c1)
        insert_call(self.user, at(3, 15, 5), "customer-ended-call", phone=NY, agent=self.a2, campaign=self.c2)
        insert_call(self.user, at(3, 15, 5), "voicemail", phone=NY, agent=self.a2, campaign=self.c2)
        for _ in range(4):
            insert_call(self.user, at(4, 10, 40), "pipeline-error-openai-llm-failed", secs=0, agent=self.a1, campaign=self.c1)
        insert_call(self.user, at(6, 9, 0), "customer-ended-call", phone=UK, agent=self.a1, direction="inbound")
        insert_call(self.user, at(3, 12), status="Initiated")            # not finished
        insert_call(self.user, at(20, 12), "customer-ended-call")       # outside the window
        insert_call(self.other, at(2, 10), "customer-did-not-answer")   # someone else's

    @staticmethod
    def agent(user, name, category):
        return supabase.table("ai_agents").insert({"user_id": user, "name": name, "category": category}).execute().data[0]["id"]

    @staticmethod
    def campaign(user, name, agent):
        return supabase.table("outbound_campaigns").insert({"user_id": user, "name": name, "agent_id": agent}).execute().data[0]["id"]

    def get(self, path, user=None, **kw):
        return client.get(f"/call-consumption{path}", params=q(**kw), headers=auth(user or self.user))

    def data(self, path, user=None, **kw):
        r = self.get(path, user, **kw)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["data"]


# ---------------------------------------------------------------------------------------------- classifier

class Classifier(unittest.TestCase):
    CASES = [
        # (ended_reason, status, seconds) -> disposition
        ("customer-ended-call", "Completed", 42, "consumed"),
        ("assistant-ended-call", "Completed", 90, "consumed"),
        ("assistant-forwarded-call", "Completed", 60, "consumed"),
        ("silence-timed-out", "Completed", 25, "consumed"),
        ("exceeded-max-duration", "Completed", 600, "consumed"),
        ("customer-ended-call", "Completed", 2, "hung_up"),
        ("customer-ended-call", "Completed", 3, "consumed"),
        ("assistant-ended-call", "Completed", 1, "consumed"),     # only the CUSTOMER hanging up at once counts
        ("customer-did-not-answer", "No Answer", 0, "no_answer"),
        ("customer-busy", "No Answer", 0, "busy"),
        ("voicemail", "No Answer", 20, "voicemail"),
        ("pipeline-error-openai-llm-failed", "Failed", 0, "failed"),
        ("twilio-failed-to-connect-call", "Failed", 0, "failed"),
        ("vonage-rejected", "Completed", 0, "failed"),
        ("assistant-request-returned-error", "Failed", 0, "blocked"),
        ("assistant-request-failed", "Failed", 0, "blocked"),
        ("call-blocked-by-hours", "Completed", 0, "blocked"),
        # Calls logged before ended_reason existed fall back to the coarse status.
        (None, "No Answer", 0, "no_answer"),
        (None, "Failed", 0, "failed"),
        (None, "Completed", 55, "consumed"),
        (None, "Completed", 0, "consumed"),                       # unknown length is NOT a hang-up
        ("", "Completed", 12, "consumed"),
        # Still ringing / talking: not counted at all.
        ("customer-ended-call", "Initiated", 5, None),
        (None, "In Progress", 0, None),
    ]

    def test_python_rules(self):
        for reason, status, secs, expected in self.CASES:
            with self.subTest(reason=reason, status=status, secs=secs):
                self.assertEqual(cc.classify(reason, status, secs), expected)

    def test_sql_case_agrees_with_python_for_every_case(self):
        user = h.make_user("cls")
        finished = [c for c in self.CASES if c[3] is not None]
        for i, (reason, status, secs, _) in enumerate(finished):
            insert_call(user, at(1 + i % 28, 8), reason, status=status, secs=secs, phone=f"+1303555{i:04d}")
        got = {}
        # One row per call, so count how many calls of each disposition came back and compare multisets.
        flt = cc.Filters(date(2026, 3, 1), date(2026, 3, 31), "UTC")
        for r in cc.fetch(user, flt):
            got[r["disposition"]] = got.get(r["disposition"], 0) + r["calls"]
        want = {}
        for _, _, _, expected in finished:
            want[expected] = want.get(expected, 0) + 1
        self.assertEqual(got, want)

    def test_every_disposition_is_listed(self):
        self.assertEqual(set(cc.DISPOSITIONS), {c[3] for c in self.CASES if c[3]})


class Maths(unittest.TestCase):
    def test_tally_invariants(self):
        t = cc.Tally()
        t.add("consumed", 6)
        t.add("no_answer", 3, 0.3)
        t.add("failed", 1, 0.1)
        self.assertEqual((t.total, t.consumed, t.dropped), (10, 6, 4))
        self.assertAlmostEqual(t.consumption_pct(2) + t.drop_pct(2), 100, places=2)
        self.assertEqual(t.row(2)["buckets"]["no_answer"], 3)
        self.assertEqual(t.row()["dropped_cost"], 0.4)

    def test_empty_tally_never_divides_by_zero(self):
        t = cc.Tally()
        self.assertEqual((t.consumption_pct(), t.drop_pct()), (0, 0))

    def test_hour_labels(self):
        self.assertEqual([cc.hour_label(h) for h in (0, 1, 11, 12, 13, 23)],
                         ["12:00 AM", "01:00 AM", "11:00 AM", "12:00 PM", "01:00 PM", "11:00 PM"])

    def test_previous_window_is_the_same_length_just_before(self):
        f = cc.Filters(date(2026, 3, 9), date(2026, 3, 15)).previous()
        self.assertEqual((f.from_date, f.to_date), (date(2026, 3, 2), date(2026, 3, 8)))
        one = cc.Filters(date(2026, 3, 9), date(2026, 3, 9)).previous()
        self.assertEqual((one.from_date, one.to_date), (date(2026, 3, 8), date(2026, 3, 8)))

    def test_window_is_local_midnight_to_local_midnight(self):
        start, end = cc.Filters(date(2026, 3, 2), date(2026, 3, 2), "Asia/Karachi").window()
        self.assertEqual(start.astimezone(UTC), datetime(2026, 3, 1, 19, 0, tzinfo=UTC))
        self.assertEqual(end - start, timedelta(days=1))

    def test_campaign_id_parsing(self):
        a, b = str(uuid.uuid4()), str(uuid.uuid4())
        self.assertEqual(cc.parse_campaign_ids(f"{a}, {b}"), (a, b))
        self.assertEqual(cc.parse_campaign_ids(None), ())
        with self.assertRaises(ValueError):
            cc.parse_campaign_ids("nope")


class AreaCodes(unittest.TestCase):
    def test_formats(self):
        for phone in ("+13035550100", "13035550100", "3035550100", "+1 (303) 555-0100", "303-555-0100"):
            self.assertEqual(area_code_of(phone), "303", phone)

    def test_non_nanp_and_junk(self):
        for phone in (None, "", "abc", UK, "+1555", "+11035550100", "0035550100"):
            self.assertIsNone(area_code_of(phone), phone)

    def test_states(self):
        self.assertEqual(state_for_phone(CO), "CO")
        self.assertEqual(state_for_phone(NY), "NY")
        self.assertEqual(state_for_phone("+17875550100"), "PR")
        self.assertEqual(state_for_phone("+18005550100"), UNKNOWN_STATE)     # toll free
        self.assertEqual(state_for_phone(UK), UNKNOWN_STATE)
        self.assertEqual(state_for_area_code(None), UNKNOWN_STATE)

    def test_no_area_code_maps_to_two_states(self):
        from services.us_area_codes import _CODES_BY_STATE
        seen = {}
        for st, codes in _CODES_BY_STATE.items():
            for c in codes.split():
                self.assertNotIn(c, seen, f"{c} is in both {seen.get(c)} and {st}")
                self.assertEqual(len(c), 3)
                seen[c] = st


# ---------------------------------------------------------------------------------------------- overview

class Overview(Base):
    def test_kpis_current_vs_previous(self):
        k = self.data("/overview/kpis")
        self.assertEqual((k["has_data"], k["total_calls"]), (True, 17))
        self.assertEqual((k["consumption_pct"], k["drop_pct"]), (58.8, 41.2))
        # Nothing in the week before: no comparison at all, NOT "+58.8 points from 0%".
        self.assertEqual((k["has_previous"], k["total_calls_change_pct"]), (False, 0))
        self.assertEqual((k["consumption_pct_point_change"], k["drop_pct_point_change"]), (0, 0))
        # Next week has 2 calls (both consumed): the week before it is the 17-call week.
        insert_call(self.user, at(10, 9), "customer-ended-call")
        insert_call(self.user, at(11, 9), "customer-ended-call")
        k = self.data("/overview/kpis", **{"from": "2026-03-09", "to": "2026-03-15"})
        self.assertEqual(k["total_calls"], 2)
        self.assertTrue(k["has_previous"])
        self.assertEqual(k["total_calls_change_pct"], -88.2)          # (2-17)/17
        self.assertEqual(k["consumption_pct"], 100.0)
        self.assertEqual(k["consumption_pct_point_change"], 41.2)     # 100 - 58.8, in points
        self.assertEqual(k["drop_pct_point_change"], -41.2)

    def test_kpis_without_data(self):
        k = self.data("/overview/kpis", user=self.other, **{"from": "2026-01-01", "to": "2026-01-31"})
        self.assertFalse(k["has_data"])
        self.assertEqual((k["total_calls"], k["drop_pct"], k["total_calls_change_pct"]), (0, 0, 0))

    def test_summary_tree_is_weighted_at_every_level(self):
        s = self.data("/overview/summary")
        self.assertTrue(s["has_data"])
        self.assertEqual(s["total"]["total_calls"], 17)
        self.assertEqual(s["total"]["drop_pct"], 41.18)
        (month,) = s["rows"]
        self.assertEqual((month["name"], month["total_calls"], month["dropped_calls"]), ("March 2026", 17, 7))
        self.assertEqual(month["drop_pct"], 41.18)
        (week,) = month["children"]
        self.assertEqual((week["name"], week["start_date"], week["end_date"]), ("Week of Mar 2", "2026-03-02", "2026-03-06"))
        days = {d["name"]: d for d in week["children"]}
        self.assertEqual(sorted(days), ["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-06"])
        self.assertEqual([days[d]["drop_pct"] for d in sorted(days)], [20.0, 50.0, 100.0, 0])
        # The parent is NOT the mean of its children (that would be 42.5): it is sum(dropped)/sum(total).
        self.assertNotEqual(week["drop_pct"], sum(d["drop_pct"] for d in days.values()) / 4)
        self.assertEqual(week["drop_pct"], round(7 / 17 * 100, 2))

    def test_consumed_plus_dropped_is_total_on_every_row(self):
        def walk(nodes):
            for n in nodes:
                self.assertEqual(n["consumed_calls"] + n["dropped_calls"], n["total_calls"], n["name"])
                self.assertEqual(sum(n["buckets"].values()), n["dropped_calls"], n["name"])
                self.assertAlmostEqual(n["consumption_pct"] + n["drop_pct"], 100, delta=0.011, msg=n["name"])
                walk(n.get("children", []))
        s = self.data("/overview/summary")
        walk(s["rows"] + [s["total"]])

    def test_weeks_never_straddle_a_month(self):
        # Sun Mar 29 .. Wed Apr 1: two months, so two week nodes, one in each.
        user = h.make_user("tree")
        for d, hr in ((date(2026, 3, 29), 8), (date(2026, 3, 31), 8), (date(2026, 4, 1), 8)):
            insert_call(user, datetime(d.year, d.month, d.day, hr, tzinfo=UTC), "customer-ended-call")
        s = self.data("/overview/summary", user=user, **{"from": "2026-03-29", "to": "2026-04-02"})
        self.assertEqual([m["name"] for m in s["rows"]], ["March 2026", "April 2026"])
        self.assertEqual([len(m["children"]) for m in s["rows"]], [1, 1])
        self.assertEqual([m["total_calls"] for m in s["rows"]], [2, 1])

    def test_buckets_in_the_summary(self):
        b = self.data("/overview/summary")["total"]["buckets"]
        self.assertEqual(b, {"no_answer": 2, "busy": 0, "voicemail": 1, "hung_up": 0, "blocked": 0, "failed": 4})

    def test_timezone_moves_a_late_call_to_the_next_day(self):
        user = h.make_user("tz")
        insert_call(user, at(5, 23, 30), "customer-ended-call")      # 23:30 UTC = 04:30 next day in Karachi
        utc = self.data("/overview/summary", user=user, tz="UTC")
        khi = self.data("/overview/summary", user=user, tz="Asia/Karachi")
        self.assertEqual(utc["rows"][0]["children"][0]["children"][0]["name"], "2026-03-05")
        self.assertEqual(khi["rows"][0]["children"][0]["children"][0]["name"], "2026-03-06")
        hours = {r["hour"]: r["total_calls"] for r in self.data("/hourly/summary", user=user, tz="Asia/Karachi")["rows"]}
        self.assertEqual(hours[4], 1)

    def test_filters(self):
        for params, total, dropped in [
            ({"campaign_ids": self.c1}, 14, 6),
            ({"campaign_ids": f"{self.c1},{self.c2}"}, 16, 7),
            ({"vertical": "Real Estate"}, 2, 1),
            ({"vertical": "Insurance"}, 15, 6),
            ({"agent_id": self.a2}, 2, 1),
            ({"direction": "inbound"}, 1, 0),
            ({"direction": "outbound"}, 16, 7),
            ({"disposition": "failed"}, 4, 4),
            ({"disposition": "consumed"}, 10, 0),
        ]:
            with self.subTest(params):
                t = self.data("/overview/summary", **params)["total"]
                self.assertEqual((t["total_calls"], t["dropped_calls"]), (total, dropped))

    def test_filters_combine(self):
        t = self.data("/overview/summary", campaign_ids=self.c1, disposition="no_answer")["total"]
        self.assertEqual(t["total_calls"], 2)

    def test_insights_for_this_data(self):
        cards = self.data("/overview/insights")
        cats = [c["category"] for c in cards]
        self.assertIn("Worst Vertical", cats)
        self.assertIn("Worst State", cats)
        worst = next(c for c in cards if c["category"] == "Worst Vertical")
        self.assertIn("Insurance", worst["title"])
        for c in cards:
            self.assertEqual(set(c), {"category", "badge", "title", "description", "action_label", "action"})

    def test_insights_with_no_data_is_a_single_card(self):
        cards = self.data("/overview/insights", user=self.other, **{"from": "2026-01-01", "to": "2026-01-02"})
        self.assertEqual([(c["category"], c["badge"]) for c in cards], [("Performance", "NO DATA")])

    def test_hotspots_respect_the_volume_floor(self):
        rows = self.data("/overview/hotspots")
        by = {(r["dimension"], r["row_type"]): r for r in rows}
        # Only segments with >= 5 calls qualify: CO (14), Insurance (15), Spring Push (14), Mon Mar 2 10:00 (10).
        self.assertEqual(by[("State", "Worst")]["segment"], "Colorado")
        self.assertEqual(by[("Vertical", "Worst")]["segment"], "Insurance")
        self.assertEqual(by[("Campaign", "Worst")]["segment"], "Spring Push")
        hour = by[("Hour", "Worst")]
        self.assertEqual((hour["segment"], hour["segment_sub_label"], hour["calls"]), ("10:00 AM", "Mon Mar 2", 10))
        self.assertNotIn("New York", [r["segment"] for r in rows])             # 2 calls: under the floor
        self.assertEqual([r["drop_rate_pct"] for r in rows], sorted((r["drop_rate_pct"] for r in rows), reverse=True))
        self.assertNotIn(",", hour["segment_sub_label"])

    def test_exports_match_the_screen(self):
        r = client.get("/call-consumption/overview/export/summary.csv", params=q(), headers=auth(self.user))
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.headers["content-type"].startswith("text/csv"))
        self.assertIn("CallConsumptionOverviewSummary.csv", r.headers["content-disposition"])
        lines = r.text.strip().split("\n")
        self.assertEqual(lines[0], "Name,Total Calls,Consumed,Consumption Rate,Dropped,Drop Rate,No answer,Busy,Voicemail,Hung up at once,Blocked,Failed")
        self.assertEqual(lines[1].split(",")[:2], ["March 2026", "17"])
        self.assertTrue(lines[-1].startswith("Total,17,10,58.82%,7,41.18%"))
        self.assertEqual(len(lines), 1 + 1 + 1 + 4 + 1)                          # header, month, week, 4 days, total
        h_ = client.get("/call-consumption/overview/export/hotspots.csv", params=q(), headers=auth(self.user))
        self.assertEqual(h_.status_code, 200)
        self.assertTrue(h_.text.startswith("Dimension,Segment,Calls,Dropped,Drop Rate\n"))
        self.assertIn("Hour (Worst),10:00 AM - Mon Mar 2,10,2,20.0%", h_.text)

    def test_empty_exports_are_404(self):
        for path in ("/overview/export/summary.csv", "/overview/export/hotspots.csv", "/hourly/export.csv"):
            r = client.get(f"/call-consumption{path}", params=q(**{"from": "2026-01-01", "to": "2026-01-02"}), headers=auth(self.user))
            self.assertEqual(r.status_code, 404, path)


# ---------------------------------------------------------------------------------------------- breakdowns

class Breakdown(Base):
    def seg(self, dim, section, **kw):
        return self.data(f"/breakdown/{dim}/{section}", **kw)

    def test_campaign_kpi(self):
        k = self.seg("campaign", "kpi")
        self.assertEqual((k["total_calls"], k["consumed_calls"], k["dropped_calls"], k["dropped_pct"]), (17, 10, 7, 41.2))
        self.assertEqual(k["segment_count"], 3)                                   # two campaigns + "No campaign"
        self.assertEqual((k["worst_segment_name"], k["worst_segment_drop_rate"], k["worst_segment_calls"]),
                         ("Spring Push", 42.9, 14))
        self.assertEqual(k["cost_on_dropped"], 0.7)                               # 7 dropped calls x $0.10

    def test_worst_segment_falls_back_below_the_floor_and_is_null_with_no_data(self):
        user = h.make_user("small")
        insert_call(user, at(2, 9), "customer-did-not-answer")
        k = self.seg("campaign", "kpi", user=user)
        self.assertEqual((k["worst_segment_name"], k["worst_segment_calls"]), ("No campaign", 1))
        k = self.seg("campaign", "kpi", user=self.other, **{"from": "2026-01-01", "to": "2026-01-02"})
        self.assertFalse(k["has_data"])
        self.assertIsNone(k["worst_segment_name"])
        self.assertIsNone(k["worst_segment_drop_rate"])

    def test_combo_ranking_and_summary_per_dimension(self):
        for dim, names in (("campaign", {"Spring Push": 14, "Listings": 2, "No campaign": 1}),
                           ("vertical", {"Insurance": 15, "Real Estate": 2}),
                           ("state", {"Colorado": 14, "New York": 2, "Unknown": 1})):
            with self.subTest(dim):
                combo = self.seg(dim, "combo")
                self.assertEqual({r["name"]: r["total_calls"] for r in combo}, names)
                self.assertEqual([r["total_calls"] for r in combo], sorted((r["total_calls"] for r in combo), reverse=True))
                for r in combo:
                    self.assertEqual(r["consumed_calls"] + r["dropped_calls"], r["total_calls"])
                rank = self.seg(dim, "ranking")
                rates = [r["drop_rate_pct"] for r in rank]
                self.assertEqual(rates, sorted(rates, reverse=True))              # worst first
                summ = self.seg(dim, "summary")
                self.assertEqual(summ["total"]["total_calls"], 17)
                self.assertEqual(sum(r["total_calls"] for r in summ["rows"]), 17)
                dropped = [r["dropped_calls"] for r in summ["rows"]]
                self.assertEqual(dropped, sorted(dropped, reverse=True))

    def test_state_uses_the_area_code(self):
        rank = {r["name"]: r for r in self.seg("state", "ranking")}
        self.assertEqual(rank["Colorado"]["dropped_calls"], 6)
        self.assertEqual(rank["New York"]["drop_rate_pct"], 50.0)
        self.assertEqual(rank["Unknown"]["drop_rate_pct"], 0)

    def test_disposition_breakdown_and_mix(self):
        rows = self.seg("campaign", "disposition")
        self.assertEqual({(r["name"], r["disposition"]): r["calls"] for r in rows},
                         {("Spring Push", "no_answer"): 2, ("Spring Push", "failed"): 4, ("Listings", "voicemail"): 1})
        self.assertTrue(all(r["calls"] > 0 for r in rows))
        mix = {m["disposition"]: m for m in self.seg("campaign", "mix")}
        self.assertEqual({k: v["calls"] for k, v in mix.items()}, {"no_answer": 2, "voicemail": 1, "failed": 4})
        self.assertEqual(mix["failed"]["pct_of_dropped"], 57.1)                  # share of DROPPED, 4/7
        self.assertEqual(sum(m["calls"] for m in mix.values()), 7)

    def test_breakdown_honours_filters(self):
        k = self.seg("campaign", "kpi", vertical="Real Estate")
        self.assertEqual((k["total_calls"], k["dropped_calls"], k["worst_segment_name"]), (2, 1, "Listings"))

    def test_reasons_leaf(self):
        r = self.data(f"/reasons?campaign_id={self.c1}")
        self.assertEqual((r["campaign_name"], r["total_calls"], r["consumed_calls"], r["dropped_calls"]), ("Spring Push", 14, 8, 6))
        self.assertEqual([(x["disposition"], x["calls"], x["pct_of_dropped"]) for x in r["reasons"]],
                         [("no_answer", 2, 33.3), ("failed", 4, 66.7)])
        raw = {x["reason"]: x["calls"] for x in r["raw_reasons"]}
        self.assertEqual(raw, {"pipeline-error-openai-llm-failed": 4, "customer-did-not-answer": 2})
        self.assertEqual(r["raw_reasons"][0]["calls"], 4)                          # most common first

    def test_reasons_for_calls_logged_before_ended_reason_existed(self):
        user = h.make_user("legacy")
        camp = self.campaign(user, "Old", self.agent(user, "A", "Insurance"))
        insert_call(user, at(2, 9), None, status="No Answer", campaign=camp)
        r = self.data(f"/reasons?campaign_id={camp}", user=user)
        self.assertEqual(r["raw_reasons"][0]["reason"], "(not recorded)")
        self.assertEqual(r["reasons"][0]["disposition"], "no_answer")

    def test_reasons_cannot_read_another_accounts_campaign(self):
        r = self.data(f"/reasons?campaign_id={self.c1}", user=self.other)
        self.assertEqual((r["total_calls"], r["campaign_name"]), (0, None))

    def test_unknown_dimension_or_section_is_404(self):
        self.assertEqual(self.get("/breakdown/planet/kpi").status_code, 404)
        self.assertEqual(self.get("/breakdown/campaign/pie").status_code, 404)


class StateHeatmap(Base):
    def grid(self, user=None, **kw):
        return self.data("/state/heatmap", user, **kw)

    def cell(self, g, state, hour):
        return next(c for c in g["cells"] if c["state"] == state and c["hour"] == hour)

    def test_one_dense_row_of_24_hours_per_state_busiest_first(self):
        g = self.grid()
        self.assertEqual([s["key"] for s in g["states"]], ["CO", "NY"])
        self.assertEqual([s["name"] for s in g["states"]], ["Colorado", "New York"])
        self.assertEqual([s["total_calls"] for s in g["states"]], [14, 2])
        self.assertEqual(len(g["cells"]), 48)
        self.assertEqual([c["hour"] for c in g["cells"] if c["state"] == "CO"], list(range(24)))
        co10 = self.cell(g, "CO", 10)
        self.assertEqual((co10["total_calls"], co10["consumed_calls"], co10["dropped_calls"], co10["drop_pct"]), (14, 8, 6, 42.9))
        self.assertEqual(co10["hour_label"], "10:00 AM")
        self.assertEqual((self.cell(g, "CO", 3)["total_calls"], self.cell(g, "CO", 3)["drop_pct"]), (0, 0))
        ny15 = self.cell(g, "NY", 15)
        self.assertEqual((ny15["total_calls"], ny15["drop_pct"], ny15["consumption_pct"]), (2, 50.0, 50.0))

    def test_non_us_numbers_are_left_out_and_only_counted(self):
        g = self.grid()
        self.assertNotIn("??", [s["key"] for s in g["states"]])
        self.assertEqual(g["unknown_calls"], 1)                            # the UK number
        self.assertEqual(sum(c["total_calls"] for c in g["cells"]) + g["unknown_calls"], 17)

    def test_all_area_codes_of_a_state_add_up_in_one_row(self):
        insert_call(self.user, at(5, 10), "customer-did-not-answer", phone="+17205550100")   # 720 is also Colorado
        co10 = self.cell(self.grid(), "CO", 10)
        self.assertEqual((co10["total_calls"], co10["dropped_calls"]), (15, 7))

    def test_hours_follow_the_chosen_time_zone(self):
        g = self.grid(tz="Asia/Karachi")                                   # UTC+5
        self.assertEqual(self.cell(g, "CO", 15)["total_calls"], 14)
        self.assertEqual(self.cell(g, "CO", 10)["total_calls"], 0)

    def test_filters_apply(self):
        g = self.grid(campaign_ids=self.c2)
        self.assertEqual([s["key"] for s in g["states"]], ["NY"])
        g = self.grid(disposition="failed")
        self.assertEqual(self.cell(g, "CO", 10)["total_calls"], 4)

    def test_empty_and_other_accounts(self):
        g = self.grid(user=self.other, **{"from": "2026-01-01", "to": "2026-01-02"})
        self.assertEqual((g["states"], g["cells"], g["unknown_calls"]), ([], [], 0))
        mine = self.grid(user=self.other)
        self.assertEqual([s["total_calls"] for s in mine["states"]], [1])  # only their own call


class StateFilter(Base):
    def total(self, path="/overview/summary", **kw):
        d = self.data(path, **kw)
        return d["total"]["total_calls"] if isinstance(d, dict) and "total" in d else d

    def test_filters_every_widget_to_the_chosen_states(self):
        self.assertEqual(self.total(states="CO"), 14)
        self.assertEqual(self.total(states="NY"), 2)
        self.assertEqual(self.total(states="CO,NY"), 16)
        self.assertEqual(self.total(states="co, ny"), 16)              # case and spaces do not matter
        self.assertEqual(self.data("/overview/kpis", states="NY")["total_calls"], 2)
        for dim in ("campaign", "vertical", "state"):
            self.assertEqual(self.data(f"/breakdown/{dim}/kpi", states="CO")["total_calls"], 14, dim)
        self.assertEqual([r["name"] for r in self.data("/breakdown/state/ranking", states="NY")], ["New York"])
        self.assertEqual(sum(c["total_calls"] for c in self.data("/hourly/heatmap", states="NY")["cells"]), 2)
        self.assertEqual([s["key"] for s in self.data("/state/heatmap", states="CO")["states"]], ["CO"])
        self.assertEqual(self.data("/hourly/kpis", states="CO")["total_calls"], 14)

    def test_all_area_codes_of_a_state_count(self):
        insert_call(self.user, at(5, 11), "customer-ended-call", phone="+17205550100")   # 720 is Colorado too
        self.assertEqual(self.total(states="CO"), 15)

    def test_combines_with_the_other_filters(self):
        self.assertEqual(self.total(states="CO", campaign_ids=self.c1), 14)
        self.assertEqual(self.total(states="NY", campaign_ids=self.c1), 0)
        self.assertEqual(self.total(states="CO", disposition="failed"), 4)

    def test_a_state_with_no_calls_gives_an_empty_report(self):
        self.assertEqual(self.total(states="TX"), 0)
        self.assertFalse(self.data("/overview/kpis", states="TX")["has_data"])

    def test_the_weekly_and_exports_honour_it_too(self):
        r = client.get("/call-consumption/overview/export/summary.csv", params=q(states="NY"), headers=auth(self.user))
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.text.strip().split("\n")[-1].startswith("Total,2,"))
        self.assertEqual(self.data("/period/weekly", states="CO")["total"]["total_calls"], 14)

    def test_unknown_or_malformed_states_are_rejected(self):
        for bad in ("ZZ", "??", "CO,ZZ", "Colorado"):
            with self.subTest(bad):
                self.assertEqual(self.get("/overview/kpis", states=bad).status_code, 400)

    def test_the_dropdown_lists_only_states_the_account_has_calls_with(self):
        f = self.data("/filters")
        self.assertEqual(f["states"], [{"code": "CO", "name": "Colorado"}, {"code": "NY", "name": "New York"}])
        self.assertEqual(self.data("/filters", user=self.other)["states"], [{"code": "CO", "name": "Colorado"}])  # only their own call

    def test_injection_attempt_is_inert(self):
        self.assertEqual(self.get("/overview/kpis", states="CO'; drop table conversations; --").status_code, 400)
        self.assertEqual(self.total(), 17)


class DirectionReport(Base):
    def setUp(self):
        super().setUp()
        self.n1 = supabase.table("phone_numbers").insert({"user_id": self.user, "number": "+15551230001", "label": "Main line"}).execute().data[0]["id"]
        self.n2 = supabase.table("phone_numbers").insert({"user_id": self.user, "number": "+15551230002"}).execute().data[0]["id"]
        for reason in ("customer-ended-call", "customer-ended-call", "customer-ended-call", "customer-did-not-answer"):
            insert_call(self.user, at(3, 11), reason, direction="inbound", agent=self.a1, number=self.n1)
        for _ in range(2):
            insert_call(self.user, at(3, 12), "pipeline-error-openai-llm-failed", secs=0, direction="inbound", agent=self.a1, number=self.n2)

    def report(self, which, user=None, **kw):
        return self.data(f"/direction/{which}", user, **kw)

    def test_outbound_is_by_campaign_busiest_first(self):
        r = self.report("outbound")
        self.assertEqual((r["direction"], r["segment_label"], r["has_data"]), ("outbound", "Campaign", True))
        self.assertEqual([(x["name"], x["total_calls"], x["dropped_calls"]) for x in r["rows"]], [("Spring Push", 14, 6), ("Listings", 2, 1)])
        self.assertEqual(r["rows"][0]["key"], self.c1)
        self.assertEqual(r["rows"][0]["drop_pct"], 42.86)
        self.assertEqual(r["total"]["total_calls"], 16)
        self.assertEqual(r["kpis"]["total_calls"], 16)                       # inbound calls are not in it
        self.assertEqual(r["rows"][0]["buckets"]["failed"], 4)

    def test_inbound_is_by_phone_number_with_label_or_number_and_unknown_for_the_rest(self):
        r = self.report("inbound")
        self.assertEqual(r["segment_label"], "Number")
        self.assertEqual([(x["name"], x["total_calls"]) for x in r["rows"]],
                         [("Main line", 4), ("+15551230002", 2), ("Unknown number", 1)])   # Unknown = the base inbound call with no number
        self.assertEqual((r["rows"][0]["drop_pct"], r["rows"][1]["drop_pct"]), (25.0, 100.0))
        self.assertEqual(r["rows"][2]["key"], "")
        self.assertEqual(r["total"]["total_calls"], 7)

    def test_each_row_is_compared_with_the_same_one_in_the_previous_window(self):
        insert_call(self.user, at(10, 11), "customer-ended-call", direction="inbound", agent=self.a1, number=self.n1)
        insert_call(self.user, at(10, 9), "customer-ended-call", agent=self.a1, campaign=self.c1)
        w = {"from": "2026-03-09", "to": "2026-03-15"}                          # previous window: Mar 2 - Mar 8
        i = self.report("inbound", **w)
        self.assertEqual([x["name"] for x in i["rows"]], ["Main line"])           # the others had no calls this week
        main = i["rows"][0]
        self.assertEqual(main["calls_change_pct"], -75.0)                        # 4 -> 1
        self.assertEqual(main["drop_pct_point_change"], -25.0)                   # 25% -> 0%
        o = self.report("outbound", **w)
        self.assertEqual((o["rows"][0]["name"], o["rows"][0]["calls_change_pct"]), ("Spring Push", -92.9))   # 14 -> 1
        self.assertTrue(o["kpis"]["has_previous"])

    def test_a_row_with_nothing_before_it_has_no_comparison(self):
        r = self.report("outbound", **{"from": "2026-03-02", "to": "2026-03-08"})
        self.assertFalse(r["kpis"]["has_previous"])
        self.assertTrue(all(x["calls_change_pct"] is None and x["drop_pct_point_change"] is None for x in r["rows"]))
        self.assertEqual((r["kpis"]["total_calls_change_pct"], r["kpis"]["drop_pct_point_change"]), (0, 0))

    def test_the_url_decides_the_direction_not_the_direction_filter(self):
        r = self.report("inbound", direction="outbound")
        self.assertEqual((r["direction"], r["total"]["total_calls"]), ("inbound", 7))

    def test_filters_apply(self):
        self.assertEqual(self.report("inbound", numbers=self.n1)["total"]["total_calls"], 4)
        self.assertEqual(self.report("inbound", numbers=f"{self.n1},{self.n2}")["total"]["total_calls"], 6)
        self.assertEqual(self.report("outbound", numbers=self.n1)["total"]["total_calls"], 0)       # outbound calls have no number
        self.assertEqual(self.report("inbound", campaign_ids=self.c1)["total"]["total_calls"], 0)   # inbound calls have no campaign
        self.assertEqual(self.report("outbound", campaign_ids=self.c2)["total"]["total_calls"], 2)
        self.assertEqual(self.report("inbound", disposition="failed")["total"]["total_calls"], 2)
        self.assertEqual(self.report("outbound", vertical="Real Estate")["total"]["total_calls"], 2)
        self.assertEqual(self.report("outbound", states="NY")["total"]["total_calls"], 2)

    def test_number_options_and_validation(self):
        f = self.data("/filters")
        self.assertEqual(sorted(n["name"] for n in f["numbers"]), ["+15551230002", "Main line"])
        self.assertEqual(self.data("/filters", user=self.other)["numbers"], [])
        self.assertEqual(self.get("/direction/inbound", numbers="nope").status_code, 400)

    def test_inbound_and_outbound_side_by_side_for_the_overview(self):
        d = self.data("/overview/directions")
        self.assertEqual((d["inbound"]["total_calls"], d["inbound"]["consumed_calls"], d["inbound"]["dropped_calls"]), (7, 4, 3))
        self.assertEqual(d["inbound"]["drop_pct"], 42.9)
        self.assertEqual((d["outbound"]["total_calls"], d["outbound"]["drop_pct"]), (16, 43.8))
        self.assertTrue(d["inbound"]["has_data"] and d["outbound"]["has_data"])
        only = self.data("/overview/directions", direction="inbound")
        self.assertEqual((only["inbound"]["total_calls"], only["outbound"]["has_data"], only["outbound"]["total_calls"]), (7, False, 0))
        empty = self.data("/overview/directions", user=self.other, **{"from": "2026-01-01", "to": "2026-01-02"})
        self.assertEqual((empty["inbound"]["has_data"], empty["outbound"]["has_data"]), (False, False))

    def test_csv_exports(self):
        r = client.get("/call-consumption/direction/outbound/export.csv", params=q(), headers=auth(self.user))
        self.assertEqual(r.status_code, 200)
        self.assertIn("OutboundCallConsumptionByCampaign.csv", r.headers["content-disposition"])
        lines = r.text.strip().split("\n")
        self.assertTrue(lines[0].startswith("Campaign,Total Calls,Consumed"))
        self.assertTrue(lines[0].endswith("Calls vs previous,Drop rate vs previous"))
        self.assertTrue(lines[1].startswith("Spring Push,14,8,57.14%,6,42.86%"))
        self.assertTrue(lines[-1].startswith("Total,16,"))
        i = client.get("/call-consumption/direction/inbound/export.csv", params=q(), headers=auth(self.user))
        self.assertIn("InboundCallConsumptionByNumber.csv", i.headers["content-disposition"])
        self.assertTrue(i.text.startswith("Number,Total Calls"))
        self.assertIn("Main line,4,3,75.0%,1,25.0%", i.text)

    def test_empty_export_unknown_direction_and_other_accounts(self):
        empty = q(**{"from": "2026-01-01", "to": "2026-01-02"})
        self.assertEqual(client.get("/call-consumption/direction/inbound/export.csv", params=empty, headers=auth(self.user)).status_code, 404)
        self.assertEqual(self.get("/direction/sideways").status_code, 404)
        self.assertEqual(client.get("/call-consumption/direction/sideways/export.csv", params=q(), headers=auth(self.user)).status_code, 404)
        r = self.report("inbound", user=self.other)
        self.assertEqual(r["rows"], [])                                          # their only call is outbound
        self.assertEqual(self.report("outbound", user=self.other)["total"]["total_calls"], 1)


# ---------------------------------------------------------------------------------------------- hourly

class Hourly(Base):
    def test_summary_is_24_rows_plus_a_weighted_total(self):
        s = self.data("/hourly/summary")
        self.assertEqual([r["hour"] for r in s["rows"]], list(range(24)))
        self.assertEqual([r["name"] for r in s["rows"]][:3], ["12:00 AM", "01:00 AM", "02:00 AM"])
        by = {r["hour"]: r for r in s["rows"]}
        self.assertEqual((by[10]["total_calls"], by[10]["dropped_calls"], by[10]["drop_pct"]), (14, 6, 42.86))
        self.assertEqual((by[3]["total_calls"], by[3]["drop_pct"]), (0, 0))        # empty hour: a zero row
        self.assertEqual(s["total"]["total_calls"], 17)
        self.assertEqual(s["total"]["drop_pct"], 41.18)
        self.assertEqual(sum(r["total_calls"] for r in s["rows"]), 17)

    def test_kpis(self):
        k = self.data("/hourly/kpis")
        self.assertEqual((k["total_calls"], k["overall_drop_pct"]), (17, 41.2))
        self.assertEqual((k["busiest_hour_label"], k["busiest_hour_calls"]), ("10:00 AM", 14))
        self.assertEqual(k["date_range_label"], "Mar 2 - Mar 8, 2026")
        # One concrete date+hour with >= 5 calls: Mon Mar 2 10:00 (Mar 4 10:00 has only 4 calls).
        self.assertEqual((k["risk_window_label"], k["risk_window_drop_pct"]), ("Mon, Mar 2 10:00 AM", 20.0))
        single = self.data("/hourly/kpis", **{"from": "2026-03-02", "to": "2026-03-02"})
        self.assertEqual(single["date_range_label"], "Mar 2, 2026")

    def test_kpis_with_nothing_qualifying(self):
        k = self.data("/hourly/kpis", user=self.other, **{"from": "2026-01-01", "to": "2026-01-02"})
        self.assertEqual((k["has_data"], k["busiest_hour_label"], k["risk_window_label"]), (False, "N/A", "N/A"))

    def test_trend_is_24_points(self):
        t = self.data("/hourly/trend")
        self.assertEqual([p["hour"] for p in t], list(range(24)))
        self.assertEqual((t[10]["total_calls"], t[10]["dropped_calls"], t[10]["drop_pct"]), (14, 6, 42.9))
        self.assertEqual((t[0]["total_calls"], t[0]["drop_pct"]), (0, 0))

    def test_heatmap_is_a_dense_7_by_24_weekday_hour_grid_over_the_chosen_range(self):
        grid = self.data("/hourly/heatmap")                       # Mar 2 - Mar 8
        cells = grid["cells"]
        self.assertEqual(len(cells), 168)
        self.assertEqual({(c["day_of_week"], c["hour"]) for c in cells}, {(d, hh) for d in range(7) for hh in range(24)})
        self.assertEqual([c["day_label"] for c in cells[::24]], ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"])
        cell = {(c["day_of_week"], c["hour"]): c for c in cells}
        mon10 = cell[(1, 10)]                                     # Mon Mar 2 10:15: 8 consumed, 2 no answer
        self.assertEqual((mon10["total_calls"], mon10["dropped_calls"], mon10["drop_pct"]), (10, 2, 20.0))
        self.assertEqual((cell[(3, 10)]["total_calls"], cell[(3, 10)]["drop_pct"]), (4, 100.0))   # Wed Mar 4: 4 failed
        self.assertEqual(cell[(2, 15)]["total_calls"], 2)          # Tue Mar 3
        self.assertEqual(cell[(5, 9)]["total_calls"], 1)           # Fri Mar 6
        self.assertEqual(sum(c["total_calls"] for c in cells), 17) # the Mar 20 call is outside the range
        self.assertEqual((grid["from_date"], grid["to_date"], grid["all_time"]), ("2026-03-02", "2026-03-08", False))

    def test_heatmap_with_no_range_is_all_time_and_adds_up_same_weekdays(self):
        insert_call(self.user, at(9, 10, 30), "customer-did-not-answer")      # another Monday 10:00 (Mar 9)
        r = client.get("/call-consumption/hourly/heatmap", params={"tz": "UTC"}, headers=auth(self.user))
        grid = r.json()["data"]
        cell = {(c["day_of_week"], c["hour"]): c for c in grid["cells"]}
        self.assertEqual((cell[(1, 10)]["total_calls"], cell[(1, 10)]["dropped_calls"]), (11, 3))  # both Mondays
        self.assertEqual(cell[(5, 12)]["total_calls"], 1)          # Fri Mar 20 12:00, now inside (all time)
        self.assertEqual(sum(c["total_calls"] for c in grid["cells"]), 19)
        self.assertTrue(grid["all_time"])
        self.assertIsNone(grid["from_date"])

    def test_heatmap_follows_the_other_filters_and_time_zone(self):
        g = self.data("/hourly/heatmap", campaign_ids=self.c2)
        self.assertEqual(sum(c["total_calls"] for c in g["cells"]), 2)
        khi = self.data("/hourly/heatmap", tz="Asia/Karachi")    # UTC+5: Mon 10:15 UTC is Mon 15:15
        cell = {(c["day_of_week"], c["hour"]): c for c in khi["cells"]}
        self.assertEqual(cell[(1, 15)]["total_calls"], 10)

    def test_heatmap_with_no_calls_is_still_a_full_zero_grid(self):
        g = self.data("/hourly/heatmap", user=self.other, **{"from": "2026-01-01", "to": "2026-01-02"})
        self.assertEqual(len(g["cells"]), 168)
        self.assertTrue(all(c["total_calls"] == 0 and c["drop_pct"] == 0 for c in g["cells"]))

    def test_hourly_export(self):
        r = client.get("/call-consumption/hourly/export.csv", params=q(), headers=auth(self.user))
        self.assertEqual(r.status_code, 200)
        self.assertIn("HourlyCallConsumptionReport.csv", r.headers["content-disposition"])
        lines = r.text.strip().split("\n")
        self.assertTrue(lines[0].startswith("Hour,Total Calls"))
        self.assertEqual(len(lines), 1 + 24 + 1)
        self.assertTrue(lines[-1].startswith("Total,17,10"))

    def test_unknown_widget_is_404(self):
        self.assertEqual(self.get("/hourly/pie").status_code, 404)
        self.assertEqual(self.get("/overview/pie").status_code, 404)


# ---------------------------------------------------------------------------------------------- weekly / monthly

def dt(m, d, h=9, mi=0, y=2026):
    return datetime(y, m, d, h, mi, tzinfo=UTC)


class Periods(Base):
    def setUp(self):
        super().setUp()
        insert_call(self.user, at(10, 9), "customer-ended-call")                       # Tue Mar 10
        insert_call(self.user, at(10, 9), "customer-ended-call")
        insert_call(self.user, at(22, 9), "pipeline-error-openai-llm-failed", secs=0)  # Sun Mar 22
        insert_call(self.user, dt(4, 6), "customer-ended-call")                        # Mon Apr 6

    def report(self, granularity, user=None, **kw):
        return self.data(f"/period/{granularity}", user, **kw)

    def test_weekly_rows_are_sunday_start_oldest_first_with_empty_weeks_as_zero_rows(self):
        r = self.report("weekly", **{"from": "2026-03-02", "to": "2026-04-10"})
        rows = r["rows"]
        self.assertEqual([x["start_date"] for x in rows],
                         ["2026-03-01", "2026-03-08", "2026-03-15", "2026-03-22", "2026-03-29", "2026-04-05"])
        self.assertEqual([x["end_date"] for x in rows][:2], ["2026-03-07", "2026-03-14"])
        self.assertEqual([x["name"] for x in rows][:2], ["Mar 1 - Mar 7, 2026", "Mar 8 - Mar 14, 2026"])
        # Mar 20 (from the base data) lands in the week of Mar 15.
        self.assertEqual([x["total_calls"] for x in rows], [17, 2, 1, 1, 0, 1])
        self.assertEqual(r["granularity"], "weekly")

    def test_each_row_compares_with_the_one_before_and_a_zero_row_has_nothing_to_compare_to(self):
        rows = self.report("weekly", **{"from": "2026-03-02", "to": "2026-04-10"})["rows"]
        self.assertIsNone(rows[0]["calls_change_pct"])
        self.assertIsNone(rows[0]["drop_pct_point_change"])
        self.assertEqual(rows[1]["calls_change_pct"], -88.2)             # (2-17)/17
        self.assertEqual(rows[1]["drop_pct_point_change"], -41.2)        # 0% dropped vs 41.18%
        self.assertEqual(rows[3]["calls_change_pct"], 0)                 # 1 -> 1
        self.assertEqual(rows[3]["drop_pct_point_change"], 100.0)        # 0% -> 100% dropped
        self.assertEqual(rows[4]["total_calls"], 0)
        self.assertEqual(rows[4]["calls_change_pct"], -100.0)            # 1 -> 0
        self.assertIsNone(rows[5]["calls_change_pct"])                   # previous week had no calls: no comparison
        self.assertIsNone(rows[5]["drop_pct_point_change"])

    def test_partial_marks_periods_cut_by_the_range_or_still_running(self):
        rows = self.report("weekly", **{"from": "2026-03-02", "to": "2026-04-10"})["rows"]
        self.assertEqual([x["partial"] for x in rows], [True, False, False, False, False, True])
        m = self.report("monthly", **{"from": "2026-03-01", "to": "2026-03-31"})["rows"]
        self.assertEqual([(x["name"], x["partial"]) for x in m], [("March 2026", False)])
        m = self.report("monthly", **{"from": "2026-03-02", "to": "2026-03-31"})["rows"]
        self.assertTrue(m[0]["partial"])                                  # starts Mar 1, range starts Mar 2

    def test_monthly_rows_and_totals(self):
        r = self.report("monthly", **{"from": "2026-03-01", "to": "2026-04-30"})
        self.assertEqual([(x["name"], x["total_calls"]) for x in r["rows"]], [("March 2026", 21), ("April 2026", 1)])
        self.assertEqual(r["rows"][1]["calls_change_pct"], -95.2)         # (1-21)/21
        self.assertEqual(r["total"]["total_calls"], 22)

    def test_the_period_that_contains_today_is_partial_even_when_the_range_covers_all_of_it(self):
        user = h.make_user("running")
        now = datetime.now(UTC)
        insert_call(user, now, "customer-ended-call")
        first = now.replace(day=1).date()
        last = (now.replace(day=28) + timedelta(days=4)).replace(day=1).date() - timedelta(days=1)
        rows = self.report("monthly", user=user, **{"from": first.isoformat(), "to": last.isoformat()})["rows"]
        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]["partial"])                               # the month is not over yet
        old = self.report("monthly", **{"from": "2026-03-01", "to": "2026-03-31"})["rows"]
        self.assertFalse(old[0]["partial"])                               # a finished month inside the range is complete

    def test_month_labels_cross_a_year_boundary(self):
        user = h.make_user("year")
        insert_call(user, dt(12, 31, y=2025), "customer-ended-call")
        insert_call(user, dt(1, 1), "customer-did-not-answer")
        rows = self.report("monthly", user=user, **{"from": "2025-12-01", "to": "2026-01-31"})["rows"]
        self.assertEqual([x["name"] for x in rows], ["December 2025", "January 2026"])
        self.assertEqual([x["end_date"] for x in rows], ["2025-12-31", "2026-01-31"])

    def test_percentages_are_weighted_and_every_row_adds_up(self):
        r = self.report("weekly", **{"from": "2026-03-02", "to": "2026-04-10"})
        for x in r["rows"] + [r["total"]]:
            self.assertEqual(x["consumed_calls"] + x["dropped_calls"], x["total_calls"])
            self.assertEqual(sum(x["buckets"].values()), x["dropped_calls"])
        t = r["total"]
        self.assertEqual(t["total_calls"], sum(x["total_calls"] for x in r["rows"]))
        self.assertEqual(t["drop_pct"], round(t["dropped_calls"] / t["total_calls"] * 100, 2))

    def test_timezone_decides_which_week_a_call_belongs_to(self):
        user = h.make_user("tzweek")
        insert_call(user, dt(3, 7, 23, 30), "customer-ended-call")        # Sat 23:30 UTC = Sun 04:30 in Karachi
        utc = self.report("weekly", user=user, tz="UTC", **{"from": "2026-03-01", "to": "2026-03-31"})["rows"]
        khi = self.report("weekly", user=user, tz="Asia/Karachi", **{"from": "2026-03-01", "to": "2026-03-31"})["rows"]
        self.assertEqual(utc[0]["start_date"], "2026-03-01")
        self.assertEqual(khi[0]["start_date"], "2026-03-08")

    def test_filters_apply_and_nothing_means_all_time(self):
        r = self.report("weekly", campaign_ids=self.c1, **{"from": "2026-03-02", "to": "2026-03-08"})
        self.assertEqual(r["total"]["total_calls"], 14)
        allr = client.get("/call-consumption/period/monthly", params={"tz": "UTC"}, headers=auth(self.user)).json()["data"]
        self.assertEqual(allr["total"]["total_calls"], 22)
        self.assertEqual([x["name"] for x in allr["rows"]], ["March 2026", "April 2026"])

    def test_empty_range_has_no_rows(self):
        r = self.report("weekly", user=self.other, **{"from": "2026-01-01", "to": "2026-01-02"})
        self.assertEqual((r["has_data"], r["rows"]), (False, []))

    def test_csv_export_matches_the_screen_newest_first(self):
        params = q(**{"from": "2026-03-02", "to": "2026-04-10"})
        r = client.get("/call-consumption/period/weekly/export.csv", params=params, headers=auth(self.user))
        self.assertEqual(r.status_code, 200)
        self.assertIn("WeeklyCallConsumptionReport.csv", r.headers["content-disposition"])
        lines = r.text.strip().split("\n")
        self.assertTrue(lines[0].startswith("Week,Total Calls,Consumed"))
        self.assertTrue(lines[0].endswith("Calls vs previous,Drop rate vs previous"))
        # The label has a comma, so the CSV quotes it.
        self.assertTrue(lines[1].startswith('"Apr 5 - Apr 11, 2026 (in progress / partial)",1,1'))
        self.assertEqual(len(lines), 1 + 6 + 1)
        self.assertTrue(lines[-1].startswith("Total,22,"))
        m = client.get("/call-consumption/period/monthly/export.csv", params=params, headers=auth(self.user))
        self.assertIn("MonthlyCallConsumptionReport.csv", m.headers["content-disposition"])

    def test_empty_export_and_unknown_granularity_are_404(self):
        empty = q(**{"from": "2026-01-01", "to": "2026-01-02"})
        self.assertEqual(client.get("/call-consumption/period/weekly/export.csv", params=empty, headers=auth(self.user)).status_code, 404)
        self.assertEqual(self.get("/period/yearly").status_code, 404)
        self.assertEqual(client.get("/call-consumption/period/yearly/export.csv", params=q(), headers=auth(self.user)).status_code, 404)

    def test_other_accounts_cannot_see_these_rows(self):
        r = self.report("weekly", user=self.other, **{"from": "2026-03-02", "to": "2026-03-08"})
        self.assertEqual(r["total"]["total_calls"], 1)                    # only their own call


# ---------------------------------------------------------------------------------------------- access + validation

class Access(Base):
    def test_requires_login(self):
        self.assertIn(client.get("/call-consumption/overview/kpis", params=q()).status_code, (401, 403))

    def test_each_account_sees_only_its_own_calls(self):
        self.assertEqual(self.data("/overview/kpis", user=self.other)["total_calls"], 1)       # their own single call
        self.assertEqual(self.data("/overview/kpis")["total_calls"], 17)

    def test_a_team_member_sees_the_owners_data(self):
        member = h.make_user("viewer")
        supabase.table("team_members").insert({"owner_id": self.user, "member_user_id": member,
                                               "member_email": f"m-{uuid.uuid4().hex[:8]}@qa.test",
                                               "role": "viewer", "status": "Active"}).execute()
        self.assertEqual(self.data("/overview/kpis", user=member)["total_calls"], 17)
        self.assertEqual(self.data("/filters", user=member)["verticals"], ["Insurance", "Real Estate"])

    def test_filter_options(self):
        f = self.data("/filters")
        self.assertEqual([c["name"] for c in f["campaigns"]], ["Listings", "Spring Push"])
        self.assertEqual([a["name"] for a in f["agents"]], ["Max", "Sara"])
        self.assertEqual(f["verticals"], ["Insurance", "Real Estate"])
        self.assertEqual([d["value"] for d in f["dispositions"]], ["consumed", *cc.DROP_BUCKETS])
        self.assertEqual(self.data("/filters", user=self.other)["campaigns"], [])               # not someone else's

    def test_a_forged_campaign_filter_cannot_reach_another_accounts_calls(self):
        t = self.data("/overview/summary", user=self.other, campaign_ids=self.c1)["total"]
        self.assertEqual(t["total_calls"], 0)

    def test_validation(self):
        for params in ({"tz": "Mars/Base"}, {"from": "2026-03-09", "to": "2026-03-02"}, {"disposition": "meh"},
                       {"direction": "sideways"}, {"campaign_ids": "not-a-uuid"}, {"agent_id": "nope"},
                       {"from": "2024-01-01", "to": "2026-03-08"}, {"from": "garbage"}):
            with self.subTest(params):
                r = self.get("/overview/kpis", **params)
                self.assertIn(r.status_code, (400, 422), r.text)

    def test_no_dates_means_all_time(self):
        r = client.get("/call-consumption/overview/kpis", params={"tz": "UTC"}, headers=auth(self.user))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["data"]["total_calls"], 18)          # the 17 in the week plus the Mar 20 one
        k = client.get("/call-consumption/hourly/kpis", params={"tz": "UTC"}, headers=auth(self.user)).json()["data"]
        self.assertEqual(k["date_range_label"], "All Time")
        only_to = client.get("/call-consumption/overview/kpis", params={"tz": "UTC", "to": "2026-03-08"}, headers=auth(self.user))
        self.assertEqual(only_to.json()["data"]["total_calls"], 17)

    def test_sql_injection_in_filters_is_inert(self):
        for evil in ("'; drop table conversations; --", "x' or '1'='1"):
            r = self.get("/overview/summary", vertical=evil)
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.json()["data"]["total"]["total_calls"], 0)
        self.assertEqual(self.data("/overview/kpis")["total_calls"], 17)


# ---------------------------------------------------------------------------------------------- rule engine

def seg(name, total, dropped, key=None):
    t = cc.Tally()
    t.add("consumed", total - dropped)
    t.add("no_answer", dropped)
    return cc.Segment(key or name, name, t)


def hours(spec):
    out = {}
    for hr, (total, dropped) in spec.items():
        t = cc.Tally()
        t.add("consumed", total - dropped)
        t.add("no_answer", dropped)
        out[hr] = t
    return out


def overall(total, dropped):
    return seg("all", total, dropped).tally


class Insights(unittest.TestCase):
    def build(self, ov=None, campaigns=(), verticals=(), states=(), hrs=None, prev=None):
        return cc.build_insights(ov or overall(100, 20), list(campaigns), list(verticals), list(states),
                                 hrs or {}, prev or {})

    def badges(self, cards):
        return [c["badge"] for c in cards]

    def test_no_data(self):
        for ov in (None, cc.Tally()):
            self.assertEqual(self.badges(cc.build_insights(ov, [], [], [], {}, {})), ["NO DATA"])

    def test_healthy_fallback_only_when_no_risk_fired(self):
        calm = self.build(verticals=[seg("Insurance", 10, 0)], campaigns=[seg("A", 10, 0)])
        self.assertEqual(self.badges(calm)[-1], "HEALTHY")
        self.assertEqual(calm[-1]["action_label"], None)
        risky = self.build(verticals=[seg("Insurance", 10, 5), seg("Legal", 10, 0)])
        self.assertNotIn("HEALTHY", self.badges(risky))

    def test_worst_vertical_state_and_hour(self):
        cards = self.build(verticals=[seg("Insurance", 20, 10), seg("Legal", 20, 2)],
                           states=[seg("Texas", 20, 8, "TX"), seg("Ohio", 20, 1, "OH")],
                           hrs=hours({9: (20, 1), 14: (20, 12)}))
        by = {c["badge"]: c for c in cards}
        self.assertEqual(by["WORST VERTICAL"]["title"], "Insurance is now the worst vertical at 50.0% drop.")
        self.assertEqual(by["WORST STATE"]["title"], "Texas leads all states at 40.0% drop.")
        self.assertEqual(by["HOTSPOT"]["title"], "02:00 PM experienced a 60.0% drop rate.")

    def test_rate_rules_ignore_tiny_segments_and_zero_drop(self):
        cards = self.build(verticals=[seg("Tiny", 2, 2), seg("Clean", 50, 0)], states=[seg("Texas", 3, 3, "TX")])
        self.assertTrue({"WORST VERTICAL", "WORST STATE"}.isdisjoint(self.badges(cards)))

    def test_unknown_state_is_never_called_out(self):
        cards = self.build(states=[seg("Unknown", 50, 40, UNKNOWN_STATE), seg("Ohio", 20, 1, "OH")])
        self.assertFalse([c for c in cards if "Unknown" in c["title"]])

    def test_anomaly_needs_a_real_outlier(self):
        flat = {h_: (20, 4) for h_ in range(9, 17)}
        self.assertNotIn("ANOMALY", self.badges(self.build(hrs=hours(flat))))
        spike = {**flat, 12: (20, 19)}
        cards = self.build(hrs=hours(spike))
        a = next(c for c in cards if c["badge"] == "ANOMALY")
        self.assertEqual(a["title"], "Anomaly: 12:00 PM drop rate spiked to 95%.")
        self.assertEqual(a["action_label"], "Likely")
        self.assertNotIn("ANOMALY", self.badges(self.build(hrs=hours({10: (20, 18)}))))      # needs >= 2 hours

    def test_volume_and_concentration(self):
        cards = self.build(ov=overall(100, 0), campaigns=[seg("Big", 40, 0), seg("Small", 5, 0)],
                           verticals=[seg("Insurance", 60, 0)], states=[seg("Texas", 25, 0, "TX")])
        titles = [c["title"] for c in cards]
        self.assertIn("Big is the highest-volume campaign.", titles)
        self.assertIn("Big contributed 40% of all traffic.", titles)
        self.assertIn("Insurance accounts for 60% of total traffic.", titles)
        self.assertIn("Texas is the highest-volume state.", titles)
        self.assertIn("Texas generated over 25% of total calls.", titles)
        below = self.build(ov=overall(100, 0), campaigns=[seg("A", 14, 0)], verticals=[seg("V", 29, 0)], states=[seg("S", 19, 0, "TX")])
        self.assertTrue({"CONCENTRATION", "TRAFFIC SHARE"}.isdisjoint(self.badges(below)))
        self.assertNotIn("Texas generated", " ".join(c["title"] for c in below))

    def test_peak_lowest_and_bright_hours(self):
        cards = self.build(hrs=hours({9: (30, 1), 11: (10, 6), 15: (40, 4)}))
        by = {c["badge"]: c["title"] for c in cards}
        self.assertEqual(by["PEAK HOUR"], "03:00 PM recorded the highest traffic.")
        self.assertEqual(by["BRIGHT SPOT"], "09:00 AM achieved the highest consumption rate at 96.67%.")
        # 11 AM is the worst hour both by drop rate and by consumption: said once, as the hotspot.
        self.assertIn("HOTSPOT", by)
        self.assertNotIn("CONSUMPTION", by)

    def test_vertical_trend_surge_and_decline(self):
        cards = self.build(verticals=[seg("Insurance", 130, 0), seg("Legal", 60, 0), seg("Auto", 100, 0)],
                           prev={"Insurance": overall(100, 0), "Legal": overall(100, 0), "Auto": overall(100, 0)})
        by = {c["badge"]: c["title"] for c in cards}
        self.assertEqual(by["TREND"], "Insurance traffic increased by 30%.")
        self.assertEqual(by["DECLINING"], "Legal traffic declined by 40%.")
        quiet = self.build(verticals=[seg("Auto", 110, 0)], prev={"Auto": overall(100, 0)})
        self.assertTrue({"TREND", "DECLINING"}.isdisjoint(self.badges(quiet)))
        no_history = self.build(verticals=[seg("Auto", 110, 0)], prev={"Auto": overall(2, 0)})
        self.assertTrue({"TREND", "DECLINING"}.isdisjoint(self.badges(no_history)))

    def test_cards_come_back_in_priority_order(self):
        cards = self.build(ov=overall(100, 30), campaigns=[seg("Big", 40, 12)], verticals=[seg("Insurance", 60, 30)],
                           states=[seg("Texas", 25, 10, "TX")], hrs=hours({9: (30, 1), 11: (10, 6)}))
        order = ["WORST VERTICAL", "WORST STATE", "HOTSPOT", "HIGHEST VOLUME", "TOP VERTICAL", "TOP STATE"]
        got = [order.index(b) for b in self.badges(cards) if b in order]
        self.assertGreaterEqual(len(got), 5)
        self.assertEqual(got, sorted(got))


class Hotspots(unittest.TestCase):
    def test_worst_and_best_per_dimension_then_global_sort(self):
        occ = {(date(2026, 3, 2), 10): hours({0: (10, 5)})[0], (date(2026, 3, 3), 11): hours({0: (10, 1)})[0],
               (date(2026, 3, 4), 12): hours({0: (4, 4)})[0]}                                  # under the floor
        rows = cc.build_hotspots(occ, [seg("A", 10, 1), seg("B", 10, 6)], [seg("V", 20, 4)],
                                 [seg("Texas", 10, 3, "TX"), seg("Unknown", 50, 49, UNKNOWN_STATE)])
        by = {(r["dimension"], r["row_type"]): r for r in rows}
        self.assertEqual((by[("Hour", "Worst")]["segment"], by[("Hour", "Worst")]["segment_sub_label"]), ("10:00 AM", "Mon Mar 2"))
        self.assertEqual(by[("Hour", "Best")]["segment"], "11:00 AM")
        self.assertEqual((by[("Campaign", "Worst")]["segment"], by[("Campaign", "Best")]["segment"]), ("B", "A"))
        self.assertEqual(by[("State", "Worst")]["segment"], "Texas")                             # Unknown never listed
        self.assertEqual(len(rows), 8)
        rates = [r["drop_rate_pct"] for r in rows]
        self.assertEqual(rates, sorted(rates, reverse=True))
        # Sorted by drop rate across ALL dimensions, so a "Best" row can still sit above another dimension's "Worst".

    def test_a_dimension_with_no_candidate_is_skipped(self):
        rows = cc.build_hotspots({}, [seg("A", 4, 1)], [], [])
        self.assertEqual(rows, [])


class Csv(unittest.TestCase):
    def test_summary_csv_quotes_commas_and_indents_children(self):
        t = cc.Tally()
        t.add("consumed", 3)
        t.add("failed", 1)
        node = {"name": "Parent, Inc", **t.row(2), "children": [{"name": "kid", **t.row(2)}]}
        out = cc.summary_csv({"rows": [node], "total": {"name": "Total", **t.row(2)}})
        lines = out.strip().split("\n")
        self.assertEqual(lines[1].split('",')[0], '"Parent, Inc')
        self.assertTrue(lines[2].startswith("  kid,4,3,75.0%,1,25.0%"))
        self.assertTrue(lines[3].startswith("Total,4,3"))


# ---------------------------------------------------------------------------------------------- webhook stores the reason

class EndedReasonIsStored(unittest.TestCase):
    def setUp(self):
        h.reset_rate_limits()
        self.vapi = h.VapiMock().start()
        self.user = h.make_user()
        self.agent = h.create_agent_via_api(self.user)
        self.asst = self.agent["vapi_assistant_id"]
        self.call = f"call-{uuid.uuid4().hex[:8]}"

    def tearDown(self):
        self.vapi.stop()

    def reason(self):
        return h.sql("select ended_reason, status from conversations where vapi_call_id=%s", (self.call,))[0]

    def test_end_of_call_report_stores_it(self):
        h.make_conversation(self.user, self.call, self.agent["id"])
        r = client.post("/webhooks/vapi", json=h.end_of_call_body(self.asst, self.call, "customer-did-not-answer", 0))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.reason(), ("customer-did-not-answer", "No Answer"))

    def test_a_call_with_no_row_yet_gets_one_with_the_reason(self):
        client.post("/webhooks/vapi", json=h.end_of_call_body(self.asst, self.call, "voicemail", 12))
        self.assertEqual(self.reason(), ("voicemail", "No Answer"))

    def test_import_from_vapi_stores_it_and_a_reimport_without_one_keeps_it(self):
        call = {"id": self.call, "assistantId": self.asst, "type": "outboundPhoneCall",
                "endedReason": "customer-busy", "startedAt": "2026-03-02T10:00:00Z", "artifact": {}, "durationSeconds": 0}
        with patch.object(webhooks, "record_call_cost", return_value=0):
            webhooks.import_vapi_call(call, self.user)
            self.assertEqual(self.reason(), ("customer-busy", "No Answer"))
            webhooks.import_vapi_call({k: v for k, v in call.items() if k != "endedReason"}, self.user)
        self.assertEqual(self.reason()[0], "customer-busy")

    def test_a_real_call_flows_into_the_report(self):
        for _ in range(2):
            call = f"call-{uuid.uuid4().hex[:8]}"
            client.post("/webhooks/vapi", json=h.end_of_call_body(self.asst, call, "customer-did-not-answer", 0))
        client.post("/webhooks/vapi", json=h.end_of_call_body(self.asst, f"call-{uuid.uuid4().hex[:8]}", "customer-ended-call", 40))
        today = datetime.now(UTC).date().isoformat()
        r = client.get("/call-consumption/overview/summary", params={"from": today, "to": today, "tz": "UTC"},
                       headers=auth(self.user))
        self.assertEqual(r.status_code, 200, r.text)
        total = r.json()["data"]["total"]
        self.assertEqual((total["total_calls"], total["consumed_calls"], total["buckets"]["no_answer"]), (3, 1, 2))


if __name__ == "__main__":
    unittest.main()
