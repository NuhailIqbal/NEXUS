/**
 * Referral partner portal (/dashboard/partner), for accounts an admin has set up as a referral partner
 * (GET /partner/overview answers 403 for everyone else, who are sent back to the dashboard). Shows the partner's
 * link and commission rule, how many people signed up through it and what they were billed, the commission earned
 * so far (and by week, month or year, with a CSV), what has been paid to them and what is still owed with the payment history (read-only), every referred
 * account with a "View as" button (the same impersonation flow admins have), and a live feed of what those users
 * do. The platform's own cost and profit, and the admin's private notes on a payment, are never sent to this page.
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Banknote, Copy, DollarSign, Eye, Loader2, Percent, UserCheck, Users2, Wallet } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import ActivityFeed from "@/components/partners/ActivityFeed";
import CommissionReport from "@/components/partners/CommissionReport";
import { api } from "@/services/api";
import { startPartnerImpersonation } from "@/lib/impersonation";
import { moneyOrDash } from "@/lib/leadRoi";
import {
  balanceStatus, commissionExplainer, payoutDate, referralUrl, timeAgo,
  type PartnerInfo, type PartnerSignup, type PartnerTotals, type Payout,
} from "@/lib/partners";

type Overview = PartnerInfo & { totals: PartnerTotals; signups: PartnerSignup[]; payouts: Payout[] };

const Stat = ({ icon: Icon, label, value, hint }: { icon: typeof Users2; label: string; value: string | number; hint?: string }) => (
  <div className="rounded-xl border border-border bg-card/40 p-5">
    <div className="flex items-center gap-2 text-sm text-muted-foreground"><Icon className="h-4 w-4" /> {label}</div>
    <div className="mt-2 text-2xl font-bold text-foreground">{value}</div>
    {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
  </div>
);

const Partner = () => {
  const navigate = useNavigate();
  const [data, setData] = useState<Overview | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);

  const fetchOverview = useCallback(async (first: boolean) => {
    const { data: d, error } = await api.getPartnerOverview();
    if (d && !error) {
      setData(d);
    } else if (first) {
      // Not a partner: this page has nothing to show. (A failed background refresh just keeps what is on screen.)
      navigate("/dashboard", { replace: true });
    }
  }, [navigate]);

  useEffect(() => {
    fetchOverview(true);
    // Signups and earnings move with usage, so refresh them quietly alongside the live feed.
    const id = setInterval(() => { if (!document.hidden) fetchOverview(false); }, 15000);
    return () => clearInterval(id);
  }, [fetchOverview]);

  const viewAs = async (userId: string, email: string) => {
    setViewing(userId);
    const { data: d, error } = await api.partnerImpersonateUser(userId);
    if (error || !d?.access_token) {
      setViewing(null);
      toast.error(error || "Could not open that account");
      return;
    }
    startPartnerImpersonation(d.access_token, email);
  };

  if (!data) {
    return (
      <div className="flex items-center justify-center py-14 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading...
      </div>
    );
  }

  const link = referralUrl(window.location.origin, data.referral_path);
  const t = data.totals;
  const balance = balanceStatus(t.owed);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Partner portal</h1>
        <p className="text-sm text-muted-foreground">Everyone who signs up through your link, what they spend, and what you earn.</p>
      </div>

      {data.status === "paused" && (
        <div className="rounded-xl border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm text-foreground">
          Your partner account is paused: new signups are not being credited to you and "View as" is turned off.
          What you have already earned is unchanged. Contact us to reactivate it.
        </div>
      )}

      <div className="space-y-2">
        <div className="text-sm font-medium text-foreground">Your referral link</div>
        <div className="flex max-w-xl gap-2">
          <Input readOnly value={link} className="min-w-0 text-ellipsis font-mono text-sm" />
          <Button type="button" className="gap-2" onClick={() => { navigator.clipboard.writeText(link); toast.success("Referral link copied"); }}>
            <Copy className="h-4 w-4" /> Copy
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
        <Stat icon={Users2} label="Signups" value={t.signups} />
        <Stat icon={UserCheck} label="Verified" value={t.verified} />
        <Stat icon={DollarSign} label="Billed to your users" value={moneyOrDash(t.billed)} hint={`${t.calls} call${t.calls === 1 ? "" : "s"}`} />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
        <Stat icon={Percent} label="You've earned" value={moneyOrDash(t.commission)} hint={data.commission_label} />
        <Stat icon={Banknote} label="Paid to you" value={moneyOrDash(t.paid)} hint={`${data.payouts.length} payment${data.payouts.length === 1 ? "" : "s"}`} />
        <Stat
          icon={Wallet}
          label={balance === "overpaid" ? "Paid ahead" : "Still owed to you"}
          value={moneyOrDash(Math.abs(t.owed))}
          hint={balance === "overpaid" ? "Your rate was lowered after a payment; this comes off future earnings." : balance === "settled" ? "You are paid up." : "Earned but not paid yet."}
        />
      </div>
      <p className="-mt-4 max-w-2xl text-xs text-muted-foreground">
        Your rate: <strong className="text-foreground">{data.commission_label}</strong>. {commissionExplainer(data.commission_type)}
      </p>

      <div>
        <h2 className="text-lg font-semibold text-foreground">Payments to you</h2>
        {data.payouts.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-border bg-card/40 py-10 text-center">
            <h3 className="font-semibold text-foreground">No payments yet</h3>
            <p className="mt-1 text-sm text-muted-foreground">When a payment is sent to you it appears here.</p>
          </div>
        ) : (
          <div className="mt-4 overflow-hidden rounded-xl border border-border">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-3 sm:px-4">Paid on</th>
                    <th className="px-3 py-3 text-right sm:px-4">Amount</th>
                    <th className="px-3 py-3 sm:px-4">Method</th>
                    <th className="px-3 py-3 sm:px-4">Reference</th>
                  </tr>
                </thead>
                <tbody>
                  {data.payouts.map((x) => (
                    <tr key={x.id} className="border-t border-border bg-card/30">
                      <td className="whitespace-nowrap px-3 py-3 sm:px-4">{payoutDate(x.paid_on)}</td>
                      <td className="px-3 py-3 text-right font-semibold text-foreground sm:px-4">{moneyOrDash(x.amount)}</td>
                      <td className="px-3 py-3 sm:px-4">{x.method || "—"}</td>
                      <td className="break-all px-3 py-3 text-muted-foreground sm:px-4">{x.reference || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <CommissionReport />

      <div>
        <h2 className="text-lg font-semibold text-foreground">Your signups</h2>
        {data.signups.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-border bg-card/40 py-14 text-center">
            <h3 className="font-semibold text-foreground">No signups yet</h3>
            <p className="mt-1 text-sm text-muted-foreground">Share your link and people who register through it appear here.</p>
          </div>
        ) : (
          <div className="mt-4 overflow-hidden rounded-xl border border-border">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-3 sm:px-4">User</th>
                    <th className="px-3 py-3 sm:px-4">Status</th>
                    <th className="px-3 py-3 sm:px-4">Signed up</th>
                    <th className="px-3 py-3 text-right sm:px-4">Calls</th>
                    <th className="px-3 py-3 text-right sm:px-4">Minutes</th>
                    <th className="px-3 py-3 text-right sm:px-4">Billed</th>
                    <th className="px-3 py-3 sm:px-4">Last call</th>
                    <th className="px-3 py-3 sm:px-4" />
                  </tr>
                </thead>
                <tbody>
                  {data.signups.map((s) => (
                    <tr key={s.user_id} className="border-t border-border bg-card/30">
                      <td className="px-3 py-3 sm:px-4">
                        <div className="break-all font-medium text-foreground">{s.email}</div>
                        {s.full_name && <div className="text-xs text-muted-foreground">{s.full_name}</div>}
                      </td>
                      <td className="px-3 py-3 sm:px-4">
                        <Badge variant={s.status === "verified" ? "default" : "secondary"}>{s.status === "verified" ? "Verified" : "Pending"}</Badge>
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-muted-foreground sm:px-4">{new Date(s.created_at).toLocaleDateString()}</td>
                      <td className="px-3 py-3 text-right sm:px-4">{s.calls}</td>
                      <td className="px-3 py-3 text-right sm:px-4">{s.minutes}</td>
                      <td className="px-3 py-3 text-right sm:px-4">{moneyOrDash(s.billed)}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-muted-foreground sm:px-4">{s.last_call ? timeAgo(s.last_call) : "—"}</td>
                      <td className="px-3 py-3 text-right sm:px-4">
                        <Button
                          size="sm" variant="outline" className="gap-1.5"
                          disabled={data.status !== "active" || viewing !== null}
                          onClick={() => viewAs(s.user_id, s.email)}
                        >
                          {viewing === s.user_id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />} View as
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <ActivityFeed load={api.getPartnerActivity} />
    </div>
  );
};

export default Partner;
