"""
Cost per lead & ROI (services/lead_roi.py, routers/lead_roi.py).

Covered: what counts as a lead (qualified / callback / booking, never twice, a cancelled booking is not one), spend
(sample rows and other accounts left out), cost per lead and per qualified lead from SUMMED figures, divide-by-zero
(None, never 0), the value settings (account default, per-campaign override field by field, owner-only saving,
validation, clearing), revenue / profit / ROI, the per-campaign and weekly / monthly reports and their totals,
previous-window changes, time-zone bucketing, filters, CSV exports and tenant isolation.

Run from the backend folder:  python -m unittest discover -s tests -p "test_lead_roi.py" -v
"""
import unittest
import uuid
from datetime import datetime, timezone

import qa_harness as h
from qa_harness import client, auth
from database import supabase
from services import lead_roi as lr

UTC = timezone.utc
PREFIX = "/call-consumption/lead-roi"


def at(day, hour=10, month=3):
    return datetime(2026, month, day, hour, 0, tzinfo=UTC)


def insert_call(user, when, cost=0.5, qualified=False, campaign=None, direction="outbound", contact="Pat", agent=None, number=None):
    """One conversation row; returns (conversation id, vapi_call_id)."""
    vapi = f"call-{uuid.uuid4().hex[:10]}"
    row = h.sql("insert into conversations (user_id, channel, status, call_time, call_cost, qualified, campaign_id,"
                " direction, contact_name, vapi_call_id, agent_id, phone_number_id)"
                " values (%s,'Phone','Completed',%s,%s,%s,%s,%s,%s,%s,%s,%s) returning id",
                (user, when, cost, qualified, campaign, direction, contact, vapi, agent, number))
    return str(row[0][0]), vapi


def add_callback(user, vapi=None, conv=None, status="pending"):
    h.sql("insert into callbacks (user_id, vapi_call_id, conversation_id, due_at, status) values (%s,%s,%s,now(),%s)",
          (user, vapi, conv, status))


def add_booking(user, vapi, status="confirmed"):
    h.sql("insert into calendar_bookings (user_id, vapi_call_id, start_at, end_at, status) values (%s,%s,now(),now(),%s)",
          (user, vapi, status))


def q(**kw):
    """The standard window (Mon 2026-03-02 .. Sun 2026-03-08) plus overrides."""
    params = {"from": "2026-03-02", "to": "2026-03-08", "tz": "UTC"}
    params.update(kw)
    return {k: v for k, v in params.items() if v is not None}


class Base(unittest.TestCase):
    """An owner with two campaigns and a known set of calls (window Mar 2 .. Mar 8).

    C1 Spring Push, Mar 2, 10 calls at $0.50 = $5.00: 2 qualified, 1 callback request, 1 booked meeting
    C1 Mar 4, 2 calls at $1.00 = $2.00: one qualified AND with a callback (still ONE lead), one with a cancelled booking
    C2 Listings, Mar 3, 4 calls at $0.25 = $1.00: no leads
    No campaign, inbound, Mar 6, 1 call $2.00, qualified
    => 17 calls, $10.00 spent, 6 leads, 4 qualified (C1: 12 calls, $7.00, 5 leads, 3 qualified).
    Left out on purpose: a [SAMPLE] call, a call outside the window and another account's call."""

    def setUp(self):
        h.reset_rate_limits()
        self.user = h.make_user()
        self.other = h.make_user("other")
        self.c1 = self.campaign(self.user, "Spring Push")
        self.c2 = self.campaign(self.user, "Listings")
        for i in range(10):
            conv, vapi = insert_call(self.user, at(2), 0.5, qualified=i < 2, campaign=self.c1)
            if i == 2:
                add_callback(self.user, vapi=vapi)              # matched by the VAPI call id
            if i == 3:
                add_booking(self.user, vapi)
        conv, vapi = insert_call(self.user, at(4), 1.0, qualified=True, campaign=self.c1)
        add_callback(self.user, vapi=vapi, conv=conv)          # qualified AND callback: one lead, not two
        conv, vapi = insert_call(self.user, at(4), 1.0, campaign=self.c1)
        add_booking(self.user, vapi, status="cancelled")        # a cancelled meeting is not a lead
        for _ in range(4):
            insert_call(self.user, at(3), 0.25, campaign=self.c2)
        insert_call(self.user, at(6), 2.0, qualified=True, direction="inbound")
        insert_call(self.user, at(5), 9.99, qualified=True, contact="[SAMPLE] Demo")
        insert_call(self.user, at(20), 3.0, qualified=True, campaign=self.c1)
        insert_call(self.other, at(2), 4.0, qualified=True)

    @staticmethod
    def campaign(user, name):
        return supabase.table("outbound_campaigns").insert({"user_id": user, "name": name}).execute().data[0]["id"]

    def get(self, path, user=None, **kw):
        return client.get(f"{PREFIX}{path}", params=q(**kw), headers=auth(user or self.user))

    def data(self, path, user=None, **kw):
        r = self.get(path, user, **kw)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["data"]

    def put(self, body, user=None):
        return client.put(f"{PREFIX}/values", json=body, headers=auth(user or self.user))

    def set_values(self, qualified=None, other=None, campaign=None, user=None):
        r = self.put({"campaign_id": campaign, "value_per_qualified_lead": qualified, "value_per_lead": other}, user)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["data"]

    def row(self, name, **kw):
        return next(r for r in self.data("/campaign", **kw)["rows"] if r["name"] == name)


