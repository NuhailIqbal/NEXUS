import { NavLink, Outlet } from "react-router-dom";

// Path-based tabs (not ?tab=) on purpose: the Stripe top-up return strips the query
// string when it cleans up ?topup=success, which would silently drop a tab param.
const TABS = [
  { to: "/dashboard/billing", label: "Overview", end: true },
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

    <div className="flex items-center gap-6 border-b border-border">
      {TABS.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          className={({ isActive }) =>
            `relative py-3 text-sm font-medium ${isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`
          }
        >
          {({ isActive }) => (
            <>
              {t.label}
              {isActive && <span className="absolute inset-x-0 -bottom-px h-0.5 bg-primary" />}
            </>
          )}
        </NavLink>
      ))}
    </div>

    <Outlet />
  </div>
);

export default BillingLayout;
