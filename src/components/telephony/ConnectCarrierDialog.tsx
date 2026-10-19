/**
 * Dialog for saving a user's own carrier account (Twilio, Vonage or Telnyx — BYOT) via
 * api.createTwilioCredential (POST /telephony/twilio-credentials).
 * Opened from CreatePhoneNumberDialog; onConnected lets the parent refresh its account list.
 * Fields, labels and hints come from the carrier registry in src/lib/carriers.ts.
 */
import { useState } from "react";
import { X, Link2, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/services/api";
import { CARRIERS, type CarrierKey } from "@/lib/carriers";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected?: () => void;
  /** Which carrier's account to connect. Defaults to Twilio. */
  carrier?: CarrierKey;
};

/**
 * Controlled credential form (open/onOpenChange). Calls onConnected after a successful save.
 * Secret fields are masked unless the user toggles reveal.
 */
export function ConnectCarrierDialog({ open, onOpenChange, onConnected, carrier = "twilio" }: Props) {
  const def = CARRIERS[carrier];
  const [values, setValues] = useState<Record<string, string>>({});
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});

  // Clears all fields (including secrets) and re-masks them.
  const reset = () => {
    setValues({});
    setRevealed({});
    setLabel("");
  };

  // Dialog open-change handler: closing wipes the form so credentials don't linger in state.
  const close = (v: boolean) => {
    if (!v) reset();
    onOpenChange(v);
  };

  // Requires every field, submits them trimmed (label optional), and on success closes the
  // dialog and then notifies the parent. On API error the dialog stays open with the input kept.
  const save = async () => {
    if (def.fields.some((f) => !values[f.key]?.trim())) {
      const names = def.fields.map((f) => f.label).join(" and ");
      toast.error(`${names} ${def.fields.length > 1 ? "are both" : "is"} required`);
      return;
    }
    setSaving(true);
    const { error } = await api.createTwilioCredential({
      carrier,
      account_sid: values.account_sid?.trim(),
      auth_token: values.auth_token.trim(),
      label: label.trim() || undefined,
    });
    setSaving(false);
    if (error) return toast.error(error);
    toast.success(`${def.label} account connected`);
    close(false);
    onConnected?.();
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg p-0 gap-0 [&>button]:hidden">
        <VisuallyHidden>
          <DialogTitle>Connect your {def.label} account</DialogTitle>
          <DialogDescription>Add your {def.label} {def.fields.map((f) => f.label).join(" and ")}</DialogDescription>
        </VisuallyHidden>

        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-bold">Connect your {def.label} account</h2>
          <button onClick={() => close(false)} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 px-6 py-6">
          <p className="text-xs text-muted-foreground">{def.connectNote}</p>
          {def.fields.map((f) => (
            <div key={f.key} className="space-y-2">
              <Label>{f.label}</Label>
              {f.secret ? (
                <div className="relative">
                  <Input
                    type={revealed[f.key] ? "text" : "password"}
                    value={values[f.key] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                    placeholder={f.placeholder}
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setRevealed((r) => ({ ...r, [f.key]: !r[f.key] }))}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
                    aria-label={revealed[f.key] ? "Hide secret" : "Show secret"}
                  >
                    {revealed[f.key] ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              ) : (
                <Input
                  value={values[f.key] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  placeholder={f.placeholder}
                />
              )}
            </div>
          ))}
          <div className="space-y-2">
            <Label>Label (optional)</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={def.labelPlaceholder} />
          </div>
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-border px-6 py-4 bg-muted/20 sm:flex-row sm:items-center sm:justify-end">
          <Button variant="outline" onClick={() => close(false)} className="w-full sm:w-auto">
            <X className="mr-1 h-4 w-4" /> Cancel
          </Button>
          <Button onClick={save} disabled={saving} className="w-full bg-primary text-primary-foreground hover:opacity-90 sm:w-auto">
            <Link2 className="mr-1 h-4 w-4" /> {saving ? "Connecting…" : "Connect"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
