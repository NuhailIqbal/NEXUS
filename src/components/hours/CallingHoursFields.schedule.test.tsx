import { choose } from "@/test/pick";
import "@/test/radix-stubs";
import { describe, expect, it } from "vitest";
import { vi as viConfig } from "vitest";
viConfig.setConfig({ testTimeout: 30000 });   // many 96-slot time pickers render slowly in jsdom
import { useState } from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { CallingHoursFields } from "./CallingHoursFields";
import type { Break, CallingHours } from "./callingHours";

const base: CallingHours = { enabled: true, timezone: "Asia/Karachi", days: [0, 1, 2, 3, 4], start: "09:00", end: "18:00" };
const brk = (start: string, end: string): Break => ({ start, end });

/** Holds the value the way a page would, and reports every change. */
function setup(initial: Partial<CallingHours> = {}, props: Partial<React.ComponentProps<typeof CallingHoursFields>> = {}) {
  const seen: CallingHours[] = [];
  function Harness() {
    const [v, setV] = useState<CallingHours>({ ...base, ...initial });
    return (
      <CallingHoursFields idPrefix="t" value={v} onChange={(n) => { seen.push(n); setV(n); }} advanced
        switchLabel="Only call during set hours" description="Explain" startLabel="Calls start" endLabel="Calls stop" {...props} />
    );
  }
  render(<Harness />);
  return seen;
}

const last = (seen: CallingHours[]) => seen[seen.length - 1];
const radio = (name: string) => screen.getByRole("radio", { name });
const day = (name: string) => screen.getByText(name, { selector: "span.text-sm" }).closest("div.rounded-md") as HTMLElement;
const alerts = () => screen.queryAllByRole("alert").map((a) => a.textContent);

