/**
 * Standard page title row for dashboard pages: an h1 title, an optional muted description and an
 * optional actions slot (buttons) beside the title. Presentational only: no state or API calls.
 * Used by pages/dashboard/AIAgents.tsx and pages/dashboard/automation/AutomationList.tsx.
 */
import type { ReactNode } from "react";

/**
 * Renders the title block and `actions`. The row stacks on narrow screens and places the actions
 * on the right from the `sm` breakpoint up. `description` and `actions` are not rendered when omitted.
 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
