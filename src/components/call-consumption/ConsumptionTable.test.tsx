import "@/test/radix-stubs";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { ConsumptionTable } from "./ConsumptionTable";
import type { TreeRow } from "@/lib/callConsumption";

const buckets = (over = {}) => ({ no_answer: 0, busy: 0, voicemail: 0, hung_up: 0, blocked: 0, failed: 0, ...over });
const row = (name: string, total: number, dropped: number, over: Partial<TreeRow> = {}): TreeRow => ({
  name, total_calls: total, consumed_calls: total - dropped, consumption_pct: total ? +(((total - dropped) / total) * 100).toFixed(2) : 0,
  dropped_calls: dropped, drop_pct: total ? +((dropped / total) * 100).toFixed(2) : 0, buckets: buckets({ failed: dropped }), dropped_cost: 0, ...over,
});

const day1 = row("2026-03-02", 10, 2);
const day2 = row("2026-03-03", 2, 1);
const week = row("Week of Mar 2", 12, 3, { children: [day1, day2] });
const month = row("March 2026", 12, 3, { children: [week] });
const total = row("Total", 12, 3);

describe("ConsumptionTable change columns", () => {
  const withChange = (name: string, calls: number | null, pts: number | null, partial = false): TreeRow =>
    ({ ...row(name, 10, 2), calls_change_pct: calls, drop_pct_point_change: pts, partial });

  it("adds Calls vs previous / Drop rate vs previous only when asked", () => {
    const { unmount } = render(<ConsumptionTable rows={[withChange("W1", 5, -1.5)]} />);
    expect(screen.queryByText("Calls vs previous")).toBeNull();
    unmount();
    render(<ConsumptionTable rows={[withChange("W1", 5, -1.5)]} showChange />);
    expect(screen.getByText("Calls vs previous")).toBeInTheDocument();
    expect(screen.getByText("Drop rate vs previous")).toBeInTheDocument();
  });

  it("colours changes by whether they are good news, and shows a dash when there is nothing to compare", () => {
    render(<ConsumptionTable rows={[withChange("up", 12.5, 3), withChange("down", -10, -3), withChange("first", null, null)]} showChange />);
    expect(screen.getByText("+12.5%").className).toContain("text-success");      // more calls: good
    expect(screen.getByText("-10.0%").className).toContain("text-destructive");  // fewer calls: bad
    expect(screen.getByText("+3.0 pts").className).toContain("text-destructive"); // drop rate up: bad
    expect(screen.getByText("-3.0 pts").className).toContain("text-success");    // drop rate down: good
    expect(screen.getAllByText("—")).toHaveLength(2);
  });

  it("flags a partial period", () => {
    render(<ConsumptionTable rows={[withChange("Mar 29 - Apr 4, 2026", 0, 0, true)]} showChange />);
    expect(screen.getByText("partial")).toBeInTheDocument();
  });
});

describe("ConsumptionTable", () => {
  it("lists a column per drop reason, in the documented order", () => {
    render(<ConsumptionTable rows={[month]} total={total} />);
    const heads = screen.getAllByRole("columnheader").map((h) => h.textContent?.trim());
    expect(heads).toEqual(["Name", "Total calls", "Consumed", "Consumption rate", "Dropped", "Drop rate",
      "No answer", "Busy", "Voicemail", "Hung up at once", "Blocked", "Failed"]);
  });

  it("starts collapsed, expands one level at a time, and collapses again", () => {
    render(<ConsumptionTable rows={[month]} total={total} firstColumn="Period" />);
    expect(screen.getByText("March 2026")).toBeInTheDocument();
    expect(screen.queryByText("Week of Mar 2")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Expand March 2026" }));
    expect(screen.getByText("Week of Mar 2")).toBeInTheDocument();
    expect(screen.queryByText("2026-03-02")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Expand Week of Mar 2" }));
    expect(screen.getByText("2026-03-02")).toBeInTheDocument();
    expect(screen.getByText("2026-03-03")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Collapse March 2026" }));
    expect(screen.queryByText("Week of Mar 2")).toBeNull();
  });

  it("opens the requested depth by default", () => {
    render(<ConsumptionTable rows={[month]} total={total} defaultExpandDepth={1} />);
    expect(screen.getByText("Week of Mar 2")).toBeInTheDocument();
    expect(screen.queryByText("2026-03-02")).toBeNull();
    expect(screen.getByRole("button", { name: "Collapse March 2026" })).toHaveAttribute("aria-expanded", "true");
  });

  it("shows the server's Total row as given, not a re-sum", () => {
    // A deliberately odd total proves the table doesn't recompute it from the rows.
    render(<ConsumptionTable rows={[month]} total={row("Total", 99, 33)} />);
    const t = within(screen.getByTestId("total-row"));
    expect(t.getByText("99")).toBeInTheDocument();
    expect(t.getAllByText("33").length).toBeGreaterThanOrEqual(1); // dropped, and the "failed" column
    expect(t.getByTestId("drop-rate")).toHaveTextContent("33.33%");
  });

  it("tints the drop rate by its value", () => {
    render(<ConsumptionTable rows={[row("a", 10, 0), row("b", 10, 10)]} />);
    const [low, high] = screen.getAllByTestId("drop-rate");
    expect(low.style.color).not.toBe(high.style.color);
  });

  it("shows the empty text and no table when there are no rows", () => {
    render(<ConsumptionTable rows={[]} total={null} />);
    expect(screen.getByText("No Data Found")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("only top-level rows are clickable, and the chevron doesn't trigger the row click", () => {
    const onRowClick = vi.fn();
    render(<ConsumptionTable rows={[{ ...month, key: "m1" }]} total={total} onRowClick={onRowClick} defaultExpandDepth={1} />);
    fireEvent.click(screen.getByText("Week of Mar 2"));
    expect(onRowClick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Collapse March 2026" }));
    expect(onRowClick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("March 2026"));
    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(onRowClick.mock.calls[0][0].key).toBe("m1");
  });
});
