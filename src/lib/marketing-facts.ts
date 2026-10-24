/**
 * Single source for the figures quoted on the public marketing site: catalog counts derived
 * from lib/voices and lib/industries, plus hand-maintained billing numbers that mirror the
 * backend. Imported by the marketing pages (Features, Pricing, About, UseCases, Technology,
 * Advertisers, Publishers) and a few shared marketing components.
 */
import { ALL_VOICE_NAMES } from "@/lib/voices";
import { AGENT_LANGUAGES } from "@/lib/languages";
import { INDUSTRIES } from "@/lib/industries";

// Numbers quoted on the public marketing pages. Counts are derived from the same
// catalogs the dashboard uses, so the site can't drift from what the product offers.
// The billing figures mirror backend/routers/billing.py and backend/config.py —
// update them here if those change.
/** Number of voices an agent can use (the English, Urdu, Spanish and German catalogs combined). */
export const VOICE_COUNT = ALL_VOICE_NAMES.length;
/** Number of industries offered in the agent builder. */
export const INDUSTRY_COUNT = INDUSTRIES.length;
/** Agent language choices as shown to users; taken straight from the agent form's language options. */
export const LANGUAGE_OPTIONS: readonly string[] = AGENT_LANGUAGES.map((l) => l.label);

// DEFAULT_RATE_PER_MINUTE: calls are charged at their actual provider cost × a flat
// multiplier, which lands around this figure. Always present it as approximate.
/** Display string for the approximate per-minute call rate; mirrors DEFAULT_RATE_PER_MINUTE (0.35) in backend/routers/billing.py. */
export const TYPICAL_RATE_PER_MINUTE = "$0.35";
/** Monthly fee per provisioned phone number; mirrors PHONE_NUMBER_MONTHLY_COST in backend/routers/billing.py. */
export const PHONE_NUMBER_MONTHLY = "$3";
/**
 * Welcome credit granted to new accounts; mirrors the default `signup_bonus_credits` in
 * backend/config.py (admin platform settings can override it at runtime, this string cannot follow).
 */
export const SIGNUP_CREDIT = "$20";
/** Days until the welcome credit expires; mirrors the default `signup_bonus_expiry_days` in backend/config.py. */
export const SIGNUP_CREDIT_EXPIRY_DAYS = 60;
/** Smallest allowed wallet top-up; mirrors TOPUP_MIN in backend/routers/billing.py. */
export const TOP_UP_MIN = "$20";
/** Largest allowed wallet top-up; mirrors TOPUP_MAX in backend/routers/billing.py. */
export const TOP_UP_MAX = "$1,000";
/** Most calls one campaign can have going at once (its Concurrent Calls setting); mirrors the 1-20 range in backend/services/dial_settings.py and src/lib/dialingStrategy.ts. */
export const MAX_CONCURRENT_CALLS = 20;
