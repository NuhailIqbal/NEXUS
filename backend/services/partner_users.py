"""The partner's user management: the accounts that signed up through their link, searchable and filterable, one account in
detail, and one account's activity history. All of it is read from the existing tables (signups, agents, wallet top-ups,
conversations); there is no separate event log, so it always agrees with the rest of the product.

What a partner gets per account: signup date, verified date, agents created, top-ups (how many, how much), calls, minutes,
billed amount and when the account was last active (the latest of its signup, verification, agent, top-up or call). Never
the platform's cost or profit: no function here selects them. [SAMPLE] demo conversations are left out of every number
(the rule of services/partners.py), and a call event carries no phone number.

Every function is scoped by `partner_id` through partner_referrals, so an account that did not sign up through that partner
is simply not found (UserNotFound), whatever id is asked for. A paused partner keeps reading their history; "View as" is
the only thing a pause turns off (routers/partners.py).

Dates (signup range, activity range) are calendar days in the caller's time zone (`tz`, an IANA name checked by Postgres,
like the commission reports); a range includes both of its days. Lists are paged; the CSV export takes every match up to
MAX_EXPORT rows.
"""
from __future__ import annotations

import csv
import io
import uuid
from datetime import date

from services import partner_reports as pr
from services.partners import SAMPLE_SQL, _iso, _num, _rows

STATUSES = ("pending", "verified")
KINDS = ("signup", "verified", "agent", "funds", "call")
# What the list can be sorted by -> its column in the list query (ties fall back to the signup date, newest first).
SORTS = {"signup": "created_at", "activity": "last_active", "calls": "calls", "billed": "billed"}
MAX_PER_PAGE = 100
DEFAULT_PER_PAGE = 25
MAX_EXPORT = 10_000
MAX_SEARCH = 100


class UserQueryError(ValueError):
    """A request the lists cannot answer (the message is shown to the user as is)."""


class UserNotFound(LookupError):
    """The account does not exist among this partner's referrals."""


def _uuid(value: str) -> str | None:
    try:
        return str(uuid.UUID(str(value)))
    except (ValueError, AttributeError, TypeError):
        return None


def _day_window(col: str, start: date | None, end: date | None, params: dict, prefix: str) -> list[str]:
    """SQL conditions keeping `col` within the calendar days start..end (both included) in the request's time zone."""
    if start and end and start > end:
        raise UserQueryError("The start date must be on or before the end date.")
    out = []
    if start:
        params[f"{prefix}_start"] = start
        out.append(f"{col} >= (%({prefix}_start)s::date)::timestamp AT TIME ZONE %(tz)s")
    if end:
        params[f"{prefix}_end"] = end
        out.append(f"{col} < ((%({prefix}_end)s::date + 1))::timestamp AT TIME ZONE %(tz)s")
    return out


def _paging(page: int, per_page: int | None) -> tuple[int, int | None]:
    if page < 1:
        raise UserQueryError("The page must be 1 or more.")
    if per_page is not None and not 1 <= per_page <= MAX_PER_PAGE:
        raise UserQueryError(f"Show between 1 and {MAX_PER_PAGE} users per page.")
    return page, per_page


