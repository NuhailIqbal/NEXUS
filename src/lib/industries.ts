/**
 * Industry catalog (label, icon, badge colors) for the agent builder's industry picker.
 * Read by components/dashboard/IndustryCombobox.tsx (used in pages/dashboard/CreateAIAgent.tsx),
 * and its length feeds `INDUSTRY_COUNT` in lib/marketing-facts.ts, so adding or removing an
 * entry here also changes the marketing copy.
 */
import {
  ShoppingBag, HeartPulse, Landmark, Home, GraduationCap, Plane, Briefcase, Car,
  Shield, ClipboardList, Wifi, Wallet, Gavel, Handshake, type LucideIcon,
} from "lucide-react";

// Real industries only — specific products/niches (Final Expense, Medicare, Roofing,
// etc.) are NOT listed here; those are niches within one of these industries, not
// industries themselves, so they're left off this list entirely. The label itself
// is the stored value (agents.category is a plain string, no separate id/enum).
/**
 * Selectable industries, in display order. `label` is the persisted value; `icon` is a
 * lucide-react icon component; `color` is a Tailwind class string (tinted background plus
 * text color) applied to the icon's badge in the combobox.
 */
export const INDUSTRIES: { label: string; icon: LucideIcon; color: string }[] = [
  { label: "Retail & E-commerce", icon: ShoppingBag, color: "bg-orange-500/15 text-orange-400" },
  { label: "Healthcare & Medical", icon: HeartPulse, color: "bg-rose-500/15 text-rose-400" },
  { label: "Finance & Banking", icon: Landmark, color: "bg-emerald-500/15 text-emerald-400" },
  { label: "Real Estate", icon: Home, color: "bg-amber-500/15 text-amber-400" },
  { label: "Education", icon: GraduationCap, color: "bg-blue-500/15 text-blue-400" },
  { label: "Travel & Hospitality", icon: Plane, color: "bg-cyan-500/15 text-cyan-400" },
  { label: "SaaS & Technology", icon: Briefcase, color: "bg-violet-500/15 text-violet-400" },
  { label: "Automotive Industry", icon: Car, color: "bg-red-500/15 text-red-400" },
  { label: "Insurance", icon: Shield, color: "bg-teal-500/15 text-teal-400" },
  { label: "Debt & Credit Services", icon: Wallet, color: "bg-amber-500/15 text-amber-400" },
  { label: "Home Services & Contracting", icon: ClipboardList, color: "bg-slate-500/15 text-slate-400" },
  { label: "Legal Services", icon: Gavel, color: "bg-gray-500/15 text-gray-400" },
  { label: "Telecommunications & Internet", icon: Wifi, color: "bg-sky-500/15 text-sky-400" },
  { label: "Marketing & Professional Services", icon: Handshake, color: "bg-orange-500/15 text-orange-400" },
];
