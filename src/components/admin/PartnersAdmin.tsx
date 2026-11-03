/**
 * Admin portal "Partners" section: create and manage referral partners, set each one's commission (a percentage of
 * profit or a fixed amount per verified signup), and see for each partner what their referred users were billed vs
 * what the platform paid (platform cost), the profit delta between the two, the commission owed and what the
 * platform keeps. A partner's detail view lists every referred account with the same three numbers and a live
 * activity feed. Rendered by pages/dashboard/Admin.tsx, which passes its own "view as user" handler.
 * Data: GET/POST /admin/partners, GET/PATCH /admin/partners/{id}, GET /admin/partners/activity (services/partners.py).
 */
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Copy, Eye, Loader2, Pause, Play, Plus } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import ActivityFeed from "@/components/partners/ActivityFeed";
import { api } from "@/services/api";
import { moneyOrDash } from "@/lib/leadRoi";
import { cn } from "@/lib/utils";
import {
  commissionExplainer, parseCommission, referralUrl,
  type AdminPartnerTotals, type CommissionType, type PartnerInfo, type PartnerSignup,
} from "@/lib/partners";
import { mainAppOrigin } from "@/lib/adminHost";

type PartnerRow = PartnerInfo & { totals: AdminPartnerTotals };
type PartnerDetail = PartnerRow & { signups: PartnerSignup[] };
type ListData = { partners: PartnerRow[]; totals: AdminPartnerTotals };

const Tile = ({ label, value, tone }: { label: string; value: string | number; tone?: "profit" | "neutral" }) => (
  <div className={cn("rounded-xl border bg-card p-5", tone === "profit" ? "border-green-500/50 bg-green-500/5" : "border-border")}>
    <div className={cn("text-2xl font-bold", tone === "profit" ? "text-green-500" : "text-foreground")}>{value}</div>
    <div className="text-xs text-muted-foreground">{label}</div>
  </div>
);

/** The money tiles shared by the list (all partners) and a partner's detail: billed, platform cost, profit delta, commission, net. */
const MoneyTiles = ({ t }: { t: AdminPartnerTotals }) => (
  <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
    <Tile label="Billed to users" value={moneyOrDash(t.billed)} />
    <Tile label="Platform cost" value={moneyOrDash(t.platform_cost)} />
    <Tile label="Profit (billed − cost)" value={moneyOrDash(t.profit)} tone="profit" />
    <Tile label="Commission owed" value={moneyOrDash(t.commission)} />
    <Tile label="Platform keeps" value={moneyOrDash(t.net_profit)} />
  </div>
);

const profitClass = (n: number) => (n > 0 ? "text-green-500" : n < 0 ? "text-destructive" : "text-muted-foreground");

const copyLink = (path: string) => {
  navigator.clipboard.writeText(referralUrl(mainAppOrigin(), path));
  toast.success("Referral link copied");
};

type Props = { onViewAs: (userId: string, email: string) => void };

export default function PartnersAdmin({ onViewAs }: Props) {
  const [list, setList] = useState<ListData | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await api.getAdminPartners();
    if (error || !data) return toast.error(error || "Could not load partners");
    setList(data);
  }, []);

  useEffect(() => { load(); }, [load]);

  if (selected) {
    return <PartnerDetailView id={selected} onBack={() => { setSelected(null); load(); }} onViewAs={onViewAs} />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Referral Partners</h1>
          <p className="text-sm text-muted-foreground">
            Each partner gets a unique signup link. Their users&apos; call billing, what the platform paid for it, and the profit between the two, are shown below.
          </p>
        </div>
        <Button className="gap-2" onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New partner</Button>
      </div>

      {!list ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading…</div>
      ) : (
        <>
          <MoneyTiles t={list.totals} />
          <div className="overflow-hidden rounded-xl border border-border">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">Partner</th>
                    <th className="px-4 py-3">Commission</th>
                    <th className="px-4 py-3 text-right">Signups</th>
                    <th className="px-4 py-3 text-right">Billed</th>
                    <th className="px-4 py-3 text-right">Platform cost</th>
                    <th className="px-4 py-3 text-right">Profit</th>
                    <th className="px-4 py-3 text-right">Commission owed</th>
                    <th className="px-4 py-3 text-right">Platform keeps</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {list.partners.length === 0 ? (
                    <tr><td colSpan={9} className="px-4 py-10 text-center text-muted-foreground">No partners yet. Create the first one.</td></tr>
                  ) : list.partners.map((p) => (
                    <tr key={p.id} className="border-t border-border bg-card/30">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-foreground">{p.name}</span>
                          <Badge variant={p.status === "active" ? "default" : "secondary"}>{p.status === "active" ? "Active" : "Paused"}</Badge>
                        </div>
                        <div className="text-xs text-muted-foreground">{p.email}</div>
                        <button type="button" onClick={() => copyLink(p.referral_path)} className="mt-1 inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground">
                          {p.code} <Copy className="h-3 w-3" />
                        </button>
                      </td>
                      <td className="px-4 py-3 text-foreground">{p.commission_label}</td>
                      <td className="px-4 py-3 text-right">{p.totals.signups} <span className="text-xs text-muted-foreground">({p.totals.verified} verified)</span></td>
                      <td className="px-4 py-3 text-right">{moneyOrDash(p.totals.billed)}</td>
                      <td className="px-4 py-3 text-right">{moneyOrDash(p.totals.platform_cost)}</td>
                      <td className={cn("px-4 py-3 text-right font-semibold", profitClass(p.totals.profit))}>{moneyOrDash(p.totals.profit)}</td>
                      <td className="px-4 py-3 text-right">{moneyOrDash(p.totals.commission)}</td>
                      <td className="px-4 py-3 text-right">{moneyOrDash(p.totals.net_profit)}</td>
                      <td className="px-4 py-3 text-right"><Button size="sm" variant="outline" onClick={() => setSelected(p.id)}>Manage</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <ActivityFeed load={() => api.getAdminPartnerActivity()} showPartner />
        </>
      )}

      <CreatePartnerDialog open={creating} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); load(); setSelected(id); }} />
    </div>
  );
}

