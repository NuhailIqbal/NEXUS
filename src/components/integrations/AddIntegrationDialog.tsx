import { useState } from "react";
import { Check, CheckCircle2, ChevronLeft, ChevronRight, X } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate?: (data: { name: string; description: string; type: string; credentials: Record<string, string> }) => void;
};

type FieldDef = { key: string; label: string; placeholder: string; help: string; type?: string };

const INTEGRATION_TYPES: { value: string; label: string; fields: FieldDef[] }[] = [
  { value: "Brevo", label: "Brevo", fields: [{ key: "apiKey", label: "API Key", placeholder: "xkeysib-…", help: "Your Brevo API key" }] },
  { value: "Custom", label: "Custom", fields: [
    { key: "baseUrl", label: "Base URL", placeholder: "https://api.example.com", help: "API base URL" },
    { key: "apiKey", label: "API Key", placeholder: "your-api-key", help: "Authentication key" },
  ]},
  { value: "Direct 7 Network", label: "Direct 7 Network", fields: [{ key: "apiKey", label: "API Key", placeholder: "api-key", help: "Your Direct 7 API key" }] },
  { value: "Gemini", label: "Gemini", fields: [{ key: "apiKey", label: "API Key", placeholder: "AIza…", help: "Your Gemini API key" }] },
  { value: "HubSpot CRM", label: "HubSpot CRM", fields: [{ key: "accessToken", label: "Access Token", placeholder: "pat-…", help: "Private app access token" }] },
  { value: "IDT International", label: "IDT International", fields: [
    { key: "username", label: "Username", placeholder: "username", help: "IDT username" },
    { key: "password", label: "Password", placeholder: "password", help: "IDT password", type: "password" },
  ]},
  { value: "MondayCRM", label: "MondayCRM", fields: [{ key: "apiKey", label: "API Key", placeholder: "api-key", help: "Monday API key" }] },
  { value: "OpenAI", label: "OpenAI", fields: [{ key: "apiKey", label: "API Key", placeholder: "sk-…", help: "Your OpenAI secret key" }] },
  { value: "SIP Trunk", label: "SIP Trunk", fields: [
    { key: "domain", label: "SIP Domain", placeholder: "sip.provider.com", help: "Your SIP domain" },
    { key: "username", label: "Username", placeholder: "username", help: "SIP username" },
    { key: "password", label: "Password", placeholder: "password", help: "SIP password", type: "password" },
  ]},
  { value: "SMS South Africa", label: "SMS South Africa", fields: [{ key: "apiKey", label: "API Key", placeholder: "api-key", help: "Your SMS South Africa API key" }] },
  { value: "Salesforce CRM", label: "Salesforce CRM", fields: [{ key: "accessToken", label: "Access Token", placeholder: "00D…", help: "Salesforce OAuth token" }] },
  { value: "Silverstreet", label: "Silverstreet", fields: [{ key: "apiKey", label: "API Key", placeholder: "api-key", help: "Silverstreet API key" }] },
  { value: "Slack Notifications", label: "Slack Notifications", fields: [{ key: "webhookUrl", label: "Webhook URL", placeholder: "https://hooks.slack.com/…", help: "Slack incoming webhook URL" }] },
  { value: "Stripe", label: "Stripe", fields: [{ key: "secretKey", label: "Secret Key", placeholder: "sk_live_…", help: "Your Stripe secret key", type: "password" }] },
  { value: "Twilio", label: "Twilio", fields: [
    { key: "sid", label: "SID", placeholder: "ac id", help: "Your Twilio Account SID" },
    { key: "token", label: "Token", placeholder: "auth token", help: "Your Twilio Auth Token", type: "password" },
  ]},
  { value: "Volt", label: "Volt", fields: [{ key: "apiKey", label: "API Key", placeholder: "api-key", help: "Volt API key" }] },
  { value: "Zapier", label: "Zapier", fields: [{ key: "webhookUrl", label: "Webhook URL", placeholder: "https://hooks.zapier.com/…", help: "Zapier webhook URL" }] },
  { value: "Zoho", label: "Zoho", fields: [{ key: "accessToken", label: "Access Token", placeholder: "1000.…", help: "Zoho OAuth access token" }] },
];

export function AddIntegrationDialog({ open, onOpenChange, onCreate }: Props) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState("");
  const [creds, setCreds] = useState<Record<string, string>>({});

  const selected = INTEGRATION_TYPES.find((t) => t.value === type);

  const reset = () => {
    setStep(1);
    setName("");
    setDescription("");
    setType("");
    setCreds({});
  };

  const close = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const next = () => {
    if (step === 1) {
      if (!name.trim()) return toast.error("Integration name is required");
      if (!type) return toast.error("Please select an integration type");
      setStep(2);
      return;
    }
    if (step === 2) {
      const missing = selected?.fields.find((f) => !creds[f.key]?.trim());
      if (missing) return toast.error(`${missing.label} is required`);
      onCreate?.({ name, description, type, credentials: creds });
      setStep(3);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-xl gap-0 p-0 sm:rounded-xl [&>button]:hidden">
        <div className="flex items-start justify-between border-b border-border p-5">
          <h2 className="text-lg font-semibold">Create Integration</h2>
          <button onClick={() => close(false)} className="rounded-md p-1 text-muted-foreground hover:bg-muted" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex items-center justify-center gap-2 px-6 pt-5">
          {[1, 2, 3].map((n, i) => {
            const done = step > n;
            const active = step === n;
            return (
              <div key={n} className="flex items-center">
                <div className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold ${done || active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                  {done ? <Check className="h-4 w-4" /> : n}
                </div>
                {i < 2 && <div className={`mx-1 h-1 w-24 rounded ${step > n ? "bg-primary" : "bg-muted"}`} />}
              </div>
            );
          })}
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-6">
          {step === 1 && (
            <div className="space-y-4">
              <h3 className="text-base font-semibold">Integration Details</h3>
              <div>
                <label className="mb-1.5 block text-sm font-medium">Integration Name <span className="text-destructive">*</span></label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g., My Custom API" />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium">Description</label>
                <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Describe what this integration does…" rows={3} className="w-full rounded-md border border-input bg-background p-2 text-sm" />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium">Select Integration Type <span className="text-destructive">*</span></label>
                <select value={type} onChange={(e) => { setType(e.target.value); setCreds({}); }} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                  <option value="">-- Select Integration --</option>
                  {INTEGRATION_TYPES.map((t) => (<option key={t.value} value={t.value}>{t.label}</option>))}
                </select>
              </div>
            </div>
          )}

          {step === 2 && selected && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">Authenticate with {selected.label} using API key</p>
              {selected.fields.map((f) => (
                <div key={f.key}>
                  <label className="mb-1.5 block text-sm font-medium">{f.label} <span className="text-destructive">*</span></label>
                  <Input type={f.type ?? "text"} value={creds[f.key] ?? ""} onChange={(e) => setCreds((c) => ({ ...c, [f.key]: e.target.value }))} placeholder={f.placeholder} />
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

        <div className="flex items-center justify-between gap-2 border-t border-border p-4">
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
                <Button onClick={next} disabled={!name.trim() || !type} className="bg-primary text-primary-foreground hover:opacity-90">
                  Next <ChevronRight className="ml-1 h-4 w-4" />
                </Button>
              ) : (
                <Button onClick={next} className="bg-primary text-primary-foreground hover:opacity-90">
                  <CheckCircle2 className="mr-1 h-4 w-4" /> Create
                </Button>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
