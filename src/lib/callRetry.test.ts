import { describe, expect, it } from "vitest";
import {
  INTERVAL_OPTIONS, MAX_ATTEMPT_OPTIONS, RETRY_OUTCOMES, defaultRetry, describeAttemptDial, describeRetry, describeRetryShort, retryFromRow,
  retryOutcomesNote, retryToPayload, validateRetry,
} from "./callRetry";

describe("callRetry", () => {
  it("defaults: off, 3 calls, 10 minutes, every outcome ticked", () => {
    expect(defaultRetry()).toEqual({ enabled: false, maxAttempts: 3, intervalMinutes: 10, retryOn: [...RETRY_OUTCOMES] });
  });

  it("offers 1-10 calls and 5-60 minutes", () => {
    expect(MAX_ATTEMPT_OPTIONS[0]).toBe(1);
    expect(MAX_ATTEMPT_OPTIONS.at(-1)).toBe(10);
    expect(INTERVAL_OPTIONS[0]).toBe(5);
    expect(INTERVAL_OPTIONS.at(-1)).toBe(60);
    expect(INTERVAL_OPTIONS).toContain(10);
  });

  it("reads a campaign row, and falls back to the defaults for a row without the fields", () => {
    expect(retryFromRow({ retry_enabled: true, retry_max_attempts: 5, retry_interval_minutes: 30, retry_on: ["busy", "failed"] }))
      .toEqual({ enabled: true, maxAttempts: 5, intervalMinutes: 30, retryOn: ["busy", "failed"] });
    expect(retryFromRow({})).toEqual(defaultRetry());
    expect(retryFromRow(null)).toEqual(defaultRetry());
    expect(retryFromRow({ retry_on: ["failed", "bogus", "no_answer"] }).retryOn).toEqual(["no_answer", "failed"]);
  });

  it("builds the request fields in the backend's names and a fixed outcome order", () => {
    expect(retryToPayload({ enabled: true, maxAttempts: 4, intervalMinutes: 15, retryOn: ["voicemail", "no_answer"] })).toEqual({
      retry_enabled: true, retry_max_attempts: 4, retry_interval_minutes: 15, retry_on: ["no_answer", "voicemail"],
    });
  });

  it("only asks for an outcome while retrying is on", () => {
    expect(validateRetry({ ...defaultRetry(), enabled: true, retryOn: [] })).toBe("Choose at least one outcome to redial on.");
    expect(validateRetry({ ...defaultRetry(), enabled: true })).toBeNull();
    expect(validateRetry({ ...defaultRetry(), enabled: false, retryOn: [] })).toBeNull();
  });

  it("describes the settings in words", () => {
    expect(describeRetry(defaultRetry())).toBe("Off");
    expect(describeRetry({ enabled: true, maxAttempts: 3, intervalMinutes: 10, retryOn: ["no_answer", "busy"] }))
      .toBe("Up to 3 calls per number, 10 min apart, on no answer, busy");
    expect(describeRetry({ enabled: true, maxAttempts: 1, intervalMinutes: 5, retryOn: ["voicemail"] }))
      .toBe("Up to 1 call per number, 5 min apart, on voicemail");
  });

  it("has a short form for the card", () => {
    expect(describeRetryShort({ ...defaultRetry(), enabled: true, maxAttempts: 2, intervalMinutes: 5 })).toBe("Up to 2 calls · every 5 min");
    expect(describeRetryShort({ ...defaultRetry(), enabled: true, maxAttempts: 1 })).toBe("Up to 1 call · every 10 min");
  });

  it("names the outcomes only when not every one is ticked", () => {
    expect(retryOutcomesNote(defaultRetry())).toBeNull();
    expect(retryOutcomesNote({ ...defaultRetry(), retryOn: ["no_answer", "failed"] })).toBe("Redials on: no answer, call failed");
    expect(retryOutcomesNote({ ...defaultRetry(), retryOn: [] })).toBe("Redials on: nothing");
  });

  it("describes how a call was placed, or says nothing for a call without that record", () => {
    expect(describeAttemptDial({})).toBeNull();
    expect(describeAttemptDial({ dial_strategy: "sequential", dial_slot: 1, dial_batch: null, dial_source: "fresh" })).toBe("slot 1");
    expect(describeAttemptDial({ dial_strategy: "concurrent", dial_slot: 3, dial_batch: 2, dial_source: "fresh" })).toBe("slot 3 · wave 2");
    expect(describeAttemptDial({ dial_strategy: "concurrent", dial_slot: 3, dial_batch: 2, dial_source: "redial" })).toBe("slot 3 · wave 2 · redial");
    expect(describeAttemptDial({ dial_strategy: "paced", dial_slot: null, dial_batch: 9, dial_source: "fresh" })).toBe("paced");
  });
});
