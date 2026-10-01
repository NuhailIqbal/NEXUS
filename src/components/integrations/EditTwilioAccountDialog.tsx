import { useEffect, useState } from "react";
import { X, Save, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/services/api";

type TwilioCredential = { id: string; account_sid: string; label?: string | null };

type Props = {
  target: TwilioCredential | null;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
};

export function EditTwilioAccountDialog({ target, onOpenChange, onSaved }: Props) {
  const [accountSid, setAccountSid] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [label, setLabel] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (target) {
      setAccountSid(target.account_sid);
      setLabel(target.label || "");
      setAuthToken("");
      setRevealed(false);
    }
  }, [target]);

  const close = () => onOpenChange(false);

  const save = async () => {
    if (!target) return;
    const sid = accountSid.trim();
    if (!sid) {
      toast.error("Account SID is required");
      return;
    }
    // Only send account_sid/auth_token when actually changed — including either
    // (even unchanged) makes the backend re-validate against Twilio, which a plain
    // label rename shouldn't have to pay for (or risk failing if Twilio is briefly down).
    const payload: { account_sid?: string; auth_token?: string; label: string } = { label: label.trim() };
    if (sid !== target.account_sid) payload.account_sid = sid;
    if (authToken.trim()) payload.auth_token = authToken.trim();

    setSaving(true);
    const { error } = await api.updateTwilioCredential(target.id, payload);
    setSaving(false);
    if (error) return toast.error(error);
    toast.success("Twilio account updated");
    close();
    onSaved?.();
  };

  return (
    <Dialog open={!!target} onOpenChange={(v) => !v && close()}>
      <DialogContent className="max-w-lg p-0 gap-0 [&>button]:hidden">
        <VisuallyHidden>
          <DialogTitle>Edit Twilio account</DialogTitle>
          <DialogDescription>Update the label, Account SID, or Auth Token</DialogDescription>
        </VisuallyHidden>

        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-bold">Edit Twilio account</h2>
          <button onClick={close} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 px-6 py-6">
          <div className="space-y-2">
            <Label>Label</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. My Twilio account" />
          </div>
          <div className="space-y-2">
            <Label>Account SID</Label>
            <Input value={accountSid} onChange={(e) => setAccountSid(e.target.value)} placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" />
          </div>
          <div className="space-y-2">
            <Label>Auth Token</Label>
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
