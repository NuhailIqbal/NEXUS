"""Call Consumption API, mounted under /call-consumption: read-only reports on how many finished calls were
consumed (a person answered and spoke with the AI) and why the rest were dropped. All the maths lives in
services/call_consumption.py; this module only validates the query string, scopes everything to the account
owner (routers.team.resolve_owner_id, so team members see the owner's data) and wraps results.

Every endpoint takes the same filters as query parameters: from / to (YYYY-MM-DD; none = all time),
tz (IANA zone the days and hours are bucketed in, default UTC), campaign_ids (comma-separated), vertical,
agent_id, direction, disposition and states (comma-separated 2-letter codes, used by the State page). Each report widget is its own endpoint so a page can load them
independently:

  /filters                                 dropdown contents
  /overview/{kpis,summary,insights,hotspots}   + /overview/export/{summary,hotspots}.csv
  /breakdown/{campaign|vertical|state}/{kpi,combo,disposition,mix,ranking,summary}   + /breakdown/<dimension>/export.csv
  /state/heatmap                           state x hour-of-day grid for the State page
  /reasons?campaign_id=                    why one campaign's calls were dropped
  /hourly/{kpis,heatmap,trend,summary}     + /hourly/export.csv
  /period/{weekly|monthly}                 one row per week / month with change vs the previous; + /export.csv
  /direction/{inbound|outbound}            outbound by campaign / inbound by phone number; + /export.csv
  /overview/directions                     inbound next to outbound (comparison strip)

These are plain `def` endpoints on purpose: the work is blocking SQL, so FastAPI runs them in its threadpool.
"""
import uuid
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from database import supabase
from dependencies import get_current_user
from routers.team import resolve_owner_id
from services import call_consumption as cc
from services.calendar_service import valid_timezone

router = APIRouter(prefix="/call-consumption", tags=["Call Consumption"])


def _owner(user) -> str:
    return resolve_owner_id(user["user_id"])


def get_filters(
    from_date: date | None = Query(None, alias="from"),
    to_date: date | None = Query(None, alias="to"),
    tz: str = Query("UTC"),
    campaign_ids: str | None = Query(None),
    vertical: str | None = Query(None),
    agent_id: str | None = Query(None),
    direction: str | None = Query(None),
    disposition: str | None = Query(None),
    states: str | None = Query(None),
    numbers: str | None = Query(None),
) -> cc.Filters:
    """Validate the shared query string into a Filters. 400 with a plain message on anything unusable."""
    if not valid_timezone(tz):
        raise HTTPException(400, "That time zone isn't recognised.")
    # No dates at all means ALL TIME; a missing end is today; a missing start (with an end) is also all time.
    all_time = from_date is None
    if to_date is None:
        to_date = datetime.now(ZoneInfo(tz)).date()
    if from_date is None:
        from_date = date(2000, 1, 1)
    else:
        if from_date > to_date:
            raise HTTPException(400, "The start date must be on or before the end date.")
        if (to_date - from_date).days + 1 > cc.MAX_RANGE_DAYS:
            raise HTTPException(400, f"Pick a range of at most {cc.MAX_RANGE_DAYS} days.")
    try:
        campaigns = cc.parse_campaign_ids(campaign_ids)
        number_ids = cc.parse_campaign_ids(numbers)
        if agent_id:
            agent_id = str(uuid.UUID(agent_id))
        state_codes = cc.parse_states(states)
    except ValueError:
        raise HTTPException(400, "That campaign, agent or state isn't valid.")
    if direction and direction not in ("inbound", "outbound"):
        raise HTTPException(400, "Direction must be inbound or outbound.")
    if disposition and disposition not in cc.DISPOSITIONS:
        raise HTTPException(400, "That disposition isn't recognised.")
    return cc.Filters(from_date=from_date, to_date=to_date, tz=tz, all_time=all_time, campaign_ids=campaigns,
                      vertical=vertical or None, agent_id=agent_id or None, direction=direction or None,
                      disposition=disposition or None, states=state_codes, numbers=number_ids)


def _ok(data):
    return {"data": data, "error": None}


