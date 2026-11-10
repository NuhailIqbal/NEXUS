/**
 * The period selector of the partner reports: Weekly / Monthly / Annual (over their usual range) or a custom range with
 * From / To dates and a grouping, and (admin) a partner to narrow to. Says why a custom range cannot be used yet.
 * State lives in the caller (useReportSelection).
 */
import { DateField } from "@/components/call-consumption/FilterBar";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { CUSTOM_GROUPS, PRESETS, customRangeError, type ReportGroup, type ReportPreset } from "@/lib/partnerReports";
import type { CustomRange } from "./useReportSelection";

type Props = {
  preset: ReportPreset;
  onPreset: (p: ReportPreset) => void;
  custom: CustomRange;
  onCustom: (c: CustomRange) => void;
  /** Admin only: the partners to choose from. Leave out for a report that always covers everyone. */
  partners?: { id: string; name: string }[];
  partnerId?: string;
  onPartner?: (id: string) => void;
};

export default function ReportControls({ preset, onPreset, custom, onCustom, partners = [], partnerId = "all", onPartner }: Props) {
  const rangeError = preset === "custom" ? customRangeError(custom.start, custom.end) : null;
  const incomplete = preset === "custom" && (!custom.start || !custom.end);
  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <div className="inline-flex flex-wrap rounded-lg border border-border bg-card/40 p-1" role="group" aria-label="Report period">
          {PRESETS.map((p) => (
            <button
              key={p.value} type="button" aria-pressed={preset === p.value} title={p.hint}
              onClick={() => onPreset(p.value)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                preset === p.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>

        {preset === "custom" && (
          <>
            <DateField label="From" className="w-40 min-w-0 flex-none" value={custom.start} onChange={(v) => onCustom({ ...custom, start: v })} />
            <DateField label="To" className="w-40 min-w-0 flex-none" value={custom.end} onChange={(v) => onCustom({ ...custom, end: v })} />
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Group by</Label>
              <Select value={custom.group} onValueChange={(v) => onCustom({ ...custom, group: v as ReportGroup })}>
                <SelectTrigger className="w-32" aria-label="Group by"><SelectValue /></SelectTrigger>
                <SelectContent>{CUSTOM_GROUPS.map((g) => <SelectItem key={g.value} value={g.value}>{g.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </>
        )}

        {partners.length > 0 && onPartner && (
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Partner</Label>
            <Select value={partnerId} onValueChange={onPartner}>
              <SelectTrigger className="w-56" aria-label="Partner"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All partners</SelectItem>
                {partners.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {rangeError && <p className="text-sm text-destructive">{rangeError}</p>}
      {incomplete && !rangeError && <p className="text-sm text-muted-foreground">Pick a start and an end date to see the report.</p>}
    </>
  );
}
