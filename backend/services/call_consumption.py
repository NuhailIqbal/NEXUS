"""Call Consumption: how many finished calls were *consumed* (a person answered and spoke with the AI) and, for
the ones that were not, why — sliced by day, campaign, vertical, state and hour. Backs routers/call_consumption.py.

Definitions (the whole module rests on these)
  * Only FINISHED calls count: conversations.status in Completed / Failed / No Answer. An "Initiated" call is
    still ringing or talking and is left out until it ends.
  * consumed = a person picked up and the call was not a voicemail/early hang-up. dropped = everything else,
    split into DROP_BUCKETS. consumed + dropped = total, always.
  * Every percentage is SUM(numerator) / SUM(denominator) at every level and in every Total row — never an
    average of children's percentages — rounded after dividing, 0 when the total is 0.

Where the work happens
  * SQL (`fetch`) only counts: one grouped query returning flat (dimension..., disposition, calls, cost) rows.
    The disposition itself is a CASE in SQL (DISPOSITION_SQL) so it can be grouped on; `classify` is its Python
    twin and the tests assert they agree.
  * Python (everything else here) shapes those rows: month > week > day tree, KPI deltas, insight rules,
    worst/best hotspots, dense 24-hour and 7x24 grids, area code -> state, names and labels. Exports call the
    very same builders as the screens, so a CSV can never disagree with what is on screen.

All times are bucketed in `Filters.tz` (the viewer's own zone, sent by the page), not the database session zone.
"""
import csv
import io
import statistics
import uuid
from dataclasses import dataclass, field, replace
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from database import supabase
from db_pg import _get_pool
from services.us_area_codes import (
    AREA_CODE_STATE, STATE_NAMES, UNKNOWN_STATE, UNKNOWN_STATE_NAME, area_code_of, state_for_area_code,
)

CONSUMED = "consumed"
# Why a call was dropped, in the fixed order every table lists its columns.
DROP_BUCKETS = ("no_answer", "busy", "voicemail", "hung_up", "blocked", "failed")
BUCKET_LABELS = {
    "no_answer": "No answer",
    "busy": "Busy",
    "voicemail": "Voicemail",
    "hung_up": "Hung up at once",
    "blocked": "Blocked",
    "failed": "Failed",
}
DISPOSITIONS = (CONSUMED,) + DROP_BUCKETS
FINISHED_STATUSES = ("Completed", "Failed", "No Answer")

# A customer who ends the call within this many seconds never really talked to the agent.
HUNG_UP_MAX_SECONDS = 3
# Noise floor: a segment (or one date+hour) with fewer calls than this is never called "worst" or "best".
HOTSPOT_MIN_VOLUME = 5
MAX_RANGE_DAYS = 366
UNCATEGORIZED = "Uncategorized"
NO_CAMPAIGN = "No campaign"
DAY_LABELS = ("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")


# --------------------------------------------------------------------------------------- classification

def classify(ended_reason, status, duration_seconds) -> str | None:
    """Python twin of DISPOSITION_SQL: CONSUMED, one of DROP_BUCKETS, or None for a call that has not finished."""
    if status not in FINISHED_STATUSES:
        return None
    r = (ended_reason or "").lower()
    if r.startswith("assistant-request") or "blocked" in r:
        return "blocked"
    if "voicemail" in r:
        return "voicemail"
    if "busy" in r:
        return "busy"
    if "did-not-answer" in r or "no-answer" in r:
        return "no_answer"
    if "error" in r or "failed" in r or "rejected" in r:
        return "failed"
    if status == "No Answer":
        return "no_answer"
    if status == "Failed":
        return "failed"
    if r == "customer-ended-call" and (duration_seconds or 0) < HUNG_UP_MAX_SECONDS:
        return "hung_up"
    return CONSUMED


# `r` = lower-cased end reason, built in the `raw` CTE below. Order matters: first match wins.
DISPOSITION_SQL = """CASE
    WHEN left(r, 17) = 'assistant-request' OR strpos(r, 'blocked') > 0 THEN 'blocked'
    WHEN strpos(r, 'voicemail') > 0 THEN 'voicemail'
    WHEN strpos(r, 'busy') > 0 THEN 'busy'
    WHEN strpos(r, 'did-not-answer') > 0 OR strpos(r, 'no-answer') > 0 THEN 'no_answer'
    WHEN strpos(r, 'error') > 0 OR strpos(r, 'failed') > 0 OR strpos(r, 'rejected') > 0 THEN 'failed'
    WHEN status = 'No Answer' THEN 'no_answer'
    WHEN status = 'Failed' THEN 'failed'
    WHEN r = 'customer-ended-call' AND coalesce(duration_seconds, 0) < {hung} THEN 'hung_up'
    ELSE 'consumed'
END""".replace("{hung}", str(HUNG_UP_MAX_SECONDS))


# --------------------------------------------------------------------------------------- tallies

def _pct(part: int, total: int, digits: int) -> float:
    return round(part / total * 100, digits) if total > 0 else 0


@dataclass
class Tally:
    """Counts for one slice of calls. Percentages are derived from the counts, never stored or averaged."""
    total: int = 0
    consumed: int = 0
    buckets: dict = field(default_factory=lambda: {b: 0 for b in DROP_BUCKETS})
    dropped_cost: float = 0.0

    @property
    def dropped(self) -> int:
        return self.total - self.consumed

    def add(self, disposition: str, calls: int, cost: float = 0.0) -> None:
        self.total += calls
        if disposition == CONSUMED:
            self.consumed += calls
        else:
            self.buckets[disposition] += calls
            self.dropped_cost += float(cost or 0)

    def merge(self, other: "Tally") -> None:
        self.total += other.total
        self.consumed += other.consumed
        self.dropped_cost += other.dropped_cost
        for b in DROP_BUCKETS:
            self.buckets[b] += other.buckets[b]

    def consumption_pct(self, digits: int = 1) -> float:
        return _pct(self.consumed, self.total, digits)

    def drop_pct(self, digits: int = 1) -> float:
        return _pct(self.dropped, self.total, digits)

    def row(self, digits: int = 1) -> dict:
        return {
            "total_calls": self.total,
            "consumed_calls": self.consumed,
            "consumption_pct": self.consumption_pct(digits),
            "dropped_calls": self.dropped,
            "drop_pct": self.drop_pct(digits),
            "buckets": dict(self.buckets),
            "dropped_cost": round(self.dropped_cost, 2),
        }


