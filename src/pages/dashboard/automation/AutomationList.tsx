import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { Plus, Pencil, Trash2, Loader2, Pause, Play } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { SmartFilters } from "@/components/dashboard/SmartFilters";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { Button } from "@/components/ui/button";
import { CreateFlowDialog } from "@/components/automation/CreateFlowDialog";
import { api } from "@/services/api";

type Flow = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  definition?: any;
  created_at?: string;
  updated_at: string;
};

const Automation = ({ v2 = false }: { v2?: boolean }) => {
  const base = v2 ? "/dashboard/automation-v2" : "/dashboard/automation";

  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [flows, setFlows] = useState<Flow[]>([]);
  const [loading, setLoading] = useState(true);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const fetchFlows = useCallback(async () => {
    const { data, error } = await api.getFlows();
    if (error) {
      toast.error(error);
    } else {
      setFlows(data ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchFlows();
  }, [fetchFlows]);

  // The engine only runs flows whose status is "Active", so Paused stops future runs.
  const togglePause = async (f: Flow) => {
    const next = f.status === "Paused" ? "Active" : "Paused";
    setTogglingId(f.id);
    const { error } = await api.updateFlow(f.id, { status: next });
    setTogglingId(null);
    if (error) return toast.error(error);
    setFlows((arr) => arr.map((x) => (x.id === f.id ? { ...x, status: next } : x)));
    toast.success(next === "Paused" ? "Flow paused" : "Flow resumed");
  };

  const remove = async (f: Flow) => {
    const { error } = await api.deleteFlow(f.id);
    if (error) return toast.error(error);
    setFlows((arr) => arr.filter((x) => x.id !== f.id));
    toast.success("Flow deleted");
  };

  const filtered = flows.filter((f) => f.name.toLowerCase().includes(search.toLowerCase()));

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading flows...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={v2 ? "Flows Lists (V2)" : "Flows Lists"}
        description="Manage your workflow automation."
        actions={
          <Button onClick={() => setCreateOpen(true)} className="bg-primary text-primary-foreground">
            <Plus className="mr-2 h-4 w-4" /> Create New Flow
          </Button>
        }
      />

      <CreateFlowDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={fetchFlows} basePath={base} />

      <SmartFilters value={search} onChange={setSearch} placeholder="Search flows..." />

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[700px] text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left font-semibold">ID</th>
                <th className="px-4 py-3 text-left font-semibold">Name</th>
                <th className="px-4 py-3 text-left font-semibold">Description</th>
                <th className="px-4 py-3 text-left font-semibold">Status</th>
                <th className="px-4 py-3 text-left font-semibold">Modified</th>
                <th className="px-4 py-3 text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((f) => (
                <tr key={f.id} className="hover:bg-muted/40">
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-muted-foreground">{f.id.slice(0, 8)}</td>
                  <td className="px-4 py-3 font-medium">{f.name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{f.description}</td>
                  <td className="px-4 py-3"><StatusBadge status={f.status} /></td>
                  <td className="px-4 py-3 text-muted-foreground">{new Date(f.updated_at).toLocaleDateString()}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <button
                        onClick={() => togglePause(f)}
                        disabled={togglingId === f.id}
                        className="rounded-md p-2.5 sm:p-1.5 text-muted-foreground hover:bg-muted disabled:opacity-50"
                        aria-label={f.status === "Paused" ? "Resume flow" : "Pause flow"}
                        title={f.status === "Paused" ? "Resume flow" : "Pause flow"}
                      >
                        {f.status === "Paused" ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
                      </button>
                      <Link
                        to={`${base}/${f.id}?name=${encodeURIComponent(f.name)}`}
                        className="rounded-md p-2.5 sm:p-1.5 text-muted-foreground hover:bg-muted"
                        aria-label="Edit flow"
                      >
                        <Pencil className="h-4 w-4" />
                      </Link>
                      <button onClick={() => remove(f)} className="rounded-md p-2.5 sm:p-1.5 text-destructive hover:bg-destructive/10"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-12 text-center text-muted-foreground">No flows yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export const AutomationList = () => <Automation />;
