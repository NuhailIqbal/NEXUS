import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Users, Bot, PhoneOutgoing, PhoneIncoming, CreditCard,
  Loader2, Shield, Search, ChevronRight, ToggleLeft, ToggleRight,
  Plus, Minus, RotateCcw, TrendingUp, LogOut, Lock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { api } from "@/services/api";
import { toast } from "sonner";

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
  total_conversations: number;
  stripe_customer_id: string | null;
};

type AdminStats = {
  total_users: number;
  total_conversations: number;
  total_agents: number;
  active_subscriptions: number;
};

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

const ADMIN_USER = "qarib";
const ADMIN_PASS = "test123";

const Admin = () => {
  const navigate = useNavigate();
  const [authenticated, setAuthenticated] = useState(() => sessionStorage.getItem("nexus_admin") === "1");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");

  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [creditAmount, setCreditAmount] = useState(10);
  const [editingLimits, setEditingLimits] = useState<string | null>(null);
  const [limitForm, setLimitForm] = useState({ outbound_limit: 0, inbound_limit: 0, agents_limit: 0 });

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (username === ADMIN_USER && password === ADMIN_PASS) {
      sessionStorage.setItem("nexus_admin", "1");
      setAuthenticated(true);
      setLoginError("");
    } else {
      setLoginError("Invalid username or password");
    }
  };

  const handleLogout = () => {
    sessionStorage.removeItem("nexus_admin");
    setAuthenticated(false);
  };

  const fetchData = async () => {
    const [statsRes, usersRes] = await Promise.all([
      api.getAdminStats(),
      api.getAdminUsers(),
    ]);
    if (statsRes.data) setStats(statsRes.data);
    if (Array.isArray(usersRes.data)) setUsers(usersRes.data);
    setLoading(false);
  };

  useEffect(() => {
    if (authenticated) fetchData();
  }, [authenticated]);

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
    const planLimits: Record<string, { outbound_limit: number; inbound_limit: number; agents_limit: number; rate_per_minute: number }> = {
      free: { outbound_limit: 5, inbound_limit: 5, agents_limit: 10, rate_per_minute: 0.05 },
      payg: { outbound_limit: 999999, inbound_limit: 999999, agents_limit: 10, rate_per_minute: 0.05 },
      starter: { outbound_limit: 100, inbound_limit: 200, agents_limit: 25, rate_per_minute: 0.03 },
      growth: { outbound_limit: 300, inbound_limit: 500, agents_limit: 50, rate_per_minute: 0.02 },
      business: { outbound_limit: 500, inbound_limit: 700, agents_limit: 100, rate_per_minute: 0.01 },
    };
    const limits = planLimits[plan] || planLimits.free;
    const { error } = await api.updateAdminUser(userId, {
      plan,
      status: plan === "free" ? "trial" : "active",
      ...limits,
      outbound_used: 0,
      inbound_used: 0,
    });
    if (error) return toast.error(error);
    toast.success(`Plan changed to ${plan}`);
    fetchData();
  };

  if (!authenticated) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <form onSubmit={handleLogin} className="w-full max-w-sm space-y-5 rounded-xl border border-border bg-card p-8 shadow-lg">
          <div className="text-center">
            <Lock className="mx-auto h-10 w-10 text-primary mb-3" />
            <h1 className="text-xl font-bold text-foreground">Admin Portal</h1>
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

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="mr-2 h-5 w-5 animate-spin text-muted-foreground" /> Loading admin panel...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-primary" />
            <span className="font-bold text-foreground">EDM NEXUS Admin</span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => navigate("/dashboard")}>
              Back to Dashboard
            </Button>
            <Button variant="outline" size="sm" onClick={handleLogout}>
              <LogOut className="mr-1 h-4 w-4" /> Logout
            </Button>
          </div>
        </div>
      </header>

    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 space-y-8">
      <div className="flex items-center gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Admin Portal</h1>
          <p className="text-sm text-muted-foreground">Manage users, billing, limits and credits.</p>
        </div>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Total Users" value={stats.total_users} icon={Users} />
          <StatCard label="Total Conversations" value={stats.total_conversations} icon={PhoneOutgoing} />
          <StatCard label="Total Agents" value={stats.total_agents} icon={Bot} />
          <StatCard label="Active Subscriptions" value={stats.active_subscriptions} icon={TrendingUp} />
        </div>
      )}

      {/* Search */}
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          placeholder="Search users by email, name or company..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="h-10 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      {/* Users Table */}
      <div className="overflow-hidden rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">User</th>
              <th className="px-4 py-3">Plan</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Outbound</th>
              <th className="px-4 py-3">Inbound</th>
              <th className="px-4 py-3">Agents</th>
              <th className="px-4 py-3">Credits</th>
              <th className="px-4 py-3">Calls</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(u => (
              <>
                <tr key={u.id} className="border-t border-border bg-card/30 hover:bg-muted/30 cursor-pointer"
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
                  <td className="px-4 py-3 text-foreground">{u.credits}</td>
                  <td className="px-4 py-3 text-foreground">{u.total_conversations}</td>
                  <td className="px-4 py-3">
                    <ChevronRight className={`h-4 w-4 text-muted-foreground transition ${selectedUser === u.id ? "rotate-90" : ""}`} />
                  </td>
                </tr>

                {selectedUser === u.id && (
                  <tr key={`${u.id}-detail`} className="border-t border-border bg-muted/20">
                    <td colSpan={9} className="px-6 py-4">
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

                        {/* Assign Plan (Admin Override) */}
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
                            <option value="free">Free (Trial)</option>
                            <option value="payg">Pay As You Go $0.05/min</option>
                            <option value="starter">Starter $25 (100 out / 200 in)</option>
                            <option value="growth">Growth $50 (300 out / 500 in)</option>
                            <option value="business">Business $100 (500 out / 700 in)</option>
                          </select>
                          <div className="text-[10px] text-muted-foreground">Admin override no payment required</div>
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
                            });
                            setEditingLimits(u.id);
                          }}>
                            Set Custom Limits
                          </Button>
                        )}
                      </div>

                      <div className="mt-3 text-xs text-muted-foreground">
                        Joined: {new Date(u.created_at).toLocaleDateString()}
                        {u.stripe_customer_id && <> &middot; Stripe: {u.stripe_customer_id}</>}
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="py-8 text-center text-sm text-muted-foreground">No users found</div>
        )}
      </div>
    </div>
    </div>
  );
};

export default Admin;
