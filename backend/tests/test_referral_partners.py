"""
Referral partners (routers/partners.py, services/partners.py, the partner hooks in routers/auth.py).

Covered: the admin creating a partner (own login, unique code, custom code, collisions, validation, linking an existing
account), attribution at registration and the pending -> verified flip, a paused partner attributing nobody, the money
(billed / platform cost / profit / percent and fixed commission / net profit, [SAMPLE] rows left out), what a partner may
and may not see (no platform cost or profit, only their own accounts), partner impersonation (own referrals only, 2h
tagged token, refused while paused), the live activity feed and its scoping, and the admin auth gate. Payouts: the ledger of payments, paid vs still owed. Reports: commission by day/week/month/year
and custom range (time zones, period boundaries, periods adding up to the lifetime totals, what a partner may see, CSV).
Financials: the platform's summary (billed / cost / profit / commission earned, paid, owed / what it keeps) by period and partner.

Run from the backend folder:  python -m unittest discover -s tests -p "test_referral_partners.py" -v
"""
import time
import unittest
import uuid
from datetime import date

import qa_harness as h
from qa_harness import client, auth
from jose import jwt
from config import settings
from database import supabase
from services import partner_financials as pf


def setUpModule():
    # The dev .env may have reCAPTCHA configured; sign-ups in these tests carry no widget token.
    global _recaptcha
    _recaptcha = settings.recaptcha_secret_key
    settings.recaptcha_secret_key = ""


def tearDownModule():
    settings.recaptcha_secret_key = _recaptcha


def admin_headers():
    now = int(time.time())
    tok = jwt.encode({"sub": "qa-admin", "adm": True, "iat": now, "exp": now + 3600}, settings.active_jwt_secret, algorithm="HS256")
    return {"X-Admin-Auth": tok}


def email(prefix="p"):
    return f"{prefix}-{uuid.uuid4().hex[:8]}@qa.test"


def create_partner(**kw):
    body = {"name": "Pat Partner", "email": email(), "password": "secret123", "commission_type": "percent", "commission_value": 20, **kw}
    r = client.post("/admin/partners", json=body, headers=admin_headers())
    assert r.status_code == 200, r.text
    return r.json()["data"], body


def register(code, who=None):
    """Register a new account through a referral code; returns (user_id, verification token)."""
    e = who or email("ref")
    r = client.post("/auth/register", json={"email": e, "password": "secret123", "referral_code": code})
    assert r.status_code == 200, r.text
    uid = h.sql("select id::text from users where email=%s", (e,))[0][0]
    tok = h.sql("select token from email_verification_tokens where user_id=%s", (uid,))[0][0]
    return uid, tok


def verify(tok):
    r = client.post("/auth/verify-email", json={"token": tok})
    assert r.status_code == 200, r.text


def login_headers(email_, pw="secret123"):
    r = client.post("/auth/login", json={"email": email_, "password": pw})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['data']['access_token']}"}


def call(user, billed, cost, contact="Sam", status="Completed", seconds=60):
    return h.sql(
        "insert into conversations (user_id, channel, status, call_cost, provider_cost, contact_name, duration_seconds, direction)"
        " values (%s,'Phone',%s,%s,%s,%s,%s,'outbound') returning id", (user, status, billed, cost, contact, seconds))[0][0]


class CreatePartner(unittest.TestCase):
    def setUp(self):
        h.reset_rate_limits()

    def test_create_makes_login_code_and_link(self):
        p, body = create_partner(name="Acme Affiliates")
        self.assertEqual(len(p["code"]), 8)
        self.assertEqual(p["referral_path"], f"/register?ref={p['code']}")
        self.assertEqual(p["status"], "active")
        self.assertEqual(p["commission_label"], "20% of profit")
        self.assertEqual(p["totals"]["signups"], 0)
        # the partner can sign in straight away (pre-verified) and is recognised as a partner
        me = client.get("/partner/me", headers=login_headers(body["email"]))
        self.assertEqual(me.json()["data"]["is_partner"], True)
        self.assertEqual(me.json()["data"]["partner"]["code"], p["code"])

    def test_custom_code_is_uppercased_and_must_be_unique(self):
        code = "AB" + uuid.uuid4().hex[:6].upper()
        p, _ = create_partner(code=code.lower())
        self.assertEqual(p["code"], code)
        r = client.post("/admin/partners", json={"name": "X", "email": email(), "password": "secret123", "code": code}, headers=admin_headers())
        self.assertEqual(r.status_code, 409)

    def test_code_cannot_equal_a_users_own_referral_code(self):
        uid = h.make_user()
        supabase.table("profiles").insert({"id": uid, "referral_code": "USERCODE9"}).execute()
        r = client.post("/admin/partners", json={"name": "X", "email": email(), "password": "secret123", "code": "usercode9"}, headers=admin_headers())
        self.assertEqual(r.status_code, 409)

    def test_validation(self):
        def post(**kw):
            body = {"name": "X", "email": email(), "password": "secret123", **kw}
            return client.post("/admin/partners", json=body, headers=admin_headers())
        self.assertEqual(post(code="ab").status_code, 400)
        self.assertEqual(post(code="no spaces!").status_code, 400)
        self.assertEqual(post(commission_type="bogus").status_code, 400)
        self.assertEqual(post(commission_value=-1).status_code, 400)
        self.assertEqual(post(commission_type="percent", commission_value=101).status_code, 400)
        self.assertEqual(post(commission_type="fixed", commission_value=10001).status_code, 400)
        self.assertEqual(post(name="  ").status_code, 400)
        self.assertEqual(post(password=None).status_code, 400)  # new account needs a password

    def test_links_an_existing_account_once(self):
        e = email("existing")
        client.post("/auth/register", json={"email": e, "password": "secret123"})
        r = client.post("/admin/partners", json={"name": "Old Hand", "email": e}, headers=admin_headers())
        self.assertEqual(r.status_code, 200, r.text)
        again = client.post("/admin/partners", json={"name": "Old Hand", "email": e}, headers=admin_headers())
        self.assertEqual(again.status_code, 409)

    def test_update_commission_status_and_validation(self):
        p, _ = create_partner()
        r = client.patch(f"/admin/partners/{p['id']}", json={"commission_type": "fixed", "commission_value": 7.5, "status": "paused"}, headers=admin_headers())
        d = r.json()["data"]
        self.assertEqual((d["commission_type"], d["commission_value"], d["status"]), ("fixed", 7.5, "paused"))
        self.assertEqual(d["commission_label"], "$7.50 per verified signup")
        bad = client.patch(f"/admin/partners/{p['id']}", json={"status": "gone"}, headers=admin_headers())
        self.assertEqual(bad.status_code, 400)
        # switching to percent keeps the (now too large) old value out
        bad2 = client.patch(f"/admin/partners/{p['id']}", json={"commission_type": "percent", "commission_value": 150}, headers=admin_headers())
        self.assertEqual(bad2.status_code, 400)
        self.assertEqual(client.patch(f"/admin/partners/{uuid.uuid4()}", json={"name": "x"}, headers=admin_headers()).status_code, 404)
        self.assertEqual(client.get("/admin/partners/not-a-uuid", headers=admin_headers()).status_code, 404)

    def test_admin_gate(self):
        self.assertEqual(client.get("/admin/partners").status_code, 401)
        user = h.make_user()
        self.assertEqual(client.get("/admin/partners", headers={"X-Admin-Auth": h.token_for(user)}).status_code, 403)


class Attribution(unittest.TestCase):
    def setUp(self):
        h.reset_rate_limits()

    def test_signup_is_attributed_then_verified(self):
        p, _ = create_partner()
        uid, tok = register(p["code"].lower())  # the code is case-insensitive
        row = h.sql("select status from partner_referrals where user_id=%s", (uid,))
        self.assertEqual(row[0][0], "pending")
        verify(tok)
        self.assertEqual(h.sql("select status, verified_at is not null from partner_referrals where user_id=%s", (uid,))[0], ("verified", True))

    def test_paused_partner_attributes_nobody(self):
        p, _ = create_partner()
        client.patch(f"/admin/partners/{p['id']}", json={"status": "paused"}, headers=admin_headers())
        uid, _tok = register(p["code"])
        self.assertEqual(h.sql("select count(*) from partner_referrals where user_id=%s", (uid,))[0][0], 0)

    def test_unknown_code_still_registers(self):
        uid, _ = register("NOSUCHCODE")
        self.assertEqual(h.sql("select count(*) from partner_referrals where user_id=%s", (uid,))[0][0], 0)

    def test_user_to_user_referrals_still_work(self):
        referrer = h.make_user()
        supabase.table("profiles").insert({"id": referrer, "referral_code": "FRIEND42"}).execute()
        uid, _ = register("friend42")
        self.assertEqual(h.sql("select count(*) from referrals where referee_id=%s", (uid,))[0][0], 1)
        self.assertEqual(h.sql("select count(*) from partner_referrals where user_id=%s", (uid,))[0][0], 0)


