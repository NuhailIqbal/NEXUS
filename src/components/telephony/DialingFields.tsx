/**
 * The dialing-strategy form shared by the create-campaign wizard and the campaign edit wizard: how the
 * campaign places its calls (one at a time, several at once, or at a steady rate) and the delay between
 * calls. Controlled: the parent owns the DialingSettings value and saves it. No API calls; the account's
 * call limit comes in as a prop. (Behaviour: backend services/dialer.py.)
 */
import { AlertTriangle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DIALING_STRATEGIES, DIALING_STRATEGY_DESCRIPTIONS, DIALING_STRATEGY_LABELS, MAX_CALLS_PER_MINUTE,
  MAX_CONCURRENT_CALLS, MAX_DELAY_SECONDS, limitWarning, validateDialing,
  type DialingLimits, type DialingSettings,
} from "@/lib/dialingStrategy";

type Props = {
  /** Unique id prefix so several forms can share a page. */
  idPrefix: string;
  value: DialingSettings;
  onChange: (next: DialingSettings) => void;
  /** The account's call limit (GET /telephony/dialing/limits); null while unknown or when there is no cap. */
  limits?: DialingLimits | null;
  /** Shown under the fields while editing a campaign that may already be running. */
  editing?: boolean;
};

/** What the delay field means for each strategy. */
const DELAY_HINTS = {
  sequential: "Wait this long after a call ends before the next call starts. 0 means straight away.",
  concurrent: "Wait this long between starting one call and the next. 0 means as fast as the calls above allow.",
  paced: "Least time between two calls. When it is longer than the rate above needs, calls go out slower than that rate.",
} as const;

/** The number in the box (an emptied box is NaN, which validation reports). */
const toNumber = (raw: string) => (raw.trim() === "" ? NaN : Number(raw));
const shown = (n: number) => (Number.isFinite(n) ? String(n) : "");

export function DialingFields({ idPrefix, value, onChange, limits, editing }: Props) {
  const set = (patch: Partial<DialingSettings>) => onChange({ ...value, ...patch });
  const problem = validateDialing(value);
  const warning = limitWarning(value, limits);

  return (
    <div className="space-y-5">
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-semibold">Dialing strategy</legend>
        <div role="radiogroup" aria-label="Dialing strategy" className="grid gap-2 sm:grid-cols-3">
          {DIALING_STRATEGIES.map((s) => {
            const on = value.strategy === s;
            return (
              <label
                key={s}
                htmlFor={`${idPrefix}-strategy-${s}`}
                className={`flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 transition-colors ${
                  on ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40"
                }`}
              >
                <input
                  type="radio"
                  id={`${idPrefix}-strategy-${s}`}
                  name={`${idPrefix}-strategy`}
                  aria-label={DIALING_STRATEGY_LABELS[s]}
                  aria-describedby={`${idPrefix}-strategy-${s}-desc`}
                  checked={on}
                  onChange={() => set({ strategy: s })}
                  className="mt-1 h-4 w-4 shrink-0 accent-primary"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">{DIALING_STRATEGY_LABELS[s]}</span>
                  <span id={`${idPrefix}-strategy-${s}-desc`} className="mt-0.5 block text-xs text-muted-foreground">
                    {DIALING_STRATEGY_DESCRIPTIONS[s]}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        {value.strategy === "concurrent" && (
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-concurrent`}>Concurrent Calls</Label>
            <Input
              id={`${idPrefix}-concurrent`}
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_CONCURRENT_CALLS}
              step={1}
              value={shown(value.concurrentCalls)}
              onChange={(e) => set({ concurrentCalls: toNumber(e.target.value) })}
            />
            <p className="text-xs text-muted-foreground">How many calls run at the same time, 1 to {MAX_CONCURRENT_CALLS}.</p>
          </div>
        )}
        {value.strategy === "paced" && (
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-per-minute`}>Calls per Minute</Label>
            <Input
              id={`${idPrefix}-per-minute`}
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_CALLS_PER_MINUTE}
              step={1}
              value={shown(value.callsPerMinute)}
              onChange={(e) => set({ callsPerMinute: toNumber(e.target.value) })}
            />
            <p className="text-xs text-muted-foreground">How many calls start each minute, 1 to {MAX_CALLS_PER_MINUTE}.</p>
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-delay`}>Delay between calls (seconds)</Label>
          <Input
            id={`${idPrefix}-delay`}
            type="number"
            inputMode="numeric"
            min={0}
            max={MAX_DELAY_SECONDS}
            step={1}
            value={shown(value.delaySeconds)}
            onChange={(e) => set({ delaySeconds: toNumber(e.target.value) })}
          />
          <p className="text-xs text-muted-foreground">{DELAY_HINTS[value.strategy]}</p>
        </div>
      </div>

      {problem && <p role="alert" className="text-xs text-destructive">{problem}</p>}

      {warning && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-xs text-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <p>{warning}</p>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        A number is called once per run. Redials (if Auto Redial is on) use the same limits as the first calls, and
        calling hours still apply: no new calls start outside them, and calls already in progress are never cut off.
        {editing && " Changes apply to calls placed from now on, not to calls already in progress."}
      </p>
    </div>
  );
}
