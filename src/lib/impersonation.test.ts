import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearImpersonation, getImpersonatedEmail, isImpersonating, isPartnerImpersonation,
  startPartnerImpersonation, stopImpersonation,
} from "./impersonation";

const realLocation = window.location;
let navigatedTo = "";

beforeEach(() => {
  localStorage.clear();
  navigatedTo = "";
  // jsdom cannot navigate; capture the assignment instead.
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      protocol: "http:", hostname: "localhost", origin: "http://localhost:8080", search: "",
      set href(v: string) { navigatedTo = v; },
      get href() { return navigatedTo; },
    },
  });
});

afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: realLocation });
});

describe("partner impersonation", () => {
  it("swaps in the user's token, parks the partner's own, and goes to the dashboard", () => {
    localStorage.setItem("nexus_token", "PARTNER");
    startPartnerImpersonation("USERTOKEN", "lead@x.test");
    expect(localStorage.getItem("nexus_token")).toBe("USERTOKEN");
    expect(localStorage.getItem("nexus_partner_return_token")).toBe("PARTNER");
    expect(getImpersonatedEmail()).toBe("lead@x.test");
    expect(isImpersonating()).toBe(true);
    expect(isPartnerImpersonation()).toBe(true);
    expect(navigatedTo).toBe("/dashboard");
  });

  it("exiting restores the partner's own token and returns to the partner page", () => {
    localStorage.setItem("nexus_token", "PARTNER");
    startPartnerImpersonation("USERTOKEN", "lead@x.test");
    stopImpersonation();
    expect(localStorage.getItem("nexus_token")).toBe("PARTNER");
    expect(localStorage.getItem("nexus_partner_return_token")).toBeNull();
    expect(isImpersonating()).toBe(false);
    expect(navigatedTo).toBe("/partner");
  });

  it("a second View as never parks an impersonation token as the partner's own", () => {
    localStorage.setItem("nexus_token", "PARTNER");
    startPartnerImpersonation("USER1", "a@x.test");
    startPartnerImpersonation("USER2", "b@x.test");
    expect(localStorage.getItem("nexus_partner_return_token")).toBe("PARTNER");
    stopImpersonation();
    expect(localStorage.getItem("nexus_token")).toBe("PARTNER");
  });

  it("sign-out / login bookkeeping clears the parked token so it cannot leak into another session", () => {
    localStorage.setItem("nexus_token", "PARTNER");
    startPartnerImpersonation("USERTOKEN", "lead@x.test");
    clearImpersonation();
    expect(isImpersonating()).toBe(false);
    expect(isPartnerImpersonation()).toBe(false);
    expect(localStorage.getItem("nexus_partner_return_token")).toBeNull();
  });
});

describe("admin impersonation is unchanged", () => {
  it("is not reported as a partner session, and exiting drops the token and heads to the admin origin", () => {
    localStorage.setItem("nexus_token", "ADMIN-ISSUED");
    localStorage.setItem("nexus_impersonating", "lead@x.test");
    expect(isPartnerImpersonation()).toBe(false);
    stopImpersonation();
    expect(localStorage.getItem("nexus_token")).toBeNull();
    expect(isImpersonating()).toBe(false);
    expect(navigatedTo).toBe("http://admin.localhost");
  });
});
