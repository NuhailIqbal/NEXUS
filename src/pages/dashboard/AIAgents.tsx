import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Settings, Copy, Trash2, PlayCircle } from "lucide-react";
import { LiveVoiceModal } from "@/components/dashboard/LiveVoiceModal";
import { toast } from "sonner";
import { api } from "@/services/api";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { SmartFilters } from "@/components/dashboard/SmartFilters";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
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

type Agent = {
  id: string;
  name: string;
  status: string;
  voice: string | null;
  language: string | null;
  category: string | null;
  created_at: string;
  vapi_assistant_id?: string | null;
  system_prompt?: string | null;
  first_message?: string | null;
  transfer_number?: string | null;
  user_id?: string | null;
};

const AIAgents = () => {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);

  // Modal state
  const [testAgent, setTestAgent] = useState<Agent | null>(null);
  const [settingsAgent, setSettingsAgent] = useState<Agent | null>(null);
  const [editForm, setEditForm] = useState<Partial<Agent>>({});

  const LANG_MAP: Record<string, string> = {
    "English (US)": "en-US",
    "English (UK)": "en-GB",
    "Spanish (ES)": "es-ES",
    "Spanish (MX)": "es-MX",
    "French (FR)": "fr-FR",
    "Italian (IT)": "it-IT",
    "German (DE)": "de-DE",
  };

  const speak = (text: string, agent: Agent | null) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const lang = (agent?.language && LANG_MAP[agent.language]) || "en-US";
      u.lang = lang;
      u.rate = 1;
      u.pitch = 1;
      const voices = window.speechSynthesis.getVoices();
      // Try to pick a voice matching the agent's voice name, then language
      const byName = agent?.voice
        ? voices.find((v) => v.name.toLowerCase().includes(agent.voice!.toLowerCase()))
        : null;
      const byLang = voices.find((v) => v.lang === lang) ?? voices.find((v) => v.lang.startsWith(lang.split("-")[0]));
      const picked = byName ?? byLang;
      if (picked) u.voice = picked;
      window.speechSynthesis.speak(u);
    } catch {
      // ignore TTS errors silently
    }
  };

  const load = async () => {
    const { data, error } = await api.getAgents();
    if (error) {
      toast.error(error);
      setAgents([]);
      return;
    }
    setAgents((data ?? []) as Agent[]);
  };

  useEffect(() => {
    load();
  }, []);

  const remove = async (a: Agent) => {
    const { error } = await api.deleteAgent(a.id);
    if (error) return toast.error(error);
    toast.success("Agent deleted");
    load();
  };

  const duplicate = async (a: Agent) => {
    const { error } = await api.createAgent({
      name: `${a.name} (Copy)`,
      voice: a.voice,
      language: a.language,
      category: a.category,
      status: a.status,
      system_prompt: a.system_prompt,
      first_message: a.first_message,
    });
    if (error) return toast.error(error);
    toast.success("Agent duplicated");
    load();
  };

  const openTest = (a: Agent) => {
    setTestAgent(a);
  };

  const openSettings = (a: Agent) => {
    setSettingsAgent(a);
    setEditForm({
      name: a.name,
      status: a.status,
      voice: a.voice,
      language: a.language,
      category: a.category,
      system_prompt: a.system_prompt,
      first_message: a.first_message,
      transfer_number: a.transfer_number,
    });
  };

  const saveSettings = async () => {
    if (!settingsAgent) return;
    const { error } = await api.updateAgent(settingsAgent.id, {
      name: editForm.name,
      status: editForm.status,
      voice: editForm.voice,
      language: editForm.language,
      category: editForm.category,
      system_prompt: editForm.system_prompt,
      first_message: editForm.first_message,
      transfer_number: editForm.transfer_number,
    });
    if (error) return toast.error(error);
    toast.success("Settings saved");
    setSettingsAgent(null);
    load();
  };

  const filtered = agents.filter((a) =>
    a.name.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="AI Agents"
        description="Build and manage your AI agents in one place."
        actions={
          <Button
            onClick={() => navigate("/dashboard/ai-agents/create")}
            className="bg-primary text-primary-foreground hover:opacity-90"
          >
            <Plus className="mr-2 h-4 w-4" /> Add New Agent
          </Button>
        }
      />

      <SmartFilters value={search} onChange={setSearch} placeholder="Search agents…" />

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-12 text-center text-sm text-muted-foreground">
          No agents found.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((a) => (
            <div key={a.id} className="rounded-xl border border-border bg-card p-5 transition hover:border-primary/40 hover:shadow-sm">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10 text-primary font-semibold">
                    {a.name[0]?.toUpperCase()}
                  </div>
                  <div>
                    <h3 className="font-semibold leading-tight">{a.name}</h3>
                    <p className="text-xs text-muted-foreground">{a.category ?? " "}</p>
                  </div>
                </div>
                <StatusBadge status={a.status} />
              </div>

              <dl className="mt-5 space-y-1.5 text-sm">
                <Row label="Voice" value={a.voice ?? " "} />
                <Row label="Language" value={a.language ?? " "} />
                <Row label="Created" value={new Date(a.created_at).toLocaleDateString()} />
              </dl>

              <div className="mt-5 flex items-center justify-between border-t border-border pt-4">
                <Button
                  size="sm"
                  variant="outline"
                  className="text-primary border-primary/40"
                  onClick={() => openTest(a)}
                >
                  <PlayCircle className="mr-1.5 h-4 w-4" /> Test
                </Button>
                <div className="flex items-center gap-1">
                  <button
                    title="Settings"
                    onClick={() => openSettings(a)}
                    className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
                  >
                    <Settings className="h-4 w-4" />
                  </button>
                  <button
                    title="Duplicate"
                    onClick={() => duplicate(a)}
                    className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
                  >
                    <Copy className="h-4 w-4" />
                  </button>
                  <button
                    title="Delete"
                    onClick={() => remove(a)}
                    className="rounded-md p-1.5 text-destructive hover:bg-destructive/10"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Live Voice Call Modal */}
      <LiveVoiceModal
        agent={testAgent}
        open={!!testAgent}
        onOpenChange={(o) => {
          if (!o) setTestAgent(null);
        }}
      />

      {/* Settings Modal */}
      <Dialog open={!!settingsAgent} onOpenChange={(o) => !o && setSettingsAgent(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5 text-primary" />
              Agent Settings
            </DialogTitle>
            <DialogDescription>
              Update your agent's configuration. Changes save immediately.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="agent-name">Name</Label>
              <Input
                id="agent-name"
                value={editForm.name ?? ""}
                onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="agent-category">Category</Label>
              <Input
                id="agent-category"
                value={editForm.category ?? ""}
                onChange={(e) => setEditForm((f) => ({ ...f, category: e.target.value }))}
                placeholder="e.g. Lead Qualifying"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Status</Label>
                <Select
                  value={editForm.status ?? "Active"}
                  onValueChange={(v) => setEditForm((f) => ({ ...f, status: v }))}
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

              <div className="space-y-2">
                <Label>Voice</Label>
                <Select
                  value={editForm.voice ?? ""}
                  onValueChange={(v) => setEditForm((f) => ({ ...f, voice: v }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select voice" />
                  </SelectTrigger>
                  <SelectContent>
                    {["Aria", "Marco", "Nora", "Kai", "Eva", "Tom", "Lia", "Diego"].map((v) => (
                      <SelectItem key={v} value={v}>
                        {v}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Language</Label>
              <Select
                value={editForm.language ?? ""}
                onValueChange={(v) => setEditForm((f) => ({ ...f, language: v }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select language" />
                </SelectTrigger>
                <SelectContent>
                  {[
                    "English (US)",
                    "English (UK)",
                    "Spanish (ES)",
                    "Spanish (MX)",
                    "French (FR)",
                    "Italian (IT)",
                    "German (DE)",
                  ].map((l) => (
                    <SelectItem key={l} value={l}>
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2 border-t border-border pt-4">
              <Label htmlFor="agent-first-message">Greeting (first message)</Label>
              <Input
                id="agent-first-message"
                value={editForm.first_message ?? ""}
                onChange={(e) => setEditForm((f) => ({ ...f, first_message: e.target.value }))}
                placeholder="Hi! How can I help you today?"
              />
              <p className="text-xs text-muted-foreground">What the agent says at the very start of a call.</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="agent-transfer-number">Transfer number</Label>
              <Input
                id="agent-transfer-number"
                value={editForm.transfer_number ?? ""}
                onChange={(e) => setEditForm((f) => ({ ...f, transfer_number: e.target.value }))}
                placeholder="+15551234567"
              />
              <p className="text-xs text-muted-foreground">
                When a call is qualified, the agent transfers it to this number (E.164, e.g. +1…). Leave blank for no transfer.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="agent-system-prompt">System prompt</Label>
              <Textarea
                id="agent-system-prompt"
                value={editForm.system_prompt ?? ""}
                onChange={(e) => setEditForm((f) => ({ ...f, system_prompt: e.target.value }))}
                rows={8}
                placeholder="You are a friendly assistant who helps users with…"
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                The agent's instructions. Changes apply on the next call no need to recreate the agent.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setSettingsAgent(null)}>
              Cancel
            </Button>
            <Button onClick={saveSettings}>Save Changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium text-foreground">{value}</dd>
    </div>
  );
}

function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

export default AIAgents;
