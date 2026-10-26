"""Cost per lead & ROI: joins what the account SPENT on calls (conversations.call_cost, the amount billed) with
what those calls PRODUCED (leads), per campaign and over time. Backs routers/lead_roi.py.

Definitions (the whole module rests on these)
  * spend = SUM(call_cost) of the account's calls in the window, whatever their status (a no-answer or voicemail
    still costs money, and that is exactly the cost a lead has to pay for). Seeded "[SAMPLE]" demo rows are left
    out, the same as the Call Costs page. Phone-number rental is NOT included: it is not tied to any call.
  * qualified lead = a call the AI handed to a human (conversations.qualified, the figure Analytics already shows).
  * lead = a qualified call, OR a call where the person asked for a callback (a `callbacks` row) or the agent booked
    a meeting (a non-cancelled `calendar_bookings` row). Every qualified lead is a lead, never the reverse, so
    qualified <= leads <= calls. Counted per call: a person who qualifies on two calls counts twice.
  * cost per lead = spend / leads, cost per qualified lead = spend / qualified. NONE (not 0) when the divisor is 0:
    "no leads" must never read as "free leads".
  * value (set by the owner, table lead_values): money one qualified lead is worth, and money one OTHER lead
    (callback / booking, not transferred) is worth. revenue = qualified x value_qualified + other leads x
    value_other; profit = revenue - spend; ROI % = profit / spend x 100. A campaign's own value overrides the
    account default field by field. With no value at all (or no spend) revenue / profit / ROI are NONE and the report
    shows costs only.
  * Every ratio is computed from summed money and counts at every level (campaign row, period row, Total): never
    an average of children's ratios.

All times are bucketed in `Filters.tz` (the viewer's zone, sent by the page), like the Call Consumption reports,
whose Filters and week / month bucketing this module reuses.
"""
import csv
import io
import math
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from database import supabase
from db_pg import _get_pool
from dataclasses import replace

from services.call_consumption import (
    DIRECTIONS, GRANULARITIES, NO_CAMPAIGN, UNCATEGORIZED, UNKNOWN_NUMBER, Filters, _campaign_names, _number_names,
    _period_bounds, _period_label,
)

# The most one lead may be valued at (a typo guard, not a business rule).
MAX_VALUE = 10_000_000
DELETED_CAMPAIGN = "Deleted campaign"

# A call is a lead when it was qualified, or produced a callback request or a booked meeting.
LEAD_SQL = """(coalesce(c.qualified, false)
    OR EXISTS (SELECT 1 FROM public.callbacks cb WHERE cb.user_id = c.user_id
               AND (cb.conversation_id = c.id OR (cb.vapi_call_id IS NOT NULL AND cb.vapi_call_id = c.vapi_call_id)))
    OR EXISTS (SELECT 1 FROM public.calendar_bookings b WHERE b.user_id = c.user_id AND b.status <> 'cancelled'
               AND b.vapi_call_id IS NOT NULL AND b.vapi_call_id = c.vapi_call_id))"""


class LeadValueError(ValueError):
    """A value the owner typed (or a campaign they named) that cannot be saved. The message is shown as it is."""


# --------------------------------------------------------------------------------------- tallies

def _ratio(num: float, den: float, digits: int | None = 2) -> float | None:
    """num / den rounded (unrounded with digits=None), or None when there is nothing to divide by."""
    if den <= 0:
        return None
    return num / den if digits is None else round(num / den, digits)


@dataclass
class Tally:
    """Money and counts for one slice (a campaign, a period, everything). Ratios are derived, never stored."""
    calls: int = 0
    spend: float = 0.0
    leads: int = 0
    qualified: int = 0
    revenue: float = 0.0
    valued: bool = False  # revenue is meaningful: a value applied to at least one slice merged in

    @property
    def other_leads(self) -> int:
        return self.leads - self.qualified

    def add(self, calls: int, spend: float, leads: int, qualified: int, values: "Values | None") -> None:
        self.calls += calls
        self.spend += spend
        self.leads += leads
        self.qualified += qualified
        if values is not None and values.is_set:
            self.valued = True
            self.revenue += qualified * (values.qualified or 0) + (leads - qualified) * (values.other or 0)

    def merge(self, other: "Tally") -> None:
        self.calls += other.calls
        self.spend += other.spend
        self.leads += other.leads
        self.qualified += other.qualified
        self.revenue += other.revenue
        self.valued = self.valued or other.valued

    @property
    def profit(self) -> float | None:
        return self.revenue - self.spend if self.valued else None

    def roi_pct(self, digits: int = 1) -> float | None:
        """Profit as a percentage of spend. None without a value, or when nothing was spent."""
        p = self.profit
        return round(p / self.spend * 100, digits) if p is not None and self.spend > 0 else None

    def row(self) -> dict:
        return {
            "calls": self.calls,
            "spend": round(self.spend, 2),
            "leads": self.leads,
            "qualified_leads": self.qualified,
            "cost_per_lead": _ratio(self.spend, self.leads),
            "cost_per_qualified_lead": _ratio(self.spend, self.qualified),
            "revenue": round(self.revenue, 2) if self.valued else None,
            "profit": round(self.profit, 2) if self.profit is not None else None,
            "roi_pct": self.roi_pct(),
        }


