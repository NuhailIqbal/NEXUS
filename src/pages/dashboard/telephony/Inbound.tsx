/**
 * AI Receptionist page (route /dashboard/telephony/inbound). Lists inbound queues
 * ("receptionists"), each pairing an AI agent with a phone number, and shows summary
 * stats from recent inbound calls. Each card can switch caller verification (only mobile
 * numbers reach the agent) on or off for its number, and, in its settings, the hours the receptionist
 * answers (callers outside them are told the line is closed). Uses api.getInboundQueues/
 * createInboundQueue/updateInboundQueue/deleteInboundQueue, getAgents, getPhoneNumbers,
 * updatePhoneNumber, getCallerVerificationStatus, getAnswerHoursStatus, getConversations and
 * confirmPhonePurchase (Stripe checkout return).
 */
import { useEffect, useState, useCallback, useRef } from "react";
import {
  PhoneIncoming, Plus, Phone, Bot, Loader2, Trash2,
  CheckCircle2, Settings as SettingsIcon,
  Copy, Headphones, TrendingUp, Activity, Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem,
  SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { CallerVerificationSwitch } from "@/components/telephony/CallerVerificationSwitch";
import { isCallerVerificationStatus, type CallerVerificationStatus } from "@/lib/callerVerification";
import { CallingHoursFields } from "@/components/hours/CallingHoursFields";
import { CreateReceptionistDialog, type NewReceptionist } from "@/components/telephony/CreateReceptionistDialog";
import {
  NUMBER_PREFIX, defaultHours, describeNextOpen, hoursFromRow, hoursToPayload, sameHours, validateHours,
  type CallingHours, type HoursState,
} from "@/components/hours/callingHours";
import { api } from "@/services/api";
import { toast } from "sonner";

type Agent = { id: string; name: string; voice?: string; status: string; vapi_assistant_id?: string };
type PhoneNumber = {
  id: string; number: string; status: string; agent_id?: string; vapi_phone_id?: string;
  caller_verification_enabled?: boolean;
  // Answering hours (answer_hours_*) as stored, and the server's view of them right now.
  answer_hours_enabled?: boolean;
  answer_hours_timezone?: string;
  answer_hours_state?: HoursState;
};
type Receptionist = {
  id: string;
  name: string;
  status: string;
  agent_id: string;
  phone_number_id?: string;
  max_wait_seconds: number;
  overflow_action: string;
};
type CallLog = {
  id: string;
  status: string;
  duration?: number;
  call_time?: string;
  customer_number?: string;
  agent_id?: string;
  ai_summary?: string;
  direction?: string;
};

/** sessionStorage key holding the answering hours chosen in the create dialog across the Stripe checkout redirect. */
const PENDING_HOURS_KEY = "nexus_pending_receptionist_hours";

/** Small tile showing an icon, a headline value and a label in the stats bar. */
function StatCard({ icon: Icon, label, value, color }: { icon: any; label: string; value: string | number; color: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 flex items-center gap-4">
      <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ${color}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0">
        <div className="text-2xl font-bold text-foreground">{value}</div>
        <div className="text-xs text-muted-foreground">{label}</div>
      </div>
    </div>
  );
}

/** Formats a duration in seconds as "Xm Ys", or just "Ys" when under a minute. */
function formatDuration(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/**
 * Page component: loads queues, agents, phone numbers and the latest 50 inbound calls,
 * and provides create / settings / delete flows for receptionists. Creating one may
 * redirect to Stripe checkout; the return is handled by an effect on the URL query.
 */
const Inbound = () => {
  const [receptionists, setReceptionists] = useState<Receptionist[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [phones, setPhones] = useState<PhoneNumber[]>([]);
  const [callLogs, setCallLogs] = useState<CallLog[]>([]);
  const [loading, setLoading] = useState(true);
  // Whether the server can run caller verification at all (null until loaded), and the number
  // whose switch is mid-save (its switch is locked so a second click can't overlap the first).
  const [verifyStatus, setVerifyStatus] = useState<CallerVerificationStatus | null>(null);
  // Whether the server can run answering hours at all (null until loaded; a failed load means "unknown", allowed).
  const [hoursStatus, setHoursStatus] = useState<CallerVerificationStatus | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  // Numbers not already answering inbound calls — reusable instead of buying a new one.
  const availableNumbers = phones.filter((p) => !p.agent_id && p.vapi_phone_id);

  const [settingsTarget, setSettingsTarget] = useState<Receptionist | null>(null);
  const [settingsForm, setSettingsForm] = useState({ name: "", agent_id: "", status: "" });
  // The receptionist's answering hours as the dialog edits them, and as they were when it opened.
  const [settingsHours, setSettingsHours] = useState<CallingHours>(defaultHours());
  const [savedHours, setSavedHours] = useState<CallingHours>(defaultHours());
  const [savingSettings, setSavingSettings] = useState(false);

  const agentsMap = new Map(agents.map((a) => [a.id, a]));
  const phonesMap = new Map(phones.map((p) => [p.id, p]));

  // Reloads all data sets in parallel; each state is only replaced when the
  // response is valid, so a failed request keeps the previous data. Only the latest reload is
  // applied: an older one finishing last (e.g. after two quick toggles) would show stale values.
  const fetchSeq = useRef(0);
  const fetchAll = useCallback(async () => {
    const seq = ++fetchSeq.current;
    const [qRes, aRes, pRes, cRes, vRes, hRes] = await Promise.all([
      api.getInboundQueues(),
      api.getAgents(),
      api.getPhoneNumbers(),
      api.getConversations("direction=inbound&limit=50"),
      api.getCallerVerificationStatus(),
      api.getAnswerHoursStatus(),
    ]);
    if (seq !== fetchSeq.current) return;
    if (Array.isArray(qRes.data)) setReceptionists(qRes.data);
    if (Array.isArray(aRes.data)) setAgents(aRes.data);
    if (Array.isArray(pRes.data)) setPhones(pRes.data);
    if (Array.isArray(cRes.data)) setCallLogs(cRes.data);
    if (isCallerVerificationStatus(vRes.data)) setVerifyStatus(vRes.data);
    if (isCallerVerificationStatus(hRes.data)) setHoursStatus(hRes.data);
    setLoading(false);
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Handle the return from Stripe checkout (low-balance receptionist purchase).
  // The ref guards against confirming the same session twice (e.g. StrictMode double effects).
  const confirming = useRef(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const purchase = params.get("purchase");
    if (!purchase) return;
    const cleanUrl = () => window.history.replaceState({}, "", window.location.pathname);

    if (purchase === "canceled") {
      toast.info("Purchase canceled. No receptionist was created.");
      cleanUrl();
      return;
    }
    if (purchase === "success") {
      const sessionId = params.get("session_id");
      if (!sessionId || confirming.current) { cleanUrl(); return; }
      confirming.current = true;
      const t = toast.loading("Payment received. Setting up your receptionist…");
      api.confirmPhonePurchase(sessionId).then(({ data, error }) => {
        toast.dismiss(t);
        if (error || !data) toast.error(error || "Could not finish setting up the receptionist after payment.");
        else toast.success(`Number ${data.number || ""} purchased and receptionist created.`);
        cleanUrl();
        // Hours chosen before the card payment were kept for this return: put them on the new number.
        let pending: string | null = null;
        try { pending = sessionStorage.getItem(PENDING_HOURS_KEY); sessionStorage.removeItem(PENDING_HOURS_KEY); } catch { /* none */ }
        if (pending && data?.id && !error) {
          api.updatePhoneNumber(data.id, JSON.parse(pending)).then(({ error: hoursError }) => {
            if (hoursError) toast.error(`The receptionist was created, but its answering hours were not saved: ${hoursError} You can set them in its Settings.`);
            fetchAll();
          });
        } else {
          fetchAll();
        }
      });
    }
  }, []);

  // Stats are derived from the fetched page of inbound calls only (limit 50), not all-time totals.
  // Average duration ignores calls with no recorded duration.
  const totalCalls = callLogs.length;
  const completedCalls = callLogs.filter((c) => c.status === "Completed").length;
  const avgDuration = callLogs.filter((c) => c.duration).length > 0
    ? Math.round(callLogs.filter((c) => c.duration).reduce((s, c) => s + (c.duration ?? 0), 0) / callLogs.filter((c) => c.duration).length)
    : 0;
  const activeReceptionists = receptionists.filter((r) => r.status === "Active").length;

  /**
   * Creates the receptionist the wizard (CreateReceptionistDialog) describes via
   * api.createInboundQueue; then, when answering hours were switched on, saves them on the
   * receptionist's number (they live on the number). If the backend returns a Stripe checkout_url
   * (low wallet balance) the hours are kept in sessionStorage for the return from checkout (see
   * PENDING_HOURS_KEY) and the browser is redirected there; otherwise the dialog is closed and the
   * data reloaded.
   */
  const handleCreate = async (createForm: NewReceptionist) => {
    const createHours = createForm.hours;
    setCreating(true);
    // Reusing an existing unassigned number just reassigns it (no purchase). Otherwise
    // a new Twilio number is bought — from the wallet if it covers it, or Stripe checkout
    // if the balance is low.
    const { data, error } = await api.createInboundQueue({
      name: createForm.name,
      agent_id: createForm.agent_id,
      phone_number_id: createForm.phone_number_id || undefined,
      status: "Active",
      success_url: `${window.location.origin}/dashboard/telephony/inbound`,
    });
    setCreating(false);
    if (error) return toast.error(error);
    if (data?.checkout_url) {
      if (createHours.enabled) {
        try { sessionStorage.setItem(PENDING_HOURS_KEY, JSON.stringify(hoursToPayload(createHours, NUMBER_PREFIX))); } catch { /* hours can be set in Settings later */ }
      }
      window.location.href = data.checkout_url;
      return;
    }
    toast.success(
      createForm.phone_number_id
        ? "AI Receptionist created. Existing number reassigned!"
        : "AI Receptionist created. Phone number provisioned!"
    );
    // The receptionist exists now; the hours go on its number. If that is refused (for instance
    // the server cannot route calls yet) the receptionist is kept and the user is told where to retry.
    if (createHours.enabled && data?.phone_number_id) {
      const { error: hoursError } = await api.updatePhoneNumber(data.phone_number_id, hoursToPayload(createHours, NUMBER_PREFIX));
      if (hoursError) toast.error(`The receptionist was created, but its answering hours were not saved: ${hoursError} You can set them in its Settings.`);
    }
    setCreateOpen(false);
    fetchAll();
  };

  /** Deletes a receptionist via api.deleteInboundQueue (no confirmation prompt) and refreshes the list. */
  const handleDelete = async (r: Receptionist) => {
    const { error } = await api.deleteInboundQueue(r.id);
    if (error) return toast.error(error);
    toast.success("Receptionist removed");
    fetchAll();
  };

  /** Opens the settings dialog, prefilling the form with the receptionist's current values. */
  const openSettings = (r: Receptionist) => {
    setSettingsTarget(r);
    setSettingsForm({ name: r.name, agent_id: r.agent_id, status: r.status });
    const phone = r.phone_number_id ? phonesMap.get(r.phone_number_id) : undefined;
    const hours = hoursFromRow(phone as unknown as Record<string, unknown> | undefined, NUMBER_PREFIX);
    setSettingsHours(hours);
    setSavedHours(hours);
  };

  /**
   * Saves name, agent and status via api.updateInboundQueue, and the answering hours (stored on the
   * receptionist's number) via api.updatePhoneNumber when they were changed, then closes the dialog
   * and reloads. The hours go first: they are the part the server can refuse (for instance when it
   * cannot route calls), and a refusal then leaves everything as it was.
   */
  const saveSettings = async () => {
    if (!settingsTarget) return;
    const phone = settingsTarget.phone_number_id ? phonesMap.get(settingsTarget.phone_number_id) : undefined;
    const hoursChanged = !!phone && !sameHours(settingsHours, savedHours);
    if (hoursChanged) {
      const problem = validateHours(settingsHours);
      if (problem) return toast.error(problem);
    }
    setSavingSettings(true);
    if (hoursChanged && phone) {
      const { error } = await api.updatePhoneNumber(phone.id, hoursToPayload(settingsHours, NUMBER_PREFIX));
      if (error) { setSavingSettings(false); return toast.error(error); }
    }
    const { error } = await api.updateInboundQueue(settingsTarget.id, settingsForm);
    setSavingSettings(false);
    if (error) { fetchAll(); return toast.error(error); }
    toast.success("Receptionist updated");
    setSettingsTarget(null);
    fetchAll();
  };

  /**
   * Turns caller verification on or off for a receptionist's number (PATCH the number itself, the
   * same field the Phone Numbers page edits). While the request runs the switch shows the pending
   * value (locked); if the server refuses, it snaps back and the reason is shown, so what stays on
   * screen is always what is really in effect.
   */
  const toggleVerification = async (phone: PhoneNumber, enabled: boolean) => {
    if (togglingId) return;
    setTogglingId(phone.id);
    const { error } = await api.updatePhoneNumber(phone.id, { caller_verification_enabled: enabled });
    if (error) {
      setTogglingId(null);
      return toast.error(error);
    }
    // The server accepted it: record the new value locally BEFORE releasing the lock. Otherwise the
    // switch would fall back to the old value until the reload below lands (and stay wrong if it fails).
    setPhones((list) => list.map((p) => (p.id === phone.id ? { ...p, caller_verification_enabled: enabled } : p)));
    setTogglingId(null);
    toast.success(enabled ? "Caller verification turned on" : "Caller verification turned off");
    fetchAll();
  };

  /** Copies a phone number to the clipboard and shows a confirmation toast. */
  const copyNumber = (num: string) => {
    navigator.clipboard.writeText(num);
    toast.success("Number copied to clipboard");
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading…
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">AI Receptionist</h1>
          <p className="text-sm text-muted-foreground">
            AI agents that answer inbound calls instantly, with no hold times: around the clock, or only during the hours you set.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="w-full sm:w-auto">
          <Plus className="mr-2 h-4 w-4" /> New Receptionist
        </Button>
      </div>

      {/* Stats Bar */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard icon={Headphones}   label="Active Receptionists" value={activeReceptionists}             color="bg-primary/10 text-primary" />
        <StatCard icon={PhoneIncoming} label="Total Inbound Calls" value={totalCalls}                      color="bg-blue-500/10 text-blue-600" />
        <StatCard icon={CheckCircle2} label="Completed Calls"      value={completedCalls}                  color="bg-green-500/10 text-green-600" />
        <StatCard icon={Activity}     label="Avg Duration"         value={avgDuration > 0 ? formatDuration(avgDuration) : " "} color="bg-purple-500/10 text-purple-600" />
      </div>

      {/* Receptionist Cards */}
      {receptionists.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card/50 p-16 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
            <PhoneIncoming className="h-7 w-7 text-primary" />
          </div>
          <h3 className="mt-4 text-lg font-semibold text-foreground">No receptionists yet</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Create your first AI receptionist we'll provision a phone number automatically.
          </p>
          <Button className="mt-4" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" /> Create Receptionist
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {receptionists.map((r) => {
            const phone = r.phone_number_id ? phonesMap.get(r.phone_number_id) : undefined;
            const agent = agentsMap.get(r.agent_id);
            const isActive = r.status === "Active";
            return (
              <div
                key={r.id}
                className={`rounded-xl border bg-card p-5 transition-shadow hover:shadow-md ${isActive ? "border-primary/30 shadow-sm shadow-primary/10" : "border-border"}`}
              >
                {/* Top */}
                <div className="flex items-start justify-between gap-2">
                  <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${isActive ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                    <PhoneIncoming className="h-5 w-5" />
                  </div>
                  <span className={`whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold ${isActive ? "border-green-500/20 bg-green-500/15 text-green-600" : "border-border bg-muted text-muted-foreground"}`}>
                    {r.status}
                  </span>
                </div>

                {/* Info */}
                <h3 className="mt-4 break-words font-semibold text-foreground">{r.name}</h3>
                <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Bot className="h-3 w-3 shrink-0" />
                  <span className="min-w-0">{agent?.name ?? "Unassigned Agent"}</span>
                </div>

                {/* Phone number highlight */}
                {phone ? (
                  <div className="mt-4 rounded-lg border border-primary/25 bg-primary/5 p-3.5">
                    <div className="text-[10px] font-semibold uppercase tracking-widest text-primary mb-2">Inbound Number</div>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <Phone className="h-4 w-4 shrink-0 text-primary" />
                        <span className="truncate text-lg font-bold tracking-wide text-foreground">{phone.number}</span>
                      </div>
                      <button
                        onClick={() => copyNumber(phone.number)}
                        className="shrink-0 rounded-md p-2.5 sm:p-1.5 text-muted-foreground hover:bg-primary/10 hover:text-primary transition-colors"
                        title="Copy number"
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <div className="mt-1.5 text-[11px] text-muted-foreground">
                      Call this number your AI agent answers instantly
                    </div>
                  </div>
                ) : (
                  <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                    No phone number linked yet
                  </div>
                )}

                {/* Caller verification belongs to the number, so it only appears once one is linked. */}
                {phone && (
                  <div className="mt-3">
                    <CallerVerificationSwitch
                      id={`verify-${r.id}`}
                      checked={togglingId === phone.id ? !phone.caller_verification_enabled : !!phone.caller_verification_enabled}
                      onCheckedChange={(v) => toggleVerification(phone, v)}
                      disabled={togglingId !== null}
                      unavailableReason={verifyStatus && !verifyStatus.available ? verifyStatus.reason : null}
                    />
                  </div>
                )}

                {/* Answering hours: shown only while they are on. */}
                {phone?.answer_hours_state?.enabled && (
                  <div className="mt-3 flex items-start gap-1.5 text-xs text-muted-foreground">
                    <Clock className="mt-0.5 h-3 w-3 shrink-0" />
                    <span className="min-w-0">
                      Answers {phone.answer_hours_state.summary}
                      {" · "}
                      {phone.answer_hours_state.open
                        ? <span className="font-medium text-success">Open now</span>
                        : <span className="font-medium text-warning">
                            Closed{describeNextOpen(phone.answer_hours_state, phone.answer_hours_timezone) ? ` — opens ${describeNextOpen(phone.answer_hours_state, phone.answer_hours_timezone)}` : ""}
                          </span>}
                    </span>
                  </div>
                )}

                {/* Actions */}
                <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3">
                  <button
                    onClick={() => openSettings(r)}
                    className="rounded-md p-2.5 sm:p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                    title="Settings"
                  >
                    <SettingsIcon className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => handleDelete(r)}
                    className="rounded-md p-2.5 sm:p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                    title="Delete"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create wizard */}
      <CreateReceptionistDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        agents={agents.filter((a) => a.vapi_assistant_id)}
        availableNumbers={availableNumbers}
        creating={creating}
        hoursUnavailableReason={hoursStatus && !hoursStatus.available ? hoursStatus.reason : null}
        onCreate={handleCreate}
      />

      {/* Settings Dialog */}
      <Dialog open={!!settingsTarget} onOpenChange={(o) => !o && !savingSettings && setSettingsTarget(null)}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader className="text-left">
            <DialogTitle className="flex items-center gap-2 pr-6">
              <SettingsIcon className="h-5 w-5 shrink-0 text-primary" />
              Receptionist Settings
            </DialogTitle>
            <DialogDescription>Update name, agent, status, and when it answers.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={settingsForm.name} onChange={(e) => setSettingsForm((f) => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>AI Agent</Label>
                <Select value={settingsForm.agent_id} onValueChange={(v) => setSettingsForm((f) => ({ ...f, agent_id: v }))}>
                  <SelectTrigger><SelectValue placeholder="Select an agent…" /></SelectTrigger>
                  <SelectContent>
                    {agents.filter((a) => a.vapi_assistant_id).map((a) => (
                      <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
            {settingsTarget?.phone_number_id ? (
              <CallingHoursFields
                idPrefix="receptionist-hours"
                value={settingsHours}
                onChange={setSettingsHours}
                disabled={savingSettings}
                switchLabel="Only answer during set hours"
                description="Off: the receptionist answers every call, at any time. On: it answers only on these days, between these times. Callers outside them hear that you are closed and the call ends."
                startLabel="Answers from"
                endLabel="Answers until"
                unavailableReason={hoursStatus && !hoursStatus.available ? hoursStatus.reason : null}
              />
            ) : (
              <p className="text-xs text-muted-foreground">Answering hours can be set once this receptionist has a phone number.</p>
            )}
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setSettingsTarget(null)} disabled={savingSettings}>Cancel</Button>
            <Button onClick={saveSettings} disabled={savingSettings}>
              {savingSettings && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Inbound;
