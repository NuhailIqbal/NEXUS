import "@/test/radix-stubs";
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CallerVerificationSwitch } from "./CallerVerificationSwitch";

function setup(props: Partial<React.ComponentProps<typeof CallerVerificationSwitch>> = {}) {
  const onCheckedChange = vi.fn();
  const utils = render(
    <CallerVerificationSwitch id="v" checked={false} onCheckedChange={onCheckedChange} {...props} />,
  );
  return { onCheckedChange, ...utils };
}
const sw = () => screen.getByRole("switch", { name: "Verify callers before answering" });

describe("CallerVerificationSwitch", () => {
  it("explains the rule in one short sentence", () => {
    setup();
    expect(screen.getByText("Verify callers before answering")).toBeInTheDocument();
    expect(screen.getByText("Only mobile numbers reach your agent. Other callers hear a short message and the call ends.")).toBeInTheDocument();
  });

  it("reflects the current value", () => {
    const { rerender, onCheckedChange } = setup({ checked: false });
    expect(sw()).not.toBeChecked();
    rerender(<CallerVerificationSwitch id="v" checked onCheckedChange={onCheckedChange} />);
    expect(sw()).toBeChecked();
  });

  it("is labelled by its visible text, so clicking the label toggles it", () => {
    const { onCheckedChange } = setup();
    fireEvent.click(screen.getByText("Verify callers before answering"));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("reports the new value when switched on and off", () => {
    const on = setup({ checked: false });
    fireEvent.click(sw());
    expect(on.onCheckedChange).toHaveBeenCalledExactlyOnceWith(true);
    on.unmount();
    const off = setup({ checked: true });
    fireEvent.click(sw());
    expect(off.onCheckedChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("does nothing while disabled", () => {
    const { onCheckedChange } = setup({ disabled: true });
    expect(sw()).toBeDisabled();
    fireEvent.click(sw());
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it("cannot be switched on when the server is not set up, and says why", () => {
    const { onCheckedChange } = setup({ checked: false, unavailableReason: "Caller verification isn't available yet. Please contact support." });
    expect(sw()).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Caller verification isn't available yet. Please contact support.");
    fireEvent.click(sw());
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it("can still be switched OFF when it is on but the server is no longer set up", () => {
    const { onCheckedChange } = setup({ checked: true, unavailableReason: "Not available." });
    expect(sw()).toBeEnabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    fireEvent.click(sw());
    expect(onCheckedChange).toHaveBeenCalledWith(false);
  });

  it("shows no warning when nothing is wrong", () => {
    setup({ unavailableReason: null });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(sw()).toBeEnabled();
  });

  it("never mentions the voice service by name", () => {
    const { container } = setup();
    expect(container.textContent).not.toMatch(/vapi/i);
  });

  it("a draft flipped off from a saved ON value is not locked, even when the server is not set up", () => {
    setup({ checked: false, savedValue: true, unavailableReason: "Not available" });
    expect(sw()).toBeEnabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("a saved OFF value is still locked when the server is not set up", () => {
    setup({ checked: false, savedValue: false, unavailableReason: "Not available" });
    expect(sw()).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Not available");
  });
});
