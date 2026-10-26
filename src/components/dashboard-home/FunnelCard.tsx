/**
 * "Where your calls go": calls -> answered -> leads -> qualified as horizontal bars, each a share of all calls. One hue,
 * darkening to the step that matters most (qualified), with the count and the percentage written out, so nothing is
 * read from colour alone. Presentational.
 */
import { SectionCard } from "@/components/call-consumption/SectionCard";
import { formatInt } from "@/lib/callConsumption";
import { funnelStages, notAnsweredBreakdown, type Tiles } from "@/lib/dashboardOverview";
import { cn } from "@/lib/utils";
import { useChartColors } from "./useChartColors";

// Bar fade, lightest (all calls) to strongest (qualified).
const OPACITY = [0.35, 0.55, 0.78, 1];

export function FunnelCard({ tiles, loading }: { tiles: Tiles | null; loading: boolean }) {
  const colors = useChartColors();
  const stages = tiles ? funnelStages(tiles) : [];
  const gone = tiles && stages.length > 0 ? notAnsweredBreakdown(tiles) : null;
  return (
    <SectionCard
      className="h-full"
      title="Where your calls go"
      subtitle="Each step as a share of all calls."
      loading={loading}
      empty={!!tiles && stages.length === 0}
      emptyText="No calls in this period yet."
      minHeight={280}
    >
      <ul className="space-y-4" data-testid="funnel">
        {stages.map((s, i) => (
          <li key={s.key} title={s.hint}>
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="min-w-0 truncate font-medium text-foreground">{s.label}</span>
              <span className="shrink-0 text-muted-foreground">
                <span className="font-semibold text-foreground">{formatInt(s.value)}</span>
                {i > 0 && <span className="ml-1.5 text-xs">{s.pctOfCalls}%</span>}
              </span>
            </div>
            <div className="mt-1.5 h-2.5 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full transition-all" style={{ width: `${Math.max(s.value > 0 ? 2 : 0, s.pctOfCalls)}%`, background: colors.calls, opacity: OPACITY[i] }} />
            </div>
          </li>
        ))}
      </ul>

      {gone && gone.items.length > 0 && (
        <div className="mt-5 border-t border-border pt-4" data-testid="not-answered">
          {gone.total > 0 ? (
            <>
              <p className="text-sm font-medium text-foreground">
                Not answered <span className="font-semibold">{formatInt(gone.total)}</span>
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">Why the other calls did not reach a person.</p>
            </>
          ) : (
            <p className="text-sm font-medium text-foreground">No result yet</p>
          )}
          <ul className="mt-3 flex flex-wrap gap-2">
            {gone.items.map((i) => (
              <li key={i.key} className={cn("rounded-full border px-2.5 py-1 text-xs",
                i.key === "failed" ? "border-destructive/30 bg-destructive/10 text-destructive" : "border-border bg-muted/40 text-muted-foreground")}>
                {i.label} <span className="font-semibold tabular-nums text-foreground">{formatInt(i.count)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </SectionCard>
  );
}