def _tally_rows(rows, key_fn) -> dict:
    """Group flat SQL rows into {key: Tally}."""
    out: dict = {}
    for r in rows:
        out.setdefault(key_fn(r), Tally()).add(r["disposition"], r["calls"], r["cost"])
    return out


def _sum_tallies(tallies) -> Tally:
    total = Tally()
    for t in tallies:
        total.merge(t)
    return total


def hour_label(hour: int) -> str:
    """"01:00 AM" ... "12:00 PM" ... "11:00 PM" (zero-padded 12-hour)."""
    h12 = hour % 12 or 12
    return f"{h12:02d}:00 {'AM' if hour < 12 else 'PM'}"


# --------------------------------------------------------------------------------------- filters + query

@dataclass(frozen=True)
class Filters:
    from_date: date
    to_date: date
    tz: str = "UTC"
    campaign_ids: tuple = ()
    vertical: str | None = None
    agent_id: str | None = None
    direction: str | None = None
    disposition: str | None = None
    all_time: bool = False  # no start date was given
    states: tuple = ()      # 2-letter state codes (State page); empty = every state
    numbers: tuple = ()     # NEXUS phone number ids (Inbound report); empty = every number

    def window(self) -> tuple[datetime, datetime]:
        """[start, end) as zone-aware instants: local midnight of from_date to local midnight after to_date."""
        zone = ZoneInfo(self.tz)
        return (datetime.combine(self.from_date, time.min, tzinfo=zone),
                datetime.combine(self.to_date + timedelta(days=1), time.min, tzinfo=zone))

    def previous(self) -> "Filters":
        """The window of the same length immediately before this one (what KPI deltas compare against)."""
        days = (self.to_date - self.from_date).days + 1
        prev_to = self.from_date - timedelta(days=1)
        return replace(self, from_date=prev_to - timedelta(days=days - 1), to_date=prev_to)


_DIMENSIONS = {
    "day": "lt::date",
    "hour": "extract(hour from lt)::int",
    "dow": "extract(dow from lt)::int",
    "campaign": "campaign_id",
    "number": "phone_number_id",
    "direction": "direction",
    "vertical": "vertical",
    "area": "area_code",
    "reason": "ended_reason",
}

_BASE_SQL = (
    "WITH raw AS ("
    " SELECT c.campaign_id, c.phone_number_id, c.direction, c.call_cost, c.ended_reason, c.status, c.duration_seconds,"
    "  (c.call_time AT TIME ZONE %(tz)s) AS lt,"
    "  COALESCE(NULLIF(btrim(a.category), ''), %(uncat)s) AS vertical,"
    "  lower(coalesce(c.ended_reason, '')) AS r,"
    "  regexp_replace(coalesce(c.phone, ''), '\\D', '', 'g') AS digits"
    " FROM public.conversations c"
    " LEFT JOIN public.ai_agents a ON a.id = c.agent_id"
    " WHERE c.user_id = %(owner)s::uuid"
    "  AND c.status IN ('Completed', 'Failed', 'No Answer')"
    "  AND c.call_time >= %(start)s AND c.call_time < %(end)s"
    "  {extra}"
    "), base AS ("
    " SELECT raw.*, " + DISPOSITION_SQL + " AS disposition,"
    "  CASE WHEN digits ~ '^1[2-9][0-9]{9}$' THEN substr(digits, 2, 3)"
    "       WHEN digits ~ '^[2-9][0-9]{9}$' THEN substr(digits, 1, 3) END AS area_code"
    " FROM raw"
    ") "
)


def fetch(owner_id: str, flt: Filters, group: tuple = ()) -> list[dict]:
    """Count the owner's finished calls inside `flt`, grouped by the named `group` dimensions (see
    _DIMENSIONS) and by disposition. Returns flat rows: {<dimension>: value, ..., disposition, calls, cost},
    where `cost` is the money spent on those calls."""
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
        extra += " AND c.direction = %(direction)s"
        params["direction"] = flt.direction
    if flt.vertical:
        extra += " AND COALESCE(NULLIF(btrim(a.category), ''), %(uncat)s) = %(vertical)s"
        params["vertical"] = flt.vertical

    select = "".join(f"{_DIMENSIONS[g]} AS {g}, " for g in group)
    group_by = "".join(f"{_DIMENSIONS[g]}, " for g in group)
    conditions = []
    if flt.disposition:
        conditions.append("disposition = %(disposition)s")
        params["disposition"] = flt.disposition
    if flt.states:
        # A state is its set of area codes (area_code is derived in the `base` CTE).
        conditions.append("area_code = ANY(%(area_codes)s)")
        params["area_codes"] = sorted(code for code, st in AREA_CODE_STATE.items() if st in flt.states)
    where = f" WHERE {' AND '.join(conditions)}" if conditions else ""
    sql = (_BASE_SQL.replace("{extra}", extra)
           + f"SELECT {select}disposition, count(*)::int AS calls, coalesce(sum(call_cost), 0) AS cost"
           + f" FROM base{where} GROUP BY {group_by}disposition")
    with _get_pool().connection() as conn:
        return conn.execute(sql, params).fetchall()


# --------------------------------------------------------------------------------------- segments

@dataclass
class Segment:
    key: str
    name: str
    tally: Tally


def _campaign_names(owner_id: str) -> dict:
    found = supabase.table("outbound_campaigns").select("id, name").eq("user_id", owner_id).execute().data or []
    return {c["id"]: c["name"] for c in found}


