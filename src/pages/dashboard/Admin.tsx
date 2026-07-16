import { useEffect, useState, Fragment } from "react";
import {
  Users, Bot, PhoneOutgoing, PhoneIncoming, CreditCard,
  Loader2, Search, ChevronRight, ChevronDown, ToggleLeft, ToggleRight,
  Plus, Minus, RotateCcw, TrendingUp, LogOut, Lock,
  LayoutDashboard, Package, UserCheck, DollarSign, BarChart3, FileText, Trash2, Eye, Phone,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { api, ADMIN_TOKEN_KEY } from "@/services/api";
import { toast } from "sonner";
import Logo from "@/components/Logo";
import { cn } from "@/lib/utils";
import { startImpersonation } from "@/lib/impersonation";

type AdminUser = {
  id: string;
  email: string;
  full_name: string;
  company_name: string;
  created_at: string;
  plan: string;
  status: string;
  is_active: boolean;
  outbound_limit: number;
  outbound_used: number;
  inbound_limit: number;
  inbound_used: number;
  agents_limit: number;
  agents_used: number;
  credits: number;
  rate_per_minute?: number;
  total_charges?: number;
  total_conversations: number;
  phone_numbers?: number;
  stripe_customer_id: string | null;
  current_period_end?: string | null;
};

type AdminAgent = {
  id: string;
  name: string;
  status: string;
  category: string | null;
  voice: string | null;
  created_at: string;
  owner_email: string;
  owner_name: string;
  synced: boolean;
  transfer_number: string | null;
};

type AdminPhoneNumber = {
  id: string;
  number: string;
  provider: string;
  status: string;
  agent_id: string | null;
  monthly_cost: number | null;
  created_at: string;
  expires_at: string | null;
  days_left: number | null;
  owner_email: string;
  owner_name: string;
  owner_number_count: number;
};

type AdminStats = {
  total_users: number;
  total_conversations: number;
  total_agents: number;
  active_subscriptions: number;
};

type PaymentsData = {
  summary: { total_charges: number; total_credits: number; mrr: number };
  per_user: { email: string; name: string; plan: string; status: string; total_charges: number; credits: number; stripe_customer_id: string | null }[];
  recent_calls: { email: string; phone: string; contact_name: string; direction: string; duration: string; call_cost: number; call_time: string }[];
};

type RevenueData = {
  totals: { usage_revenue: number; mrr: number; total_charges: number; estimated_total: number };
  by_plan: { plan: string; subscribers: number; mrr: number }[];
  timeseries: { day: string; label: string; revenue: number }[];
};

type AgentReportRow = { id: string; name: string; owner_email: string; total_calls: number; completed: number; qualified: number };

type UsersReportData = {
  totals: { total_users: number; active_users: number; disabled_users: number };
  signups: { day: string; label: string; signups: number }[];
  top_users: { email: string; name: string; plan: string; conversations: number; agents: number }[];
};

type AdminPlan = {
  id: string;
  name: string;
  price_display: string;
  description: string;
  outbound_limit: number;
  inbound_limit: number;
  agents_limit: number;
  rate_per_minute: number;
  user_count: number;
};

type SectionKey =
  | "overview" | "users" | "agents" | "numbers" | "plans" | "subscribers"
  | "payments" | "revenue" | "agent-report" | "user-report";

type NavLeaf = { key: SectionKey; label: string; icon: typeof Users };
type NavGroup = { group: string; icon: typeof Users; children: NavLeaf[] };
type NavEntry = NavLeaf | NavGroup;
const isNavGroup = (e: NavEntry): e is NavGroup => "children" in e;

const NAV: NavEntry[] = [
  { key: "overview",     label: "Overview",       icon: LayoutDashboard },
  { key: "users",        label: "Users",          icon: Users },
  { key: "agents",       label: "Agents",         icon: Bot },
  { key: "numbers",      label: "Numbers",        icon: Phone },
  { key: "plans",        label: "Plans",          icon: Package },
  { key: "subscribers",  label: "Subscribers",    icon: UserCheck },
  { key: "payments",     label: "Payments",       icon: CreditCard },
  {
    group: "Reports", icon: BarChart3, children: [
      { key: "revenue",      label: "Revenue Report", icon: DollarSign },
      { key: "agent-report", label: "Agent Report",   icon: BarChart3 },
      { key: "user-report",  label: "User Report",    icon: FileText },
    ],
  },
];

function StatCard({ label, value, icon: Icon }: { label: string; value: number; icon: typeof Users }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <div className="text-2xl font-bold text-foreground">{value}</div>
          <div className="text-xs text-muted-foreground">{label}</div>
        </div>
      </div>
    </div>
  );
}

// Admin dashboard — sidebar sections (users/agents/plans/subscribers + reports).

