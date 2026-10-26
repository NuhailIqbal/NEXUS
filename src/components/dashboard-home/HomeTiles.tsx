/**
 * The six headline tiles of the dashboard home: calls, answered rate, qualified leads, talk time, spend and cost per
 * qualified lead. Each has an icon, the big number, a pill with the change against the equally long range before it
 * (green when that is good news, red when not, plain when unchanged) and a sparkline of the days. Presentational: the
 * numbers arrive ready from GET /dashboard/overview. Until they do each tile is a skeleton; a figure the server could
 * not work out shows "—", never 0.
 */
import type { ComponentType } from "react";
import { ArrowDownRight, ArrowUpRight, Clock, DollarSign, Minus, PhoneCall, Target, TrendingDown, UserCheck } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatInt, formatPct, trendIsGood } from "@/lib/callConsumption";
import {
  changeParts, dayCostPerQualified, dayRate, formatMinutes, type RangeKey, type Tiles, type TrendPoint,
} from "@/lib/dashboardOverview";
import { moneyOrDash, NOT_AVAILABLE } from "@/lib/leadRoi";
import { Sparkline, type SparkPoint } from "./Sparkline";
import { useChartColors } from "./useChartColors";

type TileProps = {
  id: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  value: string;
  note?: string;
  change: { delta: number | null | undefined; unit: string; higherIsBetter: boolean };
  spark: SparkPoint[];
  sparkFormat: (v: number) => string;
  tiles: Tiles | null;
  range: RangeKey;
  /** Length of the range in days (names the comparison period of a custom range). */
  days?: number;
  loading: boolean;
  color: string;
};

function Tile({ id, label, icon: Icon, value, note, change, spark, sparkFormat, tiles, range, days, loading, color }: TileProps) {
  const parts = tiles?.has_previous ? changeParts(change.delta, change.unit, range, days) : null;
  const neutral = !parts || parts.delta === 0;
  const good = !neutral && trendIsGood(parts!.delta, change.higherIsBetter);
  return (
    <div className="group relative min-w-0 overflow-hidden rounded-2xl border border-border bg-card p-4 transition hover:border-primary/40 hover:shadow-lg hover:shadow-primary/5">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 text-xs font-medium uppercase leading-tight tracking-wide text-muted-foreground">{label}</span>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Icon className="h-4 w-4" /></span>
      </div>
      {loading ? (
        <div className="mt-3 space-y-2" data-testid="kpi-loading">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : (
        <>
          <div className="mt-2 truncate text-3xl font-bold tracking-tight text-foreground" title={value}>{value}</div>
          <div className="mt-1.5 flex min-h-[22px] flex-wrap items-center gap-x-2 gap-y-1">
            {parts ? (
              <>
                <span
                  className={cn(
                    "inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-semibold",
                    neutral ? "bg-muted text-muted-foreground" : good ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive",
                  )}
                  title={`${parts.text} ${parts.caption}`}
                >
                  {neutral ? <Minus className="h-3 w-3" /> : parts.delta > 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                  {parts.text.replace(/^[+-]/, "")}
                </span>
                <span className="text-xs text-muted-foreground">{parts.caption}</span>
              </>
            ) : (
              <span className="text-xs text-muted-foreground">{note ?? ""}</span>
            )}
          </div>
          <div className="-mx-1 mt-2"><Sparkline id={id} points={spark} color={color} format={sparkFormat} /></div>
        </>
      )}
    </div>
  );
}

export function HomeTiles({ tiles, trend, range, days, loading }: { tiles: Tiles | null; trend: TrendPoint[]; range: RangeKey; days?: number; loading: boolean }) {
  const t = tiles;
  const colors = useChartColors();
  const series = (pick: (p: TrendPoint) => number | null): SparkPoint[] => trend.map((p) => ({ date: p.date, value: pick(p) }));
  const none = t && !t.has_data;
  const rate = t?.answered_rate;
  const common = { tiles: t, range, days, loading, color: colors.calls };

  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 2xl:grid-cols-6" data-testid="home-tiles">
      <Tile {...common} id="calls" label="Calls made" icon={PhoneCall} value={formatInt(t?.calls.value)}
            note={none ? "No calls in this period" : undefined} change={{ delta: t?.calls.change_pct, unit: "%", higherIsBetter: true }}
            spark={series((p) => p.calls)} sparkFormat={(v) => `${formatInt(v)} calls`} />
      <Tile {...common} id="answered" label="Answered rate" icon={UserCheck} value={rate?.value == null ? NOT_AVAILABLE : formatPct(rate.value)}
            note={rate && rate.finished > 0 ? `${formatInt(rate.answered)} of ${formatInt(rate.finished)} finished calls` : none ? "No finished calls yet" : undefined}
            change={{ delta: rate?.change_pts, unit: " pts", higherIsBetter: true }}
            spark={series(dayRate)} sparkFormat={(v) => formatPct(v)} />
      <Tile {...common} id="qualified" label="Qualified leads" icon={Target} value={formatInt(t?.qualified_leads.value)}
            note={t ? `${formatInt(t.leads.value)} leads in all` : undefined} change={{ delta: t?.qualified_leads.change_pct, unit: "%", higherIsBetter: true }}
            spark={series((p) => p.qualified_leads)} sparkFormat={(v) => `${formatInt(v)} qualified`} />
      <Tile {...common} id="minutes" label="Talk time" icon={Clock} value={formatMinutes(t?.minutes.value)}
            change={{ delta: t?.minutes.change_pct, unit: "%", higherIsBetter: true }}
            spark={series((p) => p.minutes)} sparkFormat={formatMinutes} />
      <Tile {...common} id="spend" label="Spend" icon={DollarSign} value={moneyOrDash(t?.spend.value)}
            change={{ delta: t?.spend.change_pct, unit: "%", higherIsBetter: false }}
            spark={series((p) => p.spend)} sparkFormat={(v) => moneyOrDash(v)} />
      <Tile {...common} id="cpql" label="Cost per qualified lead" icon={TrendingDown} value={moneyOrDash(t?.cost_per_qualified_lead.value)}
            note={t && t.cost_per_qualified_lead.value === null ? "No qualified leads in this period" : undefined}
            change={{ delta: t?.cost_per_qualified_lead.change_pct, unit: "%", higherIsBetter: false }}
            spark={series(dayCostPerQualified)} sparkFormat={(v) => moneyOrDash(v)} />
    </div>
  );
}