def segments(owner_id: str, flt: Filters, dimension: str) -> list[Segment]:
    """One Segment per campaign / vertical / state present in the window, each with its Tally."""
    if dimension == "campaign":
        names = _campaign_names(owner_id)
        tallies = _tally_rows(fetch(owner_id, flt, ("campaign",)), lambda r: r["campaign"])
        return [Segment(str(k) if k else "", names.get(str(k), NO_CAMPAIGN) if k else NO_CAMPAIGN, t)
                for k, t in tallies.items()]
    if dimension == "vertical":
        tallies = _tally_rows(fetch(owner_id, flt, ("vertical",)), lambda r: r["vertical"])
        return [Segment(k, k, t) for k, t in tallies.items()]
    if dimension == "state":
        by_state: dict = {}
        for area, t in _tally_rows(fetch(owner_id, flt, ("area",)), lambda r: r["area"]).items():
            by_state.setdefault(state_for_area_code(area), Tally()).merge(t)
        return [Segment(k, STATE_NAMES.get(k, k), t) for k, t in by_state.items()]
    raise ValueError(f"unknown dimension {dimension!r}")


def _worst(segs, *, floor=HOTSPOT_MIN_VOLUME):
    """Highest drop rate among segments that clear the volume floor (None if none do or none dropped)."""
    cands = [s for s in segs if s.tally.total >= floor and s.tally.dropped > 0]
    return max(cands, key=lambda s: s.tally.dropped / s.tally.total, default=None)


# --------------------------------------------------------------------------------------- overview: KPIs

def overview_kpis(owner_id: str, flt: Filters) -> dict:
    cur = _sum_tallies(_tally_rows(fetch(owner_id, flt), lambda r: 0).values())
    prev = _sum_tallies(_tally_rows(fetch(owner_id, flt.previous()), lambda r: 0).values())
    # With no calls in the previous window there is nothing to compare against: every change is 0 and
    # `has_previous` is False, rather than reporting the whole current rate as a "change" from 0%.
    has_prev = prev.total > 0
    return {
        "has_data": cur.total > 0,
        "has_previous": has_prev,
        "total_calls": cur.total,
        "total_calls_change_pct": round((cur.total - prev.total) / prev.total * 100, 1) if has_prev else 0,
        "consumption_pct": cur.consumption_pct(1),
        # Percentage POINTS, not a relative change.
        "consumption_pct_point_change": round(cur.consumption_pct(4) - prev.consumption_pct(4), 1) if has_prev else 0,
        "drop_pct": cur.drop_pct(1),
        "drop_pct_point_change": round(cur.drop_pct(4) - prev.drop_pct(4), 1) if has_prev else 0,
    }


# --------------------------------------------------------------------------------------- overview: summary tree

def _sunday_of(d: date) -> date:
    return d - timedelta(days=(d.weekday() + 1) % 7)


def _node(name: str, start: date, end: date, tally: Tally, children=None) -> dict:
    node = {"name": name, "start_date": start.isoformat(), "end_date": end.isoformat(), **tally.row(2)}
    if children is not None:
        node["children"] = children
    return node


def build_summary_tree(day_tallies: dict) -> list[dict]:
    """Month > week > day, every level re-summing raw counts (never averaging its children's percentages).
    Weeks start on Sunday and are cut at month edges, so a week never straddles two months."""
    months: dict = {}
    for d in sorted(day_tallies):
        months.setdefault((d.year, d.month), {}).setdefault(_sunday_of(d), []).append(d)
    tree = []
    for (year, month), weeks in months.items():
        week_nodes, month_days = [], []
        for week_start in sorted(weeks):
            days = weeks[week_start]
            month_days += days
            day_nodes = [_node(d.isoformat(), d, d, day_tallies[d]) for d in days]
            week_nodes.append(_node(f"Week of {days[0].strftime('%b')} {days[0].day}", days[0], days[-1],
                                    _sum_tallies(day_tallies[d] for d in days), day_nodes))
        tree.append(_node(f"{date(year, month, 1).strftime('%B')} {year}", month_days[0], month_days[-1],
                          _sum_tallies(day_tallies[d] for d in month_days), week_nodes))
    return tree


def overview_summary(owner_id: str, flt: Filters) -> dict:
    day_tallies = _tally_rows(fetch(owner_id, flt, ("day",)), lambda r: r["day"])
    total = _sum_tallies(day_tallies.values())
    return {
        "has_data": total.total > 0,
        "rows": build_summary_tree(day_tallies),
        "total": {"name": "Total", **total.row(2)},
    }


# --------------------------------------------------------------------------------------- overview: insights

def _fmt(x: float) -> str:
    return f"{x:.1f}"


def _insight(category, badge, title, description, action_label=None, action=None) -> dict:
    return {"category": category, "badge": badge, "title": title, "description": description,
            "action_label": action_label, "action": action}


