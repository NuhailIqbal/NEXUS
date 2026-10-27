import { describe, expect, it } from "vitest";
import {
  FOLLOWUP_GAP_PRESETS, INTERVAL_OPTIONS, MAX_ATTEMPT_OPTIONS, RETRY_OUTCOMES, defaultRetry, describeAttemptDial, describeFollowup,
  describeFollowupCard, describeRetry, describeRetryShort, retryFromRow, retryOutcomesNote, retryToPayload, validateRetry,
} from "./callRetry";

describe("callRetry", () => {
  it("defaults: off, 3 calls, 10 minutes, every outcome ticked", () => {
    expect(defaultRetry()).toEqual({
      enabled: false, maxAttempts: 3, intervalMinutes: 10, retryOn: [...RETRY_OUTCOMES], followupRounds: 0, followupGapHours: 24,
    });
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
      .toEqual({ enabled: true, maxAttempts: 5, intervalMinutes: 30, retryOn: ["busy", "failed"], followupRounds: 0, followupGapHours: 24 });
    expect(retryFromRow({})).toEqual(defaultRetry());
    expect(retryFromRow(null)).toEqual(defaultRetry());
    expect(retryFromRow({ retry_on: ["failed", "bogus", "no_answer"] }).retryOn).toEqual(["no_answer", "failed"]);
  });

  it("builds the request fields in the backend's names and a fixed outcome order", () => {
    expect(retryToPayload({ ...defaultRetry(), enabled: true, maxAttempts: 4, intervalMinutes: 15, retryOn: ["voicemail", "no_answer"] })).toEqual({
      retry_enabled: true, retry_max_attempts: 4, retry_interval_minutes: 15, retry_on: ["no_answer", "voicemail"],
      followup_rounds: 0, followup_gap_hours: 24,
    });
  });

  it("only asks for an outcome while retrying is on", () => {
    expect(validateRetry({ ...defaultRetry(), enabled: true, retryOn: [] })).toBe("Choose at least one outcome to redial on.");
    expect(validateRetry({ ...defaultRetry(), enabled: true })).toBeNull();
    expect(validateRetry({ ...defaultRetry(), enabled: false, retryOn: [] })).toBeNull();
  });

  it("describes the settings in words", () => {
    expect(describeRetry(defaultRetry())).toBe("Off");
    expect(describeRetry({ ...defaultRetry(), enabled: true, maxAttempts: 3, intervalMinutes: 10, retryOn: ["no_answer", "busy"] }))
      .toBe("Up to 3 calls per number, 10 min apart, on no answer, busy");
    expect(describeRetry({ ...defaultRetry(), enabled: true, maxAttempts: 1, intervalMinutes: 5, retryOn: ["voicemail"] }))
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

  describe("second-chance rounds", () => {
    const on = { ...defaultRetry(), enabled: true };

    it("are off by default, 24 hours apart, and the gap presets are 4, 12, 24 and 48 hours", () => {
      expect(defaultRetry()).toMatchObject({ followupRounds: 0, followupGapHours: 24 });
      expect(FOLLOWUP_GAP_PRESETS.map((p) => p.hours)).toEqual([4, 12, 24, 48]);
      expect(FOLLOWUP_GAP_PRESETS.find((p) => p.hours === 24)?.label).toBe("24 h (next day)");
    });

    it("are read from the campaign row, with the defaults for a row from before the feature or a bad value", () => {
      expect(retryFromRow({ followup_rounds: 2, followup_gap_hours: 12 })).toMatchObject({ followupRounds: 2, followupGapHours: 12 });
      expect(retryFromRow({})).toMatchObject({ followupRounds: 0, followupGapHours: 24 });
      expect(retryFromRow({ followup_rounds: 7, followup_gap_hours: 99 })).toMatchObject({ followupRounds: 0, followupGapHours: 24 });
      expect(retryFromRow({ followup_rounds: "2", followup_gap_hours: 2.5 })).toMatchObject({ followupRounds: 0, followupGapHours: 24 });
    });

    it("go in the payload as followup_rounds and followup_gap_hours", () => {
      expect(retryToPayload({ ...on, followupRounds: 3, followupGapHours: 48 })).toMatchObject({ followup_rounds: 3, followup_gap_hours: 48 });
    });

    it("go as 0 rounds while Auto Redial is off (the server refuses rounds without it), keeping the wait", () => {
      expect(retryToPayload({ ...defaultRetry(), followupRounds: 2, followupGapHours: 6 })).toMatchObject({
        retry_enabled: false, followup_rounds: 0, followup_gap_hours: 6,
      });
    });

    it("send the default wait rather than a number the server would refuse", () => {
      expect(retryToPayload({ ...on, followupRounds: 0, followupGapHours: NaN }).followup_gap_hours).toBe(24);
      expect(retryToPayload({ ...on, followupRounds: 0, followupGapHours: 60 }).followup_gap_hours).toBe(24);
    });

    it("need a whole number of hours from 1 to 48 while they are on", () => {
      const msg = "Wait between rounds must be a whole number of hours from 1 to 48.";
      for (const bad of [0, 49, 2.5, NaN, -3]) expect(validateRetry({ ...on, followupRounds: 1, followupGapHours: bad })).toBe(msg);
      for (const good of [1, 4, 24, 48]) expect(validateRetry({ ...on, followupRounds: 1, followupGapHours: good })).toBeNull();
      expect(validateRetry({ ...on, followupRounds: 0, followupGapHours: NaN })).toBeNull();
      expect(validateRetry({ ...defaultRetry(), followupRounds: 2, followupGapHours: NaN })).toBeNull();
    });

    it("are described for the review step, and read as off without Auto Redial", () => {
      expect(describeFollowup(on)).toBe("Off");
      expect(describeFollowup({ ...on, followupRounds: 1 })).toBe("1 round, 24 h apart");
      expect(describeFollowup({ ...on, followupRounds: 3, followupGapHours: 12 })).toBe("3 rounds, 12 h apart");
      expect(describeFollowup({ ...defaultRetry(), followupRounds: 3 })).toBe("Off");
    });

    it("describe the card: the summary, then the next round or the rounds done", () => {
      const at = (iso: string) => `at ${iso}`;
      expect(describeFollowupCard(undefined, at)).toBeNull();
      expect(describeFollowupCard({ rounds: 0, gap_hours: 24, done: 0, next_at: null, waiting: false }, at)).toBeNull();
      expect(describeFollowupCard({ rounds: 2, gap_hours: 24, done: 0, next_at: null, waiting: false }, at))
        .toEqual({ summary: "Second chance: 2 rounds, 24 h apart", progress: null });
      expect(describeFollowupCard({ rounds: 1, gap_hours: 4, done: 0, next_at: null, waiting: false }, at)?.summary)
        .toBe("Second chance: 1 round, 4 h apart");
      expect(describeFollowupCard({ rounds: 2, gap_hours: 24, done: 1, next_at: "2026-10-29T10:00:00Z", waiting: true }, at)?.progress)
        .toBe("Round 2 of 2 starts at 2026-10-29T10:00:00Z");
      expect(describeFollowupCard({ rounds: 2, gap_hours: 24, done: 0, next_at: "2026-10-29T10:00:00Z", waiting: true }, at)?.progress)
        .toBe("Round 1 of 2 starts at 2026-10-29T10:00:00Z");
      expect(describeFollowupCard({ rounds: 2, gap_hours: 24, done: 1, next_at: null, waiting: false }, at)?.progress).toBe("Round 1 of 2 done");
      expect(describeFollowupCard({ rounds: 2, gap_hours: 24, done: 2, next_at: null, waiting: false }, at)?.progress).toBe("Round 2 of 2 done");
    });
  });
});
