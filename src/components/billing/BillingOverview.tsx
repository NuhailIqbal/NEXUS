import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  AlertTriangle, Clock, DollarSign, Loader2, Plus, Receipt, RefreshCw, Timer,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { api } from "@/services/api";
import { AddFundsDialog } from "./AddFundsDialog";
import { AutoRechargeDialog } from "./AutoRechargeDialog";
import {
  BillingStatus, CallCostEntry, PurchaseTxn, TXN_LABELS, formatDuration,
} from "./types";

const BillingOverview = () => {
  const [searchParams] = useSearchParams();
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [callCosts, setCallCosts] = useState<CallCostEntry[]>([]);
  const [transactions, setTransactions] = useState<PurchaseTxn[]>([]);
  const [totalCost, setTotalCost] = useState(0);
  const [totalMinutes, setTotalMinutes] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showTopup, setShowTopup] = useState(false);
  const [showAutoRecharge, setShowAutoRecharge] = useState(false);

  const fetchAll = useCallback(async () => {
    const [statusRes, costsRes, txnRes] = await Promise.all([
      api.getBillingStatus(),
      api.getBillingCallCosts(),
      api.getWalletTransactions(),
    ]);
    if (statusRes.data) setBilling(statusRes.data);
    if (costsRes.data) {
      setCallCosts(costsRes.data.calls || []);
      setTotalCost(costsRes.data.total_cost || 0);
      setTotalMinutes(costsRes.data.total_minutes || 0);
    }
    if (Array.isArray(txnRes.data)) setTransactions(txnRes.data);
    setLoading(false);
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Handle the return from a Stripe wallet top-up. Stripe always returns to the
  // Overview (index) tab, so this lives here.
  useEffect(() => {
    const topup = searchParams.get("topup");
    if (!topup) return;
    const clean = () => window.history.replaceState({}, "", window.location.pathname);
    if (topup === "canceled") {
      toast.info("Top-up canceled — no funds added.");
      clean();
      return;
    }
    if (topup === "success") {
      const sessionId = searchParams.get("session_id");
      if (!sessionId) { clean(); return; }
      const t = toast.loading("Payment received — updating your balance…");
      api.topupConfirm(sessionId).then(({ data, error }) => {
        toast.dismiss(t);
        if (error) toast.error(error);
        else toast.success(`Added $${(data?.added ?? 0).toFixed(2)} to your balance.`);
        clean();
        fetchAll();
      });
    }
  }, [searchParams, fetchAll]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading billing...
      </div>
    );
  }

  const rate = billing?.rate_per_minute ?? 0.35;
  const autoOn = !!billing?.auto_recharge_enabled;

  return (
    <div className="space-y-8">
      {/* Pay as you go — balance + primary actions */}
      <div>
        <h2 className="text-lg font-semibold text-foreground">Pay as you go</h2>
        <div className="mt-1 text-sm text-muted-foreground">Credit balance</div>
        <div className="mt-1 text-4xl font-bold text-foreground">
          ${(billing?.balance ?? 0).toFixed(2)}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          Calls are billed at ${rate.toFixed(2)} per minute. No subscription or monthly fee.
        </div>
        {transactions.some((t) => t.kind === "promo") && (
          <div className="mt-1 text-xs font-medium text-primary">🎁 Welcome credit included</div>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={() => setShowTopup(true)}>
            <Plus className="mr-2 h-4 w-4" /> Add to credit balance
          </Button>
          <Button variant="outline" onClick={() => setShowAutoRecharge(true)}>
            <RefreshCw className="mr-2 h-4 w-4" /> Auto recharge settings
          </Button>
        </div>
      </div>

      {/* Auto-recharge state banner */}
      {autoOn ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/40 bg-primary/5 px-4 py-3 text-sm">
          <div className="flex items-center gap-2 text-foreground">
            <RefreshCw className="h-4 w-4 shrink-0 text-primary" />
            <span>
              Auto recharge is <span className="font-medium">on</span>. When your balance falls below{" "}
              ${(billing?.auto_recharge_threshold ?? 0).toFixed(2)}, we'll automatically add{" "}
              ${(billing?.auto_recharge_amount ?? 0).toFixed(2)} using your default card.
            </span>
          </div>
          <Button variant="outline" size="sm" onClick={() => setShowAutoRecharge(true)}>
            Change
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-600 dark:text-yellow-400">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>
              <span className="font-medium">Auto recharge is off.</span>{" "}
              When your credit balance reaches $0, your calls will stop working. Enable automatic
              recharge to keep your balance topped up.
            </span>
          </div>
          <Button size="sm" onClick={() => setShowAutoRecharge(true)}>
            Enable auto recharge
          </Button>
        </div>
      )}

      {/* Cost summary */}
      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="mb-2 flex items-center gap-2">
            <DollarSign className="h-4 w-4 text-green-500" />
            <span className="text-sm font-medium text-foreground">Total Charges</span>
          </div>
          <div className="text-2xl font-bold text-foreground">
            ${billing?.total_charges?.toFixed(2) || "0.00"}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">This billing period</div>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="mb-2 flex items-center gap-2">
            <Timer className="h-4 w-4 text-blue-500" />
            <span className="text-sm font-medium text-foreground">Total Call Time</span>
          </div>
          <div className="text-2xl font-bold text-foreground">{totalMinutes.toFixed(1)} min</div>
          <div className="mt-1 text-xs text-muted-foreground">Across all calls</div>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="mb-2 flex items-center gap-2">
            <Clock className="h-4 w-4 text-purple-500" />
            <span className="text-sm font-medium text-foreground">Est. Rate Per Minute</span>
          </div>
          <div className="text-2xl font-bold text-foreground">${rate.toFixed(2)}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            Estimated — each call is billed by its actual cost
          </div>
        </div>
      </div>

      {/* Purchase History */}
      {transactions.length > 0 && (
        <div>
          <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold text-foreground">
            <Receipt className="h-5 w-5 text-primary" />
            Purchase History
          </h2>
          <div className="overflow-hidden rounded-xl border border-border">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3">Description</th>
                    <th className="px-4 py-3">Amount</th>
                    <th className="px-4 py-3">Balance After</th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((t) => {
                    const credit = t.amount >= 0;
                    return (
                      <tr key={t.id} className="border-t border-border bg-card/30">
                        <td className="px-4 py-3 text-foreground">
                          {new Date(t.created_at).toLocaleDateString()}{" "}
                          <span className="text-xs text-muted-foreground">
                            {new Date(t.created_at).toLocaleTimeString()}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant="outline">{TXN_LABELS[t.kind] || t.kind}</Badge>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{t.description || "—"}</td>
                        <td className={`px-4 py-3 font-medium ${credit ? "text-green-500" : "text-destructive"}`}>
                          {credit ? "+" : "-"}${Math.abs(t.amount).toFixed(2)}
                        </td>
                        <td className="px-4 py-3 text-foreground">
                          {t.balance_after != null ? `$${t.balance_after.toFixed(2)}` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Call Cost Breakdown */}
      {callCosts.length > 0 && (
        <div>
          <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold text-foreground">
            <Timer className="h-5 w-5 text-primary" />
            Call Cost Breakdown
          </h2>
          <div className="overflow-hidden rounded-xl border border-border">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Contact</th>
                    <th className="px-4 py-3">Direction</th>
                    <th className="px-4 py-3">Duration</th>
                    <th className="px-4 py-3">Cost</th>
                    <th className="px-4 py-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {callCosts.map((call) => (
                    <tr key={call.id} className="border-t border-border bg-card/30">
                      <td className="px-4 py-3 text-foreground">
                        {new Date(call.created_at).toLocaleDateString()}{" "}
                        <span className="text-xs text-muted-foreground">
                          {new Date(call.created_at).toLocaleTimeString()}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-medium text-foreground">
                        {call.contact_name || call.phone || "Unknown"}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="outline" className="capitalize">{call.direction}</Badge>
                      </td>
                      <td className="px-4 py-3 text-foreground">
                        {formatDuration(call.duration_seconds)}
                      </td>
                      <td className="px-4 py-3 font-medium text-foreground">
                        ${(call.call_cost || 0).toFixed(4)}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={call.status === "Completed" ? "default" : "secondary"}>
                          {call.status}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-border bg-muted/30 font-semibold">
                    <td className="px-4 py-3 text-foreground" colSpan={3}>Total</td>
                    <td className="px-4 py-3 text-foreground">{totalMinutes.toFixed(1)} min</td>
                    <td className="px-4 py-3 text-foreground">${totalCost.toFixed(2)}</td>
                    <td></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      <AddFundsDialog open={showTopup} onOpenChange={setShowTopup} />
      <AutoRechargeDialog
        open={showAutoRecharge}
        onOpenChange={setShowAutoRecharge}
        billing={billing}
        onSaved={fetchAll}
      />
    </div>
  );
};

export default BillingOverview;
