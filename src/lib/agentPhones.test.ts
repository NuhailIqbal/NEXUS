import { describe, expect, it } from "vitest";
import { NO_PHONE_TEXT, phoneText, phoneTitle } from "./agentPhones";

describe("phoneText", () => {
  it("says there is no number when none is connected", () => {
    expect(phoneText([])).toBe(NO_PHONE_TEXT);
    expect(phoneText(undefined)).toBe(NO_PHONE_TEXT);
    expect(phoneText(null)).toBe(NO_PHONE_TEXT);
    expect(phoneText([{ id: "1", number: "  " }])).toBe(NO_PHONE_TEXT);
  });
  it("lists every connected number on one line", () => {
    expect(phoneText([{ id: "1", number: "+15551230001" }])).toBe("+15551230001");
    expect(phoneText([{ id: "1", number: "+15551230001" }, { id: "2", number: "+15551230002", label: "Sales" }])).toBe("+15551230001, +15551230002");
  });
});

describe("phoneTitle", () => {
  it("adds the label to the hover text only when there is one", () => {
    expect(phoneTitle([{ id: "1", number: "+15551230001", label: "Sales" }, { id: "2", number: "+15551230002", label: " " }])).toBe("+15551230001 (Sales)\n+15551230002");
    expect(phoneTitle([])).toBe("");
  });
});
