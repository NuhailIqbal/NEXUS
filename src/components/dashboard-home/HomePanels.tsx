/**
 * The panels of the dashboard home: what needs attention, the running campaigns (with pause / resume) and the latest
 * calls. All presentational; the page owns the data and the pause / resume calls.
 * Anything that is not ready shows a plain sentence, never a blank card.
 */
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { SectionCard } from "@/components/call-consumption/SectionCard";
import { formatInt } from "@/lib/callConsumption";
import { stallMessage } from "@/lib/dialingStrategy";
import {
  ROUTES, buildAlerts, formatDuration, progressPct,
  type CampaignItem, type DashboardOverview, type RecentCall,
} from "@/lib/dashboardOverview";
import { cn } from "@/lib/utils";

/** Things that are wrong or waiting right now. Renders nothing when all is well. */
export function AttentionList({ data }: { data: Pick<DashboardOverview, "campaigns"> }) {
  const alerts = buildAlerts(data);
  if (alerts.length === 0) return null;
  return (
    <section aria-label="Needs attention" className="space-y-2" data-testid="attention-list">
      {alerts.map((a) => (
        <div
          key={a.key}
          role="alert"
          className={cn(
            "flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm text-foreground",
            a.level === "error" ? "border-destructive/40 bg-destructive/5" : "border-warning/40 bg-warning/5",
          )}
        >
          <span className="flex min-w-0 items-start gap-2">
            <AlertTriangle className={cn("mt-0.5 h-4 w-4 shrink-0", a.level === "error" ? "text-destructive" : "text-warning")} />
            <span className="min-w-0 break-words">{a.text}</span>
          </span>
          <Link to={a.to} className="shrink-0 font-medium text-primary hover:underline">{a.action}</Link>
        </div>
      ))}
    </section>
  );
}

/** One line under a campaign's name: what the dialer is doing, or why it is not. */
function campaignNote(c: CampaignItem): string {
  if (c.status === "Paused") return c.waiting_for_hours ? "Waiting for calling hours to open, then continues by itself." : "Paused.";
  const stall = stallMessage(c.stall_reason);
  if (stall) return stall;
  if (c.state === "waiting_hours") return "Outside calling hours. It continues when they open.";
  if (c.active_now > 0) return `${formatInt(c.active_now)} call${c.active_now === 1 ? "" : "s"} in progress.`;
  if (c.state === "waiting_redials") return "Waiting to redial numbers that did not answer.";
  return "Ready.";
}

export function CampaignsCard({
  campaigns, loading, canManage, busyId, onToggle,
}: {
  campaigns: DashboardOverview["campaigns"];
  loading: boolean;
  canManage: boolean;
  busyId: string | null;
  onToggle: (c: CampaignItem) => void;
}) {
  const { counts, items } = campaigns;
  return (
    <SectionCard
      className="h-full rounded-2xl"
      title="Campaigns"
      subtitle={loading ? undefined : `${counts.active} active, ${counts.paused} paused`}
      loading={loading}
      empty={items.length === 0}
      emptyText="No active campaigns yet."
      actions={<Link to={ROUTES.campaigns} className="text-sm font-medium text-primary hover:underline">All campaigns</Link>}
    >
      <ul className="space-y-3" data-testid="campaign-list">
        {items.map((c) => {
          const pct = progressPct(c);
          const active = c.status === "Active";
          const dialing = active && c.active_now > 0;
          return (
            <li key={c.id} className="rounded-xl border border-border bg-muted/20 p-3 transition hover:border-primary/30">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <div className="min-w-0 flex-1 basis-48">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden="true">
                      {dialing && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />}
                      <span className={cn("relative inline-flex h-2.5 w-2.5 rounded-full", active ? "bg-success" : "bg-warning")} />
                    </span>
                    <Link to={ROUTES.campaigns} className="truncate font-semibold text-foreground hover:underline" title={c.name}>{c.name}</Link>
                    <StatusBadge status={c.status} />
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{campaignNote(c)}</p>
                </div>
                {canManage && (
                  <Button size="sm" variant="outline" className="rounded-full" disabled={busyId === c.id} onClick={() => onToggle(c)}
                          aria-label={`${active ? "Pause" : "Resume"} ${c.name}`}>
                    {active ? <Pause className="mr-1 h-3.5 w-3.5" /> : <Play className="mr-1 h-3.5 w-3.5" />}
                    {active ? "Pause" : "Resume"}
                  </Button>
                )}
              </div>
              <div className="mt-3 flex items-center gap-3">
                <Progress value={pct} className="h-2 flex-1" aria-label={`${c.name} progress`} />
                <span className="shrink-0 text-xs font-medium tabular-nums text-foreground">{pct}%</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{formatInt(c.completed_count)} / {formatInt(c.contacts_count)} reached</p>
            </li>
          );
        })}
      </ul>
    </SectionCard>
  );
}

const callTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";

/** Up to two letters for the avatar: "Pat Smith" -> "PS", a bare number -> "#". */
const initials = (c: RecentCall) => {
  const letters = (c.contact_name ?? "").split(/\s+/).filter((w) => /^[A-Za-z]/.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
  return letters || "#";
};

export function RecentCallsCard({ calls, loading }: { calls: RecentCall[]; loading: boolean }) {
  return (
    <SectionCard
      className="h-full rounded-2xl"
      title="Recent conversations"
      loading={loading}
      empty={calls.length === 0}
      emptyText="No conversations yet. They will show up here as soon as a call happens."
      actions={<Link to={ROUTES.conversations} className="text-sm font-medium text-primary hover:underline">View all</Link>}
    >
      <ul className="space-y-1" data-testid="recent-calls">
        {calls.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-2 py-2 transition hover:bg-muted/40">
            <span className="relative shrink-0">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{initials(c)}</span>
              <span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full border border-card bg-muted text-muted-foreground"
                    title={c.direction === "inbound" ? "Inbound" : "Outbound"}>
                {c.direction === "inbound" ? <ArrowDownLeft className="h-2.5 w-2.5" /> : <ArrowUpRight className="h-2.5 w-2.5" />}
              </span>
            </span>
            <div className="min-w-0 flex-1 basis-40">
              <div className="truncate text-sm font-medium text-foreground">{c.contact_name || c.phone || "Unknown caller"}</div>
              <div className="truncate text-xs text-muted-foreground">
                {[c.campaign_name || c.agent_name, callTime(c.call_time)].filter(Boolean).join(" · ")}
              </div>
            </div>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatDuration(c.duration_seconds)}</span>
            {c.qualified && <span className="shrink-0 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-xs font-medium text-success">Qualified</span>}
            <StatusBadge status={c.status} className="shrink-0" />
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
