"""
Billing documents: monthly statements and top-up receipts (services/billing_documents.py,
services/billing_pdf.py, routers/billing_documents.py).

Covered: a statement RECONCILES with the wallet ledger (opening + credits - charges = closing, month to month and
against the live wallet balance, expired credits included), the call-charge breakdown adds up to the call-charges
line, only customer-facing amounts appear (never provider cost or markup), no document calls itself a tax invoice,
months without activity / malformed months, receipts only for the account's own top-ups, tenant isolation (one account
can never download another's statement or receipt; a team member gets the owner's), the account block and hostile text in a PDF.

Run from the backend folder:  python -m unittest discover -s tests -p "test_billing_documents.py" -v
"""
import base64
import re
import unittest
import uuid
import zlib
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import qa_harness as h
from qa_harness import client, auth
from database import supabase
from routers import billing
from services import billing_documents as bd
from services import billing_pdf

UTC = timezone.utc


def at(month, day=10, hour=12):
    y, m = (int(x) for x in month.split("-"))
    return datetime(y, m, day, hour, 0, tzinfo=UTC)


def ledger(user, kind, amount, when, desc=None, ref=None, stripe=None):
    """One wallet_transactions row; returns its id."""
    return str(h.sql("insert into wallet_transactions (user_id, kind, amount, description, ref_id, stripe_session_id, created_at)"
                     " values (%s,%s,%s,%s,%s,%s,%s) returning id", (user, kind, amount, desc, ref, stripe, when))[0][0])


def pdf_text(data: bytes) -> str:
    """All the text drawn in a ReportLab PDF (streams are ASCII85 + Flate): the (...) Tj strings, joined by newlines."""
    out = []
    for m in re.finditer(rb"<<(.*?)>>\s*stream\r?\n(.*?)endstream", data, re.S):
        head, body = m.group(1), m.group(2).strip()
        try:
            if b"ASCII85" in head:
                body = base64.a85decode(body[:-2] if body.endswith(b"~>") else body)
            if b"FlateDecode" in head:
                body = zlib.decompress(body)
        except Exception:
            continue
        for t in re.finditer(rb"\(((?:\\.|[^\\)])*)\)\s*Tj", body):
            s = re.sub(rb"\\([0-7]{3}|.)", lambda x: bytes([int(x.group(1), 8)]) if len(x.group(1)) == 3 else x.group(1), t.group(1))
            out.append(s.decode("cp1252", "replace"))
    return "\n".join(out)


def money_of(text, label):
    """The $ amount on the line after `label` in the extracted text."""
    lines = text.split("\n")
    i = next(i for i, ln in enumerate(lines) if ln.strip() == label)
    return lines[i + 1].strip()


