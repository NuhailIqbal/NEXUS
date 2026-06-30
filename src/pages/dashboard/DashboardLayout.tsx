import { useEffect, useState } from "react";
import { Outlet, NavLink, useLocation, useNavigate, Link } from "react-router-dom";
import {
  LayoutDashboard, Bot, Wrench, Mic, Database,
  PhoneOutgoing, PhoneIncoming, BarChart3, Users, LifeBuoy, LogOut, ChevronDown, ChevronRight,
  Sparkles, Bell, Search, Menu, X, MessageSquare, Radio, CreditCard, Shield,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";

type NavItem = {
  label: string;
  to?: string;
  icon: React.ComponentType<{ className?: string }>;
  children?: { label: string; to: string }[];
};

const NAV: NavItem[] = [
  { label: "Quick Setup", to: "/dashboard/quick-setup", icon: LayoutDashboard },
  { label: "AI Agents", to: "/dashboard/ai-agents", icon: Bot },
  { label: "Tools", to: "/dashboard/tools", icon: Wrench },
  { label: "AI Voices", to: "/dashboard/ai-voices", icon: Mic },
  {
    label: "Database",
    icon: Database,
    children: [
      { label: "Contacts", to: "/dashboard/database/contacts" },
      { label: "Lists", to: "/dashboard/database/lists" },
      { label: "Custom Fields", to: "/dashboard/database/custom-fields" },
    ],
  },
  {
    label: "Outbound",
    icon: PhoneOutgoing,
    children: [
      { label: "Campaigns", to: "/dashboard/telephony/campaigns" },
      { label: "Phone Numbers", to: "/dashboard/telephony/phone-numbers" },
    ],
  },
  {
    label: "Inbound",
    icon: PhoneIncoming,
    children: [
      { label: "AI Receptionist", to: "/dashboard/telephony/inbound" },
      { label: "Call Logs", to: "/dashboard/telephony/inbound-logs" },
    ],
  },
  { label: "Voice Widgets", to: "/dashboard/voice-widgets", icon: Radio },
  { label: "All Conversations", to: "/dashboard/conversations", icon: MessageSquare },
  {
    label: "Analytics",
    icon: BarChart3,
    children: [
      { label: "Channel", to: "/dashboard/analytics/channel" },
      { label: "Campaign", to: "/dashboard/analytics/campaign" },
      { label: "Scenario", to: "/dashboard/analytics/scenario" },
      { label: "Flow Statistics", to: "/dashboard/analytics/flow" },
    ],
  },
  { label: "Billing", to: "/dashboard/billing", icon: CreditCard },
  { label: "Profile & Teams", to: "/dashboard/profile", icon: Users },
  { label: "Support", to: "/dashboard/support", icon: LifeBuoy },
  { label: "Admin Portal", to: "/dashboard/admin", icon: Shield },
];

const DashboardLayout = () => {
  const [mobileOpen, setMobileOpen] = useState(false);
  const navigate = useNavigate();
  const { user, loading, signOut } = useAuth();

  useEffect(() => {
    if (!loading && !user) {
      navigate("/login");
    }
  }, [user, loading, navigate]);

  if (loading || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }

  const displayName =
    (user.user_metadata?.full_name as string) || user.email || "User";
  const initials = displayName
    .split(" ")
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const profile = { name: displayName, email: user.email ?? "", avatar: initials, role: "Member" };

  const handleSignOut = async () => {
    await signOut();
    toast.success("Signed out");
    navigate("/login");
  };

  return (
    <div className="flex min-h-screen w-full bg-background">
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

      <div className="flex flex-1 flex-col lg:pl-72">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border bg-background/95 px-4 backdrop-blur sm:px-6">
          <button
            onClick={() => setMobileOpen(true)}
            className="rounded-md p-2 hover:bg-muted lg:hidden"
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="relative hidden flex-1 max-w-md md:block">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              placeholder="Search…"
              className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="flex flex-1 items-center justify-end gap-3">
            <button className="relative rounded-md p-2 hover:bg-muted" aria-label="Notifications">
              <Bell className="h-5 w-5" />
              <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-primary" />
            </button>
            <div className="hidden items-center gap-2 sm:flex">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                {profile.avatar}
              </div>
              <div className="text-sm leading-tight">
                <div className="font-medium text-foreground">{profile.name}</div>
                <div className="text-xs text-muted-foreground">{profile.role}</div>
              </div>
            </div>
          </div>
        </header>

        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
};

type SidebarProfile = { name: string; email: string; avatar: string; role: string };
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
  const initialOpen = NAV.reduce<Record<string, boolean>>((acc, item) => {
    if (item.children) {
      acc[item.label] = item.children.some((c) => path.startsWith(c.to));
    }
    return acc;
  }, {});
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(initialOpen);

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
        <Link to="/dashboard/quick-setup" className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Sparkles className="h-4 w-4" />
          </div>
          <span className="text-base font-bold tracking-wide text-foreground">EDM NEXUS</span>
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
