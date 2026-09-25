import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useLocation, Link } from "react-router-dom";
import {
  ArrowLeft,
  Save,
  StopCircle,
  History,
  Settings as SettingsIcon,
  FileText,
  Maximize,
  CheckCircle2,
  XCircle,
  Loader2,
  RefreshCw,
  PlayCircle,
} from "lucide-react";
import { toast } from "sonner";
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type ReactFlowInstance,
  MarkerType,
} from "reactflow";
import "reactflow/dist/style.css";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  NODE_TYPES,
  PALETTE_GROUPS,
  paletteFor,
  reactFlowTypeFor,
  type FlowNodeData,
  type FlowNodeKind,
} from "@/components/automation/flow-nodes";
import { NodeEditPanel } from "@/components/automation/NodeEditPanel";
import { newId } from "@/hooks/use-local-collection";
import { api } from "@/services/api";

type ServerVersion = { id: string; version_number: number; created_at: string };

const STORAGE_KEY = (id: string) => `flow:graph:${id}`;
const HISTORY_KEY = (id: string) => `flow:history:${id}`;

type Snapshot = {
  nodes: Node<FlowNodeData>[];
  edges: Edge[];
  savedAt: string;
};

function defaultGraph(): Snapshot {
  return {
    nodes: [
      {
        id: newId(),
        type: "trigger",
        position: { x: 80, y: 160 },
        data: { kind: "event", label: "Update customer" },
      },
    ],
    edges: [],
    savedAt: new Date().toISOString(),
  };
}

function loadGraph(id: string): Snapshot {
  if (typeof window === "undefined") return defaultGraph();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY(id));
    if (raw) return JSON.parse(raw);
  } catch { /* noop */ }
  return defaultGraph();
}

// The backend's automation engine (services/automation_engine.py) only ever fires
// a flow when definition.trigger.event === "call_ended" — it doesn't inspect the
// node graph itself. Derive that top-level field from whichever trigger node the
// user actually placed, so saved flows can be matched by the engine at all.
function deriveTrigger(nodes: Node<FlowNodeData>[]): { event: string } {
  const trigger = nodes.find((n) => n.type === "trigger");
  const kind = trigger?.data.kind;
  if (kind === "inbound-call" || kind === "internet-call") {
    return { event: "call_ended" };
  }
  return { event: "manual" };
}

function saveGraph(id: string, snap: Snapshot) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY(id), JSON.stringify(snap));
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY(id));
    const list: Snapshot[] = raw ? JSON.parse(raw) : [];
    list.unshift(snap);
    window.localStorage.setItem(HISTORY_KEY(id), JSON.stringify(list.slice(0, 10)));
  } catch { /* noop */ }
}

