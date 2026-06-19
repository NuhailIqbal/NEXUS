import { useEffect, useState } from "react";
import { Plus, Phone } from "lucide-react";
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
import { CreatePhoneNumberDialog } from "@/components/telephony/CreatePhoneNumberDialog";
import { RowActions } from "@/components/dashboard/RowActions";
import { api } from "@/services/api";
import { toast } from "sonner";

type Num = {
  id: string;
  number: string;
  status: string;
  agent_id: string;
  provider: string;
  vapi_phone_id: string;
};

const PhoneNumbers = () => {
  const [open, setOpen] = useState(false);
  const [numbers, setNumbers] = useState<Num[]>([]);
  const [loading, setLoading] = useState(true);

  const [testTarget, setTestTarget] = useState<Num | null>(null);
  const [testLog, setTestLog] = useState<string[]>([]);
  const [settingsTarget, setSettingsTarget] = useState<Num | null>(null);
  const [settingsForm, setSettingsForm] = useState<{ agent_id: string; status: string; provider: string }>({ agent_id: "", status: "", provider: "" });

  const fetchNumbers = async () => {
    const { data } = await api.getPhoneNumbers();
    if (data) setNumbers(Array.isArray(data) ? data : []);
    setLoading(false);
  };

  useEffect(() => { fetchNumbers(); }, []);

  const handleDelete = async (n: Num) => {
    const { error } = await api.deletePhoneNumber(n.id);
    if (error) return toast.error(error);
    toast.success("Number released");
    fetchNumbers();
  };

  const openTest = (n: Num) => {
    setTestTarget(n);
    setTestLog([`Placing test call to ${n.number}...`]);
    setTimeout(() => setTestLog((l) => [...l, "Routing through carrier..."]), 400);
    setTimeout(() => setTestLog((l) => [...l, "Connected to agent: " + n.agent_id]), 900);
    setTimeout(() => {
      const ok = n.status === "Active";
      setTestLog((l) => [...l, ok ? "Test call completed (3.2s)" : "Number is inactive -- call rejected"]);
    }, 1400);
  };

  const openSettings = (n: Num) => {
    setSettingsTarget(n);
    setSettingsForm({ agent_id: n.agent_id, status: n.status, provider: n.provider });
  };

  const saveSettings = async () => {
    if (!settingsTarget) return;
    const { error } = await api.updatePhoneNumber(settingsTarget.id, {
      agent_id: settingsForm.agent_id,
      status: settingsForm.status,
      provider: settingsForm.provider,
    });
    if (error) return toast.error(error);
    toast.success("Number updated");
    setSettingsTarget(null);
    fetchNumbers();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Phone Numbers</h1>
          <p className="text-sm text-muted-foreground">Provision and manage your numbers.</p>
        </div>
        <Button onClick={() => setOpen(true)}><Plus className="mr-2 h-4 w-4" />Buy Number</Button>
      </div>
      <div className="overflow-hidden rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Number</th>
              <th className="px-4 py-3">Provider</th>
              <th className="px-4 py-3">Assigned Agent</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 w-32"></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">Loading...</td>
              </tr>
            ) : numbers.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">No phone numbers found.</td>
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
                  <td className="px-4 py-3 text-muted-foreground">{n.agent_id}</td>
                  <td className="px-4 py-3">
                    <Badge variant={n.status === "Active" ? "default" : "secondary"}>{n.status}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    <RowActions
                      onTest={() => openTest(n)}
                      onSettings={() => openSettings(n)}
                      onDelete={() => handleDelete(n)}
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <CreatePhoneNumberDialog
        open={open}
        onOpenChange={setOpen}
        onCreate={async (d) => {
          const number = d.title.startsWith("+") ? d.title : `+${d.title}`;
          const { error } = await api.createPhoneNumber({
            number,
            status: d.active ? "Active" : "Inactive",
            provider: d.serviceProvider,
          });
          if (error) return toast.error(error);
          toast.success(`Phone number "${d.title}" created`);
          fetchNumbers();
        }}
      />

      {/* Test call modal */}
      <Dialog open={!!testTarget} onOpenChange={(o) => !o && setTestTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Test {testTarget?.number}</DialogTitle>
            <DialogDescription>Simulating an inbound test call.</DialogDescription>
          </DialogHeader>
          <div className="rounded-md border border-border bg-muted/30 p-3 font-mono text-xs space-y-1 max-h-56 overflow-y-auto">
            {testLog.map((l, i) => <div key={i}>{l}</div>)}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTestTarget(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Settings modal */}
      <Dialog open={!!settingsTarget} onOpenChange={(o) => !o && setSettingsTarget(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Number Settings</DialogTitle>
            <DialogDescription>Reassign agent or change status.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Assigned Agent</Label>
              <Input value={settingsForm.agent_id} onChange={(e) => setSettingsForm((f) => ({ ...f, agent_id: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Provider</Label>
                <Input value={settingsForm.provider} onChange={(e) => setSettingsForm((f) => ({ ...f, provider: e.target.value }))} />
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

export default PhoneNumbers;
