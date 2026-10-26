/**
 * Reports > Cost per Lead (route call-consumption/lead-roi): what the account spends on calls for every lead and
 * every qualified lead, and, once the owner says what a lead is worth, the revenue, profit and ROI. Independent widgets,
 * each with its own endpoint under /call-consumption/lead-roi (see components/call-consumption/useSection.ts): the
 * headline cards, the breakdown table (outbound by campaign, inbound by phone number) and a weekly / monthly Summary table.
 * An Outbound / Inbound tab at the top scopes all of them to that direction, as on the Call Consumption Inbound & Outbound page. The filters are the Call
 * Consumption ones (dates, campaign, phone number); the CSV comes from the same server function as the screen.
 */
import { useEffect, useMemo, useState } from "react";
import { Settings2 } from "lucide-react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ExportButton } from "@/components/call-consumption/ExportButton";
import { FilterBar } from "@/components/call-consumption/FilterBar";
import { KpiCard } from "@/components/call-consumption/KpiCard";
import { SectionCard } from "@/components/call-consumption/SectionCard";
import { useSection } from "@/components/call-consumption/useSection";
import { LeadRoiTable } from "@/components/lead-roi/LeadRoiTable";
import { LeadValuesDialog } from "@/components/lead-roi/LeadValuesDialog";
import { cn } from "@/lib/utils";
import { defaultFilters, formatInt, type CCFilters } from "@/lib/callConsumption";
import {
  LEAD_ROI_PATH, changeText, leadsSub, moneyOrDash, roiOrDash, type CampaignReport, type LeadRoiKpis, type NumberReport,
  type PeriodReport,
} from "@/lib/leadRoi";
import { api } from "@/services/api";

type Granularity = "weekly" | "monthly";
type Direction = "outbound" | "inbound";

const TREND_COPY: Record<Granularity, { column: string; file: string }> = {
  weekly: { column: "Week", file: "WeeklyCostPerLead.csv" },
  monthly: { column: "Month", file: "MonthlyCostPerLead.csv" },
};

/** One Summary tab: fetches its own report for the shared, already-scoped filters. */
const TrendBody = ({ granularity, applied }: { granularity: Granularity; applied: CCFilters }) => {
  const copy = TREND_COPY[granularity];
  const report = useSection<PeriodReport>(`${LEAD_ROI_PATH}/period/${granularity}`, applied, { label: `the ${granularity} summary` });
  const data = report.data;
  const tableRows = useMemo(() => [...(data?.rows ?? [])].reverse(), [data]); // newest first, as people read it
  return (
    <SectionCard
      title="Summary"
      subtitle="Newest first. Every cost is spend ÷ leads for that period, not an average of the days in it. A period marked partial is still running or cut by the date range."
      loading={report.loading} error={report.error} onRetry={report.reload} empty={!data?.has_data}
      actions={<ExportButton path={`${LEAD_ROI_PATH}/period/${granularity}/export.csv`} filename={copy.file} applied={applied} disabled={!data?.has_data} />}
    >
      {data && <LeadRoiTable rows={tableRows} total={data.total} firstColumn={copy.column} showValue={data.has_value} />}
    </SectionCard>
  );
};

/**
 * One direction's breakdown, the way that direction is organised (as on the Call Consumption Inbound & Outbound page):
 * OUTBOUND by campaign (calls with no campaign, such as one-off dials, are under "No campaign"), INBOUND by the phone
 * number the caller reached. The page's tab is the direction.
 */
