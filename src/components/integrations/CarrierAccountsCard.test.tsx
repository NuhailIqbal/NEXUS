import "@/test/radix-stubs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/services/api", () => ({
  api: { getTwilioCredentials: vi.fn(), deleteTwilioCredential: vi.fn(), updateTwilioCredential: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { toast } from "sonner";
import { api } from "@/services/api";
import { CarrierAccountsCard } from "./CarrierAccountsCard";

const getCreds = api.getTwilioCredentials as ReturnType<typeof vi.fn>;
const deleteCred = api.deleteTwilioCredential as ReturnType<typeof vi.fn>;
const updateCred = api.updateTwilioCredential as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  getCreds.mockResolvedValue({ data: [], error: null });
  deleteCred.mockResolvedValue({ data: null, error: null });
  updateCred.mockResolvedValue({ data: { id: "cred-1" }, error: null });
});

describe("CarrierAccountsCard", () => {
  it("shows nothing when nothing is connected (first connection happens via Add Integration)", async () => {
    const { container } = render(<CarrierAccountsCard />);
    await waitFor(() => expect(getCreds).toHaveBeenCalled());
    expect(container.querySelector("section")).toBeNull();
    expect(screen.queryByText("Twilio")).not.toBeInTheDocument();
  });

  it("lists connected accounts with a masked token", async () => {
    getCreds.mockResolvedValue({
      data: [{ id: "cred-1", account_sid: "ACabc123", label: "Main account", auth_token_masked: "se****en" }],
      error: null,
    });
    render(<CarrierAccountsCard />);
    expect(await screen.findByText("Main account")).toBeInTheDocument();
    expect(screen.getByText(/ACabc123/)).toBeInTheDocument();
    expect(screen.getByText(/se\*\*\*\*en/)).toBeInTheDocument();
  });

  it("falls back to the account SID as the title when there's no label", async () => {
    getCreds.mockResolvedValue({
      data: [{ id: "cred-1", account_sid: "ACabc123" }], // no label, no auth_token_masked
      error: null,
    });
    const { container } = render(<CarrierAccountsCard />);
    await waitFor(() => expect(getCreds).toHaveBeenCalled());
    const title = container.querySelector(".font-medium.text-foreground");
    expect(title).toHaveTextContent("ACabc123");
    // no masked-token suffix should be appended when it's missing
    expect(container.textContent).not.toMatch(/·/);
  });

  it("without a label, the subtitle shows only the masked token — the SID isn't repeated from the title", async () => {
    getCreds.mockResolvedValue({
      data: [{ id: "cred-1", account_sid: "ACabc123", auth_token_masked: "se****en" }],
      error: null,
    });
    const { container } = render(<CarrierAccountsCard />);
    const title = await screen.findByText("ACabc123");
    expect(title).toHaveClass("font-medium");
    const subtitle = container.querySelector(".text-xs.text-muted-foreground");
    expect(subtitle).toHaveTextContent("se****en");
    expect(subtitle?.textContent).not.toMatch(/ACabc123/); // not repeated
  });

  it("has no connect button — adding a new account happens via Add Integration", async () => {
    getCreds.mockResolvedValue({
      data: [{ id: "cred-1", account_sid: "ACabc123", label: "Main account" }],
      error: null,
    });
    render(<CarrierAccountsCard />);
    await screen.findByText("Main account");
    expect(screen.queryByRole("button", { name: /Connect/ })).not.toBeInTheDocument();
  });

  it("Edit opens the edit dialog prefilled, and saving reloads the list", async () => {
    getCreds.mockResolvedValueOnce({
      data: [{ id: "cred-1", account_sid: "ACabc123", label: "Main account" }],
      error: null,
    }).mockResolvedValue({
      data: [{ id: "cred-1", account_sid: "ACabc123", label: "Renamed" }],
      error: null,
    });
    render(<CarrierAccountsCard />);
    await screen.findByText("Main account");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    // "Edit Twilio account" appears twice (a visually-hidden DialogTitle for a11y,
    // plus the visible styled header) — same pattern as ConnectTwilioDialog.
    expect((await screen.findAllByText("Edit Twilio account")).length).toBeGreaterThan(0);
    expect(screen.getByDisplayValue("Main account")).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue("Main account"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(updateCred).toHaveBeenCalledWith("cred-1", { label: "Renamed" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Twilio account updated"));
    await waitFor(() => expect(getCreds).toHaveBeenCalledTimes(2)); // reloaded after save
  });

  it("a load failure is reported via toast", async () => {
    getCreds.mockResolvedValue({ data: null, error: "Network error" });
    render(<CarrierAccountsCard />);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Network error"));
  });

  it("removing an account asks for confirmation, then deletes and reloads", async () => {
    getCreds.mockResolvedValueOnce({
      data: [{ id: "cred-1", account_sid: "ACabc123", label: "Main account" }],
      error: null,
    }).mockResolvedValue({ data: [], error: null });
    render(<CarrierAccountsCard />);
    await screen.findByText("Main account");

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(await screen.findByText(/Remove this Twilio account/)).toBeInTheDocument();

    // Two "Remove" buttons are now on screen: the row's icon button and the confirm
    // dialog's action button — the action button is the one added last.
    const removeButtons = screen.getAllByRole("button", { name: /Remove/ });
    fireEvent.click(removeButtons[removeButtons.length - 1]);
    await waitFor(() => expect(deleteCred).toHaveBeenCalledWith("cred-1"));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Twilio account removed"));
  });

  it("a blocked deletion (credential still in use) surfaces the backend's message", async () => {
    getCreds.mockResolvedValue({
      data: [{ id: "cred-1", account_sid: "ACabc123", label: "Main account" }],
      error: null,
    });
    deleteCred.mockResolvedValue({ data: null, error: "This Twilio account is still used by 1 phone number (+15551234567). Remove them first." });
    render(<CarrierAccountsCard />);
    await screen.findByText("Main account");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await screen.findByText(/Remove this Twilio account/);
    fireEvent.click(screen.getAllByRole("button", { name: /Remove/ }).slice(-1)[0]);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining("still used by 1 phone number")
    ));
  });
});

describe("CarrierAccountsCard — several carriers", () => {
  const rows = [
    { id: "t1", carrier: "twilio", account_sid: "ACabc123", label: "Twilio main", auth_token_masked: "tw****en" },
    { id: "v1", carrier: "vonage", account_sid: "vkey01", label: "Vonage main", auth_token_masked: "vo****et" },
    { id: "n1", carrier: "telnyx", account_sid: null, label: null, auth_token_masked: "KE****34" },
  ];

  it("shows one tile per connected carrier, each with its own accounts", async () => {
    getCreds.mockResolvedValue({ data: rows, error: null });
    render(<CarrierAccountsCard />);
    expect(await screen.findByText("Twilio main")).toBeInTheDocument();
    expect(screen.getByText("Vonage main")).toBeInTheDocument();
    expect(screen.getByText("vkey01 · vo****et")).toBeInTheDocument();
    // Telnyx has neither a label nor an identifier: falls back to a generic title + masked key
    expect(screen.getByText("Telnyx account")).toBeInTheDocument();
    expect(screen.getByText("KE****34")).toBeInTheDocument();
  });

  it("a carrier with no accounts gets no tile", async () => {
    getCreds.mockResolvedValue({ data: [rows[1]], error: null });
    const { container } = render(<CarrierAccountsCard />);
    await screen.findByText("Vonage main");
    expect(container.textContent).toContain("Vonage");
    expect(container.textContent).not.toContain("Telnyx");
    expect(container.textContent).not.toContain("Twilio");
  });

  it("removing a Vonage account names Vonage in the confirmation and the toast", async () => {
    getCreds.mockResolvedValueOnce({ data: [rows[1]], error: null }).mockResolvedValue({ data: [], error: null });
    render(<CarrierAccountsCard />);
    await screen.findByText("Vonage main");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Remove this Vonage account?")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: /Remove/ }).slice(-1)[0]);
    await waitFor(() => expect(deleteCred).toHaveBeenCalledWith("v1"));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Vonage account removed"));
  });

  it("rows without a carrier (older API) are treated as Twilio", async () => {
    getCreds.mockResolvedValue({ data: [{ id: "old", account_sid: "ACold", label: "Legacy" }], error: null });
    const { container } = render(<CarrierAccountsCard />);
    await screen.findByText("Legacy");
    expect(container.textContent).toContain("Twilio");
  });
});
