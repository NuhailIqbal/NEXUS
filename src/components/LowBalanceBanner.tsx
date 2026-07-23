import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { api } from "@/services/api";

/**
 * Persistent low-balance / paywall banner. Shows when the wallet balance is at or below
 * $10, with a stronger "credit used up" state at $0 and CTAs to Subscribe / Add Funds.
 */
const LowBalanceBanner = () => {
  const [balance, setBalance] = useState<number | null>(null);

  useEffect(() => {
    let on = true;
    const load = () =>
      api.getBillingStatus().then(({ data }) => {
        if (on && data) setBalance(Number((data as any).balance ?? 0));
      });
    load();
    const t = setInterval(load, 30000);
    return () => { on = false; clearInterval(t); };
  }, []);

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
          {empty ? "Your credit is used up." : `Low balance — $${balance.toFixed(2)} left.`}{" "}
          Add funds or subscribe to keep making calls without interruption.
        </span>
      </div>
      <Link
        to="/dashboard/billing"
        className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90"
      >
        {empty ? "Subscribe or Add Funds" : "Add Funds"}
      </Link>
    </div>
  );
};

export default LowBalanceBanner;
