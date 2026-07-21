import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  CreditCard, Check, Loader2, ExternalLink, Receipt,
  Sparkles, Zap, Building2, PhoneOutgoing, PhoneIncoming, Bot, Clock, DollarSign, Timer, Wallet, Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { api } from "@/services/api";
import { toast } from "sonner";

const TOPUP_PRESETS = [10, 25, 50, 100];

type Plan = {
  id: string;
  name: string;
  price: number;
  price_display: string;
  description: string;
  features: string[];
  popular?: boolean;
  outbound_limit: number;
  inbound_limit: number;
  agents_limit: number;
  rate_per_minute?: number;
};

type BillingStatus = {
  plan: string;
  status: string;
  is_active: boolean;
  outbound_limit: number;
  outbound_used: number;
  inbound_limit: number;
  inbound_used: number;
  agents_limit: number;
  agents_used: number;
  credits: number;
  rate_per_minute: number;
  total_charges: number;
  balance: number;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
};

type CallCostEntry = {
  id: string;
  direction: string;
  phone: string;
  contact_name: string;
  duration: string;
  duration_seconds: number;
  call_cost: number;
  status: string;
  created_at: string;
};

type Invoice = {
  id: string;
  amount: number;
  currency: string;
  status: string;
  created: number;
  invoice_url: string | null;
  pdf: string | null;
};

type PurchaseTxn = {
  id: string;
  kind: string;
  amount: number;
  balance_after: number | null;
  description: string | null;
  created_at: string;
};

const TXN_LABELS: Record<string, string> = {
  topup: "Top-up",
  phone: "Phone Number",
  plan: "Subscription",
  admin: "Adjustment",
};

const planIcons: Record<string, typeof Sparkles> = {
  payg: DollarSign,
  starter: Sparkles,
  growth: Zap,
  business: Building2,
};

