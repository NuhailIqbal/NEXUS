import "@/test/radix-stubs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("@/services/api", () => ({ api: { supportChat: vi.fn() } }));

import { api } from "@/services/api";
import SupportChatBubble, { OPEN_SUPPORT_CHAT_EVENT, STARTERS } from "./SupportChatBubble";

const chat = api.supportChat as ReturnType<typeof vi.fn>;
const openIt = () => fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
const say = (text: string) => {
  fireEvent.change(screen.getByLabelText("Your message"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});

describe("Support chat bubble teaser", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("appears once after a few seconds, can be dismissed, and then stays away this session", () => {
    const first = render(<SupportChatBubble />);
    expect(screen.queryByText("Need a hand?")).not.toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(4100); });
    expect(screen.getByText("Need a hand?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Need a hand?")).not.toBeInTheDocument();
    first.unmount();
    render(<SupportChatBubble />);
    act(() => { vi.advanceTimersByTime(10000); });
    expect(screen.queryByText("Need a hand?")).not.toBeInTheDocument();
  });

  it("clicking the teaser opens the chat", () => {
    render(<SupportChatBubble />);
    act(() => { vi.advanceTimersByTime(4100); });
    fireEvent.click(screen.getByText("Ask me anything about NEXUS."));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByText("Need a hand?")).not.toBeInTheDocument();
  });

  it("is not shown to someone who is already chatting", () => {
    sessionStorage.setItem("nexus_support_chat", JSON.stringify([{ role: "user", content: "hi", t: 1 }]));
    render(<SupportChatBubble />);
    act(() => { vi.advanceTimersByTime(10000); });
    expect(screen.queryByText("Need a hand?")).not.toBeInTheDocument();
  });
});