def build_insights(overall: Tally, campaigns, verticals, states, hours, prev_verticals) -> list[dict]:
    """The rule engine. Every rule yields (priority, is_risk, insight); the result is priority-sorted and,
    if no risk rule fired, ends with a "healthy" card.

    campaigns / verticals / states: list[Segment]. hours: {hour: Tally}. prev_verticals: {name: Tally} for the
    window before this one. Rate-based rules ("worst ...") ignore segments under HOTSPOT_MIN_VOLUME calls and
    ones with nothing dropped."""
    if overall is None or overall.total == 0:
        msg = "No operational insights are available for the selected filters."
        return [_insight("Performance", "NO DATA", msg, msg)]

    out: list = []

    def emit(priority, risk, insight):
        out.append((priority, risk, insight))

    states = [s for s in states if s.key != UNKNOWN_STATE]
    hour_segs = [Segment(str(h), hour_label(h), t) for h, t in sorted(hours.items())]

    def rate(s):
        return s.tally.dropped / s.tally.total

    def top_volume(segs):
        return max((s for s in segs if s.tally.total > 0), key=lambda s: s.tally.total, default=None)

    # 1-3: worst vertical / state / hour by drop rate
    w = _worst(verticals)
    if w:
        emit(2, True, _insight(
            "Worst Vertical", "WORST VERTICAL",
            f"{w.name} is now the worst vertical at {_fmt(w.tally.drop_pct(1))}% drop.",
            f"{w.name} recorded the highest drop rate at {_fmt(w.tally.drop_pct(1))}% "
            f"({w.tally.dropped} of {w.tally.total} calls dropped).",
            "Action", "Review the call list and agent script for this vertical."))
    w = _worst(states)
    if w:
        emit(3, True, _insight(
            "Worst State", "WORST STATE",
            f"{w.name} leads all states at {_fmt(w.tally.drop_pct(1))}% drop.",
            f"{w.name} recorded the highest drop rate at {_fmt(w.tally.drop_pct(1))}% "
            f"({w.tally.dropped} of {w.tally.total} calls dropped).",
            "Action", "Check that your calling hours suit this state's time zone."))
    worst_hour = _worst(hour_segs)
    if worst_hour:
        emit(4, True, _insight(
            "Peak Hour", "HOTSPOT",
            f"{worst_hour.name} experienced a {_fmt(worst_hour.tally.drop_pct(1))}% drop rate.",
            f"{worst_hour.name} had the highest drop rate at {_fmt(worst_hour.tally.drop_pct(1))}% "
            f"({worst_hour.tally.dropped} of {worst_hour.tally.total} calls dropped).",
            "Action", "Consider moving calling away from this hour."))

    # 4: anomaly — an hour well above the typical hourly drop rate
    populated = [s for s in hour_segs if s.tally.total > 0]
    if len(populated) >= 2:
        rates = [rate(s) for s in populated]
        mean, sigma = statistics.fmean(rates), statistics.pstdev(rates)
        spikes = [s for s in populated if s.tally.total >= HOTSPOT_MIN_VOLUME and sigma > 0
                  and rate(s) > mean + 2 * sigma]
        if spikes:
            s = max(spikes, key=rate)
            emit(5, True, _insight(
                "Anomaly", "ANOMALY",
                f"Anomaly: {s.name} drop rate spiked to {s.tally.drop_pct(0):.0f}%.",
                f"{s.name} is more than two standard deviations above the typical hourly drop rate "
                f"({s.tally.dropped} of {s.tally.total} calls dropped).",
                "Likely", "A carrier or list problem during this hour."))

    # 5-7: highest volume
    for prio, segs, badge, noun in ((6, campaigns, "HIGHEST VOLUME", "campaign"),
                                    (7, verticals, "TOP VERTICAL", "vertical"),
                                    (8, states, "TOP STATE", "state")):
        s = top_volume(segs)
        if s:
            emit(prio, False, _insight(
                "Highest Volume", badge, f"{s.name} is the highest-volume {noun}.",
                f"{s.name} placed or took {s.tally.total} of {overall.total} calls."))

    # 8-10: concentration of traffic
    for segs, threshold, badge, make in (
        (campaigns, 15, "CONCENTRATION", lambda n, sh: f"{n} contributed {sh}% of all traffic."),
        (verticals, 30, "TRAFFIC SHARE", lambda n, sh: f"{n} accounts for {sh}% of total traffic."),
        (states, 20, "TOP STATE", lambda n, sh: f"{n} generated over {sh}% of total calls."),
    ):
        s = top_volume(segs)
        if s:
            share = s.tally.total / overall.total * 100
            if share >= threshold:
                emit(9, True, _insight(
                    "Performance", badge, make(s.name, f"{share:.0f}"),
                    f"{s.name} made up {_fmt(share)}% of {overall.total} calls, so results depend heavily on it.",
                    "Action", "Watch this segment closely, or diversify your traffic."))

    # 11-13: peak hour, brightest hour
    s = top_volume(hour_segs)
    if s:
        emit(10, False, _insight("Peak Hour", "PEAK HOUR", f"{s.name} recorded the highest traffic.",
                                 f"{s.name} handled {s.tally.total} of {overall.total} calls."))
    # (There is deliberately no "lowest consumption hour" card: consumption = 100 - drop rate, so it would
    # always be the hotspot hour above, said twice.)
    best = max((h for h in hour_segs if h.tally.total >= HOTSPOT_MIN_VOLUME),
               key=lambda h: h.tally.consumed / h.tally.total, default=None)
    if best:
        emit(12, False, _insight(
            "Opportunity", "BRIGHT SPOT",
            f"{best.name} achieved the highest consumption rate at {best.tally.consumption_pct(2):.2f}%.",
            f"{best.tally.consumed} of {best.tally.total} calls were consumed at {best.name}.",
            "Opportunity", "Lean more of your calling into this hour."))

    # 14-15: vertical traffic surge / decline against the window before
    moves = []
    for v in verticals:
        prev = prev_verticals.get(v.key)
        if prev and prev.total >= HOTSPOT_MIN_VOLUME:
            moves.append((v, (v.tally.total - prev.total) / prev.total * 100))
    if moves:
        v, change = max(moves, key=lambda m: m[1])
        if change >= 25:
            emit(13, True, _insight(
                "Trend", "TREND", f"{v.name} traffic increased by {change:.0f}%.",
                f"{v.name} went from {prev_verticals[v.key].total} to {v.tally.total} calls versus the previous period.",
                "Action", "Make sure this vertical has the capacity to absorb the extra volume."))
        v, change = min(moves, key=lambda m: m[1])
        if change <= -25:
            emit(13, True, _insight(
                "Trend", "DECLINING", f"{v.name} traffic declined by {abs(change):.0f}%.",
                f"{v.name} went from {prev_verticals[v.key].total} to {v.tally.total} calls versus the previous period.",
                "Action", "Check whether campaigns for this vertical have stalled."))

    # 16: nothing risky fired
    if not any(risk for _, risk, _ in out):
        emit(14, False, _insight("Performance", "HEALTHY", "Traffic distribution remains balanced.",
                                 "No vertical, state or hour stands out as a risk for the selected filters."))
    return [ins for _, _, ins in sorted(out, key=lambda t: t[0])]


def overview_insights(owner_id: str, flt: Filters) -> list[dict]:
    overall = _sum_tallies(_tally_rows(fetch(owner_id, flt), lambda r: 0).values())
    hours = _tally_rows(fetch(owner_id, flt, ("hour",)), lambda r: r["hour"])
    prev = {s.key: s.tally for s in segments(owner_id, flt.previous(), "vertical")}
    return build_insights(overall, segments(owner_id, flt, "campaign"), segments(owner_id, flt, "vertical"),
                          segments(owner_id, flt, "state"), hours, prev)


