import { useEffect, useState } from "react";
import { Plus, PhoneOutgoing, Play, Pause as PauseIcon } from "lucide-react";
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
  contacts_count: number;
  completed_count: number;
};

const Outbound = () => {
  const [open, setOpen] = useState(false);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);

  const [settingsTarget, setSettingsTarget] = useState<Campaign | null>(null);
  const [settingsForm, setSettingsForm] = useState<{ name: string; agent_id: string; status: string }>({ name: "", agent_id: "", status: "" });

  const fetchCampaigns = async () => {
    const { data } = await api.getCampaigns();
    if (data) setCampaigns(Array.isArray(data) ? data : []);
    setLoading(false);
  };

  useEffect(() => { fetchCampaigns(); }, []);

  const togglePlay = async (c: Campaign) => {
    if (c.status === "Active") {
      const { error } = await api.pauseCampaign(c.id);
      if (error) return toast.error(error);
      toast.success("Campaign paused");
    } else {
      const action = c.status === "Paused" ? api.resumeCampaign : api.startCampaign;
      const { error } = await action(c.id);
      if (error) return toast.error(error);
      toast.success("Campaign started");
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
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Outbound Dialer</h1>
          <p className="text-sm text-muted-foreground">Run AI-powered outbound campaigns.</p>
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
                <p className="text-xs text-muted-foreground">Agent: {c.agent_id}</p>
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
            agent_id: d.agents[0] ?? "",
            list_id: d.customerList ?? "",
          });
          if (error) return toast.error(error);
          toast.success(`Campaign "${d.name}" created`);
          fetchCampaigns();
        }}
      />

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
              <Input value={settingsForm.agent_id} onChange={(e) => setSettingsForm((f) => ({ ...f, agent_id: e.target.value }))} />
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
