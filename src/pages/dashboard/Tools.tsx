import { useEffect, useState } from "react";
import { Plus, Wrench, Pencil, Trash2, PlayCircle, Settings as SettingsIcon, Loader2 } from "lucide-react";
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
  lastModified: string;
  data?: ToolWizardData;
};

const Tools = () => {
  const [tools, setTools] = useState<Tool[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Tool | null>(null);

  const [testTool, setTestTool] = useState<Tool | null>(null);
  const [testInput, setTestInput] = useState("");
  const [testOutput, setTestOutput] = useState<string | null>(null);
  const [testLoading, setTestLoading] = useState(false);

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
    if (editing) {
      const { error } = await api.updateTool(editing.id, {
        name: data.name,
        description: data.description,
        status: data.active ? "Active" : "Inactive",
      });
      if (error) return toast.error(error);
      toast.success("Tool updated");
      setEditing(null);
      setOpen(false);
      fetchTools();
      return;
    }

    const { error } = await api.createTool({
      name: data.name,
      description: data.description,
      status: data.active ? "Active" : "Inactive",
    });
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

  const openTest = (t: Tool) => {
    setTestTool(t);
    setTestInput(
      JSON.stringify(
        { example: "value", trigger: "manual" },
        null,
        2,
      ),
    );
    setTestOutput(null);
  };

  const runTest = () => {
    if (!testTool) return;
    setTestOutput(
      [
        "Tools execute inside live VAPI calls, not from the dashboard.",
        "",
        `To test "${testTool.name}":`,
        " 1. Attach this tool to an AI agent (via the Create AI Agent wizard or by editing the agent).",
        " 2. Use the \"Talk to Agent\" button on the AI Agents page.",
        " 3. Ask the agent to perform the action this tool exposes.",
        "",
        "Inside the call, VAPI will invoke the tool's server URL with the live arguments.",
      ].join("\n"),
    );
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
          <p className="text-sm text-muted-foreground">Reusable actions your agents and flows can call.</p>
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
                <th className="px-4 py-3">Description</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Last modified</th>
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
                      <span className="font-medium text-foreground">{t.name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{t.description}</td>
                  <td className="px-4 py-3">
                    <Badge variant={t.status === "Active" ? "default" : "secondary"}>{t.status}</Badge>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{t.lastModified}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => openTest(t)}
                        className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-primary"
                        aria-label="Test"
                        title="Test"
                      >
                        <PlayCircle className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => openSettings(t)}
                        className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                        aria-label="Settings"
                        title="Settings"
                      >
                        <SettingsIcon className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => { setEditing(t); setOpen(true); }}
                        className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                        aria-label="Edit"
                        title="Edit in wizard"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(t)}
                        className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                        aria-label="Delete"
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
        initialData={editing?.data}
        onSave={handleSave}
      />

      {/* Test Tool Modal */}
      <Dialog open={!!testTool} onOpenChange={(o) => !o && setTestTool(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PlayCircle className="h-5 w-5 text-primary" />
              Test {testTool?.name}
            </DialogTitle>
            <DialogDescription>
              Run this tool with sample input to preview its behavior.
            </DialogDescription>
          </DialogHeader>

          {testTool && (
            <div className="space-y-4">
              <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
                <p className="text-muted-foreground">{testTool.description}</p>
                <div className="mt-2 flex items-center gap-2">
                  <Badge variant={testTool.status === "Active" ? "default" : "secondary"}>
                    {testTool.status}
                  </Badge>
                  <span className="text-xs text-muted-foreground">Last modified {testTool.lastModified}</span>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="test-input">Input (JSON)</Label>
                <Textarea
                  id="test-input"
                  className="font-mono text-xs h-32"
                  value={testInput}
                  onChange={(e) => setTestInput(e.target.value)}
                />
              </div>

              {testOutput && (
                <div className="space-y-2">
                  <Label>Output</Label>
                  <pre className="max-h-56 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs font-mono">
                    {testOutput}
                  </pre>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setTestTool(null)}>
              Close
            </Button>
            <Button onClick={runTest} disabled={testLoading}>
              <PlayCircle className="mr-2 h-4 w-4" />
              {testLoading ? "Running..." : "Run Tool"}
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
              Update name, description, and status. Changes save immediately.
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
