import { useState } from "react";
import { X, Link2, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/services/api";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected?: () => void;
};

export function ConnectTwilioDialog({ open, onOpenChange, onConnected }: Props) {
  const [accountSid, setAccountSid] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [revealed, setRevealed] = useState(false);

  const reset = () => {
    setAccountSid("");
    setAuthToken("");
    setRevealed(false);
    setLabel("");
  };

  const close = (v: boolean) => {
    if (!v) reset();
    onOpenChange(v);
  };

  const save = async () => {
    if (!accountSid.trim() || !authToken.trim()) {
      toast.error("Account SID and Auth Token are both required");
      return;
    }
    setSaving(true);
    const { error } = await api.createTwilioCredential({
      account_sid: accountSid.trim(),
      auth_token: authToken.trim(),
      label: label.trim() || undefined,
    });
    setSaving(false);
    if (error) return toast.error(error);
    toast.success("Twilio account connected");
    close(false);
    onConnected?.();
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg p-0 gap-0 [&>button]:hidden">
        <VisuallyHidden>
          <DialogTitle>Connect your Twilio account</DialogTitle>
          <DialogDescription>Add your Twilio Account SID and Auth Token</DialogDescription>
        </VisuallyHidden>

        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-bold">Connect your Twilio account</h2>
          <button onClick={() => close(false)} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 px-6 py-6">
          <p className="text-xs text-muted-foreground">
            Find these under your Twilio Console → Account → API keys &amp; tokens. Your number
            stays billed directly by Twilio to your own account — we only use these credentials
            to connect it to your AI agent.
          </p>
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
                placeholder="Your Twilio Auth Token"
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
          <div className="space-y-2">
            <Label>Label (optional)</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. My Twilio account" />
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
