"""
Dashboard home (services/dashboard_overview.py, routers/dashboard.py: GET /dashboard/overview).

Covered: the headline tiles agree with the Cost per Lead report for the same window (the reuse guarantee), the answered
rate / minutes / cost per qualified lead (None, never 0, with no qualified lead), the change against the previous range
(and none when that range was empty), today / 7d / 30d windows, the zero-filled trend (at least 7 days), sample rows and
other accounts left out, the running campaigns (with what the dialer says), the account inventory, the Top campaigns / agents / receptionists tables, the live strip (calls running now, calls today), the first-steps checklist, team members and
Viewers seeing the owner's numbers, and the 400s.

Run from the backend folder:  python -m unittest discover -s tests -p "test_dashboard_overview.py" -v
"""
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import qa_harness as h
from qa_harness import client, auth
from database import supabase
from services import dashboard_overview as dash
from services import lead_roi as lr
from services import call_consumption as cc

UTC = timezone.utc
TZ = "UTC"


def today():
    return datetime.now(ZoneInfo(TZ)).date()


def noon(days_ago=0):
    """Noon UTC, `days_ago` days back: safely inside that calendar day whatever time the suite runs."""
    d = today() - timedelta(days=days_ago)
    return datetime(d.year, d.month, d.day, 12, 0, tzinfo=UTC)


def insert_call(user, when, cost=0.5, qualified=False, campaign=None, status="Completed", seconds=60,
                contact="Pat", phone="+15551234567", ended_reason="customer-ended-call", direction="outbound",
                agent=None, contact_id=None, number=None):
    return h.sql(
        "insert into conversations (user_id, channel, status, call_time, call_cost, qualified, campaign_id, contact_name,"
        " phone, duration_seconds, ended_reason, direction, agent_id, contact_id, phone_number_id)"
        " values (%s,'Phone',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) returning id",
        (user, status, when, cost, qualified, campaign, contact, phone, seconds, ended_reason, direction, agent, contact_id, number))[0][0]


class Base(unittest.TestCase):
    """An owner with a known set of calls (all times are noon UTC of the day shown, viewer zone UTC):

    today        4 calls at $0.50: 3 finished (consumed), 1 No Answer; 1 qualified; 60 s each (= 4 min)
    1 day ago    2 calls at $1.00 (yesterday: the previous range of "today"), 1 qualified, 30 s each
    3 days ago   2 calls at $0.50, none qualified
    20 days ago  1 call at $2.00, qualified
    Left out on purpose: a [SAMPLE] call today and another account's call today."""

    def setUp(self):
        h.reset_rate_limits()
        self.user = h.make_user()
        self.other = h.make_user("other")
        for i in range(3):
            insert_call(self.user, noon(0), 0.5, qualified=i == 0)
        insert_call(self.user, noon(0), 0.5, status="No Answer", seconds=0, ended_reason="customer-did-not-answer")
        insert_call(self.user, noon(1), 1.0, qualified=True, seconds=30)
        insert_call(self.user, noon(1), 1.0, seconds=30)
        insert_call(self.user, noon(3), 0.5)
        insert_call(self.user, noon(3), 0.5)
        insert_call(self.user, noon(20), 2.0, qualified=True)
        insert_call(self.user, noon(0), 9.99, qualified=True, contact="[SAMPLE] Demo")
        insert_call(self.other, noon(0), 4.0, qualified=True)

    def drop_sample_row(self):
        """The answered rate comes from Call Consumption, which (unlike Cost per Lead) does not leave [SAMPLE] rows out."""
        h.sql("delete from conversations where contact_name like '[SAMPLE]%%'")

    def get(self, user=None, **kw):
        params = {"range": "7d", "tz": TZ}
        params.update(kw)
        return client.get("/dashboard/overview", params=params, headers=auth(user or self.user))

    def data(self, user=None, **kw):
        r = self.get(user, **kw)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["data"]


