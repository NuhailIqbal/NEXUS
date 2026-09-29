import { useEffect, useState, useCallback, useMemo } from "react";
import { Link } from "react-router-dom";
import { Plus, Pencil, Trash2, Loader2, Pause, Play } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { Button } from "@/components/ui/button";
import { CreateFlowDialog } from "@/components/automation/CreateFlowDialog";
import { api } from "@/services/api";
import {
  SortableColumnHeader,
  TableTextFilter,
  TableSelectFilter,
  TableDateFilter,
  TablePagination,
  TABLE_PAGE_SIZE_OPTIONS,
} from "@/components/dashboard/table/TableControls";

type Flow = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  definition?: any;
  created_at?: string;
  updated_at: string;
};

type ColumnKey = "id" | "name" | "description" | "status" | "updated_at";

const COLUMNS: { key: ColumnKey; label: string }[] = [
  { key: "id", label: "ID" },
  { key: "name", label: "Name" },
  { key: "description", label: "Description" },
  { key: "status", label: "Status" },
  { key: "updated_at", label: "Modified" },
];

const Automation = ({ v2 = false }: { v2?: boolean }) => {
  const base = v2 ? "/dashboard/automation-v2" : "/dashboard/automation";

  const [createOpen, setCreateOpen] = useState(false);
  const [flows, setFlows] = useState<Flow[]>([]);
  const [loading, setLoading] = useState(true);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const [sort, setSort] = useState<{ key: ColumnKey | null; dir: "asc" | "desc" }>({ key: "updated_at", dir: "desc" });
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [modifiedDate, setModifiedDate] = useState<Date | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(TABLE_PAGE_SIZE_OPTIONS[0]);

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

  useEffect(() => {
    setPage(1);
  }, [filters, modifiedDate, pageSize]);

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

  const toggleSort = (key: ColumnKey) => {
    setSort((s) => {
      if (s.key !== key) return { key, dir: "asc" };
      if (s.dir === "asc") return { key, dir: "desc" };
      if (s.dir === "desc") return { key: null, dir: "asc" };
      return { key, dir: "asc" };
    });
  };

  const statusOptions = useMemo(
    () => Array.from(new Set(flows.map((f) => f.status).filter(Boolean))).map((s) => ({ value: s, label: s })),
    [flows]
  );

  const filtered = useMemo(() => {
    let rows = flows.filter((f) => {
      if (filters.id && !f.id.toLowerCase().includes(filters.id.toLowerCase())) return false;
      if (filters.name && !f.name.toLowerCase().includes(filters.name.toLowerCase())) return false;
      if (filters.description && !(f.description ?? "").toLowerCase().includes(filters.description.toLowerCase())) return false;
      if (filters.status && f.status !== filters.status) return false;
      if (modifiedDate) {
        const d = new Date(f.updated_at);
        if (
          d.getFullYear() !== modifiedDate.getFullYear() ||
          d.getMonth() !== modifiedDate.getMonth() ||
          d.getDate() !== modifiedDate.getDate()
        )
          return false;
      }
      return true;
    });

    if (sort.key) {
      const key = sort.key;
      rows = [...rows].sort((a, b) => {
        let av: string | number = "";
        let bv: string | number = "";
        if (key === "updated_at") {
          av = new Date(a.updated_at).getTime();
          bv = new Date(b.updated_at).getTime();
        } else {
          av = (a[key] ?? "").toString().toLowerCase();
          bv = (b[key] ?? "").toString().toLowerCase();
        }
        if (av < bv) return sort.dir === "asc" ? -1 : 1;
        if (av > bv) return sort.dir === "asc" ? 1 : -1;
        return 0;
      });
    }

    return rows;
  }, [flows, filters, modifiedDate, sort]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const curPage = Math.min(page, totalPages);
  const paged = filtered.slice((curPage - 1) * pageSize, curPage * pageSize);

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

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[700px] text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
              <tr className="divide-x divide-border">
                {COLUMNS.map((c) => (
                  <th key={c.key} className="px-4 py-3 font-semibold">
                    <SortableColumnHeader
                      label={c.label}
                      active={sort.key === c.key}
                      dir={sort.dir}
                      onClick={() => toggleSort(c.key)}
                    />
                  </th>
                ))}
                <th className="px-4 py-3 text-center font-semibold">Actions</th>
              </tr>
              <tr className="divide-x divide-border border-t border-border">
                <th className="px-4 py-3 font-normal normal-case">
                  <TableTextFilter value={filters.id || ""} onChange={(v) => setFilters((f) => ({ ...f, id: v }))} placeholder="ID" />
                </th>
                <th className="px-4 py-3 font-normal normal-case">
                  <TableTextFilter value={filters.name || ""} onChange={(v) => setFilters((f) => ({ ...f, name: v }))} placeholder="Name" />
                </th>
                <th className="px-4 py-3 font-normal normal-case">
                  <TableTextFilter
                    value={filters.description || ""}
                    onChange={(v) => setFilters((f) => ({ ...f, description: v }))}
                    placeholder="Description"
                  />
                </th>
                <th className="px-4 py-3 font-normal normal-case">
                  <TableSelectFilter
                    value={filters.status || ""}
                    onChange={(v) => setFilters((f) => ({ ...f, status: v }))}
                    options={statusOptions}
                    placeholder="Status"
                  />
                </th>
                <th className="px-4 py-3 font-normal normal-case">
                  <TableDateFilter value={modifiedDate} onChange={setModifiedDate} />
                </th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {paged.map((f) => (
                <tr key={f.id} className="divide-x divide-border hover:bg-muted/40">
                  <td className="whitespace-nowrap px-4 py-3 text-center font-mono text-xs text-muted-foreground">{f.id.slice(0, 8)}</td>
                  <td className="px-4 py-3 text-center font-medium">{f.name}</td>
                  <td className="px-4 py-3 text-center text-muted-foreground">{f.description}</td>
                  <td className="px-4 py-3 text-center"><StatusBadge status={f.status} /></td>
                  <td className="px-4 py-3 text-center text-muted-foreground">{new Date(f.updated_at).toLocaleDateString()}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-center gap-1">
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
              {paged.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-12 text-center text-muted-foreground">No flows found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <TablePagination
          page={curPage}
          pageSize={pageSize}
          totalCount={filtered.length}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
          onRefresh={fetchFlows}
        />
      </div>
    </div>
  );
};

export const AutomationList = () => <Automation />;
