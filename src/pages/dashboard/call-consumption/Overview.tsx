/**
 * Call Consumption > Overview (route call-consumption/overview): headline KPIs against the previous period, the
 * month > week > day summary table, rule-based insights and the worst/best hotspots. Four independent widgets, each
 * with its own endpoint and loading state (see components/call-consumption/useSection.ts). The CSVs come from the
 * same server functions as the screen.
 */
import { useState } from "react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { ConsumptionTable } from "@/components/call-consumption/ConsumptionTable";
import { ExportButton } from "@/components/call-consumption/ExportButton";
import { DirectionStrip } from "@/components/call-consumption/DirectionStrip";
import { FilterBar } from "@/components/call-consumption/FilterBar";
import { HotspotsTable, InsightsList, type Hotspot, type Insight } from "@/components/call-consumption/InsightsAndHotspots";
import { KpiCard } from "@/components/call-consumption/KpiCard";
import { SectionCard } from "@/components/call-consumption/SectionCard";
import { useSection } from "@/components/call-consumption/useSection";
import {
  defaultFilters, formatDelta, formatInt, formatPct, type CCFilters, type OverviewKpis, type SummaryResponse,
} from "@/lib/callConsumption";

const CallConsumptionOverview = () => {
  const [applied, setApplied] = useState<CCFilters>(defaultFilters);
  const kpis = useSection<OverviewKpis>("/overview/kpis", applied, { label: "the headline numbers" });
  const summary = useSection<SummaryResponse>("/overview/summary", applied, { label: "the summary table" });
  const insights = useSection<Insight[]>("/overview/insights", applied, { label: "the insights" });
  const hotspots = useSection<Hotspot[]>("/overview/hotspots", applied, { label: "the hotspots" });
  const k = kpis.data;
  const dash = (v: string) => (kpis.error ? "—" : v);
  // The change line under a KPI, or a plain note when the previous period had no calls to compare with.
  const change = (delta: number | undefined, unit: string) =>
    !k ? {} : k.has_previous && delta !== undefined
      ? { delta, deltaText: `${formatDelta(delta)}${unit} vs previous period` }
      : { sub: "No calls in the previous period to compare" };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Call Consumption"
        description="How many finished calls were consumed (a person answered and spoke with the AI) and why the rest were dropped."
      />
      <FilterBar applied={applied} onApply={setApplied} />

      <div className="grid gap-4 sm:grid-cols-3">
        <KpiCard label="Total calls" loading={kpis.loading} noData={!!k && !k.has_data}
                 value={dash(formatInt(k?.total_calls))} {...change(k?.total_calls_change_pct, "%")} />
        <KpiCard label="Consumption" loading={kpis.loading} noData={!!k && !k.has_data}
                 value={dash(formatPct(k?.consumption_pct))} {...change(k?.consumption_pct_point_change, " pts")} />
        <KpiCard label="Drop rate" loading={kpis.loading} noData={!!k && !k.has_data}
                 value={dash(formatPct(k?.drop_pct))} higherIsBetter={false} {...change(k?.drop_pct_point_change, " pts")} />
      </div>

      <DirectionStrip applied={applied} />

      <SectionCard
        title="Summary"
        subtitle="Month > week > day. Every percentage is dropped (or consumed) ÷ total at that level, not an average of the rows below it."
        loading={summary.loading}
        error={summary.error}
        onRetry={summary.reload}
        empty={!summary.data?.has_data}
        actions={<ExportButton path="/overview/export/summary.csv" filename="CallConsumptionOverviewSummary.csv"
                               applied={applied} disabled={!summary.data?.has_data} />}
      >
        {summary.data && <ConsumptionTable rows={summary.data.rows} total={summary.data.total} firstColumn="Period" defaultExpandDepth={1} />}
      </SectionCard>

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Insights" loading={insights.loading} error={insights.error} onRetry={insights.reload}
                     empty={!insights.data?.length}>
          {insights.data && <InsightsList insights={insights.data} />}
        </SectionCard>
        <SectionCard
          title="Hotspots"
          subtitle="The worst and best hour, state, vertical and campaign (segments with very few calls are ignored)."
          loading={hotspots.loading} error={hotspots.error} onRetry={hotspots.reload}
          empty={!hotspots.data?.length}
          actions={<ExportButton path="/overview/export/hotspots.csv" filename="CallConsumptionOverviewHotspots.csv"
                                 applied={applied} disabled={!hotspots.data?.length} />}
        >
          {hotspots.data && <HotspotsTable rows={hotspots.data} />}
        </SectionCard>
      </div>
    </div>
  );
};

export default CallConsumptionOverview;