class Base(unittest.TestCase):
    """An account with three active months (Aug, Sep and Nov 2025; October has nothing) and another account.

    Aug: top-up 100, welcome promo 20, calls -12.40 (campaign "Spring", outbound -> 3 calls @ 3.00, 1 call @ 3.40 inbound)
         phone fee -3
    Sep: top-up 50 (auto recharge), refund +4, admin +5, admin -2, calls -10.00 (campaign "Spring" outbound)
    Nov: a promo grant of 6.00 expired on Nov 2 with 6.00 left; one call -1.00 with NO campaign (outbound)"""

    def setUp(self):
        h.reset_rate_limits()
        sfx = uuid.uuid4().hex[:8]
        self.user = h.make_user("doc")
        self.other = h.make_user("other")
        self.camp = h.sql("insert into outbound_campaigns (user_id, name) values (%s,'Spring Push') returning id",
                          (self.user,))[0][0]
        self.topup_aug = ledger(self.user, "topup", 100, at("2025-08", 3), "Added $100.00 to balance", stripe=f"cs_test_aug_{sfx}")
        ledger(self.user, "promo", 20, at("2025-08", 3, 13), "Welcome bonus - $20 free credits")
        for i in range(3):
            self.call(self.user, f"c-aug-{i}", 3.00, at("2025-08", 5 + i), "outbound", self.camp, 120)
        self.call(self.user, "c-aug-in", 3.40, at("2025-08", 9), "inbound", None, 60)
        ledger(self.user, "phone", -3, at("2025-08", 15), "Phone number +15550001111")
        self.topup_sep = ledger(self.user, "topup", 50, at("2025-09", 2), "Auto recharge - added $50.00", stripe=f"pi_test_sep_{sfx}")
        ledger(self.user, "refund", 4, at("2025-09", 4), "Refund")
        ledger(self.user, "admin", 5, at("2025-09", 6), "Goodwill credit")
        ledger(self.user, "admin", -2, at("2025-09", 7), "Correction")
        self.call(self.user, "c-sep-1", 10.00, at("2025-09", 12), "outbound", self.camp, 300)
        h.sql("insert into credit_grants (user_id, type, amount, remaining, expires_at, created_at)"
              " values (%s,'promo',6,6,%s,%s)", (self.user, at("2025-11", 2), at("2025-10", 1)))
        ledger(self.user, "promo_code", 6, at("2025-10", 1), "Promotion code HELLO")
        self.call(self.user, "c-nov-1", 1.00, at("2025-11", 20), "outbound", None, 30)
        # another account with its own money
        ledger(self.other, "topup", 999, at("2025-08", 4), "Added $999.00 to balance", stripe=f"cs_test_other_{sfx}")
        self.other_txn = h.sql("select id from wallet_transactions where user_id=%s", (self.other,))[0][0]

    @staticmethod
    def call(user, call_id, cost, when, direction, campaign, seconds, provider_cost=None):
        h.sql("insert into conversations (user_id, channel, status, call_time, call_cost, provider_cost, direction, campaign_id,"
              " vapi_call_id, duration_seconds, contact_name) values (%s,'Phone','Completed',%s,%s,%s,%s,%s,%s,%s,'Pat')",
              (user, when, cost, provider_cost, direction, campaign, call_id, seconds))
        ledger(user, "call", -cost, when, "Call charge", ref=call_id)

    def statements(self, user=None):
        r = client.get("/billing/statements", headers=auth(user or self.user))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["data"]

    def statement(self, month, user=None):
        r = client.get(f"/billing/statements/{month}", headers=auth(user or self.user))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["data"]

    def pdf(self, month, user=None):
        r = client.get(f"/billing/statements/{month}/pdf", headers=auth(user or self.user))
        self.assertEqual(r.status_code, 200, r.text)
        return r


