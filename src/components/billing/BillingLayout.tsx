/**
 * Shell for the /dashboard/billing section: page title, tab bar, and an Outlet
 * that renders the active child route (overview, transactions, call costs,
 * payment methods, promotions). Routes are declared in App.tsx.
 */
import { NavLink, Outlet } from "react-router-dom";

// Path-based tabs (not ?tab=) on purpose: the Stripe top-up return strips the query
// string when it cleans up ?topup=success, which would silently drop a tab param.
const TABS = [
  { to: "/dashboard/billing", label: "Overview", end: true },
  { to: "/dashboard/billing/transactions", label: "Transactions", end: false },
  { to: "/dashboard/billing/call-costs", label: "Call Costs", end: false },
  { to: "/dashboard/billing/payment-methods", label: "Payment methods", end: false },
  { to: "/dashboard/billing/promotions", label: "Promotions", end: false },
];

const BillingLayout = () => (
  <div className="space-y-6">
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">Billing</h1>
      <p className="text-sm text-muted-foreground">
        Manage your balance, payment methods and promotions.
      </p>
    </div>

    <div className="flex items-center gap-4 overflow-x-auto shadow-[inset_0_-1px_0_0_hsl(var(--border))] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden max-sm:pr-6 max-sm:[mask-image:linear-gradient(to_right,#000_calc(100%-1.5rem),transparent)] sm:gap-6">
      {TABS.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          className={({ isActive }) =>
            `relative shrink-0 whitespace-nowrap py-3 text-sm font-medium ${isActive ? "text-foreground [scroll-initial-target:nearest]" : "text-muted-foreground hover:text-foreground"}`
          }
        >
          {({ isActive }) => (
            <>
              {t.label}
              {isActive && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-primary" />}
            </>
          )}
        </NavLink>
      ))}
    </div>

    <Outlet />
  </div>
);

export default BillingLayout;
