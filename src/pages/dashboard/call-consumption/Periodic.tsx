/**
 * Reports > Weekly & Monthly (route call-consumption/periodic): the same consumed-vs-dropped numbers as the Overview,
 * one row per week (Sunday-start) or calendar month, each compared with the period before it. ONE page with a Weekly
 * and a Monthly tab; the filters sit above the tabs and apply to whichever is open. Three independent pieces come from ONE endpoint
 * (/call-consumption/period/<granularity>): the headline cards, the trend charts and the table, so they can never
 * disagree. A period the chosen range cuts (or that is still running) is marked "partial": its figures cover only part
 * of it, so its change against the previous period is not a like-for-like comparison.
 */
import { useMemo, useState } from "react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ComboChart, DispositionStacked, type ComboRow, type DispositionRow } from "@/components/call-consumption/Charts";
import { ConsumptionTable } from "@/components/call-consumption/ConsumptionTable";
import { ExportButton } from "@/components/call-consumption/ExportButton";
import { FilterBar } from "@/components/call-consumption/FilterBar";
import { KpiCard } from "@/components/call-consumption/KpiCard";
import { SectionCard } from "@/components/call-consumption/SectionCard";
import { useSection } from "@/components/call-consumption/useSection";
import {
  BUCKET_LABELS, DROP_BUCKETS, defaultFilters, findPreset, formatDelta, formatInt, formatPct, periodPresets, type CCFilters,
  type TreeRow,
} from "@/lib/callConsumption";

type Granularity = "weekly" | "monthly";
type PeriodReport = { has_data: boolean; granularity: Granularity; rows: TreeRow[]; total: TreeRow };

const COPY: Record<Granularity, { title: string; blurb: string; noun: string; column: string; file: string }> = {
  weekly: {
    title: "Weekly Report",
    blurb: "Consumed vs dropped calls for each week (Sunday to Saturday), compared with the week before.",
    noun: "week",
    column: "Week",
    file: "WeeklyCallConsumptionReport.csv",
  },
  monthly: {
    title: "Monthly Report",
    blurb: "Consumed vs dropped calls for each calendar month, compared with the month before.",
    noun: "month",
    column: "Month",
    file: "MonthlyCallConsumptionReport.csv",
  },
};

