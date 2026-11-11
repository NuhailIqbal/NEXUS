/**
 * The phone numbers connected to an AI agent, as the agents list returns them (GET /agents puts
 * `phone_numbers` on every agent) and how the agent card words them.
 */
export type AgentPhone = { id: string; number: string; label?: string | null };

/** What the card's "Phone" row shows when the agent has no number. */
export const NO_PHONE_TEXT = "Not connected";

/** The numbers as one line, e.g. "+15551230001, +15551230002", or NO_PHONE_TEXT when there are none. */
export function phoneText(phones: AgentPhone[] | null | undefined): string {
  const numbers = (phones ?? []).map((p) => (p.number || "").trim()).filter(Boolean);
  return numbers.length ? numbers.join(", ") : NO_PHONE_TEXT;
}

/** Hover text for the row: each number with its label when it has one. Empty when there are none. */
export function phoneTitle(phones: AgentPhone[] | null | undefined): string {
  return (phones ?? [])
    .filter((p) => (p.number || "").trim())
    .map((p) => (p.label?.trim() ? `${p.number.trim()} (${p.label.trim()})` : p.number.trim()))
    .join("\n");
}