const DirectionBody = ({ direction, applied }: { direction: Direction; applied: CCFilters }) => {
  const inbound = direction === "inbound";
  const scoped = useMemo<CCFilters>(() => ({ ...applied, direction }), [applied, direction]);
  const path = `${LEAD_ROI_PATH}/${inbound ? "number" : "campaign"}`;
  const report = useSection<CampaignReport | NumberReport>(path, scoped, { label: inbound ? "the inbound number report" : "the campaign report" });
  const data = report.data;
  const emptyText = inbound ? "No inbound calls in this period" : "No outbound calls in this period";
  return (
    <div className="space-y-6">
      <SectionCard
        title={inbound ? "Inbound calls by phone number" : "Outbound calls by campaign"}
        subtitle={inbound ? "Which of your numbers brings leads, and at what cost. Biggest spender first."
                          : "Biggest spender first. Calls not tied to a campaign (one-off dials) are under No campaign."}
        loading={report.loading} error={report.error} onRetry={report.reload} empty={!data?.has_data} emptyText={emptyText}
        actions={<ExportButton path={`${path}/export.csv`} filename={inbound ? "InboundCostPerLeadByNumber.csv" : "OutboundCostPerLeadByCampaign.csv"}
                               applied={scoped} disabled={!data?.has_data} />}
      >
        {data && <LeadRoiTable rows={data.rows} total={data.total} firstColumn={inbound ? "Phone number" : "Campaign"} showValue={data.has_value} />}
      </SectionCard>
    </div>
  );
};

