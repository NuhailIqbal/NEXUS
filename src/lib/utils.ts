import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// VAPI's transferCall tool rejects any destination number that isn't E.164 (e.g. a
// missing "+" or country code) with a 400 — validate up front so that shows as a
// clear inline error instead of a confusing VAPI error after save.
export function isE164(phone: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(phone.trim());
}
