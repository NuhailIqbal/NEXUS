"""Dashboard home: one read-only snapshot of "how is my calling doing right now?". Backs routers/dashboard.py.

Everything is scoped to the account OWNER (team members see the owner's numbers) and computed on request; nothing is
stored. The headline figures REUSE the engines of the reports they summarise, so a tile can never disagree with the
page it links to:

  * calls, spend, leads, qualified leads, cost per (qualified) lead  <- services/lead_roi.py (its Report / Tally:
    spend, the lead definition and the [SAMPLE]-row exclusion are defined there, not here)
  * answered rate (consumed / finished calls)                        <- services/call_consumption.py
  * minutes                                                          <- SUM(conversations.duration_seconds), the
    one figure neither report has

One window (the chosen range and the equally long range before it, at least 7 days so the trend has a shape) is read
ONCE from each engine, per day; the tiles, their change against the previous range and the trend are all sums of those
days. Days are the viewer's own (`tz`), like the other reports.

One known difference: Call Consumption does not leave seeded "[SAMPLE]" demo rows out (Cost per Lead does), so the
answered rate counts them while every other figure here does not. Nothing in the app creates such rows any more.

Plain sync functions (blocking SQL): the router is a plain `def`, so FastAPI runs it in its threadpool.
"""
import logging
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from db_pg import _get_pool
from services import call_consumption as cc
from services import lead_roi as lr

logger = logging.getLogger(__name__)

# The ranges the page offers: key -> number of days (ending today, in the viewer's time zone). "custom" is any
# From..To the viewer picks (at most cc.MAX_RANGE_DAYS days, like every other report).
RANGES = {"today": 1, "7d": 7, "30d": 30}
CUSTOM = "custom"
ALL_RANGES = (*RANGES, CUSTOM)
DEFAULT_RANGE = "today"
# The trend always shows at least a week, even for "today", or it would be a single dot.
MIN_TREND_DAYS = 7
# A call is "running" while its conversation is in one of these statuses (set by routers/webhooks.py on call-started / status-update).
LIVE_STATUSES = ("Initiated", "Ringing", "In Progress", "Forwarding")
# ...and only if it started this recently: a call whose end-of-call message never arrived must not count as running forever.
LIVE_MAX_AGE_MINUTES = 30
# A range of at most this many days is charted hour by hour, a longer one day by day.
HOURLY_MAX_DAYS = 2
# How many rows each "Top ..." table lists.
TOP_N = 5

SAMPLE_SQL = "left(coalesce(c.contact_name, ''), 8) <> '[SAMPLE]'"


def _rows(sql: str, params: dict | tuple) -> list[dict]:
    with _get_pool().connection() as conn:
        return conn.execute(sql, params).fetchall()


