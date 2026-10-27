/**
 * Outbound campaigns dashboard page (routes telephony/outbound and telephony/campaigns).
 * Uses api.getCampaigns/createCampaign/updateCampaign/deleteCampaign/startCampaign/
 * pauseCampaign/resumeCampaign plus getAgents, getPhoneNumbers, getContacts and
 * getAnalyticsOverview, and api.getCampaignsLive (polled every few seconds while a campaign is running)
 * for the live dialing panel on each card. Campaign creation is delegated to CreateCampaignDialog.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Plus, PhoneOutgoing, Play, Pause as PauseIcon,
  CheckCircle2, XCircle, Loader2, AlertTriangle, Rocket,
  Users, TrendingUp, Radio, BarChart2, Bot, Phone, Clock, Repeat, ListChecks, Gauge,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { CreateCampaignDialog, EditCampaignDialog, type CampaignData } from "@/components/telephony/CreateCampaignDialog";
import { RowActions } from "@/components/dashboard/RowActions";
import { CampaignNumbersDialog } from "@/components/telephony/CampaignNumbersDialog";
import {
  describeFollowupCard, describeRetryShort, retryFromRow, retryOutcomesNote, retryToPayload,
  type FollowupInfo, type RetryStats,
} from "@/lib/callRetry";
import { formatDue } from "@/components/callbacks/callbackTypes";
import {
  LIVE_STATE_LABELS, describeDialingShort, dialingFromRow, dialingToPayload, secondsBetween, stallMessage,
  type DialingInfo, type LiveState,
} from "@/lib/dialingStrategy";
import {
  CAMPAIGN_PREFIX, describeNextOpen, hoursFromRow, hoursToPayload,
  type HoursState,
} from "@/components/hours/callingHours";
import { api } from "@/services/api";
import { toast } from "sonner";

/** Campaign row from GET /telephony/campaigns; effectiveStatus is derived client-side. */
type Campaign = {
  id: string;
  name: string;
  status: string;
  effectiveStatus?: string;
  agent_id: string;
  list_id: string;
  phone_number_id: string | null;
  contacts_count: number;
  completed_count: number;
  // Calling hours (call_hours_*) as stored, the server's view of them right now, and where a run
  // that the hours stopped will carry on (set while the campaign waits for the next opening).
  call_hours_enabled?: boolean;
  call_hours_timezone?: string;
  call_hours_state?: HoursState;
  dial_cursor?: string | null;
  // True while the calling hours have stopped a run and the campaign will carry on by itself the next
  // time they open (next_at, UTC; null = they are open now, so within the next minute).
  auto_resume?: { pending: boolean; next_at: string | null };
  // Call retry settings (retry_*) and the counts the list returns with each campaign.
  dnc_screening_enabled?: boolean;
  retry_enabled?: boolean;
  retry_max_attempts?: number;
  retry_interval_minutes?: number;
  retry_on?: string[];
  retry_stats?: RetryStats;
  // Second-chance rounds: the settings as stored, and where the rounds stand (done, when the next one starts).
  followup_rounds?: number;
  followup_gap_hours?: number;
  followup?: FollowupInfo;
  // Dialing strategy (dial_*) as stored, and the server's view of it: the settings with the account's
  // cap applied, any warnings, and whether a run is open.
  dial_strategy?: string;
  dial_concurrent_calls?: number;
  dial_calls_per_minute?: number;
  dial_delay_seconds?: number;
  dial_running?: boolean;
  dialing?: DialingInfo;
};

/** What POST /start and /resume answer (the legacy keys are still there; the first tick's numbers). */
type StartResult = {
  started?: boolean;
  resumed?: boolean;
  already_running?: boolean;
  strategy?: string;
  dialed?: number;
  placed?: number;
  queued?: number;
  active_now?: number;
  errors?: number;
  error_details?: { phone: string; error: string }[];
  suppressed?: number;
  already_on_call?: number;
  capped?: { requested: number; effective: number; reason?: string } | null;
  stopped_by_hours?: boolean;
  next_open_at?: string | null;
  stopped_by_person?: boolean;
  remaining?: number;
};

/** How often the live dialing numbers are refreshed while a campaign is running. */
const LIVE_POLL_MS = 4000;

/** One toast per warning the server sent along with a save or a start (the wizard has closed by then). */
const showWarnings = (warnings?: string[]) => {
  for (const w of warnings ?? []) toast.warning(w);
};

/** The provider's own error text may name it; the page never does. */
const scrub = (text: string) => text.replace(/vapi/gi, "the call service");