class Money(unittest.TestCase):
    """Partner with two verified signups and one pending one; known calls."""

    def setUp(self):
        h.reset_rate_limits()
        self.p, self.body = create_partner(commission_type="percent", commission_value=20)
        self.a, ta = register(self.p["code"])
        self.b, tb = register(self.p["code"])
        self.c, _ = register(self.p["code"])  # never verifies
        verify(ta)
        verify(tb)
        call(self.a, 1.00, 0.30)
        call(self.a, 2.00, 0.70)
        call(self.b, 0.50, 0.10)
        call(self.a, 9.00, 0.00, contact="[SAMPLE] Demo")  # demo row: ignored
        outsider = h.make_user()
        call(outsider, 50, 5)  # someone else's usage: ignored

    def detail(self):
        return client.get(f"/admin/partners/{self.p['id']}", headers=admin_headers()).json()["data"]

    def test_billed_cost_profit_and_percent_commission(self):
        t = self.detail()["totals"]
        self.assertEqual((t["signups"], t["verified"], t["calls"]), (3, 2, 3))
        self.assertEqual((t["billed"], t["platform_cost"], t["profit"]), (3.50, 1.10, 2.40))
        self.assertEqual(t["commission"], 0.48)      # 20% of 2.40
        self.assertEqual(t["net_profit"], 1.92)      # what the platform keeps

    def test_fixed_commission_counts_verified_signups_only(self):
        client.patch(f"/admin/partners/{self.p['id']}", json={"commission_type": "fixed", "commission_value": 5}, headers=admin_headers())
        t = self.detail()["totals"]
        self.assertEqual(t["commission"], 10.0)      # 2 verified x $5, the pending one does not count
        self.assertEqual(t["net_profit"], round(2.40 - 10.0, 2))

    def test_loss_never_gives_negative_percent_commission(self):
        call(self.b, 1.00, 4.00)                      # a loss-making call
        client.patch(f"/admin/partners/{self.p['id']}", json={"commission_value": 50}, headers=admin_headers())
        t = self.detail()["totals"]
        self.assertEqual(t["profit"], round(2.40 - 3.00, 2))
        self.assertEqual(t["commission"], 0.0)

    def test_per_signup_rows_carry_cost_and_profit_for_admin(self):
        rows = {s["user_id"]: s for s in self.detail()["signups"]}
        self.assertEqual((rows[self.a]["billed"], rows[self.a]["platform_cost"], rows[self.a]["profit"]), (3.0, 1.0, 2.0))
        self.assertEqual(rows[self.c]["status"], "pending")
        self.assertEqual(rows[self.c]["calls"], 0)

    def test_list_has_grand_totals(self):
        d = client.get("/admin/partners", headers=admin_headers()).json()["data"]
        mine = next(x for x in d["partners"] if x["id"] == self.p["id"])
        self.assertEqual(mine["totals"]["profit"], 2.40)
        self.assertGreaterEqual(d["totals"]["billed"], 3.50)
        self.assertGreaterEqual(d["totals"]["signups"], 3)


class PartnerSide(unittest.TestCase):
    def setUp(self):
        h.reset_rate_limits()
        self.p, self.body = create_partner(commission_value=10)
        self.hdr = login_headers(self.body["email"])
        self.u, tok = register(self.p["code"])
        verify(tok)
        call(self.u, 4.00, 1.00)
        # a second partner with their own user
        self.q, self.qbody = create_partner()
        self.v, _ = register(self.q["code"])

    def test_non_partner_is_refused_and_me_says_so(self):
        user = h.make_user()
        self.assertEqual(client.get("/partner/me", headers=auth(user)).json()["data"], {"is_partner": False, "partner": None})
        for path in ("/partner/overview", "/partner/activity"):
            self.assertEqual(client.get(path, headers=auth(user)).status_code, 403)
        self.assertEqual(client.post(f"/partner/users/{self.u}/impersonate", headers=auth(user)).status_code, 403)
        self.assertIn(client.get("/partner/overview").status_code, (401, 403))  # no token at all

    def test_overview_shows_own_signups_and_hides_platform_money(self):
        d = client.get("/partner/overview", headers=self.hdr).json()["data"]
        self.assertEqual([s["user_id"] for s in d["signups"]], [self.u])
        self.assertEqual(d["totals"], {"signups": 1, "verified": 1, "calls": 1, "billed": 4.0, "commission": 0.3,  # 10% of 3.00
                                       "paid": 0.0, "owed": 0.3})
        self.assertNotIn("platform_cost", d["signups"][0])
        self.assertNotIn("profit", d["signups"][0])
        self.assertNotIn("platform_cost", d["totals"])
        self.assertNotIn("net_profit", d["totals"])
        self.assertEqual(d["signups"][0]["email"], h.sql("select email from users where id=%s", (self.u,))[0][0])

    def test_partner_never_sees_the_admins_private_notes_or_other_internals(self):
        client.patch(f"/admin/partners/{self.p['id']}", json={"notes": "difficult, cap payout"}, headers=admin_headers())
        self.assertEqual(client.get(f"/admin/partners/{self.p['id']}", headers=admin_headers()).json()["data"]["notes"], "difficult, cap payout")
        for path in ("/partner/me", "/partner/overview"):
            body = client.get(path, headers=self.hdr).text
            self.assertNotIn("difficult", body, path)
            self.assertNotIn('"notes"', body, path)
            for hidden in ("platform_cost", "net_profit", "provider_cost"):
                self.assertNotIn(hidden, body, path)

    def test_impersonate_own_referral(self):
        r = client.post(f"/partner/users/{self.u}/impersonate", headers=self.hdr)
        self.assertEqual(r.status_code, 200, r.text)
        token = r.json()["data"]["access_token"]
        claims = jwt.decode(token, settings.active_jwt_secret, algorithms=["HS256"], options={"verify_aud": False})
        self.assertEqual(claims["sub"], self.u)
        self.assertTrue(claims["imp"])
        self.assertEqual(claims["imp_by"], self.body["email"])
        self.assertLessEqual(claims["exp"] - claims["iat"], 7200)
        # the token really is that user's session
        me = client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
        self.assertEqual(me.json()["data"]["id"], self.u)

    def test_cannot_impersonate_other_partners_users_or_strangers(self):
        self.assertEqual(client.post(f"/partner/users/{self.v}/impersonate", headers=self.hdr).status_code, 404)
        self.assertEqual(client.post(f"/partner/users/{h.make_user()}/impersonate", headers=self.hdr).status_code, 404)
        self.assertEqual(client.post("/partner/users/not-a-uuid/impersonate", headers=self.hdr).status_code, 404)

    def test_paused_partner_cannot_impersonate_but_still_sees_data(self):
        client.patch(f"/admin/partners/{self.p['id']}", json={"status": "paused"}, headers=admin_headers())
        self.assertEqual(client.post(f"/partner/users/{self.u}/impersonate", headers=self.hdr).status_code, 403)
        self.assertEqual(client.get("/partner/overview", headers=self.hdr).status_code, 200)

    def test_activity_feed_is_scoped_and_ordered(self):
        h.sql("insert into ai_agents (user_id, name) values (%s, 'Helper Bot')", (self.u,))
        feed = client.get("/partner/activity", headers=self.hdr).json()["data"]
        kinds = [i["kind"] for i in feed]
        for k in ("signup", "verified", "agent", "call"):
            self.assertIn(k, kinds)
        self.assertTrue(all(i["user_id"] == self.u for i in feed))      # nothing from the other partner's user
        ats = [i["at"] for i in feed]
        self.assertEqual(ats, sorted(ats, reverse=True))
        self.assertEqual(next(i for i in feed if i["kind"] == "agent")["detail"], "Helper Bot")
        self.assertTrue(all("phone" not in i for i in feed))
        self.assertEqual(len({i["id"] for i in feed}), len(feed))      # stable unique ids for the UI

    def test_admin_feed_covers_all_partners_or_one(self):
        both = client.get("/admin/partners/activity", headers=admin_headers()).json()["data"]
        self.assertTrue({self.u, self.v} <= {i["user_id"] for i in both})
        one = client.get(f"/admin/partners/activity?partner_id={self.q['id']}", headers=admin_headers()).json()["data"]
        self.assertEqual({i["user_id"] for i in one}, {self.v})
        self.assertEqual({i["partner_name"] for i in one}, {self.q["name"]})