class Tiles(Base):
    def test_today_tiles(self):
        self.drop_sample_row()
        t = self.data(range="today")["tiles"]
        self.assertTrue(t["has_data"] and t["has_previous"])
        self.assertEqual(t["calls"]["value"], 4)
        self.assertEqual(t["spend"]["value"], 2.0)
        self.assertEqual(t["qualified_leads"]["value"], 1)
        self.assertEqual(t["cost_per_qualified_lead"]["value"], 2.0)
        self.assertEqual(t["minutes"]["value"], 3.0)                      # 3 answered calls x 60 s
        self.assertEqual(t["answered_rate"]["value"], 75.0)               # 3 of 4 finished calls were consumed
        self.assertEqual((t["answered_rate"]["answered"], t["answered_rate"]["finished"]), (3, 4))

    def test_the_calls_nobody_answered_are_split_by_why(self):
        self.drop_sample_row()
        insert_call(self.user, noon(0), status="No Answer", seconds=0, ended_reason="customer-did-not-answer")
        insert_call(self.user, noon(0), status="No Answer", seconds=0, ended_reason="customer-busy")
        insert_call(self.user, noon(0), status="Failed", seconds=0, ended_reason="twilio-failed-to-connect-call")
        insert_call(self.user, noon(0), status="Completed", seconds=12, ended_reason="voicemail")
        insert_call(self.user, noon(0), status="Completed", seconds=1, ended_reason="customer-ended-call")      # hung up at once
        rate = self.data(range="today")["tiles"]["answered_rate"]
        na = rate["not_answered"]
        self.assertEqual(na["buckets"], {"no_answer": 2, "busy": 1, "voicemail": 1, "hung_up": 1, "blocked": 0, "failed": 1})
        self.assertEqual(na["total"], 6)                                            # setUp's own No Answer + these five
        self.assertEqual(rate["answered"] + na["total"], rate["finished"])          # nothing lost, nothing counted twice

    def test_the_split_matches_call_consumption_for_the_same_dates(self):
        self.drop_sample_row()
        insert_call(self.user, noon(0), status="Failed", seconds=0, ended_reason="assistant-error")
        na = self.data(range="7d")["tiles"]["answered_rate"]["not_answered"]
        flt = cc.Filters(from_date=today() - timedelta(days=6), to_date=today(), tz=TZ)
        total = cc._sum_tallies(cc._tally_rows(cc.fetch(self.user, flt, ("day",)), lambda r: r["day"]).values())
        self.assertEqual((na["total"], na["buckets"]), (total.dropped, total.buckets))

    def test_nothing_unanswered_is_an_empty_split_not_an_error(self):
        na = self.data(user=h.make_user("bare"), range="today")["tiles"]["answered_rate"]["not_answered"]
        self.assertEqual((na["total"], sum(na["buckets"].values())), (0, 0))

    def test_change_is_against_the_equally_long_range_before(self):
        t = self.data(range="today")["tiles"]                              # previous = yesterday: 2 calls, $2.00, 1 qualified
        self.assertEqual(t["calls"]["previous"], 2)
        self.assertEqual(t["calls"]["change_pct"], 100.0)
        self.assertEqual(t["spend"]["change_pct"], 0.0)
        self.assertEqual(t["qualified_leads"]["change_pct"], 0.0)
        self.assertEqual(t["cost_per_qualified_lead"]["change_pct"], 0.0)  # $2.00 / 1 against $2.00 / 1
        self.assertEqual(t["minutes"]["previous"], 1.0)

    def test_seven_and_thirty_day_windows(self):
        seven = self.data(range="7d")["tiles"]
        self.assertEqual((seven["calls"]["value"], seven["spend"]["value"], seven["qualified_leads"]["value"]), (8, 5.0, 2))
        self.assertEqual(seven["cost_per_qualified_lead"]["value"], 2.5)
        thirty = self.data(range="30d")["tiles"]
        self.assertEqual((thirty["calls"]["value"], thirty["spend"]["value"], thirty["qualified_leads"]["value"]), (9, 7.0, 3))
        self.assertEqual(thirty["cost_per_qualified_lead"]["value"], 2.33)

    def test_tiles_equal_the_cost_per_lead_report_for_the_same_window(self):
        """The reuse guarantee: spend, leads and ratios are the Cost per Lead report's own figures."""
        for key, days in (("today", 1), ("7d", 7), ("30d", 30)):
            tiles = self.data(range=key)["tiles"]
            report = lr.kpis(self.user, cc.Filters(from_date=today() - timedelta(days=days - 1), to_date=today(), tz=TZ))
            self.assertEqual(tiles["calls"]["value"], report["calls"], key)
            self.assertEqual(tiles["spend"]["value"], report["spend"], key)
            self.assertEqual(tiles["leads"]["value"], report["leads"], key)
            self.assertEqual(tiles["qualified_leads"]["value"], report["qualified_leads"], key)
            self.assertEqual(tiles["cost_per_qualified_lead"]["value"], report["cost_per_qualified_lead"], key)
            self.assertEqual(tiles["calls"]["change_pct"], None if not report["has_previous"] else
                             lr._change_pct(report["calls"], lr.kpis(self.user, cc.Filters(
                                 from_date=today() - timedelta(days=2 * days - 1),
                                 to_date=today() - timedelta(days=days), tz=TZ))["calls"]), key)

    def test_no_qualified_lead_means_no_cost_per_qualified_lead_not_zero(self):
        h.sql("update conversations set qualified = false where user_id = %s", (self.user,))
        t = self.data(range="7d")["tiles"]
        self.assertEqual(t["qualified_leads"]["value"], 0)
        self.assertIsNone(t["cost_per_qualified_lead"]["value"])
        self.assertIsNone(t["cost_per_qualified_lead"]["change_pct"])

    def test_an_empty_previous_range_has_no_change(self):
        t = self.data(range="30d")["tiles"]                               # the 30 days before that have no calls
        self.assertFalse(t["has_previous"])
        for tile in ("calls", "spend", "qualified_leads", "minutes", "cost_per_qualified_lead"):
            self.assertIsNone(t[tile]["change_pct"], tile)
        self.assertIsNone(t["answered_rate"]["change_pts"])

    def test_an_account_with_no_calls(self):
        empty = h.make_user("empty")
        d = self.data(user=empty)
        t = d["tiles"]
        self.assertFalse(t["has_data"])
        self.assertEqual((t["calls"]["value"], t["spend"]["value"], t["minutes"]["value"]), (0, 0.0, 0.0))
        self.assertIsNone(t["answered_rate"]["value"])                    # nothing finished: no rate, not 0%
        self.assertIsNone(t["cost_per_qualified_lead"]["value"])
        self.assertEqual(d["trend"] and sum(p["calls"] for p in d["trend"]), 0)

    def test_answered_rate_change_is_in_points(self):
        self.drop_sample_row()
        t = self.data(range="today")["tiles"]                              # 75% today; yesterday 2 of 2 consumed = 100%
        self.assertEqual(t["answered_rate"]["previous"], 100.0)
        self.assertEqual(t["answered_rate"]["change_pts"], -25.0)

    def test_sample_rows_and_other_accounts_are_left_out(self):
        self.assertEqual(self.data(range="today")["tiles"]["calls"]["value"], 4)
        self.assertEqual(self.data(user=self.other, range="today")["tiles"]["calls"]["value"], 1)

    def test_leads_include_callbacks_like_the_report(self):
        cid = h.sql("select id from conversations where user_id = %s and qualified = false and status = 'Completed'"
                    " and call_time = %s limit 1", (self.user, noon(0)))[0][0]
        h.sql("insert into callbacks (user_id, conversation_id, due_at) values (%s,%s,now())", (self.user, cid))
        t = self.data(range="today")["tiles"]
        self.assertEqual((t["leads"]["value"], t["qualified_leads"]["value"]), (2, 1))


