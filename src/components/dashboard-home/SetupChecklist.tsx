/**
 * First-steps card for an account that cannot take calls yet (no agent, no number, or nothing to call or answer with).
 * Three steps, each a link; the full checklist lives on the Quick Setup page. Presentational.
 */
import { Link } from "react-router-dom";
import { ArrowRight, CheckCircle2, Circle } from "lucide-react";
import { cn } from "@/lib/utils";
import { ROUTES, setupSteps, type Setup } from "@/lib/dashboardOverview";

export function SetupChecklist({ setup }: { setup: Setup }) {
  const steps = setupSteps(setup);
  const done = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done);
  return (
    <section className="min-w-0 overflow-hidden rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/10 via-card to-card p-5 sm:p-6" data-testid="setup-checklist">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-foreground">{done === 0 ? "Welcome! Let's get you calling" : "Almost ready to call"}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{done} of {steps.length} first steps done. Your numbers will appear here once calls start.</p>
        </div>
        <Link to={ROUTES.quickSetup} className="text-sm font-medium text-primary hover:underline">All setup steps</Link>
      </div>
      <ul className="mt-4 grid gap-3 md:grid-cols-3">
        {steps.map((s) => (
          <li key={s.key} className="min-w-0">
            <Link
              to={s.href}
              className={cn(
                "flex h-full items-start gap-3 rounded-xl border bg-card/80 p-3.5 transition hover:border-primary/50 hover:shadow-md hover:shadow-primary/5",
                s.done ? "border-border opacity-70" : s === next ? "border-primary/50" : "border-border",
              )}
              aria-label={`${s.title}${s.done ? " (done)" : ""}`}
            >
              {s.done ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" /> : <Circle className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />}
              <span className="min-w-0">
                <span className={cn("block text-sm font-medium text-foreground", s.done && "line-through")}>{s.title}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{s.description}</span>
                {s === next && <span className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary">Start <ArrowRight className="h-3 w-3" /></span>}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
