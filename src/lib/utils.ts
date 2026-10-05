/**
 * Small shared helpers: `cn` (Tailwind class merging, used throughout the UI) and `isE164`
 * (phone-number format check used by the create/edit agent forms for the call-transfer number).
 */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Joins class names (strings, arrays, objects, falsy values skipped, via clsx) and resolves
 * conflicting Tailwind utilities with tailwind-merge, so the last conflicting class wins.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// VAPI's transferCall tool rejects any destination number that isn't E.164 (e.g. a
// missing "+" or country code) with a 400 — validate up front so that shows as a
// clear inline error instead of a confusing VAPI error after save.
/**
 * True if `phone` (after trimming surrounding whitespace) is a "+" followed by 7-15 digits
 * with a non-zero first digit. Format check only; it does not verify the number exists.
 */
export function isE164(phone: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(phone.trim());
}
