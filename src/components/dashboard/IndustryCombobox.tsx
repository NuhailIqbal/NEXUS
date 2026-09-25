import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { INDUSTRIES } from "@/lib/industries";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";

export function IndustryCombobox({
  value, onChange, placeholder = "Select an industry…",
}: { value: string; onChange: (label: string) => void; placeholder?: string }) {
  const [open, setOpen] = useState(false);
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
