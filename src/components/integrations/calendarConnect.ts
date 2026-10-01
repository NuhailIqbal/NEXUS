import { api } from "@/services/api";
import { redirectTo } from "@/lib/navigate";
import { browserTimezone } from "./calendarTypes";

/**
 * Starts the Google sign-in for the current account and sends the browser to Google.
 * Resolves to an error message if it couldn't start (the page stays put), or null once the
 * redirect has begun. Google sends the user back to /dashboard/integrations?calendar=...
 */
export async function startGoogleConnect(): Promise<string | null> {
  const { data, error } = await api.getCalendarConnectUrl(browserTimezone());
  const url = (data as { url?: string } | null)?.url;
  if (error || !url) return error || "Couldn't start the Google connection.";
  redirectTo(url);
  return null;
}