@dataclass(frozen=True)
class Values:
    """What a lead is worth for one campaign, after the campaign's own numbers overrode the account's."""
    qualified: float | None = None
    other: float | None = None
    source: str | None = None  # "campaign" | "account" | None

    @property
    def is_set(self) -> bool:
        return self.qualified is not None or self.other is not None


# --------------------------------------------------------------------------------------- values (stored)

def _num(v) -> float | None:
    return None if v is None else float(v)


def load_values(owner_id: str) -> tuple[dict, dict]:
    """(account default, {campaign_id: override}); each is {"qualified": float|None, "other": float|None}."""
    with _get_pool().connection() as conn:
        rows = conn.execute(
            "SELECT campaign_id, value_per_qualified_lead AS q, value_per_lead AS o FROM public.lead_values"
            " WHERE user_id = %s::uuid", (owner_id,)).fetchall()
    account = {"qualified": None, "other": None}
    campaigns: dict = {}
    for r in rows:
        v = {"qualified": _num(r["q"]), "other": _num(r["o"])}
        if r["campaign_id"] is None:
            account = v
        else:
            campaigns[str(r["campaign_id"])] = v
    return account, campaigns


def effective_values(campaign_id: str | None, account: dict, campaigns: dict) -> Values:
    """The account default, with the campaign's own number winning wherever it set one."""
    own = campaigns.get(campaign_id or "", {"qualified": None, "other": None})
    q = own["qualified"] if own["qualified"] is not None else account["qualified"]
    o = own["other"] if own["other"] is not None else account["other"]
    if q is None and o is None:
        return Values()
    from_campaign = own["qualified"] is not None or own["other"] is not None
    return Values(q, o, "campaign" if from_campaign else "account")


def _clean_value(v, label: str) -> float | None:
    if v is None or v == "":
        return None
    try:
        n = float(v)
    except (TypeError, ValueError):
        raise LeadValueError(f"{label} must be a number.")
    if math.isnan(n) or math.isinf(n) or n < 0:
        raise LeadValueError(f"{label} must be zero or more.")
    if n > MAX_VALUE:
        raise LeadValueError(f"{label} can be at most {MAX_VALUE:,}.")
    return round(n, 2)


def save_values(owner_id: str, campaign_id: str | None, qualified, other) -> dict:
    """Set what a lead is worth for the account (campaign_id None) or one campaign. Both values blank removes the
    row (account: no value at all; campaign: it follows the account again). Returns load_values_view()."""
    q = _clean_value(qualified, "The value of a qualified lead")
    o = _clean_value(other, "The value of another lead")
    if campaign_id:
        try:
            campaign_id = str(uuid.UUID(campaign_id))
        except ValueError:
            raise LeadValueError("That campaign isn't valid.")
        owned = supabase.table("outbound_campaigns").select("id").eq("id", campaign_id).eq("user_id", owner_id) \
            .limit(1).execute().data
        if not owned:
            raise LeadValueError("That campaign isn't valid.")
    with _get_pool().connection() as conn:
        if q is None and o is None:
            conn.execute("DELETE FROM public.lead_values WHERE user_id = %s::uuid AND campaign_id IS NOT DISTINCT FROM %s::uuid",
                         (owner_id, campaign_id))
        elif campaign_id:
            conn.execute(
                "INSERT INTO public.lead_values (user_id, campaign_id, value_per_qualified_lead, value_per_lead)"
                " VALUES (%s::uuid, %s::uuid, %s, %s)"
                " ON CONFLICT (user_id, campaign_id) WHERE campaign_id IS NOT NULL DO UPDATE SET"
                " value_per_qualified_lead = EXCLUDED.value_per_qualified_lead, value_per_lead = EXCLUDED.value_per_lead,"
                " updated_at = now()", (owner_id, campaign_id, q, o))
        else:
            conn.execute(
                "INSERT INTO public.lead_values (user_id, value_per_qualified_lead, value_per_lead)"
                " VALUES (%s::uuid, %s, %s)"
                " ON CONFLICT (user_id) WHERE campaign_id IS NULL DO UPDATE SET"
                " value_per_qualified_lead = EXCLUDED.value_per_qualified_lead, value_per_lead = EXCLUDED.value_per_lead,"
                " updated_at = now()", (owner_id, q, o))
    return values_view(owner_id)


