/**
 * Call Consumption > Non-Consumption Reasons (route call-consumption/reasons?campaign_id=...): the page behind a campaign's
 * drill-down link. For ONE campaign it shows why its calls were dropped, first by reason bucket and then by the
 * carrier's/AI's own end-reason wording. Percentages here are a share of DROPPED calls, not of all calls.
 *
 * The campaign, dates, time zone and direction travel in the URL (ids and dates only), so the link is shareable and the
 * numbers match the page that opened it.
 */
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { FilterBar } from "@/components/call-consumption/FilterBar";
import { KpiCard } from "@/components/call-consumption/KpiCard";
import { SectionCard } from "@/components/call-consumption/SectionCard";
import { useSection } from "@/components/call-consumption/useSection";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  BUCKET_COLORS, defaultFilters, formatInt, formatPct, type CCFilters, type ReasonsResponse,
} from "@/lib/callConsumption";

const CallConsumptionReasons = () => {
  const [params] = useSearchParams();
  const campaignId = params.get("campaign_id") ?? "";
  const initial = useMemo<CCFilters>(() => {
    const d = defaultFilters();
    return {
      ...d,
      from: params.get("from") || d.from,
      to: params.get("to") || d.to,
      tz: params.get("tz") || d.tz,
      direction: params.get("direction") || "",
    };
  }, [params]);
  const [applied, setApplied] = useState<CCFilters>(initial);
  const reasons = useSection<ReasonsResponse>("/reasons", applied, {
    extra: { campaign_id: campaignId },
    label: "the reasons",
    enabled: !!campaignId,
  });
  const r = reasons.data;

  return (
    <div className="space-y-6">
      <Link to="/dashboard/call-consumption/campaign" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Back to campaigns
      </Link>
      <PageHeader
        title={r?.campaign_name ? `Why calls were dropped: ${r.campaign_name}` : "Why calls were dropped"}
        description="Only dropped calls are counted below; percentages are a share of dropped calls."
      />
      {!campaignId ? (
        <SectionCard empty emptyText="Pick a campaign on the Campaign page to see its reasons." />
      ) : (
        <>
          <FilterBar applied={applied} onApply={setApplied} hide={["campaign", "vertical", "agent", "disposition"]} />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard label="Total calls" loading={reasons.loading} value={reasons.error ? "—" : formatInt(r?.total_calls)} />
            <KpiCard label="Consumed" loading={reasons.loading} value={reasons.error ? "—" : formatInt(r?.consumed_calls)} />
            <KpiCard label="Dropped" loading={reasons.loading} value={reasons.error ? "—" : formatInt(r?.dropped_calls)} />
            <KpiCard label="Drop rate" loading={reasons.loading} value={reasons.error ? "—" : formatPct(r?.drop_pct)} />
          </div>

          <SectionCard title="By reason" loading={reasons.loading} error={reasons.error} onRetry={reasons.reload}
                       empty={!r?.reasons.length} emptyText="No dropped calls for this campaign in this range.">
            {r && (
              <ul className="space-y-3">
                {r.reasons.map((x) => (
                  <li key={x.disposition}>
                    <div className="mb-1 flex items-center justify-between text-sm">
                      <span className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: BUCKET_COLORS[x.disposition] }} />
                        {x.label}
                      </span>
                      <span className="tabular-nums text-muted-foreground">{formatInt(x.calls)} · {formatPct(x.pct_of_dropped)}</span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full" style={{ width: `${x.pct_of_dropped}%`, backgroundColor: BUCKET_COLORS[x.disposition] }} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard title="Exact end reasons" subtitle="The wording the phone network or the AI reported, most common first."
                       loading={reasons.loading} error={reasons.error} onRetry={reasons.reload} empty={!r?.raw_reasons.length}
                       emptyText="No dropped calls for this campaign in this range.">
            {r && (
              <div className="overflow-x-auto">
                <Table className="min-w-[28rem]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Reason</TableHead>
                      <TableHead>Counted as</TableHead>
                      <TableHead className="text-right">Calls</TableHead>
                      <TableHead className="text-right">Share of dropped</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {r.raw_reasons.map((x) => (
                      <TableRow key={`${x.reason}-${x.disposition}`}>
                        <TableCell className="font-mono text-xs">{x.reason}</TableCell>
                        <TableCell>{x.label}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatInt(x.calls)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatPct(x.pct_of_dropped)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </SectionCard>
        </>
      )}
    </div>
  );
};

export default CallConsumptionReasons;