class ReconciliationTests(Base):
    def test_months_with_activity_newest_first_and_skips_empty_october(self):
        months = [m["month"] for m in self.statements()]
        # October has only the promo ledger row (Oct 1), so it IS a month with activity
        self.assertEqual(months, ["2025-11", "2025-10", "2025-09", "2025-08"])

    def test_every_month_reconciles_and_chains(self):
        rows = list(reversed(self.statements()))
        for r in rows:
            self.assertAlmostEqual(r["opening_balance"] + r["credits"] - r["charges"], r["closing_balance"], places=2)
        for prev, nxt in zip(rows, rows[1:]):
            self.assertAlmostEqual(prev["closing_balance"], nxt["opening_balance"], places=2)
        self.assertEqual(rows[0]["opening_balance"], 0)

    def test_figures_match_the_ledger_independently(self):
        aug = self.statement("2025-08")
        self.assertEqual(aug["opening_balance"], 0)
        self.assertEqual(aug["credits"]["topups"], 100)
        self.assertEqual(aug["credits"]["promo"], 20)
        self.assertEqual(aug["debits"]["calls"], 12.40)
        self.assertEqual(aug["debits"]["phone"], 3)
        self.assertEqual(aug["closing_balance"], 100 + 20 - 12.40 - 3)       # 104.60
        sep = self.statement("2025-09")
        self.assertEqual(sep["opening_balance"], 104.60)
        self.assertEqual(sep["credits"], {"topups": 50, "promo": 0, "refunds": 4, "adjustments": 5, "other": 0, "total": 59})
        self.assertEqual(sep["debits"]["adjustments"], 2)
        self.assertEqual(sep["debits"]["calls"], 10)
        self.assertEqual(sep["closing_balance"], round(104.60 + 59 - 12, 2))   # 151.60

    def test_closing_equals_the_ledger_sum_minus_expired_credit(self):
        total = sum(Decimal(str(r[0])) for r in h.sql("select amount from wallet_transactions where user_id=%s", (self.user,)))
        nov = self.statement("2025-11")
        self.assertEqual(nov["debits"]["expired"], 6)
        self.assertAlmostEqual(nov["closing_balance"], float(total - 6), places=2)

    def test_closing_equals_the_live_wallet_balance_through_the_real_wallet_functions(self):
        u = h.make_user("wallet")
        billing.credit_balance(u, 10, "promo_code", "Promotion code OLD", grant_type="promo", ref_id="old")
        # that promo lot lapses before anything is spent: gone from the balance, with no ledger row of its own
        h.sql("update credit_grants set expires_at=%s where user_id=%s", (datetime.now(UTC) - timedelta(seconds=1), u))
        billing.credit_balance(u, 100, "topup", "Added $100.00 to balance", stripe_session_id=f"cs_real_{uuid.uuid4().hex}")
        billing.credit_balance(u, 20, "promo_code", "Promotion code X", grant_type="promo",
                               expires_at=datetime(2030, 1, 1, tzinfo=UTC).isoformat())
        billing.debit_balance(u, 31.37, "call", "Call charge", ref_id="real-call-1")
        billing.debit_balance(u, 3, "phone", "Phone number")
        live = billing.get_balance(u)
        rows = bd.month_summaries(u)
        self.assertEqual(rows[0]["month"], bd.current_month())
        self.assertEqual(live, 85.63)                                        # 100 + 20 - 31.37 - 3
        self.assertAlmostEqual(rows[0]["closing_balance"], live, places=2)   # 10 + 100 + 20 - 31.37 - 3 - 10 expired
        self.assertAlmostEqual(rows[0]["charges"], 31.37 + 3 + 10, places=2)

    def test_call_breakdown_adds_up_to_the_call_charges_line(self):
        for month in ("2025-08", "2025-09", "2025-11"):
            st = self.statement(month)
            self.assertAlmostEqual(sum(r["amount"] for r in st["calls"]["by_campaign"]), st["debits"]["calls"], places=2)
            self.assertAlmostEqual(sum(d["amount"] for d in st["calls"]["by_direction"].values()), st["debits"]["calls"], places=2)
        aug = self.statement("2025-08")
        names = {(r["name"], r["direction"]): r for r in aug["calls"]["by_campaign"]}
        self.assertEqual(names[("Spring Push", "outbound")]["amount"], 9.0)
        self.assertEqual(names[("Spring Push", "outbound")]["calls"], 3)
        self.assertEqual(names[("Spring Push", "outbound")]["minutes"], 6.0)
        self.assertEqual(names[("Inbound calls", "inbound")]["amount"], 3.4)
        self.assertEqual(aug["calls"]["by_direction"]["outbound"]["amount"], 9.0)
        self.assertEqual(aug["calls"]["by_direction"]["inbound"]["amount"], 3.4)
        nov = self.statement("2025-11")
        self.assertEqual(nov["calls"]["by_campaign"][0]["name"], "Outbound calls (no campaign)")

    def test_a_charge_whose_call_row_is_gone_is_counted_as_other_not_dropped(self):
        ledger(self.user, "call", -2.25, at("2025-08", 20), "Call charge", ref="vanished-call")
        aug = self.statement("2025-08")
        self.assertEqual(aug["debits"]["calls"], 14.65)
        self.assertEqual(aug["calls"]["by_direction"]["other"]["amount"], 2.25)
        self.assertAlmostEqual(sum(r["amount"] for r in aug["calls"]["by_campaign"]), 14.65, places=2)

    def test_unknown_ledger_kinds_still_add_up(self):
        ledger(self.user, "mystery", 7, at("2025-09", 20))
        ledger(self.user, "mystery", -1.5, at("2025-09", 21))
        sep = self.statement("2025-09")
        self.assertEqual(sep["credits"]["other"], 7)
        self.assertEqual(sep["debits"]["other"], 1.5)
        self.assertAlmostEqual(sep["opening_balance"] + sep["credits"]["total"] - sep["debits"]["total"], sep["closing_balance"], places=2)

    def test_sample_demo_calls_never_appear_only_ledger_rows_count(self):
        h.sql("insert into conversations (user_id, channel, status, call_time, call_cost, vapi_call_id, contact_name)"
              " values (%s,'Phone','Completed',%s,50,'sample-1','[SAMPLE] Demo')", (self.user, at("2025-08", 11)))
        self.assertEqual(self.statement("2025-08")["debits"]["calls"], 12.40)

    def test_month_edges_are_utc(self):
        ledger(self.user, "topup", 1, datetime(2025, 9, 30, 23, 59, 59, tzinfo=UTC), "late Sep")
        ledger(self.user, "topup", 2, datetime(2025, 10, 1, 0, 0, 0, tzinfo=UTC), "early Oct")
        self.assertEqual(self.statement("2025-09")["credits"]["topups"], 51)
        self.assertEqual(self.statement("2025-10")["credits"]["topups"], 2)

    def test_customer_facing_amounts_only(self):
        # a call whose provider cost (7.7777) differs from what was charged
        self.call(self.user, "c-secret", 1.23, at("2025-08", 25), "outbound", self.camp, 10, provider_cost=7.7777)
        blob = str(self.statement("2025-08")).lower() + pdf_text(self.pdf("2025-08").content).lower()
        for bad in ("7.7777", "provider", "markup", "multiplier", "vapi", "twilio", "cost_multiplier"):
            self.assertNotIn(bad, blob)


