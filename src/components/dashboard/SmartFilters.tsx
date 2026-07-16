import { useState } from "react";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const STATUS_DEFAULT = "All statuses";
const CATEGORY_DEFAULT = "All categories";
const DATE_DEFAULT = "Last 30 days";

export function SmartFilters({
  placeholder = "Search…",
  value,
  onChange,
  extra,
}: {
  placeholder?: string;
  value?: string;
  onChange?: (v: string) => void;
  extra?: React.ReactNode;
}) {
  const [advanced, setAdvanced] = useState(false);
  const [status, setStatus] = useState(STATUS_DEFAULT);
  const [category, setCategory] = useState(CATEGORY_DEFAULT);
  const [dateRange, setDateRange] = useState(DATE_DEFAULT);

  const hasFilters =
    (value ?? "").length > 0 ||
    status !== STATUS_DEFAULT ||
    category !== CATEGORY_DEFAULT ||
    dateRange !== DATE_DEFAULT;

  const clearAll = () => {
    onChange?.("");
    setStatus(STATUS_DEFAULT);
    setCategory(CATEGORY_DEFAULT);
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
        <div className="mt-3 grid gap-2 border-t border-border pt-3 sm:grid-cols-3">
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option>{STATUS_DEFAULT}</option>
            <option>Active</option>
            <option>Inactive</option>
            <option>Paused</option>
          </select>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option>{CATEGORY_DEFAULT}</option>
            <option>Lead Qualifying</option>
            <option>Lead Verification</option>
            <option>Customer Support</option>
          </select>
          <select
            value={dateRange}
            onChange={(e) => setDateRange(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option>{DATE_DEFAULT}</option>
            <option>Last 7 days</option>
            <option>This year</option>
          </select>
        </div>
      )}
    </div>
  );
}
