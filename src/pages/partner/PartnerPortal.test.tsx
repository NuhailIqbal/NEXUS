import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

const auth = vi.hoisted(() => ({
  state: { user: null as null | { id: string; email: string; user_metadata: Record<string, string> }, loading: false },
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ ...auth.state, signIn: auth.signIn, signOut: auth.signOut }),
}));
vi.mock("@/services/api", () => ({ api: { getPartnerMe: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { api } from "@/services/api";
import PartnerLogin from "./PartnerLogin";
import PartnerLayout from "./PartnerLayout";

const fn = (f: unknown) => f as ReturnType<typeof vi.fn>;
const ME = { is_partner: true, partner: { name: "Acme Referrals", code: "ACME1", status: "active" } };
const PAUSED = { is_partner: true, partner: { name: "Acme Referrals", code: "ACME1", status: "paused" } };
const NOT = { is_partner: false, partner: null };
const USER = { id: "u1", email: "pat@acme.test", user_metadata: {} };

const Where = () => <div data-testid="where">{useLocation().pathname}</div>;

function renderApp(start: string) {
  return render(
    <MemoryRouter initialEntries={[start]}>
      <Where />
      <Routes>
        <Route path="/partner/login" element={<PartnerLogin />} />
        <Route path="/partner" element={<PartnerLayout />}>
          <Route index element={<div>OVERVIEW PAGE</div>} />
          <Route path="users" element={<div>USERS PAGE</div>} />
        </Route>
        <Route path="/dashboard" element={<div>CUSTOMER DASHBOARD</div>} />
        <Route path="/login" element={<div>CUSTOMER LOGIN</div>} />
      </Routes>
    </MemoryRouter>,
  );
}
const where = () => screen.getByTestId("where").textContent;

beforeEach(() => {
  vi.clearAllMocks();
  auth.state = { user: null, loading: false };
  auth.signIn.mockResolvedValue({ error: null });
  auth.signOut.mockResolvedValue(undefined);
});

function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "pat@acme.test" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret-pass" } });
  fireEvent.click(screen.getByRole("button", { name: /Sign in to the Partner Portal/ }));
}

describe("Partner sign-in page", () => {
  it("is its own page, with a way back to the customer sign-in", () => {
    renderApp("/partner/login");
    expect(screen.getByRole("heading", { name: "Partner sign in" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Customer sign in" })).toHaveAttribute("href", "/login");
  });

  it("takes a partner into the console", async () => {
    fn(api.getPartnerMe).mockResolvedValue({ data: ME, error: null });
    renderApp("/partner/login");
    fillAndSubmit();
    await waitFor(() => expect(where()).toBe("/partner"));
    expect(auth.signIn).toHaveBeenCalledWith("pat@acme.test", "secret-pass");
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it("a paused partner can still sign in", async () => {
    fn(api.getPartnerMe).mockResolvedValue({ data: PAUSED, error: null });
    renderApp("/partner/login");
    fillAndSubmit();
    await waitFor(() => expect(where()).toBe("/partner"));
  });

  it("signs a valid account that is not a partner back out and says why", async () => {
    fn(api.getPartnerMe).mockResolvedValue({ data: NOT, error: null });
    renderApp("/partner/login");
    fillAndSubmit();
    expect(await screen.findByRole("alert")).toHaveTextContent(/not set up as a referral partner/);
    expect(auth.signOut).toHaveBeenCalledTimes(1);
    expect(where()).toBe("/partner/login");
  });

  it("does not guess when the partner check itself fails", async () => {
    fn(api.getPartnerMe).mockResolvedValue({ data: null, error: "Network error" });
    renderApp("/partner/login");
    fillAndSubmit();
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not check your partner access/);
    expect(auth.signOut).toHaveBeenCalledTimes(1);
    expect(where()).toBe("/partner/login");
  });

  it("shows a wrong password and never asks about partner access", async () => {
    auth.signIn.mockResolvedValue({ error: "Invalid email or password" });
    renderApp("/partner/login");
    fillAndSubmit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email or password");
    expect(api.getPartnerMe).not.toHaveBeenCalled();
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it("sends a visitor who is already signed in as a partner straight to the console", async () => {
    auth.state = { user: USER, loading: false };
    fn(api.getPartnerMe).mockResolvedValue({ data: ME, error: null });
    renderApp("/partner/login");
    await waitFor(() => expect(where()).toBe("/partner"));
  });

  it("leaves a signed-in customer on the form", async () => {
    auth.state = { user: USER, loading: false };
    fn(api.getPartnerMe).mockResolvedValue({ data: NOT, error: null });
    renderApp("/partner/login");
    await waitFor(() => expect(api.getPartnerMe).toHaveBeenCalled());
    expect(where()).toBe("/partner/login");
  });
});

describe("Partner console layout", () => {
  it("sends a visitor with no session to the partner sign-in, not the customer one", async () => {
    renderApp("/partner/users");
    await waitFor(() => expect(where()).toBe("/partner/login"));
    expect(api.getPartnerMe).not.toHaveBeenCalled();
  });

  it("waits for the session to load before deciding", () => {
    auth.state = { user: null, loading: true };
    renderApp("/partner");
    expect(where()).toBe("/partner");
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("shows the partner's own sidebar and the page, and none of the customer menus", async () => {
    auth.state = { user: USER, loading: false };
    fn(api.getPartnerMe).mockResolvedValue({ data: ME, error: null });
    renderApp("/partner/users");
    expect(await screen.findByText("USERS PAGE")).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Partner navigation" });
    expect(nav).toHaveTextContent("Overview");
    expect(nav).toHaveTextContent("My Users");
    expect(screen.getAllByText("Acme Referrals").length).toBeGreaterThan(0);
    for (const customerOnly of ["AI Agents", "Campaigns", "Billing", "Call Events"]) expect(screen.queryByText(customerOnly)).toBeNull();
    expect(screen.getByRole("link", { name: /My dashboard/ })).toHaveAttribute("href", "/dashboard");
  });

  it("marks only the current page in the sidebar (the overview is not lit on a sub-page)", async () => {
    auth.state = { user: USER, loading: false };
    fn(api.getPartnerMe).mockResolvedValue({ data: ME, error: null });
    renderApp("/partner/users");
    await screen.findByText("USERS PAGE");
    expect(screen.getByRole("link", { name: "My Users" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Overview" })).not.toHaveAttribute("aria-current");
  });

  it("lets a paused partner in and says what still works", async () => {
    auth.state = { user: USER, loading: false };
    fn(api.getPartnerMe).mockResolvedValue({ data: PAUSED, error: null });
    renderApp("/partner");
    expect(await screen.findByText("OVERVIEW PAGE")).toBeInTheDocument();
    expect(screen.getByText(/Paused: you can still see your users and earnings/)).toBeInTheDocument();
  });

  it("keeps a signed-in non-partner out: no page renders, and they can go elsewhere", async () => {
    auth.state = { user: USER, loading: false };
    fn(api.getPartnerMe).mockResolvedValue({ data: NOT, error: null });
    renderApp("/partner/users");
    expect(await screen.findByRole("heading", { name: "No partner access" })).toBeInTheDocument();
    expect(screen.queryByText("USERS PAGE")).toBeNull();
    expect(screen.getByRole("link", { name: "Go to my dashboard" })).toHaveAttribute("href", "/dashboard");
    fireEvent.click(screen.getByRole("button", { name: "Sign in as a partner" }));
    await waitFor(() => expect(where()).toBe("/partner/login"));
    expect(auth.signOut).toHaveBeenCalledTimes(1);
  });

  it("offers a retry when the access check fails, instead of calling the account a non-partner", async () => {
    auth.state = { user: USER, loading: false };
    fn(api.getPartnerMe).mockResolvedValueOnce({ data: null, error: "Network error" });
    renderApp("/partner");
    expect(await screen.findByRole("heading", { name: "We could not check your access" })).toBeInTheDocument();
    expect(screen.queryByText("OVERVIEW PAGE")).toBeNull();
    fn(api.getPartnerMe).mockResolvedValue({ data: ME, error: null });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("OVERVIEW PAGE")).toBeInTheDocument();
  });

  it("signs out to the partner sign-in", async () => {
    auth.state = { user: USER, loading: false };
    fn(api.getPartnerMe).mockResolvedValue({ data: ME, error: null });
    renderApp("/partner");
    await screen.findByText("OVERVIEW PAGE");
    fireEvent.click(screen.getAllByRole("button", { name: /Sign Out/ })[0]);
    await waitFor(() => expect(where()).toBe("/partner/login"));
    expect(auth.signOut).toHaveBeenCalledTimes(1);
  });
});
