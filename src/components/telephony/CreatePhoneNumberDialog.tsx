/**
 * "Create Phone Number" dialog, opened from the Phone Numbers page ("Buy Number").
 * Collects purpose, provider (standard Twilio-backed or BYOT), optional BYOT account/number and
 * inbound agent, validates, and hands a PhoneNumberData to onCreate; the parent calls the API.
 * Itself calls only getAgents and getTwilioCredentials, and embeds ConnectTwilioDialog.
 */
import { useEffect, useState } from "react";
import { X, Plus, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/services/api";
import { ConnectTwilioDialog } from "@/components/telephony/ConnectTwilioDialog";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate?: (data: PhoneNumberData) => void;
};

export type Purpose = "inbound" | "outbound" | "both";
/** BYOT: "import" a number already owned on the user's Twilio account, or "purchase" a new one there. */
export type ByotMode = "import" | "purchase";

export type PhoneNumberData = {
  active: boolean;
  serviceProvider: string;
  agentId: string;
  purpose: Purpose | "";
  // BYOT-only fields
  byotCredentialId?: string;
  byotMode?: ByotMode;
  byotNumber?: string;
};

/** A saved Twilio account as returned by GET /telephony/twilio-credentials (token is masked). */
type TwilioCredential = { id: string; account_sid: string; auth_token_masked?: string; label?: string | null };

const PROVIDERS = ["Twilio", "BYOT"];

// User-facing labels are kept generic so we don't expose the underlying carrier
// (and the price it implies) to end users. Internal value stays "Twilio". BYOT is
// the one exception — the whole point of it is the user explicitly choosing Twilio.
const PROVIDER_LABELS: Record<string, string> = {
  Twilio: "Standard",
  BYOT: "Twilio",
};

/**
 * Controlled dialog (open/onOpenChange) for creating a number. Props: onCreate receives the
 * validated form data. On open it loads agents and connected Twilio accounts. State resets on close.
 */