describe("Support chat bubble", () => {
  it("shows only the round icon until it is clicked", () => {
    render(<SupportChatBubble />);
    expect(screen.getByRole("button", { name: "Open chat" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens with the assistant's name, a Today divider, a greeting for the user and an honest line about being an AI", () => {
    render(<SupportChatBubble firstName="Qarib" />);
    openIt();
    expect(screen.getByRole("dialog", { name: "NEXUS Assistant" })).toBeInTheDocument();
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.getByText(/Hi Qarib! I'm the NEXUS assistant/)).toBeInTheDocument();
    expect(screen.getByText(/I'm an AI, so I can't see your account/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Write a message…")).toBeInTheDocument();
    expect(screen.getByText("AI assistant · replies instantly")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/vapi|live chat|mon.?fri/i);
  });

  it("sends the question, shows the reply and passes the whole conversation each time", async () => {
    chat.mockResolvedValueOnce({ data: { reply: "Go to AI Agents and click Add New Agent." }, error: null });
    render(<SupportChatBubble />);
    openIt();
    say("How do I make an agent?");
    expect(chat).toHaveBeenCalledWith([{ role: "user", content: "How do I make an agent?" }]);
    expect(await screen.findByText("Go to AI Agents and click Add New Agent.")).toBeInTheDocument();
    chat.mockResolvedValueOnce({ data: { reply: "It costs $3 a month." }, error: null });
    say("And a phone number?");
    await screen.findByText("It costs $3 a month.");
    expect(chat).toHaveBeenLastCalledWith([
      { role: "user", content: "How do I make an agent?" },
      { role: "assistant", content: "Go to AI Agents and click Add New Agent." },
      { role: "user", content: "And a phone number?" },
    ]);
    expect(screen.getByLabelText("Your message")).toHaveValue("");
  });

  it("shows typing dots while waiting and blocks a second send", async () => {
    let resolve!: (v: unknown) => void;
    chat.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    render(<SupportChatBubble />);
    openIt();
    say("hello");
    expect(screen.getByLabelText("The assistant is typing")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    await act(async () => { resolve({ data: { reply: "Hi!" }, error: null }); });
    expect(await screen.findByText("Hi!")).toBeInTheDocument();
    expect(screen.queryByLabelText("The assistant is typing")).not.toBeInTheDocument();
  });

  it("on an error says why, and gives the question back so it can be sent again", async () => {
    chat.mockResolvedValueOnce({ data: null, error: "The assistant is unavailable right now." });
    render(<SupportChatBubble />);
    openIt();
    say("hello?");
    expect(await screen.findByRole("alert")).toHaveTextContent("The assistant is unavailable right now.");
    expect(screen.getByLabelText("Your message")).toHaveValue("hello?");
    expect(screen.queryByText("hello?", { selector: "p" })).not.toBeInTheDocument();     // the unanswered question left the history
    chat.mockResolvedValueOnce({ data: { reply: "Back now." }, error: null });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Back now.")).toBeInTheDocument();
    expect(chat).toHaveBeenLastCalledWith([{ role: "user", content: "hello?" }]);
  });

  it("renders replies as plain text, never HTML", async () => {
    chat.mockResolvedValueOnce({ data: { reply: "<img src=x onerror=alert(1)>" }, error: null });
    render(<SupportChatBubble />);
    openIt();
    say("test");
    expect(await screen.findByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });

  it("keeps the conversation across a page change (same tab) and End chat clears it", async () => {
    chat.mockResolvedValueOnce({ data: { reply: "Sure." }, error: null });
    const first = render(<SupportChatBubble />);
    openIt();
    say("remember me");
    await screen.findByText("Sure.");
    first.unmount();
    render(<SupportChatBubble />);
    openIt();
    expect(screen.getByText("remember me")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "End chat" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    openIt();
    expect(screen.queryByText("remember me")).not.toBeInTheDocument();
  });

  it("the header has a small chevron (minimize) beside the cross (end chat), and the round icon is hidden while the window is open", () => {
    render(<SupportChatBubble />);
    openIt();
    const header = screen.getByRole("dialog").querySelector("header") as HTMLElement;
    expect(within(header).getByRole("button", { name: "Minimize chat" })).toBeInTheDocument();
    expect(within(header).getByRole("button", { name: "End chat" })).toBeInTheDocument();
    expect(header.querySelectorAll("button")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Open chat", hidden: true }).classList.contains("hidden")).toBe(true);
    fireEvent.click(within(header).getByRole("button", { name: "Minimize chat" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open chat" }).classList.contains("hidden")).toBe(false);
  });

  it("minimize hides the window but keeps the chat", async () => {
    chat.mockResolvedValueOnce({ data: { reply: "Yes." }, error: null });
    render(<SupportChatBubble />);
    openIt();
    say("q");
    await screen.findByText("Yes.");
    fireEvent.click(screen.getByRole("button", { name: "Minimize chat" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    openIt();
    expect(screen.getByText("Yes.")).toBeInTheDocument();
  });

  it("the Support page can open it with the shared event", async () => {
    render(<SupportChatBubble />);
    act(() => { window.dispatchEvent(new Event(OPEN_SUPPORT_CHAT_EVENT)); });
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
  });

  it("offers starter questions while the chat is empty; tapping one asks it and the chips go away", async () => {
    chat.mockResolvedValueOnce({ data: { reply: "Open AI Agents, then Add New Agent." }, error: null });
    render(<SupportChatBubble />);
    openIt();
    const chips = screen.getByLabelText("Suggested questions");
    expect(chips.querySelectorAll("button")).toHaveLength(STARTERS.length);
    fireEvent.click(screen.getByRole("button", { name: STARTERS[0] }));
    expect(chat).toHaveBeenCalledWith([{ role: "user", content: STARTERS[0] }]);
    expect(await screen.findByText("Open AI Agents, then Add New Agent.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Suggested questions")).not.toBeInTheDocument();
  });

  it("Enter sends; Shift+Enter keeps writing", async () => {
    chat.mockResolvedValue({ data: { reply: "ok" }, error: null });
    render(<SupportChatBubble />);
    openIt();
    const box = screen.getByLabelText("Your message");
    fireEvent.change(box, { target: { value: "line one" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(chat).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(chat).toHaveBeenCalledWith([{ role: "user", content: "line one" }]));
  });

  it("an assistant answer shows the assistant's name and the time under it", async () => {
    chat.mockResolvedValueOnce({ data: { reply: "Done." }, error: null });
    render(<SupportChatBubble />);
    openIt();
    say("hi");
    await screen.findByText("Done.");
    expect(screen.getAllByText(/NEXUS Assistant · \d/).length).toBeGreaterThan(0);
  });

  it("does not send an empty message", () => {
    render(<SupportChatBubble />);
    openIt();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    say("   ");
    expect(chat).not.toHaveBeenCalled();
  });
});
