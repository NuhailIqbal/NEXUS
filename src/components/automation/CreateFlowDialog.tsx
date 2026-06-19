import { useState } from "react";
import { Plus, X } from "lucide-react";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/services/api";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
  basePath?: string;
};

export function CreateFlowDialog({ open, onOpenChange, onCreated, basePath = "/dashboard/automation" }: Props) {
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();

  const close = (next: boolean) => {
    if (!next) setName("");
    onOpenChange(next);
  };

  const submit = async () => {
    if (!name.trim()) return toast.error("Please enter a flow name");
    setSubmitting(true);

    const { data, error } = await api.createFlow({
      name: name.trim(),
      status: "Active",
    });

    setSubmitting(false);

    if (error) {
      toast.error(error);
      return;
    }

    const flowId = data?.id ?? name.trim();
    toast.success(`Flow "${name}" created`);
    close(false);
    onCreated?.();
    navigate(`${basePath}/${flowId}?name=${encodeURIComponent(name.trim())}`);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md gap-0 p-0 sm:rounded-xl [&>button]:hidden">
        <div className="border-b border-border p-5">
          <DialogTitle className="text-lg font-semibold">Create new flow</DialogTitle>
          <DialogDescription className="sr-only">Enter a name to create a new automation flow.</DialogDescription>
        </div>

        <div className="p-6">
          <label className="mb-2 block text-sm font-semibold">Enter new flow name</label>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Name"
          />
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border p-4">
          <Button variant="outline" onClick={() => close(false)}>
            <X className="mr-1 h-4 w-4" /> Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={submitting}
            className="bg-primary text-primary-foreground hover:opacity-90"
          >
            <Plus className="mr-1 h-4 w-4" /> {submitting ? "Creating..." : "Create"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
