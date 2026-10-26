/**
 * Call Consumption > Campaign / Vertical / State (routes call-consumption/campaign|vertical|state). The three pages are
 * the same report grouped by a different dimension, so they share this one component and differ only in `dimension`.
 *
 *   dimension   groups by                                   notes
 *   campaign    the outbound campaign ("No campaign" for     rows/bars link to the Non-Consumption Reasons page
 *               inbound and one-off calls)
 *   vertical    the calling agent's industry                 "Uncategorized" when the agent has none
 *   state       the state of the contact's phone area code   an estimate; non-US numbers are "Unknown"
 *
 * Six independent widgets, each with its own endpoint (/call-consumption/breakdown/<dimension>/<section>) and loading
 * state, so one failing section never blanks the page.
 */
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "@/components/dashboard/PageHeader";
import {
  ComboChart, DispositionDonut, DispositionStacked, RankingBars, StateHourHeatmap,
  type ComboRow, type DispositionRow, type MixRow, type RankingRow, type StateHeatCell,
} from "@/components/call-consumption/Charts";
import { ConsumptionTable } from "@/components/call-consumption/ConsumptionTable";
import { ExportButton } from "@/components/call-consumption/ExportButton";
import { FilterBar } from "@/components/call-consumption/FilterBar";
import { KpiCard } from "@/components/call-consumption/KpiCard";
import { SectionCard } from "@/components/call-consumption/SectionCard";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { HEATMAP_METRICS, type HeatmapMetric } from "@/lib/callConsumptionCharts";
import { useSection } from "@/components/call-consumption/useSection";
import {
  defaultFilters, formatInt, formatMoney, formatPct, reasonsUrl, type BreakdownKpi, type CCFilters, type Dimension,
  type SummaryResponse, type TreeRow,
} from "@/lib/callConsumption";

const COPY: Record<Dimension, { title: string; noun: string; column: string; blurb: string; file: string }> = {
  campaign: {
    title: "Call Consumption by Campaign",
    noun: "campaign",
    column: "Campaign",
    blurb: "Which campaigns lose the most calls, and why. Click a campaign to see its reasons.",
    file: "CallConsumptionByCampaign.csv",
  },
  vertical: {
    title: "Call Consumption by Vertical",
    noun: "vertical",
    column: "Vertical",
    blurb: "Calls grouped by the industry of the agent that handled them.",
    file: "CallConsumptionByVertical.csv",
  },
  state: {
    title: "Call Consumption by State",
    noun: "state",
    column: "State",
    blurb: "Calls grouped by the state of the contact's phone number area code (an estimate: ported or non-US numbers show as Unknown).",
    file: "CallConsumptionByState.csv",
  },
};

type StateGrid = { states: { key: string; name: string; total_calls: number; drop_pct: number }[]; cells: StateHeatCell[]; unknown_calls: number };
/** States shown in the heatmap before "Show all". */
const STATE_HEATMAP_TOP = 15;

