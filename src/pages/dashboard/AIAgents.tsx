import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Settings, Copy, Trash2, PlayCircle } from "lucide-react";
import { LiveVoiceModal } from "@/components/dashboard/LiveVoiceModal";
import EditAgentModal from "./EditAIAgent";
import { toast } from "sonner";
import { api } from "@/services/api";
import { toCallEventsPayload } from "@/components/agents/callEventTypes";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { SmartFilters, STATUS_DEFAULT, CATEGORY_DEFAULT, DATE_DEFAULT } from "@/components/dashboard/SmartFilters";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

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
  const [statusFilter, setStatusFilter] = useState(STATUS_DEFAULT);
  const [categoryFilter, setCategoryFilter] = useState(CATEGORY_DEFAULT);
  const [dateRangeFilter, setDateRangeFilter] = useState(DATE_DEFAULT);
  const [agents, setAgents] = useState<Agent[]>([]);

  // Modal state
  const [testAgent, setTestAgent] = useState<Agent | null>(null);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Agent | null>(null);
  const [pendingDuplicate, setPendingDuplicate] = useState<Agent | null>(null);

  const LANG_MAP: Record<string, string> = {
    "English": "en-US",
    "Urdu": "ur-PK",
    // Kept for agents saved before the language list was simplified.
    "English (US)": "en-US",
    "English (UK)": "en-GB",
    "Spanish (ES)": "es-ES",
    "Spanish (MX)": "es-MX",
    "French (FR)": "fr-FR",
    "Italian (IT)": "it-IT",
    "German (DE)": "de-DE",
    "Urdu (PK)": "ur-PK",
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

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const { error } = await api.deleteAgent(pendingDelete.id);
    setPendingDelete(null);
    if (error) return toast.error(error);
    toast.success("Agent deleted");
    load();
  };

  const confirmDuplicate = async () => {
    if (!pendingDuplicate) return;
    const a = pendingDuplicate;
    // Carry the agent's call events over so the copy reports the same outcomes.
    const eventsRes = await api.getAgentEvents(a.id);
    const callEvents = toCallEventsPayload(
      ((eventsRes.data ?? []) as { library_event_id: string | null }[])
        .map((ev) => ev.library_event_id)
        .filter((id): id is string => !!id),
    );
    const { error } = await api.createAgent({
      call_events: callEvents,
      selected_tool_keys: (a as { selected_tool_keys?: string[] }).selected_tool_keys ?? [],
      name: `${a.name} (Copy)`,
      voice: a.voice,
      language: a.language,
      category: a.category,
      status: a.status,
      system_prompt: a.system_prompt,
      first_message: a.first_message,
    });
    setPendingDuplicate(null);
    if (error) return toast.error(error);
    toast.success("Agent duplicated");
    load();
  };

  const openTest = (a: Agent) => {
    setTestAgent(a);
  };

  const categoryOptions = Array.from(
    new Set(agents.map((a) => a.category).filter((c): c is string => !!c)),
  ).sort();

  const dateRangeCutoff = (range: string): Date | null => {
    const now = new Date();
    if (range === "Last 7 days") return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    if (range === "Last 30 days") return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    if (range === "This year") return new Date(now.getFullYear(), 0, 1);
    return null;
  };

  const filtered = agents.filter((a) => {
    if (!a.name.toLowerCase().includes(search.toLowerCase())) return false;
    if (statusFilter !== STATUS_DEFAULT && a.status !== statusFilter) return false;
    if (categoryFilter !== CATEGORY_DEFAULT && a.category !== categoryFilter) return false;
    const cutoff = dateRangeCutoff(dateRangeFilter);
    if (cutoff && new Date(a.created_at) < cutoff) return false;
    return true;
  });

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

      <SmartFilters
        value={search}
        onChange={setSearch}
        placeholder="Search agents…"
        status={statusFilter}
        onStatusChange={setStatusFilter}
        category={categoryFilter}
        onCategoryChange={setCategoryFilter}
        categoryOptions={categoryOptions}
        dateRange={dateRangeFilter}
        onDateRangeChange={setDateRangeFilter}
      />

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-12 text-center text-sm text-muted-foreground">
          No agents found.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((a) => (
            <div key={a.id} className="flex flex-col rounded-xl border border-border bg-card p-5 transition hover:border-primary/40 hover:shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary font-semibold">
                    {a.name[0]?.toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <h3 className="break-words font-semibold leading-tight">{a.name}</h3>
                    <p className="text-xs text-muted-foreground">{a.category ?? " "}</p>
                  </div>
                </div>
                <StatusBadge status={a.status} className="shrink-0" />
              </div>

              <dl className="mb-5 mt-5 space-y-1.5 text-sm">
                <Row label="Voice" value={a.voice ?? " "} />
                <Row label="Language" value={a.language ?? " "} />
                <Row label="Created" value={new Date(a.created_at).toLocaleDateString()} />
              </dl>

              <div className="mt-auto flex items-center justify-between border-t border-border pt-4">
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
                    onClick={() => setEditingAgentId(a.id)}
                    className="rounded-md p-2 text-muted-foreground hover:bg-muted sm:p-1.5"
                  >
                    <Settings className="h-4 w-4" />
                  </button>
                  <button
                    title="Duplicate"
                    onClick={() => setPendingDuplicate(a)}
                    className="rounded-md p-2 text-muted-foreground hover:bg-muted sm:p-1.5"
                  >
                    <Copy className="h-4 w-4" />
                  </button>
                  <button
                    title="Delete"
                    onClick={() => setPendingDelete(a)}
                    className="rounded-md p-2 text-destructive hover:bg-destructive/10 sm:p-1.5"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <AlertDialog open={!!pendingDelete} onOpenChange={(o) => { if (!o) setPendingDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader className="text-center sm:text-center">
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete && `"${pendingDelete.name}" will be permanently deleted. `}
              This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="sm:justify-center">
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!pendingDuplicate} onOpenChange={(o) => { if (!o) setPendingDuplicate(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader className="text-center sm:text-center">
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDuplicate && `A copy of "${pendingDuplicate.name}" will be created.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="sm:justify-center">
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDuplicate}>Duplicate</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Live Voice Call Modal */}
      <LiveVoiceModal
        agent={testAgent}
        open={!!testAgent}
        onOpenChange={(o) => {
          if (!o) setTestAgent(null);
        }}
      />

      {/* Edit Agent Modal — same 4-step wizard as Create, prefilled and scoped to updates */}
      <EditAgentModal
        agentId={editingAgentId}
        onClose={() => setEditingAgentId(null)}
        onSaved={load}
      />
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