class CustomRange(Base):
    def custom(self, frm, to, user=None, **kw):
        return self.get(user, range="custom", **{"from": frm.isoformat(), "to": to.isoformat()}, **kw)

    def test_a_custom_range_sums_just_those_days(self):
        d = self.custom(today() - timedelta(days=3), today() - timedelta(days=1)).json()["data"]         # 3 days ago .. yesterday
        self.assertEqual((d["range"], d["from"], d["to"]), ("custom", (today() - timedelta(days=3)).isoformat(), (today() - timedelta(days=1)).isoformat()))
        t = d["tiles"]
        self.assertEqual((t["calls"]["value"], t["spend"]["value"], t["qualified_leads"]["value"]), (4, 3.0, 1))   # 2 + 2 calls
        self.assertEqual(t["minutes"]["value"], 3.0)                                                              # 2 x 30 s + 2 x 60 s

    def test_a_single_day_custom_range_equals_that_day(self):
        d = self.custom(today() - timedelta(days=1), today() - timedelta(days=1)).json()["data"]["tiles"]
        self.assertEqual((d["calls"]["value"], d["spend"]["value"], d["qualified_leads"]["value"]), (2, 2.0, 1))

    def test_the_previous_range_is_the_equally_long_one_just_before(self):
        d = self.custom(today() - timedelta(days=1), today()).json()["data"]["tiles"]                  # yesterday + today
        self.assertEqual(d["calls"]["value"], 6)
        self.assertEqual(d["calls"]["previous"], 2 + 0)                                                # 3 days ago..2 days ago: 2 calls on day 3
        self.assertTrue(d["has_previous"])

    def test_it_matches_the_cost_per_lead_report_for_the_same_dates(self):
        frm, to = today() - timedelta(days=10), today() - timedelta(days=2)
        t = self.custom(frm, to).json()["data"]["tiles"]
        report = lr.kpis(self.user, cc.Filters(from_date=frm, to_date=to, tz=TZ))
        self.assertEqual((t["calls"]["value"], t["spend"]["value"], t["qualified_leads"]["value"], t["cost_per_qualified_lead"]["value"]),
                         (report["calls"], report["spend"], report["qualified_leads"], report["cost_per_qualified_lead"]))

    def test_a_range_in_the_past_still_gets_a_trend_ending_on_its_last_day(self):
        d = self.custom(today() - timedelta(days=5), today() - timedelta(days=2)).json()["data"]
        self.assertEqual(d["trend"][-1]["date"], (today() - timedelta(days=2)).isoformat())
        self.assertGreaterEqual(len(d["trend"]), 7)

    def test_a_long_range_has_a_point_for_every_day(self):
        d = self.custom(today() - timedelta(days=59), today()).json()["data"]
        self.assertEqual(len(d["trend"]), 60)
        self.assertEqual(sum(p["calls"] for p in d["trend"]), 9)

    def test_a_range_with_no_calls_is_empty_not_an_error(self):
        d = self.custom(today() - timedelta(days=200), today() - timedelta(days=190)).json()["data"]
        self.assertFalse(d["tiles"]["has_data"])
        self.assertEqual(d["tiles"]["calls"]["value"], 0)

    def test_bad_ranges_get_a_plain_400(self):
        r = self.get(range="custom")
        self.assertEqual((r.status_code, r.json()["detail"]), (400, "Pick both a start and an end date."))
        r = self.get(range="custom", **{"from": today().isoformat()})
        self.assertEqual(r.status_code, 400)
        r = self.custom(today(), today() - timedelta(days=1))
        self.assertEqual((r.status_code, r.json()["detail"]), (400, "The start date must be on or before the end date."))
        r = self.custom(today() - timedelta(days=366), today())
        self.assertEqual((r.status_code, r.json()["detail"]), (400, f"Pick a range of at most {dash.cc.MAX_RANGE_DAYS} days."))
        self.assertEqual(self.custom(today() - timedelta(days=365), today()).status_code, 200)       # exactly a year is fine
        self.assertEqual(self.get(range="custom", **{"from": "nope", "to": "2026-01-01"}).status_code, 422)

    def test_an_end_date_in_the_future_is_cut_at_today(self):
        d = self.custom(today() - timedelta(days=3), today() + timedelta(days=20)).json()["data"]
        self.assertEqual((d["from"], d["to"]), ((today() - timedelta(days=3)).isoformat(), today().isoformat()))
        self.assertEqual(d["tiles"]["calls"]["value"], 8)                  # 3 days ago .. today: 2 + 0 + 2 + 4
        self.assertEqual(d["trend"][-1]["date"], today().isoformat())      # no empty future days on the chart

    def test_the_comparison_after_a_cut_is_the_same_number_of_days_before(self):
        cut = self.custom(today() - timedelta(days=1), today() + timedelta(days=30)).json()["data"]["tiles"]      # yesterday + today
        exact = self.custom(today() - timedelta(days=1), today()).json()["data"]["tiles"]
        self.assertEqual((cut["calls"]["value"], cut["calls"]["previous"]), (exact["calls"]["value"], exact["calls"]["previous"]))

    def test_a_range_that_starts_in_the_future_is_refused(self):
        r = self.custom(today() + timedelta(days=1), today() + timedelta(days=5))
        self.assertEqual((r.status_code, r.json()["detail"]), (400, "The start date is in the future."))

    def test_from_and_to_are_ignored_for_the_fixed_ranges(self):
        d = self.get(range="today", **{"from": "2020-01-01", "to": "2020-01-02"}).json()["data"]
        self.assertEqual((d["range"], d["tiles"]["calls"]["value"]), ("today", 4))

    def test_other_accounts_and_viewers(self):
        self.assertEqual(self.custom(today() - timedelta(days=1), today(), user=self.other).json()["data"]["tiles"]["calls"]["value"], 1)
        m = h.make_user("viewer")
        supabase.table("team_members").insert({"owner_id": self.user, "member_user_id": m, "role": "viewer", "status": "Active",
                                               "member_email": f"m-{uuid.uuid4().hex[:8]}@qa.test"}).execute()
        self.assertEqual(self.custom(today() - timedelta(days=1), today(), user=m).json()["data"]["tiles"]["calls"]["value"], 6)


