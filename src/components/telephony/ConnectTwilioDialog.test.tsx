import "@/test/radix-stubs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/services/api", () => ({ api: { createTwilioCredential: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { toast } from "sonner";
import { api } from "@/services/api";
import { ConnectTwilioDialog } from "./ConnectTwilioDialog";

const createCred = api.createTwilioCredential as ReturnType<typeof vi.fn>;

function setup() {
  const onOpenChange = vi.fn();
  const onConnected = vi.fn();
  render(<ConnectTwilioDialog open onOpenChange={onOpenChange} onConnected={onConnected} />);
  return { onOpenChange, onConnected };
}

beforeEach(() => {
  vi.clearAllMocks();
  createCred.mockResolvedValue({ data: { id: "cred-1" }, error: null });
});

describe("ConnectTwilioDialog", () => {
  it("rejects submission with both fields empty", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      "Account SID and Auth Token are both required"
    ));
    expect(createCred).not.toHaveBeenCalled();
  });

  it("rejects submission with only Account SID filled", async () => {
    setup();
    fireEvent.change(screen.getByPlaceholderText(/ACxxxx/), { target: { value: "ACreal" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(createCred).not.toHaveBeenCalled();
  });

  it("submits trimmed values and reports success", async () => {
    const { onOpenChange, onConnected } = setup();
    fireEvent.change(screen.getByPlaceholderText(/ACxxxx/), { target: { value: "  ACreal123  " } });
    fireEvent.change(screen.getByPlaceholderText("Your Twilio Auth Token"), { target: { value: "  secrettoken  " } });
    fireEvent.change(screen.getByPlaceholderText(/My Twilio account/), { target: { value: "Main account" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(createCred).toHaveBeenCalledWith({
      account_sid: "ACreal123",
      auth_token: "secrettoken",
      label: "Main account",
    }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Twilio account connected"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConnected).toHaveBeenCalled();
  });

  it("omits an empty label rather than sending a blank string", async () => {
    setup();
    fireEvent.change(screen.getByPlaceholderText(/ACxxxx/), { target: { value: "ACreal" } });
    fireEvent.change(screen.getByPlaceholderText("Your Twilio Auth Token"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(createCred).toHaveBeenCalledWith(expect.objectContaining({ label: undefined })));
  });

  it("a backend rejection is surfaced and the dialog stays open", async () => {
    createCred.mockResolvedValue({ data: null, error: "Twilio rejected these credentials" });
    const { onOpenChange } = setup();
    fireEvent.change(screen.getByPlaceholderText(/ACxxxx/), { target: { value: "ACbad" } });
    fireEvent.change(screen.getByPlaceholderText("Your Twilio Auth Token"), { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Twilio rejected these credentials"));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("the Connect button shows a connecting state while the request is in flight", async () => {
    let resolve: (v: any) => void;
    createCred.mockReturnValue(new Promise((r) => { resolve = r; }));
    setup();
    fireEvent.change(screen.getByPlaceholderText(/ACxxxx/), { target: { value: "ACreal" } });
    fireEvent.change(screen.getByPlaceholderText("Your Twilio Auth Token"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Connecting/ })).toBeDisabled());
    resolve!({ data: { id: "cred-1" }, error: null });
  });

  it("Cancel closes without saving", () => {
    const { onOpenChange } = setup();
    fireEvent.change(screen.getByPlaceholderText(/ACxxxx/), { target: { value: "ACreal" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(createCred).not.toHaveBeenCalled();
  });

  it("the Auth Token is masked by default and can be revealed with the eye toggle", () => {
    setup();
    const tokenInput = screen.getByPlaceholderText("Your Twilio Auth Token");
    expect(tokenInput).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "Show secret" }));
    expect(tokenInput).toHaveAttribute("type", "text");
    fireEvent.click(screen.getByRole("button", { name: "Hide secret" }));
    expect(tokenInput).toHaveAttribute("type", "password");
  });

  it("the reveal state resets when the dialog is closed and reopened", () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(<ConnectTwilioDialog open onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Show secret" }));
    expect(screen.getByPlaceholderText("Your Twilio Auth Token")).toHaveAttribute("type", "text");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    rerender(<ConnectTwilioDialog open onOpenChange={onOpenChange} />);
    expect(screen.getByPlaceholderText("Your Twilio Auth Token")).toHaveAttribute("type", "password");
  });
});
