import { useCallback, useEffect, useState } from "react";
import { Copy, Users2, CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/services/api";

type ReferralItem = {
  id: string;
  referee_email: string;
  status: string;
  created_at: string;
  verified_at: string | null;
};

type ReferralStats = {
  code: string;
  invited_count: number;
  verified_count: number;
  referrals: ReferralItem[];
};

const Referrals = () => {
  const [stats, setStats] = useState<ReferralStats | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStats = useCallback(async () => {
    const { data } = await api.getMyReferrals();
    if (data) setStats(data);
    setLoading(false);
  }, []);

  useEffect(() => { fetchStats(); }, [fetchStats]);

  const link = stats?.code ? `${window.location.origin}/register?ref=${stats.code}` : "";

  const copyLink = () => {
    navigator.clipboard.writeText(link);
    toast.success("Referral link copied");
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-14 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading...
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Referrals</h1>
        <p className="text-sm text-muted-foreground">Share your link. Anyone who signs up through it is tracked as your referral.</p>
      </div>

      <div className="flex max-w-xl gap-2">
        <Input readOnly value={link} className="font-mono text-sm" />
        <Button type="button" onClick={copyLink} className="gap-2">
          <Copy className="h-4 w-4" /> Copy
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 max-w-xl">
        <div className="rounded-xl border border-border bg-card/40 p-5">
          <div className="flex items-center gap-2 text-muted-foreground text-sm"><Users2 className="h-4 w-4" /> Invited</div>
          <div className="mt-2 text-2xl font-bold text-foreground">{stats?.invited_count ?? 0}</div>
        </div>
        <div className="rounded-xl border border-border bg-card/40 p-5">
          <div className="flex items-center gap-2 text-muted-foreground text-sm"><CheckCircle2 className="h-4 w-4" /> Verified</div>
          <div className="mt-2 text-2xl font-bold text-foreground">{stats?.verified_count ?? 0}</div>
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold text-foreground">Referral activity</h2>
        {!stats?.referrals?.length ? (
          <div className="mt-4 rounded-xl border border-dashed border-border bg-card/40 py-14 text-center">
            <h3 className="font-semibold text-foreground">No referrals yet</h3>
            <p className="mt-1 text-sm text-muted-foreground">Share your link to start inviting people</p>
          </div>
        ) : (
          <div className="mt-4 overflow-hidden rounded-xl border border-border">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">Referee</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Invited</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.referrals.map((r) => (
                    <tr key={r.id} className="border-t border-border bg-card/30">
                      <td className="px-4 py-3 text-foreground">{r.referee_email}</td>
                      <td className="px-4 py-3">
                        <span className={r.status === "verified" ? "text-green-500 font-medium" : "text-muted-foreground"}>
                          {r.status === "verified" ? "Verified" : "Pending"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{new Date(r.created_at).toLocaleDateString()}</td>
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

export default Referrals;