class Trend(Base):
    def test_trend_is_dense_oldest_first_and_zero_filled(self):
        trend = self.data(range="7d")["trend"]
        self.assertEqual(len(trend), 7)
        self.assertEqual([p["date"] for p in trend], [(today() - timedelta(days=i)).isoformat() for i in range(6, -1, -1)])
        by_date = {p["date"]: p for p in trend}
        self.assertEqual((by_date[today().isoformat()]["calls"], by_date[today().isoformat()]["qualified_leads"]), (4, 1))
        self.assertEqual(by_date[(today() - timedelta(days=2)).isoformat()]["calls"], 0)
        self.assertEqual(by_date[(today() - timedelta(days=3)).isoformat()]["calls"], 2)

    def test_each_day_carries_what_the_tile_sparklines_need(self):
        self.drop_sample_row()
        by_date = {p["date"]: p for p in self.data(range="7d")["trend"]}
        day = by_date[today().isoformat()]
        self.assertEqual((day["spend"], day["minutes"], day["answered"], day["finished"]), (2.0, 3.0, 3, 4))
        quiet = by_date[(today() - timedelta(days=2)).isoformat()]
        self.assertEqual((quiet["spend"], quiet["minutes"], quiet["answered"], quiet["finished"]), (0.0, 0.0, 0, 0))
        trend = self.data(range="7d")["trend"]
        self.assertEqual(round(sum(p["spend"] for p in trend), 2), 5.0)             # the days add up to the Spend tile

    def test_today_still_shows_a_week_of_trend(self):
        self.assertEqual(len(self.data(range="today")["trend"]), 7)

    def test_thirty_days_shows_thirty_points(self):
        trend = self.data(range="30d")["trend"]
        self.assertEqual(len(trend), 30)
        self.assertEqual(sum(p["calls"] for p in trend), 9)

    def test_days_follow_the_viewers_time_zone(self):
        """A call at 23:30 UTC yesterday is already today in Auckland (UTC+12/13): the day it lands on follows tz."""
        auckland = ZoneInfo("Pacific/Auckland")
        local_today = datetime.now(auckland).date()
        user = h.make_user("nz")
        when = datetime(local_today.year, local_today.month, local_today.day, 12, 0, tzinfo=auckland)
        insert_call(user, when)
        d = self.data(user=user, range="today", tz="Pacific/Auckland")
        self.assertEqual(d["tiles"]["calls"]["value"], 1)
        self.assertEqual(d["to"], local_today.isoformat())


class Campaigns(Base):
    def campaign(self, name, status, user=None):
        return supabase.table("outbound_campaigns").insert({"user_id": user or self.user, "name": name, "status": status}).execute().data[0]["id"]

    def test_counts_every_status_and_lists_only_the_running_campaigns(self):
        self.campaign("Running", "Active")
        self.campaign("Parked", "Paused")
        self.campaign("Draft", "Inactive")
        self.campaign("Theirs", "Active", user=self.other)
        c = self.data()["campaigns"]
        self.assertEqual(c["counts"], {"active": 1, "paused": 1, "inactive": 1})
        self.assertEqual([(i["name"], i["status"]) for i in c["items"]], [("Running", "Active")])

    def test_an_account_with_no_campaigns(self):
        self.assertEqual(self.data(user=h.make_user("bare"))["campaigns"], {"counts": {"active": 0, "paused": 0, "inactive": 0}, "items": []})

    def test_a_running_campaign_carries_what_the_dialer_says_about_it(self):
        from unittest.mock import patch
        cid = self.campaign("Running", "Active")
        live = {str(cid): {"state": "stalled", "stall_reason": "balance", "counters": {"errors": 3, "last_error": "no funds"}}}
        with patch("services.dialer.live_states", return_value=live):
            item = self.data()["campaigns"]["items"][0]
        self.assertEqual((item["state"], item["stall_reason"], item["errors"], item["last_error"]), ("stalled", "balance", 3, "no funds"))

    def test_a_campaign_the_dialer_knows_nothing_about_is_quiet(self):
        from unittest.mock import patch
        self.campaign("Running", "Active")
        with patch("services.dialer.live_states", return_value={}):
            item = self.data()["campaigns"]["items"][0]
        self.assertEqual((item["state"], item["stall_reason"], item["errors"], item["last_error"]), (None, None, 0, None))

    def test_a_dialer_failure_does_not_break_the_page(self):
        from unittest.mock import patch
        self.campaign("Running", "Active")
        with patch("services.dialer.live_states", side_effect=RuntimeError("boom")):
            c = self.data()["campaigns"]
        self.assertEqual(c["items"][0]["state"], None)

    def test_the_dialer_is_not_asked_when_nothing_is_running(self):
        from unittest.mock import patch
        self.campaign("Parked", "Paused")
        with patch("services.dialer.live_states") as live:
            self.data()
        live.assert_not_called()

    def test_the_page_no_longer_carries_a_recent_conversations_list(self):
        self.assertNotIn("recent_calls", self.data())


