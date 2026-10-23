/**
 * Filter bar shared by every Call Consumption page. It edits a DRAFT copy of the filters and only reports them
 * (onApply) when the user presses Search, so typing a date never fires six requests. Clear resets to the default
 * (last 30 days, nothing else) and applies at once.
 *
 * Dropdown contents come from GET /call-consumption/filters (the account's own campaigns, agents and verticals).
 * `hide` removes controls a page doesn't use. Days and hours are bucketed in the browser's time zone, which the
 * bar names so nobody wonders why a call landed on a different date.
 */
import { useEffect, useMemo, useState } from "react";
import { CalendarIcon, ChevronDown, Search, Filter as FilterIcon, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Calendar } from "@/components/ui/calendar";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { ymd } from "@/lib/callConsumption";
import {
  RANGE_PRESETS, defaultFilters, findPreset, presetRange, rangeError, sameFilters, type CCFilters, type PeriodPreset,
} from "@/lib/callConsumption";

type Options = {
  campaigns: { id: string; name: string }[];
  agents: { id: string; name: string }[];
  verticals: string[];
  states: { code: string; name: string }[];
  numbers: { id: string; name: string }[];
  dispositions: { value: string; label: string }[];
};

type Hideable = "dates" | "campaign" | "vertical" | "agent" | "direction" | "disposition";

const ALL = "__all__";
const CUSTOM = "custom";
const parseYmd = (v: string) => (v ? new Date(`${v}T00:00:00`) : undefined);
const show = (v: string) => { const d = parseYmd(v); return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString("en-GB") : "dd/mm/yyyy"; };

/** A date field that opens a calendar popup (Today / Clear in its footer). `value` and `onChange` are YYYY-MM-DD. */
function DateField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const selected = parseYmd(value);
  return (
    <div className="min-w-[9.5rem] flex-1 space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" aria-label={label} className="w-full justify-between font-normal">
            {show(value)}
            <CalendarIcon className="ml-2 h-4 w-4 opacity-60" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar mode="single" selected={selected} defaultMonth={selected} initialFocus
                    onSelect={(d) => { if (d) { onChange(ymd(d)); setOpen(false); } }} />
          <div className="flex justify-between border-t border-border px-3 py-2 text-xs">
            <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => { onChange(""); setOpen(false); }}>Clear</Button>
            <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => { onChange(ymd(new Date())); setOpen(false); }}>Today</Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** A button that opens a checklist: pick any number of items (campaigns, states ...). Nothing picked = "Select <noun>". */
