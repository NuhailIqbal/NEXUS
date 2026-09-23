import { useEffect, useState } from "react";
import { X, Plus } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/services/api";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate?: (data: PhoneNumberData) => void;
};

export type Purpose = "inbound" | "outbound" | "both";

export type PhoneNumberData = {
  active: boolean;
  serviceProvider: string;
  agentId: string;
  purpose: Purpose | "";
};

const PROVIDERS = ["Twilio"];

export function CreatePhoneNumberDialog({ open, onOpenChange, onCreate }: Props) {
  const [data, setData] = useState<PhoneNumberData>({
    active: false,
    serviceProvider: "",
    agentId: "",
    purpose: "",
  });
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    if (open) {
      api.getAgents().then(({ data: d }) => setAgents((d as any[]) ?? []));
    }
  }, [open]);

  const reset = () => setData({ active: false, serviceProvider: "", agentId: "", purpose: "" });

  const close = (v: boolean) => {
    if (!v) reset();
    onOpenChange(v);
  };

  const create = () => {
    if (!data.purpose) return toast.error("Please select a purpose");
    if (!data.serviceProvider) return toast.error("Please select a service provider");
    onCreate?.(data);
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
              <SelectTrigger>
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
              <SelectTrigger>
                <SelectValue placeholder="Please select your phone number provider" />
              </SelectTrigger>
              <SelectContent>
                {PROVIDERS.map((p) => (<SelectItem key={p} value={p}>{p}</SelectItem>))}
              </SelectContent>
            </Select>
          </div>

          {data.serviceProvider.toLowerCase() === "twilio" && (
            <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
              This number costs <span className="font-medium text-foreground">$3</span>. If your account balance
              covers it, it's deducted from your balance; otherwise you'll be taken to secure Stripe checkout to pay.
              <span className="mt-1 block text-[11px]">The number is provisioned once payment is settled.</span>
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
