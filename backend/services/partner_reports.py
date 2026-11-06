"""Commission reports for referral partners: the same numbers as services/partners.py, broken down by day, week, month or
year (or any custom date range), for one partner or all of them.

Per period and partner: signups, verified signups, calls, billed, platform cost, profit, commission earned, net profit.
Each is counted by the date it happened: a signup by when the account registered, a verified signup by when the e-mail was
verified, calls and money by the call time. Dates are calendar days in the caller's time zone (`tz`, an IANA name); weeks
run Monday to Sunday. The first and last period of a custom range are clipped to the range, so a report never counts a day
outside it.

The periods always add up to the lifetime figures in partner_totals(). Rounding is what usually breaks that, so each
money column is rounded once on the RUNNING total and a period shows the difference between two running totals; the
periods then sum to exactly what partner_totals() reports, to the cent. A percentage commission is clamped at zero on the
running profit (the lifetime rule), so a period whose profit went negative can show a small negative commission. A
fixed commission (per verified signup) is one fixed amount for each signup verified in the period.

Partners see only signups, verified, calls, billed and their own commission; platform cost, profit and net profit are
admin-only and are left out of partner_view() and of the partner CSV.
"""
from __future__ import annotations

import csv
import io
import re
from datetime import date, timedelta
from decimal import Decimal

import psycopg

from services.partners import SAMPLE_SQL, _num, _rows, commission_amount, commission_label

GROUPS = ("day", "week", "month", "year")
EARLIEST = date(2020, 1, 1)
MAX_PERIODS = 400
METRICS = ("signups", "verified", "calls", "billed", "platform_cost", "profit", "commission", "net_profit")
ADMIN_ONLY = ("platform_cost", "profit", "net_profit")
PARTNER_METRICS = tuple(m for m in METRICS if m not in ADMIN_ONLY)
_COUNTS = ("signups", "verified", "calls")
_TZ_RE = re.compile(r"^[A-Za-z0-9_+\-/:]{1,64}$")


class ReportError(ValueError):
    """A report request that cannot be answered (the message is shown to the user as is)."""


# ───────────────────────────── dates and periods ─────────────────────────────

def resolve_tz(name: str | None) -> tuple[str, date]:
    """(the time zone name to use, today's date in it). Postgres is the judge of the name, so the dates it computes and the
    dates this module groups by can never disagree. An unknown name raises ReportError."""
    tz = (name or "").strip() or "UTC"
    if not _TZ_RE.match(tz):
        raise ReportError("Unknown time zone.")
    try:
        row = _rows("SELECT (now() AT TIME ZONE %s)::date AS today", (tz,))[0]
    except psycopg.Error:
        raise ReportError("Unknown time zone.")
    return tz, row["today"]


def bucket_start(d: date, group: str) -> date:
    """The first day of the period that contains `d`."""
    if group == "day":
        return d
    if group == "week":
        return d - timedelta(days=d.weekday())
    if group == "month":
        return d.replace(day=1)
    return date(d.year, 1, 1)


def next_bucket(b: date, group: str) -> date:
    """The first day of the period after the one starting at `b`."""
    if group == "day":
        return b + timedelta(days=1)
    if group == "week":
        return b + timedelta(days=7)
    if group == "month":
        return date(b.year + (b.month == 12), b.month % 12 + 1, 1)
    return date(b.year + 1, 1, 1)


def _back(b: date, group: str, n: int) -> date:
    for _ in range(n):
        b = bucket_start(b - timedelta(days=1), group)
    return b


def default_start(group: str, today: date) -> date:
    """Where a report with no start date begins: the last 30 days, 12 weeks, 12 months or 5 years, counting today's."""
    n = {"day": 30, "week": 12, "month": 12, "year": 5}[group]
    return today - timedelta(days=n - 1) if group == "day" else _back(bucket_start(today, group), group, n - 1)


def periods(start: date, end: date, group: str) -> list[dict]:
    """The periods that cover start..end, oldest first. `key` is the period's own first day (what the data is grouped
    by); `start`/`end` are clipped to the range."""
    out, b = [], bucket_start(start, group)
    while b <= end:
        nxt = next_bucket(b, group)
        out.append({"key": b, "start": max(b, start), "end": min(nxt - timedelta(days=1), end)})
        if len(out) > MAX_PERIODS:
            raise ReportError(f"That range has more than {MAX_PERIODS} periods. Pick a shorter range or a larger grouping.")
        b = nxt
    return out


def resolve_range(group: str, start: date | None, end: date | None, today: date) -> tuple[date, date]:
    """The range to report on: the dates given (or the defaults for the grouping), with the end never after today."""
    if group not in GROUPS:
        raise ReportError("Group by day, week, month or year.")
    end = min(end or today, today)
    start = start or default_start(group, today)
    if start < EARLIEST:
        raise ReportError(f"Reports start at {EARLIEST.isoformat()}.")
    if start > end:
        raise ReportError("The start date must be on or before the end date (and not in the future).")
    return start, end


