import { useEffect, useMemo, useState } from "react";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { useTheme } from "next-themes";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { api } from "@/services/api";

// loadStripe must be called once per key, never inside a render — cache by key.
const stripeCache = new Map<string, Promise<Stripe | null>>();
function getStripe(key: string) {
  if (!stripeCache.has(key)) stripeCache.set(key, loadStripe(key));
  return stripeCache.get(key)!;
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => void;
};

/** The actual card form — must be rendered inside <Elements>. */
function CardForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSaving(true);
    const { error } = await stripe.confirmSetup({
      elements,
      confirmParams: { return_url: `${window.location.origin}/dashboard/billing/payment-methods` },
      redirect: "if_required",
    });
    setSaving(false);
    if (error) return toast.error(error.message || "Could not save that card");
    toast.success("Card saved");
    onDone();
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      {loadError ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <p className="font-medium">The card form couldn't load.</p>
          <p className="mt-1 text-xs">{loadError}</p>
          <p className="mt-2 text-xs">
            This usually means the Stripe publishable key doesn't match the secret key's
            mode (test vs live). Ask an administrator to check the Stripe keys.
          </p>
        </div>
      ) : (
        <PaymentElement
          options={{ wallets: { link: "never" } }}
          onLoadError={(e) =>
            setLoadError(e?.error?.message || "Stripe could not initialise the payment form.")
          }
        />
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving || !stripe || !!loadError}>
          {saving ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving…</> : "Save card"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function AddCardDialog({ open, onOpenChange, onAdded }: Props) {
  const { resolvedTheme } = useTheme();
  const [publishableKey, setPublishableKey] = useState<string | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetch the key + a fresh SetupIntent each time the dialog opens (intents are single-use).
  useEffect(() => {
    if (!open) { setClientSecret(null); setError(null); return; }
    let active = true;
    (async () => {
      const [cfg, intent] = await Promise.all([
        api.getStripeConfig(),
        api.createSetupIntent(),
      ]);
      if (!active) return;
      const key = cfg.data?.publishable_key;
      if (!key) {
        setError("Card payments aren't configured yet. Ask an administrator to add a Stripe publishable key.");
        return;
      }
      if (intent.error || !intent.data?.client_secret) {
        setError(intent.error || "Could not start card setup");
        return;
      }
      setPublishableKey(key);
      setClientSecret(intent.data.client_secret);
    })();
    return () => { active = false; };
  }, [open]);

  const stripePromise = useMemo(
    () => (publishableKey ? getStripe(publishableKey) : null),
    [publishableKey],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add payment method</DialogTitle>
          <DialogDescription>
            Your card is stored securely by Stripe — it never touches our servers.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p className="py-4 text-sm text-destructive">{error}</p>
        ) : !clientSecret || !stripePromise ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Preparing secure form…
          </div>
        ) : (
          <Elements
            // key forces a fresh Elements instance per SetupIntent
            key={clientSecret}
            stripe={stripePromise}
            options={{
              clientSecret,
              appearance: { theme: resolvedTheme === "dark" ? "night" : "stripe" },
            }}
          >
            <CardForm
              onDone={() => { onOpenChange(false); onAdded(); }}
              onCancel={() => onOpenChange(false)}
            />
          </Elements>
        )}
      </DialogContent>
    </Dialog>
  );
}
