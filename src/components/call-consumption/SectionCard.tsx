/**
 * Card shell for one Call Consumption widget: a title row (with an optional actions slot), and a body that shows a
 * skeleton while `loading`, an inline error with a Retry button when `error` is set, a "No data" message when
 * `empty`, and otherwise `children`. Presentational only.
 */
import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function SectionCard({
  title,
  subtitle,
  actions,
  loading,
  error,
  empty,
  emptyText = "No Data Found",
  onRetry,
  minHeight = 120,
  className,
  children,
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  loading?: boolean;
  error?: string | null;
  empty?: boolean;
  emptyText?: string;
  onRetry?: () => void;
  minHeight?: number;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <section className={cn("min-w-0 rounded-xl border border-border bg-card p-5", className)}>
      {(title || actions) && (
        <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            {title && <h3 className="font-semibold text-foreground">{title}</h3>}
            {subtitle && <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div style={{ minHeight }}>
        {loading ? (
          <div className="space-y-3" aria-busy="true" data-testid="section-loading">
            <Skeleton className="h-6 w-1/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
          </div>
        ) : error ? (
          <div role="alert" className="flex flex-col items-start gap-2 text-sm text-destructive">
            <span className="flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> {error}</span>
            {onRetry && <Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>}
          </div>
        ) : empty ? (
          <div className="flex h-full min-h-[96px] items-center justify-center text-sm text-muted-foreground">{emptyText}</div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}
