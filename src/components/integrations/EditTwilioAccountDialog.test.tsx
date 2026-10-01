import "@/test/radix-stubs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/services/api", () => ({ api: { updateTwilioCredential: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { toast } from "sonner";
import { api } from "@/services/api";
import { EditTwilioAccountDialog } from "./EditTwilioAccountDialog";

const updateCred = api.updateTwilioCredential as ReturnType<typeof vi.fn>;

const target = { id: "cred-1", account_sid: "ACabc123", label: "Main account" };

function setup(t = target) {
  const onOpenChange = vi.fn();
  const onSaved = vi.fn();
  render(<EditTwilioAccountDialog target={t} onOpenChange={onOpenChange} onSaved={onSaved} />);
  return { onOpenChange, onSaved };
}

beforeEach(() => {
  vi.clearAllMocks();
  updateCred.mockResolvedValue({ data: { id: "cred-1" }, error: null });
});

describe("EditTwilioAccountDialog", () => {
  it("is prefilled with the current label and Account SID, Auth Token blank", () => {
    setup();
    expect(screen.getByDisplayValue("Main account")).toBeInTheDocument();
    expect(screen.getByDisplayValue("ACabc123")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Leave blank to keep the current one")).toHaveValue("");
  });

  it("saving with only the label changed sends label but not account_sid/auth_token", async () => {
    const { onSaved } = setup();
    fireEvent.change(screen.getByDisplayValue("Main account"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(updateCred).toHaveBeenCalledWith("cred-1", { label: "Renamed" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it("changing the Account SID includes it in the payload", async () => {
    setup();
    fireEvent.change(screen.getByDisplayValue("ACabc123"), { target: { value: "ACnewsid456" } });
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(updateCred).toHaveBeenCalledWith("cred-1", {
      label: "Main account", account_sid: "ACnewsid456",
    }));
  });

  it("filling in a new Auth Token includes it in the payload", async () => {
    setup();
    fireEvent.change(screen.getByPlaceholderText("Leave blank to keep the current one"), { target: { value: "new-token" } });
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(updateCred).toHaveBeenCalledWith("cred-1", {
      label: "Main account", auth_token: "new-token",
    }));
  });

  it("the Auth Token is masked by default and can be revealed", () => {
    setup();
    const tokenInput = screen.getByPlaceholderText("Leave blank to keep the current one");
    expect(tokenInput).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "Show secret" }));
    expect(tokenInput).toHaveAttribute("type", "text");
  });

  it("rejects an empty Account SID", async () => {
    setup();
    fireEvent.change(screen.getByDisplayValue("ACabc123"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    expect(toast.error).toHaveBeenCalledWith("Account SID is required");
    expect(updateCred).not.toHaveBeenCalled();
  });

  it("a backend rejection is surfaced and the dialog stays open", async () => {
    updateCred.mockResolvedValue({ data: null, error: "Twilio rejected these credentials" });
    const { onOpenChange } = setup();
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Twilio rejected these credentials"));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("Cancel closes without saving", () => {
    const { onOpenChange } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(updateCred).not.toHaveBeenCalled();
  });

  it("nothing renders when there is no target", () => {
    const { container } = render(
      <EditTwilioAccountDialog target={null} onOpenChange={vi.fn()} />
    );
    expect(container.querySelector('[role="dialog"]')).not.toBeInTheDocument();
  });
});