# ---------------------------------------------------------------------------------------------- maths

class Maths(unittest.TestCase):
    def test_empty_tally_has_no_ratios_and_never_divides_by_zero(self):
        row = lr.Tally().row()
        self.assertEqual((row["cost_per_lead"], row["cost_per_qualified_lead"], row["roi_pct"]), (None, None, None))
        self.assertEqual((row["revenue"], row["profit"]), (None, None))

    def test_spend_without_leads_has_no_cost_per_lead(self):
        t = lr.Tally()
        t.add(5, 3.0, 0, 0, None)
        self.assertEqual((t.row()["spend"], t.row()["cost_per_lead"], t.row()["cost_per_qualified_lead"]), (3.0, None, None))

    def test_cost_per_qualified_needs_a_qualified_lead_even_when_there_are_other_leads(self):
        t = lr.Tally()
        t.add(5, 3.0, 2, 0, None)
        self.assertEqual((t.row()["cost_per_lead"], t.row()["cost_per_qualified_lead"]), (1.5, None))

    def test_revenue_profit_roi(self):
        t = lr.Tally()
        t.add(10, 10.0, 5, 3, lr.Values(100, 20, "account"))
        row = t.row()
        self.assertEqual((row["revenue"], row["profit"], row["roi_pct"]), (340.0, 330.0, 3300.0))

    def test_a_loss_is_a_negative_roi(self):
        t = lr.Tally()
        t.add(10, 10.0, 1, 1, lr.Values(4, None, "account"))
        self.assertEqual((t.row()["profit"], t.row()["roi_pct"]), (-6.0, -60.0))

    def test_roi_is_none_when_nothing_was_spent(self):
        t = lr.Tally()
        t.add(3, 0.0, 2, 2, lr.Values(50, None, "account"))
        self.assertEqual((t.row()["revenue"], t.row()["profit"], t.row()["roi_pct"]), (100.0, 100.0, None))

    def test_merge_sums_money_and_counts_not_ratios(self):
        a, b = lr.Tally(), lr.Tally()
        a.add(1, 1.0, 1, 1, None)       # $1 per lead
        b.add(9, 9.0, 3, 3, None)       # $3 per lead
        a.merge(b)
        self.assertEqual(a.row()["cost_per_lead"], 2.5)      # 10 / 4, not (1 + 3) / 2

    def test_a_value_of_zero_is_still_a_value(self):
        self.assertTrue(lr.Values(0, None, "account").is_set)
        self.assertFalse(lr.Values().is_set)

    def test_campaign_value_wins_field_by_field(self):
        account = {"qualified": 100.0, "other": 20.0}
        v = lr.effective_values("c1", account, {"c1": {"qualified": 10.0, "other": None}})
        self.assertEqual((v.qualified, v.other, v.source), (10.0, 20.0, "campaign"))
        self.assertEqual(lr.effective_values("c2", account, {}).source, "account")
        self.assertFalse(lr.effective_values("c2", {"qualified": None, "other": None}, {}).is_set)

    def test_value_cleaning(self):
        self.assertEqual(lr._clean_value("12.345", "x"), 12.35)
        self.assertIsNone(lr._clean_value("", "x"))
        self.assertEqual(lr._clean_value(0, "x"), 0)
        for bad in (-1, "abc", float("nan"), float("inf"), lr.MAX_VALUE + 1):
            with self.assertRaises(lr.LeadValueError):
                lr._clean_value(bad, "x")


# ---------------------------------------------------------------------------------------------- KPIs