/** One tab's content: fetches its own report for the shared, already-applied filters. */
const PeriodicBody = ({ granularity, applied }: { granularity: Granularity; applied: CCFilters }) => {
  const copy = COPY[granularity];
  const report = useSection<PeriodReport>(`/period/${granularity}`, applied, { label: `the ${granularity} report` });
  const data = report.data;
  const rows = useMemo(() => data?.rows ?? [], [data]); // stable between renders, so the charts only rebuild on new data
  const latest = rows[rows.length - 1];

  // Oldest -> newest for the charts (a timeline), newest first for the table (what people read first).
  const trend = useMemo<ComboRow[]>(
    () => rows.map((r) => ({ key: r.key ?? r.name, name: r.name, total_calls: r.total_calls, consumed_calls: r.consumed_calls,
                              dropped_calls: r.dropped_calls, drop_pct: r.drop_pct })),
    [rows],
  );
  const reasons = useMemo<DispositionRow[]>(
    () => rows.flatMap((r) => DROP_BUCKETS.filter((b) => r.buckets[b] > 0).map((b) => ({
      key: r.key ?? r.name, name: r.name, disposition: b, label: BUCKET_LABELS[b], calls: r.buckets[b],
    }))),
    [rows],
  );
  const tableRows = useMemo(() => [...rows].reverse(), [rows]);

  const dash = (v: string) => (report.error ? "—" : v);
  const noData = !!data && !data.has_data;
  const vs = (delta: number | null | undefined, unit: string) =>
    latest && delta !== null && delta !== undefined
      ? { delta, deltaText: `${formatDelta(delta)}${unit} vs previous ${copy.noun}` }
      : { sub: latest ? `No calls in the previous ${copy.noun} to compare` : undefined };

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">{copy.blurb}</p>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label={`Latest ${copy.noun}`} loading={report.loading} noData={noData} value={dash(latest?.name ?? "—")}
                 valueClassName="text-lg" sub={latest?.partial ? "Partial: still running or cut by the date range" : undefined} />
        <KpiCard label="Total calls" loading={report.loading} noData={noData} value={dash(formatInt(latest?.total_calls))}
                 {...vs(latest?.calls_change_pct, "%")} />
        <KpiCard label="Consumption" loading={report.loading} noData={noData} value={dash(formatPct(latest?.consumption_pct))}
                 sub={latest ? `${formatInt(latest.consumed_calls)} consumed` : undefined} />
        <KpiCard label="Drop rate" loading={report.loading} noData={noData} value={dash(formatPct(latest?.drop_pct))}
                 higherIsBetter={false} {...vs(latest?.drop_pct_point_change, " pts")} />
      </div>

      <SectionCard
        title="Summary"
        subtitle="Newest first. Every rate is dropped (or consumed) ÷ total for that period, not an average of the days in it."
        loading={report.loading} error={report.error} onRetry={report.reload} empty={!data?.has_data}
        actions={<ExportButton path={`/period/${granularity}/export.csv`} filename={copy.file} applied={applied} disabled={!data?.has_data} />}
      >
        {data && <ConsumptionTable rows={tableRows} total={data.total} firstColumn={copy.column} showChange />}
      </SectionCard>

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title={`Volume and drop rate by ${copy.noun}`} subtitle="Bars are dropped calls; the line is the drop rate."
                     loading={report.loading} error={report.error} onRetry={report.reload} empty={!trend.length}>
          <ComboChart rows={trend} />
        </SectionCard>
        <SectionCard title={`Why calls were dropped, by ${copy.noun}`} subtitle="Oldest on the left."
                     loading={report.loading} error={report.error} onRetry={report.reload} empty={!reasons.length} emptyText="No dropped calls">
          <DispositionStacked rows={reasons} keepOrder />
        </SectionCard>
      </div>
    </div>
  );
};

const Periodic = () => {
  const [applied, setApplied] = useState<CCFilters>(defaultFilters);
  const [tab, setTab] = useState<Granularity>("weekly");
  const [includeCurrent, setIncludeCurrent] = useState(false);
  // Date presets are whole weeks / months for the open tab, so no row at the edge of the range is cut.
  const presets = useMemo(() => periodPresets(tab, includeCurrent), [tab, includeCurrent]);

  // Flipping "include current" re-applies the preset that was in use (its end moves), instead of silently keeping old dates.
  const onIncludeCurrent = (on: boolean) => {
    const used = findPreset(presets, applied.from, applied.to);
    setIncludeCurrent(on);
    const next = used && periodPresets(tab, on).find((p) => p.value === used.value);
    if (next) setApplied({ ...applied, from: next.from, to: next.to });
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Weekly & Monthly Reports" description="Consumed vs dropped calls over time, one row per week or per month." />
      {/* Outcome is left out: filtering to one outcome makes every period 0% or 100% dropped. */}
      <FilterBar
        applied={applied}
        onApply={setApplied}
        hide={["disposition"]}
        presets={presets}
        extra={
          <div className="flex items-center gap-2">
            <Checkbox id="cc-include-current" checked={includeCurrent} onCheckedChange={(v) => onIncludeCurrent(v === true)} />
            <Label htmlFor="cc-include-current" className="cursor-pointer text-xs text-muted-foreground">
              Include the current {tab === "weekly" ? "week" : "month"} (partial)
            </Label>
          </div>
        }
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as Granularity)} className="space-y-6">
        <TabsList>
          <TabsTrigger value="weekly">Weekly</TabsTrigger>
          <TabsTrigger value="monthly">Monthly</TabsTrigger>
        </TabsList>
        {/* Only the open tab is mounted, so each fetches when first shown. */}
        <TabsContent value="weekly" className="mt-0"><PeriodicBody granularity="weekly" applied={applied} /></TabsContent>
        <TabsContent value="monthly" className="mt-0"><PeriodicBody granularity="monthly" applied={applied} /></TabsContent>
      </Tabs>
    </div>
  );
};

export default Periodic;