const Admin = () => {
  const [authenticated, setAuthenticated] = useState(() => !!sessionStorage.getItem(ADMIN_TOKEN_KEY));
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");

  const [section, setSection] = useState<SectionKey>("overview");
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({ Reports: true });

  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [creditAmount, setCreditAmount] = useState(10);
  const [editingLimits, setEditingLimits] = useState<string | null>(null);
  const [limitForm, setLimitForm] = useState({ outbound_limit: 0, inbound_limit: 0, agents_limit: 0, rate_per_minute: 0.1, total_charges: 0 });

  const [agents, setAgents] = useState<AdminAgent[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [agentSearch, setAgentSearch] = useState("");

  const [phoneNumbers, setPhoneNumbers] = useState<AdminPhoneNumber[]>([]);
  const [phoneNumbersLoaded, setPhoneNumbersLoaded] = useState(false);
  const [phoneSearch, setPhoneSearch] = useState("");
  const [numbersModalOwner, setNumbersModalOwner] = useState<string | null>(null);

  const [plans, setPlans] = useState<AdminPlan[]>([]);
  const [plansLoaded, setPlansLoaded] = useState(false);
  const [payments, setPayments] = useState<PaymentsData | null>(null);
  const [revenue, setRevenue] = useState<RevenueData | null>(null);
  const [agentReport, setAgentReport] = useState<AgentReportRow[]>([]);
  const [userReport, setUserReport] = useState<UsersReportData | null>(null);
  const [paymentsLoaded, setPaymentsLoaded] = useState(false);
  const [revenueLoaded, setRevenueLoaded] = useState(false);
  const [agentReportLoaded, setAgentReportLoaded] = useState(false);
  const [userReportLoaded, setUserReportLoaded] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    const { data, error } = await api.adminLogin(username, password);
    if (error || !data?.admin_token) {
      setLoginError(error || "Invalid username or password");
      return;
    }
    sessionStorage.setItem(ADMIN_TOKEN_KEY, data.admin_token);
    setAuthenticated(true);
    setLoginError("");
  };

  const handleLogout = () => {
    sessionStorage.removeItem(ADMIN_TOKEN_KEY);
    setAuthenticated(false);
  };

  const fetchData = async () => {
    const [statsRes, usersRes, plansRes] = await Promise.all([
      api.getAdminStats(),
      api.getAdminUsers(),
      api.getAdminPlans(),
    ]);
    if (statsRes.data) setStats(statsRes.data);
    if (Array.isArray(usersRes.data)) setUsers(usersRes.data);
    if (Array.isArray(plansRes.data)) { setPlans(plansRes.data); setPlansLoaded(true); }
    setLoading(false);
  };

  useEffect(() => {
    if (authenticated) fetchData();
  }, [authenticated]);

  // Lazily load data the first time each section is opened.
  useEffect(() => {
    if (section === "agents" && !agentsLoaded) {
      api.getAdminAgents().then((res) => {
        if (Array.isArray(res.data)) setAgents(res.data);
        setAgentsLoaded(true);
      });
    }
    if (section === "numbers" && !phoneNumbersLoaded) {
      api.getAdminPhoneNumbers().then((res) => {
        if (Array.isArray(res.data)) setPhoneNumbers(res.data);
        setPhoneNumbersLoaded(true);
      });
    }
    if (section === "plans" && !plansLoaded) {
      api.getAdminPlans().then((res) => { if (Array.isArray(res.data)) setPlans(res.data); setPlansLoaded(true); });
    }
    if (section === "payments" && !paymentsLoaded) {
      api.getAdminPayments().then((res) => { if (res.data) setPayments(res.data); setPaymentsLoaded(true); });
    }
    if (section === "revenue" && !revenueLoaded) {
      api.getAdminRevenue().then((res) => { if (res.data) setRevenue(res.data); setRevenueLoaded(true); });
    }
    if (section === "agent-report" && !agentReportLoaded) {
      api.getAdminAgentsReport().then((res) => { if (Array.isArray(res.data)) setAgentReport(res.data); setAgentReportLoaded(true); });
    }
    if (section === "user-report" && !userReportLoaded) {
      api.getAdminUsersReport().then((res) => { if (res.data) setUserReport(res.data); setUserReportLoaded(true); });
    }
  }, [section, agentsLoaded, phoneNumbersLoaded, plansLoaded, paymentsLoaded, revenueLoaded, agentReportLoaded, userReportLoaded]);

  const filtered = users.filter(u =>
    u.email.toLowerCase().includes(search.toLowerCase()) ||
    (u.full_name || "").toLowerCase().includes(search.toLowerCase()) ||
    (u.company_name || "").toLowerCase().includes(search.toLowerCase())
  );

  const handleToggleAccess = async (userId: string) => {
    const { error } = await api.toggleAccess(userId);
    if (error) return toast.error(error);
    toast.success("Access toggled");
    fetchData();
  };

  const handleAddCredits = async (userId: string) => {
    const { error } = await api.adjustCredits(userId, { amount: creditAmount, reason: "Admin adjustment" });
    if (error) return toast.error(error);
    toast.success(`Added ${creditAmount} credits`);
    fetchData();
  };

  const handleRemoveCredits = async (userId: string) => {
    const { error } = await api.adjustCredits(userId, { amount: -creditAmount, reason: "Admin adjustment" });
    if (error) return toast.error(error);
    toast.success(`Removed ${creditAmount} credits`);
    fetchData();
  };

  const handleResetUsage = async (userId: string) => {
    const { error } = await api.resetUsage(userId);
    if (error) return toast.error(error);
    toast.success("Usage counters reset");
    fetchData();
  };

  const handleSaveLimits = async (userId: string) => {
    const { error } = await api.updateAdminUser(userId, limitForm);
    if (error) return toast.error(error);
    toast.success("Limits updated");
    setEditingLimits(null);
    fetchData();
  };

  const handleChangePlan = async (userId: string, plan: string) => {
    // Use the real plan catalog (from /admin/plans) — no hardcoded limits/rates.
    const def = plans.find((p) => p.id === plan);
    if (!def) return toast.error("Unknown plan");
    const { error } = await api.updateAdminUser(userId, {
      plan,
      status: plan === "free" ? "trial" : "active",
      outbound_limit: def.outbound_limit,
      inbound_limit: def.inbound_limit,
      agents_limit: def.agents_limit,
      rate_per_minute: def.rate_per_minute,
      outbound_used: 0,
      inbound_used: 0,
    });
    if (error) return toast.error(error);
    toast.success(`Plan changed to ${plan}`);
    fetchData();
  };

  const handleUpdateBilling = async (userId: string, updates: Record<string, unknown>) => {
    const { error } = await api.updateAdminUser(userId, updates);
    if (error) return toast.error(error);
    toast.success("User updated");
    fetchData();
  };

  const handleImpersonate = async (userId: string, email: string) => {
    const { data, error } = await api.impersonateUser(userId);
    if (error || !data?.access_token) return toast.error(error || "Could not start impersonation");
    startImpersonation(data.access_token, email);
  };

  const handleDeleteUser = async (userId: string, label: string) => {
    if (!confirm(`Permanently delete ${label} and ALL their data (agents, contacts, calls, numbers)?\n\nThis cannot be undone.`)) return;
    const { error } = await api.deleteAdminUser(userId);
    if (error) return toast.error(error);
    toast.success("User deleted");
    setSelectedUser(null);
    fetchData();
  };

  // ── Login gate ──
  if (!authenticated) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <form onSubmit={handleLogin} className="w-full max-w-sm space-y-5 rounded-xl border border-border bg-card p-8 shadow-lg">
          <div className="text-center">
            <Lock className="mx-auto h-10 w-10 text-primary mb-3" />
            <h1 className="text-xl font-bold text-foreground">Admin Dashboard</h1>
            <p className="text-sm text-muted-foreground mt-1">Enter credentials to continue</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="admin-user">Username</Label>
            <Input id="admin-user" value={username} onChange={e => setUsername(e.target.value)} placeholder="Username" autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="admin-pass">Password</Label>
            <Input id="admin-pass" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" />
          </div>
          {loginError && <p className="text-sm text-destructive">{loginError}</p>}
          <Button type="submit" className="w-full">Sign In</Button>
        </form>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-background">
      {/* Sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-card/40 lg:flex">
        <div className="flex h-14 items-center gap-2 border-b border-border px-4">
          <Logo linked={false} />
          <span className="rounded-md bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">Admin</span>
        </div>
        <nav className="flex-1 space-y-0.5 p-3">
          {NAV.map((item) => {
            if (!isNavGroup(item)) {
              return (
                <button
                  key={item.key}
                  onClick={() => setSection(item.key)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition",
                    section === item.key
                      ? "bg-primary text-primary-foreground font-medium"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  <item.icon className="h-4 w-4" />
                  {item.label}
                </button>
              );
            }
            const open = openGroups[item.group];
            const groupActive = item.children.some((c) => c.key === section);
            return (
              <div key={item.group}>
                <button
                  onClick={() => setOpenGroups((g) => ({ ...g, [item.group]: !g[item.group] }))}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition",
                    groupActive ? "bg-primary/15 text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  <item.icon className="h-4 w-4" />
                  <span className="flex-1 text-left">{item.group}</span>
                  {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </button>
                {open && (
                  <div className="ml-4 mt-1 space-y-0.5 border-l border-border pl-3">
                    {item.children.map((c) => (
                      <button
                        key={c.key}
                        onClick={() => setSection(c.key)}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition",
                          section === c.key
                            ? "bg-primary text-primary-foreground font-medium"
                            : "text-muted-foreground hover:bg-muted hover:text-foreground",
                        )}
                      >
                        <c.icon className="h-4 w-4" />
                        {c.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
        <div className="border-t border-border p-3">
          <Button variant="ghost" size="sm" className="w-full justify-start text-destructive hover:text-destructive" onClick={handleLogout}>
            <LogOut className="mr-2 h-4 w-4" /> Logout
          </Button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar with nav dropdown */}
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-border bg-background/95 px-4 backdrop-blur lg:hidden">
          <div className="flex items-center gap-2">
            <Logo linked={false} />
            <span className="rounded-md bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">Admin</span>
          </div>
          <select
            value={section}
            onChange={(e) => setSection(e.target.value as SectionKey)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            {NAV.map((n) =>
              isNavGroup(n) ? (
                <optgroup key={n.group} label={n.group}>
                  {n.children.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                </optgroup>
              ) : (
                <option key={n.key} value={n.key}>{n.label}</option>
              )
            )}
          </select>
        </header>

        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          {loading ? (
            <div className="flex items-center justify-center py-24 text-muted-foreground">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading admin panel…
            </div>
          ) : (
            <>
              {section === "overview" && renderOverview()}
              {section === "users" && renderUsers()}
              {section === "agents" && renderAgents()}
              {section === "numbers" && renderNumbers()}
              {section === "plans" && renderPlans()}
              {section === "subscribers" && renderSubscribers()}
              {section === "payments" && renderPayments()}
              {section === "revenue" && renderRevenue()}
              {section === "agent-report" && renderAgentReport()}
              {section === "user-report" && renderUserReport()}
            </>
          )}
        </main>
      </div>
    </div>
  );

  // ── Section renderers ──

  function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
    return (
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
        <p className="text-sm text-muted-foreground">{subtitle}</p>
      </div>
    );
  }

  function money(n: number) { return `$${(n ?? 0).toFixed(2)}`; }

  function ReportLoading() {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading…
      </div>
    );
  }

  function MiniStat({ label, value }: { label: string; value: string | number }) {
    return (
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="text-2xl font-bold text-foreground">{value}</div>
        <div className="text-xs text-muted-foreground">{label}</div>
      </div>
    );
  }

  function renderPayments() {
    return (
      <div>
        <SectionHeader title="Payments" subtitle="Charges, credits and recent billed calls across all users." />
        {!paymentsLoaded || !payments ? <ReportLoading /> : (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <MiniStat label="Total Charges" value={money(payments.summary.total_charges)} />
              <MiniStat label="MRR (active subs)" value={money(payments.summary.mrr)} />
              <MiniStat label="Total Credits" value={payments.summary.total_credits} />
            </div>
            <h3 className="mb-2 mt-6 text-sm font-semibold text-foreground">By user</h3>
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr><th className="px-4 py-3">User</th><th className="px-4 py-3">Plan</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Charges</th><th className="px-4 py-3">Credits</th><th className="px-4 py-3">Stripe</th></tr>
                </thead>
                <tbody>
                  {payments.per_user.map((u, i) => (
                    <tr key={i} className="border-t border-border bg-card/30">
                      <td className="px-4 py-3"><div className="text-foreground">{u.name || "—"}</div><div className="text-xs text-muted-foreground">{u.email}</div></td>
                      <td className="px-4 py-3 capitalize">{u.plan}</td>
                      <td className="px-4 py-3">{u.status}</td>
                      <td className="px-4 py-3 text-foreground">{money(u.total_charges)}</td>
                      <td className="px-4 py-3">{u.credits}</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">{u.stripe_customer_id || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h3 className="mb-2 mt-6 text-sm font-semibold text-foreground">Recent billed calls</h3>
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr><th className="px-4 py-3">User</th><th className="px-4 py-3">Contact</th><th className="px-4 py-3">Direction</th><th className="px-4 py-3">Duration</th><th className="px-4 py-3">Cost</th><th className="px-4 py-3">Time</th></tr>
                </thead>
                <tbody>
                  {payments.recent_calls.map((c, i) => (
                    <tr key={i} className="border-t border-border bg-card/30">
                      <td className="px-4 py-3 text-xs text-muted-foreground">{c.email}</td>
                      <td className="px-4 py-3">{c.contact_name || c.phone || "—"}</td>
                      <td className="px-4 py-3 capitalize">{c.direction}</td>
                      <td className="px-4 py-3">{c.duration || "—"}</td>
                      <td className="px-4 py-3 text-foreground">{money(c.call_cost)}</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">{c.call_time ? new Date(c.call_time).toLocaleString() : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {payments.recent_calls.length === 0 && <div className="py-8 text-center text-sm text-muted-foreground">No billed calls yet.</div>}
            </div>
          </>
        )}
      </div>
    );
  }

  function renderRevenue() {
    return (
      <div>
        <SectionHeader title="Revenue Report" subtitle="Usage revenue, subscriptions, and a 30-day trend." />
        {!revenueLoaded || !revenue ? <ReportLoading /> : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <MiniStat label="Usage Revenue" value={money(revenue.totals.usage_revenue)} />
              <MiniStat label="MRR" value={money(revenue.totals.mrr)} />
              <MiniStat label="Est. Total" value={money(revenue.totals.estimated_total)} />
              <MiniStat label="Lifetime Charges" value={money(revenue.totals.total_charges)} />
            </div>
            <div className="mt-6 rounded-xl border border-border bg-card p-5">
              <h3 className="mb-4 font-semibold text-foreground">Usage revenue (last 30 days)</h3>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={revenue.timeseries}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="label" stroke="hsl(var(--muted-foreground))" fontSize={12} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} />
                    <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8 }} />
                    <Line type="monotone" dataKey="revenue" name="Revenue ($)" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
            <h3 className="mb-2 mt-6 text-sm font-semibold text-foreground">Revenue by plan</h3>
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr><th className="px-4 py-3">Plan</th><th className="px-4 py-3">Active Subscribers</th><th className="px-4 py-3">MRR</th></tr>
                </thead>
                <tbody>
                  {revenue.by_plan.map((p, i) => (
                    <tr key={i} className="border-t border-border bg-card/30">
                      <td className="px-4 py-3 capitalize">{p.plan}</td>
                      <td className="px-4 py-3">{p.subscribers}</td>
                      <td className="px-4 py-3 text-foreground">{money(p.mrr)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    );
  }

  function renderAgentReport() {
    return (
      <div>
        <SectionHeader title="Agent Report" subtitle="Every agent's call performance across the platform." />
        {!agentReportLoaded ? <ReportLoading /> : (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr><th className="px-4 py-3">Agent</th><th className="px-4 py-3">Owner</th><th className="px-4 py-3">Total Calls</th><th className="px-4 py-3">Completed</th><th className="px-4 py-3">Qualified</th></tr>
              </thead>
              <tbody>
                {agentReport.map((a) => (
                  <tr key={a.id} className="border-t border-border bg-card/30">
                    <td className="px-4 py-3 font-medium text-foreground">{a.name}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{a.owner_email}</td>
                    <td className="px-4 py-3 text-foreground">{a.total_calls}</td>
                    <td className="px-4 py-3">{a.completed}</td>
                    <td className="px-4 py-3 font-medium text-success">{a.qualified}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {agentReport.length === 0 && <div className="py-8 text-center text-sm text-muted-foreground">No agents yet.</div>}
          </div>
        )}
      </div>
    );
  }

  function renderUserReport() {
    return (
      <div>
        <SectionHeader title="User Report" subtitle="Sign-ups, active users, and the most active accounts." />
        {!userReportLoaded || !userReport ? <ReportLoading /> : (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <MiniStat label="Total Users" value={userReport.totals.total_users} />
              <MiniStat label="Active" value={userReport.totals.active_users} />
              <MiniStat label="Disabled" value={userReport.totals.disabled_users} />
            </div>
            <div className="mt-6 rounded-xl border border-border bg-card p-5">
              <h3 className="mb-4 font-semibold text-foreground">Sign-ups (last 30 days)</h3>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={userReport.signups}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="label" stroke="hsl(var(--muted-foreground))" fontSize={12} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} allowDecimals={false} />
                    <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8 }} />
                    <Line type="monotone" dataKey="signups" name="Sign-ups" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
            <h3 className="mb-2 mt-6 text-sm font-semibold text-foreground">Top users by activity</h3>
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr><th className="px-4 py-3">User</th><th className="px-4 py-3">Plan</th><th className="px-4 py-3">Conversations</th><th className="px-4 py-3">Agents</th></tr>
                </thead>
                <tbody>
                  {userReport.top_users.map((u, i) => (
                    <tr key={i} className="border-t border-border bg-card/30">
                      <td className="px-4 py-3"><div className="text-foreground">{u.name || "—"}</div><div className="text-xs text-muted-foreground">{u.email}</div></td>
                      <td className="px-4 py-3 capitalize">{u.plan}</td>
                      <td className="px-4 py-3 text-foreground">{u.conversations}</td>
                      <td className="px-4 py-3">{u.agents}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    );
  }

  function renderOverview() {
    return (
      <div>
        <SectionHeader title="Overview" subtitle="Platform snapshot across all users." />
        {stats && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Total Users" value={stats.total_users} icon={Users} />
            <StatCard label="Total Conversations" value={stats.total_conversations} icon={PhoneOutgoing} />
            <StatCard label="Total Agents" value={stats.total_agents} icon={Bot} />
            <StatCard label="Active Subscriptions" value={stats.active_subscriptions} icon={TrendingUp} />
          </div>
        )}
      </div>
    );
  }

  function renderPlans() {
    return (
      <div>
        <SectionHeader title="Plans" subtitle="Available plans and how many users are on each." />
        {!plansLoaded ? (
          <ReportLoading />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {plans.map((p) => (
              <div key={p.id} className="rounded-xl border border-border bg-card p-5">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-foreground">{p.name}</h3>
                  <span className="text-sm font-medium text-primary">{p.price_display}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{p.description}</p>
                <p className="mt-3 text-xs text-muted-foreground">
                  {p.outbound_limit >= 999999 ? "Unlimited" : p.outbound_limit} out / {p.inbound_limit >= 999999 ? "Unlimited" : p.inbound_limit} in · {p.agents_limit} agents · ${p.rate_per_minute.toFixed(2)}/min
                </p>
                <div className="mt-4 flex items-center gap-2 border-t border-border pt-3">
                  <span className="text-2xl font-bold text-foreground">{p.user_count}</span>
                  <span className="text-xs text-muted-foreground">user(s) on this plan</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  function renderSubscribers() {
    const subs = users.filter((u) => (u.plan || "free") !== "free");
    return (
      <div>
        <SectionHeader title="Subscribers" subtitle="Users on a paid plan and their subscription details." />
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">User</th>
                <th className="px-4 py-3">Plan</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Renews</th>
                <th className="px-4 py-3">Credits</th>
                <th className="px-4 py-3">Stripe</th>
              </tr>
            </thead>
            <tbody>
              {subs.map((u) => (
                <tr key={u.id} className="border-t border-border bg-card/30">
                  <td className="px-4 py-3">
                    <div className="font-medium text-foreground">{u.full_name || " "}</div>
                    <div className="text-xs text-muted-foreground">{u.email}</div>
                  </td>
                  <td className="px-4 py-3"><Badge variant="outline" className="capitalize">{u.plan}</Badge></td>
                  <td className="px-4 py-3"><Badge variant={u.status === "active" ? "default" : "secondary"}>{u.status}</Badge></td>
                  <td className="px-4 py-3 text-muted-foreground">{u.current_period_end ? new Date(u.current_period_end).toLocaleDateString() : "—"}</td>
                  <td className="px-4 py-3 text-foreground">{u.credits}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{u.stripe_customer_id || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {subs.length === 0 && <div className="py-8 text-center text-sm text-muted-foreground">No paid subscribers yet.</div>}
        </div>
      </div>
    );
  }

  function renderAgents() {
    const fa = agents.filter((a) =>
      a.name.toLowerCase().includes(agentSearch.toLowerCase()) ||
      (a.owner_email || "").toLowerCase().includes(agentSearch.toLowerCase())
    );
    return (
      <div>
        <SectionHeader title="Agents" subtitle="Every AI agent created across all users." />
        <div className="relative mb-4 max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            placeholder="Search by agent name or owner email…"
            value={agentSearch}
            onChange={(e) => setAgentSearch(e.target.value)}
            className="h-10 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        {!agentsLoaded ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading agents…
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Agent</th>
                  <th className="px-4 py-3">Owner</th>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3">Voice</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">VAPI</th>
                  <th className="px-4 py-3">Created</th>
                </tr>
              </thead>
              <tbody>
                {fa.map((a) => (
                  <tr key={a.id} className="border-t border-border bg-card/30">
                    <td className="px-4 py-3 font-medium text-foreground">{a.name}</td>
                    <td className="px-4 py-3">
                      <div className="text-foreground">{a.owner_name || "—"}</div>
                      <div className="text-xs text-muted-foreground">{a.owner_email}</div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{a.category || "—"}</td>
                    <td className="px-4 py-3 text-muted-foreground">{a.voice || "—"}</td>
                    <td className="px-4 py-3"><Badge variant={a.status === "Active" ? "default" : "secondary"}>{a.status}</Badge></td>
                    <td className="px-4 py-3">
                      {a.synced
                        ? <span className="text-xs font-medium text-success">Synced</span>
                        : <span className="text-xs text-muted-foreground">Not synced</span>}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{a.created_at ? new Date(a.created_at).toLocaleDateString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {fa.length === 0 && <div className="py-8 text-center text-sm text-muted-foreground">No agents found.</div>}
          </div>
        )}
      </div>
    );
  }

  function renderNumbers() {
    const q = phoneSearch.toLowerCase();
    const fmt = (d: string | null) => (d ? new Date(d).toLocaleDateString() : "—");
    const daysMeta = (dl: number | null) => {
      const expired = dl != null && dl < 0;
      const dueSoon = dl != null && dl >= 0 && dl <= 5;
      const label = dl == null ? "" : expired ? "expired" : `${dl} day${dl === 1 ? "" : "s"} left`;
      const cls = expired ? "text-destructive font-medium" : dueSoon ? "text-yellow-500" : "text-muted-foreground";
      return { label, cls };
    };

    // One row per owner; the modal drills into that owner's individual numbers.
    const groupMap = new Map<string, { owner_email: string; owner_name: string; numbers: AdminPhoneNumber[] }>();
    for (const n of phoneNumbers) {
      const key = n.owner_email || n.owner_name || n.id;
      if (!groupMap.has(key)) groupMap.set(key, { owner_email: n.owner_email, owner_name: n.owner_name, numbers: [] });
      groupMap.get(key)!.numbers.push(n);
    }
    const groups = Array.from(groupMap.values()).filter((g) =>
      (g.owner_email || "").toLowerCase().includes(q) ||
      (g.owner_name || "").toLowerCase().includes(q) ||
      g.numbers.some((n) => (n.number || "").toLowerCase().includes(q))
    );

    const activeGroup = numbersModalOwner ? groupMap.get(numbersModalOwner) ?? null : null;

    return (
      <div>
        <SectionHeader title="Numbers" subtitle="How many numbers each user owns. Click a user to see all their numbers and expiry dates." />
        <div className="relative mb-4 max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            placeholder="Search by number or owner email…"
            value={phoneSearch}
            onChange={(e) => setPhoneSearch(e.target.value)}
            className="h-10 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        {!phoneNumbersLoaded ? (
          <ReportLoading />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Owner</th>
                  <th className="px-4 py-3 text-center">Numbers</th>
                  <th className="px-4 py-3">Total Monthly</th>
                  <th className="px-4 py-3">Soonest Expiry</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const count = g.numbers.length;
                  const totalMonthly = g.numbers.reduce((s, n) => s + (n.monthly_cost ?? 0), 0);
                  const withDays = g.numbers.filter((n) => n.days_left != null);
                  const soonest = withDays.length
                    ? withDays.reduce((a, b) => ((a.days_left ?? 0) <= (b.days_left ?? 0) ? a : b))
                    : null;
                  const dm = daysMeta(soonest?.days_left ?? null);
                  const key = g.owner_email || g.owner_name;
                  return (
                    <tr
                      key={key}
                      onClick={() => setNumbersModalOwner(key)}
                      className="cursor-pointer border-t border-border bg-card/30 hover:bg-muted/30"
                    >
                      <td className="px-4 py-3">
                        <div className="font-medium text-foreground">{g.owner_name || "—"}</div>
                        <div className="text-xs text-muted-foreground">{g.owner_email}</div>
                      </td>
                      <td className="px-4 py-3 text-center text-lg font-bold text-foreground">{count}</td>
                      <td className="px-4 py-3 text-muted-foreground">{totalMonthly > 0 ? `$${totalMonthly.toFixed(2)}` : "Free"}</td>
                      <td className="px-4 py-3">
                        {soonest ? (
                          <>
                            <div className="text-foreground">{fmt(soonest.expires_at)}</div>
                            {dm.label && <div className={`text-xs ${dm.cls}`}>{dm.label}</div>}
                          </>
                        ) : "—"}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {groups.length === 0 && <div className="py-8 text-center text-sm text-muted-foreground">No numbers found.</div>}
          </div>
        )}

        {/* Per-owner drill-down: all numbers of the clicked user */}
        <Dialog open={!!activeGroup} onOpenChange={(o) => { if (!o) setNumbersModalOwner(null); }}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Numbers owned by {activeGroup?.owner_name || activeGroup?.owner_email || ""}</DialogTitle>
              <DialogDescription>
                {activeGroup?.owner_email} · {activeGroup?.numbers.length || 0} number(s)
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-[60vh] overflow-y-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">Number</th>
                    <th className="px-3 py-2">Provider</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Purchased</th>
                    <th className="px-3 py-2">Expires</th>
                    <th className="px-3 py-2">Monthly</th>
                  </tr>
                </thead>
                <tbody>
                  {activeGroup?.numbers.map((n) => {
                    const dm = daysMeta(n.days_left);
                    return (
                      <tr key={n.id} className="border-t border-border">
                        <td className="px-3 py-2 font-medium text-foreground">{n.number || "—"}</td>
                        <td className="px-3 py-2 capitalize text-muted-foreground">{n.provider}</td>
                        <td className="px-3 py-2"><Badge variant={n.status === "Active" ? "default" : "secondary"}>{n.status}</Badge></td>
                        <td className="px-3 py-2 text-muted-foreground">{fmt(n.created_at)}</td>
                        <td className="px-3 py-2">
                          <div className="text-foreground">{fmt(n.expires_at)}</div>
                          {dm.label && <div className={`text-xs ${dm.cls}`}>{dm.label}</div>}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">{(n.monthly_cost ?? 0) > 0 ? `$${(n.monthly_cost ?? 0).toFixed(2)}` : "Free"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  function renderUsers() {
    return (
      <div>
        <SectionHeader title="Users" subtitle="Manage users, billing, limits and credits." />
        <div className="relative mb-4 max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            placeholder="Search users by email, name or company..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="h-10 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">User</th>
                <th className="px-4 py-3">Plan</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Outbound</th>
                <th className="px-4 py-3">Inbound</th>
                <th className="px-4 py-3">Agents</th>
                <th className="px-4 py-3">Numbers</th>
                <th className="px-4 py-3">Credits</th>
                <th className="px-4 py-3">Calls</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(u => (
                <Fragment key={u.id}>
                  <tr className="border-t border-border bg-card/30 hover:bg-muted/30 cursor-pointer"
                    onClick={() => setSelectedUser(selectedUser === u.id ? null : u.id)}>
                    <td className="px-4 py-3">
                      <div className="font-medium text-foreground">{u.full_name || " "}</div>
                      <div className="text-xs text-muted-foreground">{u.email}</div>
                      {u.company_name && <div className="text-xs text-muted-foreground">{u.company_name}</div>}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="outline" className="capitalize">{u.plan}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={u.is_active ? (u.status === "active" ? "default" : "secondary") : "destructive"}>
                        {u.is_active ? u.status : "Disabled"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-foreground">{u.outbound_used}/{u.outbound_limit}</td>
                    <td className="px-4 py-3 text-foreground">{u.inbound_used}/{u.inbound_limit}</td>
                    <td className="px-4 py-3 text-foreground">{u.agents_used}/{u.agents_limit}</td>
                    <td className="px-4 py-3 text-foreground">{u.phone_numbers ?? 0}</td>
                    <td className="px-4 py-3 text-foreground">{u.credits}</td>
                    <td className="px-4 py-3 text-foreground">{u.total_conversations}</td>
                    <td className="px-4 py-3">
                      <ChevronRight className={`h-4 w-4 text-muted-foreground transition ${selectedUser === u.id ? "rotate-90" : ""}`} />
                    </td>
                  </tr>

                  {selectedUser === u.id && (
                    <tr className="border-t border-border bg-muted/20">
                      <td colSpan={10} className="px-6 py-4">
                        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                          {/* Toggle Access */}
                          <div className="space-y-2">
                            <div className="text-xs font-semibold text-muted-foreground uppercase">Access</div>
                            <Button
                              size="sm"
                              variant={u.is_active ? "destructive" : "default"}
                              onClick={(e) => { e.stopPropagation(); handleToggleAccess(u.id); }}
                            >
                              {u.is_active ? <><ToggleRight className="mr-1 h-4 w-4" /> Disable</> : <><ToggleLeft className="mr-1 h-4 w-4" /> Enable</>}
                            </Button>
                          </div>

                          {/* Credits */}
                          <div className="space-y-2">
                            <div className="text-xs font-semibold text-muted-foreground uppercase">Credits ({u.credits})</div>
                            <div className="flex items-center gap-1">
                              <input
                                type="number"
                                min={1}
                                value={creditAmount}
                                onChange={e => setCreditAmount(parseInt(e.target.value) || 0)}
                                onClick={e => e.stopPropagation()}
                                className="h-8 w-16 rounded border border-input bg-background px-2 text-sm"
                              />
                              <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); handleAddCredits(u.id); }}>
                                <Plus className="h-3 w-3" />
                              </Button>
                              <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); handleRemoveCredits(u.id); }}>
                                <Minus className="h-3 w-3" />
                              </Button>
                            </div>
                          </div>

                          {/* Assign Plan (Admin Override) — options from the real plan catalog */}
                          <div className="space-y-2">
                            <div className="text-xs font-semibold text-muted-foreground uppercase">Assign Plan</div>
                            <select
                              value={u.plan}
                              onClick={e => e.stopPropagation()}
                              onChange={e => {
                                const newPlan = e.target.value;
                                if (confirm(`Assign "${newPlan}" plan to ${u.full_name || u.email}? This bypasses payment.`)) {
                                  handleChangePlan(u.id, newPlan);
                                } else {
                                  e.target.value = u.plan;
                                }
                              }}
                              className="h-8 rounded border border-input bg-background px-2 text-sm"
                            >
                              {plans.map((p) => (
                                <option key={p.id} value={p.id}>{p.name} · {p.price_display}</option>
                              ))}
                            </select>
                            <div className="text-[10px] text-muted-foreground">Admin override no payment required</div>
                          </div>

                          {/* Status */}
                          <div className="space-y-2">
                            <div className="text-xs font-semibold text-muted-foreground uppercase">Status</div>
                            <select
                              value={u.status}
                              onClick={e => e.stopPropagation()}
                              onChange={e => handleUpdateBilling(u.id, { status: e.target.value })}
                              className="h-8 rounded border border-input bg-background px-2 text-sm"
                            >
                              <option value="trial">Trial</option>
                              <option value="active">Active</option>
                              <option value="past_due">Past Due</option>
                              <option value="canceled">Canceled</option>
                            </select>
                          </div>

                          {/* Reset Usage */}
                          <div className="space-y-2">
                            <div className="text-xs font-semibold text-muted-foreground uppercase">Usage</div>
                            <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); handleResetUsage(u.id); }}>
                              <RotateCcw className="mr-1 h-3 w-3" /> Reset Counters
                            </Button>
                          </div>
                        </div>

                        {/* Custom Limits */}
                        <div className="mt-4 border-t border-border pt-4">
                          {editingLimits === u.id ? (
                            <div className="space-y-3">
                              <div className="text-xs font-semibold text-muted-foreground uppercase">Custom Limits</div>
                              <div className="flex flex-wrap gap-3">
                                <label className="space-y-1">
                                  <span className="text-xs text-muted-foreground">Outbound</span>
                                  <input type="number" value={limitForm.outbound_limit}
                                    onClick={e => e.stopPropagation()}
                                    onChange={e => setLimitForm(f => ({ ...f, outbound_limit: parseInt(e.target.value) || 0 }))}
                                    className="block h-8 w-24 rounded border border-input bg-background px-2 text-sm" />
                                </label>
                                <label className="space-y-1">
                                  <span className="text-xs text-muted-foreground">Inbound</span>
                                  <input type="number" value={limitForm.inbound_limit}
                                    onClick={e => e.stopPropagation()}
                                    onChange={e => setLimitForm(f => ({ ...f, inbound_limit: parseInt(e.target.value) || 0 }))}
                                    className="block h-8 w-24 rounded border border-input bg-background px-2 text-sm" />
                                </label>
                                <label className="space-y-1">
                                  <span className="text-xs text-muted-foreground">Agents</span>
                                  <input type="number" value={limitForm.agents_limit}
                                    onClick={e => e.stopPropagation()}
                                    onChange={e => setLimitForm(f => ({ ...f, agents_limit: parseInt(e.target.value) || 0 }))}
                                    className="block h-8 w-24 rounded border border-input bg-background px-2 text-sm" />
                                </label>
                                <label className="space-y-1">
                                  <span className="text-xs text-muted-foreground">Rate $/min</span>
                                  <input type="number" step="0.01" value={limitForm.rate_per_minute}
                                    onClick={e => e.stopPropagation()}
                                    onChange={e => setLimitForm(f => ({ ...f, rate_per_minute: parseFloat(e.target.value) || 0 }))}
                                    className="block h-8 w-24 rounded border border-input bg-background px-2 text-sm" />
                                </label>
                                <label className="space-y-1">
                                  <span className="text-xs text-muted-foreground">Total charges $</span>
                                  <input type="number" step="0.01" value={limitForm.total_charges}
                                    onClick={e => e.stopPropagation()}
                                    onChange={e => setLimitForm(f => ({ ...f, total_charges: parseFloat(e.target.value) || 0 }))}
                                    className="block h-8 w-28 rounded border border-input bg-background px-2 text-sm" />
                                </label>
                              </div>
                              <div className="flex gap-2">
                                <Button size="sm" onClick={(e) => { e.stopPropagation(); handleSaveLimits(u.id); }}>Save</Button>
                                <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); setEditingLimits(null); }}>Cancel</Button>
                              </div>
                            </div>
                          ) : (
                            <Button size="sm" variant="ghost" onClick={(e) => {
                              e.stopPropagation();
                              setLimitForm({
                                outbound_limit: u.outbound_limit,
                                inbound_limit: u.inbound_limit,
                                agents_limit: u.agents_limit,
                                rate_per_minute: u.rate_per_minute ?? 0.1,
                                total_charges: u.total_charges ?? 0,
                              });
                              setEditingLimits(u.id);
                            }}>
                              Set Custom Limits / Billing
                            </Button>
                          )}
                        </div>

                        <div className="mt-4 flex items-center justify-between border-t border-border pt-4">
                          <div className="text-xs text-muted-foreground">
                            Joined: {new Date(u.created_at).toLocaleDateString()}
                            {u.stripe_customer_id && <> &middot; Stripe: {u.stripe_customer_id}</>}
                          </div>
                          <div className="flex items-center gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={(e) => { e.stopPropagation(); handleImpersonate(u.id, u.email); }}
                            >
                              <Eye className="mr-1 h-4 w-4" /> View as user
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              onClick={(e) => { e.stopPropagation(); handleDeleteUser(u.id, u.full_name || u.email); }}
                            >
                              <Trash2 className="mr-1 h-4 w-4" /> Delete User
                            </Button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div className="py-8 text-center text-sm text-muted-foreground">No users found</div>
          )}
        </div>
      </div>
    );
  }
};

export default Admin;
