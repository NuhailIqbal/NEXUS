/**
 * Shared types, limits and helpers for call events, used by the Call Events page, the event
 * dialog, the agent wizard step and the agent duplicate flow.
 */
/** Which call directions an event applies to. */
export type CallEventScope = "both" | "inbound" | "outbound";

/** A call event in the account-level library (GET /call-events). */
export type LibraryEvent = {
  id: string;
  event_key: string;
  label: string;
  description: string | null;
  outcome: string | null;
  applies_to: CallEventScope;
  schedules_callback?: boolean;   // raising it records a callback (when the caller asked to be called back)
  agent_count?: number;
  agents?: { id: string; name: string }[];
};

/** Display text for each scope. */
export const SCOPE_LABEL: Record<CallEventScope, string> = {
  both: "Inbound & outbound",
  inbound: "Inbound only",
  outbound: "Outbound only",
};

// Limits: events selectable per agent, and max lengths of the dialog's text fields.
export const MAX_CALL_EVENTS = 20;
export const MAX_LABEL = 60;
export const MAX_OUTCOME = 60;
export const MAX_DESCRIPTION = 200;

/** Shapes an agent's selected library event ids for the agents API. */
export const toCallEventsPayload = (ids: string[]) => ids.map((event_id) => ({ event_id }));

/** Toast text for library edits/deletes whose voice-service sync failed for some agents. */
export const syncWarningText = (names: string[]) =>
  `Saved, but ${names.length === 1 ? "this agent" : "these agents"} couldn't be updated in the voice service: ${names.join(", ")}. Open the agent and save it again to retry.`;