def values_view(owner_id: str) -> dict:
    """The settings screen: the account default and, for every campaign, its override (nulls = follows the account)."""
    account, overrides = load_values(owner_id)
    names = _campaign_names(owner_id)
    campaigns = [{"campaign_id": cid, "name": name,
                  "value_per_qualified_lead": overrides.get(cid, {}).get("qualified"),
                  "value_per_lead": overrides.get(cid, {}).get("other")} for cid, name in names.items()]
    campaigns.sort(key=lambda c: c["name"].lower())
    return {"account": {"value_per_qualified_lead": account["qualified"], "value_per_lead": account["other"]},
            "campaigns": campaigns}


# --------------------------------------------------------------------------------------- query

# What a row can be grouped by (the key is also the name of its column in the rows).
_DIMENSIONS = {
    "day": "(c.call_time AT TIME ZONE %(tz)s)::date",
    "campaign": "c.campaign_id",
    "number": "c.phone_number_id",
    "direction": "coalesce(c.direction, 'outbound')",
}


def fetch(owner_id: str, flt: Filters, group: tuple = ("day", "campaign")) -> list[dict]:
    """One row per combination of the `group` dimensions (see _DIMENSIONS) with calls, spend, leads and qualified
    calls: {<dimension>..., calls, spend, leads, qualified}. Everything else in this module is shaped from these
    rows in Python."""
    start, end = flt.window()
    params: dict = {"owner": owner_id, "tz": flt.tz, "uncat": UNCATEGORIZED, "start": start, "end": end}
    extra = ""
    if flt.campaign_ids:
        extra += " AND c.campaign_id = ANY(%(campaign_ids)s)"
        params["campaign_ids"] = [uuid.UUID(c) for c in flt.campaign_ids]
    if flt.numbers:
        extra += " AND c.phone_number_id = ANY(%(number_ids)s)"
        params["number_ids"] = [uuid.UUID(n) for n in flt.numbers]
    if flt.agent_id:
        extra += " AND c.agent_id = %(agent_id)s::uuid"
        params["agent_id"] = flt.agent_id
    if flt.direction:
        extra += " AND coalesce(c.direction, 'outbound') = %(direction)s"
        params["direction"] = flt.direction
    if flt.vertical:
        extra += " AND COALESCE(NULLIF(btrim(a.category), ''), %(uncat)s) = %(vertical)s"
        params["vertical"] = flt.vertical
    select = "".join(f"{_DIMENSIONS[g]} AS {g}, " for g in group)
    group_by = ", ".join(str(i + 1) for i in range(len(group)))
    sql = (
        f"SELECT {select}count(*)::int AS calls,"
        " coalesce(sum(c.call_cost), 0) AS spend,"
        f" (count(*) FILTER (WHERE {LEAD_SQL}))::int AS leads,"
        " (count(*) FILTER (WHERE coalesce(c.qualified, false)))::int AS qualified"
        " FROM public.conversations c LEFT JOIN public.ai_agents a ON a.id = c.agent_id"
        " WHERE c.user_id = %(owner)s::uuid AND c.call_time >= %(start)s AND c.call_time < %(end)s"
        " AND left(coalesce(c.contact_name, ''), 8) <> '[SAMPLE]'"
        f"{extra} GROUP BY {group_by}"
    )
    with _get_pool().connection() as conn:
        return conn.execute(sql, params).fetchall()


