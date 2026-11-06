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
  paid           what has actually been paid to the partner = sum(partner_payouts.amount) over non-void payments
  owed           commission - paid  (negative = overpaid, which only happens when the rate is lowered after paying)
A call whose provider cost was never reported has provider_cost 0, so its whole charge counts as profit.
Phone-number monthly fees and wallet top-ups are not part of this: it is call usage only.

Payments are a ledger (`partner_payouts`): recorded with record_payout (which refuses to pay more than is owed), never
deleted, and undone with void_payout (the row stays, marked void, with who and why).

Plain SQL through db_pg's pool, aggregated in the database (not row by row in Python).
"""
from __future__ import annotations

from datetime import date, datetime
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
    return v.isoformat() if isinstance(v, (datetime, date)) else v


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
    """{partner_id: signups, verified, calls, billed, platform_cost, profit, commission, net_profit, paid, owed} for
    each partner row given (three grouped queries, whatever the number of partners). Partners with no signups get zeros."""
    if not partners:
        return {}
    ids = [str(p["id"]) for p in partners]
    payouts = _rows(
        "SELECT partner_id::text AS pid, coalesce(sum(amount), 0) AS paid FROM partner_payouts"
        " WHERE partner_id = ANY(%(ids)s::uuid[]) AND status = 'paid' GROUP BY 1", {"ids": ids})
    paid_by = {r["pid"]: round(_num(r["paid"]), 2) for r in payouts}
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
        paid = paid_by.get(pid, 0.0)
        out[pid] = {
            "signups": int(s.get("signups") or 0), "verified": verified, "calls": int(u.get("calls") or 0),
            "billed": billed, "platform_cost": cost, "profit": profit,
            "commission": commission, "net_profit": round(profit - commission, 2),
            "paid": paid, "owed": round(commission - paid, 2),
        }
    return out


# ───────────────────────────── payouts (the payment ledger) ─────────────────────────────

class PayoutError(ValueError):
    """A payment the ledger refuses (the message is shown to the admin as is)."""


class PayoutNotFound(LookupError):
    """The payment does not exist for that partner."""


_PAYOUT_COLS = "id, amount, paid_on, method, reference, note, status, created_by, created_at, voided_at, voided_by, void_reason"


def _payout_view(r: dict) -> dict:
    return {
        "id": str(r["id"]), "amount": round(_num(r["amount"]), 2), "paid_on": _iso(r["paid_on"]),
        "method": r.get("method") or "", "reference": r.get("reference") or "", "note": r.get("note") or "",
        "status": r["status"], "created_by": r.get("created_by") or "", "created_at": _iso(r["created_at"]),
        "voided_at": _iso(r.get("voided_at")), "voided_by": r.get("voided_by") or "", "void_reason": r.get("void_reason") or "",
    }


def list_payouts(partner_id: str, *, include_void: bool = True) -> list[dict]:
    """The partner's payments, newest first (void ones included for the admin, who needs the audit trail)."""
    rows = _rows(
        f"SELECT {_PAYOUT_COLS} FROM partner_payouts WHERE partner_id = %(pid)s::uuid"
        + ("" if include_void else " AND status = 'paid'")
        + " ORDER BY paid_on DESC, created_at DESC", {"pid": str(partner_id)})
    return [_payout_view(r) for r in rows]


def record_payout(partner: dict, amount: float, paid_on: date, method: str | None, reference: str | None,
                  note: str | None, created_by: str) -> dict:
    """Record a payment to the partner. Refuses more than is still owed. Takes a per-partner lock around the
    check-and-insert so two admins cannot both pay the same balance."""
    pid = str(partner["id"])
    with _get_pool().connection() as conn:
        # The pool is autocommit, so an explicit transaction is what keeps the lock held until the insert commits.
        with conn.transaction():
            conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"partner_payout:{pid}",))
            owed = partner_totals([partner])[pid]["owed"]  # reads committed rows, so a payment that just finished counts
            if owed <= 0:
                raise PayoutError("Nothing is owed to this partner right now.")
            if round(amount * 100) > round(owed * 100):
                raise PayoutError(f"That is more than what is still owed (${owed:,.2f}).")
            row = conn.execute(
                "INSERT INTO partner_payouts (partner_id, amount, paid_on, method, reference, note, created_by)"
                f" VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING {_PAYOUT_COLS}",
                (pid, round(amount, 2), paid_on, method, reference, note, created_by)).fetchone()
    return _payout_view(row)


def _get_payout(conn, partner_id: str, payout_id: str) -> dict:
    row = conn.execute(f"SELECT {_PAYOUT_COLS} FROM partner_payouts WHERE id = %s AND partner_id = %s",
                       (payout_id, str(partner_id))).fetchone()
    if not row:
        raise PayoutNotFound("Payment not found.")
    return row


def update_payout(partner_id: str, payout_id: str, fields: dict) -> dict:
    """Edit the descriptive fields (method, reference, note) of a payment that is still valid. The amount and date
    never change: to correct them, void the payment and record a new one."""
    with _get_pool().connection() as conn:
        current = _get_payout(conn, partner_id, payout_id)
        if current["status"] != "paid":
            raise PayoutError("A voided payment cannot be edited.")
        merged = {k: fields[k] if k in fields else current.get(k) for k in ("method", "reference", "note")}
        row = conn.execute(
            f"UPDATE partner_payouts SET method = %s, reference = %s, note = %s WHERE id = %s RETURNING {_PAYOUT_COLS}",
            (merged["method"], merged["reference"], merged["note"], payout_id)).fetchone()
    return _payout_view(row)


def void_payout(partner_id: str, payout_id: str, reason: str, by: str) -> dict:
    """Undo a payment: the row stays (audit trail) but stops counting, so the amount is owed again."""
    with _get_pool().connection() as conn:
        current = _get_payout(conn, partner_id, payout_id)
        if current["status"] != "paid":
            raise PayoutError("This payment is already voided.")
        row = conn.execute(
            "UPDATE partner_payouts SET status = 'void', voided_at = now(), voided_by = %s, void_reason = %s"
            f" WHERE id = %s AND status = 'paid' RETURNING {_PAYOUT_COLS}", (by, reason, payout_id)).fetchone()
        if not row:  # voided by someone else between the check and the update
            raise PayoutError("This payment is already voided.")
    return _payout_view(row)


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
