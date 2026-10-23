/**
 * The call-retry form shared by the create-campaign wizard and the campaign settings dialog: an on/off
 * switch and, while it is on, how many calls a number gets in all, the wait between them and which
 * outcomes trigger another call. Controlled: the parent owns the RetrySettings value and saves it.
 * No API calls. (Behaviour: backend services/call_retry.py.)
 */
import { Info } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  INTERVAL_OPTIONS, MAX_ATTEMPT_OPTIONS, RETRY_OUTCOMES, RETRY_OUTCOME_LABELS,
  type RetryOutcome, type RetrySettings,
} from "@/lib/callRetry";

type Props = {
  /** Unique id prefix so several forms can share a page. */
  idPrefix: string;
  value: RetrySettings;
  onChange: (next: RetrySettings) => void;
  /** Shown under the fields while editing a campaign that may already be running. */
  editing?: boolean;
};

export function RetryFields({ idPrefix, value, onChange, editing }: Props) {
  const set = (patch: Partial<RetrySettings>) => onChange({ ...value, ...patch });
  const toggle = (o: RetryOutcome, on: boolean) =>
    set({ retryOn: RETRY_OUTCOMES.filter((x) => (x === o ? on : value.retryOn.includes(x))) });
  const noneChosen = value.enabled && value.retryOn.length === 0;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <Label htmlFor={`${idPrefix}-enabled`} className="text-sm font-semibold">Enable auto redial</Label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {value.enabled
              ? "A number that does not pick up is called again after the wait below, until it has had the maximum number of calls."
              : "Off: every number in the list is called once."}
          </p>
        </div>
        <Switch
          id={`${idPrefix}-enabled`}
          aria-label="Enable auto redial"
          checked={value.enabled}
          onCheckedChange={(v) => set({ enabled: v })}
        />
      </div>

      {value.enabled && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-max`}>Calls per number</Label>
              <Select value={String(value.maxAttempts)} onValueChange={(v) => set({ maxAttempts: Number(v) })}>
                <SelectTrigger id={`${idPrefix}-max`} aria-label="Calls per number">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MAX_ATTEMPT_OPTIONS.map((n) => (
                    <SelectItem key={n} value={String(n)}>{n === 1 ? "1 call" : `${n} calls`}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Calls in all, the first one included.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-interval`}>Wait between calls</Label>
              <Select value={String(value.intervalMinutes)} onValueChange={(v) => set({ intervalMinutes: Number(v) })}>
                <SelectTrigger id={`${idPrefix}-interval`} aria-label="Wait between calls">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INTERVAL_OPTIONS.map((m) => (
                    <SelectItem key={m} value={String(m)}>{m} minutes</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Wait after a call ends before the next one.</p>
            </div>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold">Redial when</legend>
            {RETRY_OUTCOMES.map((o) => (
              <div key={o} className="flex items-center gap-2.5">
                <Checkbox
                  id={`${idPrefix}-on-${o}`}
                  checked={value.retryOn.includes(o)}
                  onCheckedChange={(v) => toggle(o, v === true)}
                />
                <Label htmlFor={`${idPrefix}-on-${o}`} className="cursor-pointer text-sm font-normal">
                  {RETRY_OUTCOME_LABELS[o]}
                </Label>
              </div>
            ))}
            {noneChosen && (
              <p role="alert" className="text-xs text-destructive">Choose at least one outcome to redial on.</p>
            )}
          </fieldset>

          <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <p>
              A number is never retried once someone answered and spoke with the agent, the call was transferred,
              the person was disqualified or asked not to be called, or the number is invalid or disconnected.
              Redials follow the campaign's calling hours: one that would fall outside them waits for the next
              opening, and a paused campaign holds its redials until it is started again.
              {editing && " Changes apply to calls placed from now on, not to calls already in progress."}
            </p>
          </div>
        </>
      )}
    </div>
  );
}
