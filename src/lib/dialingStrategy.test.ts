import { describe, expect, it } from "vitest";
import {
  callCap, defaultDialing, describeDialing, describeDialingShort, dialingFromRow, dialingToPayload, effectiveCallLimit,
  limitWarning, pacedSpacingSeconds, secondsBetween, stallMessage, validateDialing,
} from "./dialingStrategy";

describe("dialingStrategy", () => {
  it("defaults: sequential, 5 at a time, 10 a minute, no delay", () => {
    expect(defaultDialing()).toEqual({ strategy: "sequential", concurrentCalls: 5, callsPerMinute: 10, delaySeconds: 0 });
  });

  it("reads a campaign row, and falls back to the defaults for a row without the fields", () => {
    expect(dialingFromRow({ dial_strategy: "paced", dial_concurrent_calls: 8, dial_calls_per_minute: 30, dial_delay_seconds: 4 }))
      .toEqual({ strategy: "paced", concurrentCalls: 8, callsPerMinute: 30, delaySeconds: 4 });
    expect(dialingFromRow({})).toEqual(defaultDialing());
    expect(dialingFromRow(null)).toEqual(defaultDialing());
    expect(dialingFromRow(undefined)).toEqual(defaultDialing());
    expect(dialingFromRow({ dial_strategy: "bogus", dial_concurrent_calls: "x" })).toEqual(defaultDialing());
    expect(dialingFromRow({ dial_strategy: "concurrent" }).concurrentCalls).toBe(5);
  });

  it("builds all four request fields in the backend's names", () => {
    expect(dialingToPayload({ strategy: "concurrent", concurrentCalls: 12, callsPerMinute: 30, delaySeconds: 2 })).toEqual({
      dial_strategy: "concurrent", dial_concurrent_calls: 12, dial_calls_per_minute: 30, dial_delay_seconds: 2,
    });
    expect(dialingToPayload(defaultDialing())).toEqual({
      dial_strategy: "sequential", dial_concurrent_calls: 5, dial_calls_per_minute: 10, dial_delay_seconds: 0,
    });
  });

  it("sends the default for a number the chosen strategy does not use when it was left invalid", () => {
    const p = dialingToPayload({ strategy: "paced", concurrentCalls: 99, callsPerMinute: 20, delaySeconds: 0 });
    expect(p.dial_concurrent_calls).toBe(5);
    expect(p.dial_calls_per_minute).toBe(20);
    expect(dialingToPayload({ strategy: "sequential", concurrentCalls: NaN, callsPerMinute: 0, delaySeconds: 1.5 }))
      .toEqual({ dial_strategy: "sequential", dial_concurrent_calls: 5, dial_calls_per_minute: 10, dial_delay_seconds: 0 });
  });

  describe("validateDialing", () => {
    const base = defaultDialing();
    it("accepts the defaults and the edges", () => {
      expect(validateDialing(base)).toBeNull();
      expect(validateDialing({ ...base, strategy: "concurrent", concurrentCalls: 1 })).toBeNull();
      expect(validateDialing({ ...base, strategy: "concurrent", concurrentCalls: 20 })).toBeNull();
      expect(validateDialing({ ...base, strategy: "paced", callsPerMinute: 60, delaySeconds: 60 })).toBeNull();
    });
    it("checks only the number the chosen strategy uses", () => {
      expect(validateDialing({ ...base, strategy: "sequential", concurrentCalls: 99, callsPerMinute: 0 })).toBeNull();
      expect(validateDialing({ ...base, strategy: "paced", concurrentCalls: 99 })).toBeNull();
      expect(validateDialing({ ...base, strategy: "concurrent", callsPerMinute: 99 })).toBeNull();
    });
    it("rejects out-of-range, fractional and empty values in words", () => {
      expect(validateDialing({ ...base, strategy: "concurrent", concurrentCalls: 21 })).toBe("Concurrent calls must be a whole number from 1 to 20.");
      expect(validateDialing({ ...base, strategy: "concurrent", concurrentCalls: 0 })).toBe("Concurrent calls must be a whole number from 1 to 20.");
      expect(validateDialing({ ...base, strategy: "concurrent", concurrentCalls: NaN })).toBe("Concurrent calls must be a whole number from 1 to 20.");
      expect(validateDialing({ ...base, strategy: "concurrent", concurrentCalls: 2.5 })).toBe("Concurrent calls must be a whole number from 1 to 20.");
      expect(validateDialing({ ...base, strategy: "paced", callsPerMinute: 61 })).toBe("Calls per minute must be a whole number from 1 to 60.");
      expect(validateDialing({ ...base, delaySeconds: 61 })).toBe("Delay between calls must be a whole number of seconds from 0 to 60.");
      expect(validateDialing({ ...base, delaySeconds: -1 })).toBe("Delay between calls must be a whole number of seconds from 0 to 60.");
      expect(validateDialing({ ...base, delaySeconds: NaN })).toBe("Delay between calls must be a whole number of seconds from 0 to 60.");
    });
  });

  it("describes each strategy in words for the review step", () => {
    expect(describeDialing(defaultDialing())).toBe("Sequential: one call at a time");
    expect(describeDialing({ ...defaultDialing(), delaySeconds: 10 })).toBe("Sequential: one call at a time, 10 s after each call ends");
    expect(describeDialing({ ...defaultDialing(), strategy: "concurrent" })).toBe("Concurrent: up to 5 calls at a time");
    expect(describeDialing({ ...defaultDialing(), strategy: "concurrent", delaySeconds: 3 })).toBe("Concurrent: up to 5 calls at a time, 3 s between calls");
    expect(describeDialing({ ...defaultDialing(), strategy: "paced" })).toBe("Paced: 10 calls per minute");
    expect(describeDialing({ ...defaultDialing(), strategy: "paced", delaySeconds: 3 })).toBe("Paced: 10 calls per minute, at least 3 s between calls");
  });

  it("says 'about' when the delay makes a paced campaign slower than its rate", () => {
    const s = { ...defaultDialing(), strategy: "paced" as const, delaySeconds: 20 };
    expect(pacedSpacingSeconds(s)).toBe(20);
    expect(describeDialing(s)).toBe("Paced: about 3 calls per minute (20 s between calls)");
    expect(describeDialingShort(s)).toBe("Paced · about 3/min · 20 s gap");
    expect(pacedSpacingSeconds(defaultDialing())).toBe(6);
  });

  it("has a short form for the card", () => {
    expect(describeDialingShort(defaultDialing())).toBe("Sequential · one at a time");
    expect(describeDialingShort({ ...defaultDialing(), strategy: "concurrent", delaySeconds: 2 })).toBe("Concurrent · 5 at a time · 2 s gap");
    expect(describeDialingShort({ ...defaultDialing(), strategy: "concurrent" })).toBe("Concurrent · 5 at a time");
    expect(describeDialingShort({ ...defaultDialing(), strategy: "paced" })).toBe("Paced · 10/min");
  });

  describe("account limit", () => {
    it("has no cap without limits, or with a null cap", () => {
      expect(effectiveCallLimit(null)).toBeNull();
      expect(effectiveCallLimit({ account_limit: null })).toBeNull();
    });
    it("takes the lower of the account and platform caps", () => {
      expect(effectiveCallLimit({ account_limit: 3 })).toBe(3);
      expect(effectiveCallLimit({ account_limit: 8, platform_limit: 5 })).toBe(5);
      expect(effectiveCallLimit({ account_limit: null, platform_limit: 6 })).toBe(6);
    });
    it("warns only when the settings ask for more than the cap", () => {
      const conc = { ...defaultDialing(), strategy: "concurrent" as const, concurrentCalls: 5 };
      expect(limitWarning(conc, { account_limit: 3 }))
        .toBe("Concurrent Calls is set to 5, but your account allows 3 calls at the same time. Calls will run 3 at a time.");
      expect(limitWarning(conc, { account_limit: 5 })).toBeNull();
      expect(limitWarning(conc, { account_limit: null })).toBeNull();
      expect(limitWarning(conc, null)).toBeNull();
      expect(limitWarning(defaultDialing(), { account_limit: 1 })).toBeNull();
      expect(limitWarning({ ...conc, strategy: "paced" }, { account_limit: 3 }))
        .toBe("Your account allows 3 calls at the same time, so this campaign may place fewer than 10 calls per minute.");
    });
    it("says the platform currently allows when the platform's cap is the binding one", () => {
      const conc = { ...defaultDialing(), strategy: "concurrent" as const, concurrentCalls: 5 };
      expect(limitWarning(conc, { account_limit: null, platform_limit: 3 }))
        .toBe("Concurrent Calls is set to 5, but the platform currently allows 3 calls at the same time. Calls will run 3 at a time.");
      expect(limitWarning(conc, { account_limit: 8, platform_limit: 2 }))
        .toBe("Concurrent Calls is set to 5, but the platform currently allows 2 calls at the same time. Calls will run 2 at a time.");
      expect(limitWarning({ ...conc, strategy: "paced" }, { account_limit: null, platform_limit: 1 }))
        .toBe("The platform currently allows 1 call at the same time, so this campaign may place fewer than 10 calls per minute.");
      // the account's own cap wins a tie, and a platform cap above the account's is not the binding one
      expect(limitWarning(conc, { account_limit: 3, platform_limit: 3 })).toMatch(/^Concurrent Calls is set to 5, but your account allows 3/);
      expect(limitWarning(conc, { account_limit: 3, platform_limit: 9 })).toMatch(/your account allows 3/);
      expect(limitWarning(conc, { account_limit: null, platform_limit: 9 })).toBeNull();
    });
    it("names whose cap it is in the same words as the server's warnings", () => {
      expect(callCap({ account_limit: 4, platform_limit: 6 })).toEqual({ cap: 4, source: "account" });
      expect(callCap({ account_limit: 7, platform_limit: 6 })).toEqual({ cap: 6, source: "platform" });
      expect(callCap({ account_limit: null, platform_limit: null })).toBeNull();
    });
  });

  it("turns a stall code into a sentence and never names the carrier", () => {
    expect(stallMessage(null)).toBeNull();
    expect(stallMessage("balance")).toMatch(/add funds/);
    expect(stallMessage("something_new")).toBe("Waiting (something new).");
    for (const c of ["balance", "blocked", "agent", "number", "provider_limit", "provider_error", "screening"]) {
      expect(stallMessage(c)).not.toMatch(/vapi|twilio|vonage|telnyx/i);
    }
  });

  it("counts whole seconds between two timestamps", () => {
    expect(secondsBetween("2026-10-24T10:00:00Z", "2026-10-24T10:00:03.200Z")).toBe(4);
    expect(secondsBetween("2026-10-24T10:00:05Z", "2026-10-24T10:00:00Z")).toBe(0);
    expect(secondsBetween(null, "2026-10-24T10:00:00Z")).toBeNull();
    expect(secondsBetween("nope", "2026-10-24T10:00:00Z")).toBeNull();
  });
});