# --------------------------------------------------------------------------------------- overview: hotspots

def _hotspot_row(dimension, row_type, segment, sub_label, tally: Tally) -> dict:
    return {"dimension": dimension, "row_type": row_type, "segment": segment, "segment_sub_label": sub_label,
            "calls": tally.total, "dropped": tally.dropped, "drop_rate_pct": tally.drop_pct(1),
            "_rate": tally.drop_pct(6)}


def build_hotspots(hour_occurrences, campaigns, verticals, states) -> list[dict]:
    """Worst + best segment per dimension (Hour, State, Vertical, Campaign, in that order), then every row
    re-sorted by drop rate so all the "Best" rows sink to the bottom.

    hour_occurrences: {(date, hour): Tally} — a single real date+hour, not an average across matching
    weekdays, so the row points at something that can actually be investigated."""
    candidates = {
        "Hour": [(f"{hour_label(h)}", f"{d.strftime('%a %b')} {d.day}", t)
                 for (d, h), t in sorted(hour_occurrences.items())],
        "State": [(s.name, None, s.tally) for s in states if s.key != UNKNOWN_STATE],
        "Vertical": [(s.name, None, s.tally) for s in verticals],
        "Campaign": [(s.name, None, s.tally) for s in campaigns],
    }
    rows = []
    for dimension in ("Hour", "State", "Vertical", "Campaign"):
        cands = [c for c in candidates[dimension] if c[2].total >= HOTSPOT_MIN_VOLUME]
        if not cands:
            continue
        worst = max(cands, key=lambda c: c[2].dropped / c[2].total)
        best = max(cands, key=lambda c: c[2].consumed / c[2].total)
        rows.append(_hotspot_row(dimension, "Worst", *worst))
        rows.append(_hotspot_row(dimension, "Best", *best))
    rows.sort(key=lambda r: -r["_rate"])
    for r in rows:
        del r["_rate"]
    return rows


def overview_hotspots(owner_id: str, flt: Filters) -> list[dict]:
    occurrences = _tally_rows(fetch(owner_id, flt, ("day", "hour")), lambda r: (r["day"], r["hour"]))
    return build_hotspots(occurrences, segments(owner_id, flt, "campaign"), segments(owner_id, flt, "vertical"),
                          segments(owner_id, flt, "state"))


# --------------------------------------------------------------------------------------- breakdown pages

def breakdown_kpi(owner_id: str, flt: Filters, dimension: str) -> dict:
    segs = segments(owner_id, flt, dimension)
    total = _sum_tallies(s.tally for s in segs)
    # Prefer a segment with enough calls to mean something; on a very small account fall back to any.
    worst = _worst(segs) or _worst(segs, floor=1)
    return {
        "has_data": total.total > 0,
        "total_calls": total.total,
        "consumed_calls": total.consumed,
        "consumed_pct": total.consumption_pct(1),
        "dropped_calls": total.dropped,
        "dropped_pct": total.drop_pct(1),
        "segment_count": len(segs),
        "worst_segment_name": worst.name if worst else None,
        "worst_segment_drop_rate": worst.tally.drop_pct(1) if worst else None,
        "worst_segment_calls": worst.tally.total if worst else None,
        "cost_on_dropped": round(total.dropped_cost, 2),
    }


def breakdown_combo(owner_id: str, flt: Filters, dimension: str) -> list[dict]:
    """One row per segment: volume bars + drop-rate line. Sorted by volume, biggest first."""
    segs = sorted(segments(owner_id, flt, dimension), key=lambda s: (-s.tally.total, s.name))
    return [{"key": s.key, "name": s.name, **s.tally.row(1)} for s in segs]


def breakdown_disposition(owner_id: str, flt: Filters, dimension: str) -> list[dict]:
    """One row per (segment, drop reason) with a non-zero count — the stacked-bar data."""
    out = []
    for s in sorted(segments(owner_id, flt, dimension), key=lambda s: (-s.tally.dropped, s.name)):
        for b in DROP_BUCKETS:
            if s.tally.buckets[b]:
                out.append({"key": s.key, "name": s.name, "disposition": b, "label": BUCKET_LABELS[b],
                            "calls": s.tally.buckets[b]})
    return out


def breakdown_mix(owner_id: str, flt: Filters, dimension: str) -> list[dict]:
    total = _sum_tallies(s.tally for s in segments(owner_id, flt, dimension))
    return [{"disposition": b, "label": BUCKET_LABELS[b], "calls": total.buckets[b],
             "pct_of_dropped": _pct(total.buckets[b], total.dropped, 1)}
            for b in DROP_BUCKETS if total.buckets[b]]


def breakdown_ranking(owner_id: str, flt: Filters, dimension: str) -> list[dict]:
    """Every segment, worst drop rate first (ties: more dropped calls first)."""
    segs = sorted(segments(owner_id, flt, dimension),
                  key=lambda s: (-(s.tally.dropped / s.tally.total if s.tally.total else 0), -s.tally.dropped, s.name))
    return [{"key": s.key, "name": s.name, "total_calls": s.tally.total, "dropped_calls": s.tally.dropped,
             "drop_rate_pct": s.tally.drop_pct(1)} for s in segs]


def breakdown_summary(owner_id: str, flt: Filters, dimension: str) -> dict:
    segs = sorted(segments(owner_id, flt, dimension), key=lambda s: (-s.tally.dropped, s.name))
    total = _sum_tallies(s.tally for s in segs)
    return {"has_data": total.total > 0,
            "rows": [{"key": s.key, "name": s.name, **s.tally.row(2)} for s in segs],
            "total": {"name": "Total", **total.row(2)}}


BREAKDOWN_SECTIONS = {
    "kpi": breakdown_kpi,
    "combo": breakdown_combo,
    "disposition": breakdown_disposition,
    "mix": breakdown_mix,
    "ranking": breakdown_ranking,
    "summary": breakdown_summary,
}
DIMENSION_NAMES = ("campaign", "vertical", "state")


