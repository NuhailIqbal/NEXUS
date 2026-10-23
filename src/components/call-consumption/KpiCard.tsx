/**
 * One headline number: label, big value, and an optional change line coloured by whether the change is good news
 * (`higherIsBetter` false for drop rate, so a falling drop rate is green). While `loading` it shows a skeleton; when
 * `noData` it shows "No Data Found" instead of a misleading 0.
 */
import { ArrowDown, ArrowUp } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { trendColorClass } from "@/lib/callConsumption";

export function KpiCard({
  label,
  value,
  sub,
  delta,
  deltaText,
  higherIsBetter = true,
  loading,
  noData,
  valueClassName,
}: {
  label: string;
  value: string;
  sub?: string;
  /** The change itself (drives colour and arrow); `deltaText` is how it is written. */
  delta?: number;
  deltaText?: string;
  higherIsBetter?: boolean;
  loading?: boolean;
  noData?: boolean;
  valueClassName?: string;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-card p-4">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      {loading ? (
        <div className="mt-2 space-y-2" data-testid="kpi-loading">
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-3 w-32" />
        </div>
      ) : noData ? (
        <div className="mt-1 text-sm text-muted-foreground">No Data Found</div>
      ) : (
        <>
          <div className={cn("mt-1 truncate text-2xl font-bold text-foreground", valueClassName)} title={value}>{value}</div>
          {delta !== undefined && deltaText && (
            <div className={cn("mt-1 flex items-center gap-1 text-xs font-medium", trendColorClass(delta, higherIsBetter))}>
              {delta < 0 ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />}
              {deltaText}
            </div>
          )}
          {sub && <div className="mt-1 truncate text-xs text-muted-foreground" title={sub}>{sub}</div>}
        </>
      )}
    </div>
  );
}
