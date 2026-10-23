/**
 * Call Consumption > Hourly Heatmap (route call-consumption/hourly-heatmap): when in the day calls get dropped.
 * Four independent widgets; the heatmap can be coloured by drop rate, consumption rate or call volume. Every widget, the 7 x 24
 * weekday x hour heatmap included, uses the chosen date range (all time when none is chosen); the heatmap always
 * shows all 168 cells, an hour with no calls being the palest shade.
 */
import { useState } from "react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { HourlyHeatmap, HourlyTrendChart, type HeatCell, type TrendPoint } from "@/components/call-consumption/Charts";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { HEATMAP_METRICS, type HeatmapMetric } from "@/lib/callConsumptionCharts";
import { ConsumptionTable } from "@/components/call-consumption/ConsumptionTable";
import { ExportButton } from "@/components/call-consumption/ExportButton";
import { FilterBar } from "@/components/call-consumption/FilterBar";
import { KpiCard } from "@/components/call-consumption/KpiCard";
import { SectionCard } from "@/components/call-consumption/SectionCard";
import { useSection } from "@/components/call-consumption/useSection";
import { defaultFilters, formatInt, formatPct, type CCFilters, type HourlyKpis, type SummaryResponse } from "@/lib/callConsumption";

const CallConsumptionHourly = () => {
  const [applied, setApplied] = useState<CCFilters>(defaultFilters);
  // Which number the heatmap colours by. Switching only rebuilds the chart: no refetch.
  const [metric, setMetric] = useState<HeatmapMetric>("dropRate");
  const kpis = useSection<HourlyKpis>("/hourly/kpis", applied, { label: "the headline numbers" });
  const heat = useSection<{ from_date: string | null; to_date: string; all_time: boolean; cells: HeatCell[] }>("/hourly/heatmap", applied, { label: "the heatmap" });
  const trend = useSection<TrendPoint[]>("/hourly/trend", applied, { label: "the hourly trend" });
  const summary = useSection<SummaryResponse>("/hourly/summary", applied, { label: "the hourly table" });
  const k = kpis.data;
  const noData = !!k && !k.has_data;
  const dash = (v: string) => (kpis.error ? "—" : v);

  return (
    <div className="space-y-6">
      <PageHeader title="Hourly Heatmap" description="Which hours of the day lose the most calls." />
      {/* Outcome is left out: filtering to one outcome makes every cell 0% or 100% dropped. */}
      <FilterBar applied={applied} onApply={setApplied} hide={["disposition"]} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Total calls" loading={kpis.loading} noData={noData} value={dash(formatInt(k?.total_calls))} sub={k?.date_range_label} />
        <KpiCard label="Overall drop rate" loading={kpis.loading} noData={noData} value={dash(formatPct(k?.overall_drop_pct))} />
        <KpiCard label="Busiest hour" loading={kpis.loading} noData={noData} value={dash(k?.busiest_hour_label ?? "N/A")}
                 sub={k ? `${formatInt(k.busiest_hour_calls)} calls` : undefined} />
        <KpiCard label="Highest-risk window" loading={kpis.loading} noData={noData} value={dash(k?.risk_window_label ?? "N/A")}
                 valueClassName="text-lg" sub={k && k.risk_window_label !== "N/A" ? `${formatPct(k.risk_window_drop_pct)} dropped` : undefined} />
      </div>

      <SectionCard title="Heatmap by weekday and hour"
                   subtitle={heat.data ? `${heat.data.all_time || !heat.data.from_date ? "All time" : `${heat.data.from_date} to ${heat.data.to_date}`}, by weekday and hour. Hover a cell for all three numbers.` : undefined}
                   loading={heat.loading} error={heat.error} onRetry={heat.reload}
                   actions={
                     <ToggleGroup type="single" size="sm" variant="outline" value={metric} aria-label="Heatmap metric"
                                  onValueChange={(v) => v && setMetric(v as HeatmapMetric)}>
                       {HEATMAP_METRICS.map((m) => <ToggleGroupItem key={m.value} value={m.value} aria-label={m.label}>{m.label}</ToggleGroupItem>)}
                     </ToggleGroup>
                   }>
        {heat.data && <HourlyHeatmap cells={heat.data.cells} metric={metric} />}
      </SectionCard>

      <SectionCard title="Drop rate by hour" loading={trend.loading} error={trend.error} onRetry={trend.reload}
                   empty={!!trend.data && trend.data.every((p) => p.total_calls === 0)}>
        {trend.data && <HourlyTrendChart points={trend.data} />}
      </SectionCard>

      <SectionCard title="Summary by hour" loading={summary.loading} error={summary.error} onRetry={summary.reload}
                   empty={!summary.data?.has_data}
                   actions={<ExportButton path="/hourly/export.csv" filename="HourlyCallConsumptionReport.csv" applied={applied}
                                          disabled={!summary.data?.has_data} />}>
        {summary.data && <ConsumptionTable rows={summary.data.rows} total={summary.data.total} firstColumn="Hour" />}
      </SectionCard>
    </div>
  );
};

export default CallConsumptionHourly;
