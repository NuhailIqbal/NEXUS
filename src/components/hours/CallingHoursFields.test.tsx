import { choose, pick } from "@/test/pick";
import "@/test/radix-stubs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { CallingHoursFields } from "./CallingHoursFields";
import type { CallingHours } from "./callingHours";

const base: CallingHours = { enabled: false, timezone: "Asia/Karachi", days: [0, 1, 2, 3, 4], start: "09:00", end: "17:00" };

/** Holds the value the way a page would, and reports every change. */
function setup(initial: Partial<CallingHours> = {}, props: Partial<React.ComponentProps<typeof CallingHoursFields>> = {}) {
  const seen: CallingHours[] = [];
  function Harness() {
    const [v, setV] = useState<CallingHours>({ ...base, ...initial });
    return (
      <CallingHoursFields idPrefix="t" value={v} onChange={(n) => { seen.push(n); setV(n); }}
        switchLabel="Only call during set hours" description="Explain" startLabel="Calls start" endLabel="Calls stop" {...props} />
    );
  }
  render(<Harness />);
  return seen;
}
const sw = () => screen.getByRole("switch", { name: "Only call during set hours" });

/** Pins the time zone the browser reports, so the suggestion does not depend on the machine running the tests. */
const browserZone = (tz: string) =>
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({ timeZone: tz } as Intl.ResolvedDateTimeFormatOptions);
afterEach(() => vi.restoreAllMocks());

describe("CallingHoursFields: suggesting the user's own time zone", () => {
  const link = (name: RegExp | string = /Use my time zone/) => screen.queryByRole("button", { name });

  it("is offered, but nothing is pre-selected", () => {
    browserZone("Asia/Karachi");
    setup({ enabled: true, timezone: "" });
    expect(link()).toHaveTextContent("Use my time zone (Pakistan – PKT (Karachi))");
    expect(screen.getByLabelText("Timezone")).toHaveTextContent("Select time zone");
  });

  it("one click chooses it, and the suggestion goes away", () => {
    browserZone("Asia/Karachi");
    const seen = setup({ enabled: true, timezone: "" });
    fireEvent.click(link()!);
    expect(seen.at(-1)?.timezone).toBe("Asia/Karachi");
    expect(screen.getByLabelText("Timezone")).toHaveTextContent(/Pakistan/);
    expect(link()).not.toBeInTheDocument();
  });

  it("names a zone that is not in the common list by its region", () => {
    browserZone("Europe/Paris");
    setup({ enabled: true, timezone: "" });
    expect(link()).toHaveTextContent("Use my time zone (Europe/Paris)");
  });

  it("is not offered once a zone is chosen", () => {
    browserZone("Asia/Karachi");
    setup({ enabled: true, timezone: "Europe/London" });
    expect(link()).not.toBeInTheDocument();
  });

  it("is not offered while the hours are switched off (the fields are hidden)", () => {
    browserZone("Asia/Karachi");
    setup({ enabled: false, timezone: "" });
    expect(link()).not.toBeInTheDocument();
  });

  it("is not offered while the form is locked", () => {
    browserZone("Asia/Karachi");
    setup({ enabled: true, timezone: "" }, { disabled: true });
    expect(link()).not.toBeInTheDocument();
  });

  it("is not offered when the browser reports nothing usable", () => {
    browserZone("Mars/Olympus");
    setup({ enabled: true, timezone: "" });
    expect(link()).not.toBeInTheDocument();
  });
});