class Kpis(Base):
    def test_costs_leads_and_ratios(self):
        k = self.data("/kpis")
        self.assertEqual((k["has_data"], k["calls"], k["spend"]), (True, 17, 10.0))
        self.assertEqual((k["leads"], k["qualified_leads"]), (6, 4))
        self.assertEqual((k["cost_per_lead"], k["cost_per_qualified_lead"]), (1.67, 2.5))

    def test_without_a_value_there_is_no_revenue(self):
        k = self.data("/kpis")
        self.assertFalse(k["has_value"])
        self.assertEqual((k["revenue"], k["profit"], k["roi_pct"]), (None, None, None))

    def test_a_qualified_call_with_a_callback_is_one_lead(self):
        self.assertEqual(self.row("Spring Push")["leads"], 5)          # 2 + callback + booking + qualified&callback

    def test_cancelled_booking_is_not_a_lead(self):
        self.assertEqual(self.row("Spring Push")["calls"], 12)
        self.assertEqual(self.row("Spring Push")["leads"], 5)          # the cancelled-booking call is the 12th, not a lead

    def test_sample_rows_other_accounts_and_out_of_window_calls_are_left_out(self):
        self.assertEqual(self.data("/kpis")["spend"], 10.0)
        self.assertEqual(self.data("/kpis", user=self.other)["spend"], 4.0)    # only their own call
        self.assertEqual(self.data("/kpis", **{"from": "2026-03-20", "to": "2026-03-20"})["spend"], 3.0)

    def test_value_applies_to_the_totals(self):
        self.set_values(100, 20)
        k = self.data("/kpis")
        # 4 qualified x 100 + 2 other leads x 20 = 440; profit 430 on $10
        self.assertEqual((k["has_value"], k["revenue"], k["profit"], k["roi_pct"]), (True, 440.0, 430.0, 4300.0))
        self.assertEqual(k["unvalued_campaigns"], 0)

    def test_no_leads_means_no_cost_per_lead_not_zero(self):
        user = h.make_user("noleads")
        insert_call(user, at(2), 1.5)
        k = self.data("/kpis", user=user)
        self.assertEqual((k["spend"], k["leads"]), (1.5, 0))
        self.assertEqual((k["cost_per_lead"], k["cost_per_qualified_lead"]), (None, None))

    def test_empty_account(self):
        k = self.data("/kpis", user=h.make_user("empty"))
        self.assertEqual((k["has_data"], k["has_previous"], k["calls"], k["spend"]), (False, False, 0, 0))
        self.assertEqual((k["cost_per_lead"], k["roi_pct"], k["spend_change_pct"], k["roi_point_change"]), (None, None, None, None))

    def test_no_previous_window_means_no_changes(self):
        k = self.data("/kpis")
        self.assertFalse(k["has_previous"])
        self.assertEqual((k["spend_change_pct"], k["cost_per_lead_change_pct"]), (None, None))

    def test_changes_against_the_previous_window(self):
        # Week before (Feb 23 .. Mar 1): 2 calls, $4, 2 leads (both qualified) -> $2 per lead.
        insert_call(self.user, datetime(2026, 2, 25, 10, tzinfo=UTC), 2.0, qualified=True)
        insert_call(self.user, datetime(2026, 2, 26, 10, tzinfo=UTC), 2.0, qualified=True)
        self.set_values(100)
        k = self.data("/kpis")
        self.assertTrue(k["has_previous"])
        self.assertEqual(k["spend_change_pct"], 150.0)               # 4 -> 10
        self.assertEqual(k["leads_change_pct"], 200.0)               # 2 -> 6
        self.assertEqual(k["cost_per_lead_change_pct"], -16.7)       # 2.00 -> 1.6667 (exact, not the rounded 1.67)
        # previous ROI = (2 x 100 - 4) / 4 = 4900%; now = (4 x 100 - 10) / 10 = 3900%
        self.assertEqual(k["roi_point_change"], -1000.0)

    def test_previous_window_without_leads_gives_no_cost_change(self):
        insert_call(self.user, datetime(2026, 2, 25, 10, tzinfo=UTC), 2.0)
        k = self.data("/kpis")
        self.assertTrue(k["has_previous"])
        self.assertEqual(k["spend_change_pct"], 400.0)                # $2 -> $10
        self.assertIsNone(k["cost_per_lead_change_pct"])             # no previous lead, so no previous cost per lead

    def test_time_zone_decides_the_day(self):
        insert_call(self.user, datetime(2026, 3, 8, 21, tzinfo=UTC), 1.0)         # Mar 9 02:00 in Karachi
        self.assertEqual(self.data("/kpis", tz="UTC")["spend"], 11.0)
        self.assertEqual(self.data("/kpis", tz="Asia/Karachi")["spend"], 10.0)


# ---------------------------------------------------------------------------------------------- per campaign