function FlowEditorInner({ v2 = false }: { v2?: boolean }) {
  const navigate = useNavigate();
  const { flowId = "new" } = useParams();
  const location = useLocation();
  const initialName = new URLSearchParams(location.search).get("name") ?? "Untitled Flow";
  const [name, setName] = useState(initialName);
  const [tab, setTab] = useState<"design" | "statistics">("design");

  const initial = useMemo(() => loadGraph(flowId), [flowId]);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNodeData>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const [selected, setSelected] = useState<Node<FlowNodeData> | null>(null);
  const [savingHint, setSavingHint] = useState<string | null>(null);
  const [loadingFlow, setLoadingFlow] = useState(flowId !== "new");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<Snapshot[]>(() => {
    if (typeof window === "undefined") return [];
    try { return JSON.parse(window.localStorage.getItem(HISTORY_KEY(flowId)) ?? "[]"); } catch { return []; }
  });
  const [serverVersions, setServerVersions] = useState<ServerVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);
  const [phoneNumbers, setPhoneNumbers] = useState<{ id: string; number: string }[]>([]);

  useEffect(() => {
    api.getAgents().then(({ data }) => {
      if (Array.isArray(data)) setAgents(data.map((a: any) => ({ id: a.id, name: a.name })));
    });
    // Only platform-purchased numbers can send SMS through the platform's own Twilio
    // account (see automation_engine.py) — a number from the user's own separate
    // Twilio integration must still be typed in by hand.
    api.getPhoneNumbers().then(({ data }) => {
      if (Array.isArray(data)) setPhoneNumbers(data.map((p: any) => ({ id: p.id, number: p.number })));
    });
  }, []);

  const loadServerVersions = useCallback(async () => {
    if (!flowId || flowId === "new") return;
    setVersionsLoading(true);
    const { data } = await api.getFlowVersions(flowId);
    if (Array.isArray(data)) setServerVersions(data);
    setVersionsLoading(false);
  }, [flowId]);

  useEffect(() => {
    if (historyOpen) loadServerVersions();
  }, [historyOpen, loadServerVersions]);

  // Load flow from server (source of truth) localStorage only seeds the first paint.
  useEffect(() => {
    let cancelled = false;
    if (!flowId || flowId === "new") return;
    (async () => {
      const { data, error } = await api.getFlow(flowId);
      if (cancelled) return;
      if (error || !data) {
        setLoadingFlow(false);
        return;
      }
      if (data.name) setName(data.name);
      const def = data.definition;
      if (def && Array.isArray(def.nodes)) {
        setNodes(def.nodes);
        setEdges(Array.isArray(def.edges) ? def.edges : []);
      }
      setLoadingFlow(false);
    })();
    return () => { cancelled = true; };
  }, [flowId, setNodes, setEdges]);

  const restoreServerVersion = async (versionId: string) => {
    const { data: ver } = await api.getFlowVersion(flowId, versionId);
    if (!ver?.definition) {
      toast.error("Could not load that version");
      return;
    }
    const { error } = await api.restoreFlowVersion(flowId, versionId);
    if (error) {
      toast.error(error);
      return;
    }
    setNodes(ver.definition.nodes || []);
    setEdges(ver.definition.edges || []);
    setHistoryOpen(false);
    toast.success(`Restored version ${ver.version_number}`);
    loadServerVersions();
  };

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const rfRef = useRef<ReactFlowInstance | null>(null);
  const { screenToFlowPosition } = useReactFlow();

  const base = v2 ? "/dashboard/automation-v2" : "/dashboard/automation";

  const onConnect = useCallback(
    (c: Connection) =>
      setEdges((eds) =>
        addEdge(
          {
            ...c,
            type: "smoothstep",
            animated: true,
            style: { stroke: c.sourceHandle === "no" ? "#ADADAD" : "#22A655", strokeWidth: 2 },
            markerEnd: { type: MarkerType.ArrowClosed, color: c.sourceHandle === "no" ? "#ADADAD" : "#22A655" },
          },
          eds,
        ),
      ),
    [setEdges],
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const kind = event.dataTransfer.getData("application/reactflow") as FlowNodeKind;
      const label = event.dataTransfer.getData("application/reactflow-label") || "Untitled";
      if (!kind) return;
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const newNode: Node<FlowNodeData> = {
        id: newId(),
        type: reactFlowTypeFor(kind),
        position,
        data: { kind, label },
      };
      setNodes((nds) => nds.concat(newNode));
    },
    [screenToFlowPosition, setNodes],
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const onNodeDoubleClick: NodeMouseHandler = useCallback((_, node) => {
    setSelected(node as Node<FlowNodeData>);
  }, []);

  const updateNodeData = (id: string, data: FlowNodeData) => {
    setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data } : n)));
    setSelected(null);
    toast.success("Node updated");
  };

  const deleteNode = (id: string) => {
    setNodes((nds) => nds.filter((n) => n.id !== id));
    setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
    setSelected(null);
    toast.success("Node deleted");
  };

  const handleSave = useCallback(
    async (silent = false) => {
      const snap: Snapshot = { nodes, edges, savedAt: new Date().toISOString() };
      saveGraph(flowId, snap);
      setHistory((h) => [snap, ...h].slice(0, 10));

      if (flowId && flowId !== "new") {
        const { error } = await api.updateFlow(flowId, {
          name,
          definition: { nodes, edges, trigger: deriveTrigger(nodes) },
        });
        if (error && !silent) {
          toast.error(`Saved locally but server update failed: ${error}`);
        } else if (!silent) {
          toast.success("Flow saved");
        } else {
          setSavingHint("Saved");
          setTimeout(() => setSavingHint(null), 1500);
        }
      } else {
        if (!silent) toast.success("Flow saved locally");
        else {
          setSavingHint("Saved");
          setTimeout(() => setSavingHint(null), 1500);
        }
      }
    },
    [flowId, name, nodes, edges],
  );

  // Auto-save every 30s (skip while initial server fetch is in flight)
  useEffect(() => {
    if (loadingFlow) return;
    const t = window.setInterval(() => {
      setSavingHint("Saving…");
      handleSave(true);
    }, 30000);
    return () => window.clearInterval(t);
  }, [handleSave, loadingFlow]);

  return (
    <div className="-mx-4 -my-6 flex h-[calc(100vh-4rem)] flex-col bg-background sm:-mx-6 lg:-mx-8">
      {/* Top bar */}
      <div className="flex items-center justify-between gap-3 border-b border-border bg-card px-5 py-3">
        <div className="flex items-center gap-3">
          <Link
            to={base}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
            aria-label="Back"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-9 w-72 font-medium"
          />
          <button className="hidden md:inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-muted">
            <FileText className="h-4 w-4" /> Description
          </button>
          <button className="hidden md:inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-muted">
            <SettingsIcon className="h-4 w-4" /> Settings
          </button>
          {loadingFlow && <span className="text-xs text-muted-foreground">Loading…</span>}
          {!loadingFlow && savingHint && <span className="text-xs text-muted-foreground">{savingHint}</span>}
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <button
              onClick={() => setHistoryOpen((v) => !v)}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
              aria-label="History"
            >
              <History className="h-4 w-4" />
            </button>
            {historyOpen && (
              <div className="absolute right-0 top-full z-30 mt-2 w-72 rounded-lg border border-border bg-card p-2 shadow-lg">
                <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Saved Versions {versionsLoading && <span className="ml-1 normal-case font-normal">  loading…</span>}
                </div>
                {serverVersions.length === 0 && !versionsLoading ? (
                  <div className="p-3 text-center text-xs text-muted-foreground">
                    No saved versions yet. Save the flow to create one.
                  </div>
                ) : (
                  serverVersions.map((v) => (
                    <button
                      key={v.id}
                      onClick={() => restoreServerVersion(v.id)}
                      className="block w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
                    >
                      <span className="font-semibold">v{v.version_number}</span>{" "}
                      <span className="text-muted-foreground">· {new Date(v.created_at).toLocaleString()}</span>
                    </button>
                  ))
                )}
                {history.length > 0 && (
                  <>
                    <div className="mt-2 border-t border-border pt-2 px-2 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Local Snapshots
                    </div>
                    {history.slice(0, 5).map((h) => (
                      <button
                        key={h.savedAt}
                        onClick={() => {
                          setNodes(h.nodes);
                          setEdges(h.edges);
                          setHistoryOpen(false);
                          toast.success("Restored local snapshot");
                        }}
                        className="block w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
                      >
                        {new Date(h.savedAt).toLocaleString()} · {h.nodes.length} nodes
                      </button>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
          <Button
            onClick={() => handleSave(false)}
            disabled={loadingFlow}
            className="bg-primary text-primary-foreground hover:opacity-90"
          >
            <Save className="mr-1.5 h-4 w-4" /> Save
          </Button>
          <Button
            variant="destructive"
            onClick={() => navigate(base)}
          >
            <StopCircle className="mr-1.5 h-4 w-4" /> Stop
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-6 border-b border-border bg-card px-5">
        {([["design", "Design"], ["statistics", "Runs"]] as const).map(([t, label]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`relative py-3 text-sm font-medium ${
              tab === t ? "text-foreground" : "text-muted-foreground"
            }`}
          >
            {label}
            {tab === t && <span className="absolute inset-x-0 -bottom-px h-0.5 bg-primary" />}
          </button>
        ))}
      </div>

      {/* Body */}
      {tab === "design" ? (
        <div className="relative flex flex-1 overflow-hidden">
          <div ref={wrapperRef} className="flex-1" onDrop={onDrop} onDragOver={onDragOver}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeDoubleClick={onNodeDoubleClick}
              onInit={(inst) => (rfRef.current = inst)}
              nodeTypes={NODE_TYPES}
              snapToGrid
              snapGrid={[20, 20]}
              fitView
              proOptions={{ hideAttribution: true }}
              defaultEdgeOptions={{
                type: "smoothstep",
                animated: true,
                style: { stroke: "#22A655", strokeWidth: 2 },
                markerEnd: { type: MarkerType.ArrowClosed, color: "#22A655" },
              }}
              deleteKeyCode={["Backspace", "Delete"]}
            >
              <Background variant={BackgroundVariant.Dots} gap={20} size={1.5} color="hsl(var(--border))" />
              <Controls
                className="!rounded-md !border !border-border !bg-card !shadow-sm [&_button]:!bg-card [&_button]:!border-border [&_button]:!text-foreground"
                showInteractive={false}
                position="bottom-left"
              />
              <MiniMap
                className="!rounded-md !border !border-border !bg-card"
                nodeColor={() => "hsl(var(--primary))"}
                maskColor="hsl(var(--background) / 0.8)"
                pannable
                zoomable
              />
            </ReactFlow>
          </div>

          <Palette />

          <NodeEditPanel
            node={selected}
            agents={agents}
            phoneNumbers={phoneNumbers}
            onClose={() => setSelected(null)}
            onSave={updateNodeData}
            onDelete={deleteNode}
          />
        </div>
      ) : (
        <RunsTab flowId={flowId} />
      )}
    </div>
  );
}

function Palette() {
  const onDragStart = (event: React.DragEvent, kind: FlowNodeKind, label: string) => {
    event.dataTransfer.setData("application/reactflow", kind);
    event.dataTransfer.setData("application/reactflow-label", label);
    event.dataTransfer.effectAllowed = "move";
  };

  return (
    <aside className="w-[220px] shrink-0 overflow-y-auto border-l border-border bg-card p-4">
      {PALETTE_GROUPS.map((group) => (
        <div key={group.title} className="mb-5">
          <h3 className="mb-2 text-sm font-semibold text-foreground">{group.title}</h3>
          <div className="space-y-1.5">
            {group.items.map(({ kind, label }) => {
              const p = paletteFor(kind);
              const Icon = p.icon;
              return (
                <div
                  key={kind}
                  draggable
                  onDragStart={(e) => onDragStart(e, kind, label)}
                  className="flex cursor-grab items-center gap-2.5 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium transition hover:bg-primary/5 hover:border-primary/40 active:cursor-grabbing"
                >
                  <div className={`flex h-6 w-6 items-center justify-center rounded ${p.iconBg}`}>
                    <Icon className={`h-3.5 w-3.5 ${p.iconColor}`} />
                  </div>
                  <span>{label}</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      <div className="mt-3 rounded-md border border-dashed border-border bg-muted/30 p-2.5 text-[11px] leading-snug text-muted-foreground">
        <div className="mb-1 flex items-center gap-1 font-semibold text-foreground">
          <Maximize className="h-3 w-3" /> Tips
        </div>
        Drag a block onto the canvas. Connect output dots to inputs. Double-click a node to edit.
      </div>
    </aside>
  );
}

type FlowRun = {
  id: string;
  status: "queued" | "running" | "success" | "failed";
  trigger_event?: string;
  created_at: string;
  completed_at?: string | null;
  input_data?: { phone?: string; contact_name?: string; conversation_id?: string } | null;
  output_data?: { error?: string; nodes_executed?: number } | null;
};

function runDurationLabel(run: FlowRun): string {
  if (!run.completed_at) return "—";
  const ms = new Date(run.completed_at).getTime() - new Date(run.created_at).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function RunStatusBadge({ status }: { status: FlowRun["status"] }) {
  if (status === "success") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success">
        <CheckCircle2 className="h-3 w-3" /> Success
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive">
        <XCircle className="h-3 w-3" /> Failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">
      <Loader2 className="h-3 w-3 animate-spin" /> {status === "running" ? "Running" : "Queued"}
    </span>
  );
}

function RunsTab({ flowId }: { flowId: string }) {
  const [runs, setRuns] = useState<FlowRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  const fetchRuns = useCallback(async () => {
    if (!flowId || flowId === "new") { setLoading(false); return; }
    const { data } = await api.getRuns(`flow_id=${flowId}&limit=100`);
    if (Array.isArray(data)) setRuns(data as FlowRun[]);
    setLoading(false);
  }, [flowId]);

  useEffect(() => {
    setLoading(true);
    fetchRuns();
    // Runs land asynchronously (a call has to actually finish) — poll while this
    // tab is open so a fresh run shows up without the user manually refreshing.
    const t = setInterval(fetchRuns, 15000);
    return () => clearInterval(t);
  }, [fetchRuns]);

  const total = runs.length;
  const success = runs.filter((r) => r.status === "success").length;
  const failed = runs.filter((r) => r.status === "failed").length;
  const successRate = total > 0 ? `${Math.round((success / total) * 100)}%` : "—";

  const stats = [
    { label: "Total runs", value: total },
    { label: "Success rate", value: successRate },
    { label: "Failed runs", value: failed },
    { label: "In progress", value: runs.filter((r) => r.status === "running" || r.status === "queued").length },
  ];

  if (!flowId || flowId === "new") {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <div className="rounded-xl border border-dashed border-border bg-card p-10 text-center text-sm text-muted-foreground">
          Save this flow first — runs only start showing up here once it's a real, saved flow that can actually trigger.
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-xl border border-border bg-card p-4">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">{s.label}</div>
            <div className="mt-2 text-2xl font-bold">{s.value}</div>
          </div>
        ))}
      </div>

      <div className="mt-6 rounded-xl border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border p-4">
          <div className="flex items-center gap-2">
            <PlayCircle className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">Run history</h3>
          </div>
          <button
            type="button"
            onClick={() => { setLoading(true); fetchRuns(); }}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Refresh"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>

        {loading ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" /> Loading…
          </div>
        ) : runs.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            No runs yet. This flow's trigger has never fired — place or receive a real call
            that matches its trigger to see a run appear here.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Contact / Phone</th>
                <th className="px-4 py-2.5">Started</th>
                <th className="px-4 py-2.5">Duration</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <Fragment key={r.id}>
                  <tr
                    className="cursor-pointer border-t border-border hover:bg-muted/20"
                    onClick={() => setExpanded((id) => (id === r.id ? null : r.id))}
                  >
                    <td className="px-4 py-2.5"><RunStatusBadge status={r.status} /></td>
                    <td className="px-4 py-2.5 text-foreground">
                      {r.input_data?.contact_name || r.input_data?.phone || "—"}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground whitespace-nowrap">
                      {new Date(r.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">{runDurationLabel(r)}</td>
                    <td className="px-4 py-2.5 text-right text-muted-foreground">
                      {expanded === r.id ? "Hide" : "Details"}
                    </td>
                  </tr>
                  {expanded === r.id && (
                    <tr className="border-t border-border bg-muted/10">
                      <td colSpan={5} className="px-4 py-3">
                        {r.status === "failed" && r.output_data?.error ? (
                          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                            {r.output_data.error}
                          </div>
                        ) : r.status === "success" ? (
                          <div className="text-xs text-muted-foreground">
                            Ran {r.output_data?.nodes_executed ?? "—"} node(s) successfully.
                          </div>
                        ) : (
                          <div className="text-xs text-muted-foreground">Still in progress…</div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const FlowEditor = ({ v2 = false }: { v2?: boolean }) => (
  <ReactFlowProvider>
    <FlowEditorInner v2={v2} />
  </ReactFlowProvider>
);

export const AutomationFlowEditor = () => <FlowEditor />;
