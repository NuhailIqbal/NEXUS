import { useMemo } from "react";
import { SearchSelect, type SearchOption } from "./SearchSelect";
import { COMMON_TIMEZONES } from "./timezones";

const KEYWORDS: Record<string, string> = {
  "America/New_York": "EST EDT ET eastern", "America/Chicago": "CST CDT CT central",
  "America/Denver": "MST MDT MT mountain", "America/Los_Angeles": "PST PDT PT pacific",
  "America/Anchorage": "AKST AKDT alaska", "Pacific/Honolulu": "HST hawaii", "Asia/Karachi": "PKT pakistan",
  "Asia/Kolkata": "IST india",
};

/** Searchable timezone dropdown: common zones first (type EST, PST…), every other region below. */
export function TimezoneSelect({
  id, value, onChange, zones, disabled,
}: { id: string; value: string; onChange: (tz: string) => void; zones: string[]; disabled?: boolean }) {
  const options = useMemo<SearchOption[]>(() => {
    const common = new Set(COMMON_TIMEZONES.map((z) => z.value));
    return [
      ...COMMON_TIMEZONES.map((z) => ({ ...z, keywords: KEYWORDS[z.value], group: "Common" })),
      ...Array.from(new Set([value, ...zones])).filter((z) => z && !common.has(z)).map((z) => ({ value: z, label: z, group: "All regions" })),
    ];
  }, [zones, value]);
  return (
    <SearchSelect id={id} ariaLabel="Timezone" value={value} onChange={onChange} options={options} disabled={disabled}
      placeholder="Select timezone" searchPlaceholder="Type EST, PST, Karachi…" />
  );
}
