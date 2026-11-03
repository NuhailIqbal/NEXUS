"""Billing documents: the account block and the DATA behind monthly statements and
top-up receipts. Backs routers/billing_documents.py; the PDF drawing lives in services/billing_pdf.py.

What the documents are (Phase 1, USD, English, NO TAX)
  * A statement is a month of the account's prepaid wallet: opening balance, credits added, charges, closing balance.
    It is NOT a tax invoice and calculates no tax. A receipt confirms one top-up payment.
  * Every figure comes from the `wallet_transactions` ledger (customer-facing amounts only: what the account paid and
    was charged, never what the voice service or carrier cost, and never the markup).

How a month reconciles
  * opening  = everything the ledger booked before the month starts           (credits - charges)
  * closing  = opening + credits of the month - charges of the month
  * Credits that EXPIRE (a promo grant past its date) reduce the wallet without a ledger row, so they come from
    `credit_grants` (the unspent rest of a grant whose expires_at has passed) and appear as their own "Expired credits"
    charge. With that line the closing balance of the newest month equals the live wallet balance, and each month's
    opening equals the previous month's closing. All maths is Decimal in cents.
  * Months are cut in UTC (every document says so).

Which months exist: those with ledger activity or an expiry, up to the current (in-progress) month. A month outside
that list has no statement.
"""
import re
import uuid
from datetime import datetime, timezone
from decimal import Decimal

from db_pg import _get_pool

UTC = timezone.utc
CENT = Decimal("0.01")
ZERO = Decimal("0.00")

MONTH_RE = re.compile(r"^(\d{4})-(0[1-9]|1[0-2])$")

# Ledger kind -> the statement line it belongs to. A credit is a row with amount > 0, a charge amount < 0.
# Unknown kinds fall into "other" so a new kind can never make a statement stop adding up.
_CREDIT_LINE = {"topup": "topups", "promo": "promo", "promo_code": "promo", "refund": "refunds",
                "admin": "adjustments"}
_DEBIT_LINE = {"call": "calls", "phone": "phone", "admin": "adjustments"}

CREDIT_LINES = ("topups", "promo", "refunds", "adjustments", "other")
DEBIT_LINES = ("calls", "phone", "adjustments", "expired", "other")

# Itemised lists stop here (the totals above them never do): a pathological account must not produce a huge PDF.
MAX_ITEMS = 300

NO_CAMPAIGN_OUT = "Outbound calls (no campaign)"
INBOUND_LABEL = "Inbound calls"
OTHER_CALLS_LABEL = "Other calls"
DELETED_CAMPAIGN = "Deleted campaign"


# ------------------------------------------------------------------------------------------------ money & months

def money(v) -> Decimal:
    """Decimal rounded to whole cents (None -> 0.00)."""
    return Decimal(str(v if v is not None else 0)).quantize(CENT)


def f2(v: Decimal) -> float:
    """JSON-friendly 2-decimals float (the API sends dollars as numbers, like the rest of /billing)."""
    return float(money(v))


def parse_month(month: str) -> tuple[datetime, datetime]:
    """'2026-10' -> [2026-10-01, 2026-11-01) in UTC. Raises ValueError on anything else."""
    m = MONTH_RE.match(month or "")
    if not m:
        raise ValueError("Month must look like 2026-10")
    y, mo = int(m.group(1)), int(m.group(2))
    start = datetime(y, mo, 1, tzinfo=UTC)
    end = datetime(y + (mo == 12), 1 if mo == 12 else mo + 1, 1, tzinfo=UTC)
    return start, end


def month_label(month: str) -> str:
    start, _ = parse_month(month)
    return start.strftime("%B %Y")


def current_month(now: datetime | None = None) -> str:
    return (now or datetime.now(UTC)).astimezone(UTC).strftime("%Y-%m")


# ------------------------------------------------------------------------------------------------ account block

def billed_to(owner_id: str) -> dict:
    """The account's own details as they already exist (nothing extra to fill in): {name, lines, email, tax_id}.
    name = the profile's company name, else the person's name, else the login email; lines = the contact person
    (when the company name is shown) ; email = the login email. tax_id is always None (no tax in Phase 1)."""
    with _get_pool().connection() as conn:
        prof = conn.execute("SELECT full_name, company_name FROM public.profiles WHERE id = %s::uuid",
                            (owner_id,)).fetchone() or {}
        user = conn.execute("SELECT email FROM public.users WHERE id = %s::uuid", (owner_id,)).fetchone() or {}
    company = (prof.get("company_name") or "").strip()
    person = (prof.get("full_name") or "").strip()
    email = user.get("email")
    name = company or person or email or "Account holder"
    lines = [person] if company and person and person != company else []
    return {"name": name, "lines": lines, "email": email, "tax_id": None}


# ------------------------------------------------------------------------------------------------ statements

