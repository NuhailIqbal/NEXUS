import { useEffect, useState } from "react";
import { X, Trash2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import type { Node } from "reactflow";
import type { FlowNodeData } from "./flow-nodes";
import { paletteFor } from "./flow-nodes";

type Props = {
  node: Node<FlowNodeData> | null;
  onClose: () => void;
  onSave: (id: string, data: FlowNodeData) => void;
  onDelete: (id: string) => void;
};

export function NodeEditPanel({ node, onClose, onSave, onDelete }: Props) {
  const [label, setLabel] = useState("");
  const [config, setConfig] = useState<Record<string, string>>({});

  useEffect(() => {
    if (node) {
      setLabel(node.data.label);
      setConfig((node.data.config ?? {}) as Record<string, string>);
    }
  }, [node]);

  if (!node) return null;
  const p = paletteFor(node.data.kind);
  const Icon = p.icon;

  const set = (k: string, v: string) => setConfig((c) => ({ ...c, [k]: v }));

  const renderFields = () => {
    switch (node.data.kind) {
      case "sms":
        return (
          <>
            <Field label="Message">
              <Textarea rows={4} value={config.message ?? ""} onChange={(e) => set("message", e.target.value)} placeholder="Hi {{name}}, ..." />
            </Field>
            <Field label="From number">
              <Input value={config.from ?? ""} onChange={(e) => set("from", e.target.value)} placeholder="+1 555 ..." />
            </Field>
          </>
        );
      case "email":
        return (
          <>
            <Field label="Subject"><Input value={config.subject ?? ""} onChange={(e) => set("subject", e.target.value)} /></Field>
            <Field label="Body"><Textarea rows={5} value={config.body ?? ""} onChange={(e) => set("body", e.target.value)} /></Field>
          </>
        );
      case "condition":
        return (
          <>
            <Field label="Field"><Input value={config.field ?? ""} onChange={(e) => set("field", e.target.value)} placeholder="contact.status" /></Field>
            <Field label="Operator">
              <select value={config.op ?? "equals"} onChange={(e) => set("op", e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                <option value="equals">equals</option>
                <option value="not_equals">not equals</option>
                <option value="contains">contains</option>
                <option value="gt">greater than</option>
                <option value="lt">less than</option>
              </select>
            </Field>
            <Field label="Value"><Input value={config.value ?? ""} onChange={(e) => set("value", e.target.value)} /></Field>
          </>
        );
      case "delay":
        return (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Duration"><Input type="number" value={config.duration ?? "1"} onChange={(e) => set("duration", e.target.value)} /></Field>
            <Field label="Unit">
              <select value={config.unit ?? "minutes"} onChange={(e) => set("unit", e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                <option value="minutes">Minutes</option>
                <option value="hours">Hours</option>
                <option value="days">Days</option>
              </select>
            </Field>
          </div>
        );
      case "event":
        return (
          <Field label="Event type">
            <select value={config.event ?? "contact.created"} onChange={(e) => set("event", e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
              <option value="contact.created">Contact created</option>
              <option value="contact.updated">Contact updated</option>
              <option value="form.submitted">Form submitted</option>
              <option value="tag.added">Tag added</option>
            </select>
          </Field>
        );
      case "webhook":
        return (
          <>
            <Field label="URL"><Input value={config.url ?? ""} onChange={(e) => set("url", e.target.value)} placeholder="https://..." /></Field>
            <Field label="Method">
              <select value={config.method ?? "POST"} onChange={(e) => set("method", e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                <option>POST</option><option>GET</option><option>PUT</option><option>DELETE</option>
              </select>
            </Field>
          </>
        );
      default:
        return <div className="text-sm text-muted-foreground">No additional configuration.</div>;
    }
  };

  return (
    <div className="absolute inset-y-0 right-0 z-30 flex w-[360px] flex-col border-l border-border bg-card shadow-2xl animate-in slide-in-from-right-5 duration-200">
      <div className="flex items-center justify-between border-b border-border p-4">
        <div className="flex items-center gap-2">
          <div className={`flex h-8 w-8 items-center justify-center rounded-md ${p.iconBg}`}>
            <Icon className={`h-4 w-4 ${p.iconColor}`} />
          </div>
          <div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground">{p.group}</div>
            <div className="text-sm font-semibold">Edit node</div>
          </div>
        </div>
        <button onClick={onClose} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted" aria-label="Close">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <Field label="Name"><Input value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
        {renderFields()}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border p-3">
        <Button variant="ghost" className="text-destructive hover:bg-destructive/10" onClick={() => onDelete(node.id)}>
          <Trash2 className="mr-1.5 h-4 w-4" /> Delete
        </Button>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            className="bg-primary text-primary-foreground"
            onClick={() => onSave(node.id, { ...node.data, label: label || node.data.label, config })}
          >
            <Save className="mr-1.5 h-4 w-4" /> Save
          </Button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
