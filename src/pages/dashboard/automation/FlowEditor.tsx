import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useLocation, Link } from "react-router-dom";
import {
  ArrowLeft,
  Save,
  StopCircle,
  History,
  Settings as SettingsIcon,
  FileText,
  Maximize,
  TrendingUp,
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
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<Snapshot[]>(() => {
    if (typeof window === "undefined") return [];
    try { return JSON.parse(window.localStorage.getItem(HISTORY_KEY(flowId)) ?? "[]"); } catch { return []; }
  });

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
            style: { stroke: c.sourceHandle === "no" ? "#94a3b8" : "#10b981", strokeWidth: 2 },
            markerEnd: { type: MarkerType.ArrowClosed, color: c.sourceHandle === "no" ? "#94a3b8" : "#10b981" },
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
    (silent = false) => {
      const snap: Snapshot = { nodes, edges, savedAt: new Date().toISOString() };
      saveGraph(flowId, snap);
      setHistory((h) => [snap, ...h].slice(0, 10));
      if (!silent) toast.success("Flow saved");
      else {
        setSavingHint("Saved");
        setTimeout(() => setSavingHint(null), 1500);
      }
    },
    [flowId, nodes, edges],
  );

  // Auto-save every 30s
  useEffect(() => {
    const t = window.setInterval(() => {
      setSavingHint("Saving…");
      handleSave(true);
    }, 30000);
    return () => window.clearInterval(t);
  }, [handleSave]);

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
          {savingHint && <span className="text-xs text-muted-foreground">{savingHint}</span>}
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
              <div className="absolute right-0 top-full z-30 mt-2 w-64 rounded-lg border border-border bg-card p-2 shadow-lg">
                <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Last saves
                </div>
                {history.length === 0 ? (
                  <div className="p-3 text-center text-xs text-muted-foreground">No history yet</div>
                ) : (
                  history.map((h) => (
                    <button
                      key={h.savedAt}
                      onClick={() => {
                        setNodes(h.nodes);
                        setEdges(h.edges);
                        setHistoryOpen(false);
                        toast.success("Restored snapshot");
                      }}
                      className="block w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
                    >
                      {new Date(h.savedAt).toLocaleString()} · {h.nodes.length} nodes
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
          <Button onClick={() => handleSave(false)} className="bg-primary text-primary-foreground hover:opacity-90">
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
        {(["design", "statistics"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`relative py-3 text-sm font-medium capitalize ${
              tab === t ? "text-foreground" : "text-muted-foreground"
            }`}
          >
            {t}
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
                style: { stroke: "#10b981", strokeWidth: 2 },
                markerEnd: { type: MarkerType.ArrowClosed, color: "#10b981" },
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
            onClose={() => setSelected(null)}
            onSave={updateNodeData}
            onDelete={deleteNode}
          />
        </div>
      ) : (
        <StatisticsTab nodeCount={nodes.length} edgeCount={edges.length} />
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

function StatisticsTab({ nodeCount, edgeCount }: { nodeCount: number; edgeCount: number }) {
  const stats = [
    { label: "Total runs", value: 1284 },
    { label: "Success rate", value: "97.4%" },
    { label: "Failed runs", value: 33 },
    { label: "Avg. completion", value: "2m 14s" },
  ];
  const points = Array.from({ length: 30 }).map((_, i) => 30 + Math.round(Math.sin(i / 3) * 15 + Math.random() * 10));
  const max = Math.max(...points);
  const path = points
    .map((v, i) => `${i === 0 ? "M" : "L"} ${(i / (points.length - 1)) * 100} ${100 - (v / max) * 100}`)
    .join(" ");

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

      <div className="mt-6 rounded-xl border border-border bg-card p-5">
        <div className="mb-3 flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">Runs · last 30 days</h3>
        </div>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-48 w-full">
          <path d={path} fill="none" stroke="currentColor" strokeWidth="1.2" className="text-primary" vectorEffect="non-scaling-stroke" />
          <path d={`${path} L 100 100 L 0 100 Z`} fill="currentColor" className="text-primary/10" />
        </svg>
      </div>

      <div className="mt-6 rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
        Flow has <span className="font-semibold text-foreground">{nodeCount}</span> nodes and{" "}
        <span className="font-semibold text-foreground">{edgeCount}</span> connections.
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
export const AutomationV2FlowEditor = () => <FlowEditor v2 />;