def _blank_lines() -> dict:
    return {"credits": {k: ZERO for k in CREDIT_LINES}, "debits": {k: ZERO for k in DEBIT_LINES}}


def _month_buckets(owner_id: str) -> dict[str, dict]:
    """{'YYYY-MM': {"credits": {line: Decimal}, "debits": {line: Decimal}, "entries": int}} for every month with ledger
    activity or an expiry, straight from SQL aggregates (never row by row)."""
    out: dict[str, dict] = {}
    with _get_pool().connection() as conn:
        ledger = conn.execute(
            "SELECT to_char(date_trunc('month', created_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS month, kind,"
            " (amount >= 0) AS is_credit, sum(amount) AS total, count(*)::int AS n"
            " FROM public.wallet_transactions WHERE user_id = %s::uuid GROUP BY 1, 2, 3", (owner_id,)).fetchall()
        expired = conn.execute(
            "SELECT to_char(date_trunc('month', expires_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS month,"
            " sum(remaining) AS total FROM public.credit_grants"
            " WHERE user_id = %s::uuid AND expires_at IS NOT NULL AND expires_at <= now() AND remaining > 0"
            " GROUP BY 1", (owner_id,)).fetchall()
    for r in ledger:
        b = out.setdefault(r["month"], {**_blank_lines(), "entries": 0})
        b["entries"] += r["n"]
        total = money(r["total"])
        if r["is_credit"]:
            line = _CREDIT_LINE.get(r["kind"], "other")
            b["credits"][line] += total
        else:
            line = _DEBIT_LINE.get(r["kind"], "other")
            b["debits"][line] += -total
    for r in expired:
        b = out.setdefault(r["month"], {**_blank_lines(), "entries": 0})
        b["debits"]["expired"] += money(r["total"])
    return out


def _totals(b: dict) -> tuple[Decimal, Decimal]:
    return sum(b["credits"].values(), ZERO), sum(b["debits"].values(), ZERO)


def month_summaries(owner_id: str) -> list[dict]:
    """One row per month with activity, NEWEST first: {month, label, in_progress, opening_balance, credits, charges,
    topups, call_charges, closing_balance}. Balances are running totals, so month N's opening is month N-1's closing
    (months in between had no activity, so they change nothing)."""
    buckets = _month_buckets(owner_id)
    running = ZERO
    rows = []
    now_month = current_month()
    for month in sorted(buckets):
        b = buckets[month]
        credits, debits = _totals(b)
        opening = running
        running = running + credits - debits
        rows.append({
            "month": month, "label": month_label(month), "in_progress": month == now_month,
            "opening_balance": f2(opening), "credits": f2(credits), "charges": f2(debits),
            "topups": f2(b["credits"]["topups"]), "call_charges": f2(b["debits"]["calls"]),
            "closing_balance": f2(running),
        })
    return rows[::-1]


def _campaign_names(owner_id: str, ids: list) -> dict:
    if not ids:
        return {}
    with _get_pool().connection() as conn:
        rows = conn.execute("SELECT id, name FROM public.outbound_campaigns WHERE user_id = %s::uuid AND id = ANY(%s)",
                            (owner_id, ids)).fetchall()
    return {str(r["id"]): r["name"] for r in rows}


def _call_breakdown(owner_id: str, start: datetime, end: datetime) -> dict:
    """The month's call charges (ledger kind 'call') grouped by campaign and direction. The conversation is found by
    the ledger row's ref_id (the call id); a charge whose call row is gone counts as "other". Amounts are the
    wallet debits, so the rows add up to the statement's call-charges line by construction."""
    with _get_pool().connection() as conn:
        rows = conn.execute(
            "SELECT cc.campaign_id, coalesce(cc.direction, '') AS direction, count(*)::int AS calls,"
            " coalesce(sum(-w.amount), 0) AS amount, coalesce(sum(cc.duration_seconds), 0)::int AS seconds"
            " FROM public.wallet_transactions w"
            " LEFT JOIN LATERAL (SELECT c.campaign_id, c.direction, c.duration_seconds FROM public.conversations c"
            "   WHERE c.vapi_call_id = w.ref_id AND c.user_id = w.user_id ORDER BY c.call_time LIMIT 1) cc ON true"
            " WHERE w.user_id = %s::uuid AND w.kind = 'call' AND w.created_at >= %s AND w.created_at < %s"
            " GROUP BY 1, 2", (owner_id, start, end)).fetchall()
    names = _campaign_names(owner_id, [r["campaign_id"] for r in rows if r["campaign_id"]])
    by_campaign = []
    by_direction = {k: {"calls": 0, "minutes": 0.0, "amount": ZERO} for k in ("outbound", "inbound", "other")}
    for r in rows:
        direction = r["direction"] if r["direction"] in ("outbound", "inbound") else "other"
        if r["campaign_id"]:
            name = names.get(str(r["campaign_id"]), DELETED_CAMPAIGN)
        elif direction == "inbound":
            name = INBOUND_LABEL
        elif direction == "outbound":
            name = NO_CAMPAIGN_OUT
        else:
            name = OTHER_CALLS_LABEL
        amount = money(r["amount"])
        by_campaign.append({"name": name, "direction": direction, "calls": r["calls"],
                            "minutes": round(r["seconds"] / 60.0, 1), "amount": amount})
        d = by_direction[direction]
        d["calls"] += r["calls"]
        d["minutes"] += r["seconds"] / 60.0
        d["amount"] += amount
    by_campaign.sort(key=lambda x: (-x["amount"], x["name"]))
    return {"by_campaign": by_campaign, "by_direction": by_direction}