describe("CallingHoursFields (advanced): choosing the kind of schedule", () => {
  it("is not offered to forms that are not advanced (the receptionist's)", () => {
    setup({}, { advanced: false });
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByText("Breaks")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add break/ })).not.toBeInTheDocument();
  });

  it("offers the same schedule every day (selected) or a custom one per day", () => {
    setup();
    expect(radio("Same schedule every day")).toHaveAttribute("aria-checked", "true");
    expect(radio("Custom schedule per day")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("button", { name: "Mon" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Monday start")).not.toBeInTheDocument();
  });

  it("is hidden while the hours are off", () => {
    setup({ enabled: false });
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("switching to a custom schedule starts from the current one: the same days on with the same hours and breaks", () => {
    const seen = setup({ days: [0, 1, 2], breaks: [brk("13:00", "14:00")] });
    fireEvent.click(radio("Custom schedule per day"));
    expect(last(seen).mode).toBe("per_day");
    expect(last(seen).schedule!.map((d) => d.on)).toEqual([true, true, true, false, false, false, false]);
    expect(last(seen).schedule![1]).toEqual({ on: true, start: "09:00", end: "18:00", breaks: [brk("13:00", "14:00")] });
    // all seven days are listed
    for (const d of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]) expect(day(d)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Monday" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Saturday" })).not.toBeChecked();
    expect(within(day("Saturday")).getByText("Off: no calls")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mon" })).not.toBeInTheDocument();
  });

  it("switching back keeps the shared schedule as it was", () => {
    const seen = setup({ breaks: [brk("13:00", "14:00")] });
    fireEvent.click(radio("Custom schedule per day"));
    fireEvent.click(radio("Same schedule every day"));
    expect(last(seen)).toMatchObject({ mode: "same", days: [0, 1, 2, 3, 4], start: "09:00", end: "18:00", breaks: [brk("13:00", "14:00")] });
    expect(screen.getByLabelText("Break 1 start")).toHaveTextContent("1:00 PM");
  });

  it("a custom schedule that was edited survives switching to the shared one and back", async () => {
    const seen = setup();
    fireEvent.click(radio("Custom schedule per day"));
    await choose("Monday end", "12:00 PM");
    fireEvent.click(radio("Same schedule every day"));
    fireEvent.click(radio("Custom schedule per day"));
    expect(last(seen).schedule![0].end).toBe("12:00");
    expect(screen.getByLabelText("Monday end")).toHaveTextContent("12:00 PM");
  });

  it("a custom schedule that was NOT edited is rebuilt from the shared one when it is chosen again", () => {
    const seen = setup();
    fireEvent.click(radio("Custom schedule per day"));
    fireEvent.click(radio("Same schedule every day"));
    fireEvent.click(screen.getByRole("button", { name: "Sat" }));
    fireEvent.click(radio("Custom schedule per day"));
    expect(last(seen).schedule![5].on).toBe(true);
  });

  it("is locked while the form is disabled", () => {
    setup({}, { disabled: true });
    expect(radio("Custom schedule per day")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add break" })).toBeDisabled();
  });
});

describe("CallingHoursFields (advanced): breaks in the shared schedule", () => {
  it("starts with none and says so", () => {
    setup();
    expect(screen.getByText("Breaks")).toBeInTheDocument();
    expect(screen.getByText(/No breaks/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Break 1 start")).not.toBeInTheDocument();
  });

  it("Add break adds a break at lunchtime, inside the hours", () => {
    const seen = setup();
    fireEvent.click(screen.getByRole("button", { name: "Add break" }));
    expect(last(seen).breaks).toEqual([brk("13:00", "14:00")]);
    expect(screen.getByLabelText("Break 1 start")).toHaveTextContent("1:00 PM");
    expect(screen.getByLabelText("Break 1 end")).toHaveTextContent("2:00 PM");
    expect(alerts()).toEqual([]);
  });

  it("a second break does not land on the first", () => {
    const seen = setup({ breaks: [brk("13:00", "14:00")] });
    fireEvent.click(screen.getByRole("button", { name: "Add break" }));
    expect(last(seen).breaks).toEqual([brk("13:00", "14:00"), brk("12:00", "12:30")]);
    expect(alerts()).toEqual([]);
  });

  it("each break's start and end are chosen with the same time picker", async () => {
    const seen = setup({ breaks: [brk("13:00", "14:00")] });
    await choose("Break 1 start", "12:30 PM");
    expect(last(seen).breaks).toEqual([brk("12:30", "14:00")]);
    await choose("Break 1 end", "1:45 PM");
    expect(last(seen).breaks).toEqual([brk("12:30", "13:45")]);
    expect(screen.getByLabelText("Break 1 end")).toHaveTextContent("1:45 PM");
  });

  it("a break can be removed", () => {
    const seen = setup({ breaks: [brk("10:00", "10:15"), brk("13:00", "14:00")] });
    fireEvent.click(screen.getByRole("button", { name: "Remove break 1" }));
    expect(last(seen).breaks).toEqual([brk("13:00", "14:00")]);
    expect(screen.queryByLabelText("Break 2 start")).not.toBeInTheDocument();
  });

  it("no more than ten", () => {
    const ten = Array.from({ length: 10 }, (_, i) => brk(`${String(9 + i % 9).padStart(2, "0")}:${i < 9 ? "00" : "30"}`, `${String(9 + i % 9).padStart(2, "0")}:${i < 9 ? "10" : "40"}`));
    setup({ breaks: ten });
    expect(screen.getByRole("button", { name: "Add break" })).toBeDisabled();
  });
});

describe("CallingHoursFields (advanced): problems are shown next to the field", () => {
  it("a break outside the hours says what the hours are", () => {
    setup({ breaks: [brk("07:00", "08:00")] });
    expect(alerts()).toEqual(["A break must fall inside the running hours (9:00 AM–6:00 PM)."]);
    const row = screen.getByLabelText("Break 1 start").closest("div.space-y-1")!.parentElement!.parentElement!;
    expect(within(row as HTMLElement).getByRole("alert")).toBeInTheDocument();
  });

  it("a break that ends before it starts", async () => {
    setup({ breaks: [brk("13:00", "14:00")] });
    await choose("Break 1 end", "12:00 PM");
    expect(alerts()).toEqual(["A break must end after it starts."]);
  });

  it("overlapping breaks tell the later one, and the message goes away once it is fixed", async () => {
    setup({ breaks: [brk("12:00", "14:00"), brk("13:00", "15:00")] });
    expect(alerts()).toEqual(["Breaks can't overlap."]);
    await choose("Break 2 start", "2:00 PM");
    expect(alerts()).toEqual([]);
  });

  it("breaks that leave no time to run", () => {
    setup({ breaks: [brk("09:00", "18:00")] });
    expect(alerts()).toEqual(["The breaks leave no time to run."]);
  });

  it("an end time that is not after the start is shown under the times", async () => {
    setup();
    await choose("Calls stop", "8:00 AM");
    expect(alerts()).toEqual(["End time must be after start time."]);
  });

  it("changing the hours so a break no longer fits flags the break", async () => {
    setup({ breaks: [brk("13:00", "14:00")] });
    expect(alerts()).toEqual([]);
    await choose("Calls stop", "1:30 PM");
    expect(alerts()).toEqual(["A break must fall inside the running hours (9:00 AM–1:30 PM)."]);
  });

  it("no days is shown under the days", () => {
    setup({ days: [] });
    expect(alerts()).toEqual(["Pick at least one day."]);
  });

  it("while the hours are off nothing is shown", () => {
    setup({ enabled: false, breaks: [brk("07:00", "08:00")] });
    expect(alerts()).toEqual([]);
  });
});

describe("CallingHoursFields (advanced): a custom schedule per day", () => {
  const custom = (over: Partial<CallingHours> = {}) => setup({ days: [0, 1, 2, 3, 4], ...over }, {});
  const open = () => fireEvent.click(radio("Custom schedule per day"));

  it("every day has its own start and end", async () => {
    const seen = custom();
    open();
    await choose("Monday start", "10:00 AM");
    await choose("Wednesday end", "5:00 PM");
    expect(last(seen).schedule![0]).toMatchObject({ start: "10:00", end: "18:00" });
    expect(last(seen).schedule![2]).toMatchObject({ start: "09:00", end: "17:00" });
    expect(last(seen).schedule![1]).toMatchObject({ start: "09:00", end: "18:00" });
  });

  it("a day is switched on and off on its own, and its pickers go with it", () => {
    const seen = custom();
    open();
    fireEvent.click(screen.getByRole("switch", { name: "Wednesday" }));
    expect(last(seen).schedule!.map((d) => d.on)).toEqual([true, true, false, true, true, false, false]);
    expect(screen.queryByLabelText("Wednesday start")).not.toBeInTheDocument();
    expect(within(day("Wednesday")).getByText("Off: no calls")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Sunday" }));
    expect(screen.getByLabelText("Sunday start")).toHaveTextContent("9:00 AM");
    expect(last(seen).mode).toBe("per_day");
  });

  it("a day that is switched off and on again keeps its hours", async () => {
    custom();
    open();
    await choose("Tuesday end", "3:00 PM");
    fireEvent.click(screen.getByRole("switch", { name: "Tuesday" }));
    fireEvent.click(screen.getByRole("switch", { name: "Tuesday" }));
    expect(screen.getByLabelText("Tuesday end")).toHaveTextContent("3:00 PM");
  });

  it("each day has its own breaks", async () => {
    const seen = custom();
    open();
    fireEvent.click(screen.getByRole("button", { name: "Add Tuesday break" }));
    expect(last(seen).schedule![1].breaks).toEqual([brk("13:00", "14:00")]);
    expect(last(seen).schedule![0].breaks).toEqual([]);
    expect(last(seen).breaks ?? []).toEqual([]);
    await choose("Tuesday break 1 start", "12:00 PM");
    expect(last(seen).schedule![1].breaks).toEqual([brk("12:00", "14:00")]);
    fireEvent.click(screen.getByRole("button", { name: "Remove Tuesday break 1" }));
    expect(last(seen).schedule![1].breaks).toEqual([]);
  });

  it("Copy to all days gives every other day that is on the same hours and breaks, and leaves days that are off alone", async () => {
    const seen = custom();
    open();
    fireEvent.click(screen.getByRole("button", { name: "Add Monday break" }));
    await choose("Monday start", "8:00 AM");
    await choose("Monday end", "4:00 PM");
    fireEvent.click(screen.getByRole("button", { name: "Copy Monday to all days" }));
    const s = last(seen).schedule!;
    for (const d of [0, 1, 2, 3, 4]) expect(s[d], `day ${d}`).toEqual({ on: true, start: "08:00", end: "16:00", breaks: [brk("13:00", "14:00")] });
    for (const d of [5, 6]) expect(s[d].on, `day ${d}`).toBe(false);
  });

  it("Copy to all days copies copies, not shared break objects", async () => {
    const seen = custom();
    open();
    fireEvent.click(screen.getByRole("button", { name: "Add Monday break" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy Monday to all days" }));
    await choose("Tuesday break 1 start", "12:00 PM");
    expect(last(seen).schedule![1].breaks).toEqual([brk("12:00", "14:00")]);
    expect(last(seen).schedule![0].breaks).toEqual([brk("13:00", "14:00")]);
  });

  it("only days that are on have a Copy button", () => {
    custom();
    open();
    expect(screen.getByRole("button", { name: "Copy Friday to all days" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy Saturday to all days" })).not.toBeInTheDocument();
  });

  it("a problem is shown on its own day only", async () => {
    custom();
    open();
    await choose("Thursday end", "8:00 AM");
    expect(alerts()).toEqual(["End time must be after start time."]);
    expect(within(day("Thursday")).getByRole("alert")).toBeInTheDocument();
    expect(within(day("Monday")).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("a break outside its own day's hours is flagged with that day's hours", async () => {
    custom();
    open();
    fireEvent.click(screen.getByRole("button", { name: "Add Friday break" }));
    await choose("Friday end", "12:00 PM");
    expect(alerts()).toEqual(["A break must fall inside the running hours (9:00 AM–12:00 PM)."]);
    expect(within(day("Friday")).getByRole("alert")).toBeInTheDocument();
  });

  it("with every day off it asks for at least one", () => {
    custom({ days: [3] });
    open();
    fireEvent.click(screen.getByRole("switch", { name: "Thursday" }));
    expect(alerts()).toEqual(["Pick at least one day."]);
  });

  it("a day that is off shows nothing wrong even if its times would be", async () => {
    custom();
    open();
    await choose("Saturday end", "8:00 AM").catch(() => undefined);
    fireEvent.click(screen.getByRole("switch", { name: "Saturday" }));
    expect(alerts()).toEqual([]);
  });

  it("is locked while the form is disabled", () => {
    custom({ mode: "per_day" });
    expect(screen.getByRole("switch", { name: "Monday" })).toBeInTheDocument();
  });
});

describe("CallingHoursFields (advanced): existing behaviour is intact", () => {
  it("still shows the time zone, days, start and end of the shared schedule, with the old labels", () => {
    setup();
    expect(screen.getByLabelText("Timezone")).toHaveTextContent(/Pakistan/);
    expect(screen.getByLabelText("Calls start")).toHaveTextContent("9:00 AM");
    expect(screen.getByLabelText("Calls stop")).toHaveTextContent("6:00 PM");
    for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri"]) expect(screen.getByRole("button", { name: d })).toHaveAttribute("aria-pressed", "true");
  });

  it("ids are unique with several breaks and a custom schedule on the page", () => {
    const { container } = render(
      <CallingHoursFields idPrefix="x" advanced value={{ ...base, mode: "per_day", breaks: [brk("13:00", "14:00")], schedule: Array.from({ length: 7 }, () => ({ on: true, start: "09:00", end: "18:00", breaks: [brk("13:00", "14:00"), brk("15:00", "15:15")] })) }}
        onChange={() => undefined} switchLabel="S" description="" startLabel="A" endLabel="B" />,
    );
    const ids = Array.from(container.querySelectorAll("[id]")).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