class Campaigns(Base):
    def test_rows_and_total(self):
        rep = self.data("/campaign")
        rows = {r["name"]: r for r in rep["rows"]}
        self.assertEqual(set(rows), {"Spring Push", "Listings", "No campaign"})
        sp = rows["Spring Push"]
        self.assertEqual((sp["calls"], sp["spend"], sp["leads"], sp["qualified_leads"]), (12, 7.0, 5, 3))
        self.assertEqual((sp["cost_per_lead"], sp["cost_per_qualified_lead"]), (1.4, 2.33))
        ls = rows["Listings"]
        self.assertEqual((ls["spend"], ls["leads"], ls["cost_per_lead"], ls["cost_per_qualified_lead"]), (1.0, 0, None, None))
        nc = rows["No campaign"]
        self.assertEqual((nc["spend"], nc["leads"], nc["cost_per_lead"]), (2.0, 1, 2.0))
        t = rep["total"]
        self.assertEqual((t["calls"], t["spend"], t["leads"], t["qualified_leads"], t["cost_per_lead"]), (17, 10.0, 6, 4, 1.67))

    def test_total_is_the_sum_of_the_rows_and_the_kpis_agree(self):
        rep = self.data("/campaign")
        for key in ("calls", "spend", "leads", "qualified_leads"):
            self.assertAlmostEqual(sum(r[key] for r in rep["rows"]), rep["total"][key])
        k = self.data("/kpis")
        self.assertEqual({key: k[key] for key in rep["total"] if key != "name"}, {key: v for key, v in rep["total"].items() if key != "name"})

    def test_biggest_spender_first(self):
        self.assertEqual([r["name"] for r in self.data("/campaign")["rows"]], ["Spring Push", "No campaign", "Listings"])

    def test_no_value_leaves_revenue_blank(self):
        rep = self.data("/campaign")
        self.assertFalse(rep["has_value"])
        for r in rep["rows"]:
            self.assertEqual((r["revenue"], r["profit"], r["roi_pct"], r["value_source"]), (None, None, None, None))

    def test_account_value_applies_to_every_campaign(self):
        self.set_values(100, 20)
        rows = {r["name"]: r for r in self.data("/campaign")["rows"]}
        sp = rows["Spring Push"]                 # 3 x 100 + 2 x 20 = 340 on $7
        self.assertEqual((sp["revenue"], sp["profit"], sp["roi_pct"], sp["value_source"]), (340.0, 333.0, 4757.1, "account"))
        ls = rows["Listings"]                    # valued, but no leads: nothing earned, $1 lost
        self.assertEqual((ls["revenue"], ls["profit"], ls["roi_pct"]), (0.0, -1.0, -100.0))
        self.assertEqual(rows["No campaign"]["revenue"], 100.0)

    def test_campaign_override_beats_the_account_value_field_by_field(self):
        self.set_values(100, 20)
        self.set_values(10, None, campaign=self.c1)
        rep = self.data("/campaign")
        sp = next(r for r in rep["rows"] if r["name"] == "Spring Push")
        self.assertEqual((sp["value_per_qualified_lead"], sp["value_per_lead"], sp["value_source"]), (10.0, 20.0, "campaign"))
        self.assertEqual(sp["revenue"], 70.0)                                   # 3 x 10 + 2 x 20
        self.assertEqual(rep["total"]["revenue"], 170.0)                        # + No campaign 100 + Listings 0
        self.assertEqual(self.data("/kpis")["roi_pct"], 1600.0)

    def test_a_campaign_value_alone_leaves_the_others_unvalued_and_warns(self):
        self.set_values(None, None)                              # nothing for the account
        self.set_values(50, None, campaign=self.c1)
        k = self.data("/kpis")
        self.assertTrue(k["has_value"])
        self.assertEqual(k["revenue"], 150.0)                    # only Spring Push earns: 3 x 50
        self.assertEqual(k["unvalued_campaigns"], 1)             # "No campaign" made a lead but has no value
        rows = {r["name"]: r for r in self.data("/campaign")["rows"]}
        self.assertEqual(rows["No campaign"]["revenue"], None)
        self.assertEqual(rows["Listings"]["revenue"], None)

    def test_campaign_filter(self):
        rep = self.data("/campaign", campaign_ids=self.c2)
        self.assertEqual([r["name"] for r in rep["rows"]], ["Listings"])
        self.assertEqual(self.data("/kpis", campaign_ids=f"{self.c1},{self.c2}")["calls"], 16)

    def test_direction_filter(self):
        self.assertEqual(self.data("/kpis", direction="inbound")["calls"], 1)
        self.assertEqual(self.data("/kpis", direction="outbound")["calls"], 16)

    def test_agent_and_vertical_filters(self):
        agent = supabase.table("ai_agents").insert({"user_id": self.user, "name": "Sara", "category": "Insurance"}).execute().data[0]["id"]
        insert_call(self.user, at(5), 1.25, agent=agent)
        self.assertEqual(self.data("/kpis", agent_id=agent)["spend"], 1.25)
        self.assertEqual(self.data("/kpis", vertical="Insurance")["spend"], 1.25)
        self.assertEqual(self.data("/kpis", vertical="Legal")["calls"], 0)

    def test_a_deleted_campaigns_calls_move_to_no_campaign_and_are_still_counted(self):
        supabase.table("outbound_campaigns").delete().eq("id", self.c2).execute()
        rows = {r["name"]: r for r in self.data("/campaign")["rows"]}
        self.assertNotIn("Listings", rows)
        self.assertEqual((rows["No campaign"]["calls"], rows["No campaign"]["spend"]), (5, 3.0))
        self.assertEqual(self.data("/kpis")["spend"], 10.0)

    def test_csv_matches_the_screen(self):
        self.set_values(100, 20)
        r = self.get("/campaign/export.csv")
        self.assertEqual(r.status_code, 200)
        self.assertIn("attachment", r.headers["content-disposition"])
        lines = r.text.strip().split("\n")
        self.assertEqual(lines[0], "Campaign,Calls,Spend,Leads,Qualified Leads,Cost per Lead,Cost per Qualified Lead,Revenue,Profit,ROI %")
        self.assertEqual(lines[1], "Spring Push,12,7.00,5,3,1.40,2.33,340.00,333.00,4757.1")
        self.assertEqual(lines[2], "No campaign,1,2.00,1,1,2.00,2.00,100.00,98.00,4900.0")
        self.assertEqual(lines[3], "Listings,4,1.00,0,0,,,0.00,-1.00,-100.0")
        self.assertEqual(lines[-1], "Total,17,10.00,6,4,1.67,2.50,440.00,430.00,4300.0")

    def test_csv_leaves_unavailable_figures_blank(self):
        lines = self.get("/campaign/export.csv").text.strip().split("\n")
        self.assertEqual(lines[3], "Listings,4,1.00,0,0,,,,,")

    def test_csv_with_no_data_is_404(self):
        self.assertEqual(client.get(f"{PREFIX}/campaign/export.csv", params=q(), headers=auth(h.make_user("none"))).status_code, 404)


