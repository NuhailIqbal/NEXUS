/**
 * Dialing strategy for outbound campaigns (backend: services/dialer.py, services/dial_settings.py). How a
 * campaign places its calls: one at a time (sequential), several at once (concurrent) or at a steady rate
 * (paced), plus an optional delay between calls. The settings are four columns of the campaign row:
 * dial_strategy, dial_concurrent_calls, dial_calls_per_minute and dial_delay_seconds.
 */

export const DIALING_STRATEGIES = ["sequential", "concurrent", "paced"] as const;
export type DialingStrategy = (typeof DIALING_STRATEGIES)[number];

export const DIALING_STRATEGY_LABELS: Record<DialingStrategy, string> = {
  sequential: "Sequential",
  concurrent: "Concurrent",
  paced: "Paced",
};

/** One line under each strategy in the picker. */
export const DIALING_STRATEGY_DESCRIPTIONS: Record<DialingStrategy, string> = {
  sequential: "One call at a time. The next number is dialed after the current call ends.",
  concurrent: "Several calls at once. A new call starts whenever one ends, so the number running stays steady.",
  paced: "A steady number of calls started every minute, whether or not earlier calls have ended.",
};

/** The limits the server enforces on the three numbers. */
export const MAX_CONCURRENT_CALLS = 20;
export const MAX_CALLS_PER_MINUTE = 60;
export const MAX_DELAY_SECONDS = 60;

/** The dialing form's value. */
export type DialingSettings = {
  strategy: DialingStrategy;
  concurrentCalls: number;
  callsPerMinute: number;
  delaySeconds: number;
};

/** Sequential, 5 at a time (used only when Concurrent is chosen), 10 a minute (Paced only), no delay. */
export function defaultDialing(): DialingSettings {
  return { strategy: "sequential", concurrentCalls: 5, callsPerMinute: 10, delaySeconds: 0 };
}

const isStrategy = (v: unknown): v is DialingStrategy => (DIALING_STRATEGIES as readonly unknown[]).includes(v);

/** The dialing settings of a campaign row from the API (missing fields fall back to the defaults). */
export function dialingFromRow(row: Record<string, unknown> | null | undefined): DialingSettings {
  const d = defaultDialing();
  if (!row) return d;
  return {
    strategy: isStrategy(row.dial_strategy) ? row.dial_strategy : d.strategy,
    concurrentCalls: typeof row.dial_concurrent_calls === "number" ? row.dial_concurrent_calls : d.concurrentCalls,
    callsPerMinute: typeof row.dial_calls_per_minute === "number" ? row.dial_calls_per_minute : d.callsPerMinute,
    delaySeconds: typeof row.dial_delay_seconds === "number" ? row.dial_delay_seconds : d.delaySeconds,
  };
}

const inRange = (v: number, lo: number, hi: number) => Number.isInteger(v) && v >= lo && v <= hi;

/**
 * The request fields for create/update (snake_case, as the backend takes them). Always all four: the server
 * checks every one, so a number the chosen strategy does not use (and the form does not show) is sent as
 * its default if it was left invalid.
 */
export function dialingToPayload(s: DialingSettings) {
  const d = defaultDialing();
  return {
    dial_strategy: s.strategy,
    dial_concurrent_calls: inRange(s.concurrentCalls, 1, MAX_CONCURRENT_CALLS) ? s.concurrentCalls : d.concurrentCalls,
    dial_calls_per_minute: inRange(s.callsPerMinute, 1, MAX_CALLS_PER_MINUTE) ? s.callsPerMinute : d.callsPerMinute,
    dial_delay_seconds: inRange(s.delaySeconds, 0, MAX_DELAY_SECONDS) ? s.delaySeconds : d.delaySeconds,
  };
}

