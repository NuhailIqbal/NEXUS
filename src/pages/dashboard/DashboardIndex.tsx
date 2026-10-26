/**
 * Dashboard home (route /dashboard): "how is my calling doing right now?" at a glance. One request
 * (GET /dashboard/overview) feeds everything: headline tiles for Today (the default) / 7 days / 30 days against the range before, a
 * daily trend, the running campaigns (pause / resume), the latest conversations and,
 * for an account that cannot take calls yet, a first-steps card that leads to Quick Setup. The numbers are the Cost per
 * Lead and Call Consumption reports' own (see services/dashboard_overview.py).
 *
 * The page refreshes itself every minute without blanking. Switching the range keeps the old numbers on screen
 * (dimmed) until the new ones arrive. Viewers see everything; pause / resume are hidden for them (the server refuses it
 * anyway). A failed first load shows an error with Retry, never a half-empty page.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";
import { SectionCard } from "@/components/call-consumption/SectionCard";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AttentionList, CampaignsCard, RecentCallsCard } from "@/components/dashboard-home/HomePanels";
import { FunnelCard } from "@/components/dashboard-home/FunnelCard";
import { HomeTiles } from "@/components/dashboard-home/HomeTiles";
import { LiveStrip } from "@/components/dashboard-home/LiveStrip";
import { HomeTrend } from "@/components/dashboard-home/HomeTrend";
import { SetupChecklist } from "@/components/dashboard-home/SetupChecklist";
import { TopLists } from "@/components/dashboard-home/TopLists";
import { DateField } from "@/components/call-consumption/FilterBar";
import { browserTimeZone, rangeDays, rangeError, ymd } from "@/lib/callConsumption";
import { useAuth } from "@/contexts/AuthContext";
import {
  LIVE_REFRESH_MS, RANGES, ROUTES, chartIsEmpty, chartPoints, customPresets, firstName, greeting,
  type CampaignItem, type CustomRange, type DashboardOverview, type LiveData, type RangeKey,
} from "@/lib/dashboardOverview";
import { api } from "@/services/api";
import { cn } from "@/lib/utils";

const REFRESH_MS = 60_000;

/**
 * Loads the overview for `range` (and, for "custom", its From..To); keeps the last answer while a new one loads, and
 * refreshes quietly on a timer.
 */
function useOverview(range: RangeKey, custom: CustomRange) {
  const [data, setData] = useState<DashboardOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const tz = useRef(browserTimeZone()).current;

  const load = useCallback((quiet: boolean) => {
    const mine = ++latest.current;
    if (!quiet) setLoading(true);
    return (range === "custom" ? api.getDashboardOverview(range, tz, { from: custom.from, to: custom.to }) : api.getDashboardOverview(range, tz))
      .then(({ data: d, error: e }) => {
        // A newer request was started meanwhile: this answer is stale.
        if (mine !== latest.current) return;
        if (e || !d) {
          const message = typeof e === "string" && e ? e : "Failed to load the dashboard. Please try again.";
          // A failed quiet refresh keeps the numbers on screen; only a load the person is waiting for reports an error.
          if (!quiet) {
            setError(message);
            toast.error(message);
          }
        } else {
          setData(d as DashboardOverview);
          setError(null);
        }
      })
      .catch(() => {
        if (mine !== latest.current || quiet) return;
        const message = "Failed to load the dashboard. Please try again.";
        setError(message);
        toast.error(message);
      })
      .finally(() => {
        if (mine === latest.current) setLoading(false);
      });
  }, [range, tz, custom.from, custom.to]);

  useEffect(() => {
    void load(false);
    const timer = setInterval(() => void load(true), REFRESH_MS);
    return () => {
      clearInterval(timer);
      // A plain counter, not a DOM ref: bumping it drops an answer that arrives after we left.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      latest.current++;
    };
  }, [load]);

  return { data, loading, error, reload: () => void load(false), refresh: () => load(true) };
}

/**
 * Calls running now and calls today: asked again every few seconds (not while the tab is hidden) and once more when the
 * tab comes back. Independent of the range. A failed poll keeps the last numbers and says nothing: it is a live ticker,
 * and the next poll is seconds away.
 */
