"""Draws the billing documents (monthly statement, top-up receipt) as PDF bytes with ReportLab.

ReportLab (BSD, pure Python plus Pillow, no system libraries) was chosen over WeasyPrint (needs Pango/Cairo, painful on
the slim Docker image and on Windows) and over headless-browser rendering (heavy). Rendering on the server means the
file is byte-for-byte the same wherever it is downloaded; `invariant=1` also removes timestamps/ids so the same data
always yields the same bytes.

Layout rules
  * Header text "EDM Nexus" only: no logo, no invented legal name/address/registration number. The only party block
    is the ACCOUNT's own details (what the customer saved under Billing > Documents).
  * Letter size, USD, English, times in UTC. Built-in Helvetica (WinAnsi): text outside it is transliterated (accents
    stripped) or shown as "?" by `safe()` so a company name can never crash or corrupt a PDF.
  * Everything user- or ledger-supplied goes through `safe()` (transliterate + XML-escape) because Paragraph parses
    markup.
  * Customer-facing amounts only: nothing here knows the provider cost or the markup.
  * No tax: the documents say so, and nothing is called a "tax invoice".
"""
import io
import unicodedata
from decimal import Decimal
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.platypus import CondPageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

BRAND = "EDM Nexus"
INK = colors.HexColor("#111827")
MUTED = colors.HexColor("#6b7280")
RULE = colors.HexColor("#d1d5db")
SHADE = colors.HexColor("#f3f4f6")
ACCENT = colors.HexColor("#1f2937")

NOT_TAX_NOTE = ("This document is a record of your prepaid balance for your own files. It is not a tax invoice and "
                "no tax is calculated on it.")


# Letters that have no decomposition (so NFKD leaves them) but a plain Latin look-alike.
_LOOKALIKE = {"Ł": "L", "ł": "l", "Đ": "D", "đ": "d", "ı": "i", "İ": "I",
              "Ħ": "H", "ħ": "h"}


def safe(text) -> str:
    """Text that is safe to hand to Paragraph: control characters dropped, anything Helvetica (cp1252) cannot draw
    transliterated to its base letter (or '?'), then XML-escaped."""
    out = []
    for ch in str(text if text is not None else ""):
        if ch in "\n\t":
            out.append(" ")
            continue
        if unicodedata.category(ch) in ("Cc", "Cf"):
            continue
        try:
            ch.encode("cp1252")
            out.append(ch)
        except UnicodeEncodeError:
            base = _LOOKALIKE.get(ch) or "".join(c for c in unicodedata.normalize("NFKD", ch) if not unicodedata.combining(c))
            try:
                base.encode("cp1252")
                out.append(base or "?")
            except UnicodeEncodeError:
                out.append("?")
    return escape("".join(out))


def usd(v, signed: bool = False) -> str:
    """$1,234.56 / -$1,234.56 (signed=True adds an explicit + for positive amounts)."""
    d = Decimal(str(v)).quantize(Decimal("0.01"))
    s = f"${abs(d):,.2f}"
    if d < 0:
        return "-" + s
    return ("+" + s) if signed and d > 0 else s


def _styles() -> dict:
    base = getSampleStyleSheet()["Normal"]
    mk = lambda name, **kw: ParagraphStyle(name, parent=base, **{"fontName": "Helvetica", "textColor": INK, **kw})
    return {
        "brand": mk("brand", fontName="Helvetica-Bold", fontSize=20, leading=24),
        "title": mk("title", fontName="Helvetica-Bold", fontSize=15, leading=19, alignment=TA_RIGHT),
        "subtitle": mk("subtitle", fontSize=10, leading=13, textColor=MUTED, alignment=TA_RIGHT),
        "h2": mk("h2", fontName="Helvetica-Bold", fontSize=11, leading=14, spaceBefore=14, spaceAfter=5),
        "label": mk("label", fontName="Helvetica-Bold", fontSize=8, leading=11, textColor=MUTED),
        "body": mk("body", fontSize=9.5, leading=12.5),
        "small": mk("small", fontSize=8, leading=10.5, textColor=MUTED),
        "right": mk("right", fontSize=9.5, leading=12.5, alignment=TA_RIGHT),
        "right_bold": mk("right_bold", fontName="Helvetica-Bold", fontSize=9.5, leading=12.5, alignment=TA_RIGHT),
        "bold": mk("bold", fontName="Helvetica-Bold", fontSize=9.5, leading=12.5),
    }


