"""Platform financial summary for the super admin: what the referred users were billed, what the platform paid its providers,
the gross profit, the commission earned by partners, the commission actually paid, what is still owed, and what the
platform keeps. By period (day / week / month / year or a custom range) and per partner.

It adds nothing new to the maths: the billed / cost / profit / commission figures are the commission report's
(services/partner_reports.py, which is partner_totals() split by period), and the payments are the non-void rows of the
ledger (partner_payouts), counted on the day they were paid (`paid_on`, a plain date, so no time zone is involved).

Per partner and period:
  billed, platform_cost, profit   as in the commission report
  commission                      earned in the period (the report's figure)
  paid                            payments dated in the period
  owed_start / owed               what was owed to the partner at the start / end of the period: everything earned up to
                                  then minus everything paid up to then (negative = overpaid, which only happens when the
                                  rate is lowered after paying)
  net_kept                        profit - commission earned (what the platform keeps)
so that for every row:  owed_start + commission - paid = owed.  Over a range that starts at the beginning
(EARLIEST) owed_start is 0 and paid + owed = commission. Every partner counts, paused ones included: a pause stops new
signups, not the history they earned. [SAMPLE] demo conversations are left out (the report's rule).

Money is carried in whole cents, so the periods, the partners and the grand total all agree to the cent.
"""
from __future__ import annotations

import csv
import io
from datetime import date, timedelta

from services import partner_reports as pr
from services.partners import _rows

# Money columns of a row, in cents internally and in dollars on the wire.
_MONEY = ("billed", "platform_cost", "profit", "commission", "paid", "owed_start", "owed", "net_kept")


def _c(v) -> int:
    """Dollars (as the report sends them, already whole cents) -> cents."""
    return round(float(v) * 100)


def _line(billed_c: int, cost_c: int, comm_c: int, paid_c: int, start_c: int) -> dict:
    """One row of money from cents. `start_c` is what was owed at the start of the row; owed (the end) follows from it."""
    profit_c = billed_c - cost_c
    return {
        "billed": billed_c / 100, "platform_cost": cost_c / 100, "profit": profit_c / 100, "commission": comm_c / 100,
        "paid": paid_c / 100, "owed_start": start_c / 100, "owed": (start_c + comm_c - paid_c) / 100,
        "net_kept": (profit_c - comm_c) / 100,
    }


def _sum(rows: list[dict]) -> dict:
    return {k: round(sum(_c(r[k]) for r in rows) / 100, 2) for k in _MONEY}


def _payments(ids: list[str], unit: str, start: date, end: date) -> tuple[dict, dict, dict]:
    """The non-void payments: ({(partner, period): cents}, {partner: cents paid before `start`}, {partner: cents paid
    up to `end`}). A payment dated after `end` is in none of them."""
    prm = {"ids": ids, "unit": unit, "start": start, "end": end}
    inside = {(r["pid"], r["b"]): _c(r["amount"]) for r in _rows(
        "SELECT partner_id::text AS pid, date_trunc(%(unit)s::text, paid_on::timestamp)::date AS b, sum(amount) AS amount"
        " FROM partner_payouts WHERE partner_id = ANY(%(ids)s::uuid[]) AND status = 'paid'"
        " AND paid_on >= %(start)s AND paid_on <= %(end)s GROUP BY 1, 2", prm)}
    before = {r["pid"]: _c(r["amount"]) for r in _rows(
        "SELECT partner_id::text AS pid, sum(amount) AS amount FROM partner_payouts"
        " WHERE partner_id = ANY(%(ids)s::uuid[]) AND status = 'paid' AND paid_on < %(start)s GROUP BY 1", prm)}
    return inside, before