/** Commission rule editor shared by the create dialog and the detail view. */
function CommissionFields({ type, value, onType, onValue }: { type: CommissionType; value: string; onType: (t: CommissionType) => void; onValue: (v: string) => void }) {
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>Commission type</Label>
          <Select value={type} onValueChange={(v) => onType(v as CommissionType)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="percent">Percentage of profit</SelectItem>
              <SelectItem value="fixed">Fixed per verified signup</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>{type === "percent" ? "Percent (0–100)" : "Amount in $"}</Label>
          <Input inputMode="decimal" value={value} onChange={(e) => onValue(e.target.value)} placeholder={type === "percent" ? "20" : "5"} />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{commissionExplainer(type)}</p>
    </div>
  );
}

function CreatePartnerDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const [form, setForm] = useState({ name: "", email: "", password: "", code: "", notes: "" });
  const [type, setType] = useState<CommissionType>("percent");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async () => {
    const commission = parseCommission(type, value);
    if (!form.name.trim() || !form.email.trim()) return toast.error("Name and email are required");
    if (commission === null) return toast.error(type === "percent" ? "Enter a percentage between 0 and 100" : "Enter a dollar amount");
    setBusy(true);
    const { data, error } = await api.createAdminPartner({
      name: form.name.trim(), email: form.email.trim(), password: form.password || undefined,
      code: form.code.trim() || undefined, notes: form.notes.trim() || undefined,
      commission_type: type, commission_value: commission,
    });
    setBusy(false);
    if (error || !data) return toast.error(typeof error === "string" ? error : "Could not create the partner");
    toast.success(`Partner created. Their code is ${data.code}`);
    setForm({ name: "", email: "", password: "", code: "", notes: "" });
    setValue("");
    onCreated(data.id);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New referral partner</DialogTitle>
          <DialogDescription>Creates the partner, their sign-in and a unique referral link.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5"><Label>Partner name</Label><Input value={form.name} onChange={set("name")} placeholder="Acme Affiliates" /></div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5"><Label>Email (their login)</Label><Input type="email" value={form.email} onChange={set("email")} /></div>
            <div className="space-y-1.5"><Label>Password</Label><Input type="password" value={form.password} onChange={set("password")} placeholder="Leave empty if the account exists" /></div>
          </div>
          <CommissionFields type={type} value={value} onType={setType} onValue={setValue} />
          <div className="space-y-1.5">
            <Label>Custom code (optional)</Label>
            <Input value={form.code} onChange={set("code")} placeholder="Auto-generated if empty. 4–20 letters or digits" className="font-mono" />
          </div>
          <div className="space-y-1.5"><Label>Notes (optional)</Label><Input value={form.notes} onChange={set("notes")} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Create partner</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PartnerDetailView({ id, onBack, onViewAs }: { id: string; onBack: () => void; onViewAs: Props["onViewAs"] }) {
  const [p, setP] = useState<PartnerDetail | null>(null);
  const [type, setType] = useState<CommissionType>("percent");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await api.getAdminPartner(id);
    if (error || !data) { toast.error(error || "Could not load the partner"); return; }
    setP(data);
    setType(data.commission_type);
    setValue(String(data.commission_value));
  }, [id]);

  useEffect(() => { load(); }, [load]);
  // Usage keeps arriving, so the money and the per-user rows refresh quietly.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.hidden) return;
      api.getAdminPartner(id).then(({ data }) => data && setP(data));
    }, 15000);
    return () => clearInterval(t);
  }, [id]);

  if (!p) return <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading…</div>;

  const dirty = type !== p.commission_type || Number(value) !== p.commission_value;

  const save = async (patch: Record<string, unknown>, msg: string) => {
    setSaving(true);
    const { error } = await api.updateAdminPartner(id, patch);
    setSaving(false);
    if (error) return toast.error(typeof error === "string" ? error : "Could not save");
    toast.success(msg);
    load();
  };

  const saveCommission = () => {
    const v = parseCommission(type, value);
    if (v === null) return toast.error(type === "percent" ? "Enter a percentage between 0 and 100" : "Enter a dollar amount");
    save({ commission_type: type, commission_value: v }, "Commission updated");
  };

  return (
    <div className="space-y-6">
      <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> All partners
      </button>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">{p.name}</h1>
            <Badge variant={p.status === "active" ? "default" : "secondary"}>{p.status === "active" ? "Active" : "Paused"}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">{p.email}</p>
        </div>
        <Button
          variant="outline" className="gap-2" disabled={saving}
          onClick={() => save({ status: p.status === "active" ? "paused" : "active" }, p.status === "active" ? "Partner paused" : "Partner reactivated")}
        >
          {p.status === "active" ? <><Pause className="h-4 w-4" /> Pause</> : <><Play className="h-4 w-4" /> Reactivate</>}
        </Button>
      </div>

      <div className="max-w-xl space-y-2">
        <Label>Referral link</Label>
        <div className="flex gap-2">
          <Input readOnly value={referralUrl(mainAppOrigin(), p.referral_path)} className="min-w-0 font-mono text-sm" />
          <Button type="button" className="gap-2" onClick={() => copyLink(p.referral_path)}><Copy className="h-4 w-4" /> Copy</Button>
        </div>
        {p.status === "paused" && <p className="text-xs text-muted-foreground">Paused: this link still opens the signup page but no new signup is credited to the partner, and they cannot use "View as".</p>}
      </div>

      <MoneyTiles t={p.totals} />
      <p className="-mt-3 text-xs text-muted-foreground">
        Call usage of this partner&apos;s referred accounts only. Profit is billed minus what the platform paid its providers; a call with no reported provider cost counts fully as profit.
      </p>

      <div className="max-w-xl space-y-3 rounded-xl border border-border bg-card/40 p-5">
        <h2 className="text-lg font-semibold text-foreground">Commission level</h2>
        <CommissionFields type={type} value={value} onType={setType} onValue={setValue} />
        <p className="text-xs text-muted-foreground">A change applies to the partner&apos;s whole history, so what they have earned is recalculated at the new rate.</p>
        <Button onClick={saveCommission} disabled={!dirty || saving}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Save commission</Button>
      </div>

      <div>
        <h2 className="mb-3 text-lg font-semibold text-foreground">Referred accounts ({p.signups.length})</h2>
        <div className="overflow-hidden rounded-xl border border-border">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">User</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Signed up</th>
                  <th className="px-4 py-3 text-right">Calls</th>
                  <th className="px-4 py-3 text-right">Billed</th>
                  <th className="px-4 py-3 text-right">Platform cost</th>
                  <th className="px-4 py-3 text-right">Profit</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {p.signups.length === 0 ? (
                  <tr><td colSpan={8} className="px-4 py-10 text-center text-muted-foreground">Nobody has signed up through this link yet.</td></tr>
                ) : p.signups.map((s) => (
                  <tr key={s.user_id} className="border-t border-border bg-card/30">
                    <td className="px-4 py-3"><div className="break-all font-medium text-foreground">{s.email}</div>{s.full_name && <div className="text-xs text-muted-foreground">{s.full_name}</div>}</td>
                    <td className="px-4 py-3"><Badge variant={s.status === "verified" ? "default" : "secondary"}>{s.status === "verified" ? "Verified" : "Pending"}</Badge></td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{new Date(s.created_at).toLocaleDateString()}</td>
                    <td className="px-4 py-3 text-right">{s.calls}</td>
                    <td className="px-4 py-3 text-right">{moneyOrDash(s.billed)}</td>
                    <td className="px-4 py-3 text-right">{moneyOrDash(s.platform_cost ?? 0)}</td>
                    <td className={cn("px-4 py-3 text-right font-semibold", profitClass(s.profit ?? 0))}>{moneyOrDash(s.profit ?? 0)}</td>
                    <td className="px-4 py-3 text-right">
                      <Button size="sm" variant="outline" className="gap-1.5" onClick={() => onViewAs(s.user_id, s.email)}><Eye className="h-3.5 w-3.5" /> View as</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <ActivityFeed load={() => api.getAdminPartnerActivity(id)} />
    </div>
  );
}
