/**
 * Filter bar for card/list pages: a search box plus an "Advanced" panel with status, optional
 * category and date-range selects. It only collects the user's choices and reports them through
 * callbacks; the page does the actual filtering (see pages/dashboard/AIAgents.tsx, its current
 * user, which also turns the date-range label into a cutoff date). No API calls.
 */
import { useState } from "react";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

/** Select value meaning "no status filter"; pages compare against it to skip filtering. */
export const STATUS_DEFAULT = "All statuses";
/** Select value meaning "no category filter". */
export const CATEGORY_DEFAULT = "All categories";
/** Select value meaning "no date filter". The date select does not add it automatically, so it must be one of the date-range options. */
export const DATE_DEFAULT = "All time";
/** Default date-range choices. These are display labels only: the consuming page maps each one to a cutoff date. */
export const DATE_RANGE_OPTIONS = ["All time", "Last 7 days", "Last 30 days", "This year"];

/**
 * Search box with a collapsible "Advanced" panel (status, optional category, date range) and a
 * Clear button that appears once anything differs from its default.
 * `value`/`onChange` hold the search text and are always controlled by the page. Status, category
 * and date range are controlled when the page passes the value, otherwise the component falls back
 * to its own local state. The category select is shown only when `categoryOptions` is provided.
 * `extra` renders after the buttons in the search row.
 */
export function SmartFilters({
  placeholder = "Search…",
  value,
  onChange,
  extra,
  status,
  onStatusChange,
  statusOptions = ["Active", "Inactive", "Paused"],
  category,
  onCategoryChange,
  categoryOptions,
  dateRange,
  onDateRangeChange,
  dateRangeOptions = DATE_RANGE_OPTIONS,
}: {
  placeholder?: string;
  value?: string;
  onChange?: (v: string) => void;
  extra?: React.ReactNode;
  status?: string;
  onStatusChange?: (v: string) => void;
  statusOptions?: string[];
  category?: string;
  onCategoryChange?: (v: string) => void;
  categoryOptions?: string[];
  dateRange?: string;
  onDateRangeChange?: (v: string) => void;
  dateRangeOptions?: string[];
}) {
  const [advanced, setAdvanced] = useState(false);
  // Uncontrolled fallback so pages that don't wire status/category/dateRange
  // (e.g. Automation, which has no category) keep working unchanged.
  const [localStatus, setLocalStatus] = useState(STATUS_DEFAULT);
  const [localCategory, setLocalCategory] = useState(CATEGORY_DEFAULT);
  const [localDateRange, setLocalDateRange] = useState(DATE_DEFAULT);

  // A value passed in by the page takes precedence over the local fallback state.
  const effectiveStatus = status ?? localStatus;
  const effectiveCategory = category ?? localCategory;
  const effectiveDateRange = dateRange ?? localDateRange;
  const showCategory = categoryOptions !== undefined;

  // Each setter updates the local state and also notifies the page, so the fallback keeps
  // working when no onXChange prop is wired.
  const setStatus = (v: string) => {
    setLocalStatus(v);
    onStatusChange?.(v);
  };
  const setCategory = (v: string) => {
    setLocalCategory(v);
    onCategoryChange?.(v);
  };
  const setDateRange = (v: string) => {
    setLocalDateRange(v);
    onDateRangeChange?.(v);
  };

  // True when the search text or any dropdown differs from its default; controls the Clear button.
  const hasFilters =
    (value ?? "").length > 0 ||
    effectiveStatus !== STATUS_DEFAULT ||
    effectiveCategory !== CATEGORY_DEFAULT ||
    effectiveDateRange !== DATE_DEFAULT;

  // The search text has no local copy, so it is cleared through the page's onChange.
  // Category is reset only when that select is actually shown.
  const clearAll = () => {
    onChange?.("");
    setStatus(STATUS_DEFAULT);
    if (showCategory) setCategory(CATEGORY_DEFAULT);
    setDateRange(DATE_DEFAULT);
  };

  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={value ?? ""}
            onChange={(e) => onChange?.(e.target.value)}
            placeholder={placeholder}
            className="pl-9"
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setAdvanced((v) => !v)}
          className={cn(advanced && "border-primary text-primary")}
        >
          <SlidersHorizontal className="mr-2 h-4 w-4" />
          Advanced
        </Button>
        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearAll}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="mr-2 h-4 w-4" />
            Clear
          </Button>
        )}
        {extra}
      </div>
      {advanced && (
        <div className={cn("mt-3 grid gap-2 border-t border-border pt-3", showCategory ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
          <Select value={effectiveStatus} onValueChange={setStatus}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={STATUS_DEFAULT}>{STATUS_DEFAULT}</SelectItem>
              {statusOptions.map((s) => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {showCategory && (
            <Select value={effectiveCategory} onValueChange={setCategory}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={CATEGORY_DEFAULT}>{CATEGORY_DEFAULT}</SelectItem>
                {(categoryOptions ?? []).map((c) => (
                  <SelectItem key={c} value={c}>{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select value={effectiveDateRange} onValueChange={setDateRange}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {dateRangeOptions.map((d) => (
                <SelectItem key={d} value={d}>{d}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}
