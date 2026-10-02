import { SearchSelect, type SearchOption } from "./SearchSelect";

const label = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

const SLOTS: SearchOption[] = Array.from({ length: 96 }, (_, i) => {
  const t = `${String(Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}`;
  return { value: t, label: label(t), keywords: t };
});

/** Searchable time dropdown (every 15 minutes). Value is "HH:MM". */
export function TimeSelect({
  id, value, onChange, disabled,
}: { id: string; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  // Keep a value that isn't on the 15-minute grid selectable rather than silently changing it.
  const options = !/^\d\d:\d\d$/.test(value) || SLOTS.some((o) => o.value === value)
    ? SLOTS
    : [...SLOTS, { value, label: label(value), keywords: value }].sort((a, b) => a.value.localeCompare(b.value));
  return (
    <SearchSelect id={id} value={value} onChange={onChange} options={options} disabled={disabled}
      placeholder="Select time" searchable={false} />
  );
}
