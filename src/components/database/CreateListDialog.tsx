/**
 * Modal for creating a contact list (name plus description).
 * It only collects input; the parent persists it through `onCreate`
 * (see pages/dashboard/database/Lists.tsx, which calls POST /lists).
 */
import { useState } from "react";
import { Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate?: (data: { name: string; description: string }) => void;
};

/**
 * Create-list dialog. Props: `open`/`onOpenChange` control visibility; `onCreate` receives
 * the name and description on submit. The description is collected here, but the Lists page
 * currently sends only the name to the API.
 */
export function CreateListDialog({ open, onOpenChange, onCreate }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  /** Clears the form fields. */
  const reset = () => {
    setName("");
    setDescription("");
  };

  /** Dialog open-change handler: resets the form when closing, then notifies the parent. */
  const close = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  /**
   * Requires a non-blank name, then passes the data to `onCreate` and closes the dialog.
   * The success toast fires immediately, before the parent's async save completes.
   */
  const submit = () => {
    if (!name.trim()) return toast.error("Customer list name is required");
    onCreate?.({ name, description });
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
            <label className="mb-1.5 block text-sm font-semibold">Customer List Description</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Customer List Description" rows={5} className="w-full rounded-md border border-input bg-background p-3 text-sm" />
          </div>
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-border p-4 sm:flex-row sm:items-center sm:justify-end">
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
