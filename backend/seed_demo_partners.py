"""Demo data for the referral partner system, so the admin Partners page and the Partner Portal have something to show.

    python seed_demo_partners.py            add the demo partners (refuses if they are already there)
    python seed_demo_partners.py --reset    remove them, then add them again (fresh timestamps)
    python seed_demo_partners.py --remove   remove every demo row and nothing else

Runs against the database in DATABASE_URL (backend/.env or ../.env). Everything it creates is recognisable by the
e-mail domain DEMO_DOMAIN, and --remove deletes by that domain only, so real accounts are never touched. The demo
accounts are pre-verified; the partner logins use DEMO_PASSWORD (test value for this local app only).

What you get (5 partners, 14 referred accounts, ~300 calls over the last 4 weeks, a few of them minutes old so the
live feed has something fresh):
  Northwind Media     20% of profit        busiest, 5 referrals
  Brightline Agency   15% of profit        4 referrals
  Orbit Leads         $10 per verified     3 referrals, one still unverified (so a fixed bounty is visible)
  Kestrel Consulting  25% of profit        PAUSED, 2 referrals (earned history, no new signups)
  Pine & Co           10% of profit        brand new, no signups yet (the empty state)
Each partner that has earned something also gets payments (part paid, fully paid, and one voided entry) so the
"Paid" / "Still owed" figures and the payment history have something to show.
Call money follows the product's own pricing: charge = provider cost x 3.00 (routers/billing.py), so the profit
delta is real arithmetic, not invented numbers. Calls use contact "Demo Contact" (not "[SAMPLE]", which the partner
reports deliberately leave out).
"""
import random
import sys
from datetime import datetime, timedelta, timezone

from db_pg import _get_pool
from routers.auth import _hash_password, _provision_user_rows
from routers.billing import credit_balance

DEMO_DOMAIN = "demo-partners.test"
DEMO_PASSWORD = "DemoPass!234"  # partner logins: <slug>@demo-partners.test
MULTIPLIER = 3.00               # billing.DEFAULT_COST_MULTIPLIER
NOW = datetime.now(timezone.utc)

# slug, name, commission_type, commission_value, status, notes, [(full name, email local part, days since signup, verified, calls, topup $)]
PARTNERS = [
    ("northwind", "Northwind Media", "percent", 20, "active", "Largest affiliate. Agency newsletter + webinars.", [
        ("Dana Whitfield", "dana.whitfield", 26, True, 58, 100),
        ("Marcus Lee", "marcus.lee", 21, True, 41, 100),
        ("Priya Nair", "priya.nair", 14, True, 33, 50),
        ("Tom Alvarez", "tom.alvarez", 6, True, 12, 25),
        ("Sofia Brandt", "sofia.brandt", 1, False, 0, 0),
    ]),
    ("brightline", "Brightline Agency", "percent", 15, "active", "Referral from the Q3 partner call.", [
        ("Chen Wei", "chen.wei", 19, True, 37, 100),
        ("Aisha Khan", "aisha.khan", 11, True, 24, 50),
        ("Liam O'Connor", "liam.oconnor", 5, True, 9, 25),
        ("Rosa Mendes", "rosa.mendes", 2, False, 0, 0),
    ]),
    ("orbit", "Orbit Leads", "fixed", 10, "active", "Pays per verified signup. Review after 30 days.", [
        ("Noah Fischer", "noah.fischer", 16, True, 22, 50),
        ("Elena Petrova", "elena.petrova", 8, True, 6, 25),
        ("Jamal Brooks", "jamal.brooks", 3, False, 0, 0),
    ]),
    ("kestrel", "Kestrel Consulting", "percent", 25, "paused", "Paused while we renegotiate the rate.", [
        ("Grace Holloway", "grace.holloway", 24, True, 19, 50),
        ("Victor Hale", "victor.hale", 20, True, 11, 25),
    ]),
    ("pine", "Pine & Co", "percent", 10, "active", "Onboarded this week.", []),
]


def _email(local: str) -> str:
    return f"{local}@{DEMO_DOMAIN}"


