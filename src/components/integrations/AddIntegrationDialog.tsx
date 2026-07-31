import { useState } from "react";
import { Check, CheckCircle2, ChevronLeft, ChevronRight, X } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate?: (data: { name: string; description: string; type: string; credentials: Record<string, string> }) => void;
};

type FieldDef = { key: string; label: string; placeholder: string; help: string; type?: string };

// `provider` is written into the saved config blob so the backend can identify this
// integration reliably, independent of whatever the user types as its display name.
//
// Only WhitelistData is offered here — every other entry that used to live in this list
// (Brevo, Twilio, Stripe, OpenAI, Gemini, and a long tail of placeholder providers with no
// backend behind them at all) has been removed at the user's request.
const INTEGRATION_TYPES: { value: string; label: string; provider?: string; urlPaste?: boolean; fields: FieldDef[] }[] = [
  { value: "WhitelistData", label: "WhitelistData (DNC screening)", provider: "whitelistdata", urlPaste: true, fields: [
    { key: "apiKey", label: "API Key", placeholder: "d5078618-5c1c-4e3e-…", help: "The apiKey value from your WhitelistData account" },
    { key: "code", label: "Function Code", placeholder: "ONbKJs8jpJZWJU5vO9Zg…", help: "The code value from your WhitelistData endpoint URL" },
    { key: "secret", label: "Secret", placeholder: "sha290OpGRNz", help: "The secret value from your WhitelistData endpoint URL", type: "password" },
  ]},
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
                  <option value="">Select Integration</option>
                  {INTEGRATION_TYPES.map((t) => (<option key={t.value} value={t.value}>{t.label}</option>))}
                </select>
              </div>
            </div>
          )}

          {step === 2 && selected && (
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
                    Optional shortcut — this fills the fields below automatically. You can also
                    enter them by hand.
                  </p>
                </div>
              )}
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
