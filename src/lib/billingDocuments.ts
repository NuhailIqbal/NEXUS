/**
 * Types and small helpers for the billing documents UI: monthly statements, Stripe invoices, receipts.
 */

/** One month with activity (GET /billing/statements). Amounts are dollars. */
export type StatementMonth = {
  month: string; // "2026-10"
  label: string; // "October 2026"
  in_progress: boolean;
  opening_balance: number;
  credits: number;
  charges: number;
  topups: number;
  call_charges: number;
  closing_balance: number;
};

/** A Stripe invoice as returned by GET /billing/invoices (amount in cents, created in unix seconds). */
export type StripeInvoice = {
  id: string;
  amount: number;
  currency: string;
  status: string | null;
  created: number;
  invoice_url: string | null;
  pdf: string | null;
};

/** $1,234.56 / -$1,234.56 */
export function formatUsd(v: number): string {
  const s = `$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return v < 0 ? `-${s}` : s;
}

/** Stripe reports cents; show dollars in the invoice's currency (USD by default). */
export function formatInvoiceAmount(cents: number, currency = "usd"): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    return formatUsd(cents / 100);
  }
}

/** True for a wallet row that has a receipt: a payment the customer made (kind "topup", money in). */
export function hasReceipt(t: { kind: string; amount: number }): boolean {
  return t.kind === "topup" && t.amount > 0;
}
