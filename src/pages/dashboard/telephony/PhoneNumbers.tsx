/**
 * Dashboard page listing every phone number on the account (route: /dashboard/telephony/phone-numbers).
 * Loads numbers, agents and campaigns, with client-side filter/sort/pagination, and offers buy,
 * settings (agent/status), release and "place test call" actions per row.
 * API: getPhoneNumbers, getAgents, getCampaigns, createPhoneNumber, createByotPhoneNumber,
 * confirmPhonePurchase, updatePhoneNumber, deletePhoneNumber, makeCall, getCallStatus.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { format, isSameDay } from "date-fns";
import { Plus, Phone, Clock, Delete, PhoneCall, PhoneOff, Loader2 } from "lucide-react";
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
  SortableColumnHeader, TableTextFilter, TableSelectFilter, TableDateFilter, TablePagination,
} from "@/components/dashboard/table/TableControls";
import { CreatePhoneNumberDialog } from "@/components/telephony/CreatePhoneNumberDialog";
import { RowActions } from "@/components/dashboard/RowActions";
import { api } from "@/services/api";
import { toast } from "sonner";

// User-facing provider labels are kept generic so we don't expose the underlying
// carrier (and the price it implies) to end users. Raw values are left untouched.
// BYOT is the one exception — the whole point of it is the user explicitly
// choosing Twilio, so it's surfaced plainly instead of hidden behind "Standard".
const PROVIDER_LABELS: Record<string, string> = {
  twilio: "Standard",
  vapi: "Standard",
  twilio_byot: "Twilio",
};
/** Maps a raw provider value (case-insensitive) to its user-facing label; unknown values pass through. */
const providerLabel = (p: string) => PROVIDER_LABELS[(p || "").toLowerCase()] ?? p;

/** A phone number row as returned by GET /telephony/phone-numbers. */
type Num = {
  id: string;
  number: string;
  status: string;
  agent_id: string;
  provider: string;
  vapi_phone_id: string;
  created_at: string;
  monthly_cost?: number;
  next_billing_at?: string | null;
  suspended_for_balance?: boolean;
  twilio_credential_id?: string | null;
};

// Real recurring-billing renewal date (next_billing_at). NULL for free VAPI numbers.
/**
 * Parses next_billing_at into a Date plus whole days remaining (negative once past due).
 * Returns null when the value is missing or not a valid date.
 */
function numberExpiry(nextBillingAt?: string | null) {
  if (!nextBillingAt) return null;
  const d = new Date(nextBillingAt);
  if (isNaN(d.getTime())) return null;
  const daysLeft = Math.floor((d.getTime() - Date.now()) / 86400000);
  return { date: d, daysLeft };
}

/** UI state of the test-call dialog; mostly mirrors the VAPI call status, plus local "dialing"/"failed". */
type CallStage = "idle" | "dialing" | "queued" | "ringing" | "in-progress" | "ended" | "failed";

// Test-call status polling: check every 2s and give up after 2 minutes.
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 120000;

type ColumnKey = "number" | "usedIn" | "provider" | "assignedAgent" | "status" | "purchased" | "expires";

const COLUMNS: { key: ColumnKey; label: string }[] = [
  { key: "number", label: "Number" },
  { key: "usedIn", label: "Used In" },
  { key: "provider", label: "Provider" },
  { key: "assignedAgent", label: "Assigned Agent" },
  { key: "status", label: "Status" },
  { key: "purchased", label: "Purchased" },
  { key: "expires", label: "Expires" },
];

const USED_IN_OPTIONS = [
  { value: "inbound", label: "Inbound" },
  { value: "outbound", label: "Outbound" },
  { value: "unused", label: "Unused" },
];

const STATUS_OPTIONS = ["Active", "Inactive"];
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

/**
 * Phone Numbers page component. Holds the table data, filter/sort/pagination state, the
 * "Buy Number" flow (via CreatePhoneNumberDialog), the settings modal and the test-call dialog.
 * Also finishes Stripe checkout returns (?purchase=success|canceled) on mount.
 */
