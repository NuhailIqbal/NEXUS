/** Friendly choices shown first. Values are real regions, so daylight saving is handled automatically. */
export const COMMON_TIMEZONES: { value: string; label: string }[] = [
  { value: "America/New_York", label: "Eastern Time – EST/EDT (New York)" },
  { value: "America/Chicago", label: "Central Time – CST/CDT (Chicago)" },
  { value: "America/Denver", label: "Mountain Time – MST/MDT (Denver)" },
  { value: "America/Phoenix", label: "Arizona – MST, no daylight saving (Phoenix)" },
  { value: "America/Los_Angeles", label: "Pacific Time – PST/PDT (Los Angeles)" },
  { value: "America/Anchorage", label: "Alaska Time – AKST/AKDT (Anchorage)" },
  { value: "Pacific/Honolulu", label: "Hawaii – HST (Honolulu)" },
  { value: "UTC", label: "UTC" },
  { value: "Europe/London", label: "London (GMT/BST)" },
  { value: "Asia/Dubai", label: "Dubai (GST)" },
  { value: "Asia/Karachi", label: "Pakistan – PKT (Karachi)" },
  { value: "Asia/Kolkata", label: "India – IST (Kolkata)" },
];

const ALIASES: Record<string, string> = {
  EST: "America/New_York", EDT: "America/New_York", ET: "America/New_York",
  CST: "America/Chicago", CDT: "America/Chicago", CT: "America/Chicago",
  MST: "America/Denver", MDT: "America/Denver", MT: "America/Denver",
  PST: "America/Los_Angeles", PDT: "America/Los_Angeles", PT: "America/Los_Angeles",
  AKST: "America/Anchorage", AKDT: "America/Anchorage", HST: "Pacific/Honolulu", PKT: "Asia/Karachi",
};

/** 'est' -> 'America/New_York'. Mirrors the server; anything else is returned unchanged. */
export const normalizeTimezone = (name: string): string => ALIASES[name.trim().toUpperCase()] ?? name;

export const isCommonTimezone = (value: string): boolean => COMMON_TIMEZONES.some((z) => z.value === value);
