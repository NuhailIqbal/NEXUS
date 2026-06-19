import { cn } from "@/lib/utils";

type Variant = "success" | "muted" | "warning" | "destructive" | "info";

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
