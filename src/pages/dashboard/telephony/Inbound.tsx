import { useEffect, useState } from "react";
import { PhoneIncoming, Plus } from "lucide-react";
import { LiveVoiceModal, type VoiceAgentInfo } from "@/components/dashboard/LiveVoiceModal";
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
import { CreateInboundQueueDialog } from "@/components/telephony/CreateInboundQueueDialog";
import { RowActions } from "@/components/dashboard/RowActions";
import { api } from "@/services/api";
import { toast } from "sonner";

type Queue = {
  id: string;
  name: string;
  status: string;
  agent_id: string;
  max_wait_seconds: number;
  overflow_action: string;
};

const Inbound = () => {
  const [open, setOpen] = useState(false);
  const [queues, setQueues] = useState<Queue[]>([]);
  const [loading, setLoading] = useState(true);

  const [testAgent, setTestAgent] = useState<VoiceAgentInfo | null>(null);
  const [agentsById, setAgentsById] = useState<Map<string, any>>(new Map());
  const [settingsTarget, setSettingsTarget] = useState<Queue | null>(null);
  const [settingsForm, setSettingsForm] = useState<{ name: string; agent_id: string; status: string }>({ name: "", agent_id: "", status: "" });

  const fetchQueues = async () => {
    const [queuesRes, agentsRes] = await Promise.all([api.getInboundQueues(), api.getAgents()]);
    if (Array.isArray(queuesRes.data)) setQueues(queuesRes.data);
    if (Array.isArray(agentsRes.data)) {
      setAgentsById(new Map(agentsRes.data.map((a: any) => [a.id, a])));
    }
    setLoading(false);
  };

  useEffect(() => { fetchQueues(); }, []);

  const openTest = (q: Queue) => {
    const agent = agentsById.get(q.agent_id);
    if (!agent) {
      toast.error("No agent assigned to this queue. Edit it in Settings first.");
      return;
    }
    setTestAgent({
      id: agent.id,
      name: agent.name,
      voice: agent.voice,
      language: agent.language,
      category: agent.category,
      status: agent.status,
      vapi_assistant_id: agent.vapi_assistant_id,
    });
  };

  const openSettings = (q: Queue) => {
    setSettingsTarget(q);
    setSettingsForm({ name: q.name, agent_id: q.agent_id, status: q.status });
  };

  const saveSettings = async () => {
    if (!settingsTarget) return;
    const { error } = await api.updateInboundQueue(settingsTarget.id, {
      name: settingsForm.name,
      agent_id: settingsForm.agent_id,
      status: settingsForm.status,
    });
    if (error) return toast.error(error);
    toast.success("Queue updated");
    setSettingsTarget(null);
    fetchQueues();
  };

  const handleDelete = async (q: Queue) => {
    const { error } = await api.deleteInboundQueue(q.id);
    if (error) return toast.error(error);
    toast.success("Queue removed");
    fetchQueues();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Inbound Queues</h1>
          <p className="text-sm text-muted-foreground">Live queues for incoming calls.</p>
        </div>
        <Button onClick={() => setOpen(true)}><Plus className="mr-2 h-4 w-4" />New Queue</Button>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {loading ? (
          <p className="text-muted-foreground col-span-full text-center py-8">Loading...</p>
        ) : queues.length === 0 ? (
          <p className="text-muted-foreground col-span-full text-center py-8">No queues found.</p>
        ) : (
          queues.map((q) => (
            <div key={q.id} className="rounded-xl border border-border bg-card p-5 card-interactive">
              <div className="flex items-start justify-between">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <PhoneIncoming className="h-5 w-5" />
                </div>
                <Badge variant={q.status === "Active" ? "default" : "secondary"}>{q.status}</Badge>
              </div>
              <h3 className="mt-4 font-semibold text-foreground">{q.name}</h3>
              <p className="text-xs text-muted-foreground">Agent: {agentsById.get(q.agent_id)?.name ?? "Unassigned"}</p>
              <div className="mt-4 flex justify-between text-sm">
                <div>
                  <div className="text-2xl font-bold text-foreground">{q.max_wait_seconds}s</div>
                  <div className="text-xs text-muted-foreground">max wait</div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-sm text-foreground">{q.overflow_action}</div>
                  <div className="text-xs text-muted-foreground">overflow</div>
                </div>
              </div>
              <div className="mt-4 border-t border-border pt-3">
                <RowActions
                  onTest={() => openTest(q)}
                  onSettings={() => openSettings(q)}
                  onDelete={() => handleDelete(q)}
                />
              </div>
            </div>
          ))
        )}
      </div>

      <CreateInboundQueueDialog
        open={open}
        onOpenChange={setOpen}
        onCreate={async (d) => {
          const { error } = await api.createInboundQueue({
            name: d.name,
            agent_id: d.aiAgent,
            status: d.active ? "Active" : "Inactive",
          });
          if (error) return toast.error(error);
          toast.success(`Queue "${d.name}" created`);
          fetchQueues();
        }}
      />

      <LiveVoiceModal
        agent={testAgent}
        open={!!testAgent}
        onOpenChange={(o) => { if (!o) setTestAgent(null); }}
      />

      <Dialog open={!!settingsTarget} onOpenChange={(o) => !o && setSettingsTarget(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Queue Settings</DialogTitle>
            <DialogDescription>Update name, agent, and status.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={settingsForm.name} onChange={(e) => setSettingsForm((f) => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label>Agent</Label>
              <Input value={settingsForm.agent_id} onChange={(e) => setSettingsForm((f) => ({ ...f, agent_id: e.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label>Status</Label>
              <Select value={settingsForm.status} onValueChange={(v) => setSettingsForm((f) => ({ ...f, status: v }))}>
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
            <Button onClick={saveSettings}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Inbound;