const Breakdown = ({ dimension }: { dimension: Dimension }) => {
  const copy = COPY[dimension];
  const navigate = useNavigate();
  const [applied, setApplied] = useState<CCFilters>(defaultFilters);
  const base = `/breakdown/${dimension}`;
  const kpi = useSection<BreakdownKpi>(`${base}/kpi`, applied, { label: "the headline numbers" });
  const combo = useSection<ComboRow[]>(`${base}/combo`, applied, { label: "the volume chart" });
  const stacked = useSection<DispositionRow[]>(`${base}/disposition`, applied, { label: "the reasons chart" });
  const mix = useSection<MixRow[]>(`${base}/mix`, applied, { label: "the reasons mix" });
  const ranking = useSection<RankingRow[]>(`${base}/ranking`, applied, { label: "the ranking" });
  const summary = useSection<SummaryResponse>(`${base}/summary`, applied, { label: "the summary table" });
  // State page only: state x hour heatmap (the busiest STATE_HEATMAP_TOP states unless the user asks for all).
  const isState = dimension === "state";
  const stateGrid = useSection<StateGrid>("/state/heatmap", applied, { label: "the state heatmap", enabled: isState });
  const [heatMetric, setHeatMetric] = useState<HeatmapMetric>("dropRate");
  const [allStates, setAllStates] = useState(false);
  const gridStates = useMemo(() => {
    const keys = (stateGrid.data?.states ?? []).map((s) => s.key);
    return allStates ? keys : keys.slice(0, STATE_HEATMAP_TOP);
  }, [stateGrid.data, allStates]);
  const stateCount = stateGrid.data?.states.length ?? 0;
  const k = kpi.data;
  const noData = !!k && !k.has_data;
  // Stable between renders: the ranking chart rebuilds (and Apex redraws) whenever this function changes.
  const openReasons = useCallback((key: string) => { if (key) navigate(reasonsUrl(key, applied)); }, [navigate, applied]);
  const drill = dimension === "campaign" ? openReasons : undefined;
  const onRankingSelect = useCallback((r: { key: string }) => openReasons(r.key), [openReasons]);
  const errored = !!kpi.error;
  const dash = (v: string) => (errored ? "—" : v);

  return (
    <div className="space-y-6">
      <PageHeader title={copy.title} description={copy.blurb} />
      <FilterBar applied={applied} onApply={setApplied} hide={dimension === "vertical" ? ["vertical"] : []} showState={isState} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <KpiCard label="Total calls" loading={kpi.loading} noData={noData} value={dash(formatInt(k?.total_calls))}
                 sub={k ? `${formatInt(k.segment_count)} ${copy.noun}${k.segment_count === 1 ? "" : "s"}` : undefined} />
        <KpiCard label="Consumed" loading={kpi.loading} noData={noData} value={dash(formatInt(k?.consumed_calls))}
                 sub={k ? formatPct(k.consumed_pct) : undefined} />
        <KpiCard label="Dropped" loading={kpi.loading} noData={noData} value={dash(formatInt(k?.dropped_calls))}
                 sub={k ? formatPct(k.dropped_pct) : undefined} />
        <KpiCard label={`Worst ${copy.noun}`} loading={kpi.loading} noData={noData}
                 value={dash(k?.worst_segment_name ?? "None")} valueClassName="text-lg"
                 sub={k?.worst_segment_name ? `${formatPct(k.worst_segment_drop_rate)} dropped · ${formatInt(k.worst_segment_calls)} calls` : undefined} />
        <KpiCard label="Spent on dropped calls" loading={kpi.loading} noData={noData} value={dash(formatMoney(k?.cost_on_dropped))} />
      </div>

      {isState && (
        <SectionCard
          title="Heatmap by state and hour"
          subtitle={stateGrid.data ? [
            stateCount > STATE_HEATMAP_TOP && !allStates ? `Busiest ${STATE_HEATMAP_TOP} of ${stateCount} states.` : `${stateCount} state${stateCount === 1 ? "" : "s"}, busiest at the top.`,
            "Hover a cell for all three numbers.",
            stateGrid.data.unknown_calls ? `${formatInt(stateGrid.data.unknown_calls)} calls from non-US numbers are not shown.` : "",
          ].filter(Boolean).join(" ") : undefined}
          loading={stateGrid.loading} error={stateGrid.error} onRetry={stateGrid.reload}
          empty={!stateGrid.data?.states.length}
          actions={
            <>
              {stateCount > STATE_HEATMAP_TOP && (
                <Button type="button" variant="outline" size="sm" onClick={() => setAllStates((v) => !v)}>
                  {allStates ? `Show busiest ${STATE_HEATMAP_TOP}` : `Show all ${stateCount} states`}
                </Button>
              )}
              <ToggleGroup type="single" size="sm" variant="outline" value={heatMetric} aria-label="State heatmap metric"
                           onValueChange={(v) => v && setHeatMetric(v as HeatmapMetric)}>
                {HEATMAP_METRICS.map((m) => <ToggleGroupItem key={m.value} value={m.value} aria-label={m.label}>{m.label}</ToggleGroupItem>)}
              </ToggleGroup>
            </>
          }
        >
          {stateGrid.data && <StateHourHeatmap cells={stateGrid.data.cells} states={gridStates} metric={heatMetric} />}
        </SectionCard>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Volume and drop rate" subtitle="Bars are dropped calls; the line is the drop rate."
                     loading={combo.loading} error={combo.error} onRetry={combo.reload} empty={!combo.data?.length}>
          {combo.data && <ComboChart rows={combo.data} />}
        </SectionCard>
        <SectionCard title="Why calls were dropped" subtitle="The mix of reasons across everything dropped."
                     loading={mix.loading} error={mix.error} onRetry={mix.reload} empty={!mix.data?.length} emptyText="No dropped calls">
          {mix.data && <DispositionDonut rows={mix.data} />}
        </SectionCard>
      </div>

      <SectionCard title={`Dropped calls by ${copy.noun}`} subtitle="One bar per segment, split by reason."
                   loading={stacked.loading} error={stacked.error} onRetry={stacked.reload}
                   empty={!stacked.data?.length} emptyText="No dropped calls">
        {stacked.data && <DispositionStacked rows={stacked.data} />}
      </SectionCard>

      <SectionCard title="Drop-rate ranking" subtitle="Worst first."
                   loading={ranking.loading} error={ranking.error} onRetry={ranking.reload} empty={!ranking.data?.length}>
        {ranking.data && <RankingBars rows={ranking.data} onSelect={drill ? onRankingSelect : undefined} />}
      </SectionCard>

      <SectionCard title="Summary" loading={summary.loading} error={summary.error} onRetry={summary.reload}
                   empty={!summary.data?.has_data}
                   actions={<ExportButton path={`${base}/export.csv`} filename={copy.file} applied={applied} disabled={!summary.data?.has_data} />}>
        {summary.data && (
          <ConsumptionTable
            rows={summary.data.rows}
            total={summary.data.total}
            firstColumn={copy.column}
            onRowClick={drill ? (r: TreeRow) => drill(r.key ?? "") : undefined}
          />
        )}
      </SectionCard>
    </div>
  );
};

export const CallConsumptionCampaign = () => <Breakdown dimension="campaign" />;
export const CallConsumptionVertical = () => <Breakdown dimension="vertical" />;
export const CallConsumptionState = () => <Breakdown dimension="state" />;
export default Breakdown;
