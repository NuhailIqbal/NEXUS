import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { api } from "@/services/api";
import { TOPUP_MIN, TOPUP_MAX, type BillingStatus } from "./types";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  billing: BillingStatus | null;
  onSaved: () => void;
};

export function AutoRechargeDialog({ open, onOpenChange, billing, onSaved }: Props) {
  const [enabled, setEnabled] = useState(false);
  const [threshold, setThreshold] = useState(10);
  const [amount, setAmount] = useState(50);
  const [saving, setSaving] = useState(false);
  const [hasCard, setHasCard] = useState<boolean | null>(null);

  // Re-sync from the server each time the dialog opens, and check for a saved card
  // (the backend refuses to enable auto-recharge without one).
  useEffect(() => {
    if (!open) return;
    setEnabled(!!billing?.auto_recharge_enabled);
    setThreshold(billing?.auto_recharge_threshold ?? 10);
    setAmount(billing?.auto_recharge_amount ?? 50);
    let active = true;
    api.getPaymentMethods().then(({ data }) => {
      if (active) setHasCard(Array.isArray(data) && data.length > 0);
    });
    return () => { active = false; };
  }, [open, billing]);

  const save = async () => {
    if (enabled && amount < TOPUP_MIN) {
      return toast.error(`Recharge amount must be at least $${TOPUP_MIN}`);
    }
    setSaving(true);
    const { error } = await api.updateAutoRecharge({ enabled, threshold, amount });
    setSaving(false);
    if (error) return toast.error(error);
    toast.success(enabled ? "Auto recharge enabled" : "Auto recharge turned off");
    onOpenChange(false);
    onSaved();
  };

  const needsCard = enabled && hasCard === false;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Auto recharge settings</DialogTitle>
          <DialogDescription>
            Keep your balance topped up automatically so calls never stop mid-campaign.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-background/40 p-3">
            <div>
              <span className="block text-sm font-medium text-foreground">Enable auto recharge</span>
              <p className="text-xs text-muted-foreground">
                Charges your default card when the balance runs low.
              </p>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </div>

          {needsCard && (
            <p className="rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-3 text-xs text-yellow-600 dark:text-yellow-400">
              You need a saved card first.{" "}
              <Link
                to="/dashboard/billing/payment-methods"
                className="font-medium underline"
                onClick={() => onOpenChange(false)}
              >
                Add a payment method
              </Link>
              , then come back to enable this.
            </p>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="ar-threshold">When balance falls below</Label>
              <div className="relative mt-1.5">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                <Input
                  id="ar-threshold"
                  type="number"
                  min={0}
                  max={500}
                  step="1"
                  className="pl-6"
                  value={threshold}
                  onChange={(e) => setThreshold(parseFloat(e.target.value) || 0)}
                  disabled={!enabled}
                />
              </div>
            </div>
            <div>
              <Label htmlFor="ar-amount">Bring balance up by</Label>
              <div className="relative mt-1.5">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                <Input
                  id="ar-amount"
                  type="number"
                  min={TOPUP_MIN}
                  max={TOPUP_MAX}
                  step="1"
                  className="pl-6"
                  value={amount}
                  onChange={(e) => setAmount(parseFloat(e.target.value) || 0)}
                  disabled={!enabled}
                />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">Minimum ${TOPUP_MIN}.</p>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={saving || needsCard}>
            {saving ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving…</> : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
