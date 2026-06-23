import { useEffect, useState } from "react";
import { Plus, PhoneOutgoing, Play, Pause as PauseIcon, CheckCircle2, XCircle, Loader2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
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

const Outbound = () => {
  const [open, setOpen] = useState(false);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [agentsById, setAgentsById] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);

  const [settingsTarget, setSettingsTarget] = useState<Campaign | null>(null);
  const [settingsForm, setSettingsForm] = useState<{ name: string; agent_id: string; status: string }>({ name: "", agent_id: "", status: "" });

  const [preflightTarget, setPreflightTarget] = useState<Campaign | null>(null);
  const [checks, setChecks] = useState<CheckItem[]>([]);
  const [launching, setLaunching] = useState(false);

  const fetchCampaigns = async () => {
    const [campaignsRes, agentsRes] = await Promise.all([api.getCampaigns(), api.getAgents()]);
    if (Array.isArray(campaignsRes.data)) setCampaigns(campaignsRes.data);
    if (Array.isArray(agentsRes.data)) {
      setAgentsById(new Map(agentsRes.data.map((a: any) => [a.id, a.name])));
    }
    setLoading(false);
  };

  useEffect(() => { fetchCampaigns(); }, []);

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
    const loading: CheckItem[] = [
      { label: "Agent assigned & synced to VAPI", status: "loading" },
      { label: "Phone number assigned & active", status: "loading" },
      { label: "Contact list has dialable contacts", status: "loading" },
    ];
    setChecks(loading);

    const results: CheckItem[] = [...loading];

    // Check 1: agent has vapi_assistant_id
    if (!c.agent_id) {
      results[0] = { label: loading[0].label, status: "fail", detail: "No agent assigned to this campaign" };
    } else {
      const { data: agentData } = await api.getAgents();
      const agent = (agentData as any[])?.find((a: any) => a.id === c.agent_id);
      if (!agent) {
        results[0] = { label: loading[0].label, status: "fail", detail: "Agent not found" };
      } else if (!agent.vapi_assistant_id) {
        results[0] = { label: loading[0].label, status: "fail", detail: `Agent "${agent.name}" is not synced to VAPI — open the agent and click Sync to VAPI` };
      } else {
        results[0] = { label: loading[0].label, status: "pass", detail: `Agent "${agent.name}" ✓` };
      }
    }
    setChecks([...results]);

    // Check 2: phone number has vapi_phone_id
    if (!c.phone_number_id) {
      results[1] = { label: loading[1].label, status: "fail", detail: "No phone number assigned — edit the campaign and select a phone number" };
    } else {
      const { data: numData } = await api.getPhoneNumbers();
      const num = (numData as any[])?.find((n: any) => n.id === c.phone_number_id);
      if (!num) {
        results[1] = { label: loading[1].label, status: "fail", detail: "Phone number not found" };
      } else if (!num.vapi_phone_id) {
        results[1] = { label: loading[1].label, status: "fail", detail: `${num.number || "Number"} is not linked to VAPI yet — wait for activation` };
      } else {
        results[1] = { label: loading[1].label, status: "pass", detail: `${num.number} ✓` };
      }
    }
    setChecks([...results]);

    // Check 3: contacts in list with phone
    if (!c.list_id) {
      results[2] = { label: loading[2].label, status: "fail", detail: "No contact list assigned — edit the campaign and select a list" };
    } else {
      const { data: contacts } = await api.getContacts();
      const dialable = (contacts as any[])?.filter((ct: any) => ct.list_id === c.list_id && ct.phone?.trim());
      if (!dialable || dialable.length === 0) {
        results[2] = { label: loading[2].label, status: "fail", detail: "No contacts with phone numbers in the assigned list" };
      } else {
        results[2] = { label: loading[2].label, status: "pass", detail: `${dialable.length} contact${dialable.length !== 1 ? "s" : ""} ready to dial` };
      }
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
    if (dialed === 0 && errors > 0) {
      toast.error(`0 calls connected — ${details[0]?.error ?? "Unknown VAPI error"}`);
    } else if (errors > 0) {
      toast.warning(`${dialed} called, ${errors} failed`);
    } else {
      toast.success(`Dialing ${dialed} contact${dialed !== 1 ? "s" : ""}…`);
    }
    fetchCampaigns();
  };

  const openSettings = (c: Campaign) => {
    setSettingsTarget(c);
    setSettingsForm({ name: c.name, agent_id: c.agent_id, status: c.status });
  };

  const saveSettings = async () => {
    if (!settingsTarget) return;
    const { error } = await api.updateCampaign(settingsTarget.id, {
      name: settingsForm.name,
      agent_id: settingsForm.agent_id,
      status: settingsForm.status,
    });
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Campaigns</h1>
          <p className="text-sm text-muted-foreground">Run AI-powered outbound calling campaigns.</p>
        </div>
        <Button onClick={() => setOpen(true)}><Plus className="mr-2 h-4 w-4" />New Campaign</Button>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {loading ? (
          <p className="text-muted-foreground col-span-full text-center py-8">Loading...</p>
        ) : campaigns.length === 0 ? (
          <p className="text-muted-foreground col-span-full text-center py-8">No campaigns found.</p>
        ) : (
          campaigns.map((c) => {
            const pct = c.contacts_count > 0 ? Math.round((c.completed_count / c.contacts_count) * 100) : 0;
            const isActive = c.status === "Active";
            return (
              <div key={c.id} className="rounded-xl border border-border bg-card p-5 card-interactive">
                <div className="flex items-start justify-between">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <PhoneOutgoing className="h-5 w-5" />
                  </div>
                  <Badge variant={isActive ? "default" : "secondary"}>{c.status}</Badge>
                </div>
                <h3 className="mt-4 font-semibold text-foreground">{c.name}</h3>
                <p className="text-xs text-muted-foreground">Agent: {agentsById.get(c.agent_id) ?? "Unassigned"}</p>
                <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
                  <span>{c.completed_count.toLocaleString()} / {c.contacts_count.toLocaleString()}</span>
                  <span className="font-medium text-foreground">{pct}%</span>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                </div>
                <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
                  <Button size="sm" variant="outline" onClick={() => togglePlay(c)}>
                    {isActive ? (
                      <><PauseIcon className="mr-1.5 h-3.5 w-3.5" /> Pause</>
                    ) : (
                      <><Play className="mr-1.5 h-3.5 w-3.5" /> Start</>
                    )}
                  </Button>
                  <RowActions
                    onSettings={() => openSettings(c)}
                    onDelete={() => handleDelete(c)}
                  />
                </div>
              </div>
            );
          })
        )}
      </div>

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

      {/* Pre-flight Check Dialog */}
      <Dialog open={!!preflightTarget} onOpenChange={(o) => { if (!o) setPreflightTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-yellow-500" />
              Pre-launch Check — {preflightTarget?.name}
            </DialogTitle>
            <DialogDescription>Verifying campaign is ready to dial.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {checks.map((c, i) => (
              <div key={i} className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
                {c.status === "loading" && <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-muted-foreground" />}
                {c.status === "pass"    && <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />}
                {c.status === "fail"    && <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />}
                {c.status === "warn"    && <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-500" />}
                <div>
                  <p className="text-sm font-medium">{c.label}</p>
                  {c.detail && <p className="text-xs text-muted-foreground mt-0.5">{c.detail}</p>}
                </div>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreflightTarget(null)}>Cancel</Button>
            <Button
              onClick={launchCampaign}
              disabled={launching || checks.some((c) => c.status === "loading" || c.status === "fail")}
              className="bg-primary text-primary-foreground"
            >
              {launching ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Launching…</> : <><Play className="mr-2 h-4 w-4" />Launch Campaign</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!settingsTarget} onOpenChange={(o) => !o && setSettingsTarget(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Campaign Settings</DialogTitle>
            <DialogDescription>Update campaign name, agent, and status.</DialogDescription>
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
            <Button onClick={saveSettings}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Outbound;
