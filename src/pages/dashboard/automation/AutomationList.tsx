import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { Plus, Pencil, Trash2, Loader2 } from "lucide-react";
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
        <table className="w-full text-sm">
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
                <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{f.id.slice(0, 8)}</td>
                <td className="px-4 py-3 font-medium">{f.name}</td>
                <td className="px-4 py-3 text-muted-foreground">{f.description}</td>
                <td className="px-4 py-3"><StatusBadge status={f.status} /></td>
                <td className="px-4 py-3 text-muted-foreground">{new Date(f.updated_at).toLocaleDateString()}</td>
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-1">
                    <Link
                      to={`${base}/${f.id}?name=${encodeURIComponent(f.name)}`}
                      className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
                      aria-label="Edit flow"
                    >
                      <Pencil className="h-4 w-4" />
                    </Link>
                    <button onClick={() => remove(f)} className="rounded-md p-1.5 text-destructive hover:bg-destructive/10"><Trash2 className="h-4 w-4" /></button>
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
  );
};

export const AutomationList = () => <Automation />;
export const AutomationV2List = () => <Automation v2 />;