# --------------------------------------------------------------------------------------- non-consumption reasons

def non_consumption_reasons(owner_id: str, flt: Filters, campaign_id: str) -> dict:
    """Why one campaign's calls were dropped. Percentages here are a share of DROPPED calls, not of all calls."""
    flt = replace(flt, campaign_ids=(campaign_id,))
    tally = _sum_tallies(_tally_rows(fetch(owner_id, flt), lambda r: 0).values())
    raw: dict = {}
    for r in fetch(owner_id, flt, ("reason",)):
        if r["disposition"] == CONSUMED:
            continue
        key = (r["reason"] or "", r["disposition"])
        raw[key] = raw.get(key, 0) + r["calls"]
    return {
        "campaign_id": campaign_id,
        "campaign_name": _campaign_names(owner_id).get(campaign_id),
        "total_calls": tally.total,
        "consumed_calls": tally.consumed,
        "dropped_calls": tally.dropped,
        "drop_pct": tally.drop_pct(1),
        "reasons": [{"disposition": b, "label": BUCKET_LABELS[b], "calls": tally.buckets[b],
                     "pct_of_dropped": _pct(tally.buckets[b], tally.dropped, 1)}
                    for b in DROP_BUCKETS if tally.buckets[b]],
        # The carrier/AI's own wording behind each bucket, most common first.
        "raw_reasons": [{"reason": reason or "(not recorded)", "disposition": b, "label": BUCKET_LABELS[b],
                         "calls": n, "pct_of_dropped": _pct(n, tally.dropped, 1)}
                        for (reason, b), n in sorted(raw.items(), key=lambda kv: -kv[1])],
    }


# --------------------------------------------------------------------------------------- hourly

def hourly_kpis(owner_id: str, flt: Filters) -> dict:
    occ = _tally_rows(fetch(owner_id, flt, ("day", "hour")), lambda r: (r["day"], r["hour"]))
    total = _sum_tallies(occ.values())
    by_hour: dict = {}
    for (_, h), t in occ.items():
        by_hour.setdefault(h, Tally()).merge(t)
    busiest = max(by_hour.items(), key=lambda kv: (kv[1].total, -kv[0]), default=None)
    risky = [(k, t) for k, t in occ.items() if t.total >= HOTSPOT_MIN_VOLUME and t.dropped > 0]
    risk = max(risky, key=lambda kv: kv[1].dropped / kv[1].total, default=None)
    if flt.all_time:
        label = "All Time"
    elif flt.from_date == flt.to_date:
        label = f"{flt.from_date.strftime('%b')} {flt.from_date.day}, {flt.from_date.year}"
    else:
        label = (f"{flt.from_date.strftime('%b')} {flt.from_date.day} - "
                 f"{flt.to_date.strftime('%b')} {flt.to_date.day}, {flt.to_date.year}")
    return {
        "has_data": total.total > 0,
        "total_calls": total.total,
        "overall_drop_pct": total.drop_pct(1),
        "busiest_hour_label": hour_label(busiest[0]) if busiest else "N/A",
        "busiest_hour_calls": busiest[1].total if busiest else 0,
        "date_range_label": label,
        "risk_window_label": (f"{DAY_LABELS[(risk[0][0].weekday() + 1) % 7]}, {risk[0][0].strftime('%b')} "
                              f"{risk[0][0].day} {hour_label(risk[0][1])}") if risk else "N/A",
        "risk_window_drop_pct": risk[1].drop_pct(1) if risk else 0,
    }


def hourly_heatmap(owner_id: str, flt: Filters) -> dict:
    """A dense 7 x 24 weekday x hour grid over the CHOSEN range (all time when none is chosen): each cell sums every
    such weekday-hour in the range, e.g. all Mondays at 10:00. Cells with no calls are present with zeros.

    The original spec fixed this to the last 7 days; that showed an empty grid for any account without calls in the
    past week, so it now follows the same filters as every other widget."""
    cells = _tally_rows(fetch(owner_id, flt, ("dow", "hour")), lambda r: (r["dow"], r["hour"]))
    out = []
    for d in range(7):
        for h in range(24):
            t = cells.get((d, h), Tally())
            out.append({"day_of_week": d, "day_label": DAY_LABELS[d], "hour": h, "hour_label": hour_label(h),
                        "total_calls": t.total, "consumed_calls": t.consumed, "dropped_calls": t.dropped,
                        "consumption_pct": t.consumption_pct(1), "drop_pct": t.drop_pct(1)})
    return {"from_date": None if flt.all_time else flt.from_date.isoformat(), "to_date": flt.to_date.isoformat(),
            "all_time": flt.all_time, "cells": out}


def hourly_trend(owner_id: str, flt: Filters) -> list[dict]:
    hours = _tally_rows(fetch(owner_id, flt, ("hour",)), lambda r: r["hour"])
    return [{"hour": h, "hour_label": hour_label(h), "total_calls": hours.get(h, Tally()).total,
             "dropped_calls": hours.get(h, Tally()).dropped, "drop_pct": hours.get(h, Tally()).drop_pct(1)}
            for h in range(24)]


def hourly_summary(owner_id: str, flt: Filters) -> dict:
    """Exactly 24 rows (an empty hour is a labelled zero row) plus a Total whose percentages are recomputed
    from the summed counts."""
    hours = _tally_rows(fetch(owner_id, flt, ("hour",)), lambda r: r["hour"])
    rows = [{"hour": h, "name": hour_label(h), **hours.get(h, Tally()).row(2)} for h in range(24)]
    total = _sum_tallies(hours.values())
    return {"has_data": total.total > 0, "rows": rows, "total": {"name": "Total", **total.row(2)}}


# --------------------------------------------------------------------------------------- inbound / outbound report

DIRECTIONS = ("inbound", "outbound")
UNKNOWN_NUMBER = "Unknown number"


