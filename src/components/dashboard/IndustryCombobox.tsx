/**
 * Searchable single-select dropdown of industries, each with an icon and color chip, built from
 * the INDUSTRIES list in lib/industries.ts. The industry label is the value itself; the
 * create-agent wizard (pages/dashboard/CreateAIAgent.tsx) stores it as the agent's `category`.
 * Purely presentational: no API calls.
 */
import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { INDUSTRIES } from "@/lib/industries";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";

/**
 * Popover with a filterable list of industries. `value` is the selected industry label and
 * `onChange` receives the chosen label; picking an item closes the popover. A `value` that is
 * not in INDUSTRIES is still displayed, as plain text without an icon, and `placeholder` shows
 * only when `value` is empty.
 */
export function IndustryCombobox({
  value, onChange, placeholder = "Select an industry…",
}: { value: string; onChange: (label: string) => void; placeholder?: string }) {
  const [open, setOpen] = useState(false);
  // Undefined when `value` is empty or not a known label; the trigger then falls back to plain text.
  const selected = INDUSTRIES.find((ind) => ind.label === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          className="flex h-11 w-full items-center justify-between rounded-md border border-input bg-background px-3 text-sm"
        >
          {selected ? (
            <span className="flex items-center gap-2">
              <span className={cn("flex h-6 w-6 items-center justify-center rounded-md", selected.color)}>
                <selected.icon className="h-3.5 w-3.5" />
              </span>
              {selected.label}
            </span>
          ) : (
            <span className={value ? "" : "text-muted-foreground"}>{value || placeholder}</span>
          )}
          <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search industries…" />
          <CommandList>
            <CommandEmpty>No industries found.</CommandEmpty>
            <CommandGroup>
              {INDUSTRIES.map((ind) => {
                const Icon = ind.icon;
                return (
                  <CommandItem
                    key={ind.label}
                    value={ind.label}
                    onSelect={() => { onChange(ind.label); setOpen(false); }}
                  >
                    <Check className={cn("mr-2 h-4 w-4 shrink-0", value === ind.label ? "opacity-100" : "opacity-0")} />
                    <span className={cn("mr-2 flex h-6 w-6 shrink-0 items-center justify-center rounded-md", ind.color)}>
                      <Icon className="h-3.5 w-3.5" />
                    </span>
                    {ind.label}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