const PhoneNumbers = () => {
  const [open, setOpen] = useState(false);
  const [numbers, setNumbers] = useState<Num[]>([]);
  const [agentsById, setAgentsById] = useState<Map<string, string>>(new Map());
  const [outboundIds, setOutboundIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  const [sortKey, setSortKey] = useState<ColumnKey | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [filters, setFilters] = useState<Record<ColumnKey, string>>({
    number: "", usedIn: "", provider: "", assignedAgent: "", status: "", purchased: "", expires: "",
  });
  const [purchasedDateFilter, setPurchasedDateFilter] = useState<Date | undefined>(undefined);
  const [expiresDateFilter, setExpiresDateFilter] = useState<Date | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const [testTarget, setTestTarget] = useState<Num | null>(null);
  const [testLog, setTestLog] = useState<string[]>([]);
  const [callStage, setCallStage] = useState<CallStage>("idle");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [settingsTarget, setSettingsTarget] = useState<Num | null>(null);
  const [settingsForm, setSettingsForm] = useState<{ agent_id: string | null; status: string; provider: string }>({ agent_id: "", status: "", provider: "" });

  // Loads numbers, agents (id -> name lookup) and campaigns (set of phone_number_ids used
  // for outbound) in parallel. Each is applied only if its response is valid.
  const fetchNumbers = async () => {
    const [numbersRes, agentsRes, campaignsRes] = await Promise.all([
      api.getPhoneNumbers(), api.getAgents(), api.getCampaigns(),
    ]);
    if (numbersRes.data) setNumbers(Array.isArray(numbersRes.data) ? numbersRes.data : []);
    if (Array.isArray(agentsRes.data))
      setAgentsById(new Map(agentsRes.data.map((a: any) => [a.id, a.name])));
    if (Array.isArray(campaignsRes.data))
      setOutboundIds(new Set(campaignsRes.data.map((c: any) => c.phone_number_id).filter(Boolean)));
    setLoading(false);
  };

  useEffect(() => { fetchNumbers(); }, []);

  // Cycles a column through ascending -> descending -> unsorted.
  const toggleSort = (key: ColumnKey) => {
    if (sortKey !== key) { setSortKey(key); setSortDir("asc"); return; }
    if (sortDir === "asc") { setSortDir("desc"); return; }
    setSortKey(null);
  };
  const setFilter = (key: ColumnKey, value: string) => setFilters((f) => ({ ...f, [key]: value }));

  // Distinct provider labels present in the data, used as the provider filter options.
  const providerOptions = useMemo(() => {
    const set = new Set(numbers.map((n) => providerLabel(n.provider)).filter(Boolean));
    return Array.from(set).sort();
  }, [numbers]);

  // Raw comparable/searchable text for a column. Date columns return the ISO string
  // (parsed by the sort); "usedIn" has no text and is handled separately.
  const textFor = (n: Num, key: ColumnKey): string => {
    if (key === "number") return n.number || "";
    if (key === "provider") return providerLabel(n.provider) || "";
    if (key === "assignedAgent") return n.agent_id ? (agentsById.get(n.agent_id) || "Unknown agent") : "";
    if (key === "status") return n.status || "";
    if (key === "purchased") return n.created_at || "";
    if (key === "expires") return n.next_billing_at || "";
    return "";
  };

  // Inbound = actively answering calls (agent assigned). Outbound = referenced by a
  // campaign. Unused = neither — a number just sitting idle, doing nothing.
  const filteredNumbers = useMemo(() => {
    return numbers.filter((n) => {
      if (filters.usedIn === "inbound" && !n.agent_id) return false;
      if (filters.usedIn === "outbound" && !outboundIds.has(n.id)) return false;
      if (filters.usedIn === "unused" && (n.agent_id || outboundIds.has(n.id))) return false;
      if (filters.status && n.status !== filters.status) return false;
      if (filters.provider && providerLabel(n.provider) !== filters.provider) return false;
      if (purchasedDateFilter) {
        const d = n.created_at ? new Date(n.created_at) : null;
        if (!d || isNaN(d.getTime()) || !isSameDay(d, purchasedDateFilter)) return false;
      }
      if (expiresDateFilter) {
        const d = n.next_billing_at ? new Date(n.next_billing_at) : null;
        if (!d || isNaN(d.getTime()) || !isSameDay(d, expiresDateFilter)) return false;
      }
      for (const key of ["number", "assignedAgent"] as ColumnKey[]) {
        const q = filters[key].trim().toLowerCase();
        if (q && !textFor(n, key).toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [numbers, outboundIds, filters, purchasedDateFilter, expiresDateFilter]);

  // Applies the active sort. "usedIn" ranks by how many roles (inbound/outbound) a number has;
  // missing dates sort as 0 (earliest).
  const sortedNumbers = useMemo(() => {
    if (!sortKey) return filteredNumbers;
    return [...filteredNumbers].sort((a, b) => {
      if (sortKey === "purchased" || sortKey === "expires") {
        const av = textFor(a, sortKey) ? new Date(textFor(a, sortKey)).getTime() : 0;
        const bv = textFor(b, sortKey) ? new Date(textFor(b, sortKey)).getTime() : 0;
        return sortDir === "asc" ? av - bv : bv - av;
      }
      if (sortKey === "usedIn") {
        const rank = (n: Num) => (n.agent_id ? 1 : 0) + (outboundIds.has(n.id) ? 1 : 0);
        return sortDir === "asc" ? rank(a) - rank(b) : rank(b) - rank(a);
      }
      const av = textFor(a, sortKey).toLowerCase();
      const bv = textFor(b, sortKey).toLowerCase();
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
  }, [filteredNumbers, sortKey, sortDir, outboundIds]);

  // Return to the first page whenever the result set changes shape.
  useEffect(() => { setPage(1); }, [filters, purchasedDateFilter, expiresDateFilter, pageSize]);
  const totalPages = Math.max(1, Math.ceil(sortedNumbers.length / pageSize));
  // Clamp the page if rows disappear (e.g. after a delete) and the current page no longer exists.
  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [page, totalPages]);
  const visibleNumbers = useMemo(
    () => sortedNumbers.slice((page - 1) * pageSize, page * pageSize),
    [sortedNumbers, page, pageSize]
  );

  // Handle the return from Stripe checkout (low-balance number purchase).
  // The ref guards against confirming the same session twice (e.g. React StrictMode double
  // effect run). The query string is always cleaned so a refresh doesn't replay it.
  const confirming = useRef(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const purchase = params.get("purchase");
    if (!purchase) return;
    const cleanUrl = () => window.history.replaceState({}, "", window.location.pathname);

    if (purchase === "canceled") {
      toast.info("Purchase canceled. No number was created.");
      cleanUrl();
      return;
    }
    if (purchase === "success") {
      const sessionId = params.get("session_id");
      if (!sessionId || confirming.current) { cleanUrl(); return; }
      confirming.current = true;
      const t = toast.loading("Payment received. Provisioning your number…");
      api.confirmPhonePurchase(sessionId).then(({ data, error }) => {
        toast.dismiss(t);
        if (error || !data) toast.error(error || "Could not provision the number after payment.");
        else toast.success(`Number ${data.number || ""} purchased and provisioned.`);
        cleanUrl();
        fetchNumbers();
      });
    }
  }, []);

  // Releases (deletes) a number via the API, then refreshes the list.
  const handleDelete = async (n: Num) => {
    const { error } = await api.deletePhoneNumber(n.id);
    if (error) return toast.error(error);
    toast.success("Number released");
    fetchNumbers();
  };

  // Cancels the call-status poll timer, if running.
  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  // Opens the test-call dialog for a number with a clean stage and log.
  const openTest = (n: Num) => {
    stopPolling();
    setTestTarget(n);
    setCallStage("idle");
    setTestLog([]);
  };

  // Closes the test-call dialog and stops any status polling (the call itself is not cancelled).
  const closeTest = () => {
    stopPolling();
    setTestTarget(null);
  };

  // Polls VAPI directly for the live call status so the dialog reflects what's
  // actually happening (ringing → in-progress → ended) instead of a static "queued".
  const trackCallStatus = (vapiCallId: string) => {
    stopPolling();
    const startedAt = Date.now();
    let lastStatus = "";
    pollRef.current = setInterval(async () => {
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) { stopPolling(); return; }
      const { data, error } = await api.getCallStatus(vapiCallId);
      if (error || !data) return;
      const status = data.status as string;
      if (status && status !== lastStatus) {
        lastStatus = status;
        setCallStage(
          status === "ended" ? "ended" :
          status === "in-progress" || status === "forwarding" ? "in-progress" :
          status === "ringing" ? "ringing" : "queued"
        );
        setTestLog((l) => [...l, status === "ended"
          ? `Call ended${data.ended_reason ? ` (${data.ended_reason})` : ""}.`
          : `Status: ${status}`]);
      }
      if (status === "ended") stopPolling();
    }, POLL_INTERVAL_MS);
  };

  // Stop polling on unmount so no timer outlives the page.
  useEffect(() => stopPolling, []);

  // Places a real outbound call from this number using its assigned agent, then starts polling
  // for status. Validation failures are only written to the log, no request is made.
  const placeTestCall = async (n: Num, to: string) => {
    if (!n.agent_id) {
      setTestLog((l) => [...l, "Error: no agent assigned to this number. Assign one in Settings first."]);
      return;
    }
    if (!to.trim()) {
      setTestLog((l) => [...l, "Error: enter a target phone number."]);
      return;
    }
    setCallStage("dialing");
    setTestLog((l) => [...l, `Dialing ${to}…`]);
    const { data, error } = await api.makeCall({
      agent_id: n.agent_id,
      phone_number: to.trim(),
      phone_number_id: n.id,
    });
    if (error) {
      setCallStage("failed");
      setTestLog((l) => [...l, `Call failed: ${error}`]);
    } else {
      setCallStage("queued");
      setTestLog((l) => [...l, `Call queued (status: ${data?.status ?? "queued"})`]);
      if (data?.vapi_call_id) trackCallStatus(data.vapi_call_id);
    }
  };

  // Opens the settings modal, seeding the form from the number's current values.
  const openSettings = (n: Num) => {
    setSettingsTarget(n);
    setSettingsForm({ agent_id: n.agent_id, status: n.status, provider: n.provider });
  };

  // Saves agent/status/provider for the selected number (PATCH); the provider field is
  // read-only in the UI and is sent back unchanged.
  const saveSettings = async () => {
    if (!settingsTarget) return;
    const { error } = await api.updatePhoneNumber(settingsTarget.id, {
      agent_id: settingsForm.agent_id,
      status: settingsForm.status,
      provider: settingsForm.provider,
    });
    if (error) return toast.error(error);
    toast.success("Number updated");
    setSettingsTarget(null);
    fetchNumbers();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Phone Numbers</h1>
          <p className="text-sm text-muted-foreground">Every number across inbound and outbound use, in one place.</p>
        </div>
        <Button onClick={() => setOpen(true)} className="w-full sm:w-auto"><Plus className="mr-2 h-4 w-4" />Buy Number</Button>
      </div>

      <div className="overflow-hidden rounded-xl border border-border">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
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
                    {key === "usedIn" ? (
                      <TableSelectFilter value={filters.usedIn} onChange={(v) => setFilter("usedIn", v)} placeholder="Used In" options={USED_IN_OPTIONS} />
                    ) : key === "provider" ? (
                      <TableSelectFilter value={filters.provider} onChange={(v) => setFilter("provider", v)} placeholder="Provider" options={providerOptions.map((p) => ({ value: p, label: p }))} />
                    ) : key === "status" ? (
                      <TableSelectFilter value={filters.status} onChange={(v) => setFilter("status", v)} placeholder="Status" options={STATUS_OPTIONS.map((s) => ({ value: s, label: s }))} />
                    ) : key === "purchased" ? (
                      <TableDateFilter value={purchasedDateFilter} onChange={setPurchasedDateFilter} />
                    ) : key === "expires" ? (
                      <TableDateFilter value={expiresDateFilter} onChange={setExpiresDateFilter} />
                    ) : (
                      <TableTextFilter value={filters[key]} onChange={(v) => setFilter(key, v)} placeholder={label} />
                    )}
                  </th>
                ))}
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">Loading...</td>
                </tr>
              ) : visibleNumbers.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                    {numbers.length === 0 ? "No phone numbers found." : "No numbers match your filters."}
                  </td>
                </tr>
              ) : (
                visibleNumbers.map((n) => (
                  <tr key={n.id} className="divide-x divide-border border-t border-border bg-card/30">
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-center gap-2 whitespace-nowrap font-mono text-foreground">
                        <Phone className="h-4 w-4 shrink-0 text-primary" /> {n.number}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap justify-center gap-1.5">
                        {n.agent_id && (
                          <span className="whitespace-nowrap rounded-full bg-info/15 px-2 py-0.5 text-xs font-medium text-info">Inbound</span>
                        )}
                        {outboundIds.has(n.id) && (
                          <span className="whitespace-nowrap rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success">Outbound</span>
                        )}
                        {!n.agent_id && !outboundIds.has(n.id) && (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-center">{providerLabel(n.provider)}</td>
                    <td className="px-4 py-3 text-center text-muted-foreground">{agentsById.get(n.agent_id) || (n.agent_id ? "Unknown agent" : "—")}</td>
                    <td className="px-4 py-3 text-center">
                      <NumberStatus num={n} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-center text-muted-foreground xl:whitespace-normal">
                      {n.created_at ? format(new Date(n.created_at), "MMM d, yyyy") : "—"}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {(() => {
                        const e = numberExpiry(n.next_billing_at);
                        if (!e) return <span className="text-muted-foreground">—</span>;
                        const expired = e.daysLeft < 0;
                        const dueSoon = e.daysLeft >= 0 && e.daysLeft <= 5;
                        return (
                          <>
                            <div className="whitespace-nowrap text-foreground xl:whitespace-normal">{format(e.date, "MMM d, yyyy")}</div>
                            <div className={`whitespace-nowrap text-xs xl:whitespace-normal ${expired ? "text-destructive font-medium" : dueSoon ? "text-yellow-500" : "text-muted-foreground"}`}>
                              {expired ? "expired" : `${e.daysLeft} day${e.daysLeft === 1 ? "" : "s"} left`}
                            </div>
                          </>
                        );
                      })()}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <RowActions
                        onTest={() => openTest(n)}
                        onSettings={() => openSettings(n)}
                        onDelete={() => handleDelete(n)}
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
          totalCount={sortedNumbers.length}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
          pageSizeOptions={PAGE_SIZE_OPTIONS}
        />
      </div>

      <CreatePhoneNumberDialog
        open={open}
        onOpenChange={setOpen}
        // BYOT goes to the dedicated endpoint (import or purchase on the user's own Twilio account).
        // Otherwise a standard number is created; the backend may answer with a Stripe checkout URL.
        onCreate={async (d) => {
          const status = d.active ? "Active" : "Inactive";

          if (d.serviceProvider === "BYOT") {
            const { data, error } = await api.createByotPhoneNumber({
              mode: d.byotMode || "import",
              credential_id: d.byotCredentialId,
              number: d.byotNumber || undefined,
              agent_id: d.agentId || undefined,
              status,
            });
            if (error) return toast.error(error);
            toast.success(`Phone number ${data?.number || ""} connected`);
            fetchNumbers();
            return;
          }

          const payload: Record<string, any> = {
            status,
            provider: d.serviceProvider,
          };
          if (d.agentId) payload.agent_id = d.agentId;
          // Twilio: if the wallet has ≥ $3 it's deducted from balance; otherwise the
          // backend returns a Stripe checkout URL to pay for this number directly.
          const { data, error } = await api.createPhoneNumber(payload);
          if (error) return toast.error(error);
          if (data?.checkout_url) {
            window.location.href = data.checkout_url;
            return;
          }
          toast.success(`Phone number ${data?.number || ""} created`);
          fetchNumbers();
        }}
      />

      {/* Place test call modal */}
      <TestCallDialog
        target={testTarget}
        log={testLog}
        stage={callStage}
        onPlace={placeTestCall}
        onClose={closeTest}
      />

      {/* Settings modal */}
      <Dialog open={!!settingsTarget} onOpenChange={(o) => !o && setSettingsTarget(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Number Settings</DialogTitle>
            <DialogDescription>Reassign agent or change status.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Assigned Agent</Label>
              <Select
                value={settingsForm.agent_id || "__none__"}
                onValueChange={(v) => setSettingsForm((f) => ({ ...f, agent_id: v === "__none__" ? null : v }))}
              >
                <SelectTrigger><SelectValue placeholder="Select an agent" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">No agent assigned</SelectItem>
                  {Array.from(agentsById.entries()).map(([id, name]) => (
                    <SelectItem key={id} value={id}>{name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Provider</Label>
                <Input value={providerLabel(settingsForm.provider)} readOnly disabled />
              </div>
              <div className="space-y-2">
                <Label>Status</Label>
                <Select value={settingsForm.status} onValueChange={(v) => setSettingsForm((f) => ({ ...f, status: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Active">Active</SelectItem>
                    <SelectItem value="Inactive">Inactive</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setSettingsTarget(null)}>Cancel</Button>
            <Button onClick={saveSettings}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

// How long (seconds) a freshly created VAPI number is shown as "Activating" in the UI.
const ACTIVATION_SECS = 120;

/**
 * Status cell for a number. Shows an "Activating m:ss" countdown for a VAPI number created
 * less than ACTIVATION_SECS ago, then "Suspended" if the wallet balance suspended it, else
 * the Active/Inactive badge. The countdown is local only and starts once on mount.
 */
function NumberStatus({ num }: { num: Num }) {
  const [remaining, setRemaining] = useState<number>(() => {
    if ((num.provider || "").toLowerCase() !== "vapi" || !num.vapi_phone_id || !num.created_at) return 0;
    const elapsed = Math.floor((Date.now() - new Date(num.created_at).getTime()) / 1000);
    return Math.max(0, ACTIVATION_SECS - elapsed);
  });
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (remaining <= 0) return;
    timerRef.current = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) { clearInterval(timerRef.current!); return 0; }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(timerRef.current!);
  }, []);

  if (remaining > 0) {
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-yellow-500/40 bg-yellow-500/10 px-2.5 py-0.5 text-xs font-medium text-yellow-500">
        <Clock className="h-3 w-3 animate-pulse" />
        Activating {m}:{String(s).padStart(2, "0")}
      </span>
    );
  }

  if (num.suspended_for_balance) {
    return <Badge variant="destructive" className="whitespace-nowrap xl:whitespace-normal">Suspended — add funds</Badge>;
  }

  return <Badge variant={num.status === "Active" ? "default" : "secondary"}>{num.status}</Badge>;
}

// Dial pad layout as [digit, letters] pairs.
const DIAL_KEYS: [string, string][] = [
  ["1", ""], ["2", "ABC"], ["3", "DEF"],
  ["4", "GHI"], ["5", "JKL"], ["6", "MNO"],
  ["7", "PQRS"], ["8", "TUV"], ["9", "WXYZ"],
  ["+", ""], ["0", ""], ["#", ""],
];

// Badge label and styling per call stage; null (idle) hides the badge.
const CALL_STAGE_META:Record<CallStage, { label: string; className: string } | null> = {
  idle: null,
  dialing: { label: "Dialing…", className: "border-info/40 bg-info/10 text-info" },
  queued: { label: "Queued", className: "border-yellow-500/40 bg-yellow-500/10 text-yellow-500" },
  ringing: { label: "Ringing…", className: "border-info/40 bg-info/10 text-info" },
  "in-progress": { label: "In progress", className: "border-success/40 bg-success/10 text-success" },
  ended: { label: "Call ended", className: "border-muted-foreground/30 bg-muted text-muted-foreground" },
  failed: { label: "Call failed", className: "border-destructive/40 bg-destructive/10 text-destructive" },
};

/**
 * Modal with a dial pad for placing a test call from `target`. Props: `log` (latest entry is
 * shown), `stage` (drives the badge and disables input while a call is active), `onPlace`
 * (parent performs the API call) and `onClose`. Holds only the typed destination number.
 */
function TestCallDialog({
  target, log, stage, onPlace, onClose,
}: {
  target: Num | null;
  log: string[];
  stage: CallStage;
  onPlace: (n: Num, to: string) => Promise<void>;
  onClose: () => void;
}) {
  const [to, setTo] = useState("");
  const isBusy = stage === "dialing" || stage === "queued" || stage === "ringing" || stage === "in-progress";
  const meta = CALL_STAGE_META[stage];

  // Clear the typed number each time the dialog is opened for a target.
  useEffect(() => {
    if (target) setTo("");
  }, [target]);

  const pressKey = (k: string) => setTo((v) => v + k);
  const backspace = () => setTo((v) => v.slice(0, -1));

  return (
    <Dialog open={!!target} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Place test call</DialogTitle>
          <DialogDescription>Enter any phone number to place a real test call and hear your agent in action.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {meta && (
            <div className={`flex items-center justify-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${meta.className}`}>
              {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : stage === "failed" ? <PhoneOff className="h-3.5 w-3.5" /> : <PhoneCall className="h-3.5 w-3.5" />}
              {meta.label}
            </div>
          )}

          <div className="flex items-center gap-1 rounded-xl border border-border bg-muted/30 px-3 py-2">
            <Input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="+1 (555) 123-4567"
              disabled={isBusy}
              className="h-8 border-0 bg-transparent p-0 text-center font-mono text-lg tracking-wide shadow-none focus-visible:ring-0"
            />
            <button
              type="button"
              onClick={backspace}
              disabled={!to || isBusy}
              className="shrink-0 rounded-full p-2.5 sm:p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
              aria-label="Backspace"
            >
              <Delete className="h-4 w-4" />
            </button>
          </div>

          <div className="grid grid-cols-3 gap-2 justify-items-center">
            {DIAL_KEYS.map(([digit, sub]) => (
              <button
                key={digit}
                type="button"
                disabled={isBusy}
                onClick={() => pressKey(digit)}
                className="flex h-12 w-12 flex-col items-center justify-center rounded-full bg-muted/50 text-foreground transition-colors hover:bg-muted disabled:opacity-40"
              >
                <span className="text-base font-semibold leading-none">{digit}</span>
                {sub && <span className="mt-0.5 text-[8px] tracking-widest text-muted-foreground">{sub}</span>}
              </button>
            ))}
          </div>

          <div className="flex justify-center">
            <button
              type="button"
              onClick={() => target && onPlace(target, to)}
              disabled={!to.trim() || isBusy}
              aria-label="Place call"
              className="flex h-12 w-12 items-center justify-center rounded-full bg-success text-success-foreground shadow-md transition-transform hover:scale-105 hover:bg-success/90 disabled:pointer-events-none disabled:opacity-40"
            >
              {isBusy ? <Loader2 className="h-5 w-5 animate-spin" /> : <PhoneCall className="h-5 w-5" />}
            </button>
          </div>

          {log.length > 0 && (
            <p className="text-center text-xs text-muted-foreground">{log[log.length - 1]}</p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default PhoneNumbers;
