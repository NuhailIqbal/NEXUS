import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  AlertTriangle, CheckCircle2, Clock, DollarSign, Loader2, Plus, RefreshCw, Sparkles, Timer, Wallet,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/services/api";
import { AddFundsDialog } from "./AddFundsDialog";
import { AutoRechargeDialog } from "./AutoRechargeDialog";
import { BillingStatus } from "./types";

const BillingOverview = () => {
  const [searchParams] = useSearchParams();
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [hasPromo, setHasPromo] = useState(false);
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
    if (costsRes.data) setTotalMinutes(costsRes.data.total_minutes || 0);
    if (Array.isArray(txnRes.data)) setHasPromo(txnRes.data.some((t) => t.kind === "promo"));
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
      toast.info("Top-up canceled. No funds added.");
      clean();
      return;
    }
    if (topup === "success") {
      const sessionId = searchParams.get("session_id");
      if (!sessionId) { clean(); return; }
      const t = toast.loading("Payment received. Updating your balance…");
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
    <div className="space-y-6">
      {/* Pay as you go — hero balance card */}
      <div className="overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-primary/10 via-background to-background p-6 sm:p-8">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/15">
                <Wallet className="h-4.5 w-4.5 text-primary" />
              </div>
              <span className="text-sm font-medium text-muted-foreground">Pay as you go · Credit balance</span>
            </div>
            <div className="mt-3 text-5xl font-bold tracking-tight text-foreground">
              ${(billing?.balance ?? 0).toFixed(2)}
            </div>
            <div className="mt-2 text-sm text-muted-foreground">
              Calls are billed at ${rate.toFixed(2)} per minute. No subscription or monthly fee.
            </div>
            {hasPromo && (
              <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
                <Sparkles className="h-3.5 w-3.5" /> Welcome credit included
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-2 sm:shrink-0">
            <Button onClick={() => setShowTopup(true)}>
              <Plus className="mr-2 h-4 w-4" /> Add to credit balance
            </Button>
            <Button variant="outline" onClick={() => setShowAutoRecharge(true)}>
              <RefreshCw className="mr-2 h-4 w-4" /> Auto recharge settings
            </Button>
          </div>
        </div>
      </div>

      {/* Auto-recharge state banner */}
      {autoOn ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-5 py-4 text-sm">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-success/15">
              <CheckCircle2 className="h-4 w-4 text-success" />
            </div>
            <span className="text-foreground">
              Auto recharge is <span className="font-semibold">on</span>. When your balance falls below{" "}
              <span className="font-medium">${(billing?.auto_recharge_threshold ?? 0).toFixed(2)}</span>, we'll automatically add{" "}
              <span className="font-medium">${(billing?.auto_recharge_amount ?? 0).toFixed(2)}</span> using your default card.
            </span>
          </div>
          <Button variant="outline" size="sm" onClick={() => setShowAutoRecharge(true)}>
            Change
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-yellow-500/30 bg-yellow-500/[0.06] px-5 py-4 text-sm">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-yellow-500/15">
              <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-400" />
            </div>
            <span className="text-foreground">
              <span className="font-semibold">Auto recharge is off.</span>{" "}
              <span className="text-muted-foreground">
                When your credit balance reaches $0, your calls will stop working. Enable automatic
                recharge to keep your balance topped up.
              </span>
            </span>
          </div>
          <Button size="sm" onClick={() => setShowAutoRecharge(true)}>
            Enable auto recharge
          </Button>
        </div>
      )}

      {/* Cost summary */}
      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-xl border border-border bg-card p-5 transition-colors hover:border-border/80">
          <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-green-500/10">
            <DollarSign className="h-4.5 w-4.5 text-green-500" />
          </div>
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Total Charges</div>
          <div className="mt-1 text-2xl font-bold text-foreground">
            ${billing?.total_charges?.toFixed(2) || "0.00"}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">This billing period</div>
        </div>
        <div className="rounded-xl border border-border bg-card p-5 transition-colors hover:border-border/80">
          <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-blue-500/10">
            <Timer className="h-4.5 w-4.5 text-blue-500" />
          </div>
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Total Call Time</div>
          <div className="mt-1 text-2xl font-bold text-foreground">{totalMinutes.toFixed(1)} min</div>
          <div className="mt-1 text-xs text-muted-foreground">Across all calls</div>
        </div>
        <div className="rounded-xl border border-border bg-card p-5 transition-colors hover:border-border/80">
          <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-purple-500/10">
            <Clock className="h-4.5 w-4.5 text-purple-500" />
          </div>
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Est. Rate Per Minute</div>
          <div className="mt-1 text-2xl font-bold text-foreground">${rate.toFixed(2)}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            Estimated: each call is billed by its actual cost
          </div>
        </div>
      </div>

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
