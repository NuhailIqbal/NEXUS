/**
 * Shared table building blocks: a sortable column header, per-column text/select/date filters and
 * a pagination footer. They are controlled, presentational components: the page owns the sort,
 * filter and page state and does the actual data work (no API calls here).
 * Used by Contacts, PhoneNumbers, InboundLogs, OutboundLogs, AutomationList, FlowEditor, Admin
 * and the billing CallCosts and Transactions tables.
 */
import { ArrowUp, ArrowDown, ArrowUpDown, CalendarIcon, ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, RefreshCw, Search, X } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// Shared building blocks for the "All Conversations"-style data table: a
// two-row <thead> (sort-toggle labels, then a per-column filter row) plus a
// pagination footer. Each page keeps its own <table>/<tbody> and columns —
// these just standardize the repeated header/filter/pagination bits so every
// table on the site looks and behaves the same way.

/**
 * Clickable column label for the sort row of a table header. `active` marks the column that is
 * currently sorted and `dir` its direction (up or down arrow); other columns show a faded up/down
 * icon. The page's `onClick` decides how a click changes the sort.
 */
export function SortableColumnHeader({
  label, active, dir, onClick,
}: { label: string; active: boolean; dir: "asc" | "desc"; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between gap-1 hover:text-foreground"
    >
      <span>{label}</span>
      {active ? (
        dir === "asc" ? <ArrowUp className="h-3 w-3 shrink-0" /> : <ArrowDown className="h-3 w-3 shrink-0" />
      ) : (
        <ArrowUpDown className="h-3 w-3 shrink-0 opacity-50" />
      )}
    </button>
  );
}

/** Compact search input for a column's filter row; fully controlled through `value`/`onChange`. */
export function TableTextFilter({
  value, onChange, placeholder,
}: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8 pl-7 text-xs"
      />
    </div>
  );
}

/**
 * Compact dropdown for a column's filter row. Callers use "" to mean "no filter"; the component
 * shows it as the "All" item using the sentinel value "__all__", because Radix Select does not
 * allow an item with an empty-string value (an empty value clears the selection and shows the placeholder).
 */
export function TableSelectFilter({
  value, onChange, options, placeholder,
}: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; placeholder: string }) {
  return (
    <Select value={value || "__all__"} onValueChange={(v) => onChange(v === "__all__" ? "" : v)}>
      <SelectTrigger className="h-8 text-xs">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__all__">All</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Single-day filter: a button showing the chosen date (or "Date") that opens a calendar popover.
 * `value` is undefined when no date is chosen. Once a date is set, an inline "x" clears it; that
 * control is a span with role="button" rather than a nested <button> (it sits inside the trigger
 * button, and buttons cannot be nested), and it stops propagation so the click does not also open the popover.
 */
export function TableDateFilter({
  value, onChange,
}: { value: Date | undefined; onChange: (d: Date | undefined) => void }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-8 w-full items-center gap-1.5 rounded-md border border-input bg-background px-2 text-left text-xs text-muted-foreground hover:bg-muted"
        >
          <CalendarIcon className="h-3 w-3 shrink-0" />
          <span className="flex-1 truncate">{value ? format(value, "MMM d, yyyy") : "Date"}</span>
          {value && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); onChange(undefined); }}
              className="rounded p-0.5 hover:bg-muted-foreground/20"
            >
              <X className="h-3 w-3" />
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar mode="single" selected={value} onSelect={onChange} initialFocus />
      </PopoverContent>
    </Popover>
  );
}

/** Default choices for the "Items per page" select in TablePagination. */
export const TABLE_PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

/**
 * Items to render in the pager for a 1-based `page`: always the first and last page, the current
 * page with one neighbour on each side, and an "ellipsis" marker wherever pages are skipped
 * (for example 1 ... 4 5 6 ... 20).
 */