# ---------------------------------------------------------------------------------------------- weekly / monthly

class Periods(Base):
    def setUp(self):
        super().setUp()
        for d, cost, qual in ((10, 1.0, True), (11, 1.0, False), (24, 2.0, True)):
            insert_call(self.user, at(d), cost, qualified=qual, campaign=self.c1)

    def wk(self, **kw):
        return self.data("/period/weekly", **{"from": "2026-03-01", "to": "2026-03-31", **kw})

    def test_weekly_rows_oldest_first(self):
        rep = self.wk()
        self.assertEqual([r["start_date"] for r in rep["rows"]], ["2026-03-01", "2026-03-08", "2026-03-15", "2026-03-22"])
        first, second, third, last = rep["rows"]
        self.assertEqual((first["spend"], first["leads"], first["qualified_leads"], first["cost_per_lead"]), (10.0, 6, 4, 1.67))
        self.assertEqual((second["calls"], second["spend"], second["leads"], second["cost_per_lead"]), (2, 2.0, 1, 2.0))
        self.assertEqual((third["spend"], third["leads"]), (3.0, 1))                 # the Mar 20 call
        self.assertEqual((last["spend"], last["leads"]), (2.0, 1))

    def test_a_week_with_no_calls_is_a_zero_row_not_a_hole(self):
        user = h.make_user("holes")
        insert_call(user, at(2), 1.0, qualified=True)
        insert_call(user, at(24), 3.0)
        rep = self.data("/period/weekly", user=user, **{"from": "2026-03-01", "to": "2026-03-31"})
        self.assertEqual([r["start_date"] for r in rep["rows"]], ["2026-03-01", "2026-03-08", "2026-03-15", "2026-03-22"])
        gap = rep["rows"][1]
        self.assertEqual((gap["calls"], gap["spend"], gap["cost_per_lead"], gap["cost_per_qualified_lead"]), (0, 0, None, None))
        self.assertEqual((rep["rows"][3]["spend"], rep["rows"][3]["leads"], rep["rows"][3]["cost_per_lead"]), (3.0, 0, None))

    def test_rows_add_up_to_the_total_and_the_other_reports(self):
        rep = self.wk()
        self.assertEqual(round(sum(r["spend"] for r in rep["rows"]), 2), rep["total"]["spend"])
        self.assertEqual(sum(r["leads"] for r in rep["rows"]), rep["total"]["leads"])
        self.assertEqual(rep["total"], {"name": "Total", **{k: v for k, v in self.data("/campaign", **{"from": "2026-03-01", "to": "2026-03-31"})["total"].items() if k != "name"}})

    def test_monthly_is_one_row(self):
        rep = self.data("/period/monthly", **{"from": "2026-03-01", "to": "2026-03-31"})
        self.assertEqual([r["name"] for r in rep["rows"]], ["March 2026"])
        self.assertEqual((rep["rows"][0]["spend"], rep["rows"][0]["leads"]), (17.0, 9))

    def test_revenue_is_valued_per_campaign_inside_each_period(self):
        self.set_values(100, None)
        self.set_values(10, None, campaign=self.c1)
        rep = self.wk()
        # week 1: C1 3 qualified x 10 + no-campaign 1 x 100 = 130; every later week: one C1 qualified call x 10
        self.assertEqual([r["revenue"] for r in rep["rows"]], [130.0, 10.0, 10.0, 10.0])
        self.assertEqual(rep["rows"][0]["roi_pct"], 1200.0)
        self.assertEqual(rep["total"]["revenue"], 160.0)

    def test_without_a_value_revenue_is_blank_in_every_row(self):
        rep = self.wk()
        self.assertFalse(rep["has_value"])
        self.assertTrue(all(r["revenue"] is None and r["roi_pct"] is None for r in rep["rows"] + [rep["total"]]))

    def test_a_range_that_cuts_a_week_marks_it_partial(self):
        rep = self.data("/period/weekly", **{"from": "2026-03-02", "to": "2026-03-14"})
        self.assertTrue(rep["rows"][0]["partial"])                              # Mar 1 is before the range
        self.assertFalse(rep["rows"][1]["partial"])                             # Mar 8 .. 14 sits wholly inside it

    def test_empty_account(self):
        rep = self.data("/period/weekly", user=h.make_user("emptyp"))
        self.assertEqual((rep["has_data"], rep["rows"]), (False, []))

    def test_unknown_granularity_is_404(self):
        self.assertEqual(self.get("/period/yearly").status_code, 404)
        self.assertEqual(self.get("/period/yearly/export.csv").status_code, 404)

    def test_csv(self):
        r = self.get("/period/weekly/export.csv", **{"from": "2026-03-01", "to": "2026-03-31"})
        self.assertEqual(r.status_code, 200)
        lines = r.text.strip().split("\n")
        self.assertTrue(lines[0].startswith("Week,Calls,Spend"))
        self.assertEqual(len(lines), 1 + 4 + 1)                                  # header + 4 weeks + Total


# ---------------------------------------------------------------------------------------------- saving values