def _page_view(items: list[dict], total: int, page: int, per_page: int) -> dict:
    return {"items": items, "total": total, "page": page, "per_page": per_page, "pages": max(1, -(-total // per_page))}


# ───────────────────────────── the users ─────────────────────────────

# One row per referred account, with its usage. `refs` limits every aggregate to this partner's accounts.
_USERS_FROM = (
    "WITH refs AS (SELECT user_id, status, created_at, verified_at FROM partner_referrals WHERE partner_id = %(pid)s::uuid),"
    " usage AS (SELECT c.user_id, count(*) AS calls, sum(coalesce(c.duration_seconds, 0)) AS seconds, sum(c.call_cost) AS billed,"
    "   max(c.call_time) AS last_call FROM conversations c"
    f"   WHERE {SAMPLE_SQL} AND c.user_id IN (SELECT user_id FROM refs) GROUP BY c.user_id),"
    " ag AS (SELECT a.user_id, count(*) AS n, max(a.created_at) AS last_at FROM ai_agents a"
    "   WHERE a.user_id IN (SELECT user_id FROM refs) GROUP BY a.user_id),"
    " tp AS (SELECT w.user_id, count(*) AS n, sum(w.amount) AS total, max(w.created_at) AS last_at FROM wallet_transactions w"
    "   WHERE w.kind = 'topup' AND w.user_id IN (SELECT user_id FROM refs) GROUP BY w.user_id)"
    " SELECT r.user_id::text AS user_id, r.status, r.created_at, r.verified_at, u.email, p.full_name,"
    "   coalesce(us.calls, 0) AS calls, coalesce(us.seconds, 0) AS seconds, coalesce(us.billed, 0) AS billed, us.last_call,"
    "   coalesce(ag.n, 0) AS agents, coalesce(tp.n, 0) AS topups, coalesce(tp.total, 0) AS topup_total,"
    "   greatest(r.created_at, r.verified_at, us.last_call, ag.last_at, tp.last_at) AS last_active"
    " FROM refs r JOIN users u ON u.id = r.user_id LEFT JOIN profiles p ON p.id = r.user_id"
    " LEFT JOIN usage us ON us.user_id = r.user_id LEFT JOIN ag ON ag.user_id = r.user_id LEFT JOIN tp ON tp.user_id = r.user_id"
)


def _user_view(r: dict) -> dict:
    return {
        "user_id": r["user_id"], "email": r["email"], "full_name": r.get("full_name") or "", "status": r["status"],
        "created_at": _iso(r["created_at"]), "verified_at": _iso(r.get("verified_at")),
        "agents": int(r["agents"]), "topups": int(r["topups"]), "topup_total": round(_num(r["topup_total"]), 2),
        "calls": int(r["calls"]), "minutes": round(_num(r["seconds"]) / 60.0, 1), "billed": round(_num(r["billed"]), 2),
        "last_call": _iso(r.get("last_call")), "last_active": _iso(r["last_active"]),
    }


def list_users(partner_id: str, *, q: str | None = None, status: str | None = None, signed_from: date | None = None,
               signed_to: date | None = None, sort: str = "signup", order: str = "desc", page: int = 1,
               per_page: int | None = DEFAULT_PER_PAGE, tz: str | None = None) -> dict:
    """{items, total, page, per_page, pages}: this partner's accounts matching the filters, one page of them. With
    per_page=None every match is returned (up to MAX_EXPORT) as page 1 of 1, which is what the CSV uses."""
    if status and status not in STATUSES:
        raise UserQueryError("Status must be pending or verified.")
    if sort not in SORTS:
        raise UserQueryError("Sort by signup, activity, calls or billed.")
    if order not in ("asc", "desc"):
        raise UserQueryError("Order must be asc or desc.")
    page, per_page = _paging(page, per_page)
    zone, _ = pr.resolve_tz(tz)

    params: dict = {"pid": str(partner_id), "tz": zone}
    where: list[str] = []
    term = (q or "").strip()[:MAX_SEARCH]
    if term:
        params["q"] = "%" + term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        where.append("(u.email ILIKE %(q)s OR coalesce(p.full_name, '') ILIKE %(q)s)")
    if status:
        params["status"] = status
        where.append("r.status = %(status)s")
    where += _day_window("r.created_at", signed_from, signed_to, params, "signed")

    base = _USERS_FROM + (" WHERE " + " AND ".join(where) if where else "")
    order_sql = f" ORDER BY t.{SORTS[sort]} {'ASC' if order == 'asc' else 'DESC'} NULLS LAST, t.created_at DESC, t.user_id"
    if per_page is None:
        rows = _rows(f"SELECT t.* FROM ({base}) t" + order_sql + " LIMIT %(cap)s", {**params, "cap": MAX_EXPORT})
        return _page_view([_user_view(r) for r in rows], len(rows), 1, max(len(rows), 1))
    rows = _rows(f"SELECT t.*, count(*) OVER () AS total FROM ({base}) t" + order_sql + " LIMIT %(lim)s OFFSET %(off)s",
                 {**params, "lim": per_page, "off": (page - 1) * per_page})
    if rows:
        total = int(rows[0]["total"])
    elif page == 1:
        total = 0
    else:                                    # a page past the end: the list is fine, it just has no rows here
        total = int(_rows(f"SELECT count(*) AS n FROM ({base}) t", params)[0]["n"])
    return _page_view([_user_view(r) for r in rows], total, page, per_page)


def get_user(partner_id: str, user_id: str) -> dict:
    """One referred account with the same figures as the list. UserNotFound unless it signed up through this partner."""
    uid = _uuid(user_id)
    if not uid:
        raise UserNotFound("That user did not sign up through your link.")
    rows = _rows(_USERS_FROM + " WHERE r.user_id = %(uid)s::uuid", {"pid": str(partner_id), "uid": uid})
    if not rows:
        raise UserNotFound("That user did not sign up through your link.")
    return _user_view(rows[0])


# ───────────────────────────── one account's activity ─────────────────────────────

def user_activity(partner_id: str, user_id: str, *, kinds: list[str] | None = None, start: date | None = None,
                  end: date | None = None, page: int = 1, per_page: int = DEFAULT_PER_PAGE, tz: str | None = None) -> dict:
    """{items, total, page, per_page, pages}: what this account did, newest first: signed up, verified their email, created an
    agent, added funds, made a call. `kinds` narrows it (default all); start/end are calendar days in `tz`.
    Items are {id, kind, at, detail}. UserNotFound unless the account signed up through this partner."""
    get_user(partner_id, user_id)                       # the ownership check, once, for every query below
    uid = _uuid(user_id)
    if kinds:
        bad = [k for k in kinds if k not in KINDS]
        if bad:
            raise UserQueryError("Kind must be one of: " + ", ".join(KINDS) + ".")
    page, per_page = _paging(page, per_page)
    zone, _ = pr.resolve_tz(tz)

    params: dict = {"uid": uid, "tz": zone, "kinds": list(kinds or KINDS), "lim": per_page, "off": (page - 1) * per_page}
    where = ["t.kind = ANY(%(kinds)s)"] + _day_window("t.at", start, end, params, "act")
    events = (
        "SELECT 'signup' AS kind, r.created_at AS at, NULL::text AS detail, 's' AS k FROM partner_referrals r"
        "   WHERE r.user_id = %(uid)s::uuid"
        " UNION ALL SELECT 'verified', r.verified_at, NULL, 'v' FROM partner_referrals r"
        "   WHERE r.user_id = %(uid)s::uuid AND r.verified_at IS NOT NULL"
        " UNION ALL SELECT 'funds', w.created_at, to_char(w.amount, 'FM999999990.00'), w.id::text FROM wallet_transactions w"
        "   WHERE w.user_id = %(uid)s::uuid AND w.kind = 'topup'"
        " UNION ALL SELECT 'agent', a.created_at, a.name, a.id::text FROM ai_agents a WHERE a.user_id = %(uid)s::uuid"
        " UNION ALL SELECT 'call', c.call_time,"
        "   initcap(coalesce(c.direction, 'outbound')) || ' call · ' || coalesce(c.status, '') ||"
        "   CASE WHEN coalesce(c.duration_seconds, 0) > 0 THEN ' · ' || c.duration_seconds || 's' ELSE '' END, c.id::text"
        f"   FROM conversations c WHERE c.user_id = %(uid)s::uuid AND {SAMPLE_SQL}"
    )
    base = f"SELECT t.* FROM ({events}) t WHERE " + " AND ".join(where)
    rows = _rows(f"SELECT x.*, count(*) OVER () AS total FROM ({base}) x ORDER BY x.at DESC, x.k LIMIT %(lim)s OFFSET %(off)s", params)
    if rows:
        total = int(rows[0]["total"])
    elif page == 1:
        total = 0
    else:
        total = int(_rows(f"SELECT count(*) AS n FROM ({base}) x", params)[0]["n"])
    items = [{"id": f"{r['kind']}:{r['k']}", "kind": r["kind"], "at": _iso(r["at"]), "detail": r["detail"]} for r in rows]
    return _page_view(items, total, page, per_page)


# ───────────────────────────── CSV ─────────────────────────────

def to_csv(users: list[dict]) -> str:
    """The users list as CSV (what the partner filtered to). Text cells a spreadsheet could run as a formula are escaped."""
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(["Email", "Name", "Status", "Signed up", "Verified on", "Agents created", "Top-ups", "Top-up total", "Calls",
                "Minutes", "Billed", "Last active"])
    for u in users:
        w.writerow([pr._safe(u["email"]), pr._safe(u["full_name"]), u["status"], u["created_at"] or "", u["verified_at"] or "",
                    u["agents"], u["topups"], f"{u['topup_total']:.2f}", u["calls"], u["minutes"], f"{u['billed']:.2f}",
                    u["last_active"] or ""])
    return buf.getvalue()
