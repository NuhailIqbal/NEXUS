import { useEffect, useState } from "react";
import { Plus, Wrench, Pencil, Trash2, PlayCircle, Settings as SettingsIcon, Loader2, CheckCircle2, XCircle } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CreateToolWizard, type ToolWizardData } from "@/components/tools/CreateToolWizard";
import { api } from "@/services/api";
import { toast } from "sonner";

type Tool = {
  id: string;
  name: string;
  description: string;
  status: string;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  parameters?: any[];
  lastModified: string;
  data?: ToolWizardData;
};

function toolToWizardData(t: Tool): Partial<ToolWizardData> {
  return {
    name: t.name,
    description: t.description,
    active: t.status === "Active",
    method: (t.method as ToolWizardData["method"]) || "POST",
    apiUrl: t.url || "",
    headers: Object.entries(t.headers || {}).map(([key, value]) => ({ id: Math.random().toString(36).slice(2, 10), key, value })),
    parameters: (t.parameters || []).map((p: any) => ({
      id: Math.random().toString(36).slice(2, 10),
      name: p.name || "",
      type: p.type || "string",
      description: p.description || "",
      defaultValue: p.defaultValue || "",
      required: p.required || false,
      enumValues: p.enumValues || [],
      expanded: false,
    })),
    bodyProperties: [],
  };
}

