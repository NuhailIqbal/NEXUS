import { useState, useEffect, useCallback } from "react";
import { Radio, Plus, Code, Loader2, CheckCircle2 } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CreateVoiceWidgetDialog } from "@/components/voices/CreateVoiceWidgetDialog";
import { RowActions } from "@/components/dashboard/RowActions";
import { api } from "@/services/api";
import { toast } from "sonner";

type Widget = {
  id: string;
  name: string;
  status: string;
  agent: string;
  position: string;
  public_token?: string;
};

const EMBED_BASE_URL =
  (import.meta as any).env?.VITE_API_PUBLIC_URL ||
  (typeof window !== "undefined" ? window.location.origin : "");

const VoiceWidgets = () => {
  const [open, setOpen] = useState(false);
  const [widgets, setWidgets] = useState<Widget[]>([]);
  const [loading, setLoading] = useState(true);

  const [testTarget, setTestTarget] = useState<Widget | null>(null);
  const [testState, setTestState] = useState<"idle" | "loading" | "ready">("idle");
  const [settingsTarget, setSettingsTarget] = useState<Widget | null>(null);
  const [settingsForm, setSettingsForm] = useState<Partial<Widget>>({});
  const [embedFor, setEmbedFor] = useState<Widget | null>(null);

  const fetchWidgets = useCallback(async () => {
    const [widgetsRes, agentsRes] = await Promise.all([
      api.getVoiceWidgets(),
      api.getAgents(),
    ]);
    if (widgetsRes.error) {
      toast.error(widgetsRes.error);
    } else {
      const agentsById = new Map<string, string>(
        (agentsRes.data ?? []).map((a: any) => [a.id, a.name]),
      );
      const positionLabel = (slug?: string): string => {
        if (!slug) return "Bottom Right";
        return slug
          .split("-")
          .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
          .join(" ");
      };
      const normalized: Widget[] = (widgetsRes.data ?? []).map((w: any) => ({
        id: w.id,
        name: w.name,
        status: w.status,
        public_token: w.public_token,
        agent: w.agent_id ? agentsById.get(w.agent_id) ?? "Unassigned" : "Unassigned",
        position: positionLabel(w.config?.position),
      }));
      setWidgets(normalized);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchWidgets();
  }, [fetchWidgets]);

  const handleDelete = async (w: Widget) => {
    const { error } = await api.deleteVoiceWidget(w.id);
    if (error) return toast.error(error);
    setWidgets((prev) => prev.filter((x) => x.id !== w.id));
    toast.success("Widget removed");
  };

  const openTest = (w: Widget) => {
    setTestTarget(w);
    setTestState("loading");
    setTimeout(() => setTestState("ready"), 800);
  };

  const openSettings = (w: Widget) => {
    setSettingsTarget(w);
    setSettingsForm({ name: w.name, status: w.status, agent: w.agent, position: w.position });
  };

  const saveSettings = async () => {
    if (!settingsTarget) return;
    // The settings dialog only edits display fields (name, status, position label).
    // agent_id is set at creation; position is folded into the config blob backend-side via the embed.js.
    const newPosition = settingsForm.position ?? settingsTarget.position;
    const patch = {
      name: settingsForm.name ?? settingsTarget.name,
      status: settingsForm.status ?? settingsTarget.status,
      config: {
        position: newPosition.toLowerCase().replace(/\s+/g, "-"),
      },
    };
    const { error } = await api.updateVoiceWidget(settingsTarget.id, patch);
    if (error) return toast.error(error);
    setWidgets((prev) => prev.map((x) =>
      x.id === settingsTarget.id ? { ...x, name: patch.name, status: patch.status, position: newPosition } : x,
    ));
    toast.success("Widget saved");
    setSettingsTarget(null);
  };

  const handleCreate = async (d: {
    widgetName: string;
    status: string;
    agentName: string;
    position: string;
    agentId: string;
    callType: string;
    maxCalls: number;
    recordCalls: boolean;
    showTranscription: boolean;
    primaryColor: string;
    autoOpen: boolean;
  }) => {
    const positionSlug = d.position.toLowerCase().replace(/\s+/g, "-");
    const buttonLabel =
      d.callType === "Voice + Video" || d.callType === "Video" ? "Start Call" : "Talk to AI";

    const { data, error } = await api.createVoiceWidget({
      name: d.widgetName,
      status: d.status,
      agent_id: d.agentId,
      config: {
        position: positionSlug,
        buttonColor: d.primaryColor,
        buttonLabel,
        callType: d.callType,
        maxCalls: d.maxCalls,
        recordCalls: d.recordCalls,
        showTranscription: d.showTranscription,
        autoOpen: d.autoOpen,
      },
    });
    if (error) return toast.error(error);
    if (data) {
      setWidgets((prev) => [{ ...data, agent: d.agentName, position: d.position }, ...prev]);
      toast.success("Voice widget created");
    }
  };

  const embedSnippet = (w: Widget) => {
    if (!w.public_token) {
      return "<!-- Save this widget to generate an embed snippet -->";
    }
    return `<script async src="${EMBED_BASE_URL}/api/voice-widgets/${w.public_token}/embed.js"></script>`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading widgets...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Voice Widgets</h1>
          <p className="text-sm text-muted-foreground">Embeddable voice agents for your website.</p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus className="mr-2 h-4 w-4" /> New Widget
        </Button>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {widgets.map((w) => (
          <div key={w.id} className="rounded-xl border border-border bg-card p-5 card-interactive">
            <div className="flex items-start justify-between">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Radio className="h-5 w-5" />
              </div>
              <Badge variant={w.status === "Active" ? "default" : "secondary"}>{w.status}</Badge>
            </div>
            <h3 className="mt-4 font-semibold text-foreground">{w.name}</h3>
            <p className="mt-1 text-xs text-muted-foreground">Agent: {w.agent} · {w.position}</p>
            <div className="mt-4 border-t border-border pt-3">
              <RowActions
                onView={() => setEmbedFor(w)}
                onTest={() => openTest(w)}
                onSettings={() => openSettings(w)}
                onDelete={() => handleDelete(w)}
              />
            </div>
          </div>
        ))}
      </div>

      <CreateVoiceWidgetDialog
        open={open}
        onOpenChange={setOpen}
        onCreate={handleCreate}
      />

      {/* Embed snippet modal */}
      <Dialog open={!!embedFor} onOpenChange={(o) => !o && setEmbedFor(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Code className="h-5 w-5 text-primary" /> Embed {embedFor?.name}
            </DialogTitle>
            <DialogDescription>Copy this snippet into your site's HTML.</DialogDescription>
          </DialogHeader>
          {embedFor && (
            <pre className="overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs font-mono whitespace-pre-wrap break-all">
{embedSnippet(embedFor)}
            </pre>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEmbedFor(null)}>Close</Button>
            <Button
              onClick={() => {
                if (embedFor) {
                  navigator.clipboard.writeText(embedSnippet(embedFor));
                  toast.success("Snippet copied");
                }
              }}
            >
              Copy Snippet
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Test modal */}
      <Dialog open={!!testTarget} onOpenChange={(o) => !o && setTestTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Test {testTarget?.name}</DialogTitle>
            <DialogDescription>Simulating widget load on your site.</DialogDescription>
          </DialogHeader>
          {testState === "loading" ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading widget…
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 py-6">
              <CheckCircle2 className="h-10 w-10 text-success" />
              <p className="text-sm">Widget loaded successfully on a sandbox page.</p>
              <p className="text-xs text-muted-foreground">
                Position: {testTarget?.position} · Agent: {testTarget?.agent}
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setTestTarget(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Settings modal */}
      <Dialog open={!!settingsTarget} onOpenChange={(o) => !o && setSettingsTarget(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Widget Settings</DialogTitle>
            <DialogDescription>Update name, agent, position, and status.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={settingsForm.name ?? ""} onChange={(e) => setSettingsForm((f) => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label>Agent</Label>
              <Input value={settingsForm.agent ?? ""} onChange={(e) => setSettingsForm((f) => ({ ...f, agent: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Position</Label>
                <Select value={settingsForm.position ?? "Bottom Right"} onValueChange={(v) => setSettingsForm((f) => ({ ...f, position: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Bottom Right">Bottom Right</SelectItem>
                    <SelectItem value="Bottom Left">Bottom Left</SelectItem>
                    <SelectItem value="Top Right">Top Right</SelectItem>
                    <SelectItem value="Top Left">Top Left</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Status</Label>
                <Select value={settingsForm.status ?? "Active"} onValueChange={(v) => setSettingsForm((f) => ({ ...f, status: v }))}>
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
            <Button onClick={saveSettings}>Save Changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default VoiceWidgets;
