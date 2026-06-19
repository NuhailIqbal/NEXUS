import { useState } from "react";
import { Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate?: (data: { name: string; type: string; description: string; active: boolean }) => void;
};

const TYPES = ["Static", "Dynamic", "Smart Segment", "Imported", "Suppression"];

export function CreateListDialog({ open, onOpenChange, onCreate }: Props) {
  const [name, setName] = useState("");
  const [type, setType] = useState("");
  const [description, setDescription] = useState("");
  const [active, setActive] = useState(true);

  const reset = () => {
    setName("");
    setType("");
    setDescription("");
    setActive(true);
  };

  const close = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const submit = () => {
    if (!name.trim()) return toast.error("Customer list name is required");
    if (!type) return toast.error("Please select a type");
    onCreate?.({ name, type, description, active });
    toast.success(`List "${name}" created`);
    close(false);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-3xl gap-0 p-0 sm:rounded-xl [&>button]:hidden">
        <div className="flex items-start justify-between border-b border-border p-5">
          <h2 className="text-lg font-semibold">Create Customer List</h2>
          <button onClick={() => close(false)} className="rounded-md p-1 text-muted-foreground hover:bg-muted" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-5 p-6">
          <div>
            <label className="mb-1.5 block text-sm font-semibold">Customer List Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Please provide your customer list name" />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-semibold">Type</label>
            <select value={type} onChange={(e) => setType(e.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="">Please select type</option>
              {TYPES.map((t) => (<option key={t} value={t}>{t}</option>))}
            </select>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-semibold">Customer List Description</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Customer List Description" rows={5} className="w-full rounded-md border border-input bg-background p-3 text-sm" />
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setActive((a) => !a)}
              className={`relative h-7 w-12 rounded-full transition ${active ? "bg-success" : "bg-muted"}`}
              aria-pressed={active}
            >
              <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-background shadow transition ${active ? "left-[22px]" : "left-0.5"}`} />
            </button>
            <span className="text-sm font-semibold">Active</span>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border p-4">
          <Button variant="outline" onClick={() => close(false)}>
            <X className="mr-1 h-4 w-4" /> Cancel
          </Button>
          <Button onClick={submit} className="bg-primary text-primary-foreground hover:opacity-90">
            <Plus className="mr-1 h-4 w-4" /> Create
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