class Values(Base):
    def test_nothing_saved_yet(self):
        v = self.data("/values")
        self.assertEqual(v["account"], {"value_per_qualified_lead": None, "value_per_lead": None})
        self.assertEqual([c["name"] for c in v["campaigns"]], ["Listings", "Spring Push"])
        self.assertTrue(all(c["value_per_qualified_lead"] is None and c["value_per_lead"] is None for c in v["campaigns"]))

    def test_save_and_read_back(self):
        v = self.set_values(125.5, 10)
        self.assertEqual(v["account"], {"value_per_qualified_lead": 125.5, "value_per_lead": 10.0})
        v = self.set_values(40, None, campaign=self.c1)
        sp = next(c for c in v["campaigns"] if c["name"] == "Spring Push")
        self.assertEqual((sp["value_per_qualified_lead"], sp["value_per_lead"]), (40.0, None))
        self.assertEqual(v["account"]["value_per_qualified_lead"], 125.5)

    def test_saving_twice_updates_one_row(self):
        self.set_values(10)
        self.set_values(20)
        self.set_values(1, campaign=self.c1)
        self.set_values(2, campaign=self.c1)
        n = h.sql("select count(*) from lead_values where user_id = %s", (self.user,))[0][0]
        self.assertEqual(n, 2)
        self.assertEqual(self.data("/values")["account"]["value_per_qualified_lead"], 20.0)

    def test_blank_values_clear_the_row(self):
        self.set_values(10, 5)
        self.set_values(None, None)
        self.assertEqual(h.sql("select count(*) from lead_values where user_id = %s", (self.user,))[0][0], 0)
        self.assertFalse(self.data("/kpis")["has_value"])

    def test_clearing_a_campaign_makes_it_follow_the_account_again(self):
        self.set_values(100)
        self.set_values(10, campaign=self.c1)
        self.assertEqual(self.row("Spring Push")["value_source"], "campaign")
        self.set_values(None, None, campaign=self.c1)
        self.assertEqual(self.row("Spring Push")["value_source"], "account")

    def test_zero_is_a_valid_value(self):
        self.set_values(0)
        k = self.data("/kpis")
        self.assertTrue(k["has_value"])
        self.assertEqual((k["revenue"], k["profit"], k["roi_pct"]), (0.0, -10.0, -100.0))

    def test_bad_values_are_refused(self):
        for body in ({"value_per_qualified_lead": -5}, {"value_per_lead": -0.01}, {"value_per_qualified_lead": 10_000_001}):
            with self.subTest(body=body):
                r = self.put(body)
                self.assertEqual(r.status_code, 400, r.text)
        self.assertEqual(self.put({"value_per_qualified_lead": "abc"}).status_code, 422)

    def test_a_campaign_of_another_account_is_refused(self):
        theirs = self.campaign(self.other, "Theirs")
        self.assertEqual(self.put({"campaign_id": theirs, "value_per_qualified_lead": 5}).status_code, 400)
        self.assertEqual(self.put({"campaign_id": "nope", "value_per_qualified_lead": 5}).status_code, 400)
        self.assertEqual(h.sql("select count(*) from lead_values where user_id = %s", (self.other,))[0][0], 0)

    def test_deleting_a_campaign_removes_its_value(self):
        self.set_values(10, campaign=self.c2)
        supabase.table("outbound_campaigns").delete().eq("id", self.c2).execute()
        self.assertEqual(h.sql("select count(*) from lead_values where campaign_id = %s", (self.c2,))[0][0], 0)

    def test_values_are_per_account(self):
        self.set_values(100)
        self.assertEqual(self.data("/values", user=self.other)["account"]["value_per_qualified_lead"], None)
        self.assertFalse(self.data("/kpis", user=self.other)["has_value"])


# ---------------------------------------------------------------------------------------------- inbound vs outbound