class Report:
    """The window's rows with the owner's values applied: `by_campaign`, `by_day` and the grand `total` Tally."""

    def __init__(self, owner_id: str, flt: Filters):
        self.account, self.overrides = load_values(owner_id)
        self.by_campaign: dict = {}   # campaign id ("" = none) -> Tally
        self.by_day: dict = {}        # date -> Tally
        self.total = Tally()
        self.any_value = self.account["qualified"] is not None or self.account["other"] is not None \
            or any(v["qualified"] is not None or v["other"] is not None for v in self.overrides.values())
        for r in fetch(owner_id, flt, ("day", "campaign")):
            cid = str(r["campaign"]) if r["campaign"] else ""
            vals = effective_values(cid, self.account, self.overrides)
            args = (r["calls"], float(r["spend"] or 0), r["leads"], r["qualified"], vals)
            for tally in (self.by_campaign.setdefault(cid, Tally()), self.by_day.setdefault(r["day"], Tally()), self.total):
                tally.add(*args)

    def unvalued_with_leads(self) -> list[str]:
        """Campaign ids (or "") that produced leads but have no value, so their revenue counts as nothing."""
        return [cid for cid, t in self.by_campaign.items()
                if t.leads > 0 and not effective_values(cid, self.account, self.overrides).is_set]


# --------------------------------------------------------------------------------------- KPIs

def _change_pct(cur: float | None, prev: float | None) -> float | None:
    """Relative change in percent, or None when there is nothing to compare (no previous figure, or it was 0)."""
    if cur is None or prev is None or prev == 0:
        return None
    return round((cur - prev) / prev * 100, 1)


def kpis(owner_id: str, flt: Filters) -> dict:
    cur = Report(owner_id, flt)
    prev = Report(owner_id, flt.previous())
    t, p = cur.total, prev.total
    row, prow = t.row(), p.row()
    roi, proi = t.roi_pct(), p.roi_pct()
    return {
        "has_data": t.calls > 0,
        "has_previous": p.calls > 0,
        **row,
        "has_value": cur.any_value,
        # Campaigns that made leads but have no value: their revenue is counted as nothing (the page warns).
        "unvalued_campaigns": len(cur.unvalued_with_leads()),
        "spend_change_pct": _change_pct(row["spend"], prow["spend"]),
        "leads_change_pct": _change_pct(row["leads"], prow["leads"]),
        "qualified_leads_change_pct": _change_pct(row["qualified_leads"], prow["qualified_leads"]),
        # Changes are taken on the exact ratios, not on the rounded ones shown in the cards.
        "cost_per_lead_change_pct": _change_pct(_ratio(t.spend, t.leads, None), _ratio(p.spend, p.leads, None)),
        "cost_per_qualified_lead_change_pct": _change_pct(_ratio(t.spend, t.qualified, None), _ratio(p.spend, p.qualified, None)),
        # ROI moves in percentage POINTS, not as a relative change.
        "roi_point_change": round(roi - proi, 1) if roi is not None and proi is not None else None,
    }


# --------------------------------------------------------------------------------------- per campaign

def campaign_report(owner_id: str, flt: Filters) -> dict:
    """One row per campaign (plus "No campaign" for inbound and other unattached calls), biggest spender first."""
    rep = Report(owner_id, flt)
    names = _campaign_names(owner_id)
    rows = []
    for cid, t in rep.by_campaign.items():
        vals = effective_values(cid, rep.account, rep.overrides)
        rows.append({
            "key": cid,
            "name": names.get(cid, DELETED_CAMPAIGN) if cid else NO_CAMPAIGN,
            **t.row(),
            "value_per_qualified_lead": vals.qualified,
            "value_per_lead": vals.other,
            "value_source": vals.source,
        })
    rows.sort(key=lambda r: (-r["spend"], r["name"].lower()))
    return {"has_data": rep.total.calls > 0, "has_value": rep.any_value, "rows": rows,
            "total": {"name": "Total", **rep.total.row()}}


# --------------------------------------------------------------------------------------- weekly / monthly

