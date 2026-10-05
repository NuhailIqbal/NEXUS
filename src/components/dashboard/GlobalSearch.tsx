/**
 * Top-bar search box (hidden below the md breakpoint) rendered by DashboardLayout. Matches the
 * typed text, case-insensitively, against a static list of dashboard pages and against the
 * account's agents, contacts, phone numbers and campaigns, which are fetched once on first focus
 * (GET /agents, /contacts, /telephony/phone-numbers, /telephony/campaigns). Filtering is done
 * entirely in the browser; picking a result navigates to the matching list page.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search, Bot, Users, Phone, PhoneOutgoing, X } from "lucide-react";
import { api } from "@/services/api";
import { cn } from "@/lib/utils";

/** One row in the results dropdown; `group` is its section heading and `to` the route opened on select. */
type ResultItem = {
  id: string;
  label: string;
  sublabel?: string;
  to: string;
  group: "Pages" | "AI Agents" | "Contacts" | "Phone Numbers" | "Campaigns";
  icon: React.ComponentType<{ className?: string }>;
};

/**
 * Searchable dashboard destinations. Hand-maintained: it follows the sidebar (NAV in
 * DashboardLayout) and adds a few sub-pages the sidebar does not list, such as Callbacks and the
 * Billing tabs, so a new route needs an entry here to be findable.
 */
const PAGES: { label: string; to: string }[] = [
  { label: "Quick Setup", to: "/dashboard/quick-setup" },
  { label: "AI Agents", to: "/dashboard/ai-agents" },
  { label: "AI Voices", to: "/dashboard/ai-voices" },
  { label: "Contacts", to: "/dashboard/database/contacts" },
  { label: "Lists", to: "/dashboard/database/lists" },
  { label: "Phone Numbers", to: "/dashboard/telephony/phone-numbers" },
  { label: "Campaigns", to: "/dashboard/telephony/campaigns" },
  { label: "Outbound Call Logs", to: "/dashboard/telephony/outbound-logs" },
  { label: "AI Receptionist", to: "/dashboard/telephony/inbound" },
  { label: "Inbound Call Logs", to: "/dashboard/telephony/inbound-logs" },
  { label: "All Conversations", to: "/dashboard/conversations" },
  { label: "Analytics — Channel", to: "/dashboard/analytics/channel" },
  { label: "Analytics — Campaign", to: "/dashboard/analytics/campaign" },
  { label: "Analytics — Scenario", to: "/dashboard/analytics/scenario" },
  { label: "Call Events", to: "/dashboard/call-events" },
  { label: "Call Events — Callbacks", to: "/dashboard/call-events/callbacks" },
  { label: "Automation", to: "/dashboard/automation" },
  { label: "Integrations", to: "/dashboard/integrations" },
  { label: "Billing", to: "/dashboard/billing" },
  { label: "Billing — Transactions", to: "/dashboard/billing/transactions" },
  { label: "Billing — Call Costs", to: "/dashboard/billing/call-costs" },
  { label: "Referrals", to: "/dashboard/referrals" },
  { label: "Profile & Teams", to: "/dashboard/profile" },
  { label: "Support", to: "/dashboard/support" },
];

/**
 * Search input plus a grouped, keyboard-navigable results dropdown (ArrowUp/ArrowDown move the
 * highlight, Enter opens it, Escape closes). The four record lists are loaded lazily by
 * loadRecords on the first focus, so the dashboard does not fetch them until the user searches.
 */