class StatementEndpointTests(Base):
    def test_pdf_is_a_pdf_with_the_right_numbers_and_headers(self):
        r = self.pdf("2025-09")
        self.assertTrue(r.content.startswith(b"%PDF"))
        self.assertEqual(r.headers["content-type"], "application/pdf")
        self.assertIn("EDM-Nexus-Statement-2025-09.pdf", r.headers["content-disposition"])
        self.assertIn("no-store", r.headers["cache-control"])
        text = pdf_text(r.content)
        self.assertIn("EDM Nexus", text)
        self.assertIn("Account statement - September 2025", text)
        self.assertEqual(money_of(text, "Opening balance"), "$104.60")
        self.assertEqual(money_of(text, "Closing balance"), "$151.60")
        self.assertIn("Spring Push", text)
        self.assertIn("Auto recharge - added $50.00", text)

    def test_same_data_gives_the_same_bytes(self):
        st = bd.build_statement(self.user, "2025-08")
        a = billing_pdf.render_statement(st, bd.billed_to(self.user))
        b = billing_pdf.render_statement(st, bd.billed_to(self.user))
        self.assertEqual(a, b)

    def test_no_document_claims_to_be_a_tax_invoice(self):
        for text in (pdf_text(self.pdf("2025-08").content),
                     pdf_text(client.get(f"/billing/receipts/{self.topup_aug}/pdf", headers=auth(self.user)).content)):
            low = text.lower()
            self.assertIn("not a tax invoice", low)
            self.assertEqual(low.count("tax invoice"), 1)           # only inside the "is not a tax invoice" sentence
            self.assertNotIn("vat", re.findall(r"\b[a-z]+\b", low))

    def test_month_without_activity_or_malformed_or_future(self):
        h.sql("delete from wallet_transactions where user_id=%s and created_at >= %s and created_at < %s",
              (self.user, at("2025-10", 1, 0), at("2025-11", 1, 0)))
        h.sql("delete from credit_grants where user_id=%s", (self.user,))
        for month in ("2025-07", "2035-01"):
            self.assertEqual(client.get(f"/billing/statements/{month}/pdf", headers=auth(self.user)).status_code, 404)
        for month in ("2025-13", "2025-1", "abcd-ef", "2025-00"):
            self.assertEqual(client.get(f"/billing/statements/{month}/pdf", headers=auth(self.user)).status_code, 400, month)
        self.assertEqual(client.get("/billing/statements/2025-10", headers=auth(self.user)).status_code, 404)

    def test_new_account_has_no_statements(self):
        self.assertEqual(self.statements(h.make_user("fresh")), [])

    def test_in_progress_month_is_flagged(self):
        u = h.make_user("now")
        billing.credit_balance(u, 25, "topup", "Added $25.00", stripe_session_id=f"cs_{uuid.uuid4().hex}")
        row = self.statements(u)[0]
        self.assertTrue(row["in_progress"])
        self.assertIn("Month to date", pdf_text(self.pdf(row["month"], u).content))