def _items(owner_id: str, start: datetime, end: datetime, kinds_sql: str, params: tuple = ()) -> list[dict]:
    with _get_pool().connection() as conn:
        rows = conn.execute(
            "SELECT kind, amount, description, created_at FROM public.wallet_transactions"
            f" WHERE user_id = %s::uuid AND created_at >= %s AND created_at < %s AND {kinds_sql}"
            " ORDER BY created_at, id LIMIT %s", (owner_id, start, end, *params, MAX_ITEMS + 1)).fetchall()
    return [{"date": r["created_at"].astimezone(UTC).date().isoformat(), "kind": r["kind"],
             "description": (r["description"] or "").strip(), "amount": money(r["amount"])} for r in rows]


def build_statement(owner_id: str, month: str) -> dict | None:
    """The full statement data for one month, or None when the account has no activity in it (-> 404).
    Raises ValueError for a malformed month."""
    start, end = parse_month(month)
    rows = {r["month"]: r for r in month_summaries(owner_id)}
    if month not in rows:
        return None
    buckets = _month_buckets(owner_id)
    b = buckets[month]
    credits, debits = _totals(b)
    opening = money(rows[month]["opening_balance"])
    closing = opening + credits - debits

    breakdown = _call_breakdown(owner_id, start, end)
    credit_items = _items(owner_id, start, end, "amount > 0")
    phone_items = _items(owner_id, start, end, "kind = 'phone' AND amount < 0")
    adj_items = _items(owner_id, start, end, "kind NOT IN ('call', 'phone') AND amount < 0")
    in_progress = month == current_month()
    return {
        "month": month, "label": month_label(month), "in_progress": in_progress,
        "period_start": start.date().isoformat(),
        "period_end": (end.date().fromordinal(end.date().toordinal() - 1)).isoformat(),
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "opening_balance": opening, "closing_balance": closing,
        "credits": {**b["credits"], "total": credits}, "debits": {**b["debits"], "total": debits},
        "calls": breakdown, "total_calls": sum(d["calls"] for d in breakdown["by_direction"].values()),
        "credit_items": credit_items[:MAX_ITEMS], "phone_items": phone_items[:MAX_ITEMS],
        "debit_adjustment_items": adj_items[:MAX_ITEMS],
        "items_truncated": any(len(x) > MAX_ITEMS for x in (credit_items, phone_items, adj_items)),
    }


def statement_json(st: dict) -> dict:
    """JSON-safe copy of build_statement's result (Decimals -> 2-decimals floats)."""
    def conv(v):
        if isinstance(v, Decimal):
            return f2(v)
        if isinstance(v, dict):
            return {k: conv(x) for k, x in v.items()}
        if isinstance(v, list):
            return [conv(x) for x in v]
        return v
    return conv(st)


# ------------------------------------------------------------------------------------------------ receipts

def build_receipt(owner_id: str, transaction_id: str) -> dict | None:
    """One top-up payment of THIS account, or None (unknown id, another account's, not a top-up, or not a UUID).
    Only `topup` rows qualify: they are the payments the customer made."""
    try:
        txn = str(uuid.UUID(str(transaction_id)))
    except (ValueError, AttributeError):
        return None
    with _get_pool().connection() as conn:
        r = conn.execute(
            "SELECT id, amount, balance_after, description, stripe_session_id, created_at"
            " FROM public.wallet_transactions"
            " WHERE id = %s::uuid AND user_id = %s::uuid AND kind = 'topup' AND amount > 0", (txn, owner_id)).fetchone()
    if not r:
        return None
    auto = "auto" in (r["description"] or "").lower()
    return {
        "id": str(r["id"]), "reference": str(r["id"]).split("-")[0].upper(),
        "date": r["created_at"].astimezone(UTC), "amount": money(r["amount"]),
        "balance_after": money(r["balance_after"]) if r["balance_after"] is not None else None,
        "description": (r["description"] or "Added funds to balance").strip(),
        "payment_reference": r["stripe_session_id"], "automatic": auto,
    }
