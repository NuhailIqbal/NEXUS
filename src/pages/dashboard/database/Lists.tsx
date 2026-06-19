import { useEffect, useState, useCallback } from "react";
import { Plus, ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { CreateListDialog } from "@/components/database/CreateListDialog";
import { RowActions } from "@/components/dashboard/RowActions";
import { api } from "@/services/api";
import { toast } from "sonner";

type ListItem = {
  id: string;
  name: string;
  count: number;
  createdAt: string;
};

const Lists = () => {
  const [open, setOpen] = useState(false);
  const [lists, setLists] = useState<ListItem[]>([]);

  const [viewTarget, setViewTarget] = useState<ListItem | null>(null);
  const [editTarget, setEditTarget] = useState<ListItem | null>(null);
  const [editForm, setEditForm] = useState<Partial<ListItem>>({});

  const fetchLists = useCallback(async () => {
    const { data, error } = await api.getLists();
    if (error) {
      toast.error("Failed to load lists");
      return;
    }
    if (data) {
      setLists(
        (data as any[]).map((l) => ({
          id: l.id,
          name: l.name,
          count: l.contact_count ?? 0,
          createdAt: l.created_at
            ? new Date(l.created_at).toISOString().slice(0, 10)
            : "",
        })),
      );
    }
  }, []);

  useEffect(() => {
    fetchLists();
  }, [fetchLists]);

  const handleDelete = async (l: ListItem) => {
    const { error } = await api.deleteList(l.id);
    if (error) {
      toast.error("Failed to delete list");
      return;
    }
    toast.success("List deleted");
    fetchLists();
  };

  const openEdit = (l: ListItem) => {
    setEditTarget(l);
    setEditForm({ name: l.name });
  };

  const saveEdit = async () => {
    if (!editTarget) return;
    const patch = { name: editForm.name ?? editTarget.name };
    const { error } = await api.updateList(editTarget.id, patch);
    if (error) {
      toast.error("Failed to rename list");
      return;
    }
    toast.success("List renamed");
    setEditTarget(null);
    fetchLists();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Lists</h1>
          <p className="text-sm text-muted-foreground">Group contacts for campaigns and flows.</p>
        </div>
        <Button onClick={() => setOpen(true)}><Plus className="mr-2 h-4 w-4" />New List</Button>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {lists.map((l) => (
          <div key={l.id} className="rounded-xl border border-border bg-card p-5 card-interactive">
            <div className="flex items-start justify-between">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <ListChecks className="h-5 w-5" />
              </div>
            </div>
            <h3 className="mt-4 font-semibold text-foreground">{l.name}</h3>
            <p className="text-xs text-muted-foreground">Created {l.createdAt}</p>
            <div className="mt-3 text-2xl font-bold text-foreground">{l.count.toLocaleString()}</div>
            <div className="text-xs text-muted-foreground">contacts</div>
            <div className="mt-3 border-t border-border pt-3">
              <RowActions
                onView={() => setViewTarget(l)}
                onSettings={() => openEdit(l)}
                onDelete={() => handleDelete(l)}
              />
            </div>
          </div>
        ))}
      </div>

      <CreateListDialog
        open={open}
        onOpenChange={setOpen}
        onCreate={async (d) => {
          const { error } = await api.createList({ name: d.name });
          if (error) {
            toast.error("Failed to create list");
            return;
          }
          fetchLists();
        }}
      />

      <Dialog open={!!viewTarget} onOpenChange={(o) => !o && setViewTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{viewTarget?.name}</DialogTitle>
            <DialogDescription>List details</DialogDescription>
          </DialogHeader>
          {viewTarget && (
            <dl className="grid grid-cols-3 gap-3 text-sm">
              <dt className="text-muted-foreground">Contacts</dt>
              <dd className="col-span-2 font-medium">{viewTarget.count.toLocaleString()}</dd>
              <dt className="text-muted-foreground">Created</dt>
              <dd className="col-span-2 font-medium">{viewTarget.createdAt}</dd>
              <dt className="text-muted-foreground">ID</dt>
              <dd className="col-span-2 font-mono text-xs">{viewTarget.id}</dd>
            </dl>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setViewTarget(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editTarget} onOpenChange={(o) => !o && setEditTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Rename List</DialogTitle>
            <DialogDescription>Change the list's display name.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Name</Label>
            <Input value={editForm.name ?? ""} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} />
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

export default Lists;
