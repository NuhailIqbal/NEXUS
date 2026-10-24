/**
 * Call retry / redial for outbound campaigns (backend: services/call_retry.py). A number that did not pick
 * up is called again after a set delay, up to a maximum number of calls; all of it is set per campaign.
 * The settings are four columns of the campaign row: retry_enabled, retry_max_attempts,
 * retry_interval_minutes and retry_on.
 */

/** The outcomes that can trigger a redial (the "Retry on" checkboxes), in the order they are shown. */
export const RETRY_OUTCOMES = ["no_answer", "busy", "voicemail", "failed"] as const;
export type RetryOutcome = (typeof RETRY_OUTCOMES)[number];

export const RETRY_OUTCOME_LABELS: Record<RetryOutcome, string> = {
  no_answer: "No Answer",
  busy: "Busy",
  voicemail: "Voicemail / Answering Machine",
  failed: "Call Failed / Network Error",
};

/** What the user picks from: total calls per number (the first one included), and minutes between calls. */
export const MAX_ATTEMPT_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
export const INTERVAL_OPTIONS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60];

/** The retry form's value. */
export type RetrySettings = {
  enabled: boolean;
  maxAttempts: number;
  intervalMinutes: number;
  retryOn: RetryOutcome[];
};

/** Off, 3 calls in all, 10 minutes apart, every outcome ticked. */
export function defaultRetry(): RetrySettings {
  return { enabled: false, maxAttempts: 3, intervalMinutes: 10, retryOn: [...RETRY_OUTCOMES] };
}

/** The retry settings of a campaign row from the API (missing fields fall back to the defaults). */
export function retryFromRow(row: Record<string, unknown> | null | undefined): RetrySettings {
  const d = defaultRetry();
  if (!row) return d;
  const on = Array.isArray(row.retry_on) ? (row.retry_on as string[]) : d.retryOn;
  return {
    enabled: typeof row.retry_enabled === "boolean" ? row.retry_enabled : d.enabled,
    maxAttempts: typeof row.retry_max_attempts === "number" ? row.retry_max_attempts : d.maxAttempts,
    intervalMinutes: typeof row.retry_interval_minutes === "number" ? row.retry_interval_minutes : d.intervalMinutes,
    retryOn: RETRY_OUTCOMES.filter((o) => on.includes(o)),
  };
}

/** The request fields for create/update (snake_case, as the backend takes them). */
export function retryToPayload(r: RetrySettings) {
  return {
    retry_enabled: r.enabled,
    retry_max_attempts: r.maxAttempts,
    retry_interval_minutes: r.intervalMinutes,
    retry_on: RETRY_OUTCOMES.filter((o) => r.retryOn.includes(o)),
  };
}

/** The problem with the settings, in words for the user, or null when they can be saved. */
export function validateRetry(r: RetrySettings): string | null {
  if (!r.enabled) return null;
  if (r.retryOn.length === 0) return "Choose at least one outcome to redial on.";
  return null;
}

/** "3 calls in all, 10 minutes apart, on no answer, busy" (for the review step and the card). */
export function describeRetry(r: RetrySettings): string {
  if (!r.enabled) return "Off";
  const calls = r.maxAttempts === 1 ? "1 call" : `${r.maxAttempts} calls`;
  const on = r.retryOn.map((o) => RETRY_OUTCOME_LABELS[o].split(" / ")[0].toLowerCase()).join(", ");
  return `Up to ${calls} per number, ${r.intervalMinutes} min apart, on ${on || "nothing"}`;
}

/** "Up to 2 calls · every 5 min": the short form shown on the campaign card. */
export function describeRetryShort(r: RetrySettings): string {
  return `Up to ${r.maxAttempts === 1 ? "1 call" : `${r.maxAttempts} calls`} · every ${r.intervalMinutes} min`;
}

/** "Redials on: no answer, busy", or null when every outcome is ticked (nothing worth pointing out). */
export function retryOutcomesNote(r: RetrySettings): string | null {
  if (r.retryOn.length === RETRY_OUTCOMES.length) return null;
  const on = r.retryOn.map((o) => RETRY_OUTCOME_LABELS[o].split(" / ")[0].toLowerCase()).join(", ");
  return `Redials on: ${on || "nothing"}`;
}

/** What the campaign list returns next to each campaign. */
export type RetryStats = {
  total_attempts: number;
  retries_placed: number;
  answered_on_retry: number;
  max_attempts_reached: number;
  pending_retries: number;
  numbers: number;
};

/** How one call of a number ended (the outcomes the server classifies). */
export const OUTCOME_LABELS: Record<string, string> = {
  no_answer: "No answer",
  busy: "Busy",
  voicemail: "Voicemail",
  failed: "Call failed",
  answered: "Answered",
  transferred: "Transferred",
  disqualified: "Disqualified",
  do_not_call: "Do not call",
  invalid_number: "Invalid number",
};

/** The state of a number in the numbers view. */
export const STATUS_LABELS: Record<string, string> = {
  calling: "Calling now",
  retry_scheduled: "Redial scheduled",
  retry_paused: "Redial paused (campaign not active)",
  answered: "Answered",
  transferred: "Transferred",
  disqualified: "Disqualified",
  do_not_call: "Do not call",
  invalid_number: "Invalid number",
  max_attempts: "Max attempts reached",
  not_retried: "Not retried",
};

/** One call in a number's history. */
export type AttemptRow = {
  round: number;
  attempt_number: number;
  placed_at: string | null;
  ended_at: string | null;
  outcome: string | null;
  ended_reason: string | null;
  // How the call was placed (absent on calls from before the dialing strategies): the campaign's strategy then,
  // the slot it held (Sequential and Concurrent), its wave (Concurrent) and whether it was a first call or a redial.
  dial_strategy?: string | null;
  dial_slot?: number | null;
  dial_batch?: number | null;
  dial_source?: string | null;
};

/** "slot 2 · wave 1", "paced · redial": how a call was placed, or null for a call without that record. */
export function describeAttemptDial(h: Pick<AttemptRow, "dial_strategy" | "dial_slot" | "dial_batch" | "dial_source">): string | null {
  const parts: string[] = [];
  if (h.dial_strategy === "paced") parts.push("paced");
  if (h.dial_slot != null) parts.push(`slot ${h.dial_slot}`);
  if (h.dial_strategy === "concurrent" && h.dial_batch != null) parts.push(`wave ${h.dial_batch}`);
  if (h.dial_source === "redial") parts.push("redial");
  return parts.length ? parts.join(" · ") : null;
}

/** One number of a campaign (GET /telephony/campaigns/:id/numbers). */
export type CampaignNumber = {
  id: string;
  contact_id: string;
  name: string | null;
  phone: string;
  attempts: number;
  round: number;
  max_attempts: number;
  last_outcome: string | null;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  final_status: string | null;
  status: string;
  history: AttemptRow[];
};

/** The filters of the numbers view: the value sent as `status` and its label. */
export const NUMBER_FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "All numbers" },
  { value: "pending", label: "Still going" },
  { value: "finished", label: "Finished" },
  { value: "max_attempts", label: "Max attempts reached" },
  { value: "answered", label: "Answered" },
  { value: "not_retried", label: "Not retried" },
];
