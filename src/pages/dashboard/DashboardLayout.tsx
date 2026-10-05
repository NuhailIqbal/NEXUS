/**
 * Authenticated shell for every /dashboard/* route: the layout route in App.tsx, so each
 * dashboard page renders inside its <Outlet />. Provides the sidebar navigation (NAV), the top
 * bar (global search, theme toggle, notification bell, user menu) and the per-account banners.
 * Uses AuthContext for the session and GET /team/me (api.getMyRole) for the role label.
 */
import { useEffect, useRef, useState } from "react";
import { Outlet, NavLink, useLocation, useNavigate, Link } from "react-router-dom";
import {
  LayoutDashboard, Bot, Mic, Database, Phone,
  PhoneOutgoing, PhoneIncoming, BarChart3, Users, LifeBuoy, LogOut, ChevronDown, ChevronRight,
  Menu, X, MessageSquare, CreditCard, Plug, Share2, Workflow, Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import { api } from "@/services/api";
import { toast } from "sonner";
import ThemeToggle from "@/components/ThemeToggle";
import NotificationBell from "@/components/NotificationBell";
import LowBalanceBanner from "@/components/LowBalanceBanner";
import ViewerBanner from "@/components/ViewerBanner";
import Logo from "@/components/Logo";
import ImpersonationBanner from "@/components/ImpersonationBanner";
import GlobalSearch from "@/components/dashboard/GlobalSearch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** One sidebar entry: either a direct link (`to`) or a collapsible group (`children`). */
type NavItem = {
  label: string;
  to?: string;
  icon: React.ComponentType<{ className?: string }>;
  children?: { label: string; to: string }[];
};

/** Sidebar menu definition, rendered in order by Sidebar. Group labels double as the keys of its open/closed state. */
const NAV: NavItem[] = [
  { label: "Quick Setup", to: "/dashboard/quick-setup", icon: LayoutDashboard },
  { label: "AI Agents", to: "/dashboard/ai-agents", icon: Bot },
  { label: "AI Voices", to: "/dashboard/ai-voices", icon: Mic },
  {
    label: "Database",
    icon: Database,
    children: [
      { label: "Contacts", to: "/dashboard/database/contacts" },
      { label: "Lists", to: "/dashboard/database/lists" },
    ],
  },
  { label: "Phone Numbers", to: "/dashboard/telephony/phone-numbers", icon: Phone },
  {
    label: "Inbound",
    icon: PhoneIncoming,
    children: [
      { label: "AI Receptionist", to: "/dashboard/telephony/inbound" },
      { label: "Call Logs", to: "/dashboard/telephony/inbound-logs" },
    ],
  },
  {
    label: "Outbound",
    icon: PhoneOutgoing,
    children: [
      { label: "Campaigns", to: "/dashboard/telephony/campaigns" },
      { label: "Call Logs", to: "/dashboard/telephony/outbound-logs" },
    ],
  },
  { label: "All Conversations", to: "/dashboard/conversations", icon: MessageSquare },
  {
    label: "Analytics",
    icon: BarChart3,
    children: [
      { label: "Channel", to: "/dashboard/analytics/channel" },
      { label: "Campaign", to: "/dashboard/analytics/campaign" },
      { label: "Scenario", to: "/dashboard/analytics/scenario" },
    ],
  },
  { label: "Call Events", to: "/dashboard/call-events", icon: Zap },
  { label: "Automation", to: "/dashboard/automation", icon: Workflow },
  { label: "Integrations", to: "/dashboard/integrations", icon: Plug },
  { label: "Billing", to: "/dashboard/billing", icon: CreditCard },
  { label: "Referrals", to: "/dashboard/referrals", icon: Share2 },
  { label: "Profile & Teams", to: "/dashboard/profile", icon: Users },
  { label: "Support", to: "/dashboard/support", icon: LifeBuoy },
];

/**
 * Layout route component for /dashboard. Waits for AuthContext to resolve, then redirects to
 * /login if nobody is signed in; until then it shows a loading placeholder instead of the
 * dashboard. Below the lg breakpoint the sidebar is an off-canvas drawer toggled by `mobileOpen`.
 * Polls the caller's team role (GET /team/me) every 20 seconds to keep the role label current
 * and to sign out a collaborator whose access the account owner has revoked.
 */
const DashboardLayout = () => {
  const [mobileOpen, setMobileOpen] = useState(false);
  const navigate = useNavigate();
  const { user, loading, signOut } = useAuth();
  const [roleLabel, setRoleLabel] = useState("Account Owner");

  // Auth guard: `loading` must be false first, otherwise a page refresh (session still being
  // restored) would bounce a signed-in user to /login.
  useEffect(() => {
    if (!loading && !user) {
      navigate("/login");
    }
  }, [user, loading, navigate]);

  // True once this session has observed itself as a sub-user (Member/Viewer).
  // If a later poll suddenly resolves as owner, that's not a legitimate role change —
  // it means the account owner removed this collaborator, so force them out.
  const wasSubUserRef = useRef(false);

  useEffect(() => {
    if (!user) return;

    // Fetches the caller's role and updates the label shown in the user menu. api.* calls
    // resolve with `data: null` on failure instead of throwing, and a failed poll is ignored so
    // a transient network error can never trigger the removed-from-team sign-out below.
    const pollRole = () => {
      api.getMyRole().then(({ data }) => {
        if (!data) return;
        setRoleLabel(data.is_owner ? "Account Owner" : data.role === "viewer" ? "Viewer" : "Member");
        if (!data.is_owner) {
          wasSubUserRef.current = true;
        } else if (wasSubUserRef.current) {
          toast.error("You've been removed from this team by the account owner.");
          signOut().then(() => navigate("/login"));
        }
      });
    };

    // Re-checked every 20s so a revoked collaborator is signed out without having to reload.
    pollRole();
    const interval = setInterval(pollRole, 20000);
    return () => clearInterval(interval);
  }, [user, signOut, navigate]);

  // Render nothing but a placeholder until a user exists, so protected content never flashes
  // for a signed-out visitor while the redirect effect above runs. All hooks stay above this
  // early return to keep their call order stable.
  if (loading || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }

  // Name shown in the sidebar and user menu: full name if set, else the email, else a generic
  // label. The avatar shows the first letters of up to the first two words of that name.
  const displayName =
    user.user_metadata?.full_name || user.email || "User";
  const initials = displayName
    .split(" ")
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const profile = { name: displayName, email: user.email ?? "", avatar: initials, role: roleLabel };

  /** Signs out through AuthContext (which also clears any impersonation flag), then returns to /login. Shared by the sidebar and the user menu. */
  const handleSignOut = async () => {
    await signOut();
    toast.success("Signed out");
    navigate("/login");
  };

  return (
    <div className="flex min-h-screen w-full bg-background">
      <ImpersonationBanner />
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <Sidebar
        mobileOpen={mobileOpen}
        onClose={() => setMobileOpen(false)}
        profile={profile}
        onSignOut={handleSignOut}
      />

      <div className="flex min-w-0 flex-1 flex-col lg:pl-72">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border bg-background/95 px-4 backdrop-blur sm:px-6">
          <button
            onClick={() => setMobileOpen(true)}
            className="rounded-md p-2 hover:bg-muted lg:hidden"
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" />
          </button>
          <GlobalSearch />
          <div className="flex flex-1 items-center justify-end gap-3">
            <ThemeToggle />
            <NotificationBell />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex min-w-0 items-center gap-2 rounded-md p-1 pr-2 outline-none transition-colors hover:bg-muted">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                    {profile.avatar}
                  </div>
                  <div className="hidden min-w-0 text-left text-sm leading-tight sm:block">
                    <div className="truncate font-medium text-foreground md:max-w-[10rem] lg:max-w-[14rem]">{profile.name}</div>
                    <div className="truncate text-xs text-muted-foreground">{profile.role}</div>
                  </div>
                  <ChevronDown className="hidden h-4 w-4 shrink-0 text-muted-foreground sm:block" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>
                  <div className="text-sm font-medium text-foreground">{profile.name}</div>
                  <div className="truncate text-xs font-normal text-muted-foreground">{profile.email}</div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => navigate("/dashboard/profile")}>
                  <Users className="mr-2 h-4 w-4" />
                  Profile &amp; Teams
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => navigate("/dashboard/billing")}>
                  <CreditCard className="mr-2 h-4 w-4" />
                  Billing
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={handleSignOut}
                  className="text-destructive focus:text-destructive"
                >
                  <LogOut className="mr-2 h-4 w-4" />
                  Sign Out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <ViewerBanner />
          <LowBalanceBanner />
          <Outlet />
        </main>
      </div>
    </div>
  );
};

