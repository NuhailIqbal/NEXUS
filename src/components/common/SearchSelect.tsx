import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";

export interface SearchOption { value: string; label: string; keywords?: string; group?: string }

/** A dropdown with a search box: click, type to filter, pick. */
export function SearchSelect({
  id, ariaLabel, value, onChange, options, disabled, placeholder = "Select…", searchPlaceholder = "Search…", searchable = true,
}: {
  id?: string;
  ariaLabel?: string;
  value: string;
  onChange: (v: string) => void;
  options: SearchOption[];
  disabled?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  searchable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  const groups = Array.from(new Set(options.map((o) => o.group ?? "")));

  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        <button id={id} type="button" role="combobox" aria-expanded={open} aria-label={ariaLabel} disabled={disabled}
          className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-left text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50">
          <span className={cn("truncate", !current && "text-muted-foreground")}>{current?.label ?? (value || placeholder)}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-[12rem] p-0" align="start">
        <Command>
          {searchable && <CommandInput placeholder={searchPlaceholder} />}
          <CommandList>
            <CommandEmpty>No match.</CommandEmpty>
            {groups.map((g) => (
              <CommandGroup key={g} heading={g || undefined}>
                {options.filter((o) => (o.group ?? "") === g).map((o) => (
                  <CommandItem key={o.value} value={`${o.label} ${o.keywords ?? ""} ${o.value}`}
                    onSelect={() => { onChange(o.value); setOpen(false); }}>
                    <Check className={cn("mr-2 h-4 w-4", o.value === value ? "opacity-100" : "opacity-0")} />
                    {o.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
