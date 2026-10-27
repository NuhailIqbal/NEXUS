import "@/test/radix-stubs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";

vi.mock("@/services/api", () => ({
  api: { getAgents: vi.fn(), getTwilioCredentials: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("./ConnectCarrierDialog", () => ({
  ConnectCarrierDialog: ({ open, carrier }: { open: boolean; carrier?: string }) =>
    open ? <div data-testid="connect-carrier-dialog" data-carrier={carrier}>Connect carrier stub</div> : null,
}));

import { toast } from "sonner";
import { api } from "@/services/api";
import { CreatePhoneNumberDialog } from "./CreatePhoneNumberDialog";

const getAgents = api.getAgents as ReturnType<typeof vi.fn>;
const getCreds = api.getTwilioCredentials as ReturnType<typeof vi.fn>;

function setup() {
  const onCreate = vi.fn();
  const onOpenChange = vi.fn();
  render(<CreatePhoneNumberDialog open onOpenChange={onOpenChange} onCreate={onCreate} />);
  return { onCreate, onOpenChange };
}

/** Radix Select in jsdom: open with the keyboard, pick an option with Enter. */
async function choose(selectName: string, optionLabel: RegExp | string) {
  // Let the dialog's own data loads (agents, connected accounts) land before interacting, as they
  // do long before a real person clicks.
  await act(async () => {});
  const trigger = await screen.findByRole("combobox", { name: selectName });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const option = await screen.findByRole("option", { name: optionLabel });
  fireEvent.keyDown(option, { key: "Enter" });
  await waitFor(() => expect(screen.queryByRole("option")).not.toBeInTheDocument());
}

/** Opens a Select and returns the labels of its options, in order (then closes it). */
async function optionsOf(selectName: string) {
  await act(async () => {});
  const trigger = await screen.findByRole("combobox", { name: selectName });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  await screen.findAllByRole("option");
  const labels = screen.getAllByRole("option").map((o) => o.textContent);
  fireEvent.keyDown(screen.getAllByRole("option")[0], { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("option")).not.toBeInTheDocument());
  return labels;
}

const create = () => fireEvent.click(screen.getByRole("button", { name: /Create/ }));

beforeEach(() => {
  vi.clearAllMocks();
  getAgents.mockResolvedValue({ data: [], error: null });
  getCreds.mockResolvedValue({ data: [], error: null });
});

describe("CreatePhoneNumberDialog — existing Twilio flow is unchanged", () => {
  it("creating with the standard Twilio provider requires purpose + provider only", async () => {
    const { onCreate } = setup();
    await choose("Purpose", "Inbound");
    await choose("Service Provider", "Standard");
    create();
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ serviceProvider: "Twilio" }));
  });

  it("shows the $3 pricing note for the standard provider", async () => {
    setup();
    await choose("Service Provider", "Standard");
    expect(screen.getByText(/This number costs/)).toBeInTheDocument();
  });
});

describe("CreatePhoneNumberDialog — BYOT (Twilio)", () => {
  it("is offered in the Service Provider list", async () => {
    setup();
    expect(await optionsOf("Service Provider")).toContain("Twilio");
  });

  it("choosing it shows the $1/month note and no connected-account message when none exist", async () => {
    setup();
    await choose("Service Provider", "Twilio");
    expect(screen.getByText(/\$1\/month/)).toBeInTheDocument();
    expect(screen.getByText("No Twilio account connected yet.")).toBeInTheDocument();
  });

  it("lists already-connected Twilio accounts to pick from", async () => {
    getCreds.mockResolvedValue({
      data: [{ id: "cred-1", account_sid: "ACabc", label: "Main account" }],
      error: null,
    });
    setup();
    await choose("Service Provider", "Twilio");
    await choose("Twilio account", "Main account");
    // selecting it is enough to prove the list rendered from the API response
  });

  it("with two connected accounts, neither is auto-selected and either can be chosen", async () => {
    getCreds.mockResolvedValue({
      data: [
        { id: "cred-1", account_sid: "ACfirst", label: "First account" },
        { id: "cred-2", account_sid: "ACsecond", label: "Second account" },
      ],
      error: null,
    });
    const { onCreate } = setup();
    await choose("Purpose", "Inbound");
    await choose("Service Provider", "Twilio");
    expect(await screen.findByText("Connected")).toBeInTheDocument();

    // nothing pre-selected: creating now is still blocked
    create();
    expect(toast.error).toHaveBeenCalledWith("Please select (or connect) a Twilio account");
    expect(onCreate).not.toHaveBeenCalled();

    await choose("Twilio account", "Second account");
    fireEvent.change(screen.getByPlaceholderText("+1XXXXXXXXXX"), { target: { value: "+15559998888" } });
    create();
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ byotCredentialId: "cred-2" }));
  });

  it("the Connect a Twilio account button opens the connect dialog", async () => {
    setup();
    await choose("Service Provider", "Twilio");
    fireEvent.click(screen.getByRole("button", { name: "Connect a Twilio account" }));
    expect(await screen.findByTestId("connect-carrier-dialog")).toBeInTheDocument();
  });

  it("defaults to import mode, with a number field", async () => {
    getCreds.mockResolvedValue({ data: [{ id: "cred-1", account_sid: "ACabc" }], error: null });
    setup();
    await choose("Service Provider", "Twilio");
    expect(screen.getByPlaceholderText("+1XXXXXXXXXX")).toBeInTheDocument();
  });

  it("switching to purchase mode hides the number field (no area code field either)", async () => {
    getCreds.mockResolvedValue({ data: [{ id: "cred-1", account_sid: "ACabc" }], error: null });
    setup();
    await choose("Service Provider", "Twilio");
    await choose("Number acquisition mode", /Buy a new number/);
    expect(screen.queryByPlaceholderText("+1XXXXXXXXXX")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("e.g. 415")).not.toBeInTheDocument();
  });

  it("blocks creation when no Twilio account is connected yet", async () => {
    // Zero credentials — a single one is now auto-selected (see the auto-select test
    // below), so this guard is only reachable with nothing connected at all.
    getCreds.mockResolvedValue({ data: [], error: null });
    const { onCreate } = setup();
    await choose("Purpose", "Inbound");
    await choose("Service Provider", "Twilio");
    create();
    expect(toast.error).toHaveBeenCalledWith("Please select (or connect) a Twilio account");
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("auto-selects the account and shows a Connected badge when exactly one is connected", async () => {
    getCreds.mockResolvedValue({ data: [{ id: "cred-1", account_sid: "ACabc" }], error: null });
    const { onCreate } = setup();
    await choose("Purpose", "Inbound");
    await choose("Service Provider", "Twilio");
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    fireEvent.change(await screen.findByPlaceholderText("+1XXXXXXXXXX"), { target: { value: "+15559998888" } });
    create();
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ byotCredentialId: "cred-1" }));
  });

  it("blocks import-mode creation without a number", async () => {
    getCreds.mockResolvedValue({ data: [{ id: "cred-1", account_sid: "ACabc" }], error: null });
    const { onCreate } = setup();
    await choose("Purpose", "Inbound");
    await choose("Service Provider", "Twilio");
    await choose("Twilio account", "ACabc");
    create();
    expect(toast.error).toHaveBeenCalledWith("Enter the phone number you already own");
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("allows purchase-mode creation with no number required", async () => {
    getCreds.mockResolvedValue({ data: [{ id: "cred-1", account_sid: "ACabc" }], error: null });
    const { onCreate } = setup();
    await choose("Purpose", "Inbound");
    await choose("Service Provider", "Twilio");
    await choose("Twilio account", "ACabc");
    await choose("Number acquisition mode", /Buy a new number/);
    create();
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      serviceProvider: "BYOT", byotCredentialId: "cred-1", byotMode: "purchase",
    }));
  });

  it("submits the import number and credential together", async () => {
    getCreds.mockResolvedValue({ data: [{ id: "cred-1", account_sid: "ACabc" }], error: null });
    const { onCreate } = setup();
    await choose("Purpose", "Inbound");
    await choose("Service Provider", "Twilio");
    await choose("Twilio account", "ACabc");
    fireEvent.change(screen.getByPlaceholderText("+1XXXXXXXXXX"), { target: { value: "+15559998888" } });
    create();
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      serviceProvider: "BYOT", byotCredentialId: "cred-1", byotMode: "import", byotNumber: "+15559998888",
    }));
  });

});

