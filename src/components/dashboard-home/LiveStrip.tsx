/**
 * The strip under the greeting: what is happening right now and what the account has set up, whatever date range the
 * tiles below show. Two cards: "right now" (calls running now, pulsing while any are, and calls today; from
 * GET /dashboard/live, which the page polls every few seconds) and "your setup" (agents, outbound campaigns and inbound
 * receptionists; from the overview). Each count but "running now" links to where it is managed. Presentational; a
 * figure that has not arrived shows a skeleton or a dash, never a fake 0.
 */
import type { ComponentType } from "react";
import { Link } from "react-router-dom";
import { Activity, Bot, PhoneCall, PhoneIncoming, PhoneOutgoing } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatInt } from "@/lib/callConsumption";
import { runningSub, ROUTES, type DashboardOverview, type LiveData } from "@/lib/dashboardOverview";
import { NOT_AVAILABLE } from "@/lib/leadRoi";

type Cell = {
  id: string;
  label: string;
  value: string;
  sub?: string;
  icon: ComponentType<{ className?: string }>;
  to?: string;
  /** Pulse the icon (calls are running). */
  live?: boolean;
  loading?: boolean;
};

function StripCell({ id, label, value, sub, icon: Icon, to, live, loading }: Cell) {
  const body = (
    <>
      <span className={cn("relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", live ? "bg-success/15 text-success" : "bg-primary/10 text-primary")}>
        {live && <span className="absolute inset-0 animate-ping rounded-xl bg-success/20" aria-hidden="true" />}
        <Icon className="relative h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-medium uppercase leading-tight tracking-wide text-muted-foreground">{label}</span>
        {loading ? (
          <Skeleton className="mt-1 h-6 w-16" />
        ) : (
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-2xl font-bold leading-tight tracking-tight text-foreground" data-testid={`strip-${id}-value`}>{value}</span>
            {sub && <span className="text-xs text-muted-foreground" data-testid={`strip-${id}-sub`}>{sub}</span>}
          </span>
        )}
      </span>
    </>
  );
  const cell = "flex min-w-0 items-center gap-3 px-4 py-3";
  return to ? (
    <Link to={to} className={cn(cell, "transition hover:bg-muted/40")} data-testid={`strip-${id}`}>{body}</Link>
  ) : (
    <div className={cell} data-testid={`strip-${id}`}>{body}</div>
  );
}

const card = "overflow-hidden rounded-2xl border border-border bg-card";

export function LiveStrip({ live, data, loading }: { live: LiveData | null; data: DashboardOverview | null; loading: boolean }) {
  const inv = data?.inventory;
  const counts = data?.campaigns.counts;
  const campaignsTotal = counts ? counts.active + counts.paused + counts.inactive : null;
  const running = live?.running_now;
  const today = live?.calls_today;
  const waiting = loading && !data;
  return (
    <section aria-label="Right now" className="grid gap-3 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]" data-testid="live-strip">
      <div className={cn(card, "grid grid-cols-1 divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0")} aria-label="Right now">
        <StripCell id="running" label="Calls running now" icon={Activity} live={(running?.total ?? 0) > 0} loading={!live}
                   value={running ? formatInt(running.total) : NOT_AVAILABLE} sub={running ? runningSub(running) : undefined} />
        <StripCell id="today" label="Calls today" icon={PhoneCall} to={ROUTES.conversations} loading={!live}
                   value={today ? formatInt(today.total) : NOT_AVAILABLE} sub={today ? `${formatInt(today.answered)} answered` : undefined} />
      </div>
      <div className={cn(card, "grid grid-cols-1 divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0")} aria-label="Your setup">
        <StripCell id="agents" label="Agents" icon={Bot} to={ROUTES.agents} loading={waiting}
                   value={inv ? formatInt(inv.agents.total) : NOT_AVAILABLE} sub={inv ? `${formatInt(inv.agents.active)} active` : undefined} />
        <StripCell id="outbound" label="Outbound campaigns" icon={PhoneOutgoing} to={ROUTES.campaigns} loading={waiting}
                   value={campaignsTotal === null ? NOT_AVAILABLE : formatInt(campaignsTotal)} sub={counts ? `${formatInt(counts.active)} running` : undefined} />
        <StripCell id="inbound" label="Inbound receptionists" icon={PhoneIncoming} to={ROUTES.receptionists} loading={waiting}
                   value={inv ? formatInt(inv.receptionists.total) : NOT_AVAILABLE} sub={inv ? `${formatInt(inv.receptionists.active)} active` : undefined} />
      </div>
    </section>
  );
}
