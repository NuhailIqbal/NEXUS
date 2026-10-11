import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";

vi.mock("@/services/api", () => ({ api: { getCallerVerificationLog: vi.fn() } }));

import { api } from "@/services/api";
import { CallerVerificationLog } from "./CallerVerificationLog";

const getLog = api.getCallerVerificationLog as ReturnType<typeof vi.fn>;
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const entry = (over: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(), phone_number_id: "n1", vapi_call_id: "c", caller_number: "+15551230001",
  decision: "answered", reason: "mobile_verified", line_type: "mobile", detail: null, created_at: minutesAgo(2), ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("CallerVerificationLog", () => {
  it("asks for this number's latest checks only", async () => {
    getLog.mockResolvedValue({ data: [], error: null });
    render(<CallerVerificationLog phoneNumberId="n1" />);
    await waitFor(() => expect(getLog).toHaveBeenCalledWith("phone_number_id=n1&limit=5"));
  });

  it("honours a different limit", async () => {
    getLog.mockResolvedValue({ data: [], error: null });
    render(<CallerVerificationLog phoneNumberId="n1" limit={12} />);
    await waitFor(() => expect(getLog).toHaveBeenCalledWith("phone_number_id=n1&limit=12"));
  });

  it("shows a loading state first", () => {
    getLog.mockReturnValue(new Promise(() => {}));
    render(<CallerVerificationLog phoneNumberId="n1" />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("says plainly when nothing has been checked yet", async () => {
    getLog.mockResolvedValue({ data: [], error: null });
    render(<CallerVerificationLog phoneNumberId="n1" />);
    expect(await screen.findByText("No calls have been checked yet.")).toBeInTheDocument();
  });

  it("lists who called, what happened and why", async () => {
    getLog.mockResolvedValue({
      data: [
        entry({ caller_number: "+15551230001" }),
        entry({ caller_number: "+15551230002", decision: "refused", reason: "not_mobile", line_type: "landline" }),
        entry({ caller_number: "+15551230003", decision: "refused", reason: "not_mobile", line_type: "voip" }),
        entry({ caller_number: "+15551230004", decision: "refused", reason: "invalid_number", line_type: null }),
        entry({ caller_number: null, decision: "answered", reason: "no_caller_number", line_type: null }),
        entry({ caller_number: "+15551230006", decision: "answered", reason: "lookup_unavailable", line_type: null }),
      ],
      error: null,
    });
    render(<CallerVerificationLog phoneNumberId="n1" />);
    expect(await screen.findByText("+15551230001")).toBeInTheDocument();
    expect(screen.getAllByText("Answered")).toHaveLength(3);
    expect(screen.getAllByText("Turned away")).toHaveLength(3);
    for (const text of ["Mobile number", "Landline number", "VoIP number", "Not a valid number", "No caller number", "Check unavailable"]) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
    expect(screen.getByText("No number")).toBeInTheDocument();
    expect(screen.getAllByText(/2 minutes ago/).length).toBeGreaterThan(0);
  });

  it("colours refusals differently from answers", async () => {
    getLog.mockResolvedValue({
      data: [entry(), entry({ decision: "refused", reason: "not_mobile", line_type: "voip" })], error: null,
    });
    render(<CallerVerificationLog phoneNumberId="n1" />);
    expect(await screen.findByText("Answered")).toHaveClass("text-success");
    expect(screen.getByText("Turned away")).toHaveClass("text-destructive");
  });

  it("copes with a bad timestamp", async () => {
    getLog.mockResolvedValue({ data: [entry({ created_at: "not a date" })], error: null });
    render(<CallerVerificationLog phoneNumberId="n1" />);
    expect(await screen.findByText("+15551230001")).toBeInTheDocument();
    expect(screen.queryByText(/ago/)).not.toBeInTheDocument();
  });

  it("says so when the list cannot be loaded", async () => {
    getLog.mockResolvedValue({ data: null, error: "Error 500" });
    render(<CallerVerificationLog phoneNumberId="n1" />);
    expect(await screen.findByText("Couldn't load recent checks.")).toBeInTheDocument();
  });

  it("treats a response that is not a list as a failure", async () => {
    getLog.mockResolvedValue({ data: { oops: true }, error: null });
    render(<CallerVerificationLog phoneNumberId="n1" />);
    expect(await screen.findByText("Couldn't load recent checks.")).toBeInTheDocument();
  });

  it("encodes the number id in the request", async () => {
    getLog.mockResolvedValue({ data: [], error: null });
    render(<CallerVerificationLog phoneNumberId="a b&c" />);
    await waitFor(() => expect(getLog).toHaveBeenCalledWith("phone_number_id=a%20b%26c&limit=5"));
  });

  it("loads again for another number and ignores a slow answer for the old one", async () => {
    let resolveOld: (v: unknown) => void = () => {};
    getLog.mockImplementation((q: string) =>
      q.includes("old")
        ? new Promise((res) => { resolveOld = res; })
        : Promise.resolve({ data: [entry({ caller_number: "+15559990000" })], error: null }),
    );
    const { rerender } = render(<CallerVerificationLog phoneNumberId="old" />);
    rerender(<CallerVerificationLog phoneNumberId="new" />);
    expect(await screen.findByText("+15559990000")).toBeInTheDocument();
    await act(async () => { resolveOld({ data: [entry({ caller_number: "+15550001111" })], error: null }); });
    expect(screen.queryByText("+15550001111")).not.toBeInTheDocument();
    expect(screen.getByText("+15559990000")).toBeInTheDocument();
  });

  it("does not update after it has been removed", async () => {
    let resolve: (v: unknown) => void = () => {};
    getLog.mockReturnValue(new Promise((res) => { resolve = res; }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { unmount } = render(<CallerVerificationLog phoneNumberId="n1" />);
    unmount();
    await act(async () => { resolve({ data: [entry()], error: null }); });
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