describe("CreatePhoneNumberDialog — BYOT (Vonage and Telnyx)", () => {
  const accounts = [
    { id: "t1", carrier: "twilio", account_sid: "ACabc", label: "Twilio main" },
    { id: "v1", carrier: "vonage", account_sid: "vkey01", label: "Vonage main" },
    { id: "n1", carrier: "telnyx", account_sid: null, label: "Telnyx main" },
  ];

  it("offers Standard, Twilio, Vonage and Telnyx", async () => {
    setup();
    expect(await optionsOf("Service Provider")).toEqual(["Standard", "Twilio", "Vonage", "Telnyx"]);
  });

  it("Vonage: only Vonage accounts are listed, the single one is auto-selected, and the form submits it", async () => {
    getCreds.mockResolvedValue({ data: accounts, error: null });
    const { onCreate } = setup();
    await choose("Purpose", "Inbound");
    await choose("Service Provider", "Vonage");
    expect(screen.getByText(/Vonage bills you/)).toBeInTheDocument();
    expect(await screen.findByText("Vonage main")).toBeInTheDocument();
    expect(screen.queryByText("Twilio main")).not.toBeInTheDocument();
    expect(screen.queryByText("Telnyx main")).not.toBeInTheDocument();
    await choose("Number acquisition mode", /Buy a new number/);
    create();
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      serviceProvider: "BYOT_VONAGE", byotCredentialId: "v1", byotMode: "purchase",
    }));
  });

  it("Telnyx: shows the outbound setup note and submits the Telnyx account with the import number", async () => {
    getCreds.mockResolvedValue({ data: accounts, error: null });
    const { onCreate } = setup();
    await choose("Purpose", "Both");
    await choose("Service Provider", "Telnyx");
    expect(screen.getByText(/Outbound Voice Profile/)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("+1XXXXXXXXXX"), { target: { value: " +15557778888 " } });
    create();
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      serviceProvider: "BYOT_TELNYX", byotCredentialId: "n1", byotMode: "import", byotNumber: "+15557778888",
    }));
  });

  it("the Outbound Voice Profile note is Telnyx-only", async () => {
    getCreds.mockResolvedValue({ data: accounts, error: null });
    setup();
    await choose("Service Provider", "Vonage");
    expect(screen.queryByText(/Outbound Voice Profile/)).not.toBeInTheDocument();
  });

  it("switching carrier drops the account picked for the previous one", async () => {
    getCreds.mockResolvedValue({ data: [accounts[0], accounts[1], { ...accounts[1], id: "v2", label: "Vonage second" }], error: null });
    const { onCreate } = setup();
    await choose("Purpose", "Inbound");
    await choose("Service Provider", "Twilio");
    expect(await screen.findByText("Twilio main")).toBeInTheDocument(); // auto-selected (the only Twilio account)
    await choose("Service Provider", "Vonage"); // two Vonage accounts -> nothing auto-selected
    create();
    expect(toast.error).toHaveBeenCalledWith("Please select (or connect) a Vonage account");
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("the connect button opens the connect dialog for the chosen carrier", async () => {
    setup();
    await choose("Service Provider", "Telnyx");
    expect(screen.getByText("No Telnyx account connected yet.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect a Telnyx account" }));
    const dlg = await screen.findByTestId("connect-carrier-dialog");
    expect(dlg).toHaveAttribute("data-carrier", "telnyx");
  });
});

