import { describe, expect, it } from "vitest";
import { describeScreening, isCallerVerificationStatus, CALLER_VERIFICATION_LABEL } from "./callerVerification";

const row = (reason: string, over: Partial<{ decision: "answered" | "refused"; line_type: string | null }> = {}) =>
  describeScreening({ decision: "answered", line_type: null, reason, ...over });

describe("describeScreening", () => {
  it("names each reason in plain words", () => {
    expect(row("mobile_verified").label).toBe("Mobile number");
    expect(row("invalid_number", { decision: "refused" }).label).toBe("Not a valid number");
    expect(row("no_caller_number").label).toBe("No caller number");
    expect(row("unverifiable_number").label).toBe("Number can't be checked");
    expect(row("lookup_unavailable").label).toBe("Check unavailable");
  });

  it("says what kind of line a refused caller was on, when known", () => {
    expect(row("not_mobile", { decision: "refused", line_type: "landline" }).label).toBe("Landline number");
    expect(row("not_mobile", { decision: "refused", line_type: "voip" }).label).toBe("VoIP number");
    expect(row("not_mobile", { decision: "refused", line_type: null }).label).toBe("Not a mobile number");
    expect(row("not_mobile", { decision: "refused", line_type: "something-new" }).label).toBe("Not a mobile number");
  });

  it("marks only refused calls as refused", () => {
    expect(row("mobile_verified", { decision: "answered" }).refused).toBe(false);
    expect(row("lookup_unavailable", { decision: "answered" }).refused).toBe(false);
    expect(row("not_mobile", { decision: "refused" }).refused).toBe(true);
    expect(row("invalid_number", { decision: "refused" }).refused).toBe(true);
  });

  it("still reads sensibly for a reason it does not know yet", () => {
    expect(row("some_new_reason").label).toBe("some new reason");
  });

  it("never says the name of the voice service", () => {
    for (const reason of ["mobile_verified", "not_mobile", "invalid_number", "no_caller_number", "unverifiable_number", "lookup_unavailable"]) {
      expect(row(reason).label).not.toMatch(/vapi/i);
    }
    expect(CALLER_VERIFICATION_LABEL).not.toMatch(/vapi/i);
  });
});

describe("isCallerVerificationStatus", () => {
  it("accepts a real status payload", () => {
    expect(isCallerVerificationStatus({ available: true, reason: null })).toBe(true);
    expect(isCallerVerificationStatus({ available: false, reason: "Not set up yet." })).toBe(true);
  });

  it("rejects anything else, so a failed or odd response is ignored", () => {
    for (const bad of [null, undefined, {}, [], "x", 5, true, { available: "yes" }, { available: 1 }, { reason: "x" }]) {
      expect(isCallerVerificationStatus(bad)).toBe(false);
    }
  });
});
