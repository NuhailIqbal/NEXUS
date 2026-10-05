/**
 * Placeholder for the former Supabase client. No network or auth logic lives here:
 * sign-in/session handling is in contexts/AuthContext.tsx and data access goes through
 * services/api.ts (FastAPI backend). No module in src/ currently imports this file.
 */
// Supabase has been removed. Auth is now handled by the FastAPI backend.
// This file is kept as an empty export so any lingering imports don't break at compile time.
/**
 * Empty stand-in object, typed `any` so a stray `supabase.xxx` reference still compiles;
 * calling any method on it throws at runtime because it has no members.
 */
export const supabase = {} as any;
