import { useEffect, useState, useCallback } from "react";
import { Plus, Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { CreateCustomFieldDialog } from "@/components/database/CreateCustomFieldDialog";
import { RowActions } from "@/components/dashboard/RowActions";
import { api } from "@/services/api";
import { toast } from "sonner";

type Field = {
  id: string;
  name: string;
  type: string;
  required?: boolean;
  options?: string[];
  defaultValue?: string;
};

const CustomFields = () => {
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState<Field[]>([]);

  const [editTarget, setEditTarget] = useState<Field | null>(null);
  const [editForm, setEditForm] = useState<Partial<Field>>({});
  const [optionsText, setOptionsText] = useState("");

  const fetchFields = useCallback(async () => {
    const { data, error } = await api.getCustomFields();
    if (error) {
      toast.error("Failed to load custom fields");
      return;
    }
    if (data) {
      setFields(
        (data as any[]).map((f) => ({
          id: f.id,
          name: f.name,
          type: f.type ?? "Text",
          required: false,
          options: f.options ?? [],
          defaultValue: f.default_value ?? "",
        })),
      );
    }
  }, []);

  useEffect(() => {
    fetchFields();
  }, [fetchFields]);

  const openEdit = (f: Field) => {
    setEditTarget(f);
    setEditForm({ name: f.name, type: f.type, required: f.required ?? false });
    setOptionsText((f.options ?? []).join(", "));
  };

  const saveEdit = async () => {
    if (!editTarget) return;
    const opts = optionsText.split(",").map((o) => o.trim()).filter(Boolean);
    const patch = {
      name: editForm.name ?? editTarget.name,
      type: editForm.type ?? editTarget.type,
      options: opts.length ? opts : undefined,
    };
    const { error } = await api.updateCustomField(editTarget.id, patch);
    if (error) {
      toast.error("Failed to update field");
      return;
    }
    toast.success("Field updated");
    setEditTarget(null);
    fetchFields();
  };

  const handleDelete = async (f: Field) => {
    const { error } = await api.deleteCustomField(f.id);
    if (error) {
      toast.error("Failed to delete field");
      return;
    }
    toast.success("Field removed");
    fetchFields();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Custom Fields</h1>
          <p className="text-sm text-muted-foreground">Extra attributes you can store on contacts.</p>
        </div>
        <Button onClick={() => setOpen(true)}><Plus className="mr-2 h-4 w-4" />Add Field</Button>
      </div>
      <div className="overflow-hidden rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Field</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Required</th>
              <th className="px-4 py-3">Options</th>
              <th className="px-4 py-3 w-28"></th>
            </tr>
          </thead>
          <tbody>
            {fields.map((f) => (
              <tr key={f.id} className="border-t border-border bg-card/30">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2 font-medium text-foreground">
                    <Tag className="h-4 w-4 text-primary" /> {f.name}
                  </div>
                </td>
                <td className="px-4 py-3"><Badge variant="outline">{f.type}</Badge></td>
                <td className="px-4 py-3 text-muted-foreground">{f.required ? "Yes" : "No"}</td>
                <td className="px-4 py-3 text-muted-foreground">{f.options?.length ? f.options.join(", ") : "—"}</td>
                <td className="px-4 py-3">
                  <RowActions
                    onSettings={() => openEdit(f)}
                    onDelete={() => handleDelete(f)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <CreateCustomFieldDialog
        open={open}
        onOpenChange={setOpen}
        onSave={async (d) => {
          const { error } = await api.createCustomField({
            name: d.name,
            type: d.type,
            options: d.options,
          });
          if (error) {
            toast.error("Failed to create field");
            return;
          }
          fetchFields();
        }}
      />

      <Dialog open={!!editTarget} onOpenChange={(o) => !o && setEditTarget(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Field</DialogTitle>
            <DialogDescription>Update name, type, and options.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={editForm.name ?? ""} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label>Type</Label>
              <Select value={editForm.type ?? "Text"} onValueChange={(v) => setEditForm((f) => ({ ...f, type: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="Text">Text</SelectItem>
                  <SelectItem value="Number">Number</SelectItem>
                  <SelectItem value="Dropdown">Dropdown</SelectItem>
                  <SelectItem value="Date">Date</SelectItem>
                  <SelectItem value="Boolean">Boolean</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {editForm.type === "Dropdown" && (
              <div className="space-y-2">
                <Label>Options (comma separated)</Label>
                <Input value={optionsText} onChange={(e) => setOptionsText(e.target.value)} placeholder="Option 1, Option 2" />
              </div>
            )}
            <div className="flex items-center justify-between rounded-md border border-border p-3">
              <Label htmlFor="req">Required</Label>
              <Switch id="req" checked={!!editForm.required} onCheckedChange={(c) => setEditForm((f) => ({ ...f, required: c }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)}>Cancel</Button>
            <Button onClick={saveEdit}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default CustomFields;
