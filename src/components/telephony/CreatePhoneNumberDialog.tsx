import { useEffect, useState } from "react";
import { X, Plus, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { api } from "@/services/api";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate?: (data: PhoneNumberData) => void;
};

export type PhoneNumberData = {
  title: string;
  description: string;
  active: boolean;
  useForCall: boolean;
  useForHumanAgent: boolean;
  useForSms: boolean;
  serviceProvider: string;
  areaCode: string;
  agentId: string;
};

const PROVIDERS = ["VAPI", "Twilio"];

export function CreatePhoneNumberDialog({ open, onOpenChange, onCreate }: Props) {
  const [data, setData] = useState<PhoneNumberData>({
    title: "",
    description: "",
    active: false,
    useForCall: false,
    useForHumanAgent: false,
    useForSms: false,
    serviceProvider: "",
    areaCode: "",
    agentId: "",
  });
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    if (open) {
      api.getAgents().then(({ data: d }) => setAgents((d as any[]) ?? []));
    }
  }, [open]);

  const isVapi = data.serviceProvider.toLowerCase() === "vapi";

  const reset = () =>
    setData({ title: "", description: "", active: false, useForCall: false, useForHumanAgent: false, useForSms: false, serviceProvider: "", areaCode: "", agentId: "" });

  const close = (v: boolean) => {
    if (!v) reset();
    onOpenChange(v);
  };

  const create = () => {
    if (!data.title.trim()) return toast.error("Title is required");
    if (!data.serviceProvider) return toast.error("Please select a service provider");
    if (isVapi && (!data.areaCode.trim() || !/^\d{3}$/.test(data.areaCode.trim()))) {
      return toast.error("Enter a valid 3-digit area code for VAPI (e.g. 415)");
    }
    onCreate?.(data);
    close(false);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto p-0 gap-0 [&>button]:hidden">
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

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 px-6 py-6">
          <div>
            <h3 className="text-base font-bold mb-4">Main info</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-semibold mb-1.5">Title</label>
                <Input placeholder="Title" value={data.title} onChange={(e) => setData({ ...data, title: e.target.value })} />
              </div>
              <div>
                <label className="block text-sm font-semibold mb-1.5">Description</label>
                <Textarea rows={4} placeholder="Description" value={data.description} onChange={(e) => setData({ ...data, description: e.target.value })} />
              </div>
              <ToggleRow label="Active" checked={data.active} onChange={(v) => setData({ ...data, active: v })} />
              <ToggleRow label="Use For Call" checked={data.useForCall} onChange={(v) => setData({ ...data, useForCall: v })} />
              <ToggleRow label="Use For Human Agent" checked={data.useForHumanAgent} onChange={(v) => setData({ ...data, useForHumanAgent: v })} />
              <ToggleRow label="Use For SMS" checked={data.useForSms} onChange={(v) => setData({ ...data, useForSms: v })} />
            </div>
          </div>

          <div>
            <h3 className="text-base font-bold mb-4">Phone Details</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-semibold mb-1.5">Service Provider</label>
                <div className="relative">
                  <select
                    value={data.serviceProvider}
                    onChange={(e) => setData({ ...data, serviceProvider: e.target.value })}
                    className="w-full appearance-none rounded-md border border-input bg-background px-3 py-2 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                  >
                    <option value="">Please select your phone number provider</option>
                    {PROVIDERS.map((p) => (<option key={p} value={p}>{p}</option>))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                </div>
              </div>

              {isVapi && (
                <div>
                  <label className="block text-sm font-semibold mb-1.5">Area Code <span className="text-destructive">*</span></label>
                  <Input
                    placeholder="e.g. 415"
                    maxLength={3}
                    value={data.areaCode}
                    onChange={(e) => setData({ ...data, areaCode: e.target.value.replace(/\D/g, "") })}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">3-digit US area code. VAPI will provision a number in this area.</p>
                </div>
              )}

              {data.serviceProvider.toLowerCase() === "twilio" && (
                <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                  This number costs <span className="font-medium text-foreground">$3</span>. If your account balance
                  covers it, it's deducted from your balance; otherwise you'll be taken to secure Stripe checkout to pay.
                  <span className="mt-1 block text-[11px]">The number is provisioned once payment is settled.</span>
                </div>
              )}

              <div>
                <label className="block text-sm font-semibold mb-1.5">Assign AI Agent</label>
                <div className="relative">
                  <select
                    value={data.agentId}
                    onChange={(e) => setData({ ...data, agentId: e.target.value })}
                    className="w-full appearance-none rounded-md border border-input bg-background px-3 py-2 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                  >
                    <option value="">No agent assigned</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">Agent that handles inbound calls on this number.</p>
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-4 bg-muted/20">
          <Button variant="outline" onClick={() => close(false)}>
            <X className="mr-1 h-4 w-4" /> Cancel
          </Button>
          <Button onClick={create} className="bg-primary text-primary-foreground hover:opacity-90">
            <Plus className="mr-1 h-4 w-4" /> Create
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-3">
      <Switch checked={checked} onCheckedChange={onChange} />
      <span className="text-sm font-semibold">{label}</span>
    </div>
  );
}