function useLive() {
  const [live, setLive] = useState<LiveData | null>(null);
  const tz = useRef(browserTimeZone()).current;

  useEffect(() => {
    let alive = true;
    const poll = () => {
      if (document.visibilityState === "hidden") return;
      api.getDashboardLive(tz)
        .then(({ data, error }) => { if (alive && data && !error) setLive(data as LiveData); })
        .catch(() => undefined);
    };
    poll();
    const timer = setInterval(poll, LIVE_REFRESH_MS);
    document.addEventListener("visibilitychange", poll);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [tz]);

  return live;
}

const DashboardIndex = () => {
  const { user } = useAuth();
  const [range, setRange] = useState<RangeKey>("today");
  // The dates being typed (draft) become the applied range only once they make sense, so a half-typed date never fetches.
  const [draft, setDraft] = useState<CustomRange>(() => { const now = new Date(); return { from: ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6)), to: ymd(now) }; });
  const [applied, setApplied] = useState<CustomRange>(draft);
  const dateProblem = !draft.from || !draft.to ? "Pick both a start and an end date." : rangeError(draft.from, draft.to);
  const editDates = (next: CustomRange) => {
    setDraft(next);
    if (next.from && next.to && !rangeError(next.from, next.to)) setApplied(next);
  };
  const { data, loading, error, reload, refresh } = useOverview(range, applied);
  const live = useLive();
  const [canManage, setCanManage] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Owners and Members may pause / resume; Viewers are read-only.
  useEffect(() => {
    api.getMyRole()
      .then(({ data: r }) => {
        const role = r as { is_owner?: boolean; role?: string } | null;
        setCanManage(!!role && (role.is_owner === true || role.role !== "viewer"));
      })
      .catch(() => undefined);
  }, []);

  const toggleCampaign = async (c: CampaignItem) => {
    setBusyId(c.id);
    const pausing = c.status === "Active";
    try {
      const { error: e } = pausing ? await api.pauseCampaign(c.id) : await api.resumeCampaign(c.id);
      if (e) toast.error(typeof e === "string" ? e : `Could not ${pausing ? "pause" : "resume"} ${c.name}.`);
      else toast.success(pausing ? `${c.name} paused.` : `${c.name} resumed.`);
      await refresh();
    } catch {
      toast.error(`Could not ${pausing ? "pause" : "resume"} ${c.name}.`);
    } finally {
      setBusyId(null);
    }
  };

  const first = loading && !data;       // nothing to show yet
  const failed = !!error && !data;      // first load failed
  const stale = loading && !!data;      // range switched: old numbers stay, dimmed
  const d = data;

  const name = firstName(user?.user_metadata?.full_name);
  const days = d ? rangeDays(d.from, d.to) : undefined;
  const points = d ? chartPoints(d) : [];
  const byHour = d?.chart.granularity === "hour";

  return (
    <div className="space-y-6">
      <header className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-primary/15 via-card to-card p-5 sm:p-6">
        <div className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-primary/15 blur-3xl" aria-hidden="true" />
        <div className="relative flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
              {greeting()}{name ? `, ${name}` : ""}
            </h1>
          </div>
          {/* The range switch, with the From / To dates right beside it when Custom is chosen. On wide screens it sits at the right of the greeting, below it otherwise. */}
          <div className="flex flex-wrap items-end gap-3 xl:justify-end">
            <Tabs value={range} onValueChange={(v) => setRange(v as RangeKey)}>
              <TabsList aria-label="Date range" className="bg-background/60 backdrop-blur">
                {RANGES.map((r) => <TabsTrigger key={r.value} value={r.value}>{r.label}</TabsTrigger>)}
              </TabsList>
            </Tabs>
            {range === "custom" && (
              <div className="flex flex-wrap items-end gap-3" data-testid="custom-range">
                <DateField label="From" className="w-36 min-w-0 flex-none" value={draft.from} onChange={(v) => editDates({ ...draft, from: v })} />
                <DateField label="To" className="w-36 min-w-0 flex-none" value={draft.to} onChange={(v) => editDates({ ...draft, to: v })} />
              </div>
            )}
          </div>
        </div>
        {range === "custom" && (
          <div className="relative mt-4 flex flex-wrap gap-2 xl:justify-end" role="group" aria-label="Quick date ranges" data-testid="custom-presets">
            {customPresets().map((p) => {
              const on = draft.from === p.from && draft.to === p.to;
              return (
                <Button key={p.key} type="button" size="sm" variant={on ? "default" : "outline"} className="rounded-full"
                        aria-pressed={on} onClick={() => editDates({ from: p.from, to: p.to })}>
                  {p.label}
                </Button>
              );
            })}
          </div>
        )}
        {range === "custom" && dateProblem && (
          <p role="alert" className="relative mt-3 text-sm text-destructive xl:text-right">{dateProblem}</p>
        )}
      </header>

      {!failed && <LiveStrip live={live} data={d} loading={first} />}

      {failed ? (
        <div role="alert" className="flex flex-col items-start gap-2 rounded-2xl border border-border bg-card p-5 text-sm text-destructive">
          <span className="flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> {error}</span>
          <Button size="sm" variant="outline" onClick={reload}>Retry</Button>
        </div>
      ) : (
        <div className={cn("space-y-6 transition-opacity", stale && "opacity-60")} aria-busy={loading}>
          {d && <AttentionList data={d} />}
          {d && !d.setup.complete && <SetupChecklist setup={d.setup} />}

          <HomeTiles tiles={d?.tiles ?? null} trend={d?.trend ?? []} range={range} days={days} loading={first} />

          <div className="grid gap-6 lg:grid-cols-3">
            <SectionCard
              className="rounded-2xl lg:col-span-2"
              title="Calls and qualified leads"
              subtitle={`Each ${byHour ? "hour" : "day"}, in your time zone.`}
              loading={first}
              empty={!!d && chartIsEmpty(points)}
              emptyText="No calls in this period yet."
              minHeight={320}
              actions={<Link to={ROUTES.leadRoi} className="text-sm font-medium text-primary hover:underline">Cost per Lead report</Link>}
            >
              {d && <HomeTrend points={points} />}
            </SectionCard>
            <FunnelCard tiles={d?.tiles ?? null} loading={first} />
          </div>

          <TopLists tops={d?.tops ?? null} loading={first} />

          <div className="grid gap-6 lg:grid-cols-2">
            <CampaignsCard
              campaigns={d?.campaigns ?? { counts: { active: 0, paused: 0, inactive: 0 }, items: [] }}
              loading={first} canManage={canManage} busyId={busyId} onToggle={toggleCampaign}
            />
            <RecentCallsCard calls={d?.recent_calls ?? []} loading={first} />
          </div>
        </div>
      )}
    </div>
  );
};

export default DashboardIndex;