const Tools = () => {
  const [tools, setTools] = useState<Tool[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Tool | null>(null);

  const [testTool, setTestTool] = useState<Tool | null>(null);
  const [testState, setTestState] = useState<"idle" | "running" | "success" | "fail">("idle");
  const [testLog, setTestLog] = useState<string[]>([]);

  const [settingsTool, setSettingsTool] = useState<Tool | null>(null);
  const [settingsForm, setSettingsForm] = useState<Partial<Tool>>({});

  const fetchTools = async () => {
    setLoading(true);
    const { data } = await api.getTools();
    if (data) {
      const list = Array.isArray(data) ? data : data.data ?? [];
      setTools(
        list.map((t: any) => ({
          id: t.id,
          name: t.name,
          description: t.description ?? "",
          status: t.status ?? "Active",
          url: t.url ?? "",
          method: t.method ?? "POST",
          headers: t.headers ?? {},
          parameters: t.parameters ?? [],
          lastModified: t.updated_at
            ? new Date(t.updated_at).toISOString().slice(0, 10)
            : new Date(t.created_at).toISOString().slice(0, 10),
        })),
      );
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchTools();
  }, []);

  const handleSave = async (data: ToolWizardData) => {
    const headersObj: Record<string, string> = {};
    for (const h of data.headers) {
      if (h.key.trim()) headersObj[h.key.trim()] = h.value;
    }

    const params = data.parameters.map((p) => ({
      name: p.name,
      type: p.type,
      description: p.description,
      defaultValue: p.defaultValue,
      required: p.required,
      enumValues: p.enumValues,
    }));

    const payload = {
      name: data.name,
      description: data.description,
      status: data.active ? "Active" : "Inactive",
      url: data.apiUrl,
      method: data.method,
      headers: headersObj,
      parameters: params,
    };

    if (editing) {
      const { error } = await api.updateTool(editing.id, payload);
      if (error) return toast.error(error);
      toast.success("Tool updated");
      setEditing(null);
      setOpen(false);
      fetchTools();
      return;
    }

    const { error } = await api.createTool(payload);
    if (error) return toast.error(error);
    toast.success("Tool created");
    setOpen(false);
    fetchTools();
  };

  const handleDelete = async (t: Tool) => {
    const { error } = await api.deleteTool(t.id);
    if (error) return toast.error(error);
    setTools((prev) => prev.filter((x) => x.id !== t.id));
    toast.success("Tool deleted");
  };

  const openTest = async (t: Tool) => {
    setTestTool(t);
    setTestState("running");
    setTestLog([`Testing ${t.name}…`, `${t.method || "POST"} ${t.url || "(no URL)"}`, "Sending request with sample data…"]);

    const { data, error } = await api.testTool(t.id);
    if (error) {
      setTestLog((l) => [...l, `Error: ${error}`]);
      setTestState("fail");
      return;
    }

    const result = data as { ok: boolean; message: string; latency_ms: number | null; response_preview?: string } | null;
    if (!result) {
      setTestLog((l) => [...l, "No response from server"]);
      setTestState("fail");
      return;
    }

    const lines: string[] = [];
    const latency = result.latency_ms != null ? ` (${result.latency_ms}ms)` : "";
    lines.push(`${result.message}${latency}`);
    if (result.response_preview) {
      lines.push(`Response: ${result.response_preview.slice(0, 200)}`);
    }
    setTestLog((l) => [...l, ...lines]);
    setTestState(result.ok ? "success" : "fail");
  };

  const openSettings = (t: Tool) => {
    setSettingsTool(t);
    setSettingsForm({
      name: t.name,
      description: t.description,
      status: t.status,
    });
  };

  const saveSettings = async () => {
    if (!settingsTool) return;
    const patch = {
      name: settingsForm.name ?? settingsTool.name,
      description: settingsForm.description ?? settingsTool.description,
      status: settingsForm.status ?? settingsTool.status,
    };
    const { error } = await api.updateTool(settingsTool.id, patch);
    if (error) return toast.error(error);
    toast.success("Settings saved");
    setSettingsTool(null);
    fetchTools();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Tools</h1>
          <p className="text-sm text-muted-foreground">Custom API actions your agents can call during live calls.</p>
        </div>
        <Button onClick={() => { setEditing(null); setOpen(true); }}>
          <Plus className="mr-2 h-4 w-4" /> Add Tool
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : tools.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-12 text-center text-muted-foreground">
          No tools yet. Click "Add Tool" to create one.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Endpoint</th>
                <th className="px-4 py-3">Params</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Modified</th>
                <th className="px-4 py-3 w-44"></th>
              </tr>
            </thead>
            <tbody>
              {tools.map((t) => (
                <tr key={t.id} className="border-t border-border bg-card/30">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                        <Wrench className="h-4 w-4" />
                      </div>
                      <div>
                        <span className="font-medium text-foreground">{t.name}</span>
                        <p className="text-xs text-muted-foreground truncate max-w-[200px]">{t.description}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {t.url ? (
                      <div className="flex items-center gap-1.5">
                        <Badge variant="secondary" className="text-[10px]">{t.method || "POST"}</Badge>
                        <span className="text-xs text-muted-foreground truncate max-w-[180px]">{t.url}</span>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{(t.parameters || []).length}</td>
                  <td className="px-4 py-3">
                    <Badge variant={t.status === "Active" ? "default" : "secondary"}>{t.status}</Badge>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{t.lastModified}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => openTest(t)}
                        className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-primary"
                        title="Test tool"
                      >
                        <PlayCircle className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => openSettings(t)}
                        className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                        title="Settings"
                      >
                        <SettingsIcon className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => { setEditing(t); setOpen(true); }}
                        className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                        title="Edit in wizard"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(t)}
                        className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                        title="Delete"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CreateToolWizard
        open={open}
        onOpenChange={(v) => { setOpen(v); if (!v) setEditing(null); }}
        mode={editing ? "edit" : "create"}
        initialData={editing ? toolToWizardData(editing) : undefined}
        onSave={handleSave}
      />

      {/* Test Tool Modal */}
      <Dialog open={!!testTool} onOpenChange={(o) => !o && setTestTool(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PlayCircle className="h-5 w-5 text-primary" />
              Test {testTool?.name}
            </DialogTitle>
            <DialogDescription>
              Sends a request with sample data to your tool's API endpoint.
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
              <CheckCircle2 className="h-4 w-4" /> Endpoint reachable — tool is working.
            </div>
          )}
          {testState === "fail" && (
            <div className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <XCircle className="h-4 w-4" /> Test failed — check your URL and credentials.
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setTestTool(null)}>Close</Button>
            <Button
              onClick={() => testTool && openTest(testTool)}
              disabled={testState === "running"}
            >
              Run Again
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Settings Modal */}
      <Dialog open={!!settingsTool} onOpenChange={(o) => !o && setSettingsTool(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <SettingsIcon className="h-5 w-5 text-primary" />
              Tool Settings
            </DialogTitle>
            <DialogDescription>
              Update name, description, and status.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="tool-name">Name</Label>
              <Input
                id="tool-name"
                value={settingsForm.name ?? ""}
                onChange={(e) => setSettingsForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="tool-desc">Description</Label>
              <Textarea
                id="tool-desc"
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
                  <SelectItem value="Inactive">Inactive</SelectItem>
                  <SelectItem value="Paused">Paused</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setSettingsTool(null)}>
              Cancel
            </Button>
            <Button onClick={saveSettings}>Save Changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Tools;
