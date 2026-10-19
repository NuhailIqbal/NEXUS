import "@/test/radix-stubs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/services/api", () => ({ api: { createTwilioCredential: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { toast } from "sonner";
import { api } from "@/services/api";
import { ConnectCarrierDialog } from "./ConnectCarrierDialog";

const createCred = api.createTwilioCredential as ReturnType<typeof vi.fn>;

function setup() {
  const onOpenChange = vi.fn();
  const onConnected = vi.fn();
  render(<ConnectCarrierDialog open onOpenChange={onOpenChange} onConnected={onConnected} />);
  return { onOpenChange, onConnected };
}

beforeEach(() => {
  vi.clearAllMocks();
  createCred.mockResolvedValue({ data: { id: "cred-1" }, error: null });
});

describe("ConnectCarrierDialog", () => {
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
      carrier: "twilio",
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
    const { rerender } = render(<ConnectCarrierDialog open onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Show secret" }));
    expect(screen.getByPlaceholderText("Your Twilio Auth Token")).toHaveAttribute("type", "text");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    rerender(<ConnectCarrierDialog open onOpenChange={onOpenChange} />);
    expect(screen.getByPlaceholderText("Your Twilio Auth Token")).toHaveAttribute("type", "password");
  });
});

describe("ConnectCarrierDialog — Vonage and Telnyx", () => {
  it("Vonage shows API Key + API Secret and submits carrier=vonage", async () => {
    const onConnected = vi.fn();
    render(<ConnectCarrierDialog open carrier="vonage" onOpenChange={vi.fn()} onConnected={onConnected} />);
    expect(screen.getAllByText("Connect your Vonage account").length).toBeGreaterThan(0);
    fireEvent.change(screen.getByPlaceholderText("Your Vonage API Key"), { target: { value: " key1 " } });
    const secret = screen.getByPlaceholderText("Your Vonage API Secret");
    expect(secret).toHaveAttribute("type", "password");
    fireEvent.change(secret, { target: { value: " sec1 " } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(createCred).toHaveBeenCalledWith({
      carrier: "vonage", account_sid: "key1", auth_token: "sec1", label: undefined,
    }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Vonage account connected"));
    expect(onConnected).toHaveBeenCalled();
  });

  it("Vonage with only the key filled is refused", async () => {
    render(<ConnectCarrierDialog open carrier="vonage" onOpenChange={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("Your Vonage API Key"), { target: { value: "key1" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("API Key and API Secret are both required"));
    expect(createCred).not.toHaveBeenCalled();
  });

  it("Telnyx has a single masked API Key field and no account id", async () => {
    render(<ConnectCarrierDialog open carrier="telnyx" onOpenChange={vi.fn()} />);
    expect(screen.queryByPlaceholderText(/Account SID|ACxxxx/)).not.toBeInTheDocument();
    const key = screen.getByPlaceholderText("KEYxxxxxxxxxxxxxxxx");
    expect(key).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("API Key is required"));
    fireEvent.change(key, { target: { value: "KEY123" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(createCred).toHaveBeenCalledWith({
      carrier: "telnyx", account_sid: undefined, auth_token: "KEY123", label: undefined,
    }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Telnyx account connected"));
  });
});
