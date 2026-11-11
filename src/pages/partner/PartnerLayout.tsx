/**
 * The referral partner's console shell: the layout route for every /partner/* page except the sign-in (/partner/login).
 * It has its own small sidebar (Overview, My Users) and top bar, none of the customer dashboard's menus, banners or chat.
 * Access: a visitor with no session is sent to /partner/login; a signed-in account that is not a partner (GET /partner/me)
 * sees a "no partner access" screen instead of the pages, and a failed lookup offers a retry rather than guessing. A paused
 * partner gets in (they keep reading their users and earnings; only "View as" is switched off, by the pages themselves).
 * The pages render in the <Outlet /> only once access is confirmed, so none of them loads data for an outsider.
 */
import { useCallback, useEffect, useState } from "react";
import { Link, NavLink, Navigate, Outlet, useNavigate } from "react-router-dom";
import { ChevronDown, Handshake, LayoutDashboard, Loader2, LogOut, Menu, X } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import { api } from "@/services/api";
import { cn } from "@/lib/utils";
import Logo from "@/components/Logo";
import ThemeToggle from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PARTNER_HOME, PARTNER_LOGIN, PARTNER_NAV, partnerAccess, type PartnerAccess, type PartnerMe } from "@/lib/partnerPortal";

const initialsOf = (name: string) =>
  name.split(" ").map((s) => s[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "P";

const PartnerLayout = () => {
  const { user, loading, signOut } = useAuth();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [access, setAccess] = useState<PartnerAccess>("checking");
  const [partner, setPartner] = useState<PartnerMe["partner"]>(null);

  const check = useCallback(() => {
    setAccess("checking");
    let live = true;
    api.getPartnerMe().then(({ data }) => {
      if (!live) return;
      const a = partnerAccess(data);
      setAccess(a);
      setPartner(a === "partner" ? data!.partner : null);
    });
    return () => { live = false; };
  }, []);

  // Re-checked whenever the signed-in account changes (a different login must not inherit the last one's access).
  const who = user ? user.id || user.email : null;
  useEffect(() => {
    if (loading || !who) return;
    return check();
  }, [loading, who, check]);

  const handleSignOut = async () => {
    await signOut();
    toast.success("Signed out");
    navigate(PARTNER_LOGIN);
  };

  if (loading) return <Centered><Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading…</Centered>;
  if (!user) return <Navigate to={PARTNER_LOGIN} replace />;
  if (access === "checking") return <Centered><Loader2 className="mr-2 h-5 w-5 animate-spin" /> Checking your partner access…</Centered>;

  if (access !== "partner") {
    const unknown = access === "unknown";
    return (
      <Centered>
        <div className="w-full max-w-md space-y-4 rounded-xl border border-border bg-card p-8 text-center">
          <Handshake className="mx-auto h-8 w-8 text-muted-foreground" />
          <h1 className="text-xl font-semibold text-foreground">{unknown ? "We could not check your access" : "No partner access"}</h1>
          <p className="text-sm text-muted-foreground">
            {unknown
              ? "The Partner Portal could not confirm your account just now. Check your connection and try again."
              : `${user.email} is not set up as a referral partner. Sign in with your partner account, or go to your dashboard.`}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
            {unknown
              ? <Button onClick={check}>Try again</Button>
              : <Button onClick={handleSignOut}>Sign in as a partner</Button>}
            <Button variant="outline" asChild><Link to="/dashboard">Go to my dashboard</Link></Button>
          </div>
        </div>
      </Centered>
    );
  }

  const name = partner?.name || user.user_metadata?.full_name || user.email || "Partner";
  const initials = initialsOf(name);

  return (
    <div className="flex min-h-screen w-full bg-background">
      {mobileOpen && <div className="fixed inset-0 z-40 bg-black/50 lg:hidden" onClick={() => setMobileOpen(false)} />}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-72 flex-col sidebar-ambient text-sidebar-foreground transition-transform duration-200 lg:translate-x-0",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex h-16 items-center justify-between border-b border-sidebar-border px-5">
          <Link to={PARTNER_HOME} className="flex items-center"><Logo linked={false} /></Link>
          <button onClick={() => setMobileOpen(false)} className="rounded-md p-1.5 text-sidebar-muted hover:bg-sidebar-accent lg:hidden" aria-label="Close menu">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mx-3 mt-4 rounded-xl border border-sidebar-border bg-sidebar-accent/40 p-3">
          <div className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-semibold text-primary">
            <Handshake className="h-3 w-3" /> Partner Portal
          </div>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">{initials}</div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-foreground">{name}</div>
              <div className="truncate text-xs text-sidebar-muted">{user.email}</div>
            </div>
          </div>
          {partner?.status === "paused" && <p className="mt-2 text-xs text-amber-500">Paused: you can still see your users and earnings.</p>}
        </div>

        <nav className="mt-4 flex-1 overflow-y-auto px-2 pb-4" aria-label="Partner navigation">
          <ul className="space-y-0.5">
            {PARTNER_NAV.map((n) => (
              <li key={n.to}>
                <NavLink
                  to={n.to} end={n.end} onClick={() => setMobileOpen(false)}
                  className={({ isActive }) =>
                    cn(
                      "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition",
                      isActive ? "bg-primary text-primary-foreground font-semibold" : "text-sidebar-foreground hover:bg-sidebar-accent",
                    )
                  }
                >
                  {n.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className="space-y-1 border-t border-sidebar-border p-3">
          <Link to="/dashboard" className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-sidebar-foreground transition hover:bg-sidebar-accent">
            <LayoutDashboard className="h-4 w-4" /> My dashboard
          </Link>
          <button onClick={handleSignOut} className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-destructive transition hover:bg-destructive/10">
            <LogOut className="h-4 w-4" /> Sign Out
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col lg:pl-72">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border bg-background/95 px-4 backdrop-blur sm:px-6">
          <button onClick={() => setMobileOpen(true)} className="rounded-md p-2 hover:bg-muted lg:hidden" aria-label="Open menu">
            <Menu className="h-5 w-5" />
          </button>
          <span className="hidden text-sm font-medium text-muted-foreground sm:block">Partner Portal</span>
          <div className="flex flex-1 items-center justify-end gap-3">
            <ThemeToggle />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex min-w-0 items-center gap-2 rounded-md p-1 pr-2 outline-none transition-colors hover:bg-muted">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">{initials}</div>
                  <div className="hidden min-w-0 text-left text-sm leading-tight sm:block">
                    <div className="truncate font-medium text-foreground md:max-w-[10rem] lg:max-w-[14rem]">{name}</div>
                    <div className="truncate text-xs text-muted-foreground">Referral partner</div>
                  </div>
                  <ChevronDown className="hidden h-4 w-4 shrink-0 text-muted-foreground sm:block" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>
                  <div className="text-sm font-medium text-foreground">{name}</div>
                  <div className="truncate text-xs font-normal text-muted-foreground">{user.email}</div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => navigate("/dashboard")}>
                  <LayoutDashboard className="mr-2 h-4 w-4" /> My dashboard
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleSignOut} className="text-destructive focus:text-destructive">
                  <LogOut className="mr-2 h-4 w-4" /> Sign Out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8"><Outlet /></main>
      </div>
    </div>
  );
};

const Centered = ({ children }: { children: React.ReactNode }) => (
  <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4 text-sm text-muted-foreground">{children}</div>
);

export default PartnerLayout;