const LeadRoi = () => {
  const [applied, setApplied] = useState<CCFilters>(defaultFilters);
  const [tab, setTab] = useState<Granularity>("weekly");
  const [dir, setDir] = useState<Direction>("outbound");
  const [valuesOpen, setValuesOpen] = useState(false);
  const [isOwner, setIsOwner] = useState(true);
  // Bumped after the values are saved: the trend tabs are keyed on it, so the open one remounts and refetches.
  const [reloadKey, setReloadKey] = useState(0);

  // The tab IS the direction: it scopes the cards, the breakdown and the trend (the Direction filter is hidden).
  const scoped = useMemo<CCFilters>(() => ({ ...applied, direction: dir }), [applied, dir]);
  const inbound = dir === "inbound";
  // A campaign choice means nothing for inbound calls, so switching to Inbound drops it (else the tab would show nothing).
  const onTab = (next: Direction) => {
    setDir(next);
    setApplied((f) => ({ ...f, campaignIds: next === "inbound" ? [] : f.campaignIds, numberIds: next === "outbound" ? [] : f.numberIds }));
  };

  const kpis = useSection<LeadRoiKpis>(`${LEAD_ROI_PATH}/kpis`, scoped, { label: "the headline numbers" });

  useEffect(() => {
    api.getMyRole().then(({ data }) => setIsOwner((data as { is_owner?: boolean } | null)?.is_owner ?? true)).catch(() => undefined);
  }, []);

  const k = kpis.data;
  const noData = !!k && !k.has_data;
  const dash = (v: string) => (kpis.error ? "—" : v);
  const hasValue = !!k?.has_value;
  const change = (delta: number | null | undefined, unit: string, higherIsBetter: boolean) => {
    const text = changeText(delta, unit);
    return k && k.has_previous && delta !== null && delta !== undefined && text
      ? { delta, deltaText: `${text} vs previous period`, higherIsBetter }
      : { higherIsBetter };
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cost per Lead"
        description="What you spend on calls for every lead and every qualified lead, and what that earns you. Outbound and inbound are read separately."
        actions={<Button variant="outline" size="sm" onClick={() => setValuesOpen(true)}><Settings2 className="mr-1 h-4 w-4" /> Lead values</Button>}
      />
      <FilterBar applied={applied} onApply={setApplied} hide={inbound ? ["vertical", "agent", "disposition", "direction", "campaign"] : ["vertical", "agent", "disposition", "direction"]}
                 showNumber={inbound} />

      <Tabs value={dir} onValueChange={(v) => onTab(v as Direction)}>
        <TabsList>
          <TabsTrigger value="outbound">Outbound</TabsTrigger>
          <TabsTrigger value="inbound">Inbound</TabsTrigger>
        </TabsList>
      </Tabs>

      {k && k.has_data && hasValue && k.unvalued_campaigns > 0 && (
        <div role="status" className="rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm text-foreground" data-testid="unvalued-warning">
          {inbound ? "Inbound leads have no value set, so they count as"
            : <>{k.unvalued_campaigns === 1 ? "1 campaign has" : `${k.unvalued_campaigns} campaigns have`} leads but no value set, so {k.unvalued_campaigns === 1 ? "it counts" : "they count"} as</>}
          {" "}$0 revenue.{" "}
          <button type="button" className="font-medium text-primary underline-offset-2 hover:underline" onClick={() => setValuesOpen(true)}>Set a value</button>
        </div>
      )}

      <div className={cn("grid gap-4 sm:grid-cols-2", hasValue ? "lg:grid-cols-3" : "lg:grid-cols-4")}>
        <KpiCard label="Total spend" loading={kpis.loading} noData={noData} value={dash(moneyOrDash(k?.spend))}
                 sub={k ? `${formatInt(k.calls)} calls` : undefined} />
        <KpiCard label="Leads" loading={kpis.loading} noData={noData} value={dash(formatInt(k?.leads))}
                 sub={k ? leadsSub(k) : undefined} {...change(k?.leads_change_pct, "%", true)} />
        <KpiCard label="Cost per lead" loading={kpis.loading} noData={noData} value={dash(moneyOrDash(k?.cost_per_lead))}
                 {...(k?.cost_per_lead === null ? { sub: "No leads in this period" } : change(k?.cost_per_lead_change_pct, "%", false))} />
        <KpiCard label="Cost per qualified lead" loading={kpis.loading} noData={noData} value={dash(moneyOrDash(k?.cost_per_qualified_lead))}
                 {...(k?.cost_per_qualified_lead === null ? { sub: "No qualified leads in this period" } : change(k?.cost_per_qualified_lead_change_pct, "%", false))} />
        {/* Revenue and ROI only exist once the owner has said what a lead is worth (Lead values), so until then they are not shown. */}
        {hasValue && (
          <>
            <KpiCard label="Revenue" loading={kpis.loading} noData={noData} value={dash(moneyOrDash(k?.revenue))}
                     sub={k ? `${formatInt(k.qualified_leads)} qualified × your value` : undefined} />
            <KpiCard label="ROI" loading={kpis.loading} noData={noData} value={dash(roiOrDash(k?.roi_pct))}
                     valueClassName={k?.roi_pct !== null && k?.roi_pct !== undefined && k.roi_pct < 0 ? "text-destructive" : undefined}
                     {...(k?.roi_pct === null ? { sub: "Nothing spent in this period" }
                       : { ...change(k?.roi_point_change, " pts", true), sub: k?.profit !== null && k?.profit !== undefined ? `Profit ${moneyOrDash(k.profit)}` : undefined })} />
          </>
        )}
      </div>

      {/* Keyed so a save refetches the breakdown. */}
      <DirectionBody key={reloadKey} direction={dir} applied={applied} />

      <Tabs value={tab} onValueChange={(v) => setTab(v as Granularity)} className="space-y-6">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-foreground">Weekly & Monthly Report</h2>
          <p className="text-sm text-muted-foreground">One row per week (Sunday to Saturday) or calendar month.</p>
        </div>
        <TabsList>
          <TabsTrigger value="weekly">Weekly</TabsTrigger>
          <TabsTrigger value="monthly">Monthly</TabsTrigger>
        </TabsList>
        {/* Only the open tab is mounted, so each fetches when first shown; keyed so a save refetches the open one. */}
        <TabsContent value="weekly" className="mt-0"><TrendBody key={reloadKey} granularity="weekly" applied={scoped} /></TabsContent>
        <TabsContent value="monthly" className="mt-0"><TrendBody key={reloadKey} granularity="monthly" applied={scoped} /></TabsContent>
      </Tabs>

      <LeadValuesDialog open={valuesOpen} onOpenChange={setValuesOpen} isOwner={isOwner} onSaved={() => { kpis.reload(); setReloadKey((n) => n + 1); }} />
    </div>
  );
};

export default LeadRoi;
