/**
 * "Create Phone Number" dialog, opened from the Phone Numbers page ("Buy Number").
 * A short guided form: what the number is for (purpose), where it comes from (a standard number
 * from us, or the user's own Twilio / Vonage / Telnyx account — BYOT), then the account / number
 * details, the inbound agent and the active switch. It validates and hands a PhoneNumberData to
 * onCreate; the parent calls the API.
 * Itself calls only getAgents and getTwilioCredentials, and embeds ConnectCarrierDialog.
 */
import { useEffect, useState, type ReactNode } from "react";
import { CheckCircle2, Info, Plug, Plus, X } from "lucide-react";
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
const STANDARD = "Twilio";
const PROVIDERS = [STANDARD, ...Object.values(CARRIERS).map((c) => c.providerValue)];

// User-facing labels are kept generic so we don't expose the underlying carrier
// (and the price it implies) to end users. Internal value stays "Twilio". The BYOT
// entries are the exception — the whole point of them is the user explicitly choosing
// their own carrier.
const PROVIDER_LABELS: Record<string, string> = {
  [STANDARD]: "Standard",
  ...Object.fromEntries(Object.values(CARRIERS).map((c) => [c.providerValue, c.label])),
};

const EMPTY: PhoneNumberData = { active: false, serviceProvider: "", agentId: "", purpose: "", byotMode: "import" };

/**
 * Controlled dialog (open/onOpenChange) for creating a number. Props: onCreate receives the
 * validated form data. On open it loads agents and connected carrier accounts. State resets on close.
 */