function UsageMeter({ label, used, limit, icon: Icon }: {
  label: string;
  used: number;
  limit: number;
  icon: typeof PhoneOutgoing;
}) {
  const isUnlimited = limit >= 999999;
  const pct = isUnlimited ? 0 : limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const isHigh = pct >= 80;
  const isFull = pct >= 100;

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">{label}</span>
        </div>
        <span className={`text-sm font-bold ${isFull ? "text-destructive" : isHigh ? "text-yellow-500" : "text-foreground"}`}>
          {used} / {isUnlimited ? "Unlimited" : limit}
        </span>
      </div>
      {!isUnlimited && (
        <div className="h-2 rounded-full bg-muted overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${isFull ? "bg-destructive" : isHigh ? "bg-yellow-500" : "bg-primary"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      {isUnlimited && (
        <div className="h-2 rounded-full bg-green-500/20 overflow-hidden">
          <div className="h-full rounded-full bg-green-500 w-full" />
        </div>
      )}
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (!seconds) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

const Billing = () => {
  const [searchParams] = useSearchParams();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [callCosts, setCallCosts] = useState<CallCostEntry[]>([]);
  const [transactions, setTransactions] = useState<PurchaseTxn[]>([]);
  const [totalCost, setTotalCost] = useState(0);
  const [totalMinutes, setTotalMinutes] = useState(0);
  const [loading, setLoading] = useState(true);
  const [subscribing, setSubscribing] = useState<string | null>(null);
  const [showTopup, setShowTopup] = useState(false);
  const [topupAmount, setTopupAmount] = useState(25);
  const [toppingUp, setToppingUp] = useState(false);

  const fetchAll = async () => {
    const [plansRes, statusRes, invoicesRes, costsRes, txnRes] = await Promise.all([
      api.getBillingPlans(),
      api.getBillingStatus(),
      api.getBillingInvoices(),
      api.getBillingCallCosts(),
      api.getWalletTransactions(),
    ]);
    if (Array.isArray(plansRes.data)) setPlans(plansRes.data);
    if (statusRes.data) setBilling(statusRes.data);
    if (Array.isArray(invoicesRes.data)) setInvoices(invoicesRes.data);
    if (costsRes.data) {
      setCallCosts(costsRes.data.calls || []);
      setTotalCost(costsRes.data.total_cost || 0);
      setTotalMinutes(costsRes.data.total_minutes || 0);
    }
    if (Array.isArray(txnRes.data)) setTransactions(txnRes.data);
    setLoading(false);
  };

  useEffect(() => { fetchAll(); }, []);

  // Handle the return from a Stripe wallet top-up.
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
  }, [searchParams]);

  const handleAddFunds = async () => {
    if (topupAmount < 10) return toast.error("Minimum top-up is $10");
    setToppingUp(true);
    const { data, error } = await api.topupCheckout(topupAmount);
    setToppingUp(false);
    if (error || !data?.checkout_url) return toast.error(error || "Could not start checkout");
    window.location.href = data.checkout_url;
  };

  const handleSubscribeBalance = async (plan: Plan) => {
    const price = plan.price / 100;
    if (price > 0 && !confirm(`Activate ${plan.name} for $${price.toFixed(2)} from your balance?`)) return;
    setSubscribing(plan.id);
    const { error } = await api.subscribeWithBalance(plan.id);
    setSubscribing(null);
    if (error) return toast.error(error);
    toast.success(`${plan.name} activated.`);
    fetchAll();
  };

  const handlePortal = async () => {
    const { data, error } = await api.createPortalSession();
    if (error) return toast.error(error);
    if (data?.portal_url) {
      window.location.href = data.portal_url;
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading billing...
      </div>
    );
  }

  const isActive = billing?.status === "active";
  const currentPlan = billing?.plan || "free";
  const isPayg = currentPlan === "payg";

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Billing & Plans</h1>
          <p className="text-sm text-muted-foreground">
            Manage your subscription, usage, and call costs.
          </p>
        </div>
        {isActive && billing?.stripe_customer_id && (
          <Button variant="outline" onClick={handlePortal}>
            <ExternalLink className="mr-2 h-4 w-4" /> Manage Subscription
          </Button>
        )}
      </div>

      {/* Current Plan + Status */}
      <div className="rounded-xl border border-border bg-card p-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <CreditCard className="h-6 w-6" />
            </div>
            <div>
              <div className="text-sm text-muted-foreground">Current Plan</div>
              <div className="text-xl font-bold text-foreground capitalize">{currentPlan === "payg" ? "Pay As You Go" : currentPlan}</div>
            </div>
          </div>
          <div className="text-right">
            <Badge variant={isActive ? "default" : "secondary"}>
              {isActive ? "Active" : billing?.status || "Free Trial"}
            </Badge>
            {billing?.rate_per_minute && (
              <div className="mt-1 text-xs text-primary font-medium">
                ${billing.rate_per_minute.toFixed(2)}/min
              </div>
            )}
            {billing?.current_period_end && (
              <div className="mt-1 text-xs text-muted-foreground">
                Renews {new Date(billing.current_period_end).toLocaleDateString()}
              </div>
            )}
            {billing?.credits ? (
              <div className="mt-1 text-xs text-green-500 font-medium">
                +{billing.credits} bonus credits
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* Account Balance / Wallet */}
      <div className="rounded-xl border border-primary/40 bg-primary/5 p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/15 text-primary">
              <Wallet className="h-6 w-6" />
            </div>
            <div>
              <div className="text-sm text-muted-foreground">Account Balance</div>
              <div className="text-3xl font-bold text-foreground">${(billing?.balance ?? 0).toFixed(2)}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                Used for calls, phone numbers and plans
              </div>
            </div>
          </div>
          <Button onClick={() => { setTopupAmount(25); setShowTopup(true); }}>
            <Plus className="mr-2 h-4 w-4" /> Add Funds
          </Button>
        </div>
      </div>

      {/* Cost Summary Cards */}
      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <DollarSign className="h-4 w-4 text-green-500" />
            <span className="text-sm font-medium text-foreground">Total Charges</span>
          </div>
          <div className="text-2xl font-bold text-foreground">${billing?.total_charges?.toFixed(2) || "0.00"}</div>
          <div className="text-xs text-muted-foreground mt-1">This billing period</div>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <Timer className="h-4 w-4 text-blue-500" />
            <span className="text-sm font-medium text-foreground">Total Call Time</span>
          </div>
          <div className="text-2xl font-bold text-foreground">{totalMinutes.toFixed(1)} min</div>
          <div className="text-xs text-muted-foreground mt-1">Across all calls</div>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <Clock className="h-4 w-4 text-purple-500" />
            <span className="text-sm font-medium text-foreground">Rate Per Minute</span>
          </div>
          <div className="text-2xl font-bold text-foreground">${billing?.rate_per_minute?.toFixed(2) || "0.10"}</div>
          <div className="text-xs text-muted-foreground mt-1">Per minute of call time</div>
        </div>
      </div>

      {/* Usage Meters */}
      {billing && (
        <div>
          <h2 className="mb-4 text-lg font-semibold text-foreground">Current Usage</h2>
          <div className="grid gap-4 md:grid-cols-3">
            <UsageMeter
              label="Outbound Calls"
              used={billing.outbound_used}
              limit={billing.outbound_limit + (billing.credits || 0)}
              icon={PhoneOutgoing}
            />
            <UsageMeter
              label="Inbound Calls"
              used={billing.inbound_used}
              limit={billing.inbound_limit + (billing.credits || 0)}
              icon={PhoneIncoming}
            />
            <UsageMeter
              label="AI Agents"
              used={billing.agents_used}
              limit={billing.agents_limit}
              icon={Bot}
            />
          </div>
        </div>
      )}

      {/* Plans Grid */}
      <div>
        <h2 className="mb-4 text-lg font-semibold text-foreground">Available Plans</h2>
        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-4">
          {plans.map((plan) => {
            const Icon = planIcons[plan.id] || Sparkles;
            const isCurrent = currentPlan === plan.id && isActive;
            return (
              <div
                key={plan.id}
                className={`relative rounded-xl border bg-card p-6 transition ${
                  plan.popular
                    ? "border-primary shadow-md shadow-primary/10"
                    : plan.id === "payg"
                    ? "border-green-500/50 shadow-md shadow-green-500/10"
                    : "border-border"
                }`}
              >
                {plan.popular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <Badge className="bg-primary text-primary-foreground">Most Popular</Badge>
                  </div>
                )}
                {plan.id === "payg" && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <Badge className="bg-green-500 text-white">Flexible</Badge>
                  </div>
                )}
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="mt-4 text-lg font-bold text-foreground">{plan.name}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{plan.description}</p>
                <div className="mt-4">
                  {plan.price > 0 ? (
                    <>
                      <span className="text-3xl font-bold text-foreground">
                        ${(plan.price / 100).toFixed(0)}
                      </span>
                      <span className="text-sm text-muted-foreground">/mo</span>
                    </>
                  ) : (
                    <>
                      <span className="text-3xl font-bold text-foreground">
                        ${plan.rate_per_minute?.toFixed(2)}
                      </span>
                      <span className="text-sm text-muted-foreground">/min</span>
                    </>
                  )}
                </div>
                {plan.rate_per_minute && plan.price > 0 && (
                  <div className="mt-1 text-xs text-primary font-medium">
                    + ${plan.rate_per_minute.toFixed(2)}/min for calls
                  </div>
                )}
                <ul className="mt-5 space-y-2.5">
                  {plan.features.map((f, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-foreground">
                      <Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-500" />
                      {f}
                    </li>
                  ))}
                </ul>
                <div className="mt-6">
                  {isCurrent ? (
                    <Button variant="outline" className="w-full" disabled>
                      Current Plan
                    </Button>
                  ) : (() => {
                    const priceUsd = plan.price / 100;
                    const canAfford = (billing?.balance ?? 0) >= priceUsd;
                    if (priceUsd > 0 && !canAfford) {
                      return (
                        <Button
                          className="w-full"
                          variant="outline"
                          onClick={() => { setTopupAmount(Math.max(25, Math.ceil(priceUsd))); setShowTopup(true); }}
                        >
                          <Wallet className="mr-2 h-4 w-4" /> Add funds to subscribe
                        </Button>
                      );
                    }
                    return (
                      <Button
                        className="w-full"
                        variant={plan.popular ? "default" : plan.id === "payg" ? "default" : "outline"}
                        onClick={() => handleSubscribeBalance(plan)}
                        disabled={subscribing === plan.id}
                      >
                        {subscribing === plan.id ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Activating...
                          </>
                        ) : plan.id === "payg" ? (
                          "Start Pay As You Go"
                        ) : (
                          `Subscribe — $${priceUsd.toFixed(0)}/mo from balance`
                        )}
                      </Button>
                    );
                  })()}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Free Tier Info */}
      {currentPlan === "free" && (
        <div className="rounded-xl border border-dashed border-primary/40 bg-primary/5 p-5">
          <h3 className="text-sm font-semibold text-foreground mb-1">Free Trial</h3>
          <p className="text-sm text-muted-foreground">
            You have <strong>10 free AI agents</strong> and a few test calls to try the platform.
            Subscribe to a plan above to unlock full calling capacity, or choose Pay As You Go to only pay for what you use.
          </p>
        </div>
      )}

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
                          <span className="text-muted-foreground text-xs">
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

      {/* Call Cost History */}
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
                        <span className="text-muted-foreground text-xs">
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

      {/* Invoices */}
      {invoices.length > 0 && (
        <div>
          <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold text-foreground">
            <Receipt className="h-5 w-5 text-primary" />
            Invoice History
          </h2>
          <div className="overflow-hidden rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Amount</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.id} className="border-t border-border bg-card/30">
                    <td className="px-4 py-3 text-foreground">
                      {new Date(inv.created * 1000).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 font-medium text-foreground">
                      ${(inv.amount / 100).toFixed(2)} {inv.currency.toUpperCase()}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={inv.status === "paid" ? "default" : "secondary"}>
                        {inv.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {inv.invoice_url && (
                        <a
                          href={inv.invoice_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-primary hover:underline"
                        >
                          View
                        </a>
                      )}
                      {inv.pdf && (
                        <a
                          href={inv.pdf}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ml-3 text-xs text-primary hover:underline"
                        >
                          PDF
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Add Funds dialog */}
      <Dialog open={showTopup} onOpenChange={setShowTopup}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Funds</DialogTitle>
            <DialogDescription>
              Load your account balance. It's used for calls, phone numbers and plans.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-4 gap-2">
              {TOPUP_PRESETS.map((amt) => (
                <Button
                  key={amt}
                  type="button"
                  variant={topupAmount === amt ? "default" : "outline"}
                  onClick={() => setTopupAmount(amt)}
                >
                  ${amt}
                </Button>
              ))}
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-foreground">Custom amount (USD)</label>
              <Input
                type="number"
                min={10}
                max={1000}
                value={topupAmount}
                onChange={(e) => setTopupAmount(parseFloat(e.target.value) || 0)}
              />
              <p className="mt-1 text-xs text-muted-foreground">Minimum $10. You'll pay securely via Stripe.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowTopup(false)}>Cancel</Button>
            <Button onClick={handleAddFunds} disabled={toppingUp || topupAmount < 10}>
              {toppingUp ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Redirecting…</>
              ) : (
                <>Pay ${topupAmount.toFixed(2)}</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Billing;
