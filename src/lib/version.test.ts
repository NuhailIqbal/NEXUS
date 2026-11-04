import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");

describe("release version", () => {
  const pkgVersion: string = JSON.parse(read("package.json")).version;

  it("is MAJOR.MINOR.PATCH", () => {
    expect(pkgVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("is injected into the app as __APP_VERSION__", () => {
    expect(__APP_VERSION__).toBe(pkgVersion);
  });

  it("matches package-lock.json, the backend and the latest CHANGELOG release", () => {
    expect(JSON.parse(read("package-lock.json")).version).toBe(pkgVersion);
    expect(/^__version__ = "([^"]+)"$/m.exec(read("backend/version.py"))?.[1]).toBe(pkgVersion);
    expect(/^## \[(\d+\.\d+\.\d+)\]/m.exec(read("CHANGELOG.md"))?.[1]).toBe(pkgVersion);
  });
});
