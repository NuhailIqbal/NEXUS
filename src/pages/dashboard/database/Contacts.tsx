import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { Plus, Upload } from "lucide-react";
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
import {
  SortableColumnHeader, TableTextFilter, TableSelectFilter, TablePagination,
} from "@/components/dashboard/table/TableControls";
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

type ColumnKey = "name" | "phone" | "email" | "list" | "status" | "createdAt";

const COLUMNS: { key: ColumnKey; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "phone", label: "Phone" },
  { key: "email", label: "Email" },
  { key: "list", label: "List" },
  { key: "status", label: "Status" },
  { key: "createdAt", label: "Created" },
];

const STATUS_OPTIONS = ["Active", "Inactive", "Pending"];
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

const Contacts = () => {
  const [open, setOpen] = useState(false);
  const [sortKey, setSortKey] = useState<ColumnKey | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [filters, setFilters] = useState<Record<ColumnKey, string>>({
    name: "", phone: "", email: "", list: "", status: "", createdAt: "",
  });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [lists, setLists] = useState<ListRow[]>([]);

  const fileRef = useRef<HTMLInputElement>(null);
  const [showImportInfo, setShowImportInfo] = useState(false);
  const [importListId, setImportListId] = useState(""); // "" = no list, "__new__" = create new
  const [importNewListName, setImportNewListName] = useState("");
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

  const toggleSort = (key: ColumnKey) => {
    if (sortKey !== key) { setSortKey(key); setSortDir("asc"); return; }
    if (sortDir === "asc") { setSortDir("desc"); return; }
    setSortKey(null);
  };
  const setFilter = (key: ColumnKey, value: string) => setFilters((f) => ({ ...f, [key]: value }));

  const filtered = useMemo(() => {
    return contacts.filter((c) =>
      COLUMNS.every(({ key }) => {
        if (key === "status") {
          if (!filters.status) return true;
          return c.status === filters.status;
        }
        const q = filters[key].trim().toLowerCase();
        return !q || String(c[key] ?? "").toLowerCase().includes(q);
      })
    );
  }, [contacts, filters]);

  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    return [...filtered].sort((a, b) => {
      const av = String(a[sortKey] ?? "").toLowerCase();
      const bv = String(b[sortKey] ?? "").toLowerCase();
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
  }, [filtered, sortKey, sortDir]);

  useEffect(() => { setPage(1); }, [filters, pageSize]);
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [page, totalPages]);
  const visibleContacts = useMemo(
    () => sorted.slice((page - 1) * pageSize, page * pageSize),
    [sorted, page, pageSize]
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

    // Resolve the target list before touching any rows: either an existing list,
    // a brand-new one created on the fly, or none (imported contacts stay list-less).
    let listId: string | undefined;
    if (importListId === "__new__") {
      if (!importNewListName.trim()) return toast.error("Enter a name for the new list");
      const { data, error } = await api.createList({ name: importNewListName.trim() });
      if (error || !data) return toast.error(error || "Failed to create list");
      listId = (data as any).id;
    } else if (importListId) {
      listId = importListId;
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
        ...(listId ? { list_id: listId } : {}),
      });
      if (!error) count++;
    }
    if (skipped > 0) {
      toast.success(
        `Imported ${count} contact${count === 1 ? "" : "s"}, skipped ${skipped} row${skipped === 1 ? "" : "s"} with no phone number`,
      );
    } else {
      toast.success(`Imported ${count} contact${count === 1 ? "" : "s"}`);
    }
    setImportListId("");
    setImportNewListName("");
    fetchContacts();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Contacts</h1>
          <p className="text-sm text-muted-foreground">All people across your lists.</p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
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
              <li>Don&apos;t put commas inside a value (e.g. write <span className="font-medium text-foreground">John Doe</span>, not <span className="font-medium text-foreground">Doe, John</span>) since commas separate columns.</li>
              <li>New contacts are added with status <span className="font-medium text-foreground">Active</span>.</li>
            </ul>
            <div className="space-y-2 border-t border-border pt-3">
              <Label>Add to List (optional)</Label>
              <Select
                value={importListId || "__none__"}
                onValueChange={(v) => setImportListId(v === "__none__" ? "" : v)}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">No list</SelectItem>
                  {lists.map((l) => (<SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>))}
                  <SelectItem value="__new__">+ Create new list…</SelectItem>
                </SelectContent>
              </Select>
              {importListId === "__new__" && (
                <Input
                  value={importNewListName}
                  onChange={(e) => setImportNewListName(e.target.value)}
                  placeholder="New list name"
                  autoFocus
                />
              )}
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
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
      <div className="overflow-hidden rounded-xl border border-border">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-center text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              <tr className="divide-x divide-border">
                {COLUMNS.map(({ key, label }) => (
                  <th key={key} className="px-4 py-3">
                    <SortableColumnHeader label={label} active={sortKey === key} dir={sortDir} onClick={() => toggleSort(key)} />
                  </th>
                ))}
                <th className="px-4 py-3 w-32">Actions</th>
              </tr>
              <tr className="divide-x divide-border border-t border-border">
                {COLUMNS.map(({ key, label }) => (
                  <th key={key} className="px-4 py-3 font-normal normal-case">
                    {key === "status" ? (
                      <TableSelectFilter
                        value={filters.status}
                        onChange={(v) => setFilter("status", v)}
                        placeholder="Status"
                        options={STATUS_OPTIONS.map((s) => ({ value: s, label: s }))}
                      />
                    ) : key === "list" ? (
                      <TableSelectFilter
                        value={filters.list}
                        onChange={(v) => setFilter("list", v)}
                        placeholder="List"
                        options={lists.map((l) => ({ value: l.name, label: l.name }))}
                      />
                    ) : (
                      <TableTextFilter value={filters[key]} onChange={(v) => setFilter(key, v)} placeholder={label} />
                    )}
                  </th>
                ))}
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {visibleContacts.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                    {contacts.length === 0 ? "No contacts yet." : "No contacts match your filters."}
                  </td>
                </tr>
              ) : (
                visibleContacts.map((c) => (
                  <tr key={c.id} className="divide-x divide-border border-t border-border bg-card/30">
                    <td className="px-4 py-3 text-center font-medium text-foreground">{c.name}</td>
                    <td className="px-4 py-3 text-center text-muted-foreground">{c.phone}</td>
                    <td className="px-4 py-3 text-center text-muted-foreground">{c.email}</td>
                    <td className="px-4 py-3 text-center">{c.list}</td>
                    <td className="px-4 py-3 text-center">
                      <Badge variant={c.status === "Active" ? "default" : c.status === "Pending" ? "secondary" : "outline"}>
                        {c.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-center text-muted-foreground whitespace-nowrap">{c.createdAt}</td>
                    <td className="px-4 py-3 text-center">
                      <RowActions
                        onView={() => setViewTarget(c)}
                        onSettings={() => openEdit(c)}
                        onDelete={() => handleDelete(c)}
                      />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <TablePagination
          page={page}
          pageSize={pageSize}
          totalCount={sorted.length}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
          pageSizeOptions={PAGE_SIZE_OPTIONS}
        />
      </div>

      <AddContactDialog
        open={open}
        onOpenChange={setOpen}
        onCreate={async (payload) => {
          const name = payload.basic.name || "Unnamed";
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
            <dl className="grid grid-cols-1 gap-1.5 text-sm sm:grid-cols-3 sm:gap-3">
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
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Phone</Label>
                <Input value={editForm.phone ?? ""} onChange={(e) => setEditForm((f) => ({ ...f, phone: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>Email</Label>
                <Input value={editForm.email ?? ""} onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))} />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
