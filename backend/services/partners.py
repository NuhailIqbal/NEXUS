"""Referral partner reporting: signups, money (billed vs platform cost vs profit vs commission) and the live feed.

A referral PARTNER is an admin-managed affiliate (table `referral_partners`). Every account that registers with the
partner's code is attributed to it in `partner_referrals` (see routers/auth.py). This module only reads; the routers
(routers/partners.py) wrap it for the admin portal and for the partner's own page.

The money, per partner, over the call usage of the accounts it referred ([SAMPLE] demo rows left out):
  billed         what the referred accounts were charged            = sum(conversations.call_cost)
  platform_cost  what the platform paid its providers for those     = sum(conversations.provider_cost)
  profit         billed - platform_cost  ("how much money they're going to make")
  commission     'percent': value % of the profit (never negative);  'fixed': value per VERIFIED signup (one-off)
  net_profit     profit - commission  (what the platform keeps)
A call whose provider cost was never reported has provider_cost 0, so its whole charge counts as profit.
Phone-number monthly fees and wallet top-ups are not part of this: it is call usage only.

Plain SQL through db_pg's pool, aggregated in the database (not row by row in Python).
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from db_pg import _get_pool

COMMISSION_TYPES = ("percent", "fixed")
# Left out of every number: seeded "[SAMPLE]" demo conversations (the same rule Cost per Lead uses).
SAMPLE_SQL = "left(coalesce(c.contact_name, ''), 8) <> '[SAMPLE]'"
ACTIVITY_LIMIT = 40


def _rows(sql: str, params: dict | tuple = ()) -> list[dict]:
    with _get_pool().connection() as conn:
        return conn.execute(sql, params).fetchall()


def _num(v) -> float:
    return float(v) if isinstance(v, (Decimal, int, float)) else 0.0


def _iso(v):
    return v.isoformat() if isinstance(v, datetime) else v


def commission_label(ctype: str, value) -> str:
    """'20% of profit' / '$5.00 per verified signup' — shown to both admin and partner."""
    v = _num(value)
    if ctype == "fixed":
        return f"${v:,.2f} per verified signup"
    pct = f"{v:g}"
    return f"{pct}% of profit"


def commission_amount(ctype: str, value, verified: int, profit: float) -> float:
    """What the partner has earned so far under their commission rule (see the module docstring)."""
    v = _num(value)
    if ctype == "fixed":
        return round(v * verified, 2)
    return round(max(profit, 0.0) * v / 100.0, 2)


def partner_totals(partners: list[dict]) -> dict[str, dict]:
    """{partner_id: signups, verified, calls, billed, platform_cost, profit, commission, net_profit} for each partner
    row given (two grouped queries, whatever the number of partners). Partners with no signups get zeros."""
    if not partners:
        return {}
    ids = [str(p["id"]) for p in partners]
    signups = _rows(
        "SELECT partner_id::text AS pid, count(*) AS signups, count(*) FILTER (WHERE status = 'verified') AS verified"
        " FROM partner_referrals WHERE partner_id = ANY(%(ids)s::uuid[]) GROUP BY 1", {"ids": ids})
    usage = _rows(
        "SELECT pr.partner_id::text AS pid, count(c.id) AS calls, coalesce(sum(c.call_cost), 0) AS billed,"
        " coalesce(sum(c.provider_cost), 0) AS cost"
        " FROM partner_referrals pr JOIN conversations c ON c.user_id = pr.user_id"
        f" WHERE pr.partner_id = ANY(%(ids)s::uuid[]) AND {SAMPLE_SQL} GROUP BY 1", {"ids": ids})
    s_by = {r["pid"]: r for r in signups}
    u_by = {r["pid"]: r for r in usage}
    out = {}
    for p in partners:
        pid = str(p["id"])
        s, u = s_by.get(pid, {}), u_by.get(pid, {})
        billed, cost = round(_num(u.get("billed")), 2), round(_num(u.get("cost")), 2)
        profit = round(billed - cost, 2)
        verified = int(s.get("verified") or 0)
        commission = commission_amount(p.get("commission_type"), p.get("commission_value"), verified, profit)
        out[pid] = {
            "signups": int(s.get("signups") or 0), "verified": verified, "calls": int(u.get("calls") or 0),
            "billed": billed, "platform_cost": cost, "profit": profit,
            "commission": commission, "net_profit": round(profit - commission, 2),
        }
    return out


def partner_signups(partner_id: str) -> list[dict]:
    """Every account attributed to the partner, newest first, with its usage. Includes the platform cost and profit
    per account; the partner-facing router strips those two (partners never see what the platform pays)."""
    rows = _rows(
        "SELECT pr.user_id::text AS user_id, pr.status, pr.created_at, pr.verified_at, u.email, p.full_name,"
        " coalesce(c.calls, 0) AS calls, coalesce(c.seconds, 0) AS seconds, coalesce(c.billed, 0) AS billed,"
        " coalesce(c.cost, 0) AS cost, c.last_call"
        " FROM partner_referrals pr JOIN users u ON u.id = pr.user_id LEFT JOIN profiles p ON p.id = pr.user_id"
        " LEFT JOIN (SELECT c.user_id, count(*) AS calls, sum(coalesce(c.duration_seconds, 0)) AS seconds,"
        "   sum(c.call_cost) AS billed, sum(c.provider_cost) AS cost, max(c.call_time) AS last_call"
        f"   FROM conversations c WHERE {SAMPLE_SQL}"
        "   AND c.user_id IN (SELECT user_id FROM partner_referrals WHERE partner_id = %(pid)s::uuid)"
        "   GROUP BY c.user_id) c ON c.user_id = pr.user_id"
        " WHERE pr.partner_id = %(pid)s::uuid ORDER BY pr.created_at DESC", {"pid": str(partner_id)})
    out = []
    for r in rows:
        billed, cost = round(_num(r["billed"]), 2), round(_num(r["cost"]), 2)
        out.append({
            "user_id": r["user_id"], "email": r["email"], "full_name": r.get("full_name") or "",
            "status": r["status"], "created_at": _iso(r["created_at"]), "verified_at": _iso(r.get("verified_at")),
            "calls": int(r["calls"]), "minutes": round(_num(r["seconds"]) / 60.0, 1),
            "billed": billed, "platform_cost": cost, "profit": round(billed - cost, 2),
            "last_call": _iso(r.get("last_call")),
        })
    return out


def activity_feed(partner_id: str | None = None, limit: int = ACTIVITY_LIMIT) -> list[dict]:
    """The latest actions of referred users, newest first: signed up, verified email, added funds, created an agent, a
    call. One partner when `partner_id` is given, every partner otherwise. Computed from the existing tables (there is no
    separate event log), so it is always consistent with the rest of the product. Call rows carry no phone number."""
    sql = (
        "WITH refs AS (SELECT pr.user_id, pr.partner_id, pr.created_at, pr.verified_at FROM partner_referrals pr"
        "   WHERE (%(pid)s::uuid IS NULL OR pr.partner_id = %(pid)s::uuid))"
        " SELECT * FROM ("
        "  SELECT 'signup' AS kind, r.user_id, r.partner_id, r.created_at AS at, NULL::text AS detail, r.user_id::text || 's' AS k FROM refs r"
        "  UNION ALL SELECT 'verified', r.user_id, r.partner_id, r.verified_at, NULL, r.user_id::text || 'v' FROM refs r"
        "    WHERE r.verified_at IS NOT NULL"
        "  UNION ALL SELECT 'funds', w.user_id, r.partner_id, w.created_at, to_char(w.amount, 'FM999999990.00'), w.id::text"
        "    FROM wallet_transactions w JOIN refs r ON r.user_id = w.user_id WHERE w.kind = 'topup'"
        "  UNION ALL SELECT 'agent', a.user_id, r.partner_id, a.created_at, a.name, a.id::text"
        "    FROM ai_agents a JOIN refs r ON r.user_id = a.user_id"
        "  UNION ALL SELECT 'call', c.user_id, r.partner_id, c.call_time,"
        "    initcap(coalesce(c.direction, 'outbound')) || ' call · ' || coalesce(c.status, '') ||"
        "    CASE WHEN coalesce(c.duration_seconds, 0) > 0 THEN ' · ' || c.duration_seconds || 's' ELSE '' END, c.id::text"
        f"    FROM conversations c JOIN refs r ON r.user_id = c.user_id WHERE {SAMPLE_SQL}"
        " ) t ORDER BY at DESC LIMIT %(lim)s"
    )
    rows = _rows(sql, {"pid": str(partner_id) if partner_id else None, "lim": int(limit)})
    if not rows:
        return []
    uids = list({str(r["user_id"]) for r in rows})
    pids = list({str(r["partner_id"]) for r in rows})
    emails = {r["id"]: r["email"] for r in _rows(
        "SELECT id::text AS id, email FROM users WHERE id = ANY(%(i)s::uuid[])", {"i": uids})}
    names = {r["id"]: r["name"] for r in _rows(
        "SELECT id::text AS id, name FROM referral_partners WHERE id = ANY(%(i)s::uuid[])", {"i": pids})}
    return [{
        "id": f"{r['kind']}:{r['k']}", "kind": r["kind"], "at": _iso(r["at"]), "detail": r["detail"],
        "user_id": str(r["user_id"]), "email": emails.get(str(r["user_id"]), ""),
        "partner_id": str(r["partner_id"]), "partner_name": names.get(str(r["partner_id"]), ""),
    } for r in rows]
