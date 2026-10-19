/**
 * "Create Phone Number" dialog, opened from the Phone Numbers page ("Buy Number").
 * Collects purpose, provider (standard, or the user's own Twilio / Vonage / Telnyx account — BYOT),
 * optional BYOT account/number and inbound agent, validates, and hands a PhoneNumberData to
 * onCreate; the parent calls the API.
 * Itself calls only getAgents and getTwilioCredentials, and embeds ConnectCarrierDialog.
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
import { ConnectCarrierDialog } from "@/components/telephony/ConnectCarrierDialog";
import { CARRIERS, carrierFromProviderValue, carrierOf } from "@/lib/carriers";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate?: (data: PhoneNumberData) => void;
};

export type Purpose = "inbound" | "outbound" | "both";
/** BYOT: "import" a number already owned on the user's carrier account, or "purchase" a new one there. */
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

/** A saved carrier account as returned by GET /telephony/twilio-credentials (secret is masked). */
type CarrierCredential = {
  id: string;
  carrier?: string | null;
  account_sid?: string | null;
  auth_token_masked?: string;
  label?: string | null;
};

// "Twilio" is the standard (platform-provided) number; the others are the user's own carrier account.
const PROVIDERS = ["Twilio", ...Object.values(CARRIERS).map((c) => c.providerValue)];

// User-facing labels are kept generic so we don't expose the underlying carrier
// (and the price it implies) to end users. Internal value stays "Twilio". The BYOT
// entries are the exception — the whole point of them is the user explicitly choosing
// their own carrier.
const PROVIDER_LABELS: Record<string, string> = {
  Twilio: "Standard",
  ...Object.fromEntries(Object.values(CARRIERS).map((c) => [c.providerValue, c.label])),
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
  const [credentials, setCredentials] = useState<CarrierCredential[]>([]);
  const [connectOpen, setConnectOpen] = useState(false);

  // Fetches connected carrier accounts; also used as the refresh callback after connecting a new one.
  const loadCredentials = () => {
    api.getTwilioCredentials().then(({ data: d }) => {
      const list = (d as CarrierCredential[]) ?? [];
      setCredentials(list);
      // Auto-select when exactly one account is connected for the chosen carrier — no need to
      // make the user pick from a list of one, and it makes the "already connected" state obvious.
      setData((prev) => {
        const only = accountsFor(list, prev.serviceProvider);
        return only.length === 1 && !prev.byotCredentialId ? { ...prev, byotCredentialId: only[0].id } : prev;
      });
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

  const carrier = carrierFromProviderValue(data.serviceProvider);
  const isByot = !!carrier;
  const accounts = accountsFor(credentials, data.serviceProvider);

  // Switching provider drops the previously picked account (it belongs to another carrier) and
  // auto-selects the new carrier's account when there's exactly one.
  const chooseProvider = (v: string) => {
    const only = accountsFor(credentials, v);
    setData({ ...data, serviceProvider: v, byotCredentialId: only.length === 1 ? only[0].id : undefined });
  };

  // Validates the form (toasting the first problem) and, if valid, passes it to onCreate and closes.
  const create = () => {
    if (!data.purpose) return toast.error("Please select a purpose");
    if (!data.serviceProvider) return toast.error("Please select a service provider");
    if (isByot) {
      if (!data.byotCredentialId) return toast.error(`Please select (or connect) a ${carrier!.label} account`);
      if (data.byotMode === "import" && !data.byotNumber?.trim()) return toast.error("Enter the phone number you already own");
    }
    // Trim so accidental leading/trailing whitespace never breaks the carrier
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
            <Select value={data.serviceProvider} onValueChange={chooseProvider}>
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

          {carrier && (
            <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">$1/month</span> platform fee. {carrier.label} bills you
                directly for the number and call minutes.
              </p>
              {carrier.numberNote && <p className="text-xs text-muted-foreground">{carrier.numberNote}</p>}

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="block text-sm font-semibold">{carrier.label} account</label>
                  {accounts.length > 0 && (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
                      <CheckCircle2 className="h-3.5 w-3.5" /> Connected
                    </span>
                  )}
                </div>
                {accounts.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No {carrier.label} account connected yet.</p>
                ) : (
                  <Select
                    value={data.byotCredentialId || ""}
                    onValueChange={(v) => setData({ ...data, byotCredentialId: v })}
                  >
                    <SelectTrigger aria-label={`${carrier.label} account`}>
                      <SelectValue placeholder={`Select a connected ${carrier.label} account`} />
                    </SelectTrigger>
                    <SelectContent>
                      {accounts.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.label || c.account_sid || `${carrier.label} account`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <Button type="button" variant="outline" size="sm" onClick={() => setConnectOpen(true)}>
                  {accounts.length === 0 ? `Connect a ${carrier.label} account` : `Connect another ${carrier.label} account`}
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
                    <SelectItem value="purchase">Buy a new number on my {carrier.label} account</SelectItem>
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

        <ConnectCarrierDialog open={connectOpen} onOpenChange={setConnectOpen} onConnected={loadCredentials} carrier={carrier?.key} />
      </DialogContent>
    </Dialog>
  );
}

/** The saved accounts that belong to the carrier behind a provider value (none for Standard). */
function accountsFor(list: CarrierCredential[], providerValue: string): CarrierCredential[] {
  const c = carrierFromProviderValue(providerValue);
  return c ? list.filter((a) => carrierOf(a.carrier).key === c.key) : [];
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
