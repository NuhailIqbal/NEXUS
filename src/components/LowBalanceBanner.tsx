/**
 * Wallet warning banner at the top of the dashboard <main> (DashboardLayout). Polls
 * GET /billing/status (api.getBillingStatus) for the prepaid wallet balance and links to the
 * Billing page. Team members see the account owner's balance, because the backend resolves the owner.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { api } from "@/services/api";

/**
 * Persistent low-balance / paywall banner. Shows when the wallet balance is at or below
 * $10, with a stronger "credit used up" state at $0 and a CTA to Add Funds.
 */
const LowBalanceBanner = () => {
  const [balance, setBalance] = useState<number | null>(null);

  useEffect(() => {
    // `on` stops a late response from updating state after unmount. A failed request (data is
    // null) leaves the last known balance in place. The response is untyped, hence the cast.
    let on = true;
    const load = () =>
      api.getBillingStatus().then(({ data }) => {
        if (on && data) setBalance(Number((data as any).balance ?? 0));
      });
    load();
    // Poll so the banner appears or clears shortly after a call is charged or funds are added.
    const t = setInterval(load, 30000);
    return () => { on = false; clearInterval(t); };
  }, []);

  // Hidden until the first successful load (null) and while the balance is above $10, the
  // highest of the low-balance alert thresholds the backend billing router notifies at.
  if (balance === null || balance > 10) return null;
  const empty = balance <= 0;

  return (
    <div
      className={`mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm ${
        empty
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-yellow-500/40 bg-yellow-500/10 text-yellow-600 dark:text-yellow-400"
      }`}
    >
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span>
          {empty ? "Your credit is used up." : `Low balance: $${balance.toFixed(2)} left.`}{" "}
          Add funds to keep making calls without interruption.
        </span>
      </div>
      <Link
        to="/dashboard/billing"
        className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90"
      >
        Add Funds
      </Link>
    </div>
  );
};

export default LowBalanceBanner;
