import { useEffect, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Eye,
  FileText,
  Globe,
  Lightbulb,
  Pencil,
  Plus,
  Settings2,
  Sliders,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export type ToolParameter = {
  id: string;
  name: string;
  type: "string" | "number" | "boolean" | "array" | "object";
  description: string;
  defaultValue: string;
  required: boolean;
  enumValues: string[];
  expanded: boolean;
};

export type ToolHeader = { id: string; key: string; value: string };
export type ToolBodyProperty = { id: string; key: string; value: string };

export type ToolWizardData = {
  name: string;
  description: string;
  active: boolean;
  parameters: ToolParameter[];
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  apiUrl: string;
  contentType: string;
  headers: ToolHeader[];
  bodyProperties: ToolBodyProperty[];
};

const emptyData: ToolWizardData = {
  name: "",
  description: "",
  active: true,
  parameters: [],
  method: "POST",
  apiUrl: "",
  contentType: "application/json",
  headers: [],
  bodyProperties: [],
};

const STEPS = [
  { id: 1, label: "General Info", icon: FileText },
  { id: 2, label: "Parameters", icon: Sliders },
  { id: 3, label: "Platform Settings", icon: Globe },
  { id: 4, label: "Review & Save", icon: Eye },
];

const NAME_PATTERN = /^[a-z_]+$/;
const PARAM_NAME_PATTERN = /^[a-z0-9_-]+$/;

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialData?: Partial<ToolWizardData>;
  onSave: (data: ToolWizardData) => void;
  mode: "create" | "edit";
}

