import { describe, expect, it } from "vitest";
import { callTimeoutError, callTimeoutMinutes, callTimeoutText, DEFAULT_CALL_TIMEOUT_TEXT } from "./callTimeout";

describe("callTimeoutError", () => {
  it("accepts whole minutes from 1 to 60 and a blank (the default)", () => {
    for (const ok of ["1", "10", "60", " 7 ", ""]) expect(callTimeoutError(ok)).toBeNull();
  });
  it("rejects zero, anything above an hour, decimals and non-numbers", () => {
    for (const bad of ["0", "61", "500", "-5", "2.5", "ten", "1e2", "5 min"]) expect(callTimeoutError(bad)).not.toBeNull();
  });
  it("names the allowed range", () => {
    expect(callTimeoutError("61")).toMatch(/between 1 and 60/);
  });
});

describe("callTimeoutMinutes and callTimeoutText", () => {
  it("sends the typed number, or the default when blank", () => {
    expect(callTimeoutMinutes("25")).toBe(25);
    expect(callTimeoutMinutes(" 3 ")).toBe(3);
    expect(callTimeoutMinutes("")).toBe(10);
  });
  it("shows the default for an agent that has no stored value", () => {
    expect(callTimeoutText(null)).toBe(DEFAULT_CALL_TIMEOUT_TEXT);
    expect(callTimeoutText(undefined)).toBe("10");
    expect(callTimeoutText(30)).toBe("30");
  });
});
