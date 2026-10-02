import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Navigate, Route, Routes } from "react-router-dom";
import CallEventsLayout from "./CallEventsLayout";

// The same route shape App.tsx uses, with stand-in pages.
const app = (start: string) =>
  render(
    <MemoryRouter initialEntries={[start]}>
      <Routes>
        <Route path="/dashboard/call-events" element={<CallEventsLayout />}>
          <Route index element={<p>EVENTS PAGE</p>} />
          <Route path="callbacks" element={<p>CALLBACKS PAGE</p>} />
        </Route>
        <Route path="/dashboard/callbacks" element={<Navigate to="/dashboard/call-events/callbacks" replace />} />
      </Routes>
    </MemoryRouter>,
  );

const tab = (name: string) => screen.getByRole("link", { name });

describe("Call Events tabs", () => {
  it("one heading, two tabs, Events shown first", () => {
    app("/dashboard/call-events");
    expect(screen.getByRole("heading", { level: 1, name: "Call Events" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("navigation", { name: "Call events sections" })).toBeInTheDocument();
    expect(screen.getByText("EVENTS PAGE")).toBeInTheDocument();
    expect(screen.queryByText("CALLBACKS PAGE")).not.toBeInTheDocument();
    expect(tab("Events")).toHaveAttribute("aria-current", "page");
    expect(tab("Callbacks")).not.toHaveAttribute("aria-current");
  });

  it("clicking Callbacks switches the content and the active tab, and back again", () => {
    app("/dashboard/call-events");
    fireEvent.click(tab("Callbacks"));
    expect(screen.getByText("CALLBACKS PAGE")).toBeInTheDocument();
    expect(screen.queryByText("EVENTS PAGE")).not.toBeInTheDocument();
    expect(tab("Callbacks")).toHaveAttribute("aria-current", "page");
    expect(tab("Events")).not.toHaveAttribute("aria-current");        // Events is not also highlighted
    fireEvent.click(tab("Events"));
    expect(screen.getByText("EVENTS PAGE")).toBeInTheDocument();
    expect(tab("Events")).toHaveAttribute("aria-current", "page");
  });

  it("opening the Callbacks address directly shows that tab", () => {
    app("/dashboard/call-events/callbacks");
    expect(screen.getByText("CALLBACKS PAGE")).toBeInTheDocument();
    expect(tab("Callbacks")).toHaveAttribute("aria-current", "page");
  });

  it("the heading stays when switching tabs", () => {
    app("/dashboard/call-events");
    fireEvent.click(tab("Callbacks"));
    expect(screen.getByRole("heading", { level: 1, name: "Call Events" })).toBeInTheDocument();
  });

  it("old /dashboard/callbacks links and bookmarks land on the Callbacks tab", () => {
    app("/dashboard/callbacks");
    expect(screen.getByText("CALLBACKS PAGE")).toBeInTheDocument();
    expect(tab("Callbacks")).toHaveAttribute("aria-current", "page");
  });

  it("tabs point at the right addresses", () => {
    app("/dashboard/call-events");
    expect(tab("Events")).toHaveAttribute("href", "/dashboard/call-events");
    expect(tab("Callbacks")).toHaveAttribute("href", "/dashboard/call-events/callbacks");
  });
});
