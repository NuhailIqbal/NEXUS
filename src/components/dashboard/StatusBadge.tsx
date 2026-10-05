/**
 * Colored pill that shows a status string (e.g. an agent's or automation flow's status) with a
 * leading dot. The color comes from a lookup of the exact status text; unknown text renders muted.
 * Purely presentational. Used by AIAgents, AutomationList and FlowEditor.
 */
import { cn } from "@/lib/utils";

/** Semantic color families, each mapped to theme tokens in VARIANTS. */
type Variant = "success" | "muted" | "warning" | "destructive" | "info";

/** Tailwind classes per variant: `wrap` styles the pill, `dot` the indicator inside it. */
const VARIANTS: Record<Variant, { wrap: string; dot: string }> = {
  success: {
    wrap: "bg-primary/15 text-primary border-primary/30",
    dot: "bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.6)] animate-pulse",
  },
  muted: {
    wrap: "bg-muted text-muted-foreground border-border",
    dot: "bg-muted-foreground",
  },
  warning: {
    wrap: "bg-warning/15 text-warning border-warning/30",
    dot: "bg-warning",
  },
  destructive: {
    wrap: "bg-destructive/15 text-destructive border-destructive/30",
    dot: "bg-destructive",
  },
  info: {
    wrap: "bg-info/15 text-info border-info/30",
    dot: "bg-info",
  },
};

/** Status text -> variant. Keys are matched exactly (case-sensitive), so they must equal the stored/display status string. */
const STATUS_MAP: Record<string, Variant> = {
  Active: "success",
  Completed: "success",
  Inactive: "muted",
  Queued: "muted",
  Paused: "warning",
  Ringing: "info",
  Pending: "warning",
  "In Progress": "info",
  Initiated: "info",
  Error: "destructive",
  Unsuccessful: "destructive",
};

/**
 * Renders `status` verbatim inside a pill styled by STATUS_MAP; a status not in the map falls back
 * to the muted style rather than failing. `className` is appended for layout tweaks (e.g. shrink-0).
 * Only the "success" dot has the glow and pulse animation.
 */
export function StatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  const variant = STATUS_MAP[status] ?? "muted";
  const v = VARIANTS[variant];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        v.wrap,
        className,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", v.dot)} />
      {status}
    </span>
  );
}
