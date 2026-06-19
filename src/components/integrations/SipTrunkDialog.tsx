import { useState } from "react";
import { ChevronLeft, ChevronRight, Check, CheckCircle2, Copy, Globe, Info, X } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate?: (data: SipData) => void;
};

type SipData = {
  name: string;
  description: string;
  domain: string;
  proxy: string;
  username: string;
  password: string;
  port: string;
};

const STATIC_IP = "173.208.243.9";

export function SipTrunkDialog({ open, onOpenChange, onCreate }: Props) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [data, setData] = useState<SipData>({
    name: "SIP Trunk",
    description: "",
    domain: "",
    proxy: "",
    username: "user@edmnexus.ai",
    password: "",
    port: "5060",
  });

  const set = <K extends keyof SipData>(k: K, v: SipData[K]) => setData((d) => ({ ...d, [k]: v }));

  const reset = () => {
    setStep(1);
    setData({
      name: "SIP Trunk",
      description: "",
      domain: "",
      proxy: "",
      username: "user@edmnexus.ai",
      password: "",
      port: "5060",
    });
  };

  const close = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const next = () => {
    if (step === 1 && !data.name.trim()) return toast.error("Integration name is required");
    if (step < 3) setStep((s) => (s + 1) as 1 | 2 | 3);
  };

  const submit = () => {
    if (!data.domain.trim()) return toast.error("SIP Domain is required");
    if (!data.password.trim()) return toast.error("Password is required");
    onCreate?.(data);
    toast.success("SIP Trunk integration created");
    close(false);
  };

  const copyIp = async () => {
    try {
      await navigator.clipboard.writeText(STATIC_IP);
      toast.success("IP address copied");
    } catch {
      toast.error("Failed to copy");
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-xl gap-0 p-0 sm:rounded-xl [&>button]:hidden">
        <div className="flex items-start justify-between border-b border-border p-5">
          <h2 className="text-lg font-semibold">Connect SIP Trunk Integration</h2>
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
                <Input value={data.name} onChange={(e) => set("name", e.target.value)} placeholder="SIP Trunk" />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium">Description</label>
                <textarea value={data.description} onChange={(e) => set("description", e.target.value)} placeholder="Describe what this integration does…" rows={3} className="w-full rounded-md border border-input bg-background p-2 text-sm" />
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <div>
                <h3 className="text-base font-semibold">IP Whitelisting Required</h3>
                <p className="mt-1 text-sm text-muted-foreground">Your SIP provider may require you to whitelist our static IP address</p>
              </div>

              <div className="rounded-lg border border-warning/40 bg-warning/10 p-4">
                <div className="flex items-start gap-2">
                  <Info className="mt-0.5 h-4 w-4 text-warning" />
                  <div>
                    <p className="text-sm font-semibold text-warning">Important Notice</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      To ensure connectivity, add this IP address to your provider's allowed list. Without whitelisting, calls may fail to connect.
                    </p>
                  </div>
                </div>
              </div>

              <div>
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
                  <Globe className="h-4 w-4 text-info" /> Static IP Address
                </div>
                <div className="flex items-center justify-between rounded-lg bg-muted px-4 py-3">
                  <span className="font-mono text-lg font-bold">{STATIC_IP}</span>
                  <button onClick={copyIp} className="rounded-md p-1.5 text-muted-foreground hover:bg-background" aria-label="Copy IP">
                    <Copy className="h-4 w-4" />
                  </button>
                </div>
              </div>

              <div className="rounded-lg border border-border bg-success/5 p-4">
                <p className="mb-2 text-sm font-semibold">How to Whitelist This IP:</p>
                <ol className="space-y-1.5 text-sm text-muted-foreground">
                  <li><span className="font-semibold text-success">1.</span> Log in to your SIP provider's portal (e.g., Twilio Console, Vonage Dashboard)</li>
                  <li><span className="font-semibold text-success">2.</span> Navigate to Settings → IP Access Control or Security settings</li>
                  <li><span className="font-semibold text-success">3.</span> Add the IP address above to your allowed/trusted IP list</li>
                  <li><span className="font-semibold text-success">4.</span> Save the changes and wait a few moments for propagation</li>
                </ol>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Enter your SIP provider's connection details. Works with: Twilio, Vonage, Bandwidth, SignalWire, or any custom SIP provider.
              </p>
              <div>
                <label className="mb-1.5 block text-sm font-medium">SIP Domain / Host <span className="text-destructive">*</span></label>
                <Input value={data.domain} onChange={(e) => set("domain", e.target.value)} placeholder="sip.provider.com" />
                <p className="mt-1 text-xs text-muted-foreground">The SIP domain or hostname provided by your provider</p>
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium">SIP Proxy (Optional)</label>
                <Input value={data.proxy} onChange={(e) => set("proxy", e.target.value)} placeholder="proxy.provider.com" />
                <p className="mt-1 text-xs text-muted-foreground">Leave empty if not required by your provider</p>
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium">Username</label>
                <Input value={data.username} onChange={(e) => set("username", e.target.value)} />
                <p className="mt-1 text-xs text-muted-foreground">Your SIP username</p>
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium">Password</label>
                <Input type="password" value={data.password} onChange={(e) => set("password", e.target.value)} placeholder="••••••••••" />
                <p className="mt-1 text-xs text-muted-foreground">Encrypted and stored securely</p>
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium">Port</label>
                <Input value={data.port} onChange={(e) => set("port", e.target.value)} placeholder="5060" />
                <p className="mt-1 text-xs text-muted-foreground">Default: 5060 (standard SIP port)</p>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border p-4">
          {step === 1 ? (
            <Button variant="outline" onClick={() => close(false)}>Cancel</Button>
          ) : (
            <Button variant="outline" onClick={() => setStep((s) => (s - 1) as 1 | 2 | 3)}>
              <ChevronLeft className="mr-1 h-4 w-4" /> Previous
            </Button>
          )}

          {step < 3 ? (
            <Button onClick={next} className="bg-primary text-primary-foreground hover:opacity-90">
              Next <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          ) : (
            <Button onClick={submit} className="bg-primary text-primary-foreground hover:opacity-90">
              <CheckCircle2 className="mr-1 h-4 w-4" /> Create
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