class Inbound(Base):
    """On top of Base (its one inbound call: Mar 6, $2.00, qualified, no phone number):
    Main line   3 inbound calls at $1.00 (Mar 3): 1 qualified, 1 with a callback request -> 2 leads
    +1555...02  2 inbound calls at $0.50 (Mar 3): no leads
    => inbound 6 calls, $6.00, 3 leads, 2 qualified; outbound (Base) 16 calls, $8.00, 5 leads, 3 qualified."""

    def setUp(self):
        super().setUp()
        self.n1 = supabase.table("phone_numbers").insert({"user_id": self.user, "number": "+15551230001", "label": "Main line"}).execute().data[0]["id"]
        self.n2 = supabase.table("phone_numbers").insert({"user_id": self.user, "number": "+15551230002"}).execute().data[0]["id"]
        insert_call(self.user, at(3), 1.0, qualified=True, direction="inbound", number=self.n1)
        _, vapi = insert_call(self.user, at(3), 1.0, direction="inbound", number=self.n1)
        add_callback(self.user, vapi=vapi)
        insert_call(self.user, at(3), 1.0, direction="inbound", number=self.n1)
        for _ in range(2):
            insert_call(self.user, at(3), 0.5, direction="inbound", number=self.n2)

    def row_of(self, path, name, **kw):
        return next(r for r in self.data(path, **kw)["rows"] if r["name"] == name)

    def test_directions_side_by_side(self):
        d = self.data("/directions")
        out, inb = d["outbound"], d["inbound"]
        self.assertEqual((out["calls"], out["spend"], out["leads"], out["qualified_leads"], out["cost_per_lead"]), (16, 8.0, 5, 3, 1.6))
        self.assertEqual((inb["calls"], inb["spend"], inb["leads"], inb["qualified_leads"], inb["cost_per_lead"], inb["cost_per_qualified_lead"]),
                         (6, 6.0, 3, 2, 2.0, 3.0))
        self.assertTrue(out["has_data"] and inb["has_data"])

    def test_the_two_directions_add_up_to_the_total(self):
        d, total = self.data("/directions"), self.data("/kpis")
        for key in ("calls", "spend", "leads", "qualified_leads"):
            self.assertAlmostEqual(d["outbound"][key] + d["inbound"][key], total[key], places=2)

    def test_directions_ignore_the_direction_filter(self):
        d = self.data("/directions", direction="inbound")
        self.assertEqual((d["outbound"]["calls"], d["inbound"]["calls"]), (16, 6))

    def test_directions_follow_the_other_filters(self):
        d = self.data("/directions", campaign_ids=self.c1)
        self.assertEqual((d["outbound"]["calls"], d["inbound"]["calls"], d["inbound"]["has_data"]), (12, 0, False))
        self.assertEqual((d["inbound"]["cost_per_lead"], d["inbound"]["spend"]), (None, 0))

    def test_a_direction_with_no_calls_is_empty_not_missing(self):
        user = h.make_user("outonly")
        insert_call(user, at(2), 1.0, qualified=True)
        d = self.data("/directions", user=user)
        self.assertFalse(d["inbound"]["has_data"])
        self.assertEqual((d["inbound"]["calls"], d["inbound"]["cost_per_lead"], d["inbound"]["roi_pct"]), (0, None, None))
        self.assertEqual(d["outbound"]["cost_per_lead"], 1.0)
        self.assertFalse(self.data("/directions", user=h.make_user("none2"))["outbound"]["has_data"])

    def test_directions_use_each_campaigns_own_value(self):
        self.set_values(100)
        self.set_values(10, campaign=self.c1)
        d = self.data("/directions")
        self.assertTrue(d["has_value"])
        self.assertEqual(d["inbound"]["revenue"], 200.0)           # 2 qualified x the account's 100
        self.assertEqual(d["outbound"]["revenue"], 30.0)           # C1's 3 qualified x 10; Listings has none
        self.assertEqual(d["inbound"]["roi_pct"], 3233.3)          # (200 - 6) / 6

    def test_without_a_value_directions_have_no_revenue(self):
        d = self.data("/directions")
        self.assertFalse(d["has_value"])
        self.assertEqual((d["inbound"]["revenue"], d["inbound"]["roi_pct"]), (None, None))

    def test_numbers_biggest_spender_first(self):
        rep = self.data("/number")
        self.assertEqual([r["name"] for r in rep["rows"]], ["Main line", "Unknown number", "+15551230002"])
        main = rep["rows"][0]
        self.assertEqual((main["calls"], main["spend"], main["leads"], main["qualified_leads"], main["cost_per_lead"], main["cost_per_qualified_lead"]),
                         (3, 3.0, 2, 1, 1.5, 3.0))
        unknown = rep["rows"][1]                                     # Base's inbound call has no number
        self.assertEqual((unknown["calls"], unknown["spend"], unknown["leads"]), (1, 2.0, 1))
        quiet = rep["rows"][2]
        self.assertEqual((quiet["spend"], quiet["leads"], quiet["cost_per_lead"], quiet["cost_per_qualified_lead"]), (1.0, 0, None, None))

    def test_number_total_is_the_inbound_total(self):
        rep = self.data("/number")
        inbound = self.data("/directions")["inbound"]
        for key in ("calls", "spend", "leads", "qualified_leads", "cost_per_lead"):
            self.assertEqual(rep["total"][key], inbound[key])
        for key in ("calls", "spend", "leads", "qualified_leads"):
            self.assertAlmostEqual(sum(r[key] for r in rep["rows"]), rep["total"][key], places=2)

    def test_number_report_is_inbound_whatever_the_direction_filter_says(self):
        self.assertEqual(self.data("/number", direction="outbound")["total"]["calls"], 6)

    def test_number_report_never_includes_outbound_calls(self):
        insert_call(self.user, at(4), 9.0, qualified=True, direction="outbound", number=self.n1)
        self.assertEqual(self.row_of("/number", "Main line")["spend"], 3.0)

    def test_number_value_and_roi(self):
        self.set_values(100, 20)
        main = self.row_of("/number", "Main line")                   # 1 qualified x 100 + 1 other lead x 20 on $3
        self.assertEqual((main["revenue"], main["profit"], main["roi_pct"]), (120.0, 117.0, 3900.0))
        self.assertTrue(self.data("/number")["has_value"])

    def test_the_campaign_report_for_outbound_has_no_inbound_calls_in_it(self):
        rep = self.data("/campaign", direction="outbound")
        self.assertEqual([r["name"] for r in rep["rows"]], ["Spring Push", "Listings"])      # no "No campaign": that was inbound
        self.assertEqual((rep["total"]["calls"], rep["total"]["spend"]), (16, 8.0))
        csv = self.get("/campaign/export.csv", direction="outbound").text
        self.assertNotIn("No campaign", csv)

    def test_number_filter_narrows_the_report(self):
        rep = self.data("/number", numbers=self.n2)
        self.assertEqual([r["name"] for r in rep["rows"]], ["+15551230002"])

    def test_no_inbound_calls_means_no_data_and_no_csv(self):
        user = h.make_user("noinbound")
        insert_call(user, at(2), 1.0, qualified=True)               # outbound only
        rep = self.data("/number", user=user)
        self.assertEqual((rep["has_data"], rep["rows"], rep["total"]["cost_per_lead"]), (False, [], None))
        self.assertEqual(client.get(f"{PREFIX}/number/export.csv", params=q(), headers=auth(user)).status_code, 404)

    def test_number_csv_matches_the_screen(self):
        r = self.get("/number/export.csv")
        self.assertEqual(r.status_code, 200)
        self.assertIn("InboundCostPerLeadByNumber.csv", r.headers["content-disposition"])
        lines = r.text.strip().split("\n")
        self.assertEqual(lines[0], "Phone number,Calls,Spend,Leads,Qualified Leads,Cost per Lead,Cost per Qualified Lead,Revenue,Profit,ROI %")
        self.assertEqual(lines[1], "Main line,3,3.00,2,1,1.50,3.00,,,")
        self.assertEqual(lines[3], "+15551230002,2,1.00,0,0,,,,,")
        self.assertEqual(lines[-1], "Total,6,6.00,3,2,2.00,3.00,,,")

    def test_other_accounts_numbers_and_calls_stay_private(self):
        self.assertEqual(self.data("/number", user=self.other)["rows"], [])
        self.assertFalse(self.data("/directions", user=self.other)["inbound"]["has_data"])
        theirs = supabase.table("phone_numbers").insert({"user_id": self.other, "number": "+15559990000"}).execute().data[0]["id"]
        self.assertEqual(self.data("/number", numbers=theirs)["rows"], [])          # a forged number filter finds nothing

    def test_a_team_member_sees_the_owners_inbound_numbers(self):
        member = h.make_user("viewer2")
        supabase.table("team_members").insert({"owner_id": self.user, "member_user_id": member,
                                               "member_email": f"m-{uuid.uuid4().hex[:8]}@qa.test",
                                               "role": "viewer", "status": "Active"}).execute()
        self.assertEqual(len(self.data("/number", user=member)["rows"]), 3)
        self.assertEqual(self.data("/directions", user=member)["inbound"]["calls"], 6)


