// jsdom lacks a few browser APIs that Radix UI (Select, Dialog, Checkbox) touches.
import { vi } from "vitest";

const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
proto.scrollIntoView = vi.fn();
proto.hasPointerCapture = vi.fn(() => false);
proto.releasePointerCapture = vi.fn();
proto.setPointerCapture = vi.fn();

if (!("ResizeObserver" in globalThis)) {
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
