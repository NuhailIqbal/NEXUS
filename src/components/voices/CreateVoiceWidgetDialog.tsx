import { useState, useEffect } from "react";
import { Phone, X, ChevronLeft, ChevronRight, Check, Globe, CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogPortal, DialogOverlay } from "@/components/ui/dialog";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api } from "@/services/api";
import { cn } from "@/lib/utils";

interface CreateVoiceWidgetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate?: (data: WidgetData) => void;
}

interface WidgetData {
  agentId: string;
  agentName: string;
  widgetName: string;
  status: string;
  callType: string;
  maxCalls: number;
  recordCalls: boolean;
  showTranscription: boolean;
  position: string;
}

type Agent = {
  id: string;
  name: string;
  [key: string]: any;
};

const STEPS = ["Select AI Agent", "Configure Your Call Widget", "Test Your Call Widget", "Complete"];

export function CreateVoiceWidgetDialog({ open, onOpenChange, onCreate }: CreateVoiceWidgetDialogProps) {
  const [step, setStep] = useState(0);
  const [search, setSearch] = useState("");
  const [agentId, setAgentId] = useState<string>("");
  const [tab, setTab] = useState<"basic" | "appearance" | "behavior">("basic");

  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);

  const [widgetName, setWidgetName] = useState("");
  const [status, setStatus] = useState("Active");
  const [callType, setCallType] = useState("Voice Only");
  const [maxCalls, setMaxCalls] = useState(50);
  const [recordCalls, setRecordCalls] = useState(true);
  const [showTranscription, setShowTranscription] = useState(true);
  const [position, setPosition] = useState("Bottom Right");
  const [primaryColor, setPrimaryColor] = useState("#10b981");
  const [autoOpen, setAutoOpen] = useState(false);

  useEffect(() => {
    if (open && agents.length === 0) {
      setAgentsLoading(true);
      api.getAgents().then(({ data }) => {
        if (data) setAgents(data);
        setAgentsLoading(false);
      });
    }
  }, [open]);

  const filtered = agents.filter((a) => a.name.toLowerCase().includes(search.toLowerCase()));
  const selectedAgent = agents.find((a) => a.id === agentId);

  const reset = () => {
    setStep(0);
    setSearch("");
    setAgentId("");
    setTab("basic");
    setWidgetName("");
    setStatus("Active");
    setCallType("Voice Only");
    setMaxCalls(50);
    setRecordCalls(true);
    setShowTranscription(true);
    setPosition("Bottom Right");
    setAutoOpen(false);
  };

  const handleClose = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const next = () => {
    if (step === 0 && !agentId) return toast.error("Please select an AI agent");
    if (step === 1 && !widgetName.trim()) return toast.error("Widget name is required");
    setStep((s) => Math.min(3, s + 1));
  };

  const prev = () => setStep((s) => Math.max(0, s - 1));

  const handleCreate = () => {
    if (!selectedAgent) return;
    onCreate?.({
      agentId,
      agentName: selectedAgent.name,
      widgetName,
      status,
      callType,
      maxCalls,
      recordCalls,
      showTranscription,
      position,
    });
    toast.success("Voice widget created successfully");
    handleClose(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          className={cn(
            "fixed left-[50%] top-[50%] z-50 grid w-full max-w-3xl translate-x-[-50%] translate-y-[-50%] gap-0 border border-border bg-background p-0 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 sm:rounded-lg max-h-[90vh] overflow-hidden",
          )}
        >
          <DialogPrimitive.Title className="sr-only">{STEPS[step]}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">Create voice widget wizard</DialogPrimitive.Description>

          <div className="flex items-start justify-between border-b border-border px-6 pt-5 pb-4">
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <Phone className="h-5 w-5" />
                <h2 className="text-lg font-semibold">{STEPS[step]}</h2>
              </div>
              <div className="mt-3 flex gap-1.5">
                {STEPS.map((_, i) => (
                  <div key={i} className={cn("h-1.5 w-12 rounded-full transition-colors", i <= step ? "bg-primary" : "bg-muted")} />
                ))}
              </div>
            </div>
            <button onClick={() => handleClose(false)} className="rounded-sm opacity-70 hover:opacity-100">
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="overflow-y-auto px-6 py-5" style={{ maxHeight: "60vh" }}>
            {step === 0 && (
              <div className="space-y-4">
                <div>
                  <h3 className="text-xl font-bold">Choose an AI Agent</h3>
                  <p className="mt-1 text-sm text-muted-foreground">Select which AI agent will handle the calls from your website visitors.</p>
                </div>
                <Input placeholder="Search agents..." value={search} onChange={(e) => setSearch(e.target.value)} />
                {agentsLoading ? (
                  <div className="flex items-center justify-center py-8 text-muted-foreground">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading agents...
                  </div>
                ) : (
                  <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                    {filtered.map((a) => {
                      const active = a.id === agentId;
                      return (
                        <button
                          key={a.id}
                          onClick={() => setAgentId(a.id)}
                          className={cn(
                            "flex w-full items-center justify-between rounded-lg border p-3 text-left transition-colors",
                            active ? "border-primary bg-primary/5" : "border-border hover:border-primary/40",
                          )}
                        >
                          <div className="flex items-center gap-3">
                            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                              <Phone className="h-5 w-5 text-primary" />
                            </div>
                            <span className="font-medium">{a.name}</span>
                          </div>
                          {active && <CheckCircle2 className="h-5 w-5 text-primary" />}
                        </button>
                      );
                    })}
                    {filtered.length === 0 && !agentsLoading && (
                      <p className="py-4 text-center text-sm text-muted-foreground">No agents found.</p>
                    )}
                  </div>
                )}
              </div>
            )}

            {step === 1 && (
              <div className="space-y-5">
                <div>
                  <h3 className="text-xl font-bold">Configure Your Call Widget</h3>
                  <p className="mt-1 text-sm text-muted-foreground">Customize the appearance and behavior of your call widget.</p>
                </div>

                <div className="grid grid-cols-3 rounded-lg border border-border bg-muted/30 p-1">
                  {(["basic", "appearance", "behavior"] as const).map((t) => (
                    <button key={t} onClick={() => setTab(t)} className={cn("rounded-md py-2 text-sm font-medium transition-colors capitalize", tab === t ? "bg-background shadow-sm" : "text-muted-foreground")}>
                      {t === "basic" ? "Basic Settings" : t}
                    </button>
                  ))}
                </div>

                {tab === "basic" && (
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label>Widget Name <span className="text-destructive">*</span></Label>
                      <Input className="mt-1.5" placeholder="e.g., Main Website Calls" value={widgetName} onChange={(e) => setWidgetName(e.target.value)} />
                    </div>
                    <div>
                      <Label>Status</Label>
                      <select className="mt-1.5 flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={status} onChange={(e) => setStatus(e.target.value)}>
                        <option>Active</option>
                        <option>Inactive</option>
                      </select>
                    </div>
                    <div>
                      <Label>Call Type</Label>
                      <select className="mt-1.5 flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={callType} onChange={(e) => setCallType(e.target.value)}>
                        <option>Voice Only</option>
                        <option>Video</option>
                        <option>Voice + Video</option>
                      </select>
                    </div>
                    <div>
                      <Label>Max Calls</Label>
                      <Input className="mt-1.5" type="number" value={maxCalls} onChange={(e) => setMaxCalls(Number(e.target.value))} />
                    </div>
                    <div className="col-span-2 flex items-center justify-between border-t border-border pt-3">
                      <div>
                        <p className="font-medium text-sm">Record Calls</p>
                        <p className="text-xs text-muted-foreground">Record calls for quality assurance</p>
                      </div>
                      <Switch checked={recordCalls} onCheckedChange={setRecordCalls} />
                    </div>
                    <div className="col-span-2 flex items-center justify-between">
                      <div>
                        <p className="font-medium text-sm">Show Live Transcription</p>
                        <p className="text-xs text-muted-foreground">Display real-time call transcription</p>
                      </div>
                      <Switch checked={showTranscription} onCheckedChange={setShowTranscription} />
                    </div>
                  </div>
                )}

                {tab === "appearance" && (
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label>Position</Label>
                      <select className="mt-1.5 flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={position} onChange={(e) => setPosition(e.target.value)}>
                        <option>Bottom Right</option>
                        <option>Bottom Left</option>
                        <option>Top Right</option>
                        <option>Top Left</option>
                      </select>
                    </div>
                    <div>
                      <Label>Primary Color</Label>
                      <Input className="mt-1.5" type="color" value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)} />
                    </div>
                  </div>
                )}

                {tab === "behavior" && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between border border-border rounded-lg p-3">
                      <div>
                        <p className="font-medium text-sm">Auto Open</p>
                        <p className="text-xs text-muted-foreground">Open the widget automatically on page load</p>
                      </div>
                      <Switch checked={autoOpen} onCheckedChange={setAutoOpen} />
                    </div>
                  </div>
                )}
              </div>
            )}

            {step === 2 && (
              <div className="space-y-5">
                <div>
                  <h3 className="text-xl font-bold">Test Your Call Widget</h3>
                  <p className="mt-1 text-sm text-muted-foreground">Preview how your call widget will look and behave on different devices.</p>
                </div>
                <div>
                  <p className="text-sm font-semibold mb-2">Live Preview</p>
                  <div className="rounded-lg border-2 border-dashed border-border bg-muted/20 p-10">
                    <div className="flex flex-col items-center justify-center min-h-[200px]">
                      <Globe className="h-10 w-10 text-primary/60" />
                      <p className="mt-2 text-sm text-muted-foreground">Your website preview</p>
                    </div>
                    <div className="flex justify-end">
                      <Button className="bg-primary">Show Widget</Button>
                    </div>
                  </div>
                </div>
                <div className="rounded-lg border border-border p-4">
                  <p className="text-sm font-semibold mb-3">Test Configuration</p>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div><span className="text-muted-foreground">Agent:</span> <span className="font-medium">{selectedAgent?.name}</span></div>
                    <div><span className="text-muted-foreground">Call Type:</span> <span className="font-medium">{callType}</span></div>
                    <div><span className="text-muted-foreground">Position:</span> <span className="font-medium">{position}</span></div>
                    <div><span className="text-muted-foreground">Max Calls:</span> <span className="font-medium">{maxCalls}</span></div>
                    <div><span className="text-muted-foreground">Working Hours:</span> <span className="font-medium">Not enabled</span></div>
                  </div>
                </div>
              </div>
            )}

            {step === 3 && (
              <div className="space-y-4 py-6 text-center">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
                  <CheckCircle2 className="h-8 w-8 text-primary" />
                </div>
                <div>
                  <h3 className="text-xl font-bold">Ready to Create</h3>
                  <p className="mt-1 text-sm text-muted-foreground">Review and create your voice widget.</p>
                </div>
                <div className="mx-auto max-w-md rounded-lg border border-border p-4 text-left text-sm space-y-2">
                  <div className="flex justify-between"><span className="text-muted-foreground">Widget Name</span><span className="font-medium">{widgetName}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Agent</span><span className="font-medium">{selectedAgent?.name}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Position</span><span className="font-medium">{position}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Status</span><span className="font-medium">{status}</span></div>
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between border-t border-border px-6 py-4">
            {step === 0 ? (
              <Button variant="outline" onClick={() => handleClose(false)}>Cancel</Button>
            ) : (
              <Button variant="outline" onClick={prev}>
                <ChevronLeft className="mr-1 h-4 w-4" /> Previous
              </Button>
            )}
            {step < 3 ? (
              <Button onClick={next} className="bg-primary">
                Next <ChevronRight className="ml-1 h-4 w-4" />
              </Button>
            ) : (
              <Button onClick={handleCreate} className="bg-primary">
                <Check className="mr-1 h-4 w-4" /> Create Widget
              </Button>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