class _NumberedCanvas(rl_canvas.Canvas):
    """Canvas that prints 'Page x of y' in the footer once the page count is known."""

    footer_text = BRAND

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self._saved = []

    def showPage(self):
        self._saved.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        total = len(self._saved)
        for state in self._saved:
            self.__dict__.update(state)
            self.setFont("Helvetica", 8)
            self.setFillColor(MUTED)
            self.drawString(0.75 * inch, 0.5 * inch, self.footer_text)
            self.drawRightString(letter[0] - 0.75 * inch, 0.5 * inch, f"Page {self._pageNumber} of {total}")
            super().showPage()
        super().save()


def _canvas_for(footer: str):
    return type("Canvas", (_NumberedCanvas,), {"footer_text": footer})


def _header(st: dict, title: str, subtitle_lines: list[str]):
    right = [Paragraph(safe(title), st["title"])] + [Paragraph(safe(s), st["subtitle"]) for s in subtitle_lines]
    t = Table([[Paragraph(BRAND, st["brand"]), right]], colWidths=[3.0 * inch, 4.0 * inch])
    t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
                           ("RIGHTPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
                           ("LINEBELOW", (0, 0), (-1, 0), 1, ACCENT)]))
    return t


def _account(st: dict, customer: dict):
    """The account's own details (company, address, email, tax ID if given): the only party block on a document."""
    cells = [Paragraph("ACCOUNT", st["label"]), Paragraph(f"<b>{safe(customer['name'])}</b>", st["body"])]
    lines = list(customer["lines"])
    if customer.get("email"):
        lines.append(customer["email"])
    if customer.get("tax_id"):
        lines.append(f"Tax ID: {customer['tax_id']}")
    cells += [Paragraph(safe(ln), st["body"]) for ln in lines if ln]
    t = Table([[cells]], colWidths=[7.0 * inch])
    t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
                           ("TOPPADDING", (0, 0), (-1, -1), 12), ("BOTTOMPADDING", (0, 0), (-1, -1), 4)]))
    return t


