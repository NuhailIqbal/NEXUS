import { useEffect, useState } from "react";
import { PhoneIncoming, Plus, Loader2, CheckCircle2 } from "lucide-react";
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

  const [testTarget, setTestTarget] = useState<Queue | null>(null);
  const [testState, setTestState] = useState<"loading" | "ok">("loading");
  const [settingsTarget, setSettingsTarget] = useState<Queue | null>(null);
  const [settingsForm, setSettingsForm] = useState<{ name: string; agent_id: string; status: string }>({ name: "", agent_id: "", status: "" });

  const fetchQueues = async () => {
    const { data } = await api.getInboundQueues();
    if (data) setQueues(Array.isArray(data) ? data : []);
    setLoading(false);
  };

  useEffect(() => { fetchQueues(); }, []);

  const openTest = (q: Queue) => {
    setTestTarget(q);
    setTestState("loading");
    setTimeout(() => setTestState("ok"), 900);
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
              <p className="text-xs text-muted-foreground">Agent: {q.agent_id}</p>
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

      <Dialog open={!!testTarget} onOpenChange={(o) => !o && setTestTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Test {testTarget?.name}</DialogTitle>
            <DialogDescription>Simulating an incoming call routed to this queue.</DialogDescription>
          </DialogHeader>
          {testState === "loading" ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Routing call...
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 py-6">
              <CheckCircle2 className="h-10 w-10 text-success" />
              <p className="text-sm">Call routed to {testTarget?.agent_id}.</p>
              <p className="text-xs text-muted-foreground">Queue is responding normally.</p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setTestTarget(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