class Payouts(unittest.TestCase):
    """The payment ledger: paid / still owed, partial payments, overpayment refused, void with a reason, who sees what."""

    def setUp(self):
        h.reset_rate_limits()
        self.p, self.body = create_partner(commission_type="percent", commission_value=20)
        self.hdr = login_headers(self.body["email"])
        u, tok = register(self.p["code"])
        verify(tok)
        call(u, 30.00, 10.00)               # profit 20.00 -> commission 4.00
        self.base = f"/admin/partners/{self.p['id']}"

    def totals(self):
        return client.get(self.base, headers=admin_headers()).json()["data"]["totals"]

    def pay(self, amount, **kw):
        return client.post(f"{self.base}/payouts", json={"amount": amount, **kw}, headers=admin_headers())

    def test_a_partner_starts_with_nothing_paid(self):
        t = self.totals()
        self.assertEqual((t["commission"], t["paid"], t["owed"]), (4.0, 0.0, 4.0))
        self.assertEqual(client.get(f"{self.base}/payouts", headers=admin_headers()).json()["data"]["payouts"], [])

    def test_payments_reduce_what_is_owed_and_add_up(self):
        r = self.pay(1.50, method="Bank transfer", reference="TX-1", note="first part")
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()["data"]
        self.assertEqual((d["payout"]["amount"], d["payout"]["method"], d["payout"]["reference"], d["payout"]["status"]), (1.5, "Bank transfer", "TX-1", "paid"))
        self.assertEqual((d["totals"]["paid"], d["totals"]["owed"]), (1.5, 2.5))
        self.assertEqual(self.pay(2.50).status_code, 200)
        t = self.totals()
        self.assertEqual((t["paid"], t["owed"]), (4.0, 0.0))
        rows = client.get(f"{self.base}/payouts", headers=admin_headers()).json()["data"]["payouts"]
        self.assertEqual(sorted(x["amount"] for x in rows), [1.5, 2.5])
        self.assertEqual(client.get(self.base, headers=admin_headers()).json()["data"]["payouts"], rows)

    def test_overpayment_is_refused_and_nothing_is_recorded(self):
        r = self.pay(4.01)
        self.assertEqual(r.status_code, 400)
        self.assertIn("$4.00", r.json()["detail"])
        self.assertEqual(self.totals()["paid"], 0.0)
        self.assertEqual(self.pay(4.00).status_code, 200)     # exactly what is owed is fine
        again = self.pay(0.01)
        self.assertEqual(again.status_code, 400)
        self.assertIn("Nothing is owed", again.json()["detail"])

    def test_invalid_amounts_and_dates_are_refused(self):
        for bad in (0, -5, 10_000_000):
            self.assertEqual(self.pay(bad).status_code, 400, bad)
        self.assertEqual(client.post(f"{self.base}/payouts", json={"amount": "abc"}, headers=admin_headers()).status_code, 422)
        self.assertEqual(client.post(f"{self.base}/payouts", json={}, headers=admin_headers()).status_code, 422)
        self.assertEqual(self.pay(1, paid_on="2999-01-01").status_code, 400)
        self.assertEqual(client.post(f"{self.base}/payouts", json={"amount": 1, "paid_on": "not-a-date"}, headers=admin_headers()).status_code, 422)
        self.assertEqual(self.pay(1, reference="x" * 200).status_code, 400)
        self.assertEqual(self.pay(1, note="x" * 600).status_code, 400)
        self.assertEqual(self.totals()["paid"], 0.0)

    def test_a_back_dated_payment_and_a_fractional_amount(self):
        r = self.pay(0.335, paid_on="2026-01-15")            # stored to the cent
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["data"]["payout"]["paid_on"], "2026-01-15")
        self.assertIn(r.json()["data"]["payout"]["amount"], (0.33, 0.34))

    def test_void_puts_the_amount_back_and_keeps_the_audit_trail(self):
        pid = self.pay(3.00).json()["data"]["payout"]["id"]
        self.assertEqual(self.totals()["owed"], 1.0)
        r = client.post(f"{self.base}/payouts/{pid}/void", json={"reason": "Bank rejected the transfer"}, headers=admin_headers())
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["data"]["totals"]["paid"], r.json()["data"]["totals"]["owed"]), (0.0, 4.0))
        row = client.get(f"{self.base}/payouts", headers=admin_headers()).json()["data"]["payouts"][0]
        self.assertEqual((row["status"], row["void_reason"], row["amount"]), ("void", "Bank rejected the transfer", 3.0))
        self.assertEqual(row["voided_by"], "qa-admin")
        self.assertIsNotNone(row["voided_at"])
        self.assertEqual(self.pay(4.00).status_code, 200)     # the voided amount can be paid again

    def test_void_needs_a_reason_and_works_once(self):
        pid = self.pay(1.00).json()["data"]["payout"]["id"]
        for bad in ({"reason": ""}, {"reason": "  "}, {"reason": "x"}, {"reason": "x" * 400}):
            self.assertEqual(client.post(f"{self.base}/payouts/{pid}/void", json=bad, headers=admin_headers()).status_code, 400, bad)
        self.assertEqual(client.post(f"{self.base}/payouts/{pid}/void", json={}, headers=admin_headers()).status_code, 422)
        self.assertEqual(client.post(f"{self.base}/payouts/{pid}/void", json={"reason": "duplicate"}, headers=admin_headers()).status_code, 200)
        again = client.post(f"{self.base}/payouts/{pid}/void", json={"reason": "duplicate"}, headers=admin_headers())
        self.assertEqual(again.status_code, 400)
        self.assertIn("already voided", again.json()["detail"])

    def test_a_payment_cannot_be_reached_through_another_partner(self):
        other, _ = create_partner()
        pid = self.pay(1.00).json()["data"]["payout"]["id"]
        wrong = f"/admin/partners/{other['id']}/payouts/{pid}"
        self.assertEqual(client.post(f"{wrong}/void", json={"reason": "not yours"}, headers=admin_headers()).status_code, 404)
        self.assertEqual(client.patch(wrong, json={"note": "x"}, headers=admin_headers()).status_code, 404)
        self.assertEqual(client.post(f"{self.base}/payouts/not-a-uuid/void", json={"reason": "nope"}, headers=admin_headers()).status_code, 404)
        self.assertEqual(client.post(f"{self.base}/payouts/{uuid.uuid4()}/void", json={"reason": "nope"}, headers=admin_headers()).status_code, 404)
        self.assertEqual(client.get("/admin/partners/not-a-uuid/payouts", headers=admin_headers()).status_code, 404)
        self.assertEqual(self.totals()["paid"], 1.0)

    def test_edit_changes_the_description_only(self):
        pid = self.pay(2.00, method="PayPal", reference="A1").json()["data"]["payout"]["id"]
        r = client.patch(f"{self.base}/payouts/{pid}", json={"reference": "B2", "note": "fixed typo", "amount": 99}, headers=admin_headers())
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()["data"]
        self.assertEqual((d["amount"], d["method"], d["reference"], d["note"]), (2.0, "PayPal", "B2", "fixed typo"))
        self.assertEqual(self.totals()["paid"], 2.0)
        client.post(f"{self.base}/payouts/{pid}/void", json={"reason": "wrong partner"}, headers=admin_headers())
        self.assertEqual(client.patch(f"{self.base}/payouts/{pid}", json={"note": "late"}, headers=admin_headers()).status_code, 400)

    def test_lowering_the_rate_after_paying_shows_overpaid_and_blocks_more_payments(self):
        self.pay(4.00)
        client.patch(self.base, json={"commission_value": 10}, headers=admin_headers())     # earned is now 2.00
        t = self.totals()
        self.assertEqual((t["commission"], t["paid"], t["owed"]), (2.0, 4.0, -2.0))
        self.assertEqual(self.pay(0.50).status_code, 400)

    def test_two_admins_paying_the_same_balance_at_once_only_one_wins(self):
        import threading
        results = []

        def go():
            results.append(self.pay(4.00).status_code)

        threads = [threading.Thread(target=go) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(sorted(results), [200, 400, 400, 400])
        self.assertEqual(self.totals()["paid"], 4.0)

    def test_partner_sees_paid_owed_and_history_but_not_admin_only_fields(self):
        pid = self.pay(1.00, method="Wire", reference="W-9", note="PRIVATE admin note").json()["data"]["payout"]["id"]
        gone = self.pay(1.00, reference="WRONG-ONE").json()["data"]["payout"]["id"]
        client.post(f"{self.base}/payouts/{gone}/void", json={"reason": "typed the wrong amount"}, headers=admin_headers())
        r = client.get("/partner/overview", headers=self.hdr)
        d = r.json()["data"]
        self.assertEqual((d["totals"]["commission"], d["totals"]["paid"], d["totals"]["owed"]), (4.0, 1.0, 3.0))
        self.assertEqual([x["id"] for x in d["payouts"]], [pid])                              # the voided one is not shown
        self.assertEqual(set(d["payouts"][0]), {"id", "amount", "paid_on", "method", "reference"})
        for hidden in ("PRIVATE", "WRONG-ONE", "typed the wrong", "qa-admin", "void_reason", "created_by", "platform_cost"):
            self.assertNotIn(hidden, r.text, hidden)

    def test_a_partner_never_sees_another_partners_payments(self):
        self.pay(1.00, reference="MINE-1")
        other, obody = create_partner()
        d = client.get("/partner/overview", headers=login_headers(obody["email"])).json()["data"]
        self.assertEqual((d["payouts"], d["totals"]["paid"]), ([], 0.0))

    def test_payment_routes_are_admin_only(self):
        pid = self.pay(1.00).json()["data"]["payout"]["id"]
        for method, path, body in (
            ("get", f"{self.base}/payouts", None), ("post", f"{self.base}/payouts", {"amount": 1}),
            ("patch", f"{self.base}/payouts/{pid}", {"note": "x"}), ("post", f"{self.base}/payouts/{pid}/void", {"reason": "abcd"}),
        ):
            for headers in ({}, self.hdr):                                                    # nobody, and the partner themself
                r = getattr(client, method)(path, headers=headers, **({"json": body} if body else {}))
                self.assertIn(r.status_code, (401, 403), (method, path, r.status_code))
        self.assertEqual(self.totals()["paid"], 1.0)

    def test_list_grand_totals_include_paid_and_owed(self):
        self.pay(1.00)
        d = client.get("/admin/partners", headers=admin_headers()).json()["data"]
        mine = next(x for x in d["partners"] if x["id"] == self.p["id"])
        self.assertEqual((mine["totals"]["paid"], mine["totals"]["owed"]), (1.0, 3.0))
        self.assertGreaterEqual(d["totals"]["paid"], 1.0)
        self.assertAlmostEqual(d["totals"]["owed"], round(d["totals"]["commission"] - d["totals"]["paid"], 2), places=2)

    def test_a_partner_with_payments_cannot_be_deleted_by_accident(self):
        self.pay(1.00)
        with self.assertRaises(Exception):
            h.sql("delete from referral_partners where id=%s", (self.p["id"],))
        self.assertEqual(h.sql("select count(*) from partner_payouts where partner_id=%s", (self.p["id"],))[0][0], 1)

    def test_the_database_refuses_a_zero_or_negative_payment(self):
        for amount in (0, -1):
            with self.assertRaises(Exception):
                h.sql("insert into partner_payouts (partner_id, amount) values (%s, %s)", (self.p["id"], amount))

    def test_fixed_commission_payouts_follow_the_verified_count(self):
        client.patch(self.base, json={"commission_type": "fixed", "commission_value": 5}, headers=admin_headers())   # 1 verified x $5
        self.assertEqual(self.totals()["owed"], 5.0)
        self.assertEqual(self.pay(5.01).status_code, 400)
        self.assertEqual(self.pay(5.00).status_code, 200)
        _, tok = register(self.p["code"])
        verify(tok)                                                                            # a second verified signup earns $5 more
        t = self.totals()
        self.assertEqual((t["commission"], t["paid"], t["owed"]), (10.0, 5.0, 5.0))


def timed_call(user, billed, cost, when, contact="Sam"):
    return h.sql(
        "insert into conversations (user_id, channel, status, call_cost, provider_cost, contact_name, duration_seconds, direction, call_time)"
        " values (%s,'Phone','Completed',%s,%s,%s,60,'outbound',%s) returning id", (user, billed, cost, contact, when))[0][0]


def stamp(user, created=None, verified=None):
    """Put a referred account's signup / verification on known instants (UTC)."""
    if created:
        h.sql("update partner_referrals set created_at=%s where user_id=%s", (created, user))
    if verified:
        h.sql("update partner_referrals set verified_at=%s where user_id=%s", (verified, user))


class ReportPeriods(unittest.TestCase):
    """The pure date logic: where periods start and end, clipping to the range, defaults and refusals."""

    def test_weeks_run_monday_to_sunday(self):
        from datetime import date
        from services import partner_reports as pr
        self.assertEqual(pr.bucket_start(date(2026, 11, 8), "week"), date(2026, 11, 2))    # a Sunday
        self.assertEqual(pr.bucket_start(date(2026, 11, 2), "week"), date(2026, 11, 2))    # a Monday
        self.assertEqual(pr.bucket_start(date(2026, 11, 6), "month"), date(2026, 11, 1))
        self.assertEqual(pr.bucket_start(date(2026, 11, 6), "year"), date(2026, 1, 1))
        self.assertEqual(pr.next_bucket(date(2026, 12, 1), "month"), date(2027, 1, 1))     # year rollover
        self.assertEqual(pr.next_bucket(date(2026, 1, 1), "year"), date(2027, 1, 1))
        self.assertEqual(pr.next_bucket(date(2026, 12, 28), "week"), date(2027, 1, 4))

    def test_periods_are_clipped_to_the_range_and_cover_it_exactly(self):
        from datetime import date, timedelta
        from services import partner_reports as pr
        per = pr.periods(date(2026, 10, 6), date(2026, 11, 3), "week")   # Tuesday .. a Tuesday four weeks on
        self.assertEqual([(p["key"], p["start"], p["end"]) for p in per], [
            (date(2026, 10, 5), date(2026, 10, 6), date(2026, 10, 11)),
            (date(2026, 10, 12), date(2026, 10, 12), date(2026, 10, 18)),
            (date(2026, 10, 19), date(2026, 10, 19), date(2026, 10, 25)),
            (date(2026, 10, 26), date(2026, 10, 26), date(2026, 11, 1)),
            (date(2026, 11, 2), date(2026, 11, 2), date(2026, 11, 3)),
        ])
        for a, b in zip(per, per[1:]):                                    # no gap and no overlap
            self.assertEqual(b["start"], a["end"] + timedelta(days=1))
        feb = pr.periods(date(2028, 2, 1), date(2028, 3, 31), "month")    # a leap February
        self.assertEqual((feb[0]["end"], feb[1]["start"]), (date(2028, 2, 29), date(2028, 3, 1)))

    def test_defaults_are_the_last_12_weeks_12_months_5_years_30_days_including_today(self):
        from datetime import date
        from services import partner_reports as pr
        today = date(2026, 11, 6)
        self.assertEqual(pr.default_start("week", today), date(2026, 8, 17))
        self.assertEqual(pr.default_start("month", today), date(2025, 12, 1))
        self.assertEqual(pr.default_start("year", today), date(2022, 1, 1))
        self.assertEqual(pr.default_start("day", today), date(2026, 10, 8))
        self.assertEqual(len(pr.periods(pr.default_start("week", today), today, "week")), 12)
        self.assertEqual(len(pr.periods(pr.default_start("month", today), today, "month")), 12)

    def test_refused_ranges(self):
        from datetime import date
        from services import partner_reports as pr
        today = date(2026, 11, 6)
        with self.assertRaises(pr.ReportError):
            pr.resolve_range("hour", None, None, today)
        with self.assertRaises(pr.ReportError):
            pr.resolve_range("day", date(2026, 11, 7), None, today)                 # starts after today
        with self.assertRaises(pr.ReportError):
            pr.resolve_range("day", date(2026, 10, 2), date(2026, 10, 1), today)    # backwards
        with self.assertRaises(pr.ReportError):
            pr.resolve_range("day", date(2019, 12, 31), None, today)                # before reports begin
        self.assertEqual(pr.resolve_range("day", date(2026, 11, 1), date(2099, 1, 1), today), (date(2026, 11, 1), today))
        with self.assertRaises(pr.ReportError):
            pr.periods(date(2020, 1, 1), today, "day")                              # ~2,500 days


class Reports(unittest.TestCase):
    """Weekly / monthly / yearly / custom commission reports, for the admin and for the partner."""

    def setUp(self):
        h.reset_rate_limits()
        self.p, self.body = create_partner(name="Reports Partner", commission_type="percent", commission_value=20)
        self.hdr = login_headers(self.body["email"])
        self.a, ta = register(self.p["code"])
        self.b, tb = register(self.p["code"])
        verify(ta)
        verify(tb)
        stamp(self.a, "2026-09-30 10:00+00", "2026-10-01 09:00+00")     # Wed / Thu, week of Sep 28
        stamp(self.b, "2026-10-05 12:00+00", "2026-11-02 12:00+00")     # signed up in the week of Oct 5, verified in the week of Nov 2
        timed_call(self.a, 3.00, 1.00, "2026-09-28 12:00+00")           # Monday, week of Sep 28
        timed_call(self.a, 6.00, 2.00, "2026-10-04 23:30+00")           # Sunday night UTC (already Monday in Karachi)
        timed_call(self.b, 1.10, 0.30, "2026-10-20 10:00+00")           # week of Oct 19
        timed_call(self.b, 0.55, 0.10, "2026-11-02 08:00+00")           # week of Nov 2
        timed_call(self.a, 9.00, 0.00, "2026-10-21 10:00+00", contact="[SAMPLE] Demo")   # demo row: ignored
        timed_call(h.make_user(), 50, 5, "2026-10-21 10:00+00")                           # someone else's usage: ignored

    def report(self, hdr=None, path=None, **q):
        q = {"start": "2026-09-28", "end": "2026-11-06", **q}
        if path is None:
            path, q = "/admin/partners/reports", {"partner_id": self.p["id"], **q}
        return client.get(path, params=q, headers=admin_headers() if hdr is None else hdr)

    def rows(self, r):
        self.assertEqual(r.status_code, 200, r.text)
        return {x["key"]: x for x in r.json()["data"]["periods"]}

    def test_weekly_rows_count_each_thing_in_the_week_it_happened(self):
        rows = self.rows(self.report(group="week"))
        self.assertEqual(list(rows), ["2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02"])
        w = rows["2026-09-28"]
        self.assertEqual((w["signups"], w["verified"], w["calls"], w["billed"], w["platform_cost"], w["profit"]), (1, 1, 2, 9.0, 3.0, 6.0))
        self.assertEqual((w["commission"], w["net_profit"]), (1.2, 4.8))
        w = rows["2026-10-05"]
        self.assertEqual((w["signups"], w["verified"], w["calls"], w["billed"], w["commission"]), (1, 0, 0, 0.0, 0.0))
        w = rows["2026-10-19"]
        self.assertEqual((w["calls"], w["billed"], w["platform_cost"], w["profit"], w["commission"]), (1, 1.1, 0.3, 0.8, 0.16))
        w = rows["2026-11-02"]
        self.assertEqual((w["verified"], w["calls"], w["billed"], w["commission"]), (1, 1, 0.55, 0.09))
        self.assertEqual(rows["2026-10-12"]["calls"], 0)                      # a quiet week is still listed

    def test_the_time_zone_decides_which_day_and_week_a_late_night_call_belongs_to(self):
        utc = self.rows(self.report(group="week", tz="UTC"))
        self.assertEqual((utc["2026-09-28"]["calls"], utc["2026-10-05"]["calls"]), (2, 0))       # 23:30 Sunday UTC
        pk = self.rows(self.report(group="week", tz="Asia/Karachi"))                              # UTC+5: 04:30 Monday
        self.assertEqual((pk["2026-09-28"]["calls"], pk["2026-10-05"]["calls"]), (1, 1))
        self.assertEqual(pk["2026-10-05"]["billed"], 6.0)

    def test_a_call_on_the_edge_of_a_week_flips_with_the_time_zone(self):
        other, _ = create_partner(commission_value=10)
        u, t = register(other["code"])
        timed_call(u, 2.00, 1.00, "2026-11-02 07:59+00")                      # Monday in UTC, still Sunday night in Los Angeles
        q = {"partner_id": other["id"], "start": "2026-10-26", "end": "2026-11-06", "group": "week"}
        utc = {x["key"]: x for x in client.get("/admin/partners/reports", params={**q, "tz": "UTC"}, headers=admin_headers()).json()["data"]["periods"]}
        la = {x["key"]: x for x in client.get("/admin/partners/reports", params={**q, "tz": "America/Los_Angeles"}, headers=admin_headers()).json()["data"]["periods"]}
        self.assertEqual((utc["2026-10-26"]["calls"], utc["2026-11-02"]["calls"]), (0, 1))
        self.assertEqual((la["2026-10-26"]["calls"], la["2026-11-02"]["calls"]), (1, 0))

    def test_periods_add_up_to_the_lifetime_totals_for_every_grouping(self):
        life = client.get(f"/admin/partners/{self.p['id']}", headers=admin_headers()).json()["data"]["totals"]
        for group in ("day", "week", "month", "year"):
            for tz in ("UTC", "Asia/Karachi", "America/Los_Angeles"):
                d = self.report(group=group, tz=tz, start="2026-09-01").json()["data"]
                for k in ("signups", "verified", "calls", "billed", "platform_cost", "profit", "commission", "net_profit"):
                    self.assertEqual(round(sum(x[k] for x in d["periods"]), 2), life[k], f"{group}/{tz}/{k}")
                    self.assertEqual(d["total"][k], life[k], f"total {group}/{tz}/{k}")

    def test_rounding_never_makes_the_periods_drift_from_the_lifetime_total(self):
        p, body = create_partner(commission_type="percent", commission_value=10)
        u, t = register(p["code"])
        verify(t)
        for day in ("2026-10-01", "2026-10-02", "2026-10-03"):
            timed_call(u, 0.3333, 0.1111, f"{day} 12:00+00")                  # each day rounds to .33 / .11, together .9999 / .3333
        life = client.get(f"/admin/partners/{p['id']}", headers=admin_headers()).json()["data"]["totals"]
        self.assertEqual((life["billed"], life["platform_cost"]), (1.0, 0.33))
        d = client.get("/admin/partners/reports", params={"partner_id": p["id"], "group": "day", "start": "2026-09-30", "end": "2026-10-04"},
                       headers=admin_headers()).json()["data"]
        self.assertEqual((d["total"]["billed"], d["total"]["platform_cost"], d["total"]["profit"]), (1.0, 0.33, life["profit"]))
        self.assertEqual(round(sum(x["billed"] for x in d["periods"]), 2), 1.0)
        for x in (x for x in d["periods"] if x["calls"]):                   # a day with a call stays within a cent of its own rounding
            self.assertLessEqual(abs(x["billed"] - 0.33), 0.011)

    def test_a_losing_period_gives_back_commission_so_the_total_follows_the_lifetime_rule(self):
        p, body = create_partner(commission_type="percent", commission_value=20)
        u, t = register(p["code"])
        timed_call(u, 3.00, 1.00, "2026-10-05 12:00+00")                      # +2.00 profit
        timed_call(u, 1.00, 6.00, "2026-10-12 12:00+00")                      # -5.00 profit
        d = client.get("/admin/partners/reports", params={"partner_id": p["id"], "group": "week", "start": "2026-10-05", "end": "2026-10-18"},
                       headers=admin_headers()).json()["data"]
        self.assertEqual([x["commission"] for x in d["periods"]], [0.4, -0.4])
        self.assertEqual(d["total"]["commission"], 0.0)
        life = client.get(f"/admin/partners/{p['id']}", headers=admin_headers()).json()["data"]["totals"]
        self.assertEqual(life["commission"], 0.0)

    def test_a_custom_range_counts_only_what_is_inside_it(self):
        d = self.report(group="week", start="2026-10-06", end="2026-10-27").json()["data"]
        self.assertEqual((d["start"], d["end"]), ("2026-10-06", "2026-10-27"))
        self.assertEqual([(x["start"], x["end"]) for x in d["periods"]],
                         [("2026-10-06", "2026-10-11"), ("2026-10-12", "2026-10-18"), ("2026-10-19", "2026-10-25"), ("2026-10-26", "2026-10-27")])
        self.assertEqual((d["total"]["calls"], d["total"]["billed"]), (1, 1.1))                  # only the Oct 20 call
        self.assertEqual((d["total"]["signups"], d["total"]["verified"]), (0, 0))                # b signed up on Oct 5, one day before
        self.assertEqual(d["total"]["commission"], 0.16)                                          # earned inside the range only

    def test_fixed_commission_is_earned_in_the_period_a_signup_is_verified(self):
        client.patch(f"/admin/partners/{self.p['id']}", json={"commission_type": "fixed", "commission_value": 5}, headers=admin_headers())
        rows = self.rows(self.report(group="week"))
        self.assertEqual({k: v["commission"] for k, v in rows.items() if v["commission"]}, {"2026-09-28": 5.0, "2026-11-02": 5.0})
        d = self.report(group="month").json()["data"]
        self.assertEqual(d["total"]["commission"], 10.0)
        self.assertEqual(d["total"]["commission"], client.get(f"/admin/partners/{self.p['id']}", headers=admin_headers()).json()["data"]["totals"]["commission"])

    def test_admin_sees_cost_profit_and_net_profit_and_each_partner(self):
        d = self.report(group="month").json()["data"]
        self.assertTrue({"platform_cost", "profit", "net_profit"} <= set(d["periods"][0]))
        self.assertEqual(d["total"]["net_profit"], round(d["total"]["profit"] - d["total"]["commission"], 2))
        self.assertEqual([x["id"] for x in d["partners"]], [self.p["id"]])
        all_ = client.get("/admin/partners/reports", params={"group": "month", "start": "2026-09-01", "end": "2026-11-06"}, headers=admin_headers()).json()["data"]
        self.assertIn(self.p["id"], [x["id"] for x in all_["partners"]])
        self.assertGreaterEqual(all_["total"]["billed"], d["total"]["billed"])
        self.assertEqual(client.get("/admin/partners/reports", params={"partner_id": str(uuid.uuid4())}, headers=admin_headers()).status_code, 404)

    def test_a_partner_gets_their_own_numbers_and_never_cost_profit_or_net_profit(self):
        r = self.report(self.hdr, path="/partner/report", group="week")
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()["data"]
        self.assertEqual(d["commission_label"], "20% of profit")
        for row in d["periods"] + [d["total"]]:
            self.assertEqual(set(row) - {"key", "start", "end"}, {"signups", "verified", "calls", "billed", "commission"})
        for word in ("platform_cost", "profit", "net_profit", "partners"):
            self.assertNotIn(f'"{word}"', r.text)
        self.assertEqual((d["total"]["billed"], d["total"]["commission"], d["total"]["signups"], d["total"]["verified"]), (10.65, 1.45, 2, 2))

    def test_a_partner_cannot_see_another_partners_report(self):
        other, obody = create_partner(commission_value=50)
        u, t = register(other["code"])
        timed_call(u, 100.00, 10.00, "2026-10-21 10:00+00")
        mine = self.report(self.hdr, path="/partner/report", group="month", partner_id=other["id"]).json()["data"]   # the id is ignored
        self.assertEqual(mine["total"]["billed"], 10.65)
        theirs = self.report(login_headers(obody["email"]), path="/partner/report", group="month").json()["data"]
        self.assertEqual(theirs["total"]["billed"], 100.0)
        self.assertEqual(self.report(auth(h.make_user()), path="/partner/report").status_code, 403)   # not a partner
        self.assertIn(self.report({}, path="/partner/report").status_code, (401, 403))

    def test_the_admin_report_is_admin_only(self):
        self.assertIn(client.get("/admin/partners/reports").status_code, (401, 403))
        self.assertIn(client.get("/admin/partners/reports", headers=self.hdr).status_code, (401, 403))

    def test_bad_requests_are_refused_with_a_message(self):
        for q in ({"group": "hour"}, {"tz": "Mars/Olympus"}, {"tz": "../etc"}, {"start": "2026-11-05", "end": "2026-11-01"},
                  {"group": "day", "start": "2020-01-01"}, {"start": "2019-01-01"}, {"format": "xml"}):
            r = self.report(**q)
            self.assertEqual(r.status_code, 400, f"{q}: {r.text}")
            self.assertIsInstance(r.json()["detail"], str)
        self.assertEqual(self.report(start="2026-11-01", end="not-a-date").status_code, 422)

    def test_the_end_is_never_in_the_future(self):
        d = self.report(group="month", end="2099-12-31").json()["data"]
        self.assertLess(d["end"], "2099-01-01")
        self.assertEqual(d["periods"][-1]["end"], d["end"])

    def test_admin_csv(self):
        client.patch(f"/admin/partners/{self.p['id']}", json={"name": "=HYPERLINK(\"http://x\")"}, headers=admin_headers())
        r = self.report(group="month", format="csv")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.headers["content-type"].startswith("text/csv"))
        self.assertIn("attachment; filename=", r.headers["content-disposition"])
        self.assertIn(".csv", r.headers["content-disposition"])
        self.assertTrue(r.content.startswith(b"\xef\xbb\xbf"))                   # opens in Excel with the right encoding
        text = r.content.decode("utf-8-sig")
        lines = text.strip().split("\n")
        self.assertEqual(lines[0], "Period,Partner,Commission rule,Signups,Verified signups,Calls,Billed,Platform cost,Profit,Commission earned,Platform net profit")
        self.assertEqual(lines[1].split(",")[0], "2026-09-28 to 2026-09-30")
        self.assertIn("\"'=HYPERLINK(\"\"http://x\"\")\"", lines[1])             # escaped: never a bare formula
        self.assertTrue(lines[-1].startswith("Total,"))
        self.assertTrue(lines[-1].endswith(",10.65,3.40,7.25,1.45,5.80"), lines[-1])

    def test_partner_csv_has_no_cost_or_profit(self):
        r = self.report(self.hdr, path="/partner/report", group="week", format="csv")
        self.assertEqual(r.status_code, 200, r.text)
        text = r.content.decode("utf-8-sig")
        lines = text.strip().split("\n")
        self.assertEqual(lines[0], "Period,Signups,Verified signups,Calls,Billed,Commission earned")
        self.assertEqual(lines[-1], "Total,2,2,4,10.65,1.45")
        for word in ("cost", "profit", "Platform"):
            self.assertNotIn(word, text)


