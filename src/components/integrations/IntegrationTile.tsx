import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type Props = {
  icon: LucideIcon;
  title: string;
  badge?: React.ReactNode;
  actions?: React.ReactNode;
  dashed?: boolean;
  className?: string;
  children?: React.ReactNode;
};

/** Shared visual shell for every tile on the Integrations page — Google Calendar,
 *  BYOT Twilio, generic integrations (Brevo, SendGrid, …) and the DNC prompt all
 *  render through this so the grid reads as one consistent set of cards instead of
 *  a mix of full-width sections and ad-hoc boxes. */
export function IntegrationTile({ icon: Icon, title, badge, actions, dashed, className, children }: Props) {
  return (
    <div
      className={cn(
        "flex h-full flex-col gap-3 rounded-xl border p-4 transition-colors",
        dashed ? "border-dashed border-border bg-muted/30" : "border-border bg-card card-interactive",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Icon className="h-4 w-4" />
          </span>
          <span className="truncate font-semibold text-foreground">{title}</span>
        </div>
        {badge}
      </div>
      {children && <div className="flex-1 space-y-2 text-sm text-muted-foreground">{children}</div>}
      {actions && <div className="flex flex-wrap items-center gap-2 pt-1">{actions}</div>}
    </div>
  );
}
