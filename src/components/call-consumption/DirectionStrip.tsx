/**
 * Overview's inbound-vs-outbound comparison: two cards side by side (calls, consumption, drop rate for each direction)
 * with a link to the full Inbound & Outbound report. One small endpoint (/call-consumption/overview/directions) with its
 * own loading state, like every other Overview widget. A direction with no calls shows "No calls" instead of 0%.
 */
import { Link } from "react-router-dom";
import { ArrowRight, PhoneIncoming, PhoneOutgoing, type LucideIcon } from "lucide-react";
import { SectionCard } from "@/components/call-consumption/SectionCard";
import { useSection } from "@/components/call-consumption/useSection";
import { DropRatePill } from "@/components/call-consumption/ConsumptionTable";
import { formatInt, formatPct, type CCFilters, type DirectionSummary } from "@/lib/callConsumption";

function Card({ label, Icon, d }: { label: string; Icon: LucideIcon; d: DirectionSummary }) {
  return (
    <div className="min-w-0 rounded-lg border border-border p-4" data-testid={`direction-${label.toLowerCase()}`}>
      <div className="flex items-center gap-2 text-sm font-medium text-foreground"><Icon className="h-4 w-4 text-muted-foreground" /> {label}</div>
      {d.has_data ? (
        <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
          <div><dt className="text-xs text-muted-foreground">Calls</dt><dd className="text-lg font-semibold tabular-nums">{formatInt(d.total_calls)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Consumption</dt><dd className="text-lg font-semibold tabular-nums">{formatPct(d.consumption_pct)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Drop rate</dt><dd className="mt-1"><DropRatePill value={d.drop_pct} /></dd></div>
        </dl>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">No calls</p>
      )}
    </div>
  );
}

export function DirectionStrip({ applied }: { applied: CCFilters }) {
  const s = useSection<Record<"inbound" | "outbound", DirectionSummary>>("/overview/directions", applied, { label: "the inbound / outbound comparison" });
  return (
    <SectionCard
      title="Inbound vs outbound"
      loading={s.loading} error={s.error} onRetry={s.reload}
      empty={!!s.data && !s.data.inbound.has_data && !s.data.outbound.has_data}
      actions={<Link to="/dashboard/call-consumption/direction" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">Full report <ArrowRight className="h-4 w-4" /></Link>}
      minHeight={80}
    >
      {s.data && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Card label="Outbound" Icon={PhoneOutgoing} d={s.data.outbound} />
          <Card label="Inbound" Icon={PhoneIncoming} d={s.data.inbound} />
        </div>
      )}
    </SectionCard>
  );
}