def period_report(owner_id: str, flt: Filters, granularity: str) -> dict:
    """One row per week (Sunday-start) or calendar month, oldest first, from the first period with calls to the last;
    a period in between with no calls is a zero row so the trend has no holes. `partial` marks a period the range
    cuts or that is still running (its figures cover only part of it)."""
    if granularity not in GRANULARITIES:
        raise ValueError(f"unknown granularity {granularity!r}")
    rep = Report(owner_id, flt)
    today = datetime.now(ZoneInfo(flt.tz)).date()
    groups: dict = {}
    for d, t in rep.by_day.items():
        groups.setdefault(_period_bounds(d, granularity)[0], Tally()).merge(t)
    rows: list = []
    if groups:
        cursor, last = min(groups), max(groups)
        while cursor <= last:
            start, end = _period_bounds(cursor, granularity)
            rows.append({
                "key": start.isoformat(),
                "name": _period_label(start, end, granularity),
                "start_date": start.isoformat(),
                "end_date": end.isoformat(),
                "partial": start < flt.from_date or end > flt.to_date or end >= today,
                **groups.get(start, Tally()).row(),
            })
            cursor = end + timedelta(days=1)
    return {"has_data": rep.total.calls > 0, "has_value": rep.any_value, "granularity": granularity, "rows": rows,
            "total": {"name": "Total", **rep.total.row()}}


# --------------------------------------------------------------------------------------- inbound vs outbound

def _tally_by(owner_id: str, flt: Filters, dimension: str) -> tuple[dict, bool]:
    """({value of `dimension`: Tally}, any_value). Rows are fetched by (dimension, campaign) so each campaign's own
    value (or the account's) is applied to exactly its calls, then summed per `dimension`."""
    account, overrides = load_values(owner_id)
    any_value = account["qualified"] is not None or account["other"] is not None         or any(v["qualified"] is not None or v["other"] is not None for v in overrides.values())
    out: dict = {}
    for r in fetch(owner_id, flt, (dimension, "campaign")):
        vals = effective_values(str(r["campaign"]) if r["campaign"] else "", account, overrides)
        out.setdefault(r[dimension], Tally()).add(r["calls"], float(r["spend"] or 0), r["leads"], r["qualified"], vals)
    return out, any_value


def directions_report(owner_id: str, flt: Filters) -> dict:
    """Inbound next to outbound for the same window and filters, except the direction filter itself (the whole point
    is to show both). A direction with no calls is all zeros / None. Their figures add up to the Total."""
    tallies, any_value = _tally_by(owner_id, replace(flt, direction=None), "direction")
    out = {"has_value": any_value}
    for d in DIRECTIONS:
        t = tallies.get(d, Tally())
        out[d] = {"has_data": t.calls > 0, **t.row()}
    return out


def number_report(owner_id: str, flt: Filters) -> dict:
    """INBOUND calls by the NEXUS phone number the caller reached (inbound calls have no campaign): the number's
    spend, leads and cost per lead, biggest spender first. Calls whose number is gone are under "Unknown number".
    The direction filter is ignored: this report is inbound by definition."""
    flt = replace(flt, direction="inbound")
    tallies, any_value = _tally_by(owner_id, flt, "number")
    names = _number_names(owner_id)
    rows = []
    total = Tally()
    for nid, t in tallies.items():
        total.merge(t)
        rows.append({"key": str(nid) if nid else "", "name": names.get(str(nid), UNKNOWN_NUMBER) if nid else UNKNOWN_NUMBER, **t.row()})
    rows.sort(key=lambda r: (-r["spend"], r["name"].lower()))
    return {"has_data": total.calls > 0, "has_value": any_value, "rows": rows, "total": {"name": "Total", **total.row()}}


# --------------------------------------------------------------------------------------- CSV exports

def _csv(header: list, rows: list) -> str:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(header)
    w.writerows(rows)
    return buf.getvalue()


def _money(v) -> str:
    return "" if v is None else f"{v:.2f}"


_HEADERS = ["Calls", "Spend", "Leads", "Qualified Leads", "Cost per Lead", "Cost per Qualified Lead", "Revenue", "Profit", "ROI %"]


def _cells(node: dict) -> list:
    return [node["calls"], _money(node["spend"]), node["leads"], node["qualified_leads"], _money(node["cost_per_lead"]),
            _money(node["cost_per_qualified_lead"]), _money(node["revenue"]), _money(node["profit"]),
            "" if node["roi_pct"] is None else node["roi_pct"]]


def table_csv(report: dict, name_header: str) -> str:
    """A campaign or weekly / monthly report as CSV, built from the same rows as the screen (blank = not available)."""
    rows = [[r["name"]] + _cells(r) for r in report["rows"]]
    rows.append(["Total"] + _cells(report["total"]))
    return _csv([name_header] + _HEADERS, rows)
