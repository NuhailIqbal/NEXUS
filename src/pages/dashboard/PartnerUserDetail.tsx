/**
 * Partner Portal > one referred user (/partner/users/:userId): when they signed up and verified, the agents they
 * created, their top-ups, calls and billed amount and when they were last active, then their activity history (signed up,
 * verified, agent created, top-up, call), newest first, filterable by kind and date range and paged. "View as" is kept
 * here too (off while the partner is paused). A user the partner did not refer is "not found", exactly like the API.
 * Data: GET /partner/users/{id} and GET /partner/users/{id}/activity (services/partner_users.py): no platform cost or profit.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Activity, ArrowLeft, Bot, CalendarCheck, CalendarPlus, ChevronLeft, ChevronRight, Clock, DollarSign, Eye, Loader2, Phone, Wallet, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/call-consumption/FilterBar";
import { ACTIVITY_ICONS } from "@/components/partners/activityIcons";
import { useReportData } from "@/components/partners/useReportSelection";
import { usePartnerPortal } from "@/components/partners/usePartnerPortal";
import { api } from "@/services/api";
import { cn } from "@/lib/utils";
import { moneyOrDash } from "@/lib/leadRoi";
import { timeAgo } from "@/lib/partners";
import { browserTimeZone } from "@/lib/partnerReports";
import {
  ACTIVITY_KINDS, DEFAULT_ACTIVITY_FILTERS, DEFAULT_PER_PAGE, buildActivityQuery, historyText, rangeText, signupRangeError, toggleKind, userLabel,
  type ActivityFilters, type Page, type PartnerUser, type UserActivityItem,
} from "@/lib/partnerUsers";

type ActivityQuery = Record<string, string | string[] | undefined>;
const stamp = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "");

const Stat = ({ icon: Icon, label, value, hint }: { icon: typeof Activity; label: string; value: string | number; hint?: string }) => (
  <div className="rounded-xl border border-border bg-card/40 p-5">
    <div className="flex items-center gap-2 text-sm text-muted-foreground"><Icon className="h-4 w-4" /> {label}</div>
    <div className="mt-2 text-xl font-bold text-foreground">{value}</div>
    {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
  </div>
);

function History({ userId }: { userId: string }) {
  const tz = useMemo(browserTimeZone, []);
  const [filters, setFilters] = useState<ActivityFilters>(DEFAULT_ACTIVITY_FILTERS);
  const edit = (patch: Partial<ActivityFilters>) => setFilters((f) => ({ ...f, ...patch, page: 1 }));
  const query = useMemo(() => buildActivityQuery(filters, tz), [filters, tz]);
  const { report, error, loading } = useReportData<Page<UserActivityItem>, ActivityQuery>(query, (q) => api.getPartnerUserActivity(userId, q));
  const rangeError = signupRangeError(filters.start, filters.end);
  const narrowed = filters.kinds.length > 0 || !!filters.start || !!filters.end;

  useEffect(() => {
    if (report && report.items.length === 0 && report.total > 0 && filters.page > report.pages) setFilters((f) => ({ ...f, page: report.pages }));
  }, [report, filters.page]);

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-foreground">Activity history</h2>
      <div className="flex flex-wrap items-end gap-3">
        <div className="inline-flex flex-wrap gap-1 rounded-lg border border-border bg-card/40 p-1" role="group" aria-label="Kinds of activity">
          {ACTIVITY_KINDS.map((k) => (
            <button
              key={k.value} type="button" aria-pressed={filters.kinds.includes(k.value)} onClick={() => setFilters((f) => ({ ...f, kinds: toggleKind(f.kinds, k.value), page: 1 }))}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                filters.kinds.includes(k.value) ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {k.label}
            </button>
          ))}
        </div>
        <DateField label="From" className="w-40 min-w-0 flex-none" value={filters.start} onChange={(v) => edit({ start: v })} />
        <DateField label="To" className="w-40 min-w-0 flex-none" value={filters.end} onChange={(v) => edit({ end: v })} />
        {narrowed && <Button type="button" variant="ghost" className="gap-1.5" onClick={() => setFilters(DEFAULT_ACTIVITY_FILTERS)}><X className="h-4 w-4" /> Clear filters</Button>}
      </div>

      {rangeError && <p className="text-sm text-destructive">{rangeError}</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {query && !report && !error && (
        <div className="flex items-center justify-center py-10 text-muted-foreground"><Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading…</div>
      )}

      {report && (
        <div className={cn("transition-opacity", loading && "opacity-60")}>
          <div className="rounded-xl border border-border bg-card/40">
            {report.items.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-muted-foreground">
                {narrowed ? "Nothing matches these filters." : "No activity yet."}
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {report.items.map((i) => {
                  const Icon = ACTIVITY_ICONS[i.kind] ?? Activity;
                  return (
                    <li key={i.id} className="flex items-start gap-3 px-4 py-3 text-sm">
                      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 break-words text-foreground">{historyText(i)}</span>
                      <span className="shrink-0 text-right text-xs text-muted-foreground" title={stamp(i.at)}>
                        {new Date(i.at).toLocaleString()}
                        <span className="block">{timeAgo(i.at)}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
            <span>{report.total === 0 ? "0 events" : rangeText(report.page, report.per_page || DEFAULT_PER_PAGE, report.total)}</span>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" className="gap-1" disabled={filters.page <= 1 || loading} onClick={() => setFilters((f) => ({ ...f, page: f.page - 1 }))}>
                <ChevronLeft className="h-4 w-4" /> Previous
              </Button>
              <span>Page {report.page} of {report.pages}</span>
              <Button size="sm" variant="outline" className="gap-1" disabled={filters.page >= report.pages || loading} onClick={() => setFilters((f) => ({ ...f, page: f.page + 1 }))}>
                Next <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const PartnerUserDetail = () => {
  const { userId = "" } = useParams();
  const portal = usePartnerPortal();
  const [user, setUser] = useState<PartnerUser | null>(null);
  const [missing, setMissing] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setUser(null);
    setMissing(null);
    api.getPartnerUser(userId).then(({ data, error }) => {
      if (!live) return;
      if (data && !error) setUser(data);
      else setMissing(error || "That user did not sign up through your link.");
    });
    return () => { live = false; };
  }, [userId]);

  const back = (
    <Link to="/partner/users" className="mb-2 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="h-4 w-4" /> All users
    </Link>
  );

  if (missing) {
    return (
      <div className="space-y-4">
        {back}
        <div className="rounded-xl border border-dashed border-border bg-card/40 py-14 text-center">
          <h3 className="font-semibold text-foreground">User not found</h3>
          <p className="mt-1 text-sm text-muted-foreground">{missing}</p>
        </div>
      </div>
    );
  }
  if (!user) {
    return <div className="flex items-center justify-center py-14 text-muted-foreground"><Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading...</div>;
  }

  return (
    <div className="space-y-8">
      <div>
        {back}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="break-all text-2xl font-semibold tracking-tight text-foreground">{userLabel(user)}</h1>
              <Badge variant={user.status === "verified" ? "default" : "secondary"}>{user.status === "verified" ? "Verified" : "Pending"}</Badge>
            </div>
            {user.full_name && <p className="break-all text-sm text-muted-foreground">{user.email}</p>}
          </div>
          <Button
            variant="outline" className="gap-1.5" disabled={!portal.canViewAs}
            title={portal.status === "paused" ? "Turned off while your partner account is paused" : undefined}
            onClick={() => portal.viewAs(user.user_id, user.email)}
          >
            {portal.viewing === user.user_id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />} View as
          </Button>
        </div>
      </div>

      {portal.status === "paused" && (
        <div className="rounded-xl border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm text-foreground">
          Your partner account is paused: you can still see this user's history, but "View as" is turned off.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 sm:gap-4">
        <Stat icon={CalendarPlus} label="Signed up" value={new Date(user.created_at).toLocaleDateString()} hint={timeAgo(user.created_at)} />
        <Stat
          icon={CalendarCheck} label="Verified"
          value={user.verified_at ? new Date(user.verified_at).toLocaleDateString() : "Not yet"}
          hint={user.verified_at ? timeAgo(user.verified_at) : "Has not confirmed their email"}
        />
        <Stat icon={Bot} label="Agents created" value={user.agents} />
        <Stat icon={Wallet} label="Top-ups" value={user.topups} hint={user.topups ? `${moneyOrDash(user.topup_total)} added in total` : "No funds added yet"} />
        <Stat icon={Phone} label="Calls" value={user.calls} hint={user.calls ? `${user.minutes} minutes` : undefined} />
        <Stat icon={DollarSign} label="Billed" value={moneyOrDash(user.billed)} />
        <Stat icon={Clock} label="Last active" value={timeAgo(user.last_active) || "—"} hint={stamp(user.last_active)} />
        <Stat icon={Phone} label="Last call" value={user.last_call ? timeAgo(user.last_call) : "—"} hint={user.last_call ? stamp(user.last_call) : "No calls yet"} />
      </div>

      <History userId={user.user_id} />
    </div>
  );
};

export default PartnerUserDetail;