class Setup(Base):
    def test_setup_checklist(self):
        fresh = h.make_user("fresh")
        s = self.data(user=fresh)["setup"]
        self.assertEqual(s, {"agent": False, "phone": False, "campaign": False, "receptionist": False, "calls": False, "complete": False})
        supabase.table("ai_agents").insert({"user_id": fresh, "name": "A"}).execute()
        supabase.table("phone_numbers").insert({"user_id": fresh, "number": "+15550001111"}).execute()
        s = self.data(user=fresh)["setup"]
        self.assertTrue(s["agent"] and s["phone"])
        self.assertFalse(s["complete"])                                   # still no campaign or receptionist
        supabase.table("inbound_queues").insert({"user_id": fresh, "name": "Front desk"}).execute()
        s = self.data(user=fresh)["setup"]
        self.assertTrue(s["receptionist"] and s["complete"])              # a receptionist is enough

    def test_calls_flag_counts_any_conversation(self):
        self.assertTrue(self.data()["setup"]["calls"])


class Inventory(Base):
    def test_agents_and_receptionists_as_total_and_active(self):
        for name, status in (("A", "Active"), ("B", "Active"), ("C", "Inactive")):
            supabase.table("ai_agents").insert({"user_id": self.user, "name": name, "status": status}).execute()
        supabase.table("ai_agents").insert({"user_id": self.other, "name": "Theirs"}).execute()
        supabase.table("inbound_queues").insert({"user_id": self.user, "name": "Front desk", "status": "Active"}).execute()
        supabase.table("inbound_queues").insert({"user_id": self.user, "name": "After hours", "status": "Inactive"}).execute()
        inv = self.data()["inventory"]
        self.assertEqual(inv["agents"], {"total": 3, "active": 2})
        self.assertEqual(inv["receptionists"], {"total": 2, "active": 1})

    def test_an_account_with_nothing_set_up(self):
        inv = self.data(user=h.make_user("bare"))["inventory"]
        self.assertEqual(inv, {"agents": {"total": 0, "active": 0}, "receptionists": {"total": 0, "active": 0}})