# ───────────────────────────── the numbers ─────────────────────────────

def _cents(v) -> int:
    """A money amount as whole cents, rounded exactly the way partner_totals() rounds its sums."""
    return round(round(float(v), 2) * 100)


def _empty() -> dict:
    return {k: 0 for k in _COUNTS} | {k: 0.0 for k in METRICS if k not in _COUNTS}


def _row(signups: int, verified: int, calls: int, billed_c: int, cost_c: int, commission_c: int) -> dict:
    profit_c = billed_c - cost_c
    return {
        "signups": signups, "verified": verified, "calls": calls,
        "billed": billed_c / 100, "platform_cost": cost_c / 100, "profit": profit_c / 100,
        "commission": commission_c / 100, "net_profit": (profit_c - commission_c) / 100,
    }


def _sum_rows(rows: list[dict]) -> dict:
    return {k: sum(r[k] for r in rows) if k in _COUNTS else round(sum(r[k] for r in rows), 2) for k in METRICS}


def commission_report(partners: list[dict], *, group: str, start: date, end: date, tz: str) -> dict:
    """The report for these partner rows over start..end (already resolved by resolve_range/resolve_tz):
    {group, tz, start, end, periods: [{key,start,end}], partners: [{id, name, status, commission_label, rows, total}]}
    where `rows` has one metrics dict per period, oldest first. Three grouped queries plus one for what came before the
    range (the running commission needs it), whatever the number of partners."""
    pers = periods(start, end, group)
    keys = [p["key"] for p in pers]
    ids = [str(p["id"]) for p in partners]
    out = {"group": group, "tz": tz, "start": start, "end": end, "periods": pers, "partners": []}
    if not ids:
        return out

    prm = {"ids": ids, "unit": group, "tz": tz, "start": start, "end": end}
    lo = "(%(start)s::date)::timestamp AT TIME ZONE %(tz)s"
    hi = "((%(end)s::date + 1))::timestamp AT TIME ZONE %(tz)s"

    def bucket(col: str) -> str:
        return f"(date_trunc(%(unit)s::text, {col} AT TIME ZONE %(tz)s))::date"

    signed = {(r["pid"], r["b"]): r["n"] for r in _rows(
        f"SELECT partner_id::text AS pid, {bucket('created_at')} AS b, count(*) AS n FROM partner_referrals"
        f" WHERE partner_id = ANY(%(ids)s::uuid[]) AND created_at >= {lo} AND created_at < {hi} GROUP BY 1, 2", prm)}
    verified = {(r["pid"], r["b"]): r["n"] for r in _rows(
        f"SELECT partner_id::text AS pid, {bucket('coalesce(verified_at, created_at)')} AS b, count(*) AS n"
        " FROM partner_referrals WHERE partner_id = ANY(%(ids)s::uuid[]) AND status = 'verified'"
        f" AND coalesce(verified_at, created_at) >= {lo} AND coalesce(verified_at, created_at) < {hi} GROUP BY 1, 2", prm)}
    usage = {(r["pid"], r["b"]): r for r in _rows(
        f"SELECT pr.partner_id::text AS pid, {bucket('c.call_time')} AS b, count(c.id) AS calls,"
        " coalesce(sum(c.call_cost), 0) AS billed, coalesce(sum(c.provider_cost), 0) AS cost"
        " FROM partner_referrals pr JOIN conversations c ON c.user_id = pr.user_id"
        f" WHERE pr.partner_id = ANY(%(ids)s::uuid[]) AND {SAMPLE_SQL}"
        f" AND c.call_time >= {lo} AND c.call_time < {hi} GROUP BY 1, 2", prm)}
    before = {r["pid"]: r for r in _rows(
        "SELECT pr.partner_id::text AS pid, coalesce(sum(c.call_cost), 0) AS billed, coalesce(sum(c.provider_cost), 0) AS cost"
        " FROM partner_referrals pr JOIN conversations c ON c.user_id = pr.user_id"
        f" WHERE pr.partner_id = ANY(%(ids)s::uuid[]) AND {SAMPLE_SQL} AND c.call_time < {lo} GROUP BY 1", prm)}

    for p in partners:
        pid = str(p["id"])
        percent = p["commission_type"] != "fixed"
        value = _num(p["commission_value"])

        def earned_c(profit_c: int) -> int:  # the lifetime commission on a running profit, in cents
            return _cents(commission_amount("percent", value, 0, profit_c / 100))

        pre = before.get(pid, {})
        cum_b, cum_c = Decimal(pre.get("billed") or 0), Decimal(pre.get("cost") or 0)
        prev_b, prev_c = _cents(cum_b), _cents(cum_c)
        prev_comm = earned_c(prev_b - prev_c) if percent else 0
        rows = []
        for k in keys:
            u = usage.get((pid, k))
            if u:
                cum_b += Decimal(u["billed"])
                cum_c += Decimal(u["cost"])
            b_c, c_c = _cents(cum_b), _cents(cum_c)
            ver = int(verified.get((pid, k), 0))
            if percent:
                comm = earned_c(b_c - c_c)
                comm_c, prev_comm = comm - prev_comm, comm
            else:
                comm_c = _cents(value) * ver
            rows.append(_row(int(signed.get((pid, k), 0)), ver, int(u["calls"]) if u else 0, b_c - prev_b, c_c - prev_c, comm_c))
            prev_b, prev_c = b_c, c_c
        out["partners"].append({
            "id": pid, "name": p["name"], "status": p.get("status"),
            "commission_label": commission_label(p["commission_type"], p["commission_value"]),
            "rows": rows, "total": _sum_rows(rows) if rows else _empty(),
        })
    return out