def financial_summary(partners: list[dict], *, group: str, start: date, end: date, tz: str) -> dict:
    """The summary for these partner rows over start..end (already resolved by resolve_range / resolve_tz):
    {group, tz, start, end, periods: [{key,start,end}], partners: [{id, name, status, commission_label, rows, total}]}
    where `rows` has one money dict per period, oldest first and `total` covers the whole range (owed_start of the
    range, owed at its end)."""
    report = pr.commission_report(partners, group=group, start=start, end=end, tz=tz)
    out = {"group": group, "tz": tz, "start": start, "end": end, "periods": report["periods"], "partners": []}
    if not report["partners"]:
        return out

    ids = [p["id"] for p in report["partners"]]
    paid_in, paid_before = _payments(ids, group, start, end)

    # What was earned before the range: the lifetime commission up to the day before it, from the same engine (years from
    # EARLIEST), so it can never disagree with the periods.
    earned_before: dict[str, int] = {}
    if start > pr.EARLIEST:
        prior = pr.commission_report(partners, group="year", start=pr.EARLIEST, end=start - timedelta(days=1), tz=tz)
        earned_before = {p["id"]: _c(p["total"]["commission"]) for p in prior["partners"]}

    for p in report["partners"]:
        pid = p["id"]
        balance_c = earned_before.get(pid, 0) - paid_before.get(pid, 0)
        opening_c = balance_c
        rows = []
        for per, r in zip(report["periods"], p["rows"]):
            paid_c = paid_in.get((pid, per["key"]), 0)
            row = _line(_c(r["billed"]), _c(r["platform_cost"]), _c(r["commission"]), paid_c, balance_c)
            balance_c = _c(row["owed"])
            rows.append(row)
        out["partners"].append({
            "id": pid, "name": p["name"], "status": p["status"], "commission_label": p["commission_label"],
            "rows": rows, "total": {**_sum(rows), "owed_start": opening_c / 100, "owed": balance_c / 100},
        })
    return out


# ───────────────────────────── shaping ─────────────────────────────

def view(summary: dict) -> dict:
    """The JSON for the admin page: one row per period (every partner added up), the grand total and each partner's total."""
    periods = []
    for i, per in enumerate(summary["periods"]):
        merged = {k: round(sum(_c(p["rows"][i][k]) for p in summary["partners"]) / 100, 2) for k in _MONEY}
        periods.append({"key": per["key"].isoformat(), "start": per["start"].isoformat(), "end": per["end"].isoformat(), **merged})
    total = _sum(periods) if periods else {k: 0.0 for k in _MONEY}
    if periods:
        # A balance is not a sum over periods: it is where the range started and where it ended.
        total["owed_start"], total["owed"] = periods[0]["owed_start"], periods[-1]["owed"]
    return {
        "group": summary["group"], "tz": summary["tz"], "start": summary["start"].isoformat(), "end": summary["end"].isoformat(),
        "periods": periods, "total": total,
        "partners": [{k: p[k] for k in ("id", "name", "status", "commission_label", "total")} for p in summary["partners"]],
    }


def _money(v: float) -> str:
    return f"{v:.2f}"


def to_csv(summary: dict) -> str:
    """The summary as CSV for accounting, oldest period first: one line per period and partner, every partner's total,
    and the grand total when there are several. Each line reconciles: Owed at start + Commission earned - Commission paid
    = Owed at end."""
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(["Period", "Partner", "Commission rule", "Billed", "Platform cost", "Gross profit", "Commission earned",
                "Commission paid", "Owed at start", "Owed at end", "Net kept by platform"])

    def cells(r: dict) -> list:
        return [_money(r[k]) for k in ("billed", "platform_cost", "profit", "commission", "paid", "owed_start", "owed", "net_kept")]

    def label(start: str, end: str) -> str:
        return start if start == end else f"{start} to {end}"

    for p in summary["partners"]:
        for per, r in zip(summary["periods"], p["rows"]):
            w.writerow([label(per["start"].isoformat(), per["end"].isoformat()), pr._safe(p["name"]), pr._safe(p["commission_label"]), *cells(r)])
    for p in summary["partners"]:
        w.writerow(["Total", pr._safe(p["name"]), pr._safe(p["commission_label"]), *cells(p["total"])])
    if len(summary["partners"]) > 1:
        w.writerow(["Total", "All partners", "", *cells(view(summary)["total"])])
    return buf.getvalue()