class Tops(Base):
    """Setup has one campaign-less set of calls, so each test adds its own named campaigns / agents / receptionists."""

    def campaign(self, name, user=None):
        return supabase.table("outbound_campaigns").insert({"user_id": user or self.user, "name": name}).execute().data[0]["id"]

    def agent(self, name, user=None):
        return supabase.table("ai_agents").insert({"user_id": user or self.user, "name": name}).execute().data[0]["id"]

    def calls(self, n, when=None, user=None, **kw):
        ids = []
        for _ in range(n):
            ids.append(insert_call(user or self.user, when or noon(0), **kw))
        return ids

    def tops(self, key, user=None, **kw):
        return self.data(user=user, **kw)["tops"][key]

    def test_campaigns_are_ranked_by_qualified_leads_then_calls_then_name(self):
        a, b, c, d = (self.campaign(n) for n in ("Alpha", "Bravo", "Charlie", "Delta"))
        self.calls(3, campaign=a, qualified=True)                     # 3 qualified
        self.calls(5, campaign=b, qualified=True)                     # 5 qualified
        self.calls(2, campaign=c); self.calls(1, campaign=c, qualified=True)     # 1 qualified, 3 calls
        self.calls(4, campaign=d); self.calls(1, campaign=d, qualified=True)     # 1 qualified, 5 calls
        rows = self.tops("campaigns", range="today")
        self.assertEqual([r["name"] for r in rows], ["Bravo", "Alpha", "Delta", "Charlie"])
        self.assertEqual([r["qualified_leads"] for r in rows], [5, 3, 1, 1])
        self.assertEqual(rows[0]["calls"], 5)

    def test_a_tie_on_qualified_and_calls_falls_back_to_the_name(self):
        for n in ("Zeta", "Alpha"):
            self.calls(2, campaign=self.campaign(n), qualified=True)
        self.assertEqual([r["name"] for r in self.tops("campaigns", range="today")], ["Alpha", "Zeta"])

    def test_spend_and_cost_per_qualified_lead_come_from_the_same_calls(self):
        camp = self.campaign("Spring")
        self.calls(2, campaign=camp, cost=1.0, qualified=True)
        self.calls(2, campaign=camp, cost=0.5)
        row = self.tops("campaigns", range="today")[0]
        self.assertEqual((row["calls"], row["spend"], row["qualified_leads"], row["cost_per_qualified_lead"]), (4, 3.0, 2, 1.5))

    def test_no_qualified_lead_means_no_cost_per_qualified_lead_not_zero(self):
        self.calls(3, campaign=self.campaign("Quiet"))
        row = self.tops("campaigns", range="today")[0]
        self.assertEqual((row["qualified_leads"], row["cost_per_qualified_lead"]), (0, None))

    def test_leads_use_the_reports_definition_a_callback_counts_but_is_not_qualified(self):
        camp = self.campaign("Callbacks")
        conv = self.calls(1, campaign=camp)[0]
        h.sql("insert into callbacks (user_id, conversation_id, due_at) values (%s,%s,now())", (self.user, conv))
        row = self.tops("campaigns", range="today")[0]
        self.assertEqual((row["leads"], row["qualified_leads"]), (1, 0))

    def test_only_the_top_five_are_listed(self):
        for i in range(dash.TOP_N + 3):
            self.calls(1, campaign=self.campaign(f"C{i:02d}"), qualified=i % 2 == 0)
        self.assertEqual(len(self.tops("campaigns", range="today")), dash.TOP_N)

    def test_calls_without_a_campaign_or_with_a_deleted_one_are_not_ranked(self):
        # setUp already made campaign-less calls today; a call pointing at a campaign that no longer exists:
        ghost = self.campaign("Gone")
        self.calls(2, campaign=ghost)
        supabase.table("outbound_campaigns").delete().eq("id", ghost).execute()
        self.assertEqual(self.tops("campaigns", range="today"), [])

    def test_it_follows_the_chosen_range(self):
        camp = self.campaign("Old")
        self.calls(2, when=noon(3), campaign=camp, qualified=True)
        self.assertEqual(self.tops("campaigns", range="today"), [])
        self.assertEqual(self.tops("campaigns", range="7d")[0]["calls"], 2)
        custom = self.get(range="custom", **{"from": (today() - timedelta(days=4)).isoformat(), "to": (today() - timedelta(days=2)).isoformat()})
        self.assertEqual(custom.json()["data"]["tops"]["campaigns"][0]["name"], "Old")

    def test_sample_rows_and_other_accounts_are_left_out(self):
        camp = self.campaign("Mine")
        self.calls(1, campaign=camp, contact="[SAMPLE] Demo", qualified=True)
        self.calls(2, campaign=camp)
        theirs = self.campaign("Theirs", user=self.other)
        self.calls(3, user=self.other, campaign=theirs, qualified=True)
        rows = self.tops("campaigns", range="today")
        self.assertEqual([(r["name"], r["calls"]) for r in rows], [("Mine", 2)])
        self.assertEqual([r["name"] for r in self.tops("campaigns", user=self.other, range="today")], ["Theirs"])

    def test_agents_are_ranked_across_every_kind_of_call(self):
        sara, max_ = self.agent("Sara"), self.agent("Max")
        self.calls(2, agent=sara, qualified=True)
        self.calls(3, agent=max_, qualified=True, direction="inbound")      # an inbound call counts for the agent too
        self.calls(4, agent=max_)
        rows = self.tops("agents", range="today")
        self.assertEqual([(r["name"], r["calls"], r["qualified_leads"]) for r in rows], [("Max", 7, 3), ("Sara", 2, 2)])

    def test_a_deleted_agents_calls_are_not_ranked(self):
        gone = self.agent("Gone")
        self.calls(2, agent=gone)
        supabase.table("ai_agents").delete().eq("id", gone).execute()
        self.assertEqual(self.tops("agents", range="today"), [])

    def test_receptionists_are_ranked_by_the_inbound_calls_that_reached_their_number(self):
        n1 = supabase.table("phone_numbers").insert({"user_id": self.user, "number": "+15550001001"}).execute().data[0]["id"]
        n2 = supabase.table("phone_numbers").insert({"user_id": self.user, "number": "+15550001002"}).execute().data[0]["id"]
        supabase.table("inbound_queues").insert({"user_id": self.user, "name": "Front desk", "phone_number_id": n1}).execute()
        supabase.table("inbound_queues").insert({"user_id": self.user, "name": "After hours", "phone_number_id": n2}).execute()
        supabase.table("inbound_queues").insert({"user_id": self.user, "name": "No number yet"}).execute()
        self.calls(3, number=n1, direction="inbound", qualified=True)
        self.calls(5, number=n2, direction="inbound")
        self.calls(4, number=n1, direction="outbound")                   # outbound from the same number: not the receptionist's
        rows = self.tops("receptionists", range="today")
        self.assertEqual([(r["name"], r["calls"], r["qualified_leads"]) for r in rows], [("Front desk", 3, 3), ("After hours", 5, 0)])

    def test_every_table_is_empty_for_an_account_with_no_calls(self):
        self.assertEqual(self.data(user=h.make_user("bare"))["tops"], {"campaigns": [], "agents": [], "receptionists": []})

    def test_viewers_see_the_owners_rankings(self):
        self.calls(2, campaign=self.campaign("Spring"), qualified=True)
        m = h.make_user("viewer")
        supabase.table("team_members").insert({"owner_id": self.user, "member_user_id": m, "role": "viewer", "status": "Active",
                                               "member_email": f"m-{uuid.uuid4().hex[:8]}@qa.test"}).execute()
        self.assertEqual(self.tops("campaigns", user=m, range="today")[0]["name"], "Spring")


