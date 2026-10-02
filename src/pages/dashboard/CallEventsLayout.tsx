import { NavLink, Outlet } from "react-router-dom";
import { cn } from "@/lib/utils";

const TABS = [
  { to: "/dashboard/call-events", label: "Events", end: true },
  { to: "/dashboard/call-events/callbacks", label: "Callbacks", end: false },
];

/** One "Call Events" page with two tabs: the events agents report, and the callbacks they lead to. */
const CallEventsLayout = () => (
  <div className="space-y-6">
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">Call Events</h1>
      <nav aria-label="Call events sections" className="mt-4 flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end}
            className={({ isActive }) => cn(
              "-mb-px border-b-2 px-4 py-2 text-sm font-medium transition",
              isActive ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground",
            )}>
            {t.label}
          </NavLink>
        ))}
      </nav>
    </div>
    <Outlet />
  </div>
);

export default CallEventsLayout;