/** "3 calls", "1 call". */
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** "updated 3 s ago": its own small component, so the page does not re-render every second for it. */
function UpdatedAgo({ at }: { at: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return <>updated {Math.max(0, Math.round((Date.now() - at) / 1000))} s ago</>;
}

/** One row of the pre-launch checklist dialog. */
type CheckItem = {
  label: string;
  status: "loading" | "pass" | "fail" | "warn";
  detail?: string;
};

/** Summary tile (icon, big value, label) used in the stats bar. */
function StatCard({ icon: Icon, label, value, color }: { icon: any; label: string; value: string | number; color: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 flex items-center gap-4 lg:flex-col lg:items-start lg:gap-3 xl:flex-row xl:items-center xl:gap-4">
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

/**
 * The pre-launch row for the calling hours: fails (and so blocks Launch) while a campaign with
 * hours switched on is closed, passes otherwise. Based on the state the server sent with the list;
 * the server checks again when the campaign starts.
 */
function hoursCheck(c: Campaign): CheckItem {
  const label = "Inside calling hours";
  const st = c.call_hours_state;
  if (!st?.enabled) return { label, status: "pass", detail: "No calling-hours limit" };
  if (st.open) return { label, status: "pass", detail: `${st.summary} ✓` };
  const next = describeNextOpen(st, c.call_hours_timezone);
  return { label, status: "fail", detail: `Closed right now${next ? `, opens ${next}` : ""}` };
}

/** Badge classes per displayed status; unknown statuses fall back to Inactive. */
const STATUS_COLOR: Record<string, string> = {
  Active: "bg-green-500/15 text-green-600 border-green-500/20",
  Paused: "bg-yellow-500/15 text-yellow-600 border-yellow-500/20",
  Inactive: "bg-muted text-muted-foreground border-border",
  Completed: "bg-blue-500/15 text-blue-600 border-blue-500/20",
};

/**
 * Campaign management page: stats, campaign cards, create/settings dialogs and the
 * pre-launch checklist. Polls campaigns every 30s while mounted.
 */
const Outbound = () => {
  const [open, setOpen] = useState(false);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [agentsById, setAgentsById] = useState<Map<string, string>>(new Map());
  const [phoneNumbersById, setPhoneNumbersById] = useState<Map<string, string>>(new Map());
  const [qualified, setQualified] = useState(0);
  const [loading, setLoading] = useState(true);

  const [settingsTarget, setSettingsTarget] = useState<Campaign | null>(null);
  const [numbersTarget, setNumbersTarget] = useState<Campaign | null>(null);

  const [preflightTarget, setPreflightTarget] = useState<Campaign | null>(null);
  const [checks, setChecks] = useState<CheckItem[]>([]);
  const [launching, setLaunching] = useState(false);
  // How many checklist rows have been revealed so far. Results arrive together, but are shown one by one.
  const [revealed, setRevealed] = useState(0);
  const shownChecks: CheckItem[] = checks.map((c, i) => (i < revealed ? c : { label: c.label, status: "loading" }));
  const checksSettled = checks.length > 0 && checks.every((c) => c.status !== "loading");
  useEffect(() => {
    if (!checksSettled || revealed >= checks.length) return;
    const t = setTimeout(() => setRevealed((r) => r + 1), 550);
    return () => clearTimeout(t);
  }, [checksSettled, revealed, checks.length]);

  // What the server is doing with each running campaign right now (GET /campaigns/live), and when it was read.
  const [live, setLive] = useState<Record<string, LiveState>>({});
  const [liveAt, setLiveAt] = useState(0);

  // A campaign whose every contact has a completed call has nothing left to dial — shown as
  // "Completed" regardless of its underlying Active/Paused status, which otherwise never
  // changes on its own once every contact has been reached.
  /** Adds effectiveStatus to each campaign (see the note above). */
  const withEffectiveStatus = (list: Campaign[]): Campaign[] =>
    list.map((c) => ({
      ...c,
      effectiveStatus:
        c.contacts_count > 0 && c.completed_count >= c.contacts_count ? "Completed" : c.status,
    }));

  /**
   * Loads campaigns, agent/phone-number name lookups and the qualified-calls total in
   * parallel, then clears the initial loading state.
   */
  const fetchCampaigns = async () => {
    const [campaignsRes, agentsRes, phonesRes, overviewRes] = await Promise.all([
      api.getCampaigns(), api.getAgents(), api.getPhoneNumbers(), api.getAnalyticsOverview(),
    ]);
    if (Array.isArray(campaignsRes.data)) setCampaigns(withEffectiveStatus(campaignsRes.data));
    if (Array.isArray(agentsRes.data))
      setAgentsById(new Map(agentsRes.data.map((a: any) => [a.id, a.name])));
    if (Array.isArray(phonesRes.data))
      setPhoneNumbersById(new Map(phonesRes.data.map((p: any) => [p.id, p.number])));
    if (overviewRes.data) setQualified((overviewRes.data as any).qualified_calls ?? 0);
    setLoading(false);
  };

  useEffect(() => {
    fetchCampaigns();
    // Refresh so campaign "contacted" progress updates as calls sync in.
    const t = setInterval(() => fetchCampaigns(), 30000);
    return () => clearInterval(t);
  }, []);

  /** One read of the live numbers (only while the tab is in view; a failure keeps the last numbers). */
  const fetchLive = useCallback(async () => {
    if (document.visibilityState !== "visible") return;
    try {
      const { data } = await api.getCampaignsLive();
      if (!data || typeof data !== "object" || Array.isArray(data)) return;
      setLive(data as Record<string, LiveState>);
      setLiveAt(Date.now());
    } catch {
      // keep showing the last numbers; the next poll tries again
    }
  }, []);

  // One read when the page loads, and another after every Start / Pause / Resume (see refreshAfterAction); the
  // 4 s poll below takes over from there while something is running.
  useEffect(() => { fetchLive(); }, [fetchLive]);

  // Poll the live numbers only while a campaign has a pass open (it is dialing, or waiting to), has calls open, or
  // is being started: a finished campaign stays Active but is not running, so an idle page makes no request.
  // Coming back to the tab refreshes straight away.
  const needsLive = launching || campaigns.some((c) => (c.dialing?.running ?? c.dial_running) === true || (live[c.id]?.active_now ?? 0) > 0);
  useEffect(() => {
    if (!needsLive) return;
    const t = setInterval(fetchLive, LIVE_POLL_MS);
    const onVisible = () => { if (document.visibilityState === "visible") fetchLive(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [needsLive, fetchLive]);

  /** After an action that changes what is running: the list and the live numbers, once. */
  const refreshAfterAction = () => { fetchCampaigns(); fetchLive(); };

  const totalContacts = campaigns.reduce((s, c) => s + (c.contacts_count || 0), 0);
  const totalDialed   = campaigns.reduce((s, c) => s + (c.completed_count || 0), 0);
  const activeCampaigns = campaigns.filter((c) => c.effectiveStatus === "Active").length;

  /** Pauses an Active campaign immediately; otherwise opens the pre-launch checks first. */
  const togglePlay = async (c: Campaign) => {
    if (c.status === "Active") {
      const { error } = await api.pauseCampaign(c.id);
      if (error) return toast.error(error);
      toast.success("Campaign paused");
      refreshAfterAction();
    } else {
      openPreflight(c);
    }
  };

  /**
   * Opens the checklist dialog and runs three checks in order, updating the list after
   * each: agent exists and is synced to VAPI, phone number is active, and the assigned
   * list has contacts with a phone number. Launch stays disabled until none fail.
   */
  const openPreflight = async (c: Campaign) => {
    setPreflightTarget(c);
    setRevealed(0);
    const init: CheckItem[] = [
      { label: "Agent assigned & synced", status: "loading" },
      { label: "Phone number assigned & active", status: "loading" },
      { label: "Contact list has dialable contacts", status: "loading" },
      hoursCheck(c),
    ];
    setChecks(init);
    const results: CheckItem[] = [...init];

    if (!c.agent_id) {
      results[0] = { ...init[0], status: "fail", detail: "No agent assigned to this campaign" };
    } else {
      const { data: agentData } = await api.getAgents();
      const agent = (agentData as any[])?.find((a: any) => a.id === c.agent_id);
      if (!agent) results[0] = { ...init[0], status: "fail", detail: "Agent not found" };
      else if (!agent.vapi_assistant_id) results[0] = { ...init[0], status: "fail", detail: `"${agent.name}" is not synced open the agent and click Sync agent` };
      else results[0] = { ...init[0], status: "pass", detail: `${agent.name} ✓` };
    }
    setChecks([...results]);

    if (!c.phone_number_id) {
      results[1] = { ...init[1], status: "fail", detail: "No phone number assigned edit the campaign and select one" };
    } else {
      const { data: numData } = await api.getPhoneNumbers();
      const num = (numData as any[])?.find((n: any) => n.id === c.phone_number_id);
      if (!num) results[1] = { ...init[1], status: "fail", detail: "Phone number not found" };
      else if (!num.vapi_phone_id) results[1] = { ...init[1], status: "fail", detail: `${num.number || "Number"} is not active yet` };
      else results[1] = { ...init[1], status: "pass", detail: `${num.number} ✓` };
    }
    setChecks([...results]);

    if (!c.list_id) {
      results[2] = { ...init[2], status: "fail", detail: "No contact list assigned edit the campaign and select a list" };
    } else {
      const { data: contacts } = await api.getContacts();
      const dialable = (contacts as any[])?.filter((ct: any) => ct.list_id === c.list_id && ct.phone?.trim());
      if (!dialable || dialable.length === 0) results[2] = { ...init[2], status: "fail", detail: "No contacts with phone numbers in the assigned list" };
      else results[2] = { ...init[2], status: "pass", detail: `${dialable.length} contact${dialable.length !== 1 ? "s" : ""} ready to dial` };
    }
    setChecks([...results]);
  };

  /**
   * Starts the campaign being checked (or continues it, when it is Paused part-way through its list) and
   * reports the outcome in a toast, then refreshes the list. The server answers once its first calls are
   * placed; the rest of the list is dialed in the background, so the toast describes the start, and the
   * card's live panel follows the rest.
   */
  const launchCampaign = async () => {
    if (!preflightTarget) return;
    setLaunching(true);
    // A Paused campaign is RESUMED, never started: with a pass left open the server carries on from where it
    // stopped, and with none (it had finished) resume only makes it Active again, so its redials go on and the whole
    // list is not dialed a second time. Only an Inactive (or Active, not running) campaign is started.
    const action = preflightTarget.status === "Paused" ? api.resumeCampaign : api.startCampaign;
    const { data, error, warnings } = await action(preflightTarget.id);
    setLaunching(false);
    setPreflightTarget(null);
    if (error) return toast.error(error);
    showWarnings(warnings);
    const res = (data ?? {}) as StartResult;
    // Resumed with no pass left open: it is Active again, nothing was dialed.
    if (action === api.resumeCampaign && res.started === undefined && res.already_running === undefined) {
      toast.success("Campaign resumed. Numbers waiting for a redial will go out as they come due.");
      refreshAfterAction();
      return;
    }
    // Someone (or the automatic continuing) already has it running: nothing was changed.
    if (res.already_running) {
      toast.info("This campaign is already running.");
      refreshAfterAction();
      return;
    }
    const dialed: number = res.placed ?? res.dialed ?? 0;
    const errors: number = res.errors ?? 0;
    const suppressed: number = res.suppressed ?? 0;
    const details = res.error_details ?? [];
    // A person paused (or changed) the campaign while it was starting: it stopped at the next call.
    if (res.stopped_by_person) {
      const left = res.remaining ?? 0;
      toast.info(`Stopped: ${dialed} called, ${left} contact${left !== 1 ? "s" : ""} left. Start carries on from the next contact.`);
      refreshAfterAction();
      return;
    }
    // The calling hours closed part-way: say how far it got and when the rest can be dialed.
    if (res.stopped_by_hours) {
      const remaining = res.remaining ?? 0;
      const next = describeNextOpen(
        { enabled: true, open: false, next_open_at: res.next_open_at ?? null, summary: null },
        preflightTarget.call_hours_timezone,
      );
      toast.warning(
        `Calling hours ended: ${dialed} called, ${remaining} contact${remaining !== 1 ? "s" : ""} left.` +
        (next ? ` It will continue automatically from the next contact when the hours open (${next}).` : " It will continue automatically when the hours open.")
      );
      refreshAfterAction();
      return;
    }
    // Suppressed numbers aren't failures — they were deliberately skipped by DNC screening,
    // so they're reported separately from provider errors.
    const onCall: number = res.already_on_call ?? 0;
    const skipped = (suppressed > 0 ? `, ${suppressed} skipped (DNC)` : "")
      + (onCall > 0 ? `, ${onCall} skipped (already on a call)` : "");
    if (dialed === 0 && errors > 0) {
      toast.error(`0 calls connected ${scrub(details[0]?.error ?? "Unknown error")}${skipped}`);
      refreshAfterAction();
      return;
    }
    // "Campaign started: 5 calls placed, 118 numbers queued (5 at a time)"
    const dial = dialingFromRow(preflightTarget as unknown as Record<string, unknown>);
    const strategy = res.strategy ?? dial.strategy;
    const how = strategy === "concurrent" ? `${res.capped?.effective ?? dial.concurrentCalls} at a time`
      : strategy === "paced" ? `${dial.callsPerMinute} per minute`
        : "one at a time";
    const message = `Campaign ${res.resumed ? "resumed" : "started"}: ${count(dialed, "call")} placed`
      + (res.queued != null ? `, ${count(res.queued, "number")} queued` : "")
      + ` (${how})`;
    if (errors > 0) toast.warning(`${message}, ${errors} failed${skipped}`);
    else if (suppressed > 0 || onCall > 0) toast.warning(`${message}${skipped}`);
    else toast.success(message);
    refreshAfterAction();
  };

  /**
   * Cancels the automatic continuing of a campaign the hours stopped (it stays Paused and keeps its
   * place: Start carries on from the next contact whenever the user wants).
   */
  const stopAutoResume = async (c: Campaign) => {
    const { error } = await api.pauseCampaign(c.id);
    if (error) return toast.error(error);
    toast.success("Automatic continuing stopped. Press Start whenever you want it to carry on.");
    refreshAfterAction();
  };

  /** Opens the edit wizard, which starts from the campaign's current values. */
  const openSettings = (c: Campaign) => setSettingsTarget(c);

  /** The campaign as the edit wizard's form. */
  const formOf = (c: Campaign): CampaignData => ({
    status: c.status,
    name: c.name,
    description: "",
    agentId: c.agent_id ?? "",
    listId: c.list_id ?? "",
    phoneNumberId: c.phone_number_id ?? "",
    dncScreeningEnabled: c.dnc_screening_enabled ?? true,
    hours: hoursFromRow(c as unknown as Record<string, unknown>, CAMPAIGN_PREFIX),
    retry: retryFromRow(c as unknown as Record<string, unknown>),
    dialing: dialingFromRow(c as unknown as Record<string, unknown>),
  });

  /**
   * PATCHes everything the edit wizard shows. Resolves false (the wizard stays open, with the reason in a
   * toast) when the server refuses; the list, number and agent are only sent when one is chosen.
   */
  const saveSettings = async (d: CampaignData): Promise<boolean> => {
    if (!settingsTarget) return false;
    const { error, warnings } = await api.updateCampaign(settingsTarget.id, {
      name: d.name,
      // The status goes only if the person changed it in the dialog: sending the value it opened with would set a
      // campaign that was paused elsewhere in the meantime Active again (and, with a pass open, start it dialing).
      ...(d.status !== settingsTarget.status ? { status: d.status } : {}),
      ...(d.agentId ? { agent_id: d.agentId } : {}),
      ...(d.listId ? { list_id: d.listId } : {}),
      ...(d.phoneNumberId ? { phone_number_id: d.phoneNumberId } : {}),
      dnc_screening_enabled: d.dncScreeningEnabled,
      ...hoursToPayload(d.hours, CAMPAIGN_PREFIX),
      ...retryToPayload(d.retry),
      ...dialingToPayload(d.dialing),
    });
    if (error) { toast.error(error); return false; }
    toast.success("Campaign updated");
    showWarnings(warnings);
    fetchCampaigns();
    return true;
  };

  /** Deletes a campaign via the row actions menu. */
  const handleDelete = async (c: Campaign) => {
    const { error } = await api.deleteCampaign(c.id);
    if (error) return toast.error(error);
    toast.success("Campaign removed");
    fetchCampaigns();
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Outbound Campaigns</h1>
          <p className="text-sm text-muted-foreground">AI powered outbound calling automated, intelligent, scalable.</p>
        </div>
        <Button onClick={() => setOpen(true)} className="w-full sm:w-auto">
          <Plus className="mr-2 h-4 w-4" /> New Campaign
        </Button>
      </div>

      {/* Stats Bar */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 [&>*:last-child]:col-span-2 sm:[&>*:last-child]:col-span-1">
        <StatCard icon={Radio}        label="Total Campaigns"  value={campaigns.length}  color="bg-primary/10 text-primary" />
        <StatCard icon={TrendingUp}   label="Active Now"       value={activeCampaigns}   color="bg-green-500/10 text-green-600" />
        <StatCard icon={Users}        label="Total Contacts"   value={totalContacts.toLocaleString()} color="bg-blue-500/10 text-blue-600" />
        <StatCard icon={BarChart2}    label="Calls Dialed"     value={totalDialed.toLocaleString()}   color="bg-purple-500/10 text-purple-600" />
        <StatCard icon={CheckCircle2} label="Qualified"        value={qualified.toLocaleString()}     color="bg-success/10 text-success" />
      </div>

      {/* Campaign Cards */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading campaigns…
        </div>
      ) : campaigns.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card/50 p-16 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
            <PhoneOutgoing className="h-7 w-7 text-primary" />
          </div>
          <h3 className="mt-4 text-lg font-semibold text-foreground">No campaigns yet</h3>
          <p className="mt-1 text-sm text-muted-foreground">Create your first campaign to start AI powered outbound calling.</p>
          <Button className="mt-4" onClick={() => setOpen(true)}>
            <Plus className="mr-2 h-4 w-4" /> Create Campaign
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {campaigns.map((c) => {
            const pct = c.contacts_count > 0 ? Math.round((c.completed_count / c.contacts_count) * 100) : 0;
            const liveState = live[c.id];
            // Calls still open, redials still queued or a run still open mean it is not finished, whatever the counts say.
            const stillGoing = (liveState?.active_now ?? 0) > 0 || (liveState?.queued_redials ?? 0) > 0 || c.dialing?.running === true;
            const effectiveStatus = c.effectiveStatus === "Completed" && stillGoing ? c.status : (c.effectiveStatus ?? c.status);
            // Pause/Start toggles the campaign's real underlying status, independent of
            // whether every contact has already been reached — kept separate from the
            // completion badge below so the button's label always matches what clicking it does.
            const isActive = c.status === "Active";
            const isCompleted = effectiveStatus === "Completed" && !stillGoing;
            // Visual "is this actually running right now" cues (glow, icon, progress fill)
            // should turn off once completed even if the underlying status is still Active.
            const showRunning = isActive && !isCompleted;
            const statusCls = STATUS_COLOR[effectiveStatus] ?? STATUS_COLOR.Inactive;
            return (
              <div
                key={c.id}
                className={`rounded-xl border bg-card p-5 transition-shadow hover:shadow-md ${showRunning ? "border-primary/30 shadow-sm shadow-primary/10" : "border-border"}`}
              >
                {/* Top row */}
                <div className="flex items-start justify-between gap-2">
                  <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${showRunning ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                    <PhoneOutgoing className="h-5 w-5" />
                  </div>
                  <span className={`whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold ${statusCls}`}>{effectiveStatus}</span>
                </div>

                {/* Name + agent */}
                <h3 className="mt-4 break-words font-semibold text-foreground">{c.name}</h3>
                <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Bot className="h-3 w-3 shrink-0" />
                  <span className="min-w-0">{agentsById.get(c.agent_id) ?? "Unassigned"}</span>
                </div>
                {phoneNumbersById.get(c.phone_number_id ?? "") && (
                  <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Phone className="h-3 w-3 shrink-0" />
                    <span>{phoneNumbersById.get(c.phone_number_id!)}</span>
                  </div>
                )}

                {/* Calling hours */}
                {c.call_hours_state?.enabled && (
                  <div className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
                    <Clock className="mt-0.5 h-3 w-3 shrink-0" />
                    <span className="min-w-0">
                      {c.call_hours_state.summary}
                      {" · "}
                      {c.call_hours_state.open
                        ? <span className="font-medium text-success">Open now</span>
                        : <span className="font-medium text-warning">
                            Closed{describeNextOpen(c.call_hours_state, c.call_hours_timezone) ? ` — opens ${describeNextOpen(c.call_hours_state, c.call_hours_timezone)}` : ""}
                          </span>}
                    </span>
                  </div>
                )}
                {c.auto_resume?.pending && !isCompleted ? (
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span>
                      Stopped partway through its list. It continues automatically with the contacts that are left
                      {c.auto_resume.next_at
                        ? ` when the hours open (${describeNextOpen({ enabled: true, open: false, next_open_at: c.auto_resume.next_at, summary: null }, c.call_hours_timezone)}).`
                        : " within a minute (the hours are open now)."}
                    </span>
                    <button type="button" onClick={() => stopAutoResume(c)}
                      className="font-medium text-primary underline-offset-2 hover:underline">
                      Stop auto-resume
                    </button>
                  </div>
                ) : c.dial_cursor && !isCompleted && c.status !== "Active" && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Stopped partway through its list. Start continues with the contacts that are left.
                  </p>
                )}

                {/* Dialing: the strategy and, while the campaign runs, what it is doing right now */}
                {(() => {
                  const dial = dialingFromRow(c as unknown as Record<string, unknown>);
                  const eff = liveState?.effective ?? c.dialing?.effective;
                  const serverWarnings = liveState?.warnings ?? c.dialing?.warnings ?? [];
                  const notes: string[] = serverWarnings.length
                    ? serverWarnings
                    : eff?.capped && eff.cap ? [`Limited to ${count(eff.cap, "call")} at a time by your account.`] : [];
                  const stall = stallMessage(liveState?.stall_reason ?? c.dialing?.stall_reason);
                  // The last call error belongs to a pass that is going; a finished campaign does not keep showing it.
                  const inPass = (c.dialing?.running ?? c.dial_running) === true || (liveState?.active_now ?? 0) > 0;
                  const lastError = inPass && (liveState?.counters?.errors ?? 0) > 0 ? liveState?.counters?.last_error : null;
                  const showLive = !!liveState && liveState.state !== "idle";
                  const nextIn = dial.strategy === "paced" && liveState?.next_call_at
                    ? secondsBetween(liveState.as_of, liveState.next_call_at) : null;
                  return (
                    <div className="mt-3 overflow-hidden rounded-lg border border-border bg-muted/20">
                      <div className="space-y-0.5 px-3 py-2">
                        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-xs">
                          <span className="flex items-center gap-1.5 font-medium text-foreground">
                            <Gauge className="h-3.5 w-3.5 text-primary" /> Dialing
                          </span>
                          <span className="text-muted-foreground">{describeDialingShort(dial)}</span>
                        </div>
                        {notes.map((n) => (
                          <p key={n} className="flex items-start gap-1.5 text-[11px] text-warning">
                            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {n}
                          </p>
                        ))}
                        {stall && (
                          <p className="flex items-start gap-1.5 text-[11px] text-warning">
                            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {stall}
                          </p>
                        )}
                        {lastError && (
                          <p className="flex items-start gap-1.5 text-[11px] text-warning">
                            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> Last call error: {scrub(lastError)}
                          </p>
                        )}
                      </div>
                      {showLive && (
                        <>
                          <dl aria-label="Live dialing" className="grid grid-cols-3 divide-x divide-border border-t border-border text-center">
                            {([
                              ["Active now", liveState!.active_now],
                              ["In queue", liveState!.queued],
                              ["Placed", liveState!.placed],
                            ] as const).map(([label, value]) => (
                              <div key={label} className="flex min-w-0 flex-col items-center px-1 py-2">
                                <dd className="text-base font-semibold leading-none text-foreground">{value.toLocaleString()}</dd>
                                <dt className="mt-1 text-[10px] leading-tight text-muted-foreground">{label}</dt>
                              </div>
                            ))}
                          </dl>
                          <p className="flex flex-wrap items-center justify-between gap-x-3 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
                            <span>
                              {LIVE_STATE_LABELS[liveState!.state] ?? liveState!.state}
                              {nextIn != null && ` · Next call in ${nextIn} s`}
                            </span>
                            <span><UpdatedAgo at={liveAt} /></span>
                          </p>
                        </>
                      )}
                    </div>
                  );
                })()}

                {/* Auto redial: one panel with the settings and, once calls have been placed, the counts */}
                {(c.retry_enabled || (c.retry_stats?.total_attempts ?? 0) > 0) && (() => {
                  const retry = retryFromRow(c as unknown as Record<string, unknown>);
                  const stats = c.retry_stats;
                  const note = c.retry_enabled ? retryOutcomesNote(retry) : null;
                  const waiting = stats?.pending_retries ?? 0;
                  const second = c.retry_enabled
                    ? describeFollowupCard(
                        c.followup ?? (c.followup_rounds ? { rounds: c.followup_rounds, gap_hours: c.followup_gap_hours ?? 24, done: 0, next_at: null, waiting: false } : undefined),
                        (iso) => formatDue(iso, c.call_hours_timezone || ""),
                      )
                    : null;
                  return (
                    <div className="mt-3 overflow-hidden rounded-lg border border-border bg-muted/20">
                      {c.retry_enabled && (
                        <div className="space-y-0.5 px-3 py-2">
                          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-xs">
                            <span className="flex items-center gap-1.5 font-medium text-foreground">
                              <Repeat className="h-3.5 w-3.5 text-primary" /> Auto redial
                            </span>
                            <span className="text-muted-foreground">{describeRetryShort(retry)}</span>
                          </div>
                          {note && <p className="text-[11px] text-muted-foreground">{note}</p>}
                          {second && <p className="text-[11px] text-muted-foreground">{second.summary}</p>}
                          {second?.progress && <p className="text-[11px] font-medium text-foreground">{second.progress}</p>}
                          {waiting > 0 && (
                            <p className="text-[11px] font-medium text-foreground">
                              {waiting} waiting{c.status !== "Active" ? " (campaign paused)" : ""}
                            </p>
                          )}
                        </div>
                      )}
                      {(stats?.total_attempts ?? 0) > 0 && (
                        <dl
                          aria-label="Call attempts"
                          className={`grid grid-cols-4 divide-x divide-border text-center ${c.retry_enabled ? "border-t border-border" : ""}`}
                        >
                          {([
                            ["Attempts", stats!.total_attempts],
                            ["Redials", stats!.retries_placed],
                            ["Answered on redial", stats!.answered_on_retry],
                            ["Max attempts", stats!.max_attempts_reached],
                          ] as const).map(([label, value]) => (
                            <div key={label} className="flex min-w-0 flex-col items-center px-1 py-2">
                              <dd className="text-base font-semibold leading-none text-foreground">{value.toLocaleString()}</dd>
                              <dt className="mt-1 text-[10px] leading-tight text-muted-foreground">{label}</dt>
                            </div>
                          ))}
                        </dl>
                      )}
                    </div>
                  );
                })()}

                {/* Progress */}
                <div className="mt-4">
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-muted-foreground">{c.completed_count.toLocaleString()} / {c.contacts_count.toLocaleString()} contacted</span>
                    <span className="font-semibold text-foreground">{pct}%</span>
                  </div>
                  <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${isCompleted ? "bg-blue-500" : showRunning ? "bg-primary" : "bg-muted-foreground/40"}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>

                {/* Actions */}
                <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                  {isCompleted ? (
                    // Nothing is left to dial, so neither Pause nor Start would do anything useful.
                    // Adding contacts to the list takes the campaign out of "Completed" again.
                    <Button size="sm" variant="outline" disabled title="Add contacts to the list to run this campaign again">
                      <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" /> All contacts reached
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant={isActive ? "outline" : "default"}
                      onClick={() => togglePlay(c)}
                      className={isActive ? "" : "bg-primary text-primary-foreground"}
                    >
                      {isActive
                        ? <><PauseIcon className="mr-1.5 h-3.5 w-3.5" /> Pause</>
                        : <><Play className="mr-1.5 h-3.5 w-3.5" /> Start</>}
                    </Button>
                  )}
                  <div className="flex items-center gap-1">
                    {(c.retry_stats?.total_attempts ?? 0) > 0 && (
                      <Button size="sm" variant="ghost" onClick={() => setNumbersTarget(c)}>
                        <ListChecks className="mr-1.5 h-3.5 w-3.5" /> Numbers
                      </Button>
                    )}
                    <RowActions onSettings={() => openSettings(c)} onDelete={() => handleDelete(c)} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <CreateCampaignDialog
        open={open}
        onOpenChange={setOpen}
        onCreate={async (d) => {
          const { error, warnings } = await api.createCampaign({
            name: d.name,
            agent_id: d.agentId,
            list_id: d.listId,
            phone_number_id: d.phoneNumberId || null,
            dnc_screening_enabled: d.dncScreeningEnabled,
            ...hoursToPayload(d.hours, CAMPAIGN_PREFIX),
            ...retryToPayload(d.retry),
            ...dialingToPayload(d.dialing),
          });
          if (error) return toast.error(error);
          toast.success(`Campaign "${d.name}" created`);
          // The wizard has closed by now, so this is the only place the user hears about a cap.
          showWarnings(warnings);
          fetchCampaigns();
        }}
      />

      {/* Pre-flight Dialog */}
      <Dialog open={!!preflightTarget} onOpenChange={(o) => { if (!o) setPreflightTarget(null); }}>
        <DialogContent className="max-w-lg">
          {(() => {
            const total = shownChecks.length;
            const passed = shownChecks.filter((c) => c.status === "pass").length;
            const loading = shownChecks.some((c) => c.status === "loading");
            const failed = shownChecks.some((c) => c.status === "fail");
            const warned = shownChecks.some((c) => c.status === "warn");
            const tone = loading ? "muted" : failed ? "bad" : warned ? "warn" : "good";
            const title = loading ? "Running checks" : failed ? "Fix these before launching" : warned ? "Ready, with warnings" : "Ready to launch";
            const badge = {
              muted: "bg-muted text-muted-foreground",
              bad: "bg-destructive/10 text-destructive",
              warn: "bg-yellow-500/10 text-yellow-500",
              good: "bg-green-500/10 text-green-500",
            }[tone];
            const bar = { muted: "bg-muted-foreground/50", bad: "bg-destructive", warn: "bg-yellow-500", good: "bg-green-500" }[tone];
            return (
              <>
                <DialogHeader className="text-left">
                  <div className="flex items-center gap-3 pr-6">
                    <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${badge}`}>
                      {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : failed ? <XCircle className="h-5 w-5" /> : warned ? <AlertTriangle className="h-5 w-5" /> : <Rocket className="h-5 w-5" />}
                    </div>
                    <div className="min-w-0">
                      <DialogTitle className="text-lg">{title}</DialogTitle>
                      <DialogDescription className="truncate">
                        Pre-launch checks for <span className="font-medium text-foreground">{preflightTarget?.name}</span>
                      </DialogDescription>
                    </div>
                  </div>
                </DialogHeader>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>{passed} of {total} checks passed</span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div className={`h-full rounded-full transition-all duration-500 ${bar}`} style={{ width: `${total ? (passed / total) * 100 : 0}%` }} />
                  </div>
                </div>

                <div className="space-y-2">
                  {shownChecks.map((c, i) => (
                    <div key={i} className={`flex items-center gap-3 rounded-xl border px-3.5 py-3 transition-colors ${
                      c.status === "pass" ? "border-green-500/20 bg-green-500/5" :
                      c.status === "fail" ? "border-destructive/30 bg-destructive/5" :
                      c.status === "warn" ? "border-yellow-500/30 bg-yellow-500/5" :
                      "border-border bg-muted/30"
                    }`}>
                      <div key={c.status} className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full animate-in zoom-in-50 duration-300 ${
                        c.status === "pass" ? "bg-green-500/15 text-green-500" :
                        c.status === "fail" ? "bg-destructive/15 text-destructive" :
                        c.status === "warn" ? "bg-yellow-500/15 text-yellow-500" :
                        "bg-muted text-muted-foreground"
                      }`}>
                        {c.status === "loading" && <Loader2 className="h-4 w-4 animate-spin" />}
                        {c.status === "pass" && <CheckCircle2 className="h-4 w-4" />}
                        {c.status === "fail" && <XCircle className="h-4 w-4" />}
                        {c.status === "warn" && <AlertTriangle className="h-4 w-4" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{c.label}</p>
                        {c.detail && (
                          <p className={`mt-0.5 break-words text-xs ${c.status === "fail" ? "text-destructive" : "text-muted-foreground"}`}>
                            {c.detail.replace(/\s*✓$/, "")}
                          </p>
                        )}
                      </div>
                      <span className={`shrink-0 text-xs font-medium ${
                        c.status === "pass" ? "text-green-500" :
                        c.status === "fail" ? "text-destructive" :
                        c.status === "warn" ? "text-yellow-500" :
                        "text-muted-foreground"
                      }`}>
                        {c.status === "pass" ? "Passed" : c.status === "fail" ? "Failed" : c.status === "warn" ? "Warning" : "Checking"}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            );
          })()}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setPreflightTarget(null)}>Cancel</Button>
            <Button
              onClick={launchCampaign}
              disabled={launching || shownChecks.some((c) => c.status === "loading" || c.status === "fail")}
            >
              {launching
                ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Launching…</>
                : <><Play className="mr-2 h-4 w-4" />Launch Campaign</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {(() => {
        // the card as the list has it now (it refreshes after "Retry unreached numbers"), not as it was when opened
        const shown = campaigns.find((c) => c.id === numbersTarget?.id) ?? numbersTarget;
        return (
          <CampaignNumbersDialog
            campaignId={numbersTarget?.id ?? null}
            campaignName={shown?.name}
            timezone={shown?.call_hours_timezone}
            status={shown?.status}
            unreachedCount={shown?.retry_stats?.unreached_count ?? 0}
            running={!!shown && ((shown.dialing?.running ?? shown.dial_running) === true || (live[shown.id]?.active_now ?? 0) > 0)}
            onRequeued={refreshAfterAction}
            onOpenChange={(o) => { if (!o) setNumbersTarget(null); }}
          />
        );
      })()}

      {/* Edit wizard: the same steps as creating a campaign, starting from its current values */}
      {settingsTarget && (
        <EditCampaignDialog
          open
          onOpenChange={(o) => { if (!o) setSettingsTarget(null); }}
          initial={formOf(settingsTarget)}
          onSave={saveSettings}
        />
      )}
    </div>
  );
};

export default Outbound;