def _iso(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return (value if value.tzinfo else value.replace(tzinfo=timezone.utc)).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return str(value)


# --------------------------------------------------------------------------------------- windows

class RangeError(ValueError):
    """A custom range that cannot be used. The message is shown as it is."""


def check_custom(from_date: date | None, to_date: date | None) -> tuple[date, date]:
    """The validated (from, to) of a custom range: both given, in order, and not longer than the other reports allow."""
    if from_date is None or to_date is None:
        raise RangeError("Pick both a start and an end date.")
    if from_date > to_date:
        raise RangeError("The start date must be on or before the end date.")
    if (to_date - from_date).days + 1 > cc.MAX_RANGE_DAYS:
        raise RangeError(f"Pick a range of at most {cc.MAX_RANGE_DAYS} days.")
    return from_date, to_date


def windows(range_key: str, tz: str, today: date | None = None, custom: tuple[date, date] | None = None) -> dict:
    """The dates everything is cut from: `current` (from, to), `previous` (the same length, just before it) and `span`
    (the one window read from the database: the previous start .. the end, or the last 7 days when that is shorter).
    A custom range ends on its own `to` (which may be in the past), the others end today."""
    if range_key == CUSTOM:
        cur_from, to = custom
        days = (to - cur_from).days + 1
    else:
        days = RANGES[range_key]
        to = today or datetime.now(ZoneInfo(tz)).date()
        cur_from = to - timedelta(days=days - 1)
    prev_to = cur_from - timedelta(days=1)
    prev_from = prev_to - timedelta(days=days - 1)
    span_from = min(prev_from, to - timedelta(days=MIN_TREND_DAYS - 1))
    return {"days": days, "current": (cur_from, to), "previous": (prev_from, prev_to), "span": (span_from, to),
            "trend_from": to - timedelta(days=max(days, MIN_TREND_DAYS) - 1)}


def _days(start: date, end: date):
    d = start
    while d <= end:
        yield d
        d += timedelta(days=1)


# --------------------------------------------------------------------------------------- headline tiles + trend

def _minutes_by_day(owner_id: str, flt: cc.Filters) -> dict:
    start, end = flt.window()
    rows = _rows(
        "SELECT (c.call_time AT TIME ZONE %(tz)s)::date AS day, coalesce(sum(c.duration_seconds), 0)::bigint AS seconds"
        " FROM public.conversations c WHERE c.user_id = %(owner)s::uuid AND c.call_time >= %(start)s AND c.call_time < %(end)s"
        f" AND {SAMPLE_SQL} GROUP BY 1", {"tz": flt.tz, "owner": owner_id, "start": start, "end": end})
    return {r["day"]: int(r["seconds"] or 0) for r in rows}


def _sum(by_day: dict, start: date, end: date, factory):
    total = factory()
    for d in _days(start, end):
        if d in by_day:
            total.merge(by_day[d])
    return total


def _tile(cur, prev, has_previous: bool, change=lr._change_pct) -> dict:
    """{value, previous, change_pct}; the change is None when the previous range has nothing to compare with."""
    return {"value": cur, "previous": prev, "change_pct": change(cur, prev) if has_previous else None}


def headline(owner_id: str, range_key: str, tz: str, win: dict) -> tuple[dict, list[dict]]:
    """(tiles, trend). Spend / leads / cost per lead come from lead_roi's Tally (summed per day, so a ratio is always
    SUM / SUM, never an average of days), the answered rate from call_consumption's, minutes from the minutes query."""
    flt = cc.Filters(from_date=win["span"][0], to_date=win["span"][1], tz=tz)
    roi = lr.Report(owner_id, flt).by_day
    consumption = cc._tally_rows(cc.fetch(owner_id, flt, ("day",)), lambda r: r["day"])
    minutes = _minutes_by_day(owner_id, flt)

    (cf, ct), (pf, pt) = win["current"], win["previous"]
    cur, prev = _sum(roi, cf, ct, lr.Tally), _sum(roi, pf, pt, lr.Tally)
    cur_cc, prev_cc = _sum(consumption, cf, ct, cc.Tally), _sum(consumption, pf, pt, cc.Tally)
    cur_min = sum(minutes.get(d, 0) for d in _days(cf, ct)) / 60
    prev_min = sum(minutes.get(d, 0) for d in _days(pf, pt)) / 60
    has_prev = prev.calls > 0

    cur_row, prev_row = cur.row(), prev.row()
    ratio = lambda t: lr._ratio(t.spend, t.qualified, None)  # noqa: E731 - exact, not the rounded figure shown
    tiles = {
        "has_data": cur.calls > 0,
        "has_previous": has_prev,
        "calls": _tile(cur.calls, prev.calls, has_prev),
        # A percentage: its change is in percentage POINTS (None when nothing finished in either range).
        "answered_rate": {
            "value": cur_cc.consumption_pct(1) if cur_cc.total else None,
            "answered": cur_cc.consumed, "finished": cur_cc.total,
            "previous": prev_cc.consumption_pct(1) if prev_cc.total else None,
            "change_pts": round(cur_cc.consumption_pct(4) - prev_cc.consumption_pct(4), 1) if cur_cc.total and prev_cc.total else None,
            # The finished calls nobody answered, by why (Call Consumption's own buckets: no_answer, busy, voicemail,
            # hung_up, blocked, failed). answered + not_answered.total = finished, always.
            "not_answered": {"total": cur_cc.dropped, "buckets": dict(cur_cc.buckets)},
        },
        "qualified_leads": _tile(cur.qualified, prev.qualified, has_prev),
        "leads": _tile(cur.leads, prev.leads, has_prev),
        "minutes": _tile(round(cur_min, 1), round(prev_min, 1), has_prev),
        "spend": _tile(cur_row["spend"], prev_row["spend"], has_prev),
        # None (not 0) with no qualified leads: "no leads" must never read as "free leads".
        "cost_per_qualified_lead": {
            "value": cur_row["cost_per_qualified_lead"], "previous": prev_row["cost_per_qualified_lead"],
            "change_pct": lr._change_pct(ratio(cur), ratio(prev)) if has_prev else None,
        },
    }
    trend = []
    for d in _days(win["trend_from"], win["span"][1]):
        t, c = roi.get(d), consumption.get(d)
        trend.append({"date": d.isoformat(), "calls": t.calls if t else 0, "qualified_leads": t.qualified if t else 0,
                      "leads": t.leads if t else 0, "spend": round(t.spend, 2) if t else 0.0,
                      "minutes": round(minutes.get(d, 0) / 60, 1),
                      # Finished calls and how many were answered: the page works out each day's rate (None on a quiet day).
                      "answered": c.consumed if c else 0, "finished": c.total if c else 0})
    return tiles, trend


# --------------------------------------------------------------------------------------- campaigns

def campaigns(owner_id: str) -> dict:
    """{counts: {active, paused, inactive}, items: [...]}: how many campaigns the account has in each status, and the
    Active ones with what the dialer is doing right now (its state, why it is stalled, its last call error). The counts
    feed the live strip and the status line; the items feed the needs-attention list."""
    counts = {"active": 0, "paused": 0, "inactive": 0}
    for r in _rows("SELECT status, count(*)::int AS n FROM public.outbound_campaigns WHERE user_id = %s::uuid GROUP BY status", (owner_id,)):
        counts[str(r["status"]).lower()] = r["n"]
    rows = _rows("SELECT id, name, status FROM public.outbound_campaigns WHERE user_id = %s::uuid AND status = 'Active'"
                 " ORDER BY updated_at DESC", (owner_id,))
    live: dict = {}
    if rows:
        try:
            from services import dialer  # lazy: the dialing engine is heavy and only matters when something is running
            live = dialer.live_states(owner_id)
        except Exception:  # noqa: BLE001 - a dialer hiccup must never blank the dashboard
            logger.warning("dashboard: could not read the live dialing state", exc_info=True)
    items = []
    for r in rows:
        ls = live.get(str(r["id"])) or {}
        counters = ls.get("counters") or {}
        items.append({"id": str(r["id"]), "name": r["name"], "status": r["status"], "state": ls.get("state"),
                      "stall_reason": ls.get("stall_reason"), "errors": counters.get("errors", 0),
                      "last_error": counters.get("last_error")})
    return {"counts": counts, "items": items}


# --------------------------------------------------------------------------------------- setup

def setup(owner_id: str) -> dict:
    """Which of the first steps the account has taken (any row at all counts). Existence checks, not counts: cheap."""
    r = _rows(
        "SELECT EXISTS (SELECT 1 FROM public.ai_agents WHERE user_id = %(o)s::uuid) AS agent,"
        " EXISTS (SELECT 1 FROM public.phone_numbers WHERE user_id = %(o)s::uuid) AS phone,"
        " EXISTS (SELECT 1 FROM public.outbound_campaigns WHERE user_id = %(o)s::uuid) AS campaign,"
        " EXISTS (SELECT 1 FROM public.inbound_queues WHERE user_id = %(o)s::uuid) AS receptionist,"
        " EXISTS (SELECT 1 FROM public.conversations WHERE user_id = %(o)s::uuid) AS calls", {"o": owner_id})[0]
    out = {k: bool(v) for k, v in r.items()}
    # Ready to take calls: an agent, a number, and a way for calls to happen (a campaign or an AI receptionist).
    out["complete"] = out["agent"] and out["phone"] and (out["campaign"] or out["receptionist"])
    return out


def inventory(owner_id: str) -> dict:
    """What the account has set up: agents and inbound receptionists, each as total / active. (Outbound campaigns are
    counted by campaigns().) Plain counts over small per-account tables."""
    r = _rows(
        "SELECT (SELECT count(*) FROM public.ai_agents WHERE user_id = %(o)s::uuid)::int AS agents,"
        " (SELECT count(*) FROM public.ai_agents WHERE user_id = %(o)s::uuid AND status = 'Active')::int AS agents_active,"
        " (SELECT count(*) FROM public.inbound_queues WHERE user_id = %(o)s::uuid)::int AS receptionists,"
        " (SELECT count(*) FROM public.inbound_queues WHERE user_id = %(o)s::uuid AND status = 'Active')::int AS receptionists_active",
        {"o": owner_id})[0]
    return {"agents": {"total": r["agents"], "active": r["agents_active"]},
            "receptionists": {"total": r["receptionists"], "active": r["receptionists_active"]}}


# --------------------------------------------------------------------------------------- hour-by-hour chart

def hourly(owner_id: str, flt: cc.Filters) -> list[dict]:
    """One point per hour of the window, in the viewer's zone: {date, hour, calls, qualified_leads, leads}. The hours
    still to come (later than now) with no calls are None, not 0, so the chart's line stops at the present instead of
    falling to zero; an hour that has calls always shows them, even a call dated later today."""
    start, end = flt.window()
    rows = _rows(
        "SELECT date_trunc('hour', c.call_time AT TIME ZONE %(tz)s) AS hour, count(*)::int AS calls,"
        f" (count(*) FILTER (WHERE {lr.LEAD_SQL}))::int AS leads,"
        " (count(*) FILTER (WHERE coalesce(c.qualified, false)))::int AS qualified"
        " FROM public.conversations c WHERE c.user_id = %(owner)s::uuid AND c.call_time >= %(start)s AND c.call_time < %(end)s"
        f" AND {SAMPLE_SQL} GROUP BY 1", {"tz": flt.tz, "owner": owner_id, "start": start, "end": end})
    found = {r["hour"]: r for r in rows}
    now_hour = datetime.now(ZoneInfo(flt.tz)).replace(tzinfo=None, minute=0, second=0, microsecond=0)
    out = []
    for day in _days(flt.from_date, flt.to_date):
        for h in range(24):
            bucket = datetime(day.year, day.month, day.day, h)
            r = found.get(bucket)
            future = bucket > now_hour and r is None
            out.append({"date": day.isoformat(), "hour": h,
                        "calls": None if future else (r["calls"] if r else 0),
                        "qualified_leads": None if future else (r["qualified"] if r else 0),
                        "leads": None if future else (r["leads"] if r else 0)})
    return out


# --------------------------------------------------------------------------------------- top campaigns / agents / receptionists

# What each ranking groups the calls by: (FROM ... JOIN part, id expression, name expression, extra WHERE). The join is
# an inner one on purpose: a call with no campaign (a one-off dial, an inbound call), or whose agent was deleted, has
# nothing to be ranked under.
_TOPS = {
    "campaigns": ("JOIN public.outbound_campaigns g ON g.id = c.campaign_id", "g.id", "g.name", ""),
    "agents": ("JOIN public.ai_agents g ON g.id = c.agent_id", "g.id", "g.name", ""),
    # A receptionist is an inbound queue; its calls are the inbound ones that reached the number it answers on.
    "receptionists": ("JOIN public.inbound_queues g ON g.user_id = c.user_id AND g.phone_number_id = c.phone_number_id",
                      "g.id", "g.name", " AND coalesce(c.direction, 'outbound') = 'inbound'"),
}


def tops(owner_id: str, flt: cc.Filters) -> dict:
    """{campaigns, agents, receptionists}: for each, the TOP_N that did best in the window, best first. Best = most
    qualified leads, then most calls, then name. Each row has its calls, qualified leads, spend and cost per qualified
    lead (None, never 0, with no qualified lead). Leads are counted with lead_roi's own definition (LEAD_SQL), and
    [SAMPLE] rows are left out like everywhere else on the page."""
    start, end = flt.window()
    out = {}
    for key, (join, ident, name, extra) in _TOPS.items():
        rows = _rows(
            f"SELECT {ident} AS id, {name} AS name, count(*)::int AS calls, coalesce(sum(c.call_cost), 0) AS spend,"
            f" (count(*) FILTER (WHERE {lr.LEAD_SQL}))::int AS leads,"
            " (count(*) FILTER (WHERE coalesce(c.qualified, false)))::int AS qualified"
            f" FROM public.conversations c {join}"
            f" WHERE c.user_id = %(owner)s::uuid AND c.call_time >= %(start)s AND c.call_time < %(end)s AND {SAMPLE_SQL}{extra}"
            f" GROUP BY {ident}, {name} ORDER BY qualified DESC, calls DESC, {name} LIMIT {TOP_N}",
            {"owner": owner_id, "start": start, "end": end})
        out[key] = [{
            "id": str(r["id"]), "name": r["name"], "calls": r["calls"], "leads": r["leads"], "qualified_leads": r["qualified"],
            "spend": round(float(r["spend"] or 0), 2),
            "cost_per_qualified_lead": lr._ratio(float(r["spend"] or 0), r["qualified"]),
        } for r in rows]
    return out


# --------------------------------------------------------------------------------------- live (polled every few seconds)

def live(owner_id: str, tz: str) -> dict:
    """The two figures that must stay fresh, whatever range the page shows: calls running right now (outbound and
    inbound, started within LIVE_MAX_AGE_MINUTES) and calls today in the viewer's time zone with how many were answered.
    Two small indexed queries, cheap enough to poll."""
    zone = ZoneInfo(tz)
    today = datetime.now(zone).date()
    flt = cc.Filters(from_date=today, to_date=today, tz=tz)
    start, end = flt.window()
    r = _rows(
        "SELECT (count(*) FILTER (WHERE c.status = ANY(%(live)s) AND c.call_time >= %(since)s))::int AS running,"
        " (count(*) FILTER (WHERE c.status = ANY(%(live)s) AND c.call_time >= %(since)s"
        "   AND coalesce(c.direction, 'outbound') = 'outbound'))::int AS running_out,"
        " (count(*) FILTER (WHERE c.call_time >= %(start)s AND c.call_time < %(end)s))::int AS today"
        f" FROM public.conversations c WHERE c.user_id = %(owner)s::uuid AND c.call_time >= %(floor)s AND {SAMPLE_SQL}",
        {"owner": owner_id, "live": list(LIVE_STATUSES), "start": start, "end": end,
         "since": datetime.now(timezone.utc) - timedelta(minutes=LIVE_MAX_AGE_MINUTES),
         # Never scan older rows than the earliest thing asked about.
         "floor": min(start, datetime.now(timezone.utc) - timedelta(minutes=LIVE_MAX_AGE_MINUTES))})[0]
    answered = cc._sum_tallies(cc._tally_rows(cc.fetch(owner_id, flt, ("day",)), lambda row: row["day"]).values()).consumed
    return {
        "running_now": {"total": r["running"], "outbound": r["running_out"], "inbound": r["running"] - r["running_out"]},
        "calls_today": {"total": r["today"], "answered": answered},
        "as_of": _iso(datetime.now(timezone.utc)),
    }


# --------------------------------------------------------------------------------------- the snapshot

def overview(owner_id: str, range_key: str, tz: str, from_date: date | None = None, to_date: date | None = None) -> dict:
    """The snapshot for today / 7d / 30d, or for the custom range from_date..to_date (RangeError when unusable)."""
    if range_key not in ALL_RANGES:
        raise ValueError(f"unknown range {range_key!r}")
    custom = check_custom(from_date, to_date) if range_key == CUSTOM else None
    if custom:
        # A range that runs on into the future ("this month") counts only up to today: later days cannot have calls, and
        # the comparison period is then the same number of days before, i.e. "so far" against "the same stretch before".
        today = datetime.now(ZoneInfo(tz)).date()
        if custom[0] > today:
            raise RangeError("The start date is in the future.")
        custom = (custom[0], min(custom[1], today))
    win = windows(range_key, tz, custom=custom)
    tiles, trend = headline(owner_id, range_key, tz, win)
    by_hour = win["days"] <= HOURLY_MAX_DAYS
    return {
        "range": range_key,
        "from": win["current"][0].isoformat(),
        "to": win["current"][1].isoformat(),
        "tiles": tiles,
        "trend": trend,
        # What the main chart draws: every hour of the range for a day or two, every day for longer. `trend` (the days)
        # is always sent, the tiles' sparklines use it.
        "chart": {"granularity": "hour" if by_hour else "day",
                  "hourly": hourly(owner_id, cc.Filters(from_date=win["current"][0], to_date=win["current"][1], tz=tz)) if by_hour else []},
        "campaigns": campaigns(owner_id),
        "inventory": inventory(owner_id),
        "tops": tops(owner_id, cc.Filters(from_date=win["current"][0], to_date=win["current"][1], tz=tz)),
        "setup": setup(owner_id),
    }
