import { useState, useEffect, useCallback } from "react";
import { Plug, Mail, Phone, Plus, Trash2, Settings as SettingsIcon, PlayCircle, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AddIntegrationDialog } from "@/components/integrations/AddIntegrationDialog";
import { SipTrunkDialog } from "@/components/integrations/SipTrunkDialog";
import { api } from "@/services/api";
import { toast } from "sonner";

type Integration = {
  id: string;
  name: string;
  description: string;
  status: string;
  category: "voice" | "email" | "other";
  config_encrypted?: string;
};

const Integrations = () => {
  const [openAdd, setOpenAdd] = useState(false);
  const [openSip, setOpenSip] = useState(false);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);

  const [testTarget, setTestTarget] = useState<Integration | null>(null);
  const [testState, setTestState] = useState<"idle" | "running" | "success" | "fail">("idle");
  const [testLog, setTestLog] = useState<string[]>([]);

  const [settingsTarget, setSettingsTarget] = useState<Integration | null>(null);
  const [settingsForm, setSettingsForm] = useState<Partial<Integration>>({});

  const fetchIntegrations = useCallback(async () => {
    const { data, error } = await api.getIntegrations();
    if (error) {
      toast.error(error);
    } else {
      setIntegrations(data ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchIntegrations();
  }, [fetchIntegrations]);

  const voice = integrations.filter((i) => i.category === "voice");
  const email = integrations.filter((i) => i.category === "email");
  const other = integrations.filter((i) => i.category === "other");

  const handleDelete = async (i: Integration) => {
    const { error } = await api.deleteIntegration(i.id);
    if (error) return toast.error(error);
    setIntegrations((prev) => prev.filter((x) => x.id !== i.id));
    toast.success("Integration removed");
  };

  const openTest = async (i: Integration) => {
    setTestTarget(i);
    setTestState("running");
    setTestLog([`Connecting to ${i.name}…`, "Sending authenticated request…"]);

    const { data, error } = await api.testIntegration(i.id);
    if (error) {
      setTestLog((l) => [...l, `Test failed: ${error}`]);
      setTestState("fail");
      return;
    }

    const result = data as { ok: boolean; message: string; latency_ms: number | null; provider: string | null } | null;
    if (!result) {
      setTestLog((l) => [...l, "Test failed: no response from server"]);
      setTestState("fail");
      return;
    }

    const tail: string[] = [];
    if (result.provider) tail.push(`Detected provider: ${result.provider}`);
    const latencyText = result.latency_ms != null ? ` (latency ${result.latency_ms}ms)` : "";
    tail.push(`${result.message}${latencyText}`);
    setTestLog((l) => [...l, ...tail]);
    setTestState(result.ok ? "success" : "fail");
  };

  const openSettings = (i: Integration) => {
    setSettingsTarget(i);
    setSettingsForm({
      name: i.name,
      description: i.description,
      status: i.status,
    });
  };

  const saveSettings = async () => {
    if (!settingsTarget) return;
    const patch: Partial<Integration> = {
      name: settingsForm.name ?? settingsTarget.name,
      description: settingsForm.description ?? settingsTarget.description,
      status: settingsForm.status ?? settingsTarget.status,
    };
    const { error } = await api.updateIntegration(settingsTarget.id, patch);
    if (error) return toast.error(error);
    setIntegrations((prev) => prev.map((x) => (x.id === settingsTarget.id ? { ...x, ...patch } : x)));
    toast.success("Settings saved");
    setSettingsTarget(null);
  };

  const categorize = (type: string): Integration["category"] => {
    const t = type.toLowerCase();
    if (t.includes("sip") || t.includes("twilio") || t.includes("idt") || t.includes("telephony") || t.includes("vonage") || t.includes("plivo")) return "voice";
    if (t.includes("mail") || t.includes("brevo") || t.includes("sendgrid") || t.includes("smtp")) return "email";
    return "other";
  };

  const handleCreateIntegration = async (d: { name: string; description: string; type: string; credentials: Record<string, string> }) => {
    const category = categorize(d.type);
    const { data, error } = await api.createIntegration({
      name: d.name,
      description: d.description || d.type,
      status: "Active",
      category,
      config_encrypted: JSON.stringify(d.credentials),
    });
    if (error) return toast.error(error);
    if (data) setIntegrations((prev) => [data, ...prev]);
  };

  const handleCreateSipTrunk = async (d: { name: string; description: string; domain: string }) => {
    const { data, error } = await api.createIntegration({
      name: d.name,
      description: d.description || `SIP Trunk - ${d.domain}`,
      status: "Active",
      category: "voice",
    });
    if (error) return toast.error(error);
    if (data) setIntegrations((prev) => [data, ...prev]);
  };

  const Section = ({ title, icon: Icon, items }: { title: string; icon: typeof Plug; items: Integration[] }) =>
    items.length === 0 ? null : (
      <div>
        <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold text-foreground">
          <Icon className="h-5 w-5 text-primary" />
          {title}
        </h2>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {items.map((i) => (
            <div key={i.id} className="flex items-start justify-between rounded-xl border border-border bg-card p-4 card-interactive">
              <div className="min-w-0 flex-1">
                <div className="font-medium text-foreground">{i.name}</div>
                <div className="text-xs text-muted-foreground">{i.description}</div>
                <div className="mt-2">
                  <Badge variant={i.status === "Active" ? "default" : i.status === "Paused" ? "secondary" : "outline"}>
                    {i.status}
                  </Badge>
                </div>
              </div>
              <div className="flex items-center gap-0.5 ml-2">
                <button
                  onClick={() => openTest(i)}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-primary"
                  aria-label="Test"
                  title="Test connection"
                >
                  <PlayCircle className="h-4 w-4" />
                </button>
                <button
                  onClick={() => openSettings(i)}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label="Settings"
                  title="Settings"
                >
                  <SettingsIcon className="h-4 w-4" />
                </button>
                <button
                  onClick={() => handleDelete(i)}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                  aria-label="Delete"
                  title="Delete"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading integrations...
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Integrations</h1>
          <p className="text-sm text-muted-foreground">Connect telephony providers, email services, and your CRM.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setOpenSip(true)}>
            <Phone className="mr-2 h-4 w-4" /> Add SIP Trunk
          </Button>
          <Button onClick={() => setOpenAdd(true)}>
            <Plus className="mr-2 h-4 w-4" /> Add Integration
          </Button>
        </div>
      </div>
      <Section title="Voice & Telephony" icon={Phone} items={voice} />
      <Section title="Email" icon={Mail} items={email} />
      <Section title="Other Connectors" icon={Plug} items={other} />

      <AddIntegrationDialog
        open={openAdd}
        onOpenChange={setOpenAdd}
        onCreate={handleCreateIntegration}
      />
      <SipTrunkDialog
        open={openSip}
        onOpenChange={setOpenSip}
        onCreate={handleCreateSipTrunk}
      />

      {/* Test Connection Modal */}
      <Dialog open={!!testTarget} onOpenChange={(o) => !o && setTestTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PlayCircle className="h-5 w-5 text-primary" />
              Test {testTarget?.name}
            </DialogTitle>
            <DialogDescription>
              Verifying connectivity and credentials for this integration.
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-lg border border-border bg-muted/30 p-3 font-mono text-xs space-y-1 max-h-56 overflow-y-auto">
            {testLog.map((line, i) => (
              <div key={i} className="text-foreground">{line}</div>
            ))}
            {testState === "running" && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> Working...
              </div>
            )}
          </div>

          {testState === "success" && (
            <div className="flex items-center gap-2 rounded-md bg-success/10 px-3 py-2 text-sm text-success">
              <CheckCircle2 className="h-4 w-4" /> Connection verified successfully.
            </div>
          )}
          {testState === "fail" && (
            <div className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <XCircle className="h-4 w-4" /> Connection test failed.
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setTestTarget(null)}>Close</Button>
            <Button
              onClick={() => testTarget && openTest(testTarget)}
              disabled={testState === "running"}
            >
              Run Again
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Settings Modal */}
      <Dialog open={!!settingsTarget} onOpenChange={(o) => !o && setSettingsTarget(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <SettingsIcon className="h-5 w-5 text-primary" />
              Integration Settings
            </DialogTitle>
            <DialogDescription>
              Update name, description, and status. Changes save immediately.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="int-name">Name</Label>
              <Input
                id="int-name"
                value={settingsForm.name ?? ""}
                onChange={(e) => setSettingsForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="int-desc">Description</Label>
              <Textarea
                id="int-desc"
                value={settingsForm.description ?? ""}
                onChange={(e) => setSettingsForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label>Status</Label>
              <Select
                value={settingsForm.status ?? "Active"}
                onValueChange={(v) => setSettingsForm((f) => ({ ...f, status: v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
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

export default Integrations;
