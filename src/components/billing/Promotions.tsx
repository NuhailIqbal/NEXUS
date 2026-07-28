import { useCallback, useEffect, useState } from "react";
import { Loader2, Tag } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/services/api";
import type { AppliedPromotion } from "./types";

const Promotions = () => {
  const [code, setCode] = useState("");
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<AppliedPromotion[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchApplied = useCallback(async () => {
    const { data } = await api.getPromotions();
    if (Array.isArray(data)) setApplied(data);
    setLoading(false);
  }, []);

  useEffect(() => { fetchApplied(); }, [fetchApplied]);

  const apply = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) return toast.error("Enter a promotion code");
    setApplying(true);
    const { data, error } = await api.redeemPromoCode(trimmed);
    setApplying(false);
    if (error) return toast.error(error);
    toast.success(`$${(data?.amount ?? 0).toFixed(2)} credit added to your balance.`);
    setCode("");
    fetchApplied();
  };

  return (
    <div className="space-y-8">
      {/* Redeem */}
      <div>
        <h2 className="text-lg font-semibold text-foreground">Add a promotional credit</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Enter a promotional code to receive credits on your account.
        </p>
        <form onSubmit={apply} className="mt-4 flex max-w-xl gap-2">
          <Input
            placeholder="Enter code"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            autoComplete="off"
            spellCheck={false}
          />
          <Button type="submit" disabled={applying || !code.trim()}>
            {applying ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Applying…</> : "Apply"}
          </Button>
        </form>
      </div>

      {/* Applied */}
      <div>
        <h2 className="text-lg font-semibold text-foreground">Applied promotions</h2>
        {loading ? (
          <div className="flex items-center justify-center py-14 text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading…
          </div>
        ) : applied.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-border bg-card/40 py-14 text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <Tag className="h-6 w-6 text-muted-foreground" />
            </div>
            <h3 className="font-semibold text-foreground">You haven't applied any promotions yet</h3>
            <p className="mt-1 text-sm text-muted-foreground">Applied promotions will appear here</p>
          </div>
        ) : (
          <div className="mt-4 overflow-hidden rounded-xl border border-border">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">Code</th>
                    <th className="px-4 py-3">Credit</th>
                    <th className="px-4 py-3">Applied</th>
                  </tr>
                </thead>
                <tbody>
                  {applied.map((p) => (
                    <tr key={p.id} className="border-t border-border bg-card/30">
                      <td className="px-4 py-3 font-medium text-foreground">{p.code}</td>
                      <td className="px-4 py-3 font-medium text-green-500">
                        +${p.amount.toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {new Date(p.created_at).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Promotions;
