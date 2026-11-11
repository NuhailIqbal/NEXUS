import { describe, expect, it } from "vitest";
import { PARTNER_NAV, legacyPartnerPath, partnerAccess } from "./partnerPortal";

describe("partnerAccess", () => {
  it("lets a partner in, whether active or paused", () => {
    expect(partnerAccess({ is_partner: true, partner: { name: "Acme", code: "ACME1", status: "active" } })).toBe("partner");
    expect(partnerAccess({ is_partner: true, partner: { name: "Acme", code: "ACME1", status: "paused" } })).toBe("partner");
  });
  it("keeps everyone else out", () => {
    expect(partnerAccess({ is_partner: false, partner: null })).toBe("not-partner");
    expect(partnerAccess({ is_partner: true, partner: null })).toBe("not-partner");
  });
  it("treats a failed lookup as unknown, not as proof the account is no partner", () => {
    expect(partnerAccess(null)).toBe("unknown");
    expect(partnerAccess(undefined)).toBe("unknown");
  });
});

describe("legacyPartnerPath", () => {
  it("maps the old dashboard addresses onto the console", () => {
    expect(legacyPartnerPath("/dashboard/partner")).toBe("/partner");
    expect(legacyPartnerPath("/dashboard/partner/")).toBe("/partner");
    expect(legacyPartnerPath("/dashboard/partner/users")).toBe("/partner/users");
    expect(legacyPartnerPath("/dashboard/partner/users/abc-123")).toBe("/partner/users/abc-123");
  });
  it("leaves every other address alone", () => {
    expect(legacyPartnerPath("/dashboard")).toBeNull();
    expect(legacyPartnerPath("/dashboard/partners")).toBeNull();
    expect(legacyPartnerPath("/partner/users")).toBeNull();
  });
});

describe("PARTNER_NAV", () => {
  it("has the overview (exact match only) and the users", () => {
    expect(PARTNER_NAV.map((n) => n.to)).toEqual(["/partner", "/partner/users"]);
    expect(PARTNER_NAV[0].end).toBe(true);
  });
});
