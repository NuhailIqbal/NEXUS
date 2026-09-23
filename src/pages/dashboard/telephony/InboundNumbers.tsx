import { useEffect, useState } from "react";
import { Phone, PhoneIncoming } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RowActions } from "@/components/dashboard/RowActions";
import { api } from "@/services/api";
import { toast } from "sonner";

type Num = {
  id: string;
  number: string;
  status: string;
  agent_id: string;
  provider: string;
  created_at: string;
  suspended_for_balance?: boolean;
};

const InboundNumbers = () => {
  const [numbers, setNumbers] = useState<Num[]>([]);
  const [agentsById, setAgentsById] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);

  const [settingsTarget, setSettingsTarget] = useState<Num | null>(null);
  const [settingsForm, setSettingsForm] = useState<{ agent_id: string; status: string }>({ agent_id: "", status: "" });

  const fetchNumbers = async () => {
    const [numbersRes, agentsRes] = await Promise.all([api.getPhoneNumbers(), api.getAgents()]);
    if (Array.isArray(numbersRes.data)) {
      // "Inbound numbers" = numbers that actually have an agent answering them —
      // that's what makes a number inbound-capable, regardless of provider or how
      // it was acquired (AI Receptionist wizard vs. the general Phone Numbers page).
      setNumbers(numbersRes.data.filter((n: Num) => !!n.agent_id));
    }
    if (Array.isArray(agentsRes.data))
      setAgentsById(new Map(agentsRes.data.map((a: any) => [a.id, a.name])));
    setLoading(false);
  };

  useEffect(() => { fetchNumbers(); }, []);

  const openSettings = (n: Num) => {
    setSettingsTarget(n);
    setSettingsForm({ agent_id: n.agent_id, status: n.status });
  };

  const saveSettings = async () => {
    if (!settingsTarget) return;
    const { error } = await api.updatePhoneNumber(settingsTarget.id, {
      agent_id: settingsForm.agent_id,
      status: settingsForm.status,
    });
    if (error) return toast.error(error);
    toast.success("Number updated");
    setSettingsTarget(null);
    fetchNumbers();
  };

  const removeFromInbound = async (n: Num) => {
    if (!confirm(`Stop ${n.number} from answering inbound calls? The number itself is not released — you can reassign an agent to it anytime.`)) return;
    const { error } = await api.updatePhoneNumber(n.id, { agent_id: null });
    if (error) return toast.error(error);
    toast.success("Number removed from inbound");
    fetchNumbers();
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Inbound Numbers</h1>
        <p className="text-sm text-muted-foreground">Every phone number currently answered by an AI agent.</p>
      </div>
      <div className="overflow-hidden rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Number</th>
              <th className="px-4 py-3">Provider</th>
              <th className="px-4 py-3">Assigned Agent</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Purchased</th>
              <th className="px-4 py-3 w-32">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">Loading...</td>
              </tr>
            ) : numbers.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-muted-foreground">
                  <PhoneIncoming className="mx-auto mb-2 h-8 w-8 text-muted-foreground/40" />
                  No numbers are set up for inbound yet. Assign an agent to a number on the Phone Numbers page, or create an AI Receptionist.
                </td>
              </tr>
            ) : (
              numbers.map((n) => (
                <tr key={n.id} className="border-t border-border bg-card/30">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 font-mono text-foreground">
                      <Phone className="h-4 w-4 text-primary" /> {n.number}
                    </div>
                  </td>
                  <td className="px-4 py-3">{n.provider}</td>
                  <td className="px-4 py-3 text-muted-foreground">{agentsById.get(n.agent_id) || "Unknown agent"}</td>
                  <td className="px-4 py-3">
                    {n.suspended_for_balance ? (
                      <Badge variant="destructive">Suspended — add funds</Badge>
                    ) : (
                      <Badge variant={n.status === "Active" ? "default" : "secondary"}>{n.status}</Badge>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {n.created_at ? new Date(n.created_at).toLocaleDateString() : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <RowActions
                      onSettings={() => openSettings(n)}
                      onDelete={() => removeFromInbound(n)}
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Settings modal */}
      <Dialog open={!!settingsTarget} onOpenChange={(o) => !o && setSettingsTarget(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Inbound Number Settings</DialogTitle>
            <DialogDescription>Reassign the agent that answers this number, or change its status.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Assigned Agent</Label>
              <Select value={settingsForm.agent_id} onValueChange={(v) => setSettingsForm((f) => ({ ...f, agent_id: v }))}>
                <SelectTrigger><SelectValue placeholder="Select an agent" /></SelectTrigger>
                <SelectContent>
                  {Array.from(agentsById.entries()).map(([id, name]) => (
                    <SelectItem key={id} value={id}>{name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
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

export default InboundNumbers;