def _number_names(owner_id: str) -> dict:
    found = supabase.table("phone_numbers").select("id, number, label").eq("user_id", owner_id).execute().data or []
    return {n["id"]: (n.get("label") or "").strip() or n["number"] for n in found}


def number_options(owner_id: str) -> list[dict]:
    names = _number_names(owner_id)
    return sorted(({"id": i, "name": n} for i, n in names.items()), key=lambda n: n["name"].lower())


def _change_fields(cur: Tally, prev: "Tally | None") -> dict:
    ok = prev is not None and prev.total > 0
    return {
        "calls_change_pct": round((cur.total - prev.total) / prev.total * 100, 1) if ok else None,
        "drop_pct_point_change": round(cur.drop_pct(4) - prev.drop_pct(4), 1) if ok else None,
    }


def direction_report(owner_id: str, flt: Filters, direction: str) -> dict:
    """One direction's calls broken down the way that direction is organised: OUTBOUND by campaign ("No campaign" for
    one-off and callback calls), INBOUND by the NEXUS phone number the caller reached (inbound calls have no campaign).
    Each row is compared with the same campaign / number in the window before this one (None when it had no calls
    there). Busiest first. `kpis` has the same shape as the Overview's, for the whole direction."""
    flt = replace(flt, direction=direction)
    dim = "number" if direction == "inbound" else "campaign"
    names = _number_names(owner_id) if direction == "inbound" else _campaign_names(owner_id)
    unknown = UNKNOWN_NUMBER if direction == "inbound" else NO_CAMPAIGN

    def by_segment(f: Filters) -> dict:
        return {(str(k) if k else ""): t for k, t in _tally_rows(fetch(owner_id, f, (dim,)), lambda r: r[dim]).items()}

    cur, prev = by_segment(flt), by_segment(flt.previous())
    ordered = sorted(cur.items(), key=lambda kv: (-kv[1].total, names.get(kv[0], unknown).lower()))
    rows = [{"key": k, "name": names.get(k, unknown) if k else unknown, **t.row(2), **_change_fields(t, prev.get(k))}
            for k, t in ordered]
    total, prev_total = _sum_tallies(cur.values()), _sum_tallies(prev.values())
    has_prev = prev_total.total > 0
    return {
        "direction": direction,
        "has_data": total.total > 0,
        "segment_label": "Number" if direction == "inbound" else "Campaign",
        "kpis": {
            "has_data": total.total > 0,
            "has_previous": has_prev,
            "total_calls": total.total,
            "total_calls_change_pct": round((total.total - prev_total.total) / prev_total.total * 100, 1) if has_prev else 0,
            "consumption_pct": total.consumption_pct(1),
            "consumption_pct_point_change": round(total.consumption_pct(4) - prev_total.consumption_pct(4), 1) if has_prev else 0,
            "drop_pct": total.drop_pct(1),
            "drop_pct_point_change": round(total.drop_pct(4) - prev_total.drop_pct(4), 1) if has_prev else 0,
        },
        "rows": rows,
        "total": {"name": "Total", **total.row(2)},
    }


def directions_summary(owner_id: str, flt: Filters) -> dict:
    """Inbound next to outbound (the Overview's comparison strip): calls, consumption and drop rate for each."""
    tallies = _tally_rows(fetch(owner_id, flt, ("direction",)), lambda r: r["direction"])
    out = {}
    for d in DIRECTIONS:
        t = tallies.get(d, Tally())
        out[d] = {"has_data": t.total > 0, **t.row(1)}
    return out


# --------------------------------------------------------------------------------------- state x hour heatmap

def state_hour_heatmap(owner_id: str, flt: Filters) -> dict:
    """A dense state x 24-hour grid for the State page: one row per state that has calls in the window (busiest
    first), 24 cells each (an hour without calls is a zero cell). Hours are bucketed in `flt.tz` like everywhere else.
    Numbers whose area code is not a US state are left out of the grid and only counted in `unknown_calls`."""
    cells_by: dict = {}
    unknown = 0
    for r in fetch(owner_id, flt, ("area", "hour")):
        state = state_for_area_code(r["area"])
        if state == UNKNOWN_STATE:
            unknown += r["calls"]
            continue
        cells_by.setdefault((state, r["hour"]), Tally()).add(r["disposition"], r["calls"], r["cost"])
    per_state: dict = {}
    for (state, _), t in cells_by.items():
        per_state.setdefault(state, Tally()).merge(t)
    order = sorted(per_state, key=lambda s: (-per_state[s].total, STATE_NAMES.get(s, s)))
    cells = []
    for state in order:
        for h in range(24):
            t = cells_by.get((state, h), Tally())
            cells.append({"state": state, "state_name": STATE_NAMES.get(state, state), "hour": h, "hour_label": hour_label(h),
                          "total_calls": t.total, "consumed_calls": t.consumed, "dropped_calls": t.dropped,
                          "consumption_pct": t.consumption_pct(1), "drop_pct": t.drop_pct(1)})
    return {
        "states": [{"key": s, "name": STATE_NAMES.get(s, s), "total_calls": per_state[s].total,
                    "drop_pct": per_state[s].drop_pct(1)} for s in order],
        "cells": cells,
        "unknown_calls": unknown,
    }


# --------------------------------------------------------------------------------------- weekly / monthly

GRANULARITIES = ("weekly", "monthly")


def _month_end(d: date) -> date:
    nxt = date(d.year + (d.month == 12), d.month % 12 + 1, 1)
    return nxt - timedelta(days=1)


def _period_bounds(d: date, granularity: str) -> tuple[date, date]:
    """First and last day of the Sunday-start week, or the calendar month, that contains `d`."""
    if granularity == "weekly":
        start = _sunday_of(d)
        return start, start + timedelta(days=6)
    start = d.replace(day=1)
    return start, _month_end(start)


def _period_label(start: date, end: date, granularity: str) -> str:
    if granularity == "monthly":
        return f"{start.strftime('%B')} {start.year}"
    return f"{start.strftime('%b')} {start.day} - {end.strftime('%b')} {end.day}, {end.year}"


