/**
 * The call timeout of an AI agent: the longest one call may last, edited in whole minutes on the
 * agent form (Setup step) and stored as ai_agents.call_timeout_minutes. The range and the default
 * mirror services/vapi_client.py (MIN/MAX/DEFAULT_CALL_TIMEOUT_MINUTES); the server enforces them too.
 */
export const DEFAULT_CALL_TIMEOUT_MINUTES = 10;
export const MIN_CALL_TIMEOUT_MINUTES = 1;
export const MAX_CALL_TIMEOUT_MINUTES = 60;

/** The form keeps the field as the text typed, so it can be cleared and retyped. */
export const DEFAULT_CALL_TIMEOUT_TEXT = String(DEFAULT_CALL_TIMEOUT_MINUTES);

/** Why the typed value cannot be used (null when it can). A blank value means "use the default". */
export function callTimeoutError(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  const range = `${MIN_CALL_TIMEOUT_MINUTES} and ${MAX_CALL_TIMEOUT_MINUTES}`;
  if (!/^\d+$/.test(t)) return `Call timeout must be a whole number of minutes between ${range}`;
  const n = Number(t);
  return n < MIN_CALL_TIMEOUT_MINUTES || n > MAX_CALL_TIMEOUT_MINUTES ? `Call timeout must be between ${range} minutes` : null;
}

/** The minutes to send to the server: the typed whole number, or the default when blank/invalid. */
export function callTimeoutMinutes(text: string): number {
  return callTimeoutError(text) || !text.trim() ? DEFAULT_CALL_TIMEOUT_MINUTES : Number(text.trim());
}

/** The text for a stored value: an agent saved before this setting existed shows the default. */
export function callTimeoutText(stored: number | null | undefined): string {
  return String(stored || DEFAULT_CALL_TIMEOUT_MINUTES);
}
