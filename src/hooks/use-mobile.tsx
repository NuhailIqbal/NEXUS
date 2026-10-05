/**
 * `useIsMobile`: reports whether the viewport is narrower than the mobile breakpoint.
 * Browser-only (reads `window`). Consumed by the shadcn sidebar primitive
 * (src/components/ui/sidebar.tsx) to switch between its desktop and mobile layouts.
 */
import * as React from "react";

/** Viewport width in px below which the UI is treated as mobile (matches Tailwind's `md`). */
const MOBILE_BREAKPOINT = 768;

/**
 * Returns true while `window.innerWidth < 768`, and re-renders when the viewport crosses
 * that width. Returns false until the effect has run after mount, so the first render
 * is always the desktop one.
 */
export function useIsMobile() {
  // undefined = not measured yet; coerced to false by the `!!` in the return.
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined);

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    // The media query only signals that the threshold was crossed; the value is
    // re-read from innerWidth.
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };
    mql.addEventListener("change", onChange);
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return !!isMobile;
}
