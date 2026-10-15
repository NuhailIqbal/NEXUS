import "@/test/radix-stubs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

vi.mock("@/services/api", () => ({
  api: {
    getConversations: vi.fn(), getConversationStats: vi.fn(),
    getConversationTranscript: vi.fn(), getConversationRecordingUrl: vi.fn(), getConversationEvents: vi.fn(),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { api } from "@/services/api";
import InboundLogs from "./InboundLogs";
import OutboundLogs from "./OutboundLogs";
import Conversations from "../Conversations";

const fn = (f: unknown) => f as ReturnType<typeof vi.fn>;
const clean = (s: string | null) => (s ?? "").replace(/[\u202f\u00a0]/g, " ");

// 04:00 UTC on Oct 14: a different date and hour in every one of these zones.
const ISO = "2026-10-14T04:00:00Z";
const ROWS = [
  { id: "1", contact_name: "Alice LA", display_timezone: "America/Los_Angeles", expected: "Oct 13, 2026, 9:00 PM PDT" },
  { id: "2", contact_name: "Bob Kathmandu", display_timezone: "Asia/Kathmandu", expected: "Oct 14, 2026, 9:45 AM GMT+5:45" },
  { id: "3", contact_name: "Cara Kiritimati", display_timezone: "Pacific/Kiritimati", expected: "Oct 14, 2026, 6:00 PM GMT+14" },
  { id: "4", contact_name: "Dan Pago", display_timezone: "Pacific/Pago_Pago", expected: "Oct 13, 2026, 5:00 PM GMT-11" },
  { id: "5", contact_name: "Eve UTC", display_timezone: "UTC", expected: "Oct 14, 2026, 4:00 AM UTC" },
];
// A call with no chosen zone is shown in the viewer's own zone, still named.
const VIEWERS_OWN = clean(new Intl.DateTimeFormat("en-US", {
  year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
}).format(new Date(ISO)));

function conversation(r: { id: string; contact_name: string; display_timezone: string | null }, direction: string) {
  return {
    id: r.id, channel: "Phone", status: "Completed", duration: "1:05", duration_seconds: 65, call_time: ISO,
    phone: "+15550001111", contact_name: r.contact_name, agent_name: "Sara", direction, display_timezone: r.display_timezone,
    qualified: false, transferred_to: null, transcript: "hi", transcript_messages: [{ role: "assistant", text: "hi", time: 0 }],
    recording_url: null, stereo_recording_url: null, ai_summary: null, call_outcome: null,
  };
}

function mock(rows: object[], events: object[] = []) {
  fn(api.getConversations).mockResolvedValue({ data: rows, error: null, meta: { count: rows.length } });
  fn(api.getConversationStats).mockResolvedValue({ data: { total: rows.length, completed: rows.length, failed: 0, total_duration_seconds: 65 }, error: null });
  fn(api.getConversationTranscript).mockResolvedValue({ data: { transcript: "hi", transcript_messages: [], ai_summary: null }, error: null });
  fn(api.getConversationRecordingUrl).mockResolvedValue({ data: { url: null }, error: null });
  fn(api.getConversationEvents).mockResolvedValue({ data: events, error: null });
}
const rowOf = (name: string) => screen.getByText(name).closest("tr") as HTMLElement;

beforeEach(() => vi.clearAllMocks());

describe.each([
  ["Inbound call log", InboundLogs, "inbound"],
  ["Outbound call log", OutboundLogs, "outbound"],
  ["All Conversations", Conversations, "inbound"],
] as const)("%s shows every call time in the zone chosen for that call", (_label, Page, direction) => {
  it("each row is in its own zone, with the zone's name", async () => {
    mock(ROWS.map((r) => conversation(r, direction)));
    render(<Page />);
    for (const r of ROWS) {
      await screen.findByText(r.contact_name);
      expect(clean(rowOf(r.contact_name).textContent), r.display_timezone).toContain(r.expected);
    }
  });

  it("a call with no chosen zone is shown in the viewer's own zone, with its name", async () => {
    mock([conversation({ id: "9", contact_name: "Nobody Chose", display_timezone: null }, direction)]);
    render(<Page />);
    await screen.findByText("Nobody Chose");
    expect(clean(rowOf("Nobody Chose").textContent)).toContain(VIEWERS_OWN);
  });

  it("one page can mix zones without any row borrowing another's", async () => {
    mock([
      conversation(ROWS[0], direction), conversation(ROWS[1], direction),
      conversation({ id: "9", contact_name: "Nobody Chose", display_timezone: null }, direction),
    ]);
    render(<Page />);
    await screen.findByText("Alice LA");
    expect(clean(rowOf("Alice LA").textContent)).toContain("PDT");
    expect(clean(rowOf("Alice LA").textContent)).not.toContain("GMT+5:45");
    expect(clean(rowOf("Bob Kathmandu").textContent)).toContain("GMT+5:45");
    expect(clean(rowOf("Bob Kathmandu").textContent)).not.toContain("PDT");
  });

  it("the call's details dialog shows the same moment in the same zone", async () => {
    mock([conversation(ROWS[1], direction)]);
    render(<Page />);
    await screen.findByText("Bob Kathmandu");
    fireEvent.click(within(rowOf("Bob Kathmandu")).getByRole("button", { name: /view/i }));
    const dialog = await screen.findByRole("dialog");
    expect(clean(dialog.textContent)).toContain("Oct 14, 2026, 9:45 AM GMT+5:45");
  });
});

describe("All Conversations: the events inside a call use the call's zone too", () => {
  it("shows each event's time of day in the zone chosen for the call", async () => {
    mock([conversation(ROWS[0], "inbound")], [
      { id: "e1", label: "Callback Requested", event_key: "callback", outcome: null, note: null, created_at: "2026-10-14T04:00:07Z" },
    ]);
    render(<Conversations />);
    await screen.findByText("Alice LA");
    fireEvent.click(within(rowOf("Alice LA")).getByRole("button", { name: /view/i }));
    await screen.findByText("Callback Requested");
    expect(clean(screen.getByRole("dialog").textContent)).toContain("9:00:07 PM PDT");
  });
});