/** The problem with the settings, in words for the user, or null when they can be saved. */
export function validateDialing(s: DialingSettings): string | null {
  if (s.strategy === "concurrent" && !inRange(s.concurrentCalls, 1, MAX_CONCURRENT_CALLS))
    return `Concurrent calls must be a whole number from 1 to ${MAX_CONCURRENT_CALLS}.`;
  if (s.strategy === "paced" && !inRange(s.callsPerMinute, 1, MAX_CALLS_PER_MINUTE))
    return `Calls per minute must be a whole number from 1 to ${MAX_CALLS_PER_MINUTE}.`;
  if (!inRange(s.delaySeconds, 0, MAX_DELAY_SECONDS))
    return `Delay between calls must be a whole number of seconds from 0 to ${MAX_DELAY_SECONDS}.`;
  return null;
}

/** What the limits endpoint returns (GET /telephony/dialing/limits). account_limit is null when there is no cap. */
export type DialingLimits = {
  account_limit: number | null;
  source?: string | null;
  platform_limit?: number | null;
  max_concurrent_calls?: number;
  max_calls_per_minute?: number;
  max_delay_seconds?: number;
};

/**
 * The lowest cap on calls at the same time and whose it is, mirroring the backend (dial_limits.cap_of): "account"
 * is the account's own limit, "platform" the platform's current one; a tie goes to the account, because that is
 * the number the user can see and change. Null when there is no cap.
 */
export function callCap(limits: DialingLimits | null | undefined): { cap: number; source: "account" | "platform" } | null {
  if (!limits) return null;
  const positive = (n: unknown): n is number => typeof n === "number" && n > 0;
  const account = positive(limits.account_limit) ? limits.account_limit : null;
  const platform = positive(limits.platform_limit) ? limits.platform_limit : null;
  if (account == null && platform == null) return null;
  if (platform == null || (account != null && account <= platform)) return { cap: account as number, source: "account" };
  return { cap: platform, source: "platform" };
}

/** The most calls this account may have at once (the lower of its own cap and the platform's), or null. */
export function effectiveCallLimit(limits: DialingLimits | null | undefined): number | null {
  return callCap(limits)?.cap ?? null;
}

/**
 * The amber line shown when the chosen settings ask for more than is allowed, or null. The wording names whose cap
 * it is, like the backend's warnings (dial_limits.warnings_for): the platform's cap can be a temporary one (the
 * platform is full right now), so it says "the platform currently allows", never "your account allows".
 */
export function limitWarning(s: DialingSettings, limits: DialingLimits | null | undefined): string | null {
  const found = callCap(limits);
  if (!found) return null;
  const { cap, source } = found;
  const calls = cap === 1 ? "1 call" : `${cap} calls`;
  const who = source === "account" ? "your account allows" : "the platform currently allows";
  if (s.strategy === "concurrent" && s.concurrentCalls > cap)
    return `Concurrent Calls is set to ${s.concurrentCalls}, but ${who} ${calls} at the same time. Calls will run ${cap} at a time.`;
  if (s.strategy === "paced" && s.callsPerMinute > cap)
    return `${who.charAt(0).toUpperCase()}${who.slice(1)} ${calls} at the same time, so this campaign may place fewer than ${s.callsPerMinute} calls per minute.`;
  return null;
}

/** Seconds between calls when Paced: the slower of the delay and an even spread over the minute. */
export function pacedSpacingSeconds(s: DialingSettings): number {
  const even = 60 / Math.max(1, s.callsPerMinute);
  return Math.max(even, Number.isFinite(s.delaySeconds) ? s.delaySeconds : 0);
}

/** "about 3" calls a minute when the delay is longer than the rate needs, else the chosen number. */
function pacedRate(s: DialingSettings): { rate: number; slowed: boolean } {
  const spacing = pacedSpacingSeconds(s);
  const slowed = spacing > 60 / Math.max(1, s.callsPerMinute) + 1e-9;
  return { rate: slowed ? Math.round((60 / spacing) * 10) / 10 : s.callsPerMinute, slowed };
}

const secs = (n: number) => `${n} s`;