class AccessControlTests(Base):
    def test_requires_login(self):
        for path in ("/billing/statements", "/billing/statements/2025-08", "/billing/statements/2025-08/pdf",
                     f"/billing/receipts/{self.topup_aug}/pdf"):
            self.assertIn(client.get(path).status_code, (401, 403), path)

    def test_one_account_cannot_download_anothers_statement(self):
        # the other account has activity in Aug 2025 only: its Aug statement shows ITS $999, never this account's data
        other_aug = self.statement("2025-08", self.other)
        self.assertEqual(other_aug["credits"]["topups"], 999)
        self.assertEqual(other_aug["debits"]["calls"], 0)
        text = pdf_text(self.pdf("2025-08", self.other).content)
        self.assertNotIn("Spring Push", text)
        self.assertNotIn("Welcome bonus", text)
        # and a month only THIS account has is simply not there for the other one
        self.assertEqual(client.get("/billing/statements/2025-09/pdf", headers=auth(self.other)).status_code, 404)
        self.assertEqual(client.get("/billing/statements/2025-11", headers=auth(self.other)).status_code, 404)
        self.assertEqual([m["month"] for m in self.statements(self.other)], ["2025-08"])

    def test_a_receipt_of_another_account_is_not_found(self):
        r = client.get(f"/billing/receipts/{self.other_txn}/pdf", headers=auth(self.user))
        self.assertEqual(r.status_code, 404)
        r = client.get(f"/billing/receipts/{self.topup_aug}/pdf", headers=auth(self.other))
        self.assertEqual(r.status_code, 404)

    def test_no_endpoint_takes_an_account_id(self):
        r = client.get(f"/billing/statements/2025-09/pdf?user_id={self.user}&owner_id={self.user}", headers=auth(self.other))
        self.assertEqual(r.status_code, 404)

    def test_team_member_gets_the_owners_documents(self):
        member = h.make_user("member")
        supabase.table("team_members").insert({"owner_id": self.user, "member_user_id": member,
                                               "member_email": f"m-{uuid.uuid4().hex[:8]}@qa.test",
                                               "role": "viewer", "status": "Active"}).execute()
        self.assertEqual(len(self.statements(member)), 4)
        self.assertEqual(self.pdf("2025-09", member).status_code, 200)
        self.assertEqual(client.get(f"/billing/receipts/{self.topup_sep}/pdf", headers=auth(member)).status_code, 200)


