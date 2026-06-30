import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  CreditCard, Check, Loader2, ExternalLink, Receipt,
  Sparkles, Zap, Building2, PhoneOutgoing, PhoneIncoming, Bot,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { api } from "@/services/api";
import { toast } from "sonner";

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
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
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

const planIcons: Record<string, typeof Sparkles> = {
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
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
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
          {used} / {limit}
        </span>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${isFull ? "bg-destructive" : isHigh ? "bg-yellow-500" : "bg-primary"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

const Billing = () => {
  const [searchParams] = useSearchParams();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [checkingOut, setCheckingOut] = useState<string | null>(null);

  useEffect(() => {
    if (searchParams.get("success") === "true") {
      toast.success("Payment successful! Your plan is now active.");
    }
    if (searchParams.get("canceled") === "true") {
      toast.info("Checkout was canceled.");
    }
  }, [searchParams]);

  useEffect(() => {
    const fetchAll = async () => {
      const [plansRes, statusRes, invoicesRes] = await Promise.all([
        api.getBillingPlans(),
        api.getBillingStatus(),
        api.getBillingInvoices(),
      ]);
      if (Array.isArray(plansRes.data)) setPlans(plansRes.data);
      if (statusRes.data) setBilling(statusRes.data);
      if (Array.isArray(invoicesRes.data)) setInvoices(invoicesRes.data);
      setLoading(false);
    };
    fetchAll();
  }, []);

  const handleCheckout = async (planId: string) => {
    setCheckingOut(planId);
    const { data, error } = await api.createCheckout({
      plan_id: planId,
      success_url: `${window.location.origin}/dashboard/billing?success=true`,
      cancel_url: `${window.location.origin}/dashboard/billing?canceled=true`,
    });
    setCheckingOut(null);
    if (error) return toast.error(error);
    if (data?.checkout_url) {
      window.location.href = data.checkout_url;
    }
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

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Billing & Plans</h1>
          <p className="text-sm text-muted-foreground">
            Manage your subscription, usage, and invoices.
          </p>
        </div>
        {isActive && (
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
              <div className="text-xl font-bold text-foreground capitalize">{currentPlan}</div>
            </div>
          </div>
          <div className="text-right">
            <Badge variant={isActive ? "default" : "secondary"}>
              {isActive ? "Active" : billing?.status || "Free Trial"}
            </Badge>
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
        <div className="grid gap-5 md:grid-cols-3">
          {plans.map((plan) => {
            const Icon = planIcons[plan.id] || Sparkles;
            const isCurrent = currentPlan === plan.id && isActive;
            return (
              <div
                key={plan.id}
                className={`relative rounded-xl border bg-card p-6 transition ${
                  plan.popular
                    ? "border-primary shadow-md shadow-primary/10"
                    : "border-border"
                }`}
              >
                {plan.popular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <Badge className="bg-primary text-primary-foreground">Most Popular</Badge>
                  </div>
                )}
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="mt-4 text-lg font-bold text-foreground">{plan.name}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{plan.description}</p>
                <div className="mt-4">
                  <span className="text-3xl font-bold text-foreground">
                    ${(plan.price / 100).toFixed(0)}
                  </span>
                  <span className="text-sm text-muted-foreground">/mo</span>
                </div>
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
                  ) : (
                    <Button
                      className="w-full"
                      variant={plan.popular ? "default" : "outline"}
                      onClick={() => handleCheckout(plan.id)}
                      disabled={checkingOut === plan.id}
                    >
                      {checkingOut === plan.id ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Redirecting...
                        </>
                      ) : (
                        `Subscribe to ${plan.name}`
                      )}
                    </Button>
                  )}
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
            Subscribe to a plan above to unlock full calling capacity.
          </p>
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
    </div>
  );
};

export default Billing;