def _csv_response(body: str, filename: str) -> Response:
    return Response(content=body, media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


# ------------------------------------------------------------------------------------------- filters

@router.get("/filters")
def filter_options(user=Depends(get_current_user)):
    """Contents of the filter dropdowns: the owner's campaigns and agents, the verticals (agent industries)
    in use, and the disposition list."""
    owner = _owner(user)
    campaigns = supabase.table("outbound_campaigns").select("id, name").eq("user_id", owner).execute().data or []
    agents = supabase.table("ai_agents").select("id, name, category").eq("user_id", owner).execute().data or []
    verticals = sorted({(a.get("category") or "").strip() or cc.UNCATEGORIZED for a in agents})
    return _ok({
        "campaigns": sorted(({"id": c["id"], "name": c["name"]} for c in campaigns), key=lambda c: c["name"].lower()),
        "agents": sorted(({"id": a["id"], "name": a["name"]} for a in agents), key=lambda a: a["name"].lower()),
        "verticals": verticals,
        "states": cc.states_with_calls(owner),
        "numbers": cc.number_options(owner),
        "dispositions": [{"value": cc.CONSUMED, "label": "Consumed"}]
        + [{"value": b, "label": cc.BUCKET_LABELS[b]} for b in cc.DROP_BUCKETS],
    })


# ------------------------------------------------------------------------------------------- overview

_OVERVIEW = {
    "kpis": cc.overview_kpis,
    "summary": cc.overview_summary,
    "insights": cc.overview_insights,
    "hotspots": cc.overview_hotspots,
    "directions": cc.directions_summary,
}


@router.get("/overview/export/summary.csv")
def export_overview_summary(flt: cc.Filters = Depends(get_filters), user=Depends(get_current_user)):
    summary = cc.overview_summary(_owner(user), flt)
    if not summary["has_data"]:
        raise HTTPException(404, "There is no data to export for these filters.")
    return _csv_response(cc.summary_csv(summary), "CallConsumptionOverviewSummary.csv")


@router.get("/overview/export/hotspots.csv")
def export_overview_hotspots(flt: cc.Filters = Depends(get_filters), user=Depends(get_current_user)):
    rows = cc.overview_hotspots(_owner(user), flt)
    if not rows:
        raise HTTPException(404, "There is no data to export for these filters.")
    return _csv_response(cc.hotspots_csv(rows), "CallConsumptionOverviewHotspots.csv")


@router.get("/overview/{widget}")
def overview(widget: str, flt: cc.Filters = Depends(get_filters), user=Depends(get_current_user)):
    if widget not in _OVERVIEW:
        raise HTTPException(404, "Unknown overview widget.")
    return _ok(_OVERVIEW[widget](_owner(user), flt))


# ------------------------------------------------------------------------------------------- breakdown

_BREAKDOWN_FILES = {
    "campaign": ("Campaign", "CallConsumptionByCampaign.csv"),
    "vertical": ("Vertical", "CallConsumptionByVertical.csv"),
    "state": ("State", "CallConsumptionByState.csv"),
}


@router.get("/breakdown/{dimension}/export.csv")
def export_breakdown(dimension: str, flt: cc.Filters = Depends(get_filters), user=Depends(get_current_user)):
    """The Campaign / Vertical / State page's Summary table as CSV (same builder as the screen, so they agree)."""
    if dimension not in _BREAKDOWN_FILES:
        raise HTTPException(404, "Unknown dimension.")
    summary = cc.breakdown_summary(_owner(user), flt, dimension)
    if not summary["has_data"]:
        raise HTTPException(404, "There is no data to export for these filters.")
    column, filename = _BREAKDOWN_FILES[dimension]
    return _csv_response(cc.summary_csv(summary, name_header=column), filename)


@router.get("/breakdown/{dimension}/{section}")
def breakdown(dimension: str, section: str, flt: cc.Filters = Depends(get_filters), user=Depends(get_current_user)):
    if dimension not in cc.DIMENSION_NAMES:
        raise HTTPException(404, "Unknown dimension.")
    if section not in cc.BREAKDOWN_SECTIONS:
        raise HTTPException(404, "Unknown section.")
    return _ok(cc.BREAKDOWN_SECTIONS[section](_owner(user), flt, dimension))


@router.get("/state/heatmap")
def state_heatmap(flt: cc.Filters = Depends(get_filters), user=Depends(get_current_user)):
    """State x hour-of-day grid for the State page (busiest states first; non-US numbers only counted)."""
    return _ok(cc.state_hour_heatmap(_owner(user), flt))


@router.get("/reasons")
def reasons(campaign_id: str = Query(...), flt: cc.Filters = Depends(get_filters), user=Depends(get_current_user)):
    """Why one campaign's calls were dropped (the page behind a campaign's drill-down link)."""
    try:
        campaign_id = str(uuid.UUID(campaign_id))
    except ValueError:
        raise HTTPException(400, "That campaign isn't valid.")
    return _ok(cc.non_consumption_reasons(_owner(user), flt, campaign_id))


# ------------------------------------------------------------------------------------------- inbound / outbound

@router.get("/direction/{which}/export.csv")
def export_direction(which: str, flt: cc.Filters = Depends(get_filters), user=Depends(get_current_user)):
    if which not in cc.DIRECTIONS:
        raise HTTPException(404, "Unknown report.")
    report = cc.direction_report(_owner(user), flt, which)
    if not report["has_data"]:
        raise HTTPException(404, "There is no data to export for these filters.")
    name = "InboundCallConsumptionByNumber.csv" if which == "inbound" else "OutboundCallConsumptionByCampaign.csv"
    return _csv_response(cc.direction_csv(report), name)


@router.get("/direction/{which}")
def direction_report(which: str, flt: cc.Filters = Depends(get_filters), user=Depends(get_current_user)):
    """Outbound calls by campaign, or inbound calls by phone number, each compared with the previous window."""
    if which not in cc.DIRECTIONS:
        raise HTTPException(404, "Unknown report.")
    return _ok(cc.direction_report(_owner(user), flt, which))


# ------------------------------------------------------------------------------------------- weekly / monthly

@router.get("/period/{granularity}/export.csv")
def export_period(granularity: str, flt: cc.Filters = Depends(get_filters), user=Depends(get_current_user)):
    if granularity not in cc.GRANULARITIES:
        raise HTTPException(404, "Unknown report.")
    report = cc.period_report(_owner(user), flt, granularity)
    if not report["has_data"]:
        raise HTTPException(404, "There is no data to export for these filters.")
    name = "WeeklyCallConsumptionReport.csv" if granularity == "weekly" else "MonthlyCallConsumptionReport.csv"
    return _csv_response(cc.period_csv(report), name)


@router.get("/period/{granularity}")
def period(granularity: str, flt: cc.Filters = Depends(get_filters), user=Depends(get_current_user)):
    """Weekly (Sunday-start) or monthly totals, one row per period, with the change against the period before."""
    if granularity not in cc.GRANULARITIES:
        raise HTTPException(404, "Unknown report.")
    return _ok(cc.period_report(_owner(user), flt, granularity))


# ------------------------------------------------------------------------------------------- hourly

@router.get("/hourly/export.csv")
def export_hourly(flt: cc.Filters = Depends(get_filters), user=Depends(get_current_user)):
    summary = cc.hourly_summary(_owner(user), flt)
    if not summary["has_data"]:
        raise HTTPException(404, "There is no data to export for these filters.")
    return _csv_response(cc.summary_csv(summary, name_header="Hour"), "HourlyCallConsumptionReport.csv")


_HOURLY = {
    "kpis": cc.hourly_kpis,
    "heatmap": cc.hourly_heatmap,
    "trend": cc.hourly_trend,
    "summary": cc.hourly_summary,
}


@router.get("/hourly/{widget}")
def hourly(widget: str, flt: cc.Filters = Depends(get_filters), user=Depends(get_current_user)):
    if widget not in _HOURLY:
        raise HTTPException(404, "Unknown hourly widget.")
    return _ok(_HOURLY[widget](_owner(user), flt))