class ReceiptTests(Base):
    def test_receipt_pdf_for_a_topup(self):
        r = client.get(f"/billing/receipts/{self.topup_aug}/pdf", headers=auth(self.user))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.content.startswith(b"%PDF"))
        text = pdf_text(r.content)
        ref = self.topup_aug.split("-")[0].upper()
        self.assertIn(f"Reference: {ref}", text)
        self.assertIn("Payment receipt", text)
        self.assertEqual(money_of(text, "Amount paid"), "$100.00")
        self.assertIn("cs_test_aug", text)
        self.assertIn(ref, r.headers["content-disposition"])

    def test_automatic_recharge_is_labelled(self):
        text = pdf_text(client.get(f"/billing/receipts/{self.topup_sep}/pdf", headers=auth(self.user)).content)
        self.assertIn("automatic recharge", text)

    def test_only_topups_have_receipts(self):
        promo = h.sql("select id from wallet_transactions where user_id=%s and kind='promo'", (self.user,))[0][0]
        call = h.sql("select id from wallet_transactions where user_id=%s and kind='call' limit 1", (self.user,))[0][0]
        for txn in (promo, call):
            self.assertEqual(client.get(f"/billing/receipts/{txn}/pdf", headers=auth(self.user)).status_code, 404)
        self.assertEqual(client.get("/billing/receipts/not-a-uuid/pdf", headers=auth(self.user)).status_code, 404)
        self.assertEqual(client.get(f"/billing/receipts/{uuid.uuid4()}/pdf", headers=auth(self.user)).status_code, 404)


class AccountBlockTests(Base):
    """The ACCOUNT block is just what the account already has: profile company / name and the login email."""

    def set_profile(self, user, company, name):
        h.sql("insert into profiles (id, company_name, full_name) values (%s,%s,%s)"
              " on conflict (id) do update set company_name=excluded.company_name, full_name=excluded.full_name",
              (user, company, name))

    def texts(self, user=None):
        user = user or self.user
        return (pdf_text(self.pdf("2025-08", user).content),
                pdf_text(client.get(f"/billing/receipts/{self.topup_aug}/pdf", headers=auth(user)).content))

    def test_shows_company_contact_and_login_email_only(self):
        self.set_profile(self.user, "Acme Leads LLC", "Pat Doe")
        email = h.sql("select email from users where id=%s", (self.user,))[0][0]
        for text in self.texts():
            self.assertIn("ACCOUNT", text)
            self.assertIn("Acme Leads LLC", text)
            self.assertIn("Pat Doe", text)
            self.assertIn(email, text)
            for gone in ("FROM", "not set", "Issuer", "BILLED TO", "Tax ID", "[Legal"):
                self.assertNotIn(gone, text)
            self.assertIn("EDM Nexus", text)                         # the text header, nothing invented beside it

    def test_falls_back_to_the_persons_name_then_the_email(self):
        self.set_profile(self.user, None, "Pat Doe")
        self.assertEqual(bd.billed_to(self.user)["name"], "Pat Doe")
        self.set_profile(self.user, None, None)
        b = bd.billed_to(self.user)
        self.assertEqual(b["name"], b["email"])
        self.assertEqual(b["lines"], [])

    def test_each_account_gets_its_own_block(self):
        self.set_profile(self.user, "Acme Leads LLC", None)
        self.set_profile(self.other, "Other Inc", None)
        self.assertIn("Other Inc", self.texts(self.other)[0])
        self.assertNotIn("Acme Leads LLC", self.texts(self.other)[0])

    def test_hostile_and_non_latin_names_cannot_break_the_pdf(self):
        self.set_profile(self.user, "<b>Evil</b> & Co Łódź 中文", "1 <i>Road</i>")
        flat = self.texts()[0].replace(chr(10), "")                     # markup characters are drawn as separate fragments
        self.assertIn("<b>Evil</b> & Co", flat)                      # shown literally, never interpreted as markup
        self.assertIn("1 <i>Road</i>", flat)
        self.assertIn("Lódz ??", flat)                           # accents kept where Helvetica has them, else look-alike / "?"
        self.assertEqual(billing_pdf.safe("a<b>&"), "a&lt;b&gt;&amp;")


if __name__ == "__main__":
    unittest.main()
