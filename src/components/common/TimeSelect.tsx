/**
 * Time-of-day dropdown for the settings dialogs, with a slot every 15 minutes. The value is a
 * 24-hour "HH:MM" string; the options are shown as 12-hour AM/PM labels. Built on SearchSelect;
 * no API calls. Used by CallbackSettingsDialog and CalendarSettingsDialog.
 */
import { SearchSelect, type SearchOption } from "./SearchSelect";

/** Formats a 24-hour "HH:MM" string as a 12-hour label: "13:15" -> "1:15 PM", "00:00" -> "12:00 AM". */
const label = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

/** The 96 quarter-hour options from 00:00 to 23:45; `keywords` repeats the 24-hour value. */
const SLOTS: SearchOption[] = Array.from({ length: 96 }, (_, i) => {
  const t = `${String(Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}`;
  return { value: t, label: label(t), keywords: t };
});

/** Searchable time dropdown (every 15 minutes). Value is "HH:MM". */
export function TimeSelect({
  id, value, onChange, disabled,
}: { id: string; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  // Keep a value that isn't on the 15-minute grid selectable rather than silently changing it.
  // An empty or malformed value gets the plain grid; an off-grid "HH:MM" is added as one extra
  // option, sorted by its zero-padded string.
  const options = !/^\d\d:\d\d$/.test(value) || SLOTS.some((o) => o.value === value)
    ? SLOTS
    : [...SLOTS, { value, label: label(value), keywords: value }].sort((a, b) => a.value.localeCompare(b.value));
  // The search box is turned off (searchable={false}), so the list is simply scrolled and the
  // slots' `keywords` have no effect here.
  return (
    <SearchSelect id={id} value={value} onChange={onChange} options={options} disabled={disabled}
      placeholder="Select time" searchable={false} />
  );
}
