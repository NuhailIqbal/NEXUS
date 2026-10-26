"""Cost per lead & ROI API, mounted under /call-consumption/lead-roi so it sits with the other Reports pages and takes
the very same query string (from / to / tz / campaign_ids / agent_id / direction / vertical; the other Call Consumption
filters do not apply here and are ignored). All the maths lives in services/lead_roi.py; this module validates the
query string (routers.call_consumption.get_filters), scopes everything to the account owner (team members see the
owner's data) and wraps results.

  /kpis                          spend, leads, cost per lead / qualified lead, ROI, each against the previous window
  /campaign                      one row per campaign + Total;  /campaign/export.csv
  /directions                    inbound next to outbound (ignores the direction filter)
  /number                        inbound calls by the phone number the caller reached + Total;  /number/export.csv
  /period/{weekly|monthly}       one row per week / month + Total;  /period/<granularity>/export.csv
  GET /values                    what a lead is worth: the account default and each campaign's override
  PUT /values                    owner only: set (or clear) the account default or one campaign's values

Plain `def` endpoints on purpose: the work is blocking SQL, so FastAPI runs them in its threadpool.
"""
from fastapi import APIRouter, Depends, HTTPException, Response

from dependencies import get_current_user, require_owner
from models.schemas import LeadValuesUpdate
from routers.call_consumption import get_filters
from routers.team import resolve_owner_id
from services import call_consumption as cc
from services import lead_roi as lr

router = APIRouter(prefix="/call-consumption/lead-roi", tags=["Lead ROI"])


def _owner(user) -> str:
    return resolve_owner_id(user["user_id"])


def _ok(data):
    return {"data": data, "error": None}


def _csv_response(body: str, filename: str) -> Response:
    return Response(content=body, media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@router.get("/kpis")
def kpis(flt: cc.Filters = Depends(get_filters), user=Depends(get_current_user)):
    return _ok(lr.kpis(_owner(user), flt))


@router.get("/campaign/export.csv")
def export_campaign(flt: cc.Filters = Depends(get_filters), user=Depends(get_current_user)):
    report = lr.campaign_report(_owner(user), flt)
    if not report["has_data"]:
        raise HTTPException(404, "There is no data to export for these filters.")
    return _csv_response(lr.table_csv(report, "Campaign"), "CostPerLeadByCampaign.csv")


@router.get("/campaign")
def campaign(flt: cc.Filters = Depends(get_filters), user=Depends(get_current_user)):
    """Spend, leads, cost per lead and ROI for each campaign (inbound calls fall under "No campaign")."""
    return _ok(lr.campaign_report(_owner(user), flt))


@router.get("/directions")
def directions(flt: cc.Filters = Depends(get_filters), user=Depends(get_current_user)):
    return _ok(lr.directions_report(_owner(user), flt))


@router.get("/number/export.csv")
def export_number(flt: cc.Filters = Depends(get_filters), user=Depends(get_current_user)):
    report = lr.number_report(_owner(user), flt)
    if not report["has_data"]:
        raise HTTPException(404, "There is no data to export for these filters.")
    return _csv_response(lr.table_csv(report, "Phone number"), "InboundCostPerLeadByNumber.csv")


@router.get("/number")
def number(flt: cc.Filters = Depends(get_filters), user=Depends(get_current_user)):
    """Inbound calls' spend, leads and cost per lead for each of the account's phone numbers."""
    return _ok(lr.number_report(_owner(user), flt))


@router.get("/period/{granularity}/export.csv")
def export_period(granularity: str, flt: cc.Filters = Depends(get_filters), user=Depends(get_current_user)):
    if granularity not in cc.GRANULARITIES:
        raise HTTPException(404, "Unknown report.")
    report = lr.period_report(_owner(user), flt, granularity)
    if not report["has_data"]:
        raise HTTPException(404, "There is no data to export for these filters.")
    name = "WeeklyCostPerLead.csv" if granularity == "weekly" else "MonthlyCostPerLead.csv"
    return _csv_response(lr.table_csv(report, "Week" if granularity == "weekly" else "Month"), name)


@router.get("/period/{granularity}")
def period(granularity: str, flt: cc.Filters = Depends(get_filters), user=Depends(get_current_user)):
    """The trend: weekly (Sunday-start) or monthly spend, leads, cost per lead and ROI, oldest first."""
    if granularity not in cc.GRANULARITIES:
        raise HTTPException(404, "Unknown report.")
    return _ok(lr.period_report(_owner(user), flt, granularity))


@router.get("/values")
def get_values(user=Depends(get_current_user)):
    return _ok(lr.values_view(_owner(user)))


@router.put("/values")
def put_values(body: LeadValuesUpdate, user=Depends(require_owner)):
    """Owner only. `campaign_id` null sets the account default; both values null clears the row (a campaign then
    follows the account default again). Returns the refreshed settings."""
    try:
        # require_owner guarantees this user is the account owner, so their id is the account id.
        return _ok(lr.save_values(user["user_id"], body.campaign_id, body.value_per_qualified_lead, body.value_per_lead))
    except lr.LeadValueError as e:
        raise HTTPException(400, str(e))
