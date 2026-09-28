import { ALL_VOICE_NAMES } from "@/lib/voices";
import { INDUSTRIES } from "@/lib/industries";

// Numbers quoted on the public marketing pages. Counts are derived from the same
// catalogs the dashboard uses, so the site can't drift from what the product offers.
// The billing figures mirror backend/routers/billing.py and backend/config.py —
// update them here if those change.
export const VOICE_COUNT = ALL_VOICE_NAMES.length;
export const INDUSTRY_COUNT = INDUSTRIES.length;
export const LANGUAGE_OPTIONS = ["English", "Urdu", "Multilingual (auto-detect)"] as const;

// DEFAULT_RATE_PER_MINUTE: calls are charged at their actual provider cost × a flat
// multiplier, which lands around this figure. Always present it as approximate.
export const TYPICAL_RATE_PER_MINUTE = "$0.35";
export const PHONE_NUMBER_MONTHLY = "$3";
export const SIGNUP_CREDIT = "$20";
export const SIGNUP_CREDIT_EXPIRY_DAYS = 60;
export const TOP_UP_MIN = "$20";
export const TOP_UP_MAX = "$1,000";
export const CAMPAIGN_BATCH_SIZE = 20;