export default function GlobalSearch() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [records, setRecords] = useState<{
    agents: { id: string; name: string; category?: string | null }[];
    contacts: { id: string; name: string; phone?: string; email?: string }[];
    phoneNumbers: { id: string; number: string; status?: string }[];
    campaigns: { id: string; name: string; status?: string }[];
  }>({ agents: [], contacts: [], phoneNumbers: [], campaigns: [] });
  const containerRef = useRef<HTMLDivElement>(null);
  // Set as soon as loading starts (not when it finishes), so repeated focus events cannot start
  // duplicate fetches. It is never reset, so the records are fetched once per mount.
  const loadedRef = useRef(false);

  // Close the dropdown when the user presses the mouse anywhere outside the search container.
  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  /**
   * Fetches the four searchable collections in parallel, once per mount. api.* resolves with
   * `data: null` on failure instead of throwing, so a failed source simply yields an empty list
   * and is not retried until the component remounts.
   */
  const loadRecords = async () => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    setLoading(true);
    const [agentsRes, contactsRes, phoneRes, campaignsRes] = await Promise.all([
      api.getAgents(),
      api.getContacts(),
      api.getPhoneNumbers(),
      api.getCampaigns(),
    ]);
    setRecords({
      agents: agentsRes.data ?? [],
      contacts: contactsRes.data ?? [],
      phoneNumbers: phoneRes.data ?? [],
      campaigns: campaignsRes.data ?? [],
    });
    setLoading(false);
  };

  // Flat, ordered result list for the current query: pages first, then agents, contacts, phone
  // numbers and campaigns, truncated to 30 in total (so later groups are cut first). Contacts also
  // match on phone and email. Record results link to their list page, not to the individual record.
  const results = useMemo<ResultItem[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];

    const pageMatches: ResultItem[] = PAGES.filter((p) =>
      p.label.toLowerCase().includes(q),
    ).map((p) => ({
      id: p.to,
      label: p.label,
      to: p.to,
      group: "Pages",
      icon: Search,
    }));

    const agentMatches: ResultItem[] = records.agents
      .filter((a) => a.name?.toLowerCase().includes(q))
      .map((a) => ({
        id: a.id,
        label: a.name,
        sublabel: a.category ?? undefined,
        to: `/dashboard/ai-agents`,
        group: "AI Agents",
        icon: Bot,
      }));

    const contactMatches: ResultItem[] = records.contacts
      .filter(
        (c) =>
          c.name?.toLowerCase().includes(q) ||
          c.phone?.toLowerCase().includes(q) ||
          c.email?.toLowerCase().includes(q),
      )
      .map((c) => ({
        id: c.id,
        label: c.name,
        sublabel: c.phone || c.email,
        to: `/dashboard/database/contacts`,
        group: "Contacts",
        icon: Users,
      }));

    const phoneMatches: ResultItem[] = records.phoneNumbers
      .filter((p) => p.number?.toLowerCase().includes(q))
      .map((p) => ({
        id: p.id,
        label: p.number,
        sublabel: p.status ?? undefined,
        to: `/dashboard/telephony/phone-numbers`,
        group: "Phone Numbers",
        icon: Phone,
      }));

    const campaignMatches: ResultItem[] = records.campaigns
      .filter((c) => c.name?.toLowerCase().includes(q))
      .map((c) => ({
        id: c.id,
        label: c.name,
        sublabel: c.status ?? undefined,
        to: `/dashboard/telephony/campaigns`,
        group: "Campaigns",
        icon: PhoneOutgoing,
      }));

    return [
      ...pageMatches,
      ...agentMatches,
      ...contactMatches,
      ...phoneMatches,
      ...campaignMatches,
    ].slice(0, 30);
  }, [query, records]);

  // Buckets `results` by group for rendering. A Map keeps insertion order, so the sections appear
  // in the same order as the flat list that the keyboard highlight indexes into.
  const grouped = useMemo(() => {
    const map = new Map<string, ResultItem[]>();
    for (const r of results) {
      const list = map.get(r.group) ?? [];
      list.push(r);
      map.set(r.group, list);
    }
    return map;
  }, [results]);

  // Restart the highlight at the first result whenever the query changes.
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  /** Navigates to the result's route, then closes the dropdown and clears the query. */
  const selectResult = (item: ResultItem) => {
    navigate(item.to);
    setOpen(false);
    setQuery("");
  };

  /**
   * Keyboard control for the input: arrows move the highlight (clamped at both ends), Enter
   * opens the highlighted result and Escape closes the dropdown. Ignored while the dropdown is
   * closed or empty, so Enter and the arrows keep their normal input behaviour then.
   */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = results[activeIndex];
      if (item) selectResult(item);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  // Render-time counter, incremented once per rendered item. The JSX below is grouped by section,
  // so this recovers each item's position in the flat `results` list, which is what `activeIndex`
  // (keyboard and hover highlight) refers to. The dropdown shows "Searching…" while the first load
  // is in flight with nothing loaded yet, "No results", or the grouped results.
  let runningIndex = -1;

  return (
    <div ref={containerRef} className="relative hidden flex-1 max-w-md md:block">
      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          setOpen(true);
          loadRecords();
        }}
        onKeyDown={handleKeyDown}
        placeholder="Search agents, contacts, numbers, pages…"
        className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-8 text-sm outline-none focus:ring-2 focus:ring-ring"
      />
      {query && (
        <button
          onClick={() => {
            setQuery("");
            setOpen(false);
          }}
          aria-label="Clear search"
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      )}

      {open && query.trim() && (
        <div className="absolute left-0 right-0 top-11 z-50 max-h-96 overflow-y-auto rounded-md border border-border bg-popover shadow-lg">
          {loading && records.agents.length === 0 && records.contacts.length === 0 ? (
            <div className="px-3 py-4 text-sm text-muted-foreground">Searching…</div>
          ) : results.length === 0 ? (
            <div className="px-3 py-4 text-sm text-muted-foreground">
              No results for &quot;{query}&quot;
            </div>
          ) : (
            Array.from(grouped.entries()).map(([group, items]) => (
              <div key={group} className="py-1">
                <div className="px-3 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {group}
                </div>
                {items.map((item) => {
                  runningIndex += 1;
                  const idx = runningIndex;
                  const Icon = item.icon;
                  return (
                    <button
                      key={`${item.group}-${item.id}`}
                      onClick={() => selectResult(item)}
                      onMouseEnter={() => setActiveIndex(idx)}
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors",
                        idx === activeIndex ? "bg-muted" : "hover:bg-muted",
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="flex-1 truncate">{item.label}</span>
                      {item.sublabel && (
                        <span className="shrink-0 truncate text-xs text-muted-foreground">
                          {item.sublabel}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
