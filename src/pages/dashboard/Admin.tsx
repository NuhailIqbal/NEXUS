import { useEffect, useState, Fragment } from "react";
import {
  Users, Bot, PhoneOutgoing, CreditCard,
  Loader2, Search, ChevronRight, ChevronDown, ToggleLeft, ToggleRight,
  Plus, LogOut, Lock,
  LayoutDashboard, DollarSign, BarChart3, FileText, Trash2, Eye, Phone, Gift, Share2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import {
  SortableColumnHeader, TableTextFilter, TableSelectFilter, TablePagination,
} from "@/components/dashboard/table/TableControls";
import { api, ADMIN_TOKEN_KEY } from "@/services/api";
import { toast } from "sonner";
import Logo from "@/components/Logo";
import { cn } from "@/lib/utils";
import { startImpersonation, openImpersonation } from "@/lib/impersonation";
import ThemeToggle from "@/components/ThemeToggle";

type AdminUser = {
  id: string;
  email: string;
  full_name: string;
  company_name: string;
  created_at: string;
  status: string;
  is_active: boolean;
  rate_per_minute?: number;
  cost_multiplier?: number;
  total_charges?: number;
  balance?: number;
  total_conversations: number;
  phone_numbers?: number;
  stripe_customer_id: string | null;
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
};

type PaymentsUserRow = { email: string; name: string; status: string; total_charges: number; balance: number; stripe_customer_id: string | null };
type PaymentsCallRow = { email: string; phone: string; contact_name: string; direction: string; duration: string; call_cost: number; call_time: string };
type PaymentsData = {
  summary: { total_charges: number };
  per_user: PaymentsUserRow[];
  recent_calls: PaymentsCallRow[];
};

type RevenueData = {
  totals: { usage_revenue: number; total_charges: number };
  timeseries: { day: string; label: string; revenue: number }[];
};

type AgentReportRow = { id: string; name: string; owner_email: string; total_calls: number; completed: number; qualified: number };

type UserReportTopUser = { email: string; name: string; conversations: number; agents: number };
type UsersReportData = {
  totals: { total_users: number; active_users: number; disabled_users: number };
  signups: { day: string; label: string; signups: number }[];
  top_users: UserReportTopUser[];
};

type PromoCode = {
  id: string;
  code: string;
  amount: number;
  expiry_days: number | null;
  max_redemptions: number | null;
  redemption_count: number;
  valid_until: string | null;
  active: boolean;
  created_at: string;
};

type ReferralRow = {
  id: string;
  referrer_id: string;
  referee_id: string;
  referral_code: string;
  status: string;
  created_at: string;
  verified_at: string | null;
  referrer_email: string;
  referee_email: string;
};

type SectionKey =
  | "overview" | "users" | "agents" | "numbers"
  | "payments" | "promotions" | "referrals" | "revenue" | "agent-report" | "user-report";

type NavLeaf = { key: SectionKey; label: string; icon: typeof Users };
type NavGroup = { group: string; icon: typeof Users; children: NavLeaf[] };
type NavEntry = NavLeaf | NavGroup;
const isNavGroup = (e: NavEntry): e is NavGroup => "children" in e;

const NAV: NavEntry[] = [
  { key: "overview",     label: "Overview",       icon: LayoutDashboard },
  { key: "users",        label: "Users",          icon: Users },
  { key: "agents",       label: "Agents",         icon: Bot },
  { key: "numbers",      label: "Numbers",        icon: Phone },
  { key: "payments",     label: "Payments",       icon: CreditCard },
  {
    group: "Reports", icon: BarChart3, children: [
      { key: "revenue",      label: "Revenue Report", icon: DollarSign },
      { key: "agent-report", label: "Agent Report",   icon: BarChart3 },
      { key: "user-report",  label: "User Report",    icon: FileText },
    ],
  },
  { key: "promotions",   label: "Promotions",     icon: Gift },
  { key: "referrals",    label: "Referrals",      icon: Share2 },
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

// Admin dashboard — sidebar sections (users/agents/numbers/payments + reports).

const Admin = () => {
  const [authenticated, setAuthenticated] = useState(() => !!sessionStorage.getItem(ADMIN_TOKEN_KEY));
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");

  const [section, setSection] = useState<SectionKey>("overview");
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [balanceAmount, setBalanceAmount] = useState(10);
  const [editingRate, setEditingRate] = useState<string | null>(null);
  const [rateForm, setRateForm] = useState({ rate_per_minute: 0.35, cost_multiplier: 3.0, total_charges: 0 });

  const [addUserOpen, setAddUserOpen] = useState(false);
  const [addUserForm, setAddUserForm] = useState({ email: "", full_name: "", password: "" });
  // Confirmation dialogs — Disable and Delete are the two destructive actions here, so
  // both require an explicit confirm; re-enabling access needs no confirmation.
  const [pendingDisable, setPendingDisable] = useState<{ id: string; label: string } | null>(null);
  const [pendingDeleteUser, setPendingDeleteUser] = useState<{ id: string; label: string } | null>(null);
  const [addUserSaving, setAddUserSaving] = useState(false);

  const [agents, setAgents] = useState<AdminAgent[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);

  const [phoneNumbers, setPhoneNumbers] = useState<AdminPhoneNumber[]>([]);
  const [phoneNumbersLoaded, setPhoneNumbersLoaded] = useState(false);
  const [numbersModalOwner, setNumbersModalOwner] = useState<string | null>(null);

  const [payments, setPayments] = useState<PaymentsData | null>(null);
  const [revenue, setRevenue] = useState<RevenueData | null>(null);
  const [agentReport, setAgentReport] = useState<AgentReportRow[]>([]);
  const [userReport, setUserReport] = useState<UsersReportData | null>(null);
  const [paymentsLoaded, setPaymentsLoaded] = useState(false);
  const [revenueLoaded, setRevenueLoaded] = useState(false);
  const [agentReportLoaded, setAgentReportLoaded] = useState(false);
  const [userReportLoaded, setUserReportLoaded] = useState(false);
  const [promoSettings, setPromoSettings] = useState<any>(null);
  const [promoKpis, setPromoKpis] = useState<any>(null);
  const [promoLoaded, setPromoLoaded] = useState(false);
  const [promoSaving, setPromoSaving] = useState(false);
  const [promoCodes, setPromoCodes] = useState<PromoCode[]>([]);
  const [newCode, setNewCode] = useState({ code: "", amount: 20, expiry_days: "", max_redemptions: "" });
  const [creatingCode, setCreatingCode] = useState(false);
  const [referrals, setReferrals] = useState<ReferralRow[]>([]);
  const [referralsLoaded, setReferralsLoaded] = useState(false);

  // Per-table sort/filter/pagination state for every admin table (each table's
  // render fn is only invoked when its section is active, so this state must
  // live here at the top level rather than inside those functions).
  const [userSort, setUserSort] = useState<{ key: string | null; dir: "asc" | "desc" }>({ key: null, dir: "asc" });
  const [userFilters, setUserFilters] = useState<Record<string, string>>({});
  const [userPage, setUserPage] = useState(1);
  const [userPageSize, setUserPageSize] = useState(10);

  const [agentSort, setAgentSort] = useState<{ key: string | null; dir: "asc" | "desc" }>({ key: null, dir: "asc" });
  const [agentFilters, setAgentFilters] = useState<Record<string, string>>({});
  const [agentPage, setAgentPage] = useState(1);
  const [agentPageSize, setAgentPageSize] = useState(10);

  const [numberSort, setNumberSort] = useState<{ key: string | null; dir: "asc" | "desc" }>({ key: null, dir: "asc" });
  const [numberFilters, setNumberFilters] = useState<Record<string, string>>({});
  const [numberPage, setNumberPage] = useState(1);
  const [numberPageSize, setNumberPageSize] = useState(10);

  const [payUserSort, setPayUserSort] = useState<{ key: string | null; dir: "asc" | "desc" }>({ key: null, dir: "asc" });
  const [payUserFilters, setPayUserFilters] = useState<Record<string, string>>({});
  const [payUserPage, setPayUserPage] = useState(1);
  const [payUserPageSize, setPayUserPageSize] = useState(10);

  const [payCallSort, setPayCallSort] = useState<{ key: string | null; dir: "asc" | "desc" }>({ key: null, dir: "asc" });
  const [payCallFilters, setPayCallFilters] = useState<Record<string, string>>({});
  const [payCallPage, setPayCallPage] = useState(1);
  const [payCallPageSize, setPayCallPageSize] = useState(10);

  const [promoSort, setPromoSort] = useState<{ key: string | null; dir: "asc" | "desc" }>({ key: null, dir: "asc" });
  const [promoFilters, setPromoFilters] = useState<Record<string, string>>({});
  const [promoPage, setPromoPage] = useState(1);
  const [promoPageSize, setPromoPageSize] = useState(10);

  const [referralSort, setReferralSort] = useState<{ key: string | null; dir: "asc" | "desc" }>({ key: null, dir: "asc" });
  const [referralFilters, setReferralFilters] = useState<Record<string, string>>({});
  const [referralPage, setReferralPage] = useState(1);
  const [referralPageSize, setReferralPageSize] = useState(10);

  const [agentReportSort, setAgentReportSort] = useState<{ key: string | null; dir: "asc" | "desc" }>({ key: null, dir: "asc" });
  const [agentReportFilters, setAgentReportFilters] = useState<Record<string, string>>({});
  const [agentReportPage, setAgentReportPage] = useState(1);
  const [agentReportPageSize, setAgentReportPageSize] = useState(10);

  const [userReportSort, setUserReportSort] = useState<{ key: string | null; dir: "asc" | "desc" }>({ key: null, dir: "asc" });
  const [userReportFilters, setUserReportFilters] = useState<Record<string, string>>({});
  const [userReportPage, setUserReportPage] = useState(1);
  const [userReportPageSize, setUserReportPageSize] = useState(10);

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

  // The admin session token (from /admin/login) is short-lived. If it has expired,
  // force a re-login instead of showing an empty dashboard.
  const isAuthError = (err: string | null | undefined) =>
    !!err && /admin (login|session)|expired|not an admin|401|unauthor/i.test(err);

  const forceReLogin = () => {
    sessionStorage.removeItem(ADMIN_TOKEN_KEY);
    setAuthenticated(false);
    setLoading(false);
    toast.error("Admin session expired. Please log in again.");
  };

  const fetchData = async () => {
    const [statsRes, usersRes] = await Promise.all([
      api.getAdminStats(),
      api.getAdminUsers(),
    ]);
    if (isAuthError(statsRes.error)) return forceReLogin();
    if (statsRes.data) setStats(statsRes.data);
    if (Array.isArray(usersRes.data)) setUsers(usersRes.data);
    setLoading(false);
  };

  useEffect(() => {
    if (authenticated) fetchData();
  }, [authenticated]);

  // Lazily load data the first time each section is opened.
  useEffect(() => {
    if (!authenticated) return; // don't fire admin calls until logged in (avoids 401 + stuck "loaded" flags)
    if (section === "overview") {
      if (!revenueLoaded) api.getAdminRevenue().then((res) => { if (res.data) setRevenue(res.data); setRevenueLoaded(true); });
      if (!userReportLoaded) api.getAdminUsersReport().then((res) => { if (res.data) setUserReport(res.data); setUserReportLoaded(true); });
    }
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
    if (section === "payments" && !paymentsLoaded) {
      api.getAdminPayments().then((res) => { if (res.data) setPayments(res.data); setPaymentsLoaded(true); });
    }
    if (section === "promotions" && !promoLoaded) {
      Promise.all([
        api.getAdminSettings(), api.getAdminPromoKpis(), api.getAdminPromoCodes(),
      ]).then(([s, k, c]) => {
        if (s.data) setPromoSettings(s.data);
        if (k.data) setPromoKpis(k.data);
        if (Array.isArray(c.data)) setPromoCodes(c.data);
        setPromoLoaded(true);
      });
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
    if (section === "referrals" && !referralsLoaded) {
      api.getAdminReferrals().then((res) => {
        if (Array.isArray(res.data)) setReferrals(res.data);
        setReferralsLoaded(true);
      });
    }
  }, [authenticated, section, agentsLoaded, phoneNumbersLoaded, paymentsLoaded, revenueLoaded, agentReportLoaded, userReportLoaded, promoLoaded, referralsLoaded]);

  const USER_COLUMNS: { key: string; label: string }[] = [
    { key: "user", label: "User" },
    { key: "status", label: "Status" },
    { key: "balance", label: "Balance" },
    { key: "rate", label: "Rate" },
    { key: "numbers", label: "Numbers" },
    { key: "calls", label: "Calls" },
  ];
  const userText = (u: AdminUser, key: string): string => {
    if (key === "user") return `${u.full_name || ""} ${u.email} ${u.company_name || ""}`;
    if (key === "status") return u.is_active ? u.status : "Disabled";
    if (key === "balance") return String(u.balance ?? 0);
    if (key === "rate") return String(u.rate_per_minute ?? 0.35);
    if (key === "numbers") return String(u.phone_numbers ?? 0);
    if (key === "calls") return String(u.total_conversations);
    return "";
  };
  const filteredUnsorted = users.filter((u) => USER_COLUMNS.every(({ key }) => {
    if (key === "status") {
      const v = userFilters.status;
      return !v || userText(u, "status") === v;
    }
    const q = (userFilters[key] || "").trim().toLowerCase();
    return !q || userText(u, key).toLowerCase().includes(q);
  }));
  const filteredSorted = !userSort.key ? filteredUnsorted : [...filteredUnsorted].sort((a, b) => {
    const numeric = ["balance", "rate", "numbers", "calls"].includes(userSort.key!);
    let cmp: number;
    if (numeric) cmp = parseFloat(userText(a, userSort.key!)) - parseFloat(userText(b, userSort.key!));
    else cmp = userText(a, userSort.key!).toLowerCase().localeCompare(userText(b, userSort.key!).toLowerCase());
    return userSort.dir === "asc" ? cmp : -cmp;
  });
  const userTotalPages = Math.max(1, Math.ceil(filteredSorted.length / userPageSize));
  const userCurPage = Math.min(userPage, userTotalPages);
  const filtered = filteredSorted.slice((userCurPage - 1) * userPageSize, userCurPage * userPageSize);
  const toggleUserSort = (key: string) => setUserSort((s) => s.key !== key ? { key, dir: "asc" } : s.dir === "asc" ? { key, dir: "desc" } : { key: null, dir: "asc" });

  const handleAddUser = async () => {
    if (!addUserForm.email.trim() || !addUserForm.password.trim()) {
      return toast.error("Email and password are required");
    }
    if (addUserForm.password.length < 6) {
      return toast.error("Password must be at least 6 characters");
    }
    setAddUserSaving(true);
    const { error } = await api.createAdminUser({
      email: addUserForm.email.trim(),
      password: addUserForm.password,
      full_name: addUserForm.full_name.trim() || undefined,
    });
    setAddUserSaving(false);
    if (error) return toast.error(error);
    toast.success(`Account created for ${addUserForm.email.trim()}`);
    setAddUserOpen(false);
    setAddUserForm({ email: "", full_name: "", password: "" });
    fetchData();
  };

  const handleToggleAccess = async (userId: string) => {
    const { error } = await api.toggleAccess(userId);
    if (error) return toast.error(error);
    toast.success("Access toggled");
    fetchData();
  };

  const confirmDisable = async () => {
    if (!pendingDisable) return;
    await handleToggleAccess(pendingDisable.id);
    setPendingDisable(null);
  };

  const handleAddBalance = async (userId: string) => {
    if (!balanceAmount) return toast.error("Enter an amount");
    const { data, error } = await api.adjustUserBalance(userId, balanceAmount, "Admin credit");
    if (error) return toast.error(error);
    toast.success(`Added $${balanceAmount.toFixed(2)}. New balance: $${(data?.balance ?? 0).toFixed(2)}`);
    fetchData();
  };

  const handleSaveRate = async (userId: string) => {
    const { error } = await api.updateAdminUser(userId, rateForm);
    if (error) return toast.error(error);
    toast.success("Rate updated");
    setEditingRate(null);
    fetchData();
  };

  const handleUpdateBilling = async (userId: string, updates: Record<string, unknown>) => {
    const { error } = await api.updateAdminUser(userId, updates);
    if (error) return toast.error(error);
    toast.success("User updated");
    fetchData();
  };

  const handleImpersonate = async (userId: string, email: string) => {
    // Open the blank tab synchronously (inside the click) so the popup blocker
    // doesn't kill it after the await. The admin portal and the dashboard are
    // different origins in production, so the token is handed off via URL
    // (openImpersonation), not shared localStorage.
    const w = window.open("about:blank", "_blank");
    const { data, error } = await api.impersonateUser(userId);
    if (error || !data?.access_token) {
      if (w) w.close();
      return toast.error(error || "Could not start impersonation");
    }
    if (w) {
      openImpersonation(w, data.access_token, email);
      toast.success(`Opened ${email}'s dashboard in a new tab`);
    } else {
      // Popup blocked → fall back to same-tab impersonation.
      startImpersonation(data.access_token, email);
    }
  };

  const handleDeleteUser = (userId: string, label: string) => {
    setPendingDeleteUser({ id: userId, label });
  };

  const confirmDeleteUser = async () => {
    if (!pendingDeleteUser) return;
    const { error } = await api.deleteAdminUser(pendingDeleteUser.id);
    if (error) {
      toast.error(error);
      setPendingDeleteUser(null);
      return;
    }
    toast.success("User deleted");
    setSelectedUser(null);
    setPendingDeleteUser(null);
    fetchData();
  };

  // ── Login gate ──
  if (!authenticated) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <form onSubmit={handleLogin} className="w-full max-w-sm space-y-5 rounded-xl border border-border bg-card p-6 shadow-lg sm:p-8">
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
        <header className="sticky top-0 z-30 flex min-h-14 flex-wrap items-center justify-between gap-2 border-b border-border bg-background/95 px-4 py-2 backdrop-blur lg:hidden">
          <div className="flex min-w-0 items-center gap-2">
            <Logo linked={false} />
            <span className="rounded-md bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">Admin</span>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <ThemeToggle />
            <select
              value={section}
              onChange={(e) => setSection(e.target.value as SectionKey)}
              className="h-9 max-w-[55vw] rounded-md border border-input bg-background px-2 text-sm sm:max-w-none"
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
          </div>
        </header>

        {/* Desktop top bar — theme toggle at the top right */}
        <header className="sticky top-0 z-30 hidden h-14 items-center justify-end border-b border-border bg-background/95 px-6 backdrop-blur lg:flex">
          <ThemeToggle />
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
              {section === "payments" && renderPayments()}
              {section === "promotions" && renderPromotions()}
              {section === "referrals" && renderReferrals()}
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
    const PAY_USER_COLUMNS: { key: string; label: string }[] = [
      { key: "user", label: "User" }, { key: "status", label: "Status" },
      { key: "total_charges", label: "Charges" }, { key: "balance", label: "Balance" }, { key: "stripe_customer_id", label: "Stripe" },
    ];
    const payUserText = (u: PaymentsUserRow, key: string): string => {
      if (key === "user") return `${u.name || ""} ${u.email || ""}`;
      if (key === "total_charges" || key === "balance") return String(u[key] ?? 0);
      return u[key] || "";
    };
    const CALL_COLUMNS: { key: string; label: string }[] = [
      { key: "email", label: "User" }, { key: "contact", label: "Contact" }, { key: "direction", label: "Direction" },
      { key: "duration", label: "Duration" }, { key: "call_cost", label: "Cost" }, { key: "call_time", label: "Time" },
    ];
    const callText = (c: PaymentsCallRow, key: string): string => {
      if (key === "contact") return c.contact_name || c.phone || "";
      if (key === "call_time") return c.call_time ? new Date(c.call_time).toLocaleString() : "";
      if (key === "call_cost") return String(c.call_cost ?? 0);
      return c[key] || "";
    };

    let payUserRows: PaymentsUserRow[] = [];
    let payCallRows: PaymentsCallRow[] = [];
    let payUserTotalPages = 1, payUserCurPage = 1, payCallTotalPages = 1, payCallCurPage = 1;
    let payUserSortedLen = 0, payCallSortedLen = 0;
    let statusOptions: string[] = [];
    let directionOptions: string[] = [];
    if (payments) {
      statusOptions = Array.from(new Set(payments.per_user.map((u) => u.status).filter(Boolean)));
      const filteredUsers = payments.per_user.filter((u) => PAY_USER_COLUMNS.every(({ key }) => {
        if (key === "status") return !payUserFilters.status || u.status === payUserFilters.status;
        const q = (payUserFilters[key] || "").trim().toLowerCase();
        return !q || payUserText(u, key).toLowerCase().includes(q);
      }));
      const sortedUsers = !payUserSort.key ? filteredUsers : [...filteredUsers].sort((a, b) => {
        const numeric = ["total_charges", "balance"].includes(payUserSort.key!);
        const cmp = numeric ? parseFloat(payUserText(a, payUserSort.key!)) - parseFloat(payUserText(b, payUserSort.key!)) : payUserText(a, payUserSort.key!).toLowerCase().localeCompare(payUserText(b, payUserSort.key!).toLowerCase());
        return payUserSort.dir === "asc" ? cmp : -cmp;
      });
      payUserSortedLen = sortedUsers.length;
      payUserTotalPages = Math.max(1, Math.ceil(sortedUsers.length / payUserPageSize));
      payUserCurPage = Math.min(payUserPage, payUserTotalPages);
      payUserRows = sortedUsers.slice((payUserCurPage - 1) * payUserPageSize, payUserCurPage * payUserPageSize);

      directionOptions = Array.from(new Set(payments.recent_calls.map((c) => c.direction).filter(Boolean)));
      const filteredCalls = payments.recent_calls.filter((c) => CALL_COLUMNS.every(({ key }) => {
        if (key === "direction") return !payCallFilters.direction || c.direction === payCallFilters.direction;
        const q = (payCallFilters[key] || "").trim().toLowerCase();
        return !q || callText(c, key).toLowerCase().includes(q);
      }));
      const sortedCalls = !payCallSort.key ? filteredCalls : [...filteredCalls].sort((a, b) => {
        const cmp = callText(a, payCallSort.key!).toLowerCase().localeCompare(callText(b, payCallSort.key!).toLowerCase());
        return payCallSort.dir === "asc" ? cmp : -cmp;
      });
      payCallSortedLen = sortedCalls.length;
      payCallTotalPages = Math.max(1, Math.ceil(sortedCalls.length / payCallPageSize));
      payCallCurPage = Math.min(payCallPage, payCallTotalPages);
      payCallRows = sortedCalls.slice((payCallCurPage - 1) * payCallPageSize, payCallCurPage * payCallPageSize);
    }
    const togglePayUserSort = (key: string) => setPayUserSort((s) => s.key !== key ? { key, dir: "asc" } : s.dir === "asc" ? { key, dir: "desc" } : { key: null, dir: "asc" });
    const togglePayCallSort = (key: string) => setPayCallSort((s) => s.key !== key ? { key, dir: "asc" } : s.dir === "asc" ? { key, dir: "desc" } : { key: null, dir: "asc" });

    return (
      <div>
        <SectionHeader title="Payments" subtitle="Charges and recent billed calls across all users." />
        {!paymentsLoaded || !payments ? <ReportLoading /> : (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <MiniStat label="Total Charges" value={money(payments.summary.total_charges)} />
            </div>
            <h3 className="mb-2 mt-6 text-sm font-semibold text-foreground">By user</h3>
            <div className="overflow-hidden rounded-xl border border-border">
              <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead className="bg-muted/50 text-center text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  <tr className="divide-x divide-border">
                    {PAY_USER_COLUMNS.map(({ key, label }) => (
                      <th key={key} className="px-4 py-3"><SortableColumnHeader label={label} active={payUserSort.key === key} dir={payUserSort.dir} onClick={() => togglePayUserSort(key)} /></th>
                    ))}
                  </tr>
                  <tr className="divide-x divide-border border-t border-border">
                    {PAY_USER_COLUMNS.map(({ key, label }) => (
                      <th key={key} className="px-4 py-3 font-normal normal-case">
                        {key === "status" ? (
                          <TableSelectFilter value={payUserFilters.status || ""} onChange={(v) => setPayUserFilters((f) => ({ ...f, status: v }))} placeholder="Status" options={statusOptions.map((s) => ({ value: s, label: s }))} />
                        ) : (
                          <TableTextFilter value={payUserFilters[key] || ""} onChange={(v) => setPayUserFilters((f) => ({ ...f, [key]: v }))} placeholder={label} />
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {payUserRows.length === 0 ? (
                    <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">No matching users.</td></tr>
                  ) : payUserRows.map((u, i) => (
                    <tr key={i} className="divide-x divide-border border-t border-border bg-card/30">
                      <td className="px-4 py-3 text-center"><div className="text-foreground">{u.name || "—"}</div><div className="text-xs text-muted-foreground">{u.email}</div></td>
                      <td className="px-4 py-3 text-center">{u.status}</td>
                      <td className="px-4 py-3 text-center text-foreground">{money(u.total_charges)}</td>
                      <td className="px-4 py-3 text-center text-foreground">{money(u.balance)}</td>
                      <td className="px-4 py-3 text-center text-xs text-muted-foreground">{u.stripe_customer_id || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              <TablePagination page={payUserCurPage} pageSize={payUserPageSize} totalCount={payUserSortedLen} onPageChange={setPayUserPage} onPageSizeChange={(n) => { setPayUserPageSize(n); setPayUserPage(1); }} />
            </div>
            <h3 className="mb-2 mt-6 text-sm font-semibold text-foreground">Recent billed calls</h3>
            <div className="overflow-hidden rounded-xl border border-border">
              <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="bg-muted/50 text-center text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  <tr className="divide-x divide-border">
                    {CALL_COLUMNS.map(({ key, label }) => (
                      <th key={key} className="px-4 py-3"><SortableColumnHeader label={label} active={payCallSort.key === key} dir={payCallSort.dir} onClick={() => togglePayCallSort(key)} /></th>
                    ))}
                  </tr>
                  <tr className="divide-x divide-border border-t border-border">
                    {CALL_COLUMNS.map(({ key, label }) => (
                      <th key={key} className="px-4 py-3 font-normal normal-case">
                        {key === "direction" ? (
                          <TableSelectFilter value={payCallFilters.direction || ""} onChange={(v) => setPayCallFilters((f) => ({ ...f, direction: v }))} placeholder="Direction" options={directionOptions.map((d) => ({ value: d, label: d }))} />
                        ) : (
                          <TableTextFilter value={payCallFilters[key] || ""} onChange={(v) => setPayCallFilters((f) => ({ ...f, [key]: v }))} placeholder={label} />
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {payCallRows.length === 0 ? (
                    <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">{payments.recent_calls.length === 0 ? "No billed calls yet." : "No calls match your filters."}</td></tr>
                  ) : payCallRows.map((c, i) => (
                    <tr key={i} className="divide-x divide-border border-t border-border bg-card/30">
                      <td className="px-4 py-3 text-center text-xs text-muted-foreground">{c.email}</td>
                      <td className="px-4 py-3 text-center">{c.contact_name || c.phone || "—"}</td>
                      <td className="px-4 py-3 text-center capitalize">{c.direction}</td>
                      <td className="px-4 py-3 text-center">{c.duration || "—"}</td>
                      <td className="px-4 py-3 text-center text-foreground">{money(c.call_cost)}</td>
                      <td className="px-4 py-3 text-center text-xs text-muted-foreground">{c.call_time ? new Date(c.call_time).toLocaleString() : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              <TablePagination page={payCallCurPage} pageSize={payCallPageSize} totalCount={payCallSortedLen} onPageChange={setPayCallPage} onPageSizeChange={(n) => { setPayCallPageSize(n); setPayCallPage(1); }} />
            </div>
          </>
        )}
      </div>
    );
  }

  function renderPromotions() {
    const s = promoSettings || {};
    const k = promoKpis || {};
    const save = async () => {
      setPromoSaving(true);
      const { data, error } = await api.updateAdminSettings({
        promo_enabled: !!s.promo_enabled,
        promo_amount: Number(s.promo_amount) || 0,
        promo_expiry_days: Number(s.promo_expiry_days) || 0,
      });
      setPromoSaving(false);
      if (error) return toast.error(String(error));
      setPromoSettings(data);
      toast.success("Promotion settings saved");
    };
    return (
      <div className="space-y-6">
        <h2 className="text-lg font-semibold text-foreground">Promotions</h2>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MiniStat label="Free credits issued" value={`$${Number(k.credits_issued ?? 0).toFixed(2)}`} />
          <MiniStat label="Free credits consumed" value={`$${Number(k.credits_consumed ?? 0).toFixed(2)}`} />
          <MiniStat label="Conversion (Free → Paid)" value={`${k.conversion_rate ?? 0}%`} />
          <MiniStat label="Converted / total" value={`${k.converted_users ?? 0} / ${k.total_users ?? 0}`} />
          <MiniStat label="Avg LTV (paid users)" value={`$${Number(k.ltv ?? 0).toFixed(2)}`} />
          <MiniStat label="Avg time to 1st purchase" value={k.avg_time_to_first_purchase_days != null ? `${k.avg_time_to_first_purchase_days} days` : "—"} />
          <MiniStat label="CAC" value="Manual" />
        </div>

        <div className="max-w-md space-y-4 rounded-xl border border-border bg-card p-5">
          <div className="text-sm font-semibold text-foreground">Welcome promo</div>
          <label className="flex items-center justify-between gap-3 text-sm text-foreground">
            <span>Promotion enabled</span>
            <input
              type="checkbox"
              checked={!!s.promo_enabled}
              onChange={(e) => setPromoSettings({ ...s, promo_enabled: e.target.checked })}
              className="h-4 w-4 accent-primary"
            />
          </label>
          <div className="space-y-1">
            <Label>Promo amount ($)</Label>
            <Input type="number" min={0} value={s.promo_amount ?? 0}
              onChange={(e) => setPromoSettings({ ...s, promo_amount: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label>Expiry (days, 0 = never)</Label>
            <Input type="number" min={0} value={s.promo_expiry_days ?? 0}
              onChange={(e) => setPromoSettings({ ...s, promo_expiry_days: e.target.value })} />
          </div>
          <Button onClick={save} disabled={promoSaving}>{promoSaving ? "Saving…" : "Save settings"}</Button>
          <p className="text-xs text-muted-foreground">
            New signups receive this credit (one-time, expiring). Turn off to stop granting it.
          </p>
        </div>

        {/* Redeemable promo codes */}
        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Promo codes</h3>
            <p className="text-xs text-muted-foreground">
              Codes users can redeem under Billing → Promotions for wallet credit.
            </p>
          </div>

          <div className="grid grid-cols-2 items-end gap-3 rounded-xl border border-border bg-card p-4 sm:flex sm:flex-wrap">
            <div className="min-w-0 space-y-1">
              <Label className="text-xs">Code</Label>
              <Input
                className="w-full font-mono uppercase sm:w-40"
                placeholder="LAUNCH20"
                value={newCode.code}
                onChange={(e) => setNewCode({ ...newCode, code: e.target.value.toUpperCase() })}
              />
            </div>
            <div className="min-w-0 space-y-1">
              <Label className="text-xs">Credit ($)</Label>
              <Input
                type="number" min={1} className="w-full sm:w-28"
                value={newCode.amount}
                onChange={(e) => setNewCode({ ...newCode, amount: parseFloat(e.target.value) || 0 })}
              />
            </div>
            <div className="min-w-0 space-y-1">
              <Label className="text-xs">Credit expires (days)</Label>
              <Input
                type="number" min={0} className="w-full sm:w-36" placeholder="never"
                value={newCode.expiry_days}
                onChange={(e) => setNewCode({ ...newCode, expiry_days: e.target.value })}
              />
            </div>
            <div className="min-w-0 space-y-1">
              <Label className="text-xs">Max redemptions</Label>
              <Input
                type="number" min={1} className="w-full sm:w-36" placeholder="unlimited"
                value={newCode.max_redemptions}
                onChange={(e) => setNewCode({ ...newCode, max_redemptions: e.target.value })}
              />
            </div>
            <Button className="col-span-2" onClick={createCode} disabled={creatingCode || !newCode.code.trim()}>
              <Plus className="mr-1 h-4 w-4" /> {creatingCode ? "Creating…" : "Create code"}
            </Button>
          </div>

          {(() => {
            const PROMO_COLUMNS: { key: string; label: string }[] = [
              { key: "code", label: "Code" }, { key: "amount", label: "Credit" }, { key: "redemption_count", label: "Redeemed" },
              { key: "expiry_days", label: "Credit expiry" }, { key: "active", label: "Status" },
            ];
            const promoText = (c: PromoCode, key: string): string => {
              if (key === "amount") return String(c.amount);
              if (key === "redemption_count") return String(c.redemption_count);
              if (key === "expiry_days") return c.expiry_days ? `${c.expiry_days} days` : "never";
              if (key === "active") return c.active ? "Active" : "Disabled";
              return String((c as Record<string, unknown>)[key] ?? "");
            };
            const filtered = promoCodes.filter((c) => PROMO_COLUMNS.every(({ key }) => {
              if (key === "active") return !promoFilters.active || promoText(c, "active") === promoFilters.active;
              const q = (promoFilters[key] || "").trim().toLowerCase();
              return !q || promoText(c, key).toLowerCase().includes(q);
            }));
            const sorted = !promoSort.key ? filtered : [...filtered].sort((a, b) => {
              const numeric = ["amount", "redemption_count"].includes(promoSort.key!);
              const cmp = numeric ? parseFloat(promoText(a, promoSort.key!)) - parseFloat(promoText(b, promoSort.key!)) : promoText(a, promoSort.key!).toLowerCase().localeCompare(promoText(b, promoSort.key!).toLowerCase());
              return promoSort.dir === "asc" ? cmp : -cmp;
            });
            const totalPages = Math.max(1, Math.ceil(sorted.length / promoPageSize));
            const page = Math.min(promoPage, totalPages);
            const rows = sorted.slice((page - 1) * promoPageSize, page * promoPageSize);
            const toggleSort = (key: string) => setPromoSort((s) => s.key !== key ? { key, dir: "asc" } : s.dir === "asc" ? { key, dir: "desc" } : { key: null, dir: "asc" });
            return (
          <div className="overflow-hidden rounded-xl border border-border">
            <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-muted/50 text-center text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                <tr className="divide-x divide-border">
                  {PROMO_COLUMNS.map(({ key, label }) => (
                    <th key={key} className="px-4 py-3"><SortableColumnHeader label={label} active={promoSort.key === key} dir={promoSort.dir} onClick={() => toggleSort(key)} /></th>
                  ))}
                  <th className="px-4 py-3">Actions</th>
                </tr>
                <tr className="divide-x divide-border border-t border-border">
                  {PROMO_COLUMNS.map(({ key, label }) => (
                    <th key={key} className="px-4 py-3 font-normal normal-case">
                      {key === "active" ? (
                        <TableSelectFilter value={promoFilters.active || ""} onChange={(v) => setPromoFilters((f) => ({ ...f, active: v }))} placeholder="Status" options={[{ value: "Active", label: "Active" }, { value: "Disabled", label: "Disabled" }]} />
                      ) : (
                        <TableTextFilter value={promoFilters[key] || ""} onChange={(v) => setPromoFilters((f) => ({ ...f, [key]: v }))} placeholder={label} />
                      )}
                    </th>
                  ))}
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">{promoCodes.length === 0 ? "No promo codes yet." : "No codes match your filters."}</td></tr>
                ) : rows.map((c) => (
                  <tr key={c.id} className="divide-x divide-border border-t border-border bg-card/30">
                    <td className="px-4 py-3 text-center font-mono font-medium text-foreground">{c.code}</td>
                    <td className="px-4 py-3 text-center text-foreground">${Number(c.amount).toFixed(2)}</td>
                    <td className="px-4 py-3 text-center text-foreground">
                      {c.redemption_count}{c.max_redemptions ? ` / ${c.max_redemptions}` : ""}
                    </td>
                    <td className="px-4 py-3 text-center text-muted-foreground">
                      {c.expiry_days ? `${c.expiry_days} days` : "never"}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <Badge variant={c.active ? "default" : "secondary"}>
                        {c.active ? "Active" : "Disabled"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <div className="flex items-center justify-center gap-2">
                        <Button size="sm" variant="outline" onClick={() => toggleCode(c)}>
                          {c.active ? "Disable" : "Enable"}
                        </Button>
                        <Button
                          size="sm" variant="ghost"
                          className="text-destructive hover:text-destructive"
                          onClick={() => deleteCode(c)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            <TablePagination page={page} pageSize={promoPageSize} totalCount={sorted.length} onPageChange={setPromoPage} onPageSizeChange={(n) => { setPromoPageSize(n); setPromoPage(1); }} />
          </div>
            );
          })()}
        </div>
      </div>
    );
  }

  async function refreshPromoCodes() {
    const { data } = await api.getAdminPromoCodes();
    if (Array.isArray(data)) setPromoCodes(data);
  }

  async function createCode() {
    const code = newCode.code.trim().toUpperCase();
    if (!code) return toast.error("Enter a code");
    if (!newCode.amount || newCode.amount <= 0) return toast.error("Credit must be greater than 0");
    setCreatingCode(true);
    const { error } = await api.createAdminPromoCode({
      code,
      amount: newCode.amount,
      expiry_days: newCode.expiry_days ? Number(newCode.expiry_days) : null,
      max_redemptions: newCode.max_redemptions ? Number(newCode.max_redemptions) : null,
    });
    setCreatingCode(false);
    if (error) return toast.error(String(error));
    toast.success(`Code ${code} created`);
    setNewCode({ code: "", amount: 20, expiry_days: "", max_redemptions: "" });
    refreshPromoCodes();
  }

  async function toggleCode(c: PromoCode) {
    const { error } = await api.updateAdminPromoCode(c.id, { active: !c.active });
    if (error) return toast.error(String(error));
    refreshPromoCodes();
  }

  async function deleteCode(c: PromoCode) {
    if (!confirm(`Delete code ${c.code}? Credit already granted to users is not affected.`)) return;
    const { error } = await api.deleteAdminPromoCode(c.id);
    if (error) return toast.error(String(error));
    toast.success("Code deleted");
    refreshPromoCodes();
  }

  function renderReferrals() {
    const verifiedCount = referrals.filter((r) => r.status === "verified").length;
    return (
      <div className="space-y-6">
        <SectionHeader title="Referrals" subtitle="Every referral relationship platform-wide (tracking only — no credit is granted)." />

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <MiniStat label="Total referrals" value={String(referrals.length)} />
          <MiniStat label="Verified" value={String(verifiedCount)} />
          <MiniStat label="Pending" value={String(referrals.length - verifiedCount)} />
        </div>

        {(() => {
          const REFERRAL_COLUMNS: { key: string; label: string }[] = [
            { key: "referrer_email", label: "Referrer" }, { key: "referee_email", label: "Referee" }, { key: "referral_code", label: "Code" },
            { key: "status", label: "Status" }, { key: "created_at", label: "Invited" }, { key: "verified_at", label: "Verified" },
          ];
          const refText = (r: ReferralRow, key: string): string => {
            if (key === "status") return r.status === "verified" ? "Verified" : "Pending";
            if (key === "created_at") return r.created_at ? new Date(r.created_at).toLocaleDateString() : "";
            if (key === "verified_at") return r.verified_at ? new Date(r.verified_at).toLocaleDateString() : "";
            return String((r as Record<string, unknown>)[key] ?? "");
          };
          const filtered = referrals.filter((r) => REFERRAL_COLUMNS.every(({ key }) => {
            if (key === "status") return !referralFilters.status || refText(r, "status") === referralFilters.status;
            const q = (referralFilters[key] || "").trim().toLowerCase();
            return !q || refText(r, key).toLowerCase().includes(q);
          }));
          const sorted = !referralSort.key ? filtered : [...filtered].sort((a, b) => {
            const cmp = refText(a, referralSort.key!).toLowerCase().localeCompare(refText(b, referralSort.key!).toLowerCase());
            return referralSort.dir === "asc" ? cmp : -cmp;
          });
          const totalPages = Math.max(1, Math.ceil(sorted.length / referralPageSize));
          const page = Math.min(referralPage, totalPages);
          const rows = sorted.slice((page - 1) * referralPageSize, page * referralPageSize);
          const toggleSort = (key: string) => setReferralSort((s) => s.key !== key ? { key, dir: "asc" } : s.dir === "asc" ? { key, dir: "desc" } : { key: null, dir: "asc" });
          return (
        <div className="overflow-hidden rounded-xl border border-border">
          <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-muted/50 text-center text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              <tr className="divide-x divide-border">
                {REFERRAL_COLUMNS.map(({ key, label }) => (
                  <th key={key} className="px-4 py-3"><SortableColumnHeader label={label} active={referralSort.key === key} dir={referralSort.dir} onClick={() => toggleSort(key)} /></th>
                ))}
              </tr>
              <tr className="divide-x divide-border border-t border-border">
                {REFERRAL_COLUMNS.map(({ key, label }) => (
                  <th key={key} className="px-4 py-3 font-normal normal-case">
                    {key === "status" ? (
                      <TableSelectFilter value={referralFilters.status || ""} onChange={(v) => setReferralFilters((f) => ({ ...f, status: v }))} placeholder="Status" options={[{ value: "Verified", label: "Verified" }, { value: "Pending", label: "Pending" }]} />
                    ) : (
                      <TableTextFilter value={referralFilters[key] || ""} onChange={(v) => setReferralFilters((f) => ({ ...f, [key]: v }))} placeholder={label} />
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">{referrals.length === 0 ? "No referrals yet." : "No referrals match your filters."}</td></tr>
              ) : rows.map((r) => (
                <tr key={r.id} className="divide-x divide-border border-t border-border bg-card/30">
                  <td className="px-4 py-3 text-center text-foreground">{r.referrer_email || "—"}</td>
                  <td className="px-4 py-3 text-center text-foreground">{r.referee_email || "—"}</td>
                  <td className="px-4 py-3 text-center font-mono text-xs text-muted-foreground">{r.referral_code}</td>
                  <td className="px-4 py-3 text-center">
                    <Badge variant={r.status === "verified" ? "default" : "secondary"}>
                      {r.status === "verified" ? "Verified" : "Pending"}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-center text-muted-foreground">{r.created_at ? new Date(r.created_at).toLocaleDateString() : "—"}</td>
                  <td className="px-4 py-3 text-center text-muted-foreground">{r.verified_at ? new Date(r.verified_at).toLocaleDateString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <TablePagination page={page} pageSize={referralPageSize} totalCount={sorted.length} onPageChange={setReferralPage} onPageSizeChange={(n) => { setReferralPageSize(n); setReferralPage(1); }} />
        </div>
          );
        })()}
      </div>
    );
  }

  function renderRevenue() {
    return (
      <div>
        <SectionHeader title="Revenue Report" subtitle="Usage revenue and a 30-day trend." />
        {!revenueLoaded || !revenue ? <ReportLoading /> : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <MiniStat label="Usage Revenue" value={money(revenue.totals.usage_revenue)} />
              <MiniStat label="Lifetime Charges" value={money(revenue.totals.total_charges)} />
            </div>
            <div className="mt-6 rounded-xl border border-border bg-card p-5">
              <h3 className="mb-4 font-semibold text-foreground">Usage revenue (last 30 days)</h3>
              <div className="h-64 w-full [&_.recharts-surface]:overflow-visible">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={revenue.timeseries} margin={{ top: 5, right: 24, left: 0, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="label" stroke="hsl(var(--muted-foreground))" fontSize={12} minTickGap={20} tickMargin={6} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} />
                    <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8 }} />
                    <Line type="monotone" dataKey="revenue" name="Revenue ($)" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </>
        )}
      </div>
    );
  }

  function renderAgentReport() {
    const AR_COLUMNS: { key: string; label: string }[] = [
      { key: "name", label: "Agent" }, { key: "owner_email", label: "Owner" }, { key: "total_calls", label: "Total Calls" },
      { key: "completed", label: "Completed" }, { key: "qualified", label: "Qualified" },
    ];
    const arText = (a: AgentReportRow, key: string): string => String((a as unknown as Record<string, unknown>)[key] ?? "");
    const filtered = agentReport.filter((a) => AR_COLUMNS.every(({ key }) => {
      const q = (agentReportFilters[key] || "").trim().toLowerCase();
      return !q || arText(a, key).toLowerCase().includes(q);
    }));
    const sorted = !agentReportSort.key ? filtered : [...filtered].sort((a, b) => {
      const numeric = ["total_calls", "completed", "qualified"].includes(agentReportSort.key!);
      const cmp = numeric ? parseFloat(arText(a, agentReportSort.key!) || "0") - parseFloat(arText(b, agentReportSort.key!) || "0") : arText(a, agentReportSort.key!).toLowerCase().localeCompare(arText(b, agentReportSort.key!).toLowerCase());
      return agentReportSort.dir === "asc" ? cmp : -cmp;
    });
    const totalPages = Math.max(1, Math.ceil(sorted.length / agentReportPageSize));
    const page = Math.min(agentReportPage, totalPages);
    const rows = sorted.slice((page - 1) * agentReportPageSize, page * agentReportPageSize);
    const toggleSort = (key: string) => setAgentReportSort((s) => s.key !== key ? { key, dir: "asc" } : s.dir === "asc" ? { key, dir: "desc" } : { key: null, dir: "asc" });

    return (
      <div>
        <SectionHeader title="Agent Report" subtitle="Every agent's call performance across the platform." />
        {!agentReportLoaded ? <ReportLoading /> : (
          <div className="overflow-hidden rounded-xl border border-border">
            <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="bg-muted/50 text-center text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                <tr className="divide-x divide-border">
                  {AR_COLUMNS.map(({ key, label }) => (
                    <th key={key} className="px-4 py-3"><SortableColumnHeader label={label} active={agentReportSort.key === key} dir={agentReportSort.dir} onClick={() => toggleSort(key)} /></th>
                  ))}
                </tr>
                <tr className="divide-x divide-border border-t border-border">
                  {AR_COLUMNS.map(({ key, label }) => (
                    <th key={key} className="px-4 py-3 font-normal normal-case">
                      <TableTextFilter value={agentReportFilters[key] || ""} onChange={(v) => setAgentReportFilters((f) => ({ ...f, [key]: v }))} placeholder={label} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">{agentReport.length === 0 ? "No agents yet." : "No agents match your filters."}</td></tr>
                ) : rows.map((a) => (
                  <tr key={a.id} className="divide-x divide-border border-t border-border bg-card/30">
                    <td className="px-4 py-3 text-center font-medium text-foreground">{a.name}</td>
                    <td className="px-4 py-3 text-center text-xs text-muted-foreground">{a.owner_email}</td>
                    <td className="px-4 py-3 text-center text-foreground">{a.total_calls}</td>
                    <td className="px-4 py-3 text-center">{a.completed}</td>
                    <td className="px-4 py-3 text-center font-medium text-success">{a.qualified}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            <TablePagination page={page} pageSize={agentReportPageSize} totalCount={sorted.length} onPageChange={setAgentReportPage} onPageSizeChange={(n) => { setAgentReportPageSize(n); setAgentReportPage(1); }} />
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
              <div className="h-64 w-full [&_.recharts-surface]:overflow-visible">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={userReport.signups} margin={{ top: 5, right: 24, left: 0, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="label" stroke="hsl(var(--muted-foreground))" fontSize={12} minTickGap={20} tickMargin={6} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} allowDecimals={false} />
                    <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8 }} />
                    <Line type="monotone" dataKey="signups" name="Sign-ups" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
            <h3 className="mb-2 mt-6 text-sm font-semibold text-foreground">Top users by activity</h3>
            {(() => {
              const UR_COLUMNS: { key: string; label: string }[] = [
                { key: "user", label: "User" }, { key: "conversations", label: "Conversations" }, { key: "agents", label: "Agents" },
              ];
              const urText = (u: UserReportTopUser, key: string): string => {
                if (key === "user") return `${u.name || ""} ${u.email || ""}`;
                return String(u[key] ?? "");
              };
              const filtered = userReport.top_users.filter((u) => UR_COLUMNS.every(({ key }) => {
                const q = (userReportFilters[key] || "").trim().toLowerCase();
                return !q || urText(u, key).toLowerCase().includes(q);
              }));
              const sorted = !userReportSort.key ? filtered : [...filtered].sort((a, b) => {
                const numeric = ["conversations", "agents"].includes(userReportSort.key!);
                const cmp = numeric ? parseFloat(urText(a, userReportSort.key!) || "0") - parseFloat(urText(b, userReportSort.key!) || "0") : urText(a, userReportSort.key!).toLowerCase().localeCompare(urText(b, userReportSort.key!).toLowerCase());
                return userReportSort.dir === "asc" ? cmp : -cmp;
              });
              const totalPages = Math.max(1, Math.ceil(sorted.length / userReportPageSize));
              const page = Math.min(userReportPage, totalPages);
              const rows = sorted.slice((page - 1) * userReportPageSize, page * userReportPageSize);
              const toggleSort = (key: string) => setUserReportSort((s) => s.key !== key ? { key, dir: "asc" } : s.dir === "asc" ? { key, dir: "desc" } : { key: null, dir: "asc" });
              return (
            <div className="overflow-hidden rounded-xl border border-border">
              <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-sm">
                <thead className="bg-muted/50 text-center text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  <tr className="divide-x divide-border">
                    {UR_COLUMNS.map(({ key, label }) => (
                      <th key={key} className="px-4 py-3"><SortableColumnHeader label={label} active={userReportSort.key === key} dir={userReportSort.dir} onClick={() => toggleSort(key)} /></th>
                    ))}
                  </tr>
                  <tr className="divide-x divide-border border-t border-border">
                    {UR_COLUMNS.map(({ key, label }) => (
                      <th key={key} className="px-4 py-3 font-normal normal-case">
                        <TableTextFilter value={userReportFilters[key] || ""} onChange={(v) => setUserReportFilters((f) => ({ ...f, [key]: v }))} placeholder={label} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr><td colSpan={3} className="px-4 py-8 text-center text-muted-foreground">No users match your filters.</td></tr>
                  ) : rows.map((u, i: number) => (
                    <tr key={i} className="divide-x divide-border border-t border-border bg-card/30">
                      <td className="px-4 py-3 text-center"><div className="text-foreground">{u.name || "—"}</div><div className="text-xs text-muted-foreground">{u.email}</div></td>
                      <td className="px-4 py-3 text-center text-foreground">{u.conversations}</td>
                      <td className="px-4 py-3 text-center">{u.agents}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              <TablePagination page={page} pageSize={userReportPageSize} totalCount={sorted.length} onPageChange={setUserReportPage} onPageSizeChange={(n) => { setUserReportPageSize(n); setUserReportPage(1); }} />
            </div>
              );
            })()}
          </>
        )}
      </div>
    );
  }

  function renderOverview() {
    const totalNumbers = users.reduce((s, u) => s + (u.phone_numbers || 0), 0);
    const totalCharges = users.reduce((s, u) => s + (u.total_charges || 0), 0);
    return (
      <div>
        <SectionHeader title="Overview" subtitle="Platform snapshot across all users." />
        {stats && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Total Users" value={stats.total_users} icon={Users} />
            <StatCard label="Total Conversations" value={stats.total_conversations} icon={PhoneOutgoing} />
            <StatCard label="Total Agents" value={stats.total_agents} icon={Bot} />
            <StatCard label="Phone Numbers" value={totalNumbers} icon={Phone} />
          </div>
        )}

        {/* Second row — derived from live user/revenue data */}
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary"><DollarSign className="h-5 w-5" /></div>
              <div>
                <div className="text-2xl font-bold text-foreground">{money(totalCharges)}</div>
                <div className="text-xs text-muted-foreground">Lifetime Charges</div>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-6 rounded-xl border border-border bg-card p-5">
          <h3 className="mb-4 font-semibold text-foreground">Sign-ups (last 30 days)</h3>
          {userReport ? (
            <div className="h-56 w-full [&_.recharts-surface]:overflow-visible">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={userReport.signups} margin={{ top: 5, right: 24, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="label" stroke="hsl(var(--muted-foreground))" fontSize={12} minTickGap={20} tickMargin={6} />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} allowDecimals={false} />
                  <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8 }} />
                  <Line type="monotone" dataKey="signups" name="Sign-ups" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <ReportLoading />
          )}
        </div>
      </div>
    );
  }

  function renderAgents() {
    const AGENT_COLUMNS: { key: string; label: string }[] = [
      { key: "name", label: "Agent" },
      { key: "owner", label: "Owner" },
      { key: "category", label: "Industry" },
      { key: "voice", label: "Voice" },
      { key: "status", label: "Status" },
      { key: "synced", label: "VAPI" },
      { key: "created_at", label: "Created" },
    ];
    const agentText = (a: AdminAgent, key: string): string => {
      if (key === "owner") return `${a.owner_name || ""} ${a.owner_email || ""}`;
      if (key === "synced") return a.synced ? "Synced" : "Not synced";
      if (key === "created_at") return a.created_at ? new Date(a.created_at).toLocaleDateString() : "";
      return String((a as Record<string, unknown>)[key] ?? "");
    };
    const categoryOptions = Array.from(new Set(agents.map((a) => a.category).filter(Boolean))) as string[];
    const filtered = agents.filter((a) => AGENT_COLUMNS.every(({ key }) => {
      if (key === "status" || key === "category" || key === "synced") {
        const v = agentFilters[key];
        if (!v) return true;
        if (key === "synced") return (a.synced ? "Synced" : "Not synced") === v;
        return (a as Record<string, unknown>)[key] === v;
      }
      const q = (agentFilters[key] || "").trim().toLowerCase();
      return !q || agentText(a, key).toLowerCase().includes(q);
    }));
    const sorted = !agentSort.key ? filtered : [...filtered].sort((x, y) => {
      const av = agentText(x, agentSort.key!).toLowerCase();
      const bv = agentText(y, agentSort.key!).toLowerCase();
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return agentSort.dir === "asc" ? cmp : -cmp;
    });
    const totalPages = Math.max(1, Math.ceil(sorted.length / agentPageSize));
    const page = Math.min(agentPage, totalPages);
    const fa = sorted.slice((page - 1) * agentPageSize, page * agentPageSize);
    const toggleSort = (key: string) => setAgentSort((s) => s.key !== key ? { key, dir: "asc" } : s.dir === "asc" ? { key, dir: "desc" } : { key: null, dir: "asc" });

    return (
      <div>
        <SectionHeader title="Agents" subtitle="Every AI agent created across all users." />
        {!agentsLoaded ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading agents…
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="bg-muted/50 text-center text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  <tr className="divide-x divide-border">
                    {AGENT_COLUMNS.map(({ key, label }) => (
                      <th key={key} className="px-4 py-3">
                        <SortableColumnHeader label={label} active={agentSort.key === key} dir={agentSort.dir} onClick={() => toggleSort(key)} />
                      </th>
                    ))}
                  </tr>
                  <tr className="divide-x divide-border border-t border-border">
                    {AGENT_COLUMNS.map(({ key, label }) => (
                      <th key={key} className="px-4 py-3 font-normal normal-case">
                        {key === "category" ? (
                          <TableSelectFilter value={agentFilters.category || ""} onChange={(v) => setAgentFilters((f) => ({ ...f, category: v }))} placeholder="Industry" options={categoryOptions.map((c) => ({ value: c, label: c }))} />
                        ) : key === "status" ? (
                          <TableSelectFilter value={agentFilters.status || ""} onChange={(v) => setAgentFilters((f) => ({ ...f, status: v }))} placeholder="Status" options={[{ value: "Active", label: "Active" }, { value: "Inactive", label: "Inactive" }]} />
                        ) : key === "synced" ? (
                          <TableSelectFilter value={agentFilters.synced || ""} onChange={(v) => setAgentFilters((f) => ({ ...f, synced: v }))} placeholder="VAPI" options={[{ value: "Synced", label: "Synced" }, { value: "Not synced", label: "Not synced" }]} />
                        ) : (
                          <TableTextFilter value={agentFilters[key] || ""} onChange={(v) => setAgentFilters((f) => ({ ...f, [key]: v }))} placeholder={label} />
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {fa.length === 0 ? (
                    <tr><td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">{agents.length === 0 ? "No agents found." : "No agents match your filters."}</td></tr>
                  ) : fa.map((a) => (
                    <tr key={a.id} className="divide-x divide-border border-t border-border bg-card/30">
                      <td className="px-4 py-3 text-center font-medium text-foreground">{a.name}</td>
                      <td className="px-4 py-3 text-center">
                        <div className="text-foreground">{a.owner_name || "—"}</div>
                        <div className="text-xs text-muted-foreground">{a.owner_email}</div>
                      </td>
                      <td className="px-4 py-3 text-center text-muted-foreground">{a.category || "—"}</td>
                      <td className="px-4 py-3 text-center text-muted-foreground">{a.voice || "—"}</td>
                      <td className="px-4 py-3 text-center"><Badge variant={a.status === "Active" ? "default" : "secondary"}>{a.status}</Badge></td>
                      <td className="px-4 py-3 text-center">
                        {a.synced
                          ? <span className="text-xs font-medium text-success">Synced</span>
                          : <span className="text-xs text-muted-foreground">Not synced</span>}
                      </td>
                      <td className="px-4 py-3 text-center text-muted-foreground">{a.created_at ? new Date(a.created_at).toLocaleDateString() : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <TablePagination page={page} pageSize={agentPageSize} totalCount={sorted.length} onPageChange={setAgentPage} onPageSizeChange={(n) => { setAgentPageSize(n); setAgentPage(1); }} />
          </div>
        )}
      </div>
    );
  }

  function renderNumbers() {
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
    const allGroups = Array.from(groupMap.values()).map((g) => {
      const totalMonthly = g.numbers.reduce((s, n) => s + (n.monthly_cost ?? 0), 0);
      const withDays = g.numbers.filter((n) => n.days_left != null);
      const soonest = withDays.length
        ? withDays.reduce((a, b) => ((a.days_left ?? 0) <= (b.days_left ?? 0) ? a : b))
        : null;
      return { ...g, count: g.numbers.length, totalMonthly, soonest };
    });

    const q = (numberFilters.owner || "").trim().toLowerCase();
    const countQ = (numberFilters.count || "").trim().toLowerCase();
    const totalMonthlyQ = (numberFilters.totalMonthly || "").trim().toLowerCase();
    const soonestQ = (numberFilters.soonest || "").trim().toLowerCase();
    const filtered = allGroups.filter((g) => {
      if (q && !((g.owner_email || "").toLowerCase().includes(q) || (g.owner_name || "").toLowerCase().includes(q))) return false;
      if (countQ && !String(g.count).includes(countQ)) return false;
      if (totalMonthlyQ) {
        const label = g.totalMonthly > 0 ? `$${g.totalMonthly.toFixed(2)}` : "Free";
        if (!label.toLowerCase().includes(totalMonthlyQ)) return false;
      }
      if (soonestQ) {
        const dl = g.soonest?.days_left ?? null;
        const label = dl == null ? "—" : dl < 0 ? "expired" : `${dl} day${dl === 1 ? "" : "s"} left`;
        if (!label.toLowerCase().includes(soonestQ)) return false;
      }
      return true;
    });
    const sortKey = numberSort.key;
    const sorted = !sortKey ? filtered : [...filtered].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "count") cmp = a.count - b.count;
      else if (sortKey === "totalMonthly") cmp = a.totalMonthly - b.totalMonthly;
      else if (sortKey === "soonest") cmp = (a.soonest?.days_left ?? Infinity) - (b.soonest?.days_left ?? Infinity);
      else cmp = (a.owner_name || a.owner_email || "").toLowerCase().localeCompare((b.owner_name || b.owner_email || "").toLowerCase());
      return numberSort.dir === "asc" ? cmp : -cmp;
    });
    const totalPages = Math.max(1, Math.ceil(sorted.length / numberPageSize));
    const page = Math.min(numberPage, totalPages);
    const groups = sorted.slice((page - 1) * numberPageSize, page * numberPageSize);
    const toggleSort = (key: string) => setNumberSort((s) => s.key !== key ? { key, dir: "asc" } : s.dir === "asc" ? { key, dir: "desc" } : { key: null, dir: "asc" });

    const activeGroup = numbersModalOwner ? groupMap.get(numbersModalOwner) ?? null : null;

    return (
      <div>
        <SectionHeader title="Numbers" subtitle="How many numbers each user owns. Click a user to see all their numbers and expiry dates." />
        {!phoneNumbersLoaded ? (
          <ReportLoading />
        ) : (
          <div className="overflow-hidden rounded-xl border border-border">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[600px] text-sm">
                <thead className="bg-muted/50 text-center text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  <tr className="divide-x divide-border">
                    <th className="px-4 py-3"><SortableColumnHeader label="Owner" active={numberSort.key === "owner"} dir={numberSort.dir} onClick={() => toggleSort("owner")} /></th>
                    <th className="px-4 py-3"><SortableColumnHeader label="Numbers" active={numberSort.key === "count"} dir={numberSort.dir} onClick={() => toggleSort("count")} /></th>
                    <th className="px-4 py-3"><SortableColumnHeader label="Total Monthly" active={numberSort.key === "totalMonthly"} dir={numberSort.dir} onClick={() => toggleSort("totalMonthly")} /></th>
                    <th className="px-4 py-3"><SortableColumnHeader label="Soonest Expiry" active={numberSort.key === "soonest"} dir={numberSort.dir} onClick={() => toggleSort("soonest")} /></th>
                    <th className="px-4 py-3">Actions</th>
                  </tr>
                  <tr className="divide-x divide-border border-t border-border">
                    <th className="px-4 py-3 font-normal normal-case">
                      <TableTextFilter value={numberFilters.owner || ""} onChange={(v) => setNumberFilters((f) => ({ ...f, owner: v }))} placeholder="Owner" />
                    </th>
                    <th className="px-4 py-3 font-normal normal-case">
                      <TableTextFilter value={numberFilters.count || ""} onChange={(v) => setNumberFilters((f) => ({ ...f, count: v }))} placeholder="Numbers" />
                    </th>
                    <th className="px-4 py-3 font-normal normal-case">
                      <TableTextFilter value={numberFilters.totalMonthly || ""} onChange={(v) => setNumberFilters((f) => ({ ...f, totalMonthly: v }))} placeholder="Total Monthly" />
                    </th>
                    <th className="px-4 py-3 font-normal normal-case">
                      <TableTextFilter value={numberFilters.soonest || ""} onChange={(v) => setNumberFilters((f) => ({ ...f, soonest: v }))} placeholder="Soonest Expiry" />
                    </th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {groups.length === 0 ? (
                    <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">{allGroups.length === 0 ? "No numbers found." : "No owners match your filter."}</td></tr>
                  ) : groups.map((g) => {
                  const dm = daysMeta(g.soonest?.days_left ?? null);
                  const key = g.owner_email || g.owner_name;
                  return (
                    <tr
                      key={key}
                      onClick={() => setNumbersModalOwner(key)}
                      className="cursor-pointer divide-x divide-border border-t border-border bg-card/30 hover:bg-muted/30"
                    >
                      <td className="px-4 py-3 text-center">
                        <div className="font-medium text-foreground">{g.owner_name || "—"}</div>
                        <div className="text-xs text-muted-foreground">{g.owner_email}</div>
                      </td>
                      <td className="px-4 py-3 text-center text-lg font-bold text-foreground">{g.count}</td>
                      <td className="px-4 py-3 text-center text-muted-foreground">{g.totalMonthly > 0 ? `$${g.totalMonthly.toFixed(2)}` : "Free"}</td>
                      <td className="px-4 py-3 text-center">
                        {g.soonest ? (
                          <>
                            <div className="text-foreground">{fmt(g.soonest.expires_at)}</div>
                            {dm.label && <div className={`text-xs ${dm.cls}`}>{dm.label}</div>}
                          </>
                        ) : "—"}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      </td>
                    </tr>
                  );
                  })}
                </tbody>
              </table>
            </div>
            <TablePagination page={page} pageSize={numberPageSize} totalCount={sorted.length} onPageChange={setNumberPage} onPageSizeChange={(n) => { setNumberPageSize(n); setNumberPage(1); }} />
          </div>
        )}

        {/* Per-owner drill-down: all numbers of the clicked user */}
        <Dialog open={!!activeGroup} onOpenChange={(o) => { if (!o) setNumbersModalOwner(null); }}>
          <DialogContent className="max-w-2xl">
            <DialogHeader className="px-6 sm:pl-0">
              <DialogTitle>Numbers owned by {activeGroup?.owner_name || activeGroup?.owner_email || ""}</DialogTitle>
              <DialogDescription>
                {activeGroup?.owner_email} · {activeGroup?.numbers.length || 0} number(s)
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-[60vh] overflow-auto rounded-lg border border-border">
              <table className="w-full min-w-[560px] text-sm">
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
        <div className="mb-6 flex flex-col gap-0 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
          <SectionHeader title="Users" subtitle="Manage users, balances and rates." />
          <Button onClick={() => setAddUserOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" /> Add User
          </Button>
        </div>

        <Dialog open={addUserOpen} onOpenChange={(o) => { setAddUserOpen(o); if (!o) setAddUserForm({ email: "", full_name: "", password: "" }); }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Add User</DialogTitle>
              <DialogDescription>
                Creates an account that can sign in immediately. No email verification step,
                since you're vouching for it directly. Gets the same welcome credit a verified
                sign-up would.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Full Name</Label>
                <Input
                  value={addUserForm.full_name}
                  onChange={(e) => setAddUserForm((f) => ({ ...f, full_name: e.target.value }))}
                  placeholder="Jane Doe"
                />
              </div>
              <div className="space-y-2">
                <Label>Email *</Label>
                <Input
                  type="email"
                  value={addUserForm.email}
                  onChange={(e) => setAddUserForm((f) => ({ ...f, email: e.target.value }))}
                  placeholder="user@company.com"
                />
              </div>
              <div className="space-y-2">
                <Label>Password *</Label>
                <Input
                  type="text"
                  value={addUserForm.password}
                  onChange={(e) => setAddUserForm((f) => ({ ...f, password: e.target.value }))}
                  placeholder="At least 6 characters. Share this with the user directly"
                />
              </div>
            </div>
            <DialogFooter className="gap-2 sm:gap-0">
              <Button variant="outline" onClick={() => setAddUserOpen(false)}>Cancel</Button>
              <Button onClick={handleAddUser} disabled={addUserSaving}>
                {addUserSaving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Plus className="mr-1.5 h-4 w-4" />}
                Create Account
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <div className="overflow-hidden rounded-xl border border-border">
          <div className="overflow-x-auto">
          <table className="w-full min-w-[780px] text-sm">
            <thead className="bg-muted/50 text-center text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              <tr className="divide-x divide-border">
                {USER_COLUMNS.map(({ key, label }) => (
                  <th key={key} className="px-4 py-3">
                    <SortableColumnHeader label={label} active={userSort.key === key} dir={userSort.dir} onClick={() => toggleUserSort(key)} />
                  </th>
                ))}
                <th className="px-4 py-3">Actions</th>
              </tr>
              <tr className="divide-x divide-border border-t border-border">
                {USER_COLUMNS.map(({ key, label }) => (
                  <th key={key} className="px-4 py-3 font-normal normal-case">
                    {key === "status" ? (
                      <TableSelectFilter
                        value={userFilters.status || ""}
                        onChange={(v) => setUserFilters((f) => ({ ...f, status: v }))}
                        placeholder="Status"
                        options={[{ value: "active", label: "Active" }, { value: "Disabled", label: "Disabled" }]}
                      />
                    ) : (
                      <TableTextFilter value={userFilters[key] || ""} onChange={(v) => setUserFilters((f) => ({ ...f, [key]: v }))} placeholder={label} />
                    )}
                  </th>
                ))}
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">{users.length === 0 ? "No users found" : "No users match your filters"}</td></tr>
              )}
              {filtered.map(u => (
                <Fragment key={u.id}>
                  <tr className="divide-x divide-border border-t border-border bg-card/30 hover:bg-muted/30 cursor-pointer"
                    onClick={() => setSelectedUser(selectedUser === u.id ? null : u.id)}>
                    <td className="px-4 py-3 text-center">
                      <div className="font-medium text-foreground">{u.full_name || " "}</div>
                      <div className="text-xs text-muted-foreground">{u.email}</div>
                      {u.company_name && <div className="text-xs text-muted-foreground">{u.company_name}</div>}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <Badge variant={u.is_active ? (u.status === "active" ? "default" : "secondary") : "destructive"}>
                        {u.is_active ? u.status : "Disabled"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-center text-foreground">${(u.balance ?? 0).toFixed(2)}</td>
                    <td className="px-4 py-3 text-center text-foreground">${(u.rate_per_minute ?? 0.35).toFixed(2)}/min</td>
                    <td className="px-4 py-3 text-center text-foreground">{u.phone_numbers ?? 0}</td>
                    <td className="px-4 py-3 text-center text-foreground">{u.total_conversations}</td>
                    <td className="px-4 py-3 text-center">
                      <ChevronRight className={`h-4 w-4 mx-auto text-muted-foreground transition ${selectedUser === u.id ? "rotate-90" : ""}`} />
                    </td>
                  </tr>

                  {selectedUser === u.id && (
                    <tr className="border-t border-border bg-muted/20">
                      <td colSpan={7} className="px-4 py-4 sm:px-6">
                        {/* Phones: keep the panel within the visible part of the horizontally-scrolling table */}
                        <div className="max-w-[calc(100vw-66px)] sm:max-w-none">
                        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                          {/* Toggle Access */}
                          <div className="space-y-2">
                            <div className="text-xs font-semibold text-muted-foreground uppercase">Access</div>
                            <Button
                              size="sm"
                              variant={u.is_active ? "outline" : "default"}
                              className={u.is_active ? "border-destructive/40 text-destructive hover:bg-destructive/10" : undefined}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (u.is_active) setPendingDisable({ id: u.id, label: u.full_name || u.email });
                                else handleToggleAccess(u.id);
                              }}
                            >
                              {u.is_active ? <><ToggleRight className="mr-1 h-4 w-4" /> Disable</> : <><ToggleLeft className="mr-1 h-4 w-4" /> Enable</>}
                            </Button>
                          </div>

                          {/* Wallet Balance (real, spendable — numbers/calls) */}
                          <div className="space-y-2">
                            <div className="text-xs font-semibold text-muted-foreground uppercase">
                              Balance (${(u.balance ?? 0).toFixed(2)})
                            </div>
                            <div className="flex items-center gap-1">
                              <span className="text-sm text-muted-foreground">$</span>
                              <input
                                type="number"
                                min={1}
                                step="0.01"
                                value={balanceAmount}
                                onChange={e => setBalanceAmount(parseFloat(e.target.value) || 0)}
                                onClick={e => e.stopPropagation()}
                                className="h-8 w-20 rounded border border-input bg-background px-2 text-sm"
                              />
                              <Button size="sm" onClick={(e) => { e.stopPropagation(); handleAddBalance(u.id); }}>
                                <Plus className="mr-1 h-3 w-3" /> Add
                              </Button>
                            </div>
                          </div>

                          {/* Status */}
                          <div className="space-y-2">
                            <div className="text-xs font-semibold text-muted-foreground uppercase">Status</div>
                            <Select
                              value={u.status}
                              onValueChange={(v) => handleUpdateBilling(u.id, { status: v })}
                            >
                              <SelectTrigger onClick={(e) => e.stopPropagation()} className="h-8 w-full text-sm sm:w-40">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="trial">Trial</SelectItem>
                                <SelectItem value="active">Active</SelectItem>
                                <SelectItem value="past_due">Past Due</SelectItem>
                                <SelectItem value="canceled">Canceled</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                        </div>

                        {/* Custom Rate — negotiated per-account pricing override */}
                        <div className="mt-4 border-t border-border pt-4">
                          {editingRate === u.id ? (
                            <div className="space-y-3">
                              <div className="text-xs font-semibold text-muted-foreground uppercase">Custom Rate</div>
                              <div className="flex flex-wrap gap-3">
                                <label className="space-y-1">
                                  <span className="text-xs text-muted-foreground">Rate $/min</span>
                                  <input type="number" step="0.01" value={rateForm.rate_per_minute}
                                    onClick={e => e.stopPropagation()}
                                    onChange={e => setRateForm(f => ({ ...f, rate_per_minute: parseFloat(e.target.value) || 0 }))}
                                    className="block h-8 w-24 rounded border border-input bg-background px-2 text-sm" />
                                </label>
                                <label className="space-y-1">
                                  <span className="text-xs text-muted-foreground">Cost multiplier</span>
                                  <input type="number" step="0.01" value={rateForm.cost_multiplier}
                                    onClick={e => e.stopPropagation()}
                                    onChange={e => setRateForm(f => ({ ...f, cost_multiplier: parseFloat(e.target.value) || 0 }))}
                                    className="block h-8 w-24 rounded border border-input bg-background px-2 text-sm" />
                                </label>
                                <label className="space-y-1">
                                  <span className="text-xs text-muted-foreground">Total charges $</span>
                                  <input type="number" step="0.01" value={rateForm.total_charges}
                                    onClick={e => e.stopPropagation()}
                                    onChange={e => setRateForm(f => ({ ...f, total_charges: parseFloat(e.target.value) || 0 }))}
                                    className="block h-8 w-28 rounded border border-input bg-background px-2 text-sm" />
                                </label>
                              </div>
                              <div className="flex gap-2">
                                <Button size="sm" onClick={(e) => { e.stopPropagation(); handleSaveRate(u.id); }}>Save</Button>
                                <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); setEditingRate(null); }}>Cancel</Button>
                              </div>
                            </div>
                          ) : (
                            <Button size="sm" variant="ghost" onClick={(e) => {
                              e.stopPropagation();
                              setRateForm({
                                rate_per_minute: u.rate_per_minute ?? 0.35,
                                cost_multiplier: u.cost_multiplier ?? 3.0,
                                total_charges: u.total_charges ?? 0,
                              });
                              setEditingRate(u.id);
                            }}>
                              Set Custom Rate / Billing
                            </Button>
                          )}
                        </div>

                        <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
                          <div className="text-xs text-muted-foreground">
                            Joined: {new Date(u.created_at).toLocaleDateString()}
                            {u.stripe_customer_id && <> &middot; Stripe: {u.stripe_customer_id}</>}
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
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
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          </div>
          <TablePagination page={userCurPage} pageSize={userPageSize} totalCount={filteredSorted.length} onPageChange={setUserPage} onPageSizeChange={(n) => { setUserPageSize(n); setUserPage(1); }} />
        </div>

        <AlertDialog open={!!pendingDisable} onOpenChange={(o) => { if (!o) setPendingDisable(null); }}>
          <AlertDialogContent>
            <AlertDialogHeader className="text-center sm:text-center">
              <AlertDialogTitle>Disable this account?</AlertDialogTitle>
              <AlertDialogDescription>
                {pendingDisable && `"${pendingDisable.label}" `}will immediately lose access. No calls, campaigns or agent
                creation until re-enabled.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter className="sm:justify-center">
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={confirmDisable}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Disable
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog open={!!pendingDeleteUser} onOpenChange={(o) => { if (!o) setPendingDeleteUser(null); }}>
          <AlertDialogContent>
            <AlertDialogHeader className="text-center sm:text-center">
              <AlertDialogTitle>Permanently delete this user?</AlertDialogTitle>
              <AlertDialogDescription>
                {pendingDeleteUser && `"${pendingDeleteUser.label}" `}and ALL their data (agents, contacts, calls, numbers)
                will be permanently deleted. This can't be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter className="sm:justify-center">
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={confirmDeleteUser}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    );
  }
};

export default Admin;
