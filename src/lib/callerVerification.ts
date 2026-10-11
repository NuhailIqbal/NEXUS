/**
 * Inbound caller verification: types and wording shared by the Phone Numbers and AI Receptionist
 * pages. When it is on for a number, the caller's number is looked up before the agent picks up
 * and only mobile numbers get through (backend: services/caller_verification.py).
 */

/** GET /telephony/caller-verification/status — whether the server can run the check at all. */
export type CallerVerificationStatus = { available: boolean; reason: string | null };

/** True when `value` is a usable status payload (so a failed or odd response is simply ignored). */
export function isCallerVerificationStatus(value: unknown): value is CallerVerificationStatus {
  return !!value && typeof value === "object" && typeof (value as { available?: unknown }).available === "boolean";
}

/** One row of GET /telephony/caller-verification/log: what happened to a call on a verified number. */
export type CallerVerificationLogRow = {
  id: string;
  phone_number_id: string | null;
  vapi_call_id: string | null;
  caller_number: string | null;
  decision: "answered" | "refused";
  reason: string;
  line_type: string | null;
  detail: string | null;
  created_at: string;
};

export const CALLER_VERIFICATION_LABEL = "Verify callers before answering";

/** Plain-language outcome of one check: the label to show and whether it was good news. */
export function describeScreening(row: Pick<CallerVerificationLogRow, "decision" | "reason" | "line_type">): {
  label: string;
  refused: boolean;
} {
  const refused = row.decision === "refused";
  switch (row.reason) {
    case "mobile_verified":
      return { label: "Mobile number", refused };
    case "not_mobile":
      if (row.line_type === "landline") return { label: "Landline number", refused };
      if (row.line_type === "voip") return { label: "VoIP number", refused };
      return { label: "Not a mobile number", refused };
    case "invalid_number":
      return { label: "Not a valid number", refused };
    case "no_caller_number":
      return { label: "No caller number", refused };
    case "unverifiable_number":
      return { label: "Number can't be checked", refused };
    case "lookup_unavailable":
      return { label: "Check unavailable", refused };
    default:
      return { label: row.reason.replace(/_/g, " "), refused };
  }
}
