/**
 * Thin wrapper around `window.location.assign`. Kept in its own module so tests can replace
 * it with `vi.mock("@/lib/navigate")` (see GoogleCalendarCard.test.tsx). Used by
 * components/integrations/calendarConnect.ts to send the browser to Google's sign-in.
 */
/** Full-page navigation (e.g. to an OAuth provider). A module of its own so tests can replace it. */
export const redirectTo = (url: string): void => {
  window.location.assign(url);
};