def _grid(rows, widths, head=True, right_cols=(), extra=()):
    t = Table(rows, colWidths=widths, repeatRows=1 if head else 0)
    style = [("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("TOPPADDING", (0, 0), (-1, -1), 4),
             ("BOTTOMPADDING", (0, 0), (-1, -1), 4), ("LINEBELOW", (0, 0), (-1, -1), 0.4, RULE)]
    if head:
        style += [("BACKGROUND", (0, 0), (-1, 0), SHADE)]
    style += list(extra)
    t.setStyle(TableStyle(style))
    return t


# ---------------------------------------------------------------------------------------------------- statement

def render_statement(stmt: dict, customer: dict, compress: bool = True) -> bytes:
    """PDF bytes for build_statement()'s result (Decimal amounts). `compress=False` keeps page text searchable in
    the raw bytes, which is what the tests use."""
    st = _styles()
    buf = io.BytesIO()
    footer = f"{BRAND} - Account statement - {stmt['label']}"
    doc = SimpleDocTemplate(buf, pagesize=letter, leftMargin=0.75 * inch, rightMargin=0.75 * inch,
                            topMargin=0.7 * inch, bottomMargin=0.85 * inch, invariant=1, pageCompression=compress,
                            title=f"{BRAND} account statement {stmt['label']}", author=BRAND)
    W = [4.7 * inch, 2.3 * inch]
    sub = [f"Period: {stmt['period_start']} to {stmt['period_end']} (UTC)", "Currency: USD"]
    if stmt["in_progress"]:
        sub.append(f"Month to date, generated {stmt['generated_at'][:16].replace('T', ' ')} UTC")
    story = [_header(st, f"Account statement - {stmt['label']}", sub), _account(st, customer)]

    # Summary: opening, credits, charges, closing.
    c, d = stmt["credits"], stmt["debits"]
    lbl = lambda text, style="body": Paragraph(safe(text), st[style])
    amt = lambda v, signed=False, bold=False: Paragraph(usd(v, signed), st["right_bold" if bold else "right"])
    rows = [[lbl("Summary", "bold"), lbl("Amount", "right_bold")], [lbl("Opening balance", "bold"), amt(stmt["opening_balance"], bold=True)],
            [lbl("Credits added", "label"), ""]]
    credit_lines = [("topups", "Top-ups (payments)"), ("promo", "Promotional and bonus credits"), ("refunds", "Refunds"),
                    ("adjustments", "Adjustments (credits)"), ("other", "Other credits")]
    for key, text in credit_lines:
        if key in ("topups", "promo", "refunds", "adjustments") or c[key]:
            rows.append([lbl("   " + text), amt(c[key], signed=bool(c[key]))])
    rows.append([lbl("Total credits", "bold"), amt(c["total"], bold=True)])
    rows.append([lbl("Charges", "label"), ""])
    debit_lines = [("calls", "Call charges"), ("phone", "Phone number fees"), ("adjustments", "Adjustments (debits)"),
                   ("expired", "Expired credits"), ("other", "Other charges")]
    for key, text in debit_lines:
        if key in ("calls", "phone") or d[key]:
            rows.append([lbl("   " + text), amt(-d[key] if d[key] else d[key])])
    rows.append([lbl("Total charges", "bold"), amt(-d["total"] if d["total"] else d["total"], bold=True)])
    rows.append([lbl("Closing balance", "bold"), amt(stmt["closing_balance"], bold=True)])
    last = len(rows) - 1
    story.append(Spacer(1, 10))
    story.append(_grid(rows, W, extra=[("BACKGROUND", (0, last), (-1, last), SHADE), ("LINEABOVE", (0, last), (-1, last), 1, ACCENT),
                                       ("BACKGROUND", (0, 1), (-1, 1), SHADE)]))
    story.append(Spacer(1, 4))
    story.append(Paragraph(safe("Opening balance + total credits - total charges = closing balance."), st["small"]))

    # Call charges by campaign + by direction.
    calls = stmt["calls"]
    if calls["by_campaign"]:
        story += [CondPageBreak(1.6 * inch), Paragraph("Call charges by campaign", st["h2"])]
        rows = [[lbl("Campaign", "bold"), lbl("Direction", "bold"), lbl("Calls", "right_bold"),
                 lbl("Minutes", "right_bold"), lbl("Amount", "right_bold")]]
        for r in calls["by_campaign"]:
            rows.append([lbl(r["name"]), lbl(r["direction"].capitalize()), Paragraph(str(r["calls"]), st["right"]),
                         Paragraph(f"{r['minutes']:,.1f}", st["right"]), amt(r["amount"])])
        rows.append([lbl("Total call charges", "bold"), "", Paragraph(str(stmt["total_calls"]), st["right_bold"]),
                     Paragraph(f"{sum(r['minutes'] for r in calls['by_campaign']):,.1f}", st["right_bold"]),
                     amt(d["calls"], bold=True)])
        story.append(_grid(rows, [2.6 * inch, 1.0 * inch, 0.8 * inch, 1.0 * inch, 1.6 * inch],
                           extra=[("BACKGROUND", (0, len(rows) - 1), (-1, len(rows) - 1), SHADE)]))

        story += [CondPageBreak(1.6 * inch), Paragraph("Call charges by direction", st["h2"])]
        rows = [[lbl("Direction", "bold"), lbl("Calls", "right_bold"), lbl("Amount", "right_bold")]]
        for key, text in (("outbound", "Outbound calls"), ("inbound", "Inbound calls"), ("other", "Other calls")):
            dd = calls["by_direction"][key]
            if dd["calls"] or key != "other":
                rows.append([lbl(text), Paragraph(str(dd["calls"]), st["right"]), amt(dd["amount"])])
        story.append(_grid(rows, [3.9 * inch, 1.1 * inch, 2.0 * inch]))

    def itemised(title, items, sign=1):
        if not items:
            return
        rows = [[lbl("Date", "bold"), lbl("Description", "bold"), lbl("Amount", "right_bold")]]
        for it in items:
            rows.append([lbl(it["date"]), lbl(it["description"][:140] or it["kind"]), amt(it["amount"], signed=sign > 0)])
        story.extend([CondPageBreak(1.6 * inch), Paragraph(title, st["h2"]),
                      _grid(rows, [1.0 * inch, 4.4 * inch, 1.6 * inch])])

    itemised("Credit details", stmt["credit_items"], 1)
    itemised("Phone number fees", stmt["phone_items"], -1)
    itemised("Other adjustments (debits)", stmt["debit_adjustment_items"], -1)
    if stmt["items_truncated"]:
        story.append(Paragraph(safe(f"Only the first {len(stmt['credit_items'])} items of a list are shown; the totals above include every entry."), st["small"]))

    story.append(Spacer(1, 14))
    notes = [NOT_TAX_NOTE, "All amounts are in US dollars (USD). Dates and months are in UTC. Promotional credits that "
             "pass their expiry date are shown as expired credits. Call charges are the per-call amounts debited from your balance."]
    if stmt["in_progress"]:
        notes.insert(0, "This month is not finished: the figures are month to date and will change.")
    story += [Paragraph(safe(n), st["small"]) for n in notes]
    doc.build(story, canvasmaker=_canvas_for(footer))
    return buf.getvalue()


# ---------------------------------------------------------------------------------------------------- receipt

def render_receipt(rcpt: dict, customer: dict, compress: bool = True) -> bytes:
    """PDF bytes for build_receipt()'s result: one top-up payment."""
    st = _styles()
    buf = io.BytesIO()
    date_txt = rcpt["date"].strftime("%Y-%m-%d %H:%M UTC")
    doc = SimpleDocTemplate(buf, pagesize=letter, leftMargin=0.75 * inch, rightMargin=0.75 * inch,
                            topMargin=0.7 * inch, bottomMargin=0.85 * inch, invariant=1, pageCompression=compress,
                            title=f"{BRAND} payment receipt {rcpt['reference']}", author=BRAND)
    story = [_header(st, "Payment receipt", [f"Reference: {rcpt['reference']}", f"Date: {date_txt}", "Currency: USD"]),
             _account(st, customer)]
    lbl = lambda text, style="body": Paragraph(safe(text), st[style])
    rows = [[lbl("Description", "bold"), lbl("Amount", "right_bold")],
            [lbl("Added to prepaid balance" + (" (automatic recharge)" if rcpt["automatic"] else "")), Paragraph(usd(rcpt["amount"]), st["right"])],
            [lbl("Amount paid", "bold"), Paragraph(usd(rcpt["amount"]), st["right_bold"])]]
    story += [Spacer(1, 14), _grid(rows, [5.0 * inch, 2.0 * inch], extra=[("BACKGROUND", (0, 2), (-1, 2), SHADE)])]
    facts = [("Payment date", date_txt), ("Receipt reference", rcpt["reference"])]
    if rcpt["payment_reference"]:
        facts.append(("Payment reference", rcpt["payment_reference"]))
    if rcpt["balance_after"] is not None:
        facts.append(("Balance after this payment", usd(rcpt["balance_after"])))
    story += [Paragraph("Payment details", st["h2"]),
              _grid([[lbl(k, "bold"), lbl(v)] for k, v in facts], [2.2 * inch, 4.8 * inch], head=False)]
    story += [Spacer(1, 14), Paragraph(safe(NOT_TAX_NOTE), st["small"]),
              Paragraph(safe("Funds added to your prepaid balance are used for calls and phone number fees. "
                             "All amounts are in US dollars (USD)."), st["small"])]
    doc.build(story, canvasmaker=_canvas_for(f"{BRAND} - Payment receipt {rcpt['reference']}"))
    return buf.getvalue()
