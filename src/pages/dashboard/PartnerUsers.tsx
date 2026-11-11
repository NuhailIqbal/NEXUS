/**
 * Partner Portal > My users (/partner/users): every account that signed up through the partner's link, searchable
 * (email or name), filterable by status and signup dates, sortable by signup date, last activity, calls or billed, paged,
 * and exportable as CSV (every match, not just the page on screen). Each row opens the user's own page and keeps the
 * "View as" button (off while the partner is paused; the list itself stays readable). Dates are in the browser's time zone.
 * Data: GET /partner/users (services/partner_users.py). The platform's cost and profit are never in it.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowDown, ArrowLeft, ArrowUp, ChevronLeft, ChevronRight, Download, Eye, Loader2, Search, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DateField } from "@/components/call-consumption/FilterBar";
import { useReportData } from "@/components/partners/useReportSelection";
import { usePartnerPortal } from "@/components/partners/usePartnerPortal";
import { api } from "@/services/api";
import { moneyOrDash } from "@/lib/leadRoi";
import { timeAgo } from "@/lib/partners";
import { browserTimeZone } from "@/lib/partnerReports";
import {
  DEFAULT_PER_PAGE, DEFAULT_USER_FILTERS, SORT_OPTIONS, STATUS_OPTIONS, buildUsersCsvQuery, buildUsersQuery, hasFilters, rangeText,
  signupRangeError, userLabel, usersFilename, type Page, type PartnerUser, type UserFilters, type UserSort,
} from "@/lib/partnerUsers";

type Query = Record<string, string | undefined>;
const th = "px-3 py-3 text-right sm:px-4";
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "");

const PartnerUsers = () => {
  const tz = useMemo(browserTimeZone, []);
  const portal = usePartnerPortal();
  const [filters, setFilters] = useState<UserFilters>(DEFAULT_USER_FILTERS);
  const [search, setSearch] = useState("");
  const [downloading, setDownloading] = useState(false);

  // The search box feeds the filters after a short pause, so typing does not fire a request per letter.
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.q === search ? f : { ...f, q: search, page: 1 })), 300);
    return () => clearTimeout(t);
  }, [search]);

  const edit = (patch: Partial<UserFilters>) => setFilters((f) => ({ ...f, ...patch, page: 1 }));
  const clear = () => { setSearch(""); setFilters(DEFAULT_USER_FILTERS); };

  const query = useMemo(() => buildUsersQuery(filters, tz), [filters, tz]);
  const { report, error, loading } = useReportData<Page<PartnerUser>, Query>(query, (q) => api.getPartnerUsers(q));
  const rangeError = signupRangeError(filters.signedFrom, filters.signedTo);

  // A page that no longer exists (the list shrank) falls back to the last one.
  useEffect(() => {
    if (report && report.items.length === 0 && report.total > 0 && filters.page > report.pages) setFilters((f) => ({ ...f, page: report.pages }));
  }, [report, filters.page]);

  const download = async () => {
    const q = buildUsersCsvQuery(filters, tz);
    if (!q) return;
    setDownloading(true);
    const { error: err } = await api.downloadPartnerUsers(q, usersFilename());
    setDownloading(false);
    if (err) toast.error(err);
  };

  const users = report?.items ?? [];
  const everyUser = !!report && report.total === 0 && !hasFilters(filters);

  return (
    <div className="space-y-6">
      <div>
        <Link to="/partner" className="mb-2 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Partner portal
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">My users</h1>
            <p className="text-sm text-muted-foreground">Everyone who signed up through your link. Open a user to see what they did, or view their account.</p>
          </div>
          <Button variant="outline" className="gap-2" onClick={download} disabled={!query || downloading || !report || report.total === 0}>
            {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Download CSV
          </Button>
        </div>
      </div>

      {portal.status === "paused" && (
        <div className="rounded-xl border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm text-foreground">
          Your partner account is paused: you can still see your users and their history, but "View as" is turned off.
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="relative min-w-[14rem] flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by email or name" aria-label="Search users"
            className="pl-9" maxLength={100}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Status</Label>
          <Select value={filters.status || "all"} onValueChange={(v) => edit({ status: v === "all" ? "" : (v as UserFilters["status"]) })}>
            <SelectTrigger className="w-40" aria-label="Status"><SelectValue /></SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((o) => <SelectItem key={o.value || "all"} value={o.value || "all"}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <DateField label="Signed up from" className="w-40 min-w-0 flex-none" value={filters.signedFrom} onChange={(v) => edit({ signedFrom: v })} />
        <DateField label="Signed up to" className="w-40 min-w-0 flex-none" value={filters.signedTo} onChange={(v) => edit({ signedTo: v })} />
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Sort by</Label>
          <div className="flex gap-1">
            <Select value={filters.sort} onValueChange={(v) => edit({ sort: v as UserSort })}>
              <SelectTrigger className="w-40" aria-label="Sort by"><SelectValue /></SelectTrigger>
              <SelectContent>{SORT_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
            </Select>
            <Button
              type="button" variant="outline" size="icon" onClick={() => edit({ order: filters.order === "desc" ? "asc" : "desc" })}
              aria-label={filters.order === "desc" ? "Sorted high to low; switch to low to high" : "Sorted low to high; switch to high to low"}
              title={filters.order === "desc" ? "Newest / most first" : "Oldest / least first"}
            >
              {filters.order === "desc" ? <ArrowDown className="h-4 w-4" /> : <ArrowUp className="h-4 w-4" />}
            </Button>
          </div>
        </div>
        {(hasFilters(filters) || search) && (
          <Button type="button" variant="ghost" className="gap-1.5" onClick={clear}><X className="h-4 w-4" /> Clear filters</Button>
        )}
      </div>

      {rangeError && <p className="text-sm text-destructive">{rangeError}</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {query && !report && !error && (
        <div className="flex items-center justify-center py-14 text-muted-foreground"><Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading…</div>
      )}

      {report && everyUser && (
        <div className="rounded-xl border border-dashed border-border bg-card/40 py-14 text-center">
          <h3 className="font-semibold text-foreground">No users yet</h3>
          <p className="mt-1 text-sm text-muted-foreground">Share your referral link and people who register through it appear here.</p>
        </div>
      )}

      {report && !everyUser && (
        <div className={loading ? "opacity-60 transition-opacity" : "transition-opacity"}>
          <div className="overflow-hidden rounded-xl border border-border">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] text-sm">
                <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-3 text-left sm:px-4">User</th>
                    <th className="px-3 py-3 text-left sm:px-4">Status</th>
                    <th className="px-3 py-3 text-left sm:px-4">Signed up</th>
                    <th className={th}>Agents</th>
                    <th className={th}>Top-ups</th>
                    <th className={th}>Calls</th>
                    <th className={th}>Billed</th>
                    <th className="px-3 py-3 text-left sm:px-4">Last active</th>
                    <th className="px-3 py-3 sm:px-4" />
                  </tr>
                </thead>
                <tbody>
                  {users.length === 0 ? (
                    <tr><td colSpan={9} className="px-4 py-10 text-center text-muted-foreground">No users match these filters.</td></tr>
                  ) : users.map((u) => (
                    <tr key={u.user_id} className="border-t border-border bg-card/30">
                      <td className="px-3 py-3 sm:px-4">
                        <Link to={`/partner/users/${u.user_id}`} className="break-all font-medium text-foreground hover:underline">{userLabel(u)}</Link>
                        {u.full_name && <div className="break-all text-xs text-muted-foreground">{u.email}</div>}
                      </td>
                      <td className="px-3 py-3 sm:px-4">
                        <Badge variant={u.status === "verified" ? "default" : "secondary"}>{u.status === "verified" ? "Verified" : "Pending"}</Badge>
                        {u.verified_at && <div className="mt-1 text-xs text-muted-foreground">{day(u.verified_at)}</div>}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-muted-foreground sm:px-4">{day(u.created_at)}</td>
                      <td className="px-3 py-3 text-right sm:px-4">{u.agents}</td>
                      <td className="px-3 py-3 text-right sm:px-4">
                        {u.topups}{u.topups > 0 && <div className="text-xs text-muted-foreground">{moneyOrDash(u.topup_total)}</div>}
                      </td>
                      <td className="px-3 py-3 text-right sm:px-4">{u.calls}{u.calls > 0 && <div className="text-xs text-muted-foreground">{u.minutes} min</div>}</td>
                      <td className="px-3 py-3 text-right sm:px-4">{moneyOrDash(u.billed)}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-muted-foreground sm:px-4" title={u.last_active ? new Date(u.last_active).toLocaleString() : undefined}>{timeAgo(u.last_active) || "—"}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-right sm:px-4">
                        <Button
                          size="sm" variant="outline" className="gap-1.5" disabled={!portal.canViewAs}
                          title={portal.status === "paused" ? "Turned off while your partner account is paused" : undefined}
                          onClick={() => portal.viewAs(u.user_id, u.email)}
                        >
                          {portal.viewing === u.user_id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />} View as
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
            <span>{rangeText(report.page, report.per_page || DEFAULT_PER_PAGE, report.total)}</span>
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
};

export default PartnerUsers;