def remove() -> None:
    """Delete every demo account, call, partner and attribution (matched by DEMO_DOMAIN only)."""
    like = f"%@{DEMO_DOMAIN}"
    with _get_pool().connection() as conn:
        ids = [r["id"] for r in conn.execute("SELECT id FROM users WHERE email LIKE %s", (like,)).fetchall()]
        if ids:
            # Explicit first, though the user-owned tables cascade, so a missing FK can never leave orphans.
            for table in ("conversations", "wallet_transactions", "ai_agents"):
                conn.execute(f"DELETE FROM {table} WHERE user_id = ANY(%s::uuid[])", (ids,))
        # The payment ledger is RESTRICTed (a partner with payments cannot be deleted), so it goes first.
        conn.execute("DELETE FROM partner_payouts WHERE partner_id IN (SELECT id FROM referral_partners WHERE email LIKE %s)", (like,))
        conn.execute("DELETE FROM referral_partners WHERE email LIKE %s", (like,))  # cascades partner_referrals
        conn.execute("DELETE FROM users WHERE email LIKE %s", (like,))
    print(f"removed {len(ids)} demo account(s) and the demo partners")


def _create_user(conn, email: str, full_name: str, verified: bool, created: datetime) -> str:
    row = conn.execute(
        "INSERT INTO users (email, encrypted_password, raw_user_meta_data, email_confirmed_at, created_at)"
        " VALUES (%s, %s, %s::jsonb, %s, %s) RETURNING id",
        (email, _hash_password(DEMO_PASSWORD), '{"full_name": "%s"}' % full_name.replace('"', ""),
         created if verified else None, created)).fetchone()
    uid = str(row["id"])
    _provision_user_rows(uid, full_name)  # profile + billing rows, same as a real signup
    conn.execute("UPDATE profiles SET created_at = %s WHERE id = %s", (created, uid))
    return uid


def _calls(conn, rnd: random.Random, uid: str, signed_up: datetime, n: int) -> None:
    """n completed calls between signup and now (busier recently), priced like the product prices them."""
    span = (NOW - signed_up).total_seconds()
    rows = []
    for i in range(n):
        # Skew towards the present so the charts and the feed look alive; the last few are minutes old.
        when = NOW - timedelta(seconds=span * (rnd.random() ** 1.6)) if i >= 3 else NOW - timedelta(minutes=rnd.randint(2, 90))
        when = max(when, signed_up + timedelta(minutes=30))
        seconds = rnd.choice([0, 0, 18, 35, 52, 74, 96, 130, 188, 240]) if rnd.random() < 0.85 else rnd.randint(250, 420)
        answered = seconds > 0
        provider = round(seconds / 60 * rnd.uniform(0.09, 0.14), 4) if answered else 0.0
        charge = round(provider * MULTIPLIER, 2)
        rows.append((
            uid, "Phone", "Completed" if answered else "No Answer", when, charge, provider,
            "Demo Contact", f"+1555{rnd.randint(2000000, 9999999)}", seconds,
            rnd.choice(["outbound"] * 4 + ["inbound"]), "customer-ended-call" if answered else "customer-did-not-answer",
            answered and rnd.random() < 0.3))
    with conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO conversations (user_id, channel, status, call_time, call_cost, provider_cost, contact_name, phone,"
            " duration_seconds, direction, ended_reason, qualified) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)", rows)


# slug -> payments as (share of what is owed at seed time, days ago, method, reference). The share is of the commission
# earned, so every amount is real arithmetic on the seeded calls. A share of 0 with a reason is a voided payment.
PAYMENTS = {
    "northwind":  [(0.40, 14, "Bank transfer", "NW-0912"), (0.25, 3, "PayPal", "PP-55120")],   # part paid, the rest still owed
    "brightline": [(1.00, 8, "Wire", "BL-2210")],                                              # fully paid
    "orbit":      [(0.50, 6, "PayPal", "OR-7781")],
    "kestrel":    [(1.00, 5, "Bank transfer", "KC-0042")],                                     # paused, but paid up
}
VOIDED = {"brightline": (0.10, 20, "Bank transfer", "BL-1999", "Entered twice")}              # shown struck through to the admin


