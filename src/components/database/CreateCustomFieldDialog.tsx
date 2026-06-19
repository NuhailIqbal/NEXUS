import { useState } from "react";
import { Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave?: (field: { name: string; type: string; required: boolean; options: string[] }) => void;
};

const FIELD_TYPES = ["Text", "Number", "Email", "Phone", "Date", "Boolean", "Dropdown", "Multi-select", "Textarea", "URL"];

export function CreateCustomFieldDialog({ open, onOpenChange, onSave }: Props) {
  const [name, setName] = useState("");
  const [type, setType] = useState("Text");
  const [required, setRequired] = useState(false);
  const [optionsInput, setOptionsInput] = useState("");

  const reset = () => {
    setName("");
    setType("Text");
    setRequired(false);
    setOptionsInput("");
  };

  const close = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const needsOptions = type === "Dropdown" || type === "Multi-select";

  const submit = () => {
    if (!name.trim()) return toast.error("Field name is required");
    if (needsOptions && !optionsInput.trim()) return toast.error("Please add at least one option");
    const options = needsOptions ? optionsInput.split(",").map((o) => o.trim()).filter(Boolean) : [];
    onSave?.({ name: name.trim(), type, required, options });
    toast.success(`Field "${name}" saved`);
    close(false);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg gap-0 p-0 sm:rounded-xl [&>button]:hidden">
        <div className="flex items-start justify-between border-b border-border p-5">
          <h2 className="text-lg font-semibold">Create Custom Field</h2>
          <button onClick={() => close(false)} className="rounded-md p-1 text-muted-foreground hover:bg-muted" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 p-6">
          <div>
            <label className="mb-1.5 block text-sm font-semibold">Field Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g., Company Size" />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-semibold">Type</label>
            <select value={type} onChange={(e) => setType(e.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              {FIELD_TYPES.map((t) => (<option key={t} value={t}>{t}</option>))}
            </select>
          </div>

          {needsOptions && (
            <div>
              <label className="mb-1.5 block text-sm font-semibold">
                Options <span className="text-muted-foreground font-normal">(comma separated)</span>
              </label>
              <Input value={optionsInput} onChange={(e) => setOptionsInput(e.target.value)} placeholder="Option A, Option B, Option C" />
            </div>
          )}

          <label className="flex items-center gap-3 rounded-md border border-border bg-muted/40 p-3">
            <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} className="h-4 w-4 accent-primary" />
            <span className="text-sm font-medium">Required field</span>
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border p-4">
          <Button variant="outline" onClick={() => close(false)}>
            <X className="mr-1 h-4 w-4" /> Cancel
          </Button>
          <Button onClick={submit} className="bg-primary text-primary-foreground hover:opacity-90">
            <Plus className="mr-1 h-4 w-4" /> Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