/** "Concurrent: up to 5 calls at a time, 2 s between calls" (for the review step). */
export function describeDialing(s: DialingSettings): string {
  const gap = s.delaySeconds > 0 ? s.delaySeconds : 0;
  if (s.strategy === "sequential")
    return `Sequential: one call at a time${gap ? `, ${secs(gap)} after each call ends` : ""}`;
  if (s.strategy === "concurrent")
    return `Concurrent: up to ${s.concurrentCalls} calls at a time${gap ? `, ${secs(gap)} between calls` : ""}`;
  const { rate, slowed } = pacedRate(s);
  return slowed
    ? `Paced: about ${rate} calls per minute (${secs(gap)} between calls)`
    : `Paced: ${s.callsPerMinute} calls per minute${gap ? `, at least ${secs(gap)} between calls` : ""}`;
}

/** "Concurrent · 5 at a time · 2 s gap": the short form shown on the campaign card. */
export function describeDialingShort(s: DialingSettings): string {
  const gap = s.delaySeconds > 0 ? ` · ${secs(s.delaySeconds)} gap` : "";
  if (s.strategy === "sequential") return `Sequential · one at a time${gap}`;
  if (s.strategy === "concurrent") return `Concurrent · ${s.concurrentCalls} at a time${gap}`;
  const { rate, slowed } = pacedRate(s);
  return `Paced · ${slowed ? `about ${rate}` : s.callsPerMinute}/min${gap}`;
}

/** The server's effective view of the settings once the account and platform caps are applied. */
export type DialingEffective = {
  concurrent_calls: number;
  calls_per_minute: number;
  capped: boolean;
  cap?: number | null;
  cap_source?: string | null;
};

/** The `dialing` block on each campaign row (GET /telephony/campaigns). */
export type DialingInfo = {
  settings: { strategy: DialingStrategy; concurrent_calls: number; calls_per_minute: number; delay_seconds: number };
  effective?: DialingEffective;
  warnings?: string[];
  running: boolean;
  stall_reason: string | null;
};

/** What the server is doing with a campaign right now. */
export type LiveStateName =
  | "dialing" | "finishing" | "waiting_hours" | "paused" | "stalled" | "waiting_redials" | "idle";

/** One campaign in GET /telephony/campaigns/live. */
export type LiveState = {
  campaign_id: string;
  state: LiveStateName;
  strategy: DialingStrategy;
  settings?: DialingInfo["settings"];
  effective?: DialingEffective;
  warnings?: string[];
  active_now: number;
  queued: number;
  queued_fresh?: number;
  queued_redials: number;
  redials_due_now?: number;
  placed: number;
  placed_last_minute?: number;
  counters?: {
    suppressed?: number; busy?: number; duplicate?: number;
    errors?: number; last_error?: string | null; last_error_at?: string | null;
  };
  stall_reason: string | null;
  next_call_at: string | null;
  pass_started_at?: string | null;
  dispatcher_ok?: boolean;
  as_of: string;
};

/** The state line on the card. */
export const LIVE_STATE_LABELS: Record<LiveStateName, string> = {
  dialing: "Calling now",
  finishing: "Finishing calls in progress",
  waiting_hours: "Waiting for calling hours",
  paused: "Paused",
  stalled: "Waiting",
  waiting_redials: "Waiting for redials",
  idle: "Idle",
};

/** Why a campaign that should be dialing is not, in words for the user (the server sends a short code). */
export const STALL_MESSAGES: Record<string, string> = {
  balance: "Waiting for balance: add funds and it carries on by itself.",
  blocked: "Outbound calling is blocked on this account.",
  agent: "The agent is not ready to place calls. Open it and sync it.",
  number: "The phone number cannot place calls right now.",
  provider_limit: "Too many calls at once: slowing down and trying again shortly.",
  provider_error: "Stopped after repeated call errors. Check the agent and phone number, then start it again.",
  screening: "DNC screening is not answering: trying again shortly.",
};

/** The stall code as a sentence (an unknown code is shown plainly rather than hidden). */
export function stallMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return STALL_MESSAGES[code] ?? `Waiting (${code.replace(/_/g, " ")}).`;
}

/** Seconds from `from` to `to` (both ISO strings), rounded up and never negative; null when either is unreadable. */
export function secondsBetween(from: string | null | undefined, to: string | null | undefined): number | null {
  if (!from || !to) return null;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, Math.ceil((b - a) / 1000));
}