class Live(Base):
    def live(self, user=None, **kw):
        params = {"tz": TZ}
        params.update(kw)
        r = client.get("/dashboard/live", params=params, headers=auth(user or self.user))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["data"]

    def running(self, status="In Progress", minutes_ago=2, direction="outbound", user=None, contact="Pat"):
        return insert_call(user or self.user, datetime.now(UTC) - timedelta(minutes=minutes_ago), status=status,
                           direction=direction, contact=contact, seconds=0, ended_reason=None)

    def test_nothing_is_running_when_every_call_has_finished(self):
        self.assertEqual(self.live()["running_now"], {"total": 0, "outbound": 0, "inbound": 0})

    def test_counts_running_calls_by_direction(self):
        self.running("In Progress")
        self.running("Ringing")
        self.running("Initiated")
        self.running("Forwarding", direction="inbound")
        self.running("In Progress", direction="inbound")
        self.assertEqual(self.live()["running_now"], {"total": 5, "outbound": 3, "inbound": 2})

    def test_finished_calls_are_not_running(self):
        self.running("Completed")
        self.running("No Answer")
        self.running("Failed")
        self.assertEqual(self.live()["running_now"]["total"], 0)

    def test_a_call_that_never_reported_its_end_stops_counting_after_a_while(self):
        self.running("In Progress", minutes_ago=dash.LIVE_MAX_AGE_MINUTES + 5)
        self.running("In Progress", minutes_ago=dash.LIVE_MAX_AGE_MINUTES - 5)
        self.assertEqual(self.live()["running_now"]["total"], 1)

    def test_sample_rows_and_other_accounts_are_not_counted(self):
        self.running("In Progress", contact="[SAMPLE] Demo")
        self.running("In Progress", user=self.other)
        self.assertEqual(self.live()["running_now"]["total"], 0)
        self.assertEqual(self.live(user=self.other)["running_now"]["total"], 1)

    def test_calls_today_and_how_many_were_answered(self):
        self.drop_sample_row()
        live = self.live()
        self.assertEqual(live["calls_today"], {"total": 4, "answered": 3})            # the 4 of setUp; 3 finished consumed

    def test_a_running_call_counts_as_a_call_today_but_not_as_answered_yet(self):
        self.drop_sample_row()
        self.running("In Progress", minutes_ago=0)
        self.assertEqual(self.live()["calls_today"], {"total": 5, "answered": 3})

    def test_today_follows_the_viewers_time_zone(self):
        user = h.make_user("nz")
        auckland = ZoneInfo("Pacific/Auckland")
        now_local = datetime.now(auckland)
        insert_call(user, datetime(now_local.year, now_local.month, now_local.day, 12, 0, tzinfo=auckland))
        insert_call(user, datetime(now_local.year, now_local.month, now_local.day, 12, 0, tzinfo=auckland) - timedelta(days=1))
        self.assertEqual(self.live(user=user, tz="Pacific/Auckland")["calls_today"]["total"], 1)

    def test_team_members_and_viewers_see_the_owners_live_numbers(self):
        self.running("In Progress")
        m = h.make_user("viewer")
        supabase.table("team_members").insert({"owner_id": self.user, "member_user_id": m, "role": "viewer", "status": "Active",
                                               "member_email": f"m-{uuid.uuid4().hex[:8]}@qa.test"}).execute()
        self.assertEqual(self.live(user=m)["running_now"]["total"], 1)

    def test_rejects_a_bad_time_zone_and_needs_a_login(self):
        r = client.get("/dashboard/live", params={"tz": "Mars/Olympus"}, headers=auth(self.user))
        self.assertEqual(r.status_code, 400)
        self.assertIn(client.get("/dashboard/live").status_code, (401, 403))


class Access(Base):
    def member(self, role):
        m = h.make_user(role)
        supabase.table("team_members").insert({"owner_id": self.user, "member_user_id": m, "role": role, "status": "Active",
                                               "member_email": f"m-{uuid.uuid4().hex[:8]}@qa.test"}).execute()
        return m

    def test_team_members_and_viewers_see_the_owners_numbers(self):
        for role in ("member", "viewer"):
            m = self.member(role)
            self.assertEqual(self.data(user=m, range="today")["tiles"]["calls"]["value"], 4, role)

    def test_requires_a_login(self):
        self.assertIn(client.get("/dashboard/overview", params={"range": "7d"}).status_code, (401, 403))

    def test_rejects_a_bad_range_or_time_zone(self):
        self.assertEqual(self.get(range="year").status_code, 400)
        self.assertEqual(self.get(tz="Mars/Olympus").status_code, 400)

    def test_defaults_to_today_in_utc(self):
        r = client.get("/dashboard/overview", headers=auth(self.user))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["data"]["range"], "today")


