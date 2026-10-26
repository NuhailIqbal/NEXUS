/**
 * "Needs attention": what is wrong with a running campaign right now (stalled, or calls that could not be placed), each
 * with a link to the campaigns page. Renders nothing when all is well. Presentational: the list is built by buildAlerts
 * (lib/dashboardOverview.ts) from the overview.
 */
import { Link } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { buildAlerts, type DashboardOverview } from "@/lib/dashboardOverview";
import { cn } from "@/lib/utils";

/** Things that are wrong or waiting right now. Renders nothing when all is well. */
export function AttentionList({ data }: { data: Pick<DashboardOverview, "campaigns"> }) {
  const alerts = buildAlerts(data);
  if (alerts.length === 0) return null;
  return (
    <section aria-label="Needs attention" className="space-y-2" data-testid="attention-list">
      {alerts.map((a) => (
        <div
          key={a.key}
          role="alert"
          className={cn(
            "flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm text-foreground",
            a.level === "error" ? "border-destructive/40 bg-destructive/5" : "border-warning/40 bg-warning/5",
          )}
        >
          <span className="flex min-w-0 items-start gap-2">
            <AlertTriangle className={cn("mt-0.5 h-4 w-4 shrink-0", a.level === "error" ? "text-destructive" : "text-warning")} />
            <span className="min-w-0 break-words">{a.text}</span>
          </span>
          <Link to={a.to} className="shrink-0 font-medium text-primary hover:underline">{a.action}</Link>
        </div>
      ))}
    </section>
  );
}
