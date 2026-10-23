/**
 * Reports > Inbound & Outbound (route call-consumption/direction): consumed vs dropped calls for ONE direction at a time,
 * broken down the way that direction is organised. Two tabs:
 *
 *   Outbound  one row per CAMPAIGN ("No campaign" for one-off and callback calls); a row opens that campaign's reasons
 *   Inbound   one row per NEXUS PHONE NUMBER (inbound calls have no campaign; they reach a number / AI receptionist)
 *
 * Every row is compared with the same campaign / number in the window before the chosen one. The filters sit above the
 * tabs: Campaign applies to Outbound only and Number to Inbound only (so each tab shows only the filters that fit it;
 * the direction itself is the tab). One endpoint per tab (/call-consumption/direction/<direction>) feeds the cards, the
 * table, the CSV and the charts, so they cannot disagree.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { ComboChart, DispositionStacked, type ComboRow, type DispositionRow } from "@/components/call-consumption/Charts";
import { ConsumptionTable } from "@/components/call-consumption/ConsumptionTable";
import { ExportButton } from "@/components/call-consumption/ExportButton";
import { FilterBar } from "@/components/call-consumption/FilterBar";
import { KpiCard } from "@/components/call-consumption/KpiCard";
import { SectionCard } from "@/components/call-consumption/SectionCard";
import { useSection } from "@/components/call-consumption/useSection";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  BUCKET_LABELS, DROP_BUCKETS, defaultFilters, formatDelta, formatInt, formatPct, reasonsUrl, type CCFilters,
  type DirectionReport, type TreeRow,
} from "@/lib/callConsumption";

type Direction = "outbound" | "inbound";

const COPY: Record<Direction, { blurb: string; noun: string; plural: string; file: string }> = {
  outbound: {
    blurb: "Calls the AI placed, one row per campaign. Click a campaign to see why its calls were dropped.",
    noun: "campaign",
    plural: "campaigns",
    file: "OutboundCallConsumptionByCampaign.csv",
  },
  inbound: {
    blurb: "Calls the AI answered, one row per phone number (inbound calls belong to a number, not a campaign).",
    noun: "number",
    plural: "numbers",
    file: "InboundCallConsumptionByNumber.csv",
  },
};

const DirectionBody = ({ direction, applied }: { direction: Direction; applied: CCFilters }) => {
  const copy = COPY[direction];
  const navigate = useNavigate();
  const report = useSection<DirectionReport>(`/direction/${direction}`, applied, { label: `the ${direction} report` });
  const data = report.data;
  const rows = useMemo(() => data?.rows ?? [], [data]); // stable between renders, so the charts only rebuild on new data
  const k = data?.kpis;
  const busiest = rows[0];

  const combo = useMemo<ComboRow[]>(
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

  const dash = (v: string) => (report.error ? "—" : v);
  const noData = !!data && !data.has_data;
  const vs = (delta: number | undefined, unit: string) =>
    k && k.has_previous && delta !== undefined
      ? { delta, deltaText: `${formatDelta(delta)}${unit} vs previous period` }
      : k ? { sub: "No calls in the previous period to compare" } : {};
  // Only outbound campaigns that exist can open a reasons page ("No campaign" has no id).
  const drill = direction === "outbound" ? (r: TreeRow) => r.key && navigate(reasonsUrl(r.key, applied)) : undefined;

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">{copy.blurb}</p>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Total calls" loading={report.loading} noData={noData} value={dash(formatInt(k?.total_calls))}
                 {...vs(k?.total_calls_change_pct, "%")} />
        <KpiCard label="Consumption" loading={report.loading} noData={noData} value={dash(formatPct(k?.consumption_pct))}
                 {...vs(k?.consumption_pct_point_change, " pts")} />
        <KpiCard label="Drop rate" loading={report.loading} noData={noData} value={dash(formatPct(k?.drop_pct))}
                 higherIsBetter={false} {...vs(k?.drop_pct_point_change, " pts")} />
        <KpiCard label={`Busiest ${copy.noun}`} loading={report.loading} noData={noData} value={dash(busiest?.name ?? "—")}
                 valueClassName="text-lg" sub={busiest ? `${formatInt(busiest.total_calls)} calls · ${formatPct(busiest.drop_pct)} dropped` : undefined} />
      </div>

      <SectionCard
        title={`By ${copy.noun}`}
        subtitle="Busiest first. Rates are dropped (or consumed) ÷ total for that row; the change columns compare it with the previous period."
        loading={report.loading} error={report.error} onRetry={report.reload} empty={!data?.has_data}
        emptyText={`No ${direction} calls for these filters`}
        actions={<ExportButton path={`/direction/${direction}/export.csv`} filename={copy.file} applied={applied} disabled={!data?.has_data} />}
      >
        {data && <ConsumptionTable rows={rows} total={data.total} firstColumn={data.segment_label} showChange onRowClick={drill} />}
      </SectionCard>

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title={`Volume and drop rate by ${copy.noun}`} subtitle="Bars are dropped calls; the line is the drop rate."
                     loading={report.loading} error={report.error} onRetry={report.reload} empty={!combo.length}>
          <ComboChart rows={combo} />
        </SectionCard>
        <SectionCard title={`Why calls were dropped, by ${copy.noun}`} subtitle="One bar per row, split by reason."
                     loading={report.loading} error={report.error} onRetry={report.reload} empty={!reasons.length} emptyText="No dropped calls">
          <DispositionStacked rows={reasons} />
        </SectionCard>
      </div>
    </div>
  );
};

const InboundOutbound = () => {
  const [applied, setApplied] = useState<CCFilters>(defaultFilters);
  const [tab, setTab] = useState<Direction>("outbound");

  // A campaign choice means nothing for inbound calls and a number choice nothing for outbound ones, so switching tabs
  // drops the one that no longer fits (otherwise the other tab would silently show nothing).
  const onTab = (next: Direction) => {
    setTab(next);
    setApplied((f) => ({ ...f, campaignIds: next === "inbound" ? [] : f.campaignIds, numberIds: next === "outbound" ? [] : f.numberIds }));
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Inbound & Outbound" description="Consumed vs dropped calls by campaign (outbound) or by phone number (inbound)." />
      <FilterBar
        applied={applied}
        onApply={setApplied}
        hide={tab === "inbound" ? ["direction", "campaign"] : ["direction"]}
        showNumber={tab === "inbound"}
      />
      <Tabs value={tab} onValueChange={(v) => onTab(v as Direction)} className="space-y-6">
        <TabsList>
          <TabsTrigger value="outbound">Outbound</TabsTrigger>
          <TabsTrigger value="inbound">Inbound</TabsTrigger>
        </TabsList>
        {/* Only the open tab is mounted, so each fetches when first shown. */}
        <TabsContent value="outbound" className="mt-0"><DirectionBody direction="outbound" applied={applied} /></TabsContent>
        <TabsContent value="inbound" className="mt-0"><DirectionBody direction="inbound" applied={applied} /></TabsContent>
      </Tabs>
    </div>
  );
};

export default InboundOutbound;