describe("CreatePhoneNumberDialog — outbound and both need the user's own carrier number", () => {
  it("Outbound offers only Twilio, Vonage and Telnyx (no Standard)", async () => {
    setup();
    await choose("Purpose", "Outbound");
    expect(await optionsOf("Service Provider")).toEqual(["Twilio", "Vonage", "Telnyx"]);
  });

  it("Both also offers only Twilio, Vonage and Telnyx", async () => {
    setup();
    await choose("Purpose", "Both");
    expect(await optionsOf("Service Provider")).toEqual(["Twilio", "Vonage", "Telnyx"]);
  });

  it("only Inbound still offers Standard", async () => {
    setup();
    await choose("Purpose", "Inbound");
    expect(await optionsOf("Service Provider")).toEqual(["Standard", "Twilio", "Vonage", "Telnyx"]);
  });

  it("switching to Outbound or Both after picking Standard clears the provider", async () => {
    for (const purpose of ["Outbound", "Both"]) {
      vi.clearAllMocks();
      getAgents.mockResolvedValue({ data: [], error: null });
      getCreds.mockResolvedValue({ data: [], error: null });
      const { onCreate } = setup();
      await choose("Purpose", "Inbound");
      await choose("Service Provider", "Standard");
      expect(screen.getByText(/This number costs/)).toBeInTheDocument();
      await choose("Purpose", purpose);
      expect(screen.queryByText(/This number costs/)).not.toBeInTheDocument();
      create();
      expect(toast.error).toHaveBeenCalledWith("Please select a service provider");
      expect(onCreate).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it("switching to Outbound keeps a carrier that was already picked", async () => {
    getCreds.mockResolvedValue({ data: [{ id: "v1", carrier: "vonage", account_sid: "k", label: "Vonage main" }], error: null });
    const { onCreate } = setup();
    await choose("Purpose", "Inbound");
    await choose("Service Provider", "Vonage");
    await choose("Purpose", "Outbound");
    await choose("Number acquisition mode", /Buy a new number/);
    create();
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ serviceProvider: "BYOT_VONAGE", purpose: "outbound" }));
  });
});
