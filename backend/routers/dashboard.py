"""Dashboard home API, mounted under /dashboard: one read-only snapshot for the landing page (headline tiles for a
date range with their change against the range before, a daily trend, what the account has set up,
top campaigns / agents / receptionists and which first steps it has taken). All the work is in services/dashboard_overview.py, which
reuses the Cost per Lead and Call Consumption engines for its numbers.

Open to every team role (GET only, so Viewers see it too) and scoped to the account owner, like the other reports.
Plain `def` on purpose: the work is blocking SQL, so FastAPI runs it in its threadpool.

  GET /dashboard/overview?range=today|7d|30d|custom&tz=<IANA zone>[&from=YYYY-MM-DD&to=YYYY-MM-DD]   (from / to: custom only)
  GET /dashboard/live?tz=<IANA zone>      calls running now + calls today; small enough for the page to poll every ~10 s
"""
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query

from dependencies import get_current_user
from routers.team import resolve_owner_id
from services import dashboard_overview as dash
from services.calendar_service import valid_timezone

router = APIRouter(prefix="/dashboard", tags=["Dashboard"])


@router.get("/overview")
def overview(
    range: str = Query(dash.DEFAULT_RANGE),
    tz: str = Query("UTC"),
    from_date: date | None = Query(None, alias="from"),
    to_date: date | None = Query(None, alias="to"),
    user=Depends(get_current_user),
):
    """The dashboard snapshot. `range` is today, 7d or 30d (ending today in `tz`, the viewer's own zone), or custom with
    `from` and `to` (YYYY-MM-DD, at most a year). 400 with a plain message on anything else."""
    if range not in dash.ALL_RANGES:
        raise HTTPException(400, "Range must be today, 7d, 30d or custom.")
    if not valid_timezone(tz):
        raise HTTPException(400, "That time zone isn't recognised.")
    try:
        data = dash.overview(resolve_owner_id(user["user_id"]), range, tz, from_date, to_date)
    except dash.RangeError as e:
        raise HTTPException(400, str(e))
    return {"data": data, "error": None}


@router.get("/live")
def live(tz: str = Query("UTC"), user=Depends(get_current_user)):
    """Calls running right now (outbound / inbound) and calls today (with how many were answered), in `tz`."""
    if not valid_timezone(tz):
        raise HTTPException(400, "That time zone isn't recognised.")
    return {"data": dash.live(resolve_owner_id(user["user_id"]), tz), "error": None}
