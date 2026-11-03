"""Billing documents API, mounted under /billing next to routers/billing.py (Phase 1: USD, English, no tax).

  GET  /billing/statements                  months with activity, newest first, with balances
  GET  /billing/statements/{YYYY-MM}        one statement as JSON
  GET  /billing/statements/{YYYY-MM}/pdf    the statement PDF
  GET  /billing/receipts/{transaction_id}/pdf   the PDF receipt of one top-up payment

Everything is scoped to the ACCOUNT OWNER resolved from the token (team members see and download the owner's
documents); no endpoint takes an account id, so one account can never reach another's statement, and a transaction id
that belongs to another account is simply "not found". Plain `def` endpoints: the work is blocking SQL + PDF drawing,
which FastAPI runs in its threadpool.
"""
from fastapi import APIRouter, Depends, HTTPException, Response

from dependencies import get_current_user
from routers.team import resolve_owner_id
from services import billing_documents as bd
from services import billing_pdf

router = APIRouter(prefix="/billing", tags=["Billing documents"])


def _owner(user) -> str:
    return resolve_owner_id(user["user_id"])


def _pdf_response(data: bytes, filename: str) -> Response:
    return Response(content=data, media_type="application/pdf", headers={
        "Content-Disposition": f'attachment; filename="{filename}"',
        # Personal financial data: never cached by the browser or a proxy.
        "Cache-Control": "private, no-store",
    })


@router.get("/statements")
def list_statements(user=Depends(get_current_user)):
    """Months the account has activity in (newest first): what the Documents tab lists, one download button each."""
    return {"data": bd.month_summaries(_owner(user)), "error": None}


def _statement_or_404(owner: str, month: str) -> dict:
    try:
        stmt = bd.build_statement(owner, month)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if stmt is None:
        raise HTTPException(status_code=404, detail="There is no statement for that month.")
    return stmt


@router.get("/statements/{month}")
def get_statement(month: str, user=Depends(get_current_user)):
    return {"data": bd.statement_json(_statement_or_404(_owner(user), month)), "error": None}


@router.get("/statements/{month}/pdf")
def get_statement_pdf(month: str, user=Depends(get_current_user)):
    owner = _owner(user)
    stmt = _statement_or_404(owner, month)
    pdf = billing_pdf.render_statement(stmt, bd.billed_to(owner))
    return _pdf_response(pdf, f"EDM-Nexus-Statement-{month}.pdf")


@router.get("/receipts/{transaction_id}/pdf")
def get_receipt_pdf(transaction_id: str, user=Depends(get_current_user)):
    owner = _owner(user)
    rcpt = bd.build_receipt(owner, transaction_id)
    if rcpt is None:
        raise HTTPException(status_code=404, detail="Receipt not found.")
    pdf = billing_pdf.render_receipt(rcpt, bd.billed_to(owner))
    return _pdf_response(pdf, f"EDM-Nexus-Receipt-{rcpt['reference']}.pdf")
