import { useEffect, useState } from "react";
import { Check, CheckCircle2, ChevronLeft, ChevronRight, Eye, EyeOff, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/services/api";
import { CalendarConnectSteps } from "./CalendarConnectSteps";
import { startGoogleConnect } from "./calendarConnect";
import type { CalendarStatus } from "./calendarTypes";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate?: (data: { name: string; description: string; type: string; credentials: Record<string, string> }) => void;
  /** Called after a Twilio (BYOT) connection is saved, so the page's dedicated
   *  Twilio card (which has its own separate list/delete UI) can refresh. */
  onTwilioConnected?: () => void;
};

type FieldDef = { key: string; label: string; placeholder: string; help: string; type?: string };

// `provider` is written into the saved config blob so the backend can identify this
// integration reliably, independent of whatever the user types as its display name.
//
// WhitelistData, Brevo, SendGrid and SMTP are offered here — every other entry that used to
// live in this list (Twilio, Stripe, OpenAI, Gemini, and a long tail of placeholder providers
// with no backend behind them at all) has been removed at the user's request. Twilio is back,
// now backed by the real BYOT feature (services/twilio_byot_service.py) — see `twilioByot` below.
const INTEGRATION_TYPES: { value: string; label: string; provider?: string; urlPaste?: boolean; calendar?: boolean; twilioByot?: boolean; fields: FieldDef[] }[] = [
  { value: "WhitelistData", label: "WhitelistData", provider: "whitelistdata", urlPaste: true, fields: [
    { key: "apiKey", label: "API Key", placeholder: "d5078618-5c1c-4e3e-…", help: "The apiKey value from your WhitelistData account" },
    { key: "code", label: "Function Code", placeholder: "ONbKJs8jpJZWJU5vO9Zg…", help: "The code value from your WhitelistData endpoint URL" },
    { key: "secret", label: "Secret", placeholder: "sha290OpGRNz", help: "The secret value from your WhitelistData endpoint URL", type: "password" },
  ]},
  // Not an API-key integration: connecting goes through Google's own sign-in (OAuth), so this type
  // has no fields. Step 2 shows the setup steps and a "Connect with Google" button instead.
  { value: "GoogleCalendar", label: "Google Calendar", calendar: true, fields: [] },
  // Bring Your Own Twilio: saved via /telephony/twilio-credentials (a dedicated table/endpoint),
  // not the generic integrations table — see the twilioByot branch in next() below.
  { value: "TwilioByot", label: "Twilio", twilioByot: true, fields: [
    { key: "accountSid", label: "Account SID", placeholder: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", help: "Twilio Console → Account" },
    { key: "authToken", label: "Auth Token", placeholder: "Your Twilio Auth Token", help: "Twilio Console → Account → API keys & tokens", type: "password" },
  ]},
  { value: "Brevo", label: "Brevo", provider: "brevo", fields: [
    { key: "apiKey", label: "API Key", placeholder: "xkeysib-xxxxxxxxxxxx…", help: "Your Brevo API key (SMTP & API > API Keys)", type: "password" },
    { key: "fromEmail", label: "From Email", placeholder: "noreply@yourdomain.com", help: "Must be a verified sender in Brevo" },
  ]},
  { value: "SendGrid", label: "SendGrid", provider: "sendgrid", fields: [
    { key: "apiKey", label: "API Key", placeholder: "SG.xxxxxxxxxxxx…", help: "Your SendGrid API key (Settings > API Keys)", type: "password" },
    { key: "fromEmail", label: "From Email", placeholder: "noreply@yourdomain.com", help: "Must be a verified sender identity in SendGrid" },
  ]},
  { value: "SMTP", label: "SMTP", provider: "smtp", fields: [
    { key: "host", label: "SMTP Host", placeholder: "smtp.yourdomain.com", help: "Your SMTP server hostname" },
    { key: "port", label: "Port", placeholder: "587", help: "Usually 587 (TLS) or 465 (SSL)" },
    { key: "username", label: "Username", placeholder: "you@yourdomain.com", help: "SMTP login username" },
    { key: "password", label: "Password", placeholder: "••••••••", help: "SMTP login password", type: "password" },
    { key: "fromEmail", label: "From Email", placeholder: "noreply@yourdomain.com", help: "Address emails will be sent from" },
  ]},
];

export function AddIntegrationDialog({ open, onOpenChange, onCreate, onTwilioConnected }: Props) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState("");
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);

  const selected = INTEGRATION_TYPES.find((t) => t.value === type);
  const isCalendar = !!selected?.calendar;
  const isTwilioByot = !!selected?.twilioByot;

  const [calStatus, setCalStatus] = useState<CalendarStatus | null>(null);
  const [calLoading, setCalLoading] = useState(false);
  const [calError, setCalError] = useState<string | null>(null);
  const [isOwner, setIsOwner] = useState(true);
  const [connecting, setConnecting] = useState(false);

  const loadCalendar = async () => {
    setCalLoading(true);
    setCalError(null);
    const [s, role] = await Promise.all([api.getCalendarStatus(), api.getMyRole()]);
    if (s.error || !s.data) setCalError(s.error || "Couldn't load the calendar setup.");
    else setCalStatus(s.data as CalendarStatus);
    setIsOwner((role.data as { is_owner?: boolean } | null)?.is_owner ?? true);
    setCalLoading(false);
  };

  // Look up the calendar setup only when the person actually reaches the Google Calendar step.
  useEffect(() => {
    if (open && step === 2 && isCalendar) loadCalendar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step, isCalendar]);

  const connectGoogle = async () => {
    setConnecting(true);
    const err = await startGoogleConnect();
    if (err) {
      setConnecting(false);
      toast.error(err);
    }
  };
  const canConnect = !!calStatus && calStatus.configured && isOwner && (!calStatus.connected || calStatus.status === "reauth_required");

  const reset = () => {
    setStep(1);
    setName("");
    setDescription("");
    setType("");
    setCreds({});
    setCalStatus(null);
    setCalError(null);
    setConnecting(false);
    setSubmitting(false);
  };

  const close = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const next = async () => {
    if (step === 1) {
      if (!type) return toast.error("Please select an integration type");
      if (!isCalendar && !name.trim()) return toast.error("Integration name is required");
      setStep(2);
      return;
    }
    if (step === 2) {
      const missing = selected?.fields.find((f) => !creds[f.key]?.trim());
      if (missing) return toast.error(`${missing.label} is required`);

      if (isTwilioByot) {
        setSubmitting(true);
        const { error } = await api.createTwilioCredential({
          account_sid: creds.accountSid, auth_token: creds.authToken, label: name.trim() || undefined,
        });
        setSubmitting(false);
        if (error) return toast.error(error);
        onTwilioConnected?.();
        setStep(3);
        return;
      }

      const credentials = selected?.provider
        ? { ...creds, provider: selected.provider }
        : creds;
      onCreate?.({ name, description, type, credentials });
      setStep(3);
    }
  };

  /** Pull apiKey/code/secret straight out of a pasted provider URL, so the three fields
   *  don't have to be picked apart by hand. */
  const fillFromUrl = (raw: string) => {
    if (!raw.trim()) return;
    try {
      const qs = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : raw;
      const params = new URLSearchParams(qs);
      const picked: Record<string, string> = {};
      for (const key of ["apiKey", "code", "secret", "type"]) {
        const val = params.get(key);
        if (val) picked[key] = val;
      }
      if (!Object.keys(picked).length) {
        return toast.error("Couldn't find apiKey, code or secret in that URL");
      }
      setCreds((c) => ({ ...c, ...picked }));
      toast.success(`Filled ${Object.keys(picked).join(", ")}`);
    } catch {
      toast.error("That doesn't look like a valid URL");
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-xl gap-0 p-0 sm:rounded-xl [&>button]:hidden">
        <div className="flex items-start justify-between border-b border-border p-5">
          {/* DialogTitle rather than a bare h2 — Radix needs it to label the dialog for
              screen readers, and warns at runtime when it's missing. */}
          <DialogTitle className="text-lg font-semibold">Create Integration</DialogTitle>
          <button onClick={() => close(false)} className="rounded-md p-1 text-muted-foreground hover:bg-muted" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex items-center justify-center gap-2 px-6 pt-5">
          {(isCalendar ? [1, 2] : [1, 2, 3]).map((n, i, all) => {
            const done = step > n;
            const active = step === n;
            return (
              <div key={n} className="flex items-center">
                <div className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold ${done || active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                  {done ? <Check className="h-4 w-4" /> : n}
                </div>
                {i < all.length - 1 && <div className={`mx-1 h-1 w-10 rounded sm:w-24 ${step > n ? "bg-primary" : "bg-muted"}`} />}
              </div>
            );
          })}
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-6">
          {step === 1 && (
            <div className="space-y-4">
              <h3 className="text-base font-semibold">Integration Details</h3>
              <div>
                <label className="mb-1.5 block text-sm font-medium">Select Integration Type <span className="text-destructive">*</span></label>
                <Select value={type || "__none__"} onValueChange={(v) => { setType(v === "__none__" ? "" : v); setCreds({}); }}>
                  <SelectTrigger aria-label="Integration type"><SelectValue placeholder="Select Integration" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__" disabled>Select Integration</SelectItem>
                    {INTEGRATION_TYPES.map((t) => (<SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>))}
                  </SelectContent>
                </Select>
              </div>
              {isCalendar ? (
                <p className="rounded-md bg-muted/40 p-3 text-sm text-muted-foreground">
                  Connect your Google Calendar so agents can check your free times and book meetings during a call.
                  Click Next to see how.
                </p>
              ) : (
                <>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium">Integration Name <span className="text-destructive">*</span></label>
                    <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g., My Custom API" />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium">Description</label>
                    <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Describe what this integration does…" rows={3} className="w-full rounded-md border border-input bg-background p-2 text-sm" />
                  </div>
                </>
              )}
            </div>
          )}

          {step === 2 && isCalendar && (
            <CalendarConnectSteps status={calStatus} loading={calLoading} error={calError} isOwner={isOwner} onRetry={loadCalendar} />
          )}

          {step === 2 && selected && !isCalendar && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">Authenticate with {selected.label} using API key</p>
              {selected.provider === "whitelistdata" && (
                <p className="text-xs text-muted-foreground">
                  Don't have credentials yet?{" "}
                  <a
                    href="https://app.whitelistdata.com/"
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-primary underline underline-offset-2 hover:opacity-80"
                  >
                    Sign up at whitelistdata.com
                  </a>{" "}
                  to generate an apiKey, code, and secret.
                </p>
              )}
              {selected.urlPaste && (
                <div className="rounded-lg border border-dashed border-border bg-muted/30 p-3">
                  <label className="mb-1.5 block text-sm font-medium">Paste your full API URL</label>
                  <Input
                    placeholder="https://hooks.whitelistdata.com/api/…?code=…&secret=…&apiKey=…"
                    onChange={(e) => fillFromUrl(e.target.value)}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Optional shortcut. This fills the fields below automatically. You can also
                    enter them by hand.
                  </p>
                </div>
              )}
              {selected.fields.map((f) => (
                <div key={f.key}>
                  <label className="mb-1.5 block text-sm font-medium">{f.label} <span className="text-destructive">*</span></label>
                  {f.type === "password" ? (
                    <div className="relative">
                      <Input
                        type={revealed[f.key] ? "text" : "password"}
                        value={creds[f.key] ?? ""}
                        onChange={(e) => setCreds((c) => ({ ...c, [f.key]: e.target.value }))}
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
                    <Input value={creds[f.key] ?? ""} onChange={(e) => setCreds((c) => ({ ...c, [f.key]: e.target.value }))} placeholder={f.placeholder} />
                  )}
                  <p className="mt-1 text-xs text-muted-foreground">{f.help}</p>
                </div>
              ))}
            </div>
          )}

          {step === 3 && (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-full border-2 border-success">
                <Check className="h-8 w-8 text-success" />
              </div>
              <h3 className="mt-4 text-xl font-semibold text-success">Integration Created Successfully!</h3>
              <p className="mt-2 text-sm text-muted-foreground">Your integration has been configured and is ready to use.</p>
            </div>
          )}
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-border p-4 sm:flex-row sm:items-center sm:justify-between">
          {step === 3 ? (
            <Button className="ml-auto bg-primary text-primary-foreground" onClick={() => close(false)}>Done</Button>
          ) : (
            <>
              {step === 1 ? (
                <Button variant="outline" onClick={() => close(false)}>Cancel</Button>
              ) : (
                <Button variant="outline" onClick={() => setStep(1)}><ChevronLeft className="mr-1 h-4 w-4" /> Previous</Button>
              )}
              {step === 1 ? (
                <Button onClick={next} disabled={!type || (!isCalendar && !name.trim())} className="bg-primary text-primary-foreground hover:opacity-90">
                  Next <ChevronRight className="ml-1 h-4 w-4" />
                </Button>
              ) : isCalendar ? (
                canConnect ? (
                  <Button onClick={connectGoogle} disabled={connecting} className="bg-primary text-primary-foreground hover:opacity-90">
                    {connecting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                    {calStatus?.connected ? "Reconnect with Google" : "Connect with Google"}
                  </Button>
                ) : (
                  <Button onClick={() => close(false)} className="bg-primary text-primary-foreground hover:opacity-90">Close</Button>
                )
              ) : (
                <Button onClick={next} disabled={submitting} className="bg-primary text-primary-foreground hover:opacity-90">
                  {submitting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-1 h-4 w-4" />}
                  {submitting ? "Connecting…" : "Create"}
                </Button>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
