/**
 * Thin wrapper around react-router's NavLink that takes plain string `className`,
 * `activeClassName` and `pendingClassName` props instead of a className callback. At the time of
 * writing, no file imports it: the dashboard layouts use react-router's NavLink directly.
 */
import { NavLink as RouterNavLink, NavLinkProps } from "react-router-dom";
import { forwardRef } from "react";
import { cn } from "@/lib/utils";

/** NavLink props with `className` narrowed to a string, plus the extra state-specific class props. */
interface NavLinkCompatProps extends Omit<NavLinkProps, "className"> {
  className?: string;
  activeClassName?: string;
  pendingClassName?: string;
}

/**
 * Forwards its ref to the underlying anchor. Merges `className` with `activeClassName` when the
 * route matches and `pendingClassName` while navigation to it is loading, using `cn` so
 * conflicting Tailwind classes resolve in favour of the later one.
 */
const NavLink = forwardRef<HTMLAnchorElement, NavLinkCompatProps>(
  ({ className, activeClassName, pendingClassName, to, ...props }, ref) => {
    // className and to are destructured out above, so the {...props} spread cannot overwrite the
    // computed className.
    return (
      <RouterNavLink
        ref={ref}
        to={to}
        className={({ isActive, isPending }) =>
          cn(className, isActive && activeClassName, isPending && pendingClassName)
        }
        {...props}
      />
    );
  },
);

NavLink.displayName = "NavLink";

export { NavLink };
