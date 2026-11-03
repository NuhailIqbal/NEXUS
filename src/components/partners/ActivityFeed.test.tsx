import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ActivityFeed from "./ActivityFeed";
import type { ActivityItem } from "@/lib/partners";

const item = (over: Partial<ActivityItem>): ActivityItem => ({
  id: "signup:1", kind: "signup", at: new Date().toISOString(), detail: null,
  user_id: "u1", email: "lead@x.test", partner_id: "p1", partner_name: "Acme", ...over,
});

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("ActivityFeed", () => {
  it("shows a loading state, then the items", async () => {
    const load = vi.fn().mockResolvedValue({ data: [item({}), item({ id: "call:1", kind: "call", detail: "Outbound call · Completed · 60s" })], error: null });
    render(<ActivityFeed load={load} />);
    expect(screen.getByText(/Loading/)).toBeTruthy();
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText("signed up")).toBeTruthy();
    expect(screen.getByText("Outbound call · Completed · 60s")).toBeTruthy();
    expect(screen.getByText("Live")).toBeTruthy();
  });

  it("shows the empty state when there is no activity", async () => {
    render(<ActivityFeed load={vi.fn().mockResolvedValue({ data: [], error: null })} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText(/Nothing yet/)).toBeTruthy();
  });

  it("polls again on the interval and shows new items without a reload", async () => {
    const load = vi.fn()
      .mockResolvedValueOnce({ data: [item({})], error: null })
      .mockResolvedValue({ data: [item({ id: "agent:9", kind: "agent", detail: "Sales Bot" }), item({})], error: null });
    render(<ActivityFeed load={load} intervalMs={5000} />);
    await act(async () => { await Promise.resolve(); });
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.getByText('created the agent "Sales Bot"')).toBeTruthy();
  });

  it("flags a connection problem, keeps the last good items, and recovers", async () => {
    const load = vi.fn()
      .mockResolvedValueOnce({ data: [item({})], error: null })
      .mockResolvedValueOnce({ data: null, error: "Network error" })
      .mockResolvedValue({ data: [item({})], error: null });
    render(<ActivityFeed load={load} intervalMs={1000} />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByText(/Connection problem/)).toBeTruthy();
    expect(screen.getByText("signed up")).toBeTruthy(); // the previous items stay on screen
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByText("Live")).toBeTruthy();
  });

  it("names the partner in the admin view only", async () => {
    const load = vi.fn().mockResolvedValue({ data: [item({})], error: null });
    const { rerender } = render(<ActivityFeed load={load} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText("Acme")).toBeNull();
    rerender(<ActivityFeed load={load} showPartner />);
    expect(screen.getByText("Acme")).toBeTruthy();
  });

  it("stops polling when it unmounts", async () => {
    const load = vi.fn().mockResolvedValue({ data: [], error: null });
    const { unmount } = render(<ActivityFeed load={load} intervalMs={1000} />);
    await act(async () => { await Promise.resolve(); });
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(load).toHaveBeenCalledTimes(1);
  });
});