class Financials(unittest.TestCase):
    """The platform financial summary: billed / cost / profit / commission earned, paid and owed / what the platform keeps."""

    MONEY = ("billed", "platform_cost", "profit", "commission", "paid", "net_kept")

    def setUp(self):
        h.reset_rate_limits()
        # P1: 20% of profit. Profit 2.00 (Sep), 4.00 (Oct), 4.00 (Nov) -> commission 0.40 / 0.80 / 0.80.
        self.p, self.body = create_partner(name="Finance Partner", commission_type="percent", commission_value=20)
        self.a, ta = register(self.p["code"])
        self.b, tb = register(self.p["code"])
        verify(ta)
        verify(tb)
        timed_call(self.a, 3.00, 1.00, "2026-09-28 12:00+00")
        timed_call(self.a, 6.00, 2.00, "2026-10-15 12:00+00")
        timed_call(self.b, 5.00, 1.00, "2026-11-03 12:00+00")
        timed_call(self.a, 9.00, 0.00, "2026-10-21 10:00+00", contact="[SAMPLE] Demo")        # demo row: ignored
        timed_call(h.make_user(), 50, 5, "2026-10-21 10:00+00")                                  # someone else's usage: ignored
        self.pay(self.p, 0.40, "2026-10-01")
        self.pay(self.p, 1.00, "2026-11-04")
        # P2: $5.00 per verified signup, one signup verified on 2026-10-10, $2.00 of it paid on 2026-10-11.
        self.q, _ = create_partner(name="Fixed Partner", commission_type="fixed", commission_value=5)
        c, tc = register(self.q["code"])
        verify(tc)
        stamp(c, "2026-10-09 10:00+00", "2026-10-10 09:00+00")
        timed_call(c, 2.00, 1.00, "2026-10-12 10:00+00")
        self.pay(self.q, 2.00, "2026-10-11")

    def pay(self, partner, amount, paid_on):
        r = client.post(f"/admin/partners/{partner['id']}/payouts", json={"amount": amount, "paid_on": paid_on}, headers=admin_headers())
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["data"]["payout"]

    def summary(self, partner, group="month", start="2026-09-01", end="2026-11-06"):
        """The service result for one partner over fixed dates (UTC), so other tests' partners cannot be in it."""
        row = supabase.table("referral_partners").select("*").eq("id", partner["id"]).maybe_single().execute().data
        return pf.financial_summary([row], group=group, start=date.fromisoformat(start), end=date.fromisoformat(end), tz="UTC")

    def rows(self, partner, **kw):
        s = self.summary(partner, **kw)
        return {per["key"].isoformat(): r for per, r in zip(s["periods"], s["partners"][0]["rows"])}

    def get(self, **q):
        return client.get("/admin/partners/financials", params={"tz": "UTC", **q}, headers=admin_headers())

    def test_a_percent_partner_month_by_month(self):
        rows = self.rows(self.p)
        self.assertEqual(list(rows), ["2026-09-01", "2026-10-01", "2026-11-01"])
        self.assertEqual(rows["2026-09-01"], {"billed": 3.0, "platform_cost": 1.0, "profit": 2.0, "commission": 0.4, "paid": 0.0, "owed_start": 0.0, "owed": 0.4, "net_kept": 1.6})
        self.assertEqual(rows["2026-10-01"], {"billed": 6.0, "platform_cost": 2.0, "profit": 4.0, "commission": 0.8, "paid": 0.4, "owed_start": 0.4, "owed": 0.8, "net_kept": 3.2})
        self.assertEqual(rows["2026-11-01"], {"billed": 5.0, "platform_cost": 1.0, "profit": 4.0, "commission": 0.8, "paid": 1.0, "owed_start": 0.8, "owed": 0.6, "net_kept": 3.2})
        t = self.summary(self.p)["partners"][0]["total"]                                         # the demo row and the stranger's calls are not in it
        self.assertEqual(t, {"billed": 14.0, "platform_cost": 4.0, "profit": 10.0, "commission": 2.0, "paid": 1.4, "owed_start": 0.0, "owed": 0.6, "net_kept": 8.0})

    def test_a_fixed_partner_is_paid_on_the_day_it_was_paid(self):
        rows = self.rows(self.q)
        self.assertEqual((rows["2026-09-01"]["commission"], rows["2026-09-01"]["owed"]), (0.0, 0.0))
        self.assertEqual((rows["2026-10-01"]["commission"], rows["2026-10-01"]["paid"], rows["2026-10-01"]["owed"]), (5.0, 2.0, 3.0))
        self.assertEqual((rows["2026-11-01"]["commission"], rows["2026-11-01"]["owed_start"], rows["2026-11-01"]["owed"]), (0.0, 3.0, 3.0))

    def test_a_range_that_starts_late_opens_with_what_was_already_owed(self):
        s = self.summary(self.p, start="2026-11-01")["partners"][0]
        self.assertEqual((s["total"]["owed_start"], s["total"]["commission"], s["total"]["paid"], s["total"]["owed"]), (0.8, 0.8, 1.0, 0.6))
        s = self.summary(self.p, start="2026-10-16")["partners"][0]                              # opens after the 0.40 payment and the Oct call
        self.assertEqual((s["total"]["owed_start"], s["total"]["owed"]), (0.8, 0.6))

    def test_every_row_reconciles_and_the_balances_chain(self):
        for partner in (self.p, self.q):
            for group in ("day", "week", "month", "year"):
                s = self.summary(partner, group=group, start="2026-09-20", end="2026-11-06")["partners"][0]
                prev = s["total"]["owed_start"]
                for r in s["rows"] + [s["total"]]:
                    self.assertAlmostEqual(r["owed_start"] + r["commission"] - r["paid"], r["owed"], places=2)
                for r in s["rows"]:
                    self.assertAlmostEqual(r["owed_start"], prev, places=2)                        # one period ends where the next begins
                    prev = r["owed"]
                self.assertAlmostEqual(prev, s["total"]["owed"], places=2)
                for k in self.MONEY:
                    self.assertAlmostEqual(sum(r[k] for r in s["rows"]), s["total"][k], places=2, msg=f"{group} {k}")

    def test_a_range_ending_today_ends_with_what_is_owed_now(self):
        life = client.get(f"/admin/partners/{self.p['id']}", headers=admin_headers()).json()["data"]["totals"]
        for start in ("2020-01-01", "2026-10-16", "2026-11-05"):
            s = self.summary(self.p, group="year", start=start, end="2026-11-06")["partners"][0]
            self.assertAlmostEqual(s["total"]["owed"], life["owed"], places=2, msg=start)

    def test_paid_plus_owed_is_the_commission_earned_over_the_whole_history(self):
        d = self.get(group="year", start="2020-01-01").json()["data"]
        t = d["total"]
        self.assertEqual(t["owed_start"], 0.0)
        self.assertAlmostEqual(t["paid"] + t["owed"], t["commission"], places=2)
        for p in d["partners"]:
            self.assertAlmostEqual(p["total"]["paid"] + p["total"]["owed"], p["total"]["commission"], places=2, msg=p["name"])

    def test_the_grand_total_is_the_sum_of_the_partners_and_matches_the_partner_list(self):
        d = self.get(group="year", start="2020-01-01").json()["data"]
        listing = client.get("/admin/partners", headers=admin_headers()).json()["data"]
        self.assertEqual(len(d["partners"]), len(listing["partners"]))
        for k in self.MONEY[:5] + ("owed",):
            self.assertAlmostEqual(sum(p["total"][k] for p in d["partners"]), d["total"][k], places=2, msg=k)
            self.assertAlmostEqual(d["total"][k], listing["totals"][k], places=2, msg=k)
        self.assertAlmostEqual(d["total"]["net_kept"], listing["totals"]["net_profit"], places=2)
        for p in d["partners"]:
            lp = next(x for x in listing["partners"] if x["id"] == p["id"])
            for k in ("billed", "platform_cost", "profit", "commission", "paid", "owed"):
                self.assertAlmostEqual(p["total"][k], lp["totals"][k], places=2, msg=f"{p['name']} {k}")

    def test_the_period_rows_add_up_to_the_total_for_any_grouping(self):
        for group in ("day", "week", "month", "year"):
            d = self.get(group=group, start="2026-09-20", end="2026-11-06").json()["data"]
            for k in self.MONEY:
                self.assertAlmostEqual(sum(r[k] for r in d["periods"]), d["total"][k], places=2, msg=f"{group} {k}")
            self.assertAlmostEqual(d["total"]["owed_start"], d["periods"][0]["owed_start"], places=2)
            self.assertAlmostEqual(d["total"]["owed"], d["periods"][-1]["owed"], places=2)
            for k in self.MONEY[:5] + ("owed",):
                self.assertAlmostEqual(sum(p["total"][k] for p in d["partners"]), d["total"][k], places=2, msg=f"{group} {k}")

    def test_a_paused_partner_still_counts_for_what_it_earned(self):
        before = next(p for p in self.get(group="year", start="2020-01-01").json()["data"]["partners"] if p["id"] == self.p["id"])
        self.assertEqual(client.patch(f"/admin/partners/{self.p['id']}", json={"status": "paused"}, headers=admin_headers()).status_code, 200)
        after = next(p for p in self.get(group="year", start="2020-01-01").json()["data"]["partners"] if p["id"] == self.p["id"])
        self.assertEqual(after["status"], "paused")
        self.assertEqual(after["total"], before["total"])
        self.assertEqual(after["total"]["commission"], 2.0)

    def test_a_voided_payment_stops_counting(self):
        payout = self.pay(self.p, 0.10, "2026-11-05")
        self.assertEqual(self.summary(self.p)["partners"][0]["total"]["paid"], 1.5)
        r = client.post(f"/admin/partners/{self.p['id']}/payouts/{payout['id']}/void", json={"reason": "wrong amount"}, headers=admin_headers())
        self.assertEqual(r.status_code, 200, r.text)
        t = self.summary(self.p)["partners"][0]["total"]
        self.assertEqual((t["paid"], t["owed"]), (1.4, 0.6))

    def test_a_payment_after_the_range_is_not_in_it(self):
        s = self.summary(self.p, start="2026-09-01", end="2026-10-31")["partners"][0]["total"]  # the 1.00 of 4 Nov is later
        self.assertEqual((s["paid"], s["commission"], s["owed"]), (0.4, 1.2, 0.8))

    def test_the_endpoint_returns_the_summary_for_admins_only(self):
        d = self.get(group="month", start="2026-09-01", end="2026-11-06")
        self.assertEqual(d.status_code, 200, d.text)
        data = d.json()["data"]
        self.assertEqual((data["group"], data["tz"], data["start"], data["end"][:4]), ("month", "UTC", "2026-09-01", "2026"))
        self.assertEqual([p["key"] for p in data["periods"]][:3], ["2026-09-01", "2026-10-01", "2026-11-01"])
        mine = next(p for p in data["partners"] if p["id"] == self.p["id"])
        self.assertEqual(mine["commission_label"], "20% of profit")
        self.assertEqual(client.get("/admin/partners/financials").status_code, 401)
        user = h.make_user()
        self.assertEqual(client.get("/admin/partners/financials", headers={"X-Admin-Auth": h.token_for(user)}).status_code, 403)
        self.assertEqual(client.get("/admin/partners/financials", headers=login_headers(self.body["email"])).status_code, 401)

    def test_bad_requests_are_refused_with_a_message(self):
        for q in ({"group": "hour"}, {"tz": "Mars/Olympus"}, {"start": "2026-11-05", "end": "2026-11-01"}, {"start": "2019-01-01"},
                  {"group": "day", "start": "2020-01-01"}, {"format": "xml"}):
            r = self.get(**q)
            self.assertEqual(r.status_code, 400, f"{q}: {r.text}")
            self.assertIsInstance(r.json()["detail"], str)
        self.assertEqual(self.get(start="nope").status_code, 422)

    def test_no_partners_gives_an_empty_summary(self):
        self.assertEqual(pf.financial_summary([], group="month", start=date(2026, 10, 1), end=date(2026, 11, 6), tz="UTC")["partners"], [])
        d = pf.view(pf.financial_summary([], group="month", start=date(2026, 10, 1), end=date(2026, 11, 6), tz="UTC"))
        self.assertEqual(d["partners"], [])

    def test_csv_for_accounting(self):
        client.patch(f"/admin/partners/{self.p['id']}", json={"name": "=SUM(1)"}, headers=admin_headers())
        r = self.get(group="month", start="2026-09-01", end="2026-11-06", format="csv")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.headers["content-type"].startswith("text/csv"))
        self.assertIn("financial-summary-month-2026-09-01_to_", r.headers["content-disposition"])
        self.assertTrue(r.content.startswith(b"\xef\xbb\xbf"))
        lines = r.content.decode("utf-8-sig").strip().split("\n")
        self.assertEqual(lines[0], "Period,Partner,Commission rule,Billed,Platform cost,Gross profit,Commission earned,Commission paid,Owed at start,Owed at end,Net kept by platform")
        mine = [x for x in lines if "'=SUM(1)" in x]                                              # escaped: never a bare formula
        self.assertEqual(len(mine), 4)
        self.assertTrue(mine[0].startswith("2026-09-01 to 2026-09-30,"))
        self.assertTrue(mine[1].endswith(",6.00,2.00,4.00,0.80,0.40,0.40,0.80,3.20"), mine[1])
        self.assertTrue(mine[3].startswith("Total,") and mine[3].endswith(",14.00,4.00,10.00,2.00,1.40,0.00,0.60,8.00"), mine[3])
        self.assertTrue(lines[-1].startswith("Total,All partners,"))


