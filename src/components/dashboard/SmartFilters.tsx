import { useState } from "react";
import { Search, SlidersHorizontal } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
        {extra}
      </div>
      {advanced && (
        <div className="mt-3 grid gap-2 border-t border-border pt-3 sm:grid-cols-3">
          <select className="h-9 rounded-md border border-input bg-background px-2 text-sm">
            <option>All statuses</option>
            <option>Active</option>
            <option>Inactive</option>
            <option>Paused</option>
          </select>
          <select className="h-9 rounded-md border border-input bg-background px-2 text-sm">
            <option>All categories</option>
            <option>Lead Qualifying</option>
            <option>Lead Verification</option>
            <option>Customer Support</option>
          </select>
          <select className="h-9 rounded-md border border-input bg-background px-2 text-sm">
            <option>Last 30 days</option>
            <option>Last 7 days</option>
            <option>This year</option>
          </select>
        </div>
      )}
    </div>
  );
}