# ───────────────────────────── shaping for the two audiences ─────────────────────────────

def _head(report: dict) -> dict:
    return {"group": report["group"], "tz": report["tz"], "start": report["start"].isoformat(), "end": report["end"].isoformat()}


def _period_rows(report: dict, metrics: tuple[str, ...]) -> list[dict]:
    """One row per period with the partners' numbers added together, restricted to `metrics`."""
    out = []
    for i, per in enumerate(report["periods"]):
        merged = _sum_rows([p["rows"][i] for p in report["partners"]]) if report["partners"] else _empty()
        out.append({"key": per["key"].isoformat(), "start": per["start"].isoformat(), "end": per["end"].isoformat(),
                    **{m: merged[m] for m in metrics}})
    return out


def admin_view(report: dict) -> dict:
    """All numbers: one row per period (the selected partners added together), the grand total, and each partner's total."""
    rows = _period_rows(report, METRICS)
    return {
        **_head(report), "periods": rows,
        "total": _sum_rows([{m: r[m] for m in METRICS} for r in rows]) if rows else _empty(),
        "partners": [{"id": p["id"], "name": p["name"], "status": p["status"], "commission_label": p["commission_label"],
                      "total": p["total"]} for p in report["partners"]],
    }


def partner_view(report: dict) -> dict:
    """What a partner may see: signups, verified, calls, billed and their own commission. Platform cost, profit and net
    profit are never included."""
    rows = _period_rows(report, PARTNER_METRICS)
    return {
        **_head(report), "commission_label": report["partners"][0]["commission_label"] if report["partners"] else "",
        "periods": rows,
        "total": {m: (sum(r[m] for r in rows) if m in _COUNTS else round(sum(r[m] for r in rows), 2)) for m in PARTNER_METRICS},
    }


# ───────────────────────────── CSV ─────────────────────────────

def _safe(text: str) -> str:
    """A text cell a spreadsheet will not run as a formula (a partner can be named anything)."""
    return "'" + text if text[:1] in ("=", "+", "-", "@", "\t", "\r") else text


def _money(v: float) -> str:
    return f"{v:.2f}"


def _label(start: str, end: str) -> str:
    return start if start == end else f"{start} to {end}"


def to_csv(report: dict, *, admin: bool) -> str:
    """The report as CSV, oldest period first, with a Total row at the end. Admin: one line per period and partner (plus
    every partner's total and, for several partners, the grand total). Partner: one line per period (their own numbers)."""
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    pers = report["periods"]
    if not admin:
        view = partner_view(report)
        w.writerow(["Period", "Signups", "Verified signups", "Calls", "Billed", "Commission earned"])
        for r in view["periods"]:
            w.writerow([_label(r["start"], r["end"]), r["signups"], r["verified"], r["calls"], _money(r["billed"]), _money(r["commission"])])
        t = view["total"]
        w.writerow(["Total", t["signups"], t["verified"], t["calls"], _money(t["billed"]), _money(t["commission"])])
        return buf.getvalue()

    def cells(r: dict) -> list:
        return [r["signups"], r["verified"], r["calls"], _money(r["billed"]), _money(r["platform_cost"]), _money(r["profit"]),
                _money(r["commission"]), _money(r["net_profit"])]

    w.writerow(["Period", "Partner", "Commission rule", "Signups", "Verified signups", "Calls", "Billed", "Platform cost",
                "Profit", "Commission earned", "Platform net profit"])
    for p in report["partners"]:
        for per, r in zip(pers, p["rows"]):
            w.writerow([_label(per["start"].isoformat(), per["end"].isoformat()), _safe(p["name"]), _safe(p["commission_label"]), *cells(r)])
    for p in report["partners"]:
        w.writerow(["Total", _safe(p["name"]), _safe(p["commission_label"]), *cells(p["total"])])
    if len(report["partners"]) > 1:
        w.writerow(["Total", "All partners", "", *cells(admin_view(report)["total"])])
    return buf.getvalue()