def _seed_payments(conn, made: list) -> int:
    """Payments for the demo partners, from what each has earned (partner_totals), plus one voided entry."""
    from services.partners import partner_totals
    totals = partner_totals([{"id": pid, "commission_type": ct, "commission_value": cv} for _s, pid, ct, cv in made])
    count = 0
    for slug, pid, _ct, _cv in made:
        earned = totals[pid]["commission"]
        for share, days, method, ref in PAYMENTS.get(slug, []):
            amount = round(earned * share, 2)
            if amount <= 0:
                continue
            when = NOW - timedelta(days=days)
            conn.execute(
                "INSERT INTO partner_payouts (partner_id, amount, paid_on, method, reference, created_by, created_at)"
                " VALUES (%s,%s,%s,%s,%s,'demo-admin',%s)", (pid, amount, when.date(), method, ref, when))
            count += 1
        if slug in VOIDED:
            share, days, method, ref, reason = VOIDED[slug]
            amount = round(earned * share, 2)
            if amount > 0:
                when = NOW - timedelta(days=days)
                conn.execute(
                    "INSERT INTO partner_payouts (partner_id, amount, paid_on, method, reference, created_by, created_at,"
                    " status, voided_at, voided_by, void_reason) VALUES (%s,%s,%s,%s,%s,'demo-admin',%s,'void',%s,'demo-admin',%s)",
                    (pid, amount, when.date(), method, ref, when, when + timedelta(hours=2), reason))
                count += 1
    return count


def seed() -> None:
    with _get_pool().connection() as conn:
        if conn.execute("SELECT 1 FROM referral_partners WHERE email LIKE %s LIMIT 1", (f"%@{DEMO_DOMAIN}",)).fetchone():
            sys.exit("Demo partners already exist. Use --reset to recreate them, or --remove to delete them.")
        rnd = random.Random(2026)
        users = calls = 0
        made = []  # (slug, partner id, commission type, value) for the payments below
        for slug, name, ctype, cvalue, status, notes, referred in PARTNERS:
            created = NOW - timedelta(days=30)
            puid = _create_user(conn, _email(slug), name, True, created)
            credit_balance(puid, 20, "admin", "Demo credit")  # keeps the 'credit is used up' banner off the demo partner's pages
            code = "".join(rnd.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(8))
            pid = str(conn.execute(
                "INSERT INTO referral_partners (user_id, name, email, code, status, commission_type, commission_value, notes, created_at)"
                " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id",
                (puid, name, _email(slug), code, status, ctype, cvalue, notes, created)).fetchone()["id"])
            made.append((slug, pid, ctype, cvalue))
            for full_name, local, days, verified, n_calls, topup in referred:
                signed_up = NOW - timedelta(days=days, hours=rnd.randint(0, 6))
                uid = _create_user(conn, _email(local), full_name, verified, signed_up)
                conn.execute(
                    "INSERT INTO partner_referrals (partner_id, user_id, status, created_at, verified_at) VALUES (%s,%s,%s,%s,%s)",
                    (pid, uid, "verified" if verified else "pending", signed_up,
                     signed_up + timedelta(minutes=rnd.randint(2, 40)) if verified else None))
                if topup:
                    conn.execute("INSERT INTO wallet_transactions (user_id, kind, amount, description, created_at)"
                                 " VALUES (%s,'topup',%s,'Wallet top-up',%s)", (uid, topup, signed_up + timedelta(hours=2)))
                if n_calls:
                    conn.execute("INSERT INTO ai_agents (user_id, name, created_at) VALUES (%s,%s,%s)",
                                 (uid, rnd.choice(["Sales Qualifier", "Appointment Setter", "Lead Follow-up", "Inbound Receptionist"]),
                                  signed_up + timedelta(hours=3)))
                    _calls(conn, rnd, uid, signed_up, n_calls)
                users += 1
                calls += n_calls
            print(f"  {name:<20} code {code}  {ctype} {cvalue}  {status}  ({len(referred)} referred)")
        payments = _seed_payments(conn, made)
        print(f"seeded {len(PARTNERS)} partners, {users} referred accounts, {calls} calls, {payments} payments")


if __name__ == "__main__":
    arg = sys.argv[1] if len(sys.argv) > 1 else ""
    if arg == "--remove":
        remove()
    elif arg == "--reset":
        remove()
        seed()
    elif arg == "":
        seed()
    else:
        sys.exit(__doc__)
