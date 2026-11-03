"""
Referral partners (routers/partners.py, services/partners.py, the partner hooks in routers/auth.py).

Covered: the admin creating a partner (own login, unique code, custom code, collisions, validation, linking an existing
account), attribution at registration and the pending -> verified flip, a paused partner attributing nobody, the money
(billed / platform cost / profit / percent and fixed commission / net profit, [SAMPLE] rows left out), what a partner may
and may not see (no platform cost or profit, only their own accounts), partner impersonation (own referrals only, 2h
tagged token, refused while paused), the live activity feed and its scoping, and the admin auth gate.

Run from the backend folder:  python -m unittest discover -s tests -p "test_referral_partners.py" -v
"""
import time
import unittest
import uuid

import qa_harness as h
from qa_harness import client, auth
from jose import jwt
from config import settings
from database import supabase


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
        self.assertEqual(d["totals"], {"signups": 1, "verified": 1, "calls": 1, "billed": 4.0, "commission": 0.3})  # 10% of 3.00
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
        self.assertEqual(d["totals"], {"signups": 0, "verified": 0, "calls": 0, "billed": 0.0, "platform_cost": 0.0, "profit": 0.0, "commission": 0.0, "net_profit": 0.0})

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
        h.sql("drop table if exists partner_referrals cascade")
        h.sql("drop table if exists referral_partners cascade")
        for _round in range(2):  # second pass = restart of an already-migrated server
            with psycopg.connect(h.QA_URL, autocommit=True) as conn:
                migrate._ensure_columns(conn)
            self.assertEqual(h.sql("select to_regclass('public.referral_partners') is not null and to_regclass('public.partner_referrals') is not null")[0][0], True)
        p, _ = create_partner()
        u, _ = register(p["code"])
        self.assertEqual(h.sql("select count(*) from partner_referrals where partner_id=%s", (p["id"],))[0][0], 1)


if __name__ == "__main__":
    unittest.main()