export function CreateToolWizard({ open, onOpenChange, initialData, onSave, mode }: Props) {
  const [step, setStep] = useState(1);
  const [data, setData] = useState<ToolWizardData>(emptyData);

  useEffect(() => {
    if (open) {
      setStep(1);
      setData({ ...emptyData, ...initialData });
    }
  }, [open, initialData]);

  const validateStep = (s: number): string | null => {
    if (s === 1) {
      if (!data.name.trim()) return "Tool name is required";
      if (!NAME_PATTERN.test(data.name))
        return "Only lowercase letters (a-z) and underscore (_) allowed";
      if (!data.description.trim()) return "Description is required";
    }
    if (s === 2) {
      if (data.parameters.length === 0)
        return "Add at least one parameter (or use Build with AI)";
      for (const p of data.parameters) {
        if (!p.name.trim()) return "Every parameter needs a name";
        if (!PARAM_NAME_PATTERN.test(p.name))
          return `Parameter "${p.name || "unnamed"}" — only a-z, 0-9, _, - allowed`;
        if (!p.description.trim())
          return `Parameter "${p.name}" needs a description`;
      }
    }
    if (s === 3) {
      if (!data.apiUrl.trim()) return "API URL is required";
      try {
        new URL(data.apiUrl);
      } catch {
        return "API URL must be a valid URL (https://...)";
      }
    }
    return null;
  };

  const goNext = () => {
    const err = validateStep(step);
    if (err) {
      toast.error(err);
      return;
    }
    setStep((s) => Math.min(4, s + 1));
  };

  const handleSave = () => {
    for (let s = 1; s <= 3; s++) {
      const err = validateStep(s);
      if (err) {
        setStep(s);
        toast.error(err);
        return;
      }
    }
    onSave(data);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-3xl gap-0 p-0 overflow-hidden max-h-[90vh] flex flex-col"
        onInteractOutside={(e) => e.preventDefault()}
      >
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Settings2 className="h-5 w-5" />
            </div>
            <h2 className="text-xl font-semibold">
              {mode === "edit" ? "Edit Tool" : "Create New Tool"}
            </h2>
          </div>
          <button
            onClick={() => onOpenChange(false)}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <Stepper currentStep={step} />

        <div className="flex-1 overflow-y-auto bg-background px-6 py-6">
          {step === 1 && <StepGeneral data={data} setData={setData} />}
          {step === 2 && <StepParameters data={data} setData={setData} />}
          {step === 3 && <StepPlatform data={data} setData={setData} />}
          {step === 4 && <StepReview data={data} />}
        </div>

        <div className="flex items-center justify-between border-t border-border bg-background px-6 py-4">
          <div>
            {step > 1 && (
              <Button variant="outline" onClick={() => setStep((s) => s - 1)}>
                <ChevronLeft className="mr-1 h-4 w-4" /> Back
              </Button>
            )}
          </div>
          <div>
            {step < 4 ? (
              <Button onClick={goNext} className="bg-primary text-primary-foreground hover:opacity-90">
                Next <ChevronRight className="ml-1 h-4 w-4" />
              </Button>
            ) : (
              <Button onClick={handleSave} className="bg-primary text-primary-foreground hover:opacity-90">
                <Check className="mr-1 h-4 w-4" />
                {mode === "edit" ? "Save Changes" : "Create Tool"}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Stepper({ currentStep }: { currentStep: number }) {
  return (
    <div className="bg-muted/40 px-6 py-5">
      <div className="flex items-center justify-between">
        {STEPS.map((s, i) => {
          const isDone = currentStep > s.id;
          const isActive = currentStep === s.id;
          const Icon = s.icon;
          return (
            <div key={s.id} className="flex flex-1 items-center">
              <div className="flex flex-col items-center">
                <div
                  className={cn(
                    "flex h-10 w-10 items-center justify-center rounded-full transition-colors",
                    isDone && "bg-primary text-primary-foreground",
                    isActive && "bg-primary text-primary-foreground ring-4 ring-primary/20",
                    !isDone && !isActive && "bg-muted text-muted-foreground",
                  )}
                >
                  {isDone ? <Check className="h-5 w-5" /> : <Icon className="h-5 w-5" />}
                </div>
                <span
                  className={cn(
                    "mt-2 text-xs font-medium",
                    (isActive || isDone) ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {s.label}
                </span>
              </div>
              {i < STEPS.length - 1 && (
                <div
                  className={cn(
                    "mx-2 mb-6 h-0.5 flex-1 transition-colors",
                    currentStep > s.id ? "bg-primary" : "bg-border",
                  )}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function InfoBox({ title, children }: { title: string; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-border bg-muted/30">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-3"
      >
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10">
            <Lightbulb className="h-4 w-4 text-primary" />
          </div>
          <span className="font-medium">{title}</span>
        </div>
        <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
      </button>
      {open && children && (
        <div className="border-t border-border px-4 py-3 text-sm text-muted-foreground">{children}</div>
      )}
    </div>
  );
}

function SectionHeader({
  icon: Icon,
  title,
  description,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
        <Icon className="h-4 w-4" />
      </div>
      <div>
        <h3 className="font-semibold">{title}</h3>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
    </div>
  );
}

function StepGeneral({
  data,
  setData,
}: {
  data: ToolWizardData;
  setData: React.Dispatch<React.SetStateAction<ToolWizardData>>;
}) {
  return (
    <div className="space-y-6">
      <InfoBox title="What is a Tool?">
        A Tool is a custom action your AI agent can call during a conversation —
        for example, looking up a customer record or triggering a webhook.
      </InfoBox>

      <SectionHeader icon={Pencil} title="Basic Information" description="Give your tool a clear name and describe what it does." />

      <div className="space-y-2">
        <Label htmlFor="tool-name">
          Tool Name <span className="text-destructive">*</span>
        </Label>
        <Input
          id="tool-name"
          placeholder="e.g., check_payment_status"
          value={data.name}
          onChange={(e) => setData((d) => ({ ...d, name: e.target.value.toLowerCase() }))}
        />
        <p className="text-xs text-muted-foreground">
          💡 Only lowercase letters (a-z) and underscore (_) allowed in function name
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="tool-desc">
          Description <span className="text-destructive">*</span>
        </Label>
        <Textarea
          id="tool-desc"
          rows={4}
          placeholder="Example: Checks if a customer has completed their payment."
          value={data.description}
          onChange={(e) => setData((d) => ({ ...d, description: e.target.value }))}
        />
        <p className="text-xs text-muted-foreground">
          💡 Write it like you're explaining to a new employee.
        </p>
      </div>

      <div
        className={cn(
          "flex items-center justify-between rounded-lg border border-border px-4 py-3",
          data.active ? "border-primary/30 bg-primary/5" : "bg-muted/30",
        )}
      >
        <div className="flex items-center gap-2">
          <span className={cn("h-2 w-2 rounded-full", data.active ? "bg-primary" : "bg-muted-foreground")} />
          <span className="font-medium">Tool Active</span>
        </div>
        <Switch checked={data.active} onCheckedChange={(v) => setData((d) => ({ ...d, active: v }))} />
      </div>
    </div>
  );
}

function StepParameters({
  data,
  setData,
}: {
  data: ToolWizardData;
  setData: React.Dispatch<React.SetStateAction<ToolWizardData>>;
}) {
  const addParam = () => {
    setData((d) => ({
      ...d,
      parameters: [
        ...d.parameters,
        { id: uid(), name: "", type: "string", description: "", defaultValue: "", required: false, enumValues: [], expanded: true },
      ],
    }));
  };

  const buildWithAI = () => {
    setData((d) => ({
      ...d,
      parameters: [
        ...d.parameters,
        { id: uid(), name: "customer_id", type: "string", description: "The unique ID of the customer to look up", defaultValue: "", required: true, enumValues: [], expanded: true },
        { id: uid(), name: "order_id", type: "string", description: "Optional order reference", defaultValue: "", required: false, enumValues: [], expanded: false },
      ],
    }));
    toast.success("AI suggested 2 parameters");
  };

  const updateParam = (id: string, patch: Partial<ToolParameter>) => {
    setData((d) => ({ ...d, parameters: d.parameters.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
  };

  const removeParam = (id: string) => {
    setData((d) => ({ ...d, parameters: d.parameters.filter((p) => p.id !== id) }));
  };

  return (
    <div className="space-y-6">
      <InfoBox title="How It Works">
        Parameters define the data your AI agent will collect from the customer and pass to your API.
      </InfoBox>

      <SectionHeader icon={Sliders} title="Parameters to Collect" description="Define what information the AI agent needs to gather from the client." />

      <div className="grid grid-cols-2 gap-3">
        <Button type="button" onClick={buildWithAI} className="bg-primary text-primary-foreground hover:opacity-90">
          <Sparkles className="mr-2 h-4 w-4" /> Build with AI
        </Button>
        <Button type="button" variant="outline" onClick={addParam}>
          <Plus className="mr-2 h-4 w-4" /> Add Parameter
        </Button>
      </div>

      {data.parameters.length === 0 && (
        <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          No parameters yet. Add one manually or let AI suggest them.
        </div>
      )}

      <div className="space-y-3">
        {data.parameters.map((p) => (
          <ParamCard key={p.id} param={p} onChange={(patch) => updateParam(p.id, patch)} onRemove={() => removeParam(p.id)} />
        ))}
      </div>
    </div>
  );
}

function ParamCard({
  param,
  onChange,
  onRemove,
}: {
  param: ToolParameter;
  onChange: (patch: Partial<ToolParameter>) => void;
  onRemove: () => void;
}) {
  const [enumInput, setEnumInput] = useState("");

  const addEnum = () => {
    const v = enumInput.trim();
    if (!v) return;
    onChange({ enumValues: [...param.enumValues, v] });
    setEnumInput("");
  };

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between px-4 py-3">
        <button
          type="button"
          onClick={() => onChange({ expanded: !param.expanded })}
          className="flex flex-1 items-center gap-2 text-left"
        >
          <ChevronDown className={cn("h-4 w-4 transition-transform", !param.expanded && "-rotate-90")} />
          <span className="font-medium">{param.name || "Unnamed Parameter"}</span>
        </button>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">{param.type}</Badge>
          <button type="button" onClick={onRemove} className="rounded-md p-1.5 text-destructive hover:bg-destructive/10">
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {param.expanded && (
        <div className="space-y-4 border-t border-border px-4 py-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Parameter Name</Label>
              <Input
                placeholder="e.g., customer_id"
                value={param.name}
                onChange={(e) => onChange({ name: e.target.value.toLowerCase() })}
              />
              <p className="text-xs text-muted-foreground">Only a-z, 0-9, underscore, dash allowed</p>
            </div>
            <div className="space-y-2">
              <Label>Type</Label>
              <Select value={param.type} onValueChange={(v) => onChange({ type: v as ToolParameter["type"] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="string">String</SelectItem>
                  <SelectItem value="number">Number</SelectItem>
                  <SelectItem value="boolean">Boolean</SelectItem>
                  <SelectItem value="array">Array</SelectItem>
                  <SelectItem value="object">Object</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Description</Label>
            <Input
              placeholder="e.g., The unique ID of the customer to look up"
              value={param.description}
              onChange={(e) => onChange({ description: e.target.value })}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Default Value</Label>
              <Input placeholder="Value if not provided" value={param.defaultValue} onChange={(e) => onChange({ defaultValue: e.target.value })} />
            </div>
            <div className="flex items-end pb-2">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={param.required} onCheckedChange={(v) => onChange({ required: Boolean(v) })} />
                Required — tool won't work without this
              </label>
            </div>
          </div>

          <div className="space-y-2 border-t border-border pt-4">
            <Label>Enum Values (Optional)</Label>
            <p className="text-xs text-muted-foreground">Restrict this parameter to specific allowed values</p>
            <div className="flex gap-2">
              <Input
                placeholder="Add allowed value..."
                value={enumInput}
                onChange={(e) => setEnumInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addEnum();
                  }
                }}
              />
              <Button type="button" variant="outline" onClick={addEnum}>Add</Button>
            </div>
            {param.enumValues.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {param.enumValues.map((v, idx) => (
                  <Badge key={idx} variant="secondary" className="gap-1">
                    {v}
                    <button type="button" onClick={() => onChange({ enumValues: param.enumValues.filter((_, i) => i !== idx) })}>
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StepPlatform({
  data,
  setData,
}: {
  data: ToolWizardData;
  setData: React.Dispatch<React.SetStateAction<ToolWizardData>>;
}) {
  const addHeader = () => setData((d) => ({ ...d, headers: [...d.headers, { id: uid(), key: "", value: "" }] }));
  const addProperty = () => setData((d) => ({ ...d, bodyProperties: [...d.bodyProperties, { id: uid(), key: "", value: "" }] }));

  return (
    <div className="space-y-6">
      <InfoBox title="Configure API Connection">
        Define how the tool reaches your backend — endpoint, headers, and request body.
      </InfoBox>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-4 rounded-lg border border-border bg-card p-4">
          <SectionHeader icon={Globe} title="Request Configuration" description="Where should we send the request?" />
          <div className="grid grid-cols-[100px_1fr] gap-2">
            <div className="space-y-2">
              <Label>Method</Label>
              <Select value={data.method} onValueChange={(v) => setData((d) => ({ ...d, method: v as ToolWizardData["method"] }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(["GET", "POST", "PUT", "PATCH", "DELETE"] as const).map((m) => (
                    <SelectItem key={m} value={m}>{m}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>API URL <span className="text-destructive">*</span></Label>
              <Input placeholder="https://api.example.com/check-payment" value={data.apiUrl} onChange={(e) => setData((d) => ({ ...d, apiUrl: e.target.value }))} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">💡 Example: https://api.stripe.com/v1/charges</p>
          <div className="space-y-2">
            <Label>Content Type</Label>
            <Select value={data.contentType} onValueChange={(v) => setData((d) => ({ ...d, contentType: v }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="application/json">application/json</SelectItem>
                <SelectItem value="application/x-www-form-urlencoded">application/x-www-form-urlencoded</SelectItem>
                <SelectItem value="multipart/form-data">multipart/form-data</SelectItem>
                <SelectItem value="text/plain">text/plain</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-4 rounded-lg border border-border bg-card p-4">
          <div className="flex items-start justify-between">
            <SectionHeader icon={Sliders} title="HTTP Headers" description="Add authentication tokens or custom headers" />
            <Button type="button" size="sm" variant="outline" onClick={addHeader}>
              <Plus className="mr-1 h-3 w-3" /> Add Header
            </Button>
          </div>
          {data.headers.length === 0 ? (
            <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              <Sliders className="mx-auto mb-2 h-5 w-5" />
              <p className="font-medium text-foreground">No headers added yet</p>
              <p className="text-xs">Common headers: Authorization, API-Key, X-Custom-Token</p>
            </div>
          ) : (
            <div className="space-y-2">
              {data.headers.map((h) => (
                <div key={h.id} className="flex gap-2">
                  <Input placeholder="Header name" value={h.key} onChange={(e) => setData((d) => ({ ...d, headers: d.headers.map((x) => x.id === h.id ? { ...x, key: e.target.value } : x) }))} />
                  <Input placeholder="Value" value={h.value} onChange={(e) => setData((d) => ({ ...d, headers: d.headers.map((x) => x.id === h.id ? { ...x, value: e.target.value } : x) }))} />
                  <button type="button" onClick={() => setData((d) => ({ ...d, headers: d.headers.filter((x) => x.id !== h.id) }))} className="rounded-md p-2 text-destructive hover:bg-destructive/10">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="space-y-4 rounded-lg border border-border bg-card p-4">
        <SectionHeader icon={FileText} title="Request Body" description="Define what data to send with the request." />
        <div className="rounded-md border border-border bg-muted/30">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-sm font-medium">{"{ } Request Body"}</span>
            <Button type="button" size="sm" variant="outline" onClick={addProperty}>
              <Plus className="mr-1 h-3 w-3" /> Add Property
            </Button>
          </div>
          {data.bodyProperties.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              <div className="mx-auto mb-2 text-2xl">{"{ }"}</div>
              <p className="font-medium text-foreground">No properties added yet</p>
              <p className="text-xs">Add properties to define the data sent to your API.</p>
            </div>
          ) : (
            <div className="space-y-2 p-3">
              {data.bodyProperties.map((b) => (
                <div key={b.id} className="flex gap-2">
                  <Input placeholder="Property name" value={b.key} onChange={(e) => setData((d) => ({ ...d, bodyProperties: d.bodyProperties.map((x) => x.id === b.id ? { ...x, key: e.target.value } : x) }))} />
                  <Input placeholder="Value or {{variable}}" value={b.value} onChange={(e) => setData((d) => ({ ...d, bodyProperties: d.bodyProperties.map((x) => x.id === b.id ? { ...x, value: e.target.value } : x) }))} />
                  <button type="button" onClick={() => setData((d) => ({ ...d, bodyProperties: d.bodyProperties.filter((x) => x.id !== b.id) }))} className="rounded-md p-2 text-destructive hover:bg-destructive/10">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StepReview({ data }: { data: ToolWizardData }) {
  return (
    <div className="space-y-4">
      <SectionHeader icon={Eye} title="Review & Save" description="Make sure everything looks right before creating your tool." />

      <div className="space-y-3 rounded-lg border border-border bg-card p-4">
        <h4 className="font-semibold">General</h4>
        <div className="grid grid-cols-[140px_1fr] gap-y-2 text-sm">
          <span className="text-muted-foreground">Name</span>
          <span className="font-mono">{data.name}</span>
          <span className="text-muted-foreground">Status</span>
          <span>{data.active ? "Active" : "Inactive"}</span>
          <span className="text-muted-foreground">Description</span>
          <span>{data.description}</span>
        </div>
      </div>

      <div className="space-y-3 rounded-lg border border-border bg-card p-4">
        <h4 className="font-semibold">Parameters ({data.parameters.length})</h4>
        {data.parameters.length === 0 ? (
          <p className="text-sm text-muted-foreground">No parameters defined.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {data.parameters.map((p) => (
              <li key={p.id} className="flex items-center gap-2">
                <Badge variant="secondary">{p.type}</Badge>
                <span className="font-mono">{p.name}</span>
                {p.required && <Badge variant="outline" className="text-destructive">required</Badge>}
                <span className="text-muted-foreground">— {p.description}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-3 rounded-lg border border-border bg-card p-4">
        <h4 className="font-semibold">Platform</h4>
        <div className="grid grid-cols-[140px_1fr] gap-y-2 text-sm">
          <span className="text-muted-foreground">Endpoint</span>
          <span className="font-mono">
            <Badge variant="secondary" className="mr-2">{data.method}</Badge>
            {data.apiUrl}
          </span>
          <span className="text-muted-foreground">Content-Type</span>
          <span>{data.contentType}</span>
          <span className="text-muted-foreground">Headers</span>
          <span>{data.headers.length} configured</span>
          <span className="text-muted-foreground">Body Properties</span>
          <span>{data.bodyProperties.length} configured</span>
        </div>
      </div>
    </div>
  );
}