# ---------------------------------------------------------------------------------------------- access

class Access(Base):
    def member(self, role):
        member = h.make_user(role)
        supabase.table("team_members").insert({"owner_id": self.user, "member_user_id": member,
                                               "member_email": f"m-{uuid.uuid4().hex[:8]}@qa.test",
                                               "role": role, "status": "Active"}).execute()
        return member

    def test_requires_login(self):
        self.assertIn(client.get(f"{PREFIX}/kpis", params=q()).status_code, (401, 403))
        self.assertIn(client.put(f"{PREFIX}/values", json={"value_per_lead": 1}).status_code, (401, 403))

    def test_each_account_sees_only_its_own_calls(self):
        self.assertEqual(self.data("/kpis", user=self.other, **{"from": "2026-03-01"})["spend"], 4.0)
        self.assertEqual(self.data("/kpis")["spend"], 10.0)

    def test_a_forged_campaign_filter_cannot_reach_another_accounts_calls(self):
        self.assertEqual(self.data("/kpis", user=self.other, campaign_ids=self.c1)["calls"], 0)

    def test_a_team_member_sees_the_owners_numbers_and_values(self):
        self.set_values(100)
        member = self.member("viewer")
        self.assertEqual(self.data("/kpis", user=member)["spend"], 10.0)
        self.assertEqual(self.data("/values", user=member)["account"]["value_per_qualified_lead"], 100.0)

    def test_a_team_member_cannot_change_the_values(self):
        for role in ("member", "viewer"):
            with self.subTest(role=role):
                r = self.put({"value_per_qualified_lead": 999}, user=self.member(role))
                self.assertEqual(r.status_code, 403, r.text)
        self.assertEqual(h.sql("select count(*) from lead_values where user_id = %s", (self.user,))[0][0], 0)

    def test_validation(self):
        for params in ({"tz": "Mars/Base"}, {"from": "2026-03-09", "to": "2026-03-02"}, {"direction": "sideways"},
                       {"campaign_ids": "nope"}, {"from": "2020-01-01", "to": "2026-03-02"}):
            with self.subTest(params=params):
                self.assertEqual(self.get("/kpis", **params).status_code, 400)

    def test_no_dates_means_all_time(self):
        r = client.get(f"{PREFIX}/kpis", params={"tz": "UTC"}, headers=auth(self.user))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["data"]["spend"], 13.0)                        # the Mar 20 call is in range now


if __name__ == "__main__":
    unittest.main()
