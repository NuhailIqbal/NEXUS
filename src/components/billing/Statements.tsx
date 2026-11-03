/**
 * Billing > Statements tab: one PDF statement per month with activity (opening balance, credits, call charges,
 * closing balance) plus the Stripe invoices of card payments. Uses api.getBillingStatements,
 * api.downloadBillingStatement and api.getBillingInvoices. Per-top-up receipts live on the Transactions tab.
 * Statements are summaries of the prepaid balance, not tax invoices. Route: /dashboard/billing/statements (App.tsx).
 */
import { useEffect, useState } from "react";
import { Download, ExternalLink, FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/services/api";
import { formatInvoiceAmount, formatUsd, type StatementMonth, type StripeInvoice } from "@/lib/billingDocuments";

const Statements = () => {
  const [months, setMonths] = useState<StatementMonth[]>([]);
  const [statementsError, setStatementsError] = useState<string | null>(null);
  const [invoices, setInvoices] = useState<StripeInvoice[]>([]);
  const [invoicesError, setInvoicesError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let on = true;
    Promise.all([api.getBillingStatements(), api.getBillingInvoices()]).then(([s, i]) => {
      if (!on) return;
      if (Array.isArray(s.data)) setMonths(s.data);
      if (s.error) setStatementsError(String(s.error));
      if (Array.isArray(i.data)) setInvoices(i.data);
      if (i.error) setInvoicesError(String(i.error));
      setLoading(false);
    });
    return () => { on = false; };
  }, []);

  const download = async (month: string) => {
    setBusy(month);
    const { error } = await api.downloadBillingStatement(month);
    setBusy(null);
    if (error) toast.error(error);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading statements...
      </div>
    );
  }

  return (
    <div className="space-y-10">
      <section>
        <h2 className="text-lg font-semibold text-foreground">Monthly statements</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          A PDF for each month with activity: opening balance, credits added, call charges and closing balance, in US
          dollars. Statements summarise your prepaid balance and are not tax invoices.
        </p>

        {statementsError ? (
          <p role="alert" className="mt-4 text-sm text-destructive">{statementsError}</p>
        ) : months.length === 0 ? (
          <div className="mt-4 rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
            No statements yet. A statement appears here for every month with activity on your account.
          </div>
        ) : (
          <div className="mt-4 overflow-hidden rounded-xl border border-border">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 text-left">Month</th>
                    <th className="px-4 py-3 text-right">Opening balance</th>
                    <th className="px-4 py-3 text-right">Credits added</th>
                    <th className="px-4 py-3 text-right">Charges</th>
                    <th className="px-4 py-3 text-right">Closing balance</th>
                    <th className="px-4 py-3 text-right"><span className="sr-only">Download</span></th>
                  </tr>
                </thead>
                <tbody>
                  {months.map((m) => (
                    <tr key={m.month} className="border-t border-border bg-card/30">
                      <td className="whitespace-nowrap px-4 py-3 font-medium text-foreground">
                        {m.label}
                        {m.in_progress && <Badge variant="outline" className="ml-2">Month to date</Badge>}
                      </td>
                      <td className="px-4 py-3 text-right text-muted-foreground">{formatUsd(m.opening_balance)}</td>
                      <td className="px-4 py-3 text-right text-foreground">{formatUsd(m.credits)}</td>
                      <td className="px-4 py-3 text-right text-foreground">{formatUsd(m.charges)}</td>
                      <td className="px-4 py-3 text-right font-medium text-foreground">{formatUsd(m.closing_balance)}</td>
                      <td className="px-4 py-3 text-right">
                        <Button
                          size="sm" variant="outline" disabled={busy === m.month}
                          aria-label={`Download ${m.label} statement`}
                          onClick={() => download(m.month)}
                        >
                          {busy === m.month
                            ? <Loader2 className="h-4 w-4 animate-spin" />
                            : <><Download className="mr-1.5 h-4 w-4" /> PDF</>}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold text-foreground">Card payment invoices</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Invoices issued by our payment provider for card payments. A receipt for every top-up is also available on
          the Transactions tab.
        </p>

        {invoicesError ? (
          <p role="alert" className="mt-4 text-sm text-muted-foreground">
            Card invoices could not be loaded right now. Please try again later.
          </p>
        ) : invoices.length === 0 ? (
          <div className="mt-4 rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
            No card invoices yet.
          </div>
        ) : (
          <ul className="mt-4 divide-y divide-border overflow-hidden rounded-xl border border-border">
            {invoices.map((inv) => (
              <li key={inv.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 bg-card/30 px-4 py-3">
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-foreground">
                    {formatInvoiceAmount(inv.amount, inv.currency)}
                    {inv.status && <Badge variant="outline" className="ml-2 capitalize">{inv.status}</Badge>}
                  </div>
                  <div className="text-xs text-muted-foreground">{new Date(inv.created * 1000).toLocaleDateString()}</div>
                </div>
                <div className="flex shrink-0 gap-2">
                  {inv.invoice_url && (
                    <Button asChild size="sm" variant="outline">
                      <a href={inv.invoice_url} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="mr-1.5 h-4 w-4" /> View
                      </a>
                    </Button>
                  )}
                  {inv.pdf && (
                    <Button asChild size="sm" variant="outline">
                      <a href={inv.pdf} target="_blank" rel="noopener noreferrer">
                        <Download className="mr-1.5 h-4 w-4" /> PDF
                      </a>
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
};

export default Statements;