class Lifecycle(unittest.TestCase):
    """Deleting accounts, odd codes, fractional commissions, the feed limit and the upgrade path of the migration."""

    def setUp(self):
        h.reset_rate_limits()

    def test_deleting_a_referred_user_removes_them_from_the_partner(self):
        p, body = create_partner()
        u, _ = register(p["code"])
        call(u, 1.00, 0.20)
        before = client.get(f"/admin/partners/{p['id']}", headers=admin_headers()).json()["data"]["totals"]
        self.assertEqual((before["signups"], before["billed"]), (1, 1.0))
        r = client.delete(f"/admin/users/{u}", headers=admin_headers())
        self.assertEqual(r.status_code, 200, r.text)
        after = client.get(f"/admin/partners/{p['id']}", headers=admin_headers()).json()["data"]
        self.assertEqual((after["totals"]["signups"], after["totals"]["billed"], after["signups"]), (0, 0.0, []))
        feed = client.get("/partner/activity", headers=login_headers(body["email"])).json()["data"]
        self.assertEqual(feed, [])

    def test_deleting_the_partners_login_keeps_the_partner_and_their_attribution(self):
        p, body = create_partner()
        partner_user = h.sql("select id::text from users where email=%s", (body["email"],))[0][0]
        u, _ = register(p["code"])
        self.assertEqual(client.delete(f"/admin/users/{partner_user}", headers=admin_headers()).status_code, 200)
        d = client.get(f"/admin/partners/{p['id']}", headers=admin_headers()).json()["data"]
        self.assertIsNone(d["user_id"])
        self.assertEqual(d["totals"]["signups"], 1)
        # and the code still attributes new signups
        register(p["code"])
        self.assertEqual(client.get(f"/admin/partners/{p['id']}", headers=admin_headers()).json()["data"]["totals"]["signups"], 2)

    def test_hostile_or_malformed_codes_never_break_signup(self):
        for code in ["'; DROP TABLE referral_partners; --", "x" * 500, "   ", "%", "ünïcode", "../../etc"]:
            uid, _ = register(code)
            self.assertEqual(h.sql("select count(*) from partner_referrals where user_id=%s", (uid,))[0][0], 0, code)
        self.assertEqual(h.sql("select count(*) from referral_partners")[0][0] >= 0, True)  # the table is still there

    def test_fractional_commissions(self):
        p, _ = create_partner(commission_type="percent", commission_value=12.5)
        u, tok = register(p["code"]); verify(tok)
        call(u, 10.00, 2.00)
        t = client.get(f"/admin/partners/{p['id']}", headers=admin_headers()).json()["data"]["totals"]
        self.assertEqual((t["profit"], t["commission"]), (8.0, 1.0))          # 12.5% of 8.00
        client.patch(f"/admin/partners/{p['id']}", json={"commission_type": "fixed", "commission_value": 2.5}, headers=admin_headers())
        u2, tok2 = register(p["code"]); verify(tok2)
        t = client.get(f"/admin/partners/{p['id']}", headers=admin_headers()).json()["data"]["totals"]
        self.assertEqual(t["commission"], 5.0)                                 # 2 verified x 2.50

    def test_zero_commission_is_allowed_and_pays_nothing(self):
        p, _ = create_partner(commission_value=0)
        u, tok = register(p["code"]); verify(tok)
        call(u, 5, 1)
        self.assertEqual(client.get(f"/admin/partners/{p['id']}", headers=admin_headers()).json()["data"]["totals"]["commission"], 0.0)

    def test_feed_is_capped_and_a_partner_with_no_users_gets_an_empty_feed(self):
        p, body = create_partner()
        self.assertEqual(client.get("/partner/activity", headers=login_headers(body["email"])).json()["data"], [])
        u, _ = register(p["code"])
        for _i in range(60):
            call(u, 0.1, 0.01)
        feed = client.get("/partner/activity", headers=login_headers(body["email"])).json()["data"]
        self.assertEqual(len(feed), 40)

    def test_partner_with_no_usage_has_zero_money_not_errors(self):
        p, _ = create_partner()
        d = client.get(f"/admin/partners/{p['id']}", headers=admin_headers()).json()["data"]
        self.assertEqual(d["totals"], {"signups": 0, "verified": 0, "calls": 0, "billed": 0.0, "platform_cost": 0.0, "profit": 0.0,
                                       "commission": 0.0, "net_profit": 0.0, "paid": 0.0, "owed": 0.0})

    def test_patch_name_and_notes_and_blank_name_rejected(self):
        p, _ = create_partner()
        r = client.patch(f"/admin/partners/{p['id']}", json={"name": "Renamed", "notes": "VIP"}, headers=admin_headers()).json()["data"]
        self.assertEqual((r["name"], r["notes"]), ("Renamed", "VIP"))
        self.assertEqual(client.patch(f"/admin/partners/{p['id']}", json={"name": "  "}, headers=admin_headers()).status_code, 400)
        self.assertEqual(client.patch(f"/admin/partners/{p['id']}", json={}, headers=admin_headers()).status_code, 200)

    def test_user_referral_page_data_is_unaffected_by_partner_signups(self):
        p, _ = create_partner()
        register(p["code"])
        user = h.make_user()
        supabase.table("profiles").insert({"id": user, "referral_code": "NORMAL77"}).execute()
        r = client.get("/referrals/me", headers=auth(user)).json()["data"]
        self.assertEqual((r["code"], r["invited_count"]), ("NORMAL77", 0))
        self.assertNotIn(p["code"], [x["referral_code"] for x in client.get("/admin/referrals", headers=admin_headers()).json()["data"]])

    def test_migration_upgrades_a_database_that_has_no_partner_tables_and_is_idempotent(self):
        import migrate
        import psycopg
        h.sql("drop table if exists partner_payouts cascade")
        h.sql("drop table if exists partner_referrals cascade")
        h.sql("drop table if exists referral_partners cascade")
        for _round in range(2):  # second pass = restart of an already-migrated server
            with psycopg.connect(h.QA_URL, autocommit=True) as conn:
                migrate._ensure_columns(conn)
            self.assertEqual(h.sql("select to_regclass('public.referral_partners') is not null and to_regclass('public.partner_referrals') is not null"
                                   " and to_regclass('public.partner_payouts') is not null")[0][0], True)
        p, _ = create_partner()
        u, _ = register(p["code"])
        self.assertEqual(h.sql("select count(*) from partner_referrals where partner_id=%s", (p["id"],))[0][0], 1)


if __name__ == "__main__":
    unittest.main()
