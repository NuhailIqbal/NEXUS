import { describe, expect, it } from "vitest";
import { MAX_VALUE, changeText, leadsSub, moneyOrDash, parseValueInput, roiOrDash, valueText } from "./leadRoi";

describe("moneyOrDash", () => {
  it("formats dollars with two decimals and thousands separators", () => {
    expect(moneyOrDash(1.6667)).toBe("$1.67");
    expect(moneyOrDash(0)).toBe("$0.00");
    expect(moneyOrDash(1234.5)).toBe("$1,234.50");
  });
  it("puts the minus sign before the dollar sign", () => {
    expect(moneyOrDash(-6)).toBe("-$6.00");
  });
  it("shows a dash, never $0.00, when the figure is not available", () => {
    expect(moneyOrDash(null)).toBe("—");
    expect(moneyOrDash(undefined)).toBe("—");
  });
});

describe("roiOrDash", () => {
  it("shows whole percents and keeps the sign of a loss", () => {
    expect(roiOrDash(4300)).toBe("4,300%");
    expect(roiOrDash(-60.4)).toBe("-60%");
    expect(roiOrDash(0)).toBe("0%");
  });
  it("shows a dash when there is no ROI", () => {
    expect(roiOrDash(null)).toBe("—");
  });
});

describe("changeText", () => {
  it("signs the change", () => {
    expect(changeText(12.55)).toBe("+12.6%");
    expect(changeText(-16.7)).toBe("-16.7%");
    expect(changeText(0)).toBe("0.0%");
    expect(changeText(-1000, " pts")).toBe("-1000.0 pts");
  });
  it("is null when there is nothing to compare", () => {
    expect(changeText(null)).toBeNull();
    expect(changeText(undefined)).toBeNull();
  });
});

describe("parseValueInput", () => {
  const p = (t: string) => parseValueInput(t, "Value");
  it("treats blank as not set", () => {
    expect(p("")).toEqual({ value: null, error: null });
    expect(p("   ")).toEqual({ value: null, error: null });
  });
  it("accepts plain numbers, a leading $ and thousands commas", () => {
    expect(p("50")).toEqual({ value: 50, error: null });
    expect(p("$12.50")).toEqual({ value: 12.5, error: null });
    expect(p("1,250")).toEqual({ value: 1250, error: null });
    expect(p(".5")).toEqual({ value: 0.5, error: null });
    expect(p("0")).toEqual({ value: 0, error: null });
  });
  it("rounds to cents", () => {
    expect(p("12.345").value).toBe(12.35);
  });
  it("refuses text, negatives and anything over the limit, naming the field", () => {
    for (const bad of ["abc", "-5", "1e3", "5.5.5", "12abc"]) expect(p(bad).error).toBe("Value must be a number, like 50 or 12.50.");
    expect(p(String(MAX_VALUE + 1)).error).toContain("at most");
    expect(p(String(MAX_VALUE)).error).toBeNull();
  });
});

describe("small helpers", () => {
  it("shows a stored value as input text", () => {
    expect(valueText(null)).toBe("");
    expect(valueText(12.5)).toBe("12.5");
    expect(valueText(0)).toBe("0");
  });
  it("says how many leads were qualified", () => {
    expect(leadsSub({ leads: 6, qualified_leads: 4 })).toBe("4 qualified");
  });
});
