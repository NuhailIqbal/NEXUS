import { useEffect, useRef, useState, useCallback } from "react";
import { Plus, Search, Upload } from "lucide-react";
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
import { AddContactDialog } from "@/components/database/AddContactDialog";
import { RowActions } from "@/components/dashboard/RowActions";
import { api } from "@/services/api";
import { toast } from "sonner";

type Contact = {
  id: string;
  name: string;
  phone: string;
  email: string;
  status: string;
  list: string;
  list_id: string | null;
  createdAt: string;
};

type ListRow = { id: string; name: string };

const Contacts = () => {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [lists, setLists] = useState<ListRow[]>([]);

  const fileRef = useRef<HTMLInputElement>(null);
  const [showImportInfo, setShowImportInfo] = useState(false);
  const [viewTarget, setViewTarget] = useState<Contact | null>(null);
  const [editTarget, setEditTarget] = useState<Contact | null>(null);
  const [editForm, setEditForm] = useState<Partial<Contact>>({});

  const fetchContacts = useCallback(async () => {
    const [contactsRes, listsRes] = await Promise.all([api.getContacts(), api.getLists()]);
    if (contactsRes.error) {
      toast.error("Failed to load contacts");
      return;
    }
    const listsData: ListRow[] = Array.isArray(listsRes.data) ? listsRes.data : [];
    setLists(listsData);
    const listsMap = new Map(listsData.map((l) => [l.id, l.name]));
    if (contactsRes.data) {
      setContacts(
        (contactsRes.data as any[]).map((c) => ({
          id: c.id,
          name: c.name,
          phone: c.phone ?? "",
          email: c.email ?? "",
          status: c.status ?? "Active",
          list_id: c.list_id ?? null,
          list: c.list_id ? (listsMap.get(c.list_id) ?? " ") : " ",
          createdAt: c.created_at
            ? new Date(c.created_at).toISOString().slice(0, 10)
            : "",
        })),
      );
    }
  }, []);

  useEffect(() => {
    fetchContacts();
  }, [fetchContacts]);

  const filtered = contacts.filter((c) =>
    c.name.toLowerCase().includes(q.toLowerCase()) ||
    c.email.toLowerCase().includes(q.toLowerCase()),
  );

  const handleDelete = async (c: Contact) => {
    const { error } = await api.deleteContact(c.id);
    if (error) {
      toast.error("Failed to delete contact");
      return;
    }
    toast.success("Contact deleted");
    fetchContacts();
  };

  const openEdit = (c: Contact) => {
    setEditTarget(c);
    setEditForm({ name: c.name, phone: c.phone, email: c.email, status: c.status, list_id: c.list_id });
  };

  const saveEdit = async () => {
    if (!editTarget) return;
    const patch: Record<string, any> = {
      name: editForm.name ?? editTarget.name,
      phone: editForm.phone ?? editTarget.phone,
      email: editForm.email ?? editTarget.email,
      status: editForm.status ?? editTarget.status,
      list_id: editForm.list_id ?? null,
    };
    const { error } = await api.updateContact(editTarget.id, patch);
    if (error) {
      toast.error("Failed to update contact");
      return;
    }
    toast.success("Contact updated");
    setEditTarget(null);
    fetchContacts();
  };

  const handleImportCsv = async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".csv")) {
      toast.error("Please upload a .csv file. In Excel: Save As → CSV (Comma delimited).");
      return;
    }
    const text = await file.text();
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) return toast.error("Empty file");
    const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
    let count = 0;
    let skipped = 0;
    for (const line of lines.slice(1)) {
      const cols = line.split(",").map((c) => c.trim());
      const row: Record<string, string> = {};
      headers.forEach((h, i) => (row[h] = cols[i] ?? ""));
      const name = row.name || row.full_name || row.first_name || "Imported";
      const phone = (row.phone ?? "").trim();
      if (!phone) {
        skipped++;
        continue; // phone number is required
      }
      const { error } = await api.createContact({
        name,
        phone,
        email: row.email ?? "",
        status: "Active",
      });
      if (!error) count++;
    }
    if (skipped > 0) {
      toast.success(
        `Imported ${count} contact${count === 1 ? "" : "s"} — skipped ${skipped} row${skipped === 1 ? "" : "s"} with no phone number`,
      );
    } else {
      toast.success(`Imported ${count} contact${count === 1 ? "" : "s"}`);
    }
    fetchContacts();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Contacts</h1>
          <p className="text-sm text-muted-foreground">All people across your lists.</p>
        </div>
        <div className="flex gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleImportCsv(f);
              if (fileRef.current) fileRef.current.value = "";
            }}
          />
          <Button variant="outline" onClick={() => setShowImportInfo(true)}>
            <Upload className="mr-2 h-4 w-4" />Import CSV
          </Button>
          <Button onClick={() => setOpen(true)}><Plus className="mr-2 h-4 w-4" />Add Contact</Button>
        </div>
      </div>

      {/* CSV import format disclaimer — shown when the user clicks Import CSV */}
      <Dialog open={showImportInfo} onOpenChange={setShowImportInfo}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Import contacts from CSV</DialogTitle>
            <DialogDescription>
              Before you choose a file, make sure it matches this format.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div>
              <p className="mb-1 font-medium text-foreground">1. First row must be the column headers:</p>
              <pre className="whitespace-pre rounded-md border border-border bg-muted/50 p-3 text-xs overflow-x-auto">{`name,phone,email
John Doe,+13105551001,john@example.com
Jane Smith,+13105551002,jane@example.com`}</pre>
            </div>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              <li><span className="font-medium text-foreground">name</span> and <span className="font-medium text-foreground">phone</span> are required; <span className="font-medium text-foreground">email</span> is optional.</li>
              <li>Column order doesn&apos;t matter, and headers are case-insensitive.</li>
              <li>Don&apos;t put commas inside a value (e.g. write <span className="font-medium text-foreground">John Doe</span>, not <span className="font-medium text-foreground">Doe, John</span>) — commas separate columns.</li>
              <li>New contacts are added with status <span className="font-medium text-foreground">Active</span>.</li>
            </ul>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowImportInfo(false)}>Cancel</Button>
            <Button
              onClick={() => {
                setShowImportInfo(false);
                fileRef.current?.click();
              }}
            >
              <Upload className="mr-2 h-4 w-4" />Choose CSV File
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search…"
          className="h-10 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </div>
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Phone</th>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">List</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Created</th>
              <th className="px-4 py-3 w-32"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => (
              <tr key={c.id} className="border-t border-border bg-card/30">
                <td className="px-4 py-3 font-medium text-foreground">{c.name}</td>
                <td className="px-4 py-3 text-muted-foreground">{c.phone}</td>
                <td className="px-4 py-3 text-muted-foreground">{c.email}</td>
                <td className="px-4 py-3">{c.list}</td>
                <td className="px-4 py-3">
                  <Badge variant={c.status === "Active" ? "default" : c.status === "Pending" ? "secondary" : "outline"}>
                    {c.status}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-muted-foreground">{c.createdAt}</td>
                <td className="px-4 py-3">
                  <RowActions
                    onView={() => setViewTarget(c)}
                    onSettings={() => openEdit(c)}
                    onDelete={() => handleDelete(c)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <AddContactDialog
        open={open}
        onOpenChange={setOpen}
        onCreate={async (payload) => {
          const name = payload.basic.name || payload.custom.first_name || "Unnamed";
          const { error } = await api.createContact({
            name,
            phone: payload.basic.phone || "",
            email: payload.basic.email || "",
            status: "Active",
            ...(payload.basic.list_id ? { list_id: payload.basic.list_id } : {}),
          });
          if (error) {
            toast.error("Failed to create contact");
            return;
          }
          fetchContacts();
        }}
      />

      {/* View modal */}
      <Dialog open={!!viewTarget} onOpenChange={(o) => !o && setViewTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{viewTarget?.name}</DialogTitle>
            <DialogDescription>Contact details</DialogDescription>
          </DialogHeader>
          {viewTarget && (
            <dl className="grid grid-cols-3 gap-3 text-sm">
              <dt className="text-muted-foreground">Phone</dt>
              <dd className="col-span-2 font-medium">{viewTarget.phone || " "}</dd>
              <dt className="text-muted-foreground">Email</dt>
              <dd className="col-span-2 font-medium">{viewTarget.email || " "}</dd>
              <dt className="text-muted-foreground">List</dt>
              <dd className="col-span-2 font-medium">{viewTarget.list}</dd>
              <dt className="text-muted-foreground">Status</dt>
              <dd className="col-span-2"><Badge>{viewTarget.status}</Badge></dd>
              <dt className="text-muted-foreground">Created</dt>
              <dd className="col-span-2 font-medium">{viewTarget.createdAt}</dd>
            </dl>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setViewTarget(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit modal */}
      <Dialog open={!!editTarget} onOpenChange={(o) => !o && setEditTarget(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Contact</DialogTitle>
            <DialogDescription>Update contact information.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={editForm.name ?? ""} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Phone</Label>
                <Input value={editForm.phone ?? ""} onChange={(e) => setEditForm((f) => ({ ...f, phone: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>Email</Label>
                <Input value={editForm.email ?? ""} onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>List</Label>
                <select
                  value={editForm.list_id ?? ""}
                  onChange={(e) => setEditForm((f) => ({ ...f, list_id: e.target.value || null }))}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">No list</option>
                  {lists.map((l) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label>Status</Label>
                <Select value={editForm.status ?? "Active"} onValueChange={(v) => setEditForm((f) => ({ ...f, status: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Active">Active</SelectItem>
                    <SelectItem value="Inactive">Inactive</SelectItem>
                    <SelectItem value="Pending">Pending</SelectItem>
                  </SelectContent>
                </Select>
              </div>
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

export default Contacts;