function MultiSelect({
  label, noun, items, value, onChange, emptyText,
}: {
  label: string; noun: string; items: { value: string; label: string }[]; value: string[];
  onChange: (v: string[]) => void; emptyText: string;
}) {
  const text = !value.length
    ? `Select ${noun}`
    : value.length === 1
      ? items.find((i) => i.value === value[0])?.label ?? `1 ${noun}`
      : `${value.length} ${noun}s`;
  return (
    <div className="min-w-[10rem] flex-1 space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Popover>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" className="w-full justify-between font-normal" aria-label={label}>
            <span className="truncate">{text}</span>
            <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-2" align="start">
          {items.length ? (
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {items.map((i) => (
                <label key={i.value} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent">
                  <Checkbox
                    checked={value.includes(i.value)}
                    onCheckedChange={(v) => onChange(v ? [...value, i.value] : value.filter((x) => x !== i.value))}
                  />
                  <span className="truncate">{i.label}</span>
                </label>
              ))}
            </div>
          ) : (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">{emptyText}</p>
          )}
          {value.length > 0 && (
            <Button type="button" variant="ghost" size="sm" className="mt-1 w-full" onClick={() => onChange([])}>
              Clear selection
            </Button>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

export function FilterBar({
  applied,
  onApply,
  hide = [],
  note,
  presets,
  extra,
  showState = false,
  showNumber = false,
}: {
  applied: CCFilters;
  onApply: (f: CCFilters) => void;
  hide?: Hideable[];
  note?: string;
  /** Replaces the default date presets (Today, Last 7 days ...), e.g. whole weeks / months for the periodic report. */
  presets?: PeriodPreset[];
  /** Extra control shown at the left of the Clear / Search row. */
  extra?: React.ReactNode;
  /** Show the State filter (only the State page uses it). */
  showState?: boolean;
  /** Show the phone-number filter (only the inbound tab of the Inbound & Outbound page uses it). */
  showNumber?: boolean;
}) {
  const [draft, setDraft] = useState<CCFilters>(applied);
  const [options, setOptions] = useState<Options | null>(null);
  const [open, setOpen] = useState(false);
  const presetList = useMemo<PeriodPreset[]>(
    () => presets ?? RANGE_PRESETS.map((p) => ({ ...p, ...presetRange(p.value) })),
    [presets],
  );
  const matchOf = (f: string, t: string) => findPreset(presetList, f, t)?.value ?? (f || t ? CUSTOM : "");
  const [preset, setPreset] = useState<string>(() => matchOf(applied.from, applied.to));

  useEffect(() => {
    setDraft(applied);
    setPreset(matchOf(applied.from, applied.to));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applied, presetList]);
  useEffect(() => {
    let live = true;
    api.getCallConsumption<Options>("/filters").then(({ data }) => live && data && setOptions(data));
    return () => { live = false; };
  }, []);

  const shown = (k: Hideable) => !hide.includes(k);
  const set = (patch: Partial<CCFilters>) => setDraft((d) => ({ ...d, ...patch }));
  const error = shown("dates") ? rangeError(draft.from, draft.to) : null;
  const dirty = !sameFilters(draft, applied);

  const search = () => !error && onApply(draft);
  const clear = () => {
    const d = defaultFilters();
    setPreset(matchOf(d.from, d.to));
    setDraft(d);
    onApply(d);
  };

  const pick = (label: string, value: string, onChange: (v: string) => void, items: { value: string; label: string }[], allLabel: string) => (
    <div className="min-w-[10rem] flex-1 space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Select value={value} onValueChange={(v) => onChange(v === ALL ? "" : v)}>
        <SelectTrigger aria-label={label}><SelectValue placeholder={`Select ${label.toLowerCase()}`} /></SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{allLabel}</SelectItem>
          {items.map((i) => <SelectItem key={i.value} value={i.value}>{i.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <div>
      <div className={cn("flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3", open && "rounded-b-none")}>
        <p className="text-xs text-muted-foreground">{note}</p>
        <Button type="button" variant="outline" size="sm" className="ml-auto" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <FilterIcon className="mr-1 h-4 w-4" /> Filter
        </Button>
      </div>
      {open && (
    <form
        className="space-y-3 rounded-b-xl border border-t-0 border-border bg-card p-4 pt-1"
        onSubmit={(e) => { e.preventDefault(); search(); }}
        aria-label="Filters"
      >
        <div className="flex flex-wrap items-end gap-3">
          {shown("dates") && (
            <>
              <div className="min-w-[10rem] flex-1 space-y-1">
                <Label className="text-xs text-muted-foreground">Date range</Label>
                <Select
                  value={preset}
                  onValueChange={(v) => {
                    setPreset(v);
                    const hit = presetList.find((p) => p.value === v);
                    if (hit) set({ from: hit.from, to: hit.to });
                  }}
                >
                  <SelectTrigger aria-label="Date range"><SelectValue placeholder="Select date range" /></SelectTrigger>
                  <SelectContent>
                    {presetList.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
                    <SelectItem value={CUSTOM}>Custom</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <DateField label="From" value={draft.from} onChange={(v) => { setPreset(CUSTOM); set({ from: v }); }} />
              <DateField label="To" value={draft.to} onChange={(v) => { setPreset(CUSTOM); set({ to: v }); }} />
            </>
          )}
  
          {shown("campaign") && (
            <MultiSelect
              label="Campaign"
              noun="campaign"
              items={(options?.campaigns ?? []).map((c) => ({ value: c.id, label: c.name }))}
              value={draft.campaignIds}
              onChange={(v) => set({ campaignIds: v })}
              emptyText="No campaigns yet."
            />
          )}
          {showNumber && (
            <MultiSelect
              label="Number"
              noun="number"
              items={(options?.numbers ?? []).map((n) => ({ value: n.id, label: n.name }))}
              value={draft.numberIds}
              onChange={(v) => set({ numberIds: v })}
              emptyText="No phone numbers yet."
            />
          )}
          {showState && (
            <MultiSelect
              label="State"
              noun="state"
              items={(options?.states ?? []).map((st) => ({ value: st.code, label: st.name }))}
              value={draft.states}
              onChange={(v) => set({ states: v })}
              emptyText="No calls with a US state yet."
            />
          )}

          {shown("vertical") && pick("Vertical", draft.vertical, (v) => set({ vertical: v }),
            (options?.verticals ?? []).map((v) => ({ value: v, label: v })), "All verticals")}
          {shown("agent") && pick("Agent", draft.agentId, (v) => set({ agentId: v }),
            (options?.agents ?? []).map((a) => ({ value: a.id, label: a.name })), "All agents")}
          {shown("direction") && pick("Direction", draft.direction, (v) => set({ direction: v }),
            [{ value: "outbound", label: "Outbound" }, { value: "inbound", label: "Inbound" }], "Inbound + outbound")}
          {shown("disposition") && pick("Outcome", draft.disposition, (v) => set({ disposition: v }),
            options?.dispositions ?? [], "All outcomes")}
        </div>
  
        <div className="flex flex-wrap items-center justify-end gap-2">
          {extra && <div className="mr-auto">{extra}</div>}
          <div className="flex items-center gap-2">
            {error && <span role="alert" className="text-xs text-destructive">{error}</span>}
            <Button type="button" variant="outline" size="sm" onClick={clear}><X className="mr-1 h-4 w-4" /> Clear</Button>
            <Button type="submit" size="sm" disabled={!!error} data-dirty={dirty}><Search className="mr-1 h-4 w-4" /> Search</Button>
          </div>
        </div>
      </form>
    
      )}
    </div>
  );
}
