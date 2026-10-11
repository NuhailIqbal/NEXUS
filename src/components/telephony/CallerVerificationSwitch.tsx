/**
 * "Verify callers before answering" switch row, shared by the Phone Numbers settings dialog and the
 * AI Receptionist cards. Controlled: the parent owns the value and decides when it is saved.
 *
 * `unavailableReason` is set when the server cannot run the check (not set up yet). The switch is then
 * locked OFF with the reason shown, but a number that already has it on can still be switched off.
 * `savedValue` is the value currently saved, when the parent edits a draft: a draft flipped off can
 * be flipped back on (that only restores what is in effect), so it is not locked.
 */
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { CALLER_VERIFICATION_LABEL } from "@/lib/callerVerification";

type Props = {
  id: string;
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
  disabled?: boolean;
  unavailableReason?: string | null;
  savedValue?: boolean;
};

export function CallerVerificationSwitch({
  id, checked, onCheckedChange, disabled, unavailableReason, savedValue,
}: Props) {
  const blocked = !checked && !savedValue && !!unavailableReason;
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border border-input p-3">
      <div className="min-w-0">
        <Label htmlFor={id} className="text-sm font-medium">{CALLER_VERIFICATION_LABEL}</Label>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Only mobile numbers reach your agent. Other callers hear a short message and the call ends.
        </p>
        {blocked && <p role="status" className="mt-1 text-xs text-warning">{unavailableReason}</p>}
      </div>
      <Switch
        id={id}
        aria-label={CALLER_VERIFICATION_LABEL}
        checked={checked}
        disabled={disabled || blocked}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}