export function CreatePhoneNumberDialog({ open, onOpenChange, onCreate }: Props) {
  const [data, setData] = useState<PhoneNumberData>({
    active: false,
    serviceProvider: "",
    agentId: "",
    purpose: "",
    byotMode: "import",
  });
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);
  const [credentials, setCredentials] = useState<TwilioCredential[]>([]);
  const [connectOpen, setConnectOpen] = useState(false);

  // Fetches connected Twilio accounts; also used as the refresh callback after connecting a new one.
  const loadCredentials = () => {
    api.getTwilioCredentials().then(({ data: d }) => {
      const list = (d as TwilioCredential[]) ?? [];
      setCredentials(list);
      // Auto-select when exactly one account is connected — no need to make the user
      // pick from a list of one, and it makes the "already connected" state obvious.
      if (list.length === 1) {
        setData((prev) => (prev.byotCredentialId ? prev : { ...prev, byotCredentialId: list[0].id }));
      }
    });
  };

  // Reload dropdown data every time the dialog opens so it is never stale.
  useEffect(() => {
    if (open) {
      api.getAgents().then(({ data: d }) => setAgents((d as any[]) ?? []));
      loadCredentials();
    }
  }, [open]);

  const reset = () => setData({ active: false, serviceProvider: "", agentId: "", purpose: "", byotMode: "import" });

  // Dialog open-change handler: closing (by any route) discards the form before notifying the parent.
  const close = (v: boolean) => {
    if (!v) reset();
    onOpenChange(v);
  };

  const isByot = data.serviceProvider === "BYOT";

  // Validates the form (toasting the first problem) and, if valid, passes it to onCreate and closes.
  const create = () => {
    if (!data.purpose) return toast.error("Please select a purpose");
    if (!data.serviceProvider) return toast.error("Please select a service provider");
    if (isByot) {
      if (!data.byotCredentialId) return toast.error("Please select (or connect) a Twilio account");
      if (data.byotMode === "import" && !data.byotNumber?.trim()) return toast.error("Enter the phone number you already own");
    }
    // Trim so accidental leading/trailing whitespace never breaks the Twilio
    // account-ownership match on a BYOT import.
    onCreate?.(data.byotNumber ? { ...data, byotNumber: data.byotNumber.trim() } : data);
    close(false);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg p-0 gap-0 [&>button]:hidden">
        {/* [&>button]:hidden removes shadcn's built-in close X — this dialog has its own in the header */}
        <VisuallyHidden>
          <DialogTitle>Create Phone Number</DialogTitle>
          <DialogDescription>Provision a new phone number</DialogDescription>
        </VisuallyHidden>

        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-bold">Create Phone Number</h2>
          <button onClick={() => close(false)} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 px-6 py-6">
          <div>
            <label className="block text-sm font-semibold mb-1.5">Purpose</label>
            <Select
              value={data.purpose}
              onValueChange={(v) => setData({ ...data, purpose: v as Purpose, agentId: v === "outbound" ? "" : data.agentId })}
            >
              <SelectTrigger aria-label="Purpose">
                <SelectValue placeholder="Select type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inbound">Inbound</SelectItem>
                <SelectItem value="outbound">Outbound</SelectItem>
                <SelectItem value="both">Both</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="block text-sm font-semibold mb-1.5">Service Provider</label>
            <Select value={data.serviceProvider} onValueChange={(v) => setData({ ...data, serviceProvider: v })}>
              <SelectTrigger aria-label="Service Provider">
                <SelectValue placeholder="Please select your phone number provider" />
              </SelectTrigger>
              <SelectContent>
                {PROVIDERS.map((p) => (<SelectItem key={p} value={p}>{PROVIDER_LABELS[p] ?? p}</SelectItem>))}
              </SelectContent>
            </Select>
          </div>

          {data.serviceProvider === "Twilio" && (
            <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
              This number costs <span className="font-medium text-foreground">$3</span>. If your account balance
              covers it, it's deducted from your balance; otherwise you'll be taken to secure Stripe checkout to pay.
            </div>
          )}

          {isByot && (
            <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">$1/month</span> platform fee. Twilio bills you
                directly for the number and call minutes.
              </p>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="block text-sm font-semibold">Twilio account</label>
                  {credentials.length > 0 && (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
                      <CheckCircle2 className="h-3.5 w-3.5" /> Connected
                    </span>
                  )}
                </div>
                {credentials.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No Twilio account connected yet.</p>
                ) : (
                  <Select
                    value={data.byotCredentialId || ""}
                    onValueChange={(v) => setData({ ...data, byotCredentialId: v })}
                  >
                    <SelectTrigger aria-label="Twilio account">
                      <SelectValue placeholder="Select a connected Twilio account" />
                    </SelectTrigger>
                    <SelectContent>
                      {credentials.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.label || c.account_sid}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <Button type="button" variant="outline" size="sm" onClick={() => setConnectOpen(true)}>
                  {credentials.length === 0 ? "Connect a Twilio account" : "Connect another Twilio account"}
                </Button>
              </div>

              <div className="space-y-1.5">
                <label className="block text-sm font-semibold">How do you want to get the number?</label>
                <Select
                  value={data.byotMode || "import"}
                  onValueChange={(v) => setData({ ...data, byotMode: v as ByotMode })}
                >
                  <SelectTrigger aria-label="Number acquisition mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="import">I already own a number</SelectItem>
                    <SelectItem value="purchase">Buy a new number on my Twilio account</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {data.byotMode !== "purchase" && (
                <div className="space-y-1.5">
                  <label className="block text-sm font-semibold">Your phone number</label>
                  <Input
                    value={data.byotNumber || ""}
                    onChange={(e) => setData({ ...data, byotNumber: e.target.value })}
                    placeholder="+1XXXXXXXXXX"
                  />
                </div>
              )}
            </div>
          )}

          {data.purpose !== "outbound" ? (
            <div>
              <label className="block text-sm font-semibold mb-1.5">Assign AI Agent</label>
              <Select
                value={data.agentId || "__none__"}
                onValueChange={(v) => setData({ ...data, agentId: v === "__none__" ? "" : v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="No agent assigned" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">No agent assigned</SelectItem>
                  {agents.map((a) => (
                    <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1 text-xs text-muted-foreground">Agent that handles inbound calls on this number.</p>
            </div>
          ) : (
            <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
              You can add this number to a campaign from Outbound → Campaigns once it's created.
            </div>
          )}

          <ToggleRow label="Active" checked={data.active} onChange={(v) => setData({ ...data, active: v })} />
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-border px-6 py-4 bg-muted/20 sm:flex-row sm:items-center sm:justify-end">
          <Button variant="outline" onClick={() => close(false)} className="w-full sm:w-auto">
            <X className="mr-1 h-4 w-4" /> Cancel
          </Button>
          <Button onClick={create} className="w-full bg-primary text-primary-foreground hover:opacity-90 sm:w-auto">
            <Plus className="mr-1 h-4 w-4" /> Create
          </Button>
        </div>

        <ConnectTwilioDialog open={connectOpen} onOpenChange={setConnectOpen} onConnected={loadCredentials} />
      </DialogContent>
    </Dialog>
  );
}

/** Labelled on/off switch row. */
function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-3">
      <Switch checked={checked} onCheckedChange={onChange} />
      <span className="text-sm font-semibold">{label}</span>
    </div>
  );
}