function pageWindow(page: number, totalPages: number): (number | "ellipsis")[] {
  const items: (number | "ellipsis")[] = [];
  const siblings = 1;
  const start = Math.max(2, page - siblings);
  const end = Math.min(totalPages - 1, page + siblings);

  items.push(1);
  if (start > 2) items.push("ellipsis");
  for (let n = start; n <= end; n++) items.push(n);
  if (end < totalPages - 1) items.push("ellipsis");
  if (totalPages > 1) items.push(totalPages);
  return items;
}

/**
 * Pager controls: first and previous buttons, the windowed page numbers, then next and last.
 * The edge buttons are disabled on the first/last page. `page` is 1-based.
 */
function PageNumbers({
  page, totalPages, onChange,
}: { page: number; totalPages: number; onChange: (p: number) => void }) {
  const items = pageWindow(page, totalPages);
  // Class helpers: `btn` styles a page-number button (highlighted when active),
  // `iconBtn` the first/previous/next/last arrow buttons.
  const btn = (active: boolean) =>
    `flex h-8 min-w-8 items-center justify-center rounded-md px-2 text-sm transition ${
      active ? "bg-primary text-primary-foreground font-medium" : "text-muted-foreground hover:bg-muted hover:text-foreground"
    }`;
  const iconBtn = "flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40";

  return (
    <div className="flex flex-wrap items-center justify-center gap-1">
      <button type="button" className={iconBtn} disabled={page <= 1} onClick={() => onChange(1)} aria-label="First page" title="First page">
        <ChevronFirst className="h-4 w-4" />
      </button>
      <button type="button" className={iconBtn} disabled={page <= 1} onClick={() => onChange(page - 1)} aria-label="Previous page" title="Previous page">
        <ChevronLeft className="h-4 w-4" />
      </button>
      {items.map((it, i) =>
        it === "ellipsis" ? (
          <span key={`e${i}`} className="px-1.5 text-sm text-muted-foreground">…</span>
        ) : (
          <button key={it} type="button" className={btn(it === page)} onClick={() => onChange(it)}>
            {it}
          </button>
        )
      )}
      <button type="button" className={iconBtn} disabled={page >= totalPages} onClick={() => onChange(page + 1)} aria-label="Next page" title="Next page">
        <ChevronRight className="h-4 w-4" />
      </button>
      <button type="button" className={iconBtn} disabled={page >= totalPages} onClick={() => onChange(totalPages)} aria-label="Last page" title="Last page">
        <ChevronLast className="h-4 w-4" />
      </button>
    </div>
  );
}

/**
 * Table footer with an "Items per page" select, the page numbers and an "x - y of N items"
 * summary, plus an optional refresh button (shown only when `onRefresh` is given). `page` is
 * 1-based and `totalCount` is the row count across all pages; the caller slices or fetches the
 * visible rows itself. Renders nothing when `totalCount` is 0.
 */
export function TablePagination({
  page, pageSize, totalCount, onPageChange, onPageSizeChange, onRefresh, pageSizeOptions = TABLE_PAGE_SIZE_OPTIONS,
}: {
  page: number;
  pageSize: number;
  totalCount: number;
  onPageChange: (p: number) => void;
  onPageSizeChange: (n: number) => void;
  onRefresh?: () => void;
  pageSizeOptions?: number[];
}) {
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  if (totalCount === 0) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/30 px-4 py-3">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span>Items per page</span>
        <Select value={String(pageSize)} onValueChange={(v) => onPageSizeChange(Number(v))}>
          <SelectTrigger className="h-8 w-[72px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {pageSizeOptions.map((n) => (
              <SelectItem key={n} value={String(n)}>{n}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <PageNumbers page={page} totalPages={totalPages} onChange={onPageChange} />

      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <span>
          {(page - 1) * pageSize + 1} - {Math.min(page * pageSize, totalCount)} of {totalCount} items
        </span>
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            className="rounded-md p-2.5 sm:p-1.5 hover:bg-muted hover:text-foreground"
            aria-label="Refresh"
            title="Refresh"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}