type SidebarProfile = { name: string; email: string; avatar: string; role: string };
/**
 * Fixed left navigation built from NAV, with the signed-in user's card on top and Sign Out at
 * the bottom. `mobileOpen` slides it in on small screens; every link calls `onClose` so the
 * drawer closes after navigating. Groups open/close locally (see `openGroups`).
 */
function Sidebar({
  mobileOpen,
  onClose,
  profile,
  onSignOut,
}: {
  mobileOpen: boolean;
  onClose: () => void;
  profile: SidebarProfile;
  onSignOut: () => void;
}) {
  const location = useLocation();
  const path = location.pathname;
  // Groups whose child matches the current URL start expanded. This only seeds the initial
  // state; after mount, expansion is controlled solely by the user's clicks.
  const initialOpen = NAV.reduce<Record<string, boolean>>((acc, item) => {
    if (item.children) {
      acc[item.label] = item.children.some((c) => path.startsWith(c.to));
    }
    return acc;
  }, {});
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(initialOpen);

  // True on an exact match or a nested path. Matching on `to + "/"` (not a bare prefix) keeps
  // e.g. /telephony/inbound from also lighting up for /telephony/inbound-logs.
  const isActive = (to?: string) => {
    if (!to) return false;
    return path === to || path.startsWith(to + "/");
  };

  return (
    <aside
      className={cn(
        "fixed inset-y-0 left-0 z-50 flex w-72 flex-col sidebar-ambient text-sidebar-foreground transition-transform duration-200 lg:translate-x-0",
        mobileOpen ? "translate-x-0" : "-translate-x-full",
      )}
    >
      <div className="flex h-16 items-center justify-between border-b border-sidebar-border px-5">
        <Link to="/dashboard/quick-setup" className="flex items-center">
          <Logo linked={false} />
        </Link>
        <button
          onClick={onClose}
          className="rounded-md p-1.5 text-sidebar-muted hover:bg-sidebar-accent lg:hidden"
          aria-label="Close menu"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="mx-3 mt-4 rounded-xl border border-sidebar-border bg-sidebar-accent/40 p-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
            {profile.avatar}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-foreground">{profile.name}</div>
            <div className="truncate text-xs text-sidebar-muted">{profile.email}</div>
          </div>
        </div>
      </div>

      <nav className="mt-4 flex-1 overflow-y-auto px-2 pb-4">
        <ul className="space-y-0.5">
          {NAV.map((item) => {
            if (item.children) {
              const open = openGroups[item.label];
              const groupActive = item.children.some((c) => isActive(c.to));
              return (
                <li key={item.label}>
                  <button
                    onClick={() => setOpenGroups((g) => ({ ...g, [item.label]: !g[item.label] }))}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition",
                      groupActive
                        ? "bg-primary/15 text-foreground"
                        : "text-sidebar-foreground hover:bg-sidebar-accent",
                    )}
                  >
                    <item.icon className={cn("h-4 w-4", groupActive ? "text-primary" : "text-sidebar-muted")} />
                    <span className="flex-1 text-left">{item.label}</span>
                    {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </button>
                  {open && (
                    <ul className="ml-4 mt-1 space-y-0.5 border-l border-sidebar-border pl-3">
                      {item.children.map((c) => (
                        <li key={c.to}>
                          <NavLink
                            to={c.to}
                            onClick={onClose}
                            className={({ isActive: a }) =>
                              cn(
                                "block rounded-md px-3 py-1.5 text-sm transition",
                                a
                                  ? "bg-primary text-primary-foreground font-medium"
                                  : "text-sidebar-foreground hover:bg-sidebar-accent",
                              )
                            }
                          >
                            {c.label}
                          </NavLink>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            }
            // Leaf item: only group entries lack `to`, and those returned above, so `to` is set.
            // `end` limits matching to the exact path for a link to the bare /dashboard route
            // (no NAV entry uses that today).
            return (
              <li key={item.label}>
                <NavLink
                  to={item.to!}
                  onClick={onClose}
                  end={item.to === "/dashboard"}
                  className={({ isActive: a }) =>
                    cn(
                      "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition",
                      a
                        ? "bg-primary text-primary-foreground font-semibold"
                        : "text-sidebar-foreground hover:bg-sidebar-accent",
                    )
                  }
                >
                  <item.icon className="h-4 w-4" />
                  <span>{item.label}</span>
                </NavLink>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="border-t border-sidebar-border p-3">
        <button
          onClick={onSignOut}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-destructive transition hover:bg-destructive/10"
        >
          <LogOut className="h-4 w-4" />
          Sign Out
        </button>
      </div>
    </aside>
  );
}

export default DashboardLayout;
