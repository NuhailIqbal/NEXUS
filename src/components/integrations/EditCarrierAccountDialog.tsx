import { useEffect, useState } from "react";
import { X, Save, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/services/api";
import { carrierOf, identifierField, secretField } from "@/lib/carriers";

export type CarrierAccount = {
  id: string;
  carrier?: string | null;
  /** Public identifier (Twilio SID / Vonage API key); null for Telnyx. */
  account_sid?: string | null;
  label?: string | null;
  auth_token_masked?: string;
};

type Props = {
  target: CarrierAccount | null;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
};

export function EditCarrierAccountDialog({ target, onOpenChange, onSaved }: Props) {
  const def = carrierOf(target?.carrier);
  const idField = identifierField(def);
  const secret = secretField(def);

  const [identifier, setIdentifier] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [label, setLabel] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (target) {
      setIdentifier(target.account_sid || "");
      setLabel(target.label || "");
      setAuthToken("");
      setRevealed(false);
    }
  }, [target]);

  const close = () => onOpenChange(false);

  const save = async () => {
    if (!target) return;
    const id = identifier.trim();
    if (idField && !id) {
      toast.error(`${idField.label} is required`);
      return;
    }
    // Only send the identifier/secret when actually changed — including either (even
    // unchanged) makes the backend re-validate against the carrier, which a plain label
    // rename shouldn't have to pay for (or risk failing if the carrier is briefly down).
    const payload: { account_sid?: string; auth_token?: string; label: string } = { label: label.trim() };
    if (idField && id !== (target.account_sid || "")) payload.account_sid = id;
    if (authToken.trim()) payload.auth_token = authToken.trim();

    setSaving(true);
    const { error } = await api.updateTwilioCredential(target.id, payload);
    setSaving(false);
    if (error) return toast.error(error);
    toast.success(`${def.label} account updated`);
    close();
    onSaved?.();
  };

  return (
    <Dialog open={!!target} onOpenChange={(v) => !v && close()}>
      <DialogContent className="max-w-lg p-0 gap-0 [&>button]:hidden">
        <VisuallyHidden>
          <DialogTitle>Edit {def.label} account</DialogTitle>
          <DialogDescription>Update the label or the account keys</DialogDescription>
        </VisuallyHidden>

        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-bold">Edit {def.label} account</h2>
          <button onClick={close} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 px-6 py-6">
          <div className="space-y-2">
            <Label>Label</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={def.labelPlaceholder} />
          </div>
          {idField && (
            <div className="space-y-2">
              <Label>{idField.label}</Label>
              <Input value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder={idField.placeholder} />
            </div>
          )}
          <div className="space-y-2">
            <Label>{secret.label}</Label>
            <div className="relative">
              <Input
                type={revealed ? "text" : "password"}
                value={authToken}
                onChange={(e) => setAuthToken(e.target.value)}
                placeholder="Leave blank to keep the current one"
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setRevealed((r) => !r)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
                aria-label={revealed ? "Hide secret" : "Show secret"}
              >
                {revealed ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-border px-6 py-4 bg-muted/20 sm:flex-row sm:items-center sm:justify-end">
          <Button variant="outline" onClick={close} className="w-full sm:w-auto">
            <X className="mr-1 h-4 w-4" /> Cancel
          </Button>
          <Button onClick={save} disabled={saving} className="w-full bg-primary text-primary-foreground hover:opacity-90 sm:w-auto">
            <Save className="mr-1 h-4 w-4" /> {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
