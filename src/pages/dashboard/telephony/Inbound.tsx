import { useEffect, useState, useCallback } from "react";
import {
  PhoneIncoming, Plus, Phone, Bot, Loader2, Trash2,
  CheckCircle2, XCircle, Clock, PhoneCall, Settings as SettingsIcon,
} from "lucide-react";
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
import { api } from "@/services/api";
import { toast } from "sonner";

type Agent = { id: string; name: string; voice?: string; status: string; vapi_assistant_id?: string };
type PhoneNumber = { id: string; number: string; status: string; agent_id?: string; vapi_phone_id?: string };
type Receptionist = {
  id: string;
  name: string;
  status: string;
  agent_id: string;
  phone_number_id?: string;
  max_wait_seconds: number;
  overflow_action: string;
};
type CallLog = {
  id: string;
  status: string;
  duration?: number;
  call_time?: string;
  customer_number?: string;
  agent_id?: string;
  ai_summary?: string;
  direction?: string;
};

const Inbound = () => {
  const [receptionists, setReceptionists] = useState<Receptionist[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [phones, setPhones] = useState<PhoneNumber[]>([]);
  const [callLogs, setCallLogs] = useState<CallLog[]>([]);
  const [loading, setLoading] = useState(true);

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({ name: "", agent_id: "", area_code: "" });
  const [creating, setCreating] = useState(false);

  const [settingsTarget, setSettingsTarget] = useState<Receptionist | null>(null);
  const [settingsForm, setSettingsForm] = useState({ name: "", agent_id: "", status: "" });

  const agentsMap = new Map(agents.map((a) => [a.id, a]));
  const phonesMap = new Map(phones.map((p) => [p.id, p]));

  const fetchAll = useCallback(async () => {
    const [qRes, aRes, pRes, cRes] = await Promise.all([
      api.getInboundQueues(),
      api.getAgents(),
      api.getPhoneNumbers(),
      api.getConversations("direction=inbound&limit=50"),
    ]);
    if (Array.isArray(qRes.data)) setReceptionists(qRes.data);
    if (Array.isArray(aRes.data)) setAgents(aRes.data);
    if (Array.isArray(pRes.data)) setPhones(pRes.data);
    if (Array.isArray(cRes.data)) setCallLogs(cRes.data);
    setLoading(false);
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const handleCreate = async () => {
    if (!createForm.name.trim()) return toast.error("Name is required");
    if (!createForm.agent_id) return toast.error("Select an AI agent");
    setCreating(true);
    const payload: any = {
      name: createForm.name,
      agent_id: createForm.agent_id,
      status: "Active",
    };
    if (createForm.area_code.trim()) {
      payload.area_code = createForm.area_code.trim();
    }
    const { error } = await api.createInboundQueue(payload);
    setCreating(false);
    if (error) return toast.error(error);
    toast.success("AI Receptionist created — phone number provisioned!");
    setCreateOpen(false);
    setCreateForm({ name: "", agent_id: "", area_code: "" });
    fetchAll();
  };

  const handleDelete = async (r: Receptionist) => {
    const { error } = await api.deleteInboundQueue(r.id);
    if (error) return toast.error(error);
    toast.success("Receptionist removed");
    fetchAll();
  };

  const openSettings = (r: Receptionist) => {
    setSettingsTarget(r);
    setSettingsForm({
      name: r.name,
      agent_id: r.agent_id,
      status: r.status,
    });
  };

  const saveSettings = async () => {
    if (!settingsTarget) return;
    const { error } = await api.updateInboundQueue(settingsTarget.id, {
      name: settingsForm.name,
      agent_id: settingsForm.agent_id,
      status: settingsForm.status,
    });
    if (error) return toast.error(error);
    toast.success("Receptionist updated");
    setSettingsTarget(null);
    fetchAll();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading...
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">AI Receptionist</h1>
          <p className="text-sm text-muted-foreground">
            Create AI receptionists that answer inbound calls. Pick an agent, we provision a number automatically — callers reach your AI instantly.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 h-4 w-4" /> New Receptionist
        </Button>
      </div>

      {/* Receptionist Cards */}
      {receptionists.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card/50 p-12 text-center">
          <PhoneIncoming className="mx-auto h-10 w-10 text-muted-foreground/50" />
          <h3 className="mt-4 text-lg font-medium text-foreground">No receptionists yet</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Create your first AI receptionist to start receiving inbound calls.
          </p>
          <Button className="mt-4" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" /> Create Receptionist
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {receptionists.map((r) => {
            const phone = r.phone_number_id ? phonesMap.get(r.phone_number_id) : undefined;
            const agent = agentsMap.get(r.agent_id);
            return (
              <div key={r.id} className="rounded-xl border border-border bg-card p-5 card-interactive">
                <div className="flex items-start justify-between">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <PhoneIncoming className="h-5 w-5" />
                  </div>
                  <Badge variant={r.status === "Active" ? "default" : "secondary"}>{r.status}</Badge>
                </div>
                <h3 className="mt-4 font-semibold text-foreground">{r.name}</h3>
                <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Bot className="h-3 w-3" /> {agent?.name ?? "Unassigned Agent"}
                </div>

                {/* Phone number — the star of the show */}
                {phone ? (
                  <div className="mt-4 rounded-lg border border-primary/20 bg-primary/5 p-4">
                    <div className="text-[10px] font-semibold text-primary uppercase tracking-widest">Inbound Number</div>
                    <div className="mt-1.5 flex items-center gap-2.5">
                      <Phone className="h-5 w-5 text-primary" />
                      <span className="text-xl font-bold tracking-wide text-foreground">{phone.number}</span>
                    </div>
                    <div className="mt-1.5 text-[11px] text-muted-foreground">
                      Share this number — callers reach your AI receptionist
                    </div>
                  </div>
                ) : (
                  <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                    No phone number linked
                  </div>
                )}

                <div className="mt-4 flex items-center gap-2 border-t border-border pt-3">
                  <button
                    onClick={() => openSettings(r)}
                    className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                    title="Settings"
                  >
                    <SettingsIcon className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => handleDelete(r)}
                    className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                    title="Delete"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Recent Inbound Call Logs */}
      <div>
        <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold text-foreground">
          <PhoneCall className="h-5 w-5 text-primary" />
          Recent Inbound Calls
        </h2>
        {callLogs.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
            No inbound calls recorded yet. Once callers reach your receptionist, logs will appear here.
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Caller</th>
                  <th className="px-4 py-3">Agent</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Duration</th>
                  <th className="px-4 py-3">Time</th>
                  <th className="px-4 py-3">Summary</th>
                </tr>
              </thead>
              <tbody>
                {callLogs.map((c) => (
                  <tr key={c.id} className="border-t border-border bg-card/30">
                    <td className="px-4 py-3 font-medium text-foreground">
                      {c.customer_number || "Unknown"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {c.agent_id ? agentsMap.get(c.agent_id)?.name ?? "—" : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        {c.status === "Completed" ? (
                          <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                        ) : c.status === "Failed" ? (
                          <XCircle className="h-3.5 w-3.5 text-destructive" />
                        ) : (
                          <Clock className="h-3.5 w-3.5 text-yellow-500" />
                        )}
                        <span className={
                          c.status === "Completed" ? "text-green-600" :
                          c.status === "Failed" ? "text-destructive" :
                          "text-yellow-600"
                        }>
                          {c.status}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {c.duration ? `${Math.round(c.duration)}s` : "—"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {c.call_time ? new Date(c.call_time).toLocaleString() : "—"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground max-w-[200px] truncate">
                      {c.ai_summary || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create Receptionist Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PhoneIncoming className="h-5 w-5 text-primary" />
              New AI Receptionist
            </DialogTitle>
            <DialogDescription>
              Pick an AI agent — we'll provision a phone number from VAPI automatically. Incoming calls to that number will be answered by your agent.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input
                placeholder="e.g. Front Desk Receptionist"
                value={createForm.name}
                onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label>AI Agent</Label>
              <Select
                value={createForm.agent_id}
                onValueChange={(v) => setCreateForm((f) => ({ ...f, agent_id: v }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select an agent..." />
                </SelectTrigger>
                <SelectContent>
                  {agents.filter((a) => a.vapi_assistant_id).map((a) => (
                    <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Only agents synced with VAPI are shown.</p>
            </div>
            <div className="space-y-2">
              <Label>Preferred Area Code <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Input
                placeholder="e.g. 212, 415, 310"
                value={createForm.area_code}
                onChange={(e) => setCreateForm((f) => ({ ...f, area_code: e.target.value }))}
                maxLength={5}
              />
              <p className="text-xs text-muted-foreground">Leave empty for any available US number.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>Cancel</Button>
            <Button onClick={handleCreate} disabled={creating}>
              {creating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Provisioning Number...
                </>
              ) : (
                "Create Receptionist"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Settings Dialog */}
      <Dialog open={!!settingsTarget} onOpenChange={(o) => !o && setSettingsTarget(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <SettingsIcon className="h-5 w-5 text-primary" />
              Receptionist Settings
            </DialogTitle>
            <DialogDescription>Update name, agent, and status. Changing the agent re-assigns it in VAPI.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input
                value={settingsForm.name}
                onChange={(e) => setSettingsForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label>AI Agent</Label>
              <Select
                value={settingsForm.agent_id}
                onValueChange={(v) => setSettingsForm((f) => ({ ...f, agent_id: v }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select an agent..." />
                </SelectTrigger>
                <SelectContent>
                  {agents.filter((a) => a.vapi_assistant_id).map((a) => (
                    <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Status</Label>
              <Select
                value={settingsForm.status}
                onValueChange={(v) => setSettingsForm((f) => ({ ...f, status: v }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="Active">Active</SelectItem>
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

export default Inbound;