def period_report(owner_id: str, flt: Filters, granularity: str) -> dict:
    """One row per week (Sunday-start) or calendar month, oldest first, from the first period that has calls to the
    last. A period with no calls in between is a zero row (so the trend has no holes). Each row carries its change
    against the row before it (None when that one had no calls: nothing to compare), and `partial` when the period
    reaches outside the chosen range or is still in progress (today falls inside it) (its figures cover only part of it)."""
    day_tallies = _tally_rows(fetch(owner_id, flt, ("day",)), lambda r: r["day"])
    today = datetime.now(ZoneInfo(flt.tz)).date()
    groups: dict = {}
    for d, t in day_tallies.items():
        groups.setdefault(_period_bounds(d, granularity)[0], Tally()).merge(t)
    rows: list = []
    if groups:
        cursor, last = min(groups), max(groups)
        prev = None
        while cursor <= last:
            start, end = _period_bounds(cursor, granularity)
            t = groups.get(start, Tally())
            row = {
                "key": start.isoformat(),
                "name": _period_label(start, end, granularity),
                "start_date": start.isoformat(),
                "end_date": end.isoformat(),
                # Cut by the range, or not over yet (today is still inside it).
                "partial": start < flt.from_date or end > flt.to_date or end >= today,
                **t.row(2),
            }
            comparable = prev is not None and prev.total > 0
            row["calls_change_pct"] = round((t.total - prev.total) / prev.total * 100, 1) if comparable else None
            row["drop_pct_point_change"] = round(t.drop_pct(4) - prev.drop_pct(4), 1) if comparable else None
            rows.append(row)
            prev = t
            cursor = end + timedelta(days=1)
    total = _sum_tallies(groups.values())
    return {"has_data": total.total > 0, "granularity": granularity, "rows": rows, "total": {"name": "Total", **total.row(2)}}


# --------------------------------------------------------------------------------------- CSV exports

def _csv(header: list, rows: list) -> str:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(header)
    w.writerows(rows)
    return buf.getvalue()


_BUCKET_HEADERS = [BUCKET_LABELS[b] for b in DROP_BUCKETS]
_TALLY_HEADERS = ["Total Calls", "Consumed", "Consumption Rate", "Dropped", "Drop Rate"]


def _tally_cells(node: dict) -> list:
    return [node["total_calls"], node["consumed_calls"], f"{node['consumption_pct']}%", node["dropped_calls"],
            f"{node['drop_pct']}%"] + [node["buckets"][b] for b in DROP_BUCKETS]


def _flatten(nodes: list, depth: int = 0):
    """Depth-first, parents before children, with the child's depth shown as leading indentation."""
    for n in nodes:
        yield depth, n
        yield from _flatten(n.get("children", []), depth + 1)


def summary_csv(summary: dict, name_header: str = "Name") -> str:
    rows = [[("  " * depth) + n["name"]] + _tally_cells(n) for depth, n in _flatten(summary["rows"])]
    rows.append(["Total"] + _tally_cells(summary["total"]))
    return _csv([name_header] + _TALLY_HEADERS + _BUCKET_HEADERS, rows)


def period_csv(report: dict) -> str:
    """Weekly / monthly rows (newest first, as on screen) plus the Total, with the change columns."""
    def change(v, unit):
        return "" if v is None else f"{v}{unit}"
    rows = [[r["name"] + (" (in progress / partial)" if r["partial"] else "")] + _tally_cells(r)
            + [change(r["calls_change_pct"], "%"), change(r["drop_pct_point_change"], " pts")] for r in reversed(report["rows"])]
    rows.append(["Total"] + _tally_cells(report["total"]) + ["", ""])
    first = "Week" if report["granularity"] == "weekly" else "Month"
    return _csv([first] + _TALLY_HEADERS + _BUCKET_HEADERS + ["Calls vs previous", "Drop rate vs previous"], rows)


def direction_csv(report: dict) -> str:
    """The inbound / outbound report (one row per campaign or number, busiest first) plus the Total, with the change columns."""
    def change(v, unit):
        return "" if v is None else f"{v}{unit}"
    rows = [[r["name"]] + _tally_cells(r) + [change(r["calls_change_pct"], "%"), change(r["drop_pct_point_change"], " pts")]
            for r in report["rows"]]
    rows.append(["Total"] + _tally_cells(report["total"]) + ["", ""])
    return _csv([report["segment_label"]] + _TALLY_HEADERS + _BUCKET_HEADERS + ["Calls vs previous", "Drop rate vs previous"], rows)


def hotspots_csv(rows: list[dict]) -> str:
    return _csv(["Dimension", "Segment", "Calls", "Dropped", "Drop Rate"],
                [[f"{r['dimension']} ({r['row_type']})",
                  f"{r['segment']} - {r['segment_sub_label']}" if r["segment_sub_label"] else r["segment"],
                  r["calls"], r["dropped"], f"{r['drop_rate_pct']}%"] for r in rows])


def parse_campaign_ids(value: str | None) -> tuple:
    """A comma-separated list of campaign ids -> tuple of canonical uuid strings. ValueError on a bad id."""
    if not value:
        return ()
    return tuple(str(uuid.UUID(part.strip())) for part in value.split(",") if part.strip())


def parse_states(value: str | None) -> tuple:
    """A comma-separated list of 2-letter state codes -> tuple of upper-case codes. ValueError on an unknown one."""
    if not value:
        return ()
    codes = tuple(dict.fromkeys(part.strip().upper() for part in value.split(",") if part.strip()))
    for c in codes:
        if c == UNKNOWN_STATE or c not in STATE_NAMES:
            raise ValueError(c)
    return codes


def states_with_calls(owner_id: str) -> list[dict]:
    """The states the account has ever had a (finished) call with, for the State filter's dropdown."""
    everything = Filters(date(2000, 1, 1), datetime.now(ZoneInfo("UTC")).date() + timedelta(days=1), "UTC")
    present = {state_for_area_code(r["area"]) for r in fetch(owner_id, everything, ("area",))}
    present.discard(UNKNOWN_STATE)
    return sorted(({"code": c, "name": STATE_NAMES[c]} for c in present), key=lambda s: s["name"])
