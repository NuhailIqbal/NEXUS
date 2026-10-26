/**
 * "What is a lead worth?" dialog for the Cost per lead & ROI page. The owner types the money one qualified lead (a call
 * handed to a human) is worth and, optionally, one other lead (a callback request or booked meeting); the report then
 * shows revenue, profit and ROI. A value can be set for the whole account and, under "Per campaign", overridden for one
 * campaign (a blank campaign box follows the account value). Only the account owner can save: everyone else sees the
 * numbers read-only. Nothing here does any maths on the values; the server validates and stores them.
 */
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/services/api";
import { parseValueInput, valueText, type LeadValues } from "@/lib/leadRoi";

type Draft = { q: string; o: string };
type Drafts = { account: Draft; campaigns: Record<string, Draft> };

const toDrafts = (v: LeadValues): Drafts => ({
  account: { q: valueText(v.account.value_per_qualified_lead), o: valueText(v.account.value_per_lead) },
  campaigns: Object.fromEntries(v.campaigns.map((c) => [c.campaign_id, { q: valueText(c.value_per_qualified_lead), o: valueText(c.value_per_lead) }])),
});

export function LeadValuesDialog({
  open, onOpenChange, isOwner, onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isOwner: boolean;
  /** Called after a save (even a partly failed one) so the page reloads its numbers. */
  onSaved: () => void;
}) {
  const [values, setValues] = useState<LeadValues | null>(null);
  const [drafts, setDrafts] = useState<Drafts | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    setError(null);
    api.getLeadValues().then(({ data, error: e }) => {
      if (!live) return;
      setLoading(false);
      if (e || !data) { setError(typeof e === "string" && e ? e : "Couldn't load your lead values."); return; }
      setValues(data as LeadValues);
      setDrafts(toDrafts(data as LeadValues));
    }).catch(() => { if (live) { setLoading(false); setError("Couldn't load your lead values."); } });
    return () => { live = false; };
  }, [open]);

  const setAccount = (k: keyof Draft, v: string) => { setDrafts((d) => d && { ...d, account: { ...d.account, [k]: v } }); setError(null); };
  const setCampaign = (id: string, k: keyof Draft, v: string) => {
    setDrafts((d) => d && { ...d, campaigns: { ...d.campaigns, [id]: { ...d.campaigns[id], [k]: v } } });
    setError(null);
  };

  const save = async () => {
    if (!values || !drafts) return;
    // Validate every box first so nothing is half-saved on a typo.
    const parsed: { campaign_id: string | null; q: number | null; o: number | null; changed: boolean }[] = [];
    const check = (id: string | null, d: Draft, was: { q: number | null; o: number | null }, who: string) => {
      const q = parseValueInput(d.q, `${who}: the value of a qualified lead`);
      const o = parseValueInput(d.o, `${who}: the value of another lead`);
      if (q.error || o.error) { setError(q.error || o.error); return false; }
      parsed.push({ campaign_id: id, q: q.value, o: o.value, changed: q.value !== was.q || o.value !== was.o });
      return true;
    };
    if (!check(null, drafts.account, { q: values.account.value_per_qualified_lead, o: values.account.value_per_lead }, "All campaigns")) return;
    for (const c of values.campaigns) {
      if (!check(c.campaign_id, drafts.campaigns[c.campaign_id], { q: c.value_per_qualified_lead, o: c.value_per_lead }, c.name)) return;
    }
    const todo = parsed.filter((p) => p.changed);
    if (!todo.length) { onOpenChange(false); return; }
    setSaving(true);
    for (const p of todo) {
      const { error: err } = await api.saveLeadValues({ campaign_id: p.campaign_id, value_per_qualified_lead: p.q, value_per_lead: p.o });
      if (err) {
        setSaving(false);
        setError(typeof err === "string" ? err : "Couldn't save your lead values.");
        onSaved(); // earlier boxes may already be saved: show the numbers as they now are
        return;
      }
    }
    setSaving(false);
    toast.success("Lead values saved");
    onSaved();
    onOpenChange(false);
  };

  const field = (id: string, label: string, value: string, onChange: (v: string) => void, placeholder: string) => (
    <div className="min-w-0 flex-1 space-y-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">{label}</Label>
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
        <Input id={id} inputMode="decimal" className="pl-6" value={value} placeholder={placeholder} disabled={!isOwner || saving}
               onChange={(e) => onChange(e.target.value)} />
      </div>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>What is a lead worth?</DialogTitle>
          <DialogDescription>
            Tell us what a lead is worth to your business and the report will show revenue, profit and ROI next to what you spend.
            Leave a box empty if you do not want it counted.
          </DialogDescription>
        </DialogHeader>

        {loading || !drafts || !values ? (
          error ? <p role="alert" className="text-sm text-destructive">{error}</p>
                : <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
        ) : (
          <div className="space-y-5">
            <div className="space-y-2">
              <h4 className="text-sm font-semibold">All campaigns</h4>
              <div className="flex flex-col gap-3 sm:flex-row">
                {field("lv-acc-q", "Qualified lead (handed to a person)", drafts.account.q, (v) => setAccount("q", v), "e.g. 50")}
                {field("lv-acc-o", "Other lead (callback or booked meeting)", drafts.account.o, (v) => setAccount("o", v), "optional")}
              </div>
            </div>

            {values.campaigns.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-semibold">Per campaign <span className="font-normal text-muted-foreground">(optional)</span></h4>
                <p className="text-xs text-muted-foreground">A campaign worth something different from the rest? Fill it in here. An empty box uses the value above.</p>
                <div className="space-y-3">
                  {values.campaigns.map((c) => (
                    <div key={c.campaign_id} className="rounded-lg border border-border p-3">
                      <div className="mb-2 truncate text-sm font-medium" title={c.name}>{c.name}</div>
                      <div className="flex flex-col gap-3 sm:flex-row">
                        {field(`lv-${c.campaign_id}-q`, "Qualified lead", drafts.campaigns[c.campaign_id]?.q ?? "", (v) => setCampaign(c.campaign_id, "q", v), "same as above")}
                        {field(`lv-${c.campaign_id}-o`, "Other lead", drafts.campaigns[c.campaign_id]?.o ?? "", (v) => setCampaign(c.campaign_id, "o", v), "same as above")}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {!isOwner && <p className="text-sm text-muted-foreground">Only the account owner can change these values.</p>}
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>{isOwner ? "Cancel" : "Close"}</Button>
          {isOwner && (
            <Button onClick={save} disabled={saving || loading || !drafts}>
              {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Save
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
