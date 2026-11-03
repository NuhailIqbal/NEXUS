/**
 * Live feed of what referred users are doing (signed up, verified, added funds, created an agent, made a call).
 * Used on the partner's own page and in the admin portal; the caller supplies the loader (partner or admin endpoint).
 * Re-polls every few seconds while the browser tab is visible; no websocket is involved.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, Bot, CheckCircle2, DollarSign, Loader2, Phone, UserPlus } from "lucide-react";
import { cn } from "@/lib/utils";
import { activityText, timeAgo, type ActivityItem, type ActivityKind } from "@/lib/partners";

const ICONS: Record<ActivityKind, typeof Activity> = {
  signup: UserPlus, verified: CheckCircle2, funds: DollarSign, agent: Bot, call: Phone,
};

type Props = {
  /** Fetches the newest items, newest first (api.getPartnerActivity / api.getAdminPartnerActivity). */
  load: () => Promise<{ data: ActivityItem[] | null; error: string | null }>;
  /** Show which partner each user belongs to (admin view across all partners). */
  showPartner?: boolean;
  intervalMs?: number;
};

export default function ActivityFeed({ load, showPartner = false, intervalMs = 5000 }: Props) {
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  // Re-render every poll (even with identical data) so the "5m ago" labels keep moving.
  const [, setTick] = useState(0);
  // Always call the latest loader without restarting the interval when the parent re-renders.
  const loadRef = useRef(load);
  loadRef.current = load;

  const refresh = useCallback(async () => {
    const { data, error } = await loadRef.current();
    if (Array.isArray(data) && !error) {
      setItems(data);
      setFailed(false);
    } else {
      setFailed(true);
    }
    setTick((n) => n + 1);
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(() => {
      if (!document.hidden) refresh();
    }, intervalMs);
    return () => clearInterval(id);
  }, [refresh, intervalMs]);

  return (
    <div className="rounded-xl border border-border bg-card/40">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-lg font-semibold text-foreground">Live activity</h2>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="relative flex h-2 w-2">
            <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-60", failed ? "bg-destructive" : "bg-green-500")} />
            <span className={cn("relative inline-flex h-2 w-2 rounded-full", failed ? "bg-destructive" : "bg-green-500")} />
          </span>
          {failed ? "Connection problem, retrying" : "Live"}
        </span>
      </div>
      {items === null ? (
        <div className="flex items-center justify-center py-10 text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : items.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-muted-foreground">
          Nothing yet. Activity from people who sign up through the link shows up here as it happens.
        </p>
      ) : (
        <ul className="max-h-[28rem] divide-y divide-border overflow-y-auto">
          {items.map((i) => {
            const Icon = ICONS[i.kind] ?? Activity;
            return (
              <li key={i.id} className="flex items-start gap-3 px-4 py-3 text-sm">
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <span className="break-all font-medium text-foreground">{i.email || "A user"}</span>{" "}
                  <span className="text-muted-foreground">{activityText(i)}</span>
                  {showPartner && i.partner_name && (
                    <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{i.partner_name}</span>
                  )}
                </div>
                <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">{timeAgo(i.at)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