class HourlyChart(Base):
    """The chart is hour by hour for a day or two and day by day for longer."""

    def at(self, hour, minute=0, days_ago=0):
        d = today() - timedelta(days=days_ago)
        return datetime(d.year, d.month, d.day, hour, minute, tzinfo=UTC)

    def chart(self, **kw):
        return self.data(**kw)["chart"]

    def point(self, chart, hour, days_ago=0):
        d = (today() - timedelta(days=days_ago)).isoformat()
        return next(p for p in chart["hourly"] if p["date"] == d and p["hour"] == hour)

    def test_today_is_24_hours_oldest_first(self):
        c = self.chart(range="today")
        self.assertEqual(c["granularity"], "hour")
        self.assertEqual(len(c["hourly"]), 24)
        self.assertEqual([p["hour"] for p in c["hourly"]], list(range(24)))
        self.assertEqual({p["date"] for p in c["hourly"]}, {today().isoformat()})

    def test_calls_land_in_their_own_hour(self):
        insert_call(self.user, self.at(3, 5), qualified=True)
        insert_call(self.user, self.at(3, 55))
        insert_call(self.user, self.at(14, 15))
        c = self.chart(range="today")
        three = self.point(c, 3)
        self.assertEqual((three["calls"], three["qualified_leads"]), (2, 1))
        self.assertEqual(self.point(c, 14)["calls"], 1)
        self.assertEqual(self.point(c, 12)["calls"], 4)                      # setUp's four calls at noon

    def test_the_hours_add_up_to_the_calls_tile(self):
        insert_call(self.user, self.at(1))
        insert_call(self.user, self.at(20))
        d = self.data(range="today")
        self.assertEqual(sum(p["calls"] or 0 for p in d["chart"]["hourly"]), d["tiles"]["calls"]["value"])
        self.assertEqual(sum(p["qualified_leads"] or 0 for p in d["chart"]["hourly"]), d["tiles"]["qualified_leads"]["value"])

    def test_hours_still_to_come_are_none_not_zero(self):
        now_hour = datetime.now(UTC).hour
        c = self.chart(range="today")
        if now_hour < 23:
            self.assertIsNone(self.point(c, 23)["calls"])
        self.assertEqual(self.point(c, 0)["calls"], 0)                        # a quiet hour in the past is a real 0
        self.assertEqual(self.point(c, 12)["calls"], 4)                       # but an hour with calls always shows them

    def test_yesterday_and_today_are_48_hours(self):
        c = self.get(range="custom", **{"from": (today() - timedelta(days=1)).isoformat(), "to": today().isoformat()}).json()["data"]["chart"]
        self.assertEqual((c["granularity"], len(c["hourly"])), ("hour", 48))
        self.assertEqual(self.point(c, 12, days_ago=1)["calls"], 2)           # the two yesterday calls at noon

    def test_a_single_past_day_is_all_real_zeros_or_counts(self):
        c = self.get(range="custom", **{"from": (today() - timedelta(days=3)).isoformat(), "to": (today() - timedelta(days=3)).isoformat()}).json()["data"]["chart"]
        self.assertEqual(len(c["hourly"]), 24)
        self.assertTrue(all(p["calls"] is not None for p in c["hourly"]))     # nothing "to come" in the past
        self.assertEqual(sum(p["calls"] for p in c["hourly"]), 2)

    def test_three_days_or_more_is_charted_by_day(self):
        for kw in ({"range": "7d"}, {"range": "30d"}):
            c = self.chart(**kw)
            self.assertEqual((c["granularity"], c["hourly"]), ("day", []))
        three = self.get(range="custom", **{"from": (today() - timedelta(days=2)).isoformat(), "to": today().isoformat()}).json()["data"]["chart"]
        self.assertEqual((three["granularity"], three["hourly"]), ("day", []))

    def test_the_daily_trend_is_still_sent_for_the_sparklines(self):
        self.assertEqual(len(self.data(range="today")["trend"]), 7)

    def test_hours_follow_the_viewers_time_zone(self):
        auckland = ZoneInfo("Pacific/Auckland")
        user = h.make_user("nz")
        now_local = datetime.now(auckland)
        insert_call(user, datetime(now_local.year, now_local.month, now_local.day, 9, 30, tzinfo=auckland))
        c = self.data(user=user, range="today", tz="Pacific/Auckland")["chart"]
        local_today = now_local.date().isoformat()
        nine = next(p for p in c["hourly"] if p["date"] == local_today and p["hour"] == 9)
        self.assertEqual(nine["calls"], 1)
        self.assertEqual(sum(p["calls"] or 0 for p in c["hourly"]), 1)

    def test_sample_rows_and_other_accounts_are_left_out(self):
        insert_call(self.user, self.at(5), contact="[SAMPLE] Demo")
        insert_call(self.other, self.at(5))
        self.assertEqual(self.point(self.chart(range="today"), 5)["calls"], 0)

    def test_leads_in_the_hours_use_the_reports_definition(self):
        conv = insert_call(self.user, self.at(7))
        h.sql("insert into callbacks (user_id, conversation_id, due_at) values (%s,%s,now())", (self.user, conv))
        seven = self.point(self.chart(range="today"), 7)
        self.assertEqual((seven["calls"], seven["leads"], seven["qualified_leads"]), (1, 1, 0))


class Windows(unittest.TestCase):
    def test_windows_are_adjacent_and_equally_long(self):
        for key, days in (("today", 1), ("7d", 7), ("30d", 30)):
            w = dash.windows(key, "UTC", today=datetime(2026, 3, 15).date())
            (cf, ct), (pf, pt) = w["current"], w["previous"]
            self.assertEqual((ct - cf).days + 1, days)
            self.assertEqual((pt - pf).days + 1, days)
            self.assertEqual(pt + timedelta(days=1), cf)
            self.assertLessEqual(w["span"][0], pf)
            self.assertGreaterEqual((w["span"][1] - w["trend_from"]).days + 1, 7)


if __name__ == "__main__":
    unittest.main()