export function CreatePhoneNumberDialog({ open, onOpenChange, onCreate }: Props) {
  const [data, setData] = useState<PhoneNumberData>(EMPTY);
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

  const reset = () => setData(EMPTY);

  // Dialog open-change handler: closing (by any route) discards the form before notifying the parent.
  const close = (v: boolean) => {
    if (!v) reset();
    onOpenChange(v);
  };

  const carrier = carrierFromProviderValue(data.serviceProvider);
  const isByot = !!carrier;
  const accounts = accountsFor(credentials, data.serviceProvider);
  const ownCarrierOnly = usesOwnCarrierOnly(data.purpose);
  const providers = PROVIDERS.filter((p) => !(ownCarrierOnly && p === STANDARD));

  const choosePurpose = (v: Purpose) => {
    // Outbound calling (outbound or both) needs the user's own carrier number, so
    // "Standard" isn't offered for it — drop it if it was already picked.
    const dropStandard = usesOwnCarrierOnly(v) && data.serviceProvider === STANDARD;
    setData({
      ...data,
      purpose: v,
      agentId: v === "outbound" ? "" : data.agentId,
      serviceProvider: dropStandard ? "" : data.serviceProvider,
    });
  };

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
      {/* [&>button]:hidden removes shadcn's built-in close X — this dialog has its own in the header.
          Header and footer stay put; only the middle scrolls on short screens. */}
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] max-w-xl flex-col gap-0 overflow-hidden p-0 sm:p-0 [&>button]:hidden">
        <VisuallyHidden>
          <DialogTitle>Create Phone Number</DialogTitle>
          <DialogDescription>Provision a new phone number</DialogDescription>
        </VisuallyHidden>

        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4 sm:px-6">
          <div>
            <h2 className="text-lg font-bold leading-tight">Create Phone Number</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">Get a number ready for your AI agents in three quick steps.</p>
          </div>
          <button
            onClick={() => close(false)}
            aria-label="Close"
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-7 overflow-y-auto px-5 py-6 sm:px-6">
          <Section step={1} title="What will this number do?">
            <Select value={data.purpose} onValueChange={(v) => choosePurpose(v as Purpose)}>
              <SelectTrigger aria-label="Purpose">
                <SelectValue placeholder="Select type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inbound">Inbound</SelectItem>
                <SelectItem value="outbound">Outbound</SelectItem>
                <SelectItem value="both">Both</SelectItem>
              </SelectContent>
            </Select>
          </Section>

          <Section
            step={2}
            title="Where does the number come from?"
            hint={ownCarrierOnly ? "Outbound calling uses a number from your own carrier account." : undefined}
          >
            <Select value={data.serviceProvider} onValueChange={chooseProvider}>
              <SelectTrigger aria-label="Service Provider">
                <SelectValue placeholder="Please select your phone number provider" />
              </SelectTrigger>
              <SelectContent>
                {providers.map((p) => (
                  <SelectItem key={p} value={p}>{PROVIDER_LABELS[p] ?? p}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            {data.serviceProvider === STANDARD && (
              <Callout>
                This number costs <span className="font-medium text-foreground">$3</span>. If your account balance
                covers it, it's deducted from your balance; otherwise you'll be taken to secure Stripe checkout to pay.
              </Callout>
            )}

            {carrier && (
              <div className="space-y-4 rounded-xl border border-border bg-muted/20 p-4">
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">$1/month</span> platform fee. {carrier.label} bills you
                  directly for the number and call minutes.
                </p>
                {carrier.numberNote && (
                  <Callout icon>{carrier.numberNote}</Callout>
                )}

                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-sm font-semibold">{carrier.label} account</label>
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
                    <Plug className="mr-1.5 h-3.5 w-3.5" />
                    {accounts.length === 0 ? `Connect a ${carrier.label} account` : `Connect another ${carrier.label} account`}
                  </Button>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-semibold">How do you want to get the number?</label>
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
                    <label className="text-sm font-semibold" htmlFor="byot-number">Your phone number</label>
                    <Input
                      id="byot-number"
                      value={data.byotNumber || ""}
                      onChange={(e) => setData({ ...data, byotNumber: e.target.value })}
                      placeholder="+1XXXXXXXXXX"
                      inputMode="tel"
                      autoComplete="off"
                    />
                    <p className="text-xs text-muted-foreground">Include the country code, e.g. +15551234567.</p>
                  </div>
                )}
              </div>
            )}
          </Section>

          <Section step={3} title="Agent and status">
            {data.purpose !== "outbound" ? (
              <div className="space-y-1.5">
                <label className="text-sm font-semibold">Assign AI Agent</label>
                <Select
                  value={data.agentId || "__none__"}
                  onValueChange={(v) => setData({ ...data, agentId: v === "__none__" ? "" : v })}
                >
                  <SelectTrigger aria-label="Assign AI Agent">
                    <SelectValue placeholder="No agent assigned" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">No agent assigned</SelectItem>
                    {agents.map((a) => (
                      <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Agent that handles inbound calls on this number.</p>
              </div>
            ) : (
              <Callout icon>
                You can add this number to a campaign from Outbound → Campaigns once it's created.
              </Callout>
            )}

            <div className="flex items-center justify-between gap-3 rounded-xl border border-border px-4 py-3">
              <div>
                <div className="text-sm font-semibold">Active</div>
                <div className="text-xs text-muted-foreground">Turn it on to start using the number straight away.</div>
              </div>
              <Switch aria-label="Active" checked={data.active} onCheckedChange={(v) => setData({ ...data, active: v })} />
            </div>
          </Section>
        </div>

        <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-border bg-muted/20 px-5 py-4 sm:flex-row sm:items-center sm:justify-end sm:px-6">
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

/** Purposes that place outbound calls: those need a number from the user's own carrier (no "Standard"). */
const usesOwnCarrierOnly = (purpose: string) => purpose === "outbound" || purpose === "both";

/** The saved accounts that belong to the carrier behind a provider value (none for Standard). */
function accountsFor(list: CarrierCredential[], providerValue: string): CarrierCredential[] {
  const c = carrierFromProviderValue(providerValue);
  return c ? list.filter((a) => carrierOf(a.carrier).key === c.key) : [];
}

/** A numbered step with a title and an optional one-line hint. */
function Section({ step, title, hint, children }: { step: number; title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[11px] font-bold text-primary">
          {step}
        </span>
        <div>
          <h3 className="text-sm font-semibold leading-5">{title}</h3>
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

/** A quiet note box; `icon` adds an info mark in front. */
function Callout({ icon, children }: { icon?: boolean; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
      {icon && <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
      <div>{children}</div>
    </div>
  );
}
