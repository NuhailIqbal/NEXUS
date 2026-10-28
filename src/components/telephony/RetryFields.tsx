/**
 * The call-retry form shared by the create-campaign wizard and the campaign settings dialog: an on/off
 * switch and, while it is on, how many calls a number gets in all, the wait between them and which
 * outcomes trigger another call. Below it, the follow-up rounds: once the list is complete the campaign
 * calls the numbers that never picked up again, a set number of extra times with a wait between the rounds
 * (needs Auto Redial, so its controls are disabled while that is off). Controlled: the parent owns the
 * RetrySettings value and saves it. No API calls. (Behaviour: backend services/call_retry.py and
 * services/followup_rounds.py.)
 */
import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  FOLLOWUP_GAP_PRESETS, FOLLOWUP_GAP_RANGE, FOLLOWUP_ROUND_OPTIONS, INTERVAL_OPTIONS, MAX_ATTEMPT_OPTIONS, RETRY_OUTCOMES,
  RETRY_OUTCOME_LABELS, type RetryOutcome, type RetrySettings,
} from "@/lib/callRetry";

type Props = {
  /** Unique id prefix so several forms can share a page. */
  idPrefix: string;
  value: RetrySettings;
  onChange: (next: RetrySettings) => void;
  /** Shown under the fields while editing a campaign that may already be running. */
  editing?: boolean;
};

/** The number in the box (an emptied box is NaN, which validation reports). */
const toNumber = (raw: string) => (raw.trim() === "" ? NaN : Number(raw));
const shown = (n: number) => (Number.isFinite(n) ? String(n) : "");

export function RetryFields({ idPrefix, value, onChange, editing }: Props) {
  const set = (patch: Partial<RetrySettings>) => onChange({ ...value, ...patch });
  const toggle = (o: RetryOutcome, on: boolean) =>
    set({ retryOn: RETRY_OUTCOMES.filter((x) => (x === o ? on : value.retryOn.includes(x))) });
  const noneChosen = value.enabled && value.retryOn.length === 0;
  // The rounds need Auto Redial: while it is off they read as off and cannot be changed.
  const rounds = value.enabled ? value.followupRounds : 0;
  const gapProblem = value.enabled && rounds > 0 && !(Number.isInteger(value.followupGapHours)
    && value.followupGapHours >= FOLLOWUP_GAP_RANGE.min && value.followupGapHours <= FOLLOWUP_GAP_RANGE.max);

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
          onCheckedChange={(v) => set(v ? { enabled: true } : { enabled: false, followupRounds: 0 })}
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

      <div className="space-y-3 border-t border-border pt-5">
        <div>
          <h4 className="text-sm font-semibold">Follow-up rounds</h4>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {!value.enabled
              ? "Turn on Auto Redial above to call numbers that never picked up again."
              : rounds > 0
                ? `After the list is complete, numbers that never picked up are called again, up to ${rounds} more ${rounds === 1 ? "time" : "times"}. Numbers that answered, were transferred, disqualified, asked not to be called or are invalid are never called again. Calling hours always apply.`
                : "Off: numbers that never picked up are left as they are. Choose a number of rounds to call them again after the list is complete."}
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-followup-rounds`}>Rounds</Label>
            <Select
              value={String(rounds)}
              disabled={!value.enabled}
              onValueChange={(v) => set({ followupRounds: Number(v) })}
            >
              <SelectTrigger id={`${idPrefix}-followup-rounds`} aria-label="Rounds">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FOLLOWUP_ROUND_OPTIONS.map((n) => (
                  <SelectItem key={n} value={String(n)}>{n === 0 ? "Off" : n === 1 ? "1 round" : `${n} rounds`}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-followup-gap`}>Wait between rounds</Label>
            <div className="flex items-center gap-2">
              <Input
                id={`${idPrefix}-followup-gap`}
                type="number"
                inputMode="numeric"
                min={FOLLOWUP_GAP_RANGE.min}
                max={FOLLOWUP_GAP_RANGE.max}
                step={1}
                disabled={rounds === 0}
                value={shown(value.followupGapHours)}
                onChange={(e) => set({ followupGapHours: toNumber(e.target.value) })}
                className="w-24"
              />
              <span className="text-sm text-muted-foreground">hours</span>
            </div>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Wait presets">
              {FOLLOWUP_GAP_PRESETS.map((p) => (
                <Button
                  key={p.hours}
                  type="button"
                  size="sm"
                  variant={value.followupGapHours === p.hours ? "default" : "outline"}
                  aria-pressed={value.followupGapHours === p.hours}
                  disabled={rounds === 0}
                  onClick={() => set({ followupGapHours: p.hours })}
                  className="h-7 px-2.5 text-xs"
                >
                  {p.label}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">Wait after a round ends before the next one starts.</p>
          </div>
        </div>
        {gapProblem && (
          <p role="alert" className="text-xs text-destructive">
            Wait between rounds must be a whole number of hours from {FOLLOWUP_GAP_RANGE.min} to {FOLLOWUP_GAP_RANGE.max}.
          </p>
        )}
      </div>
    </div>
  );
}