describe("CallingHoursFields", () => {
  it("off: shows the switch and explanation only", () => {
    setup();
    expect(sw()).not.toBeChecked();
    expect(screen.getByText("Explain")).toBeInTheDocument();
    expect(screen.queryByLabelText("Timezone")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Calls start")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mon" })).not.toBeInTheDocument();
  });

  it("switching on reveals the same pickers as the Callbacks settings, filled in", () => {
    const seen = setup();
    fireEvent.click(sw());
    expect(seen.at(-1)?.enabled).toBe(true);
    expect(screen.getByLabelText("Timezone")).toHaveTextContent(/Pakistan/);
    expect(screen.getByLabelText("Calls start")).toHaveTextContent("9:00 AM");
    expect(screen.getByLabelText("Calls stop")).toHaveTextContent("5:00 PM");
    for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri"]) expect(screen.getByRole("button", { name: d })).toHaveAttribute("aria-pressed", "true");
    for (const d of ["Sat", "Sun"]) expect(screen.getByRole("button", { name: d })).toHaveAttribute("aria-pressed", "false");
  });

  it("marks the time zone and the days as required (red asterisk, like the agent forms)", () => {
    setup({ enabled: true, timezone: "" });
    for (const name of ["Time Zone", "Days"]) {
      const star = screen.getByText(name).querySelector("span.text-destructive");
      expect(star, name).not.toBeNull();
      expect(star).toHaveTextContent("*");
    }
    // the times always have a value, so they carry no asterisk
    expect(screen.getByText("Calls start").querySelector("span.text-destructive")).toBeNull();
  });

  it("shows no required markers while the hours are off (the fields are hidden)", () => {
    setup({ enabled: false });
    expect(document.querySelector("span.text-destructive")).toBeNull();
  });

  it("with no time zone chosen it shows the Select time zone placeholder, not a default", () => {
    setup({ enabled: true, timezone: "" });
    expect(screen.getByLabelText("Timezone")).toHaveTextContent("Select time zone");
    expect(screen.getByLabelText("Timezone")).not.toHaveTextContent(/Pakistan|UTC/);
    expect(screen.getByText("Time Zone")).toBeInTheDocument();
  });

  it("the user chooses the time zone, and it is reported", async () => {
    const seen = setup({ enabled: true, timezone: "" });
    await pick("Timezone", "karachi");
    expect(seen.at(-1)?.timezone).toBe("Asia/Karachi");
    expect(screen.getByLabelText("Timezone")).toHaveTextContent(/Pakistan/);
  });

  it("days toggle on and off, kept in order", () => {
    const seen = setup({ enabled: true });
    fireEvent.click(screen.getByRole("button", { name: "Sat" }));
    expect(seen.at(-1)?.days).toEqual([0, 1, 2, 3, 4, 5]);
    fireEvent.click(screen.getByRole("button", { name: "Mon" }));
    expect(seen.at(-1)?.days).toEqual([1, 2, 3, 4, 5]);
  });

  it("start and end come from the 15-minute time picker", async () => {
    const seen = setup({ enabled: true });
    await choose("Calls start", "8:30 AM");
    expect(seen.at(-1)?.start).toBe("08:30");
    await choose("Calls stop", "6:15 PM");
    expect(seen.at(-1)?.end).toBe("18:15");
    expect(screen.getByLabelText("Calls stop")).toHaveTextContent("6:15 PM");
  }, 20000);   // the 96-slot lists render slowly in jsdom when the whole suite is running

  it("uses the labels it is given", () => {
    setup({ enabled: true }, { startLabel: "Answers from", endLabel: "Answers until" });
    expect(screen.getByLabelText("Answers from")).toBeInTheDocument();
    expect(screen.getByLabelText("Answers until")).toBeInTheDocument();
  });

  it("disabled locks everything", () => {
    setup({ enabled: true }, { disabled: true });
    expect(sw()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Mon" })).toBeDisabled();
    expect(screen.getByLabelText("Calls start")).toBeDisabled();
  });

  it("when the feature is unavailable it cannot be switched on and says why", () => {
    const seen = setup({}, { unavailableReason: "Not available yet." });
    expect(sw()).toBeDisabled();
    expect(screen.getByText("Not available yet.")).toBeInTheDocument();
    fireEvent.click(sw());
    expect(seen).toHaveLength(0);
  });

  it("when the feature is unavailable but already on, it can still be switched off", () => {
    const seen = setup({ enabled: true }, { unavailableReason: "Not available yet." });
    expect(sw()).not.toBeDisabled();
    expect(screen.queryByText("Not available yet.")).not.toBeInTheDocument();
    fireEvent.click(sw());
    expect(seen.at(-1)?.enabled).toBe(false);
  });

  it("ids are per form, so two forms on one page do not clash", () => {
    const { container } = render(
      <>
        <CallingHoursFields idPrefix="a" value={{ ...base, enabled: true }} onChange={vi.fn()} switchLabel="One" description="" startLabel="Start A" endLabel="End A" />
        <CallingHoursFields idPrefix="b" value={{ ...base, enabled: true }} onChange={vi.fn()} switchLabel="Two" description="" startLabel="Start B" endLabel="End B" />
      </>,
    );
    const ids = Array.from(container.querySelectorAll("[id]")).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
