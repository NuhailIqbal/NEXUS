import { useEffect, useState } from "react";
import {
  Plus, PhoneOutgoing, Play, Pause as PauseIcon,
  CheckCircle2, XCircle, Loader2, AlertTriangle,
  Users, TrendingUp, Radio, BarChart2, Bot, Phone,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem,
  SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { CreateCampaignDialog } from "@/components/telephony/CreateCampaignDialog";
import { RowActions } from "@/components/dashboard/RowActions";
import { api } from "@/services/api";
import { toast } from "sonner";

type Campaign = {
  id: string;
  name: string;
  status: string;
  agent_id: string;
  list_id: string;
  phone_number_id: string | null;
  contacts_count: number;
  completed_count: number;
};

type CheckItem = {
  label: string;
  status: "loading" | "pass" | "fail" | "warn";
  detail?: string;
};

function StatCard({ icon: Icon, label, value, color }: { icon: any; label: string; value: string | number; color: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 flex items-center gap-4">
      <div className={`flex h-11 w-11 items-center justify-center rounded-lg ${color}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <div className="text-2xl font-bold text-foreground">{value}</div>
        <div className="text-xs text-muted-foreground">{label}</div>
      </div>
    </div>
  );
}

const STATUS_COLOR: Record<string, string> = {
  Active: "bg-green-500/15 text-green-600 border-green-500/20",
  Paused: "bg-yellow-500/15 text-yellow-600 border-yellow-500/20",
  Inactive: "bg-muted text-muted-foreground border-border",
  Completed: "bg-blue-500/15 text-blue-600 border-blue-500/20",
};

const Outbound = () => {
  const [open, setOpen] = useState(false);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [agentsById, setAgentsById] = useState<Map<string, string>>(new Map());
  const [phoneNumbersById, setPhoneNumbersById] = useState<Map<string, string>>(new Map());
  const [qualified, setQualified] = useState(0);
  const [loading, setLoading] = useState(true);

  const [settingsTarget, setSettingsTarget] = useState<Campaign | null>(null);
  const [settingsForm, setSettingsForm] = useState<{ name: string; agent_id: string; status: string }>({ name: "", agent_id: "", status: "" });

  const [preflightTarget, setPreflightTarget] = useState<Campaign | null>(null);
  const [checks, setChecks] = useState<CheckItem[]>([]);
  const [launching, setLaunching] = useState(false);

  const fetchCampaigns = async () => {
    const [campaignsRes, agentsRes, phonesRes, overviewRes] = await Promise.all([
      api.getCampaigns(), api.getAgents(), api.getPhoneNumbers(), api.getAnalyticsOverview(),
    ]);
    if (Array.isArray(campaignsRes.data)) setCampaigns(campaignsRes.data);
    if (Array.isArray(agentsRes.data))
      setAgentsById(new Map(agentsRes.data.map((a: any) => [a.id, a.name])));
    if (Array.isArray(phonesRes.data))
      setPhoneNumbersById(new Map(phonesRes.data.map((p: any) => [p.id, p.number])));
    if (overviewRes.data) setQualified((overviewRes.data as any).qualified_calls ?? 0);
    setLoading(false);
  };

  useEffect(() => { fetchCampaigns(); }, []);

  const totalContacts = campaigns.reduce((s, c) => s + (c.contacts_count || 0), 0);
  const totalDialed   = campaigns.reduce((s, c) => s + (c.completed_count || 0), 0);
  const activeCampaigns = campaigns.filter((c) => c.status === "Active").length;

  const togglePlay = async (c: Campaign) => {
    if (c.status === "Active") {
      const { error } = await api.pauseCampaign(c.id);
      if (error) return toast.error(error);
      toast.success("Campaign paused");
      fetchCampaigns();
    } else {
      openPreflight(c);
    }
  };

  const openPreflight = async (c: Campaign) => {
    setPreflightTarget(c);
    const init: CheckItem[] = [
      { label: "Agent assigned & synced to VAPI", status: "loading" },
      { label: "Phone number assigned & active in VAPI", status: "loading" },
      { label: "Contact list has dialable contacts", status: "loading" },
    ];
    setChecks(init);
    const results: CheckItem[] = [...init];

    if (!c.agent_id) {
      results[0] = { ...init[0], status: "fail", detail: "No agent assigned to this campaign" };
    } else {
      const { data: agentData } = await api.getAgents();
      const agent = (agentData as any[])?.find((a: any) => a.id === c.agent_id);
      if (!agent) results[0] = { ...init[0], status: "fail", detail: "Agent not found" };
      else if (!agent.vapi_assistant_id) results[0] = { ...init[0], status: "fail", detail: `"${agent.name}" is not synced to VAPI open the agent and click Sync to VAPI` };
      else results[0] = { ...init[0], status: "pass", detail: `${agent.name} ✓` };
    }
    setChecks([...results]);

    if (!c.phone_number_id) {
      results[1] = { ...init[1], status: "fail", detail: "No phone number assigned edit the campaign and select one" };
    } else {
      const { data: numData } = await api.getPhoneNumbers();
      const num = (numData as any[])?.find((n: any) => n.id === c.phone_number_id);
      if (!num) results[1] = { ...init[1], status: "fail", detail: "Phone number not found" };
      else if (!num.vapi_phone_id) results[1] = { ...init[1], status: "fail", detail: `${num.number || "Number"} is not active in VAPI yet` };
      else results[1] = { ...init[1], status: "pass", detail: `${num.number} ✓` };
    }
    setChecks([...results]);

    if (!c.list_id) {
      results[2] = { ...init[2], status: "fail", detail: "No contact list assigned edit the campaign and select a list" };
    } else {
      const { data: contacts } = await api.getContacts();
      const dialable = (contacts as any[])?.filter((ct: any) => ct.list_id === c.list_id && ct.phone?.trim());
      if (!dialable || dialable.length === 0) results[2] = { ...init[2], status: "fail", detail: "No contacts with phone numbers in the assigned list" };
      else results[2] = { ...init[2], status: "pass", detail: `${dialable.length} contact${dialable.length !== 1 ? "s" : ""} ready to dial` };
    }
    setChecks([...results]);
  };

  const launchCampaign = async () => {
    if (!preflightTarget) return;
    setLaunching(true);
    const action = preflightTarget.status === "Paused" ? api.resumeCampaign : api.startCampaign;
    const { data, error } = await action(preflightTarget.id);
    setLaunching(false);
    setPreflightTarget(null);
    if (error) return toast.error(error);
    const dialed: number = (data as any)?.dialed ?? 0;
    const errors: number = (data as any)?.errors ?? 0;
    const details: { phone: string; error: string }[] = (data as any)?.error_details ?? [];
    if (dialed === 0 && errors > 0) toast.error(`0 calls connected ${details[0]?.error ?? "Unknown VAPI error"}`);
    else if (errors > 0) toast.warning(`${dialed} called, ${errors} failed`);
    else toast.success(`Dialing ${dialed} contact${dialed !== 1 ? "s" : ""}…`);
    fetchCampaigns();
  };

  const openSettings = (c: Campaign) => {
    setSettingsTarget(c);
    setSettingsForm({ name: c.name, agent_id: c.agent_id, status: c.status });
  };

  const saveSettings = async () => {
    if (!settingsTarget) return;
    const { error } = await api.updateCampaign(settingsTarget.id, settingsForm);
    if (error) return toast.error(error);
    toast.success("Campaign updated");
    setSettingsTarget(null);
    fetchCampaigns();
  };

  const handleDelete = async (c: Campaign) => {
    const { error } = await api.deleteCampaign(c.id);
    if (error) return toast.error(error);
    toast.success("Campaign removed");
    fetchCampaigns();
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Outbound Campaigns</h1>
          <p className="text-sm text-muted-foreground">AI powered outbound calling automated, intelligent, scalable.</p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus className="mr-2 h-4 w-4" /> New Campaign
        </Button>
      </div>

      {/* Stats Bar */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard icon={Radio}        label="Total Campaigns"  value={campaigns.length}  color="bg-primary/10 text-primary" />
        <StatCard icon={TrendingUp}   label="Active Now"       value={activeCampaigns}   color="bg-green-500/10 text-green-600" />
        <StatCard icon={Users}        label="Total Contacts"   value={totalContacts.toLocaleString()} color="bg-blue-500/10 text-blue-600" />
        <StatCard icon={BarChart2}    label="Calls Dialed"     value={totalDialed.toLocaleString()}   color="bg-purple-500/10 text-purple-600" />
        <StatCard icon={CheckCircle2} label="Qualified"        value={qualified.toLocaleString()}     color="bg-success/10 text-success" />
      </div>

      {/* Campaign Cards */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading campaigns…
        </div>
      ) : campaigns.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card/50 p-16 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
            <PhoneOutgoing className="h-7 w-7 text-primary" />
          </div>
          <h3 className="mt-4 text-lg font-semibold text-foreground">No campaigns yet</h3>
          <p className="mt-1 text-sm text-muted-foreground">Create your first campaign to start AI powered outbound calling.</p>
          <Button className="mt-4" onClick={() => setOpen(true)}>
            <Plus className="mr-2 h-4 w-4" /> Create Campaign
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {campaigns.map((c) => {
            const pct = c.contacts_count > 0 ? Math.round((c.completed_count / c.contacts_count) * 100) : 0;
            const isActive = c.status === "Active";
            const statusCls = STATUS_COLOR[c.status] ?? STATUS_COLOR.Inactive;
            return (
              <div
                key={c.id}
                className={`rounded-xl border bg-card p-5 transition-shadow hover:shadow-md ${isActive ? "border-primary/30 shadow-sm shadow-primary/10" : "border-border"}`}
              >
                {/* Top row */}
                <div className="flex items-start justify-between">
                  <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${isActive ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                    <PhoneOutgoing className="h-5 w-5" />
                  </div>
                  <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${statusCls}`}>{c.status}</span>
                </div>

                {/* Name + agent */}
                <h3 className="mt-4 font-semibold text-foreground">{c.name}</h3>
                <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Bot className="h-3 w-3" />
                  <span>{agentsById.get(c.agent_id) ?? "Unassigned"}</span>
                </div>
                {phoneNumbersById.get(c.phone_number_id ?? "") && (
                  <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Phone className="h-3 w-3" />
                    <span>{phoneNumbersById.get(c.phone_number_id!)}</span>
                  </div>
                )}

                {/* Progress */}
                <div className="mt-4">
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-muted-foreground">{c.completed_count.toLocaleString()} / {c.contacts_count.toLocaleString()} contacted</span>
                    <span className="font-semibold text-foreground">{pct}%</span>
                  </div>
                  <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${isActive ? "bg-primary" : "bg-muted-foreground/40"}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>

                {/* Actions */}
                <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
                  <Button
                    size="sm"
                    variant={isActive ? "outline" : "default"}
                    onClick={() => togglePlay(c)}
                    className={isActive ? "" : "bg-primary text-primary-foreground"}
                  >
                    {isActive
                      ? <><PauseIcon className="mr-1.5 h-3.5 w-3.5" /> Pause</>
                      : <><Play className="mr-1.5 h-3.5 w-3.5" /> Start</>}
                  </Button>
                  <RowActions onSettings={() => openSettings(c)} onDelete={() => handleDelete(c)} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      <CreateCampaignDialog
        open={open}
        onOpenChange={setOpen}
        onCreate={async (d) => {
          const { error } = await api.createCampaign({
            name: d.name,
            agent_id: d.agentId,
            list_id: d.listId,
            phone_number_id: d.phoneNumberId || null,
          });
          if (error) return toast.error(error);
          toast.success(`Campaign "${d.name}" created`);
          fetchCampaigns();
        }}
      />

      {/* Pre-flight Dialog */}
      <Dialog open={!!preflightTarget} onOpenChange={(o) => { if (!o) setPreflightTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-yellow-500/10">
                <AlertTriangle className="h-4 w-4 text-yellow-500" />
              </div>
              Pre-launch Checks
            </DialogTitle>
            <DialogDescription>Verifying <span className="font-medium text-foreground">{preflightTarget?.name}</span> is ready to dial.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2.5 py-1">
            {checks.map((c, i) => (
              <div key={i} className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors ${
                c.status === "pass" ? "border-green-500/20 bg-green-500/5" :
                c.status === "fail" ? "border-destructive/20 bg-destructive/5" :
                "border-border bg-muted/30"
              }`}>
                {c.status === "loading" && <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-muted-foreground" />}
                {c.status === "pass"    && <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />}
                {c.status === "fail"    && <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />}
                {c.status === "warn"    && <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-500" />}
                <div>
                  <p className="text-sm font-medium">{c.label}</p>
                  {c.detail && <p className="mt-0.5 text-xs text-muted-foreground">{c.detail}</p>}
                </div>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreflightTarget(null)}>Cancel</Button>
            <Button
              onClick={launchCampaign}
              disabled={launching || checks.some((c) => c.status === "loading" || c.status === "fail")}
            >
              {launching
                ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Launching…</>
                : <><Play className="mr-2 h-4 w-4" />Launch Campaign</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Settings Dialog */}
      <Dialog open={!!settingsTarget} onOpenChange={(o) => !o && setSettingsTarget(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Campaign Settings</DialogTitle>
            <DialogDescription>Update campaign details.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={settingsForm.name} onChange={(e) => setSettingsForm((f) => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label>Agent</Label>
              <select
                value={settingsForm.agent_id}
                onChange={(e) => setSettingsForm((f) => ({ ...f, agent_id: e.target.value }))}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="">Select agent…</option>
                {Array.from(agentsById.entries()).map(([id, name]) => (
                  <option key={id} value={id}>{name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label>Status</Label>
              <Select value={settingsForm.status} onValueChange={(v) => setSettingsForm((f) => ({ ...f, status: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="Active">Active</SelectItem>
                  <SelectItem value="Paused">Paused</SelectItem>
                  <SelectItem value="Inactive">Inactive</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSettingsTarget(null)}>Cancel</Button>
            <Button onClick={saveSettings}>Save Changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Outbound;
